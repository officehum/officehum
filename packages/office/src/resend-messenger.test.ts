import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResendFetchFixture } from "./fixtures/resend-fetch.js";
import { openResendMessenger, type ResendMessengerOptions } from "./resend-messenger.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const file = () => {
  const directory = mkdtempSync(join(tmpdir(), "officehum-resend-"));
  temps.push(directory);
  return join(directory, "email.sqlite");
};
const intent = { to: "guest@example.test", channel: "email" as const, text: "Exact body\n" };

function fixtureOptions(fixture: ResendFetchFixture): ResendMessengerOptions {
  return {
    accountId: "test-account",
    fromEmail: "desk@example.test",
    subject: "Front Desk",
    getApiKey: async () => "synthetic-resend-key",
    fetch: fixture.fetch,
    now: () => fixture.now,
  };
}

describe("Resend Messenger", () => {
  it("persists acceptance and replays it forever without credential or network access", async () => {
    const fixture = new ResendFetchFixture();
    const path = file();
    const first = openResendMessenger(path, fixtureOptions(fixture));
    const receipt = await first.send(intent, { requestId: "1:1:send" });
    await first.close();

    fixture.now += 30 * 24 * 60 * 60 * 1000;
    const reopened = openResendMessenger(path, {
      ...fixtureOptions(fixture),
      getApiKey: async () => {
        throw new Error("credential must not be read");
      },
      fetch: async () => {
        throw new Error("network must not be used");
      },
    });
    expect(await reopened.send(intent, { requestId: "1:1:send" })).toEqual(receipt);
    expect(receipt).toMatchObject({ status: "accepted" });
    expect(fixture.posts).toBe(1);
    expect(fixture.acceptances).toBe(1);
    await reopened.close();
  });

  it("recovers response loss with the same payload and provider key inside the retry window", async () => {
    const fixture = new ResendFetchFixture();
    fixture.loseNextResponse = true;
    const path = file();
    const first = openResendMessenger(path, fixtureOptions(fixture));
    await expect(first.send(intent, { requestId: "same" })).rejects.toThrow(
      "Email request failed; its outcome is uncertain.",
    );
    await first.close();
    const second = openResendMessenger(path, {
      ...fixtureOptions(fixture),
      getApiKey: async () => "rotated-synthetic-resend-key",
    });
    const receipt = await second.send(intent, { requestId: "same" });
    expect(receipt.status).toBe("accepted");
    expect(fixture.posts).toBe(2);
    expect(fixture.acceptances).toBe(1);
    expect(fixture.requests[0]?.key).toBe(fixture.requests[1]?.key);
    expect(fixture.requests[0]?.payload).toBe(fixture.requests[1]?.payload);
    expect(fixture.requests.map(({ authorization }) => authorization)).toEqual([
      "Bearer synthetic-resend-key",
      "Bearer rotated-synthetic-resend-key",
    ]);
    await second.close();
  });

  it("binds complete intent and separates fresh ledger namespaces", async () => {
    const fixture = new ResendFetchFixture();
    const path = file();
    const host = openResendMessenger(path, fixtureOptions(fixture));
    await host.send(intent, { requestId: "same" });
    await expect(host.send({ ...intent, text: "Changed" }, { requestId: "same" })).rejects.toThrow(
      /different email payload/i,
    );
    await expect(host.send({ ...intent, channel: "sms" }, { requestId: "sms" })).rejects.toThrow(
      /email only/i,
    );
    await expect(
      host.send({ ...intent, to: "guest<guest@example.test>" }, { requestId: "display-address" }),
    ).rejects.toThrow(/destination is invalid/i);
    expect(fixture.posts).toBe(1);
    await host.close();

    expect(() =>
      openResendMessenger(path, { ...fixtureOptions(fixture), subject: "Other" }),
    ).toThrow(/authority/i);
    expect(() =>
      openResendMessenger(path, { ...fixtureOptions(fixture), accountId: "other-account" }),
    ).toThrow(/authority/i);
    expect(() =>
      openResendMessenger(path, {
        ...fixtureOptions(fixture),
        fromEmail: "other@example.test",
      }),
    ).toThrow(/authority/i);
    const other = openResendMessenger(file(), fixtureOptions(fixture));
    await other.send(intent, { requestId: "same" });
    expect(fixture.requests[0]?.key).not.toBe(fixture.requests[1]?.key);
    await other.close();
  });

  it("blocks retries at the cutoff, on clock regression, and after a late credential callback", async () => {
    const fixture = new ResendFetchFixture();
    fixture.status = 503;
    const path = file();
    const host = openResendMessenger(path, fixtureOptions(fixture));
    await expect(host.send(intent, { requestId: "cutoff" })).rejects.toThrow(/HTTP 503/);
    await host.close();

    fixture.now += 23 * 60 * 60 * 1000;
    const expired = openResendMessenger(path, fixtureOptions(fixture));
    await expect(expired.send(intent, { requestId: "cutoff" })).rejects.toThrow(
      /automatic retry is blocked/i,
    );
    expect(fixture.posts).toBe(1);
    await expired.close();

    const regressionPath = file();
    fixture.now = Date.parse("2030-01-01T00:00:00Z");
    const regression = openResendMessenger(regressionPath, fixtureOptions(fixture));
    await expect(regression.send(intent, { requestId: "regress" })).rejects.toThrow(/HTTP 503/);
    await regression.close();
    fixture.now -= 1;
    const regressed = openResendMessenger(regressionPath, fixtureOptions(fixture));
    await expect(regressed.send(intent, { requestId: "regress" })).rejects.toThrow(
      /automatic retry is blocked/i,
    );
    await regressed.close();

    const latePath = file();
    fixture.now = Date.parse("2030-01-01T00:00:00Z");
    const initial = openResendMessenger(latePath, fixtureOptions(fixture));
    await expect(initial.send(intent, { requestId: "late" })).rejects.toThrow(/HTTP 503/);
    await initial.close();
    fixture.now += 22 * 60 * 60 * 1000;
    const late = openResendMessenger(latePath, {
      ...fixtureOptions(fixture),
      getApiKey: async () => {
        fixture.now += 60 * 60 * 1000;
        return "rotated-synthetic-key";
      },
    });
    await expect(late.send(intent, { requestId: "late" })).rejects.toThrow(
      /automatic retry is blocked/i,
    );
    await late.close();
    expect(fixture.posts).toBe(3);
  });

  it("returns static bounded errors and closes active work", async () => {
    const fixture = new ResendFetchFixture();
    fixture.status = 409;
    fixture.responseBody = JSON.stringify({
      name: "invalid_idempotent_request",
      secret: "synthetic-resend-key",
    });
    const conflict = openResendMessenger(file(), fixtureOptions(fixture));
    await expect(conflict.send(intent, { requestId: "conflict" })).rejects.toThrow(
      "Resend rejected the idempotency binding; inspect the provider before retrying.",
    );
    await conflict.close();

    const concurrentFixture = new ResendFetchFixture();
    concurrentFixture.status = 409;
    concurrentFixture.responseBody = JSON.stringify({ name: "concurrent_idempotent_requests" });
    const concurrent = openResendMessenger(file(), fixtureOptions(concurrentFixture));
    await expect(concurrent.send(intent, { requestId: "concurrent" })).rejects.toThrow(
      "A matching Resend request is still in flight; retry the original submission later.",
    );
    concurrentFixture.status = undefined;
    concurrentFixture.responseBody = undefined;
    expect(await concurrent.send(intent, { requestId: "concurrent" })).toMatchObject({
      status: "accepted",
    });
    expect(concurrentFixture.requests[0]?.key).toBe(concurrentFixture.requests[1]?.key);
    await concurrent.close();

    const oversizedFixture = new ResendFetchFixture();
    oversizedFixture.responseBody = "x".repeat(65 * 1024);
    const oversized = openResendMessenger(file(), fixtureOptions(oversizedFixture));
    await expect(oversized.send(intent, { requestId: "large" })).rejects.toThrow(
      /response was invalid/i,
    );
    await oversized.close();

    const heldFixture = new ResendFetchFixture();
    heldFixture.holdNextResponse = true;
    const held = openResendMessenger(file(), fixtureOptions(heldFixture));
    const pending = held.send(intent, { requestId: "held" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await held.close();
    await expect(pending).rejects.toThrow(/closed|failed/i);
  });

  it.each([401, 403, 422, 429, 500])(
    "keeps HTTP %s failures pending with a safe error",
    async (status) => {
      const fixture = new ResendFetchFixture();
      fixture.status = status;
      fixture.responseBody = JSON.stringify({
        name: "provider_error",
        message: `synthetic-resend-key ${intent.text}`,
      });
      const host = openResendMessenger(file(), fixtureOptions(fixture));
      await expect(host.send(intent, { requestId: `status-${status}` })).rejects.toThrow(
        `Resend rejected the email request with HTTP ${status}.`,
      );
      await host.close();
    },
  );

  it.each(["", "{}", '{"id":""}'])(
    "rejects malformed successful response %j while retaining the pending operation",
    async (responseBody) => {
      const fixture = new ResendFetchFixture();
      fixture.responseBody = responseBody;
      const path = file();
      const first = openResendMessenger(path, fixtureOptions(fixture));
      await expect(first.send(intent, { requestId: "malformed-success" })).rejects.toThrow(
        /response was invalid/i,
      );
      await first.close();
      fixture.responseBody = undefined;
      const reopened = openResendMessenger(path, fixtureOptions(fixture));
      expect(await reopened.send(intent, { requestId: "malformed-success" })).toMatchObject({
        status: "accepted",
      });
      expect(fixture.acceptances).toBe(1);
      await reopened.close();
    },
  );

  it("applies the request deadline while a response body is stalled", async () => {
    vi.useFakeTimers();
    let reached!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const stalledFetch: typeof fetch = async () => {
      reached();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":"'));
          },
        }),
        { status: 200 },
      );
    };
    const fixture = new ResendFetchFixture();
    const host = openResendMessenger(file(), { ...fixtureOptions(fixture), fetch: stalledFetch });
    try {
      const pending = host.send(intent, { requestId: "stalled-body" });
      await bodyStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).rejects.toThrow("Email request failed; its outcome is uncertain.");
    } finally {
      await host.close();
      vi.useRealTimers();
    }
  });

  it("closes while a credential callback is still pending and prevents dispatch", async () => {
    const fixture = new ResendFetchFixture();
    let reached!: () => void;
    const credentialStarted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const host = openResendMessenger(file(), {
      ...fixtureOptions(fixture),
      getApiKey: async () => {
        reached();
        return new Promise<string>(() => {});
      },
    });
    const pending = host.send(intent, { requestId: "pending-credential" });
    await credentialStarted;
    await host.close();
    await expect(pending).rejects.toThrow(/closed/i);
    expect(fixture.posts).toBe(0);
  });

  it("rejects corrupt persisted timestamps and provider keys without repairing them", async () => {
    const fixture = new ResendFetchFixture();
    fixture.status = 503;
    const path = file();
    const host = openResendMessenger(path, fixtureOptions(fixture));
    await expect(host.send(intent, { requestId: "corrupt" })).rejects.toThrow(/HTTP 503/);
    await host.close();
    const database = new DatabaseSync(path);
    database
      .prepare("UPDATE email_operations SET provider_key = 'wrong' WHERE request_id = 'corrupt'")
      .run();
    database.close();
    expect(() => openResendMessenger(path, fixtureOptions(fixture))).toThrow(
      /malformed email ledger/i,
    );

    const payloadPath = file();
    const payloadHost = openResendMessenger(payloadPath, fixtureOptions(fixture));
    await expect(payloadHost.send(intent, { requestId: "payload" })).rejects.toThrow(/HTTP 503/);
    await payloadHost.close();
    const payloadDatabase = new DatabaseSync(payloadPath);
    payloadDatabase
      .prepare("UPDATE email_operations SET payload_json = ? WHERE request_id = 'payload'")
      .run(
        JSON.stringify({
          from: "attacker@example.test",
          to: [intent.to],
          subject: "Front Desk",
          text: intent.text,
        }),
      );
    payloadDatabase.close();
    expect(() => openResendMessenger(payloadPath, fixtureOptions(fixture))).toThrow(
      /malformed email ledger/i,
    );

    const schemaPath = file();
    const schemaHost = openResendMessenger(schemaPath, fixtureOptions(fixture));
    await schemaHost.close();
    const schemaDatabase = new DatabaseSync(schemaPath);
    schemaDatabase.exec("ALTER TABLE email_metadata ADD COLUMN unexpected TEXT");
    schemaDatabase.close();
    expect(() => openResendMessenger(schemaPath, fixtureOptions(fixture))).toThrow(
      /malformed email ledger/i,
    );

    const unsafePath = file();
    const unsafeHost = openResendMessenger(unsafePath, fixtureOptions(fixture));
    await expect(unsafeHost.send(intent, { requestId: "unsafe" })).rejects.toThrow(/HTTP 503/);
    await unsafeHost.close();
    const unsafeDatabase = new DatabaseSync(unsafePath);
    unsafeDatabase
      .prepare(
        "UPDATE email_operations SET first_attempt_at = ?, last_observed_at = ? WHERE request_id = 'unsafe'",
      )
      .run(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    unsafeDatabase.close();
    expect(() => openResendMessenger(unsafePath, fixtureOptions(fixture))).toThrow(
      /malformed email ledger/i,
    );
  });

  it("deduplicates same-key sends across independently opened adapters", async () => {
    const fixture = new ResendFetchFixture();
    const path = file();
    const first = openResendMessenger(path, fixtureOptions(fixture));
    const second = openResendMessenger(path, fixtureOptions(fixture));
    const [left, right] = await Promise.all([
      first.send(intent, { requestId: "shared" }),
      second.send(intent, { requestId: "shared" }),
    ]);
    expect(left).toEqual(right);
    expect(fixture.acceptances).toBe(1);
    expect(new Set(fixture.requests.map(({ key }) => key)).size).toBe(1);
    await Promise.all([first.close(), second.close()]);
  });
});
