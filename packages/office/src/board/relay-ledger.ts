/**
 * The relay's ledger, attached to the board's own handle (RASF-3067).
 *
 * `openRelayLedger` takes the `DatabaseSync` the board already opened. Two things follow. The ledger
 * writes and the board's reads see one atomic history — a cursor read and an event scan cannot land
 * between them and disagree. And the file stays single-writer: the relay never opens `board.sqlite`
 * on its own, so the single-owner lock above `openSolo` remains the only lease there is.
 *
 * The shape mirrors `openCalendarStore`: prepared statements over a caller-owned handle, no second
 * connection, no migration work (migration 2 created these tables). Every mutating call runs in its
 * own `BEGIN IMMEDIATE`, because the relay may be the only writer but the file is shared with the
 * board's own transactions.
 *
 * Why the cursor advances in the same transaction as the ledger row: the pair is the relay's whole
 * correctness argument. If the cursor moved first, a crash would leave an event the relay believes it
 * has delivered and no row to prove otherwise; if the row came first, a crash would re-deliver. One
 * transaction makes "the cursor is never past an undelivered event" a property of the file rather
 * than of the relay's ordering.
 */
import type { DatabaseSync } from "node:sqlite";

/** A delivery's whole lifecycle. `settled` and `failed` are terminal; `skipped` is terminal at birth. */
export type DeliveryState = "pending" | "admitted" | "settled" | "skipped" | "failed";

/** One row of `relay_deliveries`. */
export interface DeliveryRecord {
  readonly eventId: string;
  readonly seq: number;
  readonly ticketId: string;
  readonly kind: string;
  readonly targetKey: string;
  readonly submissionId: number | null;
  readonly state: DeliveryState;
  readonly outcome: string | null;
  readonly at: string;
}

/** One row of `relay_waits`: the durable wait's task, found again by ticket after a restart. */
export interface WaitRecord {
  readonly ticketId: string;
  readonly taskId: number;
  readonly conversationId: number;
  readonly deadlineMs: number | null;
}

/** The first write of a delivery: the row, plus the cursor move, in one transaction. */
export interface BeginDelivery {
  readonly eventId: string;
  readonly seq: number;
  readonly ticketId: string;
  readonly kind: string;
  /** The conversation the event goes to, or `""` when nothing is delivered. */
  readonly targetKey: string;
  readonly state: "pending" | "skipped";
  readonly at: string;
}

export interface RelayLedger {
  /** The highest event `seq` the relay has accounted for; 0 before anything is delivered. */
  cursor(): number;
  /** Record the delivery (or the decision not to deliver) and move the cursor, atomically. */
  begin(delivery: BeginDelivery): void;
  /** Pi Durable admitted the submission; keep its id so a restart can reacquire it. */
  admitted(eventId: string, submissionId: number): void;
  /** Terminal state and, for a settled delivery, the answer text the delegate produced. */
  settle(eventId: string, state: "settled" | "skipped" | "failed", outcome: string | null): void;
  delivery(eventId: string): DeliveryRecord | undefined;
  /** Deliveries that are not terminal, in cursor order: what `recover` re-submits. */
  openDeliveries(): DeliveryRecord[];
  /** Every delivery for one ticket, in cursor order. */
  deliveriesForTicket(ticketId: string): DeliveryRecord[];
  /** Remember the wait's task, replacing any earlier one for the ticket. */
  recordWait(wait: WaitRecord): void;
  wait(ticketId: string): WaitRecord | undefined;
  clearWait(ticketId: string): void;
}

type DeliveryRow = {
  event_id: string;
  seq: number;
  ticket_id: string;
  kind: string;
  target_key: string;
  submission_id: number | null;
  state: string;
  outcome: string | null;
  at: string;
};

type WaitRow = {
  ticket_id: string;
  task_id: number;
  conversation_id: number;
  deadline_ms: number | null;
};

const STATES: readonly DeliveryState[] = ["pending", "admitted", "settled", "skipped", "failed"];

function deliveryState(value: string): DeliveryState {
  if (!STATES.includes(value as DeliveryState)) {
    throw new Error(`relay_deliveries holds an unknown state: ${value}.`);
  }
  return value as DeliveryState;
}

function toDelivery(row: DeliveryRow): DeliveryRecord {
  return {
    eventId: row.event_id,
    seq: row.seq,
    ticketId: row.ticket_id,
    kind: row.kind,
    targetKey: row.target_key,
    submissionId: row.submission_id,
    state: deliveryState(row.state),
    outcome: row.outcome,
    at: row.at,
  };
}

function toWait(row: WaitRow): WaitRecord {
  return {
    ticketId: row.ticket_id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    deadlineMs: row.deadline_ms,
  };
}

export function openRelayLedger(database: DatabaseSync): RelayLedger {
  const readCursor = database.prepare("SELECT seq FROM relay_cursor WHERE id = 1");
  const moveCursor = database.prepare("UPDATE relay_cursor SET seq = ? WHERE id = 1");
  const insertDelivery = database.prepare(
    `INSERT INTO relay_deliveries
       (event_id, seq, ticket_id, kind, target_key, submission_id, state, outcome, at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
  );
  const admitDelivery = database.prepare(
    "UPDATE relay_deliveries SET state = 'admitted', submission_id = ? WHERE event_id = ?",
  );
  const finishDelivery = database.prepare(
    "UPDATE relay_deliveries SET state = ?, outcome = ? WHERE event_id = ?",
  );
  const findDelivery = database.prepare("SELECT * FROM relay_deliveries WHERE event_id = ?");
  const findOpen = database.prepare(
    `SELECT * FROM relay_deliveries WHERE state IN ('pending', 'admitted') ORDER BY seq`,
  );
  const findForTicket = database.prepare(
    "SELECT * FROM relay_deliveries WHERE ticket_id = ? ORDER BY seq",
  );
  const insertWait = database.prepare(
    `INSERT INTO relay_waits (ticket_id, task_id, conversation_id, deadline_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ticket_id) DO UPDATE SET
       task_id = excluded.task_id,
       conversation_id = excluded.conversation_id,
       deadline_ms = excluded.deadline_ms`,
  );
  const findWait = database.prepare("SELECT * FROM relay_waits WHERE ticket_id = ?");
  const deleteWait = database.prepare("DELETE FROM relay_waits WHERE ticket_id = ?");

  const transact = <T>(work: () => T): T => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      database.exec("COMMIT");
      return value;
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    cursor() {
      const row = readCursor.get() as { seq: number } | undefined;
      return row?.seq ?? 0;
    },
    begin(delivery) {
      transact(() => {
        insertDelivery.run(
          delivery.eventId,
          delivery.seq,
          delivery.ticketId,
          delivery.kind,
          delivery.targetKey,
          delivery.state,
          delivery.at,
        );
        moveCursor.run(delivery.seq);
      });
    },
    admitted(eventId, submissionId) {
      transact(() => {
        admitDelivery.run(submissionId, eventId);
      });
    },
    settle(eventId, state, outcome) {
      transact(() => {
        finishDelivery.run(state, outcome, eventId);
      });
    },
    delivery(eventId) {
      const row = findDelivery.get(eventId) as DeliveryRow | undefined;
      return row === undefined ? undefined : toDelivery(row);
    },
    openDeliveries() {
      return (findOpen.all() as unknown as DeliveryRow[]).map(toDelivery);
    },
    deliveriesForTicket(ticketId) {
      return (findForTicket.all(ticketId) as unknown as DeliveryRow[]).map(toDelivery);
    },
    recordWait(wait) {
      transact(() => {
        insertWait.run(wait.ticketId, wait.taskId, wait.conversationId, wait.deadlineMs);
      });
    },
    wait(ticketId) {
      const row = findWait.get(ticketId) as WaitRow | undefined;
      return row === undefined ? undefined : toWait(row);
    },
    clearWait(ticketId) {
      transact(() => {
        deleteWait.run(ticketId);
      });
    },
  };
}
