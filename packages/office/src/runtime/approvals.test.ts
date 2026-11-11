import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { EventMessage, Principal, ServerMessage } from "@officehum/protocol";
import { type ApprovalDeclaration, type Approver, approvalGate } from "@officehum/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type OfficeStorage, openOffice } from "../adapter/index.js";
import type { LoadedRole } from "../roles/load-role.js";
import { type ScriptedScript, scriptedProvider } from "../testing/scripted-model.js";
import { approvalAudit, RemoteApprovals, RUN_STOPPED, TIMED_OUT } from "./approvals.js";
import { openRuntime, type Runtime } from "./runtime.js";

const ada: Principal = { id: "ada", roles: ["staff"] };
const maya: Principal = { id: "maya", roles: ["manager"] };

const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const declarations: ApprovalDeclaration[] = [
  {
    id: "big_payment",
    tool: "pay",
    description: "Approve a payment above 100",
    when: [{ arg: "amount", op: "gt", value: 100 }],
    amount: { arg: "amount" },
  },
  { id: "any_note", tool: "send_note", description: "Approve sending this note" },
];

/** A role whose `pay` and `send_note` wait for a person, through the given approver. */
function payerRole(approve: Approver, ran: string[]): LoadedRole {
  const pay = defineTool({
    name: "pay",
    description: "Pays an amount.",
    parameters: Type.Object({ amount: Type.Number() }),
    replay: "unsafe",
    execute: async (args) => {
      ran.push(`pay ${(args as { amount: number }).amount}`);
      return { output: [{ type: "text", text: "paid" }] };
    },
  });
  const sendNote = defineTool({
    name: "send_note",
    description: "Sends a note.",
    parameters: Type.Object({}),
    replay: "unsafe",
    execute: async () => {
      ran.push("send_note");
      return { output: [{ type: "text", text: "sent" }] };
    },
  });
  const extension = defineExtension({
    name: "payer-tools",
    tools: [pay, sendNote],
    hooks: [approvalGate({ approvals: declarations, approve })],
  });
  return {
    dir: "/fixture",
    manifest: {
      id: "payer",
      role: "Pays bills",
      tools: [
        { name: "pay", replay: "unsafe" },
        { name: "send_note", replay: "unsafe" },
      ],
      approvals: declarations,
    },
    bundle: { extensions: [extension], agent: { extensions: [extension] } },
    approvalFacts: {},
  } as unknown as LoadedRole;
}

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : (content as { type: string; text?: string }[])
        .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
        .join("");

/** "pay N" calls pay; "note" calls send_note; then it answers with what the tool said. */
const script: ScriptedScript = (messages) => {
  const last = messages.at(-1);
  if (last?.role === "toolResult") return { text: `Result: ${textOf(last.content)}` };
  const request = textOf(messages.findLast((message) => message.role === "user")?.content);
  if (request.startsWith("pay ")) {
    return { toolCalls: [{ name: "pay", args: { amount: Number(request.slice(4)) } }] };
  }
  return { toolCalls: [{ name: "send_note" }] };
};

async function open(options: { storage?: OfficeStorage; timeoutMs?: number; ran?: string[] } = {}) {
  const scripted = scriptedProvider(script);
  const approvals = new RemoteApprovals();
  const ran = options.ran ?? [];
  const sent: ServerMessage[] = [];
  const runtime = await openRuntime({
    serverId: "office-test",
    roles: [payerRole(approvals.approve, ran)],
    storage: options.storage ?? "memory",
    models: scripted.models,
    model: scripted.model,
    approvals,
    ...(options.timeoutMs === undefined
      ? {}
      : { approvalTimeoutsMs: { payer: options.timeoutMs } }),
    send: (message) => sent.push(message),
  });
  runtimes.push(runtime);
  const find = <T extends ServerMessage>(predicate: (message: ServerMessage) => boolean) =>
    vi.waitFor(
      () => {
        const found = sent.find(predicate);
        if (found === undefined)
          throw new Error(`not sent yet: ${JSON.stringify(sent).slice(0, 1500)}`);
        return found as T;
      },
      { timeout: 10_000, interval: 10 },
    );
  const submit = (requestId: string, text: string) =>
    runtime.handle({
      type: "submit",
      id: `s-${requestId}`,
      agent: "payer",
      requestId,
      input: { kind: "message", text },
      principal: ada,
    });
  const requested = () =>
    find<ServerMessage & { type: "approval" }>(
      (message) => message.type === "approval" && message.approval.status === "pending",
    ).then((message) => message.approval);
  const decide = async (
    id: string,
    principal: Principal,
    approvalId: string,
    decision: "approve" | "decline",
    note?: string,
  ) => {
    await runtime.handle({
      type: "approve",
      id,
      approvalId,
      decision,
      ...(note === undefined ? {} : { note }),
      principal,
    });
    return await find((message) => "id" in message && message.id === id);
  };
  const settled = (requestId: string) =>
    find<EventMessage>(
      (message) =>
        message.type === "event" &&
        message.requestId === `ada/${requestId}` &&
        message.event.kind === "settled",
    ).then((message) => message.event);
  return { runtime, approvals, sent, ran, find, submit, requested, decide, settled };
}

describe("remote approvals", () => {
  it("asks on the request's stream, waits, and runs the tool once on approval by the signed-in principal", async () => {
    const office = await open();
    await office.submit("r1", "pay 250");
    const approval = await office.requested();
    expect(approval).toMatchObject({
      agent: "payer",
      tool: "pay",
      summary: "Approve a payment above 100",
      amount: 250,
      status: "pending",
    });
    expect(approval.approvalId).toMatch(/:big_payment$/);
    const asked = await office.find<EventMessage>(
      (message) => message.type === "event" && message.event.kind === "approval_requested",
    );
    expect(asked).toMatchObject({
      requestId: "ada/r1",
      event: { approvalId: approval.approvalId, agent: "payer", expiresAt: approval.expiresAt },
    });
    expect(office.ran).toEqual([]);

    const reply = await office.decide("a1", maya, approval.approvalId, "approve");
    expect(reply).toMatchObject({
      type: "result",
      data: { approval: { status: "approved", by: "maya", decidedAt: expect.any(String) } },
    });
    expect(await office.settled("r1")).toEqual({
      kind: "settled",
      status: "done",
      answer: "Result: paid",
    });
    expect(office.ran).toEqual(["pay 250"]);
    expect(
      office.sent.find(
        (message) => message.type === "event" && message.event.kind === "approval_decided",
      ),
    ).toMatchObject({
      event: { approvalId: approval.approvalId, decision: "approve", by: "maya" },
    });
  });

  it("never runs a declined call, and the run settles with the reason", async () => {
    const office = await open();
    await office.submit("r1", "pay 250");
    const approval = await office.requested();
    await office.decide("a1", maya, approval.approvalId, "decline", "not this month");
    const settled = await office.settled("r1");
    expect(settled).toMatchObject({ status: "done" });
    expect((settled as { answer: string }).answer).toContain("declined");
    expect((settled as { answer: string }).answer).toContain("not this month");
    expect(office.ran).toEqual([]);
  });

  it("declines a request nobody answers in time", async () => {
    const office = await open({ timeoutMs: 150 });
    await office.submit("r1", "pay 250");
    await office.requested();
    const settled = await office.settled("r1");
    expect((settled as { answer: string }).answer).toContain(TIMED_OUT);
    expect(office.ran).toEqual([]);
    const decided = await office.find<ServerMessage & { type: "approval" }>(
      (message) => message.type === "approval" && message.approval.status === "declined",
    );
    expect(decided.approval).toMatchObject({ note: TIMED_OUT });
    expect(decided.approval).not.toHaveProperty("by");
  });

  it("lets the first decision win; a later one is a conflict", async () => {
    const office = await open();
    await office.submit("r1", "pay 250");
    const approval = await office.requested();
    const [first, second] = await Promise.all([
      office.decide("a1", maya, approval.approvalId, "approve"),
      office.decide("a2", { id: "lee", roles: ["manager"] }, approval.approvalId, "decline"),
    ]);
    expect(first).toMatchObject({ type: "result" });
    expect(second).toMatchObject({ type: "error", code: "conflict" });
    expect((second as { message: string }).message).toContain("maya approved it");
    await office.settled("r1");
    expect(office.ran).toEqual(["pay 250"]);
  });

  it("checks an approver's limit against the call's amount, and refuses one it cannot check", async () => {
    const office = await open();
    await office.submit("r1", "pay 250");
    const payment = await office.requested();
    const small = { id: "sam", roles: ["manager"], approvalLimit: 100 };
    expect(await office.decide("a1", small, payment.approvalId, "approve")).toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("above your approval limit of 100"),
    });
    expect(
      await office.decide("a2", { ...small, approvalLimit: 500 }, payment.approvalId, "approve"),
    ).toMatchObject({ type: "result" });
    await office.settled("r1");

    await office.submit("r2", "note");
    const note = await office.find<ServerMessage & { type: "approval" }>(
      (message) =>
        message.type === "approval" &&
        message.approval.tool === "send_note" &&
        message.approval.status === "pending",
    );
    expect(note.approval).not.toHaveProperty("amount");
    expect(
      await office.decide(
        "a3",
        { ...small, approvalLimit: 1_000_000 },
        note.approval.approvalId,
        "approve",
      ),
    ).toMatchObject({ code: "forbidden", message: expect.stringContaining("no amount to check") });
    // Declining has no side effects, so a limit does not stand in its way.
    expect(await office.decide("a4", small, note.approval.approvalId, "decline")).toMatchObject({
      type: "result",
    });
    await office.settled("r2");
    expect(office.ran).toEqual(["pay 250"]);
  });

  it("answers not_found for an approval it does not know, and lists what is waiting", async () => {
    const office = await open();
    expect(await office.decide("a1", maya, "nope", "approve")).toMatchObject({ code: "not_found" });
    await office.submit("r1", "pay 250");
    const approval = await office.requested();
    await office.runtime.handle({ type: "watch_approvals", id: "w1", principal: maya });
    expect(await office.find((message) => "id" in message && message.id === "w1")).toEqual({
      type: "result",
      id: "w1",
      ok: true,
      data: { approvals: [approval] },
    });
  });

  it("closes the request when its run is aborted while waiting, so nobody can approve it after", async () => {
    const office = await open();
    await office.submit("r1", "pay 250");
    const approval = await office.requested();
    await office.runtime.handle({ type: "abort", id: "x1", requestId: "r1", principal: ada });
    expect(await office.settled("r1")).toMatchObject({ status: "aborted" });
    const closed = await office.find<ServerMessage & { type: "approval" }>(
      (message) => message.type === "approval" && message.approval.status === "declined",
    );
    expect(closed.approval).toMatchObject({ approvalId: approval.approvalId, note: RUN_STOPPED });
    expect(await office.decide("a1", maya, approval.approvalId, "approve")).toMatchObject({
      code: "conflict",
    });
    expect(office.ran).toEqual([]);
  });

  it("declines on the next start a request that timed out while the runtime was down", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-approvals-"));
    temps.push(directory);
    const storage = { sqlite: join(directory, "office.sqlite") };
    const ran: string[] = [];
    const first = await open({ storage, ran, timeoutMs: 300 });
    await first.submit("r1", "pay 250");
    const approval = await first.requested();
    await first.runtime.close();
    runtimes.splice(runtimes.indexOf(first.runtime), 1);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const second = await open({ storage, ran, timeoutMs: 300 });
    await second.runtime.handle({ type: "subscribe", id: "sub", requestId: "r1", principal: ada });
    expect((await second.settled("r1")) as { answer?: string }).toMatchObject({
      answer: expect.stringContaining(TIMED_OUT),
    });
    expect(ran).toEqual([]);
    expect(second.approvals.pending()).toEqual([]);
    expect(await second.decide("a1", maya, approval.approvalId, "approve")).toMatchObject({
      code: "conflict",
      message: expect.stringContaining("timed out"),
    });
  });

  it("keeps a pending approval across a restart, and a decision then resumes the run once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-approvals-"));
    temps.push(directory);
    const storage = { sqlite: join(directory, "office.sqlite") };
    const ran: string[] = [];
    const first = await open({ storage, ran });
    await first.submit("r1", "pay 250");
    const approval = await first.requested();
    await first.runtime.close();
    runtimes.splice(runtimes.indexOf(first.runtime), 1);

    const second = await open({ storage, ran });
    // The resumed run asks again for the same call: the same approval, still waiting.
    expect((await second.requested()).approvalId).toBe(approval.approvalId);
    await second.decide("a1", maya, approval.approvalId, "approve");
    await second.runtime.handle({ type: "subscribe", id: "sub", requestId: "r1", principal: ada });
    expect(await second.settled("r1")).toMatchObject({ status: "done", answer: "Result: paid" });
    expect(ran).toEqual(["pay 250"]);

    await second.runtime.close();
    runtimes.splice(runtimes.indexOf(second.runtime), 1);
    const office = await openOffice({
      storage,
      models: scriptedProvider([]).models,
      resume: false,
    });
    try {
      const audit = await approvalAudit(office);
      expect(audit.map((entry) => [entry.action, entry.by])).toEqual([
        ["requested", undefined],
        ["approved", "maya"],
      ]);
    } finally {
      await office.close();
    }
  });
});
