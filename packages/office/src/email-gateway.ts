/**
 * The gateway the office's email route runs on (RASF-3160).
 *
 * The same shape as `sms-gateway.ts`, and deliberately so: the two files differ in what a channel
 * *is* — SMS has an opt-out table, a stranger's ceiling and a registered-number question; email has
 * none of those — and not in how a message arrives. What is left here is the board's one duplicate
 * table, and the honest absence of the three facts email does not have.
 *
 * The duplicate guard is `channel_inbound`, keyed `(channel, external_id)`, so a MessageSid and a
 * Resend email id sit in one table without being able to shadow each other. The email inbox keeps a
 * receipt per email id, and that is conversation state — which conversation, which submission, which
 * reply — not a second answer to "have I seen this delivery".
 *
 * Two absences are decisions rather than omissions:
 *
 * * **No ceiling.** SMS has one because an unknown handset can text in for the price of a phone;
 *   email's equivalent is the provider's own reputation and rate limiting, and a local counter on
 *   top of it would be a limit with no failure behind it. The design says the same thing.
 * * **No opt-out keywords.** STOP is a legal instruction from a handset. A mailbox that writes
 *   "STOP" has written a message, and treating it as a command would be inventing a consent
 *   regime this office does not have.
 */
import {
  ChannelGateway,
  ChannelRegistry,
  type GatewayOutcome,
  UNKNOWN_SENDERS,
} from "@officehum/channels";
import type { InboundStore } from "./board/inbound.js";
import type { ResendInboundAdapter } from "./resend-adapter.js";

export interface EmailGatewayOptions {
  /** The channel's adapter. Built once at startup, where the mailbox and secrets are checked. */
  readonly adapter: ResendInboundAdapter;
  /** The board's one inbound duplicate table, `channel_inbound`. */
  readonly board: InboundStore;
  /** What became of the message, for a host that logs, counts, or wakes its inbound worker. */
  readonly onInbound?: (outcome: GatewayOutcome) => void | Promise<void>;
}

/**
 * Build the gateway for one email route.
 *
 * The sender is resolved by the office, not here: the exact-mailbox contact match happens inside the
 * commit that creates the conversation (`inbound-session.ts`), because the contact list lives in the
 * harness and this route has no synchronous answer to "is this sender a customer?". So the answer is
 * the conservative one — a stranger — and it costs nothing, because email has no ceiling for a
 * stranger to hit.
 */
export function emailGateway(options: EmailGatewayOptions): ChannelGateway {
  return new ChannelGateway({
    registry: new ChannelRegistry().register(options.adapter),
    store: {
      recordInboundOnce: (channel, externalId, at) =>
        options.board.recordInboundOnce(channel, externalId, at),
      forgetInbound: (channel, externalId) => options.board.forgetInbound(channel, externalId),
    },
    resolve: UNKNOWN_SENDERS,
    dispatch: async (outcome) => {
      await options.onInbound?.(outcome);
    },
  });
}
