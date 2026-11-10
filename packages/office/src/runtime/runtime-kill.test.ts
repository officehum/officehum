import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LineDecoder } from "@officehum/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

const temps: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const principal = { id: "ada", roles: ["staff"] };

/** The runtime in its own process, with its frames, its stderr and its IPC messages collected. */
function runtimeChild(directory: string, phase: "first" | "resume") {
  const child = fork(fileURLToPath(new URL("../fixtures/runtime-child.mjs", import.meta.url)), [], {
    cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
    env: { ...process.env, OFFICEHUM_TEST_DIRECTORY: directory, OFFICEHUM_TEST_PHASE: phase },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  const frames: Record<string, unknown>[] = [];
  const signals: unknown[] = [];
  let stderr = "";
  const decoder = new LineDecoder();
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      frames.push(frame.ok ? (frame.value as Record<string, unknown>) : { bad: frame });
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("message", (message) => signals.push(message));
  const send = (message: object) => child.stdin?.write(`${JSON.stringify(message)}\n`);
  const waitFor = <T>(check: () => T | undefined, what: string) =>
    vi.waitFor(
      () => {
        const found = check();
        if (found === undefined)
          throw new Error(
            `waiting for ${what}; frames: ${JSON.stringify(frames)}; stderr: ${stderr}`,
          );
        return found;
      },
      { timeout: 20_000, interval: 25 },
    );
  return { child, frames, signals, send, waitFor, stderr: () => stderr };
}

function lines(directory: string, file: string): string[] {
  const path = join(directory, file);
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

describe("runtime process crash and restart", () => {
  it("resumes after a kill during an unsafe tool without running it again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-runtime-kill-"));
    temps.push(directory);

    const first = runtimeChild(directory, "first");
    await first.waitFor(() => first.frames.find((f) => f.type === "welcome"), "welcome");
    first.send({
      type: "submit",
      id: "c1",
      agent: "worker",
      requestId: "job-1",
      input: { kind: "message", text: "Run the steps." },
      principal,
    });
    await first.waitFor(
      () => first.frames.find((f) => f.type === "accepted" && f.disposition === "started"),
      "accepted",
    );
    // The child signals only once the unsafe tool is executing, so the kill lands inside it.
    await first.waitFor(
      () => first.signals.find((s) => (s as { status?: string }).status === "unsafe-started"),
      "the unsafe tool to start",
    );
    expect(lines(directory, "calls.log")).toEqual(["safe_step", "unsafe_step"]);
    first.child.kill("SIGKILL");
    await once(first.child, "exit");

    const second = runtimeChild(directory, "resume");
    await second.waitFor(() => second.frames.find((f) => f.type === "welcome"), "welcome");
    second.send({ type: "subscribe", id: "s1", requestId: "job-1", principal });
    const settled = await second.waitFor(
      () =>
        second.frames.find(
          (f) =>
            f.type === "event" && (f.event as { kind?: string } | undefined)?.kind === "settled",
        ),
      "settled",
    );
    expect(second.frames.find((f) => f.type === "result" && f.id === "s1")).toBeDefined();
    expect(settled).toMatchObject({
      requestId: "ada/job-1",
      event: { kind: "settled", status: "done", answer: "resumed and finished" },
    });

    // The committed unsafe call is not re-executed; the model was told it was interrupted.
    const calls = lines(directory, "calls.log");
    expect(calls.filter((name) => name === "unsafe_step")).toHaveLength(1);
    expect(lines(directory, "seen.log").join("\n").toLowerCase()).toContain("interrupted");

    second.child.stdin?.end();
    await once(second.child, "exit");
    expect(second.child.exitCode).toBe(0);
  }, 60_000);
});
