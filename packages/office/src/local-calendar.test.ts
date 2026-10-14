import { mkdtempSync, rmSync } from "node:fs";
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
});
