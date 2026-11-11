/**
 * `startGateway`: the office's network edge. One HTTP(S) server carries:
 *
 * - `GET /v1/ws`: a WebSocket speaking the Gateway Protocol, one JSON message per WebSocket message.
 *   It signs in with `Authorization: Bearer` on the upgrade, or a `hello` carrying `token`.
 * - `POST /v1/submit`: submits work and answers with `accepted`.
 * - `GET /v1/requests/:requestId`: whether a request has settled, and how.
 * - `GET /v1/requests/:requestId/events`: the request's events as Server-Sent Events; `Last-Event-ID`
 *   (the event's `seq`) resumes after the last one seen.
 * - `GET /healthz`: whether the runtime is up. No sign-in needed.
 *
 * Every other route needs a bearer token. A client never sets `principal`: one in a message is
 * stripped, and the token's is attached. Each command is written to the audit log.
 *
 * Connections are limited per principal, per remote address and in total (`limits` in
 * `gateway.json`): one over a limit is refused with 429, or 503 for the total, and the refusal is
 * audited. A WebSocket whose token expired is closed (1008) unless it sends a fresh `hello` within
 * `limits.expiredGraceSeconds`.
 */

import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import {
  type ClientCommand,
  type ErrorCode,
  type ErrorMessage,
  handshake,
  invalidMessage,
  MAX_FRAME_BYTES,
  type Principal,
  replyId,
  type ServerMessage,
  validateMessage,
} from "@officehum/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { AuthError, bearerToken, type TokenKey, type VerifiedToken, verifyToken } from "./auth.js";
import type { GatewayConfig } from "./config.js";
import { ConnectionLimits, type Lease, type Refusal } from "./connection-limits.js";
import { type AuditEntry, type ClientSink, Router } from "./router.js";
import { type Backoff, RuntimeSupervisor } from "./supervisor.js";

export interface GatewayOptions {
  readonly config: GatewayConfig;
  /** The key client tokens are verified with (`tokenKeyFromEnvironment()` in production). */
  readonly key: TokenKey;
  /** The runtime's environment. Default: the gateway's own, which carries its model credentials. */
  readonly runtimeEnv?: NodeJS.ProcessEnv;
  readonly backoff?: Backoff;
  /** Operational log. Default: stderr. */
  readonly log?: (line: string) => void;
  /** The audit log. Default: one JSON line per entry on stderr. */
  readonly audit?: (entry: AuditEntry) => void;
}

export interface Gateway {
  /** `http://host:port` or `https://host:port`, with the port actually bound. */
  readonly url: string;
  readonly runtimeUp: () => boolean;
  /** The runtime's process id, for operators and tests. */
  readonly runtimePid: () => number | undefined;
  close(): Promise<void>;
}

const HTTP_STATUS: Record<ErrorCode, number> = {
  bad_frame: 400,
  frame_too_large: 413,
  unsupported_version: 400,
  invalid_message: 400,
  unknown_agent: 404,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  busy: 503,
  internal: 500,
};

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const { config, key } = options;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const audit =
    options.audit ??
    ((entry: AuditEntry) => process.stderr.write(`${JSON.stringify({ audit: entry })}\n`));
  const verifyOptions = config.auth;

  const supervisor: RuntimeSupervisor = new RuntimeSupervisor({
    command: config.runtime.command,
    args: config.runtime.args,
    cwd: config.runtime.cwd,
    ...(options.runtimeEnv === undefined ? {} : { env: options.runtimeEnv }),
    ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
    onFrame: (frame) => router.onRuntimeFrame(frame),
    onState: (state) => (state === "up" ? router.onRuntimeUp() : router.onRuntimeDown()),
    log,
  });
  const router = new Router({ permissions: config.permissions, runtime: supervisor, audit, log });
  const limits = new ConnectionLimits(config.limits);

  /** Audits a connection refused for a limit. */
  const auditRefusal = (action: string, refusal: Refusal, principal?: string) =>
    audit({
      at: new Date().toISOString(),
      ...(principal === undefined ? {} : { principal }),
      action,
      outcome: `refused: ${refusal.scope} connection limit`,
    });

  const signIn = async (token: string | undefined): Promise<VerifiedToken> => {
    if (token === undefined) throw new AuthError("Sign in: send Authorization: Bearer <token>.");
    return await verifyToken(token, key, verifyOptions);
  };

  const server: Server =
    config.tls === undefined
      ? createHttpServer()
      : createHttpsServer({
          cert: readFileSync(config.tls.cert),
          key: readFileSync(config.tls.key),
          ...(config.tls.clientCa === undefined
            ? {}
            : {
                ca: readFileSync(config.tls.clientCa),
                requestCert: true,
                rejectUnauthorized: true,
              }),
        });

  server.on("request", (request, response) => {
    let lease: Lease | undefined;
    // `/healthz` takes no lease, so a load balancer can always ask.
    if (!(request.method === "GET" && request.url === "/healthz")) {
      const opened = limits.open(addressOf(request));
      if ("refusal" in opened) {
        auditRefusal(`http ${request.method} ${pathOf(request)}`, opened.refusal);
        json(response, opened.refusal.status, errorBody("busy", opened.refusal.message));
        return;
      }
      lease = opened.lease;
      response.on("close", () => lease?.release());
    }
    void serveHttp(request, response, lease).catch((error: unknown) => {
      log(`HTTP ${request.method} ${request.url} failed: ${String(error)}`);
      if (!response.headersSent)
        json(response, 500, errorBody("internal", "The gateway failed; its log has the details."));
      else response.end();
    });
  });

  async function serveHttp(
    request: IncomingMessage,
    response: ServerResponse,
    lease: Lease | undefined,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://gateway");
    if (request.method === "GET" && url.pathname === "/healthz") {
      const up = supervisor.up;
      json(response, up ? 200 : 503, {
        status: up ? "ok" : "starting",
        runtime: up ? "up" : "down",
      });
      return;
    }
    const route = matchRoute(request.method, url.pathname);
    if (route === undefined) {
      json(response, 404, errorBody("not_found", `No route ${request.method} ${url.pathname}.`));
      return;
    }
    let principal: Principal;
    let expiresAt: number;
    try {
      ({ principal, expiresAt } = await signIn(bearerToken(request.headers.authorization)));
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      audit({
        at: new Date().toISOString(),
        action: `http ${route.name}`,
        outcome: "unauthorized",
      });
      json(response, 401, errorBody("unauthorized", error.message));
      return;
    }

    if (route.name === "submit") {
      const body = await readBody(request);
      if (!body.ok) {
        json(response, HTTP_STATUS[body.error.code], body.error);
        return;
      }
      const value = stripPrincipal(body.value);
      const command = commandFrom(
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? { ...value, type: "submit", id: "http" }
          : value,
      );
      if (!command.ok) {
        json(response, 400, command.error);
        return;
      }
      const reply = await once(router, principal, command.message);
      json(response, reply.type === "error" ? HTTP_STATUS[reply.code] : 202, reply);
      return;
    }

    const requestId = route.requestId;
    if (route.name === "status") {
      const reply = await statusOf(router, principal, requestId);
      if (reply !== undefined) {
        json(response, HTTP_STATUS[reply.code], reply);
        return;
      }
      const known = router.snapshot(principal, requestId);
      const settled = known?.events.find((event) => event.event.kind === "settled");
      json(response, 200, {
        requestId,
        status: settled === undefined ? "running" : "settled",
        ...(settled === undefined ? {} : { result: settled.event }),
        events: known?.eventCount ?? 0,
      });
      return;
    }

    // An event stream stays open, so it counts against its principal's limit.
    const refused = lease?.assign(principal.id);
    if (refused !== undefined) {
      auditRefusal("http events", refused, principal.id);
      json(response, refused.status, errorBody("busy", refused.message));
      return;
    }

    // Server-Sent Events: each event's `id` is its seq, so a reconnect's Last-Event-ID resumes after it.
    const lastEventId = Number.parseInt(String(request.headers["last-event-id"] ?? ""), 10);
    const afterSeq = Number.isInteger(lastEventId) && lastEventId >= 0 ? lastEventId : 0;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const stream: ClientSink = {
      send(message) {
        if (message.type === "error") {
          response.end(`event: error\ndata: ${JSON.stringify(message)}\n\n`);
          router.disconnect(stream);
          return;
        }
        if (message.type !== "event") return;
        response.write(
          `id: ${message.seq}\nevent: ${message.event.kind}\ndata: ${JSON.stringify(message)}\n\n`,
        );
        if (message.event.kind === "settled") {
          response.end();
          router.disconnect(stream);
        } else if (response.writableLength > config.clientBufferBytes) {
          log(`Closing an event stream for ${principal.id}: it is not reading.`);
          response.destroy();
          router.disconnect(stream);
        }
      },
    };
    // A stream ends when the token that opened it expires; the client reconnects with a fresh one.
    const expiry = atTime(expiresAt, () => {
      response.end(
        `event: error\ndata: ${JSON.stringify({ type: "error", code: "unauthorized", message: "Your token has expired; reconnect with a fresh one." })}\n\n`,
      );
      router.disconnect(stream);
    });
    request.on("close", () => {
      expiry.cancel();
      router.disconnect(stream);
    });
    router.handle(stream, principal, { type: "subscribe", id: "sse", requestId, afterSeq });
  }

  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  server.on("upgrade", (request, socket, head) => {
    // Node drops its own error listener before `upgrade`: without one, a client that resets the
    // connection while being refused would crash the gateway with an unhandled EPIPE.
    socket.on("error", (error) => log(`A connection failed during upgrade: ${error.message}`));
    let lease: Lease | undefined;
    // A refused connection gives its room back at once, and is destroyed shortly after the answer:
    // a client that never closes its own end must not hold a lease, or a socket, for ever.
    const refuse = (status: string) => {
      lease?.release();
      if (!socket.writable) {
        socket.destroy();
        return;
      }
      socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
      setTimeout(() => socket.destroy(), REFUSED_LINGER_MS).unref();
    };
    const url = new URL(request.url ?? "/", "http://gateway");
    if (url.pathname !== "/v1/ws") {
      refuse("404 Not Found");
      return;
    }
    const opened = limits.open(addressOf(request));
    if ("refusal" in opened) {
      auditRefusal("connect", opened.refusal);
      refuse(statusLine(opened.refusal.status));
      return;
    }
    const granted = opened.lease;
    lease = granted;
    socket.once("close", () => granted.release());
    const header = bearerToken(request.headers.authorization);
    const accept = (signedIn: VerifiedToken | undefined) => {
      const refused = signedIn === undefined ? undefined : granted.assign(signedIn.principal.id);
      if (refused !== undefined) {
        auditRefusal("connect", refused, signedIn?.principal.id);
        refuse(statusLine(refused.status));
        return;
      }
      sockets.handleUpgrade(request, socket, head, (ws) => session(ws, signedIn, granted));
    };
    if (header === undefined) {
      accept(undefined);
      return;
    }
    signIn(header).then(accept, (error: unknown) => {
      audit({ at: new Date().toISOString(), action: "connect", outcome: "unauthorized" });
      log(error instanceof AuthError ? `Refused a WebSocket: ${error.message}` : String(error));
      refuse("401 Unauthorized");
    });
  });

  function session(ws: WebSocket, signedIn: VerifiedToken | undefined, lease: Lease): void {
    let identity = signedIn;
    // A connection that never signs in is not kept open.
    const deadline =
      signedIn === undefined
        ? setTimeout(() => {
            if (identity === undefined) ws.close(1008, "Sign in within 30 seconds.");
          }, SIGN_IN_DEADLINE_MS)
        : undefined;
    // When the token expires, the connection's subscriptions stop; a fresh hello signs in again.
    // Armed once `sink` exists, below.
    let expiry: { cancel(): void } | undefined;
    // An expired connection that does not sign in again is closed after the grace period.
    let grace: NodeJS.Timeout | undefined;
    const graceSeconds = config.limits.expiredGraceSeconds;
    function expire() {
      router.disconnect(sink);
      sink.send({
        type: "error",
        code: "unauthorized",
        message: `Your token has expired; send hello with a fresh one within ${graceSeconds} seconds, or this connection closes.`,
      });
      clearTimeout(grace);
      grace = setTimeout(() => {
        if (identity !== undefined && identity.expiresAt > Date.now()) return;
        log(`Closing a WebSocket of ${identity?.principal.id ?? "nobody"}: its token expired.`);
        ws.close(1008, "Your token expired and no fresh one came.");
      }, graceSeconds * 1000);
    }
    const sink: ClientSink = {
      send(message) {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify(message));
        if (ws.bufferedAmount > config.clientBufferBytes) {
          log(
            `Disconnecting a client of ${identity?.principal.id ?? "nobody"}: it is not reading.`,
          );
          ws.terminate();
        }
      },
    };
    if (signedIn !== undefined) expiry = atTime(signedIn.expiresAt, expire);
    // One message at a time per connection, so a `hello` signing in is done before the next command.
    let queue = Promise.resolve();
    ws.on("message", (data, isBinary) => {
      queue = queue
        .then(() => receive(data.toString(), isBinary))
        .catch((error: unknown) => {
          log(`A WebSocket message failed: ${String(error)}`);
        });
    });
    ws.on("close", () => {
      clearTimeout(deadline);
      clearTimeout(grace);
      expiry?.cancel();
      router.disconnect(sink);
      lease.release();
    });

    async function receive(text: string, isBinary: boolean): Promise<void> {
      // Messages queued before the close still drain; a closed connection must not subscribe.
      if (ws.readyState !== ws.OPEN) return;
      let value: unknown;
      try {
        if (isBinary) throw new Error("binary");
        value = JSON.parse(text);
      } catch {
        sink.send({
          type: "error",
          code: "bad_frame",
          message: "Each WebSocket message must be one JSON object, as text.",
        });
        return;
      }
      const checked = validateMessage(stripPrincipal(value), "client");
      if (!checked.ok) {
        sink.send(invalidMessage(checked.problems, replyId(value)));
        return;
      }
      const message = checked.message;
      if (message.type === "hello") {
        if (message.token !== undefined) {
          try {
            const next = await signIn(message.token);
            const refused = lease.assign(next.principal.id);
            if (refused !== undefined) {
              auditRefusal("hello", refused, next.principal.id);
              sink.send({ type: "error", code: "busy", message: refused.message });
              ws.close(1013, "Too many connections.");
              return;
            }
            // Signing in as someone else leaves nothing of the previous principal on this socket.
            if (identity !== undefined && identity.principal.id !== next.principal.id) {
              router.disconnect(sink);
            }
            identity = next;
            expiry?.cancel();
            clearTimeout(grace);
            expiry = atTime(next.expiresAt, expire);
          } catch (error) {
            if (!(error instanceof AuthError)) throw error;
            audit({ at: new Date().toISOString(), action: "hello", outcome: "unauthorized" });
            sink.send({ type: "error", code: "unauthorized", message: error.message });
            return;
          }
        }
        const serverId = router.serverId;
        sink.send(
          serverId === undefined
            ? {
                type: "error",
                code: "busy",
                message: "The office is starting; send hello again in a moment.",
              }
            : handshake(message, serverId),
        );
        return;
      }
      if (identity === undefined || identity.expiresAt <= Date.now()) {
        audit({ at: new Date().toISOString(), action: message.type, outcome: "unauthorized" });
        sink.send({
          type: "error",
          id: message.id,
          code: "unauthorized",
          message:
            identity === undefined
              ? "Sign in first: send hello with your token, or connect with Authorization: Bearer."
              : "Your token has expired; send hello with a fresh one.",
        });
        return;
      }
      router.handle(sink, identity.principal, message);
    }
  }

  // Listen first: a gateway that cannot bind its port must not leave a runtime running behind it.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  supervisor.start();
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;

  let closing: Promise<void> | undefined;
  return {
    url: `${config.tls === undefined ? "http" : "https"}://${host}:${address.port}`,
    runtimeUp: () => supervisor.up,
    runtimePid: () => supervisor.pid,
    close() {
      closing ??= (async () => {
        for (const client of sockets.clients) client.terminate();
        sockets.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await supervisor.stop();
      })();
      return closing;
    },
  };
}

type Route =
  | { readonly name: "submit" }
  | { readonly name: "status" | "events"; readonly requestId: string };

function matchRoute(method: string | undefined, path: string): Route | undefined {
  if (method === "POST" && path === "/v1/submit") return { name: "submit" };
  if (method !== "GET") return undefined;
  const match = /^\/v1\/requests\/([^/]+)(\/events)?$/.exec(path);
  if (match?.[1] === undefined) return undefined;
  let requestId: string;
  try {
    requestId = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  return { name: match[2] === undefined ? "status" : "events", requestId };
}

function addressOf(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function pathOf(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://gateway").pathname;
}

function statusLine(status: 429 | 503): string {
  return status === 429 ? "429 Too Many Requests" : "503 Service Unavailable";
}

/** How long a refused upgrade's socket may linger after its answer before it is destroyed. */
const REFUSED_LINGER_MS = 1_000;

/** How long an unsigned WebSocket may stay open without signing in. */
const SIGN_IN_DEADLINE_MS = 30_000;

/** How long a status read waits for a settled request's `settled` event before calling it running. */
const SETTLED_WAIT_MS = 10_000;

/**
 * Runs `fn` at `time` (milliseconds since the epoch). Timers cap at about 24 days, so a long wait is
 * re-armed in steps.
 */
function atTime(time: number, fn: () => void): { cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    const wait = time - Date.now();
    if (wait <= 0) {
      fn();
      return;
    }
    timer = setTimeout(arm, Math.min(wait, 2_147_483_647));
  };
  arm();
  return { cancel: () => clearTimeout(timer) };
}

/**
 * Subscribes once to read a request's state. The runtime's result says whether the request has
 * settled; when it has, its `settled` event follows, so the read waits for that rather than for time.
 * Undefined when the read worked; the error otherwise.
 */
function statusOf(
  router: Router,
  principal: Principal,
  requestId: string,
): Promise<ErrorMessage | undefined> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = (outcome: ErrorMessage | undefined) => {
      clearTimeout(timer);
      router.disconnect(sink);
      resolve(outcome);
    };
    const sink: ClientSink = {
      send(message) {
        if (message.type === "error") done(message);
        else if (message.type === "event" && message.event.kind === "settled") done(undefined);
        else if (message.type === "result") {
          const settled = (message.data as { settled?: unknown } | undefined)?.settled === true;
          if (!settled) done(undefined);
          else timer = setTimeout(() => done(undefined), SETTLED_WAIT_MS);
        }
      },
    };
    router.handle(sink, principal, { type: "subscribe", id: "http", requestId });
  });
}

/** Sends one command through the router and resolves with its first reply. */
function once(
  router: Router,
  principal: Principal,
  command: ClientCommand,
): Promise<ServerMessage> {
  return new Promise((resolve) => {
    const sink: ClientSink = {
      send(message) {
        if (message.type === "event") return;
        router.disconnect(sink);
        resolve(message);
      },
    };
    router.handle(sink, principal, command);
  });
}

/** A client may never set `principal`; one it sends is removed before anything reads the message. */
function stripPrincipal(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("principal" in value)
  ) {
    return value;
  }
  const { principal: _stripped, ...rest } = value as Record<string, unknown>;
  return rest;
}

function commandFrom(
  value: unknown,
): { ok: true; message: ClientCommand } | { ok: false; error: ErrorMessage } {
  const checked = validateMessage(value, "client");
  if (!checked.ok) return { ok: false, error: invalidMessage(checked.problems) };
  if (checked.message.type === "hello") {
    return { ok: false, error: errorBody("invalid_message", "Expected a command, not hello.") };
  }
  return { ok: true, message: checked.message };
}

async function readBody(
  request: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; error: ErrorMessage }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_FRAME_BYTES) {
      return {
        ok: false,
        error: errorBody("frame_too_large", `The body is larger than ${MAX_FRAME_BYTES} bytes.`),
      };
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, error: errorBody("bad_frame", "The body is not valid JSON.") };
  }
}

function errorBody(code: ErrorCode, message: string): ErrorMessage {
  return { type: "error", code, message };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
