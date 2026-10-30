/**
 * Board migration tests (RASF-3066).
 *
 * Migrations are checked on `:memory:` — there is no legacy data to preserve, and a fresh database is
 * exactly the case that must work. Persistence, idempotency and the caller-key ledger are checked on a
 * real file, because a reopen is the only thing that proves them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { argsHash, type NewTicket, openBoard } from "./index.js";
import { applyMigrations, MIGRATIONS } from "./migrations.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function boardFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "officehum-board-"));
  temps.push(directory);
  return join(directory, "board.sqlite");
}

function names(database: DatabaseSync, type: string): string[] {
  return (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all(type) as Array<{ name: string }>
  ).map(({ name }) => name);
}

function columns(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    ({ name }) => name,
  );
}

const REQUEST: NewTicket = {
  type: "invoice.create",
  title: "Invoice",
  createdBy: "front-desk",
  provenance: { origin: "internal", sourceChannel: "test", sourceContact: "front-desk" },
};

describe("board migrations", () => {
  it("numbers migrations contiguously from 1", () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(
      MIGRATIONS.map((_, index) => index + 1),
    );
    expect(applyMigrations(new DatabaseSync(":memory:"))).toBe(MIGRATIONS.length);
  });

  it("empty DB applies all migrations (user_version = head) with expected columns", () => {
    const database = new DatabaseSync(":memory:");
    expect(applyMigrations(database)).toBe(MIGRATIONS.length);
    expect(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(MIGRATIONS.length);

    expect(names(database, "table")).toEqual([
      "approvals",
      "budgets",
      "comments",
      "people",
      "provenance",
      "relay_cursor",
      "relay_deliveries",
      "relay_waits",
      // Migration 6's inbound SMS intake tables.
      "sms_inbound",
      "sms_optouts",
      "sms_rate",
      "spend_ledger",
      "ticket_conversations",
      "ticket_events",
      "ticket_keys",
      "tickets",
    ]);
    expect(columns(database, "tickets")).toEqual([
      "id",
      "type",
      "title",
      "detail",
      "payload",
      "status",
      "assignee",
      "created_by",
      "parent_id",
      "workflow_run_id",
      "created_at",
      "updated_at",
      // Added by migration 3, so it lands at the end: `ALTER TABLE ADD COLUMN` appends.
      "result",
    ]);
    expect(columns(database, "ticket_events")).toEqual([
      "id",
      "seq",
      "ticket_id",
      "kind",
      "actor",
      "payload",
      "at",
    ]);
    expect(columns(database, "ticket_keys")).toEqual(["caller_key", "ticket_id", "request_json"]);
    expect(columns(database, "comments")).toEqual(["id", "ticket_id", "author", "body", "at"]);
    expect(columns(database, "provenance")).toEqual([
      "ticket_id",
      "origin",
      "source_channel",
      "source_contact",
    ]);
    expect(columns(database, "budgets")).toEqual([
      "ticket_id",
      "max_tokens",
      "max_usd_cents",
      "used_tokens",
      "used_usd_cents",
      "hop_count",
      "max_hops",
      // Added by migration 4, so they land at the end: `ALTER TABLE ADD COLUMN` appends.
      "used_calls",
      "max_calls",
    ]);
    expect(columns(database, "spend_ledger")).toEqual([
      "call_id",
      // Admission and usage are separate observations of one call, deduped independently.
      "kind",
      "ticket_id",
      "agent",
      "calls",
      "tokens",
      "usd_cents",
      "at",
    ]);
    expect(columns(database, "ticket_conversations")).toEqual([
      "conversation_id",
      "ticket_id",
      "agent",
    ]);
    expect(columns(database, "approvals")).toEqual([
      "id",
      "ticket_id",
      "approval_id",
      "tool",
      "args_json",
      "status",
      "decided_by",
      "decided_at",
      "decided_note",
      "created_at",
      // Added by migration 5's rebuild, so they land at the end too.
      "args_hash",
      "requested_by",
      "assignee",
      "expires_at",
    ]);
    expect(columns(database, "people")).toEqual(["id", "name", "roles"]);
    expect(columns(database, "sms_inbound")).toEqual(["message_sid", "received_at"]);
    expect(columns(database, "sms_optouts")).toEqual(["number", "state", "at"]);
    expect(columns(database, "sms_rate")).toEqual(["number", "window_start", "count"]);

    // Immutability is a schema fact, not an API convention.
    expect(names(database, "trigger")).toEqual([
      "approvals_decision_immutable",
      "comments_append_only_delete",
      "comments_append_only_update",
      "spend_ledger_append_only_delete",
      "spend_ledger_append_only_update",
      "ticket_events_append_only_delete",
      "ticket_events_append_only_update",
    ]);
    database.close();
  });

  it("reopen is idempotent, preserves rows", () => {
    const file = boardFile();
    const board = openBoard(file);
    const ticket = board.create(REQUEST, "reopen-key");
    board.claim(ticket.id, "agent-a");
    board.close();

    const reopened = openBoard(file);
    expect(reopened.get(ticket.id)).toMatchObject({
      id: ticket.id,
      status: "claimed",
      assignee: "agent-a",
      title: "Invoice",
    });
    expect(reopened.events(ticket.id).map((event) => event.kind)).toEqual(["created", "claimed"]);
    reopened.close();

    // Nothing accumulated on the second open: the version is at the head and no row was duplicated.
    const database = new DatabaseSync(file);
    try {
      expect(
        (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(MIGRATIONS.length);
      expect(database.prepare("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 1 });
      expect(database.prepare("SELECT COUNT(*) AS n FROM ticket_events").get()).toEqual({ n: 2 });
      expect(database.prepare("SELECT COUNT(*) AS n FROM ticket_keys").get()).toEqual({ n: 1 });
    } finally {
      database.close();
    }
  });

  it("dedup ledger survives reopen (same key → same ticket)", () => {
    const file = boardFile();
    const board = openBoard(file);
    const first = board.create(REQUEST, "survives-key");
    board.close();

    const reopened = openBoard(file);
    const again = reopened.create(REQUEST, "survives-key");
    expect(again).toEqual(first);
    expect(reopened.events(first.id)).toHaveLength(1);
    reopened.close();

    const database = new DatabaseSync(file);
    try {
      expect(database.prepare("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 1 });
      expect(database.prepare("SELECT COUNT(*) AS n FROM ticket_keys").get()).toEqual({ n: 1 });
    } finally {
      database.close();
    }
  });

  it("adds the SMS intake tables to a version-5 database, changing nothing else (migration 6)", () => {
    const file = boardFile();
    const at = "2026-10-20T00:00:00.000Z";
    const old = new DatabaseSync(file);
    for (const migration of MIGRATIONS.filter((step) => step.version <= 5)) migration.up(old);
    old.exec("PRAGMA user_version = 5");
    old
      .prepare(
        `INSERT INTO tickets (id, type, title, payload, status, assignee, created_by, created_at,
                              updated_at)
         VALUES ('t1', 'job.request', 'Leaking sink', '{}', 'open', NULL, 'front-desk', ?, ?)`,
      )
      .run(at, at);
    old.close();

    const board = openBoard(file);
    let ticketCount = 0;
    try {
      // The rows that were there are still there; the new tables are empty rather than back-filled.
      ticketCount = board.list().length;
      expect(board.sms.optOutOf("+15551234567")).toBeUndefined();
    } finally {
      board.close();
    }
    expect(ticketCount).toBe(1);

    const upgraded = new DatabaseSync(file);
    try {
      expect(
        (upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(MIGRATIONS.length);
      expect(upgraded.prepare("SELECT COUNT(*) AS n FROM sms_inbound").get()).toEqual({ n: 0 });
      expect(upgraded.prepare("SELECT COUNT(*) AS n FROM sms_optouts").get()).toEqual({ n: 0 });
      expect(upgraded.prepare("SELECT COUNT(*) AS n FROM sms_rate").get()).toEqual({ n: 0 });
      // The vocabulary is a constraint, so a hand-edited row cannot invent a state.
      const insert = upgraded.prepare(
        "INSERT INTO sms_optouts (number, state, at) VALUES (?, ?, ?)",
      );
      expect(() => insert.run("+15551234567", "maybe", at)).toThrow(/CHECK/);
    } finally {
      upgraded.close();
    }
  });

  it("refuses a database written by a newer build", () => {
    const file = boardFile();
    const setup = new DatabaseSync(file);
    setup.exec("PRAGMA user_version = 99");
    setup.close();

    expect(() => openBoard(file)).toThrow(/user_version 99/);
  });

  it("upgrades a version-3 database in place, keeping its rows (expand-only)", () => {
    const file = boardFile();
    // A board as the previous build left it: migrations 1–3, and a ticket whose spend has not been
    // counted yet because the call columns did not exist.
    const old = new DatabaseSync(file);
    for (const migration of MIGRATIONS.filter((step) => step.version <= 3)) migration.up(old);
    old.exec("PRAGMA user_version = 3");
    old
      .prepare(
        `INSERT INTO tickets (id, type, title, payload, status, assignee, created_by, created_at,
                              updated_at)
         VALUES ('t1', 'invoice.create', 'Invoice', '{}', 'claimed', 'agent-a', 'front-desk',
                 '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')`,
      )
      .run();
    old
      .prepare(
        `INSERT INTO budgets (ticket_id, max_tokens, used_tokens, used_usd_cents, hop_count, max_hops)
         VALUES ('t1', 1000, 400, 5, 0, 4)`,
      )
      .run();
    old.close();

    const board = openBoard(file);
    try {
      expect(board.get("t1")).toMatchObject({ status: "claimed", title: "Invoice" });
      // The old spend is intact and the new counter starts at zero: nothing was re-derived or guessed.
      expect(board.budget("t1")).toMatchObject({
        usedTokens: 400,
        usedUsdCents: 5,
        usedCalls: 0,
        maxCalls: null,
        remainingCalls: null,
      });
      // And the ledger is a new, empty table rather than a back-filled fiction.
      expect(board.spendByAgent()).toEqual([]);
    } finally {
      board.close();
    }

    const upgraded = new DatabaseSync(file);
    try {
      expect(
        (upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(MIGRATIONS.length);
      expect(upgraded.prepare("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 1 });
    } finally {
      upgraded.close();
    }
  });

  it("upgrades a version-4 database in place, keeping its approval rows (migration 5)", () => {
    const file = boardFile();
    const at = "2026-10-20T00:00:00.000Z";
    const old = new DatabaseSync(file);
    for (const migration of MIGRATIONS.filter((step) => step.version <= 4)) migration.up(old);
    old.exec("PRAGMA user_version = 4");
    old
      .prepare(
        `INSERT INTO tickets (id, type, title, payload, status, assignee, created_by, created_at,
                              updated_at)
         VALUES ('t1', 'refund.request', 'Refund the deposit', '{}', 'claimed', 'bookkeeper',
                 'front-desk', ?, ?)`,
      )
      .run(at, at);
    const insertApproval = old.prepare(
      `INSERT INTO approvals
         (id, ticket_id, approval_id, tool, args_json, status, decided_by, decided_at, decided_note,
          created_at)
       VALUES (?, 't1', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Waiting, and written with its keys in the order the old caller happened to emit them.
    insertApproval.run(
      "a1",
      "large_refund",
      "issue_refund",
      '{"to":"acme","amount":500}',
      "waiting",
      null,
      null,
      null,
      at,
    );
    // Decided before the upgrade: the decision and its note are the part nobody may lose.
    insertApproval.run(
      "a2",
      "large_refund",
      "issue_refund",
      '{"amount":2}',
      "declined",
      "maria",
      at,
      "Not this month.",
      at,
    );
    old.close();

    const board = openBoard(file);
    try {
      // The hash is computed during the rebuild from the row's own arguments, so key order in the
      // legacy text does not matter and the row still covers the call it was asked about.
      expect(board.approvals.approvalOf("a1")).toMatchObject({
        status: "waiting",
        tool: "issue_refund",
        args: { to: "acme", amount: 500 },
        argsHash: argsHash({ amount: 500, to: "acme" }),
        requestedBy: null,
        assignee: null,
        expiresAt: null,
      });
      expect(board.approvals.approvalOf("a2")).toMatchObject({
        status: "declined",
        decidedBy: "maria",
        decidedNote: "Not this month.",
      });
      expect(board.approvals.pendingApprovals().map((row) => row.id)).toEqual(["a1"]);

      board.approvals.decideApproval("a1", { by: "maria", decision: "approved" });
      expect(
        board.approvals.approvalCovering(
          "t1",
          "issue_refund",
          argsHash({ amount: 500, to: "acme" }),
        )?.id,
      ).toBe("a1");
    } finally {
      board.close();
    }

    const upgraded = new DatabaseSync(file);
    try {
      expect(
        (upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(MIGRATIONS.length);
      expect(upgraded.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 2 });

      // The vocabulary the v4 CHECK would have refused: a cancelled or expired request is a row the
      // rebuilt table must hold, and an invented status is still refused.
      const insertV5 = upgraded.prepare(
        `INSERT INTO approvals
           (id, ticket_id, approval_id, tool, args_json, status, created_at, args_hash)
         VALUES (?, 't1', 'large_refund', 'issue_refund', '{}', ?, ?, '0')`,
      );
      expect(() => insertV5.run("a3", "cancelled", at)).not.toThrow();
      expect(() => insertV5.run("a4", "expired", at)).not.toThrow();
      expect(() => insertV5.run("a5", "reconsidering", at)).toThrow(/CHECK/);
    } finally {
      upgraded.close();
    }
  });
});
