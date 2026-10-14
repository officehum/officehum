import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  durableInboundReplyApprover,
  inboundAuthorityId,
  openResendInbox,
  readInboundInbox,
} from "./resend-inbox.js";
import { openResendMessenger } from "./resend-messenger.js";

const directories: string[] = [];
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const SECRET = `whsec_${Buffer.from("inbox-test-secret").toString("base64")}`;
const authority = {
  version: 1 as const,
  messengerId: "officehum.resend.v1:test",
  accountId: "account_test",
  fromEmail: "desk@example.test",
  inboundEmail: "desk@example.test",
};

function signed(emailId = "11111111-1111-4111-8111-111111111111", eventId = "evt_1") {
  const event = {
    type: "email.received",
    created_at: "2030-01-01T00:00:00.000Z",
    data: {
      email_id: emailId,
      from: "guest@example.test",
      to: ["desk@example.test"],
      subject: "Hello",
      message_id: "<first@example.test>",
      attachments: [],
    },
  };
  const raw = new TextEncoder().encode(JSON.stringify(event));
  const timestamp = String(Math.floor(NOW / 1000));
  const signature = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
    .update(`${eventId}.${timestamp}.`)
    .update(raw)
    .digest("base64");
  return { raw, headers: { id: eventId, timestamp, signature: `v1,${signature}` } };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Resend inbox", () => {
  it("derives the same authority ID from every property order", () => {
    expect(inboundAuthorityId(authority)).toBe(
      inboundAuthorityId({
        accountId: authority.accountId,
        fromEmail: authority.fromEmail,
        inboundEmail: authority.inboundEmail,
        messengerId: authority.messengerId,
        version: authority.version,
      }),
    );
  });

  it("durably accepts once and returns a sanitized summary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-inbox-"));
    directories.push(directory);
    const path = join(directory, "inbound.sqlite");
    const inbox = openResendInbox(path, {
      authority,
      getApiKey: async () => "synthetic",
      getWebhookSecrets: async () => [SECRET],
      now: () => NOW,
    });
    const fixture = signed();
    await expect(inbox.accept(fixture.raw, fixture.headers)).resolves.toEqual({
      status: 202,
      emailId: "11111111-1111-4111-8111-111111111111",
    });
    await expect(inbox.accept(fixture.raw, fixture.headers)).resolves.toEqual({
      status: 200,
      emailId: "11111111-1111-4111-8111-111111111111",
    });
    const secondEvent = signed(undefined, "evt_2");
    await expect(inbox.accept(secondEvent.raw, secondEvent.headers)).resolves.toEqual({
      status: 200,
      emailId: "11111111-1111-4111-8111-111111111111",
    });
    expect(inbox.summaries()).toEqual([
      {
        emailId: "11111111-1111-4111-8111-111111111111",
        state: "received",
        reason: null,
        conversationId: null,
        submissionId: null,
      },
    ]);
    const namespace = inbox.namespace;
    await inbox.close();

    const reopened = openResendInbox(path, {
      authority,
      getApiKey: async () => "synthetic",
      getWebhookSecrets: async () => [SECRET],
      now: () => NOW,
    });
    expect(reopened.namespace).toBe(namespace);
    expect(reopened.summaries()).toHaveLength(1);
    await reopened.close();
  });

  it("rejects an unknown persisted reason without echoing its contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-inbox-"));
    directories.push(directory);
    const path = join(directory, "inbound.sqlite");
    const options = {
      authority,
      getApiKey: async () => "synthetic",
      getWebhookSecrets: async () => [SECRET],
      now: () => NOW,
    };
    const inbox = openResendInbox(path, options);
    const fixture = signed();
    await inbox.accept(fixture.raw, fixture.headers);
    await inbox.close();

    const marker = "PRIVATE CUSTOMER CONTENT";
    const database = new DatabaseSync(path);
    database
      .prepare("UPDATE receipts SET state='blocked', reason=? WHERE email_id=?")
      .run(marker, "11111111-1111-4111-8111-111111111111");
    database.close();

    for (const inspect of [
      () => openResendInbox(path, options),
      () => readInboundInbox(directory),
    ]) {
      let thrown: unknown;
      try {
        await inspect();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("Malformed inbound receipt.");
      expect((thrown as Error).message).not.toContain(marker);
    }
  });

  it("leaves accepted and pending outbound operations byte-for-byte unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-inbox-"));
    directories.push(directory);
    const outboundPath = join(directory, "email.sqlite");
    let requests = 0;
    const outbound = openResendMessenger(outboundPath, {
      accountId: "account_test",
      fromEmail: "desk@example.test",
      subject: "Front Desk",
      getApiKey: async () => "synthetic",
      now: () => NOW,
      fetch: async () => {
        requests += 1;
        if (requests === 1) {
          return Response.json({ id: "22222222-2222-4222-8222-222222222222" });
        }
        throw new Error("synthetic response loss");
      },
    });
    const intent = { to: "guest@example.test", channel: "email" as const, text: "Hello" };
    await outbound.send(intent, { requestId: "accepted-outbound" });
    await expect(outbound.send(intent, { requestId: "pending-outbound" })).rejects.toThrow(
      "outcome is uncertain",
    );
    await outbound.close();

    const snapshot = () => {
      const database = new DatabaseSync(outboundPath, { readOnly: true });
      try {
        return {
          metadata: database.prepare("SELECT * FROM email_metadata ORDER BY singleton").all(),
          operations: database.prepare("SELECT * FROM email_operations ORDER BY request_id").all(),
        };
      } finally {
        database.close();
      }
    };
    const before = snapshot();
    expect(before.operations).toMatchObject([
      { request_id: "accepted-outbound", state: "accepted" },
      { request_id: "pending-outbound", state: "pending" },
    ]);
    const inbox = openResendInbox(join(directory, "inbound.sqlite"), {
      authority,
      getApiKey: async () => "synthetic",
      getWebhookSecrets: async () => [SECRET],
      now: () => NOW,
    });
    await inbox.close();
    expect(snapshot()).toEqual(before);
  });

  it("binds event IDs, complete payloads, and authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-inbox-"));
    directories.push(directory);
    const path = join(directory, "inbound.sqlite");
    const inbox = openResendInbox(path, {
      authority,
      getApiKey: async () => "synthetic",
      getWebhookSecrets: async () => [SECRET],
      now: () => NOW,
    });
    await inbox.accept(signed().raw, signed().headers);
    const changed = signed("22222222-2222-4222-8222-222222222222");
    await expect(inbox.accept(changed.raw, changed.headers)).rejects.toThrow(
      "Webhook event identity conflict.",
    );
    await inbox.close();
    expect(() =>
      openResendInbox(path, {
        authority: { ...authority, inboundEmail: "other@example.test" },
        getApiKey: async () => "synthetic",
        getWebhookSecrets: async () => [SECRET],
        now: () => NOW,
      }),
    ).toThrow("Inbound authority does not match this inbox.");
  });

  it("blocks a signed event addressed outside the bound inbound route", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-inbox-"));
    directories.push(directory);
    const inbox = openResendInbox(join(directory, "inbound.sqlite"), {
      authority,
      getApiKey: async () => "synthetic",
      getWebhookSecrets: async () => [SECRET],
      now: () => NOW,
    });
    const fixture = signed();
    const event = JSON.parse(new TextDecoder().decode(fixture.raw)) as {
      data: { to: string[] };
    };
    event.data.to = ["other@example.test"];
    const raw = new TextEncoder().encode(JSON.stringify(event));
    const signature = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
      .update(`evt_1.${fixture.headers.timestamp}.`)
      .update(raw)
      .digest("base64");
    await inbox.accept(raw, { ...fixture.headers, signature: `v1,${signature}` });
    expect(inbox.summaries()).toEqual([
      expect.objectContaining({ state: "blocked", reason: "route_mismatch" }),
    ]);
    await inbox.close();
  });

  it("rejects a second event that reuses an email identity with changed content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-inbox-"));
    directories.push(directory);
    const inbox = openResendInbox(join(directory, "inbound.sqlite"), {
      authority,
      getApiKey: async () => "synthetic",
      getWebhookSecrets: async () => [SECRET],
      now: () => NOW,
    });
    await inbox.accept(signed().raw, signed().headers);
    const changed = signed(undefined, "evt_2");
    const parsed = JSON.parse(new TextDecoder().decode(changed.raw)) as {
      data: { subject: string };
    };
    parsed.data.subject = "Changed";
    const raw = new TextEncoder().encode(JSON.stringify(parsed));
    const timestamp = String(Math.floor(NOW / 1000));
    const signature = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
      .update(`evt_2.${timestamp}.`)
      .update(raw)
      .digest("base64");
    await expect(
      inbox.accept(raw, { id: "evt_2", timestamp, signature: `v1,${signature}` }),
    ).rejects.toThrow("Inbound email identity conflict.");
    expect(inbox.summaries()).toHaveLength(1);
    await inbox.close();
  });

  it("keeps each fsynced receipt transition and exact reply decision across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-inbox-"));
    directories.push(directory);
    const path = join(directory, "inbound.sqlite");
    const options = {
      authority,
      getApiKey: async () => "synthetic",
      getWebhookSecrets: async () => [SECRET],
      now: () => NOW,
    };
    let inbox = openResendInbox(path, options);
    const fixture = signed();
    await inbox.accept(fixture.raw, fixture.headers);
    const normalized = {
      emailId: "11111111-1111-4111-8111-111111111111",
      from: "guest@example.test",
      to: ["desk@example.test"],
      subject: "Hello",
      messageId: "<first@example.test>",
      inReplyTo: null,
      references: [],
      text: "Hello",
      truncated: false,
      attachments: [],
    };
    inbox.savePrepared(normalized.emailId, { id: normalized.emailId }, normalized);
    await inbox.close();
    inbox = openResendInbox(path, options);
    expect(inbox.receipt(normalized.emailId)?.state).toBe("prepared");
    inbox.saveRoute(
      normalized.emailId,
      {
        authorityId: inboundAuthorityId(inbox.authority),
        sender: normalized.from,
        contactId: null,
        contactRevision: null,
      },
      7,
      "stable-request",
      "saved envelope",
    );
    await inbox.close();
    inbox = openResendInbox(path, options);
    expect(inbox.receipt(normalized.emailId)).toMatchObject({
      conversationId: 7,
      requestId: "stable-request",
      envelope: "saved envelope",
    });
    inbox.saveAdmission(normalized.emailId, 9);
    await inbox.close();
    inbox = openResendInbox(path, options);
    expect(inbox.receipt(normalized.emailId)).toMatchObject({ state: "admitted", submissionId: 9 });

    const request = {
      approvalId: "confirm_inbound_reply",
      description: "Confirm exact reply",
      tool: "reply_message",
      arguments: { receiptId: normalized.emailId, text: "Reply" },
      conversationId: "7",
      taskId: "1",
      callId: "call-1",
    };
    let prompts = 0;
    const approve = durableInboundReplyApprover(inbox, async () => {
      prompts += 1;
      return { approved: false, by: "operator" };
    });
    await expect(
      Promise.all([approve(request, {} as never), approve(request, {} as never)]),
    ).resolves.toEqual([
      { approved: false, by: "operator" },
      { approved: false, by: "operator" },
    ]);
    expect(prompts).toBe(1);
    await inbox.close();
    inbox = openResendInbox(path, options);
    const replay = durableInboundReplyApprover(inbox, async () => {
      prompts += 1;
      return { approved: true };
    });
    await expect(replay(request, {} as never)).resolves.toEqual({
      approved: false,
      by: "operator",
    });
    await expect(
      replay({ ...request, arguments: { ...request.arguments, text: "Changed" } }, {} as never),
    ).rejects.toThrow("different reply");
    expect(prompts).toBe(1);
    inbox.saveSettlement(normalized.emailId, { status: "done" });
    await inbox.close();
    inbox = openResendInbox(path, options);
    expect(inbox.receipt(normalized.emailId)).toMatchObject({
      state: "settled",
      settlement: { status: "done" },
    });
    await inbox.close();
  });

  it("durably rotates bounded work past held admissions and retryable fetch failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-inbox-"));
    directories.push(directory);
    const path = join(directory, "inbound.sqlite");
    const options = {
      authority,
      getApiKey: async () => "synthetic",
      getWebhookSecrets: async () => [SECRET],
      now: () => NOW,
    };
    const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    let inbox = openResendInbox(path, options);
    for (let index = 1; index <= 21; index += 1) {
      const emailId = id(index);
      await inbox.accept(
        signed(emailId, `evt_${index}`).raw,
        signed(emailId, `evt_${index}`).headers,
      );
      const normalized = {
        emailId,
        from: `${index}@example.test`,
        to: ["desk@example.test"],
        subject: "Hello",
        messageId: `<${index}@example.test>`,
        inReplyTo: null,
        references: [],
        text: "Hello",
        truncated: false,
        attachments: [],
      };
      inbox.savePrepared(emailId, { id: emailId }, normalized);
      if (index <= 20) {
        inbox.saveRoute(
          emailId,
          {
            authorityId: inboundAuthorityId(inbox.authority),
            sender: normalized.from,
            contactId: null,
            contactRevision: null,
          },
          index,
          `request-${index}`,
          `envelope-${index}`,
        );
        inbox.saveAdmission(emailId, index);
      }
    }
    expect(inbox.eligible()).toHaveLength(20);
    await inbox.close();

    inbox = openResendInbox(path, options);
    expect(inbox.eligible()[0]?.emailId).toBe(id(21));
    await inbox.close();

    const retryPath = join(directory, "retry.sqlite");
    inbox = openResendInbox(retryPath, options);
    for (let index = 101; index <= 121; index += 1) {
      await inbox.accept(
        signed(id(index), `evt_${index}`).raw,
        signed(id(index), `evt_${index}`).headers,
      );
    }
    const firstBatch = inbox.eligible();
    expect(firstBatch).toHaveLength(20);
    firstBatch.forEach(({ emailId }) => {
      inbox.defer(emailId, "fetch_failed");
    });
    await inbox.close();
    inbox = openResendInbox(retryPath, options);
    expect(inbox.eligible()[0]?.emailId).toBe(id(121));
    await inbox.close();
  });

  it("aborts and drains a blocked receiving reader before closing SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "officehum-inbox-"));
    directories.push(directory);
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const inbox = openResendInbox(join(directory, "inbound.sqlite"), {
      authority,
      getApiKey: async () => "synthetic",
      getWebhookSecrets: async () => [SECRET],
      now: () => NOW,
      fetch: async () => {
        reached();
        return new Response(
          new ReadableStream<Uint8Array>({
            pull: async () => new Promise<never>(() => {}),
            cancel: async () => new Promise<never>(() => {}),
          }),
        );
      },
    });
    const fixture = signed();
    await inbox.accept(fixture.raw, fixture.headers);
    const receipt = inbox.receipt("11111111-1111-4111-8111-111111111111");
    if (receipt === undefined) throw new Error("missing receipt");
    const pending = inbox.fetchReceived(receipt.emailId, receipt.event);
    await started;
    const closing = inbox.close();
    await expect(pending).rejects.toThrow("Receiving request failed.");
    await closing;
  });
});
