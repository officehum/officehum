import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export interface Booking {
  readonly id: string;
  readonly start: string;
  readonly customer: string;
}

export interface Cancellation {
  readonly id: string;
  readonly status: "canceled";
  readonly alreadyCanceled: boolean;
}

export type CalendarOperationKind = "book" | "reschedule" | "cancel";
export type CalendarOperationResult = Booking | Cancellation;

export interface CalendarOperation {
  readonly key: string;
  readonly kind: CalendarOperationKind;
  readonly argsJson: string;
  readonly bookingId?: string;
  readonly booking?: Booking;
  readonly result?: CalendarOperationResult;
}

export interface CalendarStore {
  operation(key: string): CalendarOperation | undefined;
  bindOperation(key: string, kind: CalendarOperationKind, argsJson: string): CalendarOperation;
  captureBooking(key: string, booking: Booking): void;
  completeOperation(key: string, result: CalendarOperationResult): void;
  canceledBooking(id: string): Cancellation | undefined;
}

type OperationRow = {
  key: string;
  kind: string;
  args_json: string;
  booking_id: string | null;
  booking_json: string | null;
  result_json: string | null;
};

type LegacyBooking = {
  id: string;
  start: string;
  customer: string;
  idempotency_key: string;
};

const KINDS = new Set<CalendarOperationKind>(["book", "reschedule", "cancel"]);
const LEGACY_COLUMNS = ["id", "start", "customer", "idempotency_key"];
const CURRENT_COLUMNS = ["id", "original_start", "start", "customer", "idempotency_key", "status"];

function bounded(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 500) {
    throw new Error(`${label} must be between 1 and 500 characters.`);
  }
  return normalized;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseBooking(value: unknown, label: string): Booking {
  const record = object(value);
  if (
    record === undefined ||
    Object.keys(record).sort().join(",") !== "customer,id,start" ||
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    typeof record.start !== "string" ||
    record.start.length === 0 ||
    typeof record.customer !== "string" ||
    record.customer.length === 0
  ) {
    throw new Error(`Calendar operation contains malformed ${label}.`);
  }
  return { id: record.id, start: record.start, customer: record.customer };
}

function parseResult(value: unknown): CalendarOperationResult {
  const record = object(value);
  if (record?.status === "canceled") {
    if (
      Object.keys(record).sort().join(",") !== "alreadyCanceled,id,status" ||
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      typeof record.alreadyCanceled !== "boolean"
    ) {
      throw new Error("Calendar operation contains malformed result JSON.");
    }
    return { id: record.id, status: "canceled", alreadyCanceled: record.alreadyCanceled };
  }
  return parseBooking(value, "result JSON");
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Calendar operation contains malformed ${label}.`);
  }
}

function operationFromRow(row: OperationRow): CalendarOperation {
  if (!KINDS.has(row.kind as CalendarOperationKind)) {
    throw new Error("Calendar operation contains malformed kind data.");
  }
  const booking =
    row.booking_json === null
      ? undefined
      : parseBooking(parseJson(row.booking_json, "booking JSON"), "booking JSON");
  const result =
    row.result_json === null ? undefined : parseResult(parseJson(row.result_json, "result JSON"));
  return {
    key: row.key,
    kind: row.kind as CalendarOperationKind,
    argsJson: row.args_json,
    ...(row.booking_id === null ? {} : { bookingId: row.booking_id }),
    ...(booking === undefined ? {} : { booking }),
    ...(result === undefined ? {} : { result }),
  };
}

function tableColumns(database: DatabaseSync, table: string): string[] | undefined {
  const exists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (exists === undefined) return undefined;
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    ({ name }) => name,
  );
}

function sameColumns(actual: string[] | undefined, expected: readonly string[]): boolean {
  return actual !== undefined && JSON.stringify(actual) === JSON.stringify(expected);
}

function createApprovalTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS approval_decisions (
      key TEXT PRIMARY KEY,
      approved INTEGER NOT NULL,
      by_name TEXT,
      note TEXT,
      request_json TEXT NOT NULL
    );
  `);
}

function createOperationTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS calendar_operations (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('book', 'reschedule', 'cancel')),
      args_json TEXT NOT NULL,
      booking_id TEXT,
      booking_json TEXT,
      result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS calendar_operations_canceled
      ON calendar_operations (booking_id, kind) WHERE result_json IS NOT NULL;
  `);
}

function createCurrentBookings(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE bookings (
      id TEXT PRIMARY KEY,
      original_start TEXT NOT NULL,
      start TEXT NOT NULL,
      customer TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('active', 'canceled'))
    );
    CREATE UNIQUE INDEX bookings_active_start ON bookings (start) WHERE status = 'active';
  `);
}

function legacyRows(database: DatabaseSync): LegacyBooking[] {
  return database
    .prepare(
      "SELECT id, start, customer, idempotency_key FROM bookings ORDER BY id, start, customer, idempotency_key",
    )
    .all() as unknown as LegacyBooking[];
}

function approvalRows(database: DatabaseSync): unknown[] {
  if (tableColumns(database, "approval_decisions") === undefined) return [];
  return database
    .prepare(
      "SELECT key, approved, by_name, note, request_json FROM approval_decisions ORDER BY key",
    )
    .all();
}

function legacyEvidence(database: DatabaseSync): string {
  return JSON.stringify({ bookings: legacyRows(database), approvals: approvalRows(database) });
}

function migrateLegacyInTransaction(database: DatabaseSync): void {
  const beforeBookings = legacyRows(database);
  const beforeApprovals = approvalRows(database);
  const normalizedKeys = new Set<string>();
  for (const row of beforeBookings) {
    const normalized = bounded(row.idempotency_key, "Legacy booking key");
    if (normalized !== row.idempotency_key || normalizedKeys.has(normalized)) {
      throw new Error("Legacy booking keys are ambiguous after required key normalization.");
    }
    normalizedKeys.add(normalized);
  }
  database.exec("ALTER TABLE bookings RENAME TO bookings_legacy");
  createCurrentBookings(database);
  database.exec(`
    INSERT INTO bookings (id, original_start, start, customer, idempotency_key, status)
      SELECT id, start, start, customer, idempotency_key, 'active' FROM bookings_legacy;
    DROP TABLE bookings_legacy;
  `);
  createOperationTable(database);
  const insertOperation = database.prepare(
    "INSERT INTO calendar_operations (key, kind, args_json, booking_id, result_json) VALUES (?, 'book', ?, ?, ?)",
  );
  for (const row of beforeBookings) {
    const booking: Booking = { id: row.id, start: row.start, customer: row.customer };
    insertOperation.run(
      row.idempotency_key,
      JSON.stringify({ kind: "book", start: row.start, customer: row.customer }),
      row.id,
      JSON.stringify(booking),
    );
  }
  const afterBookings = database
    .prepare(
      "SELECT id, start, customer, idempotency_key FROM bookings ORDER BY id, start, customer, idempotency_key",
    )
    .all();
  if (
    JSON.stringify(afterBookings) !== JSON.stringify(beforeBookings) ||
    JSON.stringify(approvalRows(database)) !== JSON.stringify(beforeApprovals)
  ) {
    throw new Error("Calendar migration verification failed.");
  }
  database.exec("PRAGMA user_version = 2");
}

function migrateLegacyAttempt(database: DatabaseSync, file: string): void {
  if (file === ":memory:") throw new Error("Legacy in-memory calendars cannot be migrated safely.");
  let backup: string;
  do backup = `${file}.backup-${Date.now()}-${randomUUID()}.sqlite`;
  while (existsSync(backup));
  database.prepare("VACUUM INTO ?").run(backup);

  const dryRun = `${backup}.dryrun-${randomUUID()}.sqlite`;
  copyFileSync(backup, dryRun, 0);
  try {
    const Database = database.constructor as new (path: string) => DatabaseSync;
    const disposable = new Database(dryRun);
    try {
      disposable.exec("BEGIN IMMEDIATE");
      migrateLegacyInTransaction(disposable);
      const integrity = disposable.prepare("PRAGMA integrity_check").get() as
        | { integrity_check: string }
        | undefined;
      if (integrity?.integrity_check !== "ok")
        throw new Error("Calendar migration integrity failed.");
      disposable.exec("COMMIT");
    } catch (error) {
      if (disposable.isTransaction) disposable.exec("ROLLBACK");
      throw error;
    } finally {
      disposable.close();
    }
  } finally {
    rmSync(dryRun, { force: true });
  }

  const Database = database.constructor as new (
    path: string,
    options?: { readOnly?: boolean },
  ) => DatabaseSync;
  const snapshot = new Database(backup, { readOnly: true });
  let expected: string;
  try {
    expected = legacyEvidence(snapshot);
  } finally {
    snapshot.close();
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!sameColumns(tableColumns(database, "bookings"), LEGACY_COLUMNS)) {
      throw new Error("Calendar schema changed while migration was prepared.");
    }
    if (legacyEvidence(database) !== expected) {
      throw new Error("Calendar data changed while migration was prepared.");
    }
    migrateLegacyInTransaction(database);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function migrateLegacy(database: DatabaseSync, file: string): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      migrateLegacyAttempt(database, file);
      return;
    } catch (error) {
      const drift =
        error instanceof Error &&
        /Calendar (schema|data) changed while migration was prepared/.test(error.message);
      if (!drift || attempt === 2) throw error;
    }
  }
}

function prepareSchema(database: DatabaseSync, file: string): void {
  const bookingColumns = tableColumns(database, "bookings");
  const approvalColumns = tableColumns(database, "approval_decisions");
  if (
    approvalColumns !== undefined &&
    !sameColumns(approvalColumns, ["key", "approved", "by_name", "note", "request_json"])
  ) {
    throw new Error("Unrecognized calendar approval schema.");
  }
  if (bookingColumns === undefined) {
    database.exec("BEGIN IMMEDIATE");
    try {
      createCurrentBookings(database);
      createApprovalTable(database);
      createOperationTable(database);
      database.exec("PRAGMA user_version = 2; COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
    return;
  }
  if (approvalColumns === undefined) {
    throw new Error("Unrecognized calendar approval schema.");
  }
  if (sameColumns(bookingColumns, LEGACY_COLUMNS)) {
    migrateLegacy(database, file);
    return;
  }
  if (!sameColumns(bookingColumns, CURRENT_COLUMNS)) {
    throw new Error("Unrecognized calendar booking schema.");
  }
  createOperationTable(database);
  database.exec("PRAGMA user_version = 2");
}

export function openCalendarStore(database: DatabaseSync, file: string): CalendarStore {
  prepareSchema(database, file);
  const find = database.prepare(
    "SELECT key, kind, args_json, booking_id, booking_json, result_json FROM calendar_operations WHERE key = ?",
  );
  const insert = database.prepare(
    "INSERT INTO calendar_operations (key, kind, args_json) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING",
  );
  const capture = database.prepare(
    "UPDATE calendar_operations SET booking_id = ?, booking_json = ? WHERE key = ? AND booking_json IS NULL",
  );
  const complete = database.prepare(
    "UPDATE calendar_operations SET booking_id = COALESCE(booking_id, ?), result_json = ? WHERE key = ? AND result_json IS NULL",
  );
  const canceled = database.prepare(
    "SELECT key, kind, args_json, booking_id, booking_json, result_json FROM calendar_operations WHERE booking_id = ? AND kind = 'cancel' AND result_json IS NOT NULL ORDER BY rowid LIMIT 1",
  );

  const operation = (key: string): CalendarOperation | undefined => {
    const row = find.get(bounded(key, "Operation key")) as OperationRow | undefined;
    return row === undefined ? undefined : operationFromRow(row);
  };

  return {
    operation,
    bindOperation(keyValue, kind, argsJson) {
      const key = bounded(keyValue, "Operation key");
      if (!KINDS.has(kind)) throw new Error("Unknown calendar operation kind.");
      parseJson(argsJson, "argument JSON");
      insert.run(key, kind, argsJson);
      const bound = operation(key);
      if (bound === undefined) throw new Error("Failed to bind calendar operation.");
      if (bound.kind !== kind || bound.argsJson !== argsJson) {
        throw new Error("Operation key was already used with different calendar arguments.");
      }
      return bound;
    },
    captureBooking(key, booking) {
      const normalized = parseBooking(booking, "booking snapshot");
      capture.run(normalized.id, JSON.stringify(normalized), bounded(key, "Operation key"));
      const bound = operation(key);
      if (bound === undefined) throw new Error("Calendar operation was not bound.");
      if (JSON.stringify(bound.booking) !== JSON.stringify(normalized)) {
        throw new Error("Calendar operation already captured a different booking.");
      }
    },
    completeOperation(key, resultValue) {
      const result = parseResult(resultValue);
      complete.run(result.id, JSON.stringify(result), bounded(key, "Operation key"));
      const bound = operation(key);
      if (bound === undefined) throw new Error("Calendar operation was not bound.");
      if (JSON.stringify(bound.result) !== JSON.stringify(result)) {
        throw new Error("Calendar operation already completed with a different result.");
      }
    },
    canceledBooking(idValue) {
      const id = bounded(idValue, "Booking ID");
      const row = canceled.get(id) as OperationRow | undefined;
      if (row === undefined) return undefined;
      const result = operationFromRow(row).result;
      if (result === undefined || !("status" in result) || result.id !== id) {
        throw new Error("Calendar operation contains malformed cancellation evidence.");
      }
      return result;
    },
  };
}
