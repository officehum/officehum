import type { CalendarClient } from "@officehum/google-calendar";
import type { ApprovalDecision, ApprovalRequest } from "@officehum/sdk";
import type { Booking, CalendarOperation, CalendarStore, Cancellation } from "./calendar-store.js";
import { canonicalAppointmentStart } from "./local-calendar.js";

export interface DecisionStore extends CalendarStore {
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
  listBookings(): Promise<Booking[]>;
  book(start: string, customer: string, idempotencyKey: string): Promise<Booking>;
  reschedule(id: string, start: string, idempotencyKey: string): Promise<Booking>;
  cancel(id: string, idempotencyKey: string): Promise<Cancellation>;
  bookings(): Promise<Booking[]>;
}

function bounded(value: string, label: string, maximum = 500): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function portableBooking(value: {
  readonly id: string;
  readonly start: string;
  readonly customer: string;
}): Booking {
  return {
    id: bounded(value.id, "Booking ID"),
    start: canonicalAppointmentStart(value.start),
    customer: bounded(value.customer, "Customer", 200),
  };
}

function completedBooking(operation: CalendarOperation, active: readonly Booking[]): Booking {
  const result = operation.result;
  if (result === undefined || "status" in result) throw new Error("Malformed booking receipt.");
  const current = active.find((booking) => booking.id === result.id);
  if (
    current === undefined ||
    current.start !== result.start ||
    current.customer !== result.customer
  ) {
    throw new Error("The completed booking was canceled, changed, or superseded.");
  }
  return result;
}

export function createGoogleCalendarHost(options: {
  readonly client: CalendarClient;
  readonly decisions: DecisionStore;
  readonly durationMinutes: number;
}): GoogleCalendarHost {
  if (!Number.isSafeInteger(options.durationMinutes) || options.durationMinutes <= 0) {
    throw new Error("Google Calendar host duration must be a positive whole number of minutes.");
  }

  const list = async (): Promise<Booking[]> =>
    (await options.client.listBookings())
      .map(portableBooking)
      .sort(
        (left, right) => left.start.localeCompare(right.start) || left.id.localeCompare(right.id),
      );
  const slot = (start: string) => ({
    start,
    end: new Date(new Date(start).valueOf() + options.durationMinutes * 60_000).toISOString(),
  });
  let mutationTail: Promise<void> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    async freeSlots(date) {
      return (await options.client.freeSlots(date)).map((value) =>
        canonicalAppointmentStart(value.start),
      );
    },
    listBookings: list,
    async book(startValue, customerValue, idempotencyKeyValue) {
      const start = canonicalAppointmentStart(startValue);
      const customer = bounded(customerValue, "Customer", 200);
      const key = bounded(idempotencyKeyValue, "Idempotency key");
      const argsJson = JSON.stringify({ kind: "book", start, customer });
      return enqueue(async () => {
        const operation = options.decisions.bindOperation(key, "book", argsJson);
        if (operation.result !== undefined) return completedBooking(operation, await list());
        const result = portableBooking(
          await options.client.book({ ...slot(start), customer, requestId: key }),
        );
        options.decisions.completeOperation(key, result);
        return result;
      });
    },
    async reschedule(idValue, startValue, idempotencyKeyValue) {
      const id = bounded(idValue, "Booking ID");
      const start = canonicalAppointmentStart(startValue);
      const key = bounded(idempotencyKeyValue, "Idempotency key");
      const argsJson = JSON.stringify({ kind: "reschedule", id, start });
      return enqueue(async () => {
        let operation = options.decisions.bindOperation(key, "reschedule", argsJson);
        if (operation.result !== undefined) return completedBooking(operation, await list());
        if (operation.booking === undefined) {
          const current = (await list()).find((booking) => booking.id === id);
          if (current === undefined) throw new Error("Managed booking was not found.");
          options.decisions.captureBooking(key, current);
          operation = options.decisions.operation(key) ?? operation;
        }
        const result = portableBooking(await options.client.reschedule(id, slot(start), key));
        if (result.id !== id) throw new Error("Google Calendar returned a mismatched booking ID.");
        options.decisions.completeOperation(key, result);
        return result;
      });
    },
    async cancel(idValue, idempotencyKeyValue) {
      const id = bounded(idValue, "Booking ID");
      const key = bounded(idempotencyKeyValue, "Idempotency key");
      const argsJson = JSON.stringify({ kind: "cancel", id });
      return enqueue(async () => {
        let operation = options.decisions.bindOperation(key, "cancel", argsJson);
        if (operation.result !== undefined) {
          if (!("status" in operation.result)) throw new Error("Malformed cancellation receipt.");
          return operation.result;
        }
        if (operation.booking === undefined) {
          const current = (await list()).find((booking) => booking.id === id);
          if (current !== undefined) {
            options.decisions.captureBooking(key, current);
            operation = options.decisions.operation(key) ?? operation;
          } else if (options.decisions.canceledBooking(id) !== undefined) {
            const result: Cancellation = { id, status: "canceled", alreadyCanceled: true };
            options.decisions.completeOperation(key, result);
            return result;
          } else {
            throw new Error("Managed booking was not found.");
          }
        }
        if (operation.booking?.id !== id) {
          throw new Error("Cancellation operation captured a different booking.");
        }
        await options.client.cancel(id, key);
        const result: Cancellation = { id, status: "canceled", alreadyCanceled: false };
        options.decisions.completeOperation(key, result);
        return result;
      });
    },
    bookings: list,
    operation(key) {
      return options.decisions.operation(key);
    },
    bindOperation(key, kind, argsJson) {
      return options.decisions.bindOperation(key, kind, argsJson);
    },
    captureBooking(key, booking) {
      return options.decisions.captureBooking(key, booking);
    },
    completeOperation(key, result) {
      return options.decisions.completeOperation(key, result);
    },
    canceledBooking(id) {
      return options.decisions.canceledBooking(id);
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
