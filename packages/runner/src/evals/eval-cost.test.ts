/**
 * What an eval run spends and reserves: the trial's usage from its harness, the judge's
 * calls, the output cap on every request, and a reply cut off at the cap reported errored. No
 * network: the scripted provider plays the model, and a wrapper gives each response a known usage.
 */

import { fileURLToPath } from "node:url";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { formatUsage, runEvals, type Scenario } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { type ScriptedScript, scriptedProvider } from "../testing/scripted-model.js";
import { outputLimitError } from "./eval-cost.js";
import { type EvalModel, piDurableRunner } from "./runner.js";

const stockroom = fileURLToPath(new URL("../../../sdk/fixtures/sample-stockroom", import.meta.url));

/** The usage every metered response reports, as a provider with a price table would. */
const PER_REQUEST = {
  input: 100,
  cacheRead: 900,
  cacheWrite: 0,
  output: 50,
  reasoning: 30,
  totalTokens: 1050,
  cost: { input: 0.000015, output: 0.000025, cacheRead: 0.000027, cacheWrite: 0, total: 0.000067 },
};

/**
 * A scripted model whose every response reports `PER_REQUEST` (faux only estimates usage, at no
 * cost), whose `length` requests end with stop reason `length`, and which records the output cap
 * each request asked for.
 */
function metered(script: ScriptedScript, length: readonly number[] = []) {
  const scripted = scriptedProvider(script);
  const maxTokens: (number | undefined)[] = [];
  const models = new Proxy(scripted.models, {
    get(target, property) {
      if (property === "streamSimple") {
        return (...args: Parameters<Models["streamSimple"]>) => {
          maxTokens.push(args[2]?.maxTokens);
          const request = maxTokens.length;
          const stream = target.streamSimple(...args);
          const result = stream.result.bind(stream);
          stream.result = async (): Promise<AssistantMessage> => {
            const message = await result();
            const stopReason: StopReason = length.includes(request) ? "length" : message.stopReason;
            return { ...message, usage: structuredClone(PER_REQUEST), stopReason };
          };
          return stream;
        };
      }
      if (property === "completeSimple") {
        return (...args: Parameters<Models["completeSimple"]>) =>
          models.streamSimple(...args).result();
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const model: EvalModel = { models, model: scripted.model };
  return { ...model, maxTokens };
}

const levels = (reply: string): ScriptedScript => [
  { toolCalls: [{ name: "stock_levels", args: { sku: "BOLT-10" } }] },
  { text: reply },
];

const scenario = (fields: Partial<Scenario> = {}): Scenario => ({
  id: "reports-levels",
  description: "Reports the level",
  input: { kind: "message", text: "How many BOLT-10 do we have?" },
  stubs: {
    stock_levels: { text: '{"findings":[{"id":"stock:BOLT-10","quantity":120}]}' },
    stock_adjust: { text: '{"findings":[{"id":"adjustment:1"}]}' },
  },
  expect: { reply: { contains: ["120"] } },
  trials: 1,
  ...fields,
});

describe("eval cost", () => {
  it("sums each trial's requests and its judge's calls into the trial, scenario and report", async () => {
    const report = await runEvals(
      [
        {
          scenarios: [
            scenario({
              trials: 2,
              expect: {
                reply: {
                  contains: ["120"],
                  judged: [{ claim: "The reply promises a call back.", verdict: "absent" }],
                },
              },
            }),
          ],
        },
      ],
      piDurableRunner({
        dir: stockroom,
        model: () => metered(levels("120 units.")),
        // One judge for both trials, so it answers by function rather than from a list of one.
        judge: metered(() => ({ text: "ABSENT" })),
      }),
    );
    const [scenarioReport] = report.scenarios;
    const [trial] = scenarioReport?.trials ?? [];
    expect(trial?.outcome).toBe("passed");
    // Two requests in the trial: the tool call and the reply.
    expect(trial?.trace.usage).toEqual({
      input: 200,
      cacheRead: 1800,
      cacheWrite: 0,
      output: 100,
      reasoning: 60,
      cost: expect.closeTo(0.000134, 12),
    });
    expect(trial?.trace.judged?.[0]?.usage).toMatchObject({ input: 100, cacheRead: 900 });
    // The trial: its two requests and one judge call; the scenario and report: two such trials.
    expect(trial?.usage).toMatchObject({ input: 300, cacheRead: 2700, output: 150 });
    expect(scenarioReport?.usage).toMatchObject({ input: 600, cacheRead: 5400, output: 300 });
    expect(report.usage).toMatchObject({
      input: 600,
      cacheRead: 5400,
      output: 300,
      reasoning: 180,
    });
    expect(report.usage?.cost).toBeCloseTo(0.000402, 12);
    if (report.usage === undefined) throw new Error("the report carries no usage");
    expect(formatUsage(report.usage)).toBe(
      "Model usage: 6,000 input tokens (5,400 cached), 300 output tokens (180 reasoning); estimated cost $0.0004",
    );
  }, 30_000);

  it("caps every request of the trial and the judge at maxOutputTokens, and leaves it uncapped without", async () => {
    const trialModel = metered(levels("120 units."));
    const judgeModel = metered([{ text: "ABSENT" }]);
    const judged = scenario({
      expect: {
        reply: { judged: [{ claim: "The reply promises a call back.", verdict: "absent" }] },
      },
    });
    await runEvals(
      [{ scenarios: [judged] }],
      piDurableRunner({
        dir: stockroom,
        model: () => trialModel,
        judge: judgeModel,
        maxOutputTokens: 8192,
      }),
    );
    expect(trialModel.maxTokens).toEqual([8192, 8192]);
    expect(judgeModel.maxTokens).toEqual([8192]);

    const uncapped = metered(levels("120 units."));
    await runEvals(
      [{ scenarios: [scenario()] }],
      piDurableRunner({ dir: stockroom, model: () => uncapped }),
    );
    expect(uncapped.maxTokens).toEqual([undefined, undefined]);
  }, 30_000);

  it("reports a trial whose reply hit the output cap as errored with why, never graded", async () => {
    const report = await runEvals(
      [{ scenarios: [scenario()] }],
      piDurableRunner({
        dir: stockroom,
        // The reply (request 2) is cut off; it even contains the expected fact.
        model: () => metered(levels("120 units, and"), [2]),
        maxOutputTokens: 1024,
      }),
      { retries: 1 },
    );
    const [trial] = report.scenarios[0]?.trials ?? [];
    expect(trial?.outcome).toBe("errored");
    expect(trial?.failures).toEqual([]);
    expect(trial?.trace).toMatchObject({
      error: outputLimitError(1024),
      errorSource: "output-limit",
    });
    expect(trial?.erroredAttempts).toHaveLength(2);
    // Both attempts were paid for.
    expect(trial?.usage).toMatchObject({ input: 400, output: 200 });
    expect(report.outcome).toBe("incomplete");
  }, 30_000);
});
