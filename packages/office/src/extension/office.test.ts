/**
 * The office extension's tests (RASF-3109).
 *
 * Everything runs offline and deterministically: a scripted provider stands in for the model, the
 * board and the harness are real SQLite files so a restart is a real restart, and nothing touches the
 * network. Two fixture roles live in one harness — a delegator and a delegate — because routing by
 * type is only a claim about two agents, and the relay delivers into the accepting role's own
 * conversation. The two office extensions carry distinct names (`settings.name`), since Pi Durable
 * selects extensions by name and one office co-hosts both.
 *
 * The crash test follows the relay's own restart pattern: a transport that throws at a named kill
 * point is what a process death does to the ledger — nothing is caught and settled, so the row stays
 * non-terminal and `recover` finds it. Nothing here kills a process.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, Message } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  type Conversation,
  defineExtension,
  defineTool,
  type Extension,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { AgentManifest } from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { type Office, openOffice } from "../adapter/index.js";
import type { Board } from "../board/index.js";
import { createWorkboard } from "../board/testing.js";
import { openGuards } from "../relay/guards.js";
import type { RelayProvenance } from "../relay/message.js";
import { createRelay, type Relay, type RelayRole, relayTicketKey } from "../relay/relay.js";
import {
  type DeliveryHandle,
  type DeliveryTarget,
  harnessTransport,
  type RelayTransport,
} from "../relay/transport.js";
import {
  type ScriptedModel,
  type ScriptedScript,
  scriptedProvider,
} from "../testing/scripted-model.js";
import {
  OFFICE_EXTENSION_NAME,
  OFFICE_SECTION_KEY,
  OFFICE_TOOL_NAMES,
  type OfficeExtensionSettings,
  type OfficeToolCall,
  officeExtension,
  TEAM_SECTION_KEY,
} from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function DIRECTORY(): string {
  const directory = mkdtempSync(join(tmpdir(), "officehum-office-"));
  temps.push(directory);
  return directory;
}

/** The delegator: it accepts `booking.request` and hands `invoice.create` on. */
const FRONT = "frontdesk";
const FRONT_TYPE = "booking.request";
/** The delegate: it accepts `invoice.create`. */
const BOOK = "bookkeeper";
const TYPE = "invoice.create";
const UNKNOWN_TYPE = "mystery.thing";

const REQUEST = "Please invoice job 42.";
const DELEGATE_RESULT = "Invoice 42 is paid.";
const DELEGATOR_FINAL = "Handed it on.";
/** Deliberately NOT the result: what the delegate says in chat is not what it replied with. */
const DELEGATE_CHATTER = "Replied on the ticket — see agent_reply for the answer.";
const PROVENANCE: RelayProvenance = {
  origin: "internal",
  sourceChannel: "chat",
  sourceContact: "desk",
};
/** The conversation the delegator thinks in. */
const FRONT_ROOT = "frontdesk.root";

/** The tool call the direct-call tests replay; the same three fields are the dedupe key. */
const OFFICE_CALL = {
  conversationId: 7,
  taskId: 11,
  callId: "call-1",
} as unknown as OfficeToolCall;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A minimal, valid `officehum.json`: only `id`, `name` and `accepts` are read by the extension. */
function manifestOf(
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

const FRONT_MANIFEST = manifestOf(FRONT, "Front Desk", [
  { type: FRONT_TYPE, description: "Take a booking request" },
]);
const BOOK_MANIFEST = manifestOf(BOOK, "Bookkeeper", [
  { type: TYPE, description: "Invoice a completed job" },
]);

/** The text of one transcript message, whatever shape its content is. */
function textOf(message: Message): string {
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

/** The text of every `toolName` result in a transcript. */
function resultText(messages: readonly Message[], toolName: string): string {
  return messages
    .filter((message) => message.role === "toolResult" && message.toolName === toolName)
    .map(textOf)
    .join("\n");
}

/** What one direct tool call returned, narrowed enough to assert on. */
type CallResult = {
  readonly isError?: boolean | undefined;
  readonly output?: readonly { readonly type: string; readonly text?: string }[] | undefined;
  readonly details?: unknown;
};

/** The tool of one extension by name. */
function toolOf(extension: Extension, name: string): ToolRegistration {
  const tool = extension.tools?.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`The extension has no ${name} tool.`);
  return tool;
}

/** Call a tool the way the harness does: validate-free here, with a fabricated call identity. */
async function call(
  tool: ToolRegistration,
  args: Record<string, unknown>,
  api: OfficeToolCall,
): Promise<CallResult> {
  const execute = tool.execute as unknown as (
    args: unknown,
    api: unknown,
    context: unknown,
  ) => Promise<CallResult>;
  return await execute(args, api, BACKGROUND_CONTEXT);
}

/** The tool result's own text, for asserting on what the model was told. */
function callText(result: CallResult): string {
  return (result.output ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/** The `details` one tool call returned, as the object each tool documents. */
function detailsOf(result: CallResult): Record<string, unknown> {
  return (result.details ?? {}) as Record<string, unknown>;
}

/**
 * The script both fixture roles run. A relayed ticket means the delegate's conversation: it answers
 * with `agent_reply`. Otherwise the delegator asks for the work, then finishes its turn once the
 * dispatch's result comes back.
 */
function delegatingScript(dispatch?: JsonObject): ScriptedScript {
  return (messages) => {
    const relayed = messages.find(
      (message) => message.role === "user" && textOf(message).includes("TICKET "),
    );
    if (relayed !== undefined) {
      if (
        messages.some(
          (message) => message.role === "toolResult" && message.toolName === "agent_reply",
        )
      ) {
        return { text: DELEGATE_CHATTER };
      }
      const ticketId = /TICKET (\S+)/.exec(textOf(relayed))?.[1] ?? "";
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
          args: dispatch ?? {
            type: TYPE,
            title: "Invoice job 42",
            detail: REQUEST,
            wait: true,
          },
        },
      ],
    };
  };
}

/** A role's own extension: one tool and one section naming the role, so it is visible in a request. */
function fixtureRole(roleKey: string): Extension {
  return defineExtension({
    name: `fixture.${roleKey}`,
    sections: [section("fixture_role", () => roleKey)],
    tools: [
      defineTool({
        name: `fixture_note_${roleKey.replaceAll("-", "_")}`,
        description: "Record a note about the work in hand.",
        parameters: Type.Object({ note: Type.String() }, { additionalProperties: false }),
        replay: "safe",
        execute: async (args) => ({
          output: [{ type: "text" as const, text: `noted: ${args.note}` }],
        }),
      }),
    ],
  });
}

/** Where a test asks the transport to crash. */
type KillPoints = {
  beforeDelivery: boolean;
  beforeSettlement: boolean;
};

interface Fixture {
  readonly board: Board;
  readonly office: Office;
  readonly relay: Relay;
  readonly scripted: ScriptedModel;
  readonly front: Extension;
  readonly book: Extension;
  readonly kill: KillPoints;
  /** The delegator's own conversation, where its model runs. */
  readonly frontConversation: Conversation;
  /** Open a second board, office and relay over the same two files. */
  reopen(): Promise<Fixture>;
  close(): Promise<void>;
}

/** The one office a test needs: two roles, a board, a harness and a relay over them. */
async function openFixture(options: {
  readonly directory: string;
  readonly script: ScriptedScript;
  /** Reuse a provider across a reopen, so the request recording carries over. */
  readonly scripted?: ScriptedModel;
  readonly frontSettings?: Partial<OfficeExtensionSettings>;
  /** Set before any delivery, so the relay's conversations carry the office tools. */
  readonly bookSettings?: Partial<OfficeExtensionSettings>;
}): Promise<Fixture> {
  const scripted = options.scripted ?? scriptedProvider(options.script);
  const board = createWorkboard(join(options.directory, "office.sqlite"));
  const office = await openOffice({
    storage: { sqlite: join(options.directory, "harness.sqlite") },
    models: scripted.models,
  });

  // The relay resolves a role's agent settings when it creates that role's conversation, so the two
  // office extensions can be built after the relay exists — which they must be, because they wait on it.
  const roleAgents = new Map<string, AgentChange>();
  const routing: RelayRole[] = [
    {
      roleKey: FRONT,
      accepts: [FRONT_TYPE],
      get agent(): AgentChange {
        return roleAgents.get(FRONT) ?? {};
      },
    },
    {
      roleKey: BOOK,
      accepts: [TYPE],
      get agent(): AgentChange {
        return roleAgents.get(BOOK) ?? {};
      },
    },
  ];

  const inner = harnessTransport(office);
  const kill: KillPoints = { beforeDelivery: false, beforeSettlement: false };
  const transport: RelayTransport = {
    kind: "harness",
    async deliver(target: DeliveryTarget, message): Promise<DeliveryHandle> {
      if (kill.beforeDelivery) throw new Error("simulated crash before delivery");
      const handle = await inner.deliver(target, message);
      return {
        id: handle.id,
        async wait() {
          if (kill.beforeSettlement) throw new Error("simulated crash during the delegate's run");
          return await handle.wait();
        },
      };
    },
    reacquire: (target) => inner.reacquire(target),
  };

  const relay = createRelay({
    office,
    board,
    transport,
    routing,
    guards: openGuards(),
    now: () => Date.now(),
  });

  const people = [FRONT_MANIFEST, BOOK_MANIFEST];
  const front = officeExtension({
    board,
    relay,
    role: FRONT,
    people,
    settings: { provenance: PROVENANCE, name: OFFICE_EXTENSION_NAME, ...options.frontSettings },
  });
  const book = officeExtension({
    board,
    relay,
    role: BOOK,
    people,
    settings: {
      provenance: PROVENANCE,
      name: `${OFFICE_EXTENSION_NAME}.${BOOK}`,
      ...options.bookSettings,
    },
  });

  const frontRole = fixtureRole(FRONT);
  const bookRole = fixtureRole(BOOK);
  office.install({ extensions: [frontRole, front, bookRole, book], agent: {} });
  roleAgents.set(FRONT, { extensions: [frontRole, front], model: scripted.model });
  roleAgents.set(BOOK, { extensions: [bookRole, book], model: scripted.model });

  const frontAgent = roleAgents.get(FRONT);
  if (frontAgent === undefined) throw new Error("The delegator's agent settings are missing.");
  const frontConversation = await office.conversation(FRONT_ROOT, { agent: frontAgent });

  const fixture: Fixture = {
    board,
    office,
    relay,
    scripted,
    front,
    book,
    kill,
    frontConversation,
    async reopen() {
      return await openFixture({ ...options, scripted });
    },
    async close() {
      await office.close();
      board.close();
    },
  };
  return fixture;
}

/** The first ticket of `type` on the board, waiting for the tool that creates it to have run. */
async function waitForTicket(board: Board, type: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [ticket] = board.list({ type });
    if (ticket !== undefined) return ticket.id;
    await sleep(20);
  }
  throw new Error(`No ${type} ticket appeared within 10s.`);
}

/** The wait's own task, once the tool that blocked on it has recorded it. */
async function waitForWaitRecord(board: Board, ticketId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (board.relay.wait(ticketId) !== undefined) return;
    await sleep(20);
  }
  throw new Error(`No wait was recorded for ${ticketId} within 10s.`);
}

/** Poll the relay until the ticket is terminal, so a `wait: true` call that is already running returns. */
async function deliverUntilDone(fixture: Fixture, ticketId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await fixture.relay.pollOnce();
    const ticket = fixture.board.get(ticketId);
    if (ticket !== undefined && (ticket.status === "done" || ticket.status === "cancelled")) return;
    await sleep(25);
  }
  throw new Error(`Ticket ${ticketId} never finished within 10s.`);
}

/** A board ticket's own state, or a loud failure — a helper, not a silent `undefined`. */
function ticketOf(board: Board, id: string): NonNullable<ReturnType<Board["get"]>> {
  const ticket = board.get(id);
  if (ticket === undefined) throw new Error(`No ticket ${id}.`);
  return ticket;
}

describe("the office extension", () => {
  it("adds exactly the office tools to a role's own tools, and nothing else", async () => {
    const fixture = await openFixture({
      directory: DIRECTORY(),
      script: () => ({ text: "Ready." }),
    });
    try {
      // The extension's own shape: three tools, two sections (team, then office), and no hooks,
      // tasks or wraps when the caller supplies none.
      expect(fixture.front.tools?.map((tool) => tool.name)).toEqual([...OFFICE_TOOL_NAMES]);
      expect(fixture.front.sections?.map((entry) => entry.key)).toEqual([
        TEAM_SECTION_KEY,
        OFFICE_SECTION_KEY,
      ]);
      expect(fixture.front.hooks ?? []).toHaveLength(0);
      expect(fixture.front.tasks ?? []).toHaveLength(0);
      expect(fixture.front.wraps ?? []).toHaveLength(0);

      // And what the model is actually offered: the role's own tool, then the office's three.
      const submission = await fixture.office.submit(fixture.frontConversation, {
        input: "Anything for me?",
        requestId: "req-tools",
      });
      await submission.wait(BACKGROUND_CONTEXT);

      const offered = fixture.scripted.requests[0]?.tools.map((tool) => tool.name) ?? [];
      expect(offered).toEqual(["fixture_note_frontdesk", ...OFFICE_TOOL_NAMES]);
    } finally {
      await fixture.close();
    }
  });

  it("lists the accepted types and their descriptions in the team section", async () => {
    const fixture = await openFixture({
      directory: DIRECTORY(),
      script: () => ({ text: "Ready." }),
    });
    try {
      const submission = await fixture.office.submit(fixture.frontConversation, {
        input: "Anything for me?",
        requestId: "req-team",
      });
      await submission.wait(BACKGROUND_CONTEXT);

      const team = fixture.scripted.requests[0]?.sections[TEAM_SECTION_KEY] ?? "";
      expect(team).toContain(TYPE);
      expect(team).toContain("Invoice a completed job");
      expect(team).toContain(BOOK);
      // The agent's own work is not a colleague's, so its own type is not in the list.
      expect(team).not.toContain(FRONT_TYPE);
    } finally {
      await fixture.close();
    }
  });
});

describe("agent_dispatch", () => {
  it("hands the work to the role that accepts the ticket type, and wait returns the reply", async () => {
    const fixture = await openFixture({ directory: DIRECTORY(), script: delegatingScript() });
    try {
      const submission = await fixture.office.submit(fixture.frontConversation, {
        input: REQUEST,
        requestId: "req-hand-off",
      });
      const ticketId = await waitForTicket(fixture.board, TYPE);
      await fixture.relay.pollOnce();
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      expect(settled.status).toBe("done");

      // The relay delivered the ticket into the accepting role's own conversation, once.
      const [delivery] = fixture.board.relay.deliveriesForTicket(ticketId);
      expect(delivery?.targetKey).toBe(relayTicketKey(BOOK, ticketId));
      expect(delivery?.state).toBe("settled");
      // The ledger records the delegated turn's answer; the delegator gets the reply's result
      // (asserted below). They differ on purpose, so this test cannot pass by the two coinciding.
      expect(delivery?.outcome).toBe(DELEGATE_CHATTER);
      expect(fixture.board.relay.deliveriesForTicket(ticketId)).toHaveLength(1);

      // The delegate took the ticket and completed it.
      const ticket = ticketOf(fixture.board, ticketId);
      expect(ticket.status).toBe("done");
      expect(ticket.assignee).toBe(BOOK);

      // The delegator's own tool returned the delegate's answer.
      const messages = (await fixture.frontConversation.context(BACKGROUND_CONTEXT)).messages;
      expect(resultText(messages, "agent_dispatch")).toContain(DELEGATE_RESULT);
      // And it is a board fact, not a string the wait happened to find in a transcript.
      expect(ticketOf(fixture.board, ticketId).result).toBe(DELEGATE_RESULT);
    } finally {
      await fixture.close();
    }
  });

  it("refuses an unknown ticket type and names the ones the office accepts", async () => {
    const fixture = await openFixture({
      directory: DIRECTORY(),
      script: () => ({ text: "unused" }),
    });
    try {
      const result = await call(
        toolOf(fixture.front, "agent_dispatch"),
        { type: UNKNOWN_TYPE, title: "Something odd", detail: "Nobody knows." },
        OFFICE_CALL,
      );
      expect(result.isError).toBe(true);
      expect(callText(result)).toContain(UNKNOWN_TYPE);
      expect(callText(result)).toContain(TYPE);
      // The refusal is the tool's, not the relay's fallback: nothing was posted to the board at all.
      expect(fixture.board.list({ type: UNKNOWN_TYPE })).toHaveLength(0);
      expect(fixture.board.eventsAfter(0)).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it("creates exactly one ticket when the same call is retried", async () => {
    const fixture = await openFixture({
      directory: DIRECTORY(),
      script: () => ({ text: "unused" }),
    });
    try {
      const dispatch = toolOf(fixture.front, "agent_dispatch");
      const args = { type: TYPE, title: "Invoice job 42", detail: REQUEST };
      const first = await call(dispatch, args, OFFICE_CALL);
      const second = await call(dispatch, args, OFFICE_CALL);
      expect(first.isError).toBeUndefined();
      expect(second.isError).toBeUndefined();
      expect(detailsOf(second).ticketId).toBe(detailsOf(first).ticketId);
      expect(fixture.board.list({ type: TYPE })).toHaveLength(1);
      expect(fixture.board.eventsAfter(0)).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("makes a dispatch a child of the ticket the agent is working on", async () => {
    let parentId: string | undefined;
    const fixture = await openFixture({
      directory: DIRECTORY(),
      script: () => ({ text: "unused" }),
      frontSettings: { parentOf: () => parentId },
    });
    try {
      parentId = fixture.board.create(
        {
          type: FRONT_TYPE,
          title: "A customer wants a slot",
          detail: "From the website.",
          createdBy: "website",
          provenance: {
            origin: "external",
            sourceChannel: "email",
            sourceContact: "c@example.com",
          },
        },
        "root-booking",
      ).id;

      const result = await call(
        toolOf(fixture.front, "agent_dispatch"),
        { type: TYPE, title: "Invoice the completed job", detail: REQUEST },
        OFFICE_CALL,
      );
      const child = ticketOf(fixture.board, String(detailsOf(result).ticketId));
      expect(child.parentId).toBe(parentId);
      // The child inherits the external origin, not this office's internal one: a customer's words
      // stay fenced wherever the work is handed on.
      expect(fixture.board.provenance(child.id)?.origin).toBe("external");
    } finally {
      await fixture.close();
    }
  });
});

describe("agent_reply", () => {
  it("takes a ticket the relay delivered and completes it", async () => {
    const fixture = await openFixture({
      directory: DIRECTORY(),
      script: () => ({ text: "unused" }),
    });
    try {
      const ticket = fixture.board.create(
        {
          type: TYPE,
          title: "Invoice job 42",
          detail: REQUEST,
          createdBy: FRONT,
          provenance: PROVENANCE,
        },
        "reply-1",
      );
      expect(ticket.status).toBe("open");

      const result = await call(
        toolOf(fixture.book, "agent_reply"),
        { ticketId: ticket.id, result: DELEGATE_RESULT },
        OFFICE_CALL,
      );
      expect(result.isError).toBeUndefined();
      const done = ticketOf(fixture.board, ticket.id);
      expect(done.status).toBe("done");
      expect(done.assignee).toBe(BOOK);
      expect(fixture.board.events(ticket.id).map((event) => event.kind)).toEqual([
        "created",
        "claimed",
        "completed",
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("refuses a ticket another agent holds, and leaves it standing", async () => {
    const fixture = await openFixture({
      directory: DIRECTORY(),
      script: () => ({ text: "unused" }),
    });
    try {
      const ticket = fixture.board.create(
        {
          type: TYPE,
          title: "Invoice job 42",
          detail: REQUEST,
          createdBy: "office",
          provenance: PROVENANCE,
        },
        "reply-2",
      );
      fixture.board.claim(ticket.id, FRONT);

      const result = await call(
        toolOf(fixture.book, "agent_reply"),
        { ticketId: ticket.id, result: "Not mine to finish." },
        OFFICE_CALL,
      );
      expect(result.isError).toBe(true);
      // The board's own refusal, surfaced rather than swallowed.
      expect(callText(result)).toContain("unauthorized");
      expect(callText(result)).toContain(FRONT);

      const after = ticketOf(fixture.board, ticket.id);
      expect(after.status).toBe("claimed");
      expect(after.assignee).toBe(FRONT);
      expect(fixture.board.events(ticket.id).map((event) => event.kind)).toEqual([
        "created",
        "claimed",
      ]);
    } finally {
      await fixture.close();
    }
  });
});

describe("agent_inbox", () => {
  it("lists the tickets waiting for the agent, and the answers to the ones it opened", async () => {
    const fixture = await openFixture({ directory: DIRECTORY(), script: delegatingScript() });
    try {
      // One this agent opened, whose answer has come back: it dispatches and waits for the delegate.
      const waiting = call(
        toolOf(fixture.front, "agent_dispatch"),
        { type: TYPE, title: "Invoice job 42", detail: REQUEST, wait: true },
        OFFICE_CALL,
      );
      const openedId = await waitForTicket(fixture.board, TYPE);
      await deliverUntilDone(fixture, openedId);
      const opened = await waiting;
      expect(detailsOf(opened).answer).toBe(DELEGATE_RESULT);

      // One ticket assigned to this agent, and one nobody needs it for. Both are created after the
      // relay has caught up, so its polling never touches them.
      const assigned = fixture.board.create(
        {
          type: FRONT_TYPE,
          title: "Reconcile the account",
          detail: "Before the month end.",
          createdBy: "office",
          provenance: PROVENANCE,
        },
        "inbox-assigned",
      );
      fixture.board.assign(assigned.id, { kind: "agent", id: FRONT }, "office");
      fixture.board.create(
        {
          type: TYPE,
          title: "Someone else's work",
          detail: "Unassigned.",
          createdBy: "office",
          provenance: PROVENANCE,
        },
        "inbox-other",
      );

      const inbox = await call(toolOf(fixture.front, "agent_inbox"), {}, OFFICE_CALL);
      const ids = (detailsOf(inbox).tickets as readonly { id: string }[]).map((entry) => entry.id);
      expect(ids).toContain(assigned.id);
      expect(ids).toContain(openedId);
      expect(ids).toHaveLength(2);
      expect(callText(inbox)).toContain("assigned to you");
      expect(callText(inbox)).toContain("(opened)");
      expect(callText(inbox)).toContain(`result: ${DELEGATE_RESULT}`);

      // A status filter narrows it, and an empty answer is an answer.
      const claimed = await call(
        toolOf(fixture.front, "agent_inbox"),
        { status: "claimed" },
        OFFICE_CALL,
      );
      const claimedIds = (detailsOf(claimed).tickets as readonly { id: string }[]).map(
        (entry) => entry.id,
      );
      expect(claimedIds).toEqual([assigned.id]);

      const cancelled = await call(
        toolOf(fixture.front, "agent_inbox"),
        { status: "cancelled" },
        OFFICE_CALL,
      );
      expect(detailsOf(cancelled).tickets).toEqual([]);
      expect(callText(cancelled)).toContain("cancelled");
    } finally {
      await fixture.close();
    }
  });

  it("reads without changing the board", async () => {
    const fixture = await openFixture({
      directory: DIRECTORY(),
      script: () => ({ text: "unused" }),
    });
    try {
      const ticket = fixture.board.create(
        {
          type: TYPE,
          title: "Reconcile the account",
          detail: "Before the month end.",
          createdBy: FRONT,
          provenance: PROVENANCE,
        },
        "inbox-read-only",
      );
      const before = fixture.board.eventsAfter(0).length;

      await call(toolOf(fixture.front, "agent_inbox"), {}, OFFICE_CALL);

      expect(fixture.board.eventsAfter(0)).toHaveLength(before);
      expect(ticketOf(fixture.board, ticket.id).status).toBe("open");
    } finally {
      await fixture.close();
    }
  });
});

describe("a crash during the wait", () => {
  it("resumes the wait and the result arrives exactly once", async () => {
    const directory = DIRECTORY();
    const fixture = await openFixture({ directory, script: delegatingScript() });

    // The delegator dispatches and blocks on the durable wait.
    const waiting = call(
      toolOf(fixture.front, "agent_dispatch"),
      { type: TYPE, title: "Invoice job 42", detail: REQUEST, wait: true },
      OFFICE_CALL,
    );
    void waiting.catch(() => undefined);
    const ticketId = await waitForTicket(fixture.board, TYPE);
    await waitForWaitRecord(fixture.board, ticketId);

    // The process dies before the delegate is ever delivered to: the row is written and the cursor
    // moved, so the event is still visible as a non-terminal row and nothing was delivered.
    fixture.kill.beforeDelivery = true;
    await expect(fixture.relay.pollOnce()).rejects.toThrow(/simulated crash/);
    const [crashed] = fixture.board.relay.deliveriesForTicket(ticketId);
    expect(crashed?.state).toBe("pending");
    expect(fixture.board.relay.cursor()).toBe(crashed?.seq ?? -1);
    expect(ticketOf(fixture.board, ticketId).status).toBe("open");
    await fixture.close();

    // The restart resumes the wait's own task, not a new one, and the delegate runs once.
    const reopened = await fixture.reopen();
    try {
      await reopened.relay.recover();
      const rows = reopened.board.relay.deliveriesForTicket(ticketId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("settled");
      expect(rows[0]?.outcome).toBe(DELEGATE_CHATTER);
      const done = ticketOf(reopened.board, ticketId);
      expect(done.status).toBe("done");
      expect(
        reopened.board.events(ticketId).filter((event) => event.kind === "completed"),
      ).toHaveLength(1);

      const first = await reopened.relay.wait(ticketId, { timeoutMs: 10_000 });
      const second = await reopened.relay.wait(ticketId, { timeoutMs: 10_000 });
      expect(first).toEqual({
        ok: true,
        ticketId,
        status: "completed",
        answer: DELEGATE_RESULT,
      });
      expect(second).toEqual(first);
      // One ticket, one delivery, one completion: the answer arrived exactly once.
      expect(reopened.board.list({ type: TYPE })).toHaveLength(1);
      expect(reopened.board.relay.deliveriesForTicket(ticketId)).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });
});
