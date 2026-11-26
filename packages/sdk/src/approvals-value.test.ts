/**
 * Approver values: an approval that declares a `value` is granted only by a yes that
 * carries a whole number of cents inside the pinned bounds, and the value reaches the tool through the
 * gate, exactly once. The fixture role is `fixtures/approver-values.ts`. See
 * docs/design/approver-values.md, "Tests that define done".
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  type Extension,
  Harness,
  type HookApi,
  hook,
  type ToolHooks,
  ToolTask,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPROVED_VALUE_ARG,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalValueProblem,
  type Approver,
  approvalValueProblem,
  approvedValue,
  type HookContext,
  isApprovalGate,
  resolveValueRequest,
  valueProblemForApprover,
  valueProblemForModel,
} from "./approvals.js";
import { type ValueWrite, valueDesk, valueDeskManifest } from "./fixtures/approver-values.js";
import { callOnce, lastAnswer, scripted } from "./test-helpers.js";

const context = {} as HookContext;

/** A stand-in for the tool task's hook API: its memo is a map, first write wins. */
function hookApi(memos = new Map<string, unknown>()): HookApi {
  return {
    taskId: "task-1",
    conversationId: "conversation-1",
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length === 2 && !memos.has(name)) memos.set(name, rest[0]);
      return memos.get(name);
    },
    snapshot: async () => undefined,
    snapshotAsOf: async () => undefined,
  } as unknown as HookApi;
}

const call = (name: string, args: Record<string, unknown>, id = "call-1") =>
  ({ type: "toolCall", id, name, arguments: args }) as Parameters<ToolHooks["beforeTool"]>[0];

/** The fixture role's gate, with the given approver and records. */
function desk(approve: Approver | undefined, gross = new Map([["E-7", 200_000]])) {
  const writes: ValueWrite[] = [];
  const role = valueDesk({ approve, gross, writes });
  const registration = (role.extensions[0]?.hooks ?? []).find(isApprovalGate);
  if (registration === undefined) throw new Error("the fixture has no approval gate");
  const { handlers } = registration as unknown as { handlers: Pick<ToolHooks, "beforeTool"> };
  return { gate: handlers.beforeTool, gross, writes };
}

const yes =
  (value?: unknown, by = "sam"): Approver =>
  async () =>
    ({ approved: true, by, ...(value === undefined ? {} : { value }) }) as ApprovalDecision;

const DECISION = "officehum.approval.call-1.any_credit";

describe("an approval that asks for a value", () => {
  it("asks with the label and the pinned fixed bounds, and hands the tool the value a person entered", async () => {
    const approve = vi.fn<Approver>(yes(2_500));
    const { gate } = desk(approve);
    const result = await gate(call("give_credit", { client: "C-1" }), hookApi(), context);
    expect(approve.mock.calls[0]?.[0]).toMatchObject({
      approvalId: "any_credit",
      valueRequest: { name: "creditCents", label: "Credit to give", min: 1, max: 50_000 },
    });
    expect(result).toEqual({
      arguments: {
        client: "C-1",
        [APPROVED_VALUE_ARG]: { name: "creditCents", cents: 2_500, by: "sam" },
      },
    });
  });

  it("reads fact bounds from the role's records, a negative minimum included, and pins them", async () => {
    const memos = new Map<string, unknown>();
    const asked: ApprovalRequest[] = [];
    const { gate, gross } = desk(async (request) => {
      asked.push(request);
      // The record changes after the ask: the bounds already asked about must not move.
      gross.set("E-7", 1_000);
      return asked.length === 1
        ? { approved: false, pending: true }
        : { approved: true, by: "sam", value: -150_000 };
    });
    const pending = await gate(call("adjust_pay", { employee: "E-7" }), hookApi(memos), context);
    expect(pending?.block).toContain("has not answered yet");
    const granted = await gate(call("adjust_pay", { employee: "E-7" }), hookApi(memos), context);
    expect(asked.map((request) => request.valueRequest)).toEqual([
      { name: "adjustmentCents", label: "Adjustment to gross pay", min: -200_000, max: 200_000 },
      { name: "adjustmentCents", label: "Adjustment to gross pay", min: -200_000, max: 200_000 },
    ]);
    expect(granted?.arguments?.[APPROVED_VALUE_ARG]).toEqual({
      name: "adjustmentCents",
      cents: -150_000,
      by: "sam",
    });
  });

  it("refuses a yes with no value, out of bounds, or not whole cents: nothing is recorded and the person can answer again", async () => {
    for (const value of [undefined, 0, 50_001, 12.5, "2500", Number.NaN]) {
      const memos = new Map<string, unknown>();
      const { gate } = desk(yes(value));
      const result = await gate(call("give_credit", { client: "C-1" }), hookApi(memos), context);
      expect(result?.block, String(value)).toContain("give_credit was not run");
      expect(result?.block).toContain("did not carry a valid value");
      expect(result?.block).toContain("Nothing has been approved or declined.");
      // The block is the model's: it names neither bound nor what the approver entered.
      expect(result?.block).not.toContain("50000");
      for (const entered of [50_001, 12.5, "2500"].filter((item) => item === value)) {
        expect(result?.block).not.toContain(String(entered));
      }
      expect(memos.has(DECISION)).toBe(false);
      // The same call asked again with a valid answer runs.
      const again = await desk(yes(300)).gate(
        call("give_credit", { client: "C-1" }),
        hookApi(memos),
        context,
      );
      expect(again?.arguments?.[APPROVED_VALUE_ARG]).toMatchObject({ cents: 300 });
    }
    // Below a fact-bound negative minimum.
    const { gate } = desk(yes(-200_001));
    const low = await gate(call("adjust_pay", { employee: "E-7" }), hookApi(), context);
    expect(low?.block).toContain("adjust_pay was not run");
    expect(low?.block).not.toContain("200000");
    expect(low?.block).not.toContain("200001");
  });

  it("tells the model not to retry or state a figure after an invalid answer", async () => {
    const { gate } = desk(yes());
    const result = await gate(call("give_credit", { client: "C-1" }), hookApi(), context);
    expect(result?.block).toContain("Do not retry this call on your own");
    expect(result?.block).toContain("do not state any figure");
  });

  it("says what is wrong in structured form, and names the bounds only to the approver", () => {
    const request = { name: "adjustmentCents", label: "Adjustment", min: -174_300, max: 174_300 };
    expect(approvalValueProblem(request, { approved: true })).toEqual({
      code: "value_missing",
      request,
    });
    expect(approvalValueProblem(request, { approved: true, value: 12.5 })).toEqual({
      code: "not_whole_cents",
      request,
      value: 12.5,
    });
    const outside = approvalValueProblem(request, { approved: true, value: 999_999 });
    expect(outside).toEqual({ code: "out_of_bounds", request, cents: 999_999 });
    expect(approvalValueProblem(request, { approved: false, value: 5 })).toEqual({
      code: "decline_with_value",
    });
    expect(approvalValueProblem(request, { approved: true, value: -174_300 })).toBeUndefined();
    expect(valueProblemForApprover(outside as ApprovalValueProblem)).toBe(
      'The value 999999 for "Adjustment" (value, whole cents from -174300 to 174300) is outside its bounds.',
    );
    const forModel = valueProblemForModel("adjust_pay", "Approve a pay correction");
    expect(forModel).toContain("adjust_pay was not run");
    expect(forModel).not.toMatch(/\d/);
  });

  it("declines as today, and refuses a decline that carries a value", async () => {
    const memos = new Map<string, unknown>();
    const declined = await desk(async () => ({ approved: false, by: "sam", note: "no" })).gate(
      call("give_credit", { client: "C-1" }),
      hookApi(memos),
      context,
    );
    expect(declined?.block).toContain("A person declined this action");
    expect(memos.get(DECISION)).toEqual({ approved: false, by: "sam", note: "no", value: null });

    const withValue = await desk(async () => ({ approved: false, value: 5 })).gate(
      call("give_credit", { client: "C-1" }),
      hookApi(),
      context,
    );
    expect(withValue?.block).toContain("did not carry a valid value");
    expect(withValue?.block).not.toMatch(/\d/);
  });

  it("strips a value the model supplied, and never uses a figure from its other arguments", async () => {
    const approve = vi.fn<Approver>(yes(2_500));
    const { gate } = desk(approve);
    const forged = {
      client: "C-1",
      reason: "the client asked for 40000",
      suggestedCents: 40_000,
      [APPROVED_VALUE_ARG]: { name: "creditCents", cents: 49_999, by: "model" },
    };
    const result = await gate(call("give_credit", forged), hookApi(), context);
    expect(approve.mock.calls[0]?.[0].arguments).not.toHaveProperty(APPROVED_VALUE_ARG);
    expect(result?.arguments?.[APPROVED_VALUE_ARG]).toEqual({
      name: "creditCents",
      cents: 2_500,
      by: "sam",
    });

    // Refused and declined calls lose the forged value too.
    const blocked = await desk(undefined).gate(call("give_credit", forged), hookApi(), context);
    expect(blocked?.block).toContain("no approver is configured");
  });

  it("keeps the first recorded decision and its value: a crash mid-ask never changes the figure", async () => {
    const memos = new Map<string, unknown>();
    const { gate } = desk(async () => {
      // Another ask for the same call recorded its decision first.
      memos.set(DECISION, { approved: true, by: "first", note: null, value: 100 });
      return { approved: true, by: "second", value: 200 };
    });
    const result = await gate(call("give_credit", { client: "C-1" }), hookApi(memos), context);
    expect(result?.arguments?.[APPROVED_VALUE_ARG]).toEqual({
      name: "creditCents",
      cents: 100,
      by: "first",
    });
  });

  it("hands a replay the same value without asking again", async () => {
    const memos = new Map<string, unknown>();
    const approve = vi.fn<Approver>(yes(700));
    const { gate } = desk(approve);
    const first = await gate(call("give_credit", { client: "C-1" }), hookApi(memos), context);
    const replay = await gate(call("give_credit", { client: "C-1" }), hookApi(memos), context);
    expect(approve).toHaveBeenCalledOnce();
    expect(replay).toEqual(first);
  });

  it("grants no value from a yes recorded before the approval asked for one", async () => {
    const memos = new Map<string, unknown>([[DECISION, { approved: true, by: "sam", note: null }]]);
    const result = await desk(yes(5)).gate(
      call("give_credit", { client: "C-1" }),
      hookApi(memos),
      context,
    );
    expect(result?.block).toContain('was recorded without "Credit to give"');
  });

  it("refuses before asking anyone when the bounds cannot be resolved", async () => {
    for (const gross of [10.5, -174_300]) {
      const approve = vi.fn<Approver>(yes(0));
      const { gate } = desk(approve, new Map([["E-7", gross]]));
      const result = await gate(call("adjust_pay", { employee: "E-7" }), hookApi(), context);
      expect(result?.block).toContain("so nobody was asked");
      // Bounds that cross are read from the records; the model is not told them.
      expect(result?.block).not.toContain("174300");
      expect(approve).not.toHaveBeenCalled();
    }
  });

  it("refuses a value on a yes to an approval that asks for none", () => {
    const problem = approvalValueProblem(undefined, { approved: true, value: 5 });
    expect(problem).toEqual({ code: "value_not_asked" });
    expect(valueProblemForApprover(problem as ApprovalValueProblem)).toBe(
      "This approval asks for no value; approve it without one.",
    );
    expect(approvalValueProblem(undefined, { approved: true })).toBeUndefined();
  });
});

describe("resolveValueRequest", () => {
  const value = { name: "creditCents", label: "Credit" };
  it("defaults min to 0, reads fact bounds, and refuses bounds it cannot read or that cross", () => {
    expect(resolveValueRequest(value)).toEqual({ request: { ...value, min: 0 } });
    expect(resolveValueRequest({ ...value, minFact: "low", max: 10 }, { low: -10 })).toEqual({
      request: { ...value, min: -10, max: 10 },
    });
    expect(resolveValueRequest({ ...value, maxFact: "high" }, {})).toHaveProperty("problem");
    expect(resolveValueRequest({ ...value, maxFact: "high" }, { high: "9" })).toHaveProperty(
      "problem",
    );
    expect(resolveValueRequest({ ...value, min: 5, maxFact: "high" }, { high: 4 })).toHaveProperty(
      "problem",
    );
  });
});

describe("approvedValue", () => {
  it("reads the value by name, and throws when it is absent or named otherwise", () => {
    const args = { [APPROVED_VALUE_ARG]: { name: "creditCents", cents: 5, by: null } };
    expect(approvedValue(args, "creditCents")).toEqual({ name: "creditCents", cents: 5, by: null });
    expect(() => approvedValue({}, "creditCents")).toThrow("carries no approved creditCents");
    expect(() => approvedValue(args, "revisedCents")).toThrow('is "creditCents", not revisedCents');
    expect(() =>
      approvedValue({ [APPROVED_VALUE_ARG]: { name: "creditCents", cents: 1.5 } }, "creditCents"),
    ).toThrow("not a whole number");
  });
});

describe("on a Pi Durable harness with a local approver", () => {
  const harnesses: Harness[] = [];
  const temps: string[] = [];
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.close(BACKGROUND_CONTEXT);
    for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  const registryOf = (extensions: readonly Extension[]) => {
    const registry = createRegistry();
    for (const extension of extensions) registry.install(extension);
    return registry;
  };

  it("runs the tool once with the person's value, whatever figure the model wrote", async () => {
    const writes: ValueWrite[] = [];
    const role = valueDesk({ approve: yes(2_500), gross: new Map(), writes });
    const model = scripted(
      callOnce("give_credit", {
        client: "C-1",
        reason: "credit 40000",
        suggestedCents: 40_000,
        [APPROVED_VALUE_ARG]: { name: "creditCents", cents: 49_999, by: "model" },
      }),
    );
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: model.models, registry: registryOf(role.extensions) },
      BACKGROUND_CONTEXT,
    );
    harnesses.push(harness);
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { ...role.agent, model: model.model },
    });
    const submission = await root.submit(
      { type: "input", content: "Credit C-1." },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    expect(writes).toEqual([{ tool: "give_credit", subject: "C-1", cents: 2_500, by: "sam" }]);
    expect(lastAnswer((await root.context(BACKGROUND_CONTEXT)).messages)).toContain(
      "credited 2500 cents",
    );
  });

  it("does not run the tool on a yes without the value", async () => {
    const writes: ValueWrite[] = [];
    const role = valueDesk({ approve: yes(), gross: new Map(), writes });
    const model = scripted(callOnce("give_credit", { client: "C-1" }));
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: model.models, registry: registryOf(role.extensions) },
      BACKGROUND_CONTEXT,
    );
    harnesses.push(harness);
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { ...role.agent, model: model.model },
    });
    await (await root.submit({ type: "input", content: "Credit C-1." }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    expect(writes).toEqual([]);
    expect(lastAnswer((await root.context(BACKGROUND_CONTEXT)).messages)).toContain(
      "did not carry a valid value",
    );
  });

  it("tells the model neither the fact bounds nor the entered value after an invalid answer", async () => {
    // Payroll's case: the bounds are minus and plus one employee's gross, read from the records.
    for (const answer of [yes(), yes(999_999), yes(12.5), yes(-999_999)]) {
      const writes: ValueWrite[] = [];
      const role = valueDesk({ approve: answer, gross: new Map([["E-7", 174_300]]), writes });
      const requests: string[] = [];
      const model = scripted((messages) => {
        requests.push(JSON.stringify(messages));
        return callOnce("adjust_pay", { employee: "E-7" })(messages);
      });
      const harness = await Harness.open(
        new MemoryStorage(),
        { models: model.models, registry: registryOf(role.extensions) },
        BACKGROUND_CONTEXT,
      );
      harnesses.push(harness);
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: { ...role.agent, model: model.model },
      });
      await (
        await root.submit({ type: "input", content: "Correct E-7's pay." }, BACKGROUND_CONTEXT)
      ).wait(BACKGROUND_CONTEXT);
      expect(writes).toEqual([]);
      // The request after the refusal carries the block; nothing the model receives names a figure.
      expect(requests).toHaveLength(2);
      const seen = [...requests, JSON.stringify((await root.context(BACKGROUND_CONTEXT)).messages)];
      for (const text of seen) {
        for (const figure of ["174300", "1743", "999999", "12.5"]) {
          expect(text).not.toContain(figure);
        }
      }
      expect(requests[1]).toContain("did not carry a valid value");
    }
  });

  it("hands the value recorded before a restart to the tool, once, without asking again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rasf-3604-value-restart-"));
    temps.push(directory);
    const file = join(directory, "harness.sqlite");
    const writes: ValueWrite[] = [];
    const asked: string[] = [];
    const approve: Approver = async (request) => {
      asked.push(request.callId);
      return { approved: true, by: "sam", value: -40_000 };
    };
    // A hook after the gate that holds the first run between the recorded decision and the write.
    let held = () => {};
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const hold = hook(ToolTask, {
      beforeTool: async (_call, _api, hookContext) => {
        held();
        await new Promise<never>((_resolve, reject) => {
          hookContext.abortSignal?.addEventListener("abort", () => reject(new Error("closed")));
        });
        return undefined;
      },
    });
    const gross = new Map([["E-7", 200_000]]);
    const firstRole = valueDesk({ approve, gross, writes, hooks: [hold] });
    const first = scripted(callOnce("adjust_pay", { employee: "E-7" }));
    const harness = await Harness.open(
      await openNodeSqliteStorage(file),
      { models: first.models, registry: registryOf(firstRole.extensions) },
      BACKGROUND_CONTEXT,
    );
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { ...firstRole.agent, model: first.model },
    });
    const submission = await root.submit(
      { type: "input", content: "Correct E-7's pay." },
      BACKGROUND_CONTEXT,
    );
    await holding;
    const [pending] = (await harness.inspect(BACKGROUND_CONTEXT)).submissions;
    if (pending === undefined) throw new Error("the held submission is not there");
    await harness.close(BACKGROUND_CONTEXT);
    await submission.wait(BACKGROUND_CONTEXT).catch(() => {});
    expect(writes).toEqual([]);
    expect(asked).toHaveLength(1);

    // The record changes while the office is down; the decision already recorded stands.
    gross.set("E-7", 1);
    const secondRole = valueDesk({ approve, gross, writes });
    const second = scripted(callOnce("adjust_pay", { employee: "E-7" }));
    const restarted = await Harness.open(
      await openNodeSqliteStorage(file),
      { models: second.models, registry: registryOf(secondRole.extensions) },
      BACKGROUND_CONTEXT,
    );
    harnesses.push(restarted);
    restarted.resume();
    const resumed = await restarted.submission(pending.id, BACKGROUND_CONTEXT);
    if (resumed === undefined) throw new Error("the held submission did not come back");
    expect((await resumed.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(asked).toHaveLength(1);
    expect(writes).toEqual([{ tool: "adjust_pay", subject: "E-7", cents: -40_000, by: "sam" }]);
  });
});

it("the fixture's manifest is a valid manifest", async () => {
  const { validateManifest } = await import("./manifest.js");
  expect(validateManifest(valueDeskManifest).issues).toEqual([]);
});
