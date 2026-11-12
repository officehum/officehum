/**
 * Resend inbound mail, as a channel adapter (RASF-3160 stage 2).
 *
 * This is the half of the email path that the gateway could not carry: it is the channel's own
 * knowledge of its provider, and nothing else. What the provider signs (`svix-id`,
 * `svix-timestamp`, `svix-signature`, over the bytes), how a delivery is read (an event whose
 * `data.email_id` is the message), and where the words live (not in the webhook at all — a second
 * provider endpoint has to be fetched) are all facts about Resend. Everything after that — is this a
 * redelivery, has this sender opted out, is the sender a customer, what is the message's provenance —
 * is the gateway's, and appears nowhere below.
 *
 * Two things are async and that is why the contract allows a promise: the signing secret is fetched
 * per request (a rotation takes effect without a restart), and the body is fetched per message. The
 * gateway awaits both without knowing they were promises.
 *
 * The adapter is built here rather than in `packages/channels` because the email parser is here. The
 * plan put a `channels/src/resend.ts`; that file would have had to reach into this package's svix and
 * MIME code, which is the dependency the package boundary exists to prevent. The interface is the
 * seam — `ChannelAdapter` is in `channels`, and this class implements it — so an adapter on the far
 * side of that seam is the same arrangement Twilio has from the other direction.
 */
import type {
  Ack,
  ChannelAdapter,
  InboundRefusal,
  InboundRequest,
  InboundResult,
} from "@officehum/channels";
import {
  canonicalMailbox,
  type NormalizedInboundEmail,
  parseReceivingEvent,
  type ReceivingEvent,
  type SignedWebhookHeaders,
  terminalRejection,
  verifySvixWebhook,
} from "./resend-inbound.js";
import type { InternalResendInbox } from "./resend-inbox.js";

/** What Resend answers a webhook with. `accepted` is the word this route has always written. */
const ACK: Ack = {
  status: 202,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body: "accepted\n",
};

/**
 * The three headers that are one signature.
 *
 * A svix signature is not a value in a header, it is the triple it is computed over, so all three
 * have to be present and of the right shape or there is nothing to verify. `undefined` here means
 * the request is not a signed delivery at all — which is a 400 in the provider's own terms, not a
 * 401 — so the adapter can say which of the two refusals it is instead of the route guessing.
 */
function svixHeaders(request: InboundRequest): SignedWebhookHeaders | undefined {
  const headers = request.headers;
  if (headers === undefined) return undefined;
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signature = headers["svix-signature"];
  if (id === undefined || timestamp === undefined || signature === undefined) return undefined;
  return { id, timestamp, signature };
}

/** The event's own `type`, read before anything is believed: this route is subscribed to several. */
function eventType(raw: Uint8Array): string | undefined {
  try {
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
    const type = (decoded as Record<string, unknown>).type;
    return typeof type === "string" ? type : undefined;
  } catch {
    return undefined;
  }
}

export interface ResendInboundAdapterOptions {
  /**
   * The email channel's own store: the signed delivery, the fetched snapshot, the conversation — and
   * the clock, which the signature window and the receipt are both judged on.
   */
  readonly inbox: InternalResendInbox;
}

/**
 * Resend's inbound mail.
 *
 * `verify` is the svix check against the secrets in force at the moment of the request, and `parse`
 * is the provider read: the event for the envelope, then a `GET` for the words. An email's webhook
 * carries who and which, never what — so a message only exists after that fetch, which is the reason
 * this channel is the one that made `parse` asynchronous.
 */
export class ResendInboundAdapter implements ChannelAdapter {
  readonly name = "email";

  readonly #inbox: InternalResendInbox;

  constructor(options: ResendInboundAdapterOptions) {
    this.#inbox = options.inbox;
  }

  /**
   * Is this delivery signed by Resend, right now, with a secret the office currently holds?
   *
   * The refusal vocabulary is split the way the provider's failures are: a missing or unreadable
   * header is `malformed` (a 400 — this is not a webhook), and a signature or timestamp that does not
   * check out is `signature` (a 401). An unavailable secret is neither: it is this office's problem
   * and it is thrown, so the provider is told to try again rather than to stop sending.
   */
  async verify(request: InboundRequest): Promise<InboundRefusal | undefined> {
    const headers = svixHeaders(request);
    const raw = request.raw ?? new TextEncoder().encode(request.body);
    if (headers === undefined) return "malformed";
    const secrets = await this.#inbox.secrets();
    try {
      verifySvixWebhook(raw, headers, secrets, this.#inbox.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return message.includes("timestamp") || message.includes("signature")
        ? "signature"
        : "malformed";
    }
    return undefined;
  }

  /**
   * One delivery, as one message.
   *
   * The order is the receipt machine's, and it is kept: the signed delivery is made durable *before*
   * the provider is asked for the words, so a fetch that fails leaves a row an operator can see and a
   * worker can retry, rather than an email nobody knows arrived. A redelivery finds that row and does
   * not fetch again.
   *
   * Nothing here decides whether the message is new. `channel_inbound('email', email_id)` is the
   * gateway's answer to that, and a receipt keyed by email id is this channel's conversation state —
   * two facts, not two copies of one.
   */
  async parse(request: InboundRequest): Promise<InboundResult> {
    const raw = request.raw;
    if (raw === undefined) return { accepted: false, reason: "malformed" };
    if (eventType(raw) !== "email.received") {
      // A delivery this office does not take as a message: Resend's own webhook carries sent and
      // delivered events too, and an acknowledgement is the whole of the answer to those.
      return { accepted: false, reason: "ignored" };
    }
    let event: ReceivingEvent;
    try {
      event = parseReceivingEvent(raw);
    } catch {
      return { accepted: false, reason: "malformed" };
    }
    const authority = this.#inbox.authority;
    const addressedToUs = event.data.to.map(canonicalMailbox).includes(authority.inboundEmail);
    if (!addressedToUs) {
      // Signed, readable, and somebody else's: another office's mail, or a misconfiguration. It is
      // not stored, and it is not this office's conversation.
      return { accepted: false, reason: "wrong_number" };
    }
    const existing = this.#inbox.receipt(event.data.email_id);
    let normalized: NormalizedInboundEmail;
    if (existing?.state === "blocked") {
      // Already rejected for good, and the receipt says why. Acknowledged again, without asking the
      // provider for the words a second time.
      return { accepted: false, reason: "ignored" };
    }
    if (existing !== undefined && existing.normalized !== null) {
      normalized = existing.normalized;
    } else {
      const eventId = request.headers?.["svix-id"] ?? "";
      this.#inbox.record(raw, eventId);
      let prepared: Awaited<ReturnType<InternalResendInbox["fetchReceived"]>>;
      try {
        prepared = await this.#inbox.fetchReceived(event.data.email_id, event);
      } catch (error) {
        const reason = terminalRejection(error);
        // A transient failure is thrown on: the route answers 5xx and the provider retries.
        if (reason === undefined) throw error;
        // An auto-reply, a DMARC failure or another refusal of the message itself will be refused
        // again on every retry. The receipt records it as blocked with its reason, and the provider
        // is acknowledged (`ignored` is the contract's one refusal answered 2xx) so it stops sending.
        this.#inbox.block(event.data.email_id, reason);
        return { accepted: false, reason: "ignored" };
      }
      this.#inbox.savePrepared(event.data.email_id, prepared.fetched, prepared.normalized);
      normalized = prepared.normalized;
    }
    return {
      accepted: true,
      message: {
        channel: this.name,
        externalId: event.data.email_id,
        from: normalized.from,
        to: authority.inboundEmail,
        body: normalized.text,
        receivedAt: new Date(this.#inbox.now()).toISOString(),
      },
    };
  }

  /** What Resend is told: the delivery is the office's, and the office answers in its own dialect. */
  ack(): Ack {
    return ACK;
  }
}
