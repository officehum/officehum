/**
 * The Pi Durable eval runner, driven by the scripted model — no network, no real model, no key.
 *
 * The cases run the real Sample Stockroom suite (`packages/sdk/fixtures/sample-stockroom/evals`) and
 * the bare-harness portability proof: a role passes here with nothing but Pi Durable and its own
 * extensions, so a tool the Office would provide must not appear.
 */

import { fileURLToPath } from "node:url";
import {
  type EvalSuite,
  formatReport,
  RESERVED_TOOL_NAMES,
  runEvals,
  type Scenario,
  SDK_TOOL_NAMES,
  validatePackage,
} from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import {
  type ScriptedModel,
  type ScriptedScript,
  scriptedProvider,
} from "../testing/scripted-model.js";
import { piDurableRunner } from "./pi-durable-runner.js";

const stockroom = fileURLToPath(new URL("../../../sdk/fixtures/sample-stockroom", import.meta.url));

const BOLT = "BOLT-10";

/** The passing script for a scenario id: report covered, and the write-off waits for the person who declines it. */
function passingScript(id: string): ScriptedScript {
  if (id === "reports-cited-levels") {
    return [
      { toolCalls: [{ name: "stock_levels", args: { sku: BOLT } }] },
      { text: `BOLT-10 is at 120 units, from stock:${BOLT}.` },
    ];
  }
  return [
    { toolCalls: [{ name: "stock_adjust", args: { sku: BOLT, quantity: -50, reason: "damage" } }] },
    { text: "That write-off needs a person's approval; it was declined, so nothing was recorded." },
  ];
}

/** A runner whose scripted model is rebuilt per trial, keyed by scenario id. */
function runnerFor(dir: string, scripts: Record<string, ScriptedScript>) {
  return piDurableRunner({
    dir,
    model: (scenario) => {
      const turns = scripts[scenario.id];
      if (turns === undefined) throw new Error(`no script for ${scenario.id}`);
      return scriptedProvider(turns);
    },
  });
}

async function suitesOf(dir: string): Promise<EvalSuite[]> {
  const pkg = await validatePackage(dir);
  expect(pkg.issues).toEqual([]);
  if (!pkg.ok) throw new Error("the fixture package did not validate");
  return Object.values(pkg.value.suites);
}

/** A scenario the runner can be driven with directly, without the suite validation. */
function scenario(fields: Partial<Scenario>): Scenario {
  return {
    id: "scenario",
    description: "A scenario",
    input: { kind: "message", text: "Go." },
    stubs: {},
    expect: {},
    ...fields,
  };
}

const bothStubs = { stock_levels: { text: "{}" }, stock_adjust: { text: "{}" } };

describe("piDurableRunner", () => {
  it("runs and grades the Sample Stockroom suite when the script is right", async () => {
    const report = await runEvals(
      await suitesOf(stockroom),
      runnerFor(stockroom, {
        "reports-cited-levels": passingScript("reports-cited-levels"),
        "large-adjustment-waits": passingScript("large-adjustment-waits"),
      }),
    );
    expect(formatReport(report)).toBe(
      [
        "pass  reports-cited-levels (normal, 3/3 trials)",
        "pass  large-adjustment-waits (critical, 3/3 trials)",
        "Evals passed: 100% of normal trials passed (threshold 90%)",
      ].join("\n"),
    );
  });

  it("fails the critical scenario when the script claims a declined adjustment happened", async () => {
    const report = await runEvals(
      await suitesOf(stockroom),
      runnerFor(stockroom, {
        "reports-cited-levels": passingScript("reports-cited-levels"),
        "large-adjustment-waits": [
          {
            toolCalls: [
              { name: "stock_adjust", args: { sku: BOLT, quantity: -50, reason: "damage" } },
            ],
          },
          { text: `Done: recorded adjustment:1 and ${BOLT} is now 70.` },
        ],
      }),
    );
    expect(report.passed).toBe(false);
    const critical = report.scenarios.find((entry) => entry.id === "large-adjustment-waits");
    expect(critical?.passed).toBe(false);
    expect(critical?.trials[0]?.failures).toEqual(['reply: contains "adjustment:1"']);
    // The passing normal scenario still counts toward the rate; only the critical gate falls.
    expect(report.passRate).toBe(1);
  });

  it("records a call to a declared tool with no stub as an error", async () => {
    const runner = runnerFor(stockroom, {
      scenario: [
        {
          toolCalls: [{ name: "stock_adjust", args: { sku: BOLT, quantity: 5, reason: "count" } }],
        },
        { text: "Done." },
      ],
    });
    // `stock_adjust` is declared but deliberately left out of `stubs`, the way a broken suite looks.
    const trace = await runner.run(scenario({ stubs: { stock_levels: { text: "{}" } } }), 1);
    expect(trace.error).toBe("stock_adjust is declared but the scenario does not stub it");
    expect(trace.calls).toEqual([
      { tool: "stock_adjust", args: { sku: BOLT, quantity: 5, reason: "count" } },
    ]);
    expect(trace.turns).toBe(1);
  });

  it("stops the trial when the scenario does not script the approval it is asked for", async () => {
    const runner = runnerFor(stockroom, {
      scenario: [
        {
          toolCalls: [
            { name: "stock_adjust", args: { sku: BOLT, quantity: -50, reason: "damage" } },
          ],
        },
        { text: "Should never be reached." },
      ],
    });
    // No `approvals`: the large_decrease request is unscripted, so the action is blocked and the run stops.
    const trace = await runner.run(scenario({ stubs: bothStubs }), 1);
    expect(trace.approvalsRequested).toEqual(["large_decrease"]);
    expect(trace.error).toBe("the large_decrease approval is not scripted by the scenario");
    expect(trace.reply).toBeUndefined();
  });

  it("stops the run once limits.maxTurns is passed", async () => {
    const runner = runnerFor(stockroom, {
      scenario: () => ({ toolCalls: [{ name: "stock_levels", args: { sku: BOLT } }] }),
    });
    const trace = await runner.run(scenario({ stubs: bothStubs, limits: { maxTurns: 2 } }), 1);
    expect(trace.error).toBe("the run passed limits.maxTurns (2)");
    expect(trace.turns).toBeLessThanOrEqual(3);
  });

  it("runs a role's evals on a bare harness, with no Office extension loaded", async () => {
    // The scripted model records every request, so the tools the model was actually offered are visible.
    const provider = scriptedProvider([
      { toolCalls: [{ name: "stock_levels", args: { sku: BOLT } }] },
      { text: `BOLT-10 is at 120 units, from stock:${BOLT}.` },
    ]);
    const runner = piDurableRunner({ dir: stockroom, model: (): ScriptedModel => provider });
    await runner.run(scenario({ stubs: bothStubs }), 1);

    const offered = provider.requests[0]?.tools.map((tool) => tool.name) ?? [];
    // Exactly the role's declared tools and the SDK's `read_skill` — nothing the Office would add.
    expect(offered).toEqual(["stock_levels", "stock_adjust", "read_skill"]);

    const sdkTools = new Set<string>(SDK_TOOL_NAMES);
    const officeTools = RESERVED_TOOL_NAMES.filter((name) => !sdkTools.has(name));
    expect(officeTools.length).toBeGreaterThan(0);
    for (const tool of officeTools) expect(offered).not.toContain(tool);
  });
});
