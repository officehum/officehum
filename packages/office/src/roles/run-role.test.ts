import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "officehum-role-run-"));
  temps.push(directory);
  return directory;
};

type ChildMessage =
  | { status: "opened" }
  | { status: "unsafe-started" }
  | { status: "resumed"; outcomes: string[]; text: string }
  | { status: "error"; message: string };

function roleChild(directory: string, phase: "first" | "resume"): ChildProcess {
  return fork(fileURLToPath(new URL("../fixtures/role-run-child.mjs", import.meta.url)), [], {
    cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
    env: { ...process.env, OFFICEHUM_TEST_DIRECTORY: directory, OFFICEHUM_TEST_PHASE: phase },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

async function message(child: ChildProcess): Promise<ChildMessage> {
  const [received] = (await once(child, "message")) as [ChildMessage];
  return received;
}

function callLog(directory: string): string[] {
  const path = join(directory, "calls.log");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

describe("role run crash and resume", () => {
  it("does not run an unsafe tool twice, while a safe tool runs again", async () => {
    const directory = temporary();
    const first = roleChild(directory, "first");
    try {
      expect(await message(first)).toEqual({ status: "opened" });
      // The child only signals once the unsafe tool is executing, so the kill lands inside it.
      expect(await message(first)).toEqual({ status: "unsafe-started" });
      expect(callLog(directory)).toEqual(["safe_step", "unsafe_step"]);

      first.kill("SIGKILL");
      await once(first, "exit");
      expect(existsSync(join(directory, "run.sqlite"))).toBe(true);

      const resumed = roleChild(directory, "resume");
      expect(await message(resumed)).toEqual({ status: "opened" });
      const result = await message(resumed);
      expect(result.status).toBe("resumed");
      if (result.status !== "resumed") return;
      expect(result.outcomes).toEqual(["done"]);
      await once(resumed, "exit");

      // The committed unsafe call is not re-executed; the safe call is allowed to run again.
      const calls = callLog(directory);
      expect(calls.filter((name) => name === "unsafe_step")).toHaveLength(1);
      expect(calls.filter((name) => name === "safe_step")).toHaveLength(2);
    } finally {
      if (first.exitCode === null && first.signalCode === null) first.kill("SIGKILL");
    }
  }, 30_000);
});
