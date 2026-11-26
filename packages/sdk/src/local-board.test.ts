/**
 * The local board on a bare Pi Durable harness, with no Office Hum: the shared
 * communication cases the office extension also passes, then the local board's own delivery and
 * restart cases. A scripted model stands in for the model; nothing touches the network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
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
import { obj, str } from "@earendil-works/pi-schema";
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
import {
  LOCAL_ABOUT_REFUSAL,
  LOCAL_BOARD_DOC,
  type LocalTicket,
  localBoardExtension,
} from "./local-board.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * A scripted model: each request is answered by `script` from the transcript. A script may answer
 * later (a promise), and is given the request's abort signal, so a turn can be held open across a
 * harness close.
 */
type Script = (
  messages: readonly Message[],
  signal: AbortSignal | undefined,
) => CaseTurn | Promise<CaseTurn>;

function scripted(script: Script) {
  const faux = fauxProvider({
    provider: "scripted",
    api: "scripted",
    models: [{ id: "scripted-1" }],
  });
  const respond: FauxResponseFactory = async (context, options, _state, model) => {
    faux.appendResponses([respond]);
    const turn = await script(context.messages, options?.signal);
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
        parameters: obj({ note: str() }),
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
  script: Script = delegatingScript(),
  conversationIds?: Map<string, ConversationId>,
  /** The delegate's manifest, when a test needs it to accept more than one type. */
  bookManifest = BOOK_MANIFEST,
): Promise<Office> {
  const model = scripted(script);
  const registry = createRegistry();
  const harness = await Harness.open(
    storage === "memory" ? new MemoryStorage() : await openNodeSqliteStorage(storage),
    { models: model.models, registry },
    BACKGROUND_CONTEXT,
  );
  const conversations = new Map<string, Conversation>();
  const manifests = [FRONT_MANIFEST, bookManifest];
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
    // A direct call stands for a call whose result was committed: its task ended `completed`.
    getTask: async () => ({ state: { status: "terminal", outcome: { status: "completed" } } }),
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

  it("refuses a dispatch that names subjects, and opens no ticket", async () => {
    const office = await openOffice("memory");
    try {
      const result = await call(office, office.front, "agent_dispatch", {
        type: TYPE,
        title: "Invoice job 42",
        detail: REQUEST,
        about: ["customer:quickbooks:42"],
      });
      expect(result.isError).toBe(true);
      expect(callText(result)).toBe(LOCAL_ABOUT_REFUSAL);
      expect((await board(office)).tickets).toEqual({});
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

  it("refuses the dispatcher completing its own dispatch; only the role it is routed to may", async () => {
    // The colleague's turn ends without a reply, so the ticket is still open and unheld.
    const office = await openOffice("memory", () => ({ text: "I looked at it." }));
    try {
      await call(office, office.front, "agent_dispatch", {
        type: TYPE,
        title: "Invoice job 42",
        detail: REQUEST,
        wait: true,
      });
      const [id = ""] = Object.keys((await board(office)).tickets);
      const own = await call(office, office.front, "agent_reply", {
        ticketId: id,
        result: "Done it myself.",
      });
      expect(own.isError).toBe(true);
      expect(callText(own)).toContain("The board refused the reply (unauthorized)");
      expect(callText(own)).toContain(BOOK);
      expect((await board(office)).tickets[id]).toMatchObject({
        status: "open",
        assignee: null,
        result: null,
      });

      const reply = await call(office, office.book, "agent_reply", {
        ticketId: id,
        result: DELEGATE_RESULT,
      });
      expect(reply.isError).toBeUndefined();
      expect((await board(office)).tickets[id]).toMatchObject({
        status: "done",
        assignee: BOOK,
        result: DELEGATE_RESULT,
      });
    } finally {
      await office.close();
    }
  });

  it("queues a dispatch it cannot deliver yet, and lists it in the assignee's inbox", async () => {
    const office = await openOffice("memory");
    try {
      office.conversations.delete(BOOK);
      const result = await call(office, office.front, "agent_dispatch", {
        type: TYPE,
        title: "Invoice job 42",
        detail: REQUEST,
      });
      expect(result.isError).toBeUndefined();
      expect(callText(result)).toContain(`${BOOK} has no conversation on this harness`);
      expect(callText(result)).toContain("do not dispatch it again");
      // Routed to the Bookkeeper and taken by nobody: it is waiting for the Bookkeeper.
      const inbox = await call(office, office.book, "agent_inbox", {});
      expect(callText(inbox)).toContain(`${detailsOf(result).ticketId} [open] ${TYPE}`);
      expect(callText(inbox)).toContain("(assigned to you)");
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

const DISPATCH_ARGS = { type: TYPE, title: "Invoice job 42", detail: REQUEST, wait: true };
/** A live model rewords a retry: the same type, a different title and detail. */
const REWORDED_ARGS = {
  type: TYPE,
  title: "Bill the customer for job 42",
  detail: "Job 42 is finished; send its invoice.",
  wait: true,
};
const OTHER_TYPE = "books.close";
const BOOK_WITH_TWO_TYPES = {
  ...BOOK_MANIFEST,
  accepts: [...BOOK_MANIFEST.accepts, { type: OTHER_TYPE, description: "Close the month." }],
};
const OTHER_ARGS = { type: OTHER_TYPE, title: "Close March", detail: "Month end.", wait: true };
const HANDED = "Handed it on; the dispatch was interrupted.";
const THANKS = "Thanks, I have the answer.";

/** A promise, and the hand that opens it. */
function gate(): { readonly opened: Promise<void>; open(): void } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** A model turn that never answers: it ends only when the harness closes and aborts the request. */
function held(signal: AbortSignal | undefined): Promise<CaseTurn> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("closed")), { once: true });
  });
}

const isTicketTurn = (messages: readonly Message[]) =>
  messages.some((message) => message.role === "user" && textOf(message).startsWith("TICKET "));

/**
 * The delegator: dispatches each customer message once with `wait: true` (a repeat of the customer's
 * message reworded); after a dispatch a restart interrupted, `redispatch` dispatches the same type
 * again reworded, `separate` does so with `separate_request`, `other` dispatches another type; a
 * returned answer is answered in words.
 */
function deskScript(mode: "idle" | "redispatch" | "separate" | "other") {
  const afterInterrupt = {
    idle: undefined,
    redispatch: REWORDED_ARGS,
    separate: { ...REWORDED_ARGS, separate_request: true },
    other: OTHER_ARGS,
  }[mode];
  return (messages: readonly Message[]): CaseTurn => {
    const latest = messages.findLastIndex((message) => message.role === "user");
    if (textOf(messages[latest] as Message).startsWith("ANSWER ")) return { text: THANKS };
    const dispatched = messages
      .slice(latest + 1)
      .filter((message) => message.role === "toolResult" && message.toolName === "agent_dispatch");
    const last = dispatched.at(-1);
    const asked = messages.filter(
      (message) => message.role === "user" && textOf(message) === REQUEST,
    ).length;
    if (last === undefined) {
      return {
        toolCalls: [{ name: "agent_dispatch", args: asked > 1 ? REWORDED_ARGS : DISPATCH_ARGS }],
      };
    }
    const interrupted =
      last.role === "toolResult" && last.isError === true && textOf(last).includes("interrupted");
    if (interrupted && afterInterrupt !== undefined && dispatched.length === 1) {
      return { toolCalls: [{ name: "agent_dispatch", args: afterInterrupt }] };
    }
    return { text: interrupted ? HANDED : THANKS };
  };
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const userTexts = async (conversation: Conversation) =>
  (await conversation.context(BACKGROUND_CONTEXT)).messages
    .filter((message) => message.role === "user")
    .map(textOf);

const dispatchResults = async (conversation: Conversation) =>
  (await conversation.context(BACKGROUND_CONTEXT)).messages
    .filter((message) => message.role === "toolResult" && message.toolName === "agent_dispatch")
    .map((message) => ({
      isError: message.role === "toolResult" && message.isError === true,
      text: textOf(message),
    }));

/**
 * The delegator dispatches with `wait: true` on a file harness, and the harness closes while the
 * delegate's turn is still running: the dispatch call is mid-wait, as a crash would leave it.
 */
async function interruptedHandOff(file: string): Promise<Map<string, ConversationId>> {
  let delegating = false;
  const first = await openOffice(file, (messages, signal) => {
    if (isTicketTurn(messages)) {
      delegating = true;
      return held(signal);
    }
    return deskScript("idle")(messages);
  });
  const ids = new Map(
    [...first.conversations].map(([role, conversation]) => [role, conversation.id]),
  );
  await (first.conversations.get(FRONT) as Conversation).submit(
    { type: "input", content: REQUEST, requestId: "req-1" },
    BACKGROUND_CONTEXT,
  );
  await until(async () => delegating, "the delegate's turn to start");
  expect((await board(first)).tickets["ticket-1"]?.handoff).toMatchObject({ outcome: "open" });
  await first.close();
  return ids;
}

describe("the local board after a restart", () => {
  const fileOf = () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-local-board-"));
    temps.push(directory);
    return join(directory, "harness.sqlite");
  };

  it("returns the answer to a dispatcher whose wait was interrupted as one message", async () => {
    const file = fileOf();
    const ids = await interruptedHandOff(file);
    const release = gate();
    const second = await openOffice(
      file,
      async (messages) => {
        if (isTicketTurn(messages)) {
          await release.opened;
          return delegatingScript()(messages);
        }
        return deskScript("idle")(messages);
      },
      ids,
    );
    try {
      const front = second.conversations.get(FRONT) as Conversation;
      // The customer's request is the original one: the restart settled its dispatch interrupted.
      const asked = await front.submit(
        { type: "input", content: REQUEST, requestId: "req-1" },
        BACKGROUND_CONTEXT,
      );
      await asked.wait(BACKGROUND_CONTEXT);
      // Only now does the delegate reply: the dispatcher is no longer waiting, so the reply returns
      // the answer to it.
      release.open();
      await until(
        async () => (await board(second)).tickets["ticket-1"]?.handoff?.outcome === "delivered",
        "the answer to be returned",
      );
      await until(
        async () => (await front.context(BACKGROUND_CONTEXT)).messages.at(-1)?.role === "assistant",
        "the delegator to read the answer",
      );
      const answer = `ANSWER ticket-1 — type ${TYPE}\nThis answers your earlier hand-off ticket-1 ("Invoice job 42"). Your agent_dispatch call for it was interrupted by a restart, so the answer comes to you here. Do not dispatch it again.\n${DELEGATE_RESULT}`;
      expect((await userTexts(front)).filter((text) => text.startsWith("ANSWER "))).toEqual([
        answer,
      ]);
      const results = await dispatchResults(front);
      expect(results).toHaveLength(1);
      expect(results[0]?.isError).toBe(true);
      expect(results[0]?.text).toContain("Tool agent_dispatch was interrupted");

      // A crash after the message was submitted and before it was recorded: the next writing call
      // finds the submission by its request id and submits nothing new.
      await edit(second, "ticket-1", (ticket) => ({
        ...ticket,
        handoff: {
          ...(ticket.handoff as NonNullable<LocalTicket["handoff"]>),
          outcome: "delivering",
        },
      }));
      await call(second, second.front, "agent_dispatch", {
        type: TYPE,
        title: "Invoice job 43",
        detail: "Another job.",
      });
      expect((await board(second)).tickets["ticket-1"]?.handoff?.outcome).toBe("delivered");
      expect((await userTexts(front)).filter((text) => text.startsWith("ANSWER "))).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  it("returns the same ticket when the dispatcher dispatches the same type again, reworded, after the restart", async () => {
    const file = fileOf();
    const ids = await interruptedHandOff(file);
    const release = gate();
    const second = await openOffice(
      file,
      async (messages) => {
        if (isTicketTurn(messages)) {
          await release.opened;
          return delegatingScript()(messages);
        }
        return deskScript("redispatch")(messages);
      },
      ids,
    );
    try {
      const front = second.conversations.get(FRONT) as Conversation;
      const book = second.conversations.get(BOOK) as Conversation;
      const original = (await board(second)).tickets["ticket-1"]?.handoff?.taskId;
      const asked = await front.submit(
        { type: "input", content: REQUEST, requestId: "req-1" },
        BACKGROUND_CONTEXT,
      );
      // The delegate replies once the repeat has taken the ticket over and waits on it.
      await until(
        async () => (await board(second)).tickets["ticket-1"]?.handoff?.taskId !== original,
        "the repeat to take the ticket over",
      );
      release.open();
      await asked.wait(BACKGROUND_CONTEXT);

      const tickets = (await board(second)).tickets;
      expect(Object.keys(tickets)).toEqual(["ticket-1"]);
      expect(tickets["ticket-1"]).toMatchObject({ status: "done", result: DELEGATE_RESULT });
      const results = await dispatchResults(front);
      expect(results.map((result) => result.isError)).toEqual([true, false]);
      expect(results[1]?.text).toBe(
        `You already dispatched ${TYPE} work as ticket-1 ("Invoice job 42") before a restart interrupted the call, so nothing new was dispatched. If this is a different request and not a retry of ticket-1, dispatch it again with separate_request set to true. ticket-1 is done. Answer: ${DELEGATE_RESULT}`,
      );
      // The answer came back once, as that result: no message, and one delivery to the delegate.
      expect((await userTexts(front)).filter((text) => text.startsWith("ANSWER "))).toEqual([]);
      expect((await userTexts(book)).filter((text) => text.startsWith("TICKET "))).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  for (const [mode, type, title] of [
    ["separate", TYPE, REWORDED_ARGS.title],
    ["other", OTHER_TYPE, OTHER_ARGS.title],
  ] as const) {
    it(`opens a second ticket after the restart for ${mode === "separate" ? "a same-type dispatch marked separate_request" : "a dispatch of another type"}`, async () => {
      const file = fileOf();
      const ids = await interruptedHandOff(file);
      const release = gate();
      const office = await openOffice(
        file,
        async (messages) => {
          if (isTicketTurn(messages)) {
            await release.opened;
            return delegatingScript()(messages);
          }
          return deskScript(mode)(messages);
        },
        ids,
        BOOK_WITH_TWO_TYPES,
      );
      try {
        const front = office.conversations.get(FRONT) as Conversation;
        const asked = await front.submit(
          { type: "input", content: REQUEST, requestId: "req-1" },
          BACKGROUND_CONTEXT,
        );
        // The delegate replies once the new ticket exists, so the dispatcher's first call has ended.
        await until(
          async () => (await board(office)).tickets["ticket-2"] !== undefined,
          "the new ticket",
        );
        release.open();
        await asked.wait(BACKGROUND_CONTEXT);
        await until(
          async () => (await board(office)).tickets["ticket-1"]?.handoff?.outcome === "delivered",
          "the first answer to be returned",
        );
        await until(
          async () =>
            (await front.context(BACKGROUND_CONTEXT)).messages.at(-1)?.role === "assistant",
          "the delegator to read the answer",
        );

        const tickets = (await board(office)).tickets;
        expect(Object.keys(tickets)).toEqual(["ticket-1", "ticket-2"]);
        expect(tickets["ticket-2"]).toMatchObject({ type, title, status: "done" });
        // The new work came back as its dispatch's result; the first ticket's as one message.
        const results = await dispatchResults(front);
        expect(results.map((result) => result.isError)).toEqual([true, false]);
        expect(results[1]?.text).toBe(DELEGATE_RESULT);
        const answers = (await userTexts(front)).filter((text) => text.startsWith("ANSWER "));
        expect(answers).toHaveLength(1);
        expect(answers[0]?.startsWith(`ANSWER ticket-1 — type ${TYPE}`)).toBe(true);
      } finally {
        await office.close();
      }
    });
  }

  it("opens a new ticket for a same-type dispatch once the first answer came back", async () => {
    const office = await openOffice("memory", (messages) =>
      isTicketTurn(messages) ? delegatingScript()(messages) : deskScript("idle")(messages),
    );
    try {
      const front = office.conversations.get(FRONT) as Conversation;
      for (const requestId of ["req-1", "req-2"]) {
        const asked = await front.submit(
          { type: "input", content: REQUEST, requestId },
          BACKGROUND_CONTEXT,
        );
        await asked.wait(BACKGROUND_CONTEXT);
      }
      const tickets = (await board(office)).tickets;
      expect(Object.keys(tickets)).toEqual(["ticket-1", "ticket-2"]);
      // The first was answered as its dispatch's result, which the second dispatch read as such.
      expect(tickets["ticket-1"]?.handoff?.outcome).toBe("answered");
      // The customer's repeat was dispatched reworded, with no flag: new work all the same.
      expect(tickets["ticket-2"]).toMatchObject({
        title: REWORDED_ARGS.title,
        status: "done",
        result: DELEGATE_RESULT,
      });
      // Never interrupted, never a message: each answer came back once, as the tool result.
      expect((await dispatchResults(front)).map((result) => result.text)).toEqual([
        DELEGATE_RESULT,
        DELEGATE_RESULT,
      ]);
      expect((await userTexts(front)).filter((text) => text.startsWith("ANSWER "))).toEqual([]);
    } finally {
      await office.close();
    }
  });
});
