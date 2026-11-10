/**
 * The gateway's core: between authenticated clients and the one runtime process.
 *
 * Outbound, it checks a command against the permissions, replaces any `principal` with the signed-in
 * one, gives the command a gateway id (clients' ids only have to be unique on their own connection),
 * and forwards it. Inbound, it routes each reply to the client whose command it answers, and each event
 * to the clients subscribed to that request, rewriting the runtime's scoped request id back to the
 * client's own.
 *
 * It owns the event numbers clients see. The runtime keeps events in memory and numbers a resumed
 * request from 1 again after a restart, so the gateway keeps each request's events with its own `seq`
 * that only grows, drops runtime events it has already seen in the current runtime generation, and
 * forwards `settled` once. After a restart it re-subscribes every unsettled request it knows.
 */

import {
  type ClientCommand,
  type EventMessage,
  type Principal,
  type ServerMessage,
  scopedRequestId,
  validateMessage,
} from "@officehum/protocol";
import type { Permissions } from "./config.js";
import { decide } from "./permissions.js";

/** Somewhere to send a client its replies and events: a WebSocket, an HTTP response, an SSE stream. */
export interface ClientSink {
  send(message: ServerMessage): void;
}

/** The runtime as the router sees it. */
export interface RuntimeLink {
  readonly up: boolean;
  /** False when the runtime is not up to take it. */
  send(message: object): boolean;
}

/** One line of the audit log: who did what, and what came of it. Never a message body or a token. */
export interface AuditEntry {
  readonly at: string;
  readonly principal?: string;
  readonly action: string;
  readonly agent?: string;
  readonly requestId?: string;
  readonly outcome: string;
}

/** A request the gateway knows, as `GET /v1/requests/:id` reports it. */
export interface RequestSnapshot {
  readonly requestId: string;
  readonly settled: boolean;
  readonly events: readonly EventMessage[];
}

interface Pending {
  /** Undefined for the gateway's own re-subscribes, and once the client has gone. */
  client: ClientSink | undefined;
  readonly clientId: string | undefined;
  readonly type: ClientCommand["type"];
  readonly principal: Principal;
  readonly requestId?: string;
  readonly afterSeq?: number;
}

interface RequestState {
  readonly principal: Principal;
  /** The client's own request id. */
  readonly requestId: string;
  /**
   * Events as clients see them: gateway-numbered, with the client's request id. Only the latest
   * `EVENT_LIMIT` are kept for replay (a long answer streams one `text_delta` per piece).
   */
  readonly events: EventMessage[];
  /** The next gateway `seq`; it keeps growing when old events are let go. */
  nextSeq: number;
  settled: boolean;
  /** The last runtime `seq` taken in the current runtime generation. */
  runtimeSeen: number;
  readonly subscribers: Set<ClientSink>;
}

/** Settled requests nobody is watching are forgotten beyond this many known requests. */
const REQUEST_LIMIT = 1_000;

/** Events kept per request for replay; older ones are let go, and `settled` is always the last. */
const EVENT_LIMIT = 2_000;

export interface RouterOptions {
  readonly permissions: Permissions;
  readonly runtime: RuntimeLink;
  readonly audit: (entry: AuditEntry) => void;
  readonly log: (line: string) => void;
}

export class Router {
  readonly #options: RouterOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #requests = new Map<string, RequestState>();
  #nextId = 0;
  #serverId: string | undefined;

  constructor(options: RouterOptions) {
    this.#options = options;
  }

  /** The office's id, from the runtime's `welcome`; undefined until the runtime first comes up. */
  get serverId(): string | undefined {
    return this.#serverId;
  }

  /** Handles one validated command from a signed-in client. */
  handle(client: ClientSink, principal: Principal, command: ClientCommand): void {
    const audit = (outcome: string) =>
      this.#options.audit({
        at: new Date().toISOString(),
        principal: principal.id,
        action: command.type,
        ...("agent" in command && typeof command.agent === "string"
          ? { agent: command.agent }
          : {}),
        ...("requestId" in command ? { requestId: command.requestId } : {}),
        outcome,
      });
    const decision = decide(this.#options.permissions, principal, command);
    if (!decision.allowed) {
      audit("forbidden");
      client.send({ type: "error", id: command.id, code: "forbidden", message: decision.reason });
      return;
    }
    const id = `g${++this.#nextId}`;
    // The runtime numbers its own events; the client's `afterSeq` is in gateway numbers and is applied
    // here, so the runtime is asked for everything it has.
    const { afterSeq, ...forwarded } = command as ClientCommand & { afterSeq?: number };
    this.#pending.set(id, {
      client,
      clientId: command.id,
      type: command.type,
      principal: decision.principal,
      ...("requestId" in command ? { requestId: command.requestId } : {}),
      ...(afterSeq === undefined ? {} : { afterSeq }),
    });
    if (!this.#options.runtime.send({ ...forwarded, id, principal: decision.principal })) {
      this.#pending.delete(id);
      audit("busy");
      client.send(busy(command.id, "The office is starting or restarting; try again in a moment."));
      return;
    }
    audit("forwarded");
  }

  /** Takes one frame from the runtime's stdout. */
  onRuntimeFrame(value: unknown): void {
    const checked = validateMessage(value, "server");
    if (!checked.ok) {
      this.#options.log(
        `The runtime sent a message the gateway cannot use: ${JSON.stringify(checked.problems)}`,
      );
      return;
    }
    const message = checked.message;
    switch (message.type) {
      case "welcome":
        this.#serverId = message.serverId;
        return;
      case "event":
        this.#event(message);
        return;
    }
    if (message.id === undefined) {
      if (message.type === "error") {
        this.#options.log(`The runtime reported an error: ${message.code}: ${message.message}`);
      }
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    const { client, clientId } = pending;

    // The gateway's own re-subscribe after a restart failed: its watchers would otherwise wait forever.
    if (clientId === undefined && message.type === "error" && pending.requestId !== undefined) {
      this.#lost(pending.principal, pending.requestId, `${message.code}: ${message.message}`);
      return;
    }

    if (message.type === "accepted") {
      const state = this.#state(message.requestId, pending.principal, pending.requestId);
      if (client === undefined || clientId === undefined || state === undefined) return;
      this.#join(state, client, { ...message, id: clientId, requestId: state.requestId }, 0);
      return;
    }
    if (client === undefined || clientId === undefined) return;
    if (
      message.type === "result" &&
      pending.type === "subscribe" &&
      pending.requestId !== undefined
    ) {
      const key = scopedRequestId(pending.principal, pending.requestId);
      const state = this.#state(key, pending.principal, pending.requestId);
      if (state === undefined) client.send({ ...message, id: clientId });
      else this.#join(state, client, { ...message, id: clientId }, pending.afterSeq ?? 0);
      return;
    }
    client.send({ ...message, id: clientId });
  }

  /** The runtime went down: commands it never answered get `busy`; its event numbers start over. */
  onRuntimeDown(): void {
    for (const pending of this.#pending.values()) {
      if (pending.client === undefined || pending.clientId === undefined) continue;
      pending.client.send(
        busy(
          pending.clientId,
          "The office's runtime restarted before answering; send the command again (repeating a submit with the same requestId is safe).",
        ),
      );
    }
    this.#pending.clear();
    for (const state of this.#requests.values()) state.runtimeSeen = 0;
  }

  /** The runtime is up again: re-subscribe every request still running, so its events keep coming. */
  onRuntimeUp(): void {
    for (const state of this.#requests.values()) {
      if (state.settled) continue;
      const id = `g${++this.#nextId}`;
      this.#pending.set(id, {
        client: undefined,
        clientId: undefined,
        type: "subscribe",
        principal: state.principal,
        requestId: state.requestId,
      });
      this.#options.runtime.send({
        type: "subscribe",
        id,
        requestId: state.requestId,
        principal: state.principal,
      });
    }
  }

  /** A client went away: stop sending to it. */
  disconnect(client: ClientSink): void {
    for (const state of this.#requests.values()) state.subscribers.delete(client);
    for (const pending of this.#pending.values()) {
      if (pending.client === client) pending.client = undefined;
    }
  }

  /** What the gateway knows of a principal's request, for `GET /v1/requests/:id`. */
  snapshot(principal: Principal, requestId: string): RequestSnapshot | undefined {
    const state = this.#requests.get(scopedRequestId(principal, requestId));
    return state === undefined
      ? undefined
      : { requestId: state.requestId, settled: state.settled, events: [...state.events] };
  }

  #lost(principal: Principal, requestId: string, why: string): void {
    const key = scopedRequestId(principal, requestId);
    const state = this.#requests.get(key);
    this.#options.log(`Lost track of ${key} after the runtime restarted (${why}).`);
    if (state === undefined) return;
    this.#requests.delete(key);
    for (const client of state.subscribers) {
      client.send({
        type: "error",
        code: "internal",
        message: `The office lost track of request ${requestId} when its runtime restarted (${why}); subscribe again to check on it.`,
      });
    }
  }

  #state(
    key: string,
    principal: Principal,
    requestId: string | undefined,
  ): RequestState | undefined {
    const known = this.#requests.get(key);
    if (known !== undefined || requestId === undefined) return known;
    const state: RequestState = {
      principal,
      requestId,
      events: [],
      nextSeq: 1,
      settled: false,
      runtimeSeen: 0,
      subscribers: new Set(),
    };
    this.#requests.set(key, state);
    this.#forgetOld();
    return state;
  }

  #event(message: EventMessage): void {
    const state = this.#requests.get(message.requestId);
    if (state === undefined) {
      this.#options.log(`An event arrived for ${message.requestId}, which no client asked about.`);
      return;
    }
    if (message.seq <= state.runtimeSeen) return;
    state.runtimeSeen = message.seq;
    if (message.event.kind === "settled") {
      if (state.settled) return;
      state.settled = true;
    }
    const event: EventMessage = {
      type: "event",
      requestId: state.requestId,
      seq: state.nextSeq++,
      event: message.event,
    };
    state.events.push(event);
    if (state.events.length > EVENT_LIMIT) state.events.shift();
    for (const client of state.subscribers) client.send(event);
  }

  /**
   * Subscribes a client and sends it `reply`, then the request's story so far (a repeated submit gets
   * it too, as a subscribe would). Subscribed first, so a client that leaves on the reply (a one-shot
   * HTTP answer) has already been removed again by the time the replay would reach it.
   */
  #join(state: RequestState, client: ClientSink, reply: ServerMessage, afterSeq: number): void {
    const joined = !state.subscribers.has(client);
    state.subscribers.add(client);
    client.send(reply);
    if (joined && state.subscribers.has(client)) this.#replay(state, client, afterSeq);
  }

  /** Sends a request's events after `afterSeq`, and its `settled` event always. */
  #replay(state: RequestState, client: ClientSink, afterSeq: number): void {
    for (const event of state.events) {
      if (event.seq > afterSeq || event.event.kind === "settled") client.send(event);
    }
  }

  #forgetOld(): void {
    if (this.#requests.size <= REQUEST_LIMIT) return;
    for (const [key, state] of this.#requests) {
      if (this.#requests.size <= REQUEST_LIMIT) return;
      if (state.settled && state.subscribers.size === 0) this.#requests.delete(key);
    }
  }
}

function busy(id: string, message: string): ServerMessage {
  return { type: "error", id, code: "busy", message };
}
