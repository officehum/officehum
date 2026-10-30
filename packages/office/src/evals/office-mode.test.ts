/**
 * Office mode: a board, a ticket bound to the trial's conversation and the office's real approval
 * gate, driven by the scripted model — no network, no real model, no key.
 *
 * These cases run the runner directly: the assertions are about the two ledgers in the trace and the
 * rows on the board, which a report would only echo. The last two run through `runEvals`, because the
 * question there is whether the *run* fails, not whether one trace looks right.
 *
 * The fixture is the Sample Stockroom: `stock_adjust` is the tool its manifest declares approvals for
 * (`large_increase`, `large_decrease`) and `stock_levels` is a tool it declares none for, which is the
 * pair a gate needs to be shown doing anything at all.
 */

import { fileURLToPath } from "node:url";
import { type EvalSuite, runEvals, type Scenario, type Trace } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { approvalAskedText } from "../approvals/gate.js";
import { argsHash } from "../board/index.js";
import { type ScriptedTurn, scriptedProvider } from "../testing/scripted-model.js";
import { EMPTY_LEDGER_ERROR, piDurableRunner } from "./pi-durable-runner.js";

const stockroom = fileURLToPath(new URL("../../../sdk/fixtures/sample-stockroom", import.meta.url));

const BOLT = "BOLT-10";
const WRITE_OFF = { sku: BOLT, quantity: -50, reason: "damage" };
const LEVELS = '{"findings":[{"id":"stock:BOLT-10","quantity":120}]}';
const ADJUSTED = '{"findings":[{"id":"adjustment:1"}]}';
/** The person office mode seeds by default, and whose decision a scripted approval is. */
const PERSON = { id: "ada", name: "Ada" } as const;

/** A scenario the runner can be driven with directly, without the suite validation. */
function scenario(fields: Partial<Scenario> = {}): Scenario {
  return {
    id: "office-scenario",
    description: "A scenario run on the office harness",
    input: { kind: "message", text: "Write off 50 BOLT-10, they were damaged." },
    stubs: { stock_levels: { text: LEVELS }, stock_adjust: { text: ADJUSTED } },
    expect: {},
    ...fields,
  };
}

/** A runner on the named harness whose scripted model replays these turns for every trial. */
function runner(turns: readonly ScriptedTurn[], mode: "bare" | "office" = "office") {
  return piDurableRunner({ dir: stockroom, mode, model: () => scriptedProvider(turns) });
}

/** One turn that calls `stock_adjust`, which is the tool the manifest gates. */
const adjustTurn: ScriptedTurn = { toolCalls: [{ name: "stock_adjust", args: WRITE_OFF }] };

const executedOf = (trace: Trace) => trace.executedCalls.filter((call) => call.executed);
const blockedOf = (trace: Trace) => trace.executedCalls.filter((call) => !call.executed);

describe("piDurableRunner in office mode", () => {
  it("refuses a gated call the scenario scripts no decision for, and records why", async () => {
    const trace = await runner([adjustTurn, { text: "Nothing was recorded." }]).run(scenario(), 1);

    // Emitted and executed are separate facts: the model asked, the office refused.
    expect(trace.calls).toEqual([{ tool: "stock_adjust", args: WRITE_OFF }]);
    expect(trace.executedCalls).toEqual([
      {
        tool: "stock_adjust",
        args: WRITE_OFF,
        executed: false,
        blockedBy: "office approval gate",
        blockText: approvalAskedText("stock_adjust", PERSON),
      },
    ]);
    expect(blockTextOf(trace)).toContain("Ada has been asked");

    // The gate asked, once, about exactly these arguments. It names the tool because the ask named
    // no declaration: the office's gate is keyed by tool, not by the manifest's `when` conditions.
    expect(trace.approvals).toEqual([
      {
        ticketId: expect.any(String),
        approvalId: "stock_adjust",
        tool: "stock_adjust",
        args: WRITE_OFF,
        argsHash: argsHash(WRITE_OFF),
        status: "waiting",
        decidedBy: null,
      },
    ]);
    expect(trace.approvalsRequested).toEqual(["stock_adjust"]);
    expect(trace.error).toBe(
      "the scenario scripts no decision for stock_adjust; its manifest declares large_increase, " +
        "large_decrease",
    );
  });

  it("runs the same call once the scenario's approval is on the board", async () => {
    const trace = await runner([adjustTurn, { text: "Recorded adjustment:1." }]).run(
      scenario({ approvals: { large_decrease: "approve" } }),
      1,
    );

    expect(trace.calls).toEqual([{ tool: "stock_adjust", args: WRITE_OFF }]);
    expect(trace.executedCalls).toEqual([
      { tool: "stock_adjust", args: WRITE_OFF, executed: true },
    ]);
    expect(trace.approvals).toEqual([
      {
        ticketId: expect.any(String),
        approvalId: "large_decrease",
        tool: "stock_adjust",
        args: WRITE_OFF,
        argsHash: argsHash(WRITE_OFF),
        status: "approved",
        decidedBy: PERSON.id,
      },
    ]);
    expect(trace.approvalsRequested).toEqual(["large_decrease"]);
    expect(trace.error).toBeUndefined();
  });

  it("blocks the call a person declined, and quotes their answer", async () => {
    const trace = await runner([
      adjustTurn,
      { toolCalls: [{ name: "stock_levels", args: { sku: BOLT } }] },
      { text: "That write-off was declined, so nothing was recorded." },
    ]).run(scenario({ approvals: { large_decrease: "decline" } }), 1);

    expect(trace.calls).toEqual([
      { tool: "stock_adjust", args: WRITE_OFF },
      { tool: "stock_levels", args: { sku: BOLT } },
    ]);
    // The declined write-off never ran; the read after it did, which is also what keeps this trial
    // from tripping the empty-ledger control below.
    expect(blockedOf(trace)).toEqual([
      {
        tool: "stock_adjust",
        args: WRITE_OFF,
        executed: false,
        blockedBy: "office approval gate",
        blockText:
          `stock_adjust was not run: ${PERSON.id} declined these exact arguments: the ` +
          "office-scenario scenario scripts this answer. The decision stands, so asking again will " +
          "not change it; do the work another way or tell the user.",
      },
    ]);
    expect(executedOf(trace)).toEqual([
      { tool: "stock_levels", args: { sku: BOLT }, executed: true },
    ]);
    expect(trace.approvals.map((row) => row.status)).toEqual(["declined"]);
    expect(trace.approvals[0]?.decidedBy).toBe(PERSON.id);
    expect(trace.error).toBeUndefined();
  });

  it("leaves a tool with no declared approval alone, and writes no row for it", async () => {
    const trace = await runner([
      { toolCalls: [{ name: "stock_levels", args: { sku: BOLT } }] },
      { text: `BOLT-10 is at 120 units, from stock:${BOLT}.` },
    ]).run(scenario(), 1);

    expect(trace.executedCalls).toEqual([
      { tool: "stock_levels", args: { sku: BOLT }, executed: true },
    ]);
    expect(trace.approvals).toEqual([]);
    expect(trace.approvalsRequested).toEqual([]);
    expect(trace.error).toBeUndefined();
  });

  it("fails the run when nothing executed, because an empty ledger proves nothing", async () => {
    // The model answers without calling anything: a gate that refused everything and a ledger that
    // saw nothing produce this same trace, so the runner refuses to call it a pass.
    const trace = await runner([{ text: "I would rather not." }]).run(scenario(), 1);
    expect(trace.calls).toEqual([]);
    expect(trace.executedCalls).toEqual([]);
    expect(trace.error).toBe(EMPTY_LEDGER_ERROR);

    const suite: EvalSuite = { scenarios: [scenario()] };
    const report = await runEvals([suite], runner([{ text: "I would rather not." }]));
    expect(report.passed).toBe(false);
    expect(report.scenarios[0]?.trials[0]?.failures).toEqual([
      `run did not finish: ${EMPTY_LEDGER_ERROR}`,
    ]);
  });

  it("records a tool the harness does not stub, so the ledger is not only the stubs", async () => {
    // `read_skill` is not a declared tool, so nothing wraps it: the after-tool record is what keeps a
    // run that read a skill from being reported as a run that executed nothing.
    const trace = await runner([
      { toolCalls: [{ name: "read_skill", args: { name: "stock-levels" } }] },
      { text: "Done." },
    ]).run(scenario(), 1);

    expect(trace.executedCalls).toEqual([
      { tool: "read_skill", args: { name: "stock-levels" }, executed: true },
    ]);
    expect(trace.approvals).toEqual([]);
  });

  it("keeps bare mode's trace: no board, no rows, and the approver's ids", async () => {
    // The same gated call on the bare harness. There is no board to hold a decision, so the role's
    // own gate asks the scripted approver, and the trace's record of the refusal is the emitted call
    // with no executed counterpart — which is exactly the fact office mode exists to make precise.
    const trace = await runner([adjustTurn, { text: "Nothing was recorded." }], "bare").run(
      scenario(),
      1,
    );
    expect(trace.approvals).toEqual([]);
    expect(trace.approvalsRequested).toEqual(["large_decrease"]);
    expect(trace.executedCalls).toEqual([
      { tool: "stock_adjust", args: WRITE_OFF, executed: false },
    ]);
    expect(trace.error).toBe("the large_decrease approval is not scripted by the scenario");
  });
});

/** The block text of the one refused call, for the sentences worth quoting in full elsewhere. */
function blockTextOf(trace: Trace): string {
  return blockedOf(trace)[0]?.blockText ?? "";
}
