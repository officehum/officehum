import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeCalendar } from "../../google-calendar/src/index.js";
import { createGoogleCalendarHost } from "./google-calendar.js";
import { openLocalCalendar } from "./local-calendar.js";

describe("Google Calendar host adapter", () => {
  it("maps portable slots and bookings while keeping approvals in local SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-google-host-"));
    try {
      const decisions = openLocalCalendar(join(directory, "calendar.sqlite"));
      const client = fakeCalendar({
        timeZone: "UTC",
        workingHours: { start: "09:00", end: "12:00" },
        durationMinutes: 60,
      });
      const host = createGoogleCalendarHost({ client, decisions, durationMinutes: 60 });
      expect(await host.freeSlots("2030-01-15")).toEqual([
        "2030-01-15T09:00:00Z",
        "2030-01-15T10:00:00Z",
        "2030-01-15T11:00:00Z",
      ]);
      expect(await host.book("2030-01-15T09:00:00Z", "Guest", "request-1")).toMatchObject({
        start: "2030-01-15T09:00:00Z",
        customer: "Guest",
      });
      expect(await host.bookings()).toHaveLength(1);
      const request = {
        approvalId: "confirm_booking",
        description: "Confirm",
        tool: "book_appointment",
        arguments: {},
        conversationId: "conversation",
        taskId: "task",
        callId: "call",
      };
      expect(host.recordDecision("key", request, { approved: true, by: "test" })).toEqual({
        approved: true,
        by: "test",
      });
      expect(host.decision("key")).toEqual({ approved: true, by: "test" });
      host.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
