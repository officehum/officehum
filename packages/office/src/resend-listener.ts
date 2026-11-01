/**
 * The office's webhook server: one loopback `node:http` listener, one route table (RASF-3162).
 *
 * It began as the Resend listener with a single hard-coded path, and it stays one server rather than
 * growing a second: a host publishes one port, terminates TLS in front of it once, and a provider is
 * configured in one place. Routes are entries in a table, each owning its method, its media type, the
 * header its provider signs with, and the shape of its refusals — so adding `/hooks/twilio` needed no
 * new socket and no change to the Resend path's behaviour.
 *
 * **RASF-3160 made this file a route table rather than a pipeline.** Every inbound channel used to
 * carry the six facts a message needs — verify, dedupe, opt-out, the stranger's ceiling, resolving the
 * sender, dispatch — plus the fence around a stranger's words. Each of those is `ChannelGateway`'s
 * now. So this file reads a body, hands it to the route's gateway, and writes back what the adapter's
 * `ack` says. There is one `ingest` call, in `deliver`, and it serves both channels: nothing here
 * knows TwiML, a MessageSid, a svix signature, or how a duplicate is detected.
 *
 * What is left is genuinely per-provider and is data in the table, not code: which header carries the
 * signature, which URL was signed, and what a refusal looks like in that provider's dialect.
 *
 * The Twilio route is inbound only. It verifies the signature, parses the message, writes what the
 * board needs to remember, and answers with the empty TwiML that tells Twilio to send nothing. It
 * never sends: no code path in this file calls a provider, the adapter has no member that would, and
 * the outbound registry has no adapter under `sms` at all.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  type Ack,
  type ChannelGateway,
  type E164,
  type GatewayResult,
  type InboundRefusal,
  parseE164,
  type RateLimit,
  TWILIO_FORM_CONTENT_TYPE,
  TwilioAdapter,
} from "@officehum/channels";
import type { InboundStore } from "./board/inbound.js";
import type { SmsStore } from "./board/sms.js";
import { emailGateway } from "./email-gateway.js";
import type { OfficeConfig } from "./office-config.js";
import { ResendInboundAdapter } from "./resend-adapter.js";
import type { InternalResendInbox } from "./resend-inbox.js";
import { type InboundOutcome, smsGateway } from "./sms-gateway.js";

export type { InboundDisposition, InboundOutcome, SmsInboundMessage } from "./sms-gateway.js";

export interface ResendListener {
  readonly address: string;
  close(): Promise<void>;
}

const LIMIT = 256 * 1024;
const TIMEOUT = 10_000;

/**
 * What the `/hooks/twilio` route needs, with no defaults.
 *
 * Both secrets-shaped options are required and neither has a fallback: a route that ran with an empty
 * auth token would accept every request, and a route that ran with a placeholder number would refuse
 * every real one — both failures look like a quiet, working server. The adapter checks the token's
 * shape as well as its presence, so `authToken: "test"` is refused at startup rather than at the
 * first forgery it lets through.
 */
export interface TwilioHookOptions {
  /** The account's auth token. Twilio issues 32 hexadecimal characters. */
  readonly authToken: string;
  /**
   * The number this office receives on, in E.164, when the host knows it directly.
   *
   * Usually it does not: the number is provisioned once, by a provisioner, into the office's config,
   * and this route reads it from there (see `config`). Naming it here as well would be the second copy
   * that drifts.
   */
  readonly businessNumber?: string;
  /** Where a provisioned number is read from, when `businessNumber` is not given. */
  readonly config?: OfficeConfig;
  /** The board's SMS intake tables: the duplicate guard, opt-outs and the rate counter. */
  readonly board: SmsStore;
  /**
   * Is this sender a number a contact owns?
   *
   * The ceiling exists for a stranger, not for a customer with a job in flight, and this route cannot
   * read the contact list itself — contacts live in the harness, behind the office's own documents.
   * So the host answers, synchronously, from whatever it already holds. A host with no answer gets
   * the conservative one: every sender is a stranger, and the ceiling applies to all of them.
   */
  readonly isRegistered?: (from: E164) => boolean;
  /**
   * The exact URL Twilio is configured to call. Behind a TLS-terminating proxy the request cannot say
   * its own public URL, so a host passes it here; otherwise it is reconstructed from the request's
   * `host` and `x-forwarded-*` headers. A wrong URL fails closed — the signature will not match.
   */
  readonly signedUrl?: string;
  /** The ceiling for a sender this office has not registered. Three messages an hour by default. */
  readonly rateLimit?: RateLimit;
  /**
   * What the route decided, for a host that counts, logs, or routes. The HTTP answer cannot say it:
   * every accepted, duplicate and refused message gets the same 200, because a provider that is told
   * "no" retries, and a retry of a rate-limited text is the flood the ceiling exists to stop.
   *
   * A host that hands the message to an agent returns a promise, and the route waits for it before
   * answering. That ordering is what makes a failure recoverable: Twilio has not been told the
   * delivery succeeded, so it retries, and the duplicate row this route wrote is removed first (see
   * `forgetInbound`) rather than left to swallow the retry.
   */
  readonly onInbound?: (outcome: InboundOutcome) => void | Promise<void>;
}

/**
 * The request's headers as `node` gives them without joining: names lowercased, every value kept.
 *
 * The values matter as a list, not as a string: a repeated signature header is two claims, and one
 * joined string is neither of them.
 */
type RequestHeaders = Readonly<Record<string, readonly string[] | undefined>>;

type RouteContext = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly target: URL;
  /** Every header the request carried, read once for the whole request; a repeat keeps its values. */
  readonly headers: RequestHeaders;
};

/**
 * One provider endpoint: which channel it serves, how it signs, and what its refusals look like.
 *
 * Everything in here is a fact about a provider, written as data. The pipeline is not in this file,
 * so a third route is another entry and nothing else.
 */
type Route = {
  readonly method: "POST";
  readonly contentType: string;
  /** The channel the adapter is registered under; the gateway is driven by this name. */
  readonly channel: string;
  readonly gateway: ChannelGateway;
  /** The one header this provider signs with, lowercased. */
  readonly signature: string;
  /** The absolute URL the provider signed, when the request cannot say it itself. */
  readonly url?: (request: IncomingMessage, target: URL, headers: RequestHeaders) => string;
  /** How this route refuses a request it could not read the shape of. */
  readonly refuse: (response: ServerResponse, status: number) => void;
  /** How this route answers what the gateway decided. */
  readonly answer: (context: RouteContext, result: GatewayResult) => void;
};

/**
 * The one value of a header, or `undefined`.
 *
 * `undefined` for zero values and for two: a request with a repeated signature header is not a
 * request with a signature, it is a request making two claims, and neither of them is checked.
 */
function single(headers: RequestHeaders, name: string): string | undefined {
  const values = headers[name];
  return values !== undefined && values.length === 1 ? values[0] : undefined;
}

/** The first value of every header, as an adapter reads a request. */
function headerBag(headers: RequestHeaders): Readonly<Record<string, string>> {
  const bag: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, values] of Object.entries(headers)) bag[name] = values?.[0] ?? "";
  return bag;
}

function respond(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(message),
    connection: "close",
  });
  response.end(message);
}

/**
 * Write a channel's own acknowledgement.
 *
 * The route supplies the status (it owns the HTTP vocabulary: a 404 for another office's number, a 400
 * for a body that could not be read) and the adapter supplies the media type and the body. TwiML is
 * therefore not a word this file uses, and a second channel's JSON acknowledgement needs no change
 * here.
 */
function respondAck(response: ServerResponse, ack: Ack, status: number): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    ...ack.headers,
    "content-length": Buffer.byteLength(ack.body),
    connection: "close",
  });
  response.end(ack.body);
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    length += chunk.length;
    if (length > LIMIT) throw new Error("too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

/**
 * The business number, checked once at startup. It is the whole of "is this text ours": a number that is
 * not E.164 would compare unequal to every message and turn the route into a quiet 404.
 *
 * The order is: what the host passed, then the office's config. A host that passed neither has not
 * provisioned a number, and the route refuses to start rather than serving an endpoint that answers
 * 404 to every real text — that failure looks exactly like a working server from the outside.
 */
function businessNumberOf(options: TwilioHookOptions): E164 {
  const stated = options.businessNumber;
  if (stated !== undefined) {
    const parsed = parseE164(stated);
    if (parsed !== undefined) return parsed;
    throw new Error(
      "The Twilio route needs a business number in E.164 form, with its country code.",
    );
  }
  const provisioned = options.config?.smsBusinessNumber();
  if (provisioned !== undefined) return provisioned;
  throw new Error(
    "The Twilio route has no business number: provision one into the office config first.",
  );
}

/**
 * The URL Twilio signed. The provider signs the absolute URL it was configured with, so a request that
 * arrives through a proxy is checked against the public name the proxy forwards, not against
 * `127.0.0.1`. A host that terminates TLS without forwarding either header passes `signedUrl` instead.
 */
function signedUrlOf(target: URL, headers: RequestHeaders): string {
  const proto = single(headers, "x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const host =
    single(headers, "x-forwarded-host")?.split(",")[0]?.trim() ||
    single(headers, "host") ||
    "127.0.0.1";
  return `${proto}://${host}${target.pathname}`;
}

/**
 * Hand one webhook to the gateway, and answer the provider in the provider's own dialect.
 *
 * This is the whole of the pipeline, for every channel: read the body, name the header that carries
 * the signature, hand over. The order that matters — verify before anything is believed, the duplicate
 * guard before the opt-out and the counter, the counter after both — is `ChannelGateway`'s, because
 * the next channel needs the same order and a second copy of it is a second chance to get it wrong.
 *
 * A request's body is handed over as text and as the bytes it arrived as: Twilio signs the parsed
 * fields, and Resend signs the bytes, so a route cannot decide for both which one its provider meant.
 */
async function deliver(context: RouteContext, route: Route): Promise<void> {
  const { request, target, headers } = context;
  const raw = await readBody(request);
  const result = await route.gateway.ingest(route.channel, {
    url: route.url?.(request, target, headers) ?? `${target.origin}${target.pathname}`,
    body: new TextDecoder().decode(raw),
    raw,
    signature: single(headers, route.signature),
    headers: headerBag(headers),
  });
  route.answer(context, result);
}

/**
 * Resend's statuses, and the four the route can answer with.
 *
 * `ignored` is a 204 with no body: a delivery this office does not take as a message (Resend's own
 * `email.sent`, `email.delivered`) is acknowledged so it is not retried, and nothing is written.
 */
const EMAIL_REFUSAL: Readonly<Record<InboundRefusal, { status: number; body: string }>> = {
  ignored: { status: 204, body: "" },
  signature: { status: 401, body: "webhook unauthorized\n" },
  malformed: { status: 400, body: "invalid webhook\n" },
  wrong_number: { status: 404, body: "not found\n" },
};

/**
 * Opens the loopback listener and serves the route table.
 *
 * `board` is the one duplicate table every channel shares; the email route cannot be served without
 * it, because a webhook that cannot recognise a redelivery is a webhook that hands the office the
 * same email twice.
 *
 * `twilio` is optional so a host that has not provisioned a number serves only the email webhook; the
 * route does not exist without it, and answers 404 rather than pretending to be misconfigured.
 */
export async function openResendListener(options: {
  inbox: InternalResendInbox;
  board: InboundStore;
  port: number;
  twilio?: TwilioHookOptions;
}): Promise<ResendListener> {
  if (
    options?.inbox === null ||
    typeof options?.inbox !== "object" ||
    !Number.isSafeInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    throw new Error("Listener configuration is invalid.");
  }
  if (typeof options.board?.recordInboundOnce !== "function") {
    throw new Error("The email route needs the board's inbound store.");
  }
  const twilio = options.twilio;
  const routes = new Map<string, Route>();
  // Built once, at startup: the adapter holds the mailbox authority, and a route that could not
  // recognise its own inbox should stop the host rather than fail the first webhook.
  const email = new ResendInboundAdapter({ inbox: options.inbox });
  routes.set("/webhooks/resend", {
    method: "POST",
    contentType: "application/json",
    channel: email.name,
    gateway: emailGateway({ adapter: email, board: options.board }),
    signature: "svix-signature",
    // The two refusals this route has always answered, with the same bodies.
    refuse: (response, status) =>
      respond(
        response,
        status,
        status === 405 ? "method not allowed\n" : "unsupported media type\n",
      ),
    answer: ({ response, headers }, result) => {
      if (!result.accepted) {
        if (result.reason === "malformed") {
          // A delivery carrying none of the three headers svix signs with is not a webhook this
          // route can read at all, and that has always been answered in those words. The adapter
          // says `malformed` for both cases; the difference between "not a webhook" and "not a
          // readable one" is HTTP vocabulary, which is this file's.
          const signed =
            single(headers, "svix-id") !== undefined &&
            single(headers, "svix-timestamp") !== undefined &&
            single(headers, "svix-signature") !== undefined;
          return respond(
            response,
            400,
            signed ? EMAIL_REFUSAL.malformed.body : "invalid webhook headers\n",
          );
        }
        const refusal = EMAIL_REFUSAL[result.reason];
        return respond(response, refusal.status, refusal.body);
      }
      // Resend has been told 202 for a first delivery and 200 for one it had already been thanked
      // for; both mean "we have it", and only the disposition differs. That distinction is the
      // provider's own and stays here rather than in the gateway.
      return respondAck(
        response,
        result.ack,
        result.outcome.disposition === "duplicate" ? 200 : 202,
      );
    },
  });
  if (twilio !== undefined) {
    if (typeof twilio.board?.recordInboundOnce !== "function") {
      throw new Error("The Twilio route needs the board's SMS intake store.");
    }
    // Built once, at startup: the adapter's constructor is where a placeholder token is refused, and a
    // failure there should stop the host rather than fail the first webhook.
    const adapter = new TwilioAdapter({
      authToken: twilio.authToken,
      businessNumber: businessNumberOf(twilio),
    });
    routes.set("/hooks/twilio", {
      method: "POST",
      contentType: TWILIO_FORM_CONTENT_TYPE,
      channel: adapter.name,
      gateway: smsGateway({ ...twilio, adapter }),
      signature: "x-twilio-signature",
      url: (_request, target, headers) => twilio.signedUrl ?? signedUrlOf(target, headers),
      // A wrong method or media type is answered in the provider's own dialect too, so the refusal
      // renderer is the adapter's ack rather than a status-specific body this file invents.
      refuse: (response, status) => respondAck(response, adapter.ack(), status),
      answer: ({ response }, result) => {
        if (!result.accepted) {
          // No body on a refusal, and nothing about the refusal's reason in the response: an attacker
          // who learns whether a number is provisioned has learned which office they reached. The
          // board was not touched, and the message body is not logged — it is a stranger's text, and
          // unverified.
          if (result.reason === "signature") return respond(response, 403, "");
          // The rest answer in TwiML: a provider whose parser rejects the answer retries it.
          return respondAck(response, result.ack, result.reason === "wrong_number" ? 404 : 400);
        }
        return respondAck(response, result.ack, result.ack.status);
      },
    });
  }

  const sockets = new Set<Socket>();
  let closing = false;
  const server = createServer(async (request, response) => {
    if (closing) return respond(response, 503, "listener closing\n");
    const timer = setTimeout(() => {
      respond(response, 408, "request timeout\n");
      request.destroy();
    }, TIMEOUT);
    try {
      const target = new URL(request.url ?? "", "http://127.0.0.1");
      // A query string is refused on every route: the signature covers the URL, and a route that
      // accepted parameters it did not read would be one more thing to reason about per request.
      if (target.search !== "") return respond(response, 404, "not found\n");
      const route = routes.get(target.pathname);
      if (route === undefined) return respond(response, 404, "not found\n");
      if (request.method !== route.method) return route.refuse(response, 405);
      const headers = request.headersDistinct;
      // A media type is compared without its parameters (`; charset=…`): the provider declares a
      // type, and a route that refused a charset it did not ask for would refuse its own provider.
      const contentType = single(headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== route.contentType) return route.refuse(response, 415);
      await deliver({ request, response, target, headers }, route);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "too_large") respond(response, 413, "payload too large\n");
      else if (message.includes("identity conflict")) respond(response, 409, "webhook conflict\n");
      else if (message.includes("signature") || message.includes("timestamp"))
        respond(response, 401, "webhook unauthorized\n");
      else if (message.includes("Receiving event") || message.includes("Webhook"))
        respond(response, 400, "invalid webhook\n");
      else respond(response, 503, "webhook unavailable\n");
    } finally {
      clearTimeout(timer);
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, "127.0.0.1");
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    server.close();
    throw new Error("Listener address is unavailable.");
  }
  let closePromise: Promise<void> | undefined;
  return {
    address: `http://127.0.0.1:${bound.port}`,
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        closing = true;
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        for (const socket of sockets) socket.destroy();
      });
      return closePromise;
    },
  };
}
