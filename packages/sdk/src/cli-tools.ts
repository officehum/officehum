/**
 * CLI tools: tools a role declares in `officehum.json` that a service's command-line program carries
 * out, one process per call (docs/design/tool-sources.md, section 3). The manifest states each tool's
 * name, description, parameters and `replay`; the program only runs it.
 *
 * Nothing here ever builds a command line: the program is started with an argv array, without a
 * shell, and each `{placeholder}` becomes exactly one argument. A string value that starts with `-` is
 * refused, so a parameter cannot become a flag. The process gets no standard input, runs in an empty
 * temporary directory that is removed afterwards, and sees only `PATH` and the variables its `clis`
 * entry names. What it prints reaches the model inside the outside-output frame.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { declaredDescription, declaredParameters } from "./declared-tool.js";
import { show } from "./issues.js";
import {
  type AgentManifest,
  CLI_CALL_ID,
  CLI_PLACEHOLDER,
  type CliDeclaration,
  type CliToolSource,
  type ParameterDeclaration,
  type ToolDeclaration,
} from "./manifest.js";
import { frameOutsideOutput } from "./outside-output.js";
import { isReservedEnvName } from "./reserved-env.js";
import { runProgram } from "./run-program.js";

/** Seconds a CLI call may run when its tool states no `timeoutSeconds`. */
export const CLI_DEFAULT_TIMEOUT_SECONDS = 60;

/** Characters of stderr an error result carries. */
export const CLI_STDERR_CHARS = 4000;

/** Characters of output the model is given; the rest is cut, with a note. */
export const CLI_OUTPUT_CHARS = 9000;

/**
 * Builds one Pi Durable tool for each tool the manifest declares with `cli`. `packageDir` is the role
 * package's root: a command element that starts with `./` names a file there, since the program runs
 * in an empty temporary directory.
 */
export function cliTools(manifest: AgentManifest, packageDir: string): ToolRegistration[] {
  return manifest.tools.flatMap((tool) => {
    if (tool.cli === undefined) return [];
    const cli = manifest.clis?.[tool.cli.use];
    if (cli === undefined) {
      throw new Error(
        `${tool.name} uses the CLI ${show(tool.cli.use)}, which officehum.json does not declare in clis`,
      );
    }
    return [cliTool(tool, tool.cli, cli, packageDir)];
  });
}

/** What a tool call's arguments turn into: the arguments appended to the CLI's command, or why not. */
export type CliArguments =
  | { readonly ok: true; readonly args: string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * A call's argv after the CLI's command: the template with each placeholder replaced by exactly one
 * argument. An optional parameter that was not given drops its placeholder, and the `--flag` literal
 * just before it. `{callId}` is the call's idempotency key.
 */
export function cliArguments(
  template: readonly string[],
  parameters: Readonly<Record<string, ParameterDeclaration>>,
  values: Readonly<Record<string, unknown>>,
  callId: string,
): CliArguments {
  const out: string[] = [];
  let previousIsFlag = false;
  for (const element of template) {
    const name = CLI_PLACEHOLDER.exec(element)?.[1];
    if (name === undefined) {
      out.push(element);
      previousIsFlag = element.startsWith("--");
      continue;
    }
    const isFlag = previousIsFlag;
    previousIsFlag = false;
    if (name === CLI_CALL_ID) {
      out.push(callId);
      continue;
    }
    const parameter = parameters[name];
    const value = values[name];
    if (parameter === undefined) return { ok: false, reason: `${show(name)} is not a parameter` };
    if (value === undefined || value === null) {
      if (parameter.required === true) return { ok: false, reason: `${show(name)} is required` };
      if (isFlag) out.pop();
      continue;
    }
    const argument = argumentFor(name, parameter, value);
    if (typeof argument !== "string") return argument;
    out.push(argument);
  }
  return { ok: true, args: out };
}

/** One value as one argument. Numbers are checked as numbers, so a negative one is not a flag. */
function argumentFor(
  name: string,
  parameter: ParameterDeclaration,
  value: unknown,
): string | { ok: false; reason: string } {
  switch (parameter.type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? String(value)
        : { ok: false, reason: `${show(name)} must be a whole number` };
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : { ok: false, reason: `${show(name)} must be a number` };
    case "boolean":
      return typeof value === "boolean"
        ? String(value)
        : { ok: false, reason: `${show(name)} must be true or false` };
    case "string":
      if (typeof value !== "string") return { ok: false, reason: `${show(name)} must be text` };
      if (value.startsWith("-")) {
        return {
          ok: false,
          reason: `${show(name)} may not start with "-", because the program would read it as an option`,
        };
      }
      return value;
  }
}

function cliTool(
  tool: ToolDeclaration,
  source: CliToolSource,
  cli: CliDeclaration,
  packageDir: string,
): ToolRegistration {
  const [declaredProgram = "", ...declaredFixed] = cli.command;
  const resolve = (element: string) =>
    element.startsWith("./") ? join(packageDir, element) : element;
  const program = resolve(declaredProgram);
  const fixed = declaredFixed.map(resolve);
  const timeoutSeconds = source.timeoutSeconds ?? CLI_DEFAULT_TIMEOUT_SECONDS;
  const details: JsonObject = { cli: source.use };
  const frame = (text: string) =>
    frameOutsideOutput(
      {
        tool: tool.name,
        origin: `the command-line program ${show(declaredProgram)} (the CLI ${show(source.use)})`,
        tag: "cli-output",
      },
      [{ type: "text", text }],
    );
  const refuse = (text: string, extra: JsonObject = {}) => ({
    isError: true,
    output: [{ type: "text" as const, text }],
    details: { ...details, ...extra },
  });

  return defineTool({
    name: tool.name,
    description: declaredDescription(tool),
    parameters: declaredParameters(tool),
    replay: tool.replay,
    execute: async (args, api, context) => {
      // The call's durable identity, as MCP tools form it: the same when Pi Durable runs it again.
      const callId = `${String(api.conversationId)}:${api.callId}`;
      const built = cliArguments(
        source.args,
        tool.parameters ?? {},
        args as Record<string, unknown>,
        callId,
      );
      if (!built.ok) return refuse(`${tool.name} was not run: ${built.reason}.`);

      // The child never inherits the host's environment: PATH, and the variables the CLI names.
      const env: Record<string, string> = {};
      if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
      for (const name of cli.env ?? []) {
        // The validator refuses these too; this holds for a manifest that never went through it.
        if (isReservedEnvName(name)) {
          return refuse(
            `${tool.name} was not run: the CLI ${show(source.use)} names ${name}, the office's own secret, which no role's program is given.`,
          );
        }
        const value = process.env[name];
        if (value === undefined) {
          return refuse(
            `${tool.name} was not run: the CLI ${show(source.use)} needs the environment variable ${name}, which is not set on the host.`,
          );
        }
        env[name] = value;
      }

      const cwd = await mkdtemp(join(tmpdir(), "officehum-cli-"));
      let run: Awaited<ReturnType<typeof runProgram>>;
      try {
        // A cancelled call rejects here after the process is killed, so Pi Durable sees the
        // cancellation and recovers the call by its replay policy.
        run = await runProgram({
          program,
          args: [...fixed, ...built.args],
          cwd,
          env,
          timeoutMs: timeoutSeconds * 1000,
          signal: context.abortSignal,
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }

      if (run.startError !== undefined) {
        return refuse(
          `${tool.name} could not start ${show(declaredProgram)}: ${run.startError.message}`,
        );
      }
      if (run.timedOut) {
        return refuse(
          `${tool.name} was stopped: ${show(declaredProgram)} ran longer than ${timeoutSeconds} seconds and was killed, so nothing it printed is used.`,
          { timedOut: true },
        );
      }
      if (run.exitCode !== 0) {
        const ended =
          run.exitCode === null ? "was killed by a signal" : `exited with code ${run.exitCode}`;
        return {
          isError: true,
          output: frame(
            `The program ${ended}. Its stderr (first ${CLI_STDERR_CHARS.toLocaleString("en-US")} characters):\n${run.stderr.slice(0, CLI_STDERR_CHARS)}`,
          ),
          details: { ...details, exitCode: run.exitCode },
        };
      }
      const text = run.stdout.trim();
      if (source.output === "json") {
        try {
          JSON.parse(text);
        } catch {
          // The parser's message quotes the output, which is the program's text; it stays out.
          return refuse(
            `${tool.name} failed: ${show(declaredProgram)} printed output that is not valid JSON, so it was not used.`,
            { exitCode: 0 },
          );
        }
      }
      const cut =
        text.length <= CLI_OUTPUT_CHARS
          ? text
          : `${text.slice(0, CLI_OUTPUT_CHARS)}\n… (cut at ${CLI_OUTPUT_CHARS.toLocaleString("en-US")} characters; ask for a narrower result)`;
      return { output: frame(cut), details: { ...details, exitCode: 0 } };
    },
  }) as unknown as ToolRegistration;
}
