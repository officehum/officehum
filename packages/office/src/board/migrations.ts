/**
 * Board schema migrations (RASF-3066).
 *
 * `PRAGMA user_version` drives an ordered list, like the shape pivot in `calendar-store.ts`. Each step
 * runs inside its own `BEGIN IMMEDIATE`, and the version advances only after that step commits — so a
 * crash mid-migration rolls the step back and the next open re-runs it. Every statement is
 * `IF NOT EXISTS` as a second line of defence, for a database written before the version was set.
 *
 * Expand-then-contract: a step may only add. A rename or a drop belongs in a later step, so a host
 * that opens a database written by an older build still finds every column it reads.
 *
 * No foreign keys and no `PRAGMA foreign_keys` — the same choice `calendar-store.ts` makes
 * (`booking_id` is plain TEXT, integrity is the caller's). `assignee` is deliberately polymorphic (an
 * agent id or a `people.id`), and the API validates parent and person ids at write time.
 */
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly version: number;
  up(database: DatabaseSync): void;
}

/**
 * Migration 1 creates every table the workboard needs, plus the indexes the API's read paths use.
 *
 * `ticket_events` and `comments` are append-only, and that is enforced by triggers rather than by
 * convention: immutability the API alone honours is not immutability, because the relay (RASF-3067),
 * a CLI and a test all hold the same handle. The triggers bite any holder of it.
 */
function createWorkboard(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,                  -- uuid, minted by the API
      type TEXT NOT NULL,                   -- dotted, e.g. invoice.create
      title TEXT NOT NULL,
      detail TEXT,
      payload TEXT NOT NULL DEFAULT '{}',   -- JSON
      status TEXT NOT NULL CHECK (status IN ('open','claimed','waiting','blocked','done','cancelled')),
      assignee TEXT,                        -- agent id or people.id (polymorphic, no FK)
      created_by TEXT NOT NULL,
      parent_id TEXT,
      workflow_run_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tickets_parent ON tickets (parent_id);
    CREATE INDEX IF NOT EXISTS tickets_assignee ON tickets (assignee);
    CREATE INDEX IF NOT EXISTS tickets_status ON tickets (status);

    -- The caller-key ledger, separate from tickets so the key outlives any rekey or re-import.
    CREATE TABLE IF NOT EXISTS ticket_keys (
      caller_key TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, request_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ticket_events (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL UNIQUE,          -- monotonic cursor for events(after); never reused
      ticket_id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT,
      payload TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ticket_events_ticket ON ticket_events (ticket_id, seq);

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, author TEXT NOT NULL,
      body TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comments_ticket ON comments (ticket_id);

    CREATE TABLE IF NOT EXISTS provenance (
      ticket_id TEXT PRIMARY KEY,
      origin TEXT NOT NULL CHECK (origin IN ('internal','external')),
      source_channel TEXT NOT NULL, source_contact TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS budgets (
      ticket_id TEXT PRIMARY KEY,
      max_tokens INTEGER, max_usd_cents INTEGER,      -- NULL = uncapped
      used_tokens INTEGER NOT NULL DEFAULT 0, used_usd_cents INTEGER NOT NULL DEFAULT 0,
      hop_count INTEGER NOT NULL DEFAULT 0, max_hops INTEGER NOT NULL DEFAULT 4
    );

    -- Minimal, owned by RASF-3073 which expands it by migration; enough for the inbox to record a wait.
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, approval_id TEXT NOT NULL, tool TEXT NOT NULL,
      args_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','approved','declined')),
      decided_by TEXT, decided_at TEXT, decided_note TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS approvals_ticket ON approvals (ticket_id);

    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, roles TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TRIGGER IF NOT EXISTS ticket_events_append_only_update
    BEFORE UPDATE ON ticket_events BEGIN
      SELECT RAISE(ABORT, 'ticket_events is append-only: append a new event instead');
    END;
    CREATE TRIGGER IF NOT EXISTS ticket_events_append_only_delete
    BEFORE DELETE ON ticket_events BEGIN
      SELECT RAISE(ABORT, 'ticket_events is append-only: append a new event instead');
    END;
    CREATE TRIGGER IF NOT EXISTS comments_append_only_update
    BEFORE UPDATE ON comments BEGIN
      SELECT RAISE(ABORT, 'comments is append-only: append a new comment instead');
    END;
    CREATE TRIGGER IF NOT EXISTS comments_append_only_delete
    BEFORE DELETE ON comments BEGIN
      SELECT RAISE(ABORT, 'comments is append-only: append a new comment instead');
    END;
  `);
}

/**
 * Migration 2 adds the relay's cursor, its delivery ledger and its wait index (RASF-3067).
 *
 * These live here, in the office's own file, rather than in a table of their own or in Pi Durable's
 * per-conversation dedup: dedup scoped to a conversation disappears when that conversation is
 * replaced or rewound, which is exactly the case the relay's ledger is meant to survive. The cursor
 * and the ledger are two views of one fact — "everything at or below `seq` has a ledger row" — so the
 * relay writes both in one transaction and can always tell an undelivered event from a delivered one.
 *
 * The three tables are additive only, as expand-then-contract requires; nothing here reads a column
 * a later migration might drop. `relay_deliveries.state` is the delivery's whole lifecycle
 * (`pending` → `admitted` → `settled`/`failed`, or straight to `skipped`), so recovery never has to
 * infer it from the cursor.
 */
function createRelay(database: DatabaseSync): void {
  database.exec(`
    -- One row, id = 1: the highest event seq the relay has accounted for. A missing row is seq 0.
    CREATE TABLE IF NOT EXISTS relay_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO relay_cursor (id, seq) VALUES (1, 0);

    -- One row per event at or below the cursor. 'target_key' is the conversation the event would go
    -- to ('' when there is no delivery); 'submission_id' is Pi Durable's admission, so a restart can
    -- reacquire it. 'outcome' is the settled answer, or why a delivery failed.
    CREATE TABLE IF NOT EXISTS relay_deliveries (
      event_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      ticket_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_key TEXT NOT NULL,
      submission_id INTEGER,
      state TEXT NOT NULL CHECK (state IN ('pending','admitted','settled','skipped','failed')),
      outcome TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS relay_deliveries_ticket ON relay_deliveries (ticket_id);
    CREATE INDEX IF NOT EXISTS relay_deliveries_state ON relay_deliveries (state);

    -- The durable wait's task, keyed by ticket so a restart re-finds it without the cursor.
    CREATE TABLE IF NOT EXISTS relay_waits (
      ticket_id TEXT PRIMARY KEY,
      task_id INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      deadline_ms INTEGER
    );
  `);
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, up: createWorkboard },
  { version: 2, up: createRelay },
];

for (const [index, migration] of MIGRATIONS.entries()) {
  if (migration.version !== index + 1) {
    throw new Error("Board migrations must be numbered contiguously from 1.");
  }
}

function userVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * Applies every migration newer than the database's `user_version` and returns the version now at the
 * head. Opening a database written by a newer build is a refusal, not a guess: this build would read
 * columns it does not know about and write rows the newer one cannot see.
 */
export function applyMigrations(database: DatabaseSync): number {
  const current = userVersion(database);
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Board database is at user_version ${current} but this build knows ${MIGRATIONS.length} migrations; upgrade Office Hum before opening it.`,
    );
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      migration.up(database);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }
  return userVersion(database);
}
