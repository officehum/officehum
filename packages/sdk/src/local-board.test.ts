/**
 * The local board (RASF-3112) on a bare Pi Durable harness, with no Office Hum: the shared
 * communication cases the office extension also passes, then the local board's own delivery and
 * restart cases. A scripted model stands in for the model; nothing touches the network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  type ConversationId,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type JsonObject,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOOK,
  BOOK_MANIFEST,
  type CallResult,
  type CaseTurn,
  type CommunicationSubject,
  callText,
  communicationCases,
  DELEGATE_RESULT,
  delegatingScript,
  detailsOf,
  FRONT,
  FRONT_MANIFEST,
  REQUEST,
  TYPE,
  textOf,
} from "./fixtures/communication-cases.js";
import { LOCAL_BOARD_DOC, type LocalTicket, localBoardExtension } from "./local-board.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A scripted model: each request is answered by `script` from the transcript. */
function scripted(script: (messages: readonly Message[]) => CaseTurn) {
  const faux = fauxProvider({
    provider: "scripted",
    api: "scripted",
    models: [{ id: "scripted-1" }],
  });
  const respond: FauxResponseFactory = (context, _options, _state, model) => {
    faux.appendResponses([respond]);
    const turn = script(context.messages);
    const message =
      "text" in turn
        ? fauxAssistantMessage(turn.text)
        : fauxAssistantMessage(
            turn.toolCalls.map((call) => fauxToolCall(call.name, (call.args ?? {}) as JsonObject)),
            { stopReason: "toolUse" },
          );
    return { ...message, provider: model.provider, model: model.id };
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: { provider: "scripted", modelId: "scripted-1" } };
}

/** A role's own extension: one harmless tool, so each role has something of its own. */
function roleExtension(role: string) {
  return defineExtension({
    name: `role.${role}`,
    tools: [
      defineTool({
        name: `note_${role}`,
        description: "Record a note.",
        parameters: Type.Object({ note: Type.String() }, { additionalProperties: false }),
        replay: "safe",
        execute: async (args) => ({ output: [{ type: "text" as const, text: args.note }] }),
      }),
    ],
  });
}

interface Office {
  readonly harness: Harness;
  readonly front: ReturnType<typeof localBoardExtension>;
  readonly book: ReturnType<typeof localBoardExtension>;
  readonly conversations: Map<string, Conversation>;
  close(): Promise<void>;
}

/** Two roles, each with its own extension, its local-board extension and its conversation. */
async function openOffice(
  storage: "memory" | string,
  script = delegatingScript(),
  conversationIds?: Map<string, ConversationId>,
): Promise<Office> {
  const model = scripted(script);
  const registry = createRegistry();
  const harness = await Harness.open(
    storage === "memory" ? new MemoryStorage() : await openNodeSqliteStorage(storage),
    { models: model.models, registry },
    BACKGROUND_CONTEXT,
  );
  const conversations = new Map<string, Conversation>();
  const manifests = [FRONT_MANIFEST, BOOK_MANIFEST];
  const board = (role: string) =>
    localBoardExtension({
      manifests,
      role,
      conversationOf: (roleId) => conversations.get(roleId)?.id,
    });
  const front = board(FRONT);
  const book = board(BOOK);
  const frontRole = roleExtension(FRONT);
  const bookRole = roleExtension(BOOK);
  for (const extension of [frontRole, front, bookRole, book]) registry.install(extension);
  for (const [role, extensions] of [
    [FRONT, [frontRole, front]],
    [BOOK, [bookRole, book]],
  ] as const) {
    const known = conversationIds?.get(role);
    const conversation =
      known === undefined
        ? await harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              agent: { extensions: [...extensions], model: model.model },
            },
            BACKGROUND_CONTEXT,
          )
        : await harness.conversation(known, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error(`No conversation for ${role}.`);
    conversations.set(role, conversation);
  }
  harness.resume();
  return {
    harness,
    front,
    book,
    conversations,
    close: () => harness.close(BACKGROUND_CONTEXT),
  };
}

function toolOf(extension: ReturnType<typeof localBoardExtension>, name: string): ToolRegistration {
  const tool = extension.tools?.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`No ${name} tool.`);
  return tool;
}

/**
 * Calls a tool directly, with the harness standing in for the tool API: the board's reads, commits
 * and conversation handles are the harness's own, and the call identity is made up.
 */
async function call(
  office: Office,
  extension: ReturnType<typeof localBoardExtension>,
  name: string,
  args: Record<string, unknown>,
  callId = "call-1",
): Promise<CallResult> {
  const api = {
    conversationId: 7,
    taskId: 11,
    callId,
    snapshot: (token: unknown, context: unknown) =>
      office.harness.snapshot(token as never, context as never),
    commit: (change: unknown, context: unknown) =>
      office.harness.commit(change as never, context as never),
    conversation: (id: ConversationId, context: unknown) =>
      office.harness.conversation(id, context as never),
  };
  const execute = toolOf(extension, name).execute as unknown as (
    args: unknown,
    api: unknown,
    context: unknown,
  ) => Promise<CallResult>;
  return await execute(args, api, BACKGROUND_CONTEXT);
}

async function board(office: Office) {
  return (
    (await office.harness.snapshot(LOCAL_BOARD_DOC, BACKGROUND_CONTEXT)) ?? {
      tickets: {},
      callers: {},
      next: 1,
    }
  );
}

async function edit(office: Office, id: string, change: (ticket: LocalTicket) => LocalTicket) {
  await office.harness.commit(async (transaction) => {
    const doc = await transaction.doc(LOCAL_BOARD_DOC);
    const ticket = doc.tickets[id];
    if (ticket === undefined) throw new Error(`No ticket ${id}.`);
    doc.tickets[id] = change({ ...ticket });
  }, BACKGROUND_CONTEXT);
}

function subjectOf(office: Office): CommunicationSubject {
  return {
    call: (as, tool, args, callId) =>
      call(office, as === FRONT ? office.front : office.book, tool, args, callId),
    async createTicket(input) {
      let id = "";
      await office.harness.commit(async (transaction) => {
        const doc = await transaction.doc(LOCAL_BOARD_DOC);
        id = `ticket-${doc.next}`;
        doc.next += 1;
        const now = new Date().toISOString();
        doc.tickets[id] = {
          id,
          ...input,
          payload: null,
          target: input.type === TYPE ? BOOK : FRONT,
          assignee: null,
          status: "open",
          result: null,
          createdAt: now,
          updatedAt: now,
          // Put on the board as if already delivered, so no dispatch delivers it again.
          delivered: true,
        };
      }, BACKGROUND_CONTEXT);
      return id;
    },
    claim: (id, role) =>
      edit(office, id, (ticket) => ({ ...ticket, status: "claimed", assignee: role })),
    assign: (id, role) =>
      edit(office, id, (ticket) => ({ ...ticket, status: "claimed", assignee: role })),
    async ticket(id) {
      const ticket = (await board(office)).tickets[id];
      return ticket === undefined
        ? undefined
        : { status: ticket.status, assignee: ticket.assignee, result: ticket.result };
    },
    async ticketsOfType(type) {
      return Object.values((await board(office)).tickets)
        .filter((ticket) => ticket.type === type)
        .map((ticket) => ticket.id);
    },
    fingerprint: async () => JSON.stringify(await board(office)),
    async handOff() {
      const front = office.conversations.get(FRONT) as Conversation;
      const submission = await front.submit(
        { type: "input", content: REQUEST, requestId: "req-hand-off" },
        BACKGROUND_CONTEXT,
      );
      await submission.wait(BACKGROUND_CONTEXT);
      const messages = (await front.context(BACKGROUND_CONTEXT)).messages;
      const dispatchText = messages
        .filter((message) => message.role === "toolResult" && message.toolName === "agent_dispatch")
        .map(textOf)
        .join("\n");
      const [ticketId = ""] = Object.keys((await board(office)).tickets);
      return { ticketId, dispatchText };
    },
    dispatchAndWait: (args) => call(office, office.front, "agent_dispatch", args, "call-wait"),
    close: () => office.close(),
  };
}

describe("the local board", () => {
  communicationCases(async () => subjectOf(await openOffice("memory")));

  it("adds the three tools and a team section, built from the shared definitions", async () => {
    const office = await openOffice("memory");
    try {
      expect(office.front.name).toBe(`local-board.${FRONT}`);
      expect(office.front.tools?.map((tool) => [tool.name, tool.replay])).toEqual([
        ["agent_dispatch", "unsafe"],
        ["agent_inbox", "safe"],
        ["agent_reply", "unsafe"],
      ]);
      expect(office.front.sections?.map((entry) => entry.key)).toEqual(["team"]);
    } finally {
      await office.close();
    }
  });

  it("delivers into the assignee's conversation once, with the ticket id as its request id", async () => {
    const office = await openOffice("memory");
    try {
      const args = { type: TYPE, title: "Invoice job 42", detail: REQUEST };
      const first = await call(office, office.front, "agent_dispatch", { ...args, wait: true });
      expect(callText(first)).toBe(DELEGATE_RESULT);
      // The same call again: the same ticket, and no second delivery.
      await call(office, office.front, "agent_dispatch", { ...args, wait: true });
      const book = office.conversations.get(BOOK) as Conversation;
      const delivered = (await book.context(BACKGROUND_CONTEXT)).messages.filter(
        (message) => message.role === "user" && textOf(message).startsWith("TICKET "),
      );
      expect(delivered).toHaveLength(1);
      expect(textOf(delivered[0] as Message)).toBe(
        `TICKET ${detailsOf(first).ticketId} — type ${TYPE}\nInvoice job 42\n${REQUEST}`,
      );
    } finally {
      await office.close();
    }
  });

  it("says so when the colleague finishes without replying", async () => {
    const office = await openOffice("memory", (messages) =>
      messages.some((message) => message.role === "user" && textOf(message).startsWith("TICKET "))
        ? { text: "I looked at it." }
        : { text: "unused" },
    );
    try {
      const result = await call(office, office.front, "agent_dispatch", {
        type: TYPE,
        title: "Invoice job 42",
        detail: REQUEST,
        wait: true,
      });
      expect(result.isError).toBe(true);
      expect(callText(result)).toBe(
        `Ticket ${detailsOf(result).ticketId ?? "ticket-1"} (${TYPE}) did not complete: the colleague finished its turn without replying.`,
      );
    } finally {
      await office.close();
    }
  });

  it("refuses a dispatch it cannot deliver, naming why", async () => {
    const office = await openOffice("memory");
    try {
      office.conversations.delete(BOOK);
      const result = await call(office, office.front, "agent_dispatch", {
        type: TYPE,
        title: "Invoice job 42",
        detail: REQUEST,
      });
      expect(result.isError).toBe(true);
      expect(callText(result)).toContain(`${BOOK} has no conversation on this harness`);
    } finally {
      await office.close();
    }
  });

  it("keeps tickets across a restart, and delivers one a crash left undelivered", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-local-board-"));
    temps.push(directory);
    const file = join(directory, "harness.sqlite");
    const first = await openOffice(file);
    const ids = new Map(
      [...first.conversations].map(([role, conversation]) => [role, conversation.id]),
    );
    // A dispatch that stopped after committing its ticket and before submitting it.
    await first.harness.commit(async (transaction) => {
      const doc = await transaction.doc(LOCAL_BOARD_DOC);
      const now = new Date().toISOString();
      doc.tickets["ticket-1"] = {
        id: "ticket-1",
        type: TYPE,
        title: "Invoice job 7",
        detail: "Left behind.",
        payload: null,
        createdBy: FRONT,
        target: BOOK,
        assignee: null,
        status: "open",
        result: null,
        createdAt: now,
        updatedAt: now,
        delivered: false,
      };
      doc.next = 2;
    }, BACKGROUND_CONTEXT);
    await first.close();

    const second = await openOffice(file, delegatingScript(), ids);
    try {
      expect((await board(second)).tickets["ticket-1"]?.status).toBe("open");
      // The next dispatch delivers the stranded ticket first; the delegate replies to both.
      await call(second, second.front, "agent_dispatch", {
        type: TYPE,
        title: "Invoice job 8",
        detail: REQUEST,
        wait: true,
      });
      const tickets = (await board(second)).tickets;
      expect(tickets["ticket-1"]).toMatchObject({ delivered: true });
      expect(tickets["ticket-2"]).toMatchObject({ status: "done", result: DELEGATE_RESULT });
    } finally {
      await second.close();
    }
  });
});
