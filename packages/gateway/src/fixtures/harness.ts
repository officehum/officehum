/**
 * The gateway's end-to-end test harness: a signing key, a gateway in this process (or in its own,
 * so a test can SIGKILL it) over the fixture runtime, and WebSocket clients that collect what they
 * receive. Everything it starts is stopped after each test.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, expect, vi } from "vitest";
import { WebSocket } from "ws";
import { type TokenKey, tokenKey } from "../auth.js";
import { parseGatewayConfig } from "../config.js";
import type { AuditEntry } from "../router.js";
import { type Gateway, startGateway } from "../server.js";

export const fixture = fileURLToPath(new URL("./runtime-fixture.mjs", import.meta.url));
export const repository = fileURLToPath(new URL("../../../..", import.meta.url));
const bin = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));

export let key: TokenKey;
let publicKey: string;
/** jose's signing key type, without relying on the DOM's global CryptoKey. */
export type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let privateKey: SigningKey;
beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateKey = pair.privateKey;
  publicKey = await exportSPKI(pair.publicKey);
  key = tokenKey(publicKey);
});

export async function token(sub: string, roles: string[], expiresIn = "1h", signer?: SigningKey) {
  return await new SignJWT({ roles })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(sub)
    .setExpirationTime(expiresIn)
    .sign(signer ?? privateKey);
}

export const temps: string[] = [];
const gateways: Gateway[] = [];
const processes: ChildProcess[] = [];
export const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const child of processes.splice(0)) await stopProcess(child, "SIGTERM");
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

export function workDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "officehum-gateway-"));
  temps.push(directory);
  return directory;
}

const settings = {
  version: 1,
  listen: { host: "127.0.0.1", port: 0 },
  runtime: { command: process.execPath, args: [fixture], cwd: repository },
  permissions: {
    submit: [{ roles: ["staff"], agents: ["worker"] }],
    approve: [{ roles: ["manager"], limit: 100 }],
    abort: [{ roles: ["staff"] }],
  },
};

/** A gateway in this process over the fixture runtime, once its runtime is up. */
export async function start(directory = workDirectory()) {
  const audit: AuditEntry[] = [];
  const log: string[] = [];
  const gateway = await startGateway({
    config: parseGatewayConfig(settings, repository),
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

/** The built `officehum-gateway` in its own process, so a test can SIGKILL it. */
export async function startProcess(directory: string) {
  const config = join(directory, "gateway.json");
  writeFileSync(config, JSON.stringify(settings));
  const child = spawn(process.execPath, [bin, "--config", config], {
    cwd: repository,
    env: { ...process.env, FIXTURE_DIR: directory, OFFICEHUM_GATEWAY_JWT_PUBLIC_KEY: publicKey },
    stdio: ["ignore", "ignore", "pipe"],
  });
  processes.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const url = await vi.waitFor(
    () => {
      const found = /Gateway listening on (\S+)/.exec(stderr)?.[1];
      if (found === undefined) throw new Error(`gateway not listening yet; stderr: ${stderr}`);
      return found;
    },
    { timeout: 20_000, interval: 25 },
  );
  await vi.waitFor(
    async () =>
      expect(await (await fetch(`${url}/healthz`)).json()).toMatchObject({ runtime: "up" }),
    { timeout: 20_000, interval: 50 },
  );
  return { child, url };
}

export async function stopProcess(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill(signal);
  await exited;
}

/** A WebSocket client that collects every message it receives. */
export async function connect(target: Gateway | string, bearer?: string) {
  const base = typeof target === "string" ? target : target.url;
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/v1/ws`, {
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

export const settledOf = (requestId: string) => (message: Record<string, unknown>) =>
  message.type === "event" &&
  message.requestId === requestId &&
  (message.event as { kind?: string }).kind === "settled";

export const submit = (id: string, requestId: string, text: string, extra: object = {}) => ({
  type: "submit",
  id,
  agent: "worker",
  requestId,
  input: { kind: "message", text },
  ...extra,
});

/** The non-empty lines of a file the fixture runtime writes, or none if it has not written it. */
export function lines(directory: string, file: string): string[] {
  const path = join(directory, file);
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

/** How many times the fixture ran each tool, and how many model calls each request text made. */
export function counts(directory: string) {
  const tools: Record<string, number> = {};
  for (const name of lines(directory, "calls.log")) tools[name] = (tools[name] ?? 0) + 1;
  const model: Record<string, number> = {};
  for (const line of lines(directory, "model.log")) {
    const { request } = JSON.parse(line) as { request: string };
    model[request] = (model[request] ?? 0) + 1;
  }
  return { tools, model };
}

export const waitForFile = (directory: string, file: string) =>
  vi.waitFor(() => expect(existsSync(join(directory, file))).toBe(true), {
    timeout: 20_000,
    interval: 25,
  });
