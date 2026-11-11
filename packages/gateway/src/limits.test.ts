/**
 * Connection limits and expired sockets (RASF-3559), against a real gateway: a principal's, an
 * address's and the total limit, and a WebSocket closed when its token expires and no fresh `hello`
 * comes within the grace period.
 */
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { parseGatewayConfig } from "./config.js";
import { ConnectionLimits } from "./connection-limits.js";
import { connect, repository, sockets, start, token } from "./fixtures/harness.js";
import type { Gateway } from "./server.js";

/** The status a WebSocket upgrade is answered with: 101 when it opens. */
async function upgradeStatus(gateway: Gateway, bearer?: string): Promise<number> {
  const socket = new WebSocket(`${gateway.url.replace(/^http/, "ws")}/v1/ws`, {
    ...(bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
  });
  sockets.push(socket);
  socket.on("error", () => {});
  return await new Promise<number>((resolve) => {
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.once("open", () => resolve(101));
  });
}

const closed = (socket: WebSocket) =>
  new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));

describe("connection limits", () => {
  it("refuses a principal's connection over their limit, on WebSocket and event streams", async () => {
    const { gateway, audit } = await start(undefined, {}, { limits: { perPrincipal: 2 } });
    const ada = await token("ada", ["staff"]);
    const first = await connect(gateway, ada);
    await connect(gateway, ada);
    expect(await upgradeStatus(gateway, ada)).toBe(429);
    const stream = await fetch(`${gateway.url}/v1/requests/r1/events`, {
      headers: { authorization: `Bearer ${ada}` },
    });
    expect(stream.status).toBe(429);
    expect(await stream.json()).toMatchObject({ type: "error", code: "busy" });
    // Someone else is not held up by Ada's connections.
    expect(await upgradeStatus(gateway, await token("bo", ["staff"]))).toBe(101);
    expect(audit).toContainEqual(
      expect.objectContaining({
        principal: "ada",
        action: "connect",
        outcome: "refused: principal connection limit",
      }),
    );
    // Closing one makes room again.
    first.socket.close();
    await vi.waitFor(async () => expect(await upgradeStatus(gateway, ada)).toBe(101), {
      timeout: 5_000,
      interval: 50,
    });
  }, 30_000);

  it("refuses a principal over their limit who signs in with hello", async () => {
    const { gateway } = await start(undefined, {}, { limits: { perPrincipal: 1 } });
    const ada = await token("ada", ["staff"]);
    await connect(gateway, ada);
    const late = await connect(gateway);
    const ended = closed(late.socket);
    late.send({ type: "hello", version: 1, client: "t", token: ada });
    expect(await late.find((m) => m.type === "error")).toMatchObject({ code: "busy" });
    expect(await ended).toBe(1013);
  }, 30_000);

  it("enforces the limit for one address, on any kind of connection", async () => {
    const { gateway, audit } = await start(undefined, {}, { limits: { perAddress: 2 } });
    await connect(gateway, await token("ada", ["staff"]));
    await connect(gateway, await token("bo", ["staff"]));
    expect(await upgradeStatus(gateway, await token("cy", ["staff"]))).toBe(429);
    const submit = await fetch(`${gateway.url}/v1/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token("cy", ["staff"])}` },
      body: "{}",
    });
    expect(submit.status).toBe(429);
    expect(await submit.json()).toMatchObject({ code: "busy" });
    // A health check is never limited.
    expect((await fetch(`${gateway.url}/healthz`)).status).toBe(200);
    expect(
      audit.filter((entry) => entry.outcome === "refused: address connection limit"),
    ).toHaveLength(2);
  }, 30_000);

  it("answers 503 once the gateway holds its total", async () => {
    const { gateway } = await start(undefined, {}, { limits: { total: 1 } });
    await connect(gateway, await token("ada", ["staff"]));
    expect(await upgradeStatus(gateway, await token("bo", ["staff"]))).toBe(503);
  }, 30_000);
});

describe("expired WebSockets", () => {
  it("closes an expired, idle socket after the grace period", async () => {
    const { gateway } = await start(undefined, {}, { limits: { expiredGraceSeconds: 1 } });
    const client = await connect(gateway, await token("ada", ["staff"], "2s"));
    const ended = closed(client.socket);
    const notice = await client.find(
      (m) => m.type === "error" && m.code === "unauthorized",
      10_000,
    );
    const noticedAt = Date.now();
    expect(notice.message).toContain("within 1 seconds");
    expect(await ended).toBe(1008);
    expect(Date.now() - noticedAt).toBeGreaterThanOrEqual(800);
  }, 30_000);

  it("keeps a socket open that sends a fresh hello in time", async () => {
    const { gateway } = await start(undefined, {}, { limits: { expiredGraceSeconds: 2 } });
    const client = await connect(gateway, await token("ada", ["staff"], "2s"));
    await client.find((m) => m.type === "error" && m.code === "unauthorized", 10_000);
    client.send({ type: "hello", version: 1, client: "t", token: await token("ada", ["staff"]) });
    await client.find((m) => m.type === "welcome");
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    client.send({ type: "ping", id: "p1" });
    expect(await client.find((m) => m.id === "p1")).toEqual({ type: "result", id: "p1", ok: true });
  }, 30_000);
});

describe("ConnectionLimits", () => {
  const limits = { perPrincipal: 1, perAddress: 2, total: 3, expiredGraceSeconds: 60 };

  it("counts leases per address, principal and in total, and releases them once", () => {
    const counter = new ConnectionLimits(limits);
    const a = counter.open("1.1.1.1");
    if (!("lease" in a)) throw new Error("refused");
    expect(a.lease.assign("ada")).toBeUndefined();
    expect(a.lease.assign("ada")).toBeUndefined(); // the same principal again is no new count
    const b = counter.open("1.1.1.1");
    if (!("lease" in b)) throw new Error("refused");
    expect(b.lease.assign("ada")).toMatchObject({ status: 429, scope: "principal" });
    expect(counter.open("1.1.1.1")).toMatchObject({ refusal: { status: 429, scope: "address" } });
    const c = counter.open("2.2.2.2");
    expect(counter.open("3.3.3.3")).toMatchObject({ refusal: { status: 503, scope: "total" } });
    a.lease.release();
    a.lease.release();
    expect(b.lease.assign("ada")).toBeUndefined();
    b.lease.release();
    if ("lease" in c) c.lease.release();
    expect(counter.counts()).toEqual({ total: 0, addresses: 0, principals: 0 });
  });

  it("moves a lease's count when it signs in as someone else", () => {
    const counter = new ConnectionLimits(limits);
    const a = counter.open("1.1.1.1");
    if (!("lease" in a)) throw new Error("refused");
    a.lease.assign("ada");
    a.lease.assign("bo");
    const b = counter.open("1.1.1.1");
    if (!("lease" in b)) throw new Error("refused");
    expect(b.lease.assign("ada")).toBeUndefined();
  });
});

describe("limits in gateway.json", () => {
  const base = {
    version: 1,
    listen: { host: "127.0.0.1", port: 0 },
    runtime: { command: "officehum", args: [] },
  };

  it("defaults every limit, and takes the ones given", () => {
    expect(parseGatewayConfig(base, repository).limits).toEqual({
      perPrincipal: 32,
      perAddress: 64,
      total: 1024,
      expiredGraceSeconds: 60,
    });
    expect(parseGatewayConfig({ ...base, limits: { total: 10 } }, repository).limits.total).toBe(
      10,
    );
  });

  it("reports every bad limit with its path", () => {
    expect(() =>
      parseGatewayConfig(
        { ...base, limits: { perPrincipal: 0, total: 1.5, other: 1 } },
        repository,
      ),
    ).toThrow(/limits.other: is not a known field[\s\S]*limits.perPrincipal[\s\S]*limits.total/);
  });
});
