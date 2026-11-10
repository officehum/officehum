import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { type TokenKey, tokenKey } from "./auth.js";
import { parseGatewayConfig } from "./config.js";
import type { AuditEntry } from "./router.js";
import { type Gateway, startGateway } from "./server.js";

const fixture = fileURLToPath(new URL("./fixtures/runtime-fixture.mjs", import.meta.url));
const repository = fileURLToPath(new URL("../../..", import.meta.url));

let key: TokenKey;
/** jose's signing key type, without relying on the DOM's global CryptoKey. */
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let privateKey: SigningKey;
beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateKey = pair.privateKey;
  key = tokenKey(await exportSPKI(pair.publicKey));
});

async function token(sub: string, roles: string[], expiresIn = "1h", signer?: SigningKey) {
  return await new SignJWT({ roles })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(sub)
    .setExpirationTime(expiresIn)
    .sign(signer ?? privateKey);
}

const temps: string[] = [];
const gateways: Gateway[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function start() {
  const directory = mkdtempSync(join(tmpdir(), "officehum-gateway-"));
  temps.push(directory);
  const audit: AuditEntry[] = [];
  const log: string[] = [];
  const config = parseGatewayConfig(
    {
      version: 1,
      listen: { host: "127.0.0.1", port: 0 },
      runtime: { command: process.execPath, args: [fixture], cwd: repository },
      permissions: {
        submit: [{ roles: ["staff"], agents: ["worker"] }],
        approve: [{ roles: ["manager"], limit: 100 }],
        abort: [{ roles: ["staff"] }],
      },
    },
    repository,
  );
  const gateway = await startGateway({
    config,
    key,
    runtimeEnv: { ...process.env, FIXTURE_DIR: directory },
    backoff: { initialMs: 50, maxMs: 200, stableMs: 60_000 },
    log: (line) => log.push(line),
    audit: (entry) => audit.push(entry),
  });
  gateways.push(gateway);
  await vi.waitFor(() => expect(gateway.runtimeUp()).toBe(true), { timeout: 20_000, interval: 25 });
  return { gateway, directory, audit, log };
}

/** A WebSocket client that collects every message it receives. */
async function connect(gateway: Gateway, bearer?: string) {
  const socket = new WebSocket(`${gateway.url.replace(/^http/, "ws")}/v1/ws`, {
    ...(bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
  });
  sockets.push(socket);
  const received: Record<string, unknown>[] = [];
  socket.on("message", (data) =>
    received.push(JSON.parse(data.toString()) as Record<string, unknown>),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const send = (message: object) => socket.send(JSON.stringify(message));
  const find = (predicate: (message: Record<string, unknown>) => boolean, timeout = 20_000) =>
    vi.waitFor(
      () => {
        const found = received.find(predicate);
        if (found === undefined) throw new Error(`not yet; received ${JSON.stringify(received)}`);
        return found;
      },
      { timeout, interval: 20 },
    );
  return { socket, received, send, find };
}

const settledOf = (requestId: string) => (message: Record<string, unknown>) =>
  message.type === "event" &&
  message.requestId === requestId &&
  (message.event as { kind?: string }).kind === "settled";

const submit = (id: string, requestId: string, text: string, extra: object = {}) => ({
  type: "submit",
  id,
  agent: "worker",
  requestId,
  input: { kind: "message", text },
  ...extra,
});

describe("gateway over WebSocket", () => {
  it("lets a signed-in client submit to a role and stream to settled", async () => {
    const { gateway } = await start();
    const client = await connect(gateway, await token("ada", ["staff"]));
    client.send({ type: "hello", version: 1, client: "test" });
    expect(await client.find((m) => m.type === "welcome")).toEqual({
      type: "welcome",
      version: 1,
      serverId: "office-gw",
    });
    client.send(submit("c1", "r1", "lookup the thing"));
    expect(await client.find((m) => m.type === "accepted")).toEqual({
      type: "accepted",
      id: "c1",
      requestId: "r1",
      disposition: "started",
    });
    const settled = await client.find(settledOf("r1"));
    expect(settled.event).toEqual({ kind: "settled", status: "done", answer: "Looked it up." });
    const events = client.received.filter((m) => m.type === "event");
    expect(events.map((m) => m.seq)).toEqual(events.map((_, index) => index + 1));
  }, 30_000);

  it("signs in with a token in hello, and refuses commands before that", async () => {
    const { gateway } = await start();
    const client = await connect(gateway);
    client.send({ type: "ping", id: "p1" });
    expect(await client.find((m) => m.id === "p1")).toMatchObject({
      type: "error",
      code: "unauthorized",
    });
    client.send({
      type: "hello",
      version: 1,
      client: "browser",
      token: await token("ada", ["staff"]),
    });
    await client.find((m) => m.type === "welcome");
    client.send({ type: "ping", id: "p2" });
    expect(await client.find((m) => m.id === "p2")).toEqual({ type: "result", id: "p2", ok: true });
  }, 30_000);

  it("refuses a bad or expired token", async () => {
    const { gateway } = await start();
    const stranger = await generateKeyPair("ES256");
    const forged = await token("ada", ["staff"], "1h", stranger.privateKey);
    const refused = new WebSocket(`${gateway.url.replace(/^http/, "ws")}/v1/ws`, {
      headers: { authorization: `Bearer ${forged}` },
    });
    sockets.push(refused);
    refused.on("error", () => {});
    const status = await new Promise<number | undefined>((resolve) => {
      refused.once("unexpected-response", (_request, response) => resolve(response.statusCode));
      refused.once("open", () => resolve(undefined));
    });
    expect(status).toBe(401);

    const client = await connect(gateway);
    client.send({
      type: "hello",
      version: 1,
      client: "t",
      token: await token("ada", ["staff"], "-1m"),
    });
    expect(await client.find((m) => m.type === "error")).toMatchObject({
      code: "unauthorized",
      message: expect.stringContaining("expired"),
    });
  }, 30_000);

  it("refuses a command the principal's roles do not allow", async () => {
    const { gateway, audit } = await start();
    const client = await connect(gateway, await token("vic", ["visitor"]));
    client.send(submit("c1", "r1", "hello"));
    expect(await client.find((m) => m.id === "c1")).toMatchObject({
      type: "error",
      code: "forbidden",
    });
    client.send({ type: "abort", id: "c2", requestId: "r1" });
    expect(await client.find((m) => m.id === "c2")).toMatchObject({
      type: "error",
      code: "forbidden",
    });
    expect(audit).toContainEqual(
      expect.objectContaining({ principal: "vic", action: "submit", outcome: "forbidden" }),
    );
  }, 30_000);

  it("replaces a client-sent principal with the token's", async () => {
    const { gateway, audit } = await start();
    const client = await connect(gateway, await token("ada", ["staff"]));
    client.send(submit("c1", "r1", "hi", { principal: { id: "mallory", roles: ["admin"] } }));
    await client.find(settledOf("r1"));
    expect(audit).toContainEqual(
      expect.objectContaining({ principal: "ada", action: "submit", outcome: "forwarded" }),
    );

    // The request is Ada's at the runtime: she finds it, Mallory does not.
    const asAda = await fetch(`${gateway.url}/v1/requests/r1`, {
      headers: { authorization: `Bearer ${await token("ada", ["staff"])}` },
    });
    expect(await asAda.json()).toMatchObject({ requestId: "r1", status: "settled" });
    const asMallory = await fetch(`${gateway.url}/v1/requests/r1`, {
      headers: { authorization: `Bearer ${await token("mallory", ["staff"])}` },
    });
    expect(asMallory.status).toBe(404);
  }, 30_000);

  it("survives the runtime being killed mid-request: same connection, settled, no repeated unsafe tool", async () => {
    const { gateway, directory, log } = await start();
    const client = await connect(gateway, await token("ada", ["staff"]));
    client.send(submit("c1", "job", "unsafe work"));
    await client.find((m) => m.type === "accepted");
    await vi.waitFor(() => expect(existsSync(join(directory, "unsafe-started"))).toBe(true), {
      timeout: 20_000,
      interval: 25,
    });
    const first = gateway.runtimePid();
    process.kill(first as number, "SIGKILL");

    const settled = await client.find(settledOf("job"), 30_000);
    expect(settled.event).toEqual({
      kind: "settled",
      status: "done",
      answer: "resumed and finished",
    });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(gateway.runtimePid()).not.toBe(first);
    expect(log.some((line) => line.includes("restarting it"))).toBe(true);

    const calls = readFileSync(join(directory, "calls.log"), "utf8").trim().split("\n");
    expect(calls.filter((name) => name === "unsafe_step")).toHaveLength(1);
    // The client saw one gapless, growing sequence across the restart, and one settled.
    const events = client.received.filter((m) => m.type === "event" && m.requestId === "job");
    expect(events.map((m) => m.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.filter((m) => (m.event as { kind: string }).kind === "settled")).toHaveLength(1);
  }, 60_000);

  it("keeps serving other clients while one stops reading", async () => {
    const { gateway } = await start();
    const slow = await connect(gateway, await token("ada", ["staff"]));
    slow.send(submit("s1", "slow-1", "lookup for the slow one"));
    await slow.find((m) => m.type === "accepted");
    (slow.socket as unknown as { _socket: { pause(): void } })._socket.pause();

    const fast = await connect(gateway, await token("bo", ["staff"]));
    for (let n = 0; n < 5; n++) fast.send(submit(`f${n}`, `fast-${n}`, `hello ${n}`));
    for (let n = 0; n < 5; n++) await fast.find(settledOf(`fast-${n}`));
  }, 30_000);
});

describe("gateway over HTTP", () => {
  it("submits, reports status, and streams events with Last-Event-ID resuming after the last seen", async () => {
    const { gateway } = await start();
    const headers = { authorization: `Bearer ${await token("ada", ["staff"])}` };
    const accepted = await fetch(`${gateway.url}/v1/submit`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        agent: "worker",
        requestId: "h1",
        input: { kind: "message", text: "lookup it" },
      }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({
      type: "accepted",
      id: "http",
      requestId: "h1",
      disposition: "started",
    });

    await vi.waitFor(
      async () => {
        const status = await fetch(`${gateway.url}/v1/requests/h1`, { headers });
        expect(await status.json()).toMatchObject({
          status: "settled",
          result: { answer: "Looked it up." },
        });
      },
      { timeout: 20_000, interval: 100 },
    );

    const all = await sse(gateway, "h1", headers);
    expect(all.map((event) => event.id)).toEqual(all.map((_, index) => String(index + 1)));
    expect(all.at(-1)?.event).toBe("settled");
    const resumed = await sse(gateway, "h1", { ...headers, "last-event-id": "1" });
    expect(resumed.map((event) => event.id)).toEqual(all.slice(1).map((event) => event.id));
  }, 30_000);

  it("refuses unauthenticated, bad-token and forbidden requests", async () => {
    const { gateway } = await start();
    const body = JSON.stringify({
      agent: "worker",
      requestId: "x",
      input: { kind: "message", text: "hi" },
    });
    const post = (authorization?: string) =>
      fetch(`${gateway.url}/v1/submit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        body,
      });
    const missing = await post();
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ code: "unauthorized" });
    expect((await post("Bearer not-a-token")).status).toBe(401);
    const forbidden = await post(`Bearer ${await token("vic", ["visitor"])}`);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: "forbidden" });
  }, 30_000);

  it("reports health without a token", async () => {
    const { gateway } = await start();
    const health = await fetch(`${gateway.url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", runtime: "up" });
  }, 30_000);
});

async function sse(gateway: Gateway, requestId: string, headers: Record<string, string>) {
  const response = await fetch(`${gateway.url}/v1/requests/${requestId}/events`, { headers });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const field = (name: string) =>
        block
          .split("\n")
          .find((line) => line.startsWith(`${name}: `))
          ?.slice(name.length + 2);
      return { id: field("id"), event: field("event"), data: JSON.parse(field("data") ?? "null") };
    });
}
