import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ApprovalDecision, ApprovalRequest } from "@officehum/sdk";

export interface Booking {
  readonly id: string;
  readonly start: string;
  readonly customer: string;
}

export interface LocalCalendar {
  freeSlots(date: string): Promise<string[]>;
  book(start: string, customer: string, idempotencyKey: string): Promise<Booking>;
  bookings(): Booking[];
  decision(key: string): ApprovalDecision | undefined;
  recordDecision(
    key: string,
    request: ApprovalRequest,
    decision: ApprovalDecision,
  ): ApprovalDecision;
  close(): void;
}

type BookingRow = Booking & { idempotency_key: string };
type DecisionRow = { approved: number; by: string | null; note: string | null };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLOT = /^(\d{4}-\d{2}-\d{2})T(09|10|11):00:00Z$/;

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

function validStart(start: string): void {
  const match = SLOT.exec(start);
  if (match === null || !slots(match[1] ?? "").includes(start)) {
    throw new Error(`Unknown UTC appointment slot: ${start}`);
  }
}

function validCustomer(customer: string): string {
  const value = customer.trim();
  if (value.length === 0 || value.length > 200) {
    throw new Error("Customer must be between 1 and 200 characters.");
  }
  return value;
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
  database.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      start TEXT NOT NULL UNIQUE,
      customer TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS approval_decisions (
      key TEXT PRIMARY KEY,
      approved INTEGER NOT NULL,
      by_name TEXT,
      note TEXT,
      request_json TEXT NOT NULL
    );
  `);

  const findByKey = database.prepare(
    "SELECT id, start, customer, idempotency_key FROM bookings WHERE idempotency_key = ?",
  );
  const insertBooking = database.prepare(
    "INSERT INTO bookings (id, start, customer, idempotency_key) VALUES (?, ?, ?, ?)",
  );
  const listBookings = database.prepare(
    "SELECT id, start, customer FROM bookings ORDER BY start, id",
  );
  const startsOnDate = database.prepare(
    "SELECT start FROM bookings WHERE start >= ? AND start <= ? ORDER BY start",
  );
  const findDecision = database.prepare(
    "SELECT approved, by_name AS by, note FROM approval_decisions WHERE key = ?",
  );
  const insertDecision = database.prepare(
    "INSERT INTO approval_decisions (key, approved, by_name, note, request_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING",
  );

  return {
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
    async book(start, customer, idempotencyKey) {
      validStart(start);
      const normalizedCustomer = validCustomer(customer);
      if (idempotencyKey.trim().length === 0) throw new Error("Idempotency key is required.");
      database.exec("BEGIN IMMEDIATE");
      try {
        const existing = findByKey.get(idempotencyKey) as BookingRow | undefined;
        if (existing !== undefined) {
          if (existing.start !== start || existing.customer !== normalizedCustomer) {
            throw new Error("Idempotency key was already used with different booking arguments.");
          }
          database.exec("COMMIT");
          return { id: existing.id, start: existing.start, customer: existing.customer };
        }
        const booking = { id: randomUUID(), start, customer: normalizedCustomer };
        insertBooking.run(booking.id, booking.start, booking.customer, idempotencyKey);
        database.exec("COMMIT");
        return booking;
      } catch (error) {
        database.exec("ROLLBACK");
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
