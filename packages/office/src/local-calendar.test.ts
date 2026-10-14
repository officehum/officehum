import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalCalendar } from "./local-calendar.js";

const temps: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "officehum-calendar-"));
  temps.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("local calendar", () => {
  it("persists one idempotent booking and rejects conflicting reuse", async () => {
    const file = join(temporary(), "nested", "calendar.sqlite");
    const calendar = openLocalCalendar(file);
    const start = "2030-01-15T09:00:00Z";
    const first = await calendar.book(start, "Demo Guest", "operation-1");
    expect(await calendar.book(start, "Demo Guest", "operation-1")).toEqual(first);
    await expect(calendar.book(start, "Other Guest", "operation-1")).rejects.toThrow();
    await expect(calendar.book(start, "Other Guest", "operation-2")).rejects.toThrow();
    expect(calendar.bookings()).toEqual([first]);
    calendar.close();

    const reopened = openLocalCalendar(file);
    expect(reopened.bookings()).toEqual([first]);
    expect(await reopened.freeSlots("2030-01-15")).not.toContain(start);
    await expect(reopened.freeSlots("2030-02-30")).rejects.toThrow();
    await expect(reopened.book("2030-01-15T09:30:00Z", "Demo Guest", "bad")).rejects.toThrow();
    reopened.close();
  });

  it("atomically gives a slot to exactly one distinct key", async () => {
    const calendar = openLocalCalendar(join(temporary(), "calendar.sqlite"));
    const results = await Promise.allSettled([
      calendar.book("2030-01-15T10:00:00Z", "A", "key-a"),
      calendar.book("2030-01-15T10:00:00Z", "B", "key-b"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(calendar.bookings()).toHaveLength(1);
    calendar.close();
  });

  it("validates customer and idempotency input", async () => {
    const calendar = openLocalCalendar(join(temporary(), "calendar.sqlite"));
    await expect(calendar.book("2030-01-15T09:00:00Z", "", "key")).rejects.toThrow();
    await expect(calendar.book("2030-01-15T09:00:00Z", "x".repeat(201), "key")).rejects.toThrow();
    await expect(calendar.book("2030-01-15T09:00:00Z", "Guest", "")).rejects.toThrow();
    calendar.close();
  });

  it("stores approval decisions first-write-wins", () => {
    const calendar = openLocalCalendar(join(temporary(), "calendar.sqlite"));
    const request = {
      approvalId: "confirm_booking",
      description: "Confirm booking",
      tool: "book_appointment",
      arguments: { start: "2030-01-15T09:00:00Z", customer: "Guest" },
      conversationId: "conversation",
      taskId: "task",
      callId: "call",
    };
    const first = calendar.recordDecision("decision", request, { approved: false, by: "operator" });
    expect(calendar.recordDecision("decision", request, { approved: true })).toEqual(first);
    expect(calendar.decision("decision")).toEqual(first);
    calendar.close();
  });

  it("reschedules and soft-cancels while preserving identity and history", async () => {
    const file = join(temporary(), "calendar.sqlite");
    const calendar = openLocalCalendar(file);
    const original = await calendar.book("2030-01-15T09:00:00.000Z", " Guest ", "book-1");
    expect(original).toMatchObject({ start: "2030-01-15T09:00:00Z", customer: "Guest" });
    expect(await calendar.listBookings()).toEqual([original]);

    const same = await calendar.reschedule(original.id, original.start, "move-same");
    expect(same).toEqual(original);
    const moved = await calendar.reschedule(original.id, "2030-01-15T10:00:00.000Z", "move-1");
    expect(moved).toEqual({ ...original, start: "2030-01-15T10:00:00Z" });
    expect(await calendar.freeSlots("2030-01-15")).toContain("2030-01-15T09:00:00Z");
    expect(await calendar.freeSlots("2030-01-15")).not.toContain("2030-01-15T10:00:00Z");
    await expect(
      calendar.reschedule(original.id, "2030-01-15T11:00:00Z", "move-1"),
    ).rejects.toThrow(/different/i);
    await expect(calendar.book(original.start, original.customer, "book-1")).rejects.toThrow(
      /superseded|changed/i,
    );

    const canceled = await calendar.cancel(original.id, "cancel-1");
    expect(canceled).toEqual({ id: original.id, status: "canceled", alreadyCanceled: false });
    expect(await calendar.cancel(original.id, "cancel-1")).toEqual(canceled);
    expect(await calendar.cancel(original.id, "cancel-2")).toEqual({
      id: original.id,
      status: "canceled",
      alreadyCanceled: true,
    });
    expect(await calendar.listBookings()).toEqual([]);
    expect(await calendar.freeSlots("2030-01-15")).toContain("2030-01-15T10:00:00Z");
    await expect(
      calendar.reschedule(original.id, original.start, "move-after-cancel"),
    ).rejects.toThrow(/canceled/i);
    await expect(calendar.reschedule("missing", original.start, "move-missing")).rejects.toThrow(
      /not found/i,
    );
    const replacement = await calendar.book("2030-01-15T10:00:00Z", "Replacement", "book-2");
    expect(replacement.id).not.toBe(original.id);
    calendar.close();

    const reopened = openLocalCalendar(file);
    expect(await reopened.listBookings()).toEqual([replacement]);
    expect(await reopened.cancel(original.id, "cancel-3")).toEqual({
      id: original.id,
      status: "canceled",
      alreadyCanceled: true,
    });
    await expect(
      reopened.reschedule(original.id, "2030-01-15T11:00:00Z", "move-old"),
    ).rejects.toThrow(/canceled/i);
    reopened.close();
  });

  it("binds operation keys globally across kinds, IDs, and canonical arguments", async () => {
    const calendar = openLocalCalendar(join(temporary(), "calendar.sqlite"));
    const first = await calendar.book("2030-01-15T09:00:00Z", "A", "global-key");
    await expect(calendar.book("2030-01-15T10:00:00Z", "A", "global-key")).rejects.toThrow(
      /different/i,
    );
    await expect(
      calendar.reschedule(first.id, "2030-01-15T10:00:00Z", "global-key"),
    ).rejects.toThrow(/different/i);
    await expect(calendar.cancel(first.id, "global-key")).rejects.toThrow(/different/i);
    const other = await calendar.book("2030-01-15T10:00:00Z", "B", "other-key");
    await expect(
      calendar.reschedule(other.id, "2030-01-15T11:00:00Z", "move-key"),
    ).resolves.toMatchObject({
      id: other.id,
    });
    await expect(calendar.reschedule(first.id, "2030-01-15T11:00:00Z", "move-key")).rejects.toThrow(
      /different/i,
    );
    calendar.close();
  });

  it("migrates a legacy WAL database through a verified backup without changing decisions", async () => {
    const directory = temporary();
    const file = join(directory, "calendar.sqlite");
    const legacy = new (await import("node:sqlite")).DatabaseSync(file);
    legacy.exec("PRAGMA journal_mode=WAL");
    legacy.exec(`
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
    `);
    legacy
      .prepare("INSERT INTO bookings VALUES (?, ?, ?, ?)")
      .run("legacy-id", "2030-01-15T09:00:00Z", "Legacy Guest", "legacy-key");
    const requestJson = '{"tool":"book_appointment","arguments":{"customer":"Legacy Guest"}}';
    legacy
      .prepare("INSERT INTO approval_decisions VALUES (?, ?, ?, ?, ?)")
      .run("decision", 0, "operator", "kept", requestJson);
    legacy.close();

    const calendar = openLocalCalendar(file);
    expect(await calendar.listBookings()).toEqual([
      { id: "legacy-id", start: "2030-01-15T09:00:00Z", customer: "Legacy Guest" },
    ]);
    expect(calendar.decision("decision")).toEqual({
      approved: false,
      by: "operator",
      note: "kept",
    });
    await expect(
      calendar.book("2030-01-15T09:00:00Z", "Legacy Guest", "legacy-key"),
    ).resolves.toEqual({
      id: "legacy-id",
      start: "2030-01-15T09:00:00Z",
      customer: "Legacy Guest",
    });
    await expect(
      calendar.reschedule("legacy-id", "2030-01-15T10:00:00Z", "legacy-key"),
    ).rejects.toThrow(/different/i);
    await expect(calendar.cancel("legacy-id", "legacy-key")).rejects.toThrow(/different/i);
    calendar.close();

    const backups = readdirSync(directory).filter((name) =>
      name.startsWith("calendar.sqlite.backup-"),
    );
    expect(backups).toHaveLength(1);
    const backup = new (await import("node:sqlite")).DatabaseSync(
      join(directory, backups[0] ?? ""),
      {
        readOnly: true,
      },
    );
    expect(backup.prepare("SELECT * FROM bookings").all()).toEqual([
      {
        id: "legacy-id",
        start: "2030-01-15T09:00:00Z",
        customer: "Legacy Guest",
        idempotency_key: "legacy-key",
      },
    ]);
    expect(backup.prepare("SELECT request_json FROM approval_decisions").get()).toEqual({
      request_json: requestJson,
    });
    backup.close();

    const reopened = openLocalCalendar(file);
    reopened.close();
    expect(
      readdirSync(directory).filter((name) => name.startsWith("calendar.sqlite.backup-")),
    ).toEqual(backups);
  });

  it("leaves ambiguous legacy keys untouched when normalization would merge them", async () => {
    const directory = temporary();
    const file = join(directory, "calendar.sqlite");
    const legacy = new (await import("node:sqlite")).DatabaseSync(file);
    legacy.exec(`
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
      INSERT INTO bookings VALUES
        ('a', '2030-01-15T09:00:00Z', 'A', 'same'),
        ('b', '2030-01-15T10:00:00Z', 'B', ' same ');
    `);
    legacy.close();

    expect(() => openLocalCalendar(file)).toThrow(/ambiguous|normalization/i);
    const source = new (await import("node:sqlite")).DatabaseSync(file, { readOnly: true });
    expect(source.prepare("PRAGMA table_info(bookings)").all()).toHaveLength(4);
    expect(source.prepare("SELECT idempotency_key FROM bookings ORDER BY id").all()).toEqual([
      { idempotency_key: "same" },
      { idempotency_key: " same " },
    ]);
    source.close();
    expect(readdirSync(directory).some((name) => name.startsWith("calendar.sqlite.backup-"))).toBe(
      true,
    );
  });
});
