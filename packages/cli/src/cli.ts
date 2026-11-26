/**
 * `officehum`'s one-agent commands: run a role in the terminal, grade its evals, check a judge,
 * verify a `role.md`, and review a document before it is published. Each runs one role package on
 * `@officehum/runner`.
 *
 * A host adds commands through `CliExtension`: it passes its own usage and commands and runs
 * the rest here, so the two share one dispatcher, one `--version` and
 * one exit-code convention.
 */

import { join } from "node:path";
import type { createModels } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
import { loadRole, openRoleRun, PI_DURABLE_VERSION } from "@officehum/runner";
import {
  type AgentManifest,
  localVersionedFileStore,
  loweredGuards,
  type ResolvedRole,
  resolveRoleFiles,
} from "@officehum/sdk";
import {
  publicationGate,
  type ReviewResult,
  reviewLedger,
  reviewReport,
  reviewSummaryLine,
} from "@officehum/tools-paper-office";
import { type EvalOffice, runEvalCommand } from "./eval.js";
import { JUDGE_CHECK_USAGE, runJudgeCheckCommand } from "./judge-check.js";
import { loweredLines } from "./lowered.js";
import {
  deskBanner,
  operatorSender,
  parseModelRef,
  parseRunArguments,
  printRunResult,
  readClientConfig,
  runInteractive,
  runModels,
  terminalApprover,
  terminalUser,
} from "./run.js";
import { UsageError } from "./usage-error.js";
import { runVerifyRoleCommand } from "./verify-role.js";

export interface CliIo {
  output(line: string): void;
  error(line: string): void;
  readApproval(prompt: string): Promise<string | undefined>;
  /** Reads one terminal line, for the interactive `run` command. Absent means no line input. */
  readLine?(prompt: string): Promise<string | undefined>;
}

let activeSession: { close(): Promise<void> } | undefined;

/** Called by the executable's SIGINT handler so unfinished durable work remains resumable. */
export async function interruptCli(): Promise<void> {
  await activeSession?.close();
}

export interface CliDependencies {
  /** Overrides the models `run` and `eval` talk to; tests inject the scripted provider here. */
  readonly createRunModels?: (ref: ModelRef) => {
    readonly models: ReturnType<typeof createModels>;
    readonly model: ModelRef;
  };
  /** Fetches a page's text for `verify-role --online`; tests inject it so none touch the network. */
  readonly fetchText?: (url: string) => Promise<string>;
}

/** Registers what Ctrl-C closes for a long-running command; returns the call that unregisters it. */
export type RegisterSession = (session: { close(): Promise<void> }) => () => void;

/** What a host adds to the command line: its own commands, and its usage in place of this one. */
export interface CliExtension {
  /** The whole usage, printed for no arguments and in a usage error. */
  readonly usage: string;
  /** Commands by name; each is given the arguments after its name. */
  readonly commands: Readonly<
    Record<string, (args: readonly string[], register: RegisterSession) => Promise<number>>
  >;
  /** Runs any other command line (all of it); omitted, an unknown command is a usage error. */
  readonly otherwise?: (args: string[]) => Promise<number>;
  /** What the host adds to `officehum eval`: its office mode, memory and installed company. */
  readonly eval?: EvalOffice;
}

const USAGE = `Usage:
  officehum run ROLE_DIR [--overlay DIR]... [--db FILE] [--data DIR] [--work DIR] [--model provider/model] [--clients FILE] [--as PERSON] [--demo]
  officehum eval ROLE_DIR [--model provider/model] [--tag TAG] [--scenario ID]... [--trials N] [--normal-trials N] [--retries N] [--max-output-tokens N] [--script FILE] [--suite FILE] [--report FILE] [--judge provider/model] [--overlay DIR]...
    (exits 0 passed, 1 failed, 3 incomplete: the model provider did not complete a trial; repeat the run)
  ${JUDGE_CHECK_USAGE}
  officehum verify-role ROLE_DIR [--online]
  officehum review list [--state DIR]
  officehum review show [--state DIR] --review REVIEW_ID
  officehum review decide [--state DIR] --review REVIEW_ID --verdict approve|deny --by NAME [--approval ID]
  officehum review publish [--state DIR] --review REVIEW_ID --operation-id OID [--approval ID]
  officehum --version`;

/**
 * `officehum run ROLE_DIR`: load one role package, open an office on its SQLite file, resume anything
 * a previous run left unfinished, and chat with the role until end of input.
 */
async function runRun(
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseRunArguments(args);
  // A named model is resolved first, so a missing credential fails before any role code runs.
  const requested = parsed.model === undefined ? undefined : parseModelRef(parsed.model);
  const early = requested === undefined ? undefined : runModels(requested, dependencies);
  const clients = parsed.clientFile === undefined ? {} : await readClientConfig(parsed.clientFile);
  // With no --as the role gets no resolver, so every sender is unknown, as for a stranger.
  const operator = parsed.as === undefined ? undefined : operatorSender(parsed.roleDir, parsed.as);
  const role = await loadRole(parsed.roleDir, {
    overlays: parsed.overlays,
    approve: terminalApprover(io),
    ...(operator === undefined ? {} : { sender: operator.sender }),
    // A role with no desk bound refuses its desk tools unless the operator asks for the demo data.
    ...(parsed.demo === true ? { demo: true } : {}),
    ...(parsed.dataDir === undefined ? {} : { dataDir: parsed.dataDir }),
    ...(parsed.workDir === undefined ? {} : { workDir: parsed.workDir }),
    clients,
  });
  const ref = requested ?? {
    provider: role.manifest.defaultModel.provider,
    modelId: role.manifest.defaultModel.modelId,
  };
  const runtime = early ?? runModels(ref, dependencies);
  const database = parsed.database ?? join(".officehum", `${role.manifest.id}.sqlite`);
  const session = await openRoleRun({
    role,
    database,
    models: runtime.models,
    model: runtime.model,
  });
  activeSession = session;
  try {
    io.output(`${role.manifest.name} (${role.manifest.id}) — ${role.manifest.role}`);
    // What the overlay files lower: your own files, so nothing to acknowledge, but said.
    for (const line of loweredLines(role.manifest.name, runLowered(role))) io.output(line);
    io.output(`Model: ${runtime.model.provider}/${runtime.model.modelId}`);
    io.output(`Office: ${database}`);
    io.output(`Approval: this terminal (y/n), as ${terminalUser()}`);
    io.output(
      operator === undefined
        ? "Sender: unknown (anything a role gives only to a known sender is refused; pass --as PERSON to be a person on the company record)"
        : `Sender: ${operator.person.name} (${operator.person.id}), at this terminal`,
    );
    const desk = deskBanner(parsed.demo, clients);
    if (desk !== undefined) io.output(desk);
    for (const command of role.manifest.commands ?? []) {
      io.output(`Command /${command.name}: ${command.description}`);
    }
    const resumed = await session.resume();
    for (const result of resumed) printRunResult(result, io);
    if (resumed.length > 0) io.output(`Resumed ${resumed.length} unfinished submission(s).`);
    return await runInteractive(session, io);
  } finally {
    try {
      await session.close();
    } finally {
      if (activeSession === session) activeSession = undefined;
    }
  }
}

const REVIEW_USAGE = `Usage:
  officehum review list [--state DIR]
  officehum review show [--state DIR] --review REVIEW_ID
  officehum review decide [--state DIR] --review REVIEW_ID --verdict approve|deny --by NAME [--approval ID]
  officehum review publish [--state DIR] --review REVIEW_ID --operation-id OID [--approval ID]`;

interface ReviewArguments {
  readonly sub: string;
  readonly state: string;
  readonly review: string | undefined;
  readonly verdict: "approve" | "deny" | undefined;
  readonly by: string | undefined;
  readonly approval: string | undefined;
  readonly operationId: string | undefined;
}

function parseReviewArguments(args: readonly string[]): ReviewArguments {
  const sub = args[0];
  if (sub === undefined) throw new UsageError(REVIEW_USAGE);
  const options: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 2) {
    const raw = args[index];
    const option = raw?.replace(/^--/u, "");
    if (raw === undefined || !raw.startsWith("--") || option === undefined) {
      throw new UsageError(`Unknown option: ${raw ?? ""}\n${REVIEW_USAGE}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${raw} requires a value.\n${REVIEW_USAGE}`);
    }
    options[option] = value;
  }
  const verdict = options.verdict;
  if (verdict !== undefined && verdict !== "approve" && verdict !== "deny") {
    throw new UsageError("--verdict must be approve or deny.");
  }
  return {
    sub,
    state: options.state ?? join(".officehum", "documents"),
    review: options.review,
    verdict,
    by: options.by,
    approval: options.approval,
    operationId: options["operation-id"],
  };
}

function requireReviewOption(value: string | undefined, name: string): string {
  if (value === undefined) throw new UsageError(`review needs ${name}.\n${REVIEW_USAGE}`);
  return value;
}

/**
 * The person's review of an exact proposed file version, and the publication that follows it.
 *
 * This is a *different* gate from `--approval`: that one decides whether a gated tool call may run,
 * and says nothing about which bytes would become the published version. This one shows the exact
 * artifact identity and the format-native evidence, records a person's decision bound to those
 * hashes, and only then lets the FileStore compare-and-swap the published pointer — refusing, with
 * the pointer left where it was, whenever the review is missing, denied, mismatched or superseded.
 */
async function runReview(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseReviewArguments(args);
  const store = localVersionedFileStore(join(parsed.state, "files"));
  const ledger = reviewLedger(join(parsed.state, "reviews"));

  if (parsed.sub === "list") {
    const records = await ledger.list();
    if (records.length === 0) io.output("No reviews.");
    else for (const record of records) io.output(reviewSummaryLine(record));
    return 0;
  }

  const gate = publicationGate({ store, ledger });

  if (parsed.sub === "show") {
    const found = await gate.get(requireReviewOption(parsed.review, "--review"));
    if (!found.ok) return refused(found, io);
    for (const line of reviewReport(found.value)) io.output(line);
    return 0;
  }

  if (parsed.sub === "decide") {
    const reviewId = requireReviewOption(parsed.review, "--review");
    const verdict = parsed.verdict;
    if (verdict === undefined)
      throw new UsageError(`review decide needs --verdict.\n${REVIEW_USAGE}`);
    const decided = await gate.decide({
      reviewId,
      verdict: verdict === "approve" ? "approved" : "denied",
      by: requireReviewOption(parsed.by, "--by"),
      approvalId: parsed.approval ?? `cli:${reviewId}`,
    });
    if (!decided.ok) return refused(decided, io);
    io.output(
      `${decided.value.verdict === "approved" ? "Approved" : "Denied"} ${reviewId} ` +
        `by ${decided.value.by} (approval ${decided.value.approvalId})`,
    );
    return 0;
  }

  if (parsed.sub === "publish") {
    const published = await gate.publish({
      reviewId: requireReviewOption(parsed.review, "--review"),
      operationId: requireReviewOption(parsed.operationId, "--operation-id"),
      ...(parsed.approval === undefined ? {} : { approvalId: parsed.approval }),
    });
    if (!published.ok) return refused(published, io);
    io.output(
      `Published ${published.value.receipt.published.name} ` +
        `${published.value.receipt.previous?.versionId ?? "unpublished"} -> ` +
        `${published.value.receipt.published.versionId} (operation ${published.value.operationId})`,
    );
    return 0;
  }

  throw new UsageError(`Unknown review subcommand: ${parsed.sub}\n${REVIEW_USAGE}`);
}

function refused(result: ReviewResult<unknown>, io: CliIo): number {
  if (result.ok) return 0;
  io.error(`Refused (${result.code}): ${result.message}`);
  return 1;
}

export async function runCli(
  args: string[],
  io: CliIo,
  dependencies: CliDependencies = {},
  extension?: CliExtension,
): Promise<number> {
  const usage = extension?.usage ?? USAGE;
  try {
    if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
      io.output(`officehum 0.0.0 (Pi Durable ${PI_DURABLE_VERSION})`);
      return 0;
    }
    const [command, ...rest] = args;
    if (command === "run") return await runRun(rest, io, dependencies);
    if (command === "review") return await runReview(rest, io);
    if (command === "eval") return await runEvalCommand(rest, io, dependencies, extension?.eval);
    if (command === "judge-check") return await runJudgeCheckCommand(rest, io, dependencies);
    if (command === "verify-role") return await runVerifyRoleCommand(rest, io, dependencies);
    const hosted = command === undefined ? undefined : extension?.commands[command];
    if (hosted !== undefined) {
      // Long-running commands register what Ctrl-C closes.
      return await hosted(rest, (session) => {
        activeSession = session;
        return () => {
          if (activeSession === session) activeSession = undefined;
        };
      });
    }
    if (extension?.otherwise !== undefined) return await extension.otherwise(args);
    if (command === undefined) throw new UsageError(usage);
    throw new UsageError(`Unknown command: ${command}\n${usage}`);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError ? 2 : 1;
  }
}

/**
 * The safeguards a role run with `--overlay` holds below its defaults: its package alone
 * against what it loaded. None for a role whose factory cannot say what it loaded.
 */
function runLowered(role: {
  readonly dir: string;
  readonly manifest: AgentManifest;
  readonly current?: (() => ResolvedRole) | undefined;
}) {
  const current = role.current?.();
  if (current === undefined) return [];
  const defaults = resolveRoleFiles({ packageDir: role.dir, manifest: role.manifest });
  return defaults.ok ? loweredGuards(role.manifest, defaults.value, current) : [];
}
