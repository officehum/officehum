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
import { canonicalArgs, hashOfCanonical } from "./approvals.js";

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

/**
 * Migration 4 adds spend accounting (RASF-3141): the call counters every ticket's budget needed, the
 * ledger that makes a charge exactly once per call, and the conversation→ticket binding the mid-turn
 * hook reads.
 *
 * `spend_ledger` is keyed by the *call*, not by the ticket: a charge is one fact about one call, so a
 * replayed call — a recovered run that re-executes the attempt, a retried tool call — finds its own row
 * and adds nothing. That is the whole of the crash story: the row and the incremented counters commit
 * together, so a crash either lands both or neither, and a second attempt at the same call is a no-op
 * rather than a second charge.
 *
 * It is append-only by trigger, like `ticket_events`: a ledger a caller can edit is not a ledger, and
 * "one row per call" is the property a reviewer will try to break first.
 *
 * `ticket_conversations` is the binding, written by the relay in the commit that opens a delivery:
 * Pi Durable's tool hooks see a `conversationId` and nothing else, so the conversation itself has to
 * carry the ticket it is working and the role it belongs to. It lives here, beside the counters,
 * because a charge and its ticket must commit or fail together — a document in the harness store
 * would be a second record that can disagree with this one.
 */
function addSpendAccounting(database: DatabaseSync): void {
  database.exec(`
    -- NULL max_calls is uncapped, matching max_tokens and max_usd_cents. The two columns land after
    -- max_hops because ALTER TABLE appends; a reader must not assume a position either way.
    ALTER TABLE budgets ADD COLUMN used_calls INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE budgets ADD COLUMN max_calls INTEGER;

    -- One row per charged call. 'agent' is the role that spent it, so a reader can total a day per
    -- agent without guessing from a ticket's current assignee, which moves.
    CREATE TABLE IF NOT EXISTS spend_ledger (
      call_id TEXT NOT NULL,
      -- Admission and usage are two observations of one call, deduped separately: keying both on the
      -- call id alone meant the first row silenced the second, so a tool's tokens were never charged.
      kind TEXT NOT NULL CHECK (kind IN ('call', 'usage')),
      ticket_id TEXT NOT NULL,
      agent TEXT,
      calls INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      usd_cents INTEGER NOT NULL DEFAULT 0,
      at TEXT NOT NULL,
      PRIMARY KEY (call_id, kind)
    );
    CREATE INDEX IF NOT EXISTS spend_ledger_ticket ON spend_ledger (ticket_id);
    CREATE INDEX IF NOT EXISTS spend_ledger_agent ON spend_ledger (agent, at);

    CREATE TABLE IF NOT EXISTS ticket_conversations (
      conversation_id INTEGER PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      agent TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ticket_conversations_ticket ON ticket_conversations (ticket_id);

    CREATE TRIGGER IF NOT EXISTS spend_ledger_append_only_update
    BEFORE UPDATE ON spend_ledger BEGIN
      SELECT RAISE(ABORT, 'spend_ledger is append-only: charge a new call instead');
    END;
    CREATE TRIGGER IF NOT EXISTS spend_ledger_append_only_delete
    BEFORE DELETE ON spend_ledger BEGIN
      SELECT RAISE(ABORT, 'spend_ledger is append-only: charge a new call instead');
    END;
  `);
}

/**
 * Migration 5 rebuilds `approvals` (RASF-3138): the exact arguments an approval covers, who asked,
 * who is asked, when the wait ends, and the two ways a wait can end without a person — `expired` and
 * `cancelled`.
 *
 * Why a rebuild rather than the `ALTER TABLE ADD COLUMN` every earlier step uses: SQLite cannot alter
 * a CHECK constraint, and the one migration 1 wrote admits only `waiting`, `approved` and `declined`.
 * A cancelled or expired approval is a row the schema must be able to hold, or the API would have to
 * delete a request to end its wait — losing the record that a person was ever asked. The table is
 * created fresh, copied row by row (so `args_hash` can be computed from each row's own arguments),
 * dropped and renamed.
 *
 * This is expand-only in spirit, which is the part that matters to a host: no column is dropped and
 * none changes meaning. The new columns are appended after the old ones, old rows keep their ids,
 * decisions and timestamps, and a row not yet waiting on a person is the only thing that can move —
 * `expired` and `cancelled` are legal values, never a rewrite of what somebody decided.
 *
 * `args_hash` is computed here rather than left NULL, so a decision taken before this upgrade still
 * covers the arguments it was taken about. A legacy row whose `args_json` will not parse cannot be
 * given a hash that any call would match; it is kept verbatim, hashed as its raw text (which matches
 * nothing the API computes) and, if it was still waiting, closed as `cancelled` with a note saying
 * why. Failing closed and keeping the record beats a migration that invents an approval.
 */
function rebuildApprovals(database: DatabaseSync): void {
  type LegacyApproval = {
    id: string;
    ticket_id: string;
    approval_id: string;
    tool: string;
    args_json: string;
    status: string;
    decided_by: string | null;
    decided_at: string | null;
    decided_note: string | null;
    created_at: string;
  };
  const legacy = database.prepare("SELECT * FROM approvals").all() as LegacyApproval[];

  database.exec(`
    CREATE TABLE approvals_v5 (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      approval_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      args_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting','approved','declined','expired','cancelled')),
      decided_by TEXT, decided_at TEXT, decided_note TEXT,
      created_at TEXT NOT NULL,
      args_hash TEXT NOT NULL,              -- sha256 of the canonical args_json
      requested_by TEXT,                    -- null on rows written before a requester was recorded
      assignee TEXT,                        -- the people.id asked, when one was named
      expires_at TEXT                       -- deadline for the decision; null waits
    );
  `);

  const insert = database.prepare(
    `INSERT INTO approvals_v5
       (id, ticket_id, approval_id, tool, args_json, status, decided_by, decided_at, decided_note,
        created_at, args_hash, requested_by, assignee, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  );
  for (const row of legacy) {
    let argsJson = row.args_json;
    let hash: string;
    let status = row.status;
    let note = row.decided_note;
    try {
      argsJson = canonicalArgs(JSON.parse(row.args_json));
      hash = hashOfCanonical(argsJson);
    } catch {
      hash = hashOfCanonical(row.args_json);
      if (status === "waiting") {
        status = "cancelled";
        note = "arguments could not be read when the approvals table was rebuilt";
      }
    }
    insert.run(
      row.id,
      row.ticket_id,
      row.approval_id,
      row.tool,
      argsJson,
      status,
      row.decided_by,
      row.decided_at,
      note,
      row.created_at,
      hash,
    );
  }

  database.exec(`
    -- Two identical asks while both wait are one ask; the later one is cancelled rather than dropped,
    -- so the record still says a person was asked twice. Nothing in this build wrote the old table, so
    -- this is the hand-edited case, and it must not stop the unique index below from being created.
    UPDATE approvals_v5
       SET status = 'cancelled',
           decided_note = 'an identical request on the same ticket was already waiting'
     WHERE status = 'waiting'
       AND rowid NOT IN (
         SELECT MIN(rowid) FROM approvals_v5 WHERE status = 'waiting'
          GROUP BY ticket_id, tool, args_hash
       );

    DROP TABLE approvals;
    ALTER TABLE approvals_v5 RENAME TO approvals;

    CREATE INDEX IF NOT EXISTS approvals_ticket ON approvals (ticket_id);
    -- One waiting ask per (ticket, tool, arguments), enforced by the file rather than by the caller:
    -- a model that retries every turn cannot grow the inbox by one row per retry. Partial, because a
    -- decided request may legitimately be re-asked for the same call later.
    CREATE UNIQUE INDEX IF NOT EXISTS approvals_waiting
      ON approvals (ticket_id, tool, args_hash) WHERE status = 'waiting';

    -- The first decision stands, whoever writes second. The API refuses a second decision before it
    -- reaches SQL; this trigger is the line that holds for a writer that never went through the API.
    CREATE TRIGGER IF NOT EXISTS approvals_decision_immutable
    BEFORE UPDATE ON approvals
    WHEN OLD.status IN ('approved','declined','expired','cancelled')
    BEGIN
      SELECT RAISE(ABORT, 'approvals decision is immutable: a decided request cannot be changed');
    END;
  `);
}

/**
 * Migration 6 adds the inbound SMS intake tables (RASF-3162).
 *
 * Three facts, and no fourth: a message arrived (once), a number last said STOP or START, and a number
 * has sent N messages in one window. They live in this file rather than in the channel package because
 * the board is the one durable authority about this company's customers — a second SQLite file beside
 * it would be a second record that can disagree with the first, and it would need a second writer.
 *
 * `sms_inbound` is keyed by the provider's MessageSid because that is the unit of retry. Twilio
 * redelivers a webhook it did not get a 2xx for, and the redelivery carries the same id; a primary key
 * is what makes "the second delivery is the same message" a fact of the file rather than a check some
 * caller might forget. It is not append-only by trigger: nothing updates it, so the trigger would guard
 * a write no code makes, and a duplicate arriving is the insert being ignored rather than a refusal.
 *
 * `sms_optouts` is a switch, not a ledger: a person may say STOP and later START, and the row holds the
 * latest word with the time it was said. Append-only triggers would force a latest-per-number read and
 * a table that grows one row per keyword, for a state that is genuinely one value.
 *
 * `sms_rate` is one counter per `(number, window_start)`, so an increment is one upsert and the ceiling
 * needs no sweep to forget old windows.
 */
function addSmsIntake(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sms_inbound (
      message_sid TEXT PRIMARY KEY,         -- the provider's id; the duplicate guard
      received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sms_optouts (
      number TEXT PRIMARY KEY,              -- E.164, as the provider sent it
      state TEXT NOT NULL CHECK (state IN ('stop','start')),
      at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sms_rate (
      number TEXT NOT NULL,
      window_start TEXT NOT NULL,           -- first instant of the window's bucket
      count INTEGER NOT NULL,
      PRIMARY KEY (number, window_start)
    );
  `);
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, up: createWorkboard },
  { version: 2, up: createRelay },
  { version: 3, up: addTicketResult },
  { version: 4, up: addSpendAccounting },
  { version: 5, up: rebuildApprovals },
  { version: 6, up: addSmsIntake },
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

/**
 * The result a ticket closed with. `complete` used to only move the status, so a delegate's answer
 * lived only in its own transcript — readable by the delegator, but not the thing the delegate said it
 * was replying with. A tool argument that the host discards is a lie in the tool's schema.
 */
function addTicketResult(database: DatabaseSync): void {
  database.exec("ALTER TABLE tickets ADD COLUMN result TEXT");
}
