import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGoogleCalendar, type Slot } from "./index.js";

type Json = Record<string, unknown>;
type StoredEvent = Json & { id: string; etag: string; status?: string };

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fixture(
  options: { loseInsert?: boolean; losePatch?: boolean; conflictInsert?: boolean } = {},
) {
  const events = new Map<string, StoredEvent>();
  const requests: Array<{ url: URL; init: RequestInit; body?: Json }> = [];
  let lostInsert = false;
  let lostPatch = false;
  const transport: typeof fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Json) : undefined;
    requests.push({ url, init, ...(body === undefined ? {} : { body }) });
    if (url.pathname.endsWith("/freeBusy")) {
      return json(200, { calendars: { "calendar@example.test": { busy: [] } } });
    }
    if (
      url.pathname.endsWith("/calendars/calendar%40example.test") &&
      (init.method === "GET" || init.method === undefined)
    ) {
      return json(200, { timeZone: "America/Chicago" });
    }
    const eventPath = /\/events\/([^/]+)$/.exec(url.pathname);
    if (eventPath !== null) {
      const id = decodeURIComponent(eventPath[1] ?? "");
      const event = events.get(id);
      if (init.method === "GET" || init.method === undefined)
        return event === undefined
          ? json(404, { error: { message: "secret provider body" } })
          : json(200, event);
      if (init.method === "PATCH") {
        if (event === undefined) return json(404);
        if (
          init.headers instanceof Headers
            ? init.headers.get("if-match") !== event.etag
            : (init.headers as Record<string, string> | undefined)?.["If-Match"] !== event.etag
        )
          return json(412);
        const next = {
          ...event,
          ...body,
          etag: `"etag-${requests.length}"`,
          extendedProperties: {
            private: {
              ...((event.extendedProperties as Json | undefined)?.private as Json | undefined),
              ...((body?.extendedProperties as Json | undefined)?.private as Json | undefined),
            },
          },
        } as StoredEvent;
        events.set(id, next);
        if (options.losePatch && !lostPatch) {
          lostPatch = true;
          throw new Error("raw patch network secret");
        }
        return json(200, next);
      }
      if (init.method === "DELETE") {
        if (event === undefined) return json(404);
        events.delete(id);
        return new Response(undefined, { status: 204 });
      }
    }
    if (url.pathname.endsWith("/events") && init.method === "POST") {
      const id = String(body?.id);
      if (options.conflictInsert && !events.has(id)) {
        events.set(id, {
          ...body,
          id,
          etag: '"etag-conflict"',
          status: "confirmed",
        } as StoredEvent);
        return json(409);
      }
      if (events.has(id)) return json(409);
      const stored = { ...body, id, etag: '"etag-1"', status: "confirmed" } as StoredEvent;
      events.set(id, stored);
      if (options.loseInsert && !lostInsert) {
        lostInsert = true;
        throw new Error("raw insert network secret");
      }
      return json(200, stored);
    }
    if (url.pathname.endsWith("/events") && (init.method === "GET" || init.method === undefined)) {
      return json(200, { items: [...events.values()] });
    }
    return json(500, { error: { message: "unexpected fixture request" } });
  };
  const calendar = createGoogleCalendar({
    calendarId: "calendar@example.test",
    getAccessToken: async () => "top-secret-token",
    timeZone: "UTC",
    workingHours: { start: "09:00", end: "12:00" },
    durationMinutes: 60,
    fetch: transport,
  });
  return { calendar, events, requests };
}

const slot: Slot = { start: "2030-01-15T09:00:00Z", end: "2030-01-15T10:00:00Z" };

describe("Google Calendar REST client", () => {
  it("queries freeBusy exactly and fails closed on embedded errors or malformed busy intervals", async () => {
    const calls: Json[] = [];
    let response: unknown = {
      calendars: {
        cal: { busy: [{ start: "2030-01-15T10:00:00Z", end: "2030-01-15T11:00:00Z" }] },
      },
    };
    const calendar = createGoogleCalendar({
      calendarId: "cal",
      getAccessToken: async () => "token",
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
      fetch: async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)) as Json);
        return json(200, response);
      },
    });
    expect(await calendar.freeSlots("2030-01-15")).toEqual([
      slot,
      { start: "2030-01-15T11:00:00Z", end: "2030-01-15T12:00:00Z" },
    ]);
    expect(calls[0]).toEqual({
      timeMin: "2030-01-15T09:00:00Z",
      timeMax: "2030-01-15T12:00:00Z",
      timeZone: "UTC",
      items: [{ id: "cal" }],
    });
    response = { calendars: { cal: { errors: [{ reason: "forbidden" }], busy: [] } } };
    await expect(calendar.freeSlots("2030-01-15")).rejects.toThrow(/calendar.*error/i);
    response = { calendars: { cal: { errors: { reason: "forbidden" }, busy: [] } } };
    await expect(calendar.freeSlots("2030-01-15")).rejects.toThrow(/malformed/i);
    response = { calendars: { cal: { busy: [{ start: "bad", end: "2030-01-15T11:00:00Z" }] } } };
    await expect(calendar.freeSlots("2030-01-15")).rejects.toThrow(/provider/i);
  });

  it("fails a booking closed before insert when freeBusy errors are malformed", async () => {
    let inserts = 0;
    const calendar = createGoogleCalendar({
      calendarId: "cal",
      getAccessToken: async () => "token",
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
      fetch: async (input, init = {}) => {
        const url = new URL(String(input));
        if (/\/events\/[^/]+$/.test(url.pathname)) return json(404);
        if (url.pathname.endsWith("/freeBusy")) {
          return json(200, { calendars: { cal: { errors: "forbidden", busy: [] } } });
        }
        if (init.method === "POST") inserts += 1;
        return json(500);
      },
    });
    await expect(
      calendar.book({ ...slot, customer: "Guest", requestId: "malformed-errors" }),
    ).rejects.toThrow(/malformed/i);
    expect(inserts).toBe(0);
  });

  it("serializes mutations through availability and recovers its queue after rejection", async () => {
    const events = new Map<string, StoredEvent>();
    const transport: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as Json) : undefined;
      const eventPath = /\/events\/([^/]+)$/.exec(url.pathname);
      if (eventPath !== null) {
        const event = events.get(decodeURIComponent(eventPath[1] ?? ""));
        return event === undefined ? json(404) : json(200, event);
      }
      if (url.pathname.endsWith("/freeBusy")) {
        const busy = [...events.values()].map((event) => ({
          start: (event.start as Json).dateTime,
          end: (event.end as Json).dateTime,
        }));
        await new Promise<void>((resolve) => setImmediate(resolve));
        return json(200, { calendars: { cal: { busy } } });
      }
      if (url.pathname.endsWith("/events") && init.method === "POST") {
        const id = String(body?.id);
        const event = { ...body, id, etag: `"${id}"`, status: "confirmed" } as StoredEvent;
        events.set(id, event);
        return json(200, event);
      }
      return json(500);
    };
    const calendar = createGoogleCalendar({
      calendarId: "cal",
      getAccessToken: async () => "token",
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
      fetch: transport,
    });
    const firstTwo = await Promise.allSettled([
      calendar.book({ ...slot, customer: "A", requestId: "parallel-a" }),
      calendar.book({ ...slot, customer: "B", requestId: "parallel-b" }),
    ]);
    expect(firstTwo.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(events).toHaveLength(1);
    expect(
      await calendar.book({
        start: "2030-01-15T10:00:00Z",
        end: "2030-01-15T11:00:00Z",
        customer: "C",
        requestId: "after-rejection",
      }),
    ).toMatchObject({ customer: "C" });
    expect(events).toHaveLength(2);
  });

  it("rejects a deleted idempotent booking before availability while cancel accepts gone events", async () => {
    const calls: string[] = [];
    const calendar = createGoogleCalendar({
      calendarId: "cal",
      getAccessToken: async () => "token",
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
      fetch: async (input, init = {}) => {
        const url = new URL(String(input));
        calls.push(`${init.method ?? "GET"} ${url.pathname}`);
        return json(410);
      },
    });
    await expect(
      calendar.book({ ...slot, customer: "Guest", requestId: "deleted" }),
    ).rejects.toThrow(/deleted|cancel/i);
    expect(calls).toHaveLength(1);
    await expect(calendar.cancel("gone", "cancel-gone")).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("books with deterministic ownership metadata and recovers a lost insert response", async () => {
    const { calendar, events, requests } = fixture({ loseInsert: true });
    await expect(
      calendar.book({ ...slot, customer: "Guest", requestId: "retry-id" }),
    ).rejects.toThrow(/request failed/i);
    const recovered = await calendar.book({ ...slot, customer: "Guest", requestId: "retry-id" });
    expect(recovered).toMatchObject({ ...slot, customer: "Guest", timeZone: "UTC" });
    expect(events).toHaveLength(1);
    expect(recovered.id).toBe(`oh${createHash("sha256").update("retry-id").digest("hex")}`);
    const insert = requests.find(
      (request) => request.init.method === "POST" && request.url.pathname.endsWith("/events"),
    );
    expect(insert?.url.searchParams.get("sendUpdates")).toBe("none");
    expect(insert?.body).not.toHaveProperty("attendees");
    expect(insert?.body).toMatchObject({ reminders: { useDefault: false } });
    expect(JSON.stringify(insert)).not.toContain("top-secret-token");
  });

  it("recovers insert 409 only when the existing managed event matches", async () => {
    const { calendar, events } = fixture();
    const first = await calendar.book({ ...slot, customer: "Guest", requestId: "same" });
    expect(await calendar.book({ ...slot, customer: "Guest", requestId: "same" })).toEqual(first);
    await expect(
      calendar.book({
        start: "2030-01-15T10:00:00Z",
        end: "2030-01-15T11:00:00Z",
        customer: "Guest",
        requestId: "same",
      }),
    ).rejects.toThrow(/different|changed/i);
    const stored = events.get(first.id);
    if (stored === undefined) throw new Error("fixture event missing");
    events.set(first.id, { ...stored, status: "cancelled" });
    await expect(calendar.book({ ...slot, customer: "Guest", requestId: "same" })).rejects.toThrow(
      /cancel/i,
    );
    events.set(first.id, { ...stored, extendedProperties: { private: {} } });
    await expect(calendar.book({ ...slot, customer: "Guest", requestId: "same" })).rejects.toThrow(
      /owned/i,
    );
  });

  it("recovers a matching event after insert returns 409", async () => {
    const { calendar, events } = fixture({ conflictInsert: true });
    const booked = await calendar.book({ ...slot, customer: "Guest", requestId: "conflict" });
    expect(booked).toMatchObject({ ...slot, customer: "Guest" });
    expect(events).toHaveLength(1);
  });

  it("paginates and filters owned active timed bookings", async () => {
    let page = 0;
    const owned = {
      id: "owned",
      status: "confirmed",
      start: { dateTime: "2030-01-15T10:00:00Z" },
      end: { dateTime: "2030-01-15T11:00:00Z" },
      extendedProperties: {
        private: {
          officehumOwner: "frontdesk-v1",
          customer: "Guest",
          requestDigest: "a".repeat(64),
          bookFingerprint: "b".repeat(64),
        },
      },
    };
    const calendar = createGoogleCalendar({
      calendarId: "cal",
      getAccessToken: async () => "token",
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
      fetch: async (input) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("privateExtendedProperty")).toBe("officehumOwner=frontdesk-v1");
        page += 1;
        return page === 1
          ? json(200, {
              items: [{ id: "gone", status: "cancelled" }, owned],
              nextPageToken: "next",
            })
          : json(200, {
              items: [
                {
                  id: "foreign",
                  start: { dateTime: "2030-01-15T09:00:00Z" },
                  end: { dateTime: "2030-01-15T10:00:00Z" },
                },
              ],
            });
      },
    });
    const listed = await calendar.listBookings();
    expect(page).toBe(2);
    expect(listed).toEqual([
      {
        id: "owned",
        ...slot,
        start: "2030-01-15T10:00:00Z",
        end: "2030-01-15T11:00:00Z",
        customer: "Guest",
        timeZone: "UTC",
      },
    ]);
  });

  it("fails closed on incomplete metadata for an owned active booking", async () => {
    const calendar = createGoogleCalendar({
      calendarId: "cal",
      getAccessToken: async () => "token",
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
      fetch: async () =>
        json(200, {
          items: [
            {
              id: "incomplete",
              status: "confirmed",
              start: { dateTime: slot.start },
              end: { dateTime: slot.end },
              extendedProperties: {
                private: { officehumOwner: "frontdesk-v1", customer: "Guest" },
              },
            },
          ],
        }),
    });
    await expect(calendar.listBookings()).rejects.toThrow(/metadata/i);
  });

  it("checks reschedule conflicts, persists a receipt, and recovers a lost PATCH", async () => {
    const { calendar, requests } = fixture({ losePatch: true });
    const booked = await calendar.book({ ...slot, customer: "Guest", requestId: "book" });
    const target = { start: "2030-01-15T10:00:00Z", end: "2030-01-15T11:00:00Z" };
    await expect(calendar.reschedule(booked.id, target, "move")).rejects.toThrow(/request failed/i);
    const moved = await calendar.reschedule(booked.id, target, "move");
    expect(moved.start).toBe(target.start);
    const conflictQuery = requests.find(
      (request) => request.url.searchParams.get("timeMin") === target.start,
    );
    expect(conflictQuery?.url.searchParams.get("timeMax")).toBe(target.end);
    const patch = requests.find((request) => request.init.method === "PATCH");
    expect(patch?.url.searchParams.get("sendUpdates")).toBe("none");
    expect(JSON.stringify(patch?.body)).toMatch(/"r[A-Za-z0-9_-]{43}"/);
    expect(patch?.body).toMatchObject({
      extendedProperties: {
        private: {
          officehumOwner: "frontdesk-v1",
          customer: "Guest",
          requestDigest: expect.any(String),
          bookFingerprint: expect.any(String),
        },
      },
    });
    await expect(
      calendar.reschedule(
        booked.id,
        { start: "2030-01-15T11:00:00Z", end: "2030-01-15T12:00:00Z" },
        "move",
      ),
    ).rejects.toThrow(/different|superseded/i);
  });

  it("refuses to evict reschedule receipts at the 64-operation cap", async () => {
    const { calendar, events, requests } = fixture();
    const booked = await calendar.book({ ...slot, customer: "Guest", requestId: "book" });
    const event = events.get(booked.id);
    if (event === undefined) throw new Error("fixture event missing");
    const properties = ((event.extendedProperties as Json).private ?? {}) as Json;
    for (let index = 0; index < 64; index += 1) {
      properties[`r${String(index).padStart(43, "a")}`] = `fingerprint-${index}`;
    }
    const patchCount = requests.filter((request) => request.init.method === "PATCH").length;
    await expect(
      calendar.reschedule(
        booked.id,
        { start: "2030-01-15T10:00:00Z", end: "2030-01-15T11:00:00Z" },
        "move-65",
      ),
    ).rejects.toThrow(/limit/i);
    expect(requests.filter((request) => request.init.method === "PATCH")).toHaveLength(patchCount);
  });

  it("rejects target conflicts including all-day events and cancels idempotently", async () => {
    const { calendar, events, requests } = fixture();
    const booked = await calendar.book({ ...slot, customer: "Guest", requestId: "book" });
    const transport = requests[0]?.init;
    expect(transport).toBeDefined();
    events.set("blocker", {
      id: "blocker",
      etag: '"b"',
      status: "confirmed",
      start: { date: "2030-01-15" },
      end: { date: "2030-01-16" },
    });
    await expect(
      calendar.reschedule(
        booked.id,
        { start: "2030-01-15T10:00:00Z", end: "2030-01-15T11:00:00Z" },
        "blocked",
      ),
    ).rejects.toThrow(/available|conflict/i);
    events.delete("blocker");
    events.set("working", {
      id: "working",
      etag: '"w"',
      status: "confirmed",
      eventType: "workingLocation",
      start: { dateTime: "2030-01-15T10:00:00Z" },
      end: { dateTime: "2030-01-15T11:00:00Z" },
    });
    expect(
      await calendar.reschedule(
        booked.id,
        { start: "2030-01-15T10:00:00Z", end: "2030-01-15T11:00:00Z" },
        "working-location-skip",
      ),
    ).toMatchObject({ start: "2030-01-15T10:00:00Z" });
    await calendar.cancel(booked.id, "cancel");
    await calendar.cancel(booked.id, "cancel");
  });

  it.each([
    { start: "2030-01-16", end: "2030-01-15" },
    { start: "2030-01-15", end: "2030-01-15" },
  ])("rejects a non-positive all-day conflict $start to $end before PATCH", async (dates) => {
    const { calendar, events, requests } = fixture();
    const booked = await calendar.book({ ...slot, customer: "Guest", requestId: "book" });
    events.set("malformed-blocker", {
      id: "malformed-blocker",
      etag: '"bad"',
      status: "confirmed",
      start: { date: dates.start },
      end: { date: dates.end },
    });
    const patchCount = requests.filter((request) => request.init.method === "PATCH").length;
    await expect(
      calendar.reschedule(
        booked.id,
        { start: "2030-01-15T10:00:00Z", end: "2030-01-15T11:00:00Z" },
        `invalid-${dates.start}-${dates.end}`,
      ),
    ).rejects.toThrow(/malformed/i);
    expect(requests.filter((request) => request.init.method === "PATCH")).toHaveLength(patchCount);
  });

  it("rejects cancellation of a found foreign event", async () => {
    const { calendar, events } = fixture();
    const booked = await calendar.book({ ...slot, customer: "Guest", requestId: "book" });
    const event = events.get(booked.id);
    if (event === undefined) throw new Error("fixture event missing");
    events.set(booked.id, { ...event, extendedProperties: { private: {} } });
    await expect(calendar.cancel(booked.id, "cancel")).rejects.toThrow(/owned/i);
  });

  it("maps auth, provider, and network failures to safe summaries", async () => {
    const calendar = createGoogleCalendar({
      calendarId: "cal",
      getAccessToken: async () => "token-secret",
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
      fetch: async () => json(403, { error: { message: "provider-secret" } }),
    });
    let message = "";
    try {
      await calendar.freeSlots("2030-01-15");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/403.*scope|permission/i);
    expect(message).not.toContain("provider-secret");
    expect(message).not.toContain("token-secret");

    const broken = createGoogleCalendar({
      calendarId: "cal",
      getAccessToken: async () => "token",
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
      fetch: async () => {
        throw new Error("network-secret");
      },
    });
    await expect(broken.freeSlots("2030-01-15")).rejects.toThrow(
      "Google Calendar freeBusy request failed",
    );
    await expect(broken.freeSlots("2030-01-15")).rejects.not.toThrow("network-secret");

    const tokenFailure = createGoogleCalendar({
      calendarId: "cal",
      getAccessToken: async () => {
        throw new Error("token-callback-secret");
      },
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
      fetch: async () => json(200, {}),
    });
    await expect(tokenFailure.freeSlots("2030-01-15")).rejects.toThrow(/could not obtain/i);
    await expect(tokenFailure.freeSlots("2030-01-15")).rejects.not.toThrow("token-callback-secret");
  });
});
