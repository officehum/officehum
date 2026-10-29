/**
 * The approvals store: one durable record of every approval request and every decision (RASF-3138).
 *
 * It lives on the board's own handle, like the relay's ledger (`relay-ledger.ts`), because an approval
 * and the ticket it is about must be one atomic history: a person decides in the Inbox while the
 * office is mid-turn, and the gate that reads the decision has to see the row the human's screen
 * committed. A second SQLite file would be a second record that can disagree with this one.
 *
 * Four properties are the whole design, and each one exists because the opposite is a known failure:
 *
 * - **An approval is bound to the exact arguments.** The row carries `args_json` (canonicalised) and
 *   `args_hash`, and the gate matches `tool + args_hash`, never the tool alone. A person who approved a
 *   $500 refund has not approved a $50,000 one; approving a tool is not approving every use of it.
 * - **A decision is made once.** `decideApproval` refuses a row that already carries a decision, and a
 *   trigger refuses the UPDATE as well, so a second writer — a Teams card retried, an Inbox screen on a
 *   stale page — cannot overwrite what a person said. The API is the first line; the schema is the
 *   line that holds when the API is bypassed.
 * - **A request that was asked about once is one row.** Re-requesting the same `(ticket, tool, args)`
 *   while it is still waiting returns the row that exists. A model that retries on every turn must not
 *   grow the inbox one duplicate per retry, and a partial unique index makes "one waiting ask" a fact
 *   of the file rather than a habit of the caller.
 * - **Waiting ends without a sweeper.** `expires_at` is a deadline for the decision, and expiry is
 *   *computed on read*: a waiting row past its deadline reports and filters as `expired`. A sweeper
 *   would be a second writer whose absence makes a read wrong, so there isn't one.
 *
 * There is no model-facing decision method here on purpose; see the note in `extension/index.ts` where
 * the office's tools are listed. The model may cause a request (a condition, or the gate); a person is
 * the only thing that can answer one.
 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BoardError, fail } from "./errors.js";

/** A request's whole lifecycle. `expired` and `cancelled` end a wait without a person deciding it. */
export type ApprovalStatus = "waiting" | "approved" | "declined" | "expired" | "cancelled";

/** One approval request and, once a person has answered, their decision. */
export interface Approval {
  readonly id: string;
  readonly ticketId: string;
  /**
   * The declared approval this request is for (`officehum.json`'s `approvals[].id`), or the tool's own
   * name when the asker named none. It is a label for the person reading the inbox; the binding that
   * the gate enforces is `ticketId + tool + argsHash`, never this.
   */
  readonly approvalId: string;
  readonly tool: string;
  /** The arguments as JSON, parsed back from the canonical text that was hashed. */
  readonly args: unknown;
  /** SHA-256 of `canonicalArgs(args)`. What an approval actually covers. */
  readonly argsHash: string;
  /** As stored, plus `expired` computed from `expiresAt` against the clock. */
  readonly status: ApprovalStatus;
  /** The agent that asked, or null on a row written before this issue could record one. */
  readonly requestedBy: string | null;
  /** The `people.id` the request is addressed to, when one was named. */
  readonly assignee: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decidedNote: string | null;
  readonly createdAt: string;
  /** The deadline for the decision; null waits until someone decides or the ticket is cancelled. */
  readonly expiresAt: string | null;
}

/** What `requestApproval` is told. `args` is the tool call's own arguments, not a summary of them. */
export interface ApprovalRequestInput {
  readonly tool: string;
  readonly args: unknown;
  /** The agent asking. Recorded so the inbox can say who is waiting. */
  readonly requestedBy: string;
  /** `officehum.json`'s approval id, when the ask came from a declared one. */
  readonly approvalId?: string;
  /** The `people.id` the request is addressed to. Refused if the office does not know them. */
  readonly assignee?: string;
  /** How long the request waits for a decision. Omitted: until someone decides or the ticket is cancelled. */
  readonly ttlMs?: number;
}

/** A person's answer. `expired` and `cancelled` are the clock's and the ticket's, never a decision. */
export interface ApprovalDecisionInput {
  readonly by: string;
  readonly decision: "approved" | "declined";
  readonly note?: string;
}

/** Which waiting requests a reader wants. Every field narrows; none is required. */
export interface ApprovalFilter {
  readonly ticketId?: string;
  readonly tool?: string;
  readonly requestedBy?: string;
  readonly limit?: number;
}

export interface ApprovalStore {
  /**
   * Ask a person to approve this exact call. Idempotent while a request for the same
   * `(ticket, tool, args)` is still waiting: the existing row comes back rather than a second one.
   */
  requestApproval(ticketId: string, request: ApprovalRequestInput): Approval;
  /**
   * Record a person's decision. The first decision stands: deciding an already-decided, expired or
   * cancelled request is refused rather than silently overwritten.
   */
  decideApproval(id: string, decision: ApprovalDecisionInput): Approval;
  /** Waiting requests past their start, oldest first, with expiry applied on read. */
  pendingApprovals(filter?: ApprovalFilter): Approval[];
  /** One request by its store id, whatever its status. */
  approvalOf(id: string): Approval | undefined;
  /**
   * The approval the gate needs: a granted, unexpired decision for this ticket, this tool and exactly
   * these arguments. `undefined` means the call is not covered and must not run.
   */
  approvalCovering(ticketId: string, tool: string, argsHash: string): Approval | undefined;
  /**
   * The newest request for one exact call, whatever became of it.
   *
   * The gate needs this to tell two uncovered calls apart. "Nobody has been asked" means ask; "a person
   * declined this, or the ticket was cancelled" means the answer is already no, and asking again every
   * turn is the flood the waiting dedupe exists to prevent, only later. Expiry is deliberately not one
   * of those: the request lapsed without an answer, so a fresh ask is legitimate.
   */
  latestForCall(ticketId: string, tool: string, argsHash: string): Approval | undefined;
  /**
   * End every waiting request on a ticket, recording who cancelled the work. Called by the board's own
   * `cancel` in its transaction, so a cancelled ticket never has an approval still waiting on it.
   */
  cancelWaitingApprovals(ticketId: string, by: string): number;
}

/**
 * Canonical JSON for tool arguments: object keys sorted at every level, arrays kept in order.
 *
 * Sorting is what makes the hash order-independent — `{amount: 500, to: "acme"}` and
 * `{to: "acme", amount: 500}` are the same request and must be the same digest, or a model could slip
 * past an approval just by re-emitting its arguments in another order. Arrays are *not* sorted:
 * `["a", "b"]` and `["b", "a"]` are different arguments, and a hash that thought otherwise would let
 * one cover the other.
 *
 * The comparison is by UTF-16 code unit, not `localeCompare`, because a hash must not depend on the
 * host's locale: the office that approves and the process that checks may not be the same machine.
 *
 * Nothing JSON would coerce is accepted. `JSON.stringify` turns `NaN` into `null`, drops an
 * `undefined` value, and writes a `Date` as `{}` — three ways two different argument objects would
 * collapse to one canonical text, and therefore one approval covering something nobody approved. Each
 * of those is refused here instead, with the path to the offending value.
 */
export function canonicalArgs(value: unknown): string {
  const encode = (item: unknown, path: string): string => {
    if (item === null) return "null";
    if (typeof item === "string") return JSON.stringify(item);
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw fail(
          "invalid_argument",
          `Approval arguments must contain finite numbers; ${path} is ${String(item)}.`,
        );
      }
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      return `[${item.map((child, index) => encode(child, `${path}[${index}]`)).join(",")}]`;
    }
    const record = item !== null && typeof item === "object" ? (item as object) : undefined;
    if (record === undefined) {
      throw fail(
        "invalid_argument",
        `Approval arguments must be JSON; ${path} is ${item === undefined ? "undefined" : typeof item}.`,
      );
    }
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      // A Date, a Map, a class instance: JSON would write most of these as `{}` and lose the value.
      throw fail(
        "invalid_argument",
        `Approval arguments must be plain objects and arrays; ${path} is ${
          (record as { constructor?: { name?: string } }).constructor?.name ?? "an object"
        }.`,
      );
    }
    const fields = record as Record<string, unknown>;
    const keys = Object.keys(fields).sort(compareCodeUnits);
    return `{${keys
      .map((key) => {
        const child = fields[key];
        if (child === undefined) {
          throw fail(
            "invalid_argument",
            `Approval arguments must not carry undefined; ${path}.${key} is undefined.`,
          );
        }
        return `${JSON.stringify(key)}:${encode(child, `${path}.${key}`)}`;
      })
      .join(",")}}`;
  };
  return encode(value, "args");
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** SHA-256 of the canonical text, in lowercase hex. The one hashing rule this store and the gate share. */
export function hashOfCanonical(json: string): string {
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/** The digest an approval covers, from arguments as the tool call carries them. */
export function argsHash(value: unknown): string {
  return hashOfCanonical(canonicalArgs(value));
}

const STATUSES: readonly ApprovalStatus[] = [
  "waiting",
  "approved",
  "declined",
  "expired",
  "cancelled",
];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const NOTE_MAX = 5000;

type ApprovalRow = {
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
  args_hash: string;
  requested_by: string | null;
  assignee: string | null;
  expires_at: string | null;
};

function text(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string") throw fail("invalid_argument", `${label} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximum) {
    throw fail(
      "invalid_argument",
      `${label} must be between 1 and ${maximum} characters, got ${trimmed.length}.`,
    );
  }
  return trimmed;
}

function statusOf(value: string): ApprovalStatus {
  if (!STATUSES.includes(value as ApprovalStatus)) {
    throw new Error(`approvals holds an unknown status: ${value}.`);
  }
  return value as ApprovalStatus;
}

function argumentsOf(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("approvals holds malformed args_json.");
  }
}

export interface ApprovalStoreOptions {
  /** The clock expiry is computed against. Tests move it; production leaves it alone. */
  readonly now?: () => number;
}

export function openApprovalStore(
  database: DatabaseSync,
  options: ApprovalStoreOptions = {},
): ApprovalStore {
  const clock = options.now ?? (() => Date.now());
  const nowIso = (): string => new Date(clock()).toISOString();

  const findRow = database.prepare("SELECT * FROM approvals WHERE id = ?");
  const findTicket = database.prepare("SELECT 1 AS present FROM tickets WHERE id = ?");
  const findPerson = database.prepare("SELECT 1 AS present FROM people WHERE id = ?");
  const findWaiting = database.prepare(
    `SELECT * FROM approvals
      WHERE ticket_id = ? AND tool = ? AND args_hash = ? AND status = 'waiting'
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at ASC, rowid ASC LIMIT 1`,
  );
  const findAnyWaiting = database.prepare(
    `SELECT * FROM approvals
      WHERE ticket_id = ? AND tool = ? AND args_hash = ? AND status = 'waiting'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`,
  );
  const insertRow = database.prepare(
    `INSERT INTO approvals
       (id, ticket_id, approval_id, tool, args_json, status, decided_by, decided_at, decided_note,
        created_at, args_hash, requested_by, assignee, expires_at)
     VALUES (?, ?, ?, ?, ?, 'waiting', NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
  );
  const decideRow = database.prepare(
    `UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decided_note = ?
      WHERE id = ? AND status = 'waiting'`,
  );
  const expireRow = database.prepare(
    "UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'waiting'",
  );
  const cancelTicket = database.prepare(
    `UPDATE approvals SET status = 'cancelled', decided_by = ?, decided_at = ?, decided_note = ?
      WHERE ticket_id = ? AND status = 'waiting'`,
  );
  const coverRow = database.prepare(
    `SELECT * FROM approvals
      WHERE ticket_id = ? AND tool = ? AND args_hash = ? AND status = 'approved'
      ORDER BY decided_at DESC, rowid DESC LIMIT 1`,
  );
  const latestRow = database.prepare(
    `SELECT * FROM approvals
      WHERE ticket_id = ? AND tool = ? AND args_hash = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );

  /**
   * A trigger abort is the schema refusing a second decision. Surfacing it as `immutable` keeps a
   * caller from parsing SQLite's message, and matches what `index.ts` does for the append-only tables.
   */
  const surface = (error: unknown): unknown => {
    if (error instanceof BoardError) return error;
    if (error instanceof Error && error.message.includes("immutable")) {
      return fail("immutable", error.message);
    }
    return error;
  };

  /**
   * One transaction per mutation. A call made while the board's own transaction is open — `cancel`,
   * which ends a ticket's waiting approvals in the same commit that cancels the ticket — joins that
   * transaction instead of opening a second one, so the ticket's status and its requests cannot land
   * apart.
   */
  const transact = <T>(work: () => T): T => {
    if (database.isTransaction) {
      try {
        return work();
      } catch (error) {
        throw surface(error);
      }
    }
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

  const rowOf = (id: string): ApprovalRow | undefined => findRow.get(id) as ApprovalRow | undefined;

  const requireRow = (id: string): ApprovalRow => {
    const row = rowOf(id);
    if (row === undefined) throw fail("not_found", `No approval ${id} on this board.`);
    return row;
  };

  /**
   * Stored status plus the clock. A waiting row whose deadline has arrived reads as `expired` — at the
   * deadline the window has closed, which is why the comparison is `<=` and not `<`.
   * `expires_at` is an ISO-8601 UTC string from `toISOString()`, so comparing it as text (here and in
   * the SQL above) orders it correctly without parsing it back.
   */
  const toApproval = (row: ApprovalRow): Approval => {
    const stored = statusOf(row.status);
    const expired = stored === "waiting" && row.expires_at !== null && row.expires_at <= nowIso();
    return {
      id: row.id,
      ticketId: row.ticket_id,
      approvalId: row.approval_id,
      tool: row.tool,
      args: argumentsOf(row.args_json),
      argsHash: row.args_hash,
      status: expired ? "expired" : stored,
      requestedBy: row.requested_by,
      assignee: row.assignee,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      decidedNote: row.decided_note,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  };

  const limitOf = (value: number | undefined): number => {
    if (value === undefined) return DEFAULT_LIMIT;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw fail("invalid_argument", "An approvals limit must be a whole number of 1 or more.");
    }
    return Math.min(value, MAX_LIMIT);
  };

  const requestApproval = (ticketId: string, request: ApprovalRequestInput): Approval => {
    const id = text(ticketId, "Ticket id");
    const tool = text(request.tool, "Approval tool");
    const requestedBy = text(request.requestedBy, "Approval requester");
    const approvalId =
      request.approvalId === undefined ? tool : text(request.approvalId, "Approval id");
    const assignee =
      request.assignee === undefined ? null : text(request.assignee, "Approval assignee");
    let ttlMs: number | null = null;
    if (request.ttlMs !== undefined) {
      if (
        typeof request.ttlMs !== "number" ||
        !Number.isInteger(request.ttlMs) ||
        request.ttlMs < 0
      ) {
        throw fail("invalid_argument", "An approval's ttlMs must be a whole number of 0 or more.");
      }
      ttlMs = request.ttlMs;
    }
    const argsJson = canonicalArgs(request.args);
    const hash = hashOfCanonical(argsJson);
    const at = nowIso();

    return transact(() => {
      if (findTicket.get(id) === undefined) {
        throw fail("not_found", `No ticket ${id} on this board.`);
      }
      if (assignee !== null && findPerson.get(assignee) === undefined) {
        throw fail("invalid_person", `No person ${assignee} on this board.`, { id: assignee });
      }
      const waiting = findWaiting.get(id, tool, hash, at) as ApprovalRow | undefined;
      if (waiting !== undefined) return toApproval(waiting);

      // An older ask for the same call whose deadline passed is still `waiting` on disk, and the
      // partial unique index counts it. Close it as `expired` — the honest status, and the one that
      // lets a fresh ask take its place without deleting the record of the first.
      const stale = findAnyWaiting.get(id, tool, hash) as ApprovalRow | undefined;
      if (stale !== undefined) expireRow.run(stale.id);

      const expiresAt =
        ttlMs === null ? null : new Date(new Date(at).getTime() + ttlMs).toISOString();
      const approvalUuid = randomUUID();
      insertRow.run(
        approvalUuid,
        id,
        approvalId,
        tool,
        argsJson,
        at,
        hash,
        requestedBy,
        assignee,
        expiresAt,
      );
      return toApproval(requireRow(approvalUuid));
    });
  };

  const decideApproval = (id: string, decision: ApprovalDecisionInput): Approval => {
    const approvalId = text(id, "Approval id");
    const by = text(decision.by, "Approval decider");
    if (decision.decision !== "approved" && decision.decision !== "declined") {
      throw fail(
        "invalid_argument",
        `An approval decision must be "approved" or "declined", got ${String(decision.decision)}.`,
      );
    }
    const note =
      decision.note === undefined ? null : text(decision.note, "Approval note", NOTE_MAX);

    return transact(() => {
      const row = requireRow(approvalId);
      const current = toApproval(row);
      if (current.status !== "waiting") {
        if (current.status === "expired") {
          throw fail(
            "invalid_status",
            `Approval ${approvalId} expired at ${String(current.expiresAt)} and cannot be decided; the action it was for did not run.`,
            { from: current.status, to: decision.decision },
          );
        }
        const by = current.decidedBy === null ? "" : ` by ${current.decidedBy}`;
        const when = current.decidedAt === null ? "" : ` at ${current.decidedAt}`;
        throw fail(
          "immutable",
          `Approval ${approvalId} is already ${current.status}${by}${when}; a decision is recorded once and the first one stands.`,
          { from: current.status, to: decision.decision },
        );
      }
      const at = nowIso();
      const changes = Number(decideRow.run(decision.decision, by, at, note, approvalId).changes);
      // The read above and this write are one transaction, so zero changes means the trigger or a
      // second handle got there first: refuse rather than report a decision nobody made.
      if (changes === 0) {
        throw fail("immutable", `Approval ${approvalId} was decided by someone else first.`, {
          from: toApproval(requireRow(approvalId)).status,
        });
      }
      return toApproval(requireRow(approvalId));
    });
  };

  return {
    requestApproval,
    decideApproval,
    pendingApprovals(filter = {}) {
      const values: string[] = [nowIso()];
      const clauses: string[] = [];
      if (filter.ticketId !== undefined) {
        clauses.push("ticket_id = ?");
        values.push(text(filter.ticketId, "Ticket filter"));
      }
      if (filter.tool !== undefined) {
        clauses.push("tool = ?");
        values.push(text(filter.tool, "Tool filter"));
      }
      if (filter.requestedBy !== undefined) {
        clauses.push("requested_by = ?");
        values.push(text(filter.requestedBy, "Requester filter"));
      }
      const where = clauses.length === 0 ? "" : ` AND ${clauses.join(" AND ")}`;
      const rows = database
        .prepare(
          `SELECT * FROM approvals
            WHERE status = 'waiting' AND (expires_at IS NULL OR expires_at > ?)${where}
            ORDER BY created_at ASC, rowid ASC LIMIT ?`,
        )
        .all(...values, limitOf(filter.limit));
      return (rows as unknown as ApprovalRow[]).map(toApproval);
    },
    approvalOf(id) {
      const row = rowOf(text(id, "Approval id"));
      return row === undefined ? undefined : toApproval(row);
    },
    approvalCovering(ticketId, tool, argsHashValue) {
      const row = coverRow.get(
        text(ticketId, "Ticket id"),
        text(tool, "Tool"),
        text(argsHashValue, "Arguments hash", 64),
      ) as ApprovalRow | undefined;
      return row === undefined ? undefined : toApproval(row);
    },
    latestForCall(ticketId, tool, argsHashValue) {
      const row = latestRow.get(
        text(ticketId, "Ticket id"),
        text(tool, "Tool"),
        text(argsHashValue, "Arguments hash", 64),
      ) as ApprovalRow | undefined;
      return row === undefined ? undefined : toApproval(row);
    },
    cancelWaitingApprovals(ticketId, by) {
      const id = text(ticketId, "Ticket id");
      const actor = text(by, "Actor");
      return transact(() => {
        const at = nowIso();
        return Number(cancelTicket.run(actor, at, "the ticket was cancelled", id).changes);
      });
    },
  };
}
