/**
 * Sending, as a separate interface on purpose (RASF-3160).
 *
 * `ChannelAdapter` has no outbound member; this is the type a transport implements when the office is
 * allowed to send on it. The gateway's dispatcher looks the channel up in the registry and throws
 * `NoAdapterError` when nothing is registered — so "the office cannot text a customer" is an empty
 * slot rather than a check somebody has to remember to write. A channel with no SMS outbound cannot
 * be made to send by a model that believes it can, a helper added later, or a test that mocks one into
 * existence: there is nothing to call.
 *
 * The `deliverableChannel` guard in the Front Desk stays as the second layer at the tool boundary. The
 * two fail differently, and that is the point: the guard is a delivery that will not do it, this is a
 * delivery that does not exist.
 */

/** One outbound message: where it goes and what it says. A channel may read more of its own intent. */
export interface OutboundIntent {
  /** The destination in the channel's own vocabulary: a mailbox for email, a number for SMS. */
  readonly to: string;
  readonly text: string;
}

/** What a transport answers with once it has taken a message. */
export interface DeliveryReceipt {
  /** The transport's own id for the delivery. */
  readonly id: string;
  /** `accepted` when a provider took it; `recorded` when a transport only filed it. */
  readonly status: "accepted" | "recorded";
}

export interface OutboundAdapter<TIntent extends OutboundIntent = OutboundIntent> {
  /** e.g. `email`. The registry keys on it, so it matches the inbound adapter's `name`. */
  readonly channel: string;
  /**
   * Hand one message to the transport. `idempotencyKey` is the caller's identity for the send: a
   * transport that redelivers on a retry must key its own record on it, which is what makes a second
   * attempt at one approval one message rather than two.
   */
  deliver(intent: TIntent, idempotencyKey: string): Promise<DeliveryReceipt>;
}

/**
 * There is no adapter for that channel, so there is no way to send on it.
 *
 * It names the channel because the failure is a fact about the office's capabilities rather than a
 * fault: a caller that reached here asked to send on a channel this build does not send on.
 */
export class NoAdapterError extends Error {
  readonly channel: string;

  constructor(channel: string) {
    super(`No outbound adapter is registered for "${channel}": this office cannot send on it.`);
    this.name = "NoAdapterError";
    this.channel = channel;
  }
}
