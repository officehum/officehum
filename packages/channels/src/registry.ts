/**
 * Which adapters this office has, in both directions (RASF-3160).
 *
 * One map keyed by channel name for receiving and one for sending, because the two are different
 * capabilities: every channel this build has can receive, and only some may send. The outbound map is
 * the enforcement of the second — `outbound("sms")` throws `NoAdapterError` because nothing was ever
 * registered under that name, and no code path can conjure an adapter for a channel nobody wrote one
 * for.
 */
import type { ChannelAdapter } from "./adapter.js";
import {
  type DeliveryReceipt,
  NoAdapterError,
  type OutboundAdapter,
  type OutboundIntent,
} from "./outbound.js";

export { NoAdapterError } from "./outbound.js";

export class ChannelRegistry {
  readonly #inbound = new Map<string, ChannelAdapter>();
  readonly #outbound = new Map<string, OutboundAdapter<OutboundIntent>>();

  /** Add an inbound adapter. Registering two under one name is a programming error, not a merge. */
  register(adapter: ChannelAdapter): this {
    if (this.#inbound.has(adapter.name)) {
      throw new Error(`An inbound adapter is already registered for "${adapter.name}".`);
    }
    this.#inbound.set(adapter.name, adapter);
    return this;
  }

  /** The adapter for a channel, or `undefined` when this office does not receive on it. */
  adapter(name: string): ChannelAdapter | undefined {
    return this.#inbound.get(name);
  }

  /** The channels this office can receive on, in registration order. */
  channels(): string[] {
    return [...this.#inbound.keys()];
  }

  /**
   * Add an outbound adapter. Registering two under one name is a programming error: a second one would
   * silently replace the transport a message actually leaves by.
   */
  registerOutbound<TIntent extends OutboundIntent>(adapter: OutboundAdapter<TIntent>): this {
    if (this.#outbound.has(adapter.channel)) {
      throw new Error(`An outbound adapter is already registered for "${adapter.channel}".`);
    }
    this.#outbound.set(adapter.channel, adapter);
    return this;
  }

  /** The outbound adapter for a channel. Throws `NoAdapterError` when the office may not send on it. */
  outbound(channel: string): OutboundAdapter<OutboundIntent> {
    const adapter = this.#outbound.get(channel);
    if (adapter === undefined) throw new NoAdapterError(channel);
    return adapter;
  }

  /** Which channels this office may send on. `sms` is absent in this build, and that is the rule. */
  deliverable(): string[] {
    return [...this.#outbound.keys()];
  }

  /**
   * Send one message on a channel, or refuse because there is no way to.
   *
   * The lookup happens first, before anything about the intent is read, so a channel the office cannot
   * send on fails the same way whatever the message says. Async on purpose: the refusal arrives as a
   * rejected promise like every other failure to send, so a caller has one error path rather than two.
   * The adapter is typed against the base intent and receives the caller's fuller one unchanged: a
   * channel reads its own fields where it needs them.
   */
  async deliver<TIntent extends OutboundIntent>(
    channel: string,
    intent: TIntent,
    idempotencyKey: string,
  ): Promise<DeliveryReceipt> {
    return this.outbound(channel).deliver(intent, idempotencyKey);
  }
}
