import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openResendInbox } from "./resend-inbox.js";
import { openResendListener } from "./resend-listener.js";

const directories: string[] = [];
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const SECRET = `whsec_${Buffer.from("listener-test-secret").toString("base64")}`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Resend listener", () => {
  it("acknowledges only after durable intake and closes the loopback socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-listener-"));
    directories.push(directory);
    let getReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      getReached = resolve;
    });
    let releaseGet!: () => void;
    const heldGet = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
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
      fetch: async () => {
        getReached();
        await heldGet;
        return Response.json({
          id: "11111111-1111-4111-8111-111111111111",
          from: "guest@example.test",
          to: ["desk@example.test"],
          subject: "Hello",
          message_id: "<first@example.test>",
          reply_to: "guest@example.test",
          headers: {
            "message-id": "<first@example.test>",
            "reply-to": "guest@example.test",
          },
          authentication: { dmarc: "pass" },
          text: "Hello",
          html: "",
          attachments: [],
        });
      },
    });
    const listener = await openResendListener({ inbox, port: 0 });
    const raw = JSON.stringify({
      type: "email.received",
      created_at: "2030-01-01T00:00:00.000Z",
      data: {
        email_id: "11111111-1111-4111-8111-111111111111",
        from: "guest@example.test",
        to: ["desk@example.test"],
        subject: "Hello",
        message_id: "<first@example.test>",
        attachments: [],
      },
    });
    const timestamp = String(Math.floor(NOW / 1000));
    const id = "evt_listener";
    const signature = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
      .update(`${id}.${timestamp}.${raw}`)
      .digest("base64");
    const response = await fetch(`${listener.address}/webhooks/resend`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${signature}`,
      },
      body: raw,
    });
    expect(response.status).toBe(202);
    expect(inbox.summaries()).toHaveLength(1);
    const event = JSON.parse(raw) as never;
    const slowGet = inbox.fetchReceived("11111111-1111-4111-8111-111111111111", event);
    await reached;
    const secondRaw = JSON.stringify({
      type: "email.received",
      created_at: "2030-01-01T00:00:00.000Z",
      data: {
        email_id: "22222222-2222-4222-8222-222222222222",
        from: "other@example.test",
        to: ["desk@example.test"],
        subject: "Second",
        message_id: "<second@example.test>",
        attachments: [],
      },
    });
    const secondId = "evt_listener_second";
    const secondSignature = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
      .update(`${secondId}.${timestamp}.${secondRaw}`)
      .digest("base64");
    const secondResponse = await fetch(`${listener.address}/webhooks/resend`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": secondId,
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${secondSignature}`,
      },
      body: secondRaw,
    });
    expect(secondResponse.status).toBe(202);
    expect(inbox.summaries()).toHaveLength(2);
    releaseGet();
    await expect(slowGet).resolves.toMatchObject({
      normalized: { emailId: "11111111-1111-4111-8111-111111111111" },
    });
    await listener.close();
    await expect(fetch(`${listener.address}/webhooks/resend`)).rejects.toThrow();
    expect(inbox.summaries()).toHaveLength(2);
    await inbox.close();
  });
});
