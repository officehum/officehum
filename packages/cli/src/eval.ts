/**
 * The `officehum eval ROLE_DIR` command: run one role package's eval suites on the bare Pi Durable
 * harness and print the SDK's report. It is the release gate and the portability check — the runner
 * loads nothing from Office Hum, so a role that needs it fails here.
 *
 * The model is a live provider (`paper`, `openai`) or `scripted`, which reads a script file so CI can
 * run a suite with no key. A script file is JSON mapping each scenario id to the turns the scripted
 * model plays back, in order:
 *
 * ```json
 * {
 *   "reports-cited-levels": [
 *     { "toolCalls": [{ "name": "stock_levels", "args": { "sku": "BOLT-10" } }] },
 *     { "text": "120 units, from stock:BOLT-10." }
 *   ]
 * }
 * ```
 *
 * A scenario the selected suites contain but the file does not script is refused before any trial
 * runs, so a stale script fails loudly instead of silently grading nothing. A script that must branch
 * on what a tool returned cannot be written as JSON; use a runner in a test for that.
 *
 * Every role ships that file beside its `evals/` directory as `evals.smoke.json`, so `--script` is
 * optional: without it the command reads the role's own file, the way `agents/bookkeeper` does.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";
import { type EvalModel, piDurableRunner } from "@officehum/office";
import {
  SCRIPTED_MODEL_ID,
  type ScriptedToolCall,
  type ScriptedTurn,
  scriptedProvider,
} from "@officehum/office/testing";
import {
  type EvalSuite,
  formatIssue,
  formatReport,
  runEvals,
  type Scenario,
  validatePackage,
} from "@officehum/sdk";
import type { CliDependencies, CliIo } from "./cli.js";
import { parseModelRef, runModels } from "./run.js";
import { UsageError } from "./usage-error.js";

export interface EvalArguments {
  readonly roleDir: string;
  readonly model?: string;
  readonly tag?: string;
  readonly trials?: number;
  readonly script?: string;
}

const EVAL_USAGE =
  "usage: officehum eval ROLE_DIR [--model provider/model] [--tag TAG] [--trials N] [--script FILE]";

/** Parses the eval command's arguments: one positional role directory, then the flags above. */
export function parseEvalArguments(args: readonly string[]): EvalArguments {
  let roleDir: string | undefined;
  let model: string | undefined;
  let tag: string | undefined;
  let trials: number | undefined;
  let script: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      if (roleDir !== undefined)
        throw new UsageError(`Only one role directory is allowed.\n${EVAL_USAGE}`);
      roleDir = token;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${token} requires a value.\n${EVAL_USAGE}`);
    }
    index += 1;
    if (token === "--model") model = value;
    else if (token === "--tag") tag = value;
    else if (token === "--script") script = value;
    else if (token === "--trials") {
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new UsageError(`--trials must be a positive integer (got ${JSON.stringify(value)}).`);
      }
      trials = count;
    } else throw new UsageError(`Unknown option: ${token}\n${EVAL_USAGE}`);
  }
  if (roleDir === undefined) throw new UsageError(`eval requires a role directory.\n${EVAL_USAGE}`);
  return {
    roleDir,
    ...(model === undefined ? {} : { model }),
    ...(tag === undefined ? {} : { tag }),
    ...(trials === undefined ? {} : { trials }),
    ...(script === undefined ? {} : { script }),
  };
}

/**
 * `officehum eval ROLE_DIR`: validate the role package, run its eval suites, print the report, and
 * exit non-zero when the suite fails.
 */
export async function runEvalCommand(
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseEvalArguments(args);
  const checked = await validatePackage(parsed.roleDir);
  if (!checked.ok) {
    for (const issue of checked.issues) io.error(formatIssue(issue));
    return 1;
  }
  const pkg = checked.value;
  const ref: ModelRef =
    parsed.model === "scripted"
      ? { provider: "scripted", modelId: SCRIPTED_MODEL_ID }
      : parsed.model === undefined
        ? {
            provider: pkg.manifest.defaultModel.provider,
            modelId: pkg.manifest.defaultModel.modelId,
          }
        : parseModelRef(parsed.model);

  const suites: EvalSuite[] = Object.values(pkg.suites);
  const scenarios = suites
    .flatMap((suite) => suite.scenarios)
    .filter((scenario) => parsed.tag === undefined || (scenario.tags ?? []).includes(parsed.tag));
  if (scenarios.length === 0) {
    io.error(
      parsed.tag === undefined
        ? `${pkg.name} has no eval scenarios.`
        : `${pkg.name} has no scenarios tagged ${JSON.stringify(parsed.tag)}.`,
    );
    return 1;
  }

  const script = ref.provider === "scripted" ? scriptFileFor(parsed) : undefined;
  const model =
    script === undefined ? liveModel(ref, dependencies) : await scriptedModel(script, scenarios);

  const report = await runEvals(suites, piDurableRunner({ dir: parsed.roleDir, model }), {
    ...(parsed.tag === undefined ? {} : { tag: parsed.tag }),
    ...(parsed.trials === undefined ? {} : { trials: parsed.trials }),
  });
  io.output(
    `Model: ${ref.provider}/${ref.modelId}${script === undefined ? "" : ` (script ${script})`}`,
  );
  io.output(formatReport(report));
  return report.passed ? 0 : 1;
}

/** The live provider the eval runs under; the credential is required before any trial starts. */
function liveModel(ref: ModelRef, dependencies: CliDependencies) {
  const runtime = runModels(ref, dependencies, "eval");
  return (): EvalModel => runtime;
}

/** The role's own script file: `evals.smoke.json` beside `evals/`, read without `--script`. */
const DEFAULT_SCRIPT_FILE = "evals.smoke.json";

/**
 * The script file to read: `--script FILE` when given, otherwise the role's own `evals.smoke.json`.
 * A role that ships neither is a usage error, raised before any trial runs.
 */
function scriptFileFor(parsed: EvalArguments): string {
  if (parsed.script !== undefined) return parsed.script;
  const file = join(parsed.roleDir, DEFAULT_SCRIPT_FILE);
  if (!existsSync(file)) {
    throw new UsageError(
      `--model scripted needs --script FILE, or ${DEFAULT_SCRIPT_FILE} in ${parsed.roleDir}.\n${EVAL_USAGE}`,
    );
  }
  return file;
}

/** The scripted model factory: rebuilds the provider for every trial so the script replays each time. */
async function scriptedModel(file: string, scenarios: readonly Scenario[]) {
  const script = await readEvalScript(file);
  const missing = scenarios.filter((scenario) => script[scenario.id] === undefined);
  if (missing.length > 0) {
    throw new UsageError(
      `The --script file ${file} has no turns for ${missing.map((scenario) => JSON.stringify(scenario.id)).join(", ")}.\n${EVAL_USAGE}`,
    );
  }
  return (scenario: Scenario): EvalModel => {
    const turns = script[scenario.id];
    if (turns === undefined) throw new Error(`No turns for ${scenario.id} in ${file}.`);
    return scriptedProvider(turns);
  };
}

/** Reads and checks a script file: JSON of scenario id → the turns to play back, in order. */
export async function readEvalScript(
  file: string,
): Promise<Readonly<Record<string, readonly ScriptedTurn[]>>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read the --script file ${file}: ${String(error)}.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`The --script file ${file} must hold an object of scenario id → turns.`);
  }
  const script: Record<string, readonly ScriptedTurn[]> = {};
  for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(raw)) {
      throw new Error(`Scenario ${JSON.stringify(id)} in ${file} must hold an array of turns.`);
    }
    script[id] = raw.map((turn, index) => scriptedTurn(turn, id, index, file));
  }
  return script;
}

function scriptedTurn(value: unknown, id: string, index: number, file: string): ScriptedTurn {
  const where = `Scenario ${JSON.stringify(id)} turn ${index} in ${file}`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be { "text": … } or { "toolCalls": [ … ] }.`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string" && record.toolCalls === undefined) {
    return { text: record.text };
  }
  if (Array.isArray(record.toolCalls) && record.text === undefined) {
    return {
      toolCalls: record.toolCalls.map((call) => scriptedCall(call, `${where} toolCalls`, file)),
    };
  }
  throw new Error(`${where} must be exactly one of { "text": … } or { "toolCalls": [ … ] }.`);
}

function scriptedCall(value: unknown, where: string, file: string): ScriptedToolCall {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} entries must be { "name": …, "args"?: … } in ${file}.`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new Error(`${where} entries need a non-empty "name" in ${file}.`);
  }
  if (
    record.args !== undefined &&
    (record.args === null || typeof record.args !== "object" || Array.isArray(record.args))
  ) {
    throw new Error(`${where} entries need "args" to be an object in ${file}.`);
  }
  const name = record.name;
  const args = record.args;
  if (args === undefined) return { name };
  return { name, args: args as NonNullable<ScriptedToolCall["args"]> };
}
