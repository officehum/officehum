/**
 * The behaviour every `CalendarClient` owes the Front Desk, as one suite each implementation runs:
 * the fake (`fake.test.ts`), the REST client against the recorded upstream (`client.test.ts`), and
 * the connector gateway's client over the same recording. What is about one implementation alone
 * (the REST request shape, its recovery of a lost response) stays in that implementation's own tests.
 *
 * Test-only: the package's build excludes it, and other packages' tests import it by path.
 */

import { expect, it } from "vitest";
import type { CalendarClient, SchedulingOptions, Slot } from "../types.js";

/** A new, empty calendar with `schedule`, as each implementation keeps it. */
export type OpenCalendar = (schedule: SchedulingOptions) => CalendarClient;

/** The schedule every case runs on: three one-hour slots each morning, in UTC. */
export const CONTRACT_SCHEDULE: SchedulingOptions = {
  timeZone: "UTC",
  workingHours: { start: "09:00", end: "12:00" },
  durationMinutes: 60,
};

const DAY = "2030-01-15";
const NINE: Slot = { start: "2030-01-15T09:00:00Z", end: "2030-01-15T10:00:00Z" };
const TEN: Slot = { start: "2030-01-15T10:00:00Z", end: "2030-01-15T11:00:00Z" };
const ELEVEN: Slot = { start: "2030-01-15T11:00:00Z", end: "2030-01-15T12:00:00Z" };
const WINDOW = { timeMin: "2030-01-15T00:00:00Z", timeMax: "2030-01-16T00:00:00Z" };

export function calendarContract(open: OpenCalendar): void {
  it("offers every working-hours slot of an empty day", async () => {
    const calendar = open(CONTRACT_SCHEDULE);
    expect(await calendar.freeSlots(DAY)).toEqual([NINE, TEN, ELEVEN]);
    expect(await calendar.listBookings(WINDOW)).toEqual([]);
  });

  it("books a free slot, lists it, and no longer offers it", async () => {
    const calendar = open(CONTRACT_SCHEDULE);
    const booked = await calendar.book({ ...NINE, customer: "Guest", requestId: "book-1" });
    expect(booked).toEqual({ id: expect.any(String), ...NINE, customer: "Guest", timeZone: "UTC" });
    expect(await calendar.listBookings(WINDOW)).toEqual([booked]);
    expect(await calendar.freeSlots(DAY)).toEqual([TEN, ELEVEN]);
  });

  it("returns the first booking for a repeated request ID instead of booking twice", async () => {
    const calendar = open(CONTRACT_SCHEDULE);
    const first = await calendar.book({ ...NINE, customer: "Guest", requestId: "same" });
    expect(await calendar.book({ ...NINE, customer: "Guest", requestId: "same" })).toEqual(first);
    expect(await calendar.listBookings(WINDOW)).toHaveLength(1);
  });

  it("refuses a slot that is already taken", async () => {
    const calendar = open(CONTRACT_SCHEDULE);
    await calendar.book({ ...NINE, customer: "First", requestId: "first" });
    await expect(
      calendar.book({ ...NINE, customer: "Second", requestId: "second" }),
    ).rejects.toThrow(/not available/i);
    expect(await calendar.listBookings(WINDOW)).toHaveLength(1);
  });

  it("moves a booking, and a repeated move replays rather than moving again", async () => {
    const calendar = open(CONTRACT_SCHEDULE);
    const booked = await calendar.book({ ...NINE, customer: "Guest", requestId: "book" });
    const moved = await calendar.reschedule(booked.id, TEN, "move-1");
    expect(moved).toEqual({ ...booked, ...TEN });
    expect(await calendar.reschedule(booked.id, TEN, "move-1")).toEqual(moved);
    expect(await calendar.listBookings(WINDOW)).toEqual([moved]);
    expect(await calendar.freeSlots(DAY)).toEqual([NINE, ELEVEN]);
    await expect(calendar.reschedule("missing", ELEVEN, "move-2")).rejects.toThrow(
      /booking was not found/i,
    );
  });

  it("cancels a booking, frees its slot, and cancels again without error", async () => {
    const calendar = open(CONTRACT_SCHEDULE);
    const booked = await calendar.book({ ...NINE, customer: "Guest", requestId: "book" });
    await calendar.cancel(booked.id, "cancel-1");
    expect(await calendar.listBookings(WINDOW)).toEqual([]);
    expect(await calendar.freeSlots(DAY)).toEqual([NINE, TEN, ELEVEN]);
    await expect(calendar.cancel(booked.id, "cancel-2")).resolves.toBeUndefined();
  });
}
