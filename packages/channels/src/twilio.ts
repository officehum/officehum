import {
  type Ack,
  type ChannelAdapter,
  type E164,
  type InboundRefusal,
  type InboundRequest,
  type InboundResult,
  parseE164,
} from "./adapter.js";
import { verifyTwilioSignature } from "./signature.js";

/**
 * The empty TwiML every response carries, declared once.
 *
 * Twilio reads this body as "the app said nothing" and therefore sends nothing of its own: no
 * auto-reply, no confirmation, no help text. That is the whole of an inbound-only channel's outbound
 * behaviour, so it is one constant rather than a string per call site — a hand-built response is how a
 * stray `<Message>` finds its way into a channel that is not allowed to send.
 */
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** TwiML's media type, as Twilio's own examples answer. */
export const TWIML_CONTENT_TYPE = "text/xml";

/** The media type Twilio POSTs a message webhook with. */
export const TWILIO_FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** Twilio auth tokens are 32 hexadecimal characters. Anything else is a placeholder, not a secret. */
const AUTH_TOKEN = /^[0-9a-f]{32}$/i;

export interface TwilioAdapterOptions {
  /**
   * The account's auth token. Checked for shape, not merely for being non-empty: see the constructor.
   */
  readonly authToken: string;
  /** The provisioned number this office receives on. A text to any other number is not ours to take. */
  readonly businessNumber: E164;
  /** The clock. Injected by tests; `new Date()` otherwise. */
  readonly now?: () => Date;
}

/**
 * The POST body as a flat record of strings.
 *
 * `URLSearchParams` is the parser because Twilio posts `application/x-www-form-urlencoded`: it decodes
 * `+` and percent-escapes exactly as the signature examples assume. A repeated name keeps its last
 * value, which is what a dictionary read of the request does in every Twilio helper library; Twilio
 * does not send repeats. The record is created without a prototype so a parameter named `__proto__`
 * cannot reach `Object.prototype`.
 */
export function formParams(body: string): Record<string, string> {
  const params = Object.create(null) as Record<string, string>;
  for (const [key, value] of new URLSearchParams(body)) params[key] = value;
  return params;
}

/**
 * The shape this adapter has always answered `accept` with, kept because the package is published.
 *
 * The gateway works in `InboundResult`, whose message is keyed by `(channel, externalId)`. `accept` is
 * the Twilio-specific view of the same two steps and its message keeps the provider's own field name:
 * a caller written against `@officehum/channels` 0.0.0 keeps working, and `messageSid` stays the word
 * Twilio's documentation uses.
 */
export type TwilioAcceptResult =
  | {
      readonly accepted: true;
      readonly message: {
        readonly from: E164;
        readonly to: E164;
        readonly body: string;
        readonly messageSid: string;
        readonly receivedAt: string;
      };
    }
  | { readonly accepted: false; readonly reason: InboundRefusal };

/**
 * Twilio's inbound SMS, verified and parsed.
 *
 * The order is the security story. Parse, then verify, then look at the fields: verification needs the
 * parsed parameters because that is what Twilio signs, but nothing a field says is acted on until the
 * signature has been checked. A refusal carries a reason rather than a status, so the route owns the
 * HTTP vocabulary and this class owns the provider's.
 */
export class TwilioAdapter implements ChannelAdapter {
  readonly name = "sms";

  /**
   * The same channel under the member name this adapter published before the gateway existed.
   *
   * Kept because `@officehum/channels` is a published package and a caller may read either name; the
   * two are one value, so they cannot disagree.
   */
  readonly channel = "sms";

  readonly #authToken: string;
  readonly #businessNumber: E164;
  readonly #now: () => Date;

  constructor(options: TwilioAdapterOptions) {
    // A placeholder is the failure this refuses. A local run with `authToken: "test"` verifies any
    // signature an attacker can compute from the same source it read, and nothing about the run looks
    // wrong. Twilio's tokens have a fixed shape, so the shape is what is checked.
    if (!AUTH_TOKEN.test(options.authToken)) {
      throw new Error("A Twilio auth token is 32 hexadecimal characters; that is not one.");
    }
    this.#authToken = options.authToken;
    this.#businessNumber = options.businessNumber;
    this.#now = options.now ?? (() => new Date());
  }

  verify(request: InboundRequest): InboundRefusal | undefined {
    const params = formParams(request.body);
    if (!verifyTwilioSignature(this.#authToken, request.url, params, request.signature)) {
      return "signature";
    }
    return undefined;
  }

  parse(request: InboundRequest): InboundResult {
    const params = formParams(request.body);
    const from = parseE164(params.From ?? "");
    const to = parseE164(params.To ?? "");
    const externalId = params.MessageSid ?? "";
    if (from === undefined || to === undefined || externalId === "") {
      return { accepted: false, reason: "malformed" };
    }
    // A verified message to somebody else's number is Twilio misconfiguration or a replay of another
    // office's webhook. Either way it is not this office's conversation, so it is not stored.
    if (to !== this.#businessNumber) return { accepted: false, reason: "wrong_number" };
    return {
      accepted: true,
      message: {
        channel: this.name,
        externalId,
        from,
        to,
        body: params.Body ?? "",
        receivedAt: this.#now().toISOString(),
      },
    };
  }

  /** An empty TwiML body, whatever the office did with the message: Twilio must send nothing. */
  ack(): Ack {
    return {
      status: 200,
      headers: { "content-type": TWIML_CONTENT_TYPE },
      body: EMPTY_TWIML,
    };
  }

  /**
   * Verify, parse, and answer in the shape this package published before RASF-3160.
   *
   * One implementation behind two entry points: the gateway calls `verify` and `parse`, and this calls
   * the same two, so neither can drift from the other.
   */
  accept(request: InboundRequest): TwilioAcceptResult {
    if (this.verify(request) !== undefined) return { accepted: false, reason: "signature" };
    const result = this.parse(request);
    if (!result.accepted) return result;
    return {
      accepted: true,
      message: {
        from: result.message.from as E164,
        to: result.message.to as E164,
        body: result.message.body,
        messageSid: result.message.externalId,
        receivedAt: result.message.receivedAt,
      },
    };
  }
}
