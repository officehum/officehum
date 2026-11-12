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
 * No agent-facing tools live here (that is RASF-3109). Spend accounting does: `chargeUsage` and
 * `admitCall` (RASF-3141) are the only writers of `used_*`, they run in one `BEGIN IMMEDIATE` with a
 * `spend_ledger` row keyed by the call, and they roll every delta up to every ancestor — so a parent's
 * `used_*` is its whole tree's spend and a ceiling is a chain ceiling rather than one ticket's private
 * allowance. `block` is the status a stopped chain lands in; a `blocked` ticket is one a person holds.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AGENT_REPLY, canonicalJson, sameCanonical } from "@officehum/sdk";
import { transact as inTransaction } from "../shared/transact.js";
import { MICROS_PER_CENT } from "../spend/prices.js";
import {
  type Approval,
  type ApprovalDecisionInput,
  type ApprovalStore,
  openApprovalStore,
} from "./approvals.js";
import { BoardError, type BoardErrorKind, fail } from "./errors.js";
import { applyMigrations } from "./migrations.js";
import { openRelayLedger, type RelayLedger } from "./relay-ledger.js";
import { openSmsStore, type SmsStore } from "./sms.js";

export type TicketStatus =
  | "open"
  | "claimed"
  | "waiting"
  /** The agent's work checked out and a person has been asked to confirm it (RASF-3230). */
  | "awaiting_confirmation"
  | "blocked"
  | "done"
  | "cancelled";
export type Origin = "internal" | "external";
export type Assignee = { readonly kind: "agent" | "person"; readonly id: string };

export {
  type Approval,
  type ApprovalDecisionInput,
  type ApprovalFilter,
  type ApprovalRequestInput,
  type ApprovalStatus,
  type ApprovalStore,
  argsHash,
  canonicalArgs,
} from "./approvals.js";
/**
 * The SMS intake store and its vocabulary, re-exported here because the webhook route and a host that
 * reads the board both import from the board, not from a file inside it.
 */
export type { SmsOptOutState, SmsStore } from "./sms.js";
/**
 * The refusal type lives in `./errors.js` so the approvals store can throw it too; it is re-exported
 * here because every existing caller imports it from the board.
 */
export { BoardError, type BoardErrorKind };

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
    /** The dollar ceiling, in whole cents. The board holds and compares it in micro-dollars. */
    readonly maxUsdCents?: number;
    readonly maxCalls?: number;
    readonly maxHops?: number;
  };
  readonly assignee?: Assignee;
}

/**
 * One completion check's outcome, as a ticket's events record it (RASF-3230). The checks are the
 * ticket type's `accepts[].done` in the role's `officehum.json`; `./evidence.ts` runs them.
 */
export interface EvidenceResult {
  readonly kind: "engine" | "tool" | "file" | "person";
  /** The check as declared: the engine subcommand, the tool or file name, or `person`. */
  readonly check: string;
  readonly passed: boolean;
  /** Why it failed, in words the agent and a person can act on. Absent on a pass. */
  readonly reason?: string;
  /** What the check found: finding ids, the tool's details, the file, who confirmed. Plain JSON. */
  readonly found?: unknown;
}

export interface CompleteOptions {
  readonly result?: string;
  /** The checks that passed, recorded on the `completed` event. */
  readonly evidence?: readonly EvidenceResult[];
  /** Why no evidence was checked, recorded on the `completed` event for a reader of the board. */
  readonly warning?: string;
}

/** A failed attempt at completing a ticket: what did not check out, and who gets it if it blocks. */
export interface EvidenceFailureOptions {
  readonly failures: readonly EvidenceResult[];
  /** The person a ticket that has now failed `MAX_EVIDENCE_ATTEMPTS` times is handed to. */
  readonly blockTo?: Assignee;
}

/** What a failed attempt left behind. */
export interface EvidenceFailureOutcome {
  readonly ticket: Ticket;
  /** How many attempts have failed on this ticket, this one included. */
  readonly attempt: number;
  /** Whether this attempt was the last allowed, so the ticket is now `blocked`. */
  readonly blocked: boolean;
}

/** What `awaitConfirmation` records: the work as it stands, and the person asked to confirm it. */
export interface ConfirmationRequest {
  readonly result: string;
  /** The checks that already passed; the person's confirmation is added when they give it. */
  readonly evidence: readonly EvidenceResult[];
  /** The `people.id` asked. */
  readonly person: string;
}

/** A person's answer to a confirmation request. A refusal should say why: the agent is told. */
export interface ConfirmationDecision {
  readonly confirmed: boolean;
  readonly note?: string;
}

/** How many times a ticket's evidence may fail before the ticket is blocked and handed to a person. */
export const MAX_EVIDENCE_ATTEMPTS = 3;

/**
 * The approval id of a confirmation request in the Inbox. A request to confirm a ticket is an
 * approval of the exact `agent_reply` that finished it, so it lives in the approvals store with every
 * other question a person is asked; this id is how the board tells it from a tool's approval. A role
 * cannot declare it: manifest approval ids carry no dot.
 */
export const COMPLETION_APPROVAL_ID = "ticket.completion";

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
  /** Only tickets this actor created: how an agent finds the answers to what it dispatched. */
  readonly createdBy?: string;
  readonly parentId?: string;
  readonly type?: string;
  readonly limit?: number;
}

/**
 * One ticket's ceilings and what its chain has spent (RASF-3141).
 *
 * `used*` is the ticket's own row, which the board also keeps as its subtree total: every charge rolls
 * up to every ancestor, so a parent's `used` is what its whole tree has spent. That is what makes a
 * ceiling a chain ceiling rather than one ticket's private allowance.
 *
 * `remaining*` is the number a ceiling check reads, and it is deliberately *not* `max - used` of this
 * row alone. A child's ceiling is materialized when it is created, so a sibling that spends afterwards
 * would leave the first child's own row claiming headroom the chain no longer has. The remaining figures
 * therefore take the tightest of this row and every ancestor's remainder, which is why a sibling's spend
 * reduces the other's headroom at read time. `null` is uncapped, at any level of the chain.
 */
export interface Budget {
  readonly ticketId: string;
  readonly maxCalls: number | null;
  readonly maxTokens: number | null;
  readonly maxUsdMicros: number | null;
  readonly usedCalls: number;
  readonly usedTokens: number;
  readonly usedUsdMicros: number;
  readonly hopCount: number;
  readonly maxHops: number;
  readonly remainingCalls: number | null;
  readonly remainingTokens: number | null;
  readonly remainingUsdMicros: number | null;
}

/** What one charge adds to a ticket, and to every ancestor. Every field is optional; every one is a count. */
export interface UsageCharge {
  readonly calls?: number;
  readonly tokens?: number;
  /** Dollar cost in micro-dollars (millionths of a dollar), the ledger's unit. */
  readonly usdMicros?: number;
  /** The role doing the spending, recorded on the ledger row for the per-agent-per-day reader. */
  readonly agent?: string;
}

/** One charge's outcome: whether it was new, and the ticket's ceilings and spend after it. */
export interface ChargeResult {
  readonly charged: boolean;
  readonly budget: Budget;
}

/**
 * One tool call's outcome at the call ceiling. `admitted` is the ceiling's answer; `charged` says whether
 * this call id was new, so a replay is admitted without being counted twice.
 */
export interface CallAdmission {
  readonly admitted: boolean;
  readonly charged: boolean;
  readonly budget: Budget;
}

/** What one agent spent on one day, from the ledger. `agent` is null for spend with no role behind it. */
export interface AgentSpend {
  /** The UTC date, `YYYY-MM-DD`. */
  readonly day: string;
  readonly agent: string | null;
  readonly calls: number;
  readonly tokens: number;
  readonly usdMicros: number;
}

/** The ticket a relay conversation is working, and the role the conversation belongs to. */
export interface ConversationTicket {
  readonly ticketId: string;
  readonly agent: string;
}

/** Why a ticket was blocked, and the person who now holds it. */
export interface BlockOptions {
  readonly reason: string;
  readonly assignee?: Assignee;
}

/**
 * Whether a budget has nothing left to spend, and which ceilings are spent. The one definition of "at
 * or over": the mid-turn hook, the relay's door and the CLI all ask this rather than compare numbers of
 * their own, because two comparisons are two policies.
 */
export function budgetSpent(budget: Budget): readonly ("calls" | "tokens" | "usd")[] {
  const spent: ("calls" | "tokens" | "usd")[] = [];
  if (budget.remainingCalls !== null && budget.remainingCalls <= 0) spent.push("calls");
  if (budget.remainingTokens !== null && budget.remainingTokens <= 0) spent.push("tokens");
  if (budget.remainingUsdMicros !== null && budget.remainingUsdMicros <= 0) spent.push("usd");
  return spent;
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
  /**
   * The ticket, if `actor` may complete it now; otherwise the refusal `complete` would give. It
   * changes nothing: a host asks before running completion checks, so nobody can make it run them
   * against a ticket that is not theirs to finish.
   */
  completable(ticketId: string, actor: string): Ticket;
  /**
   * Records a failed attempt at completing a ticket as one `evidence_failed` event, leaving the ticket
   * with whoever holds it. The attempt that reaches `MAX_EVIDENCE_ATTEMPTS` also blocks the ticket and
   * hands it to `blockTo`, with the failed checks, what they found and the owner in the block reason.
   */
  evidenceFailed(
    ticketId: string,
    actor: string,
    options: EvidenceFailureOptions,
  ): EvidenceFailureOutcome;
  /**
   * Moves a ticket to `awaiting_confirmation` and asks a person, in the Inbox, to confirm it is done.
   * The move and the request are one commit, so a ticket never waits on a question nobody was asked.
   */
  awaitConfirmation(ticketId: string, actor: string, request: ConfirmationRequest): Ticket;
  /**
   * A person's answer for a ticket that is `awaiting_confirmation`: yes completes it, with their
   * confirmation beside the evidence on the `completed` event; no returns it to the agent as a failed
   * attempt. Deciding the same request through `approvals.decideApproval` does exactly the same.
   */
  confirm(ticketId: string, person: string, decision: ConfirmationDecision): Ticket;
  cancel(ticketId: string, actor: string): Ticket;
  /**
   * Hands a ticket to a role or a person. Only the ticket's assignee, whoever opened it, or a person
   * may; anyone else is refused with `unauthorized`.
   */
  assign(ticketId: string, assignee: Assignee, actor: string): Ticket;
  get(ticketId: string): Ticket | undefined;
  list(filter?: ListFilter): Ticket[];
  events(ticketId: string, after?: number): TicketEvent[];
  /**
   * Every event with `seq > after`, in the global `seq` order (RASF-3067). The relay's cursor is one
   * number for the whole board, so it needs the whole board's tail, not one ticket's.
   */
  eventsAfter(after: number): TicketEvent[];
  /** The newest event's `seq`, or 0 for an empty log: a cheap "has anything changed" read. */
  lastEventSeq(): number;
  /** How many tickets are in each status, every status present (0 when none). Not capped by `list`. */
  countByStatus(): Record<TicketStatus, number>;
  /**
   * Append a `stalled` event: a delivery the relay could not route and no person could take. It has
   * no status change of its own — the ticket is where it was — so it is not `assign` or `comment`.
   */
  stall(ticketId: string, actor: string, reason: string): TicketEvent;
  /**
   * Moves a ticket to `blocked` and appends one `blocked` event carrying the reason, optionally handing
   * it to a person (RASF-3141). `stall` deliberately does not change the status, so before this there
   * was no way for the board to say "this work has stopped and a human owns it" — and a status no call
   * can reach is a status a reader cannot trust.
   *
   * Idempotent on purpose: a budget that is spent refuses every later call, and each refusal would
   * otherwise append another event for the same fact. Already `blocked` returns the ticket unchanged.
   */
  block(ticketId: string, actor: string, options: BlockOptions): Ticket;
  /**
   * Charges one call's spend to a ticket and to every ancestor, exactly once per `callId`. The ledger
   * row and the incremented counters commit together, so a crash lands both or neither, and a replay of
   * the same call finds its row and adds nothing.
   */
  chargeUsage(ticketId: string, callId: string, charge: UsageCharge): ChargeResult;
  /**
   * Charges one tool call against the call ceiling and answers whether it may run. The check and the
   * increment are one `BEGIN IMMEDIATE`, so two calls in one round cannot both take the last slot.
   */
  admitCall(ticketId: string, callId: string, agent?: string): CallAdmission;
  /** The ticket's ceilings, its chain's spend and its remaining headroom. `undefined` for no such ticket. */
  budget(ticketId: string): Budget | undefined;
  /** What the ledger says each agent spent on each day, newest day first. */
  spendByAgent(): AgentSpend[];
  /**
   * Binds a relay conversation to the ticket it is working, so the mid-turn hooks — which see only a
   * `conversationId` — can find the ticket to charge. Written by the relay in the commit that opens a
   * delivery; a repeat of the same binding is the same binding.
   */
  bindConversation(conversationId: number, binding: ConversationTicket): void;
  /** The ticket and role a conversation is bound to, or `undefined` for a conversation with no ticket. */
  conversationTicket(conversationId: number): ConversationTicket | undefined;
  /** Everyone the office knows, in the order they were added. The relay's person fallback reads it. */
  people(): Person[];
  /**
   * Adds the people a host names, in the order given, and renames the ones already here. A host calls
   * it at start with the company record's people, so the same list twice changes nothing. Nobody is
   * ever removed: a ticket may still be with a person who has since left the record.
   */
  upsertPeople(people: readonly Person[]): void;
  /** The ticket's provenance row, or `undefined` when it has none. */
  provenance(ticketId: string): Provenance | undefined;
  /**
   * The approvals store over this board's handle (RASF-3138): the durable record of what was asked,
   * what a person decided, and exactly which arguments a decision covers.
   */
  readonly approvals: ApprovalStore;
  /** The relay's cursor, delivery ledger and wait index, over this board's handle. */
  readonly relay: RelayLedger;
  /**
   * The inbound SMS intake tables, over this board's handle (RASF-3162): the MessageSid duplicate
   * guard, each number's latest STOP or START, and the per-window counter behind the rate ceiling. The
   * webhook route writes them in the same file as everything else the office knows about a customer.
   */
  readonly sms: SmsStore;
  close(): void;
}

/** The manifest's `TicketType` pattern (`@officehum/sdk`): at least one dot, lowercase, underscored. */
const TICKET_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const STATUSES: readonly TicketStatus[] = [
  "open",
  "claimed",
  "waiting",
  "awaiting_confirmation",
  "blocked",
  "done",
  "cancelled",
];
/** Statuses a ticket can be moved out of; `done` and `cancelled` are terminal. */
const TERMINAL: readonly TicketStatus[] = ["done", "cancelled"];
/** A ticket is completable only once someone is working on it. `open` and unassigned work is not. */
const COMPLETABLE: readonly TicketStatus[] = ["claimed", "waiting", "blocked"];
const DEFAULT_MAX_HOPS = 4;
/**
 * How far a chain walk goes before it stops. A parent link is written once and never moves, so a cycle
 * cannot occur through the API; the bound is there so a hand-edited row could not hang a read.
 */
const MAX_CHAIN = 64;
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
  max_usd_micros: number | null;
  used_tokens: number;
  used_usd_micros: number;
  hop_count: number;
  max_hops: number;
  used_calls: number;
  max_calls: number | null;
};
type ConversationRow = { ticket_id: string; agent: string };
type SpendRow = {
  day: string;
  agent: string | null;
  calls: number;
  tokens: number;
  usd_micros: number;
};
type BudgetLimits = {
  readonly maxTokens: number | null;
  readonly maxUsdMicros: number | null;
  readonly maxCalls: number | null;
};

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

/** The Inbox line asking for a confirmation is cut to this, within the approvals store's own bound. */
const CONFIRMATION_SUMMARY_MAX = 1000;
/** Longest a check's findings run in a block reason before they are cut: a reason is read, not parsed. */
const FOUND_MAX = 400;

function storable(value: unknown, label: string): void {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined)
    throw fail("invalid_argument", `${label} must be JSON that can be stored.`);
}

function evidenceOf(value: unknown, label: string): EvidenceResult[] {
  if (!Array.isArray(value)) throw fail("invalid_argument", `${label} must be a list of checks.`);
  storable(value, label);
  return value.map((entry: unknown) => {
    const record = objectOf(entry);
    const kind = record?.kind;
    if (
      record === undefined ||
      (kind !== "engine" && kind !== "tool" && kind !== "file" && kind !== "person") ||
      typeof record.passed !== "boolean"
    ) {
      throw fail("invalid_argument", `${label} must hold { kind, check, passed } entries.`);
    }
    return {
      kind,
      check: bounded(record.check, "An evidence check"),
      passed: record.passed,
      ...(record.reason === undefined
        ? {}
        : { reason: bounded(record.reason, "An evidence reason", NOTE_MAX) }),
      ...(record.found === undefined ? {} : { found: record.found }),
    };
  });
}

/** One check as a line of text: the check, how it went, and what it found, cut to fit. */
export function evidenceLine(entry: EvidenceResult): string {
  const found =
    entry.found === undefined ? "" : ` Found: ${JSON.stringify(entry.found).slice(0, FOUND_MAX)}`;
  // A person's own words may already end the sentence; one full stop either way.
  const outcome = entry.passed
    ? "passed"
    : (entry.reason ?? "did not pass").replace(/[.\s]+$/u, "");
  return `- ${entry.kind} ${entry.check}: ${outcome}.${found}`;
}

/**
 * Why a ticket whose evidence kept failing is blocked: how often, who owns the work, and each failed
 * check with what it found, so the person it lands with reads the figures without opening the events.
 */
function evidenceBlockReason(
  owner: string | null,
  attempts: number,
  failures: readonly EvidenceResult[],
): string {
  const reason = [
    `Completion evidence failed ${attempts} times. Owner: ${owner ?? "nobody"}.`,
    "The last attempt failed these checks:",
    ...failures.map(evidenceLine),
  ].join("\n");
  return reason.length > NOTE_MAX ? `${reason.slice(0, NOTE_MAX - 1)}…` : reason;
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
    readonly maxCalls: number | null;
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
    maxCalls: optionalCount(input.budget?.maxCalls, "maxCalls"),
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
  const lastSeq = database.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM ticket_events");
  const countStatuses = database.prepare(
    "SELECT status, COUNT(*) AS count FROM tickets GROUP BY status",
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
    `SELECT max_tokens, max_usd_micros, used_tokens, used_usd_micros, hop_count, max_hops,
            used_calls, max_calls
       FROM budgets WHERE ticket_id = ?`,
  );
  const insertBudget = database.prepare(
    `INSERT INTO budgets
      (ticket_id, max_tokens, max_usd_micros, used_tokens, used_usd_micros, hop_count, max_hops,
       used_calls, max_calls)
     VALUES (?, ?, ?, 0, 0, ?, ?, 0, ?)`,
  );
  const findLedgerRow = database.prepare(
    "SELECT 1 AS present FROM spend_ledger WHERE call_id = ? AND kind = ?",
  );
  const insertLedgerRow = database.prepare(
    `INSERT INTO spend_ledger (call_id, kind, ticket_id, agent, calls, tokens, usd_micros, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const addSpend = database.prepare(
    `UPDATE budgets SET used_calls = used_calls + ?, used_tokens = used_tokens + ?,
            used_usd_micros = used_usd_micros + ?
      WHERE ticket_id = ?`,
  );
  const sumByAgent = database.prepare(
    `SELECT substr(at, 1, 10) AS day, agent,
            SUM(calls) AS calls, SUM(tokens) AS tokens, SUM(usd_micros) AS usd_micros
       FROM spend_ledger GROUP BY day, agent
      ORDER BY day DESC, (agent IS NULL) ASC, agent ASC`,
  );
  const findConversation = database.prepare(
    "SELECT ticket_id, agent FROM ticket_conversations WHERE conversation_id = ?",
  );
  const upsertConversation = database.prepare(
    `INSERT INTO ticket_conversations (conversation_id, ticket_id, agent) VALUES (?, ?, ?)
     ON CONFLICT (conversation_id) DO UPDATE SET ticket_id = excluded.ticket_id,
       agent = excluded.agent`,
  );
  const findPerson = database.prepare("SELECT 1 AS present FROM people WHERE id = ?");
  const listPeople = database.prepare("SELECT id, name FROM people ORDER BY rowid");
  const upsertPerson = database.prepare(
    "INSERT INTO people (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name",
  );
  const countFailures = database.prepare(
    "SELECT COUNT(*) AS count FROM ticket_events WHERE ticket_id = ? AND kind = 'evidence_failed'",
  );
  const findKey = database.prepare(
    "SELECT caller_key, ticket_id, request_json FROM ticket_keys WHERE caller_key = ?",
  );
  const insertKey = database.prepare(
    "INSERT INTO ticket_keys (caller_key, ticket_id, request_json) VALUES (?, ?, ?)",
  );

  const now = (): string => new Date().toISOString();
  const ledger = openRelayLedger(database);
  // The approvals store shares this handle, so a decision and the ticket it is about are one history:
  // the gate that reads a decision sees the row the person's screen committed.
  const approvalStore = openApprovalStore(database);
  // The SMS intake tables share the handle for the same reason: a text that was accepted and the
  // board's record of it are one history, and a second connection would be a second writer.
  const sms = openSmsStore(database);

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
    try {
      return inTransaction(database, work);
    } catch (error) {
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

  /** A ticket's own budget row. Every ticket is created with one; a ticket without is uncapped. */
  const budgetRow = (id: string): BudgetRow | undefined =>
    findBudget.get(id) as BudgetRow | undefined;

  /**
   * A ticket's ceilings, its own spend and the tightest headroom up its chain.
   *
   * The chain walk is the point. A child's ceilings are materialized at create from the parent's
   * remainder, so a sibling that spends afterwards leaves the child's own row claiming headroom the
   * chain no longer has; taking the minimum of this row and every ancestor's remainder is what makes a
   * sibling's spend bite. `MAX_CHAIN` bounds the walk so a cycle could not hang it, and the visited set
   * makes that refusal explicit rather than a silent number.
   */
  const budgetOf = (id: string): Budget | undefined => {
    const own = budgetRow(id);
    if (own === undefined) return undefined;
    let remainingCalls = remaining(own.max_calls, own.used_calls);
    let remainingTokens = remaining(own.max_tokens, own.used_tokens);
    let remainingUsdMicros = remaining(own.max_usd_micros, own.used_usd_micros);
    const tighten = (limit: number | null, used: number, current: number | null): number | null => {
      const available = remaining(limit, used);
      if (available === null) return current;
      return current === null ? available : Math.min(current, available);
    };
    const seen = new Set<string>([id]);
    let parentId = ticketRow(id)?.parent_id ?? null;
    while (parentId !== null && !seen.has(parentId) && seen.size < MAX_CHAIN) {
      seen.add(parentId);
      const ancestor = budgetRow(parentId);
      if (ancestor !== undefined) {
        remainingCalls = tighten(ancestor.max_calls, ancestor.used_calls, remainingCalls);
        remainingTokens = tighten(ancestor.max_tokens, ancestor.used_tokens, remainingTokens);
        remainingUsdMicros = tighten(
          ancestor.max_usd_micros,
          ancestor.used_usd_micros,
          remainingUsdMicros,
        );
      }
      parentId = ticketRow(parentId)?.parent_id ?? null;
    }
    return {
      ticketId: id,
      maxCalls: own.max_calls,
      maxTokens: own.max_tokens,
      maxUsdMicros: own.max_usd_micros,
      usedCalls: own.used_calls,
      usedTokens: own.used_tokens,
      usedUsdMicros: own.used_usd_micros,
      hopCount: own.hop_count,
      maxHops: own.max_hops,
      remainingCalls,
      remainingTokens,
      remainingUsdMicros,
    };
  };

  /**
   * One charge, exactly once per `callId`, rolled up to every ancestor.
   *
   * The whole body is one `BEGIN IMMEDIATE`: the ledger row, the ticket's counters and the ancestors'
   * counters commit together or not at all, so a crash between "spend" and "refusal" cannot leave a
   * charge half applied, and a second attempt at the same call finds its row and adds nothing. The gate
   * (the call ceiling) is asked inside the same transaction for the same reason — two calls in one round
   * must not both read the last free slot.
   */
  const chargeOnce = (
    ticketId: string,
    callId: string,
    delta: { readonly calls: number; readonly tokens: number; readonly usdMicros: number },
    options: {
      readonly agent: string | undefined;
      readonly gate: boolean;
      readonly kind: "call" | "usage";
    },
  ): ChargeResult & { readonly admitted: boolean } => {
    const id = bounded(ticketId, "Ticket id");
    const key = bounded(callId, "Call id", 400);
    for (const [label, value] of [
      ["calls", delta.calls],
      ["tokens", delta.tokens],
      ["usdMicros", delta.usdMicros],
    ] as const) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw fail("invalid_argument", `A charge's ${label} must be a whole number of 0 or more.`);
      }
    }
    const agent = options.agent === undefined ? null : bounded(options.agent, "Charging agent");
    return transact(() => {
      requireTicket(id);
      const known = budgetOf(id);
      if (known === undefined) throw fail("not_found", `No budget row for ticket ${id}.`);
      if (findLedgerRow.get(key, options.kind) !== undefined) {
        // Already charged: a replay of the same call, or a retry of the same attempt. Nothing to add.
        return { charged: false, admitted: true, budget: known };
      }
      if (options.gate) {
        // The call ceiling is checked against the chain's remainder, before the increment, so the call
        // that would cross it is refused without buying a slot it never uses.
        if (known.remainingCalls !== null && known.remainingCalls <= 0) {
          return { charged: false, admitted: false, budget: known };
        }
      }
      insertLedgerRow.run(
        key,
        options.kind,
        id,
        agent,
        delta.calls,
        delta.tokens,
        delta.usdMicros,
        now(),
      );
      let current: string | null = id;
      let depth = 0;
      while (current !== null && depth < MAX_CHAIN) {
        addSpend.run(delta.calls, delta.tokens, delta.usdMicros, current);
        current = ticketRow(current)?.parent_id ?? null;
        depth += 1;
      }
      return { charged: true, admitted: true, budget: budgetOf(id) ?? known };
    });
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

  /** Refuses unless `actor` may move this ticket to `to` now. The one statement of that rule. */
  const requireClosable = (row: TicketRow, actor: string, to: "done" | "cancelled"): void => {
    const status = statusOf(row.status);
    if (TERMINAL.includes(status)) {
      throw fail("invalid_status", `Ticket ${row.id} is already ${status}.`, { from: status, to });
    }
    if (to === "done" && !COMPLETABLE.includes(status)) {
      throw fail(
        "invalid_status",
        status === "awaiting_confirmation"
          ? `Ticket ${row.id} is awaiting a person's confirmation; it is done when they confirm it.`
          : `Ticket ${row.id} is ${status}; only a claimed, waiting or blocked ticket can be completed.`,
        { from: status, to },
      );
    }
    if (!authorized(row, actor)) {
      throw fail(
        "unauthorized",
        `Ticket ${row.id} is assigned to ${row.assignee ?? "nobody"}; only the assignee or a person can ${to === "done" ? "complete" : "cancel"} it.`,
        { assignee: row.assignee, actor },
      );
    }
  };

  const closeOut = (
    ticketId: string,
    actor: string,
    to: "done" | "cancelled",
    kind: string,
    payload: Record<string, unknown> = {},
  ): Ticket => {
    const id = bounded(ticketId, "Ticket id");
    const closer = bounded(actor, "Actor");
    return transact(() => {
      const row = requireTicket(id);
      requireClosable(row, closer, to);
      moveTicket.run(to, row.assignee, now(), id);
      if (typeof payload.result === "string") setResult.run(payload.result, id);
      // A cancelled ticket takes its waiting approvals with it: nobody should be asked to decide a
      // request for work that has already been called off. Decided ones are untouched — a person's
      // answer is a fact even when the ticket it was about went away.
      if (to === "cancelled") approvalStore.cancelWaitingApprovals(id, closer);
      appendEvent(id, kind, closer, payload);
      return toTicket(requireTicket(id));
    });
  };

  /**
   * One failed attempt, inside the caller's transaction: the `evidence_failed` event, and on the
   * attempt that reaches the limit the block as well. The count is the ticket's own event log, so it
   * survives a restart and nobody keeps a second tally.
   */
  const recordFailure = (
    row: TicketRow,
    actor: string,
    failures: readonly EvidenceResult[],
    blockTo: Assignee | null,
  ): { readonly attempt: number; readonly blocked: boolean } => {
    const attempt = (countFailures.get(row.id) as { count: number }).count + 1;
    appendEvent(row.id, "evidence_failed", actor, { attempt, failures });
    if (attempt < MAX_EVIDENCE_ATTEMPTS) {
      touchTicket.run(now(), row.id);
      return { attempt, blocked: false };
    }
    if (blockTo?.kind === "person" && !isPerson(blockTo.id)) {
      throw fail("invalid_person", `No person ${blockTo.id} on this board.`, { id: blockTo.id });
    }
    const reason = evidenceBlockReason(row.assignee, attempt, failures);
    moveTicket.run("blocked", blockTo?.id ?? row.assignee, now(), row.id);
    appendEvent(
      row.id,
      "blocked",
      actor,
      blockTo === null ? { reason } : { reason, assignee: blockTo },
    );
    return { attempt, blocked: true };
  };

  /**
   * A decided confirmation request, applied to its ticket in the decision's own transaction. Anything
   * else — a tool's approval, or a request whose ticket has since moved on — is left as decided.
   */
  const settleConfirmation = (decided: Approval): void => {
    if (decided.approvalId !== COMPLETION_APPROVAL_ID || decided.decidedBy === null) return;
    const row = ticketRow(decided.ticketId);
    if (row === undefined || row.status !== "awaiting_confirmation") return;
    const by = decided.decidedBy;
    if (decided.status === "approved") {
      const result = objectOf(decided.args)?.result;
      const evidence: EvidenceResult[] = [
        ...evidenceOf(decided.facts?.facts.evidence ?? [], "Recorded evidence"),
        { kind: "person", check: "person", passed: true, found: { confirmedBy: by } },
      ];
      moveTicket.run("done", row.assignee, now(), row.id);
      if (typeof result === "string") setResult.run(result, row.id);
      appendEvent(
        row.id,
        "completed",
        by,
        typeof result === "string" ? { result, evidence } : { evidence },
      );
      return;
    }
    if (decided.status !== "declined") return;
    // Back to the agent that holds it, as a failed attempt: a person saying "not done" is evidence.
    moveTicket.run("claimed", row.assignee, now(), row.id);
    recordFailure(
      row,
      by,
      [
        {
          kind: "person",
          check: "person",
          passed: false,
          reason: decided.decidedNote ?? "the person asked did not confirm the work is done",
        },
      ],
      isPerson(by) ? { kind: "person", id: by } : null,
    );
  };

  const decideApproval = (id: string, decision: ApprovalDecisionInput): Approval =>
    transact(() => {
      const decided = approvalStore.decideApproval(id, decision);
      settleConfirmation(decided);
      return decided;
    });
  // The store as the board publishes it: a decision that answers a confirmation request moves its
  // ticket in the same commit, whichever screen the person decided on.
  const approvals: ApprovalStore = { ...approvalStore, decideApproval };

  return {
    create(input, callerKey) {
      const key = bounded(callerKey, "Caller key");
      const request = normalizeCreate(input);
      // Sorted-key JSON, so the same request written with its fields in another order dedupes to
      // the same caller key: the relay re-sends after a restart in whatever order its encoder used.
      // The canonical form covers what the caller asked for, not what the board resolved it to: a
      // repeat of the same request is the same request, even after the parent's budget has moved.
      const requestJson = canonicalJson(request.request);
      return transact(() => {
        const seen = findKey.get(key) as KeyRow | undefined;
        if (seen !== undefined) {
          if (!sameCanonical(seen.request_json, requestJson)) {
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
        // The ceiling is configured in cents and held in micro-dollars, the unit spend is charged in.
        const requestedUsdMicros =
          request.budget.maxUsdCents === null ? null : request.budget.maxUsdCents * MICROS_PER_CENT;
        const ceilings: BudgetLimits =
          parentBudget === undefined
            ? {
                maxTokens: request.budget.maxTokens,
                maxUsdMicros: requestedUsdMicros,
                maxCalls: request.budget.maxCalls,
              }
            : {
                maxTokens: narrow(
                  remaining(parentBudget.max_tokens, parentBudget.used_tokens),
                  request.budget.maxTokens,
                ),
                maxUsdMicros: narrow(
                  remaining(parentBudget.max_usd_micros, parentBudget.used_usd_micros),
                  requestedUsdMicros,
                ),
                maxCalls: narrow(
                  remaining(parentBudget.max_calls, parentBudget.used_calls),
                  request.budget.maxCalls,
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
        insertBudget.run(
          id,
          ceilings.maxTokens,
          ceilings.maxUsdMicros,
          hopCount,
          maxHops,
          ceilings.maxCalls,
        );
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
      const evidence =
        options.evidence === undefined
          ? undefined
          : evidenceOf(options.evidence, "Completion evidence");
      const warning =
        options.warning === undefined
          ? undefined
          : bounded(options.warning, "Completion warning", NOTE_MAX);
      return closeOut(ticketId, actor, "done", "completed", {
        ...(options.result === undefined ? {} : { result: options.result }),
        ...(evidence === undefined ? {} : { evidence }),
        ...(warning === undefined ? {} : { warning }),
      });
    },
    completable(ticketId, actor) {
      const row = requireTicket(bounded(ticketId, "Ticket id"));
      requireClosable(row, bounded(actor, "Actor"), "done");
      return toTicket(row);
    },
    evidenceFailed(ticketId, actor, options) {
      const id = bounded(ticketId, "Ticket id");
      const by = bounded(actor, "Actor");
      const failures = evidenceOf(options.failures, "Failed evidence");
      if (failures.length === 0 || failures.some((failure) => failure.passed)) {
        throw fail("invalid_argument", "A failed attempt must name at least one failed check.");
      }
      const blockTo = assigneeOf(options.blockTo);
      return transact(() => {
        const row = requireTicket(id);
        requireClosable(row, by, "done");
        const { attempt, blocked } = recordFailure(row, by, failures, blockTo);
        return { ticket: toTicket(requireTicket(id)), attempt, blocked };
      });
    },
    awaitConfirmation(ticketId, actor, request) {
      const id = bounded(ticketId, "Ticket id");
      const by = bounded(actor, "Actor");
      if (typeof request.result !== "string") {
        throw fail("invalid_argument", "Ticket result must be a string.");
      }
      const { result } = request;
      const person = bounded(request.person, "Confirming person");
      const evidence = evidenceOf(request.evidence, "Completion evidence");
      return transact(() => {
        const row = requireTicket(id);
        requireClosable(row, by, "done");
        const asked = approvalStore.requestApproval(id, {
          tool: AGENT_REPLY.name,
          approvalId: COMPLETION_APPROVAL_ID,
          args: { ticketId: id, result },
          requestedBy: by,
          assignee: person,
          facts: {
            summary: `Confirm "${row.title}" (${row.type}) is done: ${result}`.slice(
              0,
              CONFIRMATION_SUMMARY_MAX,
            ),
            facts: { evidence },
          },
        });
        moveTicket.run("awaiting_confirmation", row.assignee, now(), id);
        appendEvent(id, "awaiting_confirmation", by, {
          approvalId: asked.id,
          person,
          result,
          evidence,
        });
        return toTicket(requireTicket(id));
      });
    },
    confirm(ticketId, person, decision) {
      const id = bounded(ticketId, "Ticket id");
      const by = bounded(person, "Confirming person");
      return transact(() => {
        const row = requireTicket(id);
        if (!isPerson(by)) {
          throw fail("unauthorized", `Only a person can confirm a ticket; ${by} is not one here.`, {
            actor: by,
          });
        }
        const asked = approvalStore
          .pendingApprovals({ ticketId: id, tool: AGENT_REPLY.name })
          .find((approval) => approval.approvalId === COMPLETION_APPROVAL_ID);
        if (row.status !== "awaiting_confirmation" || asked === undefined) {
          throw fail(
            "invalid_status",
            `Ticket ${id} is ${row.status}; only a ticket awaiting confirmation can be confirmed.`,
            { from: row.status },
          );
        }
        settleConfirmation(
          approvalStore.decideApproval(asked.id, {
            by,
            decision: decision.confirmed ? "approved" : "declined",
            ...(decision.note === undefined ? {} : { note: decision.note }),
          }),
        );
        return toTicket(requireTicket(id));
      });
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
        if (status === "awaiting_confirmation") {
          // The question in the Inbox is about this assignee's work; moving the ticket would leave a
          // person answering for work that is no longer where they were told it was.
          throw fail(
            "invalid_status",
            `Ticket ${id} is awaiting a person's confirmation; confirm or decline it, or cancel it, before assigning it.`,
            { from: status, to },
          );
        }
        // Routing a ticket decides who may finish it, so it is held to the same rule plus one: the
        // role that opened a ticket may say where it goes.
        if (!authorized(row, by) && row.created_by !== by) {
          throw fail(
            "unauthorized",
            `Ticket ${id} is assigned to ${row.assignee ?? "nobody"}; only its assignee, whoever opened it (${row.created_by}) or a person can assign it.`,
            { assignee: row.assignee, createdBy: row.created_by, actor: by },
          );
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
      if (filter.createdBy !== undefined) {
        clauses.push("created_by = ?");
        values.push(bounded(filter.createdBy, "Creator filter"));
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
    lastEventSeq() {
      return (lastSeq.get() as { seq: number }).seq;
    },
    countByStatus() {
      const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<
        TicketStatus,
        number
      >;
      for (const row of countStatuses.all() as unknown as { status: string; count: number }[]) {
        counts[statusOf(row.status)] = row.count;
      }
      return counts;
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
    block(ticketId, actor, options) {
      const id = bounded(ticketId, "Ticket id");
      const by = bounded(actor, "Actor");
      const why = bounded(options.reason, "Block reason", NOTE_MAX);
      const assignee = assigneeOf(options.assignee);
      return transact(() => {
        const row = requireTicket(id);
        const status = statusOf(row.status);
        if (TERMINAL.includes(status)) {
          throw fail("invalid_status", `Ticket ${id} is already ${status}.`, {
            from: status,
            to: "blocked",
          });
        }
        // One `blocked` event per block. Every later refusal of an exhausted budget would otherwise
        // append another event for a fact already on the record.
        if (status === "blocked") return toTicket(row);
        if (assignee?.kind === "person" && !isPerson(assignee.id)) {
          throw fail("invalid_person", `No person ${assignee.id} on this board.`, {
            id: assignee.id,
          });
        }
        moveTicket.run("blocked", assignee?.id ?? row.assignee, now(), id);
        appendEvent(
          id,
          "blocked",
          by,
          assignee === null ? { reason: why } : { reason: why, assignee },
        );
        return toTicket(requireTicket(id));
      });
    },
    chargeUsage(ticketId, callId, charge) {
      const result = chargeOnce(
        ticketId,
        callId,
        {
          calls: charge.calls ?? 0,
          tokens: charge.tokens ?? 0,
          usdMicros: charge.usdMicros ?? 0,
        },
        { agent: charge.agent, gate: false, kind: "usage" },
      );
      return { charged: result.charged, budget: result.budget };
    },
    admitCall(ticketId, callId, agent) {
      const result = chargeOnce(
        ticketId,
        callId,
        { calls: 1, tokens: 0, usdMicros: 0 },
        { agent, gate: true, kind: "call" },
      );
      return { admitted: result.admitted, charged: result.charged, budget: result.budget };
    },
    budget(ticketId) {
      return budgetOf(bounded(ticketId, "Ticket id"));
    },
    spendByAgent() {
      return (sumByAgent.all() as unknown as SpendRow[]).map((row) => ({
        day: row.day,
        agent: row.agent,
        calls: row.calls,
        tokens: row.tokens,
        usdMicros: row.usd_micros,
      }));
    },
    bindConversation(conversationId, binding) {
      if (typeof conversationId !== "number" || !Number.isInteger(conversationId)) {
        throw fail("invalid_argument", "A conversation id must be a whole number.");
      }
      const ticketId = bounded(binding.ticketId, "Ticket id");
      const agent = bounded(binding.agent, "Agent");
      transact(() => {
        requireTicket(ticketId);
        upsertConversation.run(conversationId, ticketId, agent);
      });
    },
    conversationTicket(conversationId) {
      if (typeof conversationId !== "number" || !Number.isInteger(conversationId)) {
        throw fail("invalid_argument", "A conversation id must be a whole number.");
      }
      const row = findConversation.get(conversationId) as ConversationRow | undefined;
      return row === undefined ? undefined : { ticketId: row.ticket_id, agent: row.agent };
    },
    people() {
      return listPeople.all() as unknown as Person[];
    },
    upsertPeople(people) {
      const rows = people.map((person) => ({
        id: bounded(person?.id, "Person id"),
        name: bounded(person?.name, "Person name"),
      }));
      transact(() => {
        for (const row of rows) upsertPerson.run(row.id, row.name);
      });
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
    approvals,
    sms,
    close() {
      database.close();
    },
  };
}
