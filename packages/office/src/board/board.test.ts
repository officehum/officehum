/**
 * Workboard contract tests (RASF-3066).
 *
 * The board's rules are the thing under test, so these exercise the API the way the relay and the
 * agent tools will: real SQLite files under a temporary directory, a reopened file where persistence
 * is the point, and `:memory:` only where there is nothing to persist.
 *
 * A second `DatabaseSync` handle appears in two roles, and both are deliberate. Seeding: `people` has
 * no API in this issue (RASF-3073 owns approvals and the inbox), yet the board must recognise a person,
 * so tests insert one. Capacity: `used_tokens` is written by usage accounting (RASF-3074), so a
 * remaining-budget assertion seeds the spend directly — the arithmetic is what is under test, not the
 * charging. Fault injection: a test-installed trigger is how a mid-transaction failure is produced
 * honestly, which is what proves the rollback.
 *
 * No network, no model, no harness.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Board,
  BoardError,
  type BoardErrorKind,
  type NewTicket,
  openBoard,
  type Ticket,
  type TicketEvent,
} from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function boardFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "officehum-board-"));
  temps.push(directory);
  return join(directory, "board.sqlite");
}

/** The board owns its file; a second handle is how a test seeds rows the API does not write yet. */
function withRaw<T>(file: string, work: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(file);
  try {
    return work(database);
  } finally {
    database.close();
  }
}

function count(file: string, table: string): number {
  const row = withRaw(file, (database) =>
    database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(),
  ) as { n: number };
  return row.n;
}

function seedPerson(file: string, id: string): void {
  withRaw(file, (database) => {
    database.prepare("INSERT INTO people (id, name) VALUES (?, ?)").run(id, id);
  });
}

type Budget = {
  max_tokens: number | null;
  max_usd_cents: number | null;
  used_tokens: number;
  used_usd_cents: number;
  hop_count: number;
  max_hops: number;
  used_calls: number;
  max_calls: number | null;
};

function budgetOf(file: string, ticketId: string): Budget {
  const row = withRaw(file, (database) =>
    database
      .prepare(
        `SELECT max_tokens, max_usd_cents, used_tokens, used_usd_cents, hop_count, max_hops,
                used_calls, max_calls
           FROM budgets WHERE ticket_id = ?`,
      )
      .get(ticketId),
  );
  if (row === undefined) throw new Error(`No budget row for ${ticketId}.`);
  return row as Budget;
}

function provenanceOf(file: string, ticketId: string): unknown {
  return withRaw(file, (database) =>
    database
      .prepare("SELECT origin, source_channel, source_contact FROM provenance WHERE ticket_id = ?")
      .get(ticketId),
  );
}

function spend(file: string, ticketId: string, tokens: number, cents = 0): void {
  withRaw(file, (database) => {
    database
      .prepare("UPDATE budgets SET used_tokens = ?, used_usd_cents = ? WHERE ticket_id = ?")
      .run(tokens, cents, ticketId);
  });
}

function pick<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Expected a value at ${index}.`);
  return value;
}

function thrown(fn: () => unknown): BoardError {
  try {
    fn();
  } catch (error) {
    if (error instanceof BoardError) return error;
    throw error;
  }
  throw new Error("Expected the board call to fail.");
}

function kindOf(fn: () => unknown): BoardErrorKind {
  return thrown(fn).kind;
}

const INTERNAL = {
  origin: "internal",
  sourceChannel: "test",
  sourceContact: "front-desk",
} as const;

let keyCounter = 0;
function nextKey(label: string): string {
  keyCounter += 1;
  return `${label}-${keyCounter}`;
}

function root(board: Board, input: Partial<NewTicket> = {}): Ticket {
  return board.create(
    {
      type: "invoice.create",
      title: "Invoice",
      createdBy: "front-desk",
      provenance: INTERNAL,
      ...input,
    },
    nextKey("root"),
  );
}

function child(board: Board, parent: Ticket, input: Partial<NewTicket> = {}): Ticket {
  return board.create(
    {
      type: "invoice.create",
      title: "Child work",
      createdBy: parent.createdBy,
      parentId: parent.id,
      provenance: INTERNAL,
      ...input,
    },
    nextKey("child"),
  );
}

/** A root plus `length - 1` delegations: hops 0 … length - 1. */
function chain(board: Board, length: number): Ticket[] {
  const tickets: Ticket[] = [];
  let current: Ticket | undefined;
  for (let index = 0; index < length; index += 1) {
    current = current === undefined ? root(board) : child(board, current);
    tickets.push(current);
  }
  return tickets;
}

function lastEvent(board: Board, ticketId: string): TicketEvent | undefined {
  const events = board.events(ticketId);
  return events[events.length - 1];
}

describe("workboard", () => {
  it("create appends exactly one created event in the same transaction", () => {
    const file = boardFile();
    const board = openBoard(file);
    const ticket = board.create(
      {
        type: "invoice.create",
        title: "Invoice",
        createdBy: "front-desk",
        provenance: INTERNAL,
        payload: { amount: 10 },
      },
      "create-key",
    );

    const events = board.events(ticket.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "created",
      actor: "front-desk",
      seq: 1,
      ticketId: ticket.id,
      payload: {},
    });
    expect(ticket).toMatchObject({ status: "open", assignee: null, payload: { amount: 10 } });
    // The ticket, its event, its provenance and its key landed in one transaction or not at all.
    expect(count(file, "tickets")).toBe(1);
    expect(count(file, "ticket_events")).toBe(1);
    expect(count(file, "ticket_keys")).toBe(1);
    expect(count(file, "provenance")).toBe(1);
    board.close();
  });

  it("claim/comment/complete/cancel/assign append exactly one event, right kind+actor", () => {
    const file = boardFile();
    const board = openBoard(file);
    seedPerson(file, "owner");
    const ticket = root(board);
    expect(board.events(ticket.id)).toHaveLength(1);

    board.claim(ticket.id, "agent-a");
    expect(board.events(ticket.id)).toHaveLength(2);
    expect(lastEvent(board, ticket.id)).toMatchObject({ kind: "claimed", actor: "agent-a" });

    board.comment(ticket.id, "agent-a", "Working on it.");
    expect(board.events(ticket.id)).toHaveLength(3);
    expect(lastEvent(board, ticket.id)).toMatchObject({
      kind: "commented",
      actor: "agent-a",
      payload: { commentId: expect.any(String) },
    });
    expect(count(file, "comments")).toBe(1);

    board.complete(ticket.id, "agent-a");
    expect(board.events(ticket.id)).toHaveLength(4);
    expect(lastEvent(board, ticket.id)).toMatchObject({ kind: "completed", actor: "agent-a" });

    const second = root(board);
    board.assign(second.id, { kind: "agent", id: "agent-b" }, "owner");
    expect(board.events(second.id)).toHaveLength(2);
    expect(lastEvent(board, second.id)).toMatchObject({
      kind: "assigned",
      actor: "owner",
      payload: { assignee: { kind: "agent", id: "agent-b" } },
    });

    board.cancel(second.id, "agent-b");
    expect(board.events(second.id)).toHaveLength(3);
    expect(lastEvent(board, second.id)).toMatchObject({ kind: "cancelled", actor: "agent-b" });

    // Nothing was rewritten on the way: each ticket's history is in its own order. `seq` is the
    // board's cursor, not the ticket's — the relay keeps one number across the whole board, so a
    // second ticket's history continues where the first left off.
    const firstHistory = board.events(ticket.id).map((event) => event.seq);
    const secondHistory = board.events(second.id).map((event) => event.seq);
    expect([...firstHistory, ...secondHistory]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(count(file, "ticket_events")).toBe(7);
    board.close();
  });

  it("ticket_events refuses UPDATE and DELETE (trigger), unchanged after reopen", () => {
    const file = boardFile();
    const board = openBoard(file);
    const ticket = root(board);
    board.comment(ticket.id, "front-desk", "First");
    board.close();

    withRaw(file, (database) => {
      expect(() =>
        database
          .prepare("UPDATE ticket_events SET kind = 'rewritten' WHERE ticket_id = ?")
          .run(ticket.id),
      ).toThrow(/append-only/);
      expect(() =>
        database.prepare("DELETE FROM ticket_events WHERE ticket_id = ?").run(ticket.id),
      ).toThrow(/append-only/);
      expect(() =>
        database
          .prepare("UPDATE comments SET body = 'rewritten' WHERE ticket_id = ?")
          .run(ticket.id),
      ).toThrow(/append-only/);
      expect(() =>
        database.prepare("DELETE FROM comments WHERE ticket_id = ?").run(ticket.id),
      ).toThrow(/append-only/);
    });

    const reopened = openBoard(file);
    expect(reopened.events(ticket.id).map((event) => event.kind)).toEqual(["created", "commented"]);
    expect(count(file, "comments")).toBe(1);
    reopened.close();
  });

  it("failed create leaves no orphan ticket/event (rollback)", () => {
    const file = boardFile();
    const board = openBoard(file);
    // Fault injection: a trigger that aborts the last statement of a create, after the ticket, its
    // budget and its event are already written. A failed call must leave none of them behind.
    withRaw(file, (database) => {
      database.exec(`
        CREATE TRIGGER board_test_abort BEFORE INSERT ON ticket_keys BEGIN
          SELECT RAISE(ABORT, 'ticket_keys is append-only: injected fault');
        END;
      `);
    });

    const fault = thrown(() => root(board));
    expect(fault.kind).toBe("immutable");
    expect(count(file, "tickets")).toBe(0);
    expect(count(file, "ticket_events")).toBe(0);
    expect(count(file, "ticket_keys")).toBe(0);
    expect(count(file, "budgets")).toBe(0);
    expect(count(file, "provenance")).toBe(0);

    withRaw(file, (database) => {
      database.exec("DROP TRIGGER board_test_abort");
    });
    const recovered = root(board);
    expect(count(file, "tickets")).toBe(1);
    expect(board.events(recovered.id)).toHaveLength(1);
    board.close();
  });

  it("child copies parent provenance", () => {
    const file = boardFile();
    const board = openBoard(file);
    const parent = board.create(
      {
        type: "booking.request",
        title: "Booking",
        createdBy: "front-desk",
        provenance: {
          origin: "external",
          sourceChannel: "email",
          sourceContact: "guest@example.com",
        },
      },
      nextKey("parent"),
    );
    // The caller's own provenance on a child is ignored: lineage is a fact about the work, not a
    // choice the delegatee gets to make.
    const inherited = child(board, parent, {
      provenance: {
        origin: "internal",
        sourceChannel: "agent",
        sourceContact: "agent-a",
      },
    });

    expect(provenanceOf(file, inherited.id)).toEqual({
      origin: "external",
      source_channel: "email",
      source_contact: "guest@example.com",
    });
    expect(provenanceOf(file, inherited.id)).toEqual(provenanceOf(file, parent.id));
    board.close();
  });

  it("child inherits remaining budget (max 1000, used 300 → child max 700)", () => {
    const file = boardFile();
    const board = openBoard(file);
    const parent = root(board, { budget: { maxTokens: 1000, maxUsdCents: 500 } });
    spend(file, parent.id, 300, 50);

    const ticket = child(board, parent);
    expect(budgetOf(file, ticket.id)).toMatchObject({
      max_tokens: 700,
      max_usd_cents: 450,
      used_tokens: 0,
      used_usd_cents: 0,
      hop_count: 1,
    });
    board.close();
  });

  it("child narrows but never widens (min)", () => {
    const file = boardFile();
    const board = openBoard(file);
    const parent = root(board, { budget: { maxTokens: 1000, maxUsdCents: 500 } });

    const greedy = child(board, parent, { budget: { maxTokens: 2000, maxUsdCents: 900 } });
    expect(budgetOf(file, greedy.id)).toMatchObject({ max_tokens: 1000, max_usd_cents: 500 });

    const thrifty = child(board, parent, { budget: { maxTokens: 100, maxUsdCents: 10 } });
    expect(budgetOf(file, thrifty.id)).toMatchObject({ max_tokens: 100, max_usd_cents: 10 });

    // NULL is uncapped: it narrows to whatever the other side says, in either direction.
    const uncapped = root(board);
    expect(budgetOf(file, uncapped.id)).toMatchObject({ max_tokens: null, max_usd_cents: null });
    const capped = child(board, uncapped, { budget: { maxTokens: 50 } });
    expect(budgetOf(file, capped.id)).toMatchObject({ max_tokens: 50, max_usd_cents: null });
    board.close();
  });

  it("grandchild composes remaining through a child parent", () => {
    const file = boardFile();
    const board = openBoard(file);
    const parent = root(board, { budget: { maxTokens: 1000 } });
    spend(file, parent.id, 300);

    const middle = child(board, parent);
    expect(budgetOf(file, middle.id).max_tokens).toBe(700);
    spend(file, middle.id, 200);

    // 700 − 200, not 1000 − 200: the middle ticket's ceiling is already its narrowed one, so the
    // subtraction composes without walking the chain.
    const grandchild = child(board, middle);
    expect(budgetOf(file, grandchild.id)).toMatchObject({ max_tokens: 500, hop_count: 2 });
    board.close();
  });

  it("hop_count increments 0→1→2", () => {
    const file = boardFile();
    const board = openBoard(file);
    const tickets = chain(board, 3);

    expect(budgetOf(file, pick(tickets, 0).id).hop_count).toBe(0);
    expect(budgetOf(file, pick(tickets, 1).id).hop_count).toBe(1);
    expect(budgetOf(file, pick(tickets, 2).id).hop_count).toBe(2);
    board.close();
  });

  it("max_hops defaults to 4", () => {
    const file = boardFile();
    const board = openBoard(file);
    // Five links is four delegations, and the default still allows every one of them.
    const tickets = chain(board, 5);

    expect(budgetOf(file, pick(tickets, 0).id)).toMatchObject({ hop_count: 0, max_hops: 4 });
    expect(budgetOf(file, pick(tickets, 4).id)).toMatchObject({ hop_count: 4, max_hops: 4 });
    board.close();
  });

  it("hop exhausted requires a person (throws max_hops without one; succeeds with one, status waiting)", () => {
    const file = boardFile();
    const board = openBoard(file);
    seedPerson(file, "owner");
    const tickets = chain(board, 5);
    const top = pick(tickets, 4);

    expect(kindOf(() => child(board, top))).toBe("max_hops");
    expect(kindOf(() => child(board, top, { assignee: { kind: "agent", id: "agent-a" } }))).toBe(
      "max_hops",
    );
    // Both refusals rolled back, so the board still holds exactly the five links.
    expect(count(file, "tickets")).toBe(5);
    expect(count(file, "ticket_events")).toBe(5);

    const handed = child(board, top, { assignee: { kind: "person", id: "owner" } });
    expect(handed).toMatchObject({ status: "waiting", assignee: "owner" });
    expect(budgetOf(file, handed.id)).toMatchObject({ hop_count: 5, max_hops: 4 });
    expect(lastEvent(board, handed.id)).toMatchObject({ kind: "created", actor: "front-desk" });
    board.close();
  });

  it("hop_count == max is allowed, == max+1 refused", () => {
    const file = boardFile();
    const board = openBoard(file);
    const parent = root(board, { budget: { maxHops: 1 } });

    const allowed = child(board, parent, { assignee: { kind: "agent", id: "agent-a" } });
    expect(budgetOf(file, allowed.id)).toMatchObject({ hop_count: 1, max_hops: 1 });
    expect(kindOf(() => child(board, allowed))).toBe("max_hops");
    board.close();
  });

  it("only assignee or a person completes (assignee ok, person ok, other agent unauthorized, unassigned only by person)", () => {
    const file = boardFile();
    const board = openBoard(file);
    seedPerson(file, "owner");

    const byAssignee = root(board);
    board.claim(byAssignee.id, "agent-a");
    expect(board.complete(byAssignee.id, "agent-a").status).toBe("done");

    const byPerson = root(board);
    board.claim(byPerson.id, "agent-b");
    expect(board.complete(byPerson.id, "owner").status).toBe("done");

    const byStranger = root(board);
    board.claim(byStranger.id, "agent-c");
    expect(kindOf(() => board.complete(byStranger.id, "agent-d"))).toBe("unauthorized");
    expect(board.get(byStranger.id)?.status).toBe("claimed");

    // An unassigned ticket is nobody's to close but a person's; `complete` refuses it outright
    // because it was never claimed, and `cancel` shows the same authorization rule underneath.
    const unassigned = root(board);
    expect(kindOf(() => board.complete(unassigned.id, "agent-a"))).toBe("invalid_status");
    expect(kindOf(() => board.cancel(unassigned.id, "agent-a"))).toBe("unauthorized");
    expect(board.cancel(unassigned.id, "owner").status).toBe("cancelled");
    board.close();
  });

  it("assign moves an agent ticket to claimed and a person ticket to waiting", () => {
    const file = boardFile();
    const board = openBoard(file);
    seedPerson(file, "owner");

    const agentTicket = root(board);
    expect(
      board.assign(agentTicket.id, { kind: "agent", id: "agent-a" }, "front-desk"),
    ).toMatchObject({ status: "claimed", assignee: "agent-a" });

    const personTicket = root(board);
    expect(
      board.assign(personTicket.id, { kind: "person", id: "owner" }, "front-desk"),
    ).toMatchObject({ status: "waiting", assignee: "owner" });

    // A person has taken over the agent's ticket: back to waiting on a human, not on the agent.
    expect(board.assign(agentTicket.id, { kind: "person", id: "owner" }, "agent-a")).toMatchObject({
      status: "waiting",
      assignee: "owner",
    });
    board.close();
  });

  it("same key returns the same ticket, one event, one row", () => {
    const file = boardFile();
    const board = openBoard(file);
    const input: NewTicket = {
      type: "invoice.create",
      title: "Invoice",
      createdBy: "front-desk",
      provenance: INTERNAL,
      payload: { amount: 10 },
    };

    const first = board.create(input, "dedupe-key");
    const second = board.create(input, "dedupe-key");
    expect(second).toEqual(first);
    expect(board.events(first.id)).toHaveLength(1);
    expect(count(file, "tickets")).toBe(1);
    expect(count(file, "ticket_keys")).toBe(1);

    // The key is normalized like the calendar's operation key, so padding is not a second request.
    expect(board.create(input, "  dedupe-key  ").id).toBe(first.id);
    board.close();
  });

  it("same key, different payload throws duplicate_key", () => {
    const file = boardFile();
    const board = openBoard(file);
    const input: NewTicket = {
      type: "invoice.create",
      title: "Invoice",
      createdBy: "front-desk",
      provenance: INTERNAL,
      payload: { amount: 10 },
    };
    const first = board.create(input, "conflict-key");

    const conflict = thrown(() =>
      board.create({ ...input, payload: { amount: 20 } }, "conflict-key"),
    );
    expect(conflict.kind).toBe("duplicate_key");
    expect(conflict.details).toEqual({ ticketId: first.id });
    expect(count(file, "tickets")).toBe(1);
    expect(board.events(first.id)).toHaveLength(1);
    board.close();
  });

  it("rejects an empty or over-long caller key", () => {
    const file = boardFile();
    const board = openBoard(file);
    const input: NewTicket = {
      type: "invoice.create",
      title: "Invoice",
      createdBy: "front-desk",
      provenance: INTERNAL,
    };

    expect(kindOf(() => board.create(input, ""))).toBe("invalid_argument");
    expect(kindOf(() => board.create(input, " ".repeat(4)))).toBe("invalid_argument");
    expect(kindOf(() => board.create(input, "x".repeat(501)))).toBe("invalid_argument");
    expect(count(file, "tickets")).toBe(0);
    expect(board.create(input, "x".repeat(500)).id).toBeDefined();
    board.close();
  });

  it("rejects a root without provenance and a bare ticket type", () => {
    const file = boardFile();
    const board = openBoard(file);
    const request = { type: "invoice.create", title: "Invoice", createdBy: "front-desk" };

    expect(
      kindOf(() =>
        board.create({ ...request, provenance: undefined } as unknown as NewTicket, "no-prov"),
      ),
    ).toBe("invalid_argument");
    // A bare type is what the manifest's `TicketType` refuses; the board refuses it too, because a
    // ticket nothing can be routed to is a lost ticket.
    expect(
      kindOf(() => board.create({ ...request, type: "triage", provenance: INTERNAL }, "bare")),
    ).toBe("invalid_argument");
    expect(count(file, "tickets")).toBe(0);
    board.close();
  });

  it("does not require a child to state its own provenance", () => {
    const file = boardFile();
    const board = openBoard(file);
    const parent = root(board);
    const request = {
      type: "invoice.create",
      title: "Child work",
      createdBy: "front-desk",
      parentId: parent.id,
    };

    const ticket = board.create(request as unknown as NewTicket, nextKey("child"));
    expect(provenanceOf(file, ticket.id)).toEqual(provenanceOf(file, parent.id));
    board.close();
  });

  it("rejects an assign to an unknown person id", () => {
    const file = boardFile();
    const board = openBoard(file);
    const ticket = root(board);

    expect(
      kindOf(() => board.assign(ticket.id, { kind: "person", id: "nobody" }, "front-desk")),
    ).toBe("invalid_person");
    expect(kindOf(() => child(board, ticket, { assignee: { kind: "person", id: "nobody" } }))).toBe(
      "invalid_person",
    );
    // The refusals changed nothing: the ticket is still open and unowned.
    expect(board.get(ticket.id)).toMatchObject({ status: "open", assignee: null });
    expect(board.events(ticket.id)).toHaveLength(1);
    board.close();
  });

  it("returns events strictly after the cursor, and an empty array past the end", () => {
    const file = boardFile();
    const board = openBoard(file);
    const ticket = root(board);
    board.comment(ticket.id, "front-desk", "One");
    board.comment(ticket.id, "front-desk", "Two");

    expect(board.events(ticket.id).map((event) => event.kind)).toEqual([
      "created",
      "commented",
      "commented",
    ]);
    expect(board.events(ticket.id, 1).map((event) => event.seq)).toEqual([2, 3]);
    expect(board.events(ticket.id, 3)).toEqual([]);
    // A cursor past the end is empty, not an error: the relay restarts and re-reads with a stale
    // cursor, and throwing there would turn a restart into a failure.
    expect(board.events(ticket.id, 9_999)).toEqual([]);

    expect(kindOf(() => board.events("no-such-ticket"))).toBe("not_found");
    expect(kindOf(() => board.events(ticket.id, -1))).toBe("invalid_argument");
    board.close();
  });

  it("orders two events in one millisecond by seq, not at", () => {
    const file = boardFile();
    const board = openBoard(file);
    const ticket = root(board);
    board.comment(ticket.id, "front-desk", "One");
    board.comment(ticket.id, "front-desk", "Two");

    const events = board.events(ticket.id);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    // `at` is written per event and two events can land in the same millisecond, so the record's order
    // is the sequence: strictly increasing, whichever way the clock went.
    for (let index = 1; index < events.length; index += 1) {
      expect(pick(events, index).seq).toBeGreaterThan(pick(events, index - 1).seq);
    }
    board.close();
  });

  it("refuses complete from open or done", () => {
    const file = boardFile();
    const board = openBoard(file);
    const open = root(board);
    expect(kindOf(() => board.complete(open.id, "agent-a"))).toBe("invalid_status");

    const done = root(board);
    board.claim(done.id, "agent-a");
    board.complete(done.id, "agent-a");
    expect(kindOf(() => board.complete(done.id, "agent-a"))).toBe("invalid_status");
    expect(kindOf(() => board.cancel(done.id, "agent-a"))).toBe("invalid_status");
    expect(board.events(done.id).map((event) => event.kind)).toEqual([
      "created",
      "claimed",
      "completed",
    ]);
    board.close();
  });

  it("allows a comment on a done ticket", () => {
    const file = boardFile();
    const board = openBoard(file);
    const ticket = root(board);
    board.claim(ticket.id, "agent-a");
    board.complete(ticket.id, "agent-a");

    const commentId = board.comment(ticket.id, "auditor", "Checked the receipt.");
    expect(commentId).toBeDefined();
    expect(board.get(ticket.id)?.status).toBe("done");
    expect(lastEvent(board, ticket.id)).toMatchObject({
      kind: "commented",
      actor: "auditor",
      payload: { commentId },
    });
    board.close();
  });

  it("filters the list by status, assignee, parent and type", () => {
    const file = boardFile();
    const board = openBoard(file);
    const parent = root(board, { type: "booking.request" });
    const claimed = child(board, parent, { type: "invoice.create" });
    board.claim(claimed.id, "agent-a");
    const open = child(board, parent, { type: "invoice.create" });

    expect(
      board
        .list({ parentId: parent.id })
        .map((ticket) => ticket.id)
        .sort(),
    ).toEqual([claimed.id, open.id].sort());
    expect(board.list({ status: "claimed" }).map((ticket) => ticket.id)).toEqual([claimed.id]);
    expect(board.list({ status: ["open", "claimed"] })).toHaveLength(3);
    expect(board.list({ status: [] })).toEqual([]);
    expect(board.list({ assignee: "agent-a" }).map((ticket) => ticket.id)).toEqual([claimed.id]);
    expect(board.list({ type: "booking.request" }).map((ticket) => ticket.id)).toEqual([parent.id]);

    expect(kindOf(() => board.list({ status: "nope" as never }))).toBe("invalid_argument");
    expect(kindOf(() => board.list({ limit: 0 }))).toBe("invalid_argument");
    board.close();
  });

  it("orders list by updated_at DESC then id ASC, and clamps the limit", () => {
    const file = boardFile();
    const board = openBoard(file);
    const tickets = [root(board), root(board), root(board)];
    for (const ticket of tickets) board.comment(ticket.id, "front-desk", "Noted.");

    // Pin every ticket to one instant in the past so the tie-break — id ASC — is what decides, not the
    // clock, and so a later comment is unambiguously newer than anything already on the board.
    withRaw(file, (database) => {
      database.prepare("UPDATE tickets SET updated_at = '2020-01-01T00:00:00.000Z'").run();
    });
    const ids = tickets.map((ticket) => ticket.id).sort();
    expect(board.list().map((ticket) => ticket.id)).toEqual(ids);

    // Activity moves a ticket to the front, which is the point of ordering by updated_at.
    board.comment(pick(ids, 1), "front-desk", "Newest.");
    expect(pick(board.list(), 0).id).toBe(pick(ids, 1));

    // Seed past the cap directly: this is a read-path test, and 501 API calls would prove nothing
    // about the clamp that the cap itself does not already prove.
    withRaw(file, (database) => {
      const insert = database.prepare(
        `INSERT INTO tickets (id, type, title, status, created_by, created_at, updated_at)
         VALUES (?, 'invoice.create', ?, 'open', 'front-desk', ?, ?)`,
      );
      const at = "2030-01-02T00:00:00.000Z";
      database.exec("BEGIN IMMEDIATE");
      try {
        for (let index = 0; index < 501; index += 1) {
          const suffix = String(index).padStart(4, "0");
          insert.run(`seed-${suffix}`, `Seeded ${suffix}`, at, at);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });

    expect(board.list()).toHaveLength(100);
    expect(board.list({ limit: 50 })).toHaveLength(50);
    // A request bigger than the cap is clamped rather than rejected.
    expect(board.list({ limit: 10_000 })).toHaveLength(500);
    board.close();
  });

  it("keeps the board file and openBoard inside this directory", () => {
    // The board file is one office's record: nothing outside this directory may open it by path or
    // grow a second writer. node:sqlite stays allowed elsewhere (the calendar is its own file).
    const boardDirectory = dirname(fileURLToPath(import.meta.url));
    const repoRoot = dirname(dirname(dirname(dirname(boardDirectory))));
    const sources: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) sources.push(path);
      }
    };
    for (const workspace of ["packages", "agents"]) walk(join(repoRoot, workspace));

    const outside = sources
      .filter((path) => !path.startsWith(`${boardDirectory}/`))
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        return text.includes("board.sqlite") || text.includes("openBoard");
      })
      .map((path) => relative(repoRoot, path));
    expect(outside).toEqual([]);
  });

  it("records the result a ticket was completed with, and null when nobody said", () => {
    const board = openBoard(boardFile());
    const provenance = INTERNAL;
    const withResult = board.create(
      { type: "job.request", title: "Paid", createdBy: "agent:desk", provenance },
      "result-1",
    );
    board.claim(withResult.id, "agent:bookkeeper");
    const completed = board.complete(withResult.id, "agent:bookkeeper", {
      result: "Invoice 42 is paid.",
    });
    expect(completed.result).toBe("Invoice 42 is paid.");
    expect(board.get(withResult.id)?.result).toBe("Invoice 42 is paid.");
    // The answer travels in the event too, so a reader of the log sees what closed the ticket.
    const closed = board.events(withResult.id).filter((event) => event.kind === "completed");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.payload).toEqual({ result: "Invoice 42 is paid." });

    const withoutResult = board.create(
      { type: "job.request", title: "Quiet", createdBy: "agent:desk", provenance },
      "result-2",
    );
    board.claim(withoutResult.id, "agent:bookkeeper");
    expect(board.complete(withoutResult.id, "agent:bookkeeper").result).toBeNull();
  });
});

/**
 * Spend accounting (RASF-3141): the charge, its dedupe, its roll-up and the reader a person uses.
 *
 * These are the arithmetic and the exactly-once story. What the *hooks* do with them — refusing a call,
 * blocking a ticket — is `spend/budget.test.ts`, over a real harness; keeping them apart means a failure
 * here is a board bug and a failure there is a wiring bug, which is the difference between a number that
 * is wrong and a number nobody is enforcing.
 */
describe("spend accounting", () => {
  it("charges a call once per call id, and rolls the deltas up to every ancestor", () => {
    const file = boardFile();
    const board = openBoard(file);
    seedPerson(file, "owner");
    const parent = root(board);
    const kid = child(board, parent);
    const grandchild = child(board, kid);

    expect(
      board.chargeUsage(grandchild.id, "call-1", { calls: 1, tokens: 100, usdCents: 3 }).charged,
    ).toBe(true);
    for (const ticket of [grandchild, kid, parent]) {
      expect(budgetOf(file, ticket.id)).toMatchObject({
        used_calls: 1,
        used_tokens: 100,
        used_usd_cents: 3,
      });
    }

    // The same call again is the same spend: a replay of one attempt, not a second charge.
    expect(
      board.chargeUsage(grandchild.id, "call-1", { calls: 1, tokens: 100, usdCents: 3 }).charged,
    ).toBe(false);
    expect(count(file, "spend_ledger")).toBe(1);
    expect(budgetOf(file, parent.id).used_calls).toBe(1);

    // A different call is different spend, and it rolls up the same way.
    board.chargeUsage(grandchild.id, "call-2", { calls: 1, tokens: 50 });
    expect(budgetOf(file, parent.id)).toMatchObject({
      used_calls: 2,
      used_tokens: 150,
      used_usd_cents: 3,
    });
    expect(count(file, "spend_ledger")).toBe(2);
    board.close();
  });

  it("a replay of one call leaves one ledger row and one increment (crash between spend and refusal)", () => {
    const file = boardFile();
    const board = openBoard(file);
    const ticket = root(board, { budget: { maxCalls: 5 } });

    // The shape of the crash: the charge landed, the process died before the refusal could be recorded,
    // and recovery re-runs the same call. Both attempts name the same call id, so the second is a no-op.
    const first = board.chargeUsage(ticket.id, "conv:task:call-9", {
      calls: 1,
      tokens: 7,
      usdCents: 1,
    });
    const second = board.chargeUsage(ticket.id, "conv:task:call-9", {
      calls: 1,
      tokens: 7,
      usdCents: 1,
    });
    expect([first.charged, second.charged]).toEqual([true, false]);
    expect(count(file, "spend_ledger")).toBe(1);
    expect(budgetOf(file, ticket.id)).toMatchObject({
      used_calls: 1,
      used_tokens: 7,
      used_usd_cents: 1,
    });
    // The ledger is the dedupe: nothing may rewrite it, so no later call can pretend the row was not there.
    withRaw(file, (database) => {
      expect(() =>
        database
          .prepare("UPDATE spend_ledger SET tokens = 0 WHERE call_id = ?")
          .run("conv:task:call-9"),
      ).toThrow(/append-only/);
    });
    board.close();
  });

  it("reports the ticket's spend and the tightest headroom up its chain", () => {
    const file = boardFile();
    const board = openBoard(file);
    const parent = root(board, { budget: { maxCalls: 4, maxTokens: 1000 } });
    const kid = child(board, parent);

    expect(board.budget(kid.id)).toMatchObject({
      maxCalls: 4,
      maxTokens: 1000,
      maxUsdCents: null,
      usedCalls: 0,
      hopCount: 1,
      remainingCalls: 4,
      remainingTokens: 1000,
      remainingUsdCents: null,
    });

    board.chargeUsage(kid.id, "call-1", { calls: 1, tokens: 100 });
    expect(board.budget(kid.id)).toMatchObject({
      usedCalls: 1,
      usedTokens: 100,
      remainingCalls: 3,
      remainingTokens: 900,
    });
    // The parent's row is subtree spend, and its headroom shrank with the child's.
    expect(board.budget(parent.id)).toMatchObject({
      usedCalls: 1,
      usedTokens: 100,
      remainingCalls: 3,
      remainingTokens: 900,
    });
    expect(board.budget("no-such-ticket")).toBeUndefined();
    board.close();
  });

  it("a sibling's spend reduces the other's headroom", () => {
    const file = boardFile();
    const board = openBoard(file);
    const parent = root(board, { budget: { maxCalls: 2 } });
    const first = child(board, parent);
    const second = child(board, parent);

    // Both children were materialized while the parent had its whole ceiling; the parent's own remainder
    // is what stops the second child from spending work the first child already did.
    expect(board.budget(first.id)?.remainingCalls).toBe(2);
    expect(board.budget(second.id)?.remainingCalls).toBe(2);
    board.admitCall(first.id, "call-1");
    expect(board.budget(second.id)?.remainingCalls).toBe(1);
    board.admitCall(second.id, "call-2");
    expect(board.budget(second.id)?.remainingCalls).toBe(0);
    // At zero the chain is spent, for both children and for the parent.
    for (const ticket of [first, second, parent]) {
      expect(board.admitCall(ticket.id, `last-${ticket.id}`).admitted).toBe(false);
    }
    expect(budgetOf(file, parent.id).used_calls).toBe(2);
    board.close();
  });

  it("admitCall refuses at the ceiling without counting the call it refused", () => {
    const file = boardFile();
    const board = openBoard(file);
    const ticket = root(board, { budget: { maxCalls: 2 } });

    expect(board.admitCall(ticket.id, "call-1")).toMatchObject({ admitted: true, charged: true });
    expect(board.admitCall(ticket.id, "call-2")).toMatchObject({ admitted: true, charged: true });
    // The third call is refused, and it does not buy a slot it never uses.
    expect(board.admitCall(ticket.id, "call-3")).toMatchObject({ admitted: false, charged: false });
    expect(budgetOf(file, ticket.id).used_calls).toBe(2);
    expect(count(file, "spend_ledger")).toBe(2);

    // A replay of a call that already ran is admitted (it did run) and not counted again.
    expect(board.admitCall(ticket.id, "call-2")).toMatchObject({ admitted: true, charged: false });
    expect(budgetOf(file, ticket.id).used_calls).toBe(2);
    board.close();
  });

  it("an uncapped ticket admits every call and reports null headroom", () => {
    const file = boardFile();
    const board = openBoard(file);
    const ticket = root(board);
    for (const callId of ["call-1", "call-2", "call-3"]) {
      expect(board.admitCall(ticket.id, callId).admitted).toBe(true);
    }
    expect(board.budget(ticket.id)).toMatchObject({
      maxCalls: null,
      remainingCalls: null,
      usedCalls: 3,
    });
    board.close();
  });

  it("block moves the ticket once, with its reason and the person it went to", () => {
    const file = boardFile();
    const board = openBoard(file);
    seedPerson(file, "owner");
    const ticket = root(board);

    const blocked = board.block(ticket.id, "budget", {
      reason: "budget reached (2 calls)",
      assignee: { kind: "person", id: "owner" },
    });
    expect(blocked).toMatchObject({ status: "blocked", assignee: "owner" });
    const blockedEvents = board.events(ticket.id).filter((event) => event.kind === "blocked");
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0]).toMatchObject({ actor: "budget" });
    expect(blockedEvents[0]?.payload).toEqual({
      reason: "budget reached (2 calls)",
      assignee: { kind: "person", id: "owner" },
    });

    // A second block is the same fact: one event, and the ticket does not move again.
    board.block(ticket.id, "budget", { reason: "budget reached (3 calls)" });
    expect(board.events(ticket.id).filter((event) => event.kind === "blocked")).toHaveLength(1);
    expect(board.get(ticket.id)).toMatchObject({ status: "blocked", assignee: "owner" });

    // A person the office does not know is refused, and a terminal ticket cannot be blocked at all.
    expect(
      kindOf(() =>
        board.block(root(board).id, "budget", {
          reason: "nobody",
          assignee: { kind: "person", id: "ghost" },
        }),
      ),
    ).toBe("invalid_person");
    const finished = root(board);
    board.claim(finished.id, "agent:bookkeeper");
    board.complete(finished.id, "agent:bookkeeper", { result: "done" });
    expect(kindOf(() => board.block(finished.id, "budget", { reason: "late" }))).toBe(
      "invalid_status",
    );
    board.close();
  });

  it("totals spend per agent per day from the ledger", () => {
    const file = boardFile();
    const board = openBoard(file);
    const ticket = root(board);
    board.chargeUsage(ticket.id, "call-1", {
      calls: 1,
      tokens: 100,
      usdCents: 2,
      agent: "bookkeeper",
    });
    board.chargeUsage(ticket.id, "call-2", {
      calls: 1,
      tokens: 50,
      usdCents: 1,
      agent: "bookkeeper",
    });
    board.chargeUsage(ticket.id, "call-3", { calls: 1, tokens: 10, agent: "frontdesk" });
    // Spend with no role behind it is a row too, and it says so rather than being dropped.
    board.chargeUsage(ticket.id, "call-4", { tokens: 5 });

    const today = new Date().toISOString().slice(0, 10);
    // Grouped by the day the ledger row was written. Two days cannot be produced here — the board writes
    // its own clock — so the day *ordering* is asserted where it is cheap: the CLI's footer, over rows.
    expect(board.spendByAgent()).toEqual([
      { day: today, agent: "bookkeeper", calls: 2, tokens: 150, usdCents: 3 },
      { day: today, agent: "frontdesk", calls: 1, tokens: 10, usdCents: 0 },
      { day: today, agent: null, calls: 0, tokens: 5, usdCents: 0 },
    ]);
    board.close();
  });

  it("binds a conversation to the ticket it is working, binding the same id twice once", () => {
    const file = boardFile();
    const board = openBoard(file);
    const ticket = root(board);

    expect(board.conversationTicket(41)).toBeUndefined();
    board.bindConversation(41, { ticketId: ticket.id, agent: "bookkeeper" });
    expect(board.conversationTicket(41)).toEqual({ ticketId: ticket.id, agent: "bookkeeper" });
    board.bindConversation(41, { ticketId: ticket.id, agent: "bookkeeper" });
    expect(count(file, "ticket_conversations")).toBe(1);

    // A conversation for a ticket that does not exist is a mistake, not a binding.
    expect(kindOf(() => board.bindConversation(42, { ticketId: "ghost", agent: "a" }))).toBe(
      "not_found",
    );
    expect(board.conversationTicket(42)).toBeUndefined();
    board.close();
  });
});
