/**
 * The office's approval gate (RASF-3138).
 *
 * These drive the hook the way Pi Durable does — the call, the hook api, and the answer the harness
 * acts on — rather than through a model, because the claim is about what the gate decides and what it
 * writes, not about whether a scripted model reads a refusal.
 *
 * Each test fails for the right reason: the uncovered one fails if no row is written *or* if two are;
 * the covered one fails if a decision about $500 admits $50,000; the ungated one fails if the gate
 * starts charging every conversation in the harness an approval; the last fails if an unreadable board
 * is treated as permission.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HookApi, ToolHooks } from "@earendil-works/pi-durable";
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

type BeforeTool = ToolHooks["beforeTool"];

function gateOf(board: Board, gatedTools: readonly string[] = [REFUND]): BeforeTool {
  const registration = approvalHooks({ board, gatedTools })[0];
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
