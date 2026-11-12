/**
 * The relay: the office's delivery loop (RASF-3067).
 *
 * The relay turns the board's append-only event log into work done by roles, exactly once each. It
 * polls `eventsAfter(cursor)`, decides where each event goes, wraps it, and delivers it into the
 * accepting role's conversation for that ticket with the event's id as the `requestId`.
 *
 * Why the shape is at-least-once plus a dedupe key, rather than a transactional outbox: Pi Durable
 * already deduplicates a submission by `(conversation, requestId)`, and it returns the original for a
 * repeat. An outbox would reimplement that dedup inside the board's own file, and the two ledgers
 * could disagree — the exact failure the dedup key is there to prevent. So the ledger's job is
 * narrower: remember what was delivered, never let the cursor pass an undelivered event, and make a
 * redelivery harmless.
 *
 * Why one poller and no claim column: Pi Durable has no cross-process locking, and Office Hum already
 * has single-owner through `acquireLock` above `openSolo`. The relay runs inside that one owning
 * process, so there is no second party to claim against. The only re-entry risk — a redelivery after
 * a crash — is made harmless by the `requestId`, not by a lease.
 *
 * What "exactly once" does not mean, learned by killing this process for real (`relay-kill.test.ts`):
 * the delivery row and the submission are exactly once, but a model turn is not. A `SIGKILL` inside
 * the delegate's first turn cannot finish it, so the resumed submission runs that turn again — the
 * same submission id, one ledger row, and two model calls. The guarantee is on the work being
 * admitted and recorded once, never on a turn being immune to re-execution, and nothing downstream
 * may assume a side effect inside a turn is idempotent by itself.
 *
 * Why admitting and settling are separate steps: a delegate's turn may itself dispatch and wait
 * (`agent_dispatch` with `wait: true`), and the child's `created` event is only delivered by this
 * poller. A poller that awaited each turn before reading the next event would wait on a turn that is
 * waiting on it. So a poll admits every event it finds, in order, lets the settlements run side by
 * side, and keeps looking for new events until the last of them is recorded. Two events for one
 * conversation stay in order because Pi Durable queues the second as a follow-up to the first.
 */
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AgentChange,
  type Conversation,
  defineExtension,
  type SettledTask,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { Office } from "../adapter/index.js";
import {
  type Assignee,
  type Board,
  BoardError,
  type Ticket,
  type TicketEvent,
} from "../board/index.js";
import type { DeliveryRecord } from "../board/relay-ledger.js";
import type {
  DeliveryGuards,
  GuardContext,
  GuardDecision,
  GuardEvent,
  GuardTicket,
} from "./guards.js";
import { type RelayMessage, type RelayProvenance, relayMessage } from "./message.js";
import type {
  DeliveryHandle,
  DeliveryOutcome,
  DeliveryTarget,
  RelayTransport,
} from "./transport.js";
import { createWaitTask, type WaitTaskResult } from "./wait-task.js";

/**
 * How often a poll that is waiting on settlements looks at the board for new events, in wall-clock
 * milliseconds. The board has no notification, and the event a running turn is waiting for (its
 * child's `created`) can only be found by looking.
 */
const ADMIT_POLL_MS = 25;

/** The name of the extension the relay installs. Installing it is what registers the wait task. */
export const RELAY_EXTENSION_NAME = "officehum.relay";

/** One role, as the relay routes to it. `roleKey` is the role's stable install name. */
export interface RelayRole {
  readonly roleKey: string;
  /** The role's conversation settings. Every ticket it takes gets its own conversation under these. */
  readonly agent: AgentChange;
  /** The ticket types this role accepts, straight from its validated manifest. */
  readonly accepts: readonly string[];
}

export type DispatchRequest = {
  readonly title: string;
  readonly detail?: string;
  readonly payload?: unknown;
  readonly createdBy: string;
  readonly provenance: RelayProvenance;
  /**
   * Deduplication key for the create. Defaults to a fresh key, so a caller that wants a repeat of the
   * same dispatch to return the same ticket passes one.
   */
  readonly callerKey?: string;
};

export type RelayOptions = {
  readonly office: Office;
  readonly board: Board;
  readonly transport: RelayTransport;
  /** The office's roles. Their `accepts` is what the routing table is built from. */
  readonly routing: readonly RelayRole[];
  readonly guards: DeliveryGuards;
  /** Wall-clock milliseconds. Injected so a test can pin the ledger's timestamps. */
  readonly now: () => number;
};

export interface Relay {
  /**
   * Deliver every event after the cursor once, and resolve when each delivery has settled. Events that
   * appear while those turns run (a turn dispatching to a colleague) are delivered by the same call.
   * Idempotent: a second call with no new events does nothing. One call at a time: the relay is the
   * office's single poller.
   */
  pollOnce(): Promise<void>;
  /**
   * Re-admit every delivery a crash left non-terminal, then settle them as `pollOnce` does. A row
   * Pi Durable never admitted passes the guards again first, and is refused if they now say no.
   */
  recover(): Promise<void>;
  /** Post work of one type onto the board; the next poll routes and delivers it. */
  dispatch(type: string, request: DispatchRequest): Promise<Ticket>;
  /** Block until the ticket is terminal, and report the delegate's answer. */
  wait(ticketId: string, options?: { readonly timeoutMs?: number }): Promise<WaitTaskResult>;
}

/** A delivery decision: what to do with one event, before anything durable happens. */
type Decision =
  | { readonly kind: "input"; readonly roleKey: string; readonly note?: string }
  | { readonly kind: "settle" }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "handToPerson"; readonly personId: string }
  | { readonly kind: "stalled"; readonly reason: string };

/** The routing table, built once from the roles' manifests. */
interface RoutingTable {
  readonly roleFor: (type: string) => string | undefined;
  readonly triageRoleKey: () => string | undefined;
  readonly role: (roleKey: string) => RelayRole | undefined;
}

const ROLE_KEY = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Build `type → roleKey` from the roles' `accepts`.
 *
 * Two roles accepting one type is refused, not resolved by install order. Delivering one ticket to
 * two agents is the failure the relay exists to prevent, and first-wins would make that depend on
 * something nobody reading the manifests can see. Failing closed at construction means the mistake is
 * found at startup rather than in a customer's ticket.
 */
export function buildRouting(roles: readonly RelayRole[]): RoutingTable {
  const byType = new Map<string, string>();
  const byKey = new Map<string, RelayRole>();
  for (const role of roles) {
    if (!ROLE_KEY.test(role.roleKey)) {
      throw new Error(`Relay role key ${role.roleKey} is not a kebab-case role name.`);
    }
    if (byKey.has(role.roleKey)) {
      throw new Error(`Two relay roles share the key ${role.roleKey}.`);
    }
    byKey.set(role.roleKey, role);
    for (const type of role.accepts) {
      const existing = byType.get(type);
      if (existing !== undefined && existing !== role.roleKey) {
        throw new Error(
          `Roles ${existing} and ${role.roleKey} both accept ticket type ${type}. ` +
            "Routing refuses to pick one by install order: remove the accept from one of them.",
        );
      }
      byType.set(type, role.roleKey);
    }
  }
  const triage = roles.find((role) => role.accepts.some((type) => type.startsWith("triage.")));
  return {
    roleFor: (type) => byType.get(type),
    triageRoleKey: () => triage?.roleKey,
    role: (roleKey) => byKey.get(roleKey),
  };
}

/** The conversation one role keeps for one ticket: a pure function of role and ticket. */
export function relayTicketKey(roleKey: string, ticketId: string): string {
  return `relay.role.${roleKey}.ticket.${ticketId}`;
}

/** The role's shared conversation. Reserved for role-scoped work (RASF-3109); no delivery uses it. */
export function relayRoleRootKey(roleKey: string): string {
  return `relay.role.${roleKey}.root`;
}

/** The stand-in conversation a wait uses when no role owns the ticket. */
export function relayWaitKey(ticketId: string): string {
  return `relay.ticket.${ticketId}`;
}

/** The role key inside a ticket conversation key, or `undefined` for any other key. */
function roleKeyOfConversationKey(key: string): string | undefined {
  const match = /^relay\.role\.([^.]+)\.ticket\./.exec(key);
  return match?.[1];
}

/** Hop depth of a ticket: 0 for a root, one per parent above it. Bounded so a cycle cannot hang. */
function hopOf(board: Board, ticket: Ticket): number {
  let depth = 0;
  let parentId = ticket.parentId;
  while (parentId !== null && depth < 64) {
    const parent = board.get(parentId);
    if (parent === undefined) break;
    depth += 1;
    parentId = parent.parentId;
  }
  return depth;
}

/** The assignee id when it names an agent (anything not in `people`), else `undefined`. */
function agentAssignee(board: Board, ticket: Ticket): string | undefined {
  if (ticket.assignee === null) return undefined;
  const people = board.people();
  return people.some((person) => person.id === ticket.assignee) ? undefined : ticket.assignee;
}

function settled(state: DeliveryOutcome): {
  readonly state: "settled" | "failed" | "skipped";
  readonly outcome: string | null;
} {
  if (state.status === "done") {
    return { state: "settled", outcome: state.answer ?? null };
  }
  if (state.status === "unanswered") return { state: "failed", outcome: state.reason };
  return { state: "skipped", outcome: null };
}

/** The settled result a terminal wait leaves behind, whichever way it settled. */
function waitResult(settled: SettledTask<WaitTaskResult>): WaitTaskResult {
  const outcome = settled.state.outcome;
  switch (outcome.status) {
    case "completed":
      return outcome.result;
    case "aborted":
      return outcome.result ?? { ok: false, reason: "cancelled" };
    case "failed":
      return outcome.result ?? { ok: false, reason: "timeout" };
    default:
      // `orphaned` or `faulted`: the wait could not be run at all. Reporting it as a timeout is the
      // honest thing a caller can act on — it did not get an answer.
      return { ok: false, reason: "timeout" };
  }
}

export function createRelay(options: RelayOptions): Relay {
  const { office, board, transport, guards, now } = options;
  const routing = buildRouting(options.routing);

  // The wait task closes over this relay's board and is installed here, so a caller cannot forget to
  // register it and end up with a wait that is admitted and never runs.
  const waitTask = createWaitTask({ board });
  office.install({
    extensions: [defineExtension({ name: RELAY_EXTENSION_NAME, tasks: [waitTask] })],
    agent: {},
  });

  const conversationCache = new Map<string, Promise<Conversation>>();

  /** Resolve-or-create a conversation by key under one role's agent settings (idempotent by name). */
  const conversationFor = (key: string): Promise<Conversation> => {
    const known = conversationCache.get(key);
    if (known !== undefined) return known;
    const roleKey = roleKeyOfConversationKey(key);
    const agent = roleKey === undefined ? {} : (routing.role(roleKey)?.agent ?? {});
    const pending = office.conversation(key, { agent });
    // A failed open is not cached, so the next delivery tries again (as the runtime does).
    pending.catch(() => conversationCache.delete(key));
    conversationCache.set(key, pending);
    return pending;
  };

  /** The conversation a wait's task lives in: the ticket's fork for whoever owns it. */
  const waitConversationKey = (ticket: Ticket): string => {
    const delivered = board.relay
      .deliveriesForTicket(ticket.id)
      .find((delivery) => delivery.targetKey !== "");
    if (delivered !== undefined) return delivered.targetKey;
    const roleKey = routing.roleFor(ticket.type) ?? routing.triageRoleKey();
    return roleKey === undefined ? relayWaitKey(ticket.id) : relayTicketKey(roleKey, ticket.id);
  };

  /**
   * Decide what one event is for. The whitelist is here, and it is deliberately explicit.
   *
   * `completed` and `cancelled` settle a wait and are NOT submitted as input. This is a deliberate
   * divergence from the issue, which lists `completed` among the delivered kinds. Pi Durable's
   * `submit` hardcodes `type: "input"`, so delivering `completed` would start a fresh model turn in
   * the delegator *and* return the same result through its wait: the delegate's answer would arrive
   * twice, once as a prompt and once as a result. The wait's return value is how the delegator learns
   * the outcome, so `completed` is consumed by the ledger (a `settled` row, exactly once) and the
   * task, not re-submitted. "Delivers the completed event" is satisfied by that consumption.
   */
  const decide = (event: TicketEvent, ticket: Ticket): Decision => {
    switch (event.kind) {
      case "created":
        // A ticket that was created already assigned to a person is theirs from its first event.
        // Delivering the creation to an agent as well would put the same work in two places, and for
        // a callback ticket it would hand the desk the customer text it is not allowed to answer.
        if (ticket.assignee !== null && board.people().some(({ id }) => id === ticket.assignee)) {
          return { kind: "skipped", reason: "assigned to a person, who is outside the harness" };
        }
        return routeTicket(ticket);
      case "assigned": {
        const assignee = assigneeOfEvent(event);
        if (assignee === undefined || assignee.kind !== "agent") {
          return { kind: "skipped", reason: "assigned to a person, who is outside the harness" };
        }
        return routeTicket(ticket, assignee.id);
      }
      case "commented": {
        const assignee = agentAssignee(board, ticket);
        if (assignee === undefined) {
          return { kind: "skipped", reason: "comment on a ticket with no agent assignee" };
        }
        if (event.actor !== null && event.actor === assignee) {
          return { kind: "skipped", reason: "self-comment by the assignee" };
        }
        return routeTicket(ticket, assignee);
      }
      case "completed":
      case "cancelled":
        // Settle-only: see the whitelist note above.
        return { kind: "settle" };
      case "claimed":
        // The actor's own turn is already the agent's context; echoing it back would be a loop.
        return { kind: "skipped", reason: "claim by the assignee" };
      case "stalled":
        return { kind: "skipped", reason: "a stalled event is an explanation, not work" };
      case "blocked":
        return {
          kind: "skipped",
          reason: "the ticket is blocked and with a person, so nothing is delivered to an agent",
        };
      default:
        return { kind: "skipped", reason: `event kind ${event.kind} is not delivered` };
    }
  };

  /**
   * Where a ticket goes: the role that accepts its type, or the assignee's own role when they name
   * one, then the same unknown-type fallback in both cases. The fallback is shared so an `assigned`
   * or `commented` event on a type nobody accepts surfaces the same way a `created` one does, rather
   * than throwing out of the poll loop and stopping every later event behind it.
   */
  const routeTicket = (ticket: Ticket, preferredRoleKey?: string): Decision => {
    const preferred =
      preferredRoleKey === undefined ? undefined : routing.role(preferredRoleKey)?.roleKey;
    const roleKey = preferred ?? routing.roleFor(ticket.type);
    if (roleKey !== undefined) return { kind: "input", roleKey };
    const triage = routing.triageRoleKey();
    if (triage !== undefined) {
      return {
        kind: "input",
        roleKey: triage,
        note: `No role accepts ticket type ${ticket.type}; it reached triage as an unknown type.`,
      };
    }
    const person = board.people()[0];
    return person === undefined
      ? {
          kind: "stalled",
          reason: `No role accepts ticket type ${ticket.type} and no person is on the board.`,
        }
      : { kind: "handToPerson", personId: person.id };
  };

  /** Run the three guards for one delivery; any refusal or throw refuses closed. */
  const runGuards = async (
    event: TicketEvent,
    ticket: Ticket,
    context: GuardContext,
  ): Promise<GuardDecision> => {
    const guardEvent: GuardEvent = { id: event.id, kind: event.kind, ticketId: ticket.id };
    const guardTicket: GuardTicket = {
      id: ticket.id,
      type: ticket.type,
      status: ticket.status,
      assignee: ticket.assignee,
    };
    for (const check of [guards.checkBudget, guards.checkHops, guards.checkApproval]) {
      let decision: GuardDecision;
      try {
        decision = await check(guardEvent, guardTicket, context);
      } catch (error) {
        return {
          allowed: false,
          reason: `guard threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!decision.allowed) return decision;
    }
    return { allowed: true };
  };

  const messageFor = (
    event: TicketEvent,
    ticket: Ticket,
    note: string | undefined,
  ): RelayMessage => {
    const provenance = board.provenance(ticket.id);
    if (provenance === undefined) {
      throw new Error(
        `Ticket ${ticket.id} has no provenance row, so its message cannot be wrapped.`,
      );
    }
    return relayMessage(
      { id: event.id, kind: event.kind, ticketId: ticket.id },
      {
        id: ticket.id,
        type: ticket.type,
        title: ticket.title,
        detail: ticket.detail,
        payload: ticket.payload,
      },
      provenance,
      hopOf(board, ticket),
      note,
    );
  };

  /** Record a terminal row and move the cursor, atomically, for an event that is never submitted. */
  const recordWithoutDelivery = (
    event: TicketEvent,
    state: "settled" | "skipped" | "failed",
    reason: string | null,
  ): void => {
    board.relay.begin({
      eventId: event.id,
      seq: event.seq,
      ticketId: event.ticketId,
      kind: event.kind,
      targetKey: "",
      state: "skipped",
      at: new Date(now()).toISOString(),
    });
    if (state !== "skipped") board.relay.settle(event.id, state, reason);
  };

  /**
   * The conversation a delivery goes to, bound to its ticket. The binding is what the mid-turn hooks
   * need: they see a conversation id and nothing else, and it is resolved here, by the party that
   * knows both ids. It is written before the delivery so a turn that starts immediately already has a
   * ticket to charge, and writing it again for a recovered delivery is idempotent.
   */
  const targetFor = async (
    eventId: string,
    ticketId: string,
    key: string,
  ): Promise<DeliveryTarget> => {
    const conversation = await conversationFor(key);
    const roleKey = roleKeyOfConversationKey(key);
    if (roleKey !== undefined) {
      board.bindConversation(conversation.id, { ticketId, agent: roleKey });
    }
    return { requestId: eventId, conversationKey: key, conversation };
  };

  /**
   * Admit one delivery whose `pending` row already exists: wrap, run the guards, submit, record the
   * admission. Fresh deliveries and recovered ones both come through here, so neither can reach
   * `submit` unwrapped or unguarded. Returns the admitted handle, or `undefined` when the row was made
   * terminal instead.
   */
  const admit = async (
    event: TicketEvent,
    ticket: Ticket,
    key: string,
    note: string | undefined,
  ): Promise<DeliveryHandle | undefined> => {
    // The wrap happens before the guards and the transport. A ticket with no provenance row is
    // unwrappable, which is an invariant violation rather than a crash: it is recorded `failed` so
    // the row is terminal and `recover` does not retry a delivery that can never be built.
    let message: RelayMessage;
    try {
      message = messageFor(event, ticket, note);
    } catch (error) {
      board.relay.settle(
        event.id,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    }

    const decision = await runGuards(event, ticket, {
      hop: hopOf(board, ticket),
      conversationKey: key,
    });
    if (!decision.allowed) {
      // A refused delivery is a stopped chain, and a stopped chain is a person's problem. The guard
      // has already blocked the ticket when the refusal is exhaustion; the `stalled` event is what
      // tells a reader of the board that this delivery was the one turned away, and it is why a
      // refusal is not just a `failed` row in a ledger nobody reads.
      board.stall(ticket.id, "relay", decision.reason);
      board.relay.settle(event.id, "failed", decision.reason);
      return undefined;
    }

    const handle = await transport.deliver(await targetFor(event.id, ticket.id, key), message);
    board.relay.admitted(event.id, handle.id);
    return handle;
  };

  /** Await one admitted delivery and record how it ended. */
  const settleDelivery = async (eventId: string, handle: DeliveryHandle): Promise<void> => {
    const { state, outcome } = settled(await handle.wait());
    board.relay.settle(eventId, state, outcome);
  };

  /** Hand the ticket to a person: the board's own move, then a `skipped` row and a moved cursor. */
  const handToPerson = (event: TicketEvent, ticket: Ticket, personId: string): void => {
    const assignee: Assignee = { kind: "person", id: personId };
    try {
      board.assign(ticket.id, assignee, event.actor ?? "relay");
    } catch (error) {
      // A ticket that already moved on (closed before the relay got to it) is not a failure: the row
      // records the attempt either way. Anything else is a real fault, and it propagates before the
      // row is written, so the cursor stays behind the event and the hand-off is tried again.
      if (!(error instanceof BoardError && error.kind === "invalid_status")) throw error;
    }
    recordWithoutDelivery(event, "skipped", null);
  };

  /**
   * Account for one event: a terminal row for anything that is not delivered, or a `pending` row and
   * an admission for work that goes to a role. Returns the handle of a delivery that is now running.
   */
  const admitEvent = async (event: TicketEvent): Promise<DeliveryHandle | undefined> => {
    const ticket = board.get(event.ticketId);
    if (ticket === undefined) {
      recordWithoutDelivery(event, "skipped", null);
      return undefined;
    }
    const decision = decide(event, ticket);
    switch (decision.kind) {
      case "settle":
        recordWithoutDelivery(event, "settled", null);
        return undefined;
      case "skipped":
        recordWithoutDelivery(event, "skipped", null);
        return undefined;
      case "stalled":
        // A stalled route is its own board event (the surfaced gap) plus a terminal `failed` row, so
        // recovery never retries a route that cannot work and a reader of the board sees why.
        board.stall(ticket.id, "relay", decision.reason);
        recordWithoutDelivery(event, "failed", decision.reason);
        return undefined;
      case "handToPerson":
        handToPerson(event, ticket, decision.personId);
        return undefined;
      default: {
        const key = relayTicketKey(decision.roleKey, ticket.id);
        // The ledger row and the cursor move together, before anything is submitted. If the relay
        // dies after this point, the row is still `pending` and `recover` admits the same requestId.
        board.relay.begin({
          eventId: event.id,
          seq: event.seq,
          ticketId: ticket.id,
          kind: event.kind,
          targetKey: key,
          state: "pending",
          at: new Date(now()).toISOString(),
        });
        return await admit(event, ticket, key, decision.note);
      }
    }
  };

  /**
   * Pick one non-terminal row back up after a restart.
   *
   * A submission Pi Durable already holds is reacquired as it is: its guards passed before the crash
   * and its turn is running (or done) whatever this relay decides, so the row follows it. That
   * includes a `pending` row, when the crash fell between the submission and the note of it. A row
   * with no submission was never delivered, so it is a fresh delivery and takes the same path as one,
   * guards included: the budget may have run out, or the chain been stopped, while the office was down.
   */
  const readmit = async (row: DeliveryRecord): Promise<DeliveryHandle | undefined> => {
    if (row.targetKey === "") {
      board.relay.settle(row.eventId, "failed", "a pending delivery with no target");
      return undefined;
    }
    const ticket = board.get(row.ticketId);
    if (ticket === undefined) {
      board.relay.settle(row.eventId, "failed", "the ticket is gone");
      return undefined;
    }
    const existing = await transport.reacquire(
      await targetFor(row.eventId, row.ticketId, row.targetKey),
    );
    if (existing !== undefined) {
      if (row.submissionId === null) board.relay.admitted(row.eventId, existing.id);
      return existing;
    }
    const event: TicketEvent = {
      id: row.eventId,
      seq: row.seq,
      ticketId: row.ticketId,
      kind: row.kind,
      actor: null,
      payload: {},
      at: row.at,
    };
    return await admit(event, ticket, row.targetKey, undefined);
  };

  /**
   * Settle `admitted`, and keep admitting whatever reaches the board meanwhile, until nothing is left
   * running. The first failure — a transport that threw, which is what a crash looks like from here —
   * rejects the call and leaves its row non-terminal for `recover`.
   */
  const drain = async (
    admitted: readonly { readonly eventId: string; readonly handle: DeliveryHandle }[],
  ): Promise<void> => {
    const settling = new Set<Promise<void>>();
    const failures: unknown[] = [];
    const settleLater = (eventId: string, handle: DeliveryHandle): void => {
      const settlement = settleDelivery(eventId, handle)
        .catch((error: unknown) => {
          failures.push(error);
        })
        .finally(() => settling.delete(settlement));
      settling.add(settlement);
    };
    for (const { eventId, handle } of admitted) settleLater(eventId, handle);

    for (;;) {
      if (failures.length > 0) throw failures[0];
      for (const event of board.eventsAfter(board.relay.cursor())) {
        const handle = await admitEvent(event);
        if (handle !== undefined) settleLater(event.id, handle);
      }
      if (settling.size === 0) {
        if (failures.length > 0) throw failures[0];
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      const tick = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ADMIT_POLL_MS);
      });
      await Promise.race([...settling, tick]);
      clearTimeout(timer);
    }
  };

  return {
    async pollOnce() {
      await drain([]);
    },
    async recover() {
      const admitted: { eventId: string; handle: DeliveryHandle }[] = [];
      for (const row of board.relay.openDeliveries()) {
        const handle = await readmit(row);
        if (handle !== undefined) admitted.push({ eventId: row.eventId, handle });
      }
      await drain(admitted);
    },
    async dispatch(type, request) {
      // A fresh caller key per dispatch, so two dispatches of the same type are two tickets; a caller
      // that wants a repeat of one to return the same ticket passes its own key.
      const callerKey = request.callerKey ?? `relay/${randomUUID()}`;
      return board.create(
        {
          type,
          title: request.title,
          createdBy: request.createdBy,
          provenance: request.provenance,
          ...(request.detail === undefined ? {} : { detail: request.detail }),
          ...(request.payload === undefined ? {} : { payload: request.payload }),
        },
        callerKey,
      );
    },
    async wait(ticketId, waitOptions) {
      const ticket = board.get(ticketId);
      if (ticket === undefined) throw new Error(`No ticket ${ticketId} to wait on.`);
      const known = board.relay.wait(ticketId);
      const taskId =
        known?.taskId ??
        (await (async () => {
          const conversation = await conversationFor(waitConversationKey(ticket));
          const timeoutMs = waitOptions?.timeoutMs;
          const deadlineMs = timeoutMs === undefined ? null : now() + timeoutMs;
          const created = await conversation.commit(
            (transaction) =>
              transaction.createTask(
                waitTask,
                { ticketId, deadlineMs },
                { ownership: { kind: "conversation" } },
              ),
            BACKGROUND_CONTEXT,
          );
          board.relay.recordWait({
            ticketId,
            taskId: created,
            conversationId: conversation.id,
            deadlineMs,
          });
          return created;
        })());
      const settledTask = await office.harness.waitForTask(
        taskId as TaskId<WaitTaskResult>,
        BACKGROUND_CONTEXT,
      );
      // The record exists so a restart finds the same running task. Once the task has answered —
      // with a result or a timeout — keeping it would hand that old answer to every later wait on
      // the ticket. A newer wait's record is left alone.
      if (board.relay.wait(ticketId)?.taskId === taskId) board.relay.clearWait(ticketId);
      return waitResult(settledTask);
    },
  };
}

/** The `assignee` an `assigned` event carries, if it carries one. */
function assigneeOfEvent(event: TicketEvent): Assignee | undefined {
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const assignee = (payload as { assignee?: unknown }).assignee;
  if (assignee === null || typeof assignee !== "object" || Array.isArray(assignee))
    return undefined;
  const record = assignee as { kind?: unknown; id?: unknown };
  if ((record.kind !== "agent" && record.kind !== "person") || typeof record.id !== "string") {
    return undefined;
  }
  return { kind: record.kind, id: record.id };
}
