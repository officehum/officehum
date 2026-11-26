/**
 * The unsafe tools' own checks, driven directly with a stand-in tool API: what runs must be what a
 * person approved, a call with no approval does nothing, and a repeat of the same call sends once.
 * (The gate that asks is covered in a real harness in `harness.test.ts`.)
 */

import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { APPROVED_FACTS_ARG, type VersionedFileStore } from "@officehum/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSendFacts, readVoidFacts } from "./approvals.js";
import { type FakeESignature, fakeESignature } from "./fake.js";
import type { ESignRecords } from "./records.js";
import { removeTempDirs, savedContract, tempStore } from "./test-helpers.js";
import { eSignaturePack } from "./tools.js";

let store: VersionedFileStore;
let fake: FakeESignature;
let contract: string;

beforeEach(async () => {
  store = tempStore();
  fake = fakeESignature();
  contract = await savedContract(store);
});
afterEach(removeTempDirs);

/** A tool API whose only document is the request records, held in memory. */
function toolApi(callId = "call-1") {
  let records: ESignRecords = { requests: {} };
  const api = {
    conversationId: 1,
    taskId: 7,
    callId,
    now: () => Date.parse("2026-11-24T10:00:00Z"),
    snapshot: async () => structuredClone(records),
    commit: async (change: (tx: unknown) => unknown) => {
      const draft = structuredClone(records);
      const result = await change({ doc: async () => draft });
      records = draft;
      return result;
    },
  };
  return { api: api as unknown as ToolExecutionApi, records: () => records };
}

function toolNamed(store_: VersionedFileStore, name: string, esign = fake): ToolRegistration {
  const pack = eSignaturePack({ esign, store: store_, createdBy: "role:test" });
  const found = pack.tools.find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
}

const run = async (
  tool: ToolRegistration,
  args: Record<string, unknown>,
  api: ToolExecutionApi,
) => {
  const result = (await tool.execute(args as never, api, {} as never)) as {
    output: { text: string }[];
  };
  return JSON.parse(result.output[0]?.text ?? "{}") as Record<string, unknown>;
};

const args = () => ({
  document_file_ids: [contract],
  signers: [{ name: "Dana Lee", email: "dana@client.example" }],
  subject: "Service agreement",
  message: "Please sign.",
});

const approved = async (call: Record<string, unknown>) => ({
  ...call,
  [APPROVED_FACTS_ARG]: await readSendFacts(call, { esign: fake, store }),
});

describe("esign_send", () => {
  it("does nothing without approved facts", async () => {
    const { api } = toolApi();
    expect(await run(toolNamed(store, "esign_send"), args(), api)).toMatchObject({
      ok: false,
      code: "not-approved",
    });
    expect(fake.sendCalls()).toBe(0);
  });

  it("refuses a signer list or document set other than the one the person approved", async () => {
    const send = toolNamed(store, "esign_send");
    const seen = await approved(args());
    const extraSigner = {
      ...seen,
      signers: [...args().signers, { name: "Eve", email: "eve@elsewhere.example" }],
    };
    const otherDocument = { ...seen, document_file_ids: [await savedContract(store, "other")] };
    for (const changed of [extraSigner, otherDocument, { ...seen, message: "Sign now." }]) {
      expect(await run(send, changed, toolApi().api)).toMatchObject({
        code: "changed-since-approval",
      });
    }
    expect(fake.sendCalls()).toBe(0);
  });

  it("refuses a document whose bytes are no longer the ones approved", async () => {
    const tampered: VersionedFileStore = {
      ...store,
      get: async (id) => {
        const file = await store.get(id);
        return file === undefined
          ? undefined
          : { ...file, bytes: new TextEncoder().encode("%PDF-1.7\n% swapped\n") };
      },
    };
    const send = toolNamed(tampered, "esign_send");
    expect(await run(send, await approved(args()), toolApi().api)).toMatchObject({
      code: "changed-since-approval",
    });
    expect(fake.sendCalls()).toBe(0);
  });

  it("sends exactly the approved facts, and a repeat of the same call sends once", async () => {
    const send = toolNamed(store, "esign_send");
    const { api, records } = toolApi();
    const call = await approved(args());
    const first = await run(send, call, api);
    const again = await run(send, call, api);
    expect(first).toMatchObject({ ok: true, status: "sent", request_id: "esign:1:7:call-1" });
    expect(again).toMatchObject({ ok: true, request_id: "esign:1:7:call-1" });
    expect(fake.sendCalls()).toBe(1);
    expect(fake.requests()[0]?.request.signers).toEqual(args().signers);
    expect(records().requests["esign:1:7:call-1"]).toMatchObject({
      providerId: "env-1",
      conversationId: "1",
      taskId: "7",
      documents: [{ fileId: contract, name: "service-agreement.pdf" }],
    });
  });
});

describe("esign_void", () => {
  it("does nothing without approved facts, and voids with them", async () => {
    const { api } = toolApi();
    const sent = await run(toolNamed(store, "esign_send"), await approved(args()), api);
    const voidTool = toolNamed(store, "esign_void");
    const call = { request_id: sent.request_id, reason: "Superseded" };
    expect(await run(voidTool, call, api)).toMatchObject({ code: "not-approved" });
    expect(fake.requests()[0]?.status).toBe("sent");
    const approvedCall = { ...call, [APPROVED_FACTS_ARG]: readVoidFacts(call) };
    expect(await run(voidTool, { ...approvedCall, reason: "Other" }, api)).toMatchObject({
      code: "changed-since-approval",
    });
    expect(await run(voidTool, approvedCall, api)).toMatchObject({ ok: true, status: "voided" });
    expect(fake.requests()[0]?.status).toBe("voided");
  });
});
