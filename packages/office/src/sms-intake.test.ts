/**
 * The inbound text path end to end (RASF-3162): a signed webhook, the office's board, a real harness,
 * a scripted model, and a messenger that records what it was asked to send.
 *
 * Nothing here reaches Twilio and nothing here runs a model: the provider is the scripted one and the
 * webhook body is a fixture signed with the fixture's own token. What is real is everything between
 * them — the route, the duplicate guard, the rate counter, the conversation Pi Durable creates, and
 * the approval gate the role asks before a message leaves.
 *
 * The two cases this file exists for are the two kinds of sender. A number a contact owns is a
 * customer: one conversation per contact, answered by email, first contact approved by a person. A
 * number nobody owns is a stranger: a callback ticket for a person, and no conversation at all — which
 * is how "the desk cannot answer this" is a shape rather than a promise.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { EMPTY_TWIML, FAKE_NUMBER, rateLimitWindow, twilioSignature } from "@officehum/channels";
import frontdesk, {
  type Calendar,
  ContactsDoc,
  type DeliveryReceipt,
  type MessageIntent,
  type Messenger,
} from "@officehum/frontdesk";
import { afterEach, describe, expect, it } from "vitest";
import type { Board } from "./board/index.js";
import { createWorkboard, seedPerson } from "./board/testing.js";
import { openLocalCalendar } from "./local-calendar.js";
import type { ResendInbox } from "./resend-inbox.js";
import type { InboundOutcome, ResendListener } from "./resend-listener.js";
import { openResendListener } from "./resend-listener.js";
import { openSmsIntake, SmsConversationDoc, type SmsIntake, SmsRoutesDoc } from "./sms-intake.js";
import { openSolo, type SoloSession } from "./solo.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const BUSINESS = FAKE_NUMBER;
const CUSTOMER = "+15555550123";
const STRANGER = "+15555550999";
const SID = "SM11111111111111111111111111111111";
const SID2 = "SM22222222222222222222222222222222";
const EMAIL = "dana@example.test";

const directories: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "officehum-sms-intake-"));
  directories.push(path);
  return path;
}

/** The Resend half of the listener is not what this file tests; it only has to exist and be typed. */
function idleInbox(): ResendInbox {
  return {
    authority: {
      version: 1,
      messengerId: "officehum.resend.v1:test",
      accountId: "account_test",
      fromEmail: "desk@example.test",
      inboundEmail: "desk@example.test",
    },
    namespace: "test",
    accept: () => Promise.resolve({ status: 204 }),
    summaries: () => [],
    close: () => Promise.resolve(),
  };
}

function testMessenger(): { messenger: Messenger; effects: MessageIntent[] } {
  const effects: MessageIntent[] = [];
  const messenger: Messenger = {
    identity: "test.transport.v1",
    async send(intent, options): Promise<DeliveryReceipt> {
      effects.push({ ...intent });
      return { id: `receipt-${options.requestId}`, status: "accepted" };
    },
  };
  return { messenger, effects };
}

type Turn = readonly { readonly text: string }[];

interface Office {
  readonly board: Board;
  readonly solo: SoloSession;
  readonly intake: SmsIntake;
  readonly listener: ResendListener;
  readonly outcomes: InboundOutcome[];
  readonly effects: MessageIntent[];
  readonly approvals: string[];
  /** Every call the role made to the calendar, so a blocked tool is provably blocked. */
  readonly calendarCalls: string[];
  post(overrides?: Readonly<Record<string, string>>): Promise<Response>;
}

/**
 * One office as this file needs it: a board, a harness with the Front Desk role, the SMS intake over
 * both, and the real webhook route in front of the intake.
 *
 * `approve` decides what a person answers. The default declines every approval, which is the case the
 * first-contact tests need — a decline still has to be asked for.
 */
async function office(options: {
  readonly turns?: () => readonly unknown[];
  readonly approve?: (approvalId: string) => boolean;
  readonly contacts?: readonly { phone: string; email: string | null }[];
  readonly rateLimit?: { limit: number; windowMs: number };
  readonly isRegistered?: boolean;
}): Promise<Office> {
  const path = directory();
  const board = createWorkboard(join(path, "office.sqlite"));
  seedPerson(join(path, "office.sqlite"), "pat", "Pat");
  const local = openLocalCalendar(join(path, "calendar.sqlite"));
  const calendarCalls: string[] = [];
  const calendar: Calendar = {
    freeSlots: (date) => local.freeSlots(date),
    listBookings: () => {
      calendarCalls.push("list_bookings");
      return local.listBookings();
    },
    book: (start, customer, key) => local.book(start, customer, key),
    reschedule: (id, start, key) => local.reschedule(id, start, key),
    cancel: (id, key) => local.cancel(id, key),
  };
  const { messenger, effects } = testMessenger();
  const approvals: string[] = [];
  const role = frontdesk({
    calendar,
    messenger,
    approve: async (request) => {
      approvals.push(request.approvalId);
      return { approved: options.approve?.(request.approvalId) ?? false, by: "pat" };
    },
  });
  const provider = fauxProvider({ provider: "sms-intake", models: [{ id: "model" }] });
  provider.setResponses((options.turns?.() ?? []) as never);
  const models = createModels();
  models.setProvider(provider.provider);
  const solo = await openSolo({
    directory: path,
    models,
    model: { provider: "sms-intake", modelId: "model" },
    role,
  });
  // A contact saved the way the desk saves one: the session document the tool writes.
  const contacts = options.contacts ?? [];
  if (contacts.length > 0) {
    await solo.harness.commit(async (tx) => {
      const state = await tx.doc(ContactsDoc);
      for (const [index, contact] of contacts.entries()) {
        state.contacts.push({
          id: `contact-${index + 1}`,
          name: "Dana Reyes",
          email: contact.email,
          phone: contact.phone,
          revision: 1,
          bookingIds: [],
          lastSeenAt: null,
        });
      }
      state.nextId = contacts.length + 1;
    }, BACKGROUND_CONTEXT);
  }
  const outcomes: InboundOutcome[] = [];
  const intake = openSmsIntake({
    board,
    harness: () => solo.harness,
    agent: { ...role.agent, model: { provider: "sms-intake", modelId: "model" } },
    agentKey: "frontdesk",
    personId: "pat",
  });
  const listener = await openResendListener({
    inbox: idleInbox(),
    port: 0,
    twilio: {
      authToken: TOKEN,
      businessNumber: BUSINESS,
      board: board.sms,
      isRegistered: () => options.isRegistered ?? false,
      ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
      onInbound: async (outcome) => {
        outcomes.push(outcome);
        await intake.accept(outcome);
      },
    },
  });
  cleanups.push(async () => {
    await listener.close();
    await solo.close();
    board.close();
    local.close();
  });
  return {
    board,
    solo,
    intake,
    listener,
    outcomes,
    effects,
    approvals,
    calendarCalls,
    async post(overrides = {}) {
      const params: Record<string, string> = {
        AccountSid: "AC11111111111111111111111111111111",
        ApiVersion: "2010-04-01",
        Body: "The sink is leaking again",
        From: CUSTOMER,
        MessageSid: SID,
        NumSegments: "1",
        SmsSid: SID,
        SmsStatus: "received",
        To: BUSINESS,
        ...overrides,
      };
      const url = `${listener.address}/hooks/twilio`;
      return fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": twilioSignature(TOKEN, url, params),
        },
        body: new URLSearchParams(params).toString(),
      });
    },
  };
}

/** The conversation a number's texts are routed to, read from the office's own route document. */
async function routes(
  solo: SoloSession,
): Promise<readonly { number: string; conversationId: number }[]> {
  const state = await solo.harness.snapshot(SmsRoutesDoc, BACKGROUND_CONTEXT);
  return state?.routes ?? [];
}

/** Is there an input with this request id in that conversation? The Pi Durable dedupe key, read back. */
async function submitted(
  solo: SoloSession,
  conversationId: number,
  requestId: string,
): Promise<boolean> {
  return solo.harness.commit(async (tx) => {
    const record = await tx.submissionByRequest(conversationId as never, requestId);
    return record !== undefined;
  }, BACKGROUND_CONTEXT);
}

const sendEmail = (to: string, text: string) =>
  fauxAssistantMessage(
    fauxToolCall("send_message", {
      contactId: "contact-1",
      channel: "email",
      to,
      text,
      messengerId: "test.transport.v1",
    }),
    { stopReason: "toolUse" },
  );

describe("inbound text from a registered number", () => {
  it("opens one conversation, marked external, keyed by the MessageSid", async () => {
    const office1 = await office({
      contacts: [{ phone: CUSTOMER, email: EMAIL }],
      turns: () => [fauxAssistantMessage("Thanks — I'll be in touch by email.")],
      isRegistered: true,
    });
    const response = await office1.post();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(EMPTY_TWIML);

    const [route] = await routes(office1.solo);
    expect(route?.number).toBe(CUSTOMER);
    if (route === undefined) throw new Error("the text was not routed");
    const marker = await office1.solo.harness.snapshot(
      SmsConversationDoc,
      route.conversationId as never,
      BACKGROUND_CONTEXT,
    );
    expect(marker).toMatchObject({
      agent: "frontdesk",
      number: CUSTOMER,
      contactId: "contact-1",
      provenance: "external",
    });
    // The provider's id is the conversation's request id, so a redelivery cannot say it twice.
    expect(await submitted(office1.solo, route.conversationId, `twilio:${SID}`)).toBe(true);
    await office1.solo.harness.waitForIdle(BACKGROUND_CONTEXT);
    // A registered number files no ticket: this is a conversation, not queued work.
    expect(office1.board.list()).toEqual([]);
  });

  it("answers by email, and a declined first contact sends nothing", async () => {
    const office1 = await office({
      contacts: [{ phone: CUSTOMER, email: EMAIL }],
      turns: () => [
        sendEmail(EMAIL, "Hello Dana — sorry about the leak."),
        fauxAssistantMessage("Sent."),
      ],
      approve: () => false,
      isRegistered: true,
    });
    await office1.post();
    await office1.solo.harness.waitForIdle(BACKGROUND_CONTEXT);

    // The desk tried the only reply it has, and the gate it hit is the first-contact one.
    expect(office1.approvals).toContain("first_contact");
    expect(office1.effects).toEqual([]);
  });

  it("sends an email once a person approves the first contact", async () => {
    const office1 = await office({
      contacts: [{ phone: CUSTOMER, email: EMAIL }],
      turns: () => [
        sendEmail(EMAIL, "Hello Dana — sorry about the leak."),
        fauxAssistantMessage("Sent."),
      ],
      approve: (approvalId) => approvalId === "first_contact",
      isRegistered: true,
    });
    await office1.post();
    await office1.solo.harness.waitForIdle(BACKGROUND_CONTEXT);

    expect(office1.effects).toEqual([
      { to: EMAIL, channel: "email", text: "Hello Dana — sorry about the leak." },
    ]);
  });

  it("keeps a customer's second text in the conversation the first one opened", async () => {
    const office1 = await office({
      contacts: [{ phone: CUSTOMER, email: EMAIL }],
      turns: () => [fauxAssistantMessage("Noted."), fauxAssistantMessage("Noted again.")],
      isRegistered: true,
    });
    await office1.post();
    await office1.post({ MessageSid: SID2, SmsSid: SID2, Body: "And the bathroom tap." });
    await office1.solo.harness.waitForIdle(BACKGROUND_CONTEXT);

    const routed = await routes(office1.solo);
    expect(routed).toHaveLength(1);
    const conversationId = routed[0]?.conversationId ?? 0;
    expect(await submitted(office1.solo, conversationId, `twilio:${SID}`)).toBe(true);
    expect(await submitted(office1.solo, conversationId, `twilio:${SID2}`)).toBe(true);
  });

  it("gives a text-conversation no way into the office's own work", async () => {
    const office1 = await office({
      contacts: [{ phone: CUSTOMER, email: EMAIL }],
      turns: () => [
        fauxAssistantMessage(fauxToolCall("list_bookings", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("I can't look through the diary from here."),
      ],
      isRegistered: true,
    });
    await office1.post();
    await office1.solo.harness.waitForIdle(BACKGROUND_CONTEXT);

    // The guard reads the conversation's marker, so a customer's text reaches only availability and
    // the email reply. Everything else — the diary, contacts, bookings — is the office's own work.
    expect(office1.calendarCalls).toEqual([]);
  });

  it("is not held to the stranger's ceiling", async () => {
    const office1 = await office({
      contacts: [{ phone: CUSTOMER, email: EMAIL }],
      turns: () => [fauxAssistantMessage("Noted.")],
      rateLimit: { limit: 1, windowMs: 60 * 60 * 1000 },
      isRegistered: true,
    });
    await office1.post();
    await office1.post({ MessageSid: SID2, SmsSid: SID2 });
    await office1.post({ MessageSid: "SM3", SmsSid: "SM3" });

    expect(office1.outcomes.map(({ disposition }) => disposition)).toEqual([
      "recorded",
      "recorded",
      "recorded",
    ]);
  });
});

describe("inbound text from a number no contact owns", () => {
  it("files a callback for a person and opens no conversation at all", async () => {
    const office1 = await office({ turns: () => [fauxAssistantMessage("unused")] });
    const response = await office1.post({ From: STRANGER, Body: "Do you fix boilers?" });
    expect(response.status).toBe(200);

    const [ticket] = office1.board.list();
    if (ticket === undefined) throw new Error("no callback ticket was filed");
    expect(ticket.type).toBe("phone.callback");
    expect(ticket.assignee).toBe("pat");
    expect(ticket.payload).toMatchObject({ number: STRANGER, message: "Do you fix boilers?" });
    expect(ticket.detail).toContain("Do you fix boilers?");
    expect(office1.board.provenance(ticket.id)).toEqual({
      origin: "external",
      sourceChannel: "sms",
      sourceContact: STRANGER,
    });
    // No conversation, so there is nothing for the desk to answer in: the agent never sees this text.
    expect(await routes(office1.solo)).toEqual([]);
    expect(office1.effects).toEqual([]);
  });

  it("records an email the text names, and writes to nothing without approval", async () => {
    const office1 = await office({ turns: () => [fauxAssistantMessage("unused")] });
    await office1.post({ From: STRANGER, Body: `Call me, or write to ${EMAIL.toUpperCase()}.` });

    const [ticket] = office1.board.list();
    if (ticket === undefined) throw new Error("no callback ticket was filed");
    expect(ticket.payload).toMatchObject({ replyToEmail: EMAIL });
    // Nothing was written and nothing was asked: the ticket is where a person decides, and a first
    // contact to that address will need their approval when the desk is asked to make it.
    expect(office1.effects).toEqual([]);
    expect(office1.approvals).toEqual([]);
    expect(office1.board.approvals.pendingApprovals({ ticketId: ticket.id })).toEqual([]);
  });

  it("refuses the text past the ceiling, records the refusal, and files no ticket", async () => {
    const window = { limit: 2, windowMs: 60 * 60 * 1000 };
    const office1 = await office({
      turns: () => [fauxAssistantMessage("unused")],
      rateLimit: window,
    });
    await office1.post({ From: STRANGER, MessageSid: "SM1", SmsSid: "SM1" });
    await office1.post({ From: STRANGER, MessageSid: "SM2", SmsSid: "SM2" });
    await office1.post({ From: STRANGER, MessageSid: "SM3", SmsSid: "SM3" });

    expect(office1.outcomes.map(({ disposition }) => disposition)).toEqual([
      "recorded",
      "recorded",
      "rate_limited",
    ]);
    expect(office1.board.list()).toHaveLength(2);
    // The count climbs past the ceiling rather than pinning at it: that is how a person reads the row
    // and tells three messages from three hundred.
    const bucket = rateLimitWindow(office1.outcomes[0]?.message.receivedAt ?? "", window);
    expect(office1.board.sms.countInWindow(STRANGER, bucket, window.limit)).toMatchObject({
      count: 4,
    });
  });
});

describe("duplicate and keyword messages", () => {
  it("turns one redelivered MessageSid into one conversation and one input", async () => {
    const office1 = await office({
      contacts: [{ phone: CUSTOMER, email: EMAIL }],
      turns: () => [fauxAssistantMessage("Noted.")],
      isRegistered: true,
    });
    await office1.post();
    await office1.post();

    expect(office1.outcomes.map(({ disposition }) => disposition)).toEqual([
      "recorded",
      "duplicate",
    ]);
    expect(await routes(office1.solo)).toHaveLength(1);
  });

  it("turns one redelivered MessageSid from a stranger into one ticket", async () => {
    const office1 = await office({ turns: () => [fauxAssistantMessage("unused")] });
    await office1.post({ From: STRANGER });
    await office1.post({ From: STRANGER });

    expect(office1.board.list()).toHaveLength(1);
  });

  it("does not deliver STOP to the agent, and START does not either", async () => {
    const office1 = await office({
      contacts: [{ phone: CUSTOMER, email: EMAIL }],
      turns: () => [fauxAssistantMessage("Noted.")],
      isRegistered: true,
    });
    await office1.post({ Body: "STOP" });
    await office1.post({ Body: "START", MessageSid: SID2, SmsSid: SID2 });

    expect(office1.outcomes.map(({ disposition }) => disposition)).toEqual(["opt_out", "opt_out"]);
    expect(await routes(office1.solo)).toEqual([]);
    expect(office1.board.sms.optOutOf(CUSTOMER)).toBe("start");
  });

  it("resumes the conversation after a STOP and a START", async () => {
    const office1 = await office({
      contacts: [{ phone: CUSTOMER, email: EMAIL }],
      turns: () => [fauxAssistantMessage("Noted."), fauxAssistantMessage("Noted.")],
      isRegistered: true,
    });
    await office1.post({ Body: "STOP" });
    await office1.post({ MessageSid: SID2, SmsSid: SID2, Body: "START" });
    await office1.post({ MessageSid: "SM3", SmsSid: "SM3", Body: "About that leak again." });
    await office1.solo.harness.waitForIdle(BACKGROUND_CONTEXT);

    const routed = await routes(office1.solo);
    expect(routed).toHaveLength(1);
    expect(await submitted(office1.solo, routed[0]?.conversationId ?? 0, "twilio:SM3")).toBe(true);
  });
});
