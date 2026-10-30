/**
 * The inbound SMS intake tables, on the board's own handle (RASF-3162).
 *
 * Same shape as `relay-ledger.ts` and `approvals.ts`: prepared statements over a caller-owned
 * `DatabaseSync`, no second connection, no migration work here (migration 6 created these tables), and
 * every mutating call in its own `BEGIN IMMEDIATE` because the file is shared with the board's own
 * transactions.
 *
 * `recordInboundOnce` is the duplicate guard and the whole of it is one `INSERT OR IGNORE` inside one
 * transaction. Twilio retries a delivery it did not get a 2xx for and the retry carries the same
 * MessageSid, so "already seen" and "now recorded" have to be one decision: a `SELECT` followed by an
 * `INSERT` lets two deliveries interleave, both read as unseen, and the office ends up with two tickets
 * about one text. Letting the primary key answer makes the second delivery a no-op by construction.
 * The only delete is `forgetInbound`, used when the route recorded a message and then could not hand
 * it on: that row would otherwise turn the provider's retry into a duplicate of work nobody did.
 *
 * The rate counter is incremented before it is read, and a message that takes the count past the limit
 * is refused while still counting. A flood therefore climbs in the table instead of pinning at the
 * ceiling, which is what lets a person looking at the row tell three messages from three hundred.
 */
import type { DatabaseSync } from "node:sqlite";
import { fail } from "./errors.js";

/** A number's latest instruction. `stop` is a legal demand, `start` is the way back. */
export type SmsOptOutState = "stop" | "start";

export interface SmsStore {
  /** Record the provider's message id; false when it was already recorded. */
  recordInboundOnce(messageSid: string, at: string): boolean;
  /**
   * Forget a message id, so the provider's retry is treated as a first delivery.
   *
   * This exists for one case: the route recorded the message, then could not hand it to the office.
   * The record exists to stop a retry creating a second ticket, and a retry after a failed hand-off is
   * the retry that should create the first one — so the row is removed rather than allowed to swallow
   * the provider's only second chance. It is not a general delete: nothing else calls it.
   */
  forgetInbound(messageSid: string): void;
  /** Replace a number's state with what they just said. */
  setOptOut(number: string, state: SmsOptOutState, at: string): void;
  /** The number's latest state, or `undefined` for a number that never said either word. */
  optOutOf(number: string): SmsOptOutState | undefined;
  /** Count this message against the number's window and answer whether it may go on. */
  countInWindow(
    number: string,
    windowStart: string,
    limit: number,
  ): { readonly allowed: boolean; readonly count: number };
}

type CountRow = { count: number };
type StateRow = { state: string };

function text(value: string, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw fail("invalid_argument", `${what} is required.`);
  }
  return value;
}

export function openSmsStore(database: DatabaseSync): SmsStore {
  const insertInbound = database.prepare(
    "INSERT OR IGNORE INTO sms_inbound (message_sid, received_at) VALUES (?, ?)",
  );
  const deleteInbound = database.prepare("DELETE FROM sms_inbound WHERE message_sid = ?");
  const upsertOptOut = database.prepare(
    `INSERT INTO sms_optouts (number, state, at) VALUES (?, ?, ?)
     ON CONFLICT(number) DO UPDATE SET state = excluded.state, at = excluded.at`,
  );
  const findOptOut = database.prepare("SELECT state FROM sms_optouts WHERE number = ?");
  const bumpRate = database.prepare(
    `INSERT INTO sms_rate (number, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(number, window_start) DO UPDATE SET count = count + 1`,
  );
  const readCount = database.prepare(
    "SELECT count FROM sms_rate WHERE number = ? AND window_start = ?",
  );

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
    recordInboundOnce(messageSid, at) {
      const sid = text(messageSid, "A MessageSid");
      const receivedAt = text(at, "A receive time");
      return transact(() => Number(insertInbound.run(sid, receivedAt).changes) > 0);
    },
    forgetInbound(messageSid) {
      const sid = text(messageSid, "A MessageSid");
      transact(() => {
        deleteInbound.run(sid);
      });
    },
    setOptOut(number, state, at) {
      const who = text(number, "A number");
      const when = text(at, "A time");
      if (state !== "stop" && state !== "start") {
        throw fail("invalid_argument", `An opt-out state is 'stop' or 'start', not '${state}'.`);
      }
      transact(() => {
        upsertOptOut.run(who, state, when);
      });
    },
    optOutOf(number) {
      const row = findOptOut.get(text(number, "A number")) as StateRow | undefined;
      if (row === undefined) return undefined;
      if (row.state !== "stop" && row.state !== "start") {
        throw new Error(`sms_optouts holds an unknown state: ${row.state}.`);
      }
      return row.state;
    },
    countInWindow(number, windowStart, limit) {
      const who = text(number, "A number");
      const window = text(windowStart, "A window start");
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw fail("invalid_argument", "A rate limit is a whole number of 0 or more.");
      }
      return transact(() => {
        bumpRate.run(who, window);
        const row = readCount.get(who, window) as CountRow | undefined;
        const count = row?.count ?? 0;
        return { allowed: count <= limit, count };
      });
    },
  };
}
