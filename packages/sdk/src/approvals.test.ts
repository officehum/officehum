import { defineDoc, type HookApi, type ToolHooks } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import stockroomManifest from "../fixtures/sample-stockroom/officehum.json" with { type: "json" };
import sampleStockroom, {
  packageDir as stockroomDir,
} from "../fixtures/sample-stockroom/src/index.js";
import {
  APPROVED_FACTS_ARG,
  type ApprovalFactsReader,
  type ApprovalGateOptions,
  type ApprovalRequest,
  type Approver,
  approvalGate,
  approvedFacts,
  conditionsHold,
  type HookContext,
  isApprovalGate,
  sameFacts,
} from "./approvals.js";
import { stubEngine } from "./engine.js";
import type { ConditionDeclaration } from "./manifest.js";
import { type DefinedRole, defineRole } from "./role.js";
import { STOCKROOM_OVERLAY } from "./test-helpers.js";

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

/** The approval gate a role built with `defineRole` installs, ready to drive a call through. */
function gateFrom(role: DefinedRole) {
  const registration = (role.extensions[0]?.hooks ?? []).find(isApprovalGate);
  if (registration === undefined) throw new Error("the role has no approval gate");
  const { handlers } = registration as unknown as { handlers: Pick<ToolHooks, "beforeTool"> };
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
      "A person declined this action (Bookings after 18:00): We close at 6. " +
        "Say it was declined. This result does not say who declined, so name no one as the person who did.",
    );
  });

  it("blocks a pending answer as waiting, and records no decision so the person can still answer", async () => {
    const answers = [
      { approved: false, pending: true },
      { approved: true, by: "Sam" },
    ];
    const approve = vi.fn<Approver>(async () => answers.shift() ?? { approved: false });
    const memos = new Map<string, unknown>();
    const gate = beforeTool({ approvals, approve });
    const waiting = await gate(call("book_appointment", {}), hookApi(memos), context);
    expect(waiting?.block).toBe(
      "book_appointment was not run: it needs a person's approval (Bookings after 18:00), and the " +
        "request is with a person who has not answered yet. Nothing has been approved or declined. " +
        "Say the request is waiting for a person's answer, and do not retry this call.",
    );
    expect([...memos.values()]).not.toContainEqual(expect.objectContaining({ approved: false }));
    // The same call, recovered after the person answers, is asked again and runs on their yes.
    expect(await gate(call("book_appointment", {}), hookApi(memos), context)).toBeUndefined();
    expect(approve).toHaveBeenCalledTimes(2);
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

describe("approval facts read before the gate asks", () => {
  const BOOKING = { summary: "Book room 4 at 19:00 for Sam", facts: { room: 4, start: "19:00" } };
  const reader = () => vi.fn<ApprovalFactsReader>(async () => BOOKING);

  it("asks with facts the reader returned", async () => {
    const approve = vi.fn<Approver>(async () => ({ approved: true }));
    const read = reader();
    const gate = beforeTool({ approvals, approve, facts: { book_after_hours: read } });
    await gate(call("book_appointment", { bookingId: "B-1" }), hookApi(), context);
    // The reader is told whose call it is, so a role can scope what it reads to the call's sender.
    expect(read).toHaveBeenCalledWith({ bookingId: "B-1" }, context, {
      conversationId: "conversation-1",
      taskId: "task-1",
    });
    expect(approve.mock.calls[0]?.[0]).toMatchObject({
      arguments: { bookingId: "B-1" },
      facts: BOOKING,
    });
  });

  it("injects the memoised facts on approval", async () => {
    const memos = new Map<string, unknown>();
    const gate = beforeTool({
      approvals,
      approve: async () => ({ approved: true }),
      facts: { book_after_hours: reader() },
    });
    const result = await gate(
      call("book_appointment", { bookingId: "B-1" }),
      hookApi(memos),
      context,
    );
    expect(result).toEqual({
      arguments: { bookingId: "B-1", [APPROVED_FACTS_ARG]: BOOKING.facts },
    });
    expect(memos.get("officehum.approval-facts.call-1.book_after_hours")).toEqual(BOOKING);
    expect(approvedFacts(result?.arguments ?? {})).toEqual(BOOKING.facts);
  });

  it("overwrites a model-supplied approved-facts argument", async () => {
    const approve = vi.fn<Approver>(async () => ({ approved: true }));
    const read = reader();
    const gate = beforeTool({ approvals, approve, facts: { book_after_hours: read } });
    const forged = { bookingId: "B-1", [APPROVED_FACTS_ARG]: { room: 1, start: "09:00" } };
    const result = await gate(call("book_appointment", forged), hookApi(), context);
    expect(result?.arguments?.[APPROVED_FACTS_ARG]).toEqual(BOOKING.facts);
    // Neither the reader nor the person deciding sees the forged key.
    expect(read.mock.calls[0]?.[0]).toEqual({ bookingId: "B-1" });
    expect(approve.mock.calls[0]?.[0].arguments).toEqual({ bookingId: "B-1" });
  });

  it("strips a model-supplied approved-facts argument when no approval injects facts", async () => {
    const gate = beforeTool({ approvals, facts: { book_after_hours: reader() } });
    const result = await gate(
      call("check_schedule", { day: "Monday", [APPROVED_FACTS_ARG]: { room: 1 } }),
      hookApi(),
      context,
    );
    expect(result).toEqual({ arguments: { day: "Monday" } });
  });

  it("blocks without asking when the reader throws", async () => {
    const approve = vi.fn<Approver>(async () => ({ approved: true }));
    const memos = new Map<string, unknown>();
    const gate = beforeTool({
      approvals,
      approve,
      facts: {
        book_after_hours: async () => {
          throw new Error("No booking B-9 is on the calendar. Nothing was booked.");
        },
      },
    });
    const result = await gate(
      call("book_appointment", { bookingId: "B-9" }),
      hookApi(memos),
      context,
    );
    expect(result).toEqual({ block: "No booking B-9 is on the calendar. Nothing was booked." });
    expect(approve).not.toHaveBeenCalled();
    expect(memos.has("officehum.approval-facts.call-1.book_after_hours")).toBe(false);
  });

  it("with no approver blocks and never reads facts", async () => {
    const read = reader();
    const gate = beforeTool({ approvals, facts: { book_after_hours: read } });
    const result = await gate(call("book_appointment", { bookingId: "B-1" }), hookApi(), context);
    expect(result?.block).toContain("no approver is configured");
    expect(read).not.toHaveBeenCalled();
  });

  it("a restart after the ask reuses the memoised facts", async () => {
    const memos = new Map<string, unknown>();
    const read = reader();
    const approve = vi.fn<Approver>(async () => ({ approved: true }));
    const gate = beforeTool({ approvals, approve, facts: { book_after_hours: read } });
    const first = await gate(
      call("book_appointment", { bookingId: "B-1" }),
      hookApi(memos),
      context,
    );
    // The tool task is recovered: the hook runs again for the same call, over the same memos, with a
    // reader that would now return something else.
    read.mockResolvedValue({ summary: "changed", facts: { room: 9 } });
    const again = await gate(
      call("book_appointment", { bookingId: "B-1" }),
      hookApi(memos),
      context,
    );
    expect(again).toEqual(first);
    expect(read).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledOnce();
  });

  it("a crash mid-ask asks again with the first facts and never rereads them", async () => {
    const memos = new Map<string, unknown>();
    const read = reader();
    const asked: ApprovalRequest[] = [];
    let crash = true;
    const approve = vi.fn<Approver>(async (request) => {
      asked.push(request);
      // The process dies while the person is deciding: the facts are memoised, no decision is.
      if (crash) throw new Error("process crashed mid-ask");
      return { approved: true };
    });
    const gate = beforeTool({ approvals, approve, facts: { book_after_hours: read } });
    await expect(
      gate(call("book_appointment", { bookingId: "B-1" }), hookApi(memos), context),
    ).rejects.toThrow("process crashed mid-ask");
    expect(memos.has("officehum.approval-facts.call-1.book_after_hours")).toBe(true);
    expect(memos.has("officehum.approval.call-1.book_after_hours")).toBe(false);

    crash = false;
    read.mockResolvedValue({ summary: "changed", facts: { room: 9 } });
    const again = await gate(
      call("book_appointment", { bookingId: "B-1" }),
      hookApi(memos),
      context,
    );
    expect(read).toHaveBeenCalledOnce();
    expect(asked.map((request) => request.facts)).toEqual([BOOKING, BOOKING]);
    expect(approvedFacts(again?.arguments ?? {})).toEqual(BOOKING.facts);
  });

  it("does not read facts for a call the approval does not apply to", async () => {
    const read = reader();
    const gate = beforeTool({
      approvals,
      approve: async () => ({ approved: true }),
      when: { book_after_hours: () => false },
      facts: { book_after_hours: read },
    });
    const result = await gate(call("book_appointment", { bookingId: "B-1" }), hookApi(), context);
    expect(result).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("compares approved facts by content, not key order", () => {
    expect(sameFacts({ a: 1, b: [{ x: 1, y: 2 }] }, { b: [{ y: 2, x: 1 }], a: 1 })).toBe(true);
    expect(sameFacts({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameFacts({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("reads approved facts only from a plain object under the reserved key", () => {
    expect(approvedFacts({ [APPROVED_FACTS_ARG]: { a: 1 } })).toEqual({ a: 1 });
    expect(approvedFacts({})).toBeUndefined();
    expect(approvedFacts({ [APPROVED_FACTS_ARG]: "yes" })).toBeUndefined();
    expect(approvedFacts({ [APPROVED_FACTS_ARG]: [1] })).toBeUndefined();
    expect(approvedFacts({ [APPROVED_FACTS_ARG]: null })).toBeUndefined();
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

  it("treats an absent optional argument as not applicable only when a condition says so", () => {
    const when = [
      { arg: "discountPercent", op: "present" as const },
      { arg: "discountPercent", op: "gt" as const, value: { limit: "rate" } },
    ];
    const limits = { rate: 10 };
    // Absent means no discount, so nothing waits: the case a bare comparison used to gate every call.
    expect(conditionsHold(when, {}, limits)).toBe(false);
    expect(conditionsHold(when, { discountPercent: null }, limits)).toBe(false);
    expect(conditionsHold(when, { discountPercent: 5 }, limits)).toBe(false);
    expect(conditionsHold(when, { discountPercent: 15 }, limits)).toBe(true);
    // A named limit that does not resolve still waits for a person.
    expect(conditionsHold(when, { discountPercent: 15 }, {})).toBe(true);
    // Without the presence operator, absence still fails safe: a malformed call cannot skip a gate by
    // leaving a field out.
    expect(conditionsHold([when[1] as NonNullable<(typeof when)[1]>], {}, limits)).toBe(true);
    // `absent` is the mirror, and takes no value either.
    expect(conditionsHold([{ arg: "x", op: "absent" }], {}, {})).toBe(true);
    expect(conditionsHold([{ arg: "x", op: "absent" }], { x: 1 }, {})).toBe(false);
  });
});

/**
 * The sum: an array of objects, one numeric field of each, and a threshold. Nothing here knows what
 * the array is — the invoice it is used for lives in the Bookkeeper's manifest.
 */
describe("a condition that sums a field over an array argument", () => {
  const LIMIT = { large_invoice: 2500 };

  /** The rule the Bookkeeper declares: each line's price times its quantity, over the limit. */
  const invoiceWhen: ConditionDeclaration[] = [
    {
      arg: "lines",
      op: "gt",
      field: "unitPriceCents",
      times: "quantity",
      value: { limit: "large_invoice" },
    },
  ];

  const line = (quantity: number, unitPriceCents: number) => ({
    description: "Work",
    quantity,
    unitPriceCents,
  });

  const holds = (lines: unknown, limits: Readonly<Record<string, number>> = LIMIT) =>
    conditionsHold(invoiceWhen, { lines }, limits);

  it("compares the total: exactly at the limit it does not hold, one cent over it does", () => {
    // 10 × 250 = 2,500: exactly the limit, and `gt` is strict, so the call runs.
    expect(holds([line(10, 250)])).toBe(false);
    expect(holds([line(10, 250), line(1, 1)])).toBe(true);
    // The sum spans the lines, not one of them: 3 × 500 + 1 × 1,000 = 2,500.
    expect(holds([line(3, 500), line(1, 1000)])).toBe(false);
    expect(holds([line(3, 500), line(1, 1001)])).toBe(true);
    // A limit that does not resolve still asks for a person.
    expect(holds([line(1, 1)], {})).toBe(true);
  });

  it("rounds each line's price times its quantity, then adds", () => {
    // 1.5 hours at 3.33 is 4.995, which the billing system totals as 5.00; two such lines are 10.00.
    const term = line(1.5, 333);
    expect(holds([term], { large_invoice: 500 })).toBe(false);
    expect(holds([term, term], { large_invoice: 1000 })).toBe(false);
    expect(holds([term, term], { large_invoice: 999 })).toBe(true);
  });

  it("fails closed on an element it cannot read instead of skipping it", () => {
    // The documented rule: a missing or non-numeric field refuses the whole total, so the condition
    // holds and a person is asked. Skipping the element would total the rest and report less than the
    // call's own numbers — the one direction that lets a large call through a limit.
    expect(holds([line(1, 100), { quantity: 1 }])).toBe(true);
    expect(holds([line(1, 100), { quantity: 1, unitPriceCents: "4400" }])).toBe(true);
    expect(holds([line(1, 100), { unitPriceCents: 4400 }])).toBe(true);
    expect(holds([line(1, 100), { quantity: 0, unitPriceCents: 4400 }])).toBe(true);
    expect(holds([line(1, 100), { quantity: 1, unitPriceCents: -4400 }])).toBe(true);
    // A total that nothing can be summed from is not a total of zero.
    expect(holds([])).toBe(true);
    expect(holds("nothing")).toBe(true);
    expect(holds([line(1, 100), null])).toBe(true);
    expect(conditionsHold(invoiceWhen, {}, LIMIT)).toBe(true);
  });

  it("is generic: one field, a literal threshold, and every numeric comparison", () => {
    const when = (op: "gt" | "gte" | "lt" | "lte", amount: number): ConditionDeclaration[] => [
      { arg: "items", op, field: "amountCents", value: amount },
    ];
    const draft = { items: [{ amountCents: 60 }, { amountCents: 40 }] };
    expect(conditionsHold(when("gt", 100), draft)).toBe(false);
    expect(conditionsHold(when("gte", 100), draft)).toBe(true);
    expect(conditionsHold(when("lt", 101), draft)).toBe(true);
    expect(conditionsHold(when("lte", 99), draft)).toBe(false);
  });
});

describe("named approval limits", () => {
  const invoiceApprovals = [
    {
      id: "large_invoice",
      tool: "create_invoice",
      description: "Invoices over the set amount",
      when: [{ arg: "amount", op: "gt" as const, value: { limit: "large_invoice" } }],
    },
  ];

  it("gates at the manifest's default, and at the overlay's value when a business sets one", async () => {
    const atDefault = beforeTool({ approvals: invoiceApprovals, limits: { large_invoice: 5000 } });
    expect(
      await atDefault(call("create_invoice", { amount: 4000 }), hookApi(), context),
    ).toBeUndefined();
    expect(
      (await atDefault(call("create_invoice", { amount: 6000 }), hookApi(), context))?.block,
    ).toContain("Invoices over the set amount");

    const tightened = beforeTool({ approvals: invoiceApprovals, limits: { large_invoice: 2500 } });
    expect(
      await tightened(call("create_invoice", { amount: 2000 }), hookApi(), context),
    ).toBeUndefined();
    expect(
      (await tightened(call("create_invoice", { amount: 3000 }), hookApi(), context))?.block,
    ).toContain("Invoices over the set amount");
  });

  it("fails safe when a named limit does not resolve, rather than letting the call through", async () => {
    const gate = beforeTool({ approvals: invoiceApprovals, limits: {} });
    expect(
      (await gate(call("create_invoice", { amount: 100 }), hookApi(), context))?.block,
    ).toBeDefined();
  });

  it("gives a code condition the resolved limits in its environment", async () => {
    let seen: Readonly<Record<string, number>> | undefined;
    const gate = beforeTool({
      approvals: invoiceApprovals,
      limits: { large_invoice: 2500 },
      when: {
        large_invoice: (args, environment) => {
          seen = environment.limits;
          return Number(args.amount) > (environment.limits.large_invoice ?? 0);
        },
      },
    });
    expect(
      await gate(call("create_invoice", { amount: 1000 }), hookApi(), context),
    ).toBeUndefined();
    expect(
      (await gate(call("create_invoice", { amount: 4000 }), hookApi(), context))?.block,
    ).toBeDefined();
    expect(seen).toEqual({ large_invoice: 2500 });
  });

  it("lets an async condition read durable records and decide either way", async () => {
    const Known = defineDoc<{ known: boolean }>({
      kind: "test.first-contact",
      version: 1,
      scope: "session",
      initial: () => ({ known: false }),
    });
    const approve = vi.fn<Approver>(async () => ({ approved: true }));
    const gate = beforeTool({
      approvals: invoiceApprovals,
      approve,
      when: {
        large_invoice: async (_args, { read }, predicateContext) =>
          !((await read.snapshot(Known, predicateContext))?.known ?? false),
      },
    });
    // A target the role has met before needs no person; a first contact does.
    await gate(
      call("create_invoice", { amount: 1 }),
      hookApi(new Map(), new Map([["test.first-contact", { known: true }]])),
      context,
    );
    expect(approve).not.toHaveBeenCalled();
    await gate(
      call("create_invoice", { amount: 1 }, "call-2"),
      hookApi(new Map(), new Map([["test.first-contact", { known: false }]])),
      context,
    );
    expect(approve).toHaveBeenCalledOnce();
  });

  it("gates the call when a condition throws, never letting it through", async () => {
    const approve = vi.fn<Approver>(async () => ({ approved: true }));
    const gate = beforeTool({
      approvals: invoiceApprovals,
      approve,
      when: {
        large_invoice: () => {
          throw new Error("cannot decide");
        },
      },
    });
    await gate(call("create_invoice", { amount: 1 }), hookApi(), context);
    expect(approve).toHaveBeenCalledOnce();
  });
});

describe("the Sample Stockroom's named limits", () => {
  const adjust = (quantity: number, id = "call-1") =>
    call("stock_adjust", { sku: "BOLT-10", quantity, reason: "count" }, id);

  it("gates at the manifest's default, and at a business overlay's value", async () => {
    const role = sampleStockroom({ engine: stubEngine({}) });
    expect(role.current().limits).toEqual({ large_increase: 10, large_decrease: -10 });
    const gate = gateFrom(role);
    expect(await gate(adjust(10), hookApi(), context)).toBeUndefined();
    expect((await gate(adjust(11, "call-2"), hookApi(), context))?.block).toContain(
      "Adding more units",
    );

    const overlaid = sampleStockroom({ engine: stubEngine({}), overlays: [STOCKROOM_OVERLAY] });
    expect(overlaid.current().limits).toEqual({ large_increase: 5, large_decrease: -10 });
    const tightened = gateFrom(overlaid);
    expect(await tightened(adjust(5), hookApi(), context)).toBeUndefined();
    expect((await tightened(adjust(6, "call-3"), hookApi(), context))?.block).toContain(
      "Adding more units",
    );
  });
});

describe("defineRole's approval facts", () => {
  it("passes its readers to the role's gate and exposes them on the bundle", async () => {
    const facts = { summary: "Add 11 BOLT-10", facts: { sku: "BOLT-10", quantity: 11 } };
    const read = vi.fn<ApprovalFactsReader>(async () => facts);
    const approve = vi.fn<Approver>(async () => ({ approved: true }));
    const role = defineRole({
      packageDir: stockroomDir,
      manifest: stockroomManifest,
      engine: stubEngine({}),
      approve,
      approvalFacts: { large_increase: read },
    });
    expect(role.approvalFacts).toEqual({ large_increase: read });
    const result = await gateFrom(role)(
      call("stock_adjust", { sku: "BOLT-10", quantity: 11, reason: "count" }),
      hookApi(),
      context,
    );
    expect(approve.mock.calls[0]?.[0].facts).toEqual(facts);
    expect(approvedFacts(result?.arguments ?? {})).toEqual(facts.facts);
  });
});
