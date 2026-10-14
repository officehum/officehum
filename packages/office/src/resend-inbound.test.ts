import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeReceivedEmail,
  parseReceivingEvent,
  verifySvixWebhook,
} from "./resend-inbound.js";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const SECRET = `whsec_${Buffer.from("synthetic-secret-bytes").toString("base64")}`;

function event() {
  return {
    type: "email.received",
    created_at: "2030-01-01T00:00:00.000Z",
    data: {
      email_id: "11111111-1111-4111-8111-111111111111",
      from: "Guest <guest@example.test>",
      to: ["desk@example.test"],
      subject: "Availability",
      message_id: "<first@example.test>",
      attachments: [],
    },
  };
}

function signed(value = event(), timestamp = Math.floor(NOW / 1000)) {
  const raw = new TextEncoder().encode(JSON.stringify(value));
  const id = "msg_synthetic";
  const signature = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
    .update(id)
    .update(".")
    .update(String(timestamp))
    .update(".")
    .update(raw)
    .digest("base64");
  return { raw, headers: { id, timestamp: String(timestamp), signature: `v1,${signature}` } };
}

describe("Resend inbound protocol", () => {
  it("verifies the exact raw Svix payload and both tolerance endpoints", () => {
    for (const offset of [-300, 300]) {
      const fixture = signed(event(), Math.floor(NOW / 1000) + offset);
      expect(verifySvixWebhook(fixture.raw, fixture.headers, [SECRET], NOW)).toEqual(fixture.raw);
    }
    const fixture = signed();
    const changed = Uint8Array.from(fixture.raw);
    changed[changed.length - 2] ^= 1;
    expect(() => verifySvixWebhook(changed, fixture.headers, [SECRET], NOW)).toThrow(
      "Webhook signature is invalid.",
    );
    const previous = `whsec_${Buffer.from("previous-secret-bytes").toString("base64")}`;
    const previousSignature = createHmac("sha256", Buffer.from(previous.slice(6), "base64"))
      .update(`${fixture.headers.id}.${fixture.headers.timestamp}.`)
      .update(fixture.raw)
      .digest("base64");
    expect(
      verifySvixWebhook(
        fixture.raw,
        {
          ...fixture.headers,
          signature: `v1,${Buffer.alloc(32).toString("base64")} v1,${previousSignature}`,
        },
        [SECRET, previous],
        NOW,
      ),
    ).toEqual(fixture.raw);
    for (const offset of [-301, 301]) {
      const stale = signed(event(), Math.floor(NOW / 1000) + offset);
      expect(() => verifySvixWebhook(stale.raw, stale.headers, [SECRET], NOW)).toThrow(
        "Webhook timestamp is invalid.",
      );
    }
  });

  it("parses a canonical receiving event and rejects conflicting message identifiers", () => {
    const fixture = signed();
    const parsed = parseReceivingEvent(fixture.raw);
    expect(parsed.data.email_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(() =>
      parseReceivingEvent(
        new TextEncoder().encode(
          JSON.stringify({ ...event(), data: { ...event().data, message_id: "bad" } }),
        ),
      ),
    ).toThrow("Receiving event is invalid.");
  });

  it("normalizes safe HTML without quoted content or asset URLs", () => {
    const received = {
      id: "11111111-1111-4111-8111-111111111111",
      from: "Guest <guest@example.test>",
      to: ["desk@example.test"],
      subject: "Availability",
      message_id: "<first@example.test>",
      reply_to: "guest@example.test",
      headers: {
        "message-id": "<first@example.test>",
        "reply-to": "guest@example.test",
      },
      authentication: { dmarc: "pass" },
      html: '<p>Hello &amp; welcome.</p><img src="https://asset.invalid/a"><blockquote>old</blockquote>',
      text: "",
      attachments: [],
    };
    const result = normalizeReceivedEmail(event(), received);
    expect(result).toMatchObject({
      from: "guest@example.test",
      text: "Hello & welcome.",
      messageId: "<first@example.test>",
      truncated: false,
    });
    expect(result.text).not.toContain("asset.invalid");
    expect(result.text).not.toContain("old");

    for (const [changed, reason] of [
      [{ authentication: { dmarc: "fail" } }, "authentication_failed"],
      [{ reply_to: "attacker@example.test" }, "reply_to_mismatch"],
      [{ headers: { ...received.headers, "auto-submitted": "auto-generated" } }, "auto_message"],
      [
        { headers: { ...received.headers, "in-reply-to": "not-a-message-id" } },
        "invalid_thread_headers",
      ],
      [{ from: "different@example.test" }, "binding_mismatch"],
    ] as const) {
      expect(() => normalizeReceivedEmail(event(), { ...received, ...changed })).toThrow(reason);
    }

    const deep = `${"<div>".repeat(45)}kept${"</div>".repeat(45)}`;
    expect(normalizeReceivedEmail(event(), { ...received, html: deep })).toMatchObject({
      truncated: true,
    });
  });
});
