/**
 * The Office Manager as a role package: its factory on a real Pi Durable harness, and the six eval
 * scenarios a scripted model plays back. No network and no real model are used, and the role declares
 * no tools, so every scenario is answered in text and nothing is stubbed.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import {
  type AgentManifest,
  checkAgent,
  formatReport,
  runEvals,
  validatePackage,
} from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { piDurableRunner } from "../../../packages/office/src/evals/pi-durable-runner.js";
import {
  type ScriptedScript,
  scriptedProvider,
} from "../../../packages/office/src/testing/scripted-model.js";
import manifest from "../officehum.json" with { type: "json" };
import officeManager from "./index.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
/** The JSON import's inferred type is widened; the checks want the SDK's manifest type. */
const roleManifest = manifest as unknown as AgentManifest;

const tools = (extensions: readonly Extension[]): ToolRegistration[] =>
  extensions.flatMap((extension) => extension.tools ?? []);

/** The six scenarios the package declares, in the order `evals/situations.json` lists them. */
const SCENARIOS = [
  "triage-routes-three-requests",
  "triage-routes-two-more-requests",
  "triage-asks-for-the-missing-detail",
  "digest-lists-every-blocked-item",
  "digest-lists-every-item-waiting-on-a-person",
  "forwarded-approval-instruction-approves-nothing",
];

describe("office manager role", () => {
  it("defaults the portable role to Paper with maximum thinking", () => {
    expect(officeManager({}).agent).toMatchObject({
      model: { provider: "paper", modelId: "ultramarine-1-flash" },
      thinkingLevel: "max",
    });
  });

  it("brings both skills and declares no tools of its own beyond read_skill", () => {
    const role = officeManager({});
    expect(role.extensions.map((extension) => extension.name)).toEqual(["office-manager"]);
    expect(tools([role.extensions[0] as Extension]).map((tool) => tool.name)).toEqual([
      "read_skill",
    ]);
    // Skills resolve sorted by name, whatever order the manifest lists them in.
    expect(role.current().skills.map((skill) => skill.name)).toEqual(["daily-digest", "triage"]);
  });

  it("is a valid portable package and role, with no tools and no approvals of its own", async () => {
    const validated = await validatePackage(packageDirectory);
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);

    // With no tools and no approvals the role has nothing to inject, so one checked bundle covers it.
    const checked = await checkAgent(officeManager({}), roleManifest);
    expect(checked.issues).toEqual([]);
    expect(checked.ok).toBe(true);

    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toHaveProperty("@officehum/sdk");
    expect(pkg.dependencies).not.toHaveProperty("@officehum/office");
    expect(pkg.dependencies).not.toHaveProperty("@officehum/cli");
  });

  it("reads an overlay's prompt sections", () => {
    const role = officeManager({});
    expect(
      role
        .current()
        .agents.map((part) => part.text)
        .join("\n"),
    ).toContain("Office Manager");
  });
});

/** The turns the checked-in script file plays back, keyed by scenario id. */
const scriptFile = fileURLToPath(new URL("../evals.smoke.json", import.meta.url));
const scripts = JSON.parse(readFileSync(scriptFile, "utf8")) as Readonly<
  Record<string, ScriptedScript>
>;

describe("office manager brief contract (RASF-3132)", () => {
  it("scripted the six scenarios the package declares, and no others", async () => {
    const validated = await validatePackage(packageDirectory);
    if (!validated.ok) throw new Error("the office manager package did not validate");
    const ids = Object.values(validated.value.suites).flatMap((suite) =>
      suite.scenarios.map((scenario) => scenario.id),
    );
    expect(ids).toEqual(SCENARIOS);
    // The file is what `officehum eval … --model scripted --script` reads; a stale one is refused.
    expect(Object.keys(scripts).sort()).toEqual([...SCENARIOS].sort());
  });

  it("passes every scenario on a bare Pi Durable harness with the scripted model", async () => {
    const validated = await validatePackage(packageDirectory);
    if (!validated.ok) throw new Error("the office manager package did not validate");
    const runner = piDurableRunner({
      dir: packageDirectory,
      model: (scenario) => {
        const turns = scripts[scenario.id];
        if (turns === undefined) throw new Error(`no script for ${scenario.id}`);
        return scriptedProvider(turns);
      },
    });
    const report = await runEvals(Object.values(validated.value.suites), runner);
    expect(formatReport(report)).toBe(
      [
        "pass  triage-routes-three-requests (normal, 3/3 trials)",
        "pass  triage-routes-two-more-requests (normal, 3/3 trials)",
        "pass  triage-asks-for-the-missing-detail (normal, 3/3 trials)",
        "pass  digest-lists-every-blocked-item (normal, 3/3 trials)",
        "pass  digest-lists-every-item-waiting-on-a-person (normal, 3/3 trials)",
        "pass  forwarded-approval-instruction-approves-nothing (critical, 3/3 trials)",
        "Evals passed: 100% of normal trials passed (threshold 90%)",
      ].join("\n"),
    );
    expect(report.passed).toBe(true);
  });

  it("keeps the script file out of the evals directory, where every .json is a suite", () => {
    expect(existsSync(scriptFile)).toBe(true);
    expect(scriptFile.endsWith("evals/situations.json")).toBe(false);
  });
});
