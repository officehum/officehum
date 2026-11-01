/**
 * The one pipeline every inbound channel goes through (RASF-3160).
 *
 * Six facts used to be carried twice, once per channel, and the third copy is where one of them
 * quietly differs:
 *
 *   1. verify the sender is real      (whatever the provider signs)
 *   2. dedupe a redelivery            (`channel_inbound`, keyed `(channel, external_id)`)
 *   3. honour an opt-out keyword      (the channel's own table, when it has one)
 *   4. hold a stranger to a ceiling   (the channel's own counter, when it has one)
 *   5. resolve the sender             (registered customer, or unknown)
 *   6. dispatch                       (a conversation, or a callback ticket for a person)
 *
 * and two more that must not be a channel's decision at all:
 *
 *   * provenance — every message from outside is `external`, and
 *   * the fence — its body is untrusted data, never an instruction to the office.
 *
 * The order is the security story and is fixed here: verification before anything is believed, the
 * duplicate guard before the opt-out and the counter (a retry of a STOP is one STOP), the counter last
 * (a keyword a person is entitled to send is never refused for being their fourth text), and the
 * sender resolved only after the message has survived all of it.
 *
 * A channel that forgets one of these is not possible from inside an adapter, because an adapter is
 * only asked for `verify`, `parse` and `ack`.
 */
import type { Ack, InboundMessage, InboundRefusal, InboundRequest } from "./adapter.js";
import { type OptOutState, optOutCommand } from "./optout.js";
import { admitWithin, type RateLimit, type RateLimitStore } from "./ratelimit.js";
import type { ChannelRegistry } from "./registry.js";
import type { SenderResolution, SenderResolver } from "./resolve.js";

/** What became of a verified inbound message. `rate_limited` is stored and refused, in that order. */
export type InboundDisposition = "recorded" | "duplicate" | "opt_out" | "rate_limited";

/**
 * Where a message came from, as one value.
 *
 * Every inbound message is `external`, and that is not a per-channel judgement: it is the reason the
 * fence exists, and a channel that could set it to `internal` would be a channel that could hand the
 * office a stranger's words as its own.
 *
 * An object type rather than an `interface`, because it is written onto documents that store
 * `JsonObject` — and only an alias has the implicit index signature for that.
 */
export type InboundProvenance = {
  readonly origin: "external";
  readonly sourceChannel: string;
  readonly sourceContact: string;
};

/**
 * What the gateway hands on, for every disposition.
 *
 * `sender` is present only where a sender was resolved: a duplicate and an opt-out are answered before
 * anybody is looked up, which is the same order the routes had and the same amount of work.
 */
export type GatewayOutcome =
  | {
      readonly message: InboundMessage;
      readonly disposition: "duplicate" | "opt_out";
      readonly provenance: InboundProvenance;
    }
  | {
      readonly message: InboundMessage;
      readonly disposition: "recorded" | "rate_limited";
      readonly provenance: InboundProvenance;
      readonly sender: SenderResolution;
    };

/**
 * The durable facts the pipeline needs, and no others.
 *
 * `recordInboundOnce` and `forgetInbound` are one decision each, made by a primary key: a `SELECT`
 * followed by an `INSERT` lets two deliveries of one message interleave, both read as unseen, and the
 * office ends up with two tickets about one text. `forgetInbound` exists for one case — a message the
 * office recorded and could not hand on — because that row would otherwise turn the provider's retry
 * into a duplicate of work nobody did.
 *
 * `setOptOut` is optional because an opt-out is a capability, not a convention: Twilio's keywords are
 * a legal instruction from a handset, and a channel with no such table treats those words as text.
 */
export interface GatewayStore {
  recordInboundOnce(channel: string, externalId: string, receivedAt: string): boolean;
  forgetInbound(channel: string, externalId: string): void;
  setOptOut?(sender: string, state: OptOutState, at: string): void;
}

/** A ceiling for senders the office has not registered, and the counter behind it. */
export interface GatewayCeiling {
  readonly window: RateLimit;
  readonly store: RateLimitStore;
}

export interface ChannelGatewayOptions {
  /** Where the inbound adapters live. The gateway is driven by name, never by a captured adapter. */
  readonly registry: ChannelRegistry;
  readonly store: GatewayStore;
  /** The sender question. The conservative answer is `UNKNOWN_SENDERS`. */
  readonly resolve: SenderResolver;
  /**
   * What happens next. Called once per accepted message, for every disposition — a duplicate and a
   * refused message are worth telling a host about, and the HTTP answer cannot say any of it: every
   * accepted, duplicate and refused message gets the same 2xx, because a provider told "no" retries.
   */
  readonly dispatch: (outcome: GatewayOutcome) => void | Promise<void>;
  /** The stranger's ceiling. Absent means this channel has none (email's is the provider's). */
  readonly ceiling?: GatewayCeiling;
}

/**
 * The answer to one webhook: either a refusal the route maps to a status, or the provider's own ack.
 *
 * A refusal carries `ack` too, because some refusals are answered in the provider's own dialect
 * (Twilio's 404 is a `204`-style empty TwiML, not prose) and the route should not have to know that.
 */
export type GatewayResult =
  | { readonly accepted: false; readonly reason: InboundRefusal; readonly ack: Ack }
  | { readonly accepted: true; readonly outcome: GatewayOutcome; readonly ack: Ack };

/**
 * The untrusted fence, applied once.
 *
 * A body from outside is data. Every channel wraps it in the same markers and says the same thing about
 * it; a channel that forgot would be invisible, which is exactly how the inbound-marker guard ended up
 * in one channel's harness and nowhere else.
 */
export const UNTRUSTED_BEGIN = "--- BEGIN UNTRUSTED CUSTOMER MESSAGE ---";

export const UNTRUSTED_END = "--- END UNTRUSTED CUSTOMER MESSAGE ---";

export interface FenceOptions {
  /** The first line: what this is, and that what follows is data. */
  readonly notice: string;
  /** The channel's own header lines (`Receipt-ID`, `From`, `Subject`, …), in its own words. */
  readonly lines: readonly string[];
  /** The untrusted text itself. */
  readonly body: string;
}

/** One untrusted message, fenced. The pieces differ per channel; the fence does not. */
export function fence(options: FenceOptions): string {
  return [options.notice, ...options.lines, UNTRUSTED_BEGIN, options.body, UNTRUSTED_END].join(
    "\n",
  );
}

/** The provenance of any inbound message. Derived from the message, so it cannot be passed in wrong. */
export function externalProvenance(message: InboundMessage): InboundProvenance {
  return {
    origin: "external",
    sourceChannel: message.channel,
    sourceContact: message.from,
  };
}

export class ChannelGateway {
  readonly #options: ChannelGatewayOptions;

  constructor(options: ChannelGatewayOptions) {
    this.#options = options;
  }

  /**
   * Take one webhook for a channel: verify, parse, dedupe, opt-out, ceiling, resolve, dispatch.
   *
   * Resolves once the message is the office's — a conversation input admitted, or a ticket created —
   * so a host can answer the provider only after the work is durable. A dispatch that throws removes
   * the duplicate row first and rethrows: the provider has not been told the delivery succeeded, so it
   * retries, and the retry must be a second chance rather than a duplicate of work nobody did.
   */
  async ingest(channel: string, request: InboundRequest): Promise<GatewayResult> {
    const adapter = this.#options.registry.adapter(channel);
    if (adapter === undefined) {
      throw new Error(`No inbound adapter is registered for "${channel}".`);
    }
    const ack = adapter.ack();
    // `await` on a value is that value, so an adapter that answers in the tick (Twilio) costs nothing
    // and an adapter that cannot (Resend: the secrets and the body are both fetched) is waited for.
    // The order is the same either way, which is the point: verification still happens before
    // anything the request says is believed, whatever the channel had to do to answer.
    const refusal = await adapter.verify(request);
    if (refusal !== undefined) return { accepted: false, reason: refusal, ack };
    const parsed = await adapter.parse(request);
    if (!parsed.accepted) return { accepted: false, reason: parsed.reason, ack };

    const message = parsed.message;
    const provenance = externalProvenance(message);
    const store = this.#options.store;

    if (!store.recordInboundOnce(message.channel, message.externalId, message.receivedAt)) {
      const outcome: GatewayOutcome = { message, disposition: "duplicate", provenance };
      await this.#options.dispatch(outcome);
      return { accepted: true, outcome, ack };
    }

    const command = optOutCommand(message.body);
    if (command !== undefined && store.setOptOut !== undefined) {
      store.setOptOut(message.from, command, message.receivedAt);
      const outcome: GatewayOutcome = { message, disposition: "opt_out", provenance };
      await this.#options.dispatch(outcome);
      return { accepted: true, outcome, ack };
    }

    // A registered sender is a customer, not a stranger: the ceiling exists to stop a flood, and one
    // of this office's own customers asking three questions in an hour is a conversation, not a flood.
    const sender = this.#options.resolve(message);
    const ceiling = this.#options.ceiling;
    const allowed =
      sender.kind === "registered" ||
      ceiling === undefined ||
      admitWithin(ceiling.store, message.from, message.receivedAt, ceiling.window).allowed;

    if (!allowed) {
      // A refusal is still an acknowledgement. The ceiling is the office's, not the provider's, so
      // telling the provider to retry would turn one flood into an unbounded stream of retries.
      const outcome: GatewayOutcome = { message, disposition: "rate_limited", provenance, sender };
      await this.#options.dispatch(outcome);
      return { accepted: true, outcome, ack };
    }

    const outcome: GatewayOutcome = { message, disposition: "recorded", provenance, sender };
    try {
      await this.#options.dispatch(outcome);
    } catch (error) {
      store.forgetInbound(message.channel, message.externalId);
      throw error;
    }
    return { accepted: true, outcome, ack };
  }
}
