export interface Slot {
  readonly start: string;
  readonly end: string;
}

export interface CalendarBooking extends Slot {
  readonly id: string;
  readonly customer: string;
  readonly timeZone: string;
}

export interface CalendarClient {
  freeSlots(date: string): Promise<Slot[]>;
  listBookings(): Promise<CalendarBooking[]>;
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
