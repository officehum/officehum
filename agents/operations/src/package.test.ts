/**
 * The Operations package as the office reads it: a strict package under `agents/`, a manifest that
 * states one approval decision per unsafe tool, and hours limits that come from the company package
 * rather than from this role. The company facts are generated from `company/default/`, so a cap or a
 * policy that drifts between the company and this role is caught here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentManifest, validateManifest, validatePackage } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import manifest from "../officehum.json" with { type: "json" };
import { loadCompanyFacts, scheduleOwner } from "./company.js";
import { operationsTools } from "./tools.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const roleManifest = manifest as unknown as AgentManifest;
const company = loadCompanyFacts();

const TOOLS = [
  "list_jobs",
  "list_crews",
  "assign_crew",
  "request_overtime",
  "reschedule_job",
  "request_contract_reschedule",
  "record_callout",
  "read_company",
];

describe("operations package", () => {
  it("validates strictly as a package under agents/, with all eight tools stubbed in every scenario", async () => {
    const validated = await validatePackage(packageDirectory);
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.piDurableRange).toBe("1.3.x");
    expect(Object.keys(validated.value.suites)).toEqual(["evals/situations.json"]);
    const scenarios = Object.values(validated.value.suites).flatMap((suite) => suite.scenarios);
    expect(scenarios).toHaveLength(10);
    for (const scenario of scenarios) {
      expect(Object.keys(scenario.stubs).sort()).toEqual([...TOOLS].sort());
    }
  });

  it("declares eight tools, two approvals on every call, and a reason for each write without one", () => {
    expect(roleManifest.tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(
      roleManifest.tools.filter((tool) => tool.replay === "unsafe").map((tool) => tool.name),
    ).toEqual([
      "assign_crew",
      "request_overtime",
      "reschedule_job",
      "request_contract_reschedule",
      "record_callout",
    ]);
    expect(validateManifest(roleManifest).ok).toBe(true);

    // The two requests ask a person on every call: no condition can let one through.
    expect(roleManifest.approvals.map((approval) => [approval.tool, approval.id])).toEqual([
      ["request_overtime", "overtime"],
      ["request_contract_reschedule", "contract_reschedule"],
    ]);
    for (const approval of roleManifest.approvals) expect(approval.when).toBeUndefined();

    // The writes with no approval say why, and the call-out says it books nothing.
    const note = (name: string) =>
      roleManifest.tools.find((tool) => tool.name === name)?.noApproval;
    expect(note("assign_crew")).toContain("request_overtime");
    expect(note("reschedule_job")).toContain("request_contract_reschedule");
    expect(note("record_callout")).toContain("books no crew");
    expect(roleManifest.limits ?? {}).toEqual({});
  });

  it("asks a person for overtime on every call because the company says overtime needs approval", () => {
    // If the company ever records overtimeNeedsApproval: false, this fails on purpose: the
    // unconditional `overtime` approval is then a choice to revisit, not something to drift.
    expect(company.staffPolicies.overtimeNeedsApproval).toBe(true);
  });

  it("takes every crew and cap from the company, and its demo jobs only use crews that exist", () => {
    expect(company.crews.length).toBeGreaterThan(0);
    for (const crew of company.crews) expect(crew.weeklyHoursCap).toBeGreaterThan(0);
    const crews = new Set(company.crews.map((crew) => crew.id));
    const script = JSON.parse(
      readFileSync(fileURLToPath(new URL("../evals.smoke.json", import.meta.url)), "utf8"),
    ) as Record<string, { toolCalls?: { args?: { crewId?: string } }[] }[]>;
    for (const turns of Object.values(script)) {
      for (const turn of turns) {
        for (const call of turn.toolCalls ?? []) {
          if (call.args?.crewId === undefined) continue;
          expect(crews.has(call.args.crewId), `${call.args.crewId} is not a crew`).toBe(true);
        }
      }
    }
  });

  it("declares the generated handbook, and the schedule has an owner the company names", () => {
    expect(roleManifest.skills.map((skill) => skill.id)).toEqual([
      "dispatching-crews",
      "changing-the-schedule",
      "handling-call-outs",
      "company-handbook",
    ]);
    expect(scheduleOwner(company)).toBeDefined();
    const people = new Set(company.people.map((worker) => worker.id));
    for (const rule of company.escalation) {
      expect(people.has(rule.toPersonId), `${rule.topic} goes to ${rule.toPersonId}`).toBe(true);
    }
  });

  it("refuses an overtime request with no approval decision, in memory", () => {
    const stripped: AgentManifest = {
      ...roleManifest,
      approvals: roleManifest.approvals.filter((approval) => approval.tool !== "request_overtime"),
    };
    const refused = validateManifest(stripped);
    expect(refused.ok).toBe(false);
    expect(
      refused.issues.some(
        (issue) =>
          issue.message.includes("request_overtime") &&
          issue.message.includes("no approval decision"),
      ),
    ).toBe(true);
  });

  it("hands subcontracting and sign-off to a person, and accepts the schedule work Sales dispatches", () => {
    expect(roleManifest.department).toBe("operations");
    expect(roleManifest.channels).toEqual(["email", "chat"]);
    const mayNot = (roleManifest.mayNot ?? []).map((rule) => rule.action).join("\n");
    expect(mayNot).toContain("Subcontract");
    expect(mayNot).toContain("complete");
    expect(roleManifest.accepts.map((accept) => accept.type)).toEqual([
      "operations.schedule",
      "operations.callout",
    ]);
    for (const accept of roleManifest.accepts) {
      expect(accept.done?.length ?? 0).toBeGreaterThan(0);
    }
    const accepted = new Set(roleManifest.accepts.map((accept) => accept.type));
    for (const dispatch of roleManifest.dispatches ?? []) {
      expect(accepted.has(dispatch.type)).toBe(false);
    }
  });

  it("names no company fact outside the generated handbook, so another company can run it", () => {
    const skipped = new Set(["dist", "node_modules", "evals", "evals.smoke.json", "README.md"]);
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const local = relative(packageDirectory, path);
        if (skipped.has(entry.name) || local === join("skills", "company-handbook")) continue;
        if (entry.isDirectory()) walk(path);
        else if (!entry.name.endsWith(".test.ts")) files.push(path);
      }
    };
    walk(packageDirectory);
    expect(files.length).toBeGreaterThan(10);

    const facts = [
      company.profile.legalName,
      company.profile.tradingName,
      company.profile.address.city,
      ...company.people.flatMap((worker) => [worker.name, worker.name.split(" ")[0] ?? ""]),
    ].filter((fact) => fact !== "");
    const found: string[] = [];
    for (const file of files) {
      let text = readFileSync(file, "utf8");
      if (file.endsWith(join("src", "desk.ts"))) {
        // The demonstration week is demo data; the desk's logic is not.
        const start = text.indexOf("export function demoJobs");
        const end = text.indexOf("const DAY_MS");
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        text = text.slice(0, start) + text.slice(end);
      }
      for (const fact of facts) {
        const pattern = new RegExp(`\\b${fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (pattern.test(text)) found.push(`${relative(packageDirectory, file)}: ${fact}`);
      }
    }
    expect(found).toEqual([]);
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
    // The README's "Try it" and "Run its evals" notes describe the demonstration; the rest is prose.
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

describe("operations eval stubs", () => {
  it("read_company stubs match the generated facts", async () => {
    const tool = operationsTools({ desk: undefined, company }).readCompany;
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
      for (const part of result.output)
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
