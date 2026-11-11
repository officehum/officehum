import type { ServerMessage } from "@officehum/protocol";
import { describe, expect, it } from "vitest";
import type { Permissions } from "./config.js";
import { type AuditEntry, type ClientSink, Router } from "./router.js";

const ada = { id: "ada", roles: ["staff"] };
const permissions: Permissions = {
  submit: [{ roles: ["staff"], agents: "*" }],
  approve: [{ roles: ["staff"], limit: 50 }],
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
    expect(toRuntime.at(-1)).toEqual({
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
