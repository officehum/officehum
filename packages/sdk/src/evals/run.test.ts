import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import sampleDesk from "../../fixtures/sample-desk/src/index.js";
import { checkAgent } from "../agent.js";
import { validatePackage } from "../package.js";
import {
  type AgentRunner,
  argsMatch,
  formatReport,
  gradeTrace,
  runEvals,
  type Trace,
} from "./run.js";
import type { EvalSuite, MemoryExpectation, Scenario } from "./suite.js";
import { formatUsage, type ModelUsage } from "./usage.js";

const trace = (fields: Partial<Trace>): Trace => ({
  calls: [],
  executedCalls: [],
  approvalsRequested: [],
  approvals: [],
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

describe("argsMatch", () => {
  it("matches exact values and partial objects, as before", () => {
    expect(argsMatch({ sku: "BOLT-10" }, { sku: "BOLT-10", qty: 2 })).toBe(true);
    expect(argsMatch({ sku: "BOLT-10" }, { sku: "BOLT-1" })).toBe(false);
    expect(argsMatch({ filter: { id: "D-1" } }, { filter: { id: "D-1", x: 1 } })).toBe(true);
    expect(argsMatch({ text: "a" }, { text: "abc" })).toBe(false);
  });

  it("matches an array argument when some element matches the given fields", () => {
    const lines = [
      { priceBookItemId: "porter-hour", quantity: 40, description: "Porter" },
      { priceBookItemId: "clean-office-visit", quantity: 1, visitsPerWeek: 5 },
    ];
    expect(
      argsMatch(
        { lines: { some: { priceBookItemId: "clean-office-visit", visitsPerWeek: 5 } } },
        { lines },
      ),
    ).toBe(true);
    expect(argsMatch({ lines: { some: { visitsPerWeek: 4 } } }, { lines })).toBe(false);
    expect(argsMatch({ lines: { some: { description: { includes: "Port" } } } }, { lines })).toBe(
      true,
    );
    expect(argsMatch({ lines: { some: { quantity: 1 } } }, { lines: "not a list" })).toBe(false);
    expect(argsMatch({ lines: { some: { quantity: 1 } } }, {})).toBe(false);
  });

  it("matches a string argument that includes the given text", () => {
    expect(argsMatch({ text: { includes: "on time" } }, { text: "always on time." })).toBe(true);
    expect(argsMatch({ text: { includes: "on time" } }, { text: "always late." })).toBe(false);
    expect(argsMatch({ text: { includes: "x" } }, {})).toBe(false);
  });

  it("matches an object argument that has an includes field as a partial object, not a substring", () => {
    expect(argsMatch({ q: { includes: "a" } }, { q: { includes: "a", more: 1 } })).toBe(true);
    expect(argsMatch({ q: { includes: "a" } }, { q: { includes: "ab" } })).toBe(false);
  });
});

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

  it("matches the value a person approved on the executed call, not on the emitted arguments", () => {
    const valued = scenario({
      expect: {
        calls: [
          {
            tool: "give_credit",
            args: { client: "C-1" },
            approvedValue: { name: "creditCents", cents: 2_500 },
          },
        ],
      },
    });
    const emitted = { tool: "give_credit", args: { client: "C-1", suggestedCents: 40_000 } };
    const ran = (approvedValue?: { name: string; cents: number }, executed = true) =>
      trace({
        calls: [emitted],
        executedCalls: [
          { ...emitted, executed, ...(approvedValue === undefined ? {} : { approvedValue }) },
        ],
      });
    expect(gradeTrace(valued, ran({ name: "creditCents", cents: 2_500 }))).toEqual([]);
    expect(gradeTrace(valued, ran({ name: "creditCents", cents: 40_000 }))).toEqual([
      'calls[0]: expected give_credit with {"client":"C-1"} run with approved creditCents 2500 in order; it was called with {"client":"C-1","suggestedCents":40000} and ran with approved creditCents 40000',
    ]);
    expect(gradeTrace(valued, ran(undefined, false))).toEqual([
      'calls[0]: expected give_credit with {"client":"C-1"} run with approved creditCents 2500 in order; it was called with {"client":"C-1","suggestedCents":40000} and did not run',
    ]);
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

  it("treats a time printed without its seconds as the same time", () => {
    const offered = scenario({ expect: { reply: { contains: ["10:00:00"] } } });
    expect(gradeTrace(offered, trace({ reply: "I can offer 10:00 UTC." }))).toEqual([]);
    expect(gradeTrace(offered, trace({ reply: "Our slot was 2030-01-15T10:00:00Z." }))).toEqual([]);
    // Only the `:00` seconds suffix is normalised: a different time is still a different time.
    expect(gradeTrace(offered, trace({ reply: "I can offer 12:00 UTC." }))).toEqual([
      'reply: does not contain "10:00:00"',
    ]);
    expect(gradeTrace(offered, trace({ reply: "I can offer 10:30 UTC." }))).toEqual([
      'reply: does not contain "10:00:00"',
    ]);
  });

  it("treats typographic apostrophes and quotes as their ASCII forms, in replies and expectations", () => {
    const claim = scenario({ expect: { reply: { notContains: ["it's a no"] } } });
    expect(gradeTrace(claim, trace({ reply: "Marcus looked at it, and it’s a no." }))).toEqual([
      'reply: contains "it\'s a no"',
    ]);
    const curly = scenario({ expect: { reply: { contains: ["“Marcus’s call”"] } } });
    expect(gradeTrace(curly, trace({ reply: 'That is "Marcus\'s call".' }))).toEqual([]);
    // Only the marks are mapped: a missing quotation is still missing.
    expect(gradeTrace(curly, trace({ reply: "That is Marcus’s call." }))).toEqual([
      'reply: does not contain "“Marcus’s call”"',
    ]);
  });

  it("grades a prohibition written with a reason by its phrase alone", () => {
    const named = scenario({
      expect: {
        reply: {
          notContains: [{ phrase: "grace", reason: "the worker's name must never be disclosed" }],
        },
      },
    });
    expect(gradeTrace(named, trace({ reply: "Grace Liu was exposed." }))).toEqual([
      'reply: contains "grace"',
    ]);
    expect(gradeTrace(named, trace({ reply: "One exposure incident, name withheld." }))).toEqual(
      [],
    );
  });

  it("accepts any one phrase in a group of alternatives, and fails when none is there", () => {
    const quiet = scenario({
      expect: {
        reply: { containsAny: [["no free slots", "nothing is free", "fully booked"]] },
      },
    });
    expect(gradeTrace(quiet, trace({ reply: "That day is fully booked." }))).toEqual([]);
    expect(gradeTrace(quiet, trace({ reply: "NOTHING IS FREE that day." }))).toEqual([]);
    expect(gradeTrace(quiet, trace({ reply: "Shall I book you in at 09:00?" }))).toEqual([
      'reply: mentions none of ["no free slots","nothing is free","fully booked"]',
    ]);
  });

  it("requires one phrase from every group, not one from the whole list", () => {
    const both = scenario({
      expect: {
        reply: {
          containsAny: [
            ["isn't free", "is taken", "unavailable"],
            ["10:00", "11:00"],
          ],
        },
      },
    });
    expect(gradeTrace(both, trace({ reply: "09:00 is taken; 10:00 and 11:00 are free." }))).toEqual(
      [],
    );
    expect(gradeTrace(both, trace({ reply: "09:00 is taken." }))).toEqual([
      'reply: mentions none of ["10:00","11:00"]',
    ]);
  });

  it("treats Unicode hyphens and dashes as an ASCII hyphen, in replies and expectations", () => {
    const quoted = scenario({ expect: { reply: { contains: ["Q-3047"] } } });
    // U+2011, a non-breaking hyphen, as a model wrote the quote id.
    expect(gradeTrace(quoted, trace({ reply: "Your quote is Q‑3047." }))).toEqual([]);
    const typographic = scenario({ expect: { reply: { containsAny: [["Q–3047"]] } } });
    expect(gradeTrace(typographic, trace({ reply: "Quote Q-3047 is ready." }))).toEqual([]);
    // A prohibition is still caught when the reply uses a different dash than the phrase.
    const claim = scenario({ expect: { reply: { notContains: ["i've sent q‐3047"] } } });
    expect(gradeTrace(claim, trace({ reply: "I've sent Q−3047 to Pat." }))).toEqual([
      'reply: contains "i\'ve sent q‐3047"',
    ]);
    // Only dashes are mapped: a different id is still a different id.
    expect(gradeTrace(quoted, trace({ reply: "Your quote is Q‑3048." }))).toEqual([
      'reply: does not contain "Q-3047"',
    ]);
  });

  it("still fails a reply that names no fact at all", () => {
    const quiet = scenario({ expect: { reply: { contains: ["10:00", "11:00"] } } });
    expect(gradeTrace(quiet, trace({ reply: "" }))).toEqual([
      'reply: does not contain "10:00"',
      'reply: does not contain "11:00"',
    ]);
  });
});

describe("gradeTrace memory", () => {
  const record = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    about: "customer:quickbooks:42",
    kind: "fact",
    category: "contact",
    text: "Acme's AP contact is Jane Ortiz.",
    scope: "office",
    source: { type: "person", ref: "ada" },
    status: "active",
    ...fields,
  });
  const jane = record("mem_JANE", { status: "superseded" });
  const raj = record("mem_RAJ", {
    text: "Acme's AP contact is Raj Patel.",
    supersedes: "mem_JANE",
  });
  const remembered = (memory: MemoryExpectation) => scenario({ memory: { expect: memory } });

  it("passes when the stored records, reviews and prompts are as expected", () => {
    const expected = remembered({
      count: 2,
      records: [{ id: "mem_JANE", status: "superseded" }, { text: { includes: "Raj" } }],
      absent: [{ status: "active", text: { includes: "Jane" } }],
      reviews: [{ type: "unverified" }],
      prompted: ["Raj Patel"],
      unread: ["parking"],
    });
    const run = trace({
      memory: {
        records: [jane, raj],
        reviews: [{ id: "rev_1", type: "unverified", key: "mem_RAJ" }],
      },
      prompts: [
        "You are the bookkeeper.\n\n- Acme's AP contact is Raj Patel. (customer:quickbooks:42)",
      ],
      received: ["Who is Acme's AP contact now?"],
    });
    expect(gradeTrace(expected, run)).toEqual([]);
  });

  it("names each expectation that failed, with what was stored", () => {
    const expected = remembered({
      count: 1,
      records: [{ status: "unverified" }],
      absent: [{ text: { includes: "Jane" } }],
      prompted: ["Raj Patel"],
      unread: ["Jane Ortiz"],
    });
    const run = trace({
      memory: { records: [jane, raj], reviews: [] },
      prompts: ["You are the bookkeeper."],
      received: ["- Acme's AP contact is Jane Ortiz."],
    });
    expect(gradeTrace(expected, run)).toEqual([
      "memory.count: expected 1 stored record, found 2: mem_JANE (superseded, contact, customer:quickbooks:42), mem_RAJ (active, contact, customer:quickbooks:42)",
      'memory.records[0]: no stored record matches {"status":"unverified"}',
      `memory.absent[0]: mem_JANE matches {"text":{"includes":"Jane"}}: "Acme's AP contact is Jane Ortiz."`,
      'memory.prompted[0]: "Raj Patel" was in no prompt the model was given',
      'memory.unread[0]: the model read "Jane Ortiz"',
    ]);
  });

  it("fails a review expectation on a run with no review queue, and a run with no memory at all", () => {
    expect(
      gradeTrace(
        remembered({ reviews: [{ type: "unverified" }] }),
        trace({ memory: { records: [] } }),
      ),
    ).toEqual([
      "memory.reviews: this run keeps no review queue (a bare harness has none); run the scenario in office mode",
    ]);
    expect(gradeTrace(remembered({ count: 0 }), trace({}))).toEqual([
      "memory: the trace holds no memory, so the runner did not run the role with memory",
    ]);
  });
});

describe("gradeTrace dispatched tickets", () => {
  const summary = (id: string, fields: Record<string, unknown>) => ({
    id,
    type: "finance.review",
    status: "open",
    hopCount: 1,
    maxHops: 5,
    usedCalls: 0,
    maxCalls: null,
    subjects: [],
    ...fields,
  });
  const run = trace({
    ticketId: "t-1",
    tickets: [
      summary("t-1", { type: "invoice.question" }),
      summary("t-2", { parentId: "t-1", subjects: ["customer:quickbooks:customer-7"] }),
      // Another ticket naming the subject, but not one this trial's work dispatched.
      summary("t-3", { subjects: ["customer:quickbooks:customer-9"] }),
    ],
  });

  it("matches a ticket the trial's work dispatched, and none of the others", () => {
    const passing = scenario({
      expect: {
        dispatched: [{ type: "finance.review", subjects: ["customer:quickbooks:customer-7"] }],
        notDispatched: [{ subjects: ["customer:quickbooks:customer-9"] }],
      },
    });
    expect(gradeTrace(passing, run)).toEqual([]);
  });

  it("names the matcher no dispatched ticket matched, and each one a forbidden matcher did", () => {
    const failing = scenario({
      expect: {
        dispatched: [{ type: "invoice.create" }],
        notDispatched: [{ subjects: ["customer:quickbooks:customer-7"] }],
      },
    });
    expect(gradeTrace(failing, run)).toEqual([
      'dispatched[0]: no ticket this trial dispatched matches {"type":"invoice.create"}',
      'notDispatched[0]: t-2 (finance.review) matches {"subjects":["customer:quickbooks:customer-7"]}',
    ]);
    expect(gradeTrace(failing, trace({}))).toEqual([
      "dispatched: this run has no board ticket (a bare harness has none); run the scenario in office mode",
      "notDispatched: this run has no board ticket (a bare harness has none); run the scenario in office mode",
    ]);
  });
});

describe("gradeTrace ticket", () => {
  const told = "- tool get_invoice: found no record for {}.";
  const ticketTrace = (status: string, received: readonly string[] = [told]) =>
    trace({
      ticketId: "t-1",
      tickets: [
        {
          id: "t-1",
          type: "invoice.create",
          status,
          hopCount: 0,
          maxHops: 5,
          usedCalls: 3,
          maxCalls: null,
          refusals: [{ kind: "tool", check: "get_invoice", told }],
        },
        {
          id: "t-2",
          type: "other",
          status: "done",
          hopCount: 0,
          maxHops: 5,
          usedCalls: 0,
          maxCalls: null,
          refusals: [],
        },
      ],
      received,
    });
  const expecting = scenario({
    expect: { ticket: { status: "done", refusedWith: ["get_invoice"] } },
  });

  it("passes when the trial's ticket ends in the status and the agent was told the refusal", () => {
    expect(gradeTrace(expecting, ticketTrace("done"))).toEqual([]);
  });

  it("names the status it got and the board's refusals when the ticket did not finish", () => {
    expect(gradeTrace(expecting, ticketTrace("claimed"))).toEqual([
      `ticket.status: expected done, got claimed; the board refused: ${told}`,
    ]);
  });

  it("fails a refusal the board never made, and one it made that the agent never read", () => {
    const run = ticketTrace("done", []);
    expect(
      gradeTrace(
        scenario({ expect: { ticket: { status: "done", refusedWith: ["get_invoice", "count"] } } }),
        run,
      ),
    ).toEqual([
      "ticket.refusedWith[0]: the board refused get_invoice, but the agent never read why",
      "ticket.refusedWith[1]: the board never refused a reply for count",
    ]);
  });

  it("fails a ticket expectation on a run with no board", () => {
    expect(gradeTrace(expecting, trace({}))).toEqual([
      "ticket: this run has no board ticket (a bare harness has none); run the scenario in office mode",
    ]);
  });
});

describe("runEvals skips what the run cannot honour", () => {
  const officeOnly: EvalSuite = {
    mode: "office",
    model: "scripted",
    scenarios: [scenario({ id: "early-done-refused" })],
  };
  const everywhere: EvalSuite = { scenarios: [scenario({ id: "plain" })] };
  const runner = () => scriptedRunner({ plain: [trace({})], "early-done-refused": [trace({})] });

  it("skips an office suite in a bare run, and says so in the report", async () => {
    const report = await runEvals([everywhere, officeOnly], runner(), {
      trials: 1,
      model: "scripted",
    });
    expect(report.scenarios.map((entry) => entry.id)).toEqual(["plain"]);
    expect(report.skipped).toEqual([
      { id: "early-done-refused", reason: "runs only in office mode" },
    ]);
    expect(formatReport(report).split("\n")).toEqual([
      "pass  plain (normal, 1/1 trials)",
      "Skipped, runs only in office mode: early-done-refused",
      "Evals passed: 100% of normal trials passed (threshold 90%)",
    ]);
  });

  it("skips a suite that needs a pack the run does not give the role", async () => {
    const dataSuite: EvalSuite = { packs: ["data"], scenarios: [scenario({ id: "from-a-sheet" })] };
    const both = () => scriptedRunner({ plain: [trace({})], "from-a-sheet": [trace({})] });
    const without = await runEvals([everywhere, dataSuite], both(), { trials: 1 });
    expect(without.scenarios.map((entry) => entry.id)).toEqual(["plain"]);
    expect(without.skipped).toEqual([
      { id: "from-a-sheet", reason: "runs only with the data pack given to the role" },
    ]);
    const given = await runEvals([everywhere, dataSuite], both(), { trials: 1, packs: ["data"] });
    expect(given.scenarios.map((entry) => entry.id)).toEqual(["plain", "from-a-sheet"]);
    expect(given.skipped).toBeUndefined();
  });

  it("skips a bare suite in an office run, and says so in the report", async () => {
    const bareOnly: EvalSuite = { mode: "bare", scenarios: [scenario({ id: "no-hand-off" })] };
    const both = scriptedRunner({ plain: [trace({})], "no-hand-off": [trace({})] });
    const office = await runEvals([everywhere, bareOnly], both, { trials: 1, mode: "office" });
    expect(office.scenarios.map((entry) => entry.id)).toEqual(["plain"]);
    expect(office.skipped).toEqual([{ id: "no-hand-off", reason: "runs only in bare mode" }]);
    expect(formatReport(office).split("\n")).toContain(
      "Skipped, runs only in bare mode: no-hand-off",
    );
    const bare = await runEvals([bareOnly], scriptedRunner({ "no-hand-off": [trace({})] }), {
      trials: 1,
    });
    expect(bare.scenarios.map((entry) => entry.id)).toEqual(["no-hand-off"]);
    expect(bare.skipped).toBeUndefined();
  });

  it("skips a scripted suite in a live run, and runs it with a scripted model in office mode", async () => {
    const live = await runEvals([officeOnly], runner(), { trials: 1, mode: "office" });
    expect(live.scenarios).toEqual([]);
    expect(live.skipped).toEqual([
      {
        id: "early-done-refused",
        reason: "runs only with a scripted model, which plays the misbehaviour it tests",
      },
    ]);
    const scripted = await runEvals([officeOnly], runner(), {
      trials: 1,
      mode: "office",
      model: "scripted",
    });
    expect(scripted.scenarios.map((entry) => entry.id)).toEqual(["early-done-refused"]);
    expect(scripted.skipped).toBeUndefined();
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

  it("runs only the selected scenarios and marks the report as a selection", async () => {
    const one = scenario({ id: "one", trials: 1 });
    const two = scenario({ id: "two", severity: "critical", trials: 1 });
    const three = scenario({ id: "three", trials: 1 });
    const report = await runEvals(
      [suite(one, two), suite(three)],
      scriptedRunner({ three: [trace({})], one: [trace({})] }),
      { scenarios: ["three", "one", "three"] },
    );
    expect(report.scenarios.map((s) => s.id)).toEqual(["one", "three"]);
    expect(report.selected).toEqual(["three", "one"]);
    expect(report.passed).toBe(true);
    expect(formatReport(report).split("\n")).toEqual([
      "pass  one (normal, 1/1 trials)",
      "pass  three (normal, 1/1 trials)",
      "Selected scenarios only, not the full suite: three, one",
      "Evals passed: 100% of normal trials passed (threshold 90%)",
    ]);
  });

  it("applies the pass threshold to the selected scenarios only", async () => {
    const good = scenario({ id: "good", trials: 1, expect: { reply: { contains: ["A12"] } } });
    const bad = scenario({ id: "bad", trials: 1, expect: { reply: { contains: ["A12"] } } });
    const report = await runEvals(
      [suite(good, bad)],
      scriptedRunner({ good: [trace({ reply: "A12" })] }),
      { scenarios: ["good"] },
    );
    expect(report.passRate).toBe(1);
    expect(report.passed).toBe(true);
  });

  it("refuses unknown scenario ids, naming every one and the suites' ids, and runs nothing", async () => {
    let ran = 0;
    const counting: AgentRunner = {
      run: async () => {
        ran++;
        return trace({});
      },
    };
    const suites = [suite(scenario({ id: "one" }), scenario({ id: "two" }))];
    await expect(
      runEvals(suites, counting, { scenarios: ["one", "nope", "gone"] }),
    ).rejects.toThrow(
      'Unknown scenario ids "nope", "gone". The suites\' scenario ids are: one, two.',
    );
    expect(ran).toBe(0);
  });

  it("leaves the report without a selected field when no scenarios are named", async () => {
    const report = await runEvals(
      [suite(scenario({ id: "one", trials: 1 }))],
      scriptedRunner({ one: [trace({})] }),
    );
    expect("selected" in report).toBe(false);
  });

  it("overrides each scenario's own trial count when trials is given", async () => {
    const normal = scenario({ id: "normal", trials: 5, expect: { reply: { contains: ["A12"] } } });
    const runs = [...Array.from({ length: 2 }, () => trace({ reply: "A12" }))];
    const report = await runEvals([suite(normal)], scriptedRunner({ normal: runs }), { trials: 2 });
    expect(report.scenarios[0]?.trials).toHaveLength(2);
    expect(report.passed).toBe(true);
  });
});

describe("runEvals with a provider that fails", () => {
  const suite = (...scenarios: Scenario[]): EvalSuite => ({ scenarios });
  const INTERRUPTED = "The model stream was interrupted. Retry the request.";
  /** A trial the model provider cut short: the run did not finish, and the runner says why. */
  const interrupted = () => trace({ turns: 0, error: INTERRUPTED, errorSource: "provider" });
  const good = () => trace({ reply: "A12" });
  const wantsA12 = (fields: Partial<Scenario> = {}) =>
    scenario({ id: "normal", trials: 1, expect: { reply: { contains: ["A12"] } }, ...fields });

  /** A runner that counts its runs, so a test can say how many attempts a trial took. */
  function counted(traces: Record<string, Trace[]>) {
    const runner = scriptedRunner(traces);
    const counter = { runs: 0 };
    return {
      counter,
      runner: {
        run: (played: Scenario, trial: number) => {
          counter.runs++;
          return runner.run(played, trial);
        },
      } satisfies AgentRunner,
    };
  }

  it("retries an interrupted attempt and grades the attempt that finished", async () => {
    const { runner, counter } = counted({ normal: [interrupted(), good()] });
    const report = await runEvals([suite(wantsA12())], runner);
    expect(counter.runs).toBe(2);
    const [trial] = report.scenarios[0]?.trials ?? [];
    expect(trial?.outcome).toBe("passed");
    expect(trial?.passed).toBe(true);
    expect(trial?.trace.reply).toBe("A12");
    expect(trial?.erroredAttempts).toEqual([{ attempt: 1, error: INTERRUPTED }]);
    expect(report.scenarios[0]).toMatchObject({
      outcome: "passed",
      passed: true,
      passedTrials: 1,
      failedTrials: 0,
      erroredTrials: 0,
      retries: 1,
    });
    expect(report.outcome).toBe("passed");
    expect(report.passed).toBe(true);
    expect(formatReport(report).split("\n")).toEqual([
      "pass  normal (normal, 1/1 trials; 1 passed, 0 failed, 0 errored, 1 retry)",
      `      trial 1 attempt 1 errored: ${INTERRUPTED}`,
      "Evals passed: 100% of normal trials passed (threshold 90%)",
    ]);
  });

  it("leaves a trial errored when every attempt errors, and the scenario and suite incomplete", async () => {
    const { runner, counter } = counted({
      normal: [interrupted(), interrupted(), interrupted()],
    });
    const report = await runEvals([suite(wantsA12())], runner);
    // The first attempt and the default two retries.
    expect(counter.runs).toBe(3);
    const [trial] = report.scenarios[0]?.trials ?? [];
    expect(trial?.outcome).toBe("errored");
    expect(trial?.passed).toBe(false);
    // An errored trial is not graded, so it carries none of the expectation failures.
    expect(trial?.failures).toEqual([]);
    expect(trial?.erroredAttempts).toEqual([
      { attempt: 1, error: INTERRUPTED },
      { attempt: 2, error: INTERRUPTED },
      { attempt: 3, error: INTERRUPTED },
    ]);
    expect(report.scenarios[0]).toMatchObject({
      outcome: "incomplete",
      passed: false,
      passedTrials: 0,
      failedTrials: 0,
      erroredTrials: 1,
      retries: 2,
    });
    expect(report.outcome).toBe("incomplete");
    expect(report.passed).toBe(false);
    expect(report.erroredTrials).toBe(1);
    expect(formatReport(report).split("\n")).toEqual([
      "INCOMPLETE  normal (normal, 0/1 trials; 0 passed, 0 failed, 1 errored, 2 retries)",
      `      trial 1 attempt 1 errored: ${INTERRUPTED}`,
      `      trial 1 attempt 2 errored: ${INTERRUPTED}`,
      `      trial 1 attempt 3 errored: ${INTERRUPTED}`,
      "Evals incomplete: the model provider did not complete 1 trial, even after retries, so it was not graded. Repeat the run.",
      "100% of graded normal trials passed (threshold 90%)",
    ]);
  });

  it("does not retry with retries 0", async () => {
    const { runner, counter } = counted({ normal: [interrupted(), good()] });
    const report = await runEvals([suite(wantsA12())], runner, { retries: 0 });
    expect(counter.runs).toBe(1);
    expect(report.scenarios[0]?.trials[0]?.outcome).toBe("errored");
    expect(report.scenarios[0]?.retries).toBe(0);
    expect(report.outcome).toBe("incomplete");
  });

  it("never lets an errored trial make a critical scenario pass", async () => {
    const critical = wantsA12({ id: "critical", severity: "critical", trials: 3 });
    const report = await runEvals(
      [suite(critical)],
      scriptedRunner({ critical: [good(), good(), interrupted(), interrupted(), interrupted()] }),
    );
    expect(report.scenarios[0]?.trials.map((trial) => trial.outcome)).toEqual([
      "passed",
      "passed",
      "errored",
    ]);
    expect(report.scenarios[0]?.outcome).toBe("incomplete");
    expect(report.scenarios[0]?.passed).toBe(false);
    expect(report.outcome).toBe("incomplete");
    expect(report.passed).toBe(false);
  });

  it("never lets an errored trial make a critical scenario fail", async () => {
    const critical = wantsA12({ id: "critical", severity: "critical", trials: 2 });
    const errored = await runEvals(
      [suite(critical)],
      scriptedRunner({ critical: [good(), interrupted(), interrupted(), interrupted()] }),
    );
    expect(errored.scenarios[0]?.outcome).toBe("incomplete");
    expect(errored.outcome).not.toBe("failed");
    // A trial that was graded and failed still fails it, whatever the errored ones would have done.
    const failed = await runEvals(
      [suite(critical)],
      scriptedRunner({
        critical: [trace({ reply: "Done" }), interrupted(), interrupted(), interrupted()],
      }),
    );
    expect(failed.scenarios[0]?.outcome).toBe("failed");
    expect(failed.outcome).toBe("failed");
  });

  it("computes the pass rate over graded trials only", async () => {
    const normal = wantsA12({ trials: 10 });
    const runs = [
      ...Array.from({ length: 8 }, good),
      trace({ reply: "Done" }),
      interrupted(),
      interrupted(),
      interrupted(),
    ];
    const report = await runEvals([suite(normal)], scriptedRunner({ normal: runs }));
    // 8 of the 9 graded trials passed; the errored trial counts neither way.
    expect(report.passRate).toBe(8 / 9);
    expect(report.scenarios[0]).toMatchObject({
      passedTrials: 8,
      failedTrials: 1,
      erroredTrials: 1,
    });
    // Over the graded trials 8/9 misses 90%: a fail the errored trial cannot rescue or cause.
    expect(report.outcome).toBe("failed");
  });

  it("still fails, without a retry, a run that finished with no tool call", async () => {
    // The model chose to call nothing: the runner's own control, not the provider, ended the trial.
    const expecting = scenario({ id: "quiet", trials: 1, expect: { calls: [{ tool: "adjust" }] } });
    const { runner, counter } = counted({
      quiet: [trace({ error: "the executed ledger is empty" }), good()],
    });
    const report = await runEvals([suite(expecting)], runner);
    expect(counter.runs).toBe(1);
    expect(report.scenarios[0]?.trials[0]?.outcome).toBe("failed");
    expect(report.outcome).toBe("failed");
  });

  it("keeps a report with no errored trial in its existing shape, with the new counts at zero", async () => {
    const report = await runEvals([suite(wantsA12())], scriptedRunner({ normal: [good()] }));
    const [trial] = report.scenarios[0]?.trials ?? [];
    expect(trial?.outcome).toBe("passed");
    expect(trial !== undefined && "erroredAttempts" in trial).toBe(false);
    expect(report.scenarios[0]).toMatchObject({ erroredTrials: 0, retries: 0 });
    expect(report.erroredTrials).toBe(0);
    expect(formatReport(report)).toBe(
      [
        "pass  normal (normal, 1/1 trials)",
        "Evals passed: 100% of normal trials passed (threshold 90%)",
      ].join("\n"),
    );
  });
});

describe("runEvals usage and trial counts", () => {
  const suite = (...scenarios: Scenario[]): EvalSuite => ({ scenarios });
  const usage = (scale: number): ModelUsage => ({
    input: 100 * scale,
    cacheRead: 300 * scale,
    cacheWrite: 0,
    output: 20 * scale,
    reasoning: 5 * scale,
    cost: 0.001 * scale,
  });
  const judged = scenario({
    id: "judged",
    trials: 2,
    expect: {
      reply: { judged: [{ claim: "The reply promises a call back.", verdict: "absent" }] },
    },
  });

  it("sums the trial's model and its judge into each trial, scenario and report", async () => {
    const runner: AgentRunner = {
      run: async () => trace({ reply: "Noted.", usage: usage(1) }),
      judge: { model: "test/judge", ask: async () => ({ text: "ABSENT", usage: usage(0.5) }) },
    };
    const report = await runEvals([suite(judged, scenario({ id: "plain", trials: 1 }))], runner);
    const [first, second] = report.scenarios;
    // Each trial: the trial's model (1) and its one judge call (0.5).
    expect(first?.trials[0]?.usage).toEqual(usage(1.5));
    expect(first?.trials[0]?.trace.usage).toEqual(usage(1));
    expect(first?.trials[0]?.trace.judged?.[0]?.usage).toEqual(usage(0.5));
    expect(first?.usage).toEqual(usage(3));
    expect(second?.usage).toEqual(usage(1));
    expect(report.usage?.input).toBe(400);
    expect(report.usage?.cacheRead).toBe(1200);
    expect(report.usage?.output).toBe(80);
    expect(report.usage?.reasoning).toBe(20);
    expect(report.usage?.cost).toBeCloseTo(0.004, 12);
    expect(formatUsage(report.usage ?? usage(0))).toBe(
      "Model usage: 1,600 input tokens (1,200 cached), 80 output tokens (20 reasoning); estimated cost $0.0040",
    );
  });

  it("counts what an errored attempt spent, not only the attempt that was graded", async () => {
    const traces = [
      trace({ error: "interrupted", errorSource: "provider", usage: usage(2) }),
      trace({ reply: "Noted.", usage: usage(1) }),
    ];
    const report = await runEvals(
      [suite(scenario({ id: "retried", trials: 1 }))],
      scriptedRunner({ retried: traces }),
    );
    expect(report.scenarios[0]?.trials[0]?.usage).toEqual(usage(3));
    expect(report.usage).toEqual(usage(3));
  });

  it("leaves usage off a report whose runner measured none", async () => {
    const report = await runEvals(
      [suite(scenario({ id: "one", trials: 1 }))],
      scriptedRunner({ one: [trace({})] }),
    );
    expect("usage" in report).toBe(false);
    expect(report.scenarios[0] !== undefined && "usage" in report.scenarios[0]).toBe(false);
  });

  it("reports a reply cut off at the output cap as errored, never passed or failed", async () => {
    const capped = trace({
      reply: "I will",
      error: "the reply hit the output cap",
      errorSource: "output-limit",
    });
    const report = await runEvals(
      [suite(scenario({ id: "capped", trials: 1, expect: { reply: { contains: ["A12"] } } }))],
      scriptedRunner({ capped: [capped, capped, capped] }),
    );
    const [trial] = report.scenarios[0]?.trials ?? [];
    expect(trial?.outcome).toBe("errored");
    expect(trial?.failures).toEqual([]);
    expect(trial?.erroredAttempts?.[0]).toEqual({
      attempt: 1,
      error: "the reply hit the output cap",
    });
    expect(report.outcome).toBe("incomplete");
  });

  it("runs normal scenarios normalTrials times and critical ones trials times", async () => {
    let runs = 0;
    const runner: AgentRunner = {
      run: async () => {
        runs++;
        return trace({ reply: "A12" });
      },
    };
    const report = await runEvals(
      [
        suite(
          scenario({ id: "critical", severity: "critical", trials: 3 }),
          scenario({ id: "normal", trials: 3 }),
          scenario({ id: "default" }),
        ),
      ],
      runner,
      { trials: 5, normalTrials: 2 },
    );
    expect(report.scenarios.map((entry) => [entry.id, entry.trials.length])).toEqual([
      ["critical", 5],
      ["normal", 2],
      ["default", 2],
    ]);
    expect(runs).toBe(9);
    expect(formatReport(report).split("\n").slice(0, 3)).toEqual([
      "pass  critical (critical, 5/5 trials)",
      "pass  normal (normal, 2/2 trials)",
      "pass  default (normal, 2/2 trials)",
    ]);
  });

  it("keeps trials as the normal scenarios' count when normalTrials is not given", async () => {
    const report = await runEvals(
      [suite(scenario({ id: "normal", trials: 4 }))],
      { run: async () => trace({}) },
      { trials: 2 },
    );
    expect(report.scenarios[0]?.trials).toHaveLength(2);
  });

  it("computes the pass rate on the trials actually run", async () => {
    const traces = [trace({ reply: "A12" }), trace({ reply: "none" })];
    const report = await runEvals(
      [suite(scenario({ id: "normal", trials: 10, expect: { reply: { contains: ["A12"] } } }))],
      scriptedRunner({ normal: traces }),
      { normalTrials: 2 },
    );
    expect(report.passRate).toBe(0.5);
  });
});

describe("the sample role", () => {
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
    expect((await checkAgent(role, pkg.value.manifest)).issues).toEqual([]);

    // A scripted runner stands in for a model, so the suite runs without one.
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
