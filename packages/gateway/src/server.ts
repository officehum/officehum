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
    void serveHttp(request, response).catch((error: unknown) => {
      log(`HTTP ${request.method} ${request.url} failed: ${String(error)}`);
      if (!response.headersSent)
        json(response, 500, errorBody("internal", "The gateway failed; its log has the details."));
      else response.end();
    });
  });

  async function serveHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
    try {
      ({ principal } = await signIn(bearerToken(request.headers.authorization)));
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
      const reply = await once(router, principal, { type: "subscribe", id: "http", requestId });
      if (reply.type === "error") {
        json(response, HTTP_STATUS[reply.code], reply);
        return;
      }
      // The runtime writes a subscribe's result and its replayed events together; let them land.
      await new Promise((resolve) => setImmediate(resolve));
      const known = router.snapshot(principal, requestId);
      const settled = known?.events.find((event) => event.event.kind === "settled");
      json(response, 200, {
        requestId,
        status: settled === undefined ? "running" : "settled",
        ...(settled === undefined ? {} : { result: settled.event }),
        events: known?.events.length ?? 0,
      });
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
    request.on("close", () => router.disconnect(stream));
    router.handle(stream, principal, { type: "subscribe", id: "sse", requestId, afterSeq });
  }

  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://gateway");
    if (url.pathname !== "/v1/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const header = bearerToken(request.headers.authorization);
    const accept = (signedIn: VerifiedToken | undefined) =>
      sockets.handleUpgrade(request, socket, head, (ws) => session(ws, signedIn));
    if (header === undefined) {
      accept(undefined);
      return;
    }
    signIn(header).then(accept, (error: unknown) => {
      audit({ at: new Date().toISOString(), action: "connect", outcome: "unauthorized" });
      log(error instanceof AuthError ? `Refused a WebSocket: ${error.message}` : String(error));
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    });
  });

  function session(ws: WebSocket, signedIn: VerifiedToken | undefined): void {
    let identity = signedIn;
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
    // One message at a time per connection, so a `hello` signing in is done before the next command.
    let queue = Promise.resolve();
    ws.on("message", (data, isBinary) => {
      queue = queue
        .then(() => receive(data.toString(), isBinary))
        .catch((error: unknown) => {
          log(`A WebSocket message failed: ${String(error)}`);
        });
    });
    ws.on("close", () => router.disconnect(sink));

    async function receive(text: string, isBinary: boolean): Promise<void> {
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
            identity = await signIn(message.token);
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

  supervisor.start();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
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
