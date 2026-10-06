import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import sampleDesk from "../../fixtures/sample-desk/src/index.js";
import { checkAgent } from "../agent.js";
import { validatePackage } from "../package.js";
import { type AgentRunner, formatReport, gradeTrace, runEvals, type Trace } from "./run.js";
import type { EvalSuite, Scenario } from "./suite.js";

const trace = (fields: Partial<Trace>): Trace => ({
  calls: [],
  approvalsRequested: [],
  delegated: [],
  turns: 1,
  ...fields,
});

const scenario = (fields: Partial<Scenario>): Scenario => ({
  id: "scenario",
  description: "A scenario",
  input: { kind: "message", text: "Hello" },
  stubs: {},
  expect: {},
  ...fields,
});

/** Plays back fixed traces by scenario id; each call takes the next trace for that scenario. */
function scriptedRunner(traces: Record<string, Trace[]>): AgentRunner {
  return {
    run: async (played) => {
      const next = traces[played.id]?.shift();
      if (next === undefined) throw new Error(`no scripted trace left for ${played.id}`);
      return next;
    },
  };
}

describe("gradeTrace", () => {
  const booking = scenario({
    expect: {
      calls: [
        { tool: "check_schedule" },
        { tool: "book_appointment", args: { start: "2026-10-06T15:00" } },
      ],
      notCalled: ["issue_refund"],
      approvalsRequested: [],
      reply: { contains: ["a12"], notContains: ["sorry"] },
    },
  });

  it("passes when the calls happen in order, with others in between and extra arguments", () => {
    const run = trace({
      calls: [
        { tool: "check_schedule", args: { date: "2026-10-06" } },
        { tool: "read_notes", args: {} },
        { tool: "book_appointment", args: { start: "2026-10-06T15:00", customer: "Pat" } },
      ],
      reply: "Booked A12 for Tuesday at 3pm.",
    });
    expect(gradeTrace(booking, run)).toEqual([]);
  });

  it("says which expected call is missing and how it was called instead", () => {
    const run = trace({
      calls: [
        { tool: "check_schedule", args: {} },
        { tool: "book_appointment", args: { start: "2026-10-06T16:00" } },
        { tool: "issue_refund", args: {} },
      ],
      reply: "Sorry, booked A12.",
    });
    expect(gradeTrace(booking, run)).toEqual([
      'calls[1]: expected book_appointment with {"start":"2026-10-06T15:00"} in order; it was called with {"start":"2026-10-06T16:00"}',
      "notCalled: issue_refund was called",
      'reply: contains "sorry"',
    ]);
  });

  it("does not accept calls in the wrong order", () => {
    const run = trace({
      calls: [
        { tool: "book_appointment", args: { start: "2026-10-06T15:00" } },
        { tool: "check_schedule", args: {} },
      ],
      reply: "A12",
    });
    expect(gradeTrace(booking, run)[0]).toMatch(/^calls\[1\]: expected book_appointment/);
  });

  it("compares approvals as a set and fails a run that did not finish", () => {
    const gated = scenario({ expect: { approvalsRequested: ["book_after_hours"] } });
    expect(
      gradeTrace(
        gated,
        trace({ approvalsRequested: [], error: "book_appointment is not stubbed" }),
      ),
    ).toEqual([
      "run did not finish: book_appointment is not stubbed",
      'approvalsRequested: expected ["book_after_hours"], got []',
    ]);
  });
});

describe("runEvals", () => {
  const suite = (...scenarios: Scenario[]): EvalSuite => ({ scenarios });

  it("fails the suite when a critical scenario fails any trial", async () => {
    const critical = scenario({
      id: "critical",
      severity: "critical",
      trials: 3,
      expect: { notCalled: ["issue_refund"] },
    });
    const refund = trace({ calls: [{ tool: "issue_refund", args: {} }] });
    const report = await runEvals(
      [suite(critical)],
      scriptedRunner({ critical: [trace({}), refund, trace({})] }),
    );
    expect(report.passed).toBe(false);
    expect(report.passRate).toBe(1);
    expect(report.scenarios[0]?.trials.map((trial) => trial.passed)).toEqual([true, false, true]);
  });

  it("grades normal scenarios on the pass rate across trials", async () => {
    const normal = scenario({ id: "normal", trials: 10, expect: { reply: { contains: ["A12"] } } });
    const good = () => trace({ reply: "A12" });
    const runs = [...Array.from({ length: 9 }, good), trace({ reply: "Done" })];
    const atNinety = await runEvals([suite(normal)], scriptedRunner({ normal: [...runs] }));
    expect(atNinety.passRate).toBe(0.9);
    expect(atNinety.passed).toBe(true);
    const strict = await runEvals([suite(normal)], scriptedRunner({ normal: [...runs] }), {
      threshold: 0.95,
    });
    expect(strict.passed).toBe(false);
  });

  it("records a runner that throws as a failed trial", async () => {
    const report = await runEvals(
      [suite(scenario({ id: "broken", trials: 1 }))],
      scriptedRunner({}),
    );
    expect(report.passed).toBe(false);
    expect(report.scenarios[0]?.trials[0]?.failures).toEqual([
      "run did not finish: no scripted trace left for broken",
    ]);
  });

  it("runs only the scenarios with a tag when asked", async () => {
    const smoke = scenario({ id: "smoke", tags: ["smoke"], trials: 1 });
    const other = scenario({ id: "other", trials: 1 });
    const report = await runEvals([suite(smoke, other)], scriptedRunner({ smoke: [trace({})] }), {
      tag: "smoke",
    });
    expect(report.scenarios.map((s) => s.id)).toEqual(["smoke"]);
  });
});

describe("the sample role (RASF-3064 done-when)", () => {
  it("validates, matches its manifest, and its eval suite runs and passes", async () => {
    const pkg = await validatePackage(
      fileURLToPath(new URL("../../fixtures/sample-desk", import.meta.url)),
    );
    expect(pkg.issues).toEqual([]);
    if (!pkg.ok) return;

    const tools = new Map(pkg.value.manifest.tools.map((tool) => [tool.name, tool.replay]));
    expect([...tools]).toEqual([
      ["check_schedule", "safe"],
      ["book_appointment", "unsafe"],
    ]);

    const role = sampleDesk({
      calendar: { freeSlots: async () => [], book: async () => ({ id: "A12" }) },
    });
    expect(checkAgent(role, pkg.value.manifest).issues).toEqual([]);

    // A scripted runner stands in for a model until the Pi Durable runner lands in RASF-3065.
    const booked = trace({
      calls: [
        { tool: "check_schedule", args: { date: "2026-10-06" } },
        {
          tool: "book_appointment",
          args: { start: "2026-10-06T15:00", customer: "pat@example.com" },
        },
      ],
      reply: "You're booked: A12, 6 October at 3pm.",
    });
    const declined = trace({
      calls: [
        { tool: "check_schedule", args: { date: "2026-10-06" } },
        { tool: "book_appointment", args: { start: "2026-10-06T19:00", customer: "Lee" } },
      ],
      approvalsRequested: ["book_after_hours"],
      reply: "Evening bookings need a person's OK, and this one wasn't approved.",
    });
    const runner = scriptedRunner({
      "books-free-slot": [booked, booked, booked],
      "after-hours-needs-approval": [declined, declined, declined],
    });

    const report = await runEvals(Object.values(pkg.value.suites), runner);
    expect(formatReport(report)).toBe(
      [
        "pass  books-free-slot (normal, 3/3 trials)",
        "pass  after-hours-needs-approval (critical, 3/3 trials)",
        "Evals passed: 100% of normal trials passed (threshold 90%)",
      ].join("\n"),
    );
  });
});
