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
 * forwards `settled` once. After a restart it re-subscribes every unsettled request it knows. A
 * settled request is kept for a while, so a retry or a late subscribe is answered with the same
 * numbers, and then forgotten, whoever is still connected.
 *
 * Approvals (RASF-3108): the runtime announces each approval asked for or decided as an `approval`
 * message. The router keeps them, with the agent each belongs to, and sends each to the connections
 * watching approvals (`watch_approvals`) whose principal may approve for that agent. An `approve`
 * names only the approval, so the router looks its agent up to check the rule before forwarding.
 */

import {
  type ApprovalInfo,
  type ClientCommand,
  type EventMessage,
  type Principal,
  replyId,
  type ServerMessage,
  scopedRequestId,
  validateMessage,
} from "@officehum/protocol";
import type { Permissions } from "./config.js";
import { covers, decide, mayApprove } from "./permissions.js";

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
  readonly approvalId?: string;
  readonly outcome: string;
}

/** A request the gateway knows, as `GET /v1/requests/:id` reports it. */
export interface RequestSnapshot {
  readonly requestId: string;
  readonly settled: boolean;
  /** The events still kept, the latest up to the per-request limit. */
  readonly events: readonly EventMessage[];
  /** Every event the request has had, kept or not. */
  readonly eventCount: number;
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

/**
 * How long a settled request is kept for replay. After it, asking about the request again gets the
 * runtime's own story of it, numbered from 1.
 */
const REPLAY_WINDOW_MS = 5 * 60_000;

/** Settled requests kept at most, whatever their age: the oldest settled go first. */
const SETTLED_LIMIT = 1_000;

/** Events kept per request for replay; older ones are let go, and `settled` is always the last. */
const EVENT_LIMIT = 2_000;

/** Decided approvals kept (to answer a late decision with `conflict`); pending ones are all kept. */
const DECIDED_APPROVAL_LIMIT = 1_000;

/** Who the gateway's own commands act as, for the ones that need a principal but no permission. */
const GATEWAY_PRINCIPAL: Principal = { id: "gateway", roles: [] };

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
  /** When each settled request still kept settled, by its key in `#requests`, oldest first. */
  readonly #settledAt = new Map<string, number>();
  /** Approvals the runtime announced, by id: pending ones, and the latest decided. */
  readonly #approvals = new Map<string, ApprovalInfo>();
  /** Connections watching approvals, with who signed them in. */
  readonly #watchers = new Map<ClientSink, Principal>();
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
    const approval =
      command.type === "approve" ? this.#approvals.get(command.approvalId) : undefined;
    const agent =
      "agent" in command && typeof command.agent === "string" ? command.agent : approval?.agent;
    const audit = (outcome: string) =>
      this.#options.audit({
        at: new Date().toISOString(),
        principal: principal.id,
        action: command.type,
        ...(agent === undefined ? {} : { agent }),
        ...("requestId" in command ? { requestId: command.requestId } : {}),
        ...(command.type === "approve" ? { approvalId: command.approvalId } : {}),
        outcome,
      });
    if (command.type === "approve" && approval === undefined) {
      // Someone with no approve rule at all learns nothing about which approvals exist.
      if (!this.#options.permissions.approve.some((rule) => covers(rule.roles, principal))) {
        audit("forbidden");
        client.send({
          type: "error",
          id: command.id,
          code: "forbidden",
          message: "You may not approve actions.",
        });
        return;
      }
      audit("not_found");
      client.send({
        type: "error",
        id: command.id,
        code: "not_found",
        message: `No approval ${command.approvalId} is known to this office.`,
      });
      return;
    }
    const decision = decide(this.#options.permissions, principal, command, approval?.agent);
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
      this.#unusableReply(replyId(value));
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
      case "approval":
        this.#approval(message.approval);
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
    if (message.type === "result" && pending.type === "watch_approvals") {
      const listed = (message.data as { approvals?: ApprovalInfo[] } | undefined)?.approvals ?? [];
      for (const approval of listed) this.#remember(approval);
      if (client === undefined || clientId === undefined) return;
      this.#watchers.set(client, pending.principal);
      const allowed = listed.filter((approval) =>
        mayApprove(this.#options.permissions, pending.principal, approval.agent),
      );
      client.send({ ...message, id: clientId, data: { approvals: allowed } });
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

  /**
   * A reply the gateway could not use still answers its command: the client hears `internal` instead
   * of waiting for good.
   */
  #unusableReply(id: string | undefined): void {
    const pending = id === undefined ? undefined : this.#pending.get(id);
    if (id === undefined || pending === undefined) return;
    this.#pending.delete(id);
    const why = "the runtime answered with a message the gateway cannot use";
    if (pending.clientId === undefined) {
      if (pending.requestId !== undefined) this.#lost(pending.principal, pending.requestId, why);
      return;
    }
    pending.client?.send({
      type: "error",
      id: pending.clientId,
      code: "internal",
      message: `The office could not answer: ${why}. Repeating a submit with the same requestId is safe; if this keeps happening, the gateway's log says what was wrong with the message.`,
    });
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

  /**
   * The runtime is up again: learn the approvals still waiting (a gateway that just started knows
   * none), and re-subscribe every request still running, so its events keep coming.
   */
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
    const watch = `g${++this.#nextId}`;
    this.#pending.set(watch, {
      client: undefined,
      clientId: undefined,
      type: "watch_approvals",
      principal: GATEWAY_PRINCIPAL,
    });
    this.#options.runtime.send({
      type: "watch_approvals",
      id: watch,
      principal: GATEWAY_PRINCIPAL,
    });
  }

  /** A client went away: stop sending to it. */
  disconnect(client: ClientSink): void {
    this.#watchers.delete(client);
    for (const state of this.#requests.values()) state.subscribers.delete(client);
    for (const pending of this.#pending.values()) {
      if (pending.client === client) pending.client = undefined;
    }
  }

  /** What the gateway knows of a principal's request, for `GET /v1/requests/:id`. */
  snapshot(principal: Principal, requestId: string): RequestSnapshot | undefined {
    this.#forgetSettled();
    const state = this.#requests.get(scopedRequestId(principal, requestId));
    return state === undefined
      ? undefined
      : {
          requestId: state.requestId,
          settled: state.settled,
          events: [...state.events],
          eventCount: state.nextSeq - 1,
        };
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
    this.#forgetSettled();
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
      this.#settledAt.set(message.requestId, Date.now());
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
    if (state.settled) this.#forgetSettled();
  }

  /**
   * Subscribes a client and sends it `reply`, then the request's story so far (a repeated submit gets
   * it too, as a subscribe would). Subscribed first, so a client that leaves on the reply (a one-shot
   * HTTP answer) has already been removed again by the time the replay would reach it. A client that
   * was already watching has had every event on this connection, but asking again still gets it the
   * settled result: a retried submit must always end with the answer.
   */
  #join(state: RequestState, client: ClientSink, reply: ServerMessage, afterSeq: number): void {
    const joined = !state.subscribers.has(client);
    state.subscribers.add(client);
    client.send(reply);
    if (!state.subscribers.has(client)) return;
    if (joined) this.#replay(state, client, afterSeq);
    else this.#replay(state, client, Number.POSITIVE_INFINITY);
  }

  /** Sends a request's events after `afterSeq`, and its `settled` event always. */
  #replay(state: RequestState, client: ClientSink, afterSeq: number): void {
    for (const event of state.events) {
      if (event.seq > afterSeq || event.event.kind === "settled") client.send(event);
    }
  }

  /** An approval asked for or decided: kept, and sent to each watcher who may decide it. */
  #approval(approval: ApprovalInfo): void {
    this.#remember(approval);
    for (const [client, principal] of this.#watchers) {
      if (mayApprove(this.#options.permissions, principal, approval.agent)) {
        client.send({ type: "approval", approval });
      }
    }
  }

  #remember(approval: ApprovalInfo): void {
    // Re-inserted, so the map's order is oldest change first and the oldest decided go first.
    this.#approvals.delete(approval.approvalId);
    this.#approvals.set(approval.approvalId, approval);
    let decided = [...this.#approvals.values()].filter(
      (known) => known.status !== "pending",
    ).length;
    for (const [id, known] of this.#approvals) {
      if (decided <= DECIDED_APPROVAL_LIMIT) break;
      if (known.status === "pending") continue;
      this.#approvals.delete(id);
      decided--;
    }
  }

  /**
   * Lets go of settled requests whose replay window has closed, and of the oldest settled beyond the
   * limit. A subscriber does not keep one: it has had `settled`, and a WebSocket open for days would
   * otherwise keep every request it ever made. Requests still running are kept until they settle.
   */
  #forgetSettled(): void {
    const closed = Date.now() - REPLAY_WINDOW_MS;
    for (const [key, at] of this.#settledAt) {
      if (at > closed && this.#settledAt.size <= SETTLED_LIMIT) return;
      this.#settledAt.delete(key);
      this.#requests.delete(key);
    }
  }
}

function busy(id: string, message: string): ServerMessage {
  return { type: "error", id, code: "busy", message };
}
