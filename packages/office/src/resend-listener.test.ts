/**
 * The webhook server, end to end: one route table, two providers, one pipeline (RASF-3160).
 *
 * What this file proves is the listener's own job — read the request, name the header its provider
 * signs with, hand it to that channel's gateway, answer in the provider's dialect — plus the two facts
 * the gateway now owns for email as well as for text: a redelivery is one message, and one id on two
 * channels is two messages. No network: the provider's `GET` is a stub, as the rest of this package's
 * email tests do.
 */
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TWILIO_FORM_CONTENT_TYPE, twilioSignature } from "@officehum/channels";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkboard } from "./board/testing.js";
import { type InboxSummary, openResendInbox } from "./resend-inbox.js";
import { openResendListener, type ResendListener } from "./resend-listener.js";

const directories: string[] = [];
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const SECRET = `whsec_${Buffer.from("listener-test-secret").toString("base64")}`;
const TOKEN = "0123456789abcdef0123456789abcdef";
const BUSINESS = "+15550100";
const CUSTOMER = "+15550199";
const EMAIL = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "officehum-listener-"));
  directories.push(path);
  return path;
}

/** The delivery Resend posts: an envelope with the message's identity, and no words at all. */
function event(emailId = EMAIL): string {
  return JSON.stringify({
    type: "email.received",
    created_at: "2030-01-01T00:00:00.000Z",
    data: {
      email_id: emailId,
      from: "guest@example.test",
      to: ["desk@example.test"],
      subject: "Hello",
      message_id: `<${emailId}@example.test>`,
      attachments: [],
    },
  });
}

/** The message Resend serves from its own endpoint, once the office asks for it. */
function received(emailId = EMAIL, overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    id: emailId,
    from: "guest@example.test",
    to: ["desk@example.test"],
    subject: "Hello",
    message_id: `<${emailId}@example.test>`,
    reply_to: "guest@example.test",
    headers: { "message-id": `<${emailId}@example.test>`, "reply-to": "guest@example.test" },
    authentication: { dmarc: "pass" },
    text: "Is January 15 open?",
    html: "",
    attachments: [],
    ...overrides,
  });
}

function svix(raw: string, eventId: string, secret = SECRET, at = NOW): Record<string, string> {
  const timestamp = String(Math.floor(at / 1000));
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${eventId}.${timestamp}.${raw}`)
    .digest("base64");
  return {
    "content-type": "application/json",
    "svix-id": eventId,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
}

/** Rows in the one duplicate table, read the way a person inspecting the board would. */
function inboundRows(path: string): Array<{ channel: string; external_id: string }> {
  const database = new DatabaseSync(join(path, "office.sqlite"), { readOnly: true });
  try {
    return database
      .prepare("SELECT channel, external_id FROM channel_inbound ORDER BY channel, external_id")
      .all() as unknown as Array<{ channel: string; external_id: string }>;
  } finally {
    database.close();
  }
}

interface Office {
  readonly path: string;
  readonly listener: ResendListener;
  summaries(): InboxSummary[];
  readonly sms: Array<{ disposition: string }>;
  fetches(): number;
  close(): Promise<void>;
}

async function office(
  options: {
    twilio?: boolean;
    /** Reopen an office that already has state on disk, as a restarted host does. */
    path?: string;
    /** What the provider serves for a message; omitted, a well-formed customer email. */
    serve?: (emailId: string) => Response;
  } = {},
): Promise<Office> {
  const path = options.path ?? (await directory());
  let fetches = 0;
  const inbox = openResendInbox(join(path, "inbound.sqlite"), {
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
      fetches += 1;
      // The provider's endpoint names the message it is serving; the stub does the same, so the
      // envelope and the body cannot drift apart in a fixture.
      const url = new URL(String(input));
      const emailId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      return options.serve?.(emailId) ?? received(emailId);
    },
  });
  const board = createWorkboard(join(path, "office.sqlite"));
  const sms: Array<{ disposition: string }> = [];
  const listener = await openResendListener({
    inbox,
    board: board.sms.inbound,
    port: 0,
    ...(options.twilio === true
      ? {
          twilio: {
            authToken: TOKEN,
            businessNumber: BUSINESS,
            board: board.sms,
            onInbound: (outcome: { disposition: string }) => void sms.push(outcome),
          },
        }
      : {}),
  });
  return {
    path,
    listener,
    summaries: () => inbox.summaries(),
    sms,
    fetches: () => fetches,
    close: async () => {
      await listener.close();
      await inbox.close();
      board.close();
    },
  };
}

describe("Resend listener", () => {
  it("delivers a signed email once, and a redelivery of it as a duplicate", async () => {
    const office1 = await office();
    const raw = event();
    const address = `${office1.listener.address}/webhooks/resend`;

    const first = await fetch(address, { method: "POST", headers: svix(raw, "evt_1"), body: raw });
    expect(first.status).toBe(202);
    expect(await first.text()).toBe("accepted\n");

    // Resend retrying the delivery is the same message: it is told the office has it, and the
    // message is not fetched, admitted or recorded twice.
    const again = await fetch(address, { method: "POST", headers: svix(raw, "evt_2"), body: raw });
    expect(again.status).toBe(200);
    expect(office1.fetches()).toBe(1);
    expect(office1.summaries()).toEqual([
      {
        emailId: EMAIL,
        state: "prepared",
        reason: null,
        conversationId: null,
        submissionId: null,
      },
    ]);
    expect(inboundRows(office1.path)).toEqual([{ channel: "email", external_id: EMAIL }]);
    await office1.close();
  });

  it.each([
    [
      "an auto-reply",
      { headers: { "message-id": `<${EMAIL}@example.test>`, "auto-submitted": "auto-replied" } },
      "auto_message",
    ],
    ["a DMARC failure", { authentication: { dmarc: "fail" } }, "authentication_failed"],
  ])(
    "records %s as blocked and acknowledges it, so Resend does not retry",
    async (_name, overrides, reason) => {
      const serve = (emailId: string) => received(emailId, overrides);
      const office1 = await office({ serve });
      const raw = event();
      const address = `${office1.listener.address}/webhooks/resend`;
      const blocked = [
        { emailId: EMAIL, state: "blocked", reason, conversationId: null, submissionId: null },
      ];

      const first = await fetch(address, {
        method: "POST",
        headers: svix(raw, "evt_1"),
        body: raw,
      });
      expect(first.status).toBe(204);
      expect(office1.summaries()).toEqual(blocked);
      // Not a message for the office: nothing reaches the duplicate table or a conversation.
      expect(inboundRows(office1.path)).toEqual([]);

      // A redelivery is answered from the record: the provider is not asked for the words again.
      const again = await fetch(address, {
        method: "POST",
        headers: svix(raw, "evt_2"),
        body: raw,
      });
      expect(again.status).toBe(204);
      expect(office1.fetches()).toBe(1);
      await office1.close();

      // The rejection outlives the process: a restarted host still answers 2xx without refetching.
      const restarted = await office({ path: office1.path, serve });
      const later = await fetch(`${restarted.listener.address}/webhooks/resend`, {
        method: "POST",
        headers: svix(raw, "evt_3"),
        body: raw,
      });
      expect(later.status).toBe(204);
      expect(restarted.fetches()).toBe(0);
      expect(restarted.summaries()).toEqual(blocked);
      await restarted.close();
    },
  );

  it("answers 503 for a transient fetch failure, and takes the retry", async () => {
    let failing = true;
    const office1 = await office({
      serve: (emailId) =>
        failing ? new Response("unavailable", { status: 500 }) : received(emailId),
    });
    const raw = event();
    const address = `${office1.listener.address}/webhooks/resend`;

    const first = await fetch(address, { method: "POST", headers: svix(raw, "evt_1"), body: raw });
    expect(first.status).toBe(503);
    expect(office1.summaries()).toMatchObject([{ emailId: EMAIL, state: "received" }]);

    failing = false;
    const retry = await fetch(address, { method: "POST", headers: svix(raw, "evt_2"), body: raw });
    expect(retry.status).toBe(202);
    expect(office1.summaries()).toMatchObject([{ emailId: EMAIL, state: "prepared" }]);
    await office1.close();
  });

  it("refuses a forged signature, and writes nothing at all", async () => {
    const office1 = await office();
    const raw = event();
    const other = `whsec_${Buffer.from("another-office").toString("base64")}`;

    const response = await fetch(`${office1.listener.address}/webhooks/resend`, {
      method: "POST",
      headers: svix(raw, "evt_forged", other),
      body: raw,
    });

    expect(response.status).toBe(401);
    // Nothing verified, nothing parsed, nothing fetched, nothing remembered — not a receipt and not
    // a row in the duplicate table the gateway would have written.
    expect(office1.summaries()).toEqual([]);
    expect(inboundRows(office1.path)).toEqual([]);
    expect(office1.fetches()).toBe(0);
    await office1.close();
  });

  it("keys the guard by (channel, external id), so one id on two channels is two messages", async () => {
    const office1 = await office({ twilio: true });
    const shared = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const raw = event(shared);

    const email = await fetch(`${office1.listener.address}/webhooks/resend`, {
      method: "POST",
      headers: svix(raw, "evt_shared"),
      body: raw,
    });
    expect(email.status).toBe(202);

    const params = new URLSearchParams({
      AccountSid: "AC11111111111111111111111111111111",
      ApiVersion: "2010-04-01",
      Body: "Same identity, different provider",
      From: CUSTOMER,
      MessageSid: shared,
      SmsSid: shared,
      To: BUSINESS,
    }).toString();
    const url = `${office1.listener.address}/hooks/twilio`;
    const text = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": TWILIO_FORM_CONTENT_TYPE,
        "x-twilio-signature": twilioSignature(
          TOKEN,
          url,
          Object.fromEntries(new URLSearchParams(params)),
        ),
      },
      body: params,
    });
    expect(text.status).toBe(200);
    expect(office1.sms.map((outcome) => outcome.disposition)).toEqual(["recorded"]);

    // One row per channel for one string, because a MessageSid and an email id are different
    // namespaces: the coincidence must not swallow either message.
    expect(inboundRows(office1.path)).toEqual([
      { channel: "email", external_id: shared },
      { channel: "sms", external_id: shared },
    ]);
    await office1.close();
  });

  it("acknowledges a delivery it does not take as a message, and closes its socket", async () => {
    const office1 = await office();
    const raw = JSON.stringify({ type: "email.delivered", data: { email_id: EMAIL } });
    const address = `${office1.listener.address}/webhooks/resend`;

    const ignored = await fetch(address, {
      method: "POST",
      headers: svix(raw, "evt_delivered"),
      body: raw,
    });
    expect(ignored.status).toBe(204);
    expect(await ignored.text()).toBe("");
    expect(office1.summaries()).toEqual([]);

    await office1.close();
    await expect(fetch(address)).rejects.toThrow();
  });
});
