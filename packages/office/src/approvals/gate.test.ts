/**
 * The office's approval gate (RASF-3138), and its condition-aware gating (RASF-3439).
 *
 * These drive the hook the way Pi Durable does — the call, the hook api, and the answer the harness
 * acts on — rather than through a model, because the claim is about what the gate decides and what it
 * writes, not about whether a scripted model reads a refusal.
 *
 * Each test fails for the right reason: the uncovered one fails if no row is written *or* if two are;
 * the covered one fails if a decision about $500 admits $50,000; the ungated one fails if the gate
 * starts charging every conversation in the harness an approval; the failing one fails if an unreadable
 * board is treated as permission. The conditional cases fail the other way: a gate that ignored `when`
 * — the bug RASF-3439 fixes — refuses the small invoice that should have run, and a gate that never
 * gated would let the large one through with no row.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HookApi, ToolHooks } from "@earendil-works/pi-durable";
import type { ApprovalDeclaration } from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { argsHash, type Board } from "../board/index.js";
import { createWorkboard, seedPerson } from "../board/testing.js";
import { approvalAskedText, approvalHooks, approvalUncheckedText } from "./gate.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const PERSON = { id: "maria", name: "Maria Okonkwo" };
const PROVENANCE = { origin: "internal", sourceChannel: "chat", sourceContact: "desk" } as const;
const REFUND = "issue_refund";
/** The conversation the relay bound to the ticket; the hook sees only this number. */
const CONVERSATION = 7;

/**
 * The gate's default declaration: no `when`, so it applies to every call of its tool. That is the
 * unchanged meaning of declaring an approval without a condition, and it is what the older cases in
 * this file exercise.
 */
const REFUND_DECLARATION: ApprovalDeclaration = {
  id: "confirm_refund",
  tool: REFUND,
  description: "Confirm this refund",
};

const INVOICE = "create_invoice";
const INVOICE_LIMIT = 2500;
/** `total` strictly above the business's `large_invoice` limit needs a person. */
const LARGE_INVOICE: ApprovalDeclaration = {
  id: "large_invoice",
  tool: INVOICE,
  description: "Confirm an invoice whose lines come to more than the business's set amount",
  when: [{ arg: "total", op: "gt", value: { limit: "large_invoice" } }],
};
const INVOICE_LIMITS = { large_invoice: INVOICE_LIMIT } as const;

const REMINDER = "send_reminder";
/** Only a final notice needs a person; the declarations are the role's own statement of that. */
const FINAL_NOTICE: ApprovalDeclaration = {
  id: "final_notice",
  tool: REMINDER,
  description: "Confirm a final notice to a customer",
  when: [{ arg: "tone", op: "eq", value: "final" }],
};

const BOOKING = "book_appointment";
const BOOKING_DISCOUNT_LIMIT = 10;
/**
 * Present *and* above the limit: an absent `discountPercent` is not a reason to ask a person, which is
 * what the `present` condition is for — a comparison on a missing argument fails safe and would gate
 * every undiscounted booking.
 */
const DISCOUNT_BOOKING: ApprovalDeclaration = {
  id: "discount_booking",
  tool: BOOKING,
  description: "Confirm a discounted booking above the business's set rate",
  when: [
    { arg: "discountPercent", op: "present" },
    { arg: "discountPercent", op: "gt", value: { limit: "booking_discount_percent" } },
  ],
};
const BOOKING_LIMITS = { booking_discount_percent: BOOKING_DISCOUNT_LIMIT } as const;
/** The unconditional declaration frontdesk puts on the same tool, written before the conditional one. */
const CONFIRM_BOOKING: ApprovalDeclaration = {
  id: "confirm_booking",
  tool: BOOKING,
  description: "Confirm this appointment booking",
};

type BeforeTool = ToolHooks["beforeTool"];

function gateOf(
  board: Board,
  declarations: readonly ApprovalDeclaration[] = [REFUND_DECLARATION],
  limits: Readonly<Record<string, number>> = {},
): BeforeTool {
  const registration = approvalHooks({ board, declarations, limits })[0];
  if (registration === undefined) throw new Error("approvalHooks registered nothing.");
  const { handlers } = registration as unknown as { handlers: Pick<ToolHooks, "beforeTool"> };
  return handlers.beforeTool;
}

/** A stand-in for the tool task's hook api: the gate reads the conversation id and nothing else. */
function hookApi(conversationId: number = CONVERSATION): HookApi {
  return { taskId: "task-1", conversationId } as unknown as HookApi;
}

/** A model-issued tool call, in the shape the hook receives it. */
function call(
  name: string,
  args: Record<string, unknown>,
  id = "call-1",
): Parameters<BeforeTool>[0] {
  return { type: "toolCall", id, name, arguments: args } as Parameters<BeforeTool>[0];
}

const CONTEXT = {} as Parameters<BeforeTool>[2];

interface Fixture {
  readonly file: string;
  readonly board: Board;
  readonly ticketId: string;
  close(): void;
}

function openFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "officehum-approval-gate-"));
  temps.push(directory);
  const file = join(directory, "office.sqlite");
  seedPerson(file, PERSON.id, PERSON.name);
  const board = createWorkboard(file);
  const ticket = board.create(
    {
      type: "refund.request",
      title: "Refund the deposit",
      detail: "Charged twice.",
      createdBy: "front-desk",
      provenance: PROVENANCE,
    },
    "refund-key",
  );
  board.bindConversation(CONVERSATION, { ticketId: ticket.id, agent: "bookkeeper" });
  return { file, board, ticketId: ticket.id, close: () => board.close() };
}

function rows(file: string): number {
  const database = new DatabaseSync(file);
  try {
    const row = database.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number };
    return row.n;
  } finally {
    database.close();
  }
}

/** The writing side of an approval, so a test can say yes to what the gate asked. */
function approveOnly(board: Board): void {
  const approval = board.approvals.pendingApprovals()[0];
  expect(approval).toBeDefined();
  board.approvals.decideApproval(String(approval?.id), {
    by: PERSON.id,
    decision: "approved",
    note: "Checked the invoice.",
  });
}

describe("the approval gate", () => {
  it("blocks an uncovered call, asks once, and names the person who was asked", async () => {
    const fixture = openFixture();
    try {
      const beforeTool = gateOf(fixture.board);
      const refund = { amount: 500, to: "acme" };

      const first = await beforeTool(call(REFUND, refund), hookApi(), CONTEXT);
      expect(first?.block).toBe(approvalAskedText(REFUND, { id: PERSON.id, name: PERSON.name }));
      expect(first?.block).toContain(PERSON.name);
      expect(first?.block).toContain("has been asked");
      expect(first?.block).toContain("Do not retry this call");

      // The model retries the same call, as a model does. It is still blocked, and the inbox still has
      // one row: the ask is idempotent while it waits.
      const second = await beforeTool(call(REFUND, refund, "call-2"), hookApi(), CONTEXT);
      expect(second?.block).toBe(first?.block);
      expect(rows(fixture.file)).toBe(1);

      const pending = fixture.board.approvals.pendingApprovals();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        ticketId: fixture.ticketId,
        // The declaration, not the tool: a row says which stated policy it is about (RASF-3439).
        approvalId: REFUND_DECLARATION.id,
        tool: REFUND,
        args: refund,
        requestedBy: "bookkeeper",
        assignee: PERSON.id,
      });
    } finally {
      fixture.close();
    }
  });

  it("allows the call a person approved, and only that call", async () => {
    const fixture = openFixture();
    try {
      const beforeTool = gateOf(fixture.board);
      const refund = { amount: 500, to: "acme" };

      const blocked = await beforeTool(call(REFUND, refund), hookApi(), CONTEXT);
      expect(blocked?.block).toBeDefined();
      const approval = fixture.board.approvals.pendingApprovals()[0];
      expect(approval).toBeDefined();
      fixture.board.approvals.decideApproval(String(approval?.id), {
        by: PERSON.id,
        decision: "approved",
        note: "A deposit, not a fee.",
      });

      // The same call, with its keys in another order, is covered: the decision was about this call.
      expect(
        await beforeTool(call(REFUND, { to: "acme", amount: 500 }, "call-2"), hookApi(), CONTEXT),
      ).toBeUndefined();
      // Ten times the money is not the call anybody approved.
      const bigger = await beforeTool(
        call(REFUND, { amount: 50_000, to: "acme" }),
        hookApi(),
        CONTEXT,
      );
      expect(bigger).toMatchObject({ block: expect.stringContaining(PERSON.name) });
      expect(rows(fixture.file)).toBe(2);
      expect(
        fixture.board.approvals.approvalCovering(
          fixture.ticketId,
          REFUND,
          argsHash({ amount: 50_000, to: "acme" }),
        ),
      ).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it("leaves an ungated tool and a conversation with no ticket alone", async () => {
    const fixture = openFixture();
    try {
      const beforeTool = gateOf(fixture.board);

      // Declared safe: no approval, no row.
      expect(
        await beforeTool(call("read_ledger", { month: "October" }), hookApi(), CONTEXT),
      ).toBeUndefined();
      // A conversation the relay never bound to a ticket is ticket work of nobody's.
      expect(await beforeTool(call(REFUND, { amount: 500 }), hookApi(99), CONTEXT)).toBeUndefined();
      expect(rows(fixture.file)).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("does not ask again for a call a person already declined", async () => {
    const fixture = openFixture();
    try {
      const beforeTool = gateOf(fixture.board);
      const refund = { amount: 500, to: "acme" };
      await beforeTool(call(REFUND, refund), hookApi(), CONTEXT);
      const approval = fixture.board.approvals.pendingApprovals()[0];
      expect(approval).toBeDefined();
      fixture.board.approvals.decideApproval(String(approval?.id), {
        by: PERSON.id,
        decision: "declined",
        note: "Ask the customer for the receipt first.",
      });

      // The person said no to these exact arguments. A retry is blocked with their answer, and no new
      // request is written: the inbox does not fill up one row per turn with a question already answered.
      const again = await beforeTool(call(REFUND, refund, "call-2"), hookApi(), CONTEXT);
      expect(again).toMatchObject({
        block: expect.stringContaining("declined these exact arguments"),
      });
      expect(again?.block).toContain("Ask the customer for the receipt first.");
      expect(rows(fixture.file)).toBe(1);
      expect(fixture.board.approvals.pendingApprovals()).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("fails closed when the board cannot answer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-approval-gate-"));
    temps.push(directory);
    const file = join(directory, "office.sqlite");
    const board = createWorkboard(file);
    const beforeTool = gateOf(board);
    board.close();

    // A gate that treated an unreadable record as permission would approve every call the moment the
    // disk was busy; the model is told the check failed and that the call did not run.
    const result = await beforeTool(call(REFUND, { amount: 500 }), hookApi(), CONTEXT);
    expect(result?.block).toBe(approvalUncheckedText(REFUND));
    expect(result?.block).toContain("could not check");
  });
});

describe("a declaration's condition", () => {
  it("lets an invoice below the limit run, and writes nothing", async () => {
    const fixture = openFixture();
    try {
      const beforeTool = gateOf(fixture.board, [LARGE_INVOICE], INVOICE_LIMITS);
      const invoice = { total: INVOICE_LIMIT - 1, customer: "acme" };

      // The role declares that only a large invoice waits for a person. A gate that ignored `when`
      // refused this call, which is the bug: production demanded a person for every invoice.
      expect(await beforeTool(call(INVOICE, invoice), hookApi(), CONTEXT)).toBeUndefined();
      expect(rows(fixture.file)).toBe(0);
      expect(fixture.board.approvals.pendingApprovals()).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("asks about an invoice over the limit, records the declared id, and runs it once approved", async () => {
    const fixture = openFixture();
    try {
      const beforeTool = gateOf(fixture.board, [LARGE_INVOICE], INVOICE_LIMITS);
      const invoice = { total: INVOICE_LIMIT + 1, customer: "acme" };

      const blocked = await beforeTool(call(INVOICE, invoice), hookApi(), CONTEXT);
      expect(blocked?.block).toBe(approvalAskedText(INVOICE, { id: PERSON.id, name: PERSON.name }));
      expect(rows(fixture.file)).toBe(1);
      const pending = fixture.board.approvals.pendingApprovals();
      expect(pending).toHaveLength(1);
      // `large_invoice`, not `create_invoice`: the row names the declaration a person is answering.
      expect(pending[0]?.approvalId).toBe("large_invoice");
      expect(pending[0]?.tool).toBe(INVOICE);

      approveOnly(fixture.board);
      expect(
        await beforeTool(call(INVOICE, invoice, "call-2"), hookApi(), CONTEXT),
      ).toBeUndefined();
      expect(rows(fixture.file)).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it("treats the limit itself as allowed, because the declaration says `gt`", async () => {
    const fixture = openFixture();
    try {
      const beforeTool = gateOf(fixture.board, [LARGE_INVOICE], INVOICE_LIMITS);

      // Exactly at the limit is not above it: `gt` decides the boundary, and the gate must not invent
      // a stricter one.
      expect(
        await beforeTool(call(INVOICE, { total: INVOICE_LIMIT }), hookApi(), CONTEXT),
      ).toBeUndefined();
      expect(rows(fixture.file)).toBe(0);

      const over = await beforeTool(
        call(INVOICE, { total: INVOICE_LIMIT + 1 }, "call-2"),
        hookApi(),
        CONTEXT,
      );
      expect(over?.block).toBeDefined();
      expect(rows(fixture.file)).toBe(1);
      expect(fixture.board.approvals.pendingApprovals()[0]?.approvalId).toBe("large_invoice");
    } finally {
      fixture.close();
    }
  });

  it("gates a final notice and lets a firm reminder through", async () => {
    const fixture = openFixture();
    try {
      const beforeTool = gateOf(fixture.board, [FINAL_NOTICE]);

      expect(
        await beforeTool(call(REMINDER, { tone: "firm", customer: "acme" }), hookApi(), CONTEXT),
      ).toBeUndefined();
      expect(rows(fixture.file)).toBe(0);

      const final = await beforeTool(
        call(REMINDER, { tone: "final", customer: "acme" }, "call-2"),
        hookApi(),
        CONTEXT,
      );
      expect(final?.block).toBeDefined();
      expect(rows(fixture.file)).toBe(1);
      expect(fixture.board.approvals.pendingApprovals()[0]?.approvalId).toBe("final_notice");
    } finally {
      fixture.close();
    }
  });

  it("gates a discounted booking only when the discount is present and above the limit", async () => {
    const fixture = openFixture();
    try {
      const beforeTool = gateOf(fixture.board, [DISCOUNT_BOOKING], BOOKING_LIMITS);
      const slot = { customer: "acme", startsAt: "2026-11-02T09:00:00Z" };

      // No discount at all: the condition is about an optional argument, so absence means it does not
      // apply rather than "cannot be compared, so ask".
      expect(await beforeTool(call(BOOKING, slot, "call-1"), hookApi(), CONTEXT)).toBeUndefined();
      // At the limit is not above it.
      expect(
        await beforeTool(
          call(BOOKING, { ...slot, discountPercent: BOOKING_DISCOUNT_LIMIT }, "call-2"),
          hookApi(),
          CONTEXT,
        ),
      ).toBeUndefined();
      // Below it, likewise.
      expect(
        await beforeTool(
          call(BOOKING, { ...slot, discountPercent: BOOKING_DISCOUNT_LIMIT - 5 }, "call-3"),
          hookApi(),
          CONTEXT,
        ),
      ).toBeUndefined();
      expect(rows(fixture.file)).toBe(0);

      const discounted = await beforeTool(
        call(BOOKING, { ...slot, discountPercent: BOOKING_DISCOUNT_LIMIT + 1 }, "call-4"),
        hookApi(),
        CONTEXT,
      );
      expect(discounted?.block).toBeDefined();
      expect(rows(fixture.file)).toBe(1);
      expect(fixture.board.approvals.pendingApprovals()[0]?.approvalId).toBe("discount_booking");
    } finally {
      fixture.close();
    }
  });

  it("records the first declaration that applies when a tool carries two", async () => {
    const fixture = openFixture();
    try {
      const both = gateOf(fixture.board, [CONFIRM_BOOKING, DISCOUNT_BOOKING], BOOKING_LIMITS);
      const slot = { customer: "acme", startsAt: "2026-11-02T09:00:00Z" };

      // Both apply to a 20% booking. The manifest's order decides, so the row names `confirm_booking`
      // — the declaration the author wrote first — on every run.
      expect(
        (await both(call(BOOKING, { ...slot, discountPercent: 20 }), hookApi(), CONTEXT))?.block,
      ).toBeDefined();
      expect(fixture.board.approvals.pendingApprovals()[0]?.approvalId).toBe("confirm_booking");

      // Reverse the manifest's order and the other declaration is the one that answers these
      // arguments, which is what makes the first test about order rather than about specificity.
      const reversed = gateOf(fixture.board, [DISCOUNT_BOOKING, CONFIRM_BOOKING], BOOKING_LIMITS);
      expect(
        (
          await reversed(
            call(BOOKING, { ...slot, discountPercent: 25 }, "call-2"),
            hookApi(),
            CONTEXT,
          )
        )?.block,
      ).toBeDefined();
      const quarter = fixture.board.approvals
        .pendingApprovals()
        .find((approval) => (approval.args as { discountPercent?: number }).discountPercent === 25);
      expect(quarter?.approvalId).toBe("discount_booking");
    } finally {
      fixture.close();
    }
  });
});
