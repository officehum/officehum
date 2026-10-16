/**
 * Contract tests for the Pi Durable adapter.
 *
 * These pin the behavior Office Hum relies on, so a later Pi Durable pin bump fails here rather than in
 * production: `requestId` idempotency, recovery of an interrupted run from a reopened SQLite file, the
 * `replay` classification of an interrupted tool, and per-bundle extension selection.
 *
 * In-memory storage except where a reopen is the point, and the scripted provider throughout: no
 * network, no real model, no credential. Every assertion keeps its meaning; the scripted provider also
 * lets a case read back the tools the model was offered.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";
import type { RoleBundle } from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedProvider } from "../testing/scripted-model.js";
import { openOffice, ROOT_KEY } from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sqliteFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "officehum-adapter-"));
  temps.push(directory);
  return join(directory, "office.sqlite");
}

/** A bundle with one run-counting tool, its own extension name and the scripted model. */
function toolBundle(
  extensionName: string,
  tools: ReturnType<typeof defineTool>[],
  model: ModelRef,
  hooks: ReturnType<typeof hook>[] = [],
): RoleBundle {
  const extension = defineExtension({ name: extensionName, tools, hooks });
  return {
    extensions: [extension],
    agent: { model, extensions: [extension] },
  };
}

/** A script that calls `toolName` once and then answers, branched on the transcript so it never runs out. */
function callThenAnswer(toolName: string) {
  return (messages: readonly { role: string }[]) =>
    messages.some((message) => message.role === "toolResult")
      ? { text: "finished" }
      : { toolCalls: [{ name: toolName }] };
}

describe("office adapter", () => {
  it("submits once per requestId, returns the original for a repeat, and calls the model once", async () => {
    const scripted = scriptedProvider([{ text: "done" }, { text: "done" }, { text: "done" }]);
    const office = await openOffice({ storage: "memory", models: scripted.models });
    const conversation = await office.conversation(ROOT_KEY, { agent: { model: scripted.model } });

    const first = await office.submit(conversation, { input: "first", requestId: "same" });
    expect((await first.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(scripted.calls).toBe(1);

    // The same key on the same conversation is the original submission, and costs no second model call.
    const repeat = await office.submit(conversation, { input: "first", requestId: "same" });
    expect(repeat.id).toBe(first.id);
    expect((await repeat.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(scripted.calls).toBe(1);

    const second = await office.submit(conversation, { input: "second", requestId: "different" });
    expect(second.id).not.toBe(first.id);
    expect((await second.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(scripted.calls).toBe(2);

    // One recorded request per model call, and no tools offered because the role declares none.
    expect(scripted.requests).toHaveLength(2);
    expect(scripted.requests.every((request) => request.tools.length === 0)).toBe(true);

    await office.close();
  });

  it("finds an unsettled submission after reopening the same SQLite file and resumes it", async () => {
    const file = sqliteFile();
    const scripted = scriptedProvider([{ text: "done" }]);
    const office = await openOffice({ storage: { sqlite: file }, models: scripted.models });
    const conversation = await office.conversation(ROOT_KEY, { agent: { model: scripted.model } });
    const submitted = await office.submit(conversation, {
      input: "survive me",
      requestId: "reopen",
    });

    // Crash before the submission settles: the office is closed with the run not yet finished.
    await office.close();

    const reopened = await openOffice({ storage: { sqlite: file }, models: scripted.models });
    const found = await reopened.submission(submitted.id);
    expect(found).toBeDefined();
    expect((await found?.status(BACKGROUND_CONTEXT))?.requestId).toBe("reopen");
    expect((await found?.wait(BACKGROUND_CONTEXT))?.status).toBe("done");
    expect(scripted.calls).toBe(1);
    await reopened.close();
  });

  it("re-runs an interrupted replay-safe tool and does not re-run a replay-unsafe one", async () => {
    const runs = { safe: 0, unsafe: 0 };

    for (const kind of ["safe", "unsafe"] as const) {
      const file = sqliteFile();
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let pauses = 0;
      // Pause after the tool's effect, on the first run only, so the office can be closed around an
      // unsettled tool task. `awaitWithContext` keeps the pause cancellable, so `close()` can proceed.
      const pauseAfterTool = hook(ToolTask, {
        afterTool: async (call, result, _api, context) => {
          if (call.name !== `${kind}_tool`) return result;
          pauses += 1;
          if (pauses > 1) return result;
          reached();
          await awaitWithContext(new Promise<never>(() => {}), context);
          return result;
        },
      });
      const tool = defineTool({
        name: `${kind}_tool`,
        description: `Interruptible ${kind} tool.`,
        parameters: Type.Object({}),
        replay: kind,
        execute: async () => {
          runs[kind] += 1;
          return { output: [{ type: "text" as const, text: `${kind} ran` }] };
        },
      });
      const scripted = scriptedProvider(callThenAnswer(`${kind}_tool`));
      const bundle = toolBundle(`replay-${kind}`, [tool], scripted.model, [pauseAfterTool]);

      const office = await openOffice({
        storage: { sqlite: file },
        models: scripted.models,
      });
      office.install(bundle);
      const conversation = await office.conversation(ROOT_KEY, { agent: bundle.agent });
      const submitted = await office.submit(conversation, {
        input: `run ${kind}`,
        requestId: `${kind}-once`,
      });
      await paused;
      await office.close();

      const reopened = await openOffice({
        storage: { sqlite: file },
        models: scripted.models,
      });
      reopened.install(bundle);
      const found = await reopened.submission(submitted.id);
      expect(found).toBeDefined();
      expect((await found?.wait(BACKGROUND_CONTEXT))?.status).toBe("done");
      await reopened.close();

      // A safe tool is retried after the crash; an unsafe one is not, and the model sees the
      // interrupted result instead. Either way the run took two model calls: the call, then the answer.
      expect(runs[kind]).toBe(kind === "safe" ? 2 : 1);
      expect(scripted.calls).toBe(2);
    }
  }, 30_000);

  it("selects only the installed bundle's extensions for a conversation", async () => {
    const runs = { a: 0, b: 0 };
    const tool = (name: string) =>
      defineTool({
        name,
        description: `Test tool ${name}.`,
        parameters: Type.Object({}),
        replay: "safe" as const,
        execute: async () => {
          if (name === "a_only") runs.a += 1;
          else runs.b += 1;
          return { output: [{ type: "text" as const, text: `${name} ran` }] };
        },
      });
    // Turn 3 asks for the other bundle's tool; it is not in this conversation's selection, so it must
    // not run, and the model is only ever offered a_only.
    const scripted = scriptedProvider([
      { toolCalls: [{ name: "a_only" }] },
      { text: "done" },
      { toolCalls: [{ name: "b_only" }] },
      { text: "done" },
    ]);
    const bundleA = toolBundle("isolation-a", [tool("a_only")], scripted.model);
    const bundleB = toolBundle("isolation-b", [tool("b_only")], scripted.model);

    const office = await openOffice({ storage: "memory", models: scripted.models });
    office.install(bundleA);
    office.install(bundleB);
    const conversation = await office.conversation(ROOT_KEY, { agent: bundleA.agent });

    const selected = await office.submit(conversation, { input: "use a", requestId: "a" });
    expect((await selected.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(runs.a).toBe(1);

    // The other bundle's tool is not in this conversation's selection, so it must not execute.
    const outside = await office.submit(conversation, { input: "use b", requestId: "b" });
    await outside.wait(BACKGROUND_CONTEXT);
    expect(runs.b).toBe(0);

    // Every request this conversation made was offered only the selected bundle's tool.
    expect(scripted.requests.length).toBeGreaterThan(0);
    const offered = scripted.requests.map((request) => request.tools.map((entry) => entry.name));
    expect(offered.every((names) => names.length === 1 && names[0] === "a_only")).toBe(true);
    // The model did ask for b_only (turn 3); the harness only refused to run it.
    expect(scripted.calls).toBeGreaterThanOrEqual(3);

    await office.close();
  }, 20_000);
});
