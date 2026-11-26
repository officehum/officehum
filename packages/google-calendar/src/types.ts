export interface Slot {
  readonly start: string;
  readonly end: string;
}

export interface CalendarBooking extends Slot {
  readonly id: string;
  readonly customer: string;
  readonly timeZone: string;
}

/**
 * The stretch of time a listing covers, as RFC 3339 instants, read the way Google reads them: a
 * booking is listed when it ends after `timeMin` and, with a `timeMax`, starts before it.
 */
export interface BookingWindow {
  readonly timeMin: string;
  readonly timeMax?: string;
}

export interface CalendarClient {
  freeSlots(date: string): Promise<Slot[]>;
  /** The active managed bookings inside `window`, so a listing never pages through the past. */
  listBookings(window: BookingWindow): Promise<CalendarBooking[]>;
  book(
    input: Slot & { readonly customer: string; readonly requestId: string },
  ): Promise<CalendarBooking>;
  reschedule(id: string, slot: Slot, requestId: string): Promise<CalendarBooking>;
  cancel(id: string, requestId: string): Promise<void>;
}

export interface SchedulingOptions {
  readonly timeZone: string;
  readonly workingHours: { readonly start: string; readonly end: string };
  readonly durationMinutes: number;
}

export interface GoogleCalendarOptions extends SchedulingOptions {
  readonly calendarId: string;
  readonly getAccessToken: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

export interface FakeCalendarOptions extends SchedulingOptions {
  readonly busy?: readonly Slot[];
  readonly bookings?: readonly CalendarBooking[];
}
