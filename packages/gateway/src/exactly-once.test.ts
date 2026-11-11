/**
 * Exactly-once across the gateway (SPEC-PI-INTERAGENT-001 US-3, AC-3.1 and AC-3.2): a real gateway
 * over a real runtime process, with the scripted model and the fixture role, failed in each way a
 * client, the runtime or the gateway can fail. Every scenario checks how often the model was called
 * and how often each tool ran, from the files the fixture runtime writes.
 *
 * These tests start processes and kill them, so each takes a few seconds; they run in `npm run check`
 * with the rest of the suite.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  connect,
  counts,
  lines,
  settledOf,
  start,
  startProcess,
  stopProcess,
  submit,
  token,
  waitForFile,
  workDirectory,
} from "./fixtures/harness.js";

const settledEvents = (received: Record<string, unknown>[], requestId: string) =>
  received.filter(settledOf(requestId));

/** Whether a process is still running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("exactly-once across the gateway", () => {
  it("1. a re-submitted settled request returns the stored result without running again", async () => {
    const { gateway, directory } = await start();
    const client = await connect(gateway, await token("ada", ["staff"]));
    client.send(submit("c1", "r1", "lookup once"));
    const first = await client.find(settledOf("r1"));
    const before = counts(directory);
    expect(before).toEqual({ tools: { safe_step: 1 }, model: { "lookup once": 2 } });

    client.send(submit("c2", "r1", "lookup once"));
    expect(await client.find((m) => m.id === "c2")).toEqual({
      type: "accepted",
      id: "c2",
      requestId: "r1",
      disposition: "existing",
    });
    await vi.waitFor(() => expect(settledEvents(client.received, "r1")).toHaveLength(2), {
      timeout: 20_000,
      interval: 20,
    });
    expect(settledEvents(client.received, "r1")[1]?.event).toEqual(first.event);
    expect(first.event).toEqual({ kind: "settled", status: "done", answer: "Looked it up." });
    expect(counts(directory)).toEqual(before);
  }, 60_000);

  it("2. a client that drops mid-run and re-submits gets one run and one result", async () => {
    const { gateway, directory } = await start();
    const bearer = await token("ada", ["staff"]);
    const dropped = await connect(gateway, bearer);
    dropped.send(submit("c1", "g1", "gate drop"));
    expect(await dropped.find((m) => m.id === "c1")).toMatchObject({ disposition: "started" });
    await waitForFile(directory, "gate-started");
    dropped.socket.terminate();

    const again = await connect(gateway, bearer);
    again.send(submit("c1", "g1", "gate drop"));
    expect(await again.find((m) => m.id === "c1")).toMatchObject({
      type: "accepted",
      disposition: "existing",
    });
    writeFileSync(join(directory, "release"), "");
    const settled = await again.find(settledOf("g1"));
    expect(settled.event).toEqual({ kind: "settled", status: "done", answer: "Through the gate." });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settledEvents(again.received, "g1")).toHaveLength(1);
    expect(counts(directory)).toEqual({ tools: { gate_step: 1 }, model: { "gate drop": 2 } });
  }, 60_000);

  it("3. a runtime killed during a safe tool resumes and delivers the result once", async () => {
    const { gateway, directory } = await start();
    const client = await connect(gateway, await token("ada", ["staff"]));
    client.send(submit("c1", "g1", "gate crash"));
    await client.find((m) => m.id === "c1");
    await waitForFile(directory, "gate-started");
    const first = gateway.runtimePid() as number;
    process.kill(first, "SIGKILL");
    writeFileSync(join(directory, "release"), "");

    const settled = await client.find(settledOf("g1"), 30_000);
    expect(settled.event).toEqual({ kind: "settled", status: "done", answer: "Through the gate." });
    expect(gateway.runtimePid()).not.toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settledEvents(client.received, "g1")).toHaveLength(1);
    // A safe tool may run again after a crash: once before the kill, once when the run resumes.
    // The model call that asked for it was committed, so it is not repeated.
    expect(counts(directory)).toEqual({ tools: { gate_step: 2 }, model: { "gate crash": 2 } });
  }, 60_000);

  it("4. a runtime killed during an unsafe tool never runs it again and reports it interrupted", async () => {
    const { gateway, directory } = await start();
    const client = await connect(gateway, await token("ada", ["staff"]));
    client.send(submit("c1", "u1", "unsafe work"));
    await client.find((m) => m.id === "c1");
    await waitForFile(directory, "unsafe-started");
    process.kill(gateway.runtimePid() as number, "SIGKILL");

    const settled = await client.find(settledOf("u1"), 30_000);
    expect(settled.event).toEqual({
      kind: "settled",
      status: "done",
      answer: "resumed and finished",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settledEvents(client.received, "u1")).toHaveLength(1);
    expect(counts(directory)).toEqual({
      tools: { safe_step: 1, unsafe_step: 1 },
      model: { "unsafe work": 3 },
    });
    // The model's last turn saw the unsafe call's result as interrupted, not a fresh run of it.
    const last = JSON.parse(lines(directory, "model.log").at(-1) as string) as { seen: string };
    expect(last.seen).toMatch(/unsafe_step: .*interrupted/is);
  }, 60_000);

  it("5. after the gateway is SIGKILLed and restarted, re-submitting returns the stored result", async () => {
    const directory = workDirectory();
    const bearer = await token("ada", ["staff"]);
    const first = await startProcess(directory);
    const client = await connect(first.url, bearer);
    client.send(submit("c1", "k1", "lookup stored"));
    const stored = await client.find(settledOf("k1"));
    const before = counts(directory);
    expect(before).toEqual({ tools: { safe_step: 1 }, model: { "lookup stored": 2 } });

    const runtime = Number(lines(directory, "runtime.pid").at(-1));
    await stopProcess(first.child, "SIGKILL");
    // The runtime's stdin closes with the gateway, so it shuts down rather than lingering.
    await vi.waitFor(() => expect(alive(runtime)).toBe(false), { timeout: 20_000, interval: 50 });

    const second = await startProcess(directory);
    expect(lines(directory, "runtime.pid")).toHaveLength(2);
    const retry = await connect(second.url, bearer);
    retry.send(submit("c1", "k1", "lookup stored"));
    expect(await retry.find((m) => m.id === "c1")).toMatchObject({ disposition: "existing" });
    expect((await retry.find(settledOf("k1"))).event).toEqual(stored.event);
    const status = await fetch(`${second.url}/v1/requests/k1`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(await status.json()).toMatchObject({
      status: "settled",
      result: { answer: "Looked it up." },
    });
    expect(counts(directory)).toEqual(before);
  }, 90_000);

  it("6. two principals with the same requestId get separate runs and cannot read each other's", async () => {
    const { gateway, directory } = await start();
    const ada = await connect(gateway, await token("ada", ["staff"]));
    const bo = await connect(gateway, await token("bo", ["staff"]));
    ada.send(submit("c1", "same", "hello from ada"));
    bo.send(submit("c1", "same", "hello from bo"));
    expect((await ada.find(settledOf("same"))).event).toMatchObject({
      answer: "Echo: hello from ada",
    });
    expect((await bo.find(settledOf("same"))).event).toMatchObject({
      answer: "Echo: hello from bo",
    });
    expect(ada.received.find((m) => m.id === "c1")).toMatchObject({ disposition: "started" });
    expect(bo.received.find((m) => m.id === "c1")).toMatchObject({ disposition: "started" });
    expect(counts(directory).model).toEqual({ "hello from ada": 1, "hello from bo": 1 });

    // Naming the other principal's scoped id reaches nothing: it is scoped again under the caller.
    bo.send({ type: "subscribe", id: "s1", requestId: "ada/same" });
    expect(await bo.find((m) => m.id === "s1")).toMatchObject({
      type: "error",
      code: "not_found",
    });
    const asCarol = await fetch(`${gateway.url}/v1/requests/same`, {
      headers: { authorization: `Bearer ${await token("carol", ["staff"])}` },
    });
    expect(asCarol.status).toBe(404);
    expect(await asCarol.json()).toMatchObject({ code: "not_found" });
    // Nothing of Ada's run reached Bo's connection, and nothing of Bo's reached Ada's.
    expect(JSON.stringify(bo.received)).not.toContain("from ada");
    expect(JSON.stringify(ada.received)).not.toContain("from bo");
  }, 60_000);

  it("7. ten concurrent submits of one requestId start exactly one run", async () => {
    const { gateway, directory } = await start();
    const bearer = await token("ada", ["staff"]);
    const clients = await Promise.all(Array.from({ length: 10 }, () => connect(gateway, bearer)));
    for (const [n, client] of clients.entries()) {
      client.send(submit(`c${n}`, "dup", "lookup in parallel"));
    }
    const accepted = await Promise.all(
      clients.map((client) => client.find((m) => m.type === "accepted")),
    );
    const dispositions = accepted.map((m) => m.disposition).sort();
    expect(dispositions).toEqual(["existing", ...Array(8).fill("existing"), "started"].sort());
    const settled = await Promise.all(clients.map((client) => client.find(settledOf("dup"))));
    for (const message of settled) {
      expect(message.event).toEqual({ kind: "settled", status: "done", answer: "Looked it up." });
    }
    expect(counts(directory)).toEqual({
      tools: { safe_step: 1 },
      model: { "lookup in parallel": 2 },
    });
  }, 60_000);
});
