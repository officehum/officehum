# Plan: Workboard tables and events (RASF-3066)

Design only. Implementer writes `packages/office/src/board/` from this. No production `.ts` in this change.

## Contract

The issue cites a platform spec section "Workboard data model". **It is not in this repository** — no
such section exists under `docs/` or `packages/`. The issue's schema list and Rules are the contract.
Where the contract is silent (caller-key storage, event cursor, approvals shape) this plan adds a
minimal column/table and marks it `[addition]` with the reason. Ticket types are dotted
(`invoice.create`), per the repo's existing `TicketType` convention.

## (a) Storage: sibling `board.sqlite`, not Pi Durable's store

Plain `node:sqlite` `DatabaseSync` at `join(directory, "board.sqlite")` — the same `directory`
`openSolo`/`--state` uses, next to `calendar.sqlite`. Never Pi's harness store, because: (1) one process
owns Pi's store and its per-conversation dedup "disappears if a role conversation is replaced or rotated"
(RASF-3067 relay needs a ledger that survives rotation/rewind); (2) relay and agent tools read/write it
with no harness, and tests need no harness.

Host supplies the path via `openBoard(file: string): Board`. It `mkdirSync(dirname)`, opens
`DatabaseSync(file)`, sets `busy_timeout = 5000; synchronous = FULL; journal_mode = WAL` (same as
`local-calendar.ts`), runs migrations, returns a handle with `close()`. Tests: a temp file under
`mkdtempSync(join(tmpdir(), "officehum-board-"))` for persist/reopen cases; `":memory:"` for migration
cases (allowed — no legacy data to migrate).

## (b) Migrations: numbered, idempotent, expand-then-contract

`PRAGMA user_version`-driven ordered list, applied in one `BEGIN IMMEDIATE` — the same pivot
`calendar-store.ts` uses (`PRAGMA user_version = 2`), upgraded from its shape-detection to a list.
`const MIGRATIONS: readonly { version: number; up(db): void }[]`, contiguous from 1. On open: for each
`version > user_version`, run `up` in `BEGIN IMMEDIATE`, set `user_version`, `COMMIT`. A crash rolls back
and re-runs; idempotent because the version only advances after success, with `IF NOT EXISTS` as a
backstop. Expand-then-contract: a migration only adds; a later one only drops/renames. This issue ships
migration 1 only (create all tables).

```sql
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,                  -- uuid, minted by API
  type TEXT NOT NULL,                   -- dotted
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

-- [addition] dedup ledger (mirrors calendar_operations.key); separate so the key outlives any rekey.
CREATE TABLE IF NOT EXISTS ticket_keys (
  caller_key TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, request_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_events (  -- append-only, see (c)
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,          -- [addition] monotonic cursor for events(after)
  ticket_id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT,
  payload TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_events_ticket ON ticket_events (ticket_id, seq);

CREATE TABLE IF NOT EXISTS comments (       -- append-only
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

-- Minimal, owned by RASF-3073 which EXPANDS it by migration; enough for the inbox to record a wait.
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, approval_id TEXT NOT NULL, tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','approved','declined')),
  decided_by TEXT, decided_at TEXT, decided_note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_ticket ON approvals (ticket_id);

CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, roles TEXT NOT NULL DEFAULT '[]');
```

No `PRAGMA foreign_keys`, no FK columns — consistent with `calendar-store.ts` (plain TEXT `booking_id`,
integrity enforced in code). The API validates `parent_id` and person ids at write time.

## (c) Append-only `ticket_events`/`comments` — enforced, not documented

1. **API is the only writer**: `Board` never emits UPDATE/DELETE on these tables, only INSERT; only
   `tickets.status/assignee` and `budgets.*` mutate, via named statements.
2. **Triggers**: migration 1 installs `BEFORE UPDATE`/`BEFORE DELETE` triggers on both tables that
   `SELECT RAISE(ABORT, '…append-only')` — they bite any holder of the handle.
3. **Boundary guard**: a colocated test asserts `openBoard`/`board.sqlite` is referenced only by
   `packages/office/src/board/` (node:sqlite stays allowed elsewhere).

An attempted UPDATE/DELETE aborts that statement (trigger), rolls back the statement only, and the API
surfaces `BoardError { kind: "immutable" }`. A reopen test confirms the bytes survive.

## (d) Board API — signatures, typed errors, transactions

```ts
export type TicketStatus = "open" | "claimed" | "waiting" | "blocked" | "done" | "cancelled";
export type Origin = "internal" | "external";
export type Assignee = { readonly kind: "agent" | "person"; readonly id: string };
export type BoardErrorKind =
  | "not_found" | "invalid_status" | "unauthorized" | "duplicate_key"
  | "immutable" | "max_hops" | "invalid_person" | "invalid_argument";
export class BoardError extends Error {
  constructor(readonly kind: BoardErrorKind, m: string, readonly details?: unknown) { super(m); }
}

export interface NewTicket {
  readonly type: string; readonly title: string; readonly detail?: string; readonly payload?: unknown;
  readonly createdBy: string; readonly parentId?: string; readonly workflowRunId?: string;
  readonly provenance: { readonly origin: Origin; readonly sourceChannel: string; readonly sourceContact: string };
  readonly budget?: { readonly maxTokens?: number; readonly maxUsdCents?: number; readonly maxHops?: number };
  readonly assignee?: Assignee;                      // required when hop-exhausted (see (g))
}
export interface Ticket {
  readonly id: string; readonly type: string; readonly title: string; readonly detail: string | null;
  readonly payload: unknown; readonly status: TicketStatus; readonly assignee: string | null;
  readonly createdBy: string; readonly parentId: string | null; readonly workflowRunId: string | null;
  readonly createdAt: string; readonly updatedAt: string;
}
export interface TicketEvent {
  readonly id: string; readonly seq: number; readonly ticketId: string; readonly kind: string;
  readonly actor: string | null; readonly payload: unknown; readonly at: string;
}
export interface ListFilter {
  readonly status?: TicketStatus | readonly TicketStatus[];
  readonly assignee?: string; readonly parentId?: string; readonly type?: string; readonly limit?: number;
}

export interface Board {
  create(input: NewTicket, callerKey: string): Ticket;
  claim(ticketId: string, actor: string): Ticket;               // actor = agent claiming for itself
  comment(ticketId: string, author: string, body: string): string; // returns comment id
  complete(ticketId: string, actor: string): Ticket;
  cancel(ticketId: string, actor: string): Ticket;
  assign(ticketId: string, assignee: Assignee, actor: string): Ticket;
  get(ticketId: string): Ticket | undefined;
  list(filter?: ListFilter): Ticket[];
  events(ticketId: string, after?: number): TicketEvent[];      // after = last-seen seq
  close(): void;
}
```

All six mutating calls run inside `BEGIN IMMEDIATE … COMMIT` and append exactly one `ticket_events` row
in the same transaction (the Rules' invariant); `create` does its key dedup inside it too. Reads
(`get`, `list`, `events`) are plain SELECTs. Rollback path matches `local-calendar.ts`
(`catch { if isTransaction ROLLBACK; throw }`). Event kinds: `created`, `claimed`, `commented`,
`completed`, `cancelled`, `assigned`. A comment writes a `comments` row plus a `commented` event with
payload `{ "commentId": "<id>" }`. `seq = 1 + COALESCE(MAX(seq), 0)` inside the transaction (single
writer), so `events(after)` = `seq > after` ordered by `seq`.

## (e) Dedupe on a caller key

- **Scope**: the board (one `board.sqlite` = one office = one board). Caller-chosen, bounded/trimmed
  1…500 chars; empty/over-long throws `invalid_argument`.
- **Repeat**: same key returns the **same ticket unchanged** — same id, one event, one `ticket_keys` row.
- **Conflict**: key exists with a different canonical `request_json` (sorted-key stringify of `type`,
  `title`, `payload`, `createdBy`, `parentId`, `provenance`, requested budget) → throws `duplicate_key`
  (with existing id). Mirrors `bindOperation`'s "same key, different args". Persists across reopen.

## (f) Provenance and budget inheritance: resolve-then-materialize (copy)

At `create(parentId = P)`: **provenance** copies P's row verbatim (a supplied provenance on a child is
ignored — lineage is a fact, not caller-chosen; a root must supply it or `invalid_argument`). **Budget**
gets its own row; effective limits = `min(parent.limit, childRequested)` per field (narrow only; NULL =
uncapped). **Remaining budget** = `max_* − used_*` of the ticket; a child's ceiling = parent's remaining
(`parent.max − parent.used`), narrowed by the child's request. When the parent is itself a child,
`parent.max_*` is already its chain-narrowed ceiling and `parent.used_*` its subtree spend, so the
subtraction composes — the recursion walks by materialization, not by query; each read is one row.
**Usage charging is RASF-3074 (out of scope)**: this issue allocates `used_* = 0` and defines the column
semantics so 3074's ancestor roll-up (`UPDATE budgets SET used = used + ? WHERE ticket_id`, bounded by
max_hops) has a target.

## (g) Hop counting and `max_hops = 4`

Increment happens on `create` with a `parentId`: `child.hop_count = parent.hop_count + 1`; a root starts
at 0; `max_hops` inherits from the parent, default 4. **"Assigned to a person"** concretely =
`assignee.kind === "person"` and `assignee.id ∈ people.id` (a missing person id throws `invalid_person`);
an agent assignee is any id not in `people` (opaque until RASF-3109). When
`parent.hop_count + 1 > parent.max_hops`, the board **refuses an agent hop**: the call must carry
`assignee: { kind: "person", id }`, else it throws `max_hops`; the child is then created with status
`waiting` and that person as assignee. `hop_count == max_hops` is allowed; `+1 > max` is refused.

## (h) Status transitions

```
open → claimed | waiting | blocked | cancelled
claimed → waiting | blocked | done | cancelled
waiting → open | blocked | done | cancelled
blocked → open | claimed | cancelled
done, cancelled → terminal
```

- `create` → `open`; hop-exhausted person-assigned child → `waiting`.
- `claim(actor)`: `open` only → `claimed`, assignee = actor.
- `assign(x, actor)`: from `open|claimed|waiting|blocked`; agent → `claimed`, person → `waiting`.
- `comment(...)`: any ticket, including terminal (audit).
- `complete(actor)`: from `claimed|waiting|blocked`; **only the assignee or a person** (`actor ===
  assignee` or `actor ∈ people.id`), else `unauthorized`; `open`/unassigned not completable. Completion
  *evidence* is RASF-3230 (blocked by this issue); here it's the bare transition + `completed` event.
- `cancel(actor)`: any non-terminal, same authorization as `complete` (decision to note: the issue does
  not scope cancel, so it shares complete's rule).
- **Illegal**: any edge out of `done`/`cancelled`; `claim` from other than `open`; `complete`/`cancel`
  by an unauthorized actor → `invalid_status` (with `from`/`to`) or `unauthorized`.

## (i) Tests (colocated `board.test.ts`, `migrations.test.ts`)

Issue bullets → named tests:
1. every call writes exactly one event; update fails — "create appends exactly one created event in the
   same transaction"; "claim/comment/complete/cancel/assign append exactly one event, right kind+actor";
   "ticket_events refuses UPDATE and DELETE (trigger), unchanged after reopen"; "failed create leaves no
   orphan ticket/event (rollback)".
2. inheritance; hop limit — "child copies parent provenance"; "child inherits remaining budget
   (max 1000, used 300 → child max 700)"; "child narrows but never widens (min)"; "grandchild composes
   remaining through a child parent"; "hop_count increments 0→1→2"; "max_hops defaults to 4"; "hop
   exhausted requires a person (throws max_hops without one; succeeds with one, status waiting)";
   "hop_count == max is allowed, == max+1 refused".
3. auth and dedupe — "only assignee or a person completes (assignee ok, person ok, other agent
   unauthorized, unassigned only by person)"; "same key returns the same ticket, one event, one row";
   "same key, different payload throws duplicate_key".
4. migrations — "empty DB applies all migrations (user_version = 1) with expected columns"; "reopen is
   idempotent, preserves rows"; "dedup ledger survives reopen (same key → same ticket)".

Edge cases a reviewer will ask: empty/over-long caller key rejected; root without provenance rejected;
child with provenance ignored; assign to unknown person id rejected; two same-key creates never yield two
tickets (`BEGIN IMMEDIATE` serializes); `events(after)` strictly increasing, unknown `after` throws
`not_found`; two events in one millisecond order by `seq`, not `at`; `complete` from `open` or `done`
throws; comment allowed on a `done` ticket.

Out of scope: event delivery (RASF-3067), board UI (RASF-3075), budget accounting from usage (RASF-3074),
completion evidence (RASF-3230), approval semantics (RASF-3073).