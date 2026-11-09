/**
 * The verified sender Office Hum hands a role (`loadRole(dir, { sender })`): who is asking, read
 * from the board rather than from anything the model or the message can say.
 *
 * The board already knows. A root ticket records where its work came from once, as its provenance
 * row (the channel gateway resolved the SMS or email sender before the ticket existed), and every
 * child ticket copies its root's row verbatim, so delegated work keeps the original asker. The
 * relay binds each delivery's conversation to its ticket, which is how a hook or tool, seeing only
 * its conversation, finds the ticket — the same read `budgetHooks` and the approval gate make.
 */

import type { SenderResolver } from "@officehum/sdk";
import type { Board } from "../board/index.js";

/**
 * A resolver over the board: the provenance of the ticket the call's conversation is bound to, or
 * `undefined` for a conversation with no ticket or a ticket with no provenance. A board that cannot
 * answer throws: an unreadable record is not an unknown sender.
 */
export function boardSenderResolver(board: Board): SenderResolver {
  return async ({ conversationId }) => {
    // Pi Durable's conversation ids are whole numbers; anything else names no conversation the
    // board could have bound, so nobody is asking rather than the board refusing the lookup.
    if (typeof conversationId !== "number" || !Number.isInteger(conversationId)) return undefined;
    const ticket = board.conversationTicket(conversationId);
    if (ticket === undefined) return undefined;
    const provenance = board.provenance(ticket.ticketId);
    return provenance === undefined
      ? undefined
      : {
          origin: provenance.origin,
          channel: provenance.sourceChannel,
          contact: provenance.sourceContact,
        };
  };
}
