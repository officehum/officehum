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
import { type NewTicket, openBoard } from "./index.js";
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
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1]);
    expect(applyMigrations(new DatabaseSync(":memory:"))).toBe(MIGRATIONS.length);
  });

  it("empty DB applies all migrations (user_version = 1) with expected columns", () => {
    const database = new DatabaseSync(":memory:");
    expect(applyMigrations(database)).toBe(1);
    expect(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(1);

    expect(names(database, "table")).toEqual([
      "approvals",
      "budgets",
      "comments",
      "people",
      "provenance",
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
    ]);
    expect(columns(database, "people")).toEqual(["id", "name", "roles"]);

    // Immutability is a schema fact, not an API convention.
    expect(names(database, "trigger")).toEqual([
      "comments_append_only_delete",
      "comments_append_only_update",
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
      ).toBe(1);
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

  it("refuses a database written by a newer build", () => {
    const file = boardFile();
    const setup = new DatabaseSync(file);
    setup.exec("PRAGMA user_version = 99");
    setup.close();

    expect(() => openBoard(file)).toThrow(/user_version 99/);
  });
});
