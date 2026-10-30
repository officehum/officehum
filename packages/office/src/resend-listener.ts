/**
 * The office's webhook server: one loopback `node:http` listener, one route table (RASF-3162).
 *
 * It began as the Resend listener with a single hard-coded path, and it stays one server rather than
 * growing a second: a host publishes one port, terminates TLS in front of it once, and a provider is
 * configured in one place. Routes are entries in a table now, each owning its method, its media type and
 * the shape of its refusals, so adding `/hooks/twilio` needed no new socket and no change to the Resend
 * path's behaviour.
 *
 * The Resend route is deliberately untouched: same checks, same statuses, same bodies, same error
 * mapping. Its behaviour is a live integration, and a webhook router that "cleaned up" the one route
 * already in production would be the most expensive kind of refactor.
 *
 * The Twilio route is inbound only. It verifies the signature, parses the message, writes what the board
 * needs to remember, and answers with the empty TwiML that tells Twilio to send nothing. It never sends:
 * no code path in this file calls a provider, and the adapter has no member that would.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  admitWithin,
  DEFAULT_SMS_RATE_LIMIT,
  type E164,
  EMPTY_TWIML,
  type InboundMessage,
  optOutCommand,
  parseE164,
  type RateLimit,
  TWILIO_FORM_CONTENT_TYPE,
  TWIML_CONTENT_TYPE,
  TwilioAdapter,
} from "@officehum/channels";
import type { SmsStore } from "./board/sms.js";
import type { ResendInbox } from "./resend-inbox.js";

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
 * every real one — both failures look like a quiet, working server. The adapter checks the token's shape
 * as well as its presence, so `authToken: "test"` is refused at startup rather than at the first
 * forgery it lets through.
 */
export interface TwilioHookOptions {
  /** The account's auth token. Twilio issues 32 hexadecimal characters. */
  readonly authToken: string;
  /** The provisioned number this office receives on, in E.164. */
  readonly businessNumber: string;
  /** The board's SMS intake tables: the duplicate guard, opt-outs and the rate counter. */
  readonly board: SmsStore;
  /**
   * The exact URL Twilio is configured to call. Behind a TLS-terminating proxy the request cannot say
   * its own public URL, so a host passes it here; otherwise it is reconstructed from the request's
   * `host` and `x-forwarded-*` headers. A wrong URL fails closed — the signature will not match.
   */
  readonly signedUrl?: string;
  /** The ceiling for a sender this office has not registered. Three messages an hour by default. */
  readonly rateLimit?: RateLimit;
  /**
   * What the route decided, for a host that counts or logs. The HTTP answer cannot say it: every
   * accepted, duplicate and refused message gets the same 200, because a provider that is told "no"
   * retries, and a retry of a rate-limited text is the flood the ceiling exists to stop.
   */
  readonly onInbound?: (outcome: InboundOutcome) => void;
}

/** What became of a verified inbound message. `rate_limited` is stored and refused, in that order. */
export type InboundDisposition = "recorded" | "duplicate" | "opt_out" | "rate_limited";

export interface InboundOutcome {
  readonly message: InboundMessage;
  readonly disposition: InboundDisposition;
}

type RouteContext = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly target: URL;
};

type Route = {
  readonly method: "POST";
  readonly contentType: string;
  /** How this route refuses a request it could not read the shape of. */
  readonly refuse: (response: ServerResponse, status: number) => void;
  handle(context: RouteContext): Promise<void>;
};

function headerValues(request: IncomingMessage, name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name)
      result.push(request.rawHeaders[index + 1] ?? "");
  }
  return result;
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
 * A TwiML answer. `text/xml` exactly, because Twilio's parser dispatches on the declared type and an
 * answer it cannot parse is an answer it retries. `EMPTY_TWIML` is imported rather than written here:
 * one string, one place, so no call site can answer with a `<Message>`.
 */
function respondTwiml(response: ServerResponse, status: number, body: string = EMPTY_TWIML): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "content-type": TWIML_CONTENT_TYPE,
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  response.end(body);
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
 */
function businessNumberOf(options: TwilioHookOptions): E164 {
  const parsed = parseE164(options.businessNumber);
  if (parsed === undefined) {
    throw new Error(
      "The Twilio route needs a business number in E.164 form, with its country code.",
    );
  }
  return parsed;
}

/**
 * The URL Twilio signed. The provider signs the absolute URL it was configured with, so a request that
 * arrives through a proxy is checked against the public name the proxy forwards, not against
 * `127.0.0.1`. A host that terminates TLS without forwarding either header passes `signedUrl` instead.
 */
function signedUrlOf(request: IncomingMessage, target: URL): string {
  const proto = headerValues(request, "x-forwarded-proto")[0]?.split(",")[0]?.trim() || "http";
  const host =
    headerValues(request, "x-forwarded-host")[0]?.split(",")[0]?.trim() ||
    headerValues(request, "host")[0] ||
    "127.0.0.1";
  return `${proto}://${host}${target.pathname}`;
}

async function deliverResend(context: RouteContext, inbox: ResendInbox): Promise<void> {
  const { request, response } = context;
  const ids = headerValues(request, "svix-id");
  const timestamps = headerValues(request, "svix-timestamp");
  const signatures = headerValues(request, "svix-signature");
  if (ids.length !== 1 || timestamps.length !== 1 || signatures.length !== 1) {
    return respond(response, 400, "invalid webhook headers\n");
  }
  const raw = await readBody(request);
  const result = await inbox.accept(raw, {
    id: ids[0] ?? "",
    timestamp: timestamps[0] ?? "",
    signature: signatures[0] ?? "",
  });
  respond(response, result.status, result.status === 204 ? "" : "accepted\n");
}

/**
 * Verify, record, answer.
 *
 * The order matters more than the code length. Verification comes before anything is read as a fact, so
 * a forged request leaves no row. The duplicate guard comes before the opt-out and the counter, so a
 * Twilio retry of a STOP does not count as a second message. The counter comes last, so a keyword a
 * person is entitled to send is never refused for being their fourth text.
 */
async function deliverTwilio(
  context: RouteContext,
  options: TwilioHookOptions,
  adapter: TwilioAdapter,
): Promise<void> {
  const { request, response, target } = context;
  const signatures = headerValues(request, "x-twilio-signature");
  const raw = await readBody(request);
  const result = adapter.accept({
    url: options.signedUrl ?? signedUrlOf(request, target),
    body: new TextDecoder().decode(raw),
    signature: signatures.length === 1 ? signatures[0] : undefined,
  });
  if (!result.accepted) {
    // No body on a refusal, and nothing about the refusal's reason in the response: an attacker who
    // learns whether a number is provisioned has learned which office they reached. The board was not
    // touched, and the message body is not logged — it is a stranger's text, and unverified.
    if (result.reason === "signature") return respond(response, 403, "");
    if (result.reason === "wrong_number") return respondTwiml(response, 404);
    return respondTwiml(response, 400);
  }

  const message = result.message;
  if (!options.board.recordInboundOnce(message.messageSid, message.receivedAt)) {
    options.onInbound?.({ message, disposition: "duplicate" });
    return respondTwiml(response, 200);
  }

  const command = optOutCommand(message.body);
  if (command !== undefined) {
    options.board.setOptOut(message.from, command, message.receivedAt);
    options.onInbound?.({ message, disposition: "opt_out" });
    return respondTwiml(response, 200);
  }

  const { allowed } = admitWithin(
    options.board,
    message.from,
    message.receivedAt,
    options.rateLimit ?? DEFAULT_SMS_RATE_LIMIT,
  );
  options.onInbound?.({ message, disposition: allowed ? "recorded" : "rate_limited" });
  // A refusal is still a 200 with empty TwiML. The ceiling is the office's, not the provider's, so
  // telling Twilio to retry would turn one flood into an unbounded stream of retries.
  return respondTwiml(response, 200);
}

/**
 * Opens the loopback listener and serves the route table.
 *
 * `twilio` is optional so a host that has not provisioned a number serves only the email webhook; the
 * route does not exist without it, and answers 404 rather than pretending to be misconfigured.
 */
export async function openResendListener(options: {
  inbox: ResendInbox;
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
  const twilio = options.twilio;
  const routes = new Map<string, Route>();
  routes.set("/webhooks/resend", {
    method: "POST",
    contentType: "application/json",
    // The two refusals this route has always answered, with the same bodies.
    refuse: (response, status) =>
      respond(
        response,
        status,
        status === 405 ? "method not allowed\n" : "unsupported media type\n",
      ),
    handle: (context) => deliverResend(context, options.inbox),
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
      refuse: (response, status) => respondTwiml(response, status),
      handle: (context) => deliverTwilio(context, twilio, adapter),
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
      const contentType = headerValues(request, "content-type");
      if (
        contentType.length !== 1 ||
        contentType[0]?.split(";", 1)[0]?.trim().toLowerCase() !== route.contentType
      ) {
        return route.refuse(response, 415);
      }
      await route.handle({ request, response, target });
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
