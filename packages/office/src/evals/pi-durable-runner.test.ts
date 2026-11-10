/**
 * The Pi Durable eval runner, driven by the scripted model — no network, no real model, no key.
 *
 * The cases run the real Sample Stockroom suite (`packages/sdk/fixtures/sample-stockroom/evals`) and
 * the bare-harness portability proof: a role passes here with nothing but Pi Durable and its own
 * extensions, so a tool the Office would provide must not appear.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { afterEach, describe, expect, it } from "vitest";
import { createWorkboard } from "../board/testing.js";
import { boardSenderResolver } from "../roles/sender.js";
import { recordingRole } from "../testing/recording-role.js";
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

  it("leaves a pending approval unanswered: the call is blocked as waiting and the trial goes on", async () => {
    const provider = scriptedProvider([
      {
        toolCalls: [{ name: "stock_adjust", args: { sku: BOLT, quantity: -50, reason: "damage" } }],
      },
      { text: "The write-off is waiting for a person's answer." },
    ]);
    const runner = piDurableRunner({ dir: stockroom, model: (): ScriptedModel => provider });
    const trace = await runner.run(
      scenario({ stubs: bothStubs, approvals: { large_decrease: "pending" } }),
      1,
    );
    expect(trace.error).toBeUndefined();
    expect(trace.approvalsRequested).toEqual(["large_decrease"]);
    expect(trace.executedCalls).toEqual([
      {
        tool: "stock_adjust",
        args: { sku: BOLT, quantity: -50, reason: "damage" },
        executed: false,
      },
    ]);
    expect(trace.reply).toBe("The write-off is waiting for a person's answer.");
    // What the model was told: waiting, never declined.
    const told = JSON.stringify(provider.requests[1]?.messages ?? []);
    expect(told).toContain("has not answered yet");
    expect(told).not.toContain("declined this action");
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

  describe("per-argument stubs", () => {
    const byArgs = {
      stock_levels: {
        byArgs: [
          { args: { sku: "BOLT-10" }, text: "BOLT-10 STUB TEXT" },
          { args: { sku: "NUT-20" }, text: "NUT-20 STUB TEXT" },
        ],
      },
      stock_adjust: { text: "{}" },
    };

    /** Runs one stock_levels call and returns the trace with everything the model saw afterwards. */
    async function callWith(sku: string, stubs: Scenario["stubs"]) {
      const provider = scriptedProvider([
        { toolCalls: [{ name: "stock_levels", args: { sku } }] },
        { text: "Done." },
      ]);
      const runner = piDurableRunner({ dir: stockroom, model: (): ScriptedModel => provider });
      const trace = await runner.run(scenario({ stubs }), 1);
      const seen = JSON.stringify(provider.requests.at(-1)?.messages ?? []);
      return { trace, seen };
    }

    it("returns the byArgs entry matching the call", async () => {
      const { trace, seen } = await callWith("NUT-20", byArgs);
      expect(trace.error).toBeUndefined();
      expect(seen).toContain("NUT-20 STUB TEXT");
      expect(seen).not.toContain("BOLT-10 STUB TEXT");
    });

    it("falls back to otherwise", async () => {
      const { trace, seen } = await callWith("WASHER-1", {
        ...byArgs,
        stock_levels: { ...byArgs.stock_levels, otherwise: { text: "NO SUCH SKU", isError: true } },
      });
      expect(trace.error).toBeUndefined();
      expect(seen).toContain("NO SUCH SKU");
    });

    it("answers a byArgs entry whose argument includes the given text", async () => {
      const { trace, seen } = await callWith("NUT-20-M8", {
        ...byArgs,
        stock_levels: {
          byArgs: [{ args: { sku: { includes: "-M8" } }, text: "M8 STUB TEXT" }],
        },
      });
      expect(trace.error).toBeUndefined();
      expect(seen).toContain("M8 STUB TEXT");
    });

    it("stops the trial when no entry matches and there is no otherwise", async () => {
      const { trace } = await callWith("WASHER-1", byArgs);
      expect(trace.error).toBe('stock_levels has no stub for these arguments: {"sku":"WASHER-1"}');
    });
  });
});

describe("the sender a trial's role is handed", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const levelsThenAnswer = () =>
    scriptedProvider([
      { toolCalls: [{ name: "stock_levels", args: { sku: BOLT } }] },
      { text: `BOLT-10 is at 120 units, from stock:${BOLT}.` },
    ]);
  const fromDana = scenario({
    input: { kind: "message", text: "How many BOLT-10?", channel: "sms", from: "+1 503 555 0143" },
    stubs: bothStubs,
  });

  it("bare mode resolves the scenario's from", async () => {
    const recording = await recordingRole(stockroom);
    temps.push(recording.dir);
    await piDurableRunner({ dir: recording.dir, model: levelsThenAnswer }).run(fromDana, 1);

    const sender = recording.options()?.sender as
      | ((call: { conversationId: unknown; taskId: unknown }) => Promise<unknown>)
      | undefined;
    expect(await sender?.({ conversationId: 1, taskId: 1 })).toEqual({
      origin: "external",
      channel: "sms",
      contact: "+1 503 555 0143",
    });

    // A scenario that says its sender wrote from inside the office is an internal sender.
    await piDurableRunner({ dir: recording.dir, model: levelsThenAnswer }).run(
      scenario({ input: { ...fromDana.input, origin: "internal" } as never, stubs: bothStubs }),
      1,
    );
    const inside = recording.options()?.sender as typeof sender;
    expect(await inside?.({ conversationId: 1, taskId: 1 })).toEqual({
      origin: "internal",
      channel: "sms",
      contact: "+1 503 555 0143",
    });

    // A scenario that names nobody leaves the sender unknown, as a role with no resolver would.
    await piDurableRunner({ dir: recording.dir, model: levelsThenAnswer }).run(
      scenario({ stubs: bothStubs }),
      1,
    );
    const unnamed = recording.options()?.sender as typeof sender;
    expect(await unnamed?.({ conversationId: 1, taskId: 1 })).toBeUndefined();
  });

  /**
   * Runs `fromDana` in office mode on a board file the test keeps, then reopens the board and reads
   * the ticket's provenance and what the office's resolver answers for the trial's conversation.
   */
  async function officeTrial(
    delivery: "internal-message" | "inbound-email",
    trialScenario: Scenario = fromDana,
  ) {
    const recording = await recordingRole(stockroom);
    temps.push(recording.dir);
    const boardDir = mkdtempSync(join(tmpdir(), "officehum-sender-board-"));
    temps.push(boardDir);
    const boardFile = join(boardDir, "office.sqlite");
    await piDurableRunner({
      dir: recording.dir,
      mode: "office",
      office: { boardFile, delivery },
      model: levelsThenAnswer,
    }).run(trialScenario, 1);
    expect(typeof recording.options()?.sender).toBe("function");

    // The board lists no bindings, so the trial's conversation id is read from the file.
    const database = new DatabaseSync(boardFile);
    const bound = database.prepare("SELECT conversation_id FROM ticket_conversations").all() as {
      conversation_id: number;
    }[];
    database.close();
    expect(bound).toHaveLength(1);
    const conversationId = bound[0]?.conversation_id;

    const board = createWorkboard(boardFile);
    try {
      const [ticket] = board.list({});
      return {
        provenance: ticket === undefined ? undefined : board.provenance(ticket.id),
        resolved: await boardSenderResolver(board)({ conversationId, taskId: 1 }),
      };
    } finally {
      board.close();
    }
  }

  it("office mode puts from on the ticket's provenance", async () => {
    const internal = await officeTrial("internal-message");
    expect(internal.provenance).toEqual({
      origin: "internal",
      sourceChannel: "sms",
      sourceContact: "+1 503 555 0143",
    });
    expect(internal.resolved).toEqual({
      origin: "internal",
      channel: "sms",
      contact: "+1 503 555 0143",
    });

    // An inbound email stays an email whatever the scenario's channel; `from` is still the contact.
    const inbound = await officeTrial("inbound-email");
    expect(inbound.provenance).toEqual({
      origin: "external",
      sourceChannel: "email",
      sourceContact: "+1 503 555 0143",
    });
    expect(inbound.resolved).toEqual({
      origin: "external",
      channel: "email",
      contact: "+1 503 555 0143",
    });
  });

  it("office mode takes the ticket's origin from the scenario's origin", async () => {
    const outside = await officeTrial(
      "internal-message",
      scenario({ input: { ...fromDana.input, origin: "external" } as never, stubs: bothStubs }),
    );
    expect(outside.provenance).toEqual({
      origin: "external",
      sourceChannel: "sms",
      sourceContact: "+1 503 555 0143",
    });
    expect(outside.resolved).toEqual({
      origin: "external",
      channel: "sms",
      contact: "+1 503 555 0143",
    });
  });
});
