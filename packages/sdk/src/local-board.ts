/**
 * The local board (RASF-3112): the office's `agent_dispatch`, `agent_inbox` and `agent_reply`, for
 * roles on someone's own Pi Durable harness, without Office Hum.
 *
 * Install one `localBoardExtension` per role, next to that role's own extension. The tools are built
 * from the same definitions the office extension uses (`./communication.ts`), so a role sees the same
 * names, parameters, replay policies and answers either way.
 *
 * - **Tickets** live in a session document in the same harness (`LOCAL_BOARD_DOC`), so they are
 *   durable and commit atomically with the run.
 * - **Routing** is by ticket type, read from the manifests' `accepts`, never by role name.
 * - **Delivery.** A dispatch commits the ticket, then submits it into the assignee's conversation
 *   through the tool's own API, with `requestId` set to the ticket id, so a retry never delivers
 *   twice. The harness's owner creates one conversation per role, with that role's agent, and names
 *   them in `conversationOf`: a tool cannot create a conversation for another agent. A dispatch that
 *   stopped between committing and submitting is delivered by the next dispatch from any role.
 * - **Waiting.** `wait: true` waits for the assignee's turn on the ticket to settle, then returns the
 *   result it replied with.
 * - **Inbox.** A role's inbox lists what it holds and what is routed to it that nobody has taken,
 *   plus the tickets it opened with their results.
 *
 * Exactly once within the harness, with one gap: `agent_dispatch` is not safe to rerun, so a crash
 * between committing a ticket and submitting it leaves the ticket for the next dispatch to deliver;
 * if the model dispatches the same work again after the crash, it is delivered twice.
 *
 * Budgets, hop limits, provenance, person routes and approvals are Office Hum's, and are not here.
 * One conversation per role means a role waiting on a colleague that in turn waits on it deadlocks
 * until `waitTimeoutMs`: wait in one direction only.
 */

import {
  type ConversationId,
  defineDoc,
  defineExtension,
  defineTool,
  type Extension,
  type JsonObject,
  section,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import {
  AGENT_DISPATCH,
  AGENT_INBOX,
  AGENT_REPLY,
  communicationError,
  dispatchedText,
  dispatchTargets,
  emptyInboxText,
  inboxLine,
  noAnswerText,
  noTicketText,
  notCompletedText,
  refusalText,
  repliedText,
  teamText,
  ticketMessage,
  unknownTypeText,
} from "./communication.js";
import type { AgentManifest } from "./manifest.js";

/** Any JSON value, as Pi Durable documents hold them. */
type JsonValue = JsonObject[string];

/** One ticket on the local board. */
export type LocalTicket = {
  id: string;
  type: string;
  title: string;
  detail: string;
  payload: JsonValue;
  /** The role that dispatched it. */
  createdBy: string;
  /** The role the ticket is routed to. */
  target: string;
  /** Who holds it: `null` until the target takes it. */
  assignee: string | null;
  status: "open" | "claimed" | "done";
  result: string | null;
  createdAt: string;
  updatedAt: string;
  /** Whether it was submitted into the target's conversation. */
  delivered: boolean;
};

type LocalBoard = {
  tickets: Record<string, LocalTicket>;
  /** Tool call identity → the ticket it created, and the request it was made with. */
  callers: Record<string, { ticketId: string; request: string }>;
  next: number;
};

/** The local board's tickets, a session document of the harness it runs in. */
const emptyBoard = (): LocalBoard => ({ tickets: {}, callers: {}, next: 1 });

export const LOCAL_BOARD_DOC = defineDoc<LocalBoard>({
  kind: "officehum.local-board",
  version: 1,
  scope: "session",
  initial: emptyBoard,
});

export interface LocalBoardOptions {
  /** Every role on this harness that may take tickets, as their manifests. */
  readonly manifests: readonly AgentManifest[];
  /** This agent: its manifest id, the `createdBy` of what it dispatches and the assignee it replies as. */
  readonly role: string;
  /**
   * The conversation a role's tickets are delivered into, which you create with that role's agent.
   * Read at delivery time, so it can be filled in after the extensions exist.
   */
  readonly conversationOf: (roleId: string) => ConversationId | undefined;
  /** The installed extension name. Default `local-board.<role>`, so co-hosted roles never clash. */
  readonly name?: string;
  /** How long `wait: true` waits, in milliseconds. Omitted: until the assignee's turn settles. */
  readonly waitTimeoutMs?: number;
}

type Context = Parameters<ToolExecutionApi["commit"]>[1];

export function localBoardExtension(options: LocalBoardOptions): Extension {
  const { manifests, role } = options;
  const accepted = dispatchTargets(manifests, role);

  const read = async (api: ToolExecutionApi, context: Context): Promise<Readonly<LocalBoard>> =>
    (await api.snapshot(LOCAL_BOARD_DOC, context)) ?? emptyBoard();

  /** Submits a ticket into its target's conversation (idempotent by request id), and marks it delivered. */
  const deliver = async (
    api: ToolExecutionApi,
    ticket: LocalTicket,
    context: Context,
  ): Promise<{ readonly wait: (context: Context) => Promise<unknown> } | string> => {
    const conversationId = options.conversationOf(ticket.target);
    const conversation =
      conversationId === undefined ? undefined : await api.conversation(conversationId, context);
    if (conversation === undefined) {
      return `${ticket.target} has no conversation on this harness to deliver it to; give the local board one in conversationOf`;
    }
    const submission = await conversation.submit(
      {
        type: "input",
        content: ticketMessage(ticket),
        // Prefixed, so it never meets a request id the harness's owner chose for that conversation.
        requestId: `local-board:${ticket.id}`,
        whenBusy: "followUp",
      },
      context,
    );
    if (!ticket.delivered) {
      await api.commit(async (transaction) => {
        const board = await transaction.doc(LOCAL_BOARD_DOC);
        const stored = board.tickets[ticket.id];
        if (stored !== undefined) board.tickets[ticket.id] = { ...stored, delivered: true };
      }, context);
    }
    return submission;
  };

  const agentDispatch = defineTool({
    ...AGENT_DISPATCH,
    execute: async (args, api, context) => {
      const target = accepted.get(args.type);
      if (target === undefined) {
        // The office names person routes here too; a local board has none.
        return communicationError(unknownTypeText(args.type, accepted));
      }
      // A dispatch that stopped between committing its ticket and submitting it left the ticket
      // undelivered; deliver those first, so nothing waits on a submit that never happened.
      for (const pending of Object.values((await read(api, context)).tickets)) {
        if (!pending.delivered && pending.status === "open") await deliver(api, pending, context);
      }

      // The dedupe key is the tool call's own identity, as in the office: a retry of one call
      // creates exactly one ticket.
      const callerKey = `${api.conversationId}:${api.taskId}:${api.callId}`;
      const request = JSON.stringify([args.type, args.title, args.detail, args.payload ?? null]);
      const created = await api.commit(async (transaction) => {
        const board = await transaction.doc(LOCAL_BOARD_DOC);
        const seen = board.callers[callerKey];
        if (seen !== undefined) {
          if (seen.request !== request) {
            return refusalText(
              "dispatch",
              "duplicate_key",
              `Caller key ${callerKey} already created ticket ${seen.ticketId} with a different request.`,
            );
          }
          // Copied inside the transaction: the draft cannot be read once it settles.
          return { ...(board.tickets[seen.ticketId] as LocalTicket) };
        }
        const now = new Date().toISOString();
        const ticket: LocalTicket = {
          id: `ticket-${board.next}`,
          type: args.type,
          title: args.title,
          detail: args.detail,
          payload: (args.payload ?? null) as JsonValue,
          createdBy: role,
          target,
          assignee: null,
          status: "open",
          result: null,
          createdAt: now,
          updatedAt: now,
          delivered: false,
        };
        board.next += 1;
        board.tickets[ticket.id] = ticket;
        board.callers[callerKey] = { ticketId: ticket.id, request };
        return ticket;
      }, context);
      if (typeof created === "string") return communicationError(created);
      const ticket = { ...created };

      const delivery = await deliver(api, ticket, context);
      if (typeof delivery === "string") {
        // The ticket stays on the board and the next dispatch delivers it, so this is not a failure
        // to report as one: a model told the work failed would dispatch it a second time.
        return {
          output: [
            {
              type: "text" as const,
              text: `Queued ${ticket.id} (${ticket.type}) for ${target}, but it is not delivered yet: ${delivery}. It is delivered with the next dispatch once it can be; do not dispatch it again.`,
            },
          ],
          details: { ticketId: ticket.id, type: ticket.type, status: ticket.status, role: target },
        };
      }
      if (args.wait !== true) {
        return {
          output: [{ type: "text" as const, text: dispatchedText(ticket.id, ticket.type, target) }],
          details: { ticketId: ticket.id, type: ticket.type, status: ticket.status, role: target },
        };
      }

      const settled = await waitFor(delivery.wait(context), options.waitTimeoutMs);
      if (settled === "timed out") {
        return communicationError(notCompletedText(ticket.id, ticket.type, "timed out"));
      }
      const finished = (await read(api, context)).tickets[ticket.id];
      if (finished?.status !== "done") {
        return communicationError(
          notCompletedText(
            ticket.id,
            ticket.type,
            "the colleague finished its turn without replying",
          ),
        );
      }
      return {
        output: [
          {
            type: "text" as const,
            text: finished.result ?? noAnswerText(ticket.id, ticket.type),
          },
        ],
        details: {
          ticketId: ticket.id,
          type: ticket.type,
          status: "completed" as const,
          ...(finished.result === null ? {} : { answer: finished.result }),
        },
      };
    },
  });

  const agentInbox = defineTool({
    ...AGENT_INBOX,
    execute: async (args, api, context) => {
      const tickets = Object.values((await read(api, context)).tickets).filter(
        (ticket) => args.status === undefined || ticket.status === args.status,
      );
      // Waiting for this role: what it holds, and what is routed to it and nobody has taken yet, so
      // a ticket its first turn did not finish can still be found.
      const waiting = (ticket: LocalTicket) =>
        ticket.assignee === role || (ticket.assignee === null && ticket.target === role);
      const entries = [
        ...tickets.filter(waiting).map((ticket) => ({ ticket, assigned: true })),
        ...tickets
          .filter((ticket) => !waiting(ticket) && ticket.createdBy === role)
          .map((ticket) => ({ ticket, assigned: false })),
      ];
      if (entries.length === 0) {
        return {
          output: [{ type: "text" as const, text: emptyInboxText(args.status) }],
          details: { tickets: [] },
        };
      }
      entries.sort(
        (left, right) =>
          right.ticket.updatedAt.localeCompare(left.ticket.updatedAt) ||
          left.ticket.id.localeCompare(right.ticket.id),
      );
      return {
        output: [
          {
            type: "text" as const,
            text: entries
              .map(({ ticket, assigned }) =>
                inboxLine(ticket, assigned, assigned ? undefined : (ticket.result ?? undefined)),
              )
              .join("\n"),
          },
        ],
        details: {
          tickets: entries.map(({ ticket, assigned }) => ({
            id: ticket.id,
            type: ticket.type,
            status: ticket.status,
            createdBy: ticket.createdBy,
            assigned,
          })),
        },
      };
    },
  });

  const agentReply = defineTool({
    ...AGENT_REPLY,
    execute: async (args, api, context) => {
      const outcome = await api.commit(async (transaction) => {
        const board = await transaction.doc(LOCAL_BOARD_DOC);
        const ticket = board.tickets[args.ticketId];
        if (ticket === undefined) return noTicketText(args.ticketId);
        if (ticket.status === "done") {
          return refusalText("reply", "invalid_status", `Ticket ${ticket.id} is already done.`);
        }
        // A ticket nobody has taken belongs to the role it is routed to: that role's reply is the
        // claim before completing it. Anyone else, the dispatcher included, is refused.
        const holder = ticket.assignee ?? ticket.target;
        if (holder !== role) {
          return refusalText(
            "reply",
            "unauthorized",
            `Ticket ${ticket.id} is assigned to ${holder}; only the assignee can complete it.`,
          );
        }
        board.tickets[ticket.id] = {
          ...ticket,
          assignee: role,
          status: "done",
          result: args.result,
          updatedAt: new Date().toISOString(),
        };
        return undefined;
      }, context);
      if (outcome !== undefined) return communicationError(outcome);
      return {
        output: [{ type: "text" as const, text: repliedText(args.ticketId, args.result) }],
        details: { ticketId: args.ticketId, result: args.result },
      };
    },
  });

  return defineExtension({
    name: options.name ?? `local-board.${role}`,
    sections: [section("team", () => teamText(manifests, role))],
    tools: [agentDispatch, agentInbox, agentReply],
  });
}

/** The promise's settling, or `"timed out"` after `timeoutMs`. */
async function waitFor<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
): Promise<T | "timed out"> {
  if (timeoutMs === undefined) return await promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"timed out">((resolve) => {
        timer = setTimeout(() => resolve("timed out"), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
