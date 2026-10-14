import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import {
  canonicalSlot,
  createSchedule,
  overlaps,
  slotsFor,
  validateSlot,
  validBounded,
} from "./schedule.js";
import type { CalendarBooking, CalendarClient, GoogleCalendarOptions, Slot } from "./types.js";

const BASE = "https://www.googleapis.com/calendar/v3";
const OWNER_KEY = "officehumOwner";
const OWNER = "frontdesk-v1";
const RECEIPT = /^r[A-Za-z0-9_-]{43}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

type Json = Record<string, unknown>;
type GoogleEvent = Json & { id?: unknown; status?: unknown; etag?: unknown };

const shaHex = (value: string) => createHash("sha256").update(value).digest("hex");
const requestDigest = (value: string) => shaHex(value);
const eventId = (value: string) => `oh${requestDigest(value)}`;
const targetFingerprint = (slot: Slot) => shaHex(JSON.stringify(slot));
const bookFingerprint = (calendarId: string, slot: Slot, customer: string, timeZone: string) =>
  shaHex(JSON.stringify({ calendarId, ...slot, customer, timeZone }));

function asJson(value: unknown, label: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Google Calendar returned malformed ${label} data.`);
  }
  return value as Json;
}

function privateProperties(event: GoogleEvent): Json | undefined {
  const extended = event.extendedProperties;
  if (extended === null || typeof extended !== "object" || Array.isArray(extended))
    return undefined;
  const privateValue = (extended as Json).private;
  if (privateValue === null || typeof privateValue !== "object" || Array.isArray(privateValue))
    return undefined;
  return privateValue as Json;
}

function timedSlot(event: GoogleEvent): Slot {
  const start = asJson(event.start, "event start").dateTime;
  const end = asJson(event.end, "event end").dateTime;
  if (typeof start !== "string" || typeof end !== "string") {
    throw new Error("Google Calendar returned a malformed timed event.");
  }
  return canonicalSlot({ start, end });
}

function managedBooking(event: GoogleEvent, timeZone: string): CalendarBooking {
  const properties = privateProperties(event);
  if (properties?.[OWNER_KEY] !== OWNER)
    throw new Error("Google Calendar event is not owned by Office Hum.");
  if (event.status === "cancelled") throw new Error("Google Calendar event is canceled.");
  if (!Array.isArray(event.attendees) && event.attendees !== undefined) {
    throw new Error("Google Calendar event attendees are malformed.");
  }
  if (Array.isArray(event.attendees) && event.attendees.length > 0) {
    throw new Error("Google Calendar event has attendees and cannot be modified safely.");
  }
  if (typeof event.id !== "string" || event.id.length === 0)
    throw new Error("Google Calendar event ID is malformed.");
  const customer = properties.customer;
  if (
    typeof customer !== "string" ||
    customer.length === 0 ||
    customer.length > 200 ||
    typeof properties.requestDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(properties.requestDigest) ||
    typeof properties.bookFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(properties.bookFingerprint)
  ) {
    throw new Error("Google Calendar event ownership metadata is malformed.");
  }
  return { id: event.id, ...timedSlot(event), customer, timeZone };
}

function safeStatus(operation: string, status: number): Error {
  if (status === 401)
    return new Error(
      `Google Calendar ${operation} failed (401); refresh the access token externally.`,
    );
  if (status === 403)
    return new Error(
      `Google Calendar ${operation} failed (403); check calendar scopes and permissions.`,
    );
  if (status === 429 || status >= 500)
    return new Error(`Google Calendar ${operation} failed (${status}); retry later.`);
  return new Error(`Google Calendar ${operation} failed (${status}).`);
}

export function createGoogleCalendar(options: GoogleCalendarOptions): CalendarClient {
  const calendarId = validBounded(options.calendarId, "Calendar ID");
  const schedule = createSchedule(options);
  const transport = options.fetch ?? globalThis.fetch;
  if (typeof transport !== "function") throw new Error("A fetch implementation is required.");
  if (typeof options.getAccessToken !== "function")
    throw new Error("An access-token callback is required.");
  const calendarPath = `${BASE}/calendars/${encodeURIComponent(calendarId)}`;

  async function request(
    operation: string,
    url: string,
    init: RequestInit = {},
    accepted: readonly number[] = [200],
  ): Promise<{ status: number; body?: unknown }> {
    let token: string;
    try {
      token = await options.getAccessToken();
    } catch {
      throw new Error(`Google Calendar ${operation} could not obtain an access token.`);
    }
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new Error(`Google Calendar ${operation} requires a nonempty access token.`);
    }
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      if (init.body !== undefined) headers.set("content-type", "application/json");
      response = await transport(url, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error(`Google Calendar ${operation} request failed.`);
    }
    if (!accepted.includes(response.status)) throw safeStatus(operation, response.status);
    if (response.status === 204 || response.status === 404 || response.status === 410)
      return { status: response.status };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Google Calendar returned malformed ${operation} data.`);
    }
    return { status: response.status, body };
  }

  async function getEvent(
    id: string,
    operation: string,
  ): Promise<{ kind: "found"; event: GoogleEvent } | { kind: "missing" | "deleted" }> {
    const result = await request(
      operation,
      `${calendarPath}/events/${encodeURIComponent(id)}`,
      {},
      [200, 404, 410],
    );
    if (result.status === 404) return { kind: "missing" };
    if (result.status === 410) return { kind: "deleted" };
    return { kind: "found", event: asJson(result.body, "event") as GoogleEvent };
  }

  async function freeBusy(window: Slot): Promise<Slot[]> {
    const result = await request("freeBusy", `${BASE}/freeBusy`, {
      method: "POST",
      body: JSON.stringify({
        timeMin: window.start,
        timeMax: window.end,
        timeZone: schedule.timeZone,
        items: [{ id: calendarId }],
      }),
    });
    const root = asJson(result.body, "freeBusy");
    const calendars = asJson(root.calendars, "freeBusy calendars");
    const entry = asJson(calendars[calendarId], "freeBusy calendar");
    if (entry.errors !== undefined) {
      if (!Array.isArray(entry.errors))
        throw new Error("Google Calendar returned malformed freeBusy data.");
      if (entry.errors.length > 0)
        throw new Error("Google Calendar calendar-level error blocked availability.");
    }
    if (!Array.isArray(entry.busy))
      throw new Error("Google Calendar returned malformed freeBusy data.");
    return entry.busy.map((item) => {
      try {
        const value = asJson(item, "busy interval");
        if (typeof value.start !== "string" || typeof value.end !== "string") throw new Error();
        return canonicalSlot({ start: value.start, end: value.end });
      } catch {
        throw new Error("Google Calendar returned malformed provider busy data.");
      }
    });
  }

  async function assertAvailable(slot: Slot): Promise<void> {
    const busy = await freeBusy(slot);
    if (busy.some((item) => overlaps(item, slot)))
      throw new Error("Appointment slot is not available.");
  }

  function verifyExistingBook(
    event: GoogleEvent,
    expected: { id: string; slot: Slot; customer: string; requestId: string },
  ): CalendarBooking {
    if (event.status === "cancelled")
      throw new Error("The idempotent Google Calendar booking was canceled.");
    const booking = managedBooking(event, schedule.timeZone);
    const properties = privateProperties(event) ?? {};
    const fingerprint = bookFingerprint(
      calendarId,
      expected.slot,
      expected.customer,
      schedule.timeZone,
    );
    if (
      booking.id !== expected.id ||
      properties.requestDigest !== requestDigest(expected.requestId) ||
      properties.bookFingerprint !== fingerprint ||
      booking.customer !== expected.customer
    ) {
      throw new Error(
        "Google Calendar event has different idempotent booking arguments or ownership metadata.",
      );
    }
    if (booking.start !== expected.slot.start || booking.end !== expected.slot.end) {
      throw new Error("The original Google Calendar booking has changed since it was created.");
    }
    return booking;
  }

  async function listEvents(url: URL, operation: string): Promise<GoogleEvent[]> {
    const events: GoogleEvent[] = [];
    let pageToken: string | undefined;
    do {
      if (pageToken === undefined) url.searchParams.delete("pageToken");
      else url.searchParams.set("pageToken", pageToken);
      const result = await request(operation, url.toString());
      const body = asJson(result.body, "event list");
      if (!Array.isArray(body.items))
        throw new Error("Google Calendar returned malformed event list data.");
      for (const item of body.items) events.push(asJson(item, "event list item") as GoogleEvent);
      if (body.nextPageToken !== undefined && typeof body.nextPageToken !== "string")
        throw new Error("Google Calendar returned malformed pagination data.");
      pageToken = body.nextPageToken as string | undefined;
    } while (pageToken !== undefined && pageToken.length > 0);
    return events;
  }

  async function calendarTimeZone(): Promise<string> {
    const result = await request("calendar metadata", calendarPath);
    const timeZone = asJson(result.body, "calendar metadata").timeZone;
    if (typeof timeZone !== "string" || timeZone.length === 0)
      throw new Error("Google Calendar returned malformed calendar timezone data.");
    try {
      Temporal.Now.instant().toZonedDateTimeISO(timeZone);
    } catch {
      throw new Error("Google Calendar returned malformed calendar timezone data.");
    }
    return timeZone;
  }

  async function conflictSlot(
    event: GoogleEvent,
    getTimeZone: () => Promise<string>,
  ): Promise<Slot> {
    const start = asJson(event.start, "conflict start");
    const end = asJson(event.end, "conflict end");
    if (typeof start.dateTime === "string" && typeof end.dateTime === "string")
      return canonicalSlot({ start: start.dateTime, end: end.dateTime });
    if (typeof start.date === "string" && typeof end.date === "string") {
      const timeZone = await getTimeZone();
      try {
        if (!DATE_ONLY.test(start.date) || !DATE_ONLY.test(end.date)) throw new Error();
        const startInstant = Temporal.PlainDate.from(start.date)
          .toPlainDateTime("00:00")
          .toZonedDateTime(timeZone, { disambiguation: "reject" })
          .toInstant();
        const endInstant = Temporal.PlainDate.from(end.date)
          .toPlainDateTime("00:00")
          .toZonedDateTime(timeZone, { disambiguation: "reject" })
          .toInstant();
        return canonicalSlot({ start: startInstant.toString(), end: endInstant.toString() });
      } catch {
        throw new Error("Google Calendar returned malformed all-day conflict data.");
      }
    }
    throw new Error("Google Calendar returned malformed conflict interval data.");
  }

  async function assertTargetAvailable(id: string, slot: Slot): Promise<void> {
    const url = new URL(`${calendarPath}/events`);
    url.searchParams.set("timeMin", slot.start);
    url.searchParams.set("timeMax", slot.end);
    url.searchParams.set("singleEvents", "true");
    const events = await listEvents(url, "reschedule conflict check");
    let cachedTimeZone: Promise<string> | undefined;
    const getTimeZone = () => (cachedTimeZone ??= calendarTimeZone());
    for (const event of events) {
      if (
        event.id === id ||
        event.status === "cancelled" ||
        event.transparency === "transparent" ||
        event.eventType === "workingLocation"
      )
        continue;
      const other = await conflictSlot(event, getTimeZone);
      if (overlaps(other, slot))
        throw new Error("Reschedule target conflicts with an existing Google Calendar event.");
    }
  }

  let mutationTail: Promise<void> = Promise.resolve();
  function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    async freeSlots(date) {
      const candidates = slotsFor(schedule, date);
      if (candidates.length === 0) return [];
      const window = { start: candidates[0]?.start ?? "", end: candidates.at(-1)?.end ?? "" };
      const busy = await freeBusy(window);
      return candidates.filter((slot) => !busy.some((item) => overlaps(item, slot)));
    },
    async listBookings() {
      const url = new URL(`${calendarPath}/events`);
      url.searchParams.set("privateExtendedProperty", `${OWNER_KEY}=${OWNER}`);
      url.searchParams.set("showDeleted", "false");
      url.searchParams.set("singleEvents", "true");
      const result: CalendarBooking[] = [];
      for (const event of await listEvents(url, "list bookings")) {
        if (event.status === "cancelled" || privateProperties(event)?.[OWNER_KEY] !== OWNER)
          continue;
        result.push(managedBooking(event, schedule.timeZone));
      }
      return result.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    },
    async book(input) {
      return enqueueMutation(async () => {
        const slot = validateSlot(schedule, input);
        const customer = validBounded(input.customer, "Customer");
        const requestId = validBounded(input.requestId, "Request ID");
        const id = eventId(requestId);
        const existing = await getEvent(id, "get booking");
        if (existing.kind === "deleted")
          throw new Error("The idempotent Google Calendar booking was deleted or canceled.");
        if (existing.kind === "found")
          return verifyExistingBook(existing.event, { id, slot, customer, requestId });
        await assertAvailable(slot);
        const fingerprint = bookFingerprint(calendarId, slot, customer, schedule.timeZone);
        const body = {
          id,
          summary: `Office Hum appointment: ${customer}`,
          start: { dateTime: slot.start, timeZone: schedule.timeZone },
          end: { dateTime: slot.end, timeZone: schedule.timeZone },
          reminders: { useDefault: false },
          extendedProperties: {
            private: {
              [OWNER_KEY]: OWNER,
              requestDigest: requestDigest(requestId),
              customer,
              bookFingerprint: fingerprint,
            },
          },
        };
        try {
          const result = await request(
            "insert booking",
            `${calendarPath}/events?sendUpdates=none`,
            { method: "POST", body: JSON.stringify(body) },
            [200, 201],
          );
          return verifyExistingBook(asJson(result.body, "inserted event") as GoogleEvent, {
            id,
            slot,
            customer,
            requestId,
          });
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("(409)")) throw error;
          const conflict = await getEvent(id, "recover booking conflict");
          if (conflict.kind !== "found")
            throw new Error("Google Calendar booking conflict could not be recovered.");
          return verifyExistingBook(conflict.event, { id, slot, customer, requestId });
        }
      });
    },
    async reschedule(idValue, input, requestIdValue) {
      return enqueueMutation(async () => {
        const id = validBounded(idValue, "Booking ID");
        const requestId = validBounded(requestIdValue, "Request ID");
        const slot = validateSlot(schedule, input);
        const lookup = await getEvent(id, "get reschedule booking");
        if (lookup.kind !== "found")
          throw new Error("Managed Google Calendar booking was not found.");
        const event = lookup.event;
        const booking = managedBooking(event, schedule.timeZone);
        const properties = privateProperties(event) ?? {};
        const key = `r${createHash("sha256").update(requestId).digest("base64url")}`;
        const fingerprint = targetFingerprint(slot);
        const prior = properties[key];
        if (prior !== undefined) {
          if (prior !== fingerprint)
            throw new Error("Reschedule request ID was reused with different arguments.");
          if (booking.start !== slot.start || booking.end !== slot.end)
            throw new Error("Reschedule request was superseded by a later move.");
          return booking;
        }
        if (Object.keys(properties).filter((name) => RECEIPT.test(name)).length >= 64)
          throw new Error("Reschedule receipt limit reached.");
        await assertTargetAvailable(id, slot);
        if (typeof event.etag !== "string" || event.etag.length === 0)
          throw new Error("Google Calendar event ETag is malformed.");
        const result = await request(
          "reschedule booking",
          `${calendarPath}/events/${encodeURIComponent(id)}?sendUpdates=none`,
          {
            method: "PATCH",
            headers: { "If-Match": event.etag },
            body: JSON.stringify({
              start: { dateTime: slot.start, timeZone: schedule.timeZone },
              end: { dateTime: slot.end, timeZone: schedule.timeZone },
              extendedProperties: { private: { ...properties, [key]: fingerprint } },
            }),
          },
        );
        const updated = asJson(result.body, "rescheduled event") as GoogleEvent;
        if (privateProperties(updated)?.[key] !== fingerprint)
          throw new Error("Google Calendar reschedule receipt was not persisted.");
        const updatedBooking = managedBooking(updated, schedule.timeZone);
        if (updatedBooking.start !== slot.start || updatedBooking.end !== slot.end)
          throw new Error("Google Calendar returned the wrong reschedule target.");
        return updatedBooking;
      });
    },
    async cancel(idValue, requestIdValue) {
      return enqueueMutation(async () => {
        const id = validBounded(idValue, "Booking ID");
        validBounded(requestIdValue, "Request ID");
        const lookup = await getEvent(id, "get cancellation booking");
        if (lookup.kind !== "found") return;
        const event = lookup.event;
        const properties = privateProperties(event);
        if (properties?.[OWNER_KEY] !== OWNER)
          throw new Error("Google Calendar event is not owned by Office Hum.");
        if (event.status === "cancelled") return;
        managedBooking(event, schedule.timeZone);
        await request(
          "cancel booking",
          `${calendarPath}/events/${encodeURIComponent(id)}?sendUpdates=none`,
          { method: "DELETE" },
          [204, 404, 410],
        );
      });
    },
  };
}
