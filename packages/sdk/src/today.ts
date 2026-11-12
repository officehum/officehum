/**
 * "Today" for a role's prompt, read from a clock the host passes. A model has no clock and guesses
 * badly at weekdays, so the date, and the dates of the next two weeks with their weekdays, are
 * rendered by code: "next Thursday" is looked up here, not worked out. The day is the one in the
 * time zone given, which is the company's, so the prompt and the desk agree on what today is; with
 * none it is the UTC day.
 */

import { type PromptSection, section } from "@earendil-works/pi-durable";
import { addDays, isoDate, localDate, parseDate } from "./dates.js";

const DAYS_AHEAD = 14;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function weekday(day: string): string {
  return WEEKDAYS[parseDate(day)?.getUTCDay() ?? -1] ?? "";
}

/** Today, then the next 14 dates with their weekdays, then where every date must come from. */
export function todayText(now: Date, timeZone?: string): string {
  const today = timeZone === undefined ? isoDate(now) : localDate(now, timeZone);
  const ahead = Array.from({ length: DAYS_AHEAD }, (_, index) => {
    const day = addDays(today, index + 1);
    return `${weekday(day).slice(0, 3)} ${day}`;
  });
  return [
    `Today is ${today} (${weekday(today)}).`,
    ahead.join(", "),
    "Every date you state or record comes from this section or a tool result.",
  ].join("\n");
}

/** The `today` prompt section, rendered from the clock at every request. */
export function todaySection(now: () => Date, timeZone?: string): PromptSection {
  return section("today", () => todayText(now(), timeZone));
}
