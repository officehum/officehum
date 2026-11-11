import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "./client.js";
import { GatewayError, isGatewayError } from "./errors.js";
import { type FakeGateway, startFakeGateway } from "./fixtures/fake-gateway.js";
import { makeRequestId } from "./request-id.js";
import { Run, type RunEvent } from "./run.js";

const fakes: FakeGateway[] = [];
const clients: GatewayClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const fake of fakes.splice(0)) await fake.close();
});

const fast = { initialMs: 10, maxMs: 50 };

async function setup(options: { transport?: "websocket" | "http"; token?: () => string } = {}) {
  const fake = await startFakeGateway();
  fakes.push(fake);
  const client = await GatewayClient.connect({
    url: fake.url,
    token: options.token ?? "good-1",
    backoff: fast,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  });
  clients.push(client);
  return { fake, client };
}

const message = { kind: "message", text: "Hello" } as const;
const text = (t: string) => ({ kind: "text_delta", text: t }) as const;
const done = (answer: string) => ({ kind: "settled", status: "done", answer }) as const;

async function collect(run: Run): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of run.events()) events.push(event);
  return events;
}

const until = (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 10 });

describe("GatewayClient over WebSocket", () => {
  it("submits, streams events in order and resolves settled", async () => {
    const { fake, client } = await setup();
    const run = await client.submit({ agent: "frontdesk", requestId: "r1", input: message });
    expect(run.disposition).toBe("started");
    const events = collect(run);
    fake.emit("r1", text("Hi "));
    fake.emit("r1", { kind: "tool_start", toolCallId: "t1", tool: "lookup" });
    fake.emit("r1", done("Hi there"));
    expect((await events).map((event) => [event.seq, event.kind])).toEqual([
      [1, "text_delta"],
      [2, "tool_start"],
      [3, "settled"],
    ]);
    expect(await run.settled()).toEqual(done("Hi there"));
    expect(fake.received[0]).toEqual({
      type: "hello",
      version: 1,
      client: "officehum-client",
      token: "good-1",
    });
    expect(fake.received[1]).toMatchObject({ type: "submit", requestId: "r1" });
    expect(fake.received[1]).not.toHaveProperty("principal");
  });

  it("reconnects after a drop mid-stream and resumes with no gap and no duplicate", async () => {
    let issued = 0;
    const { fake, client } = await setup({ token: () => `good-${++issued}` });
    const run = await client.submit({ agent: "frontdesk", requestId: "r1", input: message });
    const events = collect(run);
    fake.emit("r1", text("a"));
    fake.emit("r1", text("b"));
    await until(() => expect(run.lastSeq).toBe(2));
    fake.overlap = true; // the resume replays seq 2 again; the client must not show it twice
    fake.drop();
    fake.emit("r1", text("c")); // while the client is away
    await until(() =>
      expect(fake.received).toContainEqual(
        expect.objectContaining({ type: "subscribe", requestId: "r1", afterSeq: 2 }),
      ),
    );
    fake.emit("r1", done("abc"));
    expect((await events).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    // A fresh token was asked for when it reconnected, and nothing was submitted again.
    expect(fake.tokens).toEqual(["good-1", "good-2"]);
    expect(fake.received.filter((m) => m.type === "submit")).toHaveLength(1);
  });

  it("surfaces forbidden as a typed GatewayError", async () => {
    const { client } = await setup();
    const error = await client
      .submit({ agent: "secret", requestId: "r1", input: message })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayError);
    expect(isGatewayError(error, "forbidden")).toBe(true);
    expect(isGatewayError(error, "not_found")).toBe(false);
  });

  it("refuses to connect with a bad token", async () => {
    const fake = await startFakeGateway();
    fakes.push(fake);
    const error = await GatewayClient.connect({ url: fake.url, token: "bad" }).catch(
      (caught: unknown) => caught,
    );
    expect(isGatewayError(error, "unauthorized")).toBe(true);
  });

  it("sends a submit answered busy again with the same requestId", async () => {
    const { fake, client } = await setup();
    fake.busyNext(2);
    const run = await client.submit({ agent: "frontdesk", requestId: "r1", input: message });
    expect(run.disposition).toBe("started");
    const submits = fake.received.filter((m) => m.type === "submit");
    expect(submits.map((m) => (m.type === "submit" ? m.requestId : ""))).toEqual([
      "r1",
      "r1",
      "r1",
    ]);
  });

  it("re-sends an unanswered submit after a drop, but fails any other unanswered command", async () => {
    const { fake, client } = await setup();
    fake.silent.add("submit");
    fake.silent.add("approve");
    const submitted = client.submit({ agent: "frontdesk", requestId: "r1", input: message });
    const approved = client.approve({ approvalId: "a1", decision: "approve" });
    approved.catch(() => {});
    await until(() => expect(fake.received.filter((m) => m.type === "approve")).toHaveLength(1));
    fake.silent.clear();
    fake.drop();
    expect(isGatewayError(await approved.catch((e: unknown) => e), "busy")).toBe(true);
    expect((await submitted).requestId).toBe("r1");
    expect(fake.received.filter((m) => m.type === "submit")).toHaveLength(2);
    expect(fake.received.filter((m) => m.type === "approve")).toHaveLength(1);
  });

  it("re-submitting a settled request returns its result again", async () => {
    const { fake, client } = await setup();
    const first = await client.submit({ agent: "frontdesk", requestId: "r1", input: message });
    fake.emit("r1", done("ok"));
    await first.settled();
    const again = await client.submit({ agent: "frontdesk", requestId: "r1", input: message });
    expect(again.disposition).toBe("existing");
    expect(await again.settled()).toEqual(done("ok"));
  });

  it("subscribes to an earlier request, and reports not_found for an unknown one", async () => {
    const { fake, client } = await setup();
    fake.emit("old", text("x"));
    fake.emit("old", done("x"));
    const run = await client.subscribe("old");
    expect(await run.settled()).toEqual(done("x"));
    expect(
      isGatewayError(await client.subscribe("nope").catch((e: unknown) => e), "not_found"),
    ).toBe(true);
  });

  it("lists agents and pings", async () => {
    const { client } = await setup();
    expect(await client.listAgents()).toEqual([
      { name: "frontdesk", model: "scripted/x", tools: [] },
    ]);
    await client.ping();
  });
});

describe("GatewayClient over HTTP", () => {
  it("submits, streams over SSE and resumes after a drop with Last-Event-ID", async () => {
    const { fake, client } = await setup({ transport: "http" });
    const run = await client.submit({ agent: "frontdesk", requestId: "a/b", input: message });
    expect(run.disposition).toBe("started");
    const events = collect(run);
    fake.emit("a/b", text("1"));
    fake.emit("a/b", text("2"));
    await until(() => expect(run.lastSeq).toBe(2));
    fake.drop();
    fake.emit("a/b", text("3"));
    fake.emit("a/b", done("123"));
    expect((await events).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(fake.http.filter((r) => r.path.endsWith("/events")).at(-1)?.lastEventId).toBe("2");
  });

  it("retries a busy submit, types errors, and refuses commands HTTP cannot carry", async () => {
    const { fake, client } = await setup({ transport: "http" });
    fake.busyNext(1);
    await client.submit({ agent: "frontdesk", requestId: "r1", input: message });
    expect(fake.http.filter((r) => r.path === "/v1/submit")).toHaveLength(2);
    const forbidden = await client
      .submit({ agent: "secret", requestId: "r2", input: message })
      .catch((e: unknown) => e);
    expect(isGatewayError(forbidden, "forbidden")).toBe(true);
    await expect(client.approve({ approvalId: "a", decision: "approve" })).rejects.toThrow(
      /WebSocket transport/,
    );
  });
});

describe("Run", () => {
  it("takes settled even with a seq it has passed, as after a gateway restart", async () => {
    const run = new Run("r1");
    run.push({ type: "event", requestId: "r1", seq: 5, event: text("x") });
    expect(run.push({ type: "event", requestId: "r1", seq: 5, event: text("x") })).toBe(false);
    expect(run.push({ type: "event", requestId: "r1", seq: 1, event: done("x") })).toBe(true);
    expect(await run.settled()).toEqual(done("x"));
    expect(run.push({ type: "event", requestId: "r1", seq: 2, event: done("y") })).toBe(false);
  });
});

describe("makeRequestId", () => {
  it("is stable for the same inputs and changes with any of them", async () => {
    const id = await makeRequestId("acme", "frontdesk", "2026-10-08", "Book Ada at 3pm");
    expect(id).toMatch(/^acme:frontdesk:2026-10-08:[0-9a-f]{16}$/);
    expect(await makeRequestId("acme", "frontdesk", "2026-10-08", "Book Ada at 3pm")).toBe(id);
    expect(
      await makeRequestId("acme", "frontdesk", new Date("2026-10-08T23:00:00Z"), "Book Ada at 3pm"),
    ).toBe(id);
    expect(await makeRequestId("acme", "frontdesk", "2026-10-08", "Book Ada at 4pm")).not.toBe(id);
    expect(await makeRequestId("acme", "sales", "2026-10-08", "Book Ada at 3pm")).not.toBe(id);
  });

  it("refuses parts that would make the id ambiguous", async () => {
    await expect(makeRequestId("a:b", "", "08/10/2026", "x")).rejects.toThrow(
      /org must be .*; role must be .*; date must be/,
    );
  });
});
