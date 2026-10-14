import { describe, expect, it } from "vitest";
import { fakeCalendar } from "./index.js";

describe("portable calendar scheduling", () => {
  it("subtracts half-open busy intervals while keeping adjacent slots", async () => {
    const calendar = fakeCalendar({
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
      busy: [
        { start: "2030-01-15T08:00:00Z", end: "2030-01-15T09:00:00Z" },
        { start: "2030-01-15T10:00:00Z", end: "2030-01-15T11:00:00Z" },
        { start: "2030-01-15T12:00:00Z", end: "2030-01-15T13:00:00Z" },
      ],
    });

    expect(await calendar.freeSlots("2030-01-15")).toEqual([
      { start: "2030-01-15T09:00:00Z", end: "2030-01-15T10:00:00Z" },
      { start: "2030-01-15T11:00:00Z", end: "2030-01-15T12:00:00Z" },
    ]);
  });

  it("uses real timezone transitions and canonicalizes offset-equivalent instants", async () => {
    const calendar = fakeCalendar({
      timeZone: "America/Chicago",
      workingHours: { start: "09:00", end: "11:00" },
      durationMinutes: 60,
    });

    expect(await calendar.freeSlots("2030-03-10")).toEqual([
      { start: "2030-03-10T14:00:00Z", end: "2030-03-10T15:00:00Z" },
      { start: "2030-03-10T15:00:00Z", end: "2030-03-10T16:00:00Z" },
    ]);
    const booked = await calendar.book({
      start: "2030-03-10T09:00:00-05:00",
      end: "2030-03-10T10:00:00-05:00",
      customer: "  Demo Guest  ",
      requestId: "request-1",
    });
    expect(booked).toMatchObject({
      start: "2030-03-10T14:00:00Z",
      end: "2030-03-10T15:00:00Z",
      customer: "Demo Guest",
      timeZone: "America/Chicago",
    });
    expect(
      await calendar.book({
        start: "2030-03-10T14:00:00Z",
        end: "2030-03-10T15:00:00Z",
        customer: "Demo Guest",
        requestId: "request-1",
      }),
    ).toEqual(booked);
  });

  it.each([
    ["2030-03-10", "02:00", "04:00"],
    ["2030-11-03", "01:00", "03:00"],
  ])("rejects nonexistent or ambiguous working endpoints on %s", async (date, start, end) => {
    const calendar = fakeCalendar({
      timeZone: "America/Chicago",
      workingHours: { start, end },
      durationMinutes: 60,
    });
    await expect(calendar.freeSlots(date)).rejects.toThrow(/ambiguous|nonexistent/i);
  });

  it.each([
    [
      "invalid date",
      () =>
        fakeCalendar({
          timeZone: "UTC",
          workingHours: { start: "09:00", end: "12:00" },
          durationMinutes: 60,
        }).freeSlots("2030-02-30"),
    ],
    [
      "invalid hours",
      () =>
        fakeCalendar({
          timeZone: "UTC",
          workingHours: { start: "12:00", end: "09:00" },
          durationMinutes: 60,
        }),
    ],
    [
      "invalid duration",
      () =>
        fakeCalendar({
          timeZone: "UTC",
          workingHours: { start: "09:00", end: "12:00" },
          durationMinutes: 0,
        }),
    ],
  ])("rejects %s", async (_name, action) => {
    await expect(Promise.resolve().then(action)).rejects.toThrow();
  });

  it("rejects malformed, unaligned, wrong-duration, and conflicting bookings", async () => {
    const calendar = fakeCalendar({
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
    });
    await expect(
      calendar.book({
        start: "2030-01-15T09:00:00",
        end: "2030-01-15T10:00:00Z",
        customer: "Guest",
        requestId: "a",
      }),
    ).rejects.toThrow(/offset/i);
    await expect(
      calendar.book({
        start: "2030-01-15T09:30:00Z",
        end: "2030-01-15T10:30:00Z",
        customer: "Guest",
        requestId: "b",
      }),
    ).rejects.toThrow(/align/i);
    await expect(
      calendar.book({
        start: "2030-01-15T09:00:00Z",
        end: "2030-01-15T09:30:00Z",
        customer: "Guest",
        requestId: "c",
      }),
    ).rejects.toThrow(/duration/i);
    await expect(
      calendar.book({
        start: "2030-01-15T09:00:00Z",
        end: "2030-01-15T10:00:00Z",
        customer: " ",
        requestId: "d",
      }),
    ).rejects.toThrow(/customer/i);
    await expect(
      calendar.book({
        start: "2030-01-15T09:00:00Z",
        end: "2030-01-15T10:00:00Z",
        customer: "Guest",
        requestId: " ",
      }),
    ).rejects.toThrow(/request/i);
    await calendar.book({
      start: "2030-01-15T09:00:00Z",
      end: "2030-01-15T10:00:00Z",
      customer: "Guest",
      requestId: "first",
    });
    await expect(
      calendar.book({
        start: "2030-01-15T09:00:00Z",
        end: "2030-01-15T10:00:00Z",
        customer: "Other",
        requestId: "other",
      }),
    ).rejects.toThrow(/available/i);
    await expect(
      calendar.book({
        start: "2030-01-15T10:00:00Z",
        end: "2030-01-15T11:00:00Z",
        customer: "Guest",
        requestId: "first",
      }),
    ).rejects.toThrow(/different/i);
  });

  it("implements reschedule and cancel idempotently in the fake", async () => {
    const calendar = fakeCalendar({
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
    });
    const original = await calendar.book({
      start: "2030-01-15T09:00:00Z",
      end: "2030-01-15T10:00:00Z",
      customer: "Guest",
      requestId: "book-1",
    });
    const moved = await calendar.reschedule(
      original.id,
      { start: "2030-01-15T10:00:00Z", end: "2030-01-15T11:00:00Z" },
      "move-1",
    );
    expect(moved.start).toBe("2030-01-15T10:00:00Z");
    expect(
      await calendar.reschedule(
        original.id,
        { start: "2030-01-15T10:00:00Z", end: "2030-01-15T11:00:00Z" },
        "move-1",
      ),
    ).toEqual(moved);
    await expect(
      calendar.reschedule(
        original.id,
        { start: "2030-01-15T11:00:00Z", end: "2030-01-15T12:00:00Z" },
        "move-1",
      ),
    ).rejects.toThrow(/different/i);
    await expect(
      calendar.book({
        start: original.start,
        end: original.end,
        customer: original.customer,
        requestId: "book-1",
      }),
    ).rejects.toThrow(/changed/i);
    await calendar.cancel(original.id, "cancel-1");
    await calendar.cancel(original.id, "cancel-1");
    expect(await calendar.listBookings()).toEqual([]);
  });
});
