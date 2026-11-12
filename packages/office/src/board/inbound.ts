/**
 * The one inbound dedupe table (RASF-3160).
 *
 * Every channel used to remember handled messages in its own place — SMS in `sms_inbound`, keyed by the
 * MessageSid; email inside its own receipt machine — and the copies were the reason a third channel was
 * a third answer to one question. There is one table now, and one call that decides whether a delivery
 * is the first one.
 *
 * Keyed by `(channel, external_id)` and not by the id alone, because a MessageSid and a Resend message
 * id are different namespaces: two providers can mint the same string, and a coincidence between them
 * must not swallow a real message.
 *
 * `recordInboundOnce` is one `INSERT OR IGNORE` inside one transaction, and the whole of it is the
 * primary key. Providers retry a delivery they did not get a 2xx for, and the retry carries the same
 * id, so "already seen" and "now recorded" have to be one decision: a `SELECT` followed by an `INSERT`
 * lets two deliveries interleave, both read as unseen, and the office ends up with two tickets about
 * one text. The only delete is `forgetInbound`, used when the route recorded a message and then could
 * not hand it on: that row would otherwise turn the provider's retry into a duplicate of work nobody
 * did.
 */
import type { DatabaseSync } from "node:sqlite";
import { transact } from "../shared/transact.js";
import { fail } from "./errors.js";

export interface InboundStore {
  /** Record the provider's id for this channel; false when it was already recorded. */
  recordInboundOnce(channel: string, externalId: string, receivedAt: string): boolean;
  /**
   * Forget one message, so the provider's retry is treated as a first delivery.
   *
   * This exists for one case: the route recorded the message, then could not hand it to the office.
   * The record exists to stop a retry creating a second ticket, and a retry after a failed hand-off is
   * the retry that should create the first one — so the row is removed rather than allowed to swallow
   * the provider's only second chance. It is not a general delete: nothing else calls it.
   */
  forgetInbound(channel: string, externalId: string): void;
}

function text(value: string, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw fail("invalid_argument", `${what} is required.`);
  }
  return value;
}

export function openInboundStore(database: DatabaseSync): InboundStore {
  const insert = database.prepare(
    "INSERT OR IGNORE INTO channel_inbound (channel, external_id, received_at) VALUES (?, ?, ?)",
  );
  const remove = database.prepare(
    "DELETE FROM channel_inbound WHERE channel = ? AND external_id = ?",
  );

  return {
    recordInboundOnce(channel, externalId, receivedAt) {
      const name = text(channel, "A channel");
      const id = text(externalId, "A provider message id");
      const at = text(receivedAt, "A receive time");
      return transact(database, () => Number(insert.run(name, id, at).changes) > 0);
    },
    forgetInbound(channel, externalId) {
      const name = text(channel, "A channel");
      const id = text(externalId, "A provider message id");
      transact(database, () => {
        remove.run(name, id);
      });
    },
  };
}
