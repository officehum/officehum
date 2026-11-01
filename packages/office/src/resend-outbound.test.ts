/**
 * Outbound SMS is impossible because nothing implements it, and email still leaves (RASF-3160).
 *
 * The two halves of one claim. `ChannelRegistry.deliver("sms", …)` throws `NoAdapterError` because no
 * adapter was ever registered under that name — not because a check said no — and the same registry
 * sends the same office's email through Resend with the threading headers, the pinned receipt and the
 * idempotency key it has always used. A guard that could be edited would be a promise; an empty slot is
 * the fact, and this file is the test of the fact.
 */
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelRegistry, NoAdapterError } from "@officehum/channels";
import { afterEach, describe, expect, it } from "vitest";
import { inboundAuthorityId, openResendInbox } from "./resend-inbox.js";
import { type EmailOutboundIntent, ResendOutbound } from "./resend-outbound.js";
import { createResendReplyMessenger } from "./resend-replies.js";

const directories: string[] = [];
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const SECRET = `whsec_${Buffer.from("outbound-test-secret").toString("base64")}`;
const SENT_ID = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

/** An inbox with one admitted inbound email, exactly as the reply transport needs to find it. */
async function seeded() {
  const directory = await mkdtemp(join(tmpdir(), "officehum-outbound-"));
  directories.push(directory);
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
  });
  const emailId = "11111111-1111-4111-8111-111111111111";
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
  const signature = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
    .update(`evt_outbound.${timestamp}.`)
    .update(raw)
    .digest("base64");
  await inbox.accept(raw, { id: "evt_outbound", timestamp, signature: `v1,${signature}` });
  inbox.savePrepared(
    emailId,
    { id: emailId },
    {
      emailId,
      from: "guest@example.test",
      to: ["desk@example.test"],
      subject: event.data.subject,
      messageId: event.data.message_id,
      inReplyTo: null,
      references: [],
      text: "Is January 15 open?",
      truncated: false,
      attachments: [],
    },
  );
  inbox.saveRoute(
    emailId,
    {
      authorityId: inboundAuthorityId(inbox.authority),
      sender: "guest@example.test",
      contactId: null,
      contactRevision: null,
    },
    7,
    "request-1",
    "envelope",
  );
  inbox.saveAdmission(emailId, 9);
  return { inbox, emailId };
}

describe("the office's outbound channels", () => {
  it("cannot send SMS, and can still send email", async () => {
    const { inbox, emailId } = await seeded();
    const requests: Array<{ key: string | null; payload: Record<string, unknown> }> = [];
    const messenger = createResendReplyMessenger({
      inbox,
      getHarness: () => undefined,
      getApiKey: async () => "synthetic-api-key",
      now: () => NOW,
      fetch: async (_input, init) => {
        requests.push({
          key: new Headers(init?.headers).get("idempotency-key"),
          payload: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({ id: SENT_ID });
      },
    });
    const registry = new ChannelRegistry().registerOutbound(new ResendOutbound(messenger));

    // The refusal is the absence of an adapter, and it happens before anything is sent.
    await expect(
      registry.deliver("sms", { to: "+15551234567", text: "On my way." }, "7:1:reply"),
    ).rejects.toThrow(NoAdapterError);
    expect(requests).toEqual([]);

    // Email goes out through the very same dispatcher, pinned to the receipt it answers.
    const intent: EmailOutboundIntent = {
      to: "guest@example.test",
      text: "January 15 is open.",
      receiptId: emailId,
      conversationId: "7",
    };
    const receipt = await registry.deliver("email", intent, "7:1:reply");

    expect(receipt).toEqual({ id: SENT_ID, status: "accepted" });
    expect(registry.deliverable()).toEqual(["email"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.payload).toEqual({
      from: "desk@example.test",
      to: ["guest@example.test"],
      reply_to: "desk@example.test",
      subject: "Re: Availability",
      text: "January 15 is open.",
      headers: {
        "In-Reply-To": "<first@example.test>",
        References: "<first@example.test>",
        "Auto-Submitted": "auto-replied",
        "X-Auto-Response-Suppress": "All",
      },
    });
    // The caller's idempotency key is the reply operation's identity, so a retry replays rather than
    // sending twice.
    expect(requests[0]?.key).toMatch(/^officehum\.email\.reply\.v1\//u);

    await messenger.close();
    await inbox.close();
  });

  it("refuses an email whose destination is not the receipt's sender", async () => {
    const { inbox, emailId } = await seeded();
    const requests: unknown[] = [];
    const messenger = createResendReplyMessenger({
      inbox,
      getHarness: () => undefined,
      getApiKey: async () => "synthetic-api-key",
      now: () => NOW,
      fetch: async (_input, init) => {
        requests.push(init?.body);
        return Response.json({ id: SENT_ID });
      },
    });
    const adapter = new ResendOutbound(messenger);

    await expect(
      adapter.deliver(
        {
          to: "somebody-else@example.test",
          text: "January 15 is open.",
          receiptId: emailId,
          conversationId: "7",
        },
        "7:1:reply",
      ),
    ).rejects.toThrow(/does not match the receipt/);
    expect(requests).toEqual([]);

    await messenger.close();
    await inbox.close();
  });
});
