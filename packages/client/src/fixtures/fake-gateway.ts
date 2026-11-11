/**
 * An in-process stand-in for a gateway, for the client's tests: it speaks the Gateway Protocol on
 * `/v1/ws` and the gateway's HTTP routes, and the test decides every event, drop and refusal.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClientMessage, EventMessage, RequestEvent, ServerMessage } from "@officehum/protocol";
import { type WebSocket, WebSocketServer } from "ws";

interface Request {
  events: EventMessage[];
  watchers: Set<(message: EventMessage) => void>;
}

export interface FakeGateway {
  readonly url: string;
  /** Every client message on a WebSocket, in order. */
  readonly received: ClientMessage[];
  /** Every token a client signed in with, WebSocket `hello` or HTTP header. */
  readonly tokens: string[];
  /** HTTP requests: method, path and Last-Event-ID. */
  readonly http: { method: string; path: string; lastEventId?: string }[];
  /** Adds an event to a request (numbering it) and sends it to whoever watches the request. */
  emit(requestId: string, event: RequestEvent): void;
  /** Ends every open WebSocket and event stream, as a network failure would. */
  drop(): void;
  /** Answers the next `count` submits with `busy`. */
  busyNext(count: number): void;
  /** Replays from one event before `afterSeq` on subscribe, as an overlapping resume might. */
  overlap: boolean;
  /** Commands of these types get no reply at all. */
  readonly silent: Set<string>;
  close(): Promise<void>;
}

const FORBIDDEN_AGENT = "secret";
export const GOOD_TOKENS = /^good/;

export async function startFakeGateway(): Promise<FakeGateway> {
  const requests = new Map<string, Request>();
  const sockets = new Set<WebSocket>();
  const streams = new Set<ServerResponse>();
  const received: ClientMessage[] = [];
  const tokens: string[] = [];
  const http: FakeGateway["http"] = [];
  let busy = 0;

  const requestOf = (requestId: string) => {
    let request = requests.get(requestId);
    if (request === undefined) {
      request = { events: [], watchers: new Set() };
      requests.set(requestId, request);
    }
    return request;
  };
  const replay = (request: Request, afterSeq: number, send: (m: EventMessage) => void) => {
    const from = fake.overlap ? afterSeq - 1 : afterSeq;
    for (const event of request.events) {
      if (event.seq > from || event.event.kind === "settled") send(event);
    }
  };

  const server = createServer((req, res) => void route(req, res));
  const wss = new WebSocketServer({ server, path: "/v1/ws" });
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let signedIn = false;
    const send = (message: ServerMessage) => socket.send(JSON.stringify(message));
    const watched = new Set<Request>();
    const watcher = (message: EventMessage) => send(message);
    socket.on("close", () => {
      for (const request of watched) request.watchers.delete(watcher);
    });
    const watch = (request: Request, afterSeq: number) => {
      if (!watched.has(request)) {
        watched.add(request);
        request.watchers.add(watcher);
      }
      replay(request, afterSeq, send);
    };
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ClientMessage;
      received.push(message);
      if (message.type === "hello") {
        tokens.push(message.token ?? "");
        signedIn = GOOD_TOKENS.test(message.token ?? "");
        send(
          signedIn
            ? { type: "welcome", version: 1, serverId: "fake" }
            : { type: "error", code: "unauthorized", message: "That token is not valid." },
        );
        return;
      }
      if (fake.silent.has(message.type)) return;
      const { id } = message;
      if (!signedIn) {
        send({ type: "error", id, code: "unauthorized", message: "Sign in first." });
        return;
      }
      switch (message.type) {
        case "submit": {
          if (busy > 0) {
            busy--;
            send({ type: "error", id, code: "busy", message: "The runtime is restarting." });
            return;
          }
          if (message.agent === FORBIDDEN_AGENT) {
            send({ type: "error", id, code: "forbidden", message: "You may not use that agent." });
            return;
          }
          const existing = requests.has(message.requestId);
          const request = requestOf(message.requestId);
          send({
            type: "accepted",
            id,
            requestId: message.requestId,
            disposition: existing ? "existing" : "started",
          });
          watch(request, 0);
          return;
        }
        case "subscribe": {
          const request = requests.get(message.requestId);
          if (request === undefined) {
            send({ type: "error", id, code: "not_found", message: "No such request." });
            return;
          }
          const settled = request.events.some((event) => event.event.kind === "settled");
          send({ type: "result", id, ok: true, data: { settled } });
          watch(request, message.afterSeq ?? 0);
          return;
        }
        case "list_agents":
          send({
            type: "result",
            id,
            ok: true,
            data: { agents: [{ name: "frontdesk", model: "scripted/x", tools: [] }] },
          });
          return;
        default:
          send({ type: "result", id, ok: true });
      }
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://fake");
    const lastEventId = req.headers["last-event-id"];
    http.push({
      method: req.method ?? "",
      path: url.pathname,
      ...(typeof lastEventId === "string" ? { lastEventId } : {}),
    });
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    tokens.push(token);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!GOOD_TOKENS.test(token)) {
      json(401, { type: "error", code: "unauthorized", message: "Bad token." });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/submit") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text) as { agent: string; requestId: string };
      if (busy > 0) {
        busy--;
        json(503, { type: "error", id: "http", code: "busy", message: "Restarting." });
        return;
      }
      if (body.agent === FORBIDDEN_AGENT) {
        json(403, { type: "error", id: "http", code: "forbidden", message: "Not that agent." });
        return;
      }
      const existing = requests.has(body.requestId);
      requestOf(body.requestId);
      json(202, {
        type: "accepted",
        id: "http",
        requestId: body.requestId,
        disposition: existing ? "existing" : "started",
      });
      return;
    }
    const match = /^\/v1\/requests\/([^/]+)(\/events)?$/.exec(url.pathname);
    const request = match === null ? undefined : requests.get(decodeURIComponent(match[1] ?? ""));
    if (match === null || request === undefined) {
      json(404, { type: "error", code: "not_found", message: "No such request." });
      return;
    }
    if (match[2] === undefined) {
      const settled = request.events.find((event) => event.event.kind === "settled");
      json(200, { status: settled === undefined ? "running" : "settled" });
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    streams.add(res);
    const write = (message: EventMessage) => {
      res.write(
        `id: ${message.seq}\nevent: ${message.event.kind}\ndata: ${JSON.stringify(message)}\n\n`,
      );
      if (message.event.kind === "settled") res.end();
    };
    request.watchers.add(write);
    res.on("close", () => {
      request.watchers.delete(write);
      streams.delete(res);
    });
    replay(request, Number(lastEventId ?? 0) || 0, write);
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const fake: FakeGateway = {
    url: `http://127.0.0.1:${port}`,
    received,
    tokens,
    http,
    overlap: false,
    silent: new Set(),
    emit(requestId, event) {
      const request = requestOf(requestId);
      const message: EventMessage = {
        type: "event",
        requestId,
        seq: request.events.length + 1,
        event,
      };
      request.events.push(message);
      for (const watcher of request.watchers) watcher(message);
    },
    drop() {
      for (const socket of sockets) socket.terminate();
      for (const stream of streams) stream.destroy();
    },
    busyNext(count) {
      busy = count;
    },
    async close() {
      fake.drop();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return fake;
}
