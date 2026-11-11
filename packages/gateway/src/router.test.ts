import type { ServerMessage } from "@officehum/protocol";
import { describe, expect, it } from "vitest";
import type { Permissions } from "./config.js";
import { type AuditEntry, type ClientSink, Router } from "./router.js";

const ada = { id: "ada", roles: ["staff"] };
const permissions: Permissions = {
  submit: [{ roles: ["staff"], agents: "*" }],
  approve: [{ roles: ["staff"], agents: "*", limit: 50 }],
  abort: [{ roles: ["staff"] }],
};

/** A router over a fake runtime that records what it was sent. */
function setup() {
  const toRuntime: Record<string, unknown>[] = [];
  const runtime = {
    up: true,
    send(message: object) {
      if (!this.up) return false;
      toRuntime.push(message as Record<string, unknown>);
      return true;
    },
  };
  const audit: AuditEntry[] = [];
  const router = new Router({
    permissions,
    runtime,
    audit: (entry) => audit.push(entry),
    log: () => {},
  });
  const client = () => {
    const received: ServerMessage[] = [];
    const sink: ClientSink = { send: (message) => received.push(message) };
    return { sink, received };
  };
  return { router, runtime, toRuntime, audit, client };
}

const submit = {
  type: "submit",
  id: "c1",
  agent: "worker",
  requestId: "r1",
  input: { kind: "message", text: "hi" },
} as const;
const event = (seq: number, kind: "text_delta" | "settled", requestId = "ada/r1") => ({
  type: "event",
  requestId,
  seq,
  event: kind === "settled" ? { kind, status: "done", answer: "ok" } : { kind, text: `t${seq}` },
});

const approvalInfo = (approvalId: string, agent: string, status = "pending") => ({
  approvalId,
  agent,
  tool: "pay",
  summary: "Approve a payment",
  status,
  requestedAt: "2026-11-11T10:00:00.000Z",
  expiresAt: "2026-11-11T14:00:00.000Z",
});

describe("Router approvals", () => {
  const scoped: Permissions = {
    submit: [{ roles: ["staff"], agents: "*" }],
    approve: [
      { roles: ["finance"], agents: ["bookkeeper"] },
      { roles: ["sales-lead"], agents: ["sales"], limit: 500 },
    ],
    abort: [],
  };
  const fin = { id: "fin", roles: ["finance"] };
  const lead = { id: "lead", roles: ["sales-lead"] };

  function scopedSetup() {
    const toRuntime: Record<string, unknown>[] = [];
    const audit: AuditEntry[] = [];
    const router = new Router({
      permissions: scoped,
      runtime: {
        up: true,
        send: (message: object) => toRuntime.push(message as Record<string, unknown>) > 0,
      },
      audit: (entry) => audit.push(entry),
      log: () => {},
    });
    const client = () => {
      const received: ServerMessage[] = [];
      return { sink: { send: (message: ServerMessage) => received.push(message) }, received };
    };
    return { router, toRuntime, audit, client };
  }

  it("lists and sends each approval only to watchers who may decide it", () => {
    const { router, toRuntime, client } = scopedSetup();
    const finance = client();
    const sales = client();
    const staff = client();
    router.handle(finance.sink, fin, { type: "watch_approvals", id: "w1" });
    router.handle(sales.sink, lead, { type: "watch_approvals", id: "w2" });
    router.handle(staff.sink, ada, { type: "watch_approvals", id: "w3" });
    expect(staff.received).toEqual([
      expect.objectContaining({ type: "error", id: "w3", code: "forbidden" }),
    ]);
    const [first, second] = toRuntime.map((message) => message.id);
    const waiting = [approvalInfo("b1", "bookkeeper"), approvalInfo("s1", "sales")];
    router.onRuntimeFrame({ type: "result", id: first, ok: true, data: { approvals: waiting } });
    router.onRuntimeFrame({ type: "result", id: second, ok: true, data: { approvals: waiting } });
    expect(finance.received).toEqual([
      { type: "result", id: "w1", ok: true, data: { approvals: [waiting[0]] } },
    ]);
    expect(sales.received).toEqual([
      { type: "result", id: "w2", ok: true, data: { approvals: [waiting[1]] } },
    ]);

    router.onRuntimeFrame({ type: "approval", approval: approvalInfo("b2", "bookkeeper") });
    expect(finance.received.at(-1)).toEqual({
      type: "approval",
      approval: approvalInfo("b2", "bookkeeper"),
    });
    expect(sales.received).toHaveLength(1);
    router.disconnect(finance.sink);
    router.onRuntimeFrame({ type: "approval", approval: approvalInfo("b3", "bookkeeper") });
    expect(finance.received).toHaveLength(2);
  });

  it("refuses approve for an unknown approval, or another agent's, and forwards the rest with the limit", () => {
    const { router, toRuntime, audit, client } = scopedSetup();
    router.onRuntimeFrame({ type: "approval", approval: approvalInfo("b1", "bookkeeper") });
    router.onRuntimeFrame({ type: "approval", approval: approvalInfo("s1", "sales") });
    const c = client();
    const approve = (id: string, approvalId: string) =>
      ({ type: "approve", id, approvalId, decision: "approve" }) as const;
    router.handle(c.sink, lead, approve("a1", "nope"));
    router.handle(c.sink, lead, approve("a2", "b1"));
    router.handle(c.sink, lead, {
      ...approve("a3", "s1"),
      principal: { id: "x", roles: ["*"] },
    } as never);
    expect(c.received).toEqual([
      expect.objectContaining({ id: "a1", code: "not_found" }),
      expect.objectContaining({
        id: "a2",
        code: "forbidden",
        message: "You may not approve actions for bookkeeper.",
      }),
    ]);
    expect(toRuntime).toEqual([
      {
        type: "approve",
        id: "g1",
        approvalId: "s1",
        decision: "approve",
        principal: { ...lead, approvalLimit: 500 },
      },
    ]);
    expect(audit.map((entry) => [entry.approvalId, entry.agent, entry.outcome])).toEqual([
      ["nope", undefined, "not_found"],
      ["b1", "bookkeeper", "forbidden"],
      ["s1", "sales", "forwarded"],
    ]);
  });

  it("tells someone with no approve rule nothing about which approvals exist", () => {
    const { router, client } = scopedSetup();
    router.onRuntimeFrame({ type: "approval", approval: approvalInfo("b1", "bookkeeper") });
    const c = client();
    for (const [id, approvalId] of [
      ["a1", "b1"],
      ["a2", "nope"],
    ] as const) {
      router.handle(c.sink, ada, { type: "approve", id, approvalId, decision: "approve" });
    }
    expect(c.received.map((m) => (m.type === "error" ? m.code : m.type))).toEqual([
      "forbidden",
      "forbidden",
    ]);
  });

  it("asks the runtime what is waiting whenever it comes up", () => {
    const { router, toRuntime } = scopedSetup();
    router.onRuntimeUp();
    expect(toRuntime[0]).toMatchObject({ type: "watch_approvals", principal: { id: "gateway" } });
    router.onRuntimeFrame({
      type: "result",
      id: toRuntime[0]?.id,
      ok: true,
      data: { approvals: [approvalInfo("b1", "bookkeeper")] },
    });
    // Learned at start-up, so an approve for it is checked and forwarded, not refused as unknown.
    router.handle({ send: () => {} }, fin, {
      type: "approve",
      id: "a1",
      approvalId: "b1",
      decision: "approve",
    });
    expect(toRuntime.at(-1)).toMatchObject({ type: "approve", approvalId: "b1", principal: fin });
  });
});

describe("Router", () => {
  it("forwards with a gateway id and the signed-in principal, and maps the reply back", () => {
    const { router, toRuntime, client } = setup();
    const a = client();
    router.handle(a.sink, ada, submit);
    expect(toRuntime).toEqual([{ ...submit, id: "g1", principal: ada }]);
    router.onRuntimeFrame({
      type: "accepted",
      id: "g1",
      requestId: "ada/r1",
      disposition: "started",
    });
    expect(a.received).toEqual([
      { type: "accepted", id: "c1", requestId: "r1", disposition: "started" },
    ]);
  });

  it("caps an approver's limit at the lower of the token's and the rules'", () => {
    const { router, toRuntime, client } = setup();
    router.onRuntimeFrame({ type: "approval", approval: approvalInfo("x", "worker") });
    router.handle(
      client().sink,
      { ...ada, approvalLimit: 500 },
      {
        type: "approve",
        id: "a1",
        approvalId: "x",
        decision: "approve",
      },
    );
    expect(toRuntime[0]?.principal).toEqual({ ...ada, approvalLimit: 50 });
  });

  it("renumbers events for clients and keeps one growing sequence across a runtime restart", () => {
    const { router, toRuntime, client } = setup();
    const a = client();
    router.handle(a.sink, ada, submit);
    router.onRuntimeFrame({
      type: "accepted",
      id: "g1",
      requestId: "ada/r1",
      disposition: "started",
    });
    router.onRuntimeFrame(event(1, "text_delta"));
    router.onRuntimeFrame(event(2, "text_delta"));
    router.onRuntimeFrame(event(2, "text_delta")); // a replay of one already seen: dropped

    router.onRuntimeDown();
    router.onRuntimeUp();
    // The runtime is asked again for the unsettled request, as Ada.
    expect(toRuntime.filter((message) => message.type === "subscribe").at(-1)).toEqual({
      type: "subscribe",
      id: "g2",
      requestId: "r1",
      principal: ada,
    });
    router.onRuntimeFrame({ type: "result", id: "g2", ok: true });
    // The restarted runtime numbers from 1 again; the client sees 3 and 4.
    router.onRuntimeFrame(event(1, "text_delta"));
    router.onRuntimeFrame(event(2, "settled"));
    router.onRuntimeFrame(event(2, "settled"));
    const seqs = a.received
      .filter((m) => m.type === "event")
      .map((m) => (m.type === "event" ? m.seq : 0));
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(a.received.at(-1)).toMatchObject({ requestId: "r1", event: { kind: "settled" } });
  });

  it("sends a settled request's result again when a client already watching it re-submits", () => {
    const { router, client } = setup();
    const a = client();
    router.handle(a.sink, ada, submit);
    router.onRuntimeFrame({
      type: "accepted",
      id: "g1",
      requestId: "ada/r1",
      disposition: "started",
    });
    router.onRuntimeFrame(event(1, "text_delta"));
    router.onRuntimeFrame(event(2, "settled"));
    router.handle(a.sink, ada, { ...submit, id: "c2" });
    router.onRuntimeFrame({
      type: "accepted",
      id: "g2",
      requestId: "ada/r1",
      disposition: "existing",
    });
    // The runtime's own replay of the story is already known, so it is not forwarded twice.
    router.onRuntimeFrame(event(1, "text_delta"));
    router.onRuntimeFrame(event(2, "settled"));
    expect(a.received.slice(3)).toEqual([
      { type: "accepted", id: "c2", requestId: "r1", disposition: "existing" },
      {
        type: "event",
        requestId: "r1",
        seq: 2,
        event: { kind: "settled", status: "done", answer: "ok" },
      },
    ]);
  });

  it("answers busy while the runtime is down, and to commands it never answered", () => {
    const { router, runtime, client } = setup();
    const a = client();
    router.handle(a.sink, ada, submit);
    router.onRuntimeDown();
    expect(a.received.at(-1)).toMatchObject({ type: "error", id: "c1", code: "busy" });
    runtime.up = false;
    router.handle(a.sink, ada, { type: "ping", id: "p1" });
    expect(a.received.at(-1)).toMatchObject({ type: "error", id: "p1", code: "busy" });
  });

  it("replays a request's events after afterSeq to a new subscriber, always with settled", () => {
    const { router, client } = setup();
    const a = client();
    router.handle(a.sink, ada, submit);
    router.onRuntimeFrame({
      type: "accepted",
      id: "g1",
      requestId: "ada/r1",
      disposition: "started",
    });
    router.onRuntimeFrame(event(1, "text_delta"));
    router.onRuntimeFrame(event(2, "text_delta"));
    router.onRuntimeFrame(event(3, "settled"));

    const b = client();
    router.handle(b.sink, ada, { type: "subscribe", id: "s1", requestId: "r1", afterSeq: 3 });
    router.onRuntimeFrame({ type: "result", id: "g2", ok: true });
    expect(b.received).toEqual([
      { type: "result", id: "s1", ok: true },
      expect.objectContaining({ seq: 3, event: expect.objectContaining({ kind: "settled" }) }),
    ]);
  });

  it("tells subscribers when the runtime no longer knows a request after a restart", () => {
    const { router, client } = setup();
    const a = client();
    router.handle(a.sink, ada, submit);
    router.onRuntimeFrame({
      type: "accepted",
      id: "g1",
      requestId: "ada/r1",
      disposition: "started",
    });
    router.onRuntimeDown();
    router.onRuntimeUp();
    router.onRuntimeFrame({ type: "error", id: "g2", code: "not_found", message: "gone" });
    expect(a.received.at(-1)).toMatchObject({
      type: "error",
      code: "internal",
      message: expect.stringContaining("lost track of request r1"),
    });
    expect(router.snapshot(ada, "r1")).toBeUndefined();
  });

  it("stops sending to a client that left", () => {
    const { router, client } = setup();
    const a = client();
    router.handle(a.sink, ada, submit);
    router.onRuntimeFrame({
      type: "accepted",
      id: "g1",
      requestId: "ada/r1",
      disposition: "started",
    });
    router.disconnect(a.sink);
    router.onRuntimeFrame(event(1, "text_delta"));
    expect(a.received).toHaveLength(1);
  });

  it("audits who did what without bodies", () => {
    const { router, audit, client } = setup();
    router.handle(client().sink, ada, submit);
    expect(audit).toEqual([
      {
        at: expect.any(String),
        principal: "ada",
        action: "submit",
        agent: "worker",
        requestId: "r1",
        outcome: "forwarded",
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain("hi");
  });
});
