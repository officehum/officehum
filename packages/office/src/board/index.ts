/**
 * The workboard: the office's shared record of work (RASF-3066).
 *
 * One SQLite file per office — `office.sqlite`, beside `calendar.sqlite` in the state directory the
 * caller already passes to `openSolo`. Pi Durable's own store is deliberately not used: a single
 * process owns it, and its per-conversation dedup disappears when a role conversation is replaced or
 * rotated — exactly when the relay (RASF-3067) needs the ledger to still be there. The relay, agent
 * tools and tests all read this file with no harness in the picture.
 *
 * Every write goes through this API, and every write runs in one `BEGIN IMMEDIATE … COMMIT` that also
 * appends the ticket's single event for that change: a reader sees the whole change or none of it, and
 * a call that fails leaves no orphan ticket, event, comment or key row. The append-only tables are
 * enforced by triggers as well (see `migrations.ts`), so immutability does not depend on callers being
 * polite.
 *
 * No agent-facing tools live here (that is RASF-3109), and nothing charges a budget: `used_*` stays 0
 * until usage accounting (RASF-3074) rolls it up, which is why the column semantics are defined even
 * though this issue never writes them.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "./migrations.js";
import { openRelayLedger, type RelayLedger } from "./relay-ledger.js";

export type TicketStatus = "open" | "claimed" | "waiting" | "blocked" | "done" | "cancelled";
export type Origin = "internal" | "external";
export type Assignee = { readonly kind: "agent" | "person"; readonly id: string };
export type BoardErrorKind =
  | "not_found"
  | "invalid_status"
  | "unauthorized"
  | "duplicate_key"
  | "immutable"
  | "max_hops"
  | "invalid_person"
  | "invalid_argument";

export class BoardError extends Error {
  constructor(
    readonly kind: BoardErrorKind,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "BoardError";
  }
}

export interface NewTicket {
  readonly type: string;
  readonly title: string;
  readonly detail?: string;
  readonly payload?: unknown;
  readonly createdBy: string;
  readonly parentId?: string;
  readonly workflowRunId?: string;
  readonly provenance: {
    readonly origin: Origin;
    readonly sourceChannel: string;
    readonly sourceContact: string;
  };
  readonly budget?: {
    readonly maxTokens?: number;
    readonly maxUsdCents?: number;
    readonly maxHops?: number;
  };
  readonly assignee?: Assignee;
}

export interface CompleteOptions {
  readonly result?: string;
}

export interface Ticket {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly detail: string | null;
  readonly payload: unknown;
  readonly status: TicketStatus;
  readonly assignee: string | null;
  readonly createdBy: string;
  readonly parentId: string | null;
  readonly workflowRunId: string | null;
  /** What the ticket was closed with, when the closer said. Null for tickets closed without one. */
  readonly result: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TicketEvent {
  readonly id: string;
  readonly seq: number;
  readonly ticketId: string;
  readonly kind: string;
  readonly actor: string | null;
  readonly payload: unknown;
  readonly at: string;
}

/** A person the office knows: work assigned to them leaves the harness. */
export interface Person {
  readonly id: string;
  readonly name: string;
}

/** A ticket's provenance row: where the work came from, copied verbatim to its children. */
export interface Provenance {
  readonly origin: Origin;
  readonly sourceChannel: string;
  readonly sourceContact: string;
}

export interface ListFilter {
  readonly status?: TicketStatus | readonly TicketStatus[];
  readonly assignee?: string;
  readonly parentId?: string;
  readonly type?: string;
  readonly limit?: number;
}

export interface Board {
  create(input: NewTicket, callerKey: string): Ticket;
  claim(ticketId: string, actor: string): Ticket;
  comment(ticketId: string, author: string, body: string): string;
  /**
   * Completes a ticket, recording the answer it was completed with. The answer is a board fact: a
   * delegator's wait reports it, and a wait that had to fall back to the delegate's transcript would
   * report whatever the model happened to write last.
   */
  complete(ticketId: string, actor: string, options?: CompleteOptions): Ticket;
  cancel(ticketId: string, actor: string): Ticket;
  assign(ticketId: string, assignee: Assignee, actor: string): Ticket;
  get(ticketId: string): Ticket | undefined;
  list(filter?: ListFilter): Ticket[];
  events(ticketId: string, after?: number): TicketEvent[];
  /**
   * Every event with `seq > after`, in the global `seq` order (RASF-3067). The relay's cursor is one
   * number for the whole board, so it needs the whole board's tail, not one ticket's.
   */
  eventsAfter(after: number): TicketEvent[];
  /**
   * Append a `stalled` event: a delivery the relay could not route and no person could take. It has
   * no status change of its own — the ticket is where it was — so it is not `assign` or `comment`.
   */
  stall(ticketId: string, actor: string, reason: string): TicketEvent;
  /** Everyone the office knows, in the order they were added. The relay's person fallback reads it. */
  people(): Person[];
  /** The ticket's provenance row, or `undefined` when it has none. */
  provenance(ticketId: string): Provenance | undefined;
  /** The relay's cursor, delivery ledger and wait index, over this board's handle. */
  readonly relay: RelayLedger;
  close(): void;
}

/** The manifest's `TicketType` pattern (`@officehum/sdk`): at least one dot, lowercase, underscored. */
const TICKET_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const STATUSES: readonly TicketStatus[] = [
  "open",
  "claimed",
  "waiting",
  "blocked",
  "done",
  "cancelled",
];
/** Statuses a ticket can be moved out of; `done` and `cancelled` are terminal. */
const TERMINAL: readonly TicketStatus[] = ["done", "cancelled"];
/** A ticket is completable only once someone is working on it. `open` and unassigned work is not. */
const COMPLETABLE: readonly TicketStatus[] = ["claimed", "waiting", "blocked"];
const DEFAULT_MAX_HOPS = 4;
/** `list` default and cap. A bigger request is clamped, not rejected: a reader paging a large board
 * should not have to discover the cap by failing. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** Comment bodies and ticket detail are prose; the 500-character identity bound is too small for them. */
const NOTE_MAX = 5000;

type TicketRow = {
  id: string;
  type: string;
  title: string;
  detail: string | null;
  payload: string;
  status: string;
  assignee: string | null;
  created_by: string;
  parent_id: string | null;
  workflow_run_id: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  id: string;
  seq: number;
  ticket_id: string;
  kind: string;
  actor: string | null;
  payload: string;
  at: string;
};

type KeyRow = { caller_key: string; ticket_id: string; request_json: string };
type ProvenanceRow = { origin: string; source_channel: string; source_contact: string };
type BudgetRow = {
  max_tokens: number | null;
  max_usd_cents: number | null;
  used_tokens: number;
  used_usd_cents: number;
  hop_count: number;
  max_hops: number;
};
type BudgetLimits = { readonly maxTokens: number | null; readonly maxUsdCents: number | null };

function fail(kind: BoardErrorKind, message: string, details?: unknown): BoardError {
  return new BoardError(kind, message, details);
}

function bounded(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string") throw fail("invalid_argument", `${label} must be a string.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw fail(
      "invalid_argument",
      `${label} must be between 1 and ${maximum} characters, got ${normalized.length}.`,
    );
  }
  return normalized;
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Sorted-key JSON, so the same request written with its fields in a different order dedupes to the
 * same caller key. The board owes that to RASF-3067's relay, which re-sends after a restart with
 * whatever order its own encoder produced.
 */
function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, sort(nested)]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

function optionalCount(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw fail("invalid_argument", `${label} must be a whole number of 0 or more.`);
  }
  return value;
}

function assigneeOf(value: unknown): Assignee | null {
  if (value === undefined || value === null) return null;
  const record = objectOf(value);
  if (record === undefined || (record.kind !== "agent" && record.kind !== "person")) {
    throw fail("invalid_argument", 'An assignee must be { kind: "agent" | "person", id }.');
  }
  return { kind: record.kind, id: bounded(record.id, "Assignee id") };
}

function statusOf(value: unknown): TicketStatus {
  if (typeof value !== "string" || !STATUSES.includes(value as TicketStatus)) {
    throw new Error(`Board row contains an unknown ticket status: ${String(value)}.`);
  }
  return value as TicketStatus;
}

function payloadOf(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Board row contains malformed payload JSON.");
  }
}

function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    detail: row.detail,
    payload: payloadOf(row.payload),
    status: statusOf(row.status),
    assignee: row.assignee,
    createdBy: row.created_by,
    parentId: row.parent_id,
    workflowRunId: row.workflow_run_id,
    result: row.result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: EventRow): TicketEvent {
  return {
    id: row.id,
    seq: row.seq,
    ticketId: row.ticket_id,
    kind: row.kind,
    actor: row.actor,
    payload: payloadOf(row.payload),
    at: row.at,
  };
}

/** A create request with everything validated, and the canonical form the caller key dedupes on. */
type NormalizedCreate = {
  readonly request: unknown;
  readonly type: string;
  readonly title: string;
  readonly detail: string | null;
  readonly payload: unknown;
  readonly payloadJson: string;
  readonly createdBy: string;
  readonly parentId: string | null;
  readonly workflowRunId: string | null;
  readonly provenance: {
    readonly origin: Origin;
    readonly sourceChannel: string;
    readonly sourceContact: string;
  } | null;
  readonly budget: {
    readonly maxTokens: number | null;
    readonly maxUsdCents: number | null;
    readonly maxHops: number | null;
  };
  readonly assignee: Assignee | null;
};

function normalizeCreate(input: NewTicket): NormalizedCreate {
  const type = bounded(input.type, "Ticket type");
  if (!TICKET_TYPE.test(type)) {
    throw fail(
      "invalid_argument",
      `Ticket type ${type} must be dotted (domain.verb, e.g. invoice.create).`,
    );
  }
  const title = bounded(input.title, "Ticket title");
  const detail =
    input.detail === undefined ? null : bounded(input.detail, "Ticket detail", NOTE_MAX);
  const createdBy = bounded(input.createdBy, "Ticket creator");
  const parentId =
    input.parentId === undefined ? null : bounded(input.parentId, "Parent ticket id");
  const workflowRunId =
    input.workflowRunId === undefined ? null : bounded(input.workflowRunId, "Workflow run id");
  const payload = input.payload ?? {};
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payload);
  } catch {
    throw fail("invalid_argument", "Ticket payload must be JSON that can be stored.");
  }
  if (payloadJson === undefined) {
    throw fail("invalid_argument", "Ticket payload must be JSON that can be stored.");
  }

  let provenance: NormalizedCreate["provenance"] = null;
  if (input.provenance !== undefined && input.provenance !== null) {
    const origin = input.provenance.origin;
    if (origin !== "internal" && origin !== "external") {
      throw fail("invalid_argument", 'Provenance origin must be "internal" or "external".');
    }
    provenance = {
      origin,
      sourceChannel: bounded(input.provenance.sourceChannel, "Provenance source channel"),
      sourceContact: bounded(input.provenance.sourceContact, "Provenance source contact"),
    };
  }

  const budget = {
    maxTokens: optionalCount(input.budget?.maxTokens, "maxTokens"),
    maxUsdCents: optionalCount(input.budget?.maxUsdCents, "maxUsdCents"),
    maxHops: optionalCount(input.budget?.maxHops, "maxHops"),
  };
  const assignee = assigneeOf(input.assignee);

  return {
    request: { type, title, payload, createdBy, parentId, provenance, budget },
    type,
    title,
    detail,
    payload,
    payloadJson,
    createdBy,
    parentId,
    workflowRunId,
    provenance,
    budget,
    assignee,
  };
}

/** Child limits narrow only. `null` is uncapped, so it narrows to whatever the other side says. */
function narrow(parentLimit: number | null, requested: number | null): number | null {
  if (parentLimit === null) return requested;
  if (requested === null) return parentLimit;
  return Math.min(parentLimit, requested);
}

/** What is left of a parent's ceiling, which is what a child may spend. Never negative. */
function remaining(limit: number | null, used: number): number | null {
  return limit === null ? null : Math.max(limit - used, 0);
}

function statusesOf(value: ListFilter["status"]): TicketStatus[] | null {
  if (value === undefined) return null;
  const requested = Array.isArray(value) ? value : [value];
  for (const status of requested) {
    if (typeof status !== "string" || !STATUSES.includes(status as TicketStatus)) {
      throw fail("invalid_argument", `Unknown ticket status filter: ${String(status)}.`);
    }
  }
  return [...(requested as TicketStatus[])];
}

function limitOf(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw fail("invalid_argument", "Ticket list limit must be a whole number of 1 or more.");
  }
  return Math.min(value, MAX_LIMIT);
}

function cursorOf(value: number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw fail("invalid_argument", "The event cursor must be a whole number of 0 or more.");
  }
  return value;
}

export function openBoard(file: string): Board {
  mkdirSync(dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec(
    "PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA journal_mode = WAL;",
  );
  try {
    applyMigrations(database);
  } catch (error) {
    database.close();
    throw error;
  }

  const findTicket = database.prepare("SELECT * FROM tickets WHERE id = ?");
  const insertTicket = database.prepare(
    `INSERT INTO tickets
      (id, type, title, detail, payload, status, assignee, created_by, parent_id, workflow_run_id,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const setResult = database.prepare("UPDATE tickets SET result = ? WHERE id = ?");
  const moveTicket = database.prepare(
    "UPDATE tickets SET status = ?, assignee = ?, updated_at = ? WHERE id = ?",
  );
  const touchTicket = database.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?");
  const nextSeq = database.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM ticket_events");
  const insertEvent = database.prepare(
    `INSERT INTO ticket_events (id, seq, ticket_id, kind, actor, payload, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const findEvent = database.prepare(
    `SELECT id, seq, ticket_id, kind, actor, payload, at FROM ticket_events
      WHERE ticket_id = ? AND seq > ? ORDER BY seq`,
  );
  const findEventsAfter = database.prepare(
    `SELECT id, seq, ticket_id, kind, actor, payload, at FROM ticket_events
      WHERE seq > ? ORDER BY seq`,
  );
  const insertComment = database.prepare(
    "INSERT INTO comments (id, ticket_id, author, body, at) VALUES (?, ?, ?, ?, ?)",
  );
  const findProvenance = database.prepare(
    "SELECT origin, source_channel, source_contact FROM provenance WHERE ticket_id = ?",
  );
  const insertProvenance = database.prepare(
    "INSERT INTO provenance (ticket_id, origin, source_channel, source_contact) VALUES (?, ?, ?, ?)",
  );
  const findBudget = database.prepare(
    `SELECT max_tokens, max_usd_cents, used_tokens, used_usd_cents, hop_count, max_hops
       FROM budgets WHERE ticket_id = ?`,
  );
  const insertBudget = database.prepare(
    `INSERT INTO budgets
      (ticket_id, max_tokens, max_usd_cents, used_tokens, used_usd_cents, hop_count, max_hops)
     VALUES (?, ?, ?, 0, 0, ?, ?)`,
  );
  const findPerson = database.prepare("SELECT 1 AS present FROM people WHERE id = ?");
  const listPeople = database.prepare("SELECT id, name FROM people ORDER BY rowid");
  const findKey = database.prepare(
    "SELECT caller_key, ticket_id, request_json FROM ticket_keys WHERE caller_key = ?",
  );
  const insertKey = database.prepare(
    "INSERT INTO ticket_keys (caller_key, ticket_id, request_json) VALUES (?, ?, ?)",
  );

  const now = (): string => new Date().toISOString();
  const ledger = openRelayLedger(database);

  /**
   * A trigger abort is the ledger refusing a write. Surfacing it as `immutable` keeps a caller from
   * having to parse SQLite's message, and is the one way this API can carry that kind: no API call of
   * this issue writes to `ticket_events` or `comments` other than by inserting.
   */
  const surface = (error: unknown): unknown => {
    if (error instanceof BoardError) return error;
    if (error instanceof Error && error.message.includes("append-only")) {
      return fail("immutable", error.message);
    }
    return error;
  };

  const transact = <T>(work: () => T): T => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      database.exec("COMMIT");
      return value;
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw surface(error);
    }
  };

  const ticketRow = (id: string): TicketRow | undefined =>
    findTicket.get(id) as TicketRow | undefined;
  const requireTicket = (id: string): TicketRow => {
    const row = ticketRow(id);
    if (row === undefined) throw fail("not_found", `No ticket ${id} on this board.`);
    return row;
  };
  const isPerson = (id: string): boolean => findPerson.get(id) !== undefined;

  const appendEvent = (
    ticketId: string,
    kind: string,
    actor: string | null,
    payload: unknown,
  ): TicketEvent => {
    const at = now();
    const seq = (nextSeq.get() as { seq: number } | undefined)?.seq;
    if (seq === undefined) throw new Error("Failed to read the next board event sequence.");
    const id = randomUUID();
    insertEvent.run(id, seq, ticketId, kind, actor, JSON.stringify(payload), at);
    return { id, seq, ticketId, kind, actor, payload, at };
  };

  /** `open` only: an agent takes work by claiming it, and the claim is the ticket's event. */
  const claim = (ticketId: string, actor: string): Ticket => {
    const id = bounded(ticketId, "Ticket id");
    const claimant = bounded(actor, "Actor");
    return transact(() => {
      const row = requireTicket(id);
      if (row.status !== "open") {
        throw fail("invalid_status", `Ticket ${id} is ${row.status}, not open.`, {
          from: row.status,
          to: "claimed",
        });
      }
      moveTicket.run("claimed", claimant, now(), id);
      appendEvent(id, "claimed", claimant, {});
      return toTicket(requireTicket(id));
    });
  };

  /**
   * The one rule that keeps multi-agent work bounded: only the assignee, or a person, may finish or
   * kill a ticket. A person is anyone in `people`; an agent is anyone else.
   */
  const authorized = (row: TicketRow, actor: string): boolean =>
    row.assignee !== null && row.assignee === actor ? true : isPerson(actor);

  const closeOut = (
    ticketId: string,
    actor: string,
    to: TicketStatus,
    kind: string,
    result?: string,
  ): Ticket => {
    const id = bounded(ticketId, "Ticket id");
    const closer = bounded(actor, "Actor");
    return transact(() => {
      const row = requireTicket(id);
      const status = statusOf(row.status);
      if (TERMINAL.includes(status)) {
        throw fail("invalid_status", `Ticket ${id} is already ${status}.`, { from: status, to });
      }
      if (to === "done" && !COMPLETABLE.includes(status)) {
        throw fail(
          "invalid_status",
          `Ticket ${id} is ${status}; only a claimed, waiting or blocked ticket can be completed.`,
          { from: status, to },
        );
      }
      if (!authorized(row, closer)) {
        throw fail(
          "unauthorized",
          `Ticket ${id} is assigned to ${row.assignee ?? "nobody"}; only the assignee or a person can ${to === "done" ? "complete" : "cancel"} it.`,
          { assignee: row.assignee, actor: closer },
        );
      }
      moveTicket.run(to, row.assignee, now(), id);
      if (result !== undefined) setResult.run(result, id);
      appendEvent(id, kind, closer, result === undefined ? {} : { result });
      return toTicket(requireTicket(id));
    });
  };

  return {
    create(input, callerKey) {
      const key = bounded(callerKey, "Caller key");
      const request = normalizeCreate(input);
      // The canonical form covers what the caller asked for, not what the board resolved it to: a
      // repeat of the same request is the same request, even after the parent's budget has moved.
      const requestJson = canonicalJson(request.request);
      return transact(() => {
        const seen = findKey.get(key) as KeyRow | undefined;
        if (seen !== undefined) {
          if (seen.request_json !== requestJson) {
            throw fail(
              "duplicate_key",
              `Caller key ${key} already created ticket ${seen.ticket_id} with a different request.`,
              { ticketId: seen.ticket_id },
            );
          }
          return toTicket(requireTicket(seen.ticket_id));
        }

        const parent = request.parentId === null ? undefined : requireTicket(request.parentId);
        const at = now();
        const id = randomUUID();

        // Provenance is a fact about where the work came from, so a child copies its parent's row
        // verbatim and a caller-supplied provenance on a child is ignored. Only a root states one.
        if (parent === undefined) {
          if (request.provenance === null) {
            throw fail(
              "invalid_argument",
              "A root ticket must state its provenance (origin, sourceChannel, sourceContact).",
            );
          }
          insertProvenance.run(
            id,
            request.provenance.origin,
            request.provenance.sourceChannel,
            request.provenance.sourceContact,
          );
        } else {
          const inherited = findProvenance.get(parent.id) as ProvenanceRow | undefined;
          if (inherited === undefined) {
            throw fail("not_found", `Ticket ${parent.id} has no provenance row to inherit.`);
          }
          insertProvenance.run(
            id,
            inherited.origin,
            inherited.source_channel,
            inherited.source_contact,
          );
        }

        // Inheritance is materialization, not a query walk: a parent's max_* is already its own
        // chain-narrowed ceiling and its used_* its subtree spend, so one subtraction composes for a
        // grandchild. The child's own request narrows and never widens.
        const parentBudget =
          parent === undefined ? undefined : (findBudget.get(parent.id) as BudgetRow | undefined);
        const ceilings: BudgetLimits =
          parentBudget === undefined
            ? { maxTokens: request.budget.maxTokens, maxUsdCents: request.budget.maxUsdCents }
            : {
                maxTokens: narrow(
                  remaining(parentBudget.max_tokens, parentBudget.used_tokens),
                  request.budget.maxTokens,
                ),
                maxUsdCents: narrow(
                  remaining(parentBudget.max_usd_cents, parentBudget.used_usd_cents),
                  request.budget.maxUsdCents,
                ),
              };
        const hopCount = parentBudget === undefined ? 0 : parentBudget.hop_count + 1;
        const maxHops =
          parentBudget === undefined
            ? (request.budget.maxHops ?? DEFAULT_MAX_HOPS)
            : Math.min(parentBudget.max_hops, request.budget.maxHops ?? parentBudget.max_hops);

        // At the limit the board stops handing work to agents: the next ticket goes to a person, which
        // is the point of the hop rule. `hop_count == max_hops` is still allowed.
        const exhausted =
          parentBudget !== undefined && parentBudget.hop_count + 1 > parentBudget.max_hops;
        if (exhausted && request.assignee?.kind !== "person") {
          throw fail(
            "max_hops",
            `Delegation is exhausted at ${parentBudget.max_hops} hops; the next ticket must be assigned to a person.`,
            { parentId: request.parentId, hopCount, maxHops: parentBudget.max_hops },
          );
        }
        if (request.assignee?.kind === "person" && !isPerson(request.assignee.id)) {
          throw fail("invalid_person", `No person ${request.assignee.id} on this board.`, {
            id: request.assignee.id,
          });
        }
        // A hop-exhausted child waits on the person it was handed to. A fresh ticket is open even when
        // the caller named an assignee: `claim` or `assign` is what moves it on from there.
        const status: TicketStatus = exhausted ? "waiting" : "open";

        insertTicket.run(
          id,
          request.type,
          request.title,
          request.detail,
          request.payloadJson,
          status,
          request.assignee?.id ?? null,
          request.createdBy,
          request.parentId,
          request.workflowRunId,
          at,
          at,
        );
        insertBudget.run(id, ceilings.maxTokens, ceilings.maxUsdCents, hopCount, maxHops);
        appendEvent(id, "created", request.createdBy, {});
        insertKey.run(key, id, requestJson);
        return toTicket(requireTicket(id));
      });
    },
    claim,
    comment(ticketId, author, body) {
      const id = bounded(ticketId, "Ticket id");
      const writer = bounded(author, "Comment author");
      const text = bounded(body, "Comment body", NOTE_MAX);
      return transact(() => {
        requireTicket(id);
        const commentId = randomUUID();
        const at = now();
        insertComment.run(commentId, id, writer, text, at);
        appendEvent(id, "commented", writer, { commentId });
        // A comment is activity: it moves the ticket to the top of `list`, which orders by recency.
        touchTicket.run(at, id);
        return commentId;
      });
    },
    complete(ticketId, actor, options = {}) {
      return closeOut(ticketId, actor, "done", "completed", options.result);
    },
    cancel(ticketId, actor) {
      return closeOut(ticketId, actor, "cancelled", "cancelled");
    },
    assign(ticketId, assignee, actor) {
      const target = assigneeOf(assignee);
      if (target === null) throw fail("invalid_argument", "An assignee is required.");
      const id = bounded(ticketId, "Ticket id");
      const by = bounded(actor, "Actor");
      return transact(() => {
        const row = requireTicket(id);
        const status = statusOf(row.status);
        const to: TicketStatus = target.kind === "person" ? "waiting" : "claimed";
        if (TERMINAL.includes(status)) {
          throw fail("invalid_status", `Ticket ${id} is already ${status}.`, { from: status, to });
        }
        if (target.kind === "person" && !isPerson(target.id)) {
          throw fail("invalid_person", `No person ${target.id} on this board.`, { id: target.id });
        }
        moveTicket.run(to, target.id, now(), id);
        appendEvent(id, "assigned", by, { assignee: target });
        return toTicket(requireTicket(id));
      });
    },
    get(ticketId) {
      const row = ticketRow(bounded(ticketId, "Ticket id"));
      return row === undefined ? undefined : toTicket(row);
    },
    list(filter = {}) {
      const clauses: string[] = [];
      const values: string[] = [];
      const statuses = statusesOf(filter.status);
      if (statuses !== null) {
        // An empty status list can only mean "nothing": `IN ()` is not valid SQL and is not what the
        // caller asked for either.
        if (statuses.length === 0) return [];
        clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        values.push(...statuses);
      }
      if (filter.assignee !== undefined) {
        clauses.push("assignee = ?");
        values.push(bounded(filter.assignee, "Assignee filter"));
      }
      if (filter.parentId !== undefined) {
        clauses.push("parent_id = ?");
        values.push(bounded(filter.parentId, "Parent filter"));
      }
      if (filter.type !== undefined) {
        clauses.push("type = ?");
        values.push(bounded(filter.type, "Type filter"));
      }
      const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
      const rows = database
        .prepare(`SELECT * FROM tickets ${where} ORDER BY updated_at DESC, id ASC LIMIT ?`)
        .all(...values, limitOf(filter.limit));
      return (rows as unknown as TicketRow[]).map(toTicket);
    },
    events(ticketId, after) {
      const id = bounded(ticketId, "Ticket id");
      const from = cursorOf(after);
      requireTicket(id);
      const rows = findEvent.all(id, from) as unknown as EventRow[];
      return rows.map(toEvent);
    },
    eventsAfter(after) {
      const from = cursorOf(after);
      const rows = findEventsAfter.all(from) as unknown as EventRow[];
      return rows.map(toEvent);
    },
    stall(ticketId, actor, reason) {
      const id = bounded(ticketId, "Ticket id");
      const by = bounded(actor, "Actor");
      const why = bounded(reason, "Stall reason", NOTE_MAX);
      return transact(() => {
        requireTicket(id);
        return appendEvent(id, "stalled", by, { reason: why });
      });
    },
    people() {
      return listPeople.all() as unknown as Person[];
    },
    provenance(ticketId) {
      const row = findProvenance.get(bounded(ticketId, "Ticket id")) as ProvenanceRow | undefined;
      return row === undefined
        ? undefined
        : {
            origin: row.origin === "external" ? "external" : "internal",
            sourceChannel: row.source_channel,
            sourceContact: row.source_contact,
          };
    },
    relay: ledger,
    close() {
      database.close();
    },
  };
}
