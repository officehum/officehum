/**
 * Grading and running evals. Grading is pure: a scenario's expectations checked against the trace of
 * one run. Running a scenario needs a Pi Durable harness, so it goes through an `AgentRunner`; the
 * Pi Durable runner lives with the adapter in @officehum/office (RASF-3065).
 */

import { show } from "../issues.js";
import { DEFAULT_PASS_THRESHOLD, DEFAULT_TRIALS, type EvalSuite, type Scenario } from "./suite.js";

/** What happened in one run of a scenario. */
export interface Trace {
  /** Every tool call the agent made, in order, including calls an approval gate blocked. */
  readonly calls: readonly {
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
  }[];
  /** Approval ids the agent's gated calls asked for. */
  readonly approvalsRequested: readonly string[];
  /** Ticket types delegated through the office extension; always empty on a bare harness. */
  readonly delegated: readonly string[];
  /** The agent's final answer, if it gave one. */
  readonly reply?: string;
  readonly turns: number;
  /** Set when the run could not finish, e.g. an unstubbed tool call or a limit was hit. */
  readonly error?: string;
}

/** Runs one trial of a scenario: a fresh harness, stubbed tools, scripted approvals. */
export interface AgentRunner {
  run(scenario: Scenario, trial: number): Promise<Trace>;
}

export interface TrialReport {
  readonly trial: number;
  readonly passed: boolean;
  /** Why the trial failed, one line per failed check. */
  readonly failures: readonly string[];
  readonly trace: Trace;
}

export interface ScenarioReport {
  readonly id: string;
  readonly severity: "critical" | "normal";
  readonly trials: readonly TrialReport[];
  /** Every trial passed. */
  readonly passed: boolean;
}

export interface EvalReport {
  readonly scenarios: readonly ScenarioReport[];
  /** Passed trials of `normal` scenarios over all their trials; 1 when there are none. */
  readonly passRate: number;
  readonly threshold: number;
  /** Every critical scenario passed every trial, and the pass rate reached the threshold. */
  readonly passed: boolean;
}

export interface RunEvalsOptions {
  /** Pass rate the normal scenarios must reach. Default 0.9. */
  readonly threshold?: number;
  /** Run only scenarios with this tag, e.g. `smoke`. */
  readonly tag?: string;
}

/** Checks a scenario's expectations against one trace. Returns one line per failed check. */
export function gradeTrace(scenario: Scenario, trace: Trace): string[] {
  const failures: string[] = [];
  const { expect } = scenario;

  if (trace.error !== undefined) failures.push(`run did not finish: ${trace.error}`);

  if (expect.calls !== undefined) {
    // In order, with other calls allowed in between.
    let next = 0;
    for (const call of trace.calls) {
      const wanted = expect.calls[next];
      if (
        wanted !== undefined &&
        call.tool === wanted.tool &&
        matches(wanted.args ?? {}, call.args)
      )
        next++;
    }
    const missing = expect.calls[next];
    if (missing !== undefined) {
      const made = trace.calls.filter((call) => call.tool === missing.tool);
      const detail =
        made.length === 0
          ? "it was never called"
          : `it was called with ${made.map((call) => show(call.args)).join(", ")}`;
      failures.push(
        `calls[${next}]: expected ${missing.tool}${missing.args ? ` with ${show(missing.args)}` : ""} in order; ${detail}`,
      );
    }
  }

  for (const tool of expect.notCalled ?? []) {
    if (trace.calls.some((call) => call.tool === tool))
      failures.push(`notCalled: ${tool} was called`);
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

  if (expect.reply !== undefined) {
    // Case-insensitive: the model may phrase a fact many ways, but the fact itself must be there.
    const reply = (trace.reply ?? "").toLowerCase();
    for (const words of expect.reply.contains ?? []) {
      if (!reply.includes(words.toLowerCase()))
        failures.push(`reply: does not contain ${show(words)}`);
    }
    for (const words of expect.reply.notContains ?? []) {
      if (reply.includes(words.toLowerCase())) failures.push(`reply: contains ${show(words)}`);
    }
  }

  return failures;
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
  const scenarios = suites
    .flatMap((suite) => suite.scenarios)
    .filter((scenario) => options.tag === undefined || (scenario.tags ?? []).includes(options.tag));

  const reports: ScenarioReport[] = [];
  for (const scenario of scenarios) {
    const trials: TrialReport[] = [];
    for (let trial = 1; trial <= (scenario.trials ?? DEFAULT_TRIALS); trial++) {
      let trace: Trace;
      try {
        trace = await runner.run(scenario, trial);
      } catch (error) {
        trace = {
          calls: [],
          approvalsRequested: [],
          delegated: [],
          turns: 0,
          error: errorMessage(error),
        };
      }
      const failures = gradeTrace(scenario, trace);
      trials.push({ trial, passed: failures.length === 0, failures, trace });
    }
    reports.push({
      id: scenario.id,
      severity: scenario.severity ?? "normal",
      trials,
      passed: trials.every((trial) => trial.passed),
    });
  }

  const normalTrials = reports
    .filter((report) => report.severity === "normal")
    .flatMap((report) => report.trials);
  const passRate =
    normalTrials.length === 0
      ? 1
      : normalTrials.filter((trial) => trial.passed).length / normalTrials.length;
  const criticalPassed = reports.every((report) => report.severity !== "critical" || report.passed);

  return {
    scenarios: reports,
    passRate,
    threshold,
    passed: criticalPassed && passRate >= threshold,
  };
}

/** Renders a report as plain lines for a terminal or CI log. */
export function formatReport(report: EvalReport): string {
  const lines = report.scenarios.map((scenario) => {
    const passes = scenario.trials.filter((trial) => trial.passed).length;
    const mark = scenario.passed ? "pass" : "FAIL";
    const head = `${mark}  ${scenario.id} (${scenario.severity}, ${passes}/${scenario.trials.length} trials)`;
    const firstFailure = scenario.trials.find((trial) => !trial.passed);
    return firstFailure === undefined
      ? head
      : `${head}\n      ${firstFailure.failures.join("\n      ")}`;
  });
  const rate = `${Math.round(report.passRate * 100)}% of normal trials passed (threshold ${Math.round(report.threshold * 100)}%)`;
  lines.push(report.passed ? `Evals passed: ${rate}` : `Evals failed: ${rate}`);
  return lines.join("\n");
}

/** Partial match: every field `expected` names must equal the actual value; nested objects match the same way. */
function matches(expected: unknown, actual: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      matches(value, (actual as Record<string, unknown>)[key]),
    );
  }
  return show(expected) === show(actual);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
