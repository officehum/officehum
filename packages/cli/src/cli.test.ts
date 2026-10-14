import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { awaitWithContext, BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import frontdesk from "@officehum/frontdesk";
import {
  createDemoModels,
  durableInboundReplyApprover,
  openConsoleMessenger,
  openLocalCalendar,
  openResendInbox,
  openSolo,
  readMessengerIdentity,
} from "@officehum/office";
import { afterEach, describe, expect, it } from "vitest";
import { fakeCalendar } from "../../google-calendar/src/index.js";
import { type CliIo, cliApprover, cliReplyDecision, interruptCli, runCli } from "./cli.js";
import { createTerminalIo } from "./terminal-io.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const state = () => {
  const directory = mkdtempSync(join(tmpdir(), "officehum-cli-"));
  temps.push(directory);
  return directory;
};

function io(...answers: [] | [string | undefined]) {
  const answer = answers.length === 0 ? "allow" : answers[0];
  const output: string[] = [];
  const errors: string[] = [];
  const value: CliIo = {
    output: (line) => output.push(line),
    error: (line) => errors.push(line),
    readApproval: async () => answer,
  };
  return { io: value, output, errors };
}

async function entryCount(directory: string): Promise<number> {
  const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
  const role = frontdesk({ calendar });
  const solo = await openSolo({ directory, role, ...createDemoModels() });
  try {
    return (await solo.root.context(BACKGROUND_CONTEXT)).entries.length;
  } finally {
    await solo.close();
    calendar.close();
  }
}

async function createLiveState(directory: string, modelId = "gpt-6-sol"): Promise<void> {
  const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
  const role = frontdesk({ calendar });
  const faux = fauxProvider({ provider: "openai", models: [{ id: modelId }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const solo = await openSolo({
    directory,
    role,
    models,
    model: { provider: "openai", modelId },
  });
  await solo.close();
  calendar.close();
}

async function createPendingDemo(directory: string): Promise<string> {
  const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
  let reached!: () => void;
  const barrier = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const role = frontdesk({
    calendar,
    approve: async (_request, context) => {
      reached();
      await awaitWithContext(new Promise<never>(() => {}), context);
      return { approved: true };
    },
  });
  const solo = await openSolo({ directory, role, ...createDemoModels() });
  const pending = solo.submit("Book Demo Guest on 2030-01-15", "terminal-pending");
  await barrier;
  const [record] = (await solo.harness.inspect(BACKGROUND_CONTEXT)).submissions;
  if (record === undefined) throw new Error("Expected a pending submission");
  await solo.close();
  await pending.catch(() => {});
  calendar.close();
  return String(record.id);
}

async function createGoogleState(directory: string, calendarId = "calendar@example.test") {
  const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
  const role = frontdesk({ calendar });
  const solo = await openSolo({
    directory,
    role,
    ...createDemoModels(),
    connectorIdentity: {
      version: 1,
      backend: "google",
      calendarId,
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
    },
  });
  await solo.close();
  calendar.close();
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing loopback port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for CLI state");
}

describe("runCli", () => {
  it("keeps console as the default even when Resend environment values exist", async () => {
    const directory = state();
    const prior = {
      account: process.env.RESEND_ACCOUNT_ID,
      from: process.env.RESEND_FROM_EMAIL,
      subject: process.env.RESEND_SUBJECT,
      key: process.env.RESEND_API_KEY,
    };
    process.env.RESEND_ACCOUNT_ID = "ignored-account";
    process.env.RESEND_FROM_EMAIL = "ignored@example.test";
    process.env.RESEND_SUBJECT = "Ignored";
    process.env.RESEND_API_KEY = "synthetic-resend-key";
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-6-sol" }] });
    faux.setResponses([fauxAssistantMessage("No action requested.")]);
    const models = createModels();
    models.setProvider(faux.provider);
    try {
      const capture = io();
      expect(
        await runCli(
          [
            "start",
            "--state",
            directory,
            "--message",
            "Say hello",
            "--request-id",
            "console-default",
          ],
          capture.io,
          {
            createLiveModels: () => ({
              models,
              model: { provider: "openai", modelId: "gpt-6-sol" },
            }),
          },
        ),
      ).toBe(0);
      expect(readMessengerIdentity(directory)).toEqual({ version: 1, backend: "console" });
      expect(capture.output.join("\n")).toContain("Messaging: console outbox");
    } finally {
      if (prior.account === undefined) delete process.env.RESEND_ACCOUNT_ID;
      else process.env.RESEND_ACCOUNT_ID = prior.account;
      if (prior.from === undefined) delete process.env.RESEND_FROM_EMAIL;
      else process.env.RESEND_FROM_EMAIL = prior.from;
      if (prior.subject === undefined) delete process.env.RESEND_SUBJECT;
      else process.env.RESEND_SUBJECT = prior.subject;
      if (prior.key === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prior.key;
    }
  });

  it("requires explicit complete Resend configuration and displays the persisted authority", async () => {
    const directory = state();
    const missing = io();
    expect(
      await runCli(
        [
          "start",
          "--state",
          directory,
          "--messenger",
          "resend",
          "--message",
          "Say hello",
          "--request-id",
          "resend-missing",
        ],
        missing.io,
      ),
    ).toBe(1);
    expect(missing.errors.join("\n")).toMatch(/RESEND_ACCOUNT_ID/);

    const prior = {
      account: process.env.RESEND_ACCOUNT_ID,
      from: process.env.RESEND_FROM_EMAIL,
      subject: process.env.RESEND_SUBJECT,
      key: process.env.RESEND_API_KEY,
    };
    process.env.RESEND_ACCOUNT_ID = "test-account";
    process.env.RESEND_FROM_EMAIL = "desk@example.test";
    process.env.RESEND_SUBJECT = "Front Desk";
    process.env.RESEND_API_KEY = "synthetic-resend-key";
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-6-sol" }] });
    faux.setResponses([fauxAssistantMessage("No action requested.")]);
    const models = createModels();
    models.setProvider(faux.provider);
    try {
      const capture = io();
      expect(
        await runCli(
          [
            "start",
            "--state",
            directory,
            "--messenger",
            "resend",
            "--message",
            "Say hello",
            "--request-id",
            "resend-configured",
          ],
          capture.io,
          {
            createLiveModels: () => ({
              models,
              model: { provider: "openai", modelId: "gpt-6-sol" },
            }),
          },
        ),
      ).toBe(0);
      expect(readMessengerIdentity(directory)).toEqual({
        version: 1,
        backend: "resend",
        accountId: "test-account",
        fromEmail: "desk@example.test",
        subject: "Front Desk",
      });
      expect(capture.output.join("\n")).toMatch(
        /Messaging: Resend.*test-account.*desk@example\.test.*Front Desk/is,
      );
    } finally {
      if (prior.account === undefined) delete process.env.RESEND_ACCOUNT_ID;
      else process.env.RESEND_ACCOUNT_ID = prior.account;
      if (prior.from === undefined) delete process.env.RESEND_FROM_EMAIL;
      else process.env.RESEND_FROM_EMAIL = prior.from;
      if (prior.subject === undefined) delete process.env.RESEND_SUBJECT;
      else process.env.RESEND_SUBJECT = prior.subject;
      if (prior.key === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prior.key;
    }
  });

  it("rejects Resend for demo and on read-only commands", async () => {
    const demo = io();
    expect(await runCli(["demo", "--messenger", "resend"], demo.io)).toBe(2);
    expect(demo.errors.join("\n")).toMatch(/synthetic demo.*console/i);
    const contacts = io();
    expect(await runCli(["contacts", "--messenger", "console"], contacts.io)).toBe(2);
  });

  it("rejects console listening and malformed webhook secrets before opening runtime state", async () => {
    const consoleCapture = io();
    expect(
      await runCli(["listen", "--messenger", "console", "--port", "8787"], consoleCapture.io),
    ).toBe(1);
    expect(consoleCapture.errors.join("\n")).toContain("requires the Resend Messenger");

    const directory = state();
    const names = [
      "RESEND_ACCOUNT_ID",
      "RESEND_FROM_EMAIL",
      "RESEND_SUBJECT",
      "RESEND_API_KEY",
      "RESEND_INBOUND_EMAIL",
      "RESEND_WEBHOOK_SECRET",
    ] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
      RESEND_ACCOUNT_ID: "account_test",
      RESEND_FROM_EMAIL: "desk@example.test",
      RESEND_SUBJECT: "Front Desk",
      RESEND_API_KEY: "synthetic",
      RESEND_INBOUND_EMAIL: "desk@example.test",
      RESEND_WEBHOOK_SECRET: "not-base64",
    });
    try {
      const malformed = io();
      expect(
        await runCli(
          ["listen", "--state", directory, "--messenger", "resend", "--port", "8787"],
          malformed.io,
        ),
      ).toBe(1);
      expect(malformed.errors).toEqual(["RESEND_WEBHOOK_SECRET is invalid."]);
      expect(existsSync(join(directory, "inbound.sqlite"))).toBe(false);
    } finally {
      for (const name of names) {
        const value = prior[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("reopens a fresh Resend host for the resume probe and live session", async () => {
    const directory = state();
    const prior = {
      account: process.env.RESEND_ACCOUNT_ID,
      from: process.env.RESEND_FROM_EMAIL,
      subject: process.env.RESEND_SUBJECT,
      key: process.env.RESEND_API_KEY,
    };
    process.env.RESEND_ACCOUNT_ID = "test-account";
    process.env.RESEND_FROM_EMAIL = "desk@example.test";
    process.env.RESEND_SUBJECT = "Front Desk";
    process.env.RESEND_API_KEY = "synthetic-resend-key";
    let opened = 0;
    let closed = 0;
    let modelCall = 0;
    const dependencies = {
      openResendMessenger: () => {
        opened += 1;
        let isClosed = false;
        return {
          identity: `officehum.resend.v1:${"a".repeat(64)}`,
          send: async () => ({ id: "unused", status: "accepted" as const }),
          close: async () => {
            if (isClosed) return;
            isClosed = true;
            closed += 1;
          },
        };
      },
      createLiveModels: () => {
        const faux = fauxProvider({
          provider: "openai",
          models: [{ id: "gpt-6-sol" }],
        });
        if (modelCall === 0) faux.setResponses([fauxAssistantMessage("No action requested.")]);
        modelCall += 1;
        const models = createModels();
        models.setProvider(faux.provider);
        return { models, model: { provider: "openai", modelId: "gpt-6-sol" } };
      },
    };
    try {
      expect(
        await runCli(
          [
            "start",
            "--state",
            directory,
            "--messenger",
            "resend",
            "--message",
            "No action",
            "--request-id",
            "resend-lifetime",
          ],
          io().io,
          dependencies,
        ),
      ).toBe(0);
      delete process.env.RESEND_ACCOUNT_ID;
      delete process.env.RESEND_FROM_EMAIL;
      delete process.env.RESEND_SUBJECT;
      expect(await runCli(["resume", "--state", directory], io().io, dependencies)).toBe(0);
      expect({ opened, closed }).toEqual({ opened: 3, closed: 3 });
    } finally {
      if (prior.account === undefined) delete process.env.RESEND_ACCOUNT_ID;
      else process.env.RESEND_ACCOUNT_ID = prior.account;
      if (prior.from === undefined) delete process.env.RESEND_FROM_EMAIL;
      else process.env.RESEND_FROM_EMAIL = prior.from;
      if (prior.subject === undefined) delete process.env.RESEND_SUBJECT;
      else process.env.RESEND_SUBJECT = prior.subject;
      if (prior.key === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prior.key;
    }
  });

  it("prints the version", async () => {
    const capture = io();
    expect(await runCli(["--version"], capture.io)).toBe(0);
    expect(capture.output.join("\n")).toMatch(/officehum 0\.0\.0.*1\.0\.2/);
  });

  it("rejects unknown commands and options", async () => {
    const first = io();
    expect(await runCli(["wat"], first.io)).toBe(2);
    const second = io();
    expect(await runCli(["bookings", "--wat"], second.io)).toBe(2);
    expect(second.errors.join("\n")).toContain("Unknown option");
  });

  it("requires an explicit request id for live start", async () => {
    const capture = io();
    expect(await runCli(["start", "--message", "Book Guest on 2030-01-15"], capture.io)).toBe(2);
    expect(capture.errors.join("\n")).toContain("--request-id");
  });

  it("inspects empty and populated contacts without credentials or provider setup", async () => {
    const absent = state();
    const empty = io();
    expect(await runCli(["contacts", "--state", absent], empty.io)).toBe(0);
    expect(empty.output).toEqual(["No contacts."]);
    expect(existsSync(join(absent, "harness"))).toBe(false);

    const directory = state();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const role = frontdesk({ calendar });
    const solo = await openSolo({ directory, role, ...createDemoModels() });
    const create = role.extensions
      .flatMap((extension) => extension.tools ?? [])
      .find((tool) => tool.name === "create_contact");
    if (create === undefined) throw new Error("missing create_contact tool");
    await create.execute(
      { name: "Zulu Guest", phone: "+15551234567" },
      {
        conversationId: 1,
        taskId: 1,
        callId: "seed-zulu",
        commit: solo.harness.commit.bind(solo.harness),
        snapshot: solo.harness.snapshot.bind(solo.harness),
      } as never,
      BACKGROUND_CONTEXT,
    );
    await create.execute(
      { name: "Alpha Guest", email: "alpha@example.com" },
      {
        conversationId: 1,
        taskId: 1,
        callId: "seed-alpha",
        commit: solo.harness.commit.bind(solo.harness),
        snapshot: solo.harness.snapshot.bind(solo.harness),
      } as never,
      BACKGROUND_CONTEXT,
    );
    await solo.close();
    calendar.close();

    const populated = io();
    expect(await runCli(["contacts", "--state", directory], populated.io)).toBe(0);
    expect(populated.output).toEqual([
      JSON.stringify({
        id: "contact-2",
        revision: 1,
        name: "Alpha Guest",
        email: "alpha@example.com",
        phone: null,
      }),
      JSON.stringify({
        id: "contact-1",
        revision: 1,
        name: "Zulu Guest",
        email: null,
        phone: "+15551234567",
      }),
    ]);

    const googleDirectory = state();
    await createGoogleState(googleDirectory);
    const google = io();
    expect(
      await runCli(["contacts", "--state", googleDirectory], google.io, {
        createGoogleCalendar: () => {
          throw new Error("contacts must not construct a provider client");
        },
        createLiveModels: () => {
          throw new Error("contacts must not construct models");
        },
      }),
    ).toBe(0);
    expect(google.output).toEqual(["No contacts."]);
  });

  it("prints only sanitized blocked inbox metadata without credentials or models", async () => {
    const directory = state();
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const secret = `whsec_${Buffer.from("cli-inbox-secret").toString("base64")}`;
    const inbox = openResendInbox(join(directory, "inbound.sqlite"), {
      authority: {
        version: 1,
        messengerId: "officehum.resend.v1:test",
        accountId: "account_test",
        fromEmail: "desk@example.test",
        inboundEmail: "desk@example.test",
      },
      getApiKey: async () => {
        throw new Error("inbox inspection must not request a credential");
      },
      getWebhookSecrets: async () => [secret],
      now: () => now,
    });
    const event = {
      type: "email.received",
      created_at: "2030-01-01T00:00:00.000Z",
      data: {
        email_id: "66666666-6666-4666-8666-666666666666",
        from: "private-sender@example.test",
        to: ["other@example.test"],
        subject: "Private subject",
        message_id: "<private@example.test>",
        attachments: [],
      },
    };
    const raw = new TextEncoder().encode(JSON.stringify(event));
    const timestamp = String(Math.floor(now / 1000));
    const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
      .update(`evt_cli_inbox.${timestamp}.`)
      .update(raw)
      .digest("base64");
    await inbox.accept(raw, {
      id: "evt_cli_inbox",
      timestamp,
      signature: `v1,${signature}`,
    });
    expect(inbox.summaries()).toEqual([
      expect.objectContaining({ state: "blocked", reason: "route_mismatch" }),
    ]);
    await inbox.close();

    const capture = io();
    expect(
      await runCli(["inbox", "--state", directory], capture.io, {
        createLiveModels: () => {
          throw new Error("inbox inspection must not construct models");
        },
      }),
    ).toBe(0);
    expect(capture.output).toEqual([
      JSON.stringify({
        emailId: event.data.email_id,
        state: "blocked",
        reason: "route_mismatch",
        conversationId: null,
        submissionId: null,
      }),
    ]);
    expect(capture.output.join("\n")).not.toMatch(/private|sender|subject/iu);
  });

  it("serializes two customer reply prompts so deny and allow answers cannot cross", async () => {
    const directory = state();
    const inbox = openResendInbox(join(directory, "inbound.sqlite"), {
      authority: {
        version: 1,
        messengerId: "officehum.resend.v1:test",
        accountId: "account_test",
        fromEmail: "desk@example.test",
        inboundEmail: "desk@example.test",
      },
      getApiKey: async () => "synthetic",
      getWebhookSecrets: async () => [
        `whsec_${Buffer.from("cli-prompt-secret").toString("base64")}`,
      ],
    });
    const prompts: string[] = [];
    const answers = ["deny", "allow"];
    const terminal: CliIo = {
      output: (line) => prompts.push(line),
      error: () => {},
      readApproval: async () => answers.shift(),
    };
    const decide = durableInboundReplyApprover(
      inbox,
      cliReplyDecision(undefined, terminal, () => {}),
    );
    const request = (conversationId: string, callId: string, to: string) => ({
      approvalId: "confirm_inbound_reply",
      description: "Confirm exact threaded reply",
      tool: "reply_message",
      arguments: { target: { receiptId: callId, to }, text: `Reply to ${to}` },
      conversationId,
      taskId: "task",
      callId,
    });
    const first = request("101", "call-first", "first@example.test");
    const second = request("202", "call-second", "second@example.test");
    await expect(
      Promise.all([decide(first, BACKGROUND_CONTEXT), decide(second, BACKGROUND_CONTEXT)]),
    ).resolves.toEqual([
      expect.objectContaining({ approved: false }),
      expect.objectContaining({ approved: true }),
    ]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("first@example.test");
    expect(prompts[0]).not.toContain("second@example.test");
    expect(prompts[1]).toContain("second@example.test");
    await inbox.close();
  });

  it("listens, inspects the durable receipt, and resumes one exact threaded reply", async () => {
    const directory = state();
    const port = await freeLoopbackPort();
    const secret = `whsec_${Buffer.from("cli-listen-secret").toString("base64")}`;
    const emailId = "77777777-7777-4777-8777-777777777777";
    const eventId = "evt_cli_listen";
    const event = {
      type: "email.received",
      created_at: new Date().toISOString(),
      data: {
        email_id: emailId,
        from: "guest@example.test",
        to: ["desk@example.test"],
        subject: "Availability",
        message_id: "<cli-listen@example.test>",
        attachments: [],
      },
    };
    const raw = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
      .update(`${eventId}.${timestamp}.${raw}`)
      .digest("base64");
    const received = {
      id: emailId,
      from: "guest@example.test",
      to: ["desk@example.test"],
      subject: "Availability",
      message_id: "<cli-listen@example.test>",
      reply_to: "guest@example.test",
      headers: {
        "message-id": "<cli-listen@example.test>",
        "reply-to": "guest@example.test",
      },
      authentication: { dmarc: "pass" },
      text: "Is tomorrow open?",
      html: "",
      attachments: [],
    };
    const priorEnvironment = {
      account: process.env.RESEND_ACCOUNT_ID,
      from: process.env.RESEND_FROM_EMAIL,
      subject: process.env.RESEND_SUBJECT,
      key: process.env.RESEND_API_KEY,
      inbound: process.env.RESEND_INBOUND_EMAIL,
      webhook: process.env.RESEND_WEBHOOK_SECRET,
    };
    const nativeFetch = globalThis.fetch;
    let replyPosts = 0;
    const provider = fauxProvider({ provider: "openai", models: [{ id: "gpt-6-sol" }] });
    provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall("reply_message", { receiptId: emailId, text: "Tomorrow is open." }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("PRIVATE MODEL ANSWER"),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    process.env.RESEND_ACCOUNT_ID = "account_test";
    process.env.RESEND_FROM_EMAIL = "desk@example.test";
    process.env.RESEND_SUBJECT = "Front Desk";
    process.env.RESEND_API_KEY = "synthetic";
    process.env.RESEND_INBOUND_EMAIL = "desk@example.test";
    process.env.RESEND_WEBHOOK_SECRET = secret;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return nativeFetch(input, init);
      if (url.includes(`/emails/receiving/${emailId}`)) return Response.json(received);
      if (url === "https://api.resend.com/emails" && init?.method === "POST") {
        replyPosts += 1;
        return Response.json({ id: "88888888-8888-4888-8888-888888888888" });
      }
      throw new Error("unexpected synthetic network request");
    };
    const dependencies = {
      createLiveModels: () => ({
        models,
        model: { provider: "openai", modelId: "gpt-6-sol" },
      }),
    };
    try {
      const listening = io();
      const running = runCli(
        ["listen", "--state", directory, "--messenger", "resend", "--port", String(port)],
        listening.io,
        dependencies,
      );
      await waitUntil(() => listening.output.some((line) => line.includes("Inbound listener:")));
      const response = await nativeFetch(`http://127.0.0.1:${port}/webhooks/resend`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": eventId,
          "svix-timestamp": timestamp,
          "svix-signature": `v1,${signature}`,
        },
        body: raw,
      });
      expect(response.status).toBe(202);
      await interruptCli();
      expect(await running).toBe(0);

      const before = io();
      expect(await runCli(["inbox", "--state", directory], before.io, dependencies)).toBe(0);
      expect(before.output).toEqual([
        JSON.stringify({
          emailId,
          state: "received",
          reason: null,
          conversationId: null,
          submissionId: null,
        }),
      ]);

      const resumed = io();
      expect(
        await runCli(
          ["resume", "--state", directory, "--messenger", "resend", "--approval", "allow"],
          resumed.io,
          dependencies,
        ),
      ).toBe(0);
      expect(resumed.errors).toEqual([]);
      expect(resumed.output.join("\n")).not.toContain("PRIVATE MODEL ANSWER");
      expect(replyPosts).toBe(1);
      const after = io();
      expect(await runCli(["inbox", "--state", directory], after.io, dependencies)).toBe(0);
      expect(after.output.join("\n")).toContain('"state":"settled"');
    } finally {
      await interruptCli();
      globalThis.fetch = nativeFetch;
      for (const [name, value] of Object.entries({
        RESEND_ACCOUNT_ID: priorEnvironment.account,
        RESEND_FROM_EMAIL: priorEnvironment.from,
        RESEND_SUBJECT: priorEnvironment.subject,
        RESEND_API_KEY: priorEnvironment.key,
        RESEND_INBOUND_EMAIL: priorEnvironment.inbound,
        RESEND_WEBHOOK_SECRET: priorEnvironment.webhook,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("does not resume or settle pending work while inspecting contacts", async () => {
    const directory = state();
    const submissionId = await createPendingDemo(directory);
    const capture = io();
    expect(await runCli(["contacts", "--state", directory], capture.io)).toBe(0);
    expect(capture.output).toEqual(["No contacts."]);

    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const solo = await openSolo({
      directory,
      role: frontdesk({ calendar }),
      ...createDemoModels(),
    });
    const pending = (await solo.harness.inspect(BACKGROUND_CONTEXT)).submissions;
    expect(pending.map((record) => String(record.id))).toContain(submissionId);
    expect(
      pending.find((record) => String(record.id) === submissionId)?.settlement,
    ).toBeUndefined();
    await solo.close();
    calendar.close();
  });

  it("runs deterministic allow and deny demos and lists bookings without credentials", async () => {
    const allowedState = state();
    const allowed = io();
    expect(await runCli(["demo", "--state", allowedState, "--approval", "allow"], allowed.io)).toBe(
      0,
    );
    expect(allowed.output.join("\n")).toContain("synthetic");
    expect(allowed.output).toContain("Messaging: console outbox; no customer delivery.");
    const outbox = openConsoleMessenger(join(allowedState, "messages.sqlite"));
    expect(outbox.messages()).toEqual([]);
    outbox.close();
    const listing = io();
    expect(await runCli(["bookings", "--state", allowedState], listing.io)).toBe(0);
    expect(listing.output.join("\n")).toContain("2030-01-15T09:00:00Z");

    const deniedState = state();
    const denied = io();
    expect(await runCli(["demo", "--state", deniedState, "--approval", "deny"], denied.io)).toBe(0);
    const deniedListing = io();
    expect(await runCli(["bookings", "--state", deniedState], deniedListing.io)).toBe(0);
    expect(deniedListing.output.join("\n")).toContain("No bookings");
  });

  it("runs approved reschedule and cancellation through ordinary start submissions", async () => {
    const directory = state();
    const seededCalendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const seeded = await seededCalendar.book("2030-01-15T09:00:00Z", "Guest", "seed");
    seededCalendar.close();

    const runtime = (responses: ReturnType<typeof fauxAssistantMessage>[]) => {
      const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-6-sol" }] });
      faux.setResponses(responses);
      const models = createModels();
      models.setProvider(faux.provider);
      return { models, model: { provider: "openai" as const, modelId: "gpt-6-sol" } };
    };
    const move = runtime([
      fauxAssistantMessage(fauxToolCall("list_bookings", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("check_schedule", { date: "2030-01-15" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("reschedule_appointment", {
          id: seeded.id,
          start: "2030-01-15T10:00:00Z",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Moved."),
    ]);
    const movedOutput = io();
    expect(
      await runCli(
        [
          "start",
          "--state",
          directory,
          "--message",
          `Move ${seeded.id} to 10:00 UTC`,
          "--request-id",
          "move-request",
          "--approval",
          "allow",
        ],
        movedOutput.io,
        { createLiveModels: () => move },
      ),
    ).toBe(0);
    expect(movedOutput.output.join("\n")).toContain("Moved.");
    const afterMove = openLocalCalendar(join(directory, "calendar.sqlite"));
    expect(await afterMove.listBookings()).toEqual([{ ...seeded, start: "2030-01-15T10:00:00Z" }]);
    afterMove.close();

    const cancellation = runtime([
      fauxAssistantMessage(fauxToolCall("list_bookings", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("cancel_appointment", { id: seeded.id }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Canceled."),
    ]);
    const canceledOutput = io();
    expect(
      await runCli(
        [
          "start",
          "--state",
          directory,
          "--message",
          `Cancel ${seeded.id}`,
          "--request-id",
          "cancel-request",
          "--approval",
          "allow",
        ],
        canceledOutput.io,
        { createLiveModels: () => cancellation },
      ),
    ).toBe(0);
    expect(canceledOutput.output.join("\n")).toContain("Canceled.");
    const afterCancel = openLocalCalendar(join(directory, "calendar.sqlite"));
    expect(await afterCancel.listBookings()).toEqual([]);
    afterCancel.close();
  });

  it("rejects Google for demo and requires initial Google token and calendar ID", async () => {
    const demo = io();
    expect(await runCli(["demo", "--state", state(), "--calendar", "google"], demo.io)).toBe(2);
    expect(demo.errors.join("\n")).toMatch(/demo.*local/i);

    const previousToken = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
    const previousId = process.env.GOOGLE_CALENDAR_ID;
    delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
    delete process.env.GOOGLE_CALENDAR_ID;
    try {
      process.env.GOOGLE_CALENDAR_ID = "calendar@example.test";
      const missingToken = io();
      expect(
        await runCli(["bookings", "--state", state(), "--calendar", "google"], missingToken.io),
      ).toBe(1);
      expect(missingToken.errors.join("\n")).toContain("GOOGLE_CALENDAR_ACCESS_TOKEN");
      process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = "test-token";
      delete process.env.GOOGLE_CALENDAR_ID;
      const missingId = io();
      expect(
        await runCli(["bookings", "--state", state(), "--calendar", "google"], missingId.io),
      ).toBe(1);
      expect(missingId.errors.join("\n")).toContain("GOOGLE_CALENDAR_ID");
    } finally {
      if (previousToken === undefined) delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
      else process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = previousToken;
      if (previousId === undefined) delete process.env.GOOGLE_CALENDAR_ID;
      else process.env.GOOGLE_CALENDAR_ID = previousId;
    }
  });

  it("allows a corrected Google start to reuse fresh state after credential preflight fails", async () => {
    const directory = state();
    const previousOpenAi = process.env.OPENAI_API_KEY;
    const previousToken = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
    const previousId = process.env.GOOGLE_CALENDAR_ID;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
    process.env.GOOGLE_CALENDAR_ID = "calendar@example.test";
    const args = [
      "start",
      "--state",
      directory,
      "--calendar",
      "google",
      "--message",
      "Book Guest on 2030-01-15",
      "--request-id",
      "retry-preflight",
    ];
    try {
      const first = io();
      expect(await runCli(args, first.io)).toBe(1);
      expect(first.errors.join("\n")).toContain("GOOGLE_CALENDAR_ACCESS_TOKEN");
      expect(existsSync(join(directory, "harness"))).toBe(false);
      expect(existsSync(join(directory, "connector.json"))).toBe(false);

      process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = "test-token";
      const second = io();
      expect(
        await runCli(args, second.io, {
          createGoogleCalendar: () =>
            fakeCalendar({
              timeZone: "UTC",
              workingHours: { start: "09:00", end: "12:00" },
              durationMinutes: 60,
            }),
        }),
      ).toBe(1);
      expect(second.errors.join("\n")).toContain("OPENAI_API_KEY");
      expect(second.errors.join("\n")).not.toMatch(/legacy|identity mismatch/i);
      expect(existsSync(join(directory, "harness"))).toBe(false);
      expect(existsSync(join(directory, "connector.json"))).toBe(false);
    } finally {
      if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAi;
      if (previousToken === undefined) delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
      else process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = previousToken;
      if (previousId === undefined) delete process.env.GOOGLE_CALENDAR_ID;
      else process.env.GOOGLE_CALENDAR_ID = previousId;
    }
  });

  it("lists persisted Google bookings without an OpenAI key and without repeating the backend flag", async () => {
    const directory = state();
    await createGoogleState(directory);
    const previousOpenAi = process.env.OPENAI_API_KEY;
    const previousToken = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
    delete process.env.OPENAI_API_KEY;
    process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = "test-token";
    try {
      const capture = io();
      const code = await runCli(["bookings", "--state", directory], capture.io, {
        createGoogleCalendar: () =>
          fakeCalendar({
            timeZone: "UTC",
            workingHours: { start: "09:00", end: "12:00" },
            durationMinutes: 60,
            bookings: [
              {
                id: "remote-1",
                start: "2030-01-15T09:00:00Z",
                end: "2030-01-15T10:00:00Z",
                customer: "Remote Guest",
                timeZone: "UTC",
              },
            ],
          }),
      });
      expect(code).toBe(0);
      expect(capture.output.join("\n")).toContain("Remote Guest");
    } finally {
      if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAi;
      if (previousToken === undefined) delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
      else process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = previousToken;
    }
  });

  it("rejects an explicit Google calendar mismatch before constructing the client", async () => {
    const directory = state();
    await createGoogleState(directory);
    const previousToken = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
    const previousId = process.env.GOOGLE_CALENDAR_ID;
    process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = "test-token";
    process.env.GOOGLE_CALENDAR_ID = "other@example.test";
    let constructed = 0;
    try {
      const capture = io();
      expect(
        await runCli(["bookings", "--state", directory, "--calendar", "google"], capture.io, {
          createGoogleCalendar: () => {
            constructed += 1;
            return fakeCalendar({
              timeZone: "UTC",
              workingHours: { start: "09:00", end: "12:00" },
              durationMinutes: 60,
            });
          },
        }),
      ).toBe(1);
      expect(capture.errors.join("\n")).toMatch(/calendar.*mismatch/i);
      expect(constructed).toBe(0);
    } finally {
      if (previousToken === undefined) delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
      else process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = previousToken;
      if (previousId === undefined) delete process.env.GOOGLE_CALENDAR_ID;
      else process.env.GOOGLE_CALENDAR_ID = previousId;
    }
  });

  it("rejects Google reuse of legacy local state before constructing the client", async () => {
    const directory = state();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const legacy = await openSolo({
      directory,
      role: frontdesk({ calendar }),
      ...createDemoModels(),
    });
    await legacy.close();
    rmSync(join(directory, "connector.json"));
    calendar.close();
    const previousToken = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
    const previousId = process.env.GOOGLE_CALENDAR_ID;
    process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = "test-token";
    process.env.GOOGLE_CALENDAR_ID = "calendar@example.test";
    let constructed = 0;
    try {
      const capture = io();
      expect(
        await runCli(["bookings", "--state", directory, "--calendar", "google"], capture.io, {
          createGoogleCalendar: () => {
            constructed += 1;
            return fakeCalendar({
              timeZone: "UTC",
              workingHours: { start: "09:00", end: "12:00" },
              durationMinutes: 60,
            });
          },
        }),
      ).toBe(1);
      expect(capture.errors.join("\n")).toMatch(/legacy|local|identity/i);
      expect(constructed).toBe(0);
    } finally {
      if (previousToken === undefined) delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
      else process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = previousToken;
      if (previousId === undefined) delete process.env.GOOGLE_CALENDAR_ID;
      else process.env.GOOGLE_CALENDAR_ID = previousId;
    }
  });

  it("rejects Google reuse of calendar-only local records before constructing the client", async () => {
    const directory = state();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    await calendar.book("2030-01-15T09:00:00Z", "Local Guest", "legacy-booking");
    calendar.close();
    const previousToken = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
    const previousId = process.env.GOOGLE_CALENDAR_ID;
    process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = "test-token";
    process.env.GOOGLE_CALENDAR_ID = "calendar@example.test";
    let constructed = 0;
    try {
      const capture = io();
      expect(
        await runCli(["bookings", "--state", directory, "--calendar", "google"], capture.io, {
          createGoogleCalendar: () => {
            constructed += 1;
            return fakeCalendar({
              timeZone: "UTC",
              workingHours: { start: "09:00", end: "12:00" },
              durationMinutes: 60,
            });
          },
        }),
      ).toBe(1);
      expect(capture.errors.join("\n")).toMatch(/legacy|local|identity/i);
      expect(constructed).toBe(0);
    } finally {
      if (previousToken === undefined) delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
      else process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = previousToken;
      if (previousId === undefined) delete process.env.GOOGLE_CALENDAR_ID;
      else process.env.GOOGLE_CALENDAR_ID = previousId;
    }
  });

  it("fails missing live credentials before admitting input", async () => {
    const directory = state();
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const capture = io();
      expect(
        await runCli(
          [
            "start",
            "--state",
            directory,
            "--message",
            "Book Guest on 2030-01-15",
            "--request-id",
            "live-1",
          ],
          capture.io,
        ),
      ).toBe(1);
      expect(capture.errors.join("\n")).toContain("OPENAI_API_KEY");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
    const listing = io();
    await runCli(["bookings", "--state", directory], listing.io);
    expect(listing.output.join("\n")).toContain("No bookings");
  });

  it("interrupts approval on EOF without recording consent", async () => {
    const directory = state();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const eof = io(undefined);
    const cancellation = withCancel(BACKGROUND_CONTEXT);
    const approver = cliApprover(calendar, undefined, eof.io, () => {
      cancellation.cancel(new Error("approval input ended"));
    });
    await expect(
      approver(
        {
          approvalId: "confirm_booking",
          description: "Confirm booking",
          tool: "book_appointment",
          arguments: { start: "2030-01-15T09:00:00Z", customer: "Demo Guest" },
          conversationId: "conversation",
          taskId: "task",
          callId: "call",
        },
        cancellation.context,
      ),
    ).rejects.toThrow("approval input ended");
    expect(calendar.decision("conversation:task:call:confirm_booking")).toBeUndefined();
    calendar.close();
  });

  it("rejects demo-to-live state reuse before adding a submission", async () => {
    const directory = state();
    expect(await runCli(["demo", "--state", directory], io().io)).toBe(0);
    const before = await entryCount(directory);
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-only-placeholder";
    try {
      const capture = io();
      expect(
        await runCli(
          [
            "start",
            "--state",
            directory,
            "--message",
            "Book Guest on 2030-01-15",
            "--request-id",
            "live-after-demo",
          ],
          capture.io,
        ),
      ).toBe(1);
      expect(capture.errors.join("\n")).toMatch(/synthetic demo.*fresh --state/i);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
    expect(await entryCount(directory)).toBe(before);
  });

  it("rejects live-to-demo state reuse and labels the persisted live model", async () => {
    const directory = state();
    await createLiveState(directory, "gpt-6.1-sol");
    const before = await entryCount(directory);
    const demo = io();
    expect(await runCli(["demo", "--state", directory], demo.io)).toBe(1);
    expect(demo.errors.join("\n")).toMatch(/live OpenAI.*fresh --state/i);
    expect(await entryCount(directory)).toBe(before);

    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-only-placeholder";
    try {
      const resumed = io();
      expect(await runCli(["resume", "--state", directory], resumed.io)).toBe(0);
      expect(resumed.output.join("\n")).toContain("Mode: live OpenAI (gpt-6.1-sol)");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it.each([
    ["Aborted with Ctrl+D", "eof"],
    ["Aborted with Ctrl+C", "sigint"],
  ] as const)("keeps the original request pending after %s", async (message, kind) => {
    const directory = state();
    const submissionId = await createPendingDemo(directory);
    const stream = Object.assign(new PassThrough(), { isTTY: true });
    const interruptions: string[] = [];
    const terminalIo = createTerminalIo({
      input: stream,
      output: stream,
      error: stream,
      onInterrupt: (value) => interruptions.push(value),
      open: () => ({
        question: async () => {
          throw new Error(message);
        },
        close: () => {},
      }),
    });
    expect(await runCli(["resume", "--state", directory], terminalIo)).toBe(1);
    expect(interruptions).toEqual([kind]);
    const before = openLocalCalendar(join(directory, "calendar.sqlite"));
    expect(before.bookings()).toEqual([]);
    before.close();

    const resumed = io();
    const resumeCode = await runCli(
      ["resume", "--state", directory, "--approval", "allow"],
      resumed.io,
    );
    expect({ code: resumeCode, errors: resumed.errors.join("\n") }).toEqual({
      code: 0,
      errors: "",
    });
    expect(resumed.output.join("\n")).toContain(`Submission: ${submissionId}`);
    const after = openLocalCalendar(join(directory, "calendar.sqlite"));
    expect(after.bookings()).toHaveLength(1);
    after.close();
  });
});
