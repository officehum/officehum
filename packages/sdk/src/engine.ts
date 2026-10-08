/**
 * Engines: a role's deterministic core. An engine is a command-line program (Python, for example)
 * that a role calls for every number it reports, so figures come from code, never from the model.
 * It is passed into the role like any app client: `commandEngine` runs the real program, and
 * `stubEngine` stands in for it in tests and evals. See "Engines" in docs/design/agent-package.md.
 *
 * The engine contract:
 * - The host runs `<engine.command> <subcommand…> [--name value…]` from the role package's root.
 * - The engine prints one JSON object on stdout: `{ "ok": true, "data": …, "findings": [{ "id": … }],
 *   "caveats": [] }`, or `{ "ok": false, "error": "…" }`. The exit code does not matter if the JSON
 *   is there.
 * - It reads and writes only the host's directories, given in `OFFICEHUM_DATA_DIR` and
 *   `OFFICEHUM_WORK_DIR`, never the package. Each call carries `OFFICEHUM_IDEMPOTENCY_KEY`, so a write
 *   repeated by the host is not applied twice.
 * - It sees no other environment except `PATH`, `HOME`, `LANG` and what the host passes explicitly:
 *   model keys and other secrets never reach it.
 */

import { execFile } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import semver from "semver";
import type { Issue } from "./issues.js";
import {
  type AgentManifest,
  MANIFEST_FILE,
  type ParameterDeclaration,
  type ToolDeclaration,
} from "./manifest.js";

/** A fact the engine established, with the id the role cites, e.g. `variance:MP-1000:material`. */
export interface EngineFinding {
  readonly id: string;
  readonly description?: string;
  readonly [field: string]: unknown;
}

/** What one engine call returned. */
export interface EngineResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly findings: readonly EngineFinding[];
  readonly caveats: readonly string[];
  readonly error?: string;
}

export interface EngineRunOptions {
  /** Stable per tool call, so a repeated write is not applied twice. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

/** A role's engine. */
export interface Engine {
  run(args: readonly string[], options?: EngineRunOptions): Promise<EngineResult>;
}

/** Thrown when the engine cannot be run or does not answer with the JSON envelope. */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

export interface CommandEngineOptions {
  /** The program and its fixed arguments, e.g. `["python3", "engine/engine.py"]`. */
  readonly command: readonly string[];
  /** Where to run it: the role package's root, so relative script paths work. */
  readonly cwd: string;
  /** The host's directory of input data the engine reads. */
  readonly dataDir?: string;
  /** The host's directory where the engine keeps its working records. */
  readonly workDir?: string;
  /** More environment variables for the engine. Nothing else from the host's environment is passed. */
  readonly env?: Readonly<Record<string, string>>;
  /** Default 120 seconds. */
  readonly timeoutMs?: number;
}

const PASSED_THROUGH = ["PATH", "HOME", "LANG", "LC_ALL", "SYSTEMROOT", "TMPDIR"] as const;

/** Runs the engine as a subprocess for each call. */
export function commandEngine(options: CommandEngineOptions): Engine {
  const [program, ...fixed] = options.command;
  if (program === undefined) throw new EngineError("engine command is empty");

  return {
    run: (args, runOptions = {}) =>
      new Promise((resolve, reject) => {
        const env: Record<string, string> = {};
        for (const name of PASSED_THROUGH) {
          const value = process.env[name];
          if (value !== undefined) env[name] = value;
        }
        if (options.dataDir !== undefined) env.OFFICEHUM_DATA_DIR = options.dataDir;
        if (options.workDir !== undefined) env.OFFICEHUM_WORK_DIR = options.workDir;
        if (runOptions.idempotencyKey !== undefined)
          env.OFFICEHUM_IDEMPOTENCY_KEY = runOptions.idempotencyKey;
        Object.assign(env, options.env);

        execFile(
          program,
          [...fixed, ...args],
          {
            cwd: options.cwd,
            env,
            timeout: options.timeoutMs ?? 120_000,
            maxBuffer: 32 * 1024 * 1024,
            ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }),
          },
          (error, stdout, stderr) => {
            const text = String(stdout).trim();
            if (text.startsWith("{")) {
              try {
                resolve(toResult(JSON.parse(text)));
                return;
              } catch (parseError) {
                reject(new EngineError(`engine printed invalid JSON: ${message(parseError)}`));
                return;
              }
            }
            const detail = String(stderr).trim().split("\n").slice(-5).join("\n") || message(error);
            reject(
              new EngineError(
                `engine ${[program, ...fixed, ...args].join(" ")} gave no JSON result: ${detail}`,
              ),
            );
          },
        );
      }),
  };
}

export interface ManifestEngineOptions extends Omit<CommandEngineOptions, "command" | "cwd"> {}

/** The engine a role's manifest declares, run from the role package's root. */
export function engineFromManifest(
  packageDir: string,
  manifest: AgentManifest,
  options: ManifestEngineOptions = {},
): Engine {
  if (manifest.engine === undefined) throw new EngineError(`${MANIFEST_FILE} declares no engine`);
  return commandEngine({ ...options, command: manifest.engine.command, cwd: packageDir });
}

type StubResponse = Partial<EngineResult> | ((args: readonly string[]) => Partial<EngineResult>);

/** An engine for tests and evals: answers by subcommand, records every call. */
export interface StubEngine extends Engine {
  readonly calls: readonly { readonly args: readonly string[]; readonly idempotencyKey?: string }[];
}

/**
 * Answers each call with the response whose key (subcommand words joined by spaces, e.g. `"je post"`)
 * is the longest match for the start of the call's arguments.
 */
export function stubEngine(responses: Readonly<Record<string, StubResponse>>): StubEngine {
  const calls: { args: readonly string[]; idempotencyKey?: string }[] = [];
  const keys = Object.keys(responses).sort((a, b) => b.split(" ").length - a.split(" ").length);
  return {
    calls,
    run: async (args, options = {}) => {
      calls.push({
        args,
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      });
      const key = keys.find((candidate) =>
        candidate.split(" ").every((word, index) => args[index] === word),
      );
      if (key === undefined)
        throw new EngineError(`stub engine has no response for "${args.join(" ")}"`);
      const response = responses[key];
      const partial = typeof response === "function" ? response(args) : (response ?? {});
      return toResult({ ok: true, findings: [], caveats: [], ...partial });
    },
  };
}

/**
 * The engine arguments for a tool call: the subcommand, then `--name value` for each declared
 * parameter given, in declaration order. Underscores become hyphens (`work_order` → `--work-order`);
 * a boolean is a bare flag when true and left out when false.
 */
export function engineArgs(
  subcommand: readonly string[],
  parameters: Readonly<Record<string, ParameterDeclaration>> | undefined,
  args: Readonly<Record<string, unknown>>,
): string[] {
  const out = [...subcommand];
  for (const [name, parameter] of Object.entries(parameters ?? {})) {
    const value = args[name];
    if (value === undefined || value === null) continue;
    const flag = `--${name.replaceAll("_", "-")}`;
    if (parameter.type === "boolean") {
      if (value === true) out.push(flag);
    } else {
      out.push(flag, String(value));
    }
  }
  return out;
}

/** The text a tool returns to the model: findings, data and caveats as JSON, cut to `maxChars`. */
export function formatEngineResult(result: EngineResult, maxChars = 9000): string {
  const body = result.ok
    ? { findings: result.findings, data: result.data, caveats: result.caveats }
    : { error: result.error ?? "the engine reported a failure", caveats: result.caveats };
  const json = JSON.stringify(body, null, 2);
  if (json.length <= maxChars) return json;
  // Findings carry the ids the role must cite, so they are kept whole where possible.
  const findings = JSON.stringify({ findings: result.findings, truncated: true }, null, 2);
  if (findings.length <= maxChars) return findings;
  return `${json.slice(0, maxChars)}\n… (truncated; ask for a narrower result)`;
}

/** Builds the role's engine tools from the manifest: one Pi Durable tool per tool with an `engine`. */
export function engineTools(manifest: AgentManifest, engine: Engine): ToolRegistration[] {
  return manifest.tools
    .filter((tool) => tool.engine !== undefined)
    .map((tool) => engineTool(tool, engine));
}

function engineTool(tool: ToolDeclaration, engine: Engine): ToolRegistration {
  const subcommand = tool.engine ?? [];
  const guidelines = (tool.guidelines ?? []).map((line) => `- ${line}`).join("\n");
  const description =
    guidelines === ""
      ? (tool.description ?? tool.name)
      : `${tool.description ?? tool.name}\n\n${guidelines}`;
  const properties = Object.fromEntries(
    Object.entries(tool.parameters ?? {}).map(([name, parameter]) => {
      const schema = parameterSchema(parameter);
      return [name, parameter.required ? schema : Type.Optional(schema)];
    }),
  );

  return defineTool({
    name: tool.name,
    description,
    parameters: Type.Object(properties),
    replay: tool.replay,
    execute: async (args, api) => {
      const result = await engine.run(
        engineArgs(subcommand, tool.parameters, args as Record<string, unknown>),
        {
          idempotencyKey: `${String(api.conversationId)}:${api.callId}`,
        },
      );
      return {
        content: [{ type: "text", text: formatEngineResult(result) }],
        ...(result.ok ? {} : { isError: true }),
        details: { findings: result.findings.map((finding) => finding.id) },
      };
    },
  }) as unknown as ToolRegistration;
}

function parameterSchema(parameter: ParameterDeclaration) {
  const options = { description: parameter.description };
  if (parameter.enum !== undefined) {
    return Type.Union(
      parameter.enum.map((value) => Type.Literal(value)),
      options,
    );
  }
  switch (parameter.type) {
    case "string":
      return Type.String(options);
    case "number":
      return Type.Number(options);
    case "integer":
      return Type.Integer(options);
    case "boolean":
      return Type.Boolean(options);
  }
}

/** Runs an operator command from the manifest: an engine view, with no model involved. */
export async function runOperatorCommand(
  manifest: AgentManifest,
  engine: Engine,
  name: string,
): Promise<EngineResult> {
  const command = (manifest.commands ?? []).find((candidate) => candidate.name === name);
  if (command === undefined)
    throw new EngineError(`${manifest.id} has no command ${JSON.stringify(name)}`);
  return engine.run(command.engine);
}

/**
 * Checks the programs a role needs are installed in a range it supports, by running each one's
 * `--version`. A host runs this before loading the role.
 */
export async function checkRuntimes(manifest: AgentManifest): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const [index, runtime] of (manifest.runtimes ?? []).entries()) {
    const path = `runtimes[${index}]`;
    const need = `${manifest.id} needs ${runtime.name} ${runtime.version}`;
    let output: string;
    try {
      output = await versionOutput(runtime.name);
    } catch {
      issues.push({
        source: MANIFEST_FILE,
        path,
        message: `${runtime.name} is not installed or not on PATH; ${need}`,
      });
      continue;
    }
    const found = semver.coerce(output);
    if (found === null) {
      issues.push({
        source: MANIFEST_FILE,
        path,
        message: `could not read ${runtime.name}'s version from ${JSON.stringify(output.trim())}; ${need}`,
      });
    } else if (!semver.satisfies(found, runtime.version)) {
      issues.push({
        source: MANIFEST_FILE,
        path,
        message: `${runtime.name} ${found.version} is installed; ${need}`,
      });
    }
  }
  return issues;
}

function versionOutput(program: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(program, ["--version"], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(`${stdout}${stderr}`); // Some programs (older Pythons) print their version on stderr.
    });
  });
}

function toResult(value: unknown): EngineResult {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { ok?: unknown }).ok !== "boolean"
  ) {
    throw new EngineError('engine result must be a JSON object with "ok": true or false');
  }
  const raw = value as Record<string, unknown>;
  const findings = Array.isArray(raw.findings) ? raw.findings : [];
  for (const finding of findings) {
    if (
      finding === null ||
      typeof finding !== "object" ||
      typeof (finding as { id?: unknown }).id !== "string"
    ) {
      throw new EngineError('every engine finding must be an object with a string "id"');
    }
  }
  return {
    ok: raw.ok as boolean,
    ...(raw.data === undefined ? {} : { data: raw.data }),
    findings: findings as EngineFinding[],
    caveats: Array.isArray(raw.caveats) ? raw.caveats.map(String) : [],
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
