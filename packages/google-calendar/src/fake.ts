import { createHash } from "node:crypto";
import {
  canonicalSlot,
  createSchedule,
  overlaps,
  slotsFor,
  validateSlot,
  validBounded,
} from "./schedule.js";
import type { CalendarBooking, CalendarClient, FakeCalendarOptions, Slot } from "./types.js";

type Record = {
  booking: CalendarBooking;
  original: string;
  receipts: Map<string, string>;
  canceled: boolean;
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const targetFingerprint = (slot: Slot) => digest(JSON.stringify(slot));

export function fakeCalendar(options: FakeCalendarOptions): CalendarClient {
  const schedule = createSchedule(options);
  const busy = (options.busy ?? []).map(canonicalSlot);
  const records = new Map<string, Record>();
  const requestIds = new Map<string, { id: string; fingerprint: string }>();
  for (const seeded of options.bookings ?? []) {
    const slot = validateSlot(schedule, seeded);
    const booking = { ...seeded, ...slot, timeZone: schedule.timeZone };
    records.set(booking.id, {
      booking,
      original: targetFingerprint(booking),
      receipts: new Map(),
      canceled: false,
    });
  }

  const active = () => [...records.values()].filter((record) => !record.canceled);
  const available = (slot: Slot, excluding?: string) =>
    !busy.some((item) => overlaps(item, slot)) &&
    !active().some((record) => record.booking.id !== excluding && overlaps(record.booking, slot));

  return {
    async freeSlots(date) {
      return slotsFor(schedule, date).filter((slot) => available(slot));
    },
    async listBookings() {
      return active()
        .map((record) => record.booking)
        .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    },
    async book(input) {
      const slot = validateSlot(schedule, input);
      const customer = validBounded(input.customer, "Customer");
      const requestId = validBounded(input.requestId, "Request ID");
      const fingerprint = digest(
        JSON.stringify({ ...slot, customer, timeZone: schedule.timeZone }),
      );
      const prior = requestIds.get(requestId);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint)
          throw new Error("Request ID was already used with different booking arguments.");
        const record = records.get(prior.id);
        if (record === undefined || record.canceled)
          throw new Error("The idempotent booking was canceled.");
        if (record.booking.start !== slot.start || record.booking.end !== slot.end)
          throw new Error("The original booking has changed since it was created.");
        return record.booking;
      }
      if (!available(slot)) throw new Error("Appointment slot is not available.");
      const id = `oh${digest(requestId)}`;
      const booking = { id, ...slot, customer, timeZone: schedule.timeZone };
      records.set(id, { booking, original: fingerprint, receipts: new Map(), canceled: false });
      requestIds.set(requestId, { id, fingerprint });
      return booking;
    },
    async reschedule(idValue, input, requestIdValue) {
      const id = validBounded(idValue, "Booking ID");
      const requestId = validBounded(requestIdValue, "Request ID");
      const slot = validateSlot(schedule, input);
      const record = records.get(id);
      if (record === undefined || record.canceled)
        throw new Error("Managed booking was not found.");
      const key = `r${createHash("sha256").update(requestId).digest("base64url")}`;
      const fingerprint = targetFingerprint(slot);
      const receipt = record.receipts.get(key);
      if (receipt !== undefined) {
        if (receipt !== fingerprint)
          throw new Error("Reschedule request ID was reused with different arguments.");
        if (record.booking.start !== slot.start || record.booking.end !== slot.end)
          throw new Error("Reschedule request was superseded by a later move.");
        return record.booking;
      }
      if (record.receipts.size >= 64) throw new Error("Reschedule receipt limit reached.");
      if (!available(slot, id)) throw new Error("Appointment target is not available.");
      record.booking = { ...record.booking, ...slot };
      record.receipts.set(key, fingerprint);
      return record.booking;
    },
    async cancel(idValue, requestIdValue) {
      const id = validBounded(idValue, "Booking ID");
      validBounded(requestIdValue, "Request ID");
      const record = records.get(id);
      if (record !== undefined) record.canceled = true;
    },
  };
}
