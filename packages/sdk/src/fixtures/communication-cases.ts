/**
 * The communication tools' shared test cases (RASF-3112): what `agent_dispatch`, `agent_inbox` and
 * `agent_reply` do, written once and run against both implementations — the office extension
 * (`packages/office/src/extension/office.test.ts`) and the local board
 * (`packages/sdk/src/local-board.test.ts`). Each supplies a `CommunicationSubject` over its own
 * board; the cases only talk to that.
 *
 * Two roles share one harness: the delegator (`frontdesk`, accepts `booking.request`) and the
 * delegate (`bookkeeper`, accepts `invoice.create`). Test support only: not built, not published.
 */
import type { JsonObject, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentManifest } from "../manifest.js";

export const FRONT = "frontdesk";
export const FRONT_TYPE = "booking.request";
export const BOOK = "bookkeeper";
export const TYPE = "invoice.create";
export const UNKNOWN_TYPE = "mystery.thing";

export const REQUEST = "Please invoice job 42.";
export const DELEGATE_RESULT = "Invoice 42 is paid.";
export const DELEGATOR_FINAL = "Handed it on.";
/** Deliberately NOT the result: what the delegate says in chat is not what it replied with. */
export const DELEGATE_CHATTER = "Replied on the ticket — see agent_reply for the answer.";

/** A minimal, valid `officehum.json`: only `id`, `name` and `accepts` are read by the tools. */
export function manifestOf(
  id: string,
  name: string,
  accepts: readonly { readonly type: string; readonly description: string }[],
): AgentManifest {
  return {
    schemaVersion: 1,
    id,
    name,
    department: "finance",
    role: `${name} does the work this office hands on.`,
    defaultModel: { provider: "scripted", modelId: "scripted-1" },
    tools: [],
    connectors: [],
    approvals: [],
    channels: [],
    accepts: accepts.map((accept) => ({ ...accept })),
    skills: [],
    evals: "evals",
  };
}

export const FRONT_MANIFEST = manifestOf(FRONT, "Front Desk", [
  { type: FRONT_TYPE, description: "Take a booking request" },
]);
export const BOOK_MANIFEST = manifestOf(BOOK, "Bookkeeper", [
  { type: TYPE, description: "Invoice a completed job" },
]);

/** The text of one transcript message, whatever shape its content is. */
export function textOf(message: Message): string {
  const content: unknown = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { readonly type: "text"; readonly text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/** A turn of the scripted model: an answer, or tool calls. */
export type CaseTurn =
  | { readonly text: string }
  | {
      readonly toolCalls: readonly {
        readonly name: string;
        // JSON, as the scripted providers on both sides pass it to the model's tool call.
        readonly args?: JsonObject;
      }[];
    };

/**
 * The script both roles run. A delivered ticket means the delegate's conversation: it answers with
 * `agent_reply`. Otherwise the delegator asks for the work, then finishes once the dispatch returns.
 */
export function delegatingScript(
  dispatch?: JsonObject,
): (messages: readonly Message[]) => CaseTurn {
  return (messages) => {
    const delivered = messages.findLast(
      (message) => message.role === "user" && textOf(message).includes("TICKET "),
    );
    if (delivered !== undefined) {
      const ticketId = /TICKET (\S+)/.exec(textOf(delivered))?.[1] ?? "";
      const after = messages.slice(messages.lastIndexOf(delivered) + 1);
      if (
        after.some((message) => message.role === "toolResult" && message.toolName === "agent_reply")
      ) {
        return { text: DELEGATE_CHATTER };
      }
      return {
        toolCalls: [{ name: "agent_reply", args: { ticketId, result: DELEGATE_RESULT } }],
      };
    }
    if (
      messages.some(
        (message) => message.role === "toolResult" && message.toolName === "agent_dispatch",
      )
    ) {
      return { text: DELEGATOR_FINAL };
    }
    return {
      toolCalls: [
        {
          name: "agent_dispatch",
          args: dispatch ?? { type: TYPE, title: "Invoice job 42", detail: REQUEST, wait: true },
        },
      ],
    };
  };
}

/** What one direct tool call returned, narrowed enough to assert on. */
export type CallResult = {
  readonly isError?: boolean | undefined;
  readonly output?: readonly { readonly type: string; readonly text?: string }[] | undefined;
  readonly details?: unknown;
};

export function callText(result: CallResult): string {
  return (result.output ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

export function detailsOf(result: CallResult): Record<string, unknown> {
  return (result.details ?? {}) as Record<string, unknown>;
}

export type CommunicationTool = "agent_dispatch" | "agent_inbox" | "agent_reply";

/** One implementation's board and tools, as the shared cases drive them. */
export interface CommunicationSubject {
  /** Calls a tool as one of the two roles; `callId` names the call (the dedupe key). */
  call(
    as: typeof FRONT | typeof BOOK,
    tool: CommunicationTool,
    args: Record<string, unknown>,
    callId?: string,
  ): Promise<CallResult>;
  /** Puts an open, undelivered ticket on the board. */
  createTicket(input: {
    readonly type: string;
    readonly title: string;
    readonly detail: string;
    readonly createdBy: string;
  }): Promise<string>;
  /** Has `role` take an open ticket. */
  claim(ticketId: string, role: string): Promise<void>;
  /** Assigns a ticket to an agent, which then holds it. */
  assign(ticketId: string, role: string): Promise<void>;
  ticket(
    ticketId: string,
  ): Promise<
    | { readonly status: string; readonly assignee: string | null; readonly result: string | null }
    | undefined
  >;
  ticketsOfType(type: string): Promise<readonly string[]>;
  /** Everything the board holds, as a string, to show a read changed nothing. */
  fingerprint(): Promise<string>;
  /**
   * The whole hand-off: the delegator's model dispatches with `wait: true`, the ticket is delivered,
   * the delegate replies. Resolves with the ticket and what the delegator's dispatch returned.
   */
  handOff(): Promise<{ readonly ticketId: string; readonly dispatchText: string }>;
  /** A delegator's `agent_dispatch` with `wait: true`, delivered until the delegate has replied. */
  dispatchAndWait(args: Record<string, unknown>): Promise<CallResult>;
  close(): Promise<void>;
}

/** Registers the shared cases against one implementation. */
export function communicationCases(open: () => Promise<CommunicationSubject>): void {
  const withSubject = (test: (subject: CommunicationSubject) => Promise<void>) => async () => {
    const subject = await open();
    try {
      await test(subject);
    } finally {
      await subject.close();
    }
  };

  describe("agent_dispatch (shared)", () => {
    it(
      "hands the work to the role that accepts the type, and wait returns the reply",
      withSubject(async (subject) => {
        const { ticketId, dispatchText } = await subject.handOff();
        expect(dispatchText).toContain(DELEGATE_RESULT);
        expect(await subject.ticket(ticketId)).toEqual({
          status: "done",
          assignee: BOOK,
          result: DELEGATE_RESULT,
        });
      }),
    );

    it(
      "refuses an unknown ticket type, names the accepted ones, and creates nothing",
      withSubject(async (subject) => {
        const result = await subject.call(FRONT, "agent_dispatch", {
          type: UNKNOWN_TYPE,
          title: "Something odd",
          detail: "Nobody knows.",
        });
        expect(result.isError).toBe(true);
        expect(callText(result)).toContain(UNKNOWN_TYPE);
        expect(callText(result)).toContain(TYPE);
        expect(callText(result)).toContain("nothing was dispatched");
        expect(await subject.ticketsOfType(UNKNOWN_TYPE)).toEqual([]);
      }),
    );

    it(
      "creates exactly one ticket when the same call is retried",
      withSubject(async (subject) => {
        const args = { type: TYPE, title: "Invoice job 42", detail: REQUEST };
        const first = await subject.call(FRONT, "agent_dispatch", args, "call-retry");
        const second = await subject.call(FRONT, "agent_dispatch", args, "call-retry");
        expect(first.isError).toBeUndefined();
        expect(second.isError).toBeUndefined();
        expect(detailsOf(second).ticketId).toBe(detailsOf(first).ticketId);
        expect(callText(first)).toContain(
          `Dispatched ${detailsOf(first).ticketId} (${TYPE}) to ${BOOK}`,
        );
        expect(await subject.ticketsOfType(TYPE)).toHaveLength(1);
      }),
    );
  });

  describe("agent_reply (shared)", () => {
    it(
      "takes an open ticket and completes it",
      withSubject(async (subject) => {
        const id = await subject.createTicket({
          type: TYPE,
          title: "Invoice job 42",
          detail: REQUEST,
          createdBy: FRONT,
        });
        const result = await subject.call(BOOK, "agent_reply", {
          ticketId: id,
          result: DELEGATE_RESULT,
        });
        expect(result.isError).toBeUndefined();
        expect(callText(result)).toBe(`Completed ${id}: ${DELEGATE_RESULT}`);
        expect(await subject.ticket(id)).toEqual({
          status: "done",
          assignee: BOOK,
          result: DELEGATE_RESULT,
        });
      }),
    );

    it(
      "refuses a ticket another agent holds, and leaves it standing",
      withSubject(async (subject) => {
        const id = await subject.createTicket({
          type: TYPE,
          title: "Invoice job 42",
          detail: REQUEST,
          createdBy: "office",
        });
        await subject.claim(id, FRONT);
        const result = await subject.call(BOOK, "agent_reply", {
          ticketId: id,
          result: "Not mine to finish.",
        });
        expect(result.isError).toBe(true);
        expect(callText(result)).toContain("The board refused the reply (unauthorized)");
        expect(callText(result)).toContain(FRONT);
        expect(await subject.ticket(id)).toMatchObject({ status: "claimed", assignee: FRONT });
      }),
    );

    it(
      "says so for a ticket that does not exist",
      withSubject(async (subject) => {
        const result = await subject.call(BOOK, "agent_reply", {
          ticketId: "no-such-ticket",
          result: "x",
        });
        expect(result.isError).toBe(true);
        expect(callText(result)).toBe("No ticket no-such-ticket on this board.");
      }),
    );
  });

  describe("agent_inbox (shared)", () => {
    it(
      "lists the tickets waiting for the agent, and the answers to the ones it opened",
      withSubject(async (subject) => {
        const opened = await subject.dispatchAndWait({
          type: TYPE,
          title: "Invoice job 42",
          detail: REQUEST,
          wait: true,
        });
        expect(detailsOf(opened).answer).toBe(DELEGATE_RESULT);
        const openedId = String(detailsOf(opened).ticketId);

        const assigned = await subject.createTicket({
          type: FRONT_TYPE,
          title: "Reconcile the account",
          detail: "Before the month end.",
          createdBy: "office",
        });
        await subject.assign(assigned, FRONT);
        await subject.createTicket({
          type: TYPE,
          title: "Someone else's work",
          detail: "Unassigned.",
          createdBy: "office",
        });

        const inbox = await subject.call(FRONT, "agent_inbox", {});
        const ids = (detailsOf(inbox).tickets as readonly { id: string }[]).map(
          (entry) => entry.id,
        );
        expect([...ids].sort()).toEqual([assigned, openedId].sort());
        expect(callText(inbox)).toContain("assigned to you");
        expect(callText(inbox)).toContain("(opened)");
        expect(callText(inbox)).toContain(`result: ${DELEGATE_RESULT}`);

        const claimed = await subject.call(FRONT, "agent_inbox", { status: "claimed" });
        expect(
          (detailsOf(claimed).tickets as readonly { id: string }[]).map((entry) => entry.id),
        ).toEqual([assigned]);

        const cancelled = await subject.call(FRONT, "agent_inbox", { status: "cancelled" });
        expect(detailsOf(cancelled).tickets).toEqual([]);
        expect(callText(cancelled)).toBe("Nothing is cancelled.");
      }),
    );

    it(
      "reads without changing the board",
      withSubject(async (subject) => {
        const id = await subject.createTicket({
          type: TYPE,
          title: "Reconcile the account",
          detail: "Before the month end.",
          createdBy: FRONT,
        });
        const before = await subject.fingerprint();
        await subject.call(FRONT, "agent_inbox", {});
        expect(await subject.fingerprint()).toBe(before);
        expect(await subject.ticket(id)).toMatchObject({ status: "open" });
      }),
    );
  });
}
