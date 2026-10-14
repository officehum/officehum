import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ApprovalDecision, ApprovalRequest } from "@officehum/sdk";
import {
  type Booking,
  type CalendarOperation,
  type CalendarStore,
  type Cancellation,
  openCalendarStore,
} from "./calendar-store.js";

export type { Booking, Cancellation } from "./calendar-store.js";

export interface LocalCalendar extends CalendarStore {
  freeSlots(date: string): Promise<string[]>;
  listBookings(): Promise<Booking[]>;
  book(start: string, customer: string, idempotencyKey: string): Promise<Booking>;
  reschedule(id: string, start: string, idempotencyKey: string): Promise<Booking>;
  cancel(id: string, idempotencyKey: string): Promise<Cancellation>;
  bookings(): Booking[];
  decision(key: string): ApprovalDecision | undefined;
  recordDecision(
    key: string,
    request: ApprovalRequest,
    decision: ApprovalDecision,
  ): ApprovalDecision;
  close(): void;
}

type BookingRow = Booking & {
  original_start: string;
  idempotency_key: string;
  status: "active" | "canceled";
};
type DecisionRow = { approved: number; by: string | null; note: string | null };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLOT = /^(\d{4}-\d{2}-\d{2})T(09|10|11):00:00(?:\.000)?Z$/;

function slots(date: string): string[] {
  const match = DATE.exec(date);
  if (match === null) throw new Error(`Invalid UTC date: ${date}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`Invalid UTC date: ${date}`);
  }
  return ["09", "10", "11"].map((hour) => `${date}T${hour}:00:00Z`);
}

export function canonicalAppointmentStart(start: string): string {
  const match = SLOT.exec(start);
  if (match === null) throw new Error(`Unknown UTC appointment slot: ${start}`);
  const canonical = `${match[1]}T${match[2]}:00:00Z`;
  if (!slots(match[1] ?? "").includes(canonical)) {
    throw new Error(`Unknown UTC appointment slot: ${start}`);
  }
  return canonical;
}

function bounded(value: string, label: string, maximum = 500): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function validCustomer(customer: string): string {
  return bounded(customer, "Customer", 200);
}

function booking(row: BookingRow): Booking {
  return { id: row.id, start: row.start, customer: row.customer };
}

function bookingResult(operation: CalendarOperation, current: BookingRow | undefined): Booking {
  const result = operation.result;
  if (result === undefined || "status" in result) throw new Error("Malformed booking receipt.");
  if (current === undefined || current.status !== "active") {
    throw new Error("The idempotent booking was canceled or removed.");
  }
  if (
    current.id !== result.id ||
    current.start !== result.start ||
    current.customer !== result.customer
  ) {
    throw new Error("The idempotent booking was superseded or changed.");
  }
  return result;
}

function toDecision(row: DecisionRow): ApprovalDecision {
  return {
    approved: row.approved === 1,
    ...(row.by === null ? {} : { by: row.by }),
    ...(row.note === null ? {} : { note: row.note }),
  };
}

export function openLocalCalendar(file: string): LocalCalendar {
  mkdirSync(dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec(
    "PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA journal_mode = WAL;",
  );
  let store: CalendarStore;
  try {
    store = openCalendarStore(database, file);
  } catch (error) {
    database.close();
    throw error;
  }

  const findByKey = database.prepare(
    "SELECT id, original_start, start, customer, idempotency_key, status FROM bookings WHERE idempotency_key = ?",
  );
  const findById = database.prepare(
    "SELECT id, original_start, start, customer, idempotency_key, status FROM bookings WHERE id = ?",
  );
  const insertBooking = database.prepare(
    "INSERT INTO bookings (id, original_start, start, customer, idempotency_key, status) VALUES (?, ?, ?, ?, ?, 'active')",
  );
  const listBookings = database.prepare(
    "SELECT id, start, customer FROM bookings WHERE status = 'active' ORDER BY start, id",
  );
  const startsOnDate = database.prepare(
    "SELECT start FROM bookings WHERE status = 'active' AND start >= ? AND start <= ? ORDER BY start",
  );
  const occupiedAt = database.prepare(
    "SELECT id FROM bookings WHERE status = 'active' AND start = ? AND id <> ?",
  );
  const moveBooking = database.prepare(
    "UPDATE bookings SET start = ? WHERE id = ? AND status = 'active'",
  );
  const cancelBooking = database.prepare(
    "UPDATE bookings SET status = 'canceled' WHERE id = ? AND status = 'active'",
  );
  const findDecision = database.prepare(
    "SELECT approved, by_name AS by, note FROM approval_decisions WHERE key = ?",
  );
  const insertDecision = database.prepare(
    "INSERT INTO approval_decisions (key, approved, by_name, note, request_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING",
  );

  const currentForResult = (operation: CalendarOperation): BookingRow | undefined => {
    const result = operation.result;
    return result === undefined ? undefined : (findById.get(result.id) as BookingRow | undefined);
  };

  return {
    ...store,
    async freeSlots(date) {
      const inventory = slots(date);
      const first = inventory[0];
      const last = inventory[2];
      if (first === undefined || last === undefined)
        throw new Error("Calendar inventory is empty.");
      const occupied = new Set(
        (startsOnDate.all(first, last) as Array<{ start: string }>).map((row) => row.start),
      );
      return inventory.filter((start) => !occupied.has(start));
    },
    async listBookings() {
      return listBookings.all() as unknown as Booking[];
    },
    async book(startValue, customerValue, idempotencyKeyValue) {
      const start = canonicalAppointmentStart(startValue);
      const customer = validCustomer(customerValue);
      const key = bounded(idempotencyKeyValue, "Idempotency key");
      const argsJson = JSON.stringify({ kind: "book", start, customer });
      let operation = store.bindOperation(key, "book", argsJson);
      if (operation.result !== undefined)
        return bookingResult(operation, currentForResult(operation));

      database.exec("BEGIN IMMEDIATE");
      try {
        operation = store.operation(key) ?? operation;
        if (operation.result !== undefined) {
          const result = bookingResult(operation, currentForResult(operation));
          database.exec("COMMIT");
          return result;
        }
        const existing = findByKey.get(key) as BookingRow | undefined;
        if (existing !== undefined) {
          if (
            existing.original_start !== start ||
            existing.customer !== customer ||
            existing.status !== "active" ||
            existing.start !== start
          ) {
            throw new Error("Idempotent booking was canceled, changed, or superseded.");
          }
          const result = booking(existing);
          store.completeOperation(key, result);
          database.exec("COMMIT");
          return result;
        }
        const result = { id: randomUUID(), start, customer };
        insertBooking.run(result.id, start, start, customer, key);
        store.completeOperation(key, result);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    },
    async reschedule(idValue, startValue, idempotencyKeyValue) {
      const id = bounded(idValue, "Booking ID");
      const start = canonicalAppointmentStart(startValue);
      const key = bounded(idempotencyKeyValue, "Idempotency key");
      const argsJson = JSON.stringify({ kind: "reschedule", id, start });
      let operation = store.bindOperation(key, "reschedule", argsJson);
      if (operation.result !== undefined)
        return bookingResult(operation, currentForResult(operation));

      database.exec("BEGIN IMMEDIATE");
      try {
        operation = store.operation(key) ?? operation;
        if (operation.result !== undefined) {
          const result = bookingResult(operation, currentForResult(operation));
          database.exec("COMMIT");
          return result;
        }
        const row = findById.get(id) as BookingRow | undefined;
        if (row === undefined) throw new Error("Managed booking was not found.");
        if (row.status !== "active") throw new Error("Managed booking was canceled.");
        if (occupiedAt.get(start, id) !== undefined)
          throw new Error("Appointment target is not available.");
        store.captureBooking(key, booking(row));
        moveBooking.run(start, id);
        const result = { id, start, customer: row.customer };
        store.completeOperation(key, result);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    },
    async cancel(idValue, idempotencyKeyValue) {
      const id = bounded(idValue, "Booking ID");
      const key = bounded(idempotencyKeyValue, "Idempotency key");
      const argsJson = JSON.stringify({ kind: "cancel", id });
      let operation = store.bindOperation(key, "cancel", argsJson);
      if (operation.result !== undefined) {
        if (!("status" in operation.result)) throw new Error("Malformed cancellation receipt.");
        return operation.result;
      }

      database.exec("BEGIN IMMEDIATE");
      try {
        operation = store.operation(key) ?? operation;
        if (operation.result !== undefined) {
          if (!("status" in operation.result)) throw new Error("Malformed cancellation receipt.");
          database.exec("COMMIT");
          return operation.result;
        }
        const row = findById.get(id) as BookingRow | undefined;
        if (row === undefined) throw new Error("Managed booking was not found.");
        let result: Cancellation;
        if (row.status === "canceled") {
          if (store.canceledBooking(id) === undefined)
            throw new Error("Managed booking cancellation history is missing.");
          result = { id, status: "canceled", alreadyCanceled: true };
        } else {
          store.captureBooking(key, booking(row));
          cancelBooking.run(id);
          result = { id, status: "canceled", alreadyCanceled: false };
        }
        store.completeOperation(key, result);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    },
    bookings() {
      return listBookings.all() as unknown as Booking[];
    },
    decision(key) {
      const row = findDecision.get(key) as DecisionRow | undefined;
      return row === undefined ? undefined : toDecision(row);
    },
    recordDecision(key, request, decision) {
      insertDecision.run(
        key,
        decision.approved ? 1 : 0,
        decision.by ?? null,
        decision.note ?? null,
        JSON.stringify(request),
      );
      const row = findDecision.get(key) as DecisionRow | undefined;
      if (row === undefined) throw new Error("Failed to persist approval decision.");
      return toDecision(row);
    },
    close() {
      database.close();
    },
  };
}
