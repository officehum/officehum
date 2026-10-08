import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import stockroomManifest from "../fixtures/sample-stockroom/officehum.json" with { type: "json" };
import sampleStockroom, { packageDir } from "../fixtures/sample-stockroom/src/index.js";
import { checkAgent } from "./agent.js";
import {
  checkRuntimes,
  commandEngine,
  EngineError,
  engineArgs,
  engineFromManifest,
  formatEngineResult,
  runOperatorCommand,
  stubEngine,
} from "./engine.js";
import { formatIssue } from "./issues.js";
import { type AgentManifest, validateManifest } from "./manifest.js";
import { validatePackage } from "./package.js";
import { removeTempDirs, tempDir } from "./test-helpers.js";

afterEach(removeTempDirs);

const manifest = stockroomManifest as AgentManifest;
const realEngine = (workDir = tempDir("work", {})) =>
  engineFromManifest(packageDir, manifest, { workDir, dataDir: tempDir("data", {}) });

const tool = (tools: readonly ToolRegistration[] | undefined, name: string) => {
  const found = tools?.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
};
const api = (callId = "call-1") => ({ conversationId: "conversation-1", callId }) as never;
const text = (result: { content?: readonly { type: string; text?: string }[] }) =>
  result.content?.[0]?.text ?? "";

describe("the engine contract, run against a real Python engine", () => {
  it("runs a subcommand and returns findings with ids", async () => {
    const result = await realEngine().run(["levels", "--sku", "BOLT-10"]);
    expect(result).toEqual({
      ok: true,
      data: { "BOLT-10": 120 },
      findings: [{ id: "stock:BOLT-10", description: "BOLT-10 on hand", quantity: 120 }],
      caveats: [],
    });
  });

  it("writes only to the host's work directory, and applies a repeated write once", async () => {
    const workDir = tempDir("work", {});
    const engine = realEngine(workDir);
    const adjust = ["adjust", "--sku", "NUT-10", "--quantity", "-5", "--reason", "damage"];
    await engine.run(adjust, { idempotencyKey: "conversation-1:call-7" });
    const again = await engine.run(adjust, { idempotencyKey: "conversation-1:call-7" });
    expect(again.caveats).toEqual(["This adjustment was already recorded."]);
    expect(JSON.parse(readFileSync(join(workDir, "adjustments.json"), "utf8"))).toHaveLength(1);
    expect((await engine.run(["levels", "--sku", "NUT-10"])).data).toEqual({ "NUT-10": 75 });
  });

  it("passes on the engine's own failure as a result, and a crash as an error", async () => {
    const engine = realEngine();
    expect(await engine.run(["levels", "--sku", "GEAR-99"])).toEqual({
      ok: false,
      findings: [],
      caveats: [],
      error: "unknown SKU: GEAR-99",
    });
    await expect(engine.run(["crash"])).rejects.toThrow(
      /gave no JSON result:[\s\S]*RuntimeError: the engine crashed/,
    );
  });

  it("keeps the host's secrets out of the engine's environment", async () => {
    process.env.OFFICEHUM_TEST_SECRET = "sk-should-not-leak";
    try {
      const names = (await realEngine().run(["env-names"])).data as string[];
      expect(names).not.toContain("OFFICEHUM_TEST_SECRET");
      expect(names).toEqual(
        expect.arrayContaining(["OFFICEHUM_DATA_DIR", "OFFICEHUM_WORK_DIR", "PATH"]),
      );
    } finally {
      delete process.env.OFFICEHUM_TEST_SECRET;
    }
  });

  it("explains a command that cannot run", async () => {
    const missing = commandEngine({ command: ["no-such-program-officehum"], cwd: packageDir });
    await expect(missing.run(["levels"])).rejects.toBeInstanceOf(EngineError);
  });
});

describe("checkRuntimes", () => {
  it("finds python3 in the range the role declares", async () => {
    expect(await checkRuntimes(manifest)).toEqual([]);
  });

  it("explains a missing program or a version out of range", async () => {
    const needs = (runtimes: NonNullable<AgentManifest["runtimes"]>) =>
      checkRuntimes({ ...manifest, runtimes });
    expect((await needs([{ name: "python3", version: ">=99" }])).map(formatIssue)[0]).toMatch(
      /^officehum\.json › runtimes\[0\]: python3 3\.\d+\.\d+ is installed; sample-stockroom needs python3 >=99$/,
    );
    expect(
      (await needs([{ name: "no-such-program-officehum", version: ">=1" }])).map(formatIssue),
    ).toEqual([
      "officehum.json › runtimes[0]: no-such-program-officehum is not installed or not on PATH; sample-stockroom needs no-such-program-officehum >=1",
    ]);
  });
});

describe("engine tools built from the manifest", () => {
  it("builds each engine tool with its replay policy, parameters and guidelines", () => {
    const role = sampleStockroom({ engine: stubEngine({}) });
    expect(checkAgent(role, manifest).issues).toEqual([]);
    const tools = role.extensions[0]?.tools;
    expect(tools?.map((candidate) => [candidate.name, candidate.replay])).toEqual([
      ["stock_levels", "safe"],
      ["stock_adjust", "unsafe"],
      ["read_skill", "safe"],
    ]);
    expect(tool(tools, "stock_levels").description).toContain(
      "- Cite the finding id for every quantity you state.",
    );
    const parameters = tool(tools, "stock_adjust").parameters as {
      required?: string[];
      properties: object;
    };
    expect(parameters.required).toEqual(["sku", "quantity", "reason"]);
  });

  it("turns a call into engine arguments and returns the findings", async () => {
    const engine = stubEngine({
      adjust: { findings: [{ id: "adjustment:1" }], data: { recorded: true } },
    });
    const adjust = tool(sampleStockroom({ engine }).extensions[0]?.tools, "stock_adjust");
    const result = await adjust.execute(
      { sku: "NUT-10", quantity: -5, reason: "damage" } as never,
      api("call-9"),
      {} as never,
    );
    expect(engine.calls).toEqual([
      {
        args: ["adjust", "--sku", "NUT-10", "--quantity", "-5", "--reason", "damage"],
        idempotencyKey: "conversation-1:call-9",
      },
    ]);
    expect(JSON.parse(text(result)).findings).toEqual([{ id: "adjustment:1" }]);
    expect(result.details).toEqual({ findings: ["adjustment:1"] });
  });

  it("runs the same tool against the real engine", async () => {
    const levels = tool(
      sampleStockroom({ engine: realEngine() }).extensions[0]?.tools,
      "stock_levels",
    );
    const result = await levels.execute({ sku: "WASHER-10" } as never, api(), {} as never);
    expect(JSON.parse(text(result))).toEqual({
      findings: [{ id: "stock:WASHER-10", description: "WASHER-10 on hand", quantity: 15 }],
      data: { "WASHER-10": 15 },
      caveats: ["WASHER-10 is below 20 units"],
    });
  });

  it("refuses to build an engine-backed role without an engine", () => {
    expect(() => sampleStockroom({ engine: undefined as never })).toThrow(
      /sample-stockroom declares engine tools; pass an engine/,
    );
  });

  it("maps parameters to flags in declaration order", () => {
    const parameters = {
      work_order: { type: "string", description: "Work order" },
      summary: { type: "boolean", description: "Summary only" },
      limit: { type: "integer", description: "Rows" },
    } as const;
    expect(
      engineArgs(["close-status"], parameters, { limit: 5, summary: true, work_order: "WO-1" }),
    ).toEqual(["close-status", "--work-order", "WO-1", "--summary", "--limit", "5"]);
    expect(engineArgs(["levels"], parameters, { summary: false })).toEqual(["levels"]);
  });

  it("keeps findings when a result is too long for the model", () => {
    const formatted = formatEngineResult(
      { ok: true, findings: [{ id: "stock:BOLT-10" }], data: "x".repeat(20_000), caveats: [] },
      500,
    );
    expect(JSON.parse(formatted)).toEqual({ findings: [{ id: "stock:BOLT-10" }], truncated: true });
  });
});

describe("operator commands", () => {
  it("runs an engine view without the model", async () => {
    const result = await runOperatorCommand(manifest, realEngine(), "stock-board");
    expect(result.findings.map((finding) => finding.id)).toEqual([
      "stock:BOLT-10",
      "stock:NUT-10",
      "stock:WASHER-10",
    ]);
    await expect(runOperatorCommand(manifest, realEngine(), "payroll")).rejects.toThrow(
      'sample-stockroom has no command "payroll"',
    );
  });
});

describe("engine rules in officehum.json", () => {
  const messages = (fields: Record<string, unknown>) => {
    const result = validateManifest({ ...structuredClone(stockroomManifest), ...fields });
    return result.ok ? [] : result.issues.map(formatIssue);
  };

  it("accepts the sample role, and its package passes validation", async () => {
    expect(messages({})).toEqual([]);
    const pkg = await validatePackage(
      fileURLToPath(new URL("../fixtures/sample-stockroom", import.meta.url)),
    );
    expect(pkg.issues).toEqual([]);
  });

  it("requires the engine's program to be a declared runtime", () => {
    expect(messages({ runtimes: [] })).toEqual([
      'officehum.json › engine.command[0]: "python3" must be declared in runtimes, e.g. { "name": "python3", "version": ">=3.10" }, so hosts know to provide it',
    ]);
    expect(messages({ runtimes: [{ name: "python3", version: "three" }] })).toEqual([
      'officehum.json › runtimes[0].version: must be a version range like ">=3.10" (got "three")',
    ]);
  });

  it("requires an engine and a description for engine tools and commands", () => {
    const { engine: _engine, ...withoutEngine } = structuredClone(stockroomManifest);
    const result = validateManifest({
      ...withoutEngine,
      tools: [{ name: "stock_levels", replay: "safe", engine: ["levels"] }],
      approvals: [],
    });
    expect(result.ok ? [] : result.issues.map(formatIssue)).toEqual([
      "officehum.json › tools[0].engine: needs the manifest's engine to be declared",
      "officehum.json › tools[0].description: is required for an engine tool: it is all the model reads about it",
      "officehum.json › commands[0]: needs the manifest's engine to be declared",
    ]);
  });

  it("checks approval conditions against the tool's parameters", () => {
    const approvals = [
      {
        id: "big",
        tool: "stock_adjust",
        description: "Big",
        when: [{ arg: "amount", op: "gt", value: "ten" }],
      },
    ];
    expect(messages({ approvals })).toEqual([
      'officehum.json › approvals[0].when[0].arg: "amount" is not a parameter of "stock_adjust"',
      'officehum.json › approvals[0].when[0].value: must be a number when op is "gt"',
    ]);
  });
});
