import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openCalendarStore } from "./calendar-store.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("calendar operation store", () => {
  it("persists first-write-wins typed operation evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-store-"));
    temps.push(directory);
    const database = new DatabaseSync(join(directory, "calendar.sqlite"));
    const store = openCalendarStore(database, join(directory, "calendar.sqlite"));
    expect(store.bindOperation("key", "cancel", '{"kind":"cancel","id":"booking"}')).toMatchObject({
      key: "key",
      kind: "cancel",
    });
    expect(store.operation("key")?.result).toBeUndefined();
    expect(() => store.bindOperation("key", "reschedule", '{"kind":"reschedule"}')).toThrow(
      /different/i,
    );
    const booking = { id: "booking", start: "2030-01-15T09:00:00Z", customer: "Guest" };
    store.captureBooking("key", booking);
    expect(() => store.captureBooking("key", { ...booking, customer: "Other" })).toThrow(
      /different/i,
    );
    const receipt = { id: "booking", status: "canceled" as const, alreadyCanceled: false };
    store.completeOperation("key", receipt);
    expect(store.operation("key")).toMatchObject({ booking, result: receipt });
    expect(store.canceledBooking("booking")).toEqual(receipt);
    expect(() => store.completeOperation("key", { ...receipt, alreadyCanceled: true })).toThrow(
      /different/i,
    );
    database.close();

    const reopenedDatabase = new DatabaseSync(join(directory, "calendar.sqlite"));
    const reopened = openCalendarStore(reopenedDatabase, join(directory, "calendar.sqlite"));
    expect(reopened.operation("key")).toMatchObject({ booking, result: receipt });
    reopenedDatabase.close();
  });

  it("rejects malformed persisted result JSON instead of returning a false receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-store-"));
    temps.push(directory);
    const file = join(directory, "calendar.sqlite");
    const database = new DatabaseSync(file);
    const store = openCalendarStore(database, file);
    store.bindOperation("key", "cancel", '{"kind":"cancel","id":"booking"}');
    database
      .prepare("UPDATE calendar_operations SET result_json = ? WHERE key = ?")
      .run('{"id":"booking","status":"canceled"}', "key");
    expect(() => store.operation("key")).toThrow(/malformed/i);
    database.close();
  });

  it("rejects an incomplete legacy schema before creating a backup or changing the source", () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-store-"));
    temps.push(directory);
    const file = join(directory, "calendar.sqlite");
    const database = new DatabaseSync(file);
    database.exec(`
      CREATE TABLE bookings (
        id TEXT PRIMARY KEY,
        start TEXT NOT NULL UNIQUE,
        customer TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE
      );
      INSERT INTO bookings VALUES ('a', '2030-01-15T09:00:00Z', 'A', 'key-a');
    `);

    expect(() => openCalendarStore(database, file)).toThrow(/approval schema/i);
    expect(database.prepare("PRAGMA table_info(bookings)").all()).toHaveLength(4);
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'approval_decisions'")
        .get(),
    ).toBeUndefined();
    expect(readdirSync(directory)).toEqual(["calendar.sqlite"]);
    database.close();
  });

  it("re-snapshots after source drift before rewriting the legacy database", () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-store-"));
    temps.push(directory);
    const file = join(directory, "calendar.sqlite");
    const setup = new DatabaseSync(file);
    setup.exec(`
      CREATE TABLE bookings (
        id TEXT PRIMARY KEY,
        start TEXT NOT NULL UNIQUE,
        customer TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE
      );
      CREATE TABLE approval_decisions (
        key TEXT PRIMARY KEY,
        approved INTEGER NOT NULL,
        by_name TEXT,
        note TEXT,
        request_json TEXT NOT NULL
      );
      INSERT INTO bookings VALUES ('a', '2030-01-15T09:00:00Z', 'A', 'key-a');
    `);
    setup.close();

    class DriftDatabase extends DatabaseSync {
      private drift = true;
      private readonly source: boolean;
      constructor(path: string, options?: { readOnly?: boolean }) {
        if (options === undefined) super(path);
        else super(path, options);
        this.source = path === file;
      }
      override exec(sql: string): void {
        if (this.source && this.drift && sql === "BEGIN IMMEDIATE") {
          this.drift = false;
          this.prepare("INSERT INTO bookings VALUES (?, ?, ?, ?)").run(
            "b",
            "2030-01-15T10:00:00Z",
            "B",
            "key-b",
          );
        }
        super.exec(sql);
      }
    }
    const database = new DriftDatabase(file);
    openCalendarStore(database, file);
    expect(database.prepare("SELECT id FROM bookings ORDER BY id").all()).toEqual([
      { id: "a" },
      { id: "b" },
    ]);
    expect(database.prepare("PRAGMA table_info(bookings)").all()).toHaveLength(6);
    database.close();
  });

  it("rolls back a source-only failure after the verified dry run", () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-store-"));
    temps.push(directory);
    const file = join(directory, "calendar.sqlite");
    const setup = new DatabaseSync(file);
    setup.exec(`
      CREATE TABLE bookings (
        id TEXT PRIMARY KEY,
        start TEXT NOT NULL UNIQUE,
        customer TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE
      );
      CREATE TABLE approval_decisions (
        key TEXT PRIMARY KEY,
        approved INTEGER NOT NULL,
        by_name TEXT,
        note TEXT,
        request_json TEXT NOT NULL
      );
      INSERT INTO bookings VALUES ('a', '2030-01-15T09:00:00Z', 'A', 'key-a');
    `);
    setup.close();

    class FailingSourceDatabase extends DatabaseSync {
      private readonly source: boolean;
      constructor(path: string, options?: { readOnly?: boolean }) {
        if (options === undefined) super(path);
        else super(path, options);
        this.source = path === file;
      }
      override exec(sql: string): void {
        if (this.source && sql.includes("DROP TABLE bookings_legacy")) {
          throw new Error("injected source migration failure");
        }
        super.exec(sql);
      }
    }
    const database = new FailingSourceDatabase(file);
    expect(() => openCalendarStore(database, file)).toThrow(/injected/i);
    expect(database.prepare("PRAGMA table_info(bookings)").all()).toHaveLength(4);
    expect(database.prepare("SELECT * FROM bookings").all()).toEqual([
      {
        id: "a",
        start: "2030-01-15T09:00:00Z",
        customer: "A",
        idempotency_key: "key-a",
      },
    ]);
    database.close();
  });
});
