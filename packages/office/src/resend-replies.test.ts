import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inboundAuthorityId, openResendInbox } from "./resend-inbox.js";
import { createResendReplyMessenger } from "./resend-replies.js";

const directories: string[] = [];
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const SECRET = `whsec_${Buffer.from("reply-test-secret").toString("base64")}`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function seeded() {
  const directory = await mkdtemp(join(tmpdir(), "officehum-reply-"));
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
  const event = {
    type: "email.received",
    created_at: "2030-01-01T00:00:00.000Z",
    data: {
      email_id: "11111111-1111-4111-8111-111111111111",
      from: "guest@example.test",
      to: ["desk@example.test"],
      subject: "Availability",
      message_id: "<first@example.test>",
      attachments: [],
    },
  };
  const raw = new TextEncoder().encode(JSON.stringify(event));
  const timestamp = String(Math.floor(NOW / 1000));
  const id = "evt_reply";
  const signature = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
    .update(`${id}.${timestamp}.`)
    .update(raw)
    .digest("base64");
  await inbox.accept(raw, { id, timestamp, signature: `v1,${signature}` });
  inbox.savePrepared(
    event.data.email_id,
    { id: event.data.email_id },
    {
      emailId: event.data.email_id,
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
    event.data.email_id,
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
  inbox.saveAdmission(event.data.email_id, 9);
  return { inbox, emailId: event.data.email_id };
}

describe("Resend threaded reply transport", () => {
  it("pins the inbound authority and sends the exact threaded payload once", async () => {
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
        return Response.json({ id: "22222222-2222-4222-8222-222222222222" });
      },
    });
    const target = await messenger.prepare(emailId, "7");
    expect(target).toMatchObject({
      to: "guest@example.test",
      from: "desk@example.test",
      inReplyTo: "<first@example.test>",
      references: ["<first@example.test>"],
    });
    const first = await messenger.send(
      { target, text: "January 15 is open." },
      { requestId: "7:1:reply" },
    );
    const replay = await messenger.send(
      { target, text: "January 15 is open." },
      { requestId: "7:1:reply" },
    );
    expect(first).toEqual(replay);
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
    expect(requests[0]?.key).toMatch(/^officehum\.email\.reply\.v1\//u);
    await messenger.close();
    await inbox.close();
  });

  it("never retries an uncertain operation at the exact 23-hour cutoff or after clock regression", async () => {
    const { inbox, emailId } = await seeded();
    let clock = NOW;
    let posts = 0;
    let credentials = 0;
    const messenger = createResendReplyMessenger({
      inbox,
      getHarness: () => undefined,
      getApiKey: async () => {
        credentials += 1;
        return "synthetic-api-key";
      },
      now: () => clock,
      fetch: async () => {
        posts += 1;
        throw new Error("synthetic lost response");
      },
    });
    const target = await messenger.prepare(emailId, "7");
    const intent = { target, text: "January 15 is open." };
    await expect(messenger.send(intent, { requestId: "7:1:uncertain" })).rejects.toThrow(
      "outcome is uncertain",
    );
    clock = NOW - 1;
    await expect(messenger.send(intent, { requestId: "7:1:uncertain" })).rejects.toThrow(
      "automatic retry is blocked",
    );
    clock = NOW + 23 * 60 * 60 * 1000;
    await expect(messenger.send(intent, { requestId: "7:1:uncertain" })).rejects.toThrow(
      "automatic retry is blocked",
    );
    expect({ posts, credentials }).toEqual({ posts: 1, credentials: 1 });
    await messenger.close();
    await inbox.close();
  });

  it("rechecks an uncertain operation after delayed credentials and replays acceptance credential-free", async () => {
    const pending = await seeded();
    let clock = NOW;
    let posts = 0;
    let delayCredential = false;
    const pendingMessenger = createResendReplyMessenger({
      inbox: pending.inbox,
      getHarness: () => undefined,
      getApiKey: async () => {
        if (delayCredential) clock = NOW + 23 * 60 * 60 * 1000;
        return "synthetic-api-key";
      },
      now: () => clock,
      fetch: async () => {
        posts += 1;
        throw new Error("synthetic lost response");
      },
    });
    const target = await pendingMessenger.prepare(pending.emailId, "7");
    const intent = { target, text: "January 15 is open." };
    await expect(pendingMessenger.send(intent, { requestId: "7:2:delayed" })).rejects.toThrow(
      "outcome is uncertain",
    );
    delayCredential = true;
    await expect(pendingMessenger.send(intent, { requestId: "7:2:delayed" })).rejects.toThrow(
      "automatic retry is blocked",
    );
    expect(posts).toBe(1);
    await pendingMessenger.close();
    await pending.inbox.close();

    const accepted = await seeded();
    let credentialAvailable = true;
    let acceptedPosts = 0;
    const acceptedMessenger = createResendReplyMessenger({
      inbox: accepted.inbox,
      getHarness: () => undefined,
      getApiKey: async () => {
        if (!credentialAvailable) throw new Error("unavailable");
        return "synthetic-api-key";
      },
      now: () => clock,
      fetch: async () => {
        acceptedPosts += 1;
        return Response.json({ id: "22222222-2222-4222-8222-222222222222" });
      },
    });
    const acceptedTarget = await acceptedMessenger.prepare(accepted.emailId, "7");
    const acceptedIntent = { target: acceptedTarget, text: "January 15 is open." };
    const first = await acceptedMessenger.send(acceptedIntent, { requestId: "7:3:accepted" });
    credentialAvailable = false;
    clock += 20 * 365 * 24 * 60 * 60 * 1000;
    await expect(
      acceptedMessenger.send(acceptedIntent, { requestId: "7:3:accepted" }),
    ).resolves.toEqual(first);
    expect(acceptedPosts).toBe(1);
    await acceptedMessenger.close();
    await accepted.inbox.close();
  });

  it("recovers one provider acceptance after the first response is lost", async () => {
    const { inbox, emailId } = await seeded();
    let clock = NOW;
    let posts = 0;
    const acceptances = new Map<string, string>();
    const messenger = createResendReplyMessenger({
      inbox,
      getHarness: () => undefined,
      getApiKey: async () => "synthetic-api-key",
      now: () => clock,
      fetch: async (_input, init) => {
        posts += 1;
        const key = new Headers(init?.headers).get("idempotency-key");
        if (key === null) throw new Error("missing idempotency key");
        const receipt = acceptances.get(key) ?? "77777777-7777-4777-8777-777777777777";
        acceptances.set(key, receipt);
        if (posts === 1) throw new Error("synthetic response loss after acceptance");
        return Response.json({ id: receipt });
      },
    });
    const target = await messenger.prepare(emailId, "7");
    const intent = { target, text: "January 15 is open." };
    await expect(messenger.send(intent, { requestId: "7:4:response-loss" })).rejects.toThrow(
      "outcome is uncertain",
    );
    clock += 1;
    await expect(messenger.send(intent, { requestId: "7:4:response-loss" })).resolves.toEqual({
      id: "77777777-7777-4777-8777-777777777777",
      status: "accepted",
    });
    expect({ posts, providerAcceptances: acceptances.size }).toEqual({
      posts: 2,
      providerAcceptances: 1,
    });
    await messenger.close();
    await inbox.close();
  });
});
