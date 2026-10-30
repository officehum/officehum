/**
 * The relay's ledger schema (RASF-3067), as migration 2 leaves it.
 *
 * A fresh `:memory:` database is the case that must work (there is no legacy data to migrate), and a
 * real file is where persistence and idempotency are provable — a reopen is the only thing that
 * shows the cursor and the deliveries are on disk rather than in a handle.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS } from "../board/migrations.js";
import { createWorkboard } from "../board/testing.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function boardFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "officehum-relay-schema-"));
  temps.push(directory);
  return join(directory, "office.sqlite");
}

function tableNames(database: DatabaseSync): string[] {
  return (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
}

function columns(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    ({ name }) => name,
  );
}

describe("relay migration", () => {
  it("numbers migrations contiguously from 1", () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(
      MIGRATIONS.map((_, index) => index + 1),
    );
    expect(applyMigrations(new DatabaseSync(":memory:"))).toBe(MIGRATIONS.length);
  });

  it("creates the cursor, delivery and wait tables with the specified columns", () => {
    const database = new DatabaseSync(":memory:");
    expect(applyMigrations(database)).toBe(MIGRATIONS.length);
    expect(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(MIGRATIONS.length);

    expect(tableNames(database)).toEqual([
      "approvals",
      "budgets",
      "comments",
      "people",
      "provenance",
      "relay_cursor",
      "relay_deliveries",
      "relay_waits",
      // Migration 6, RASF-3162: the inbound SMS intake tables.
      "sms_inbound",
      "sms_optouts",
      "sms_rate",
      // Migration 4, RASF-3141: the spend ledger and the conversation→ticket binding the hooks read.
      "spend_ledger",
      "ticket_conversations",
      "ticket_events",
      "ticket_keys",
      "tickets",
    ]);
    expect(columns(database, "relay_cursor")).toEqual(["id", "seq"]);
    expect(columns(database, "relay_deliveries")).toEqual([
      "event_id",
      "seq",
      "ticket_id",
      "kind",
      "target_key",
      "submission_id",
      "state",
      "outcome",
      "at",
    ]);
    expect(columns(database, "relay_waits")).toEqual([
      "ticket_id",
      "task_id",
      "conversation_id",
      "deadline_ms",
    ]);
    // The cursor starts at 0, not absent: `begin` is an UPDATE, and a missing row would be a
    // silently different cursor.
    expect(database.prepare("SELECT id, seq FROM relay_cursor").all()).toEqual([{ id: 1, seq: 0 }]);
    database.close();
  });

  it("rejects a delivery state outside the lifecycle", () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(database);
    expect(() =>
      database
        .prepare(
          `INSERT INTO relay_deliveries (event_id, seq, ticket_id, kind, target_key, state, at)
           VALUES ('e', 1, 't', 'created', '', 'delivered', 'now')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it("keeps the cursor and the ledger across a reopen", () => {
    const file = boardFile();
    const first = createWorkboard(file);
    first.relay.begin({
      eventId: "event-1",
      seq: 7,
      ticketId: "ticket-1",
      kind: "created",
      targetKey: "relay.role.bookkeeper.ticket.ticket-1",
      state: "pending",
      at: "2026-10-26T00:00:00.000Z",
    });
    expect(first.relay.cursor()).toBe(7);
    first.close();

    const reopened = createWorkboard(file);
    expect(reopened.relay.cursor()).toBe(7);
    expect(reopened.relay.openDeliveries().map((row) => row.eventId)).toEqual(["event-1"]);
    reopened.relay.admitted("event-1", 42);
    reopened.relay.settle("event-1", "settled", "the answer");
    expect(reopened.relay.openDeliveries()).toEqual([]);
    expect(reopened.relay.delivery("event-1")?.submissionId).toBe(42);
    reopened.close();

    const database = new DatabaseSync(file);
    try {
      expect(
        (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(MIGRATIONS.length);
      expect(database.prepare("SELECT COUNT(*) AS n FROM relay_cursor").get()).toEqual({ n: 1 });
      expect(database.prepare("SELECT COUNT(*) AS n FROM relay_deliveries").get()).toEqual({
        n: 1,
      });
    } finally {
      database.close();
    }
  });
});
