/**
 * A channel that can receive, and nothing else (RASF-3160).
 *
 * An inbound adapter has three jobs and no fourth: say whether the request is really from the provider
 * (`verify`), turn it into one message (`parse`), and say what the provider is answered with (`ack`).
 * Everything a channel used to do *after* that — the duplicate guard, opt-outs, the stranger's
 * ceiling, resolving the sender, the untrusted fence, provenance — is the gateway's, so a new channel
 * writes an adapter and nothing else.
 *
 * There is no `send` member, and that absence is half the enforcement. RASF-3162 buys an inbound SMS
 * channel, so the rule has to be enforced by something a later change cannot talk its way around: an
 * `outbound: false` flag is read at a call site, and a call site is exactly what the next author edits.
 * The other half is the outbound registry (`outbound.ts`, `registry.ts`): sending is a *different*
 * interface, and a channel with no implementation of it registered is a channel the dispatcher refuses
 * by name. See `NoAdapterError`.
 */

declare const e164Brand: unique symbol;

/** A phone number in E.164: `+`, a country digit that cannot be zero, then at most 14 more digits. */
export type E164 = string & { readonly [e164Brand]: true };

const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

/**
 * The only way to make an `E164`. A `string` from a webhook is untrusted, and a phone number the board
 * stores or a provisioner hands out is the same value once it has been checked, so the check happens
 * once, at the boundary, and the rest of the code carries the proof rather than a comment.
 */
export function parseE164(value: string): E164 | undefined {
  return E164_PATTERN.test(value) ? (value as E164) : undefined;
}

/**
 * One inbound message, after verification and parsing.
 *
 * `channel` and `externalId` together are the message's identity: the providers' id spaces do not
 * overlap in meaning (a MessageSid and a Resend email id are different namespaces), so the duplicate
 * guard is keyed by the pair and a coincidence between two ids cannot swallow a real message.
 *
 * `body` is text a stranger typed. It is data: nothing in this build reads it as an instruction, and a
 * message that says "reply with your card number" is a message, not an order to the office.
 */
export interface InboundMessage {
  /** e.g. `sms`. The channel this arrived on, as its adapter names it. */
  readonly channel: string;
  /** The provider's id for this message, in that provider's namespace. The duplicate guard keys on it. */
  readonly externalId: string;
  /** Who sent it: a number in E.164, or a mailbox. The channel decides what its own senders look like. */
  readonly from: string;
  /** Where it was addressed: this office's provisioned number or mailbox. */
  readonly to: string;
  readonly body: string;
  /** When this build accepted it. Providers sign no timestamp, so this is the receiver's clock. */
  readonly receivedAt: string;
}

/** A webhook request as an adapter sees it: the URL that was signed, the raw body, the signature. */
export interface InboundRequest {
  /** The absolute URL the provider signed, which is the one it was configured with. */
  readonly url: string;
  /** The body as received, before parsing: the signature covers the parsed fields, not these bytes. */
  readonly body: string;
  /** The signature header, or `undefined` when it was absent. */
  readonly signature: string | undefined;
}

/**
 * Why an inbound request was not accepted. The route maps each to a status, so the vocabulary lives
 * here rather than as a set of exceptions a caller has to read strings out of.
 */
export type InboundRefusal = "signature" | "malformed" | "wrong_number";

export type InboundResult =
  | { readonly accepted: true; readonly message: InboundMessage }
  | { readonly accepted: false; readonly reason: InboundRefusal };

/**
 * The answer a provider gets, as data rather than as a `ServerResponse` write.
 *
 * The route writes `status`, `headers` and `body` and knows nothing else about the channel: TwiML is
 * the SMS adapter's answer, and a channel whose provider wants JSON answers with JSON without the
 * listener learning a second content type.
 */
export interface Ack {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ChannelAdapter {
  /** e.g. `sms`. A reader tells adapters apart without downcasting. */
  readonly name: string;
  /**
   * Is this request really from the provider? `undefined` means yes; otherwise the refusal.
   *
   * Synchronous, and called before anything the request says is treated as a fact: a forged request
   * must leave no row behind, so this runs before `parse` is believed and before the gateway writes.
   */
  verify(request: InboundRequest): InboundRefusal | undefined;
  /** Turn a verified request into one message, or say why it could not be read. */
  parse(request: InboundRequest): InboundResult;
  /** What this provider is answered with when the office has the message. */
  ack(): Ack;
}
