import type { CalendarClient } from "@officehum/google-calendar";
import type { ApprovalDecision, ApprovalRequest } from "@officehum/sdk";
import type { Booking } from "./local-calendar.js";

export interface DecisionStore {
  decision(key: string): ApprovalDecision | undefined;
  recordDecision(
    key: string,
    request: ApprovalRequest,
    decision: ApprovalDecision,
  ): ApprovalDecision;
  close(): void;
}

export interface GoogleCalendarHost extends DecisionStore {
  freeSlots(date: string): Promise<string[]>;
  book(start: string, customer: string, idempotencyKey: string): Promise<Booking>;
  bookings(): Promise<Booking[]>;
}

export function createGoogleCalendarHost(options: {
  readonly client: CalendarClient;
  readonly decisions: DecisionStore;
  readonly durationMinutes: number;
}): GoogleCalendarHost {
  if (!Number.isSafeInteger(options.durationMinutes) || options.durationMinutes <= 0) {
    throw new Error("Google Calendar host duration must be a positive whole number of minutes.");
  }
  return {
    async freeSlots(date) {
      return (await options.client.freeSlots(date)).map((slot) => slot.start);
    },
    async book(start, customer, idempotencyKey) {
      const instant = new Date(start);
      if (!Number.isFinite(instant.valueOf()))
        throw new Error("Appointment start must be a valid instant.");
      const end = new Date(instant.valueOf() + options.durationMinutes * 60_000).toISOString();
      const booking = await options.client.book({
        start,
        end,
        customer,
        requestId: idempotencyKey,
      });
      return { id: booking.id, start: booking.start, customer: booking.customer };
    },
    async bookings() {
      return (await options.client.listBookings()).map(({ id, start, customer }) => ({
        id,
        start,
        customer,
      }));
    },
    decision(key) {
      return options.decisions.decision(key);
    },
    recordDecision(key, request, decision) {
      return options.decisions.recordDecision(key, request, decision);
    },
    close() {
      options.decisions.close();
    },
  };
}
