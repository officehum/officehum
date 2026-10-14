import { Temporal } from "@js-temporal/polyfill";
import type { SchedulingOptions, Slot } from "./types.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const OFFSET_INSTANT = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i;

export interface Schedule {
  readonly timeZone: string;
  readonly workingStart: Temporal.PlainTime;
  readonly workingEnd: Temporal.PlainTime;
  readonly durationMinutes: number;
}

export function createSchedule(options: SchedulingOptions): Schedule {
  if (typeof options.timeZone !== "string" || options.timeZone.trim().length === 0) {
    throw new Error("A valid IANA time zone is required.");
  }
  try {
    Temporal.Now.instant().toZonedDateTimeISO(options.timeZone);
  } catch {
    throw new Error("A valid IANA time zone is required.");
  }
  if (!TIME.test(options.workingHours.start) || !TIME.test(options.workingHours.end)) {
    throw new Error("Working hours must use HH:mm.");
  }
  const workingStart = Temporal.PlainTime.from(options.workingHours.start);
  const workingEnd = Temporal.PlainTime.from(options.workingHours.end);
  if (Temporal.PlainTime.compare(workingStart, workingEnd) >= 0) {
    throw new Error("Working-hours start must be before end.");
  }
  if (!Number.isSafeInteger(options.durationMinutes) || options.durationMinutes <= 0) {
    throw new Error("Duration must be a positive whole number of minutes.");
  }
  return {
    timeZone: options.timeZone,
    workingStart,
    workingEnd,
    durationMinutes: options.durationMinutes,
  };
}

export function validDate(date: string): Temporal.PlainDate {
  if (!DATE.test(date)) throw new Error(`Invalid calendar date: ${date}`);
  try {
    return Temporal.PlainDate.from(date);
  } catch {
    throw new Error(`Invalid calendar date: ${date}`);
  }
}

function endpoint(
  date: Temporal.PlainDate,
  time: Temporal.PlainTime,
  timeZone: string,
): Temporal.Instant {
  try {
    return date
      .toPlainDateTime(time)
      .toZonedDateTime(timeZone, { disambiguation: "reject" })
      .toInstant();
  } catch {
    throw new Error(`Working-hours endpoint is ambiguous or nonexistent in ${timeZone}.`);
  }
}

export function windowFor(schedule: Schedule, dateValue: string): Slot {
  const date = validDate(dateValue);
  const start = endpoint(date, schedule.workingStart, schedule.timeZone);
  const end = endpoint(date, schedule.workingEnd, schedule.timeZone);
  if (Temporal.Instant.compare(start, end) >= 0) {
    throw new Error("Working-hours window is empty.");
  }
  return { start: start.toString(), end: end.toString() };
}

export function canonicalInstant(value: string): Temporal.Instant {
  if (typeof value !== "string" || !OFFSET_INSTANT.test(value)) {
    throw new Error("Appointment instants must be offset-bearing RFC3339 values.");
  }
  try {
    return Temporal.Instant.from(value);
  } catch {
    throw new Error("Appointment instants must be valid offset-bearing RFC3339 values.");
  }
}

export function canonicalSlot(slot: Slot): Slot {
  const start = canonicalInstant(slot.start);
  const end = canonicalInstant(slot.end);
  if (Temporal.Instant.compare(start, end) >= 0) {
    throw new Error("Appointment end must be after start.");
  }
  return { start: start.toString(), end: end.toString() };
}

export function slotsFor(schedule: Schedule, date: string): Slot[] {
  const window = windowFor(schedule, date);
  const finish = canonicalInstant(window.end);
  const duration = Temporal.Duration.from({ minutes: schedule.durationMinutes });
  const result: Slot[] = [];
  for (let start = canonicalInstant(window.start); ; start = start.add(duration)) {
    const end = start.add(duration);
    if (Temporal.Instant.compare(end, finish) > 0) break;
    result.push({ start: start.toString(), end: end.toString() });
  }
  return result;
}

export function validateSlot(schedule: Schedule, input: Slot): Slot {
  const slot = canonicalSlot(input);
  const start = canonicalInstant(slot.start);
  const end = canonicalInstant(slot.end);
  const elapsedMinutes = Number(end.epochNanoseconds - start.epochNanoseconds) / 60_000_000_000;
  if (elapsedMinutes !== schedule.durationMinutes) {
    throw new Error(`Appointment duration must be ${schedule.durationMinutes} minutes.`);
  }
  const localDate = start.toZonedDateTimeISO(schedule.timeZone).toPlainDate().toString();
  const candidates = slotsFor(schedule, localDate);
  if (
    !candidates.some((candidate) => candidate.start === slot.start && candidate.end === slot.end)
  ) {
    throw new Error("Appointment must align with configured working hours.");
  }
  return slot;
}

export function overlaps(left: Slot, right: Slot): boolean {
  const leftStart = canonicalInstant(left.start);
  const leftEnd = canonicalInstant(left.end);
  const rightStart = canonicalInstant(right.start);
  const rightEnd = canonicalInstant(right.end);
  return (
    Temporal.Instant.compare(leftStart, rightEnd) < 0 &&
    Temporal.Instant.compare(leftEnd, rightStart) > 0
  );
}

export function validBounded(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is required.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new Error(`${label} must be between 1 and 200 characters.`);
  }
  return normalized;
}
