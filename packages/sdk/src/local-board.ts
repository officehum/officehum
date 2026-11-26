/**
 * The local board: the office's `agent_dispatch`, `agent_inbox` and `agent_reply`, for
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
 * - **After a restart**, as in the office. Each ticket a dispatch creates records the
 *   conversation and the tool task of the call that made it (`handoff`). When Pi Durable ends that
 *   call itself — a restart settles an interrupted `agent_dispatch` as failed — its result never
 *   reached the conversation, so the answer is owed: it is submitted into the dispatcher's
 *   conversation once, with `requestId` `local-board-answer:<ticket id>`. And a dispatch of the same
 *   ticket type from the same conversation, while that answer is still owed or on its way, is a
 *   retry: it returns the earlier ticket and creates nothing, unless it sets `separate_request`.
 *   Once the answer is in the dispatcher's transcript — as a dispatch's committed result, or as the
 *   answer message placed there — a dispatch of the type is new work.
 *
 * One difference from the office: there is no poller, so an owed answer is returned by the local
 * board's own writing tools — `agent_reply` returns it as it completes a ticket whose dispatcher no
 * longer waits, and every `agent_dispatch` and `agent_reply` first returns any answer still owed. An
 * answer owed after a restart therefore arrives with the next dispatch or reply from any role, not on
 * its own. `agent_inbox` stays read-only.
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
  type TaskId,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import {
  AGENT_DISPATCH,
  AGENT_INBOX,
  AGENT_REPLY,
  answerMessage,
  communicationError,
  dispatchedText,
  dispatchTargets,
  emptyInboxText,
  inboxLine,
  noAnswerText,
  noTicketText,
  notCompletedText,
  recognisedText,
  refusalText,
  repliedText,
  teamText,
  ticketMessage,
  unknownTypeText,
} from "./communication.js";
import type { AgentManifest } from "./manifest.js";

/** Any JSON value, as Pi Durable documents hold them. */
type JsonValue = JsonObject[string];

/**
 * Which conversation and dispatch call opened a ticket, and what its answer's return stands at
 *. `outcome` follows the office's hand-off: `open` until the bound call's end is known,
 * `returned` (the call returned its own result without the answer), `answered` (it returned the
 * answer), `delivering` then `delivered` (the answer submitted as a message), `gone` (no conversation
 * to return it to).
 */
export type LocalHandoff = {
  conversationId: number;
  /** The Pi Durable tool task of the dispatch call the ticket is bound to. */
  taskId: number;
  /** The call that marked itself as returning the answer; counts once its task ended `completed`. */
  answeredTaskId: number | null;
  outcome: "open" | "returned" | "answered" | "delivering" | "delivered" | "gone";
};

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
  /** Absent on a ticket a dispatch did not create, or one written before tickets recorded their dispatch. */
  handoff?: LocalHandoff;
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
  checkpointWhen: () => false,
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

/**
 * Where a dispatch call stands, from the harness's record of its tool task: `running` while it is not
 * terminal, `returned` when it ended `completed` (its own result is in the transcript), `ended` when
 * Pi Durable ended it itself or there is no such task. The office reads it the same way.
 */
async function callState(
  api: ToolExecutionApi,
  taskId: number,
  context: Context,
): Promise<"running" | "returned" | "ended"> {
  const record = await api.getTask(taskId as TaskId, context);
  if (record === undefined) return "ended";
  if (record.state.status !== "terminal") return "running";
  return record.state.outcome.status === "completed" ? "returned" : "ended";
}

/** The request id an answer message is submitted with: one per ticket, so Pi Durable dedupes it. */
const answerRequestId = (ticketId: string): string => `local-board-answer:${ticketId}`;

/**
 * What a dispatch naming subjects is told: a standalone harness has no record of what a
 * conversation's tools verified, so it never takes a subject from the model.
 */
export const LOCAL_ABOUT_REFUSAL =
  "Nothing was dispatched: this harness cannot check that a tool of yours looked those subjects up, so a dispatch here takes no about. Dispatch again without it.";

export function localBoardExtension(options: LocalBoardOptions): Extension {
  const { manifests, role } = options;
  const accepted = dispatchTargets(manifests, role);

  const read = async (api: ToolExecutionApi, context: Context): Promise<Readonly<LocalBoard>> =>
    (await api.snapshot(LOCAL_BOARD_DOC, context)) ?? emptyBoard();

  /** Change one ticket's hand-off when `when` holds for it; whether it did. */
  const updateHandoff = async (
    api: ToolExecutionApi,
    ticketId: string,
    when: (handoff: LocalHandoff) => boolean,
    change: Partial<LocalHandoff>,
    context: Context,
  ): Promise<boolean> =>
    await api.commit(async (transaction) => {
      const board = await transaction.doc(LOCAL_BOARD_DOC);
      const stored = board.tickets[ticketId];
      if (stored?.handoff === undefined || !when(stored.handoff)) return false;
      board.tickets[ticketId] = { ...stored, handoff: { ...stored.handoff, ...change } };
      return true;
    }, context);

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

  /**
   * The answer message for a ticket, submitted into its dispatcher's conversation. Idempotent by
   * request id: submitting again returns the original submission, which is how a later call learns
   * whether it was placed in the transcript yet. `undefined` when the conversation is gone.
   */
  const submitAnswer = async (api: ToolExecutionApi, ticket: LocalTicket, context: Context) => {
    const handoff = ticket.handoff;
    const conversation =
      handoff === undefined
        ? undefined
        : await api.conversation(handoff.conversationId as ConversationId, context);
    if (conversation === undefined) return undefined;
    return await conversation.submit(
      {
        type: "input",
        content: answerMessage(ticket, ticket.result ?? undefined),
        requestId: answerRequestId(ticket.id),
        whenBusy: "followUp",
      },
      context,
    );
  };

  /**
   * Return every answer owed to a dispatcher that no longer waits for it: a done ticket whose bound
   * call Pi Durable ended. A call still running will return the answer itself; a call that returned
   * its own result settles the hand-off (`answered` or `returned`). The `open → delivering` step is
   * conditional on the bound call, so a re-dispatch that rebound the ticket meanwhile wins.
   */
  const returnAnswers = async (api: ToolExecutionApi, context: Context): Promise<void> => {
    for (const ticket of Object.values((await read(api, context)).tickets)) {
      const handoff = ticket.handoff;
      if (handoff === undefined || ticket.status !== "done") continue;
      if (handoff.outcome === "open") {
        const state = await callState(api, handoff.taskId, context);
        if (state === "running") continue;
        const bound = (current: LocalHandoff) =>
          current.outcome === "open" && current.taskId === handoff.taskId;
        if (state === "returned") {
          const answered = handoff.answeredTaskId === handoff.taskId;
          await updateHandoff(
            api,
            ticket.id,
            bound,
            { outcome: answered ? "answered" : "returned" },
            context,
          );
          continue;
        }
        if (!(await updateHandoff(api, ticket.id, bound, { outcome: "delivering" }, context))) {
          continue;
        }
      } else if (handoff.outcome !== "delivering") {
        continue;
      }
      const submitted = await submitAnswer(api, ticket, context);
      await updateHandoff(
        api,
        ticket.id,
        (current) => current.outcome === "delivering",
        { outcome: submitted === undefined ? "gone" : "delivered" },
        context,
      );
    }
  };

  /**
   * The tickets a dispatch of `type` from this conversation retries, newest first: of that type,
   * whose answer is still owed (the call ended by Pi Durable) or on its way (its message not yet
   * placed in the transcript). A call still running is a concurrent dispatch, and a call that
   * returned its own result named its ticket; neither is retried.
   */
  const retriedTickets = async (
    api: ToolExecutionApi,
    type: string,
    context: Context,
  ): Promise<LocalTicket[]> => {
    const candidates = Object.values((await read(api, context)).tickets)
      .filter(
        (ticket) =>
          ticket.createdBy === role &&
          ticket.type === type &&
          ticket.handoff !== undefined &&
          ticket.handoff.conversationId === api.conversationId &&
          ticket.handoff.taskId !== api.taskId &&
          ["open", "delivering", "delivered"].includes(ticket.handoff.outcome),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const retried: LocalTicket[] = [];
    for (const ticket of candidates) {
      const handoff = ticket.handoff as LocalHandoff;
      if (handoff.outcome === "delivered") {
        const submission = await submitAnswer(api, ticket, context);
        if (submission === undefined) continue;
        if ((await submission.status(context)).status !== "queued") continue;
      } else if (handoff.outcome === "open") {
        const state = await callState(api, handoff.taskId, context);
        if (state === "running") continue;
        if (state === "returned") {
          await updateHandoff(
            api,
            ticket.id,
            (current) => current.outcome === "open" && current.taskId === handoff.taskId,
            { outcome: handoff.answeredTaskId === handoff.taskId ? "answered" : "returned" },
            context,
          );
          continue;
        }
      }
      retried.push({ ...ticket });
    }
    return retried;
  };

  /** The answer, once the delegate's turn settled: the result the delegate replied with. */
  const waitForAnswer = async (
    api: ToolExecutionApi,
    ticket: LocalTicket,
    delivery: { readonly wait: (context: Context) => Promise<unknown> },
    /** Set when this call is a recognised retry: the other interrupted hand-offs of the type. */
    recognised: readonly string[] | undefined,
    context: Context,
  ) => {
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
    // This call returns the answer: acknowledged once Pi Durable commits the result, not before.
    await updateHandoff(
      api,
      ticket.id,
      (current) => current.outcome === "open" && current.taskId === api.taskId,
      { answeredTaskId: api.taskId },
      context,
    );
    return {
      output: [
        {
          type: "text" as const,
          text:
            recognised === undefined
              ? (finished.result ?? noAnswerText(ticket.id, ticket.type))
              : recognisedText({
                  id: ticket.id,
                  type: ticket.type,
                  title: ticket.title,
                  status: "done",
                  answer: finished.result ?? undefined,
                  others: recognised,
                }),
        },
      ],
      details: {
        ticketId: ticket.id,
        type: ticket.type,
        status: "completed" as const,
        ...(finished.result === null ? {} : { answer: finished.result }),
        ...(recognised === undefined ? {} : { recognised: true, others: [...recognised] }),
      },
    };
  };

  /** Answer a retry with the ticket it retries; `undefined` when it moved on meanwhile. */
  const answerRepeat = async (
    api: ToolExecutionApi,
    ticket: LocalTicket,
    others: readonly string[],
    wait: boolean,
    context: Context,
  ) => {
    const handoff = ticket.handoff as LocalHandoff;
    const reply = (status: string, answer: string | undefined, delivering = false) => ({
      output: [
        {
          type: "text" as const,
          text: recognisedText({
            id: ticket.id,
            type: ticket.type,
            title: ticket.title,
            status,
            answer,
            delivering,
            others,
          }),
        },
      ],
      details: {
        ticketId: ticket.id,
        type: ticket.type,
        recognised: true,
        others: [...others],
        status: status === "done" && !delivering ? ("completed" as const) : status,
        ...(answer === undefined ? {} : { answer }),
      },
    });
    if (handoff.outcome !== "open") return reply(ticket.status, undefined, true);
    const done = ticket.status === "done";
    const rebound = await updateHandoff(
      api,
      ticket.id,
      (current) => current.outcome === "open" && current.taskId === handoff.taskId,
      { taskId: api.taskId, answeredTaskId: done ? api.taskId : null },
      context,
    );
    if (!rebound) {
      const now = (await read(api, context)).tickets[ticket.id]?.handoff?.outcome;
      return now === "delivering" ? reply(ticket.status, undefined, true) : undefined;
    }
    if (done) return reply("done", ticket.result ?? undefined);
    if (wait) {
      const delivery = await deliver(api, ticket, context);
      if (typeof delivery !== "string") {
        return await waitForAnswer(api, ticket, delivery, others, context);
      }
    }
    return reply(ticket.status, undefined);
  };

  const agentDispatch = defineTool({
    ...AGENT_DISPATCH,
    execute: async (args, api, context) => {
      if ((args.about ?? []).length > 0) return communicationError(LOCAL_ABOUT_REFUSAL);
      const target = accepted.get(args.type);
      if (target === undefined) {
        // The office names person routes here too; a local board has none.
        return communicationError(unknownTypeText(args.type, accepted));
      }
      // Answers a restart left owed go back first, so a repeat below sees where they stand.
      await returnAnswers(api, context);
      // A dispatch that stopped between committing its ticket and submitting it left the ticket
      // undelivered; deliver those first, so nothing waits on a submit that never happened.
      for (const pending of Object.values((await read(api, context)).tickets)) {
        if (!pending.delivered && pending.status === "open") await deliver(api, pending, context);
      }

      // A retry of a hand-off a restart interrupted: the same type from the same conversation,
      // unless the agent says it is a separate request.
      if (args.separate_request !== true) {
        const retried = await retriedTickets(api, args.type, context);
        for (const [index, ticket] of retried.entries()) {
          const others = retried.filter((_, at) => at !== index).map((other) => other.id);
          const answered = await answerRepeat(api, ticket, others, args.wait === true, context);
          if (answered !== undefined) return answered;
        }
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
          // In the ticket's own commit: what a restart reads to tell whether this call still waits.
          handoff: {
            conversationId: api.conversationId,
            taskId: api.taskId,
            answeredTaskId: null,
            outcome: "open",
          },
        };
        board.next += 1;
        board.tickets[ticket.id] = ticket;
        board.callers[callerKey] = { ticketId: ticket.id, request };
        return { ...ticket, handoff: { ...(ticket.handoff as LocalHandoff) } };
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
      return await waitForAnswer(api, ticket, delivery, undefined, context);
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
      // The dispatcher may no longer be waiting for this answer (a restart ended its call), and any
      // other answer still owed goes back with it.
      await returnAnswers(api, context);
      return {
        output: [{ type: "text" as const, text: repliedText(args.ticketId, args.result) }],
        details: {
          ticketId: args.ticketId,
          result: args.result,
          // The local board checks no completion evidence, so it only passes the files on.
          ...(args.files === undefined ? {} : { files: args.files }),
        },
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
