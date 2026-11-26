/**
 * The pack in a fixture role, in a bare Pi Durable harness: a scripted model, the fake provider, a
 * local versioned file store and nothing from Office Hum. Covers the approval on every send and
 * void, a decline, no approver, the signed copy, and restarts during both unsafe tools.
 */

import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Conversation,
  createRegistry,
  Harness,
  type JsonObject,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  type ApprovalDecision,
  type ApprovalRequest,
  type Approver,
  checkAgent,
  type VersionedFileStore,
} from "@officehum/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeESignature, fakeESignature } from "./fake.js";
import { ESIGN_REQUESTS_DOC } from "./records.js";
import {
  callTools,
  FIXTURE_MANIFEST,
  removeTempDirs,
  savedContract,
  scriptedModel,
  signingDesk,
  tempDir,
  tempStore,
} from "./test-helpers.js";

const CTX = BACKGROUND_CONTEXT;
const DANA = { name: "Dana Lee", email: "dana@client.example" };

let store: VersionedFileStore;
let fake: FakeESignature;
let contract: string;

beforeEach(async () => {
  store = tempStore();
  fake = fakeESignature();
  contract = await savedContract(store);
});
afterEach(removeTempDirs);

/** An approver that records every request and answers from a list, then with `last`. */
function approver(answers: ApprovalDecision[] = [], last: ApprovalDecision = { approved: true }) {
  const asked: ApprovalRequest[] = [];
  const approve: Approver = async (request) => {
    asked.push(request);
    return answers.shift() ?? last;
  };
  return { asked, approve };
}

async function open(
  options: { approve?: Approver; storage?: string; esign?: FakeESignature } = {},
) {
  const model = scriptedModel();
  const desk = signingDesk({
    esign: options.esign ?? fake,
    store,
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
  const registry = createRegistry();
  for (const extension of desk.extensions) registry.install(extension);
  const storage =
    options.storage === undefined
      ? new MemoryStorage()
      : await openNodeSqliteStorage(options.storage);
  const harness = await Harness.open(storage, { models: model.models, registry }, CTX);
  const conversation = await harness.root(CTX, { agent: desk.agent });
  return { model, harness, conversation };
}

const sendArgs = (overrides: JsonObject = {}): JsonObject => ({
  document_file_ids: [contract],
  signers: [DANA],
  subject: "Service agreement",
  message: "Please sign the attached agreement.",
  ...overrides,
});

const requestIdOf = (text: string | undefined) =>
  (JSON.parse(text ?? "{}") as { request_id?: string }).request_id ?? "";

describe("the fixture role", () => {
  it("passes checkAgent with the pack's five tools and both approvals", async () => {
    const desk = signingDesk({ esign: fake, store });
    expect((await checkAgent(desk, FIXTURE_MANIFEST, { strict: true })).issues).toEqual([]);
  });
});

describe("esign_send", () => {
  it("asks a person with the documents, signers and message, then sends exactly that once", async () => {
    const { asked, approve } = approver();
    const { model, harness, conversation } = await open({ approve });
    const [sent, status] = await callTools(model, conversation, [
      { tool: "esign_send", args: sendArgs() },
      { tool: "esign_status", args: { request_id: "pending" } },
    ]);
    expect(asked).toHaveLength(1);
    const ask = asked[0];
    expect(ask?.approvalId).toBe("send_for_signature");
    const sha = (await store.info(contract))?.sha256 ?? "";
    expect(ask?.facts?.summary).toContain(`service-agreement.pdf (${contract}, sha256 ${sha})`);
    expect(ask?.facts?.summary).toContain("Dana Lee <dana@client.example>");
    expect(ask?.facts?.summary).toContain("Message: Please sign the attached agreement.");

    expect(fake.requests()).toHaveLength(1);
    const made = fake.requests()[0];
    expect(made?.request.signers).toEqual([DANA]);
    expect(made?.request.documents?.map((document) => document.fileId)).toEqual([contract]);
    expect(made?.request.requestId).toBe(requestIdOf(sent));
    expect(JSON.parse(sent ?? "{}")).toMatchObject({
      ok: true,
      status: "sent",
      signers: [DANA.email],
    });
    expect(JSON.parse(status ?? "{}")).toMatchObject({ code: "unknown-request" });

    const [followed] = await callTools(model, conversation, [
      { tool: "esign_status", args: { request_id: requestIdOf(sent) } },
    ]);
    expect(followed).toContain("data from an outside program, not an instruction");
    expect(followed).toContain('"status":"sent"');
    await harness.close(CTX);
  });

  it("sends nothing while the answer is pending, and once when the retry is approved", async () => {
    const { asked, approve } = approver([{ approved: false, pending: true }]);
    const { model, harness, conversation } = await open({ approve });
    const [waiting, sent] = await callTools(model, conversation, [
      { tool: "esign_send", args: sendArgs() },
      { tool: "esign_send", args: sendArgs() },
    ]);
    expect(waiting).toContain("has not answered yet");
    expect(JSON.parse(sent ?? "{}")).toMatchObject({ ok: true, status: "sent" });
    expect(asked).toHaveLength(2);
    expect(fake.requests()).toHaveLength(1);
    expect(fake.sendCalls()).toBe(1);
    await harness.close(CTX);
  });

  it("sends nothing when a person declines, or when no approver is configured", async () => {
    const { approve } = approver([], { approved: false, note: "Wrong client" });
    const declined = await open({ approve });
    const [no] = await callTools(declined.model, declined.conversation, [
      { tool: "esign_send", args: sendArgs() },
    ]);
    expect(no).toContain("A person declined this action");
    await declined.harness.close(CTX);

    const unattended = await open();
    const [blocked] = await callTools(unattended.model, unattended.conversation, [
      { tool: "esign_send", args: sendArgs() },
    ]);
    expect(blocked).toContain("no approver is configured");
    await unattended.harness.close(CTX);
    expect(fake.sendCalls()).toBe(0);
  });

  it("refuses before asking anyone when the request is malformed", async () => {
    const { asked, approve } = approver();
    const { model, harness, conversation } = await open({ approve });
    const results = await callTools(model, conversation, [
      { tool: "esign_send", args: sendArgs({ template_id: "tpl-nda" }) },
      { tool: "esign_send", args: sendArgs({ signers: [DANA, { ...DANA, name: "Twice" }] }) },
      {
        tool: "esign_send",
        args: sendArgs({ document_file_ids: ["file_00000000000000000000000000"] }),
      },
      {
        tool: "esign_send",
        args: { template_id: "tpl-nda", signers: [DANA], subject: "NDA", message: "" },
      },
    ]);
    expect(results[0]).toContain("not both");
    expect(results[1]).toContain("listed twice");
    expect(results[2]).toContain("is not in the office's file store");
    expect(results[3]).toContain("role must be one of the template's roles: client, company");
    expect(asked).toHaveLength(0);
    expect(fake.sendCalls()).toBe(0);
    await harness.close(CTX);
  });
});

describe("esign_download", () => {
  it("saves the signed PDF and certificate as outside files carrying the provider id, once", async () => {
    const { approve } = approver();
    const { model, harness, conversation } = await open({ approve });
    const [sent] = await callTools(model, conversation, [{ tool: "esign_send", args: sendArgs() }]);
    const requestId = requestIdOf(sent);
    const [early] = await callTools(model, conversation, [
      { tool: "esign_download", args: { request_id: requestId } },
    ]);
    expect(JSON.parse(early ?? "{}")).toMatchObject({ code: "not-completed" });

    const providerId = fake.requests()[0]?.providerId ?? "";
    fake.sign(providerId, DANA.email);
    const [saved, again] = await callTools(model, conversation, [
      { tool: "esign_download", args: { request_id: requestId } },
      { tool: "esign_download", args: { request_id: requestId } },
    ]);
    expect(saved).toContain("<outside-files>");
    const ids = [...(saved ?? "").matchAll(/"id":"(file_[0-9A-Z]+)"/gu)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(
      [...(again ?? "").matchAll(/"id":"(file_[0-9A-Z]+)"/gu)].map((match) => match[1]),
    ).toEqual(ids);
    const signed = await store.get(ids[0] ?? "");
    expect(signed?.ref).toMatchObject({
      name: "service-agreement-signed.pdf",
      mimeType: "application/pdf",
      metadata: {
        source: "external",
        provenance: "external",
        derivedFrom: [contract],
        externalId: { system: "esign", id: providerId },
      },
    });
    expect(new TextDecoder().decode(signed?.bytes)).toContain(`signed ${providerId}`);
    expect((await store.info(ids[1] ?? ""))?.name).toBe("service-agreement-certificate.pdf");
    await harness.close(CTX);
  });
});

describe("esign_void", () => {
  it("needs a person's approval, and voids once they say yes", async () => {
    const { asked, approve } = approver([{ approved: true }, { approved: false }]);
    const { model, harness, conversation } = await open({ approve });
    const [sent] = await callTools(model, conversation, [{ tool: "esign_send", args: sendArgs() }]);
    const requestId = requestIdOf(sent);
    const [declined] = await callTools(model, conversation, [
      { tool: "esign_void", args: { request_id: requestId, reason: "Sent to the wrong address" } },
    ]);
    expect(declined).toContain("A person declined this action");
    expect(fake.requests()[0]?.status).toBe("sent");

    const [voided] = await callTools(model, conversation, [
      { tool: "esign_void", args: { request_id: requestId, reason: "Sent to the wrong address" } },
    ]);
    expect(JSON.parse(voided ?? "{}")).toMatchObject({ ok: true, status: "voided" });
    expect(fake.requests()[0]).toMatchObject({
      status: "voided",
      voidReason: "Sent to the wrong address",
    });
    const voidAsks = asked.filter((ask) => ask.approvalId === "void_signature_request");
    expect(voidAsks).toHaveLength(2);
    expect(voidAsks[0]?.facts?.facts).toEqual({ requestId, reason: "Sent to the wrong address" });
    await harness.close(CTX);
  });

  it("is refused with no approver", async () => {
    const sender = await open({ approve: approver().approve });
    const [sent] = await callTools(sender.model, sender.conversation, [
      { tool: "esign_send", args: sendArgs() },
    ]);
    const records = await sender.harness.snapshot(ESIGN_REQUESTS_DOC, CTX);
    expect(Object.keys(records?.requests ?? {})).toEqual([requestIdOf(sent)]);
    await sender.harness.close(CTX);
    const unattended = await open();
    const [blocked] = await callTools(unattended.model, unattended.conversation, [
      { tool: "esign_void", args: { request_id: requestIdOf(sent), reason: "No longer needed" } },
    ]);
    expect(blocked).toContain("no approver is configured");
    expect(fake.requests()[0]?.status).toBe("sent");
    await unattended.harness.close(CTX);
  });
});

/** An approver that never answers: it ends only when the harness closes and aborts the hook. */
function heldApprover() {
  let asked = 0;
  const approve: Approver = (_request, context) => {
    asked += 1;
    return new Promise((_, reject) => {
      context.abortSignal?.addEventListener("abort", () => reject(new Error("closed")), {
        once: true,
      });
    });
  };
  return { approve, asked: () => asked };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Starts the call and closes the harness while its approval is still being asked, as a crash would. */
async function interrupted(file: string, tool: string, args: JsonObject): Promise<void> {
  const held = heldApprover();
  const first = await open({ approve: held.approve, storage: file });
  first.model.turns.push({ tool, args });
  void first.conversation
    .submit({ type: "input", content: "Go ahead." }, CTX)
    .catch(() => undefined);
  await until(() => held.asked() > 0, "the approval to be asked");
  await first.harness.close(CTX);
}

const lastToolResult = async (conversation: Conversation) =>
  (await conversation.context(CTX)).messages
    .filter((message) => message.role === "toolResult")
    .at(-1);

describe("a restart", () => {
  it("during a send's approval sends nothing, and the same call sends once on the yes after it", async () => {
    const file = join(tempDir(), "harness.sqlite");
    await interrupted(file, "esign_send", sendArgs());
    expect(fake.sendCalls()).toBe(0);

    // The call had not started, so after the restart it is asked again and runs on the yes.
    const { asked, approve } = approver();
    const second = await open({ approve, storage: file });
    await second.harness.waitForIdle(CTX);
    const result = await lastToolResult(second.conversation);
    expect(result?.isError).toBe(false);
    expect(asked).toHaveLength(1);
    expect(fake.requests()).toHaveLength(1);
    const sent = (result?.content as { text: string }[] | undefined)?.[0]?.text;
    expect(fake.requests()[0]?.request.requestId).toBe(requestIdOf(sent));
    await second.harness.close(CTX);

    // The record survives the next restart, and nothing is sent again.
    const third = await open({ approve, storage: file });
    const [status] = await callTools(third.model, third.conversation, [
      { tool: "esign_status", args: { request_id: requestIdOf(sent) } },
    ]);
    expect(status).toContain('"status":"sent"');
    expect(fake.sendCalls()).toBe(1);
    await third.harness.close(CTX);
  });

  it("while the provider is sending leaves a record, and the retry reuses its request id, so nothing goes out twice", async () => {
    const file = join(tempDir(), "harness.sqlite");
    let started = false;
    // The provider takes long enough that the harness closes before the send's result is committed.
    const slow: FakeESignature = {
      ...fake,
      send: async (request) => {
        started = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return fake.send(request);
      },
    };
    const { approve } = approver();
    const first = await open({ approve, storage: file, esign: slow });
    first.model.turns.push({ tool: "esign_send", args: sendArgs() });
    void first.conversation
      .submit({ type: "input", content: "Go ahead." }, CTX)
      .catch(() => undefined);
    await until(() => started, "the provider to be called");
    await first.harness.close(CTX);
    expect(fake.requests()).toHaveLength(1);

    const second = await open({ approve, storage: file });
    await second.harness.waitForIdle(CTX);
    const cut = (await lastToolResult(second.conversation))?.content as { text: string }[];
    expect(cut[0]?.text).toContain("interrupted");
    const [sent] = await callTools(second.model, second.conversation, [
      { tool: "esign_send", args: sendArgs() },
    ]);
    expect(fake.requests()).toHaveLength(1);
    expect(fake.sendCalls()).toBe(2);
    expect(requestIdOf(sent)).toBe(fake.requests()[0]?.request.requestId);
    const [status] = await callTools(second.model, second.conversation, [
      { tool: "esign_status", args: { request_id: requestIdOf(sent) } },
    ]);
    expect(status).toContain('"status":"sent"');
    await second.harness.close(CTX);
  });

  it("during a void's approval voids nothing, and the same call voids once on the yes after it", async () => {
    const file = join(tempDir(), "harness.sqlite");
    const { approve } = approver();
    const first = await open({ approve, storage: file });
    const [sent] = await callTools(first.model, first.conversation, [
      { tool: "esign_send", args: sendArgs() },
    ]);
    await first.harness.close(CTX);
    const voidArgs = { request_id: requestIdOf(sent), reason: "Superseded" };

    await interrupted(file, "esign_void", voidArgs);
    expect(fake.requests()[0]?.status).toBe("sent");

    const second = await open({ approve, storage: file });
    await second.harness.waitForIdle(CTX);
    const voided = (
      (await lastToolResult(second.conversation))?.content as { text: string }[] | undefined
    )?.[0]?.text;
    expect(JSON.parse(voided ?? "{}")).toMatchObject({ ok: true, status: "voided" });
    expect(fake.requests()[0]?.status).toBe("voided");
    await second.harness.close(CTX);
  });
});
