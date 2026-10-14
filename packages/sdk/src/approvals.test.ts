import { defineDoc, type HookApi, type ToolHooks } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import {
  type ApprovalGateOptions,
  type Approver,
  approvalGate,
  conditionsHold,
  type HookContext,
} from "./approvals.js";

const approvals = [
  { id: "book_after_hours", tool: "book_appointment", description: "Bookings after 18:00" },
];
const context = {} as HookContext;

/** A stand-in for the tool task's hook API: its memo is a map, as durable as this test needs. */
function hookApi(
  memos = new Map<string, unknown>(),
  snapshots = new Map<string, unknown>(),
): HookApi {
  return {
    taskId: "task-1",
    conversationId: "conversation-1",
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length === 2 && !memos.has(name)) memos.set(name, rest[0]);
      return memos.get(name);
    },
    snapshot: async (token: { definition: { kind: string } }) =>
      snapshots.get(token.definition.kind),
    snapshotAsOf: async () => undefined,
  } as unknown as HookApi;
}

const call = (name: string, args: Record<string, unknown>, id = "call-1") =>
  ({ type: "toolCall", id, name, arguments: args }) as Parameters<ToolHooks["beforeTool"]>[0];

function beforeTool(options: ApprovalGateOptions) {
  const { handlers } = approvalGate(options) as { handlers: Pick<ToolHooks, "beforeTool"> };
  return handlers.beforeTool;
}

describe("approvalGate", () => {
  it("blocks gated actions when no approver is supplied", async () => {
    const result = await beforeTool({ approvals })(
      call("book_appointment", {}),
      hookApi(),
      context,
    );
    expect(result?.block).toContain("needs a person's approval (Bookings after 18:00)");
  });

  it("lets ungated tools through", async () => {
    const result = await beforeTool({ approvals })(call("check_schedule", {}), hookApi(), context);
    expect(result).toBeUndefined();
  });

  it("asks only when the approval's condition holds", async () => {
    const approve = vi.fn<Approver>(async () => ({ approved: true }));
    const gate = beforeTool({
      approvals,
      approve,
      when: { book_after_hours: (args) => Number(String(args.start).slice(11, 13)) >= 18 },
    });
    expect(
      await gate(call("book_appointment", { start: "2026-10-06T15:00" }), hookApi(), context),
    ).toBeUndefined();
    expect(approve).not.toHaveBeenCalled();
    expect(
      await gate(call("book_appointment", { start: "2026-10-06T19:00" }), hookApi(), context),
    ).toBeUndefined();
    expect(approve).toHaveBeenCalledOnce();
    expect(approve.mock.calls[0]?.[0]).toMatchObject({
      approvalId: "book_after_hours",
      tool: "book_appointment",
      arguments: { start: "2026-10-06T19:00" },
      callId: "call-1",
      taskId: "task-1",
    });
  });

  it("blocks with the person's reason when they decline", async () => {
    const gate = beforeTool({
      approvals,
      approve: async () => ({ approved: false, by: "Sam", note: "We close at 6" }),
    });
    const result = await gate(call("book_appointment", {}), hookApi(), context);
    expect(result?.block).toBe(
      "A person declined this action (Bookings after 18:00): We close at 6.",
    );
  });

  it("never asks twice for the same call, so a crash cannot re-ask or forget a yes", async () => {
    const approve = vi.fn<Approver>(async () => ({ approved: true, by: "Sam" }));
    const memos = new Map<string, unknown>();
    const gate = beforeTool({ approvals, approve });
    await gate(call("book_appointment", {}), hookApi(memos), context);
    // The tool task is recovered after a crash: the hook runs again for the same call.
    const again = await gate(call("book_appointment", {}), hookApi(memos), context);
    expect(again).toBeUndefined();
    expect(approve).toHaveBeenCalledOnce();
    expect([...memos.values()]).toEqual([
      { tool: "book_appointment", argsJson: "{}", required: true },
      { approved: true, by: "Sam", note: null },
    ]);
  });

  it("gives async conditions a bound read-only document reader", async () => {
    const HistoryDoc = defineDoc<{ known: boolean }>({
      kind: "test.approval-history",
      version: 1,
      scope: "session",
      initial: () => ({ known: false }),
    });
    const approve = vi.fn<Approver>(async () => ({ approved: true }));
    let readerKeys: string[] = [];
    const gate = beforeTool({
      approvals,
      approve,
      when: {
        book_after_hours: async (_args, environment, predicateContext) => {
          readerKeys = Object.keys(environment.read).sort();
          expect(predicateContext).toBe(context);
          return !((await environment.read.snapshot(HistoryDoc, predicateContext))?.known ?? false);
        },
      },
    });
    await gate(
      call("book_appointment", { customer: "Ada" }),
      hookApi(new Map(), new Map([["test.approval-history", { known: false }]])),
      context,
    );
    expect(readerKeys).toEqual(["snapshot", "snapshotAsOf"]);
    expect(approve).toHaveBeenCalledOnce();
  });

  it("persists true and false applicability before approval or bypass", async () => {
    const approve = vi.fn<Approver>(async () => ({ approved: true }));
    const trueMemos = new Map<string, unknown>();
    const falseMemos = new Map<string, unknown>();
    const required = vi.fn(
      async (args: Readonly<Record<string, unknown>>) => args.required === true,
    );
    const gate = beforeTool({ approvals, approve, when: { book_after_hours: required } });

    await gate(call("book_appointment", { required: true }), hookApi(trueMemos), context);
    await gate(
      call("book_appointment", { required: false }, "call-2"),
      hookApi(falseMemos),
      context,
    );

    expect(trueMemos.get("officehum.approval-intent.call-1.book_after_hours")).toEqual({
      tool: "book_appointment",
      argsJson: '{"required":true}',
      required: true,
    });
    expect(falseMemos.get("officehum.approval-intent.call-2.book_after_hours")).toEqual({
      tool: "book_appointment",
      argsJson: '{"required":false}',
      required: false,
    });
    expect(approve).toHaveBeenCalledOnce();
  });

  it("replays immutable false applicability after durable state changes", async () => {
    const memos = new Map<string, unknown>();
    let known = true;
    const applies = vi.fn(async () => !known);
    const approve = vi.fn<Approver>(async () => ({ approved: true }));
    const gate = beforeTool({ approvals, approve, when: { book_after_hours: applies } });

    await gate(
      call("book_appointment", { b: 2, nested: { z: 1, a: 0 }, a: 1 }),
      hookApi(memos),
      context,
    );
    known = false;
    await gate(
      call("book_appointment", { a: 1, nested: { a: 0, z: 1 }, b: 2 }),
      hookApi(memos),
      context,
    );

    expect(applies).toHaveBeenCalledOnce();
    expect(approve).not.toHaveBeenCalled();
    expect(memos.get("officehum.approval-intent.call-1.book_after_hours")).toEqual({
      tool: "book_appointment",
      argsJson: '{"a":1,"b":2,"nested":{"a":0,"z":1}}',
      required: false,
    });
  });

  it("rejects changed arguments under a call identity before reusing applicability or a decision", async () => {
    const memos = new Map<string, unknown>();
    const gate = beforeTool({
      approvals,
      approve: async () => ({ approved: true }),
      when: { book_after_hours: () => true },
    });
    await gate(call("book_appointment", { start: "one" }), hookApi(memos), context);
    await expect(
      gate(call("book_appointment", { start: "two" }), hookApi(memos), context),
    ).rejects.toThrow(/different tool or arguments/i);
  });

  it("preserves legacy approved and declined decisions without applicability memos", async () => {
    const approved = new Map<string, unknown>([
      ["officehum.approval.call-1.book_after_hours", { approved: true, by: null, note: null }],
    ]);
    const declined = new Map<string, unknown>([
      [
        "officehum.approval.call-1.book_after_hours",
        { approved: false, by: "Sam", note: "legacy decline" },
      ],
    ]);
    const applies = vi.fn(() => false);
    const gate = beforeTool({ approvals, when: { book_after_hours: applies } });
    expect(
      await gate(call("book_appointment", { changed: true }), hookApi(approved), context),
    ).toBeUndefined();
    expect(
      (await gate(call("book_appointment", { changed: true }), hookApi(declined), context))?.block,
    ).toContain("legacy decline");
    expect(applies).not.toHaveBeenCalled();
  });

  it("keeps a persisted decline after later history makes the tuple known", async () => {
    const memos = new Map<string, unknown>();
    let known = false;
    const applies = vi.fn(() => !known);
    const gate = beforeTool({
      approvals,
      approve: async () => ({ approved: false, by: "operator", note: "declined first contact" }),
      when: { book_after_hours: applies },
    });
    expect(
      (await gate(call("book_appointment", { target: "same" }), hookApi(memos), context))?.block,
    ).toContain("declined first contact");
    known = true;
    expect(
      (await gate(call("book_appointment", { target: "same" }), hookApi(memos), context))?.block,
    ).toContain("declined first contact");
    expect(applies).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("predicate failed");
      },
    ],
    [
      "rejects",
      async () => {
        throw new Error("predicate failed");
      },
    ],
    ["returns a nonboolean", () => "yes"],
  ])("fails safe when an async condition %s", async (_label, condition) => {
    const approve = vi.fn<Approver>(async () => ({ approved: true }));
    const gate = beforeTool({
      approvals,
      approve,
      when: { book_after_hours: condition as never },
    });
    await gate(call("book_appointment", {}), hookApi(), context);
    expect(approve).toHaveBeenCalledOnce();
  });

  it("propagates active cancellation from a condition", async () => {
    const controller = new AbortController();
    const cancelled = {
      abortSignal: controller.signal,
      value: () => undefined,
      toString: () => "cancelled test",
    } as HookContext;
    controller.abort(new Error("cancelled"));
    const approve = vi.fn<Approver>(async () => ({ approved: true }));
    const gate = beforeTool({
      approvals,
      approve,
      when: {
        book_after_hours: async () => {
          throw new Error("predicate interrupted");
        },
      },
    });
    await expect(gate(call("book_appointment", {}), hookApi(), cancelled)).rejects.toThrow(
      "cancelled",
    );
    expect(approve).not.toHaveBeenCalled();
  });
});

describe("approval conditions from officehum.json", () => {
  const declared = [
    {
      id: "large_decrease",
      tool: "stock_adjust",
      description: "Removing more than 10 units",
      when: [{ arg: "quantity", op: "lt" as const, value: -10 }],
    },
  ];

  it("gates only calls that meet the declared condition", async () => {
    const gate = beforeTool({ approvals: declared });
    expect(await gate(call("stock_adjust", { quantity: -5 }), hookApi(), context)).toBeUndefined();
    expect(
      (await gate(call("stock_adjust", { quantity: -50 }), hookApi(), context))?.block,
    ).toContain("Removing more than 10 units");
  });

  it("fails safe: a missing or unreadable argument still needs approval", async () => {
    const gate = beforeTool({ approvals: declared });
    expect((await gate(call("stock_adjust", {}), hookApi(), context))?.block).toBeDefined();
    expect(
      (await gate(call("stock_adjust", { quantity: "lots" }), hookApi(), context))?.block,
    ).toBeDefined();
  });

  it("lets a condition written in code take precedence", async () => {
    const gate = beforeTool({ approvals: declared, when: { large_decrease: () => false } });
    expect(await gate(call("stock_adjust", { quantity: -50 }), hookApi(), context)).toBeUndefined();
  });

  it("supports every comparison", () => {
    const holds = (
      op: "gt" | "gte" | "lt" | "lte" | "eq" | "ne" | "in",
      value: number | string | string[],
      actual: unknown,
    ) => conditionsHold([{ arg: "x", op, value }], { x: actual });
    expect([holds("gt", 5, 6), holds("gte", 5, 5), holds("lt", 5, 4), holds("lte", 5, 5)]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect([
      holds("gt", 5, 5),
      holds("eq", "a", "a"),
      holds("ne", "a", "a"),
      holds("in", ["a", "b"], "c"),
    ]).toEqual([false, true, false, false]);
  });
});
