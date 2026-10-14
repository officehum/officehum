import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type Harness, hook, InboxDoc, ToolTask } from "@earendil-works/pi-durable";
import frontdesk, { ContactsDoc, RepliesDoc } from "@officehum/frontdesk";
import { afterEach, describe, expect, it } from "vitest";
import { inboundAwareApprover, openInboundSession } from "./inbound-session.js";
import { openLocalCalendar } from "./local-calendar.js";
import {
  durableInboundReplyApprover,
  type InternalResendInbox,
  openResendInbox,
  readInboundInbox,
} from "./resend-inbox.js";
import { createResendReplyMessenger } from "./resend-replies.js";
import { openSolo } from "./solo.js";

const directories: string[] = [];
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const SECRET = `whsec_${Buffer.from("session-test-secret").toString("base64")}`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Inbound session", () => {
  it("admits a first authenticated sender into one fsynced customer conversation without creating a contact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-inbound-session-"));
    directories.push(directory);
    const emailId = "11111111-1111-4111-8111-111111111111";
    const received = {
      id: emailId,
      from: "guest@example.test",
      to: ["desk@example.test"],
      subject: "Availability",
      message_id: "<first@example.test>",
      reply_to: "guest@example.test",
      headers: { "message-id": "<first@example.test>", "reply-to": "guest@example.test" },
      authentication: { dmarc: "pass" },
      text: "Is January 15 open?",
      html: "",
      attachments: [],
    };
    const inbox = openResendInbox(join(directory, "inbound.sqlite"), {
      authority: {
        version: 1,
        messengerId: "officehum.resend.v1:test",
        accountId: "account_test",
        fromEmail: "desk@example.test",
        inboundEmail: "desk@example.test",
      },
      getApiKey: async () => "synthetic",
      getWebhookSecrets: async () => [SECRET],
      now: () => NOW,
      fetch: async () => Response.json(received),
    });
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const role = frontdesk({ calendar });
    const provider = fauxProvider({ provider: "inbound-session", models: [{ id: "model" }] });
    provider.setResponses([fauxAssistantMessage("I can help with availability.")]);
    const models = createModels();
    models.setProvider(provider.provider);
    const solo = await openSolo({
      directory,
      models,
      model: { provider: "inbound-session", modelId: "model" },
      role,
    });
    const customerTools = role.extensions
      .flatMap((extension) => extension.tools ?? [])
      .filter(({ name }) => name === "check_schedule" || name === "reply_message");
    const session = openInboundSession({
      solo,
      inbox,
      customerAgent: {
        ...role.agent,
        model: { provider: "inbound-session", modelId: "model" },
        tools: customerTools,
      },
    });
    await expect(readInboundInbox(directory)).rejects.toThrow("owned by another active process");
    const event = {
      type: "email.received",
      created_at: "2030-01-01T00:00:00.000Z",
      data: {
        email_id: emailId,
        from: "guest@example.test",
        to: ["desk@example.test"],
        subject: "Availability",
        message_id: "<first@example.test>",
        attachments: [],
      },
    };
    const raw = new TextEncoder().encode(JSON.stringify(event));
    const timestamp = String(Math.floor(NOW / 1000));
    const id = "evt_session";
    const signature = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
      .update(`${id}.${timestamp}.`)
      .update(raw)
      .digest("base64");
    await inbox.accept(raw, { id, timestamp, signature: `v1,${signature}` });
    await session.tick();
    const routed = inbox.receipt(emailId);
    if (routed?.conversationId === null || routed?.conversationId === undefined) {
      throw new Error("customer conversation was not routed");
    }
    let operatorPrompts = 0;
    const guarded = inboundAwareApprover(
      () => solo.harness,
      async () => {
        operatorPrompts += 1;
        return { approved: true };
      },
    );
    await expect(
      guarded(
        {
          approvalId: "confirm_contact",
          description: "Forbidden customer mutation",
          tool: "create_contact",
          arguments: { email: "other@example.test" },
          conversationId: String(routed.conversationId),
          taskId: "forbidden",
          callId: "forbidden",
        },
        BACKGROUND_CONTEXT,
      ),
    ).resolves.toMatchObject({ approved: false, by: "inbound-policy" });
    expect(operatorPrompts).toBe(0);
    await solo.harness.waitForIdle(BACKGROUND_CONTEXT);
    await session.reconcile();
    expect(inbox.summaries()).toEqual([
      expect.objectContaining({ emailId, state: "settled", reason: null }),
    ]);
    expect((await solo.harness.snapshot(ContactsDoc, BACKGROUND_CONTEXT))?.contacts ?? []).toEqual(
      [],
    );
    await session.close();
    await solo.close();
  });

  it("recovers an immediate customer reply from the Harness proof before the worker saves admission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-inbound-session-"));
    directories.push(directory);
    const emailId = "22222222-2222-4222-8222-222222222222";
    const received = {
      id: emailId,
      from: "guest@example.test",
      to: ["desk@example.test"],
      subject: "Availability",
      message_id: "<early@example.test>",
      reply_to: "guest@example.test",
      headers: { "message-id": "<early@example.test>", "reply-to": "guest@example.test" },
      authentication: { dmarc: "pass" },
      text: "Is January 15 open?",
      html: "",
      attachments: [],
    };
    const sent: Record<string, unknown>[] = [];
    const transport: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/emails/receiving/")) return Response.json(received);
      if (url === "https://api.resend.com/emails" && init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ id: "33333333-3333-4333-8333-333333333333" });
      }
      throw new Error("unexpected synthetic request");
    };
    const inbox = openResendInbox(join(directory, "inbound.sqlite"), {
      authority: {
        version: 1,
        messengerId: "officehum.resend.v1:test",
        accountId: "account_test",
        fromEmail: "desk@example.test",
        inboundEmail: "desk@example.test",
      },
      getApiKey: async () => "synthetic",
      getWebhookSecrets: async () => [SECRET],
      now: () => NOW,
      fetch: transport,
    });
    let attachedHarness: Awaited<ReturnType<typeof openSolo>>["harness"] | undefined;
    const reply = createResendReplyMessenger({
      inbox,
      getHarness: () => attachedHarness,
      getApiKey: async () => "synthetic",
      now: () => NOW,
      fetch: transport,
    });
    let prompts = 0;
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const role = frontdesk({
      calendar,
      replyMessenger: reply,
      approveReply: durableInboundReplyApprover(inbox, async () => {
        prompts += 1;
        return { approved: true, by: "operator" };
      }),
    });
    const provider = fauxProvider({ provider: "inbound-early-reply", models: [{ id: "model" }] });
    provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall("reply_message", { receiptId: emailId, text: "January 15 is open." }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Reply sent."),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    const solo = await openSolo({
      directory,
      models,
      model: { provider: "inbound-early-reply", modelId: "model" },
      role,
    });
    attachedHarness = solo.harness;
    const customerTools = role.extensions
      .flatMap((extension) => extension.tools ?? [])
      .filter(({ name }) => name === "check_schedule" || name === "reply_message");
    let workerAdmissionAttempts = 0;
    const workerInbox = {
      ...inbox,
      saveAdmission() {
        workerAdmissionAttempts += 1;
        throw new Error("synthetic crash before worker admission update");
      },
    } satisfies InternalResendInbox;
    const session = openInboundSession({
      solo,
      inbox: workerInbox,
      customerAgent: {
        ...role.agent,
        model: { provider: "inbound-early-reply", modelId: "model" },
        tools: customerTools,
      },
    });
    const event = {
      type: "email.received",
      created_at: "2030-01-01T00:00:00.000Z",
      data: {
        email_id: emailId,
        from: "guest@example.test",
        to: ["desk@example.test"],
        subject: "Availability",
        message_id: "<early@example.test>",
        attachments: [],
      },
    };
    const raw = new TextEncoder().encode(JSON.stringify(event));
    const timestamp = String(Math.floor(NOW / 1000));
    const signature = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
      .update(`evt_early.${timestamp}.`)
      .update(raw)
      .digest("base64");
    await inbox.accept(raw, { id: "evt_early", timestamp, signature: `v1,${signature}` });
    await expect(session.tick()).rejects.toThrow("synthetic crash before worker admission update");
    await solo.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(inbox.receipt(emailId)).toMatchObject({ state: "admitted" });
    await session.reconcile();
    expect(workerAdmissionAttempts).toBe(1);
    expect(prompts).toBe(1);
    expect(sent).toEqual([
      expect.objectContaining({
        to: ["guest@example.test"],
        reply_to: "desk@example.test",
        text: "January 15 is open.",
        headers: expect.objectContaining({ "In-Reply-To": "<early@example.test>" }),
      }),
    ]);
    expect(inbox.summaries()).toEqual([
      expect.objectContaining({ emailId, state: "settled", reason: null }),
    ]);
    await session.close();
    await reply.close();
    await solo.close();
    await inbox.close();
    calendar.close();
  });

  it("durably steers a second email from the same sender while the first turn is busy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-inbound-session-"));
    directories.push(directory);
    const ids = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
    const received = new Map(
      ids.map((emailId, index) => [
        emailId,
        {
          id: emailId,
          from: "guest@example.test",
          to: ["desk@example.test"],
          subject: index === 0 ? "First subject" : "Second subject",
          message_id: `<steer-${index}@example.test>`,
          reply_to: "guest@example.test",
          headers: {
            "message-id": `<steer-${index}@example.test>`,
            "reply-to": "guest@example.test",
          },
          authentication: { dmarc: "pass" },
          text: `Message ${index + 1}`,
          html: "",
          attachments: [],
        },
      ]),
    );
    const inbox = openResendInbox(join(directory, "inbound.sqlite"), {
      authority: {
        version: 1,
        messengerId: "officehum.resend.v1:test",
        accountId: "account_test",
        fromEmail: "desk@example.test",
        inboundEmail: "desk@example.test",
      },
      getApiKey: async () => "synthetic",
      getWebhookSecrets: async () => [SECRET],
      now: () => NOW,
      fetch: async (input) => {
        const match = String(input).match(/receiving\/([^?]+)/u);
        const item = match?.[1] === undefined ? undefined : received.get(match[1]);
        if (item === undefined) throw new Error("unexpected synthetic request");
        return Response.json(item);
      },
    });
    let reached!: () => void;
    const busy = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldOnce = false;
    const baseCalendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const calendar = {
      freeSlots: async (date: string) => {
        if (!heldOnce) {
          heldOnce = true;
          reached();
          await held;
        }
        return baseCalendar.freeSlots(date);
      },
      listBookings: () => baseCalendar.listBookings(),
      book: (start: string, customer: string, key: string) =>
        baseCalendar.book(start, customer, key),
      reschedule: (id: string, start: string, key: string) =>
        baseCalendar.reschedule(id, start, key),
      cancel: (id: string, key: string) => baseCalendar.cancel(id, key),
    };
    const role = frontdesk({ calendar });
    const provider = fauxProvider({ provider: "inbound-steer", models: [{ id: "model" }] });
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("check_schedule", { date: "2030-01-15" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("First handled."),
      fauxAssistantMessage("Second handled."),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    const solo = await openSolo({
      directory,
      models,
      model: { provider: "inbound-steer", modelId: "model" },
      role,
    });
    const customerTools = role.extensions
      .flatMap((extension) => extension.tools ?? [])
      .filter(({ name }) => name === "check_schedule" || name === "reply_message");
    const session = openInboundSession({
      solo,
      inbox,
      customerAgent: {
        ...role.agent,
        model: { provider: "inbound-steer", modelId: "model" },
        tools: customerTools,
      },
    });
    const accept = async (emailId: string, index: number) => {
      const event = {
        type: "email.received",
        created_at: "2030-01-01T00:00:00.000Z",
        data: {
          email_id: emailId,
          from: "guest@example.test",
          to: ["desk@example.test"],
          subject: index === 0 ? "First subject" : "Second subject",
          message_id: `<steer-${index}@example.test>`,
          attachments: [],
        },
      };
      const raw = new TextEncoder().encode(JSON.stringify(event));
      const timestamp = String(Math.floor(NOW / 1000));
      const eventId = `evt_steer_${index}`;
      const signature = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
        .update(`${eventId}.${timestamp}.`)
        .update(raw)
        .digest("base64");
      await inbox.accept(raw, { id: eventId, timestamp, signature: `v1,${signature}` });
    };
    await accept(ids[0] as string, 0);
    await session.tick();
    await busy;
    await accept(ids[1] as string, 1);
    await session.tick();
    const second = inbox.receipt(ids[1] as string);
    if (second === undefined) throw new Error("second receipt was not saved");
    expect(second.state).toBe("admitted");
    const queued = await solo.harness.commit(async (tx) => {
      const submission = await tx.submissionByRequest(
        second.conversationId as never,
        second.requestId as string,
      );
      const durableInbox = await tx.doc(InboxDoc, second.conversationId as never);
      const item = durableInbox.items.find(({ id }) => id === submission?.id);
      return {
        submission,
        item:
          item === undefined
            ? undefined
            : {
                id: item.id,
                mode: item.mode,
                content: "content" in item ? item.content : undefined,
              },
      };
    }, BACKGROUND_CONTEXT);
    expect(queued.submission?.status).toBe("queued");
    expect(queued.item).toMatchObject({ mode: "steer", content: second.envelope });
    expect(inbox.receipt(ids[0] as string)?.conversationId).toBe(second.conversationId);
    release();
    await solo.harness.waitForIdle(BACKGROUND_CONTEXT);
    await session.reconcile();
    expect(inbox.summaries().map(({ state }) => state)).toEqual(["settled", "settled"]);
    await session.close();
    await solo.close();
    await inbox.close();
    baseCalendar.close();
  });

  it("recovers provider acceptance, reply history, and tool settlement across fsynced reopens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-inbound-session-"));
    directories.push(directory);
    const emailId = "88888888-8888-4888-8888-888888888888";
    const received = {
      id: emailId,
      from: "guest@example.test",
      to: ["desk@example.test"],
      subject: "Recovery",
      message_id: "<recovery@example.test>",
      reply_to: "guest@example.test",
      headers: {
        "message-id": "<recovery@example.test>",
        "reply-to": "guest@example.test",
      },
      authentication: { dmarc: "pass" },
      text: "Please reply.",
      html: "",
      attachments: [],
    };
    let posts = 0;
    const accepted = new Map<string, string>();
    const transport: typeof fetch = async (input, init) => {
      if (String(input).includes("/emails/receiving/")) return Response.json(received);
      if (String(input) !== "https://api.resend.com/emails") {
        throw new Error("unexpected synthetic request");
      }
      posts += 1;
      const key = new Headers(init?.headers).get("idempotency-key");
      if (key === null) throw new Error("missing reply idempotency key");
      const id = accepted.get(key) ?? "99999999-9999-4999-8999-999999999999";
      accepted.set(key, id);
      if (phase === "provider") {
        providerReached();
        await new Promise<never>((_resolve, reject) => {
          interruptSend = reject;
        });
      }
      return Response.json({ id });
    };
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    let attachedHarness: Harness | undefined;
    let phase: "provider" | "history" | "settle" = "provider";
    let providerReached!: () => void;
    const providerAccepted = new Promise<void>((resolve) => {
      providerReached = resolve;
    });
    let historyReached!: () => void;
    const historySaved = new Promise<void>((resolve) => {
      historyReached = resolve;
    });
    let interruptSend: ((error: Error) => void) | undefined;
    let approvals = 0;
    let currentInbox: InternalResendInbox | undefined;
    let currentRole: ReturnType<typeof frontdesk> | undefined;
    const createRole = () => {
      const inbox = openResendInbox(join(directory, "inbound.sqlite"), {
        authority: {
          version: 1,
          messengerId: "officehum.resend.v1:test",
          accountId: "account_test",
          fromEmail: "desk@example.test",
          inboundEmail: "desk@example.test",
        },
        getApiKey: async () => "synthetic",
        getWebhookSecrets: async () => [SECRET],
        now: () => NOW,
        fetch: transport,
      });
      currentInbox = inbox;
      const reply = createResendReplyMessenger({
        inbox,
        getHarness: () => attachedHarness,
        getApiKey: async () => "synthetic",
        now: () => NOW,
        fetch: transport,
      });
      const baseRole = frontdesk({
        calendar,
        replyMessenger: reply,
        approveReply: durableInboundReplyApprover(inbox, async () => {
          approvals += 1;
          return { approved: true, by: "operator" };
        }),
      });
      let role = baseRole;
      if (phase === "history") {
        const pauseAfterHistory = hook(ToolTask, {
          afterTool: async (call, result) => {
            if (call.name !== "reply_message") return result;
            historyReached();
            await new Promise<never>((_resolve, reject) => {
              interruptSend = reject;
            });
            return result;
          },
        });
        const [extension, ...rest] = baseRole.extensions;
        if (extension === undefined) throw new Error("frontdesk extension was not created");
        role = {
          ...baseRole,
          extensions: [
            { ...extension, hooks: [...(extension.hooks ?? []), pauseAfterHistory] },
            ...rest,
          ],
        };
      }
      currentRole = role;
      return {
        role,
        close: async () => {
          interruptSend?.(new Error(`synthetic crash after ${phase}`));
          await reply.close();
          await inbox.close();
        },
      };
    };
    const firstProvider = fauxProvider({
      provider: "inbound-history-recovery",
      models: [{ id: "model" }],
    });
    firstProvider.setResponses([
      fauxAssistantMessage(
        fauxToolCall("reply_message", { receiptId: emailId, text: "Recovered reply." }),
        { stopReason: "toolUse" },
      ),
    ]);
    const firstModels = createModels();
    firstModels.setProvider(firstProvider.provider);
    const firstSolo = await openSolo({
      directory,
      models: firstModels,
      model: { provider: "inbound-history-recovery", modelId: "model" },
      messengerIdentity: {
        version: 1,
        backend: "resend",
        accountId: "account_test",
        fromEmail: "desk@example.test",
        subject: "Front Desk",
      },
      createRole,
    });
    attachedHarness = firstSolo.harness;
    const firstInbox = currentInbox;
    const firstRole = currentRole;
    if (firstInbox === undefined || firstRole === undefined) {
      throw new Error("inbound resources were not created");
    }
    const customerTools = firstRole.extensions
      .flatMap((extension) => extension.tools ?? [])
      .filter(({ name }) => name === "check_schedule" || name === "reply_message");
    const firstSession = openInboundSession({
      solo: firstSolo,
      inbox: firstInbox,
      customerAgent: {
        ...firstRole.agent,
        model: { provider: "inbound-history-recovery", modelId: "model" },
        tools: customerTools,
      },
    });
    const event = {
      type: "email.received",
      created_at: "2030-01-01T00:00:00.000Z",
      data: {
        email_id: emailId,
        from: "guest@example.test",
        to: ["desk@example.test"],
        subject: "Recovery",
        message_id: "<recovery@example.test>",
        attachments: [],
      },
    };
    const raw = new TextEncoder().encode(JSON.stringify(event));
    const timestamp = String(Math.floor(NOW / 1000));
    const signature = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
      .update(`evt_recovery.${timestamp}.`)
      .update(raw)
      .digest("base64");
    await firstInbox.accept(raw, {
      id: "evt_recovery",
      timestamp,
      signature: `v1,${signature}`,
    });
    await firstSession.tick();
    await providerAccepted;
    const interruptedReceipt = firstInbox.receipt(emailId);
    if (
      interruptedReceipt?.replyRequestId === null ||
      interruptedReceipt?.replyRequestId === undefined
    ) {
      throw new Error("reply operation was not reserved");
    }
    expect(firstInbox.replyOperation(interruptedReceipt.replyRequestId)).toMatchObject({
      state: "pending",
      providerReceiptId: null,
    });
    expect(
      (await firstSolo.harness.snapshot(RepliesDoc, BACKGROUND_CONTEXT))?.replies ?? [],
    ).toHaveLength(0);
    await firstSession.close();
    await firstSolo.close();

    phase = "history";
    interruptSend = undefined;
    attachedHarness = undefined;
    currentInbox = undefined;
    currentRole = undefined;
    const secondProvider = fauxProvider({
      provider: "inbound-history-recovery",
      models: [{ id: "model" }],
    });
    secondProvider.setResponses([fauxAssistantMessage("Recovered the accepted reply.")]);
    const secondModels = createModels();
    secondModels.setProvider(secondProvider.provider);
    const secondSolo = await openSolo({
      directory,
      models: secondModels,
      messengerIdentity: {
        version: 1,
        backend: "resend",
        accountId: "account_test",
        fromEmail: "desk@example.test",
        subject: "Front Desk",
      },
      createRole,
    });
    attachedHarness = secondSolo.harness;
    const secondInbox = currentInbox;
    const secondRole = currentRole;
    if (secondInbox === undefined || secondRole === undefined) {
      throw new Error("reopened inbound resources were not created");
    }
    const reopenedTools = secondRole.extensions
      .flatMap((extension) => extension.tools ?? [])
      .filter(({ name }) => name === "check_schedule" || name === "reply_message");
    const secondSession = openInboundSession({
      solo: secondSolo,
      inbox: secondInbox,
      customerAgent: {
        ...secondRole.agent,
        model: { provider: "inbound-history-recovery", modelId: "model" },
        tools: reopenedTools,
      },
    });
    await secondSession.reconcile();
    const secondResume = secondSolo.resume();
    await historySaved;
    const secondReceipt = secondInbox.receipt(emailId);
    if (secondReceipt?.replyRequestId === null || secondReceipt?.replyRequestId === undefined) {
      throw new Error("recovered reply operation was not reserved");
    }
    expect(secondInbox.replyOperation(secondReceipt.replyRequestId)).toMatchObject({
      state: "accepted",
      providerReceiptId: "99999999-9999-4999-8999-999999999999",
    });
    expect(
      (await secondSolo.harness.snapshot(RepliesDoc, BACKGROUND_CONTEXT))?.replies,
    ).toHaveLength(1);
    await secondSession.close();
    await secondSolo.close();
    await secondResume.catch(() => {});

    phase = "settle";
    interruptSend = undefined;
    attachedHarness = undefined;
    currentInbox = undefined;
    currentRole = undefined;
    const thirdProvider = fauxProvider({
      provider: "inbound-history-recovery",
      models: [{ id: "model" }],
    });
    thirdProvider.setResponses([fauxAssistantMessage("Recovered the accepted reply.")]);
    const thirdModels = createModels();
    thirdModels.setProvider(thirdProvider.provider);
    const thirdSolo = await openSolo({
      directory,
      models: thirdModels,
      messengerIdentity: {
        version: 1,
        backend: "resend",
        accountId: "account_test",
        fromEmail: "desk@example.test",
        subject: "Front Desk",
      },
      createRole,
    });
    attachedHarness = thirdSolo.harness;
    const thirdInbox = currentInbox;
    const thirdRole = currentRole;
    if (thirdInbox === undefined || thirdRole === undefined) {
      throw new Error("twice-reopened inbound resources were not created");
    }
    const thirdTools = thirdRole.extensions
      .flatMap((extension) => extension.tools ?? [])
      .filter(({ name }) => name === "check_schedule" || name === "reply_message");
    const thirdSession = openInboundSession({
      solo: thirdSolo,
      inbox: thirdInbox,
      customerAgent: {
        ...thirdRole.agent,
        model: { provider: "inbound-history-recovery", modelId: "model" },
        tools: thirdTools,
      },
    });
    await thirdSession.reconcile();
    const results = await thirdSolo.resume();
    await thirdSolo.harness.waitForIdle(BACKGROUND_CONTEXT);
    await thirdSession.reconcile();
    expect(results.map(({ settlement }) => settlement.status)).toContain("done");
    expect(
      (await thirdSolo.harness.snapshot(RepliesDoc, BACKGROUND_CONTEXT))?.replies,
    ).toHaveLength(1);
    expect(thirdInbox.receipt(emailId)).toMatchObject({
      state: "settled",
      settlement: { status: "done" },
    });
    expect(Object.keys(thirdInbox.receipt(emailId)?.settlement ?? {})).toEqual(["status"]);
    expect({ approvals, posts, providerAcceptances: accepted.size }).toEqual({
      approvals: 1,
      posts: 2,
      providerAcceptances: 1,
    });
    await thirdSession.close();
    await thirdSolo.close();
    calendar.close();
  });
});
