/**
 * The approvals store (RASF-3138).
 *
 * These are the tests a reviewer should try to break, and each one is written to fail for the right
 * reason if the property it names is lost:
 *
 * - **The arguments are the approval.** Achieving a $500 refund must not authorise a $50,000 one, and
 *   the test fails on `approvalCovering` returning a row rather than on a string comparison somewhere
 *   else. The canonicalisation tests below are what make that binding independent of how the model
 *   happened to order its JSON.
 * - **A decision is made once.** The first decision and its note survive a second attempt, and the
 *   refusal is the store's own, not a uniqueness error leaking out of SQLite.
 * - **One ask is one row.** A retry while waiting returns the row that exists; counting is done against
 *   the file, not against the returned array.
 * - **Waiting ends on its own.** Expiry is read-time, so the test checks both the reported status and
 *   that the row written to disk is untouched — the store is not quietly rewriting a request to expire
 *   it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { argsHash, type Board, BoardError, canonicalArgs, openBoard } from "./index.js";
import { seedPerson } from "./testing.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const PROVENANCE = {
  origin: "external",
  sourceChannel: "email",
  sourceContact: "customer",
} as const;
const REFUND = "issue_refund";
const PERSON = { id: "maria", name: "Maria Okonkwo" };

interface Fixture {
  readonly file: string;
  readonly board: Board;
  readonly ticketId: string;
  close(): void;
}

/** One board, one person and one ticket with detail — the smallest office an approval needs. */
function openFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "officehum-approvals-"));
  temps.push(directory);
  const file = join(directory, "office.sqlite");
  seedPerson(file, PERSON.id, PERSON.name);
  const board = openBoard(file);
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
  return { file, board, ticketId: ticket.id, close: () => board.close() };
}

/** A second handle on the same file: how these tests count rows the API does not expose. */
function withRaw<T>(file: string, work: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(file);
  try {
    return work(database);
  } finally {
    database.close();
  }
}

function rows(file: string): number {
  return withRaw(file, (database) => {
    const row = database.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number };
    return row.n;
  });
}

/** The refusal a call made, so a test can assert both its kind and what it said. */
function refusalOf(work: () => unknown): BoardError {
  try {
    work();
  } catch (error) {
    if (error instanceof BoardError) return error;
    throw error;
  }
  throw new Error("expected a BoardError, but the call returned");
}

describe("the approvals store", () => {
  it("binds a decision to the exact arguments: $500 does not admit $50,000", () => {
    const fixture = openFixture();
    try {
      const { approvals } = fixture.board;
      const approved = approvals.requestApproval(fixture.ticketId, {
        tool: REFUND,
        args: { amount: 500, currency: "USD", to: "acme" },
        requestedBy: "bookkeeper",
        assignee: PERSON.id,
      });
      approvals.decideApproval(approved.id, {
        by: PERSON.id,
        decision: "approved",
        note: "A deposit, not a fee.",
      });

      const covered = (amount: number, currency = "USD") =>
        approvals.approvalCovering(
          fixture.ticketId,
          REFUND,
          argsHash({ amount, currency, to: "acme" }),
        );

      expect(covered(500)?.id).toBe(approved.id);
      // The whole point: the person approved five hundred dollars, not the tool.
      expect(covered(50_000)).toBeUndefined();
      expect(covered(500, "EUR")).toBeUndefined();
      // And the approval is for this tool, not for every tool called with these arguments.
      expect(
        approvals.approvalCovering(
          fixture.ticketId,
          "issue_credit",
          argsHash({ amount: 500, currency: "USD", to: "acme" }),
        ),
      ).toBeUndefined();
      // Nor does it cover another ticket's identical call.
      const other = fixture.board.create(
        {
          type: "refund.request",
          title: "Second refund",
          createdBy: "front-desk",
          provenance: PROVENANCE,
        },
        "refund-key-2",
      );
      expect(
        approvals.approvalCovering(
          other.id,
          REFUND,
          argsHash({ amount: 500, currency: "USD", to: "acme" }),
        ),
      ).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it("canonicalises args so key order cannot change the hash, and a changed value does", () => {
    const left = { amount: 500, to: { name: "acme", reference: "INV-1" }, tags: ["a", "b"] };
    const right = { tags: ["a", "b"], to: { reference: "INV-1", name: "acme" }, amount: 500 };

    expect(canonicalArgs(left)).toBe(canonicalArgs(right));
    expect(argsHash(left)).toBe(argsHash(right));
    // Nested order is part of the same rule, and the text says why: keys sorted at every level.
    expect(canonicalArgs(left)).toBe(
      '{"amount":500,"tags":["a","b"],"to":{"name":"acme","reference":"INV-1"}}',
    );

    // A changed value is a different approval, at the top level and nested.
    expect(argsHash({ ...left, amount: 501 })).not.toBe(argsHash(left));
    expect(
      argsHash({ ...left, to: { name: "acme", reference: "INV-2" }, tags: ["a", "b"] }),
    ).not.toBe(argsHash(left));
    // Arrays are ordered meaning, not a set: reversing one is a different request.
    expect(argsHash({ tags: ["b", "a"] })).not.toBe(argsHash({ tags: ["a", "b"] }));
  });

  it("refuses arguments that JSON would quietly coerce into another value", () => {
    // Each of these would collapse to a value nobody wrote: NaN to null, a Date to {}, a dropped key.
    expect(() => canonicalArgs({ amount: Number.NaN })).toThrow(/finite numbers/);
    expect(() => canonicalArgs({ at: new Date(0) })).toThrow(/plain objects/);
    expect(() => canonicalArgs({ amount: undefined })).toThrow(/undefined/);
    expect(() => canonicalArgs({ amount: 10n })).toThrow(/must be JSON/);
  });

  it("refuses a second decision and keeps the first, note included", () => {
    const fixture = openFixture();
    try {
      const { approvals } = fixture.board;
      const approval = approvals.requestApproval(fixture.ticketId, {
        tool: REFUND,
        args: { amount: 500 },
        requestedBy: "bookkeeper",
      });
      const first = approvals.decideApproval(approval.id, {
        by: PERSON.id,
        decision: "approved",
        note: "Checked against the double charge.",
      });

      const refused = refusalOf(() =>
        approvals.decideApproval(approval.id, {
          by: "someone-else",
          decision: "declined",
          note: "Changed my mind.",
        }),
      );
      expect(refused.kind).toBe("immutable");
      expect(refused.message).toContain("already approved");
      expect(refused.message).toContain(PERSON.id);
      expect(refused.message).toContain("the first one stands");

      const after = approvals.approvalOf(approval.id);
      expect(after).toMatchObject({
        status: "approved",
        decidedBy: PERSON.id,
        decidedAt: first.decidedAt,
        decidedNote: "Checked against the double charge.",
      });
      // The file, not just the return value: one decision, and it is the first one.
      const stored = withRaw(fixture.file, (database) =>
        database
          .prepare("SELECT status, decided_by, decided_note FROM approvals WHERE id = ?")
          .get(approval.id),
      );
      expect(stored).toEqual({
        status: "approved",
        decided_by: PERSON.id,
        decided_note: "Checked against the double charge.",
      });
    } finally {
      fixture.close();
    }
  });

  it("returns the existing row when the same call is requested again while waiting", () => {
    const fixture = openFixture();
    try {
      const { approvals } = fixture.board;
      const request = {
        tool: REFUND,
        args: { amount: 500, to: "acme" },
        requestedBy: "bookkeeper",
      };
      const first = approvals.requestApproval(fixture.ticketId, request);
      // The same request with its keys in another order is the same request.
      const again = approvals.requestApproval(fixture.ticketId, {
        tool: REFUND,
        args: { to: "acme", amount: 500 },
        requestedBy: "bookkeeper",
      });

      expect(again.id).toBe(first.id);
      expect(rows(fixture.file)).toBe(1);
      expect(approvals.pendingApprovals()).toHaveLength(1);
      // The lookup the gate uses to read a settled answer finds the waiting row, not a second one.
      expect(
        approvals.latestForCall(fixture.ticketId, REFUND, argsHash({ amount: 500, to: "acme" }))
          ?.id,
      ).toBe(first.id);

      // A different amount is a different request, and the inbox shows both.
      approvals.requestApproval(fixture.ticketId, { ...request, args: { amount: 50_000 } });
      expect(rows(fixture.file)).toBe(2);
      expect(approvals.pendingApprovals({ ticketId: fixture.ticketId })).toHaveLength(2);
    } finally {
      fixture.close();
    }
  });

  it("reports a request past its deadline as expired, and refuses to decide it", () => {
    const fixture = openFixture();
    try {
      const { approvals } = fixture.board;
      const approval = approvals.requestApproval(fixture.ticketId, {
        tool: REFUND,
        args: { amount: 500 },
        requestedBy: "bookkeeper",
        ttlMs: 60_000,
      });
      expect(approvals.approvalOf(approval.id)?.status).toBe("waiting");
      expect(approvals.pendingApprovals()).toHaveLength(1);

      const lapsed = approvals.requestApproval(fixture.ticketId, {
        tool: REFUND,
        args: { amount: 900 },
        requestedBy: "bookkeeper",
        ttlMs: 0,
      });
      expect(lapsed.status).toBe("expired");
      expect(lapsed.expiresAt).not.toBeNull();
      // Not pending, and the row on disk still says what was written: expiry is read, not sweeped.
      expect(approvals.pendingApprovals().map((row) => row.id)).toEqual([approval.id]);
      expect(
        withRaw(fixture.file, (database) =>
          database.prepare("SELECT status FROM approvals WHERE id = ?").get(lapsed.id),
        ),
      ).toEqual({ status: "waiting" });

      const refused = refusalOf(() =>
        approvals.decideApproval(lapsed.id, { by: PERSON.id, decision: "approved" }),
      );
      expect(refused.kind).toBe("invalid_status");
      expect(refused.message).toContain("expired");
      expect(
        approvals.approvalCovering(fixture.ticketId, REFUND, argsHash({ amount: 900 })),
      ).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it("lets an expired request be asked again, closing the old ask as expired", () => {
    const fixture = openFixture();
    try {
      const { approvals } = fixture.board;
      const request = { tool: REFUND, args: { amount: 500 }, requestedBy: "bookkeeper" };
      const lapsed = approvals.requestApproval(fixture.ticketId, { ...request, ttlMs: 0 });
      const fresh = approvals.requestApproval(fixture.ticketId, request);

      // The unique waiting index would refuse the second row; the store closes the first ask instead of
      // making the retry fail, and the first ask stays on the record with the reason it ended.
      expect(fresh.id).not.toBe(lapsed.id);
      expect(approvals.approvalOf(lapsed.id)).toMatchObject({
        status: "expired",
        decidedBy: null,
      });
      expect(approvals.pendingApprovals().map((row) => row.id)).toEqual([fresh.id]);
      expect(rows(fixture.file)).toBe(2);
    } finally {
      fixture.close();
    }
  });

  it("cancels a ticket's waiting approvals and leaves decided ones alone", () => {
    const fixture = openFixture();
    try {
      const { approvals } = fixture.board;
      const decided = approvals.requestApproval(fixture.ticketId, {
        tool: REFUND,
        args: { amount: 500 },
        requestedBy: "bookkeeper",
      });
      approvals.decideApproval(decided.id, { by: PERSON.id, decision: "declined" });
      const waiting = approvals.requestApproval(fixture.ticketId, {
        tool: REFUND,
        args: { amount: 900 },
        requestedBy: "bookkeeper",
      });

      // The ticket must be claimable before it can be cancelled, and only the assignee or a person may.
      fixture.board.claim(fixture.ticketId, "bookkeeper");
      fixture.board.cancel(fixture.ticketId, PERSON.id);

      expect(approvals.approvalOf(waiting.id)).toMatchObject({
        status: "cancelled",
        decidedBy: PERSON.id,
      });
      expect(approvals.pendingApprovals()).toEqual([]);
      // A person's answer is a fact even when the work it was about was called off.
      expect(approvals.approvalOf(decided.id)?.status).toBe("declined");
    } finally {
      fixture.close();
    }
  });

  it("keeps a decision across a reopen, and covers the call the decision was about", () => {
    const fixture = openFixture();
    const approval = fixture.board.approvals.requestApproval(fixture.ticketId, {
      tool: REFUND,
      args: { amount: 500, to: "acme" },
      requestedBy: "bookkeeper",
      assignee: PERSON.id,
    });
    fixture.board.approvals.decideApproval(approval.id, {
      by: PERSON.id,
      decision: "approved",
    });
    fixture.close();

    const reopened = openBoard(fixture.file);
    try {
      expect(reopened.approvals.approvalOf(approval.id)).toMatchObject({
        status: "approved",
        decidedBy: PERSON.id,
        requestedBy: "bookkeeper",
        assignee: PERSON.id,
      });
      expect(
        reopened.approvals.approvalCovering(
          fixture.ticketId,
          REFUND,
          argsHash({ amount: 500, to: "acme" }),
        )?.id,
      ).toBe(approval.id);
    } finally {
      reopened.close();
    }
  });

  it("refuses a request for a ticket or a person the office does not know", () => {
    const fixture = openFixture();
    try {
      const { approvals } = fixture.board;
      expect(
        refusalOf(() =>
          approvals.requestApproval("no-such-ticket", {
            tool: REFUND,
            args: {},
            requestedBy: "bookkeeper",
          }),
        ).kind,
      ).toBe("not_found");
      expect(
        refusalOf(() =>
          approvals.requestApproval(fixture.ticketId, {
            tool: REFUND,
            args: {},
            requestedBy: "bookkeeper",
            assignee: "nobody",
          }),
        ).kind,
      ).toBe("invalid_person");
      expect(
        refusalOf(() =>
          approvals.decideApproval("no-such-approval", { by: PERSON.id, decision: "approved" }),
        ).kind,
      ).toBe("not_found");
      expect(approvals.latestForCall(fixture.ticketId, REFUND, "0".repeat(64))).toBeUndefined();
      expect(rows(fixture.file)).toBe(0);
    } finally {
      fixture.close();
    }
  });
});
