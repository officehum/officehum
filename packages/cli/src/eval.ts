/**
 * The `officehum eval ROLE_DIR` command: run one role package's eval suites on the bare Pi Durable
 * harness and print the SDK's report. It is the portability gate — the runner loads nothing from
 * Office Hum, so a role that needs it fails here. It is not evidence of behaviour: a scripted run
 * counts the calls the model intended, including ones an approval gate would block, so a green
 * scripted suite says the wiring holds, and only a live run says how the role acts.
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
 *
 * `--suite FILE` runs that one suite file against the role instead of the role's own `evals/`,
 * checked against the role's manifest like the role's own. It is how a suite kept outside a role's
 * package runs, such as the memory evals in `packages/memory/evals/`, which the role's default run
 * must not pick up.
 *
 * A role's office-only suite (`evals/office.json`, which declares `"mode": "office"`) runs only in
 * a host's office mode, so a run here skips it and the report says so; its turns are in
 * `evals.office.json`, read beside `evals.smoke.json` when no `--script` is given. A host adds that
 * mode, its memory and an installed company (`--company`) through `EvalOffice`.
 *
 * A trial the model provider fails (an interrupted stream, a rate limit, a timeout, a server error)
 * says nothing about the role, so it is run again, up to `--retries N` times (default 2, 0 turns it
 * off), on the same provider and model. One that never finishes is reported `errored`, not failed;
 * if no graded trial fails the suite, the run is `incomplete` and exits `EXIT_INCOMPLETE` (3).
 *
 * A scenario's judged reply assertions (`expect.reply.judged`) are graded by a judge
 * model: by default the live model the trials run on, so the run needs no second key; `--judge
 * provider/model` names another. A scripted run has no judge unless `--judge` names one, so it
 * reports each judged assertion skipped and the report says how many. A judge the provider fails,
 * or one that answers anything but PRESENT or ABSENT, makes the trial errored, retried like any.
 *
 * What a run costs: `--normal-trials N` runs normal scenarios N times while critical ones
 * run `--trials`; `--max-output-tokens N` (default 8192) caps every model request's output, so a
 * provider reserves that much balance per request rather than the model's whole limit, and a trial
 * whose reply hits the cap is errored, not graded. A live run ends with one line of model usage,
 * judge included: input tokens (cached), output tokens (reasoning) and the estimated cost.
 *
 * `--overlay DIR` (repeatable, lowest first) evaluates the role under a business's overlay
 * directories, in either mode, as a host loads them: a house rule as an overlay `AGENTS.md`, a tool
 * switched off, a limit set. The run's first lines say so and name every safeguard the overlays
 * lower (`loweredGuards`), so the result is never mistaken for one on the role's defaults. An overlay
 * that does not load is refused, naming the problem, before any trial runs. Without the flag the run
 * is unchanged.
 *
 * `--pack ID` (repeatable) gives the role a tool pack its office would supply, today only
 * `data`: the tools its manifest declares with `"pack": "data"` are offered, stubbed like every
 * declared tool, so the pack's engine never loads. A suite that declares `"packs": ["data"]` runs
 * only with it; without the flag the role has no pack and such a suite is skipped, and the report
 * says so.
 */

import { existsSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";
import {
  type EvalModel,
  type PiDurableRunnerOptions,
  piDurableRunner,
  type TrialContext,
} from "@officehum/runner";
import {
  SCRIPTED_MODEL_ID,
  type ScriptedToolCall,
  type ScriptedTurn,
  scriptedProvider,
} from "@officehum/runner/testing";
import {
  type AgentRunner,
  type EvalReport,
  type EvalSuite,
  formatIssue,
  formatReport,
  formatUsage,
  loweredGuards,
  type RolePackage,
  resolveRoleFiles,
  runEvals,
  type Scenario,
  selectScenarios,
  validatePackage,
  validateSuite,
} from "@officehum/sdk";
import type { CliDependencies, CliIo } from "./cli.js";
import { loweredLines } from "./lowered.js";
import { dataPackFor, importDataPack, OFFICE_PACKS } from "./packs.js";
import { parseModelRef, runModels } from "./run.js";
import { UsageError } from "./usage-error.js";

interface EvalArguments {
  readonly roleDir: string;
  readonly model?: string;
  readonly tag?: string;
  /** Every `--scenario ID`, in the order given. */
  readonly scenarios?: readonly string[];
  readonly trials?: number;
  /** Trials per normal scenario, when fewer than critical ones run `--trials`. */
  readonly normalTrials?: number;
  readonly retries?: number;
  /** The output token cap of every model request, the judge's included. */
  readonly maxOutputTokens?: number;
  readonly script?: string;
  /** A suite file to run instead of the role's own `evals/`. */
  readonly suite?: string;
  readonly mode?: "bare" | "office";
  /** `true` (`--memory`) or `false` (`--no-memory`); omitted: office memory's default, on. */
  readonly memory?: boolean;
  readonly report?: string;
  /** The model that grades judged reply assertions, when not the trials' own. */
  readonly judge?: string;
  /** Every `--overlay DIR`, lowest first: the role is evaluated under them. */
  readonly overlays?: readonly string[];
  /** `--company FILE`: the role runs as an installed office with this company record. */
  readonly company?: string;
  /** Every `--pack ID`: the tool packs the role is given, their tools stubbed. */
  readonly packs?: readonly (typeof OFFICE_PACKS)[number][];
}

/** An installed office's company for one eval run (`--company FILE`). */
export interface InstalledCompany {
  readonly name: string;
  /** The run's own directory, removed when the run ends. */
  readonly root: string;
  /** The office layer holding its handbook, loaded below any `--overlay`. */
  readonly layer: string;
}

/**
 * What a host adds to `officehum eval`: its office mode (`--mode`), its memory (`--memory`,
 * `--no-memory`) and an installed company (`--company FILE`). Without
 * one, those flags are unknown options and every run is bare.
 */
export interface EvalOffice<Company extends InstalledCompany = InstalledCompany> {
  /** The command's usage with the host's flags. */
  readonly usage: string;
  /** Reads a company file into the run's company; a usage error names every problem. */
  installedCompany(file: string): Company;
  /**
   * The suites the host keeps for this role outside its package (its office-mode suites),
   * run after the package's own, and the script files that hold their turns.
   */
  roleSuites(pkg: RolePackage): {
    readonly suites: readonly EvalSuite[];
    readonly scripts: readonly string[];
  };
  /** The runner for the run, in the mode and with the company asked for. */
  runner(
    options: Omit<PiDurableRunnerOptions, "company" | "host">,
    office: {
      readonly mode?: "bare" | "office";
      readonly memory?: boolean;
      readonly company?: Company;
    },
  ): AgentRunner;
}

/**
 * The exit code of a run the model provider did not complete: some trial errored on every attempt,
 * and no graded trial failed the suite. Distinct from 1 (failed) and 2 (usage error), so a CI job can
 * repeat the run instead of reporting the role as broken.
 */
export const EXIT_INCOMPLETE = 3;

/**
 * The output cap of an eval request when the run does not name one. Visible replies stay under 1,000
 * tokens, but every role reasons at `max` and reasoning shares the cap; Paper's own examples for
 * Ultramarine at `max` effort set `max_completion_tokens` to 8,192. A quarter of the model's 32,768,
 * so a provider that reserves balance for a request's largest cost reserves a quarter as much.
 */
export const DEFAULT_EVAL_MAX_OUTPUT_TOKENS = 8192;

const EVAL_USAGE =
  "usage: officehum eval ROLE_DIR [--model provider/model] [--tag TAG] [--scenario ID]... " +
  "[--trials N] [--normal-trials N] [--retries N] [--max-output-tokens N] [--script FILE] " +
  "[--suite FILE] [--report FILE] [--judge provider/model] [--overlay DIR]... [--pack data]...\n" +
  "--pack gives the role a tool pack its office would supply (data), its tools stubbed; a suite that " +
  "declares the pack runs only with it\n" +
  "--overlay evaluates the role under a business's overlay directories (lowest first); the run says so " +
  "and names each safeguard they lower\n" +
  "--trials sets every scenario's trial count; --normal-trials sets the normal scenarios' instead\n" +
  `--max-output-tokens caps each model request's output, reasoning included (default ${DEFAULT_EVAL_MAX_OUTPUT_TOKENS}); ` +
  "a trial whose reply hits it is errored, not graded\n" +
  "judged reply assertions are graded by --judge, else by the live --model; a scripted run without " +
  "--judge skips them and says so\n" +
  "a live run ends with one line of model usage: input tokens (cached), output tokens (reasoning) " +
  "and the estimated cost\n" +
  "exit codes: 0 passed, 1 failed, 2 usage error, 3 incomplete (the model provider did not " +
  "complete a trial, even after --retries, default 2; repeat the run)";

/** The flags only a host's eval knows: office mode, its memory, an installed company. */
const HOSTED_FLAGS: readonly string[] = ["--mode", "--memory", "--no-memory", "--company"];

/**
 * Parses the eval command's arguments: one positional role directory, then the flags above. The
 * host's flags (`--mode`, `--memory`, `--no-memory`, `--company`) are known only when `hosted`.
 */
function parseEvalArguments(
  args: readonly string[],
  hosted: boolean,
  usage: string,
): EvalArguments {
  let roleDir: string | undefined;
  let model: string | undefined;
  let tag: string | undefined;
  const scenarios: string[] = [];
  let trials: number | undefined;
  let normalTrials: number | undefined;
  let retries: number | undefined;
  let maxOutputTokens: number | undefined;
  let script: string | undefined;
  let suite: string | undefined;
  let mode: "bare" | "office" | undefined;
  let memory: boolean | undefined;
  let report: string | undefined;
  let judge: string | undefined;
  const overlays: string[] = [];
  let company: string | undefined;
  const packs: (typeof OFFICE_PACKS)[number][] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      if (roleDir !== undefined)
        throw new UsageError(`Only one role directory is allowed.\n${usage}`);
      roleDir = token;
      continue;
    }
    if (!hosted && HOSTED_FLAGS.includes(token)) {
      throw new UsageError(`Unknown option: ${token}\n${usage}`);
    }
    // The flags that take no value.
    if (token === "--memory" || token === "--no-memory") {
      if (memory !== undefined && memory !== (token === "--memory")) {
        throw new UsageError(`--memory and --no-memory cannot both be given.\n${usage}`);
      }
      memory = token === "--memory";
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${token} requires a value.\n${usage}`);
    }
    index += 1;
    if (token === "--model") model = value;
    else if (token === "--tag") tag = value;
    else if (token === "--scenario") scenarios.push(value);
    else if (token === "--script") script = value;
    else if (token === "--suite") suite = value;
    else if (token === "--report") report = value;
    else if (token === "--overlay") overlays.push(value);
    else if (token === "--company") company = value;
    else if (token === "--pack") {
      const pack = OFFICE_PACKS.find((known) => known === value);
      if (pack === undefined) {
        throw new UsageError(
          `--pack must name a tool pack an office supplies: ${OFFICE_PACKS.join(", ")} (got ${JSON.stringify(value)}).`,
        );
      }
      if (!packs.includes(pack)) packs.push(pack);
    } else if (token === "--judge") {
      if (value === "scripted") {
        throw new UsageError(
          `--judge names a live model, provider/model; a scripted model cannot judge a reply.\n${usage}`,
        );
      }
      judge = value;
    } else if (token === "--mode") {
      if (value !== "bare" && value !== "office") {
        throw new UsageError(`--mode must be bare or office (got ${JSON.stringify(value)}).`);
      }
      mode = value;
    } else if (token === "--trials") {
      trials = positiveInteger(token, value);
    } else if (token === "--normal-trials") {
      normalTrials = positiveInteger(token, value);
    } else if (token === "--max-output-tokens") {
      maxOutputTokens = positiveInteger(token, value);
    } else if (token === "--retries") {
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new UsageError(
          `--retries must be a whole number of 0 or more (got ${JSON.stringify(value)}).`,
        );
      }
      retries = count;
    } else throw new UsageError(`Unknown option: ${token}\n${usage}`);
  }
  if (roleDir === undefined) throw new UsageError(`eval requires a role directory.\n${usage}`);
  if (memory !== undefined && mode !== "office") {
    const flag = memory ? "--memory" : "--no-memory";
    throw new UsageError(
      `${flag} sets office memory, which only office mode has; set --mode to office.\n${usage}`,
    );
  }
  return {
    roleDir,
    ...(model === undefined ? {} : { model }),
    ...(tag === undefined ? {} : { tag }),
    ...(scenarios.length === 0 ? {} : { scenarios }),
    ...(trials === undefined ? {} : { trials }),
    ...(normalTrials === undefined ? {} : { normalTrials }),
    ...(retries === undefined ? {} : { retries }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(script === undefined ? {} : { script }),
    ...(suite === undefined ? {} : { suite }),
    ...(mode === undefined ? {} : { mode }),
    ...(memory === undefined ? {} : { memory }),
    ...(report === undefined ? {} : { report }),
    ...(judge === undefined ? {} : { judge }),
    ...(overlays.length === 0 ? {} : { overlays }),
    ...(company === undefined ? {} : { company }),
    ...(packs.length === 0 ? {} : { packs }),
  };
}

/** A flag's value as a positive integer, or a usage error naming the flag. */
function positiveInteger(flag: string, value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new UsageError(`${flag} must be a positive integer (got ${JSON.stringify(value)}).`);
  }
  return count;
}

/**
 * `officehum eval ROLE_DIR`: validate the role package, run its eval suites, print the report, and
 * exit non-zero when the suite fails.
 */
export async function runEvalCommand(
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
  office?: EvalOffice,
): Promise<number> {
  const usage = office?.usage ?? EVAL_USAGE;
  const parsed = parseEvalArguments(args, office !== undefined, usage);
  const checked = await validatePackage(parsed.roleDir);
  if (!checked.ok) {
    for (const issue of checked.issues) io.error(formatIssue(issue));
    return 1;
  }
  const pkg = checked.value;
  // Under a business's overlays: refused before any trial when they do not load, and named first.
  let overlayLines: string[] = [];
  if (parsed.overlays !== undefined) {
    const defaults = resolveRoleFiles({ packageDir: parsed.roleDir, manifest: pkg.manifest });
    const under = resolveRoleFiles({
      packageDir: parsed.roleDir,
      manifest: pkg.manifest,
      overlays: parsed.overlays,
    });
    if (!under.ok) {
      for (const issue of under.issues) io.error(formatIssue(issue));
      return 1;
    }
    const lowered = defaults.ok ? loweredGuards(pkg.manifest, defaults.value, under.value) : [];
    overlayLines = [
      `Overlays: ${parsed.overlays.join(", ")} (a result under a business's overlays, not on the role's defaults)`,
      ...(lowered.length === 0
        ? ["They lower no safeguard."]
        : loweredLines(pkg.manifest.name, lowered)),
    ];
  }
  const ref: ModelRef =
    parsed.model === "scripted"
      ? { provider: "scripted", modelId: SCRIPTED_MODEL_ID }
      : parsed.model === undefined
        ? {
            provider: pkg.manifest.defaultModel.provider,
            modelId: pkg.manifest.defaultModel.modelId,
          }
        : parseModelRef(parsed.model);

  // The packs the role is given must be ones it declares tools from.
  for (const pack of parsed.packs ?? []) {
    if (!pkg.manifest.tools.some((tool) => tool.pack === pack)) {
      throw new UsageError(
        `--pack ${pack}: ${pkg.name} declares no tool from the ${pack} pack, so there is nothing to give it.\n${usage}`,
      );
    }
  }
  // Only its light entry: the tools are stubs, so the engine never loads.
  const data = parsed.packs?.includes("data") === true ? await importDataPack() : undefined;

  // What the run can honour: an office-only suite needs a host's office mode, a scripted-only one a
  // scripted model, a suite that declares packs those packs. `runEvals` skips the rest and the
  // report names them.
  const run = {
    mode: parsed.mode ?? "bare",
    model: ref.provider === "scripted" ? "scripted" : "live",
    ...(parsed.packs === undefined ? {} : { packs: parsed.packs }),
  } as const;
  const kept = office?.roleSuites(pkg);
  let suites: EvalSuite[] = [
    ...Object.values(pkg.suites),
    ...Object.values(pkg.officeSuites),
    ...(kept?.suites ?? []),
  ];
  if (parsed.suite !== undefined) {
    const checkedSuite = validateSuite(
      await readJsonFile(parsed.suite, "--suite"),
      pkg.manifest,
      parsed.suite,
    );
    if (!checkedSuite.ok) {
      for (const issue of checkedSuite.issues) io.error(formatIssue(issue));
      return 1;
    }
    suites = [checkedSuite.value];
  }
  const selection = {
    ...(parsed.tag === undefined ? {} : { tag: parsed.tag }),
    ...(parsed.scenarios === undefined ? {} : { scenarios: parsed.scenarios }),
    ...run,
  };
  let scenarios: Scenario[];
  try {
    scenarios = selectScenarios(suites, selection);
  } catch (error) {
    // Only an unknown --scenario id throws here, and it is the operator's typo: a usage error.
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
  }
  if (scenarios.length === 0) {
    io.error(
      parsed.tag === undefined
        ? `${pkg.name} has no eval scenarios.`
        : `${pkg.name} has no scenarios tagged ${JSON.stringify(parsed.tag)}.`,
    );
    return 1;
  }

  const script =
    ref.provider === "scripted"
      ? [
          ...scriptFilesFor(parsed, usage),
          ...(parsed.script === undefined ? (kept?.scripts ?? []) : []),
        ]
      : undefined;
  // The credential is required before any trial starts, for the judge as for the trials.
  let live: EvalModel | undefined;
  let model: (scenario: Scenario, trial: number, context: TrialContext) => EvalModel;
  if (script === undefined) {
    const runtime = runModels(ref, dependencies, "eval");
    live = runtime;
    model = () => runtime;
  } else {
    model = await scriptedModel(script, scenarios, usage);
  }
  // The judge is the trials' own live model unless --judge names another; never a fallback.
  const judge =
    parsed.judge === undefined
      ? live
      : runModels(parseModelRef(parsed.judge, "--judge"), dependencies, "eval");

  // As an installed office: the role is given the company file's company, and reads its
  // handbook from an office layer written for the run, below any --overlay.
  const installed =
    parsed.company === undefined ? undefined : office?.installedCompany(parsed.company);
  const overlays = [
    ...(installed === undefined ? [] : [installed.layer]),
    ...(parsed.overlays ?? []),
  ];
  // The run's office layer is removed when the run ends, however it ends.
  const options: PiDurableRunnerOptions = {
    dir: parsed.roleDir,
    model,
    ...(overlays.length === 0 ? {} : { overlays }),
    ...(judge === undefined ? {} : { judge }),
    ...(data === undefined
      ? {}
      : { packs: (manifest) => [dataPackFor(data, manifest, undefined)] }),
    maxOutputTokens: parsed.maxOutputTokens ?? DEFAULT_EVAL_MAX_OUTPUT_TOKENS,
  };
  const runner =
    office === undefined
      ? piDurableRunner(options)
      : office.runner(options, {
          ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
          ...(parsed.memory === undefined ? {} : { memory: parsed.memory }),
          ...(installed === undefined ? {} : { company: installed }),
        });
  const report = await runEvals(suites, runner, {
    ...selection,
    ...(parsed.trials === undefined ? {} : { trials: parsed.trials }),
    ...(parsed.normalTrials === undefined ? {} : { normalTrials: parsed.normalTrials }),
    ...(parsed.retries === undefined ? {} : { retries: parsed.retries }),
  }).finally(() => {
    if (installed !== undefined) rmSync(installed.root, { recursive: true, force: true });
  });
  for (const line of overlayLines) io.output(line);
  if (installed !== undefined) {
    io.output(
      `Company: ${installed.name} from ${parsed.company} (an installed office's own record, with no demonstration data; not the sample company). read_company runs for real against it, and a scenario whose stubs name the sample company is not run`,
    );
  }
  if (parsed.packs !== undefined) {
    io.output(
      `Packs: ${parsed.packs.join(", ")} (the tools the role declares from them are offered, stubbed like every declared tool)`,
    );
  }
  io.output(
    `Model: ${ref.provider}/${ref.modelId}${script === undefined ? "" : ` (script ${script.join(", ")})`}`,
  );
  if (judge !== undefined) io.output(`Judge: ${judge.model.provider}/${judge.model.modelId}`);
  io.output(formatReport(report));
  for (const line of failingTrialLines(report)) io.output(line);
  // A scripted model's tokens are pi-ai's estimates and cost nothing, so only a live run prints them;
  // the --report file carries the usage either way.
  if (script === undefined && report.usage !== undefined) io.output(formatUsage(report.usage));
  if (parsed.report !== undefined) {
    // The SDK report as is: traces carry calls, approvals and replies, and nothing reads the environment.
    try {
      await writeFile(parsed.report, `${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      throw new Error(
        `Could not write the --report file ${parsed.report}: ${String(error)}. Check that its directory exists and is writable.`,
      );
    }
    io.output(`Report written to ${parsed.report}`);
  }
  return { passed: 0, failed: 1, incomplete: EXIT_INCOMPLETE }[report.outcome];
}

/**
 * One line per failing trial: the tools it called and the start of its reply, for a quick look. An
 * errored trial is not a failing one; the report already prints each of its provider errors.
 */
function failingTrialLines(report: EvalReport): string[] {
  return report.scenarios.flatMap((scenario) =>
    scenario.trials
      .filter((trial) => trial.outcome === "failed")
      .map((trial) => {
        const calls = trial.trace.calls.map((call) => call.tool).join(", ") || "none";
        const reply = (trial.trace.reply ?? "").replace(/\s+/g, " ").slice(0, 200);
        return `trial ${scenario.id} #${trial.trial}: calls [${calls}]; reply: ${reply === "" ? "(none)" : reply}`;
      }),
  );
}

/** The role's own script file: `evals.smoke.json` beside `evals/`, read without `--script`. */
const DEFAULT_SCRIPT_FILE = "evals.smoke.json";

/** The turns of the role's office-only suite (`evals/office.json`), read beside the default file. */
const OFFICE_SCRIPT_FILE = "evals.office.json";

/**
 * The script files to read: `--script FILE` when given, otherwise the role's own `evals.smoke.json`,
 * and its `evals.office.json` when it ships one. A role that ships no `evals.smoke.json` is a usage
 * error, raised before any trial runs.
 */
function scriptFilesFor(parsed: EvalArguments, usage: string): readonly string[] {
  if (parsed.script !== undefined) return [parsed.script];
  const file = join(parsed.roleDir, DEFAULT_SCRIPT_FILE);
  if (!existsSync(file)) {
    throw new UsageError(
      `--model scripted needs --script FILE, or ${DEFAULT_SCRIPT_FILE} in ${parsed.roleDir}.\n${usage}`,
    );
  }
  const office = join(parsed.roleDir, OFFICE_SCRIPT_FILE);
  return existsSync(office) ? [file, office] : [file];
}

/**
 * The scripted model factory: rebuilds the provider for every trial so the script replays each time,
 * with the trial's ticket for a script's `{ticket.id}`.
 */
async function scriptedModel(
  files: readonly string[],
  scenarios: readonly Scenario[],
  usage: string,
) {
  const script: Record<string, readonly ScriptedTurn[]> = {};
  for (const file of files) Object.assign(script, await readEvalScript(file));
  const named = files.join(", ");
  const missing = scenarios.filter((scenario) => script[scenario.id] === undefined);
  if (missing.length > 0) {
    throw new UsageError(
      `The --script file ${named} has no turns for ${missing.map((scenario) => JSON.stringify(scenario.id)).join(", ")}.\n${usage}`,
    );
  }
  return (scenario: Scenario, _trial: number, trial: TrialContext): EvalModel => {
    const turns = script[scenario.id];
    if (turns === undefined) throw new Error(`No turns for ${scenario.id} in ${named}.`);
    return scriptedProvider(
      turns,
      trial.ticketId === undefined ? {} : { ticketId: trial.ticketId },
    );
  };
}

/** Reads a JSON file named by `flag`, saying which flag's file could not be read. */
async function readJsonFile(file: string, flag: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read the ${flag} file ${file}: ${String(error)}.`);
  }
}

/** Reads and checks a script file: JSON of scenario id → the turns to play back, in order. */
async function readEvalScript(
  file: string,
): Promise<Readonly<Record<string, readonly ScriptedTurn[]>>> {
  const parsed = await readJsonFile(file, "--script");
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
