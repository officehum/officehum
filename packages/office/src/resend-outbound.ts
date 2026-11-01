/**
 * Resend, as the office's one outbound adapter (RASF-3160).
 *
 * The transport itself is `resend-replies.ts` and is unchanged: same threading headers, same durable
 * reply-operation row, same idempotency key. This is the two-line seam that makes it *an adapter* — a
 * channel name and a `deliver(intent, idempotencyKey)` — so the dispatcher can look it up in the
 * registry instead of every caller holding a messenger and knowing what to do with it.
 *
 * The idempotency key is the caller's, and it becomes the reply operation's `requestId`: a retried
 * approval replays the delivery it already made rather than sending a second email.
 *
 * Nothing here implements `sms`, and nothing can: `ChannelRegistry.outbound("sms")` throws
 * `NoAdapterError` because no adapter was ever registered under that name.
 */
import type { DeliveryReceipt, OutboundAdapter, OutboundIntent } from "@officehum/channels";
import type { ReplyMessenger } from "./resend-replies.js";

/**
 * An email the office may send: who it goes to, what it says, and which receipt it answers.
 *
 * `receiptId` and `conversationId` are not optional, because Resend replies in-thread: the message is
 * pinned to the inbound receipt it answers, and a destination that does not match that receipt's
 * sender is refused rather than quietly sent somewhere else.
 */
export type EmailOutboundIntent = OutboundIntent & {
  readonly receiptId: string;
  readonly conversationId: string;
};

export class ResendOutbound implements OutboundAdapter<EmailOutboundIntent> {
  readonly channel = "email";
  readonly #messenger: ReplyMessenger;

  constructor(messenger: ReplyMessenger) {
    this.#messenger = messenger;
  }

  async deliver(intent: EmailOutboundIntent, idempotencyKey: string): Promise<DeliveryReceipt> {
    const target = await this.#messenger.prepare(intent.receiptId, intent.conversationId);
    if (target.to !== intent.to) {
      throw new Error("Reply destination does not match the receipt it answers.");
    }
    return this.#messenger.send({ target, text: intent.text }, { requestId: idempotencyKey });
  }
}
