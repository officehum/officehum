/**
 * A channel that can receive, and nothing else.
 *
 * There is no `send` member, and that absence is the enforcement. RASF-3162 buys an inbound SMS
 * channel, so the rule has to be enforced by something a later change cannot talk its way around: an
 * `outbound: false` flag is read at a call site, and a call site is exactly what the next author edits.
 * A type with no send member is refused by the compiler at the point of the call, which means a model
 * that believes it can text a customer cannot express the call, a helper cannot grow one, and a test
 * cannot mock one into existence. When sending is bought (RASF-3220), it arrives as a different type
 * with its own name and its own review, not as a member bolted onto this one.
 *
 * `accept` still answers a webhook — Twilio's empty TwiML — because a provider that gets no answer
 * retries. That body is an acknowledgement to the provider, never a message to a person.
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
 * `body` is text a stranger typed. It is data: nothing in this build reads it as an instruction, and a
 * message that says "reply with your card number" is a message, not an order to the office.
 */
export interface InboundMessage {
  readonly from: E164;
  readonly to: E164;
  readonly body: string;
  /** The provider's id for this message. The duplicate guard keys on it. */
  readonly messageSid: string;
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

export interface ChannelAdapter {
  /** e.g. `sms`. A reader tells adapters apart without downcasting. */
  readonly channel: string;
  /** Verify, parse and stamp. Synchronous: nothing on this path may wait on the network. */
  accept(request: InboundRequest): InboundResult;
}
