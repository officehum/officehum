/**
 * The inbound SMS intake tables, on the board's own handle (RASF-3162).
 *
 * Same shape as `relay-ledger.ts` and `approvals.ts`: prepared statements over a caller-owned
 * `DatabaseSync`, no second connection, no migration work here (migration 6 created the opt-out and
 * rate tables, migration 7 the dedupe table), and every mutating call in its own `BEGIN IMMEDIATE`
 * because the file is shared with the board's own transactions.
 *
 * The duplicate guard is no longer this channel's own table: RASF-3160 moved it to `channel_inbound`,
 * keyed `(channel, external_id)`, so a second channel reuses one decision instead of writing a second
 * copy of it. `recordInboundOnce` here is that store bound to `sms`, which is why the provider's id
 * keeps the name the route has always used for it, and `inbound` is the same store unbounded, for the
 * gateway.
 *
 * The rate counter is incremented before it is read, and a message that takes the count past the limit
 * is refused while still counting. A flood therefore climbs in the table instead of pinning at the
 * ceiling, which is what lets a person looking at the row tell three messages from three hundred.
 */
import type { DatabaseSync } from "node:sqlite";
import { fail } from "./errors.js";
import { type InboundStore, openInboundStore } from "./inbound.js";

/** A number's latest instruction. `stop` is a legal demand, `start` is the way back. */
export type SmsOptOutState = "stop" | "start";

export interface SmsStore {
  /**
   * The same duplicate guard, keyed by channel as well as by id — for the gateway.
   *
   * The methods below are this store bound to `sms`; a second channel calls this one directly with its
   * own name, so one table answers the question for both.
   */
  readonly inbound: InboundStore;
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
  const inbound = openInboundStore(database);
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
    inbound,
    recordInboundOnce(messageSid, at) {
      const sid = text(messageSid, "A MessageSid");
      const receivedAt = text(at, "A receive time");
      return inbound.recordInboundOnce("sms", sid, receivedAt);
    },
    forgetInbound(messageSid) {
      const sid = text(messageSid, "A MessageSid");
      inbound.forgetInbound("sms", sid);
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
