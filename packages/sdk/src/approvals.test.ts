import type { HookApi, ToolHooks } from "@earendil-works/pi-durable";
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
function hookApi(memos = new Map<string, unknown>()): HookApi {
  return {
    taskId: "task-1",
    conversationId: "conversation-1",
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length === 2 && !memos.has(name)) memos.set(name, rest[0]);
      return memos.get(name);
    },
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
    expect([...memos.values()]).toEqual([{ approved: true, by: "Sam", note: null }]);
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
