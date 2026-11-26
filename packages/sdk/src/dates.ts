/**
 * Calendar days, as every role's desk dates its records: `YYYY-MM-DD` strings.
 *
 * Which day it is depends on where the business is: `localDate` reads the day from the host's clock
 * in the company's time zone, so 17:00 in Portland is still today and a notice period is not a day
 * short. Once a day is a `YYYY-MM-DD` string it has no time zone, and the arithmetic here (adding
 * days, counting them, finding the week) is on the calendar alone.
 */

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of an instant in UTC. For the business's own day, use `localDate`. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The calendar day, `YYYY-MM-DD`, that `now` falls on in an IANA time zone such as
 * `America/Los_Angeles`: the company record's `hours.timezone`. "Today", and every notice period and
 * due date counted from it, starts here. Throws when the name is not a time zone.
 */
export function localDate(now: Date, timeZone: string): string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    throw new Error(
      `${JSON.stringify(timeZone)} is not an IANA time zone; use a name like "America/Los_Angeles".`,
    );
  }
  const parts = format.formatToParts(now);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** A real calendar day in `YYYY-MM-DD` form, as its UTC midnight, or `undefined`. */
export function parseDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || isoDate(date) !== value ? undefined : date;
}

/**
 * The day `days` after a `YYYY-MM-DD` day (before it, when negative). Throws for a day that is not
 * one: a caller checks what a person typed with `parseDate` first, so this is a programming error,
 * and a wrong date quietly carried on is worse than a stop.
 */
export function addDays(day: string, days: number): string {
  const date = parseDate(day);
  if (date === undefined) throw new Error(`${JSON.stringify(day)} is not a date (YYYY-MM-DD).`);
  return isoDate(new Date(date.getTime() + days * DAY_MS));
}

/** Whole days from one `YYYY-MM-DD` day to another, negative backwards; `NaN` when either is not a day. */
export function daysBetween(from: string, to: string): number {
  const start = parseDate(from);
  const end = parseDate(to);
  if (start === undefined || end === undefined) return Number.NaN;
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

/** Monday and Sunday of the week a `YYYY-MM-DD` day falls in, or `undefined` when it is not a day. */
export function weekOf(day: string): { readonly start: string; readonly end: string } | undefined {
  const date = parseDate(day);
  if (date === undefined) return undefined;
  const monday = addDays(day, -((date.getUTCDay() + 6) % 7));
  return { start: monday, end: addDays(monday, 6) };
}
