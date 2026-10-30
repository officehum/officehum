import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { contactTools } from "./contacts.js";
import type { Calendar } from "./index.js";
import frontdesk, { MessagesDoc } from "./index.js";
import {
  type DeliveryReceipt,
  deliverableChannel,
  firstContactCondition,
  type MessageIntent,
  type Messenger,
  messagingTools,
} from "./messaging.js";

const calendar: Calendar = {
  freeSlots: async () => [],
  listBookings: async () => [],
  book: async () => {
    throw new Error("not used");
  },
  reschedule: async () => {
    throw new Error("not used");
  },
  cancel: async () => {
    throw new Error("not used");
  },
};

const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close(BACKGROUND_CONTEXT)));
});

function testMessenger(identity = "test.transport.v1") {
  const effects: Array<{ intent: MessageIntent; requestId: string }> = [];
  const messenger: Messenger = {
    identity,
    async send(intent, options): Promise<DeliveryReceipt> {
      effects.push({ intent: { ...intent }, requestId: options.requestId });
      return { id: `receipt-${options.requestId}`, status: "accepted" };
    },
  };
  return { messenger, effects };
}

describe("Front Desk messaging", () => {
  it("asks once for the first successful tuple and commits exact portable history", async () => {
    const { messenger, effects } = testMessenger();
    const requests: Array<{ approvalId: string; arguments: Readonly<Record<string, unknown>> }> =
      [];
    const role = frontdesk({
      calendar,
      messenger,
      approve: async (request) => {
        requests.push({ approvalId: request.approvalId, arguments: request.arguments });
        return { approved: true, by: "operator" };
      },
    });
    const provider = fauxProvider({ provider: "messaging-test", models: [{ id: "model" }] });
    const first = {
      contactId: "contact-1",
      channel: "email",
      to: "guest@example.test",
      text: "Appointment confirmed.\nThank you.",
      messengerId: "test.transport.v1",
    } as const;
    provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall("create_contact", { name: "Guest", email: "guest@example.test" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("send_message", first), { stopReason: "toolUse" }),
      fauxAssistantMessage(
        fauxToolCall("send_message", { ...first, text: "A known-target follow-up." }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Finished"),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    const registry = createRegistry();
    for (const extension of role.extensions) registry.install(extension);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      BACKGROUND_CONTEXT,
    );
    harnesses.push(harness);
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { ...role.agent, model: { provider: "messaging-test", modelId: "model" } },
    });

    const submission = await root.submit(
      { type: "input", content: "Create and message Guest" },
      BACKGROUND_CONTEXT,
    );
    expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(requests).toEqual([
      {
        approvalId: "confirm_contact_creation",
        arguments: { name: "Guest", email: "guest@example.test" },
      },
      { approvalId: "first_contact", arguments: first },
    ]);
    expect(effects.map(({ intent }) => intent)).toEqual([
      { to: first.to, channel: first.channel, text: first.text },
      { to: first.to, channel: first.channel, text: "A known-target follow-up." },
    ]);
    expect(await harness.snapshot(MessagesDoc, BACKGROUND_CONTEXT)).toMatchObject({
      messages: [
        {
          messengerId: first.messengerId,
          contactId: first.contactId,
          contactRevision: 1,
          contactName: "Guest",
          to: first.to,
          channel: first.channel,
          text: first.text,
          delivery: { status: "accepted" },
        },
        { text: "A known-target follow-up.", delivery: { status: "accepted" } },
      ],
    });
  });

  it("gates concurrent first-contact calls independently before either success is visible", async () => {
    const { messenger, effects } = testMessenger();
    let approvals = 0;
    let releaseApprovals!: () => void;
    const bothApprovals = new Promise<void>((resolve) => {
      releaseApprovals = resolve;
    });
    const role = frontdesk({
      calendar,
      messenger,
      approve: async (request) => {
        if (request.approvalId !== "first_contact") return { approved: true };
        approvals += 1;
        if (approvals === 2) releaseApprovals();
        await bothApprovals;
        return { approved: true, by: "operator" };
      },
    });
    const provider = fauxProvider({ provider: "concurrent-messaging", models: [{ id: "model" }] });
    const base = {
      contactId: "contact-1",
      channel: "email",
      to: "guest@example.test",
      messengerId: messenger.identity,
    } as const;
    provider.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("send_message", { ...base, text: "First concurrent message" }),
          fauxToolCall("send_message", { ...base, text: "Second concurrent message" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Finished"),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    const registry = createRegistry();
    for (const extension of role.extensions) registry.install(extension);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      BACKGROUND_CONTEXT,
    );
    harnesses.push(harness);
    const create = contactTools().find((tool) => tool.name === "create_contact");
    if (create === undefined) throw new Error("missing create_contact");
    await create.execute(
      { name: "Guest", email: "guest@example.test" },
      {
        conversationId: 100,
        taskId: 100,
        callId: "seed",
        commit: harness.commit.bind(harness),
        snapshot: harness.snapshot.bind(harness),
      } as never,
      BACKGROUND_CONTEXT,
    );
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { ...role.agent, model: { provider: "concurrent-messaging", modelId: "model" } },
    });

    const submission = await root.submit(
      { type: "input", content: "Send both messages" },
      BACKGROUND_CONTEXT,
    );
    expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(approvals).toBe(2);
    expect(effects.map(({ intent }) => intent.text).sort()).toEqual([
      "First concurrent message",
      "Second concurrent message",
    ]);
    expect((await harness.snapshot(MessagesDoc, BACKGROUND_CONTEXT))?.messages).toHaveLength(2);
  });

  it("blocks a missing or declined first-contact approval with no effect or history", async () => {
    for (const approval of [undefined, async () => ({ approved: false })] as const) {
      const { messenger, effects } = testMessenger();
      const role = frontdesk({
        calendar,
        messenger,
        ...(approval === undefined ? {} : { approve: approval }),
      });
      const providerId = `blocked-${approval === undefined ? "missing" : "denied"}`;
      const provider = fauxProvider({ provider: providerId, models: [{ id: "model" }] });
      provider.setResponses([
        fauxAssistantMessage(
          fauxToolCall("send_message", {
            contactId: "contact-1",
            channel: "email",
            to: "guest@example.test",
            text: "Blocked",
            messengerId: messenger.identity,
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Blocked"),
      ]);
      const models = createModels();
      models.setProvider(provider.provider);
      const registry = createRegistry();
      for (const extension of role.extensions) registry.install(extension);
      const harness = await Harness.open(
        new MemoryStorage(),
        { models, registry },
        BACKGROUND_CONTEXT,
      );
      harnesses.push(harness);
      const create = contactTools().find((tool) => tool.name === "create_contact");
      if (create === undefined) throw new Error("missing create_contact");
      await create.execute(
        { name: "Guest", email: "guest@example.test" },
        {
          conversationId: 100,
          taskId: 100,
          callId: "seed",
          commit: harness.commit.bind(harness),
          snapshot: harness.snapshot.bind(harness),
        } as never,
        BACKGROUND_CONTEXT,
      );
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: { ...role.agent, model: { provider: providerId, modelId: "model" } },
      });
      const submission = await root.submit({ type: "input", content: "Send" }, BACKGROUND_CONTEXT);
      await submission.wait(BACKGROUND_CONTEXT);
      expect(effects).toEqual([]);
      expect(await harness.snapshot(MessagesDoc, BACKGROUND_CONTEXT)).toBeUndefined();
    }
  });

  it("pins the exact intent, returns committed history on replay, and rejects changed call arguments", async () => {
    const { messenger, effects } = testMessenger();
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    harnesses.push(harness);
    const create = contactTools().find((tool) => tool.name === "create_contact");
    const send = messagingTools(messenger).find((tool) => tool.name === "send_message");
    if (create === undefined || send === undefined) throw new Error("missing messaging tools");
    const memos = new Map<string, unknown>();
    const api = {
      conversationId: 1,
      taskId: 2,
      callId: "call-1",
      commit: harness.commit.bind(harness),
      snapshot: harness.snapshot.bind(harness),
      memo: async (name: string, ...rest: unknown[]) => {
        if (rest.length === 2 && !memos.has(name)) memos.set(name, rest[0]);
        return memos.get(name);
      },
    } as unknown as ToolExecutionApi;
    await create.execute(
      { name: "Guest", email: "guest@example.test" },
      { ...api, callId: "seed" } as never,
      BACKGROUND_CONTEXT,
    );
    const args = {
      contactId: "contact-1",
      channel: "email",
      to: "guest@example.test",
      text: "Exact\ntext\tkept",
      messengerId: messenger.identity,
    } as const;
    const first = await send.execute(args, api, BACKGROUND_CONTEXT);
    const replay = await send.execute(args, api, BACKGROUND_CONTEXT);
    expect(first.details).toMatchObject({
      replayed: false,
      text: args.text,
      delivery: { status: "accepted" },
    });
    expect(replay.details).toMatchObject({
      replayed: true,
      text: args.text,
      delivery: first.details?.delivery,
    });
    expect(effects).toHaveLength(1);
    await expect(
      send.execute({ ...args, text: "changed" }, api, BACKGROUND_CONTEXT),
    ).rejects.toThrow(/different arguments/i);
  });

  it("rejects invalid explicit targets and missing transports before effects", async () => {
    const { messenger, effects } = testMessenger();
    const send = messagingTools(messenger).find((tool) => tool.name === "send_message");
    if (send === undefined) throw new Error("missing send_message");
    const api = { conversationId: 1, taskId: 2, callId: "bad" } as ToolExecutionApi;
    for (const args of [
      {
        contactId: " contact-1",
        channel: "email",
        to: "guest@example.test",
        text: "Hi",
        messengerId: messenger.identity,
      },
      {
        contactId: "contact-1",
        channel: "email",
        to: "GUEST@example.test",
        text: "Hi",
        messengerId: messenger.identity,
      },
      {
        contactId: "contact-1",
        channel: "sms",
        to: "555-1234",
        text: "Hi",
        messengerId: messenger.identity,
      },
      {
        contactId: "contact-1",
        channel: "email",
        to: "guest@example.test",
        text: " \n ",
        messengerId: messenger.identity,
      },
      {
        contactId: "contact-1",
        channel: "email",
        to: "guest@example.test",
        text: "bad\u0000",
        messengerId: messenger.identity,
      },
      {
        contactId: "contact-1",
        channel: "email",
        to: "guest@example.test",
        text: "Hi",
        messengerId: "other.transport",
      },
    ] as const) {
      await expect(send.execute(args as never, api, BACKGROUND_CONTEXT)).rejects.toThrow();
    }
    expect(effects).toEqual([]);
    const missing = messagingTools().find((tool) => tool.name === "send_message");
    if (missing === undefined) throw new Error("missing send_message");
    await expect(
      missing.execute(
        {
          contactId: "contact-1",
          channel: "email",
          to: "guest@example.test",
          text: "Hi",
          messengerId: "none",
        },
        api,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow(/messenger.*configured/i);
  });

  it("requires a fresh first-contact decision when console history is reused through Resend", async () => {
    const console = testMessenger("officehum.console.v1");
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    harnesses.push(harness);
    const create = contactTools().find((tool) => tool.name === "create_contact");
    const send = messagingTools(console.messenger).find((tool) => tool.name === "send_message");
    if (create === undefined || send === undefined) throw new Error("missing messaging tools");
    const memos = new Map<string, unknown>();
    const api = {
      conversationId: 1,
      taskId: 2,
      callId: "console-history",
      commit: harness.commit.bind(harness),
      snapshot: harness.snapshot.bind(harness),
      memo: async (name: string, ...rest: unknown[]) => {
        if (rest.length === 2 && !memos.has(name)) memos.set(name, rest[0]);
        return memos.get(name);
      },
    } as unknown as ToolExecutionApi;
    await create.execute(
      { name: "Guest", email: "guest@example.test" },
      { ...api, callId: "seed" } as never,
      BACKGROUND_CONTEXT,
    );
    const base = {
      contactId: "contact-1",
      channel: "email",
      to: "guest@example.test",
      text: "Console message",
    } as const;
    await send.execute(
      { ...base, messengerId: console.messenger.identity },
      api,
      BACKGROUND_CONTEXT,
    );
    const environment = {
      read: { snapshot: harness.snapshot.bind(harness) },
    } as never;
    expect(
      await firstContactCondition(
        { ...base, text: "Follow-up", messengerId: console.messenger.identity },
        environment,
        BACKGROUND_CONTEXT,
      ),
    ).toBe(false);
    expect(
      await firstContactCondition(
        {
          ...base,
          text: "Resend message",
          messengerId: `officehum.resend.v1:${"a".repeat(64)}`,
        },
        environment,
        BACKGROUND_CONTEXT,
      ),
    ).toBe(true);
  });
});

/**
 * Outbound SMS, and the two layers that make it unreachable (RASF-3162).
 *
 * They are in one file because they fail differently and both have to hold. The schema is what a model
 * sees: a channel it cannot name is a call it cannot make, and that is the layer that keeps the
 * tempting call out of a transcript in the first place. The delivery function is what a caller does:
 * a persisted intent from an older build, a host calling a messenger itself, a helper somebody adds
 * next year. A schema is a promise made at the edge; the function is the one that keeps it.
 */
describe("outbound SMS is not a thing this role can do", () => {
  it("cannot even be expressed: the schema offers email and names sms nowhere", () => {
    const send = messagingTools().find((tool) => tool.name === "send_message");
    if (send === undefined) throw new Error("missing send_message");
    const properties = send.parameters as unknown as {
      properties: { channel: { const?: string } };
    };
    expect(properties.properties.channel).toMatchObject({ const: "email" });
    // An enum that still listed `sms` would tell a model the call exists, even with a refusal behind
    // it. The whole point of this layer is that the words are not there to be tried.
    expect(JSON.stringify(send.parameters)).not.toContain("sms");
  });

  it("is refused by the delivery function when it is handed in directly", () => {
    expect(() => deliverableChannel("sms")).toThrow(/inbound/);
    expect(deliverableChannel("email")).toBe("email");
  });

  it("never reaches a messenger, even when the call bypasses the schema", async () => {
    const { messenger, effects } = testMessenger();
    const send = messagingTools(messenger).find((tool) => tool.name === "send_message");
    if (send === undefined) throw new Error("missing send_message");
    const api = { conversationId: 1, taskId: 2, callId: "sms" } as ToolExecutionApi;
    await expect(
      send.execute(
        {
          contactId: "contact-1",
          channel: "sms",
          to: "guest@example.test",
          text: "Hello",
          messengerId: messenger.identity,
        } as never,
        api,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow(/email only/);
    expect(effects).toEqual([]);
  });
});
