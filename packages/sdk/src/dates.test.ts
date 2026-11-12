import { describe, expect, it } from "vitest";
import { addDays, daysBetween, isoDate, localDate, parseDate, weekOf } from "./dates.js";

describe("localDate", () => {
  it("is the calendar day in the company's time zone, not the UTC day", () => {
    // 17:30 on 11 November in Portland is already the 12th in UTC.
    const evening = new Date("2026-11-12T01:30:00.000Z");
    expect(isoDate(evening)).toBe("2026-11-12");
    expect(localDate(evening, "America/Los_Angeles")).toBe("2026-11-11");
    expect(localDate(evening, "UTC")).toBe("2026-11-12");
    // East of UTC the local day runs ahead instead.
    expect(localDate(new Date("2026-11-11T20:00:00.000Z"), "Asia/Tokyo")).toBe("2026-11-12");
  });

  it("follows daylight saving, and pads the month and day", () => {
    // Midnight Pacific is 07:00 UTC in summer and 08:00 UTC in winter.
    expect(localDate(new Date("2026-07-04T06:59:59.000Z"), "America/Los_Angeles")).toBe(
      "2026-07-03",
    );
    expect(localDate(new Date("2026-07-04T07:00:00.000Z"), "America/Los_Angeles")).toBe(
      "2026-07-04",
    );
    expect(localDate(new Date("2026-01-05T07:59:59.000Z"), "America/Los_Angeles")).toBe(
      "2026-01-04",
    );
    expect(localDate(new Date("2026-01-05T08:00:00.000Z"), "America/Los_Angeles")).toBe(
      "2026-01-05",
    );
  });

  it("says what is wrong with a time zone that is not one", () => {
    expect(() => localDate(new Date("2026-11-12T01:30:00.000Z"), "Pacific")).toThrow(
      '"Pacific" is not an IANA time zone; use a name like "America/Los_Angeles"',
    );
  });
});

describe("calendar days", () => {
  it("parseDate takes a real YYYY-MM-DD day and nothing else", () => {
    expect(parseDate("2026-02-28")?.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(parseDate("2026-02-30")).toBeUndefined();
    expect(parseDate("2026-2-3")).toBeUndefined();
    expect(parseDate("tomorrow")).toBeUndefined();
    expect(parseDate("2026-11-12T00:00:00.000Z")).toBeUndefined();
  });

  it("addDays moves a day forwards and back across months and years", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-11-12", 0)).toBe("2026-11-12");
  });

  it("addDays refuses a day that is not one, rather than returning it or an invalid date", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow('"2026-02-30" is not a date (YYYY-MM-DD)');
  });

  it("daysBetween counts whole days, negative backwards, and NaN for a day that is not one", () => {
    expect(daysBetween("2026-11-12", "2026-11-26")).toBe(14);
    expect(daysBetween("2026-11-26", "2026-11-12")).toBe(-14);
    // Across the spring clock change, still whole days: these are calendar days, not hours.
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetween("soon", "2026-11-12")).toBeNaN();
  });

  it("weekOf is the Monday to Sunday a day falls in", () => {
    expect(weekOf("2026-11-12")).toEqual({ start: "2026-11-09", end: "2026-11-15" });
    expect(weekOf("2026-11-09")).toEqual({ start: "2026-11-09", end: "2026-11-15" });
    expect(weekOf("2026-11-15")).toEqual({ start: "2026-11-09", end: "2026-11-15" });
    expect(weekOf("2026-13-01")).toBeUndefined();
  });
});
