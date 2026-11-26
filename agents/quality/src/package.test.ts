/**
 * The Quality package as the office reads it: a strict package under `agents/`, a manifest that
 * states one approval decision per write, a pass score that is the role's own limit rather than a
 * company figure, and a checklist and people that come from the company package. The company facts
 * are generated from `company/default/`, so a checklist item or a person that drifts between the
 * company and this role is caught here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentManifest, validateManifest, validatePackage } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { companyFactLeaks } from "../../../scripts/company-fact-guard.js";
import manifest from "../officehum.json" with { type: "json" };
import {
  creditDecider,
  disciplineDecider,
  loadCompanyFacts,
  qualityOwner,
  safetyOfficer,
} from "./company.js";
import { demoInspections, demoNonconformances } from "./desk.js";
import { qualityTools } from "./tools.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const roleManifest = manifest as unknown as AgentManifest;
const company = loadCompanyFacts();

const TOOLS = [
  "list_inspections",
  "record_inspection",
  "open_nonconformance",
  "list_nonconformances",
  "record_containment",
  "record_root_cause",
  "propose_corrective_action",
  "record_verification",
  "request_closure",
  "quality_report",
  "read_company",
];

describe("quality package", () => {
  it("validates strictly as a package under agents/, with all eleven tools stubbed in every scenario", async () => {
    const validated = await validatePackage(packageDirectory);
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.piDurableRange).toBe("1.6.x");
    expect(Object.keys(validated.value.suites)).toEqual(["evals/situations.json"]);
    const scenarios = Object.values(validated.value.suites).flatMap((suite) => suite.scenarios);
    expect(scenarios.length).toBeGreaterThanOrEqual(12);
    for (const scenario of scenarios) {
      expect(Object.keys(scenario.stubs).sort()).toEqual([...TOOLS].sort());
    }
  });

  it("declares eleven tools, one approval on every call, and a reason for each write without one", () => {
    expect(roleManifest.tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(
      roleManifest.tools.filter((tool) => tool.replay === "unsafe").map((tool) => tool.name),
    ).toEqual([
      "record_inspection",
      "open_nonconformance",
      "record_containment",
      "record_root_cause",
      "propose_corrective_action",
      "record_verification",
      "request_closure",
    ]);
    expect(validateManifest(roleManifest).ok).toBe(true);

    // Closing a report asks a person on every call: no condition can let one through.
    expect(roleManifest.approvals.map((approval) => [approval.tool, approval.id])).toEqual([
      ["request_closure", "close_nonconformance"],
    ]);
    for (const approval of roleManifest.approvals) expect(approval.when).toBeUndefined();

    const note = (name: string) =>
      roleManifest.tools.find((tool) => tool.name === name)?.noApproval;
    expect(note("record_inspection")).toContain("the desk scores it from the checklist weights");
    expect(note("propose_corrective_action")).toContain("until a root cause is recorded");
    expect(note("open_nonconformance")).toContain("safety officer");
    expect(note("request_closure")).toBeUndefined();
  });

  it("refuses the closure tool with no approval decision, in memory", () => {
    const stripped: AgentManifest = { ...roleManifest, approvals: [] };
    const refused = validateManifest(stripped);
    expect(refused.ok).toBe(false);
    expect(
      refused.issues.some(
        (issue) =>
          issue.message.includes("request_closure") &&
          issue.message.includes("no approval decision"),
      ),
    ).toBe(true);
  });

  it("takes the checklist and people from the company, and the pass score from its own manifest", () => {
    expect(Object.keys(roleManifest.limits ?? {})).toEqual(["inspection_pass_score"]);
    expect(roleManifest.limits?.inspection_pass_score?.default).toBe(85);
    // The pass score is a setting the business chooses, so the company record does not hold it.
    expect(company.quality).not.toHaveProperty("passScore");
    expect(qualityOwner(company)).toBeDefined();
    expect(safetyOfficer(company)).toBeDefined();
    expect(creditDecider(company)).toBeDefined();
    expect(disciplineDecider(company)).toBeDefined();

    const items = new Set(company.quality.checklist.map((item) => item.id));
    for (const inspection of demoInspections(company.quality.checklist)) {
      for (const entry of inspection.results)
        expect(items.has(entry.itemId), entry.itemId).toBe(true);
    }
    for (const report of demoNonconformances(company.quality.checklist)) {
      if (report.item !== null) expect(items.has(report.item.id), report.item.id).toBe(true);
    }

    // The scripted runs name only checklist items the company has.
    const script = JSON.parse(
      readFileSync(fileURLToPath(new URL("../evals.smoke.json", import.meta.url)), "utf8"),
    ) as Record<
      string,
      { toolCalls?: { args?: { results?: { itemId: string }[]; itemId?: string } }[] }[]
    >;
    for (const turns of Object.values(script)) {
      for (const turn of turns) {
        for (const call of turn.toolCalls ?? []) {
          for (const entry of call.args?.results ?? []) {
            expect(items.has(entry.itemId), entry.itemId).toBe(true);
          }
          if (call.args?.itemId !== undefined) expect(items.has(call.args.itemId)).toBe(true);
        }
      }
    }
  });

  it("declares the generated handbook beside its own skills", () => {
    expect(roleManifest.skills.map((skill) => skill.id)).toEqual([
      "inspecting-sites",
      "handling-nonconformances",
      "closing-reports",
      "company-handbook",
    ]);
  });

  it("hands credits, staff matters, concessions and contracts to a person, and accepts quality work", () => {
    expect(roleManifest.department).toBe("operations");
    expect(roleManifest.channels).toEqual(["email", "chat"]);
    const mayNot = (roleManifest.mayNot ?? []).map((rule) => rule.action).join("\n");
    expect(mayNot).toContain("credit");
    expect(mayNot).toContain("Discipline");
    expect(mayNot).toContain("contract's scope");
    expect(mayNot).toContain("Accept non-conforming work as it is");
    expect(mayNot).toContain("safety hazard");
    expect(roleManifest.accepts.map((accept) => accept.type)).toEqual([
      "quality.inspection",
      "quality.complaint",
    ]);
    for (const accept of roleManifest.accepts) expect(accept.done?.length ?? 0).toBeGreaterThan(0);
    const accepted = new Set(roleManifest.accepts.map((accept) => accept.type));
    for (const dispatch of roleManifest.dispatches ?? []) {
      expect(accepted.has(dispatch.type)).toBe(false);
    }
  });

  it("names no company fact outside the generated handbook, so another company can run it", () => {
    expect(companyFactLeaks(packageDirectory)).toEqual([]);
  });

  it("role files name no company person's title, so a retitled company still reads true", () => {
    const files: string[] = ["AGENTS.md", "APPEND_SYSTEM.md", "officehum.json"].map((name) =>
      join(packageDirectory, name),
    );
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (relative(packageDirectory, path) === join("skills", "company-handbook")) continue;
        if (entry.isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(join(packageDirectory, "skills"));

    const texts = files.map((file) => [
      relative(packageDirectory, file),
      readFileSync(file, "utf8"),
    ]);
    const readme = readFileSync(join(packageDirectory, "README.md"), "utf8");
    texts.push(["README.md", readme.slice(readme.indexOf("## What it does"))]);

    const found: string[] = [];
    for (const [file, text] of texts) {
      for (const person of company.people) {
        const pattern = new RegExp(`\\b${person.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (pattern.test(text ?? "")) found.push(`${file}: ${person.title}`);
      }
    }
    expect(found).toEqual([]);
  });
});

describe("quality eval stubs", () => {
  it("read_company stubs match the generated facts", async () => {
    // The stubs were written at the manifest's default pass score, which is what a role with no
    // overlay says.
    const tool = qualityTools({
      desk: undefined,
      company,
      limits: () => ({
        inspection_pass_score: roleManifest.limits?.inspection_pass_score?.default ?? 0,
      }),
    }).readCompany;
    const sections = (
      tool.parameters as unknown as { properties: { section: { anyOf: { const: string }[] } } }
    ).properties.section.anyOf.map((option) => option.const);
    const real = new Set<string>();
    for (const section of sections) {
      const result = await tool.execute(
        { section },
        { conversationId: "c", taskId: "t", callId: section } as never,
        BACKGROUND_CONTEXT,
      );
      for (const part of result.output ?? [])
        if (part.type === "text") for (const line of part.text.split("\n")) real.add(line);
    }
    expect(real.size).toBeGreaterThan(0);

    const suite = JSON.parse(
      readFileSync(join(packageDirectory, "evals", "situations.json"), "utf8"),
    );
    const stale: string[] = [];
    for (const scenario of suite.scenarios as {
      id: string;
      stubs: Record<string, { text?: string }>;
    }[]) {
      for (const line of (scenario.stubs.read_company?.text ?? "").split("\n")) {
        if (line.trim() !== "" && !real.has(line)) stale.push(`${scenario.id}: ${line}`);
      }
    }
    expect(stale).toEqual([]);
  });
});
