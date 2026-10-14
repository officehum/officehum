import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CalendarClient,
  createGoogleCalendar,
  fakeCalendar,
} from "../../google-calendar/src/index.js";
import { createGoogleCalendarHost } from "./google-calendar.js";
import { openLocalCalendar } from "./local-calendar.js";

function googleRestFixture() {
  const events = new Map<string, Record<string, unknown>>();
  const writes = { posts: 0, patches: 0, deletes: 0 };
  const transport: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/freeBusy")) {
      return new Response(JSON.stringify({ calendars: { cal: { busy: [] } } }), { status: 200 });
    }
    const eventPath = /\/events\/([^/]+)$/.exec(url.pathname);
    if (eventPath !== null) {
      const id = decodeURIComponent(eventPath[1] ?? "");
      const event = events.get(id);
      if (init.method === "PATCH") {
        if (event === undefined) return new Response(undefined, { status: 404 });
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const previousPrivate = (event.extendedProperties as Record<string, unknown>).private as
          | Record<string, unknown>
          | undefined;
        const nextPrivate = (body.extendedProperties as Record<string, unknown>).private as
          | Record<string, unknown>
          | undefined;
        const updated = {
          ...event,
          ...body,
          id,
          status: "confirmed",
          etag: `"etag-${writes.patches + 1}"`,
          extendedProperties: { private: { ...previousPrivate, ...nextPrivate } },
        };
        events.set(id, updated);
        writes.patches += 1;
        return new Response(JSON.stringify(updated), { status: 200 });
      }
      if (init.method === "DELETE") {
        events.delete(id);
        writes.deletes += 1;
        return new Response(undefined, { status: 204 });
      }
      return new Response(JSON.stringify(event ?? {}), {
        status: event === undefined ? 404 : 200,
      });
    }
    if (url.pathname.endsWith("/events") && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const event = { ...body, status: "confirmed", etag: `"etag-post-${writes.posts + 1}"` };
      events.set(String(body.id), event);
      writes.posts += 1;
      return new Response(JSON.stringify(event), { status: 200 });
    }
    if (url.pathname.endsWith("/events")) {
      return new Response(JSON.stringify({ items: [...events.values()] }), { status: 200 });
    }
    return new Response(JSON.stringify({ timeZone: "UTC" }), { status: 200 });
  };
  return { events, transport, writes };
}

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
      expect(await host.listBookings()).toHaveLength(1);
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

  it("moves, cancels, and verifies completed retries against current provider state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-google-host-"));
    try {
      const decisions = openLocalCalendar(join(directory, "calendar.sqlite"));
      const client = fakeCalendar({
        timeZone: "UTC",
        workingHours: { start: "09:00", end: "12:00" },
        durationMinutes: 60,
      });
      const host = createGoogleCalendarHost({ client, decisions, durationMinutes: 60 });
      const booked = await host.book("2030-01-15T09:00:00.000Z", " Guest ", "book-key");
      expect(booked).toMatchObject({ start: "2030-01-15T09:00:00Z", customer: "Guest" });
      const moved = await host.reschedule(booked.id, "2030-01-15T10:00:00.000Z", "move-key");
      expect(moved).toEqual({ ...booked, start: "2030-01-15T10:00:00Z" });
      expect(await host.reschedule(booked.id, "2030-01-15T10:00:00Z", "move-key")).toEqual(moved);
      await client.reschedule(
        booked.id,
        { start: "2030-01-15T11:00:00Z", end: "2030-01-15T12:00:00Z" },
        "external-move",
      );
      await expect(host.reschedule(booked.id, "2030-01-15T10:00:00Z", "move-key")).rejects.toThrow(
        /superseded|changed/i,
      );
      await expect(host.book("2030-01-15T09:00:00Z", "Guest", "book-key")).rejects.toThrow(
        /superseded|changed/i,
      );

      const canceled = await host.cancel(booked.id, "cancel-key");
      expect(canceled).toEqual({ id: booked.id, status: "canceled", alreadyCanceled: false });
      expect(await host.cancel(booked.id, "cancel-key")).toEqual(canceled);
      expect(await host.cancel(booked.id, "cancel-again")).toEqual({
        id: booked.id,
        status: "canceled",
        alreadyCanceled: true,
      });
      expect(await host.listBookings()).toEqual([]);
      host.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["book", "reschedule"] as const)(
    "rejects a completed %s replay after provider end-only drift without another write",
    async (kind) => {
      const directory = mkdtempSync(join(tmpdir(), "officehum-google-host-"));
      try {
        const decisions = openLocalCalendar(join(directory, "calendar.sqlite"));
        const rest = googleRestFixture();
        const client = createGoogleCalendar({
          calendarId: "cal",
          timeZone: "UTC",
          workingHours: { start: "09:00", end: "12:00" },
          durationMinutes: 60,
          getAccessToken: async () => "test-token",
          fetch: rest.transport,
        });
        const host = createGoogleCalendarHost({ client, decisions, durationMinutes: 60 });
        const booked = await host.book("2030-01-15T09:00:00Z", "Guest", "book-key");
        if (kind === "reschedule") {
          await host.reschedule(booked.id, "2030-01-15T10:00:00Z", "move-key");
        }
        const replay =
          kind === "book"
            ? () => host.book("2030-01-15T09:00:00Z", "Guest", "book-key")
            : () => host.reschedule(booked.id, "2030-01-15T10:00:00Z", "move-key");
        const event = rest.events.get(booked.id);
        if (event === undefined) throw new Error("missing REST fixture event");
        event.end = {
          dateTime: kind === "book" ? "2030-01-15T11:00:00Z" : "2030-01-15T12:00:00Z",
          timeZone: "UTC",
        };
        const writesBeforeReplay = { ...rest.writes };

        await expect(replay()).rejects.toThrow(/changed|superseded/i);
        expect(rest.writes).toEqual(writesBeforeReplay);
        host.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects unknown first-time cancellation without DELETE and recovers an exact pending one", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-google-host-"));
    try {
      const decisions = openLocalCalendar(join(directory, "calendar.sqlite"));
      let cancels = 0;
      const base = fakeCalendar({
        timeZone: "UTC",
        workingHours: { start: "09:00", end: "12:00" },
        durationMinutes: 60,
      });
      const client: CalendarClient = {
        ...base,
        async cancel(id, key) {
          cancels += 1;
          return base.cancel(id, key);
        },
      };
      const host = createGoogleCalendarHost({ client, decisions, durationMinutes: 60 });
      await expect(host.cancel("unknown", "unknown-key")).rejects.toThrow(/not found/i);
      expect(cancels).toBe(0);

      const snapshot = {
        id: "lost-delete",
        start: "2030-01-15T09:00:00Z",
        customer: "Guest",
      };
      decisions.bindOperation(
        "pending-key",
        "cancel",
        JSON.stringify({ kind: "cancel", id: snapshot.id }),
      );
      decisions.captureBooking("pending-key", snapshot);
      expect(await host.cancel(snapshot.id, "pending-key")).toEqual({
        id: snapshot.id,
        status: "canceled",
        alreadyCanceled: false,
      });
      expect(cancels).toBe(1);
      host.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("binds keys across kinds and continues its queue after a rejected mutation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-google-host-"));
    try {
      const decisions = openLocalCalendar(join(directory, "calendar.sqlite"));
      const client = fakeCalendar({
        timeZone: "UTC",
        workingHours: { start: "09:00", end: "12:00" },
        durationMinutes: 60,
      });
      const host = createGoogleCalendarHost({ client, decisions, durationMinutes: 60 });
      const booked = await host.book("2030-01-15T09:00:00Z", "Guest", "global-key");
      await expect(host.cancel(booked.id, "global-key")).rejects.toThrow(/different/i);
      await expect(
        host.reschedule("missing", "2030-01-15T10:00:00Z", "failed-move"),
      ).rejects.toThrow(/not found/i);
      expect(await host.reschedule(booked.id, "2030-01-15T10:00:00Z", "good-move")).toMatchObject({
        id: booked.id,
        start: "2030-01-15T10:00:00Z",
      });
      host.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses current active provider state before stale cancellation history for a new key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-google-host-"));
    try {
      const decisions = openLocalCalendar(join(directory, "calendar.sqlite"));
      const restored = {
        id: "restored",
        start: "2030-01-15T09:00:00Z",
        end: "2030-01-15T10:00:00Z",
        customer: "Guest",
        timeZone: "UTC",
      };
      let active = [restored];
      let deletes = 0;
      const client: CalendarClient = {
        async freeSlots() {
          return [];
        },
        async listBookings() {
          return active;
        },
        async book() {
          throw new Error("unused");
        },
        async reschedule() {
          throw new Error("unused");
        },
        async cancel() {
          deletes += 1;
          active = [];
        },
      };
      const host = createGoogleCalendarHost({ client, decisions, durationMinutes: 60 });
      const original = await host.cancel(restored.id, "cancel-original");
      expect(original.alreadyCanceled).toBe(false);
      expect(deletes).toBe(1);
      active = [restored];
      expect(await host.cancel(restored.id, "cancel-restored")).toEqual(original);
      expect(deletes).toBe(2);
      expect(await host.cancel(restored.id, "cancel-original")).toEqual(original);
      expect(deletes).toBe(2);
      host.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
