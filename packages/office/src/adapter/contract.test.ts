/**
 * Contract tests for the Pi Durable adapter.
 *
 * These pin the behavior Office Hum relies on, so a later Pi Durable pin bump fails here rather than in
 * production: `requestId` idempotency, recovery of an interrupted run from a reopened SQLite file, the
 * `replay` classification of an interrupted tool, and per-bundle extension selection.
 *
 * In-memory storage except where a reopen is the point, and a faux provider throughout: no network, no
 * real model, no credential.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";
import type { RoleBundle } from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
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

/** A faux provider whose responses count how many model calls the office actually made. */
function countingModels(
  name: string,
  responses: readonly (() => ReturnType<FauxResponseFactory>)[],
) {
  const calls = { count: 0 };
  const faux = fauxProvider({ provider: name, models: [{ id: "adapter-test" }] });
  const factories: FauxResponseFactory[] = responses.map((response) => () => {
    calls.count += 1;
    return response();
  });
  faux.setResponses(factories);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: { provider: name, modelId: "adapter-test" }, calls };
}

const plainText = () => fauxAssistantMessage("done");

/** A bundle whose one tool records how often it ran, with its own extension name. */
function toolBundle(
  provider: string,
  extensionName: string,
  tools: ReturnType<typeof defineTool>[],
  hooks: ReturnType<typeof hook>[] = [],
): RoleBundle {
  const extension = defineExtension({ name: extensionName, tools, hooks });
  return {
    extensions: [extension],
    agent: { model: { provider, modelId: "adapter-test" }, extensions: [extension] },
  };
}

/** A provider that calls `toolName` once and then answers, scripted enough times to cover a restart. */
function scriptedModels(provider: string, toolName: string) {
  const scripted: FauxResponseFactory = (context) =>
    context.messages.some((message) => message.role === "toolResult")
      ? fauxAssistantMessage("finished")
      : fauxAssistantMessage(fauxToolCall(toolName, {}), { stopReason: "toolUse" });
  const faux = fauxProvider({ provider, models: [{ id: "adapter-test" }] });
  faux.setResponses(Array.from({ length: 6 }, () => scripted));
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

describe("office adapter", () => {
  it("submits once per requestId, returns the original for a repeat, and calls the model once", async () => {
    const { models, calls } = countingModels("adapter-idempotent", [plainText, plainText]);
    const office = await openOffice({ storage: "memory", models });
    const conversation = await office.conversation(ROOT_KEY, {
      agent: { model: { provider: "adapter-idempotent", modelId: "adapter-test" } },
    });

    const first = await office.submit(conversation, { input: "first", requestId: "same" });
    expect((await first.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(calls.count).toBe(1);

    // The same key on the same conversation is the original submission, and costs no second model call.
    const repeat = await office.submit(conversation, { input: "first", requestId: "same" });
    expect(repeat.id).toBe(first.id);
    expect((await repeat.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(calls.count).toBe(1);

    const second = await office.submit(conversation, { input: "second", requestId: "different" });
    expect(second.id).not.toBe(first.id);
    expect((await second.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(calls.count).toBe(2);

    await office.close();
  });

  it("finds an unsettled submission after reopening the same SQLite file and resumes it", async () => {
    const file = sqliteFile();
    const { models, calls } = countingModels("adapter-reopen", [plainText]);
    const office = await openOffice({ storage: { sqlite: file }, models });
    const conversation = await office.conversation(ROOT_KEY, {
      agent: { model: { provider: "adapter-reopen", modelId: "adapter-test" } },
    });
    const submitted = await office.submit(conversation, {
      input: "survive me",
      requestId: "reopen",
    });

    // Crash before the submission settles: the office is closed with the run not yet finished.
    await office.close();

    const reopened = await openOffice({ storage: { sqlite: file }, models });
    const found = await reopened.submission(submitted.id);
    expect(found).toBeDefined();
    expect((await found?.status(BACKGROUND_CONTEXT))?.requestId).toBe("reopen");
    expect((await found?.wait(BACKGROUND_CONTEXT))?.status).toBe("done");
    expect(calls.count).toBe(1);
    await reopened.close();
  });

  it("re-runs an interrupted replay-safe tool and does not re-run a replay-unsafe one", async () => {
    const runs = { safe: 0, unsafe: 0 };

    for (const kind of ["safe", "unsafe"] as const) {
      const file = sqliteFile();
      const provider = `adapter-replay-${kind}`;
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
      const bundle = toolBundle(provider, `replay-${kind}`, [tool], [pauseAfterTool]);

      const office = await openOffice({
        storage: { sqlite: file },
        models: scriptedModels(provider, `${kind}_tool`),
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
        models: scriptedModels(provider, `${kind}_tool`),
      });
      reopened.install(bundle);
      const found = await reopened.submission(submitted.id);
      expect(found).toBeDefined();
      expect((await found?.wait(BACKGROUND_CONTEXT))?.status).toBe("done");
      await reopened.close();

      // A safe tool is retried after the crash; an unsafe one is not, and the model sees the
      // interrupted result instead.
      expect(runs[kind]).toBe(kind === "safe" ? 2 : 1);
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
    const provider = "adapter-isolation";
    const bundleA = toolBundle(provider, "isolation-a", [tool("a_only")]);
    const bundleB = toolBundle(provider, "isolation-b", [tool("b_only")]);
    const models = createModels();
    const faux = fauxProvider({ provider, models: [{ id: "adapter-test" }] });
    const scriptedFor =
      (name: string): FauxResponseFactory =>
      (context) =>
        context.messages.some((message) => message.role === "toolResult")
          ? fauxAssistantMessage("done")
          : fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: "toolUse" });
    faux.setResponses([scriptedFor("a_only"), scriptedFor("b_only"), scriptedFor("b_only")]);
    models.setProvider(faux.provider);

    const office = await openOffice({ storage: "memory", models });
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

    await office.close();
  }, 20_000);
});
