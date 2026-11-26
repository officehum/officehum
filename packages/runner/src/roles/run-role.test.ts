import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRef } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedProvider } from "../testing/scripted-model.js";
import type { LoadedRole } from "./load-role.js";
import { openRoleRun } from "./run-role.js";

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

describe("role run reload", () => {
  const SAVED: ModelRef = { provider: "scripted", modelId: "saved-model" };
  const OVERLAID: ModelRef = { provider: "scripted", modelId: "overlay-model" };

  /** A role whose `reload` picks up an overlay that names a different model, as `defineRole`'s does. */
  function overlaidRole(directory: string): LoadedRole {
    const agent: { model: ModelRef; extensions: [] } = { model: SAVED, extensions: [] };
    return {
      dir: directory,
      manifest: { id: "reload-fixture" },
      bundle: { extensions: [], agent },
      reload: () => {
        agent.model = OVERLAID;
        return [];
      },
    } as unknown as LoadedRole;
  }

  it("keeps the saved conversation's provider and model, across reload and reopen", async () => {
    const directory = temporary();
    const database = join(directory, "run.sqlite");
    const scripted = scriptedProvider([{ text: "first" }, { text: "second" }]);
    const role = overlaidRole(directory);

    const run = await openRoleRun({ role, database, models: scripted.models });
    try {
      expect(await run.reload()).toEqual([]);
      expect((await run.conversation.agent(BACKGROUND_CONTEXT)).model).toEqual(SAVED);
      await run.submit("hello", "after-reload");
      expect(scripted.requests.at(-1)?.model).toBe(SAVED.modelId);
    } finally {
      await run.close();
    }

    // The same file, reopened by a new process that asks for the model the conversation started
    // with: the reload left nothing behind that says otherwise.
    const reopened = await openRoleRun({ role, database, models: scripted.models, model: SAVED });
    try {
      expect((await reopened.conversation.agent(BACKGROUND_CONTEXT)).model).toEqual(SAVED);
      await reopened.reload();
      expect((await reopened.conversation.agent(BACKGROUND_CONTEXT)).model).toEqual(SAVED);
    } finally {
      await reopened.close();
    }
  });
});
