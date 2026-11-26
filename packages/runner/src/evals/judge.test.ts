/**
 * The model judge: one closed question through the trial's own model collection. No
 * network: the scripted and flaky providers stand in for the model.
 */

import { fileURLToPath } from "node:url";
import type { Models } from "@earendil-works/pi-ai/models";
import { judgePrompt, runEvals, type Scenario } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { flakyProvider, scriptedProvider } from "../testing/scripted-model.js";
import { modelJudge } from "./judge.js";
import { piDurableRunner } from "./runner.js";

const CLAIM = "The reply promises that someone will contact the sender.";

/** A pi-ai usage record, scaled. */
function usage(scale: number) {
  return {
    input: 10 * scale,
    cacheRead: 30 * scale,
    cacheWrite: 0,
    output: 2 * scale,
    reasoning: 1 * scale,
    totalTokens: 42 * scale,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 * scale },
  };
}

describe("modelJudge", () => {
  it("sends the prompt as the only message and returns the model's text", async () => {
    const scripted = scriptedProvider([{ text: "ABSENT" }]);
    const judge = modelJudge(scripted);
    expect(judge.model).toBe("scripted/scripted-1");
    const prompt = judgePrompt("I cannot say she will be in touch.", CLAIM);
    expect((await judge.ask(prompt)).text).toBe("ABSENT");
    expect(scripted.requests).toHaveLength(1);
    expect(scripted.requests[0]?.tools).toEqual([]);
    expect(scripted.requests[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", content: prompt }),
    ]);
  });

  it("throws the provider's error, so the trial is errored rather than graded", async () => {
    const flaky = flakyProvider([], () => "The model stream was interrupted.");
    await expect(modelJudge(flaky).ask("x")).rejects.toThrow(
      "flaky/scripted-1 answered with error: The model stream was interrupted.",
    );
  });

  it("refuses a model its collection does not have", async () => {
    const scripted = scriptedProvider([]);
    const judge = modelJudge({ ...scripted, model: { provider: "paper", modelId: "nope" } });
    await expect(judge.ask("x")).rejects.toThrow("paper/nope is not in the judge's models");
  });

  it("asks at temperature 0, except a reasoning model, which fixes its own sampling", async () => {
    const options: unknown[] = [];
    const fake = (reasoning: boolean) =>
      ({
        getModel: () => ({ id: "m", provider: "p", reasoning }),
        completeSimple: async (_model: unknown, _context: unknown, given: unknown) => {
          options.push(given);
          return {
            stopReason: "stop",
            content: [{ type: "text", text: "PRESENT" }],
            usage: usage(1),
          };
        },
      }) as unknown as Models;
    const model = { provider: "p", modelId: "m" };
    await modelJudge({ models: fake(false), model }).ask("x");
    await modelJudge({ models: fake(true), model }).ask("x");
    expect(options).toEqual([{ temperature: 0 }, {}]);
  });

  it("returns what the call spent, and throws on an answer cut off at the output limit", async () => {
    const answers = [
      { stopReason: "stop", content: [{ type: "text", text: "ABSENT" }], usage: usage(2) },
      { stopReason: "length", content: [{ type: "text", text: "PRESENT" }], usage: usage(1) },
    ];
    const models = {
      getModel: () => ({ id: "m", provider: "p", reasoning: true }),
      completeSimple: async () => answers.shift(),
    } as unknown as Models;
    const judge = modelJudge({ models, model: { provider: "p", modelId: "m" } });
    expect(await judge.ask("x")).toEqual({
      text: "ABSENT",
      usage: { input: 20, cacheRead: 60, cacheWrite: 0, output: 4, reasoning: 2, cost: 0.002 },
    });
    await expect(judge.ask("x")).rejects.toThrow('stop reason "length"');
  });
});

describe("piDurableRunner with a judge", () => {
  const stockroom = fileURLToPath(
    new URL("../../../sdk/fixtures/sample-stockroom", import.meta.url),
  );
  const scenario: Scenario = {
    id: "reports-levels",
    description: "Reports the level and promises nothing",
    input: { kind: "message", text: "How many BOLT-10 do we have?" },
    stubs: {
      stock_levels: { text: '{"findings":[{"id":"stock:BOLT-10","quantity":120}]}' },
      stock_adjust: { text: '{"findings":[{"id":"adjustment:1"}]}' },
    },
    expect: { reply: { judged: [{ claim: CLAIM, verdict: "absent" }] } },
    trials: 1,
  };
  const turns = (reply: string) => () =>
    scriptedProvider([
      { toolCalls: [{ name: "stock_levels", args: { sku: "BOLT-10" } }] },
      { text: reply },
    ]);

  it("grades a judged assertion with the judge it is given, and records the judge's answer", async () => {
    const judgeModel = scriptedProvider([{ text: "PRESENT" }]);
    const runner = piDurableRunner({
      dir: stockroom,
      model: turns("120 units. Our stock team will call you."),
      judge: judgeModel,
    });
    const report = await runEvals([{ scenarios: [scenario] }], runner);
    const [trial] = report.scenarios[0]?.trials ?? [];
    expect(trial?.outcome).toBe("failed");
    expect(trial?.trace.judged?.[0]).toMatchObject({
      outcome: "failed",
      model: "scripted/scripted-1",
      raw: "PRESENT",
      prompt: judgePrompt("120 units. Our stock team will call you.", CLAIM),
    });
  }, 30_000);

  it("has no judge unless one is given, so a scripted run reports judged assertions skipped", async () => {
    const runner = piDurableRunner({ dir: stockroom, model: turns("120 units.") });
    expect(runner.judge).toBeUndefined();
    const report = await runEvals([{ scenarios: [scenario] }], runner);
    expect(report.outcome).toBe("passed");
    expect(report.skippedAssertions).toBe(1);
  }, 30_000);
});
