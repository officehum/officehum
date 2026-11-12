/**
 * The gateway the office's SMS route runs on (RASF-3160).
 *
 * Everything the pipeline needs is a capability the office already had, named once: the board's
 * duplicate guard (now keyed by channel as well as by id), its STOP/START switch, its window counter,
 * and the host's answer to "is this sender a customer?". It lives here rather than in the listener
 * because it is the office's wiring, not the server's: `/hooks/twilio` reads a body and writes an
 * acknowledgement, and what stands between those two is this.
 *
 * The reply-route-as-data ticket (RASF-3160 §5) leaves one seam open, and it is visible here: an SMS
 * message is answered by email, so `SmsConversationDoc.replyBy` records that route. The Front Desk's
 * `send_message` still states `channel: "email"` in its own schema — reading the route from the
 * conversation is a change to the role package and its approval memo, and is reported rather than
 * half-done.
 */
import {
  ChannelGateway,
  ChannelRegistry,
  DEFAULT_SMS_RATE_LIMIT,
  type E164,
  type GatewayOutcome,
  type InboundDisposition,
  type InboundMessage,
  parseE164,
  type RateLimit,
  resolveBy,
  type TwilioAdapter,
  UNKNOWN_SENDERS,
} from "@officehum/channels";
import type { SmsStore } from "./board/sms.js";

/**
 * An inbound SMS message, as the office's own intake reads it.
 *
 * The gateway keys a message by `(channel, externalId)`; Twilio's word for that id is a MessageSid, and
 * the intake, the ticket's caller key and the conversation's request id are all written in that word.
 * So the route publishes both, one value: a channel-neutral id for the gateway, and the provider's name
 * for everything downstream that has always spoken it.
 */
export type SmsInboundMessage = InboundMessage & {
  readonly messageSid: string;
};

/** What became of a verified inbound message. `rate_limited` is stored and refused, in that order. */
export type { InboundDisposition };

export interface InboundOutcome {
  readonly message: SmsInboundMessage;
  readonly disposition: InboundDisposition;
}

/** The gateway's outcome in the words this office's intake has always used. */
export function smsOutcome(outcome: GatewayOutcome): InboundOutcome {
  return {
    message: { ...outcome.message, messageSid: outcome.message.externalId },
    disposition: outcome.disposition,
  };
}

export interface SmsGatewayOptions {
  /** The channel's adapter. Built once at startup, where a placeholder token is refused. */
  readonly adapter: TwilioAdapter;
  /** The board's SMS intake store: the duplicate guard, opt-outs and the rate counter. */
  readonly board: SmsStore;
  /**
   * Is this sender a number a contact owns? A host with no answer gets the conservative one: every
   * sender is a stranger, and the ceiling applies to all of them.
   */
  readonly isRegistered?: (from: E164) => boolean | Promise<boolean>;
  /** The ceiling for a sender this office has not registered. Three messages an hour otherwise. */
  readonly rateLimit?: RateLimit;
  /** What became of the message, for a host that routes, logs or counts it. */
  readonly onInbound?: (outcome: InboundOutcome) => void | Promise<void>;
}

/**
 * Build the gateway for one SMS route.
 *
 * The ceiling is named here rather than defaulted inside the gateway, because "which channel has a
 * ceiling" is a decision this office makes about a channel, not a fact about inbound mail.
 */
export function smsGateway(options: SmsGatewayOptions): ChannelGateway {
  const isRegistered = options.isRegistered;
  return new ChannelGateway({
    registry: new ChannelRegistry().register(options.adapter),
    store: {
      recordInboundOnce: (channel, externalId, at) =>
        options.board.inbound.recordInboundOnce(channel, externalId, at),
      forgetInbound: (channel, externalId) =>
        options.board.inbound.forgetInbound(channel, externalId),
      setOptOut: (sender, state, at) => options.board.setOptOut(sender, state, at),
    },
    resolve:
      isRegistered === undefined
        ? UNKNOWN_SENDERS
        : resolveBy(async (from) => {
            const number = parseE164(from);
            return number !== undefined && (await isRegistered(number));
          }),
    ceiling: {
      window: options.rateLimit ?? DEFAULT_SMS_RATE_LIMIT,
      store: options.board,
    },
    dispatch: async (outcome) => {
      await options.onInbound?.(smsOutcome(outcome));
    },
  });
}
