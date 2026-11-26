/**
 * The Compliance and Safety package as the office reads it: a strict package under `agents/`, a
 * manifest that states one approval decision per write, reporting deadlines that are the role's own
 * limits rather than company figures, and courses, crews, chemicals and people that come from the
 * company package. The company facts are generated from `company/default/`, so a course or a person
 * that drifts between the company and this role is caught here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentManifest, validateManifest, validatePackage } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { companyFactLeaks } from "../../../scripts/company-fact-guard.js";
import manifest from "../officehum.json" with { type: "json" };
import { loadCompanyFacts, safetyOfficer } from "./company.js";
import { demoCompletions, demoSafetyDataSheets, demoWorkers } from "./desk.js";
import { safetyTools } from "./tools.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const roleManifest = manifest as unknown as AgentManifest;
const company = loadCompanyFacts();

const TOOLS = [
  "list_training_status",
  "record_training_completion",
  "clearance_check",
  "request_training_exception",
  "log_incident",
  "request_recordability_decision",
  "request_regulator_report",
  "list_incidents",
  "get_safety_data_sheet",
  "schedule_toolbox_talk",
  "read_company",
];

describe("safety package", () => {
  it("validates strictly as a package under agents/, with all eleven tools stubbed in every scenario", async () => {
    const validated = await validatePackage(packageDirectory);
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.piDurableRange).toBe("1.6.x");
    expect(Object.keys(validated.value.suites)).toEqual(["evals/situations.json"]);
    const scenarios = Object.values(validated.value.suites).flatMap((suite) => suite.scenarios);
    expect(scenarios.length).toBeGreaterThanOrEqual(13);
    for (const scenario of scenarios) {
      expect(Object.keys(scenario.stubs).sort()).toEqual([...TOOLS].sort());
    }
  });

  it("declares eleven tools, an approval on every call of each gated one, and a reason for each write without one", () => {
    expect(roleManifest.tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(
      roleManifest.tools.filter((tool) => tool.replay === "unsafe").map((tool) => tool.name),
    ).toEqual([
      "record_training_completion",
      "request_training_exception",
      "log_incident",
      "request_recordability_decision",
      "request_regulator_report",
      "schedule_toolbox_talk",
    ]);
    expect(validateManifest(roleManifest).ok).toBe(true);

    // Each decision asks a person on every call: no condition can let one through.
    expect(roleManifest.approvals.map((approval) => [approval.tool, approval.id])).toEqual([
      ["request_training_exception", "training_exception"],
      ["request_recordability_decision", "recordability"],
      ["request_regulator_report", "regulator_report"],
    ]);
    for (const approval of roleManifest.approvals) expect(approval.when).toBeUndefined();

    const note = (name: string) =>
      roleManifest.tools.find((tool) => tool.name === name)?.noApproval;
    expect(note("record_training_completion")).toContain("a future date");
    expect(note("log_incident")).toContain("never discouraged");
    expect(note("schedule_toolbox_talk")).toContain("never records a training completion");
    for (const gated of [
      "request_training_exception",
      "request_recordability_decision",
      "request_regulator_report",
    ]) {
      expect(note(gated)).toBeUndefined();
    }
  });

  it("refuses each gated tool with no approval decision, in memory", () => {
    const refused = validateManifest({ ...roleManifest, approvals: [] });
    expect(refused.ok).toBe(false);
    for (const tool of [
      "request_training_exception",
      "request_recordability_decision",
      "request_regulator_report",
    ]) {
      expect(
        refused.issues.some(
          (issue) => issue.message.includes(tool) && issue.message.includes("no approval decision"),
        ),
        tool,
      ).toBe(true);
    }
  });

  it("takes courses, crews, chemicals and people from the company, and the deadlines from its own manifest", () => {
    expect(Object.keys(roleManifest.limits ?? {})).toEqual([
      "fatality_report_hours",
      "severe_injury_report_hours",
    ]);
    expect(roleManifest.limits?.fatality_report_hours?.default).toBe(8);
    expect(roleManifest.limits?.severe_injury_report_hours?.default).toBe(24);
    // The deadlines are a jurisdiction's, set on the role, so the company record does not hold them.
    expect(company.safety).not.toHaveProperty("reportHours");
    expect(safetyOfficer(company)).toBeDefined();

    const crews = new Set(company.crews.map((crew) => crew.id));
    for (const worker of demoWorkers()) expect(crews.has(worker.crewId), worker.name).toBe(true);
    const courses = new Set(company.safety.requiredTraining.map((course) => course.id));
    for (const record of demoCompletions()) expect(courses.has(record.courseId)).toBe(true);
    const catalog = new Set(company.supplyCatalog.map((item) => item.id));
    for (const sheet of demoSafetyDataSheets()) expect(catalog.has(sheet.chemicalId)).toBe(true);
  });

  it("declares the generated handbook beside its own skills", () => {
    expect(roleManifest.skills.map((skill) => skill.id)).toEqual([
      "tracking-training",
      "logging-incidents",
      "answering-safety-questions",
      "company-handbook",
    ]);
  });

  it("keeps the decisions with a person in mayNot, and accepts safety work", () => {
    expect(roleManifest.department).toBe("operations");
    expect(roleManifest.channels).toEqual(["email", "chat"]);
    const mayNot = (roleManifest.mayNot ?? []).map((rule) => rule.action).join("\n");
    for (const phrase of [
      "recordable",
      "work-related",
      "legal or medical advice",
      "medical details",
      "work stop",
      "refusal to work",
      "control measures",
      "Discourage",
    ]) {
      expect(mayNot, phrase).toContain(phrase);
    }
    expect(roleManifest.accepts.map((accept) => accept.type)).toEqual([
      "safety.incident",
      "safety.question",
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

describe("safety eval stubs", () => {
  it("read_company stubs match the generated facts", async () => {
    // The stubs were written at the manifest's default deadlines, which is what a role with no
    // overlay says.
    const tool = safetyTools({
      desk: undefined,
      company,
      limits: () => ({
        fatality_report_hours: roleManifest.limits?.fatality_report_hours?.default ?? 0,
        severe_injury_report_hours: roleManifest.limits?.severe_injury_report_hours?.default ?? 0,
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
