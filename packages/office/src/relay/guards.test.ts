/**
 * The relay's delivery guards (RASF-3141).
 *
 * These are the door, tested without a harness: a guard is a yes/no answer about one event and one
 * ticket, so the ticket is a real board row and the answer is read back off the board. What the relay
 * does with a refusal — a `failed` ledger row and a `stalled` event, and no agent turn — is
 * `relay.test.ts`'s; keeping the two apart means a broken policy here does not need a transport to
 * reproduce.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Board, NewTicket, Ticket } from "../board/index.js";
import { createWorkboard, seedPerson } from "../board/testing.js";
import {
  boardGuards,
  type GuardContext,
  type GuardEvent,
  type GuardTicket,
  openGuards,
} from "./guards.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface Fixture {
  readonly file: string;
  readonly board: Board;
  readonly dir: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "officehum-guards-"));
  temps.push(dir);
  const file = join(dir, "office.sqlite");
  seedPerson(file, "owner", "Pat Owner");
  return { file, board: createWorkboard(file), dir };
}

const PROVENANCE = {
  origin: "internal",
  sourceChannel: "test",
  sourceContact: "front-desk",
} as const;
let counter = 0;

function ticket(board: Board, input: Partial<NewTicket> = {}): Ticket {
  counter += 1;
  return board.create(
    {
      type: "invoice.create",
      title: "Invoice",
      createdBy: "front-desk",
      provenance: PROVENANCE,
      ...input,
    },
    `guards-${counter}`,
  );
}

/** The ticket as the relay hands it to a guard. */
function asGuardTicket(row: Ticket): GuardTicket {
  return { id: row.id, type: row.type, status: row.status, assignee: row.assignee };
}

/**
 * The ticket as the relay reads it *now*: fresh from the board, after whatever the test just did. A
 * guard trusts the row it is handed, so a test that hands it the state from before a `block` would be
 * testing nothing at all.
 */
function fresh(board: Board, ticketId: string): GuardTicket {
  const row = board.get(ticketId);
  if (row === undefined) throw new Error(`No ticket ${ticketId} on the board.`);
  return asGuardTicket(row);
}

const EVENT: GuardEvent = { id: "event-1", kind: "created", ticketId: "unused" };
const CONTEXT: GuardContext = { hop: 0, conversationKey: "relay.role.bookkeeper.ticket.x" };

/** Seed a hop count the API would refuse to write, so the guard's comparison is the thing under test. */
function seedHops(file: string, ticketId: string, hopCount: number, maxHops: number): void {
  const database = new DatabaseSync(file);
  try {
    database
      .prepare("UPDATE budgets SET hop_count = ?, max_hops = ? WHERE ticket_id = ?")
      .run(hopCount, maxHops, ticketId);
  } finally {
    database.close();
  }
}

describe("delivery guards", () => {
  it("openGuards allows a spent ticket, because it has no board to read", async () => {
    const guards = openGuards();
    const spent: GuardTicket = {
      id: "x",
      type: "invoice.create",
      status: "blocked",
      assignee: null,
    };
    await expect(guards.checkBudget(EVENT, spent, CONTEXT)).resolves.toEqual({ allowed: true });
    await expect(guards.checkHops(EVENT, spent, CONTEXT)).resolves.toEqual({ allowed: true });
    await expect(guards.checkApproval(EVENT, spent, CONTEXT)).resolves.toEqual({ allowed: true });
  });

  it("checkBudget allows a ticket inside its ceiling and refuses one at it, blocking it with a person", async () => {
    const { file, board } = fixture();
    const guards = boardGuards({ board });
    const within = ticket(board, { budget: { maxCalls: 2 } });
    board.admitCall(within.id, "call-1");
    await expect(guards.checkBudget(EVENT, asGuardTicket(within), CONTEXT)).resolves.toEqual({
      allowed: true,
    });

    board.admitCall(within.id, "call-2");
    const refused = await guards.checkBudget(EVENT, fresh(board, within.id), CONTEXT);
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("the guard should have refused an exhausted ticket");
    expect(refused.reason).toContain("budget reached");
    expect(refused.reason).toContain("2 calls");

    // The refusal is on the board, not only in the answer: blocked, with the reason and a person.
    expect(board.get(within.id)).toMatchObject({ status: "blocked", assignee: "owner" });
    const events = board.events(within.id).filter((event) => event.kind === "blocked");
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("budget");
    expect(file).toContain("office.sqlite");
    board.close();
  });

  it("refuses a delivery to a ticket that is already blocked, whatever its numbers say", async () => {
    const { board } = fixture();
    const guards = boardGuards({ board });
    const row = ticket(board);
    board.block(row.id, "owner", { reason: "waiting on the accountant" });

    const refused = await guards.checkBudget(EVENT, fresh(board, row.id), CONTEXT);
    expect(refused).toEqual({ allowed: false, reason: "the ticket is blocked and with a person" });
    board.close();
  });

  it("checkHops allows the ticket at the limit and refuses the one past it", async () => {
    const { file, board } = fixture();
    const guards = boardGuards({ board });
    const row = ticket(board);

    seedHops(file, row.id, 3, 3);
    await expect(guards.checkHops(EVENT, fresh(board, row.id), CONTEXT)).resolves.toEqual({
      allowed: true,
    });

    seedHops(file, row.id, 4, 3);
    const refused = await guards.checkHops(EVENT, fresh(board, row.id), CONTEXT);
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("the guard should have refused a deep delivery");
    expect(refused.reason).toContain("3 hops");
    // Hops exhaust the same way money does: blocked, one event, a person.
    expect(board.get(row.id)).toMatchObject({ status: "blocked", assignee: "owner" });
    expect(board.events(row.id).filter((event) => event.kind === "blocked")).toHaveLength(1);
    board.close();
  });

  it("leaves approvals to RASF-3073", async () => {
    const { board } = fixture();
    const guards = boardGuards({ board });
    const row = ticket(board);
    await expect(guards.checkApproval(EVENT, asGuardTicket(row), CONTEXT)).resolves.toEqual({
      allowed: true,
    });
    board.close();
  });
});
