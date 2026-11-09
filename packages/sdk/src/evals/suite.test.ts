import { describe, expect, it } from "vitest";
import type { AgentManifest } from "../manifest.js";
import { validateSuite } from "./suite.js";

const manifest = {
  tools: [
    { name: "get_invoice", replay: "safe" },
    {
      name: "run_report",
      replay: "safe",
      engine: ["report"],
      description: "Runs a report.",
      parameters: { period: { type: "string", description: "The period." } },
    },
  ],
  approvals: [],
  accepts: [],
} as unknown as AgentManifest;

const suiteWith = (stubs: Record<string, unknown>) => ({
  scenarios: [
    {
      id: "a-scenario",
      description: "A scenario",
      input: { kind: "message", text: "Go." },
      stubs,
      expect: {},
    },
  ],
});

const plain = { run_report: { text: "{}" } };

describe("validateSuite stubs", () => {
  it("still accepts a text stub", () => {
    const result = validateSuite(
      suiteWith({ get_invoice: { text: "{}", isError: false }, ...plain }),
      manifest,
      "x",
    );
    expect(result.issues).toEqual([]);
  });

  it("accepts a byArgs stub", () => {
    const result = validateSuite(
      suiteWith({
        get_invoice: {
          byArgs: [{ args: { id: "1043" }, text: "{}" }],
          otherwise: { text: "none", isError: true },
        },
        ...plain,
      }),
      manifest,
      "x",
    );
    expect(result.issues).toEqual([]);
  });

  it("rejects an empty byArgs", () => {
    const result = validateSuite(
      suiteWith({ get_invoice: { byArgs: [] }, ...plain }),
      manifest,
      "x",
    );
    expect(result.ok).toBe(false);
  });

  it("reports an argument the tool does not take, when the manifest names its parameters", () => {
    const result = validateSuite(
      suiteWith({
        get_invoice: { text: "{}" },
        run_report: { byArgs: [{ args: { perod: "2026-10" }, text: "{}" }] },
      }),
      manifest,
      "x",
    );
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "scenarios[0].stubs.run_report.byArgs[0].args.perod",
    ]);
  });

  it("skips the argument-name check for a tool whose manifest names no parameters", () => {
    const result = validateSuite(
      suiteWith({ get_invoice: { byArgs: [{ args: { anything: "x" }, text: "{}" }] }, ...plain }),
      manifest,
      "x",
    );
    expect(result.issues).toEqual([]);
  });
});
