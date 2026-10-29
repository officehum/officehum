/**
 * The Inbox, over a real board (RASF-3138).
 *
 * The store's own tests prove the state machine; these prove the read model a screen gets: the ticket
 * a request belongs to, where the work came from, which agent is waiting and for how long, and the
 * exact arguments a person is being asked about. The clock is injected so "how long" is an assertion
 * rather than a tolerance.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Board } from "../board/index.js";
import { createWorkboard, seedPerson } from "../board/testing.js";
import { openApprovalInbox } from "./inbox.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const PERSON = { id: "maria", name: "Maria Okonkwo" };
const PROVENANCE = {
  origin: "external",
  sourceChannel: "email",
  sourceContact: "customer",
} as const;

interface Fixture {
  readonly board: Board;
  readonly ticketId: string;
  close(): void;
}

function openFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "officehum-inbox-"));
  temps.push(directory);
  const file = join(directory, "office.sqlite");
  seedPerson(file, PERSON.id, PERSON.name);
  const board = createWorkboard(file);
  const ticket = board.create(
    {
      type: "refund.request",
      title: "Refund the deposit",
      detail: "The customer was charged twice for the deposit.",
      createdBy: "front-desk",
      provenance: PROVENANCE,
    },
    "refund-key",
  );
  return { board, ticketId: ticket.id, close: () => board.close() };
}

describe("the approvals inbox", () => {
  it("lists a waiting request with the ticket context a person needs", () => {
    const fixture = openFixture();
    try {
      const inbox = openApprovalInbox(fixture.board);
      const approval = fixture.board.approvals.requestApproval(fixture.ticketId, {
        tool: "issue_refund",
        args: { amount: 500, to: "acme" },
        requestedBy: "bookkeeper",
        assignee: PERSON.id,
      });

      const [item] = inbox.list();
      expect(item).toMatchObject({
        id: approval.id,
        ticketId: fixture.ticketId,
        ticketType: "refund.request",
        ticketTitle: "Refund the deposit",
        origin: "external",
        sourceChannel: "email",
        tool: "issue_refund",
        args: { amount: 500, to: "acme" },
        requestedBy: "bookkeeper",
        awaiting: { id: PERSON.id, name: PERSON.name },
        status: "waiting",
        expiresAt: null,
      });
      expect(item?.argsHash).toBe(approval.argsHash);
    } finally {
      fixture.close();
    }
  });

  it("says how long the request has waited, measured by the clock it is given", () => {
    const fixture = openFixture();
    try {
      const approval = fixture.board.approvals.requestApproval(fixture.ticketId, {
        tool: "issue_refund",
        args: { amount: 500 },
        requestedBy: "bookkeeper",
      });
      const createdAt = Date.parse(approval.createdAt);
      const later = openApprovalInbox(fixture.board, { now: () => createdAt + 90_000 });

      expect(later.list()[0]?.waitingForMs).toBe(90_000);
      // A clock behind the row cannot make the wait negative.
      const earlier = openApprovalInbox(fixture.board, { now: () => createdAt - 5_000 });
      expect(earlier.list()[0]?.waitingForMs).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("opens one request with the ticket's own summary and the exact arguments", () => {
    const fixture = openFixture();
    try {
      const inbox = openApprovalInbox(fixture.board);
      const approval = fixture.board.approvals.requestApproval(fixture.ticketId, {
        tool: "issue_refund",
        args: { amount: 500, to: "acme", meta: { invoice: "INV-1" } },
        requestedBy: "bookkeeper",
      });

      const detail = inbox.get(approval.id);
      expect(detail).toMatchObject({
        summary: "The customer was charged twice for the deposit.",
        args: { amount: 500, to: "acme", meta: { invoice: "INV-1" } },
        decidedBy: null,
        decidedAt: null,
        decidedNote: null,
      });
      // A ticket nobody wrote a detail for summarises as its title, not as an empty string.
      const second = fixture.board.create(
        {
          type: "refund.request",
          title: "Second refund",
          createdBy: "front-desk",
          provenance: PROVENANCE,
        },
        "refund-key-2",
      );
      const bare = fixture.board.approvals.requestApproval(second.id, {
        tool: "issue_refund",
        args: { amount: 10 },
        requestedBy: "bookkeeper",
      });
      expect(inbox.get(bare.id)?.summary).toBe("Second refund");
      expect(inbox.get("no-such-approval")).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it("filters the list by ticket and by tool, and drops requests past their deadline", () => {
    const fixture = openFixture();
    try {
      const inbox = openApprovalInbox(fixture.board);
      const other = fixture.board.create(
        {
          type: "invoice.create",
          title: "Invoice 42",
          createdBy: "front-desk",
          provenance: PROVENANCE,
        },
        "invoice-key",
      );
      fixture.board.approvals.requestApproval(fixture.ticketId, {
        tool: "issue_refund",
        args: { amount: 500 },
        requestedBy: "bookkeeper",
      });
      fixture.board.approvals.requestApproval(fixture.ticketId, {
        tool: "send_email",
        args: { to: "acme" },
        requestedBy: "bookkeeper",
      });
      fixture.board.approvals.requestApproval(other.id, {
        tool: "issue_refund",
        args: { amount: 7 },
        requestedBy: "bookkeeper",
      });
      fixture.board.approvals.requestApproval(fixture.ticketId, {
        tool: "issue_refund",
        args: { amount: 1 },
        requestedBy: "bookkeeper",
        ttlMs: 0,
      });

      expect(inbox.list()).toHaveLength(3);
      expect(inbox.list({ ticketId: fixture.ticketId }).map((item) => item.tool)).toEqual([
        "issue_refund",
        "send_email",
      ]);
      expect(inbox.list({ tool: "issue_refund" }).map((item) => item.ticketId)).toEqual([
        fixture.ticketId,
        other.id,
      ]);
      expect(inbox.list({ ticketId: other.id })).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it("decides a request and returns it as it now stands, refusing a second decision", () => {
    const fixture = openFixture();
    try {
      const inbox = openApprovalInbox(fixture.board);
      const approval = fixture.board.approvals.requestApproval(fixture.ticketId, {
        tool: "issue_refund",
        args: { amount: 500 },
        requestedBy: "bookkeeper",
        assignee: PERSON.id,
      });

      const decided = inbox.decide(approval.id, {
        by: PERSON.id,
        decision: "declined",
        note: "Ask the customer for the receipt first.",
      });
      expect(decided).toMatchObject({
        status: "declined",
        decidedBy: PERSON.id,
        decidedNote: "Ask the customer for the receipt first.",
      });
      expect(decided.decidedAt).not.toBeNull();
      // The inbox is empty once a person has answered, and the decision is still readable.
      expect(inbox.list()).toEqual([]);
      expect(inbox.get(approval.id)?.status).toBe("declined");

      // A stale screen that decides again is refused; the store owns that rule, and the Inbox does not
      // soften it into a last-write-wins update.
      expect(() => inbox.decide(approval.id, { by: PERSON.id, decision: "approved" })).toThrow(
        /already declined/,
      );
    } finally {
      fixture.close();
    }
  });
});
