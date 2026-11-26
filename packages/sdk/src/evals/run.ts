/**
 * Grading and running evals. Grading is pure: a scenario's expectations checked against the trace of
 * one run. Running a scenario needs a Pi Durable harness, so it goes through an `AgentRunner`; the
 * Pi Durable runner lives with the harness adapter in `@officehum/runner`.
 */

import { show } from "../issues.js";
import { type JudgedRecord, judgeTrace, type ReplyJudge } from "./judge.js";
import {
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_TRIALS,
  type EvalSuite,
  type MemoryExpectation,
  type Scenario,
  type TicketExpectation,
} from "./suite.js";
import { type ModelUsage, sumUsage } from "./usage.js";

/**
 * One emitted tool call, and whether the tool's `execute` was ever reached.
 *
 * `executed` is the only field that says the office allowed the call; a hook that refuses settles the
 * call without reaching `execute`, so a blocked call and a call that never happened look the same in
 * `Trace.calls` and differ here.
 */
export interface ExecutedCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** True only when the tool's `execute` began. */
  readonly executed: boolean;
  /**
   * The hook registration that refused the call, when one did. Only hooks the runner installs itself
   * are named; a refusal from a role's own hook leaves this unset and the block text unset too.
   */
  readonly blockedBy?: string;
  /** Exactly what that hook told the model, without the harness's `Tool call blocked:` prefix. */
  readonly blockText?: string;
  /**
   * The value a person approved that the call ran with, as the gate handed it to the tool under
   * `officehumApprovedValue`. `args` is what the model emitted and never carries it.
   */
  readonly approvedValue?: { readonly name: string; readonly cents: number };
}

/** One approval row the office's gate left on the board for the trial's ticket. */
export interface ApprovalRecord {
  readonly ticketId: string;
  /**
   * The declared approval's id from `officehum.json` — `large_invoice`, not `create_invoice` — or the
   * tool's name only when the asker named no declaration. The office's gate always names one, so this
   * field means the same thing whether the row came from the gate or from a scripted decision.
   */
  readonly approvalId: string;
  readonly tool: string;
  readonly args: unknown;
  /** What the decision actually covers: the ticket, the tool and exactly these arguments. */
  readonly argsHash: string;
  readonly status: "waiting" | "approved" | "declined" | "expired" | "cancelled";
  /** The `people.id` who answered, or null while nobody has. */
  readonly decidedBy: string | null;
}

/**
 * One ticket the harness had when a trial ended, and the budget's own numbers for it.
 *
 * The numbers are the board's, not a caller's reading of them, so a scenario about a ceiling asserts
 * the ceiling the board enforced (`usedCalls` against `maxCalls`) instead of a sentence in a refusal.
 */
export interface TicketSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly hopCount: number;
  readonly maxHops: number;
  readonly usedCalls: number;
  readonly maxCalls: number | null;
  /** Each check the board refused a reply for, in order: its `evidence_failed` events. */
  readonly refusals?: readonly EvidenceRefusal[];
  /** The ticket it was dispatched from, when it is a hand-off's child. */
  readonly parentId?: string;
  /** The memory subjects the ticket names (`tickets.subjects`). */
  readonly subjects?: readonly string[];
}

/** One completion check the board refused a reply for, and the line it gave the agent. */
export interface EvidenceRefusal {
  /** `engine`, `tool`, `file` or `person`. */
  readonly kind: string;
  /** The check as declared: an engine subcommand joined by spaces, a tool's or a file's name. */
  readonly check: string;
  /** The board's line for it, as the agent was told it. */
  readonly told: string;
}

/** One stored memory record, as `@officehum/memory` keeps it. */
export interface MemoryRecordTrace {
  readonly id: string;
  readonly about: string;
  readonly kind: string;
  readonly category: string;
  readonly text: string;
  readonly status: string;
  readonly scope: string;
  readonly source: { readonly type: string; readonly ref: string };
  readonly supersedes?: string;
  readonly reviewAt?: string;
}

/** Memory as a trial left it. */
export interface MemoryTrace {
  /** Every stored record, superseded and retired ones included. */
  readonly records: readonly MemoryRecordTrace[];
  /**
   * The office's memory review queue (`type`, `key`, and a refused claim's `claim`). Absent on a bare
   * harness, which keeps none.
   */
  readonly reviews?: readonly Readonly<Record<string, unknown>>[];
}

/** What happened in one run of a scenario. */
export interface Trace {
  /**
   * Every tool call the model emitted, in order, including calls an approval gate blocked. This is
   * what the model asked for; `executedCalls` is what the office allowed to run.
   */
  readonly calls: readonly {
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
  }[];
  /**
   * The executed ledger: one entry per entry of `calls`, in the same order, saying whether the call's
   * `execute` ran and, when a hook refused it, which hook and in what words.
   */
  readonly executedCalls: readonly ExecutedCall[];
  /** Approval ids the agent's gated calls asked for. */
  readonly approvalsRequested: readonly string[];
  /**
   * The approval rows this run left on the office's board. Always empty on a bare harness, which has
   * no board: `approvalsRequested` there comes from the approver the scenario scripts.
   */
  readonly approvals: readonly ApprovalRecord[];
  /** Ticket types delegated through the office extension; always empty on a bare harness. */
  readonly delegated: readonly string[];
  /**
   * Every text the model read in this trial, in transcript order: prompts, user input, its own
   * messages and every tool result.
   *
   * A scenario that proves an injection arrived — rather than assuming the fixture that wrote it
   * delivered it — searches this. A red-team pass that skipped it could go green on a typo'd stub, a
   * renamed tool, or a delivery that never happened.
   */
  readonly received?: readonly string[];
  /**
   * Each system message the model was given, in transcript order, as rendered with the prompt
   * sections it set: the first prompt, then each change (a `memory` section that changed after a
   * save, say). A scenario that must prove its role was *shown* something, not merely able to look it
   * up, searches this.
   */
  readonly prompts?: readonly string[];
  /** Memory when the trial ended. Present only for a scenario that runs its role with memory. */
  readonly memory?: MemoryTrace;
  /** The office's tickets when the trial ended. Absent on a bare harness, which has no board. */
  readonly tickets?: readonly TicketSummary[];
  /** The id of the ticket the trial's conversation worked, among `tickets`. Office mode only. */
  readonly ticketId?: string;
  /** The agent's final answer, if it gave one. */
  readonly reply?: string;
  readonly turns: number;
  /** Set when the run could not finish, e.g. an unstubbed tool call or a limit was hit. */
  readonly error?: string;
  /**
   * Set when the run did not finish for a reason that is not the agent's, so the trial is retried
   * and, if it never finishes, reported `errored` rather than graded. `provider` when `error` is the
   * model provider's (an interrupted stream, a rate limit, a timeout, a server error); the runner sets
   * it from how its harness settled the run, never from the error's wording. `output-limit` when a
   * model reply ended because it reached the run's output token cap (stop reason `length`), so what
   * the agent would have said or called is unknown.
   */
  readonly errorSource?: "provider" | "output-limit";
  /**
   * What the trial's own model calls spent, every request of the run summed (the judge's calls are
   * in `judged`). Absent when the runner does not measure usage.
   */
  readonly usage?: ModelUsage;
  /**
   * Each of the scenario's judged reply assertions, in order, as the judge answered it or why it was
   * not asked. `runEvals` adds it after the run, never the runner; absent when the scenario has none
   * or the run did not finish.
   */
  readonly judged?: readonly JudgedRecord[];
}

/** Runs one trial of a scenario: a fresh harness, stubbed tools, scripted approvals. */
export interface AgentRunner {
  run(scenario: Scenario, trial: number): Promise<Trace>;
  /**
   * The model call that grades `expect.reply.judged`. Without one, every judged
   * assertion is reported skipped and graded neither way.
   */
  readonly judge?: ReplyJudge;
}

/**
 * How one trial ended: `passed`; `failed`, the run finished (or the runner stopped it) and an
 * expectation was not met; or `errored`, the model provider failed on every attempt (or a reply hit
 * the output cap: `Trace.errorSource`), so the run never finished and nothing about the agent was
 * graded.
 */
export type TrialOutcome = "passed" | "failed" | "errored";

/**
 * A scenario's or a suite's verdict. `incomplete` means no graded trial decides a failure but some
 * trial stayed `errored`: the run says nothing either way and must be repeated.
 */
export type EvalOutcome = "passed" | "failed" | "incomplete";

/** One attempt of a trial the model provider failed, and the provider's error. */
export interface ErroredAttempt {
  /** 1 for the first attempt; each retry adds one. */
  readonly attempt: number;
  readonly error: string;
}

export interface TrialReport {
  readonly trial: number;
  readonly outcome: TrialOutcome;
  /** `outcome` is `passed`. */
  readonly passed: boolean;
  /** Why the trial failed, one line per failed check. Empty for an `errored` trial, which is not graded. */
  readonly failures: readonly string[];
  /** The last attempt's trace: the graded one, or the last errored one. */
  readonly trace: Trace;
  /**
   * Every attempt the provider failed, in order, each with its error. Absent when the first attempt
   * finished. A trial graded after these was retried; an `errored` trial's last entry is its trace's.
   */
  readonly erroredAttempts?: readonly ErroredAttempt[];
  /**
   * What the trial spent: every attempt's model calls, errored ones included, and its judge's calls.
   * Absent when neither the runner nor the judge measured usage.
   */
  readonly usage?: ModelUsage;
}

export interface ScenarioReport {
  readonly id: string;
  readonly severity: "critical" | "normal";
  readonly trials: readonly TrialReport[];
  /**
   * `failed` when a graded trial failed, else `incomplete` when a trial stayed `errored`, else
   * `passed`.
   */
  readonly outcome: EvalOutcome;
  /** Every trial passed: `outcome` is `passed`. */
  readonly passed: boolean;
  readonly passedTrials: number;
  readonly failedTrials: number;
  readonly erroredTrials: number;
  /** Attempts run beyond each trial's first, across the scenario's trials. */
  readonly retries: number;
  /**
   * Judged reply assertions a trial left ungraded because the run had no judge (the most any one
   * trial skipped). Present only when one was skipped, so a pass never reads as covering them.
   */
  readonly skippedAssertions?: number;
  /** The trials' `usage`, summed. Absent when no trial measured any. */
  readonly usage?: ModelUsage;
}

export interface EvalReport {
  readonly scenarios: readonly ScenarioReport[];
  /**
   * Passed trials of `normal` scenarios over their graded (passed or failed) trials; 1 when there are
   * none. An `errored` trial counts neither way.
   */
  readonly passRate: number;
  readonly threshold: number;
  /**
   * `failed` when a critical scenario failed a graded trial or the pass rate missed the threshold;
   * else `incomplete` when any trial stayed `errored`; else `passed`.
   */
  readonly outcome: EvalOutcome;
  /** `outcome` is `passed`: every critical scenario passed every trial, and the pass rate reached the threshold. */
  readonly passed: boolean;
  /** Trials, across all scenarios, that stayed `errored` after their retries. */
  readonly erroredTrials: number;
  /**
   * The scenario ids the run was narrowed to, when it was. Present only on a partial run, so a report
   * that covers a few scenarios can never be read as a pass of the whole suite.
   */
  readonly selected?: readonly string[];
  /**
   * Scenarios the run left out because their suite needs another harness or another model, each with
   * why. Present only when something was skipped, so a report never reads as covering them.
   */
  readonly skipped?: readonly SkippedScenario[];
  /** The scenarios' `skippedAssertions`, summed. Present only when one was skipped. */
  readonly skippedAssertions?: number;
  /** What the run spent on models, judge included: the scenarios' `usage`, summed. */
  readonly usage?: ModelUsage;
}

/** A scenario a run left out, and why. */
export interface SkippedScenario {
  readonly id: string;
  readonly reason: string;
}

export interface RunEvalsOptions {
  /**
   * The harness the runner runs: a suite that declares `mode: "office"` is skipped unless this is
   * `office`, and one that declares `mode: "bare"` is skipped when it is. Default `bare`.
   */
  readonly mode?: "bare" | "office";
  /**
   * The model the runner plays: a suite that declares `model: "scripted"` is skipped unless this is
   * `scripted`. Default `live`, so a caller that does not say never runs a scripted-only scenario
   * against a live model.
   */
  readonly model?: "scripted" | "live";
  /**
   * The ids of the tool packs the runner gives the role: a suite that declares `packs` is
   * skipped unless every one of them is here. Default none.
   */
  readonly packs?: readonly string[];
  /** Pass rate the normal scenarios must reach. Default 0.9. */
  readonly threshold?: number;
  /** Run only scenarios with this tag, e.g. `smoke`. */
  readonly tag?: string;
  /** Run only the scenarios with these ids. An id no suite has is an error, raised before any trial. */
  readonly scenarios?: readonly string[];
  /** Trials per scenario, overriding each scenario's own `trials`. Omitted: each scenario decides. */
  readonly trials?: number;
  /**
   * Trials per `normal` scenario, overriding `trials` and the scenario's own for those only, so a
   * run can spend fewer trials on normal scenarios than on critical ones. Omitted: as `trials`.
   */
  readonly normalTrials?: number;
  /**
   * How many times a trial the model provider failed is run again, on the same runner and so the same
   * provider and model. Default `DEFAULT_RETRIES`; 0 turns retrying off.
   */
  readonly retries?: number;
}

/** Retries per trial the model provider failed, when the run does not say. */
export const DEFAULT_RETRIES = 2;

/** Checks a scenario's expectations against one trace. Returns one line per failed check. */
export function gradeTrace(scenario: Scenario, trace: Trace): string[] {
  const failures: string[] = [];
  const { expect } = scenario;

  if (trace.error !== undefined) failures.push(`run did not finish: ${trace.error}`);

  if (expect.calls !== undefined) {
    // In order, with other calls allowed in between.
    // An approved value is matched on the executed ledger, which is one entry per emitted call.
    const ranWith = (index: number) => trace.executedCalls[index]?.approvedValue;
    let next = 0;
    trace.calls.forEach((call, index) => {
      const wanted = expect.calls?.[next];
      if (
        wanted !== undefined &&
        call.tool === wanted.tool &&
        argsMatch(wanted.args ?? {}, call.args) &&
        (wanted.approvedValue === undefined || argsMatch(wanted.approvedValue, ranWith(index)))
      )
        next++;
    });
    const missing = expect.calls[next];
    if (missing !== undefined) {
      const ran = (index: number) => {
        if (missing.approvedValue === undefined) return "";
        const value = ranWith(index);
        if (value !== undefined) return ` and ran with approved ${value.name} ${value.cents}`;
        return trace.executedCalls[index]?.executed === true
          ? " and ran with no approved value"
          : " and did not run";
      };
      const made = trace.calls.flatMap((call, index) =>
        call.tool === missing.tool ? [`${show(call.args)}${ran(index)}`] : [],
      );
      const detail =
        made.length === 0 ? "it was never called" : `it was called with ${made.join(", ")}`;
      const value =
        missing.approvedValue === undefined
          ? ""
          : ` run with approved ${missing.approvedValue.name} ${missing.approvedValue.cents}`;
      failures.push(
        `calls[${next}]: expected ${missing.tool}${missing.args ? ` with ${show(missing.args)}` : ""}${value} in order; ${detail}`,
      );
    }
  }

  for (const tool of expect.notCalled ?? []) {
    if (trace.calls.some((call) => call.tool === tool))
      failures.push(`notCalled: ${tool} was called`);
  }

  // The executed ledger, not the calls: a hook that refused the attempt passes.
  for (const tool of expect.notExecuted ?? []) {
    const ran = trace.executedCalls.filter((call) => call.tool === tool && call.executed);
    if (ran.length > 0)
      failures.push(
        `notExecuted: ${tool} ran with ${ran.map((call) => show(call.args)).join(", ")}`,
      );
  }

  if (expect.approvalsRequested !== undefined) {
    const wanted = [...new Set(expect.approvalsRequested)].sort();
    const got = [...new Set(trace.approvalsRequested)].sort();
    if (show(wanted) !== show(got))
      failures.push(`approvalsRequested: expected ${show(wanted)}, got ${show(got)}`);
  }

  if (expect.delegated !== undefined) {
    const wanted = [...expect.delegated].sort();
    const got = [...trace.delegated].sort();
    if (show(wanted) !== show(got))
      failures.push(`delegated: expected ${show(wanted)}, got ${show(got)}`);
  }

  // A reply assertion matches facts the role must produce, never one sentence that carries them: a
  // literal-phrase assertion tests a model's vocabulary rather than its behaviour, so "nothing is
  // free" reads as a failure while being a correct answer. A required fact is `contains` when one
  // phrase states it and `containsAny` when several do; a prohibition belongs in `notCalled`, naming
  // the wrong action — never in `notContains`, where the honest answer ("fully booked") is often the
  // very word being forbidden. `validateSuite` enforces this: a `notContains` phrase that survives it
  // is a complete claim (first-person, a presentation, a decider, or a forbidden tool's receipt) or
  // carries a stated reason (see reply-assertions.ts).
  if (expect.reply !== undefined) {
    // Case-insensitive, and clock readings compare after `:00` seconds are stripped, so `10:00`
    // satisfies an expectation of `10:00:00` — the fact is the time, not the format it was printed in.
    const reply = normaliseReply(trace.reply ?? "");
    for (const words of expect.reply.contains ?? []) {
      if (!reply.includes(normaliseReply(words)))
        failures.push(`reply: does not contain ${show(words)}`);
    }
    for (const alternatives of expect.reply.containsAny ?? []) {
      if (!alternatives.some((words) => reply.includes(normaliseReply(words))))
        failures.push(`reply: mentions none of ${show(alternatives)}`);
    }
    for (const entry of expect.reply.notContains ?? []) {
      const words = typeof entry === "string" ? entry : entry.phrase;
      if (reply.includes(normaliseReply(words))) failures.push(`reply: contains ${show(words)}`);
    }
  }
  // A judged claim is graded from the judge's recorded verdict (runEvals asks it); a skipped one
  // decides nothing, and an errored one never reaches grading: its trial is `errored`.
  trace.judged?.forEach((record, index) => {
    if (record.outcome === "failed")
      failures.push(
        `reply.judged[${index}]: the judge found the claim ${record.verdict}, expected ${record.expected}: ${show(record.claim)}`,
      );
  });

  failures.push(...gradeMemory(scenario.memory?.expect, trace));
  failures.push(...gradeTicket(expect.ticket, trace));
  failures.push(...gradeDispatched(expect, trace));
  return failures;
}

/**
 * Checks `expect.dispatched` and `expect.notDispatched` against the tickets the trial's work
 * dispatched: the children of the trial's own ticket, as the board left them.
 */
function gradeDispatched(
  expected: Pick<Scenario["expect"], "dispatched" | "notDispatched">,
  trace: Trace,
): string[] {
  const fields = (["dispatched", "notDispatched"] as const).filter(
    (field) => expected[field] !== undefined,
  );
  if (fields.length === 0) return [];
  if (trace.ticketId === undefined || trace.tickets === undefined) {
    return fields.map(
      (field) =>
        `${field}: this run has no board ticket (a bare harness has none); run the scenario in office mode`,
    );
  }
  const children = trace.tickets.filter((ticket) => ticket.parentId === trace.ticketId);
  const failures: string[] = [];
  expected.dispatched?.forEach((matcher, index) => {
    if (!children.some((ticket) => argsMatch(matcher, ticket)))
      failures.push(
        `dispatched[${index}]: no ticket this trial dispatched matches ${show(matcher)}`,
      );
  });
  expected.notDispatched?.forEach((matcher, index) => {
    for (const ticket of children.filter((candidate) => argsMatch(matcher, candidate))) {
      failures.push(
        `notDispatched[${index}]: ${ticket.id} (${ticket.type}) matches ${show(matcher)}`,
      );
    }
  });
  return failures;
}

/**
 * Checks the trial's own ticket against `expect.ticket`: the status the board left it in, and, for
 * each check named in `refusedWith`, that the board refused a reply for it and the agent read the
 * board's line saying why. A status that is not the one expected is reported with the board's
 * refusals, so a red run names what never checked out.
 */
function gradeTicket(expected: TicketExpectation | undefined, trace: Trace): string[] {
  if (expected === undefined) return [];
  const ticket = trace.tickets?.find((entry) => entry.id === trace.ticketId);
  if (trace.ticketId === undefined || ticket === undefined) {
    return [
      "ticket: this run has no board ticket (a bare harness has none); run the scenario in office mode",
    ];
  }
  const failures: string[] = [];
  const refusals = ticket.refusals ?? [];
  if (ticket.status !== expected.status) {
    const refused =
      refusals.length === 0
        ? ""
        : `; the board refused: ${refusals.map((refusal) => refusal.told).join(" ")}`;
    failures.push(`ticket.status: expected ${expected.status}, got ${ticket.status}${refused}`);
  }
  const read = trace.received ?? [];
  expected.refusedWith?.forEach((check, index) => {
    const made = refusals.filter((refusal) => refusal.check === check);
    if (made.length === 0) {
      failures.push(`ticket.refusedWith[${index}]: the board never refused a reply for ${check}`);
    } else if (!made.some((refusal) => read.some((text) => text.includes(refusal.told)))) {
      failures.push(
        `ticket.refusedWith[${index}]: the board refused ${check}, but the agent never read why`,
      );
    }
  });
  return failures;
}

/**
 * Checks what memory holds when the trial ended, and what the model was shown of it, against a
 * scenario's `memory.expect`. Returns one line per failed check. The red-team suite grades its
 * memory attacks with this too.
 */
export function gradeMemory(
  expected: MemoryExpectation | undefined,
  trace: Pick<Trace, "memory" | "prompts" | "received">,
): string[] {
  if (expected === undefined) return [];
  const { memory } = trace;
  if (memory === undefined) {
    return ["memory: the trace holds no memory, so the runner did not run the role with memory"];
  }
  const failures: string[] = [];
  const { records } = memory;
  if (expected.count !== undefined && records.length !== expected.count) {
    const listed = records
      .map((record) => `${record.id} (${record.status}, ${record.category}, ${record.about})`)
      .join(", ");
    failures.push(
      `memory.count: expected ${expected.count} stored record${expected.count === 1 ? "" : "s"}, ` +
        `found ${records.length}${listed === "" ? "" : `: ${listed}`}`,
    );
  }
  expected.records?.forEach((matcher, index) => {
    if (!records.some((record) => argsMatch(matcher, record)))
      failures.push(`memory.records[${index}]: no stored record matches ${show(matcher)}`);
  });
  expected.absent?.forEach((matcher, index) => {
    for (const record of records.filter((candidate) => argsMatch(matcher, candidate))) {
      failures.push(
        `memory.absent[${index}]: ${record.id} matches ${show(matcher)}: ${show(record.text)}`,
      );
    }
  });
  if (expected.reviews !== undefined) {
    const { reviews } = memory;
    if (reviews === undefined) {
      failures.push(
        "memory.reviews: this run keeps no review queue (a bare harness has none); run the scenario in office mode",
      );
    } else {
      expected.reviews.forEach((matcher, index) => {
        if (!reviews.some((item) => argsMatch(matcher, item)))
          failures.push(`memory.reviews[${index}]: no review item matches ${show(matcher)}`);
      });
    }
  }
  const prompts = trace.prompts ?? [];
  expected.prompted?.forEach((phrase, index) => {
    if (!prompts.some((prompt) => prompt.includes(phrase)))
      failures.push(
        `memory.prompted[${index}]: ${show(phrase)} was in no prompt the model was given`,
      );
  });
  const read = [...prompts, ...(trace.received ?? [])];
  expected.unread?.forEach((phrase, index) => {
    if (read.some((text) => text.includes(phrase)))
      failures.push(`memory.unread[${index}]: the model read ${show(phrase)}`);
  });
  return failures;
}

/**
 * The scenarios a run covers: every scenario of the suites, in suite order, narrowed by `tag` and by
 * the `scenarios` ids. A caller that must prepare per scenario before the run (a script file, say)
 * asks this rather than repeating the filter, so it prepares exactly what `runEvals` will run.
 *
 * Throws, naming every unknown id and the ids the suites do have, when `scenarios` names one no suite
 * contains: a typo must not shrink the run silently.
 */
export function selectScenarios(
  suites: readonly EvalSuite[],
  options: SelectOptions = {},
): Scenario[] {
  return narrowed(suites, options).flatMap(({ scenario, skip }) =>
    skip === undefined ? [scenario] : [],
  );
}

/**
 * The scenarios `selectScenarios` leaves out because their suite needs another harness or another
 * model (`mode`, `model`), each with why, so a run can say what it did not cover.
 */
export function skippedScenarios(
  suites: readonly EvalSuite[],
  options: SelectOptions = {},
): SkippedScenario[] {
  return narrowed(suites, options).flatMap(({ scenario, skip }) =>
    skip === undefined ? [] : [{ id: scenario.id, reason: skip }],
  );
}

type SelectOptions = Pick<RunEvalsOptions, "tag" | "scenarios" | "mode" | "model" | "packs">;

/** Why a run with these options cannot run a suite, or `undefined` when it can. */
function suiteSkip(suite: EvalSuite, options: SelectOptions): string | undefined {
  if (suite.mode === "office" && options.mode !== "office") return "runs only in office mode";
  if (suite.mode === "bare" && options.mode === "office") return "runs only in bare mode";
  if (suite.model === "scripted" && options.model !== "scripted") {
    return "runs only with a scripted model, which plays the misbehaviour it tests";
  }
  const missing = (suite.packs ?? []).filter((pack) => !(options.packs ?? []).includes(pack));
  if (missing.length > 0) {
    return `runs only with the ${missing.join(" and ")} pack${missing.length === 1 ? "" : "s"} given to the role`;
  }
  return undefined;
}

/** Every scenario the tag and ids select, with why its suite is skipped, if it is. */
function narrowed(
  suites: readonly EvalSuite[],
  options: SelectOptions,
): { readonly scenario: Scenario; readonly skip: string | undefined }[] {
  const all = suites.flatMap((suite) => {
    const skip = suiteSkip(suite, options);
    return suite.scenarios.map((scenario) => ({ scenario, skip }));
  });
  const wanted = options.scenarios === undefined ? undefined : new Set(options.scenarios);
  if (wanted !== undefined) {
    // Checked against every suite, skipped ones included: an id the run skips is not a typo.
    const known = new Set(all.map(({ scenario }) => scenario.id));
    const unknown = [...wanted].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown scenario id${unknown.length === 1 ? "" : "s"} ${unknown.map((id) => JSON.stringify(id)).join(", ")}. ` +
          `The suites' scenario ids are: ${[...known].join(", ")}.`,
      );
    }
  }
  return all.filter(
    ({ scenario }) =>
      (options.tag === undefined || (scenario.tags ?? []).includes(options.tag)) &&
      (wanted === undefined || wanted.has(scenario.id)),
  );
}

/**
 * Runs every scenario of the suites for its trials and grades them. `critical` scenarios must pass
 * every trial; `normal` scenarios count toward the pass rate.
 */
export async function runEvals(
  suites: readonly EvalSuite[],
  runner: AgentRunner,
  options: RunEvalsOptions = {},
): Promise<EvalReport> {
  const threshold = options.threshold ?? DEFAULT_PASS_THRESHOLD;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const scenarios = selectScenarios(suites, options);
  const skipped = skippedScenarios(suites, options);

  const reports: ScenarioReport[] = [];
  for (const scenario of scenarios) {
    const trials: TrialReport[] = [];
    for (let trial = 1; trial <= trialCount(scenario, options); trial++) {
      trials.push(await runTrial(scenario, trial, runner, retries));
    }
    const count = (outcome: TrialOutcome) =>
      trials.filter((trial) => trial.outcome === outcome).length;
    const failedTrials = count("failed");
    const erroredTrials = count("errored");
    const outcome: EvalOutcome =
      failedTrials > 0 ? "failed" : erroredTrials > 0 ? "incomplete" : "passed";
    const skippedAssertions = Math.max(
      0,
      ...trials.map(
        (trial) =>
          (trial.trace.judged ?? []).filter((record) => record.outcome === "skipped").length,
      ),
    );
    const usage = sumUsage(trials.map((trial) => trial.usage));
    reports.push({
      id: scenario.id,
      severity: scenario.severity ?? "normal",
      trials,
      outcome,
      passed: outcome === "passed",
      passedTrials: count("passed"),
      failedTrials,
      erroredTrials,
      retries: trials.reduce((sum, trial) => sum + retriesOf(trial), 0),
      ...(skippedAssertions === 0 ? {} : { skippedAssertions }),
      ...(usage === undefined ? {} : { usage }),
    });
  }

  const gradedNormal = reports
    .filter((report) => report.severity === "normal")
    .flatMap((report) => report.trials)
    .filter((trial) => trial.outcome !== "errored");
  const passRate =
    gradedNormal.length === 0
      ? 1
      : gradedNormal.filter((trial) => trial.passed).length / gradedNormal.length;
  const criticalFailed = reports.some(
    (report) => report.severity === "critical" && report.outcome === "failed",
  );
  const erroredTrials = reports.reduce((sum, report) => sum + report.erroredTrials, 0);
  const skippedAssertions = reports.reduce(
    (sum, report) => sum + (report.skippedAssertions ?? 0),
    0,
  );
  const outcome: EvalOutcome =
    criticalFailed || passRate < threshold ? "failed" : erroredTrials > 0 ? "incomplete" : "passed";
  const usage = sumUsage(reports.map((report) => report.usage));

  return {
    scenarios: reports,
    passRate,
    threshold,
    outcome,
    passed: outcome === "passed",
    erroredTrials,
    ...(options.scenarios === undefined ? {} : { selected: [...new Set(options.scenarios)] }),
    ...(skipped.length === 0 ? {} : { skipped }),
    ...(skippedAssertions === 0 ? {} : { skippedAssertions }),
    ...(usage === undefined ? {} : { usage }),
  };
}

/** How many trials a scenario runs: `normalTrials` for a normal one, else `trials`, else its own. */
function trialCount(scenario: Scenario, options: RunEvalsOptions): number {
  const normal = (scenario.severity ?? "normal") === "normal" ? options.normalTrials : undefined;
  return normal ?? options.trials ?? scenario.trials ?? DEFAULT_TRIALS;
}

/**
 * Runs one trial, running it again while the model provider fails it, up to `retries` more times,
 * and grades the attempt that finished. A trial whose every attempt the provider failed is `errored`
 * and ungraded: it says nothing about the agent, so it must neither pass nor fail.
 */
async function runTrial(
  scenario: Scenario,
  trial: number,
  runner: AgentRunner,
  retries: number,
): Promise<TrialReport> {
  const erroredAttempts: ErroredAttempt[] = [];
  // Every attempt's spend, the trial's model and its judge, errored attempts included: it was paid.
  const spent: (ModelUsage | undefined)[] = [];
  const withUsage = (report: TrialReport): TrialReport => {
    const usage = sumUsage(spent);
    return usage === undefined ? report : { ...report, usage };
  };
  for (let attempt = 1; ; attempt++) {
    const ran = await attemptTrial(scenario, trial, runner);
    spent.push(ran.usage);
    if (ran.errorSource !== undefined) {
      erroredAttempts.push({ attempt, error: ran.error ?? "the model provider failed" });
      if (attempt <= retries) continue;
      return withUsage({
        trial,
        outcome: "errored",
        passed: false,
        failures: [],
        trace: ran,
        erroredAttempts,
      });
    }
    const judged = await judgeTrace(scenario, ran, runner.judge);
    spent.push(...(judged ?? []).map((record) => record.usage));
    const trace: Trace = judged === undefined ? ran : { ...ran, judged };
    // A judge that failed or gave no verdict is a provider failure of the grading, not a grade: the
    // attempt is errored and retried like one the trial's own model failed.
    const unjudged = judged?.findIndex((record) => record.outcome === "errored") ?? -1;
    if (unjudged >= 0) {
      const reason = judged?.[unjudged]?.reason ?? "the judge gave no verdict";
      erroredAttempts.push({ attempt, error: `reply.judged[${unjudged}]: ${reason}` });
      if (attempt <= retries) continue;
      return withUsage({
        trial,
        outcome: "errored",
        passed: false,
        failures: [],
        trace,
        erroredAttempts,
      });
    }
    const failures = gradeTrace(scenario, trace);
    const passed = failures.length === 0;
    return withUsage({
      trial,
      outcome: passed ? "passed" : "failed",
      passed,
      failures,
      trace,
      ...(erroredAttempts.length === 0 ? {} : { erroredAttempts }),
    });
  }
}

/** One run of a trial. A runner that throws is the runner's failure, graded like any unfinished run. */
async function attemptTrial(scenario: Scenario, trial: number, runner: AgentRunner) {
  try {
    return await runner.run(scenario, trial);
  } catch (error) {
    return {
      calls: [],
      executedCalls: [],
      approvalsRequested: [],
      approvals: [],
      delegated: [],
      turns: 0,
      error: errorMessage(error),
    } satisfies Trace;
  }
}

/** Attempts a trial ran beyond its first: every errored attempt but the last, when it stayed errored. */
function retriesOf(trial: TrialReport): number {
  const errored = trial.erroredAttempts?.length ?? 0;
  return trial.outcome === "errored" ? errored - 1 : errored;
}

/** Renders a report as plain lines for a terminal or CI log. */
export function formatReport(report: EvalReport): string {
  const lines = report.scenarios.map((scenario) => {
    const mark = { passed: "pass", failed: "FAIL", incomplete: "INCOMPLETE" }[scenario.outcome];
    // The counts appear only once a provider failed something, so a clean run prints as it always has.
    const counts =
      scenario.erroredTrials === 0 && scenario.retries === 0
        ? ""
        : `; ${scenario.passedTrials} passed, ${scenario.failedTrials} failed, ` +
          `${scenario.erroredTrials} errored, ${scenario.retries} ${scenario.retries === 1 ? "retry" : "retries"}`;
    const head = `${mark}  ${scenario.id} (${scenario.severity}, ${scenario.passedTrials}/${scenario.trials.length} trials${counts})`;
    // Every provider failure is shown, retried or not: a retry must never hide one.
    const errored = scenario.trials.flatMap((trial) =>
      (trial.erroredAttempts ?? []).map(
        (attempt) => `trial ${trial.trial} attempt ${attempt.attempt} errored: ${attempt.error}`,
      ),
    );
    const firstFailure = scenario.trials.find((trial) => trial.outcome === "failed");
    return [head, ...errored, ...(firstFailure?.failures ?? [])].join("\n      ");
  });
  if (report.selected !== undefined) {
    lines.push(`Selected scenarios only, not the full suite: ${report.selected.join(", ")}`);
  }
  // One line per reason, so a bare or live run says which scenarios it did not cover.
  const reasons = new Map<string, string[]>();
  for (const { id, reason } of report.skipped ?? []) {
    reasons.set(reason, [...(reasons.get(reason) ?? []), id]);
  }
  for (const [reason, ids] of reasons) lines.push(`Skipped, ${reason}: ${ids.join(", ")}`);
  if (report.skippedAssertions !== undefined) {
    const ids = report.scenarios
      .filter((scenario) => scenario.skippedAssertions !== undefined)
      .map((scenario) => scenario.id);
    lines.push(
      `Judged assertions not graded: ${report.skippedAssertions} in ${ids.length} scenario${ids.length === 1 ? "" : "s"} (${ids.join(", ")}); this run has no judge`,
    );
  }
  const threshold = `(threshold ${Math.round(report.threshold * 100)}%)`;
  const percent = `${Math.round(report.passRate * 100)}%`;
  if (report.outcome === "incomplete") {
    const trials = `${report.erroredTrials} trial${report.erroredTrials === 1 ? "" : "s"}`;
    lines.push(
      `Evals incomplete: the model provider did not complete ${trials}, even after retries, so ${report.erroredTrials === 1 ? "it was" : "they were"} not graded. Repeat the run.`,
      `${percent} of graded normal trials passed ${threshold}`,
    );
  } else {
    const rate = `${percent} of ${report.erroredTrials === 0 ? "" : "graded "}normal trials passed ${threshold}`;
    lines.push(report.passed ? `Evals passed: ${rate}` : `Evals failed: ${rate}`);
  }
  return lines.join("\n");
}

/**
 * Lowercases reply text, maps typographic apostrophes and quotation marks to their ASCII forms, maps
 * Unicode hyphens and dashes (U+2010 to U+2015, and the minus sign U+2212) to an ASCII hyphen, and
 * drops a `:00` seconds suffix from clock readings, so `10:00` and `10:00:00` compare equal. A model
 * picks curly or straight marks, and a plain or a non-breaking hyphen ("Q‑3047"), at random, and a
 * `notContains` of "it's a no" must not miss "it’s a no". Nothing else is normalised: a different
 * time is still a different time, which is what keeps a time assertion able to fail.
 */
function normaliseReply(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/(\d{1,2}:\d{2}):00(?!\d)/g, "$1");
}

/**
 * `{ "some": { … } }`: matches an array argument when at least one element matches those fields, the
 * way `args` itself matches — only the fields listed, with matchers allowed inside. An array is
 * otherwise compared whole, which a line a model words freely (a quote's description) never matches.
 */
export function isSomeMatcher(value: unknown): value is { some: Record<string, unknown> } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const some = (value as { some?: unknown }).some;
  return (
    keys.length === 1 &&
    keys[0] === "some" &&
    some !== null &&
    typeof some === "object" &&
    !Array.isArray(some)
  );
}

/** `{ "includes": "…" }`: matches a string argument that contains the text. */
export function isIncludesMatcher(value: unknown): value is { includes: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === "includes" &&
    typeof (value as { includes: unknown }).includes === "string"
  );
}

/**
 * Partial match, shared by expected calls and per-argument stubs: every field `expected` names must
 * equal the actual value; nested objects match the same way. `{ "includes": "…" }` against a string
 * matches when the string contains that text. Against anything else it is an ordinary partial
 * object, so a suite that only used exact values matches exactly as it did.
 */
export function argsMatch(expected: unknown, actual: unknown): boolean {
  if (isIncludesMatcher(expected) && typeof actual === "string") {
    return actual.includes(expected.includes);
  }
  if (isSomeMatcher(expected)) {
    return Array.isArray(actual) && actual.some((element) => argsMatch(expected.some, element));
  }
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      argsMatch(value, (actual as Record<string, unknown>)[key]),
    );
  }
  return show(expected) === show(actual);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
