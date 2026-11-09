/**
 * "Today" for a role's prompt, read from a clock the host passes. A model has no clock and guesses
 * badly at weekdays, so the date, and the dates of the next two weeks with their weekdays, are
 * rendered by code: "next Thursday" is looked up here, not worked out. Dates are UTC, as the desks
 * date their records.
 */

import { type PromptSection, section } from "@earendil-works/pi-durable";

const DAY_MS = 86_400_000;
const DAYS_AHEAD = 14;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** `YYYY-MM-DD` in UTC. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function weekday(date: Date): string {
  return WEEKDAYS[date.getUTCDay()] ?? "";
}

/** Today, then the next 14 dates with their weekdays, then where every date must come from. */
export function todayText(now: Date): string {
  const start = Date.parse(`${isoDate(now)}T00:00:00.000Z`);
  const ahead = Array.from({ length: DAYS_AHEAD }, (_, index) => {
    const date = new Date(start + (index + 1) * DAY_MS);
    return `${weekday(date).slice(0, 3)} ${isoDate(date)}`;
  });
  return [
    `Today is ${isoDate(now)} (${weekday(now)}).`,
    ahead.join(", "),
    "Every date you state or record comes from this section or a tool result.",
  ].join("\n");
}

/** The `today` prompt section, rendered from the clock at every request. */
export function todaySection(now: () => Date): PromptSection {
  return section("today", () => todayText(now()));
}
