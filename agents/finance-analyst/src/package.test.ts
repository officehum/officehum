/**
 * The Finance Analysis package as the office reads it: a strict package under `agents/`, a manifest
 * that states one approval decision per write, a variance limit that is the role's own rather than a
 * company figure, and a budget and people that come from the company package. The company facts are
 * generated from `company/default/`, so a budget line or a person that drifts between the company
 * and this role is caught here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentManifest, validateManifest, validatePackage } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { companyFactLeaks } from "../../../scripts/company-fact-guard.js";
import manifest from "../officehum.json" with { type: "json" };
import { booksKeeper, budgetApprover, loadCompanyFacts } from "./company.js";
import { DEMO_DIRECT_COST_SHARES, demoActuals } from "./desk.js";
import { financeTools } from "./tools.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const roleManifest = manifest as unknown as AgentManifest;
const company = loadCompanyFacts();

const TOOLS = [
  "list_periods",
  "budget_vs_actual",
  "margin_by_service",
  "receivables_aging",
  "cash_forecast",
  "record_variance_explanation",
  "save_report_draft",
  "request_report_release",
  "request_budget_revision",
  "read_company",
];

/** The data pack's four tools, which the office supplies. */
const DATA_TOOLS = ["data_inspect", "data_query", "data_export", "chart_render"];

describe("finance analyst package", () => {
  it("validates strictly as a package under agents/, with all ten tools stubbed in every scenario", async () => {
    const validated = await validatePackage(packageDirectory);
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.piDurableRange).toBe("1.6.x");
    expect(Object.keys(validated.value.suites)).toEqual([
      "evals/data.json",
      "evals/situations.json",
    ]);
    const situations = validated.value.suites["evals/situations.json"]?.scenarios ?? [];
    expect(situations.length).toBeGreaterThanOrEqual(14);
    for (const scenario of situations) {
      expect(Object.keys(scenario.stubs).sort()).toEqual([...TOOLS].sort());
    }
    // The data suite runs with the data pack, so its scenarios stub the pack's tools too.
    const data = validated.value.suites["evals/data.json"];
    expect(data?.packs).toEqual(["data"]);
    for (const scenario of data?.scenarios ?? []) {
      expect(Object.keys(scenario.stubs).sort()).toEqual([...TOOLS, ...DATA_TOOLS].sort());
    }
  });

  it("declares ten tools, an approval on every call of each gated one, and a reason for each write without one", () => {
    expect(roleManifest.tools.map((tool) => tool.name)).toEqual([...TOOLS, ...DATA_TOOLS]);
    // The data tools come from the office's data pack. They are safe to rerun, and the three that
    // save a new file in the office's files say so and why no approval is needed.
    const pack = roleManifest.tools.filter((tool) => tool.pack !== undefined);
    expect(pack.map((tool) => [tool.name, tool.pack, tool.replay, tool.writes ?? false])).toEqual([
      ["data_inspect", "data", "safe", false],
      ["data_query", "data", "safe", true],
      ["data_export", "data", "safe", true],
      ["chart_render", "data", "safe", true],
    ]);
    for (const tool of pack.slice(1))
      expect(tool.noApproval).toContain("nothing leaves the office");
    expect(
      roleManifest.tools.filter((tool) => tool.replay === "unsafe").map((tool) => tool.name),
    ).toEqual([
      "record_variance_explanation",
      "save_report_draft",
      "request_report_release",
      "request_budget_revision",
    ]);
    expect(validateManifest(roleManifest).ok).toBe(true);

    // A release and a revision ask a person on every call: no condition can let one through.
    expect(roleManifest.approvals.map((approval) => [approval.tool, approval.id])).toEqual([
      ["request_report_release", "release_report"],
      ["request_budget_revision", "budget_revision"],
    ]);
    for (const approval of roleManifest.approvals) expect(approval.when).toBeUndefined();
    // A revision's amount is the approver's, entered with their yes; nothing is proposed to them.
    const revision = roleManifest.approvals.find((approval) => approval.id === "budget_revision");
    expect(revision?.value).toEqual({
      name: "revisedCents",
      label: "Revised monthly budget for the line",
      min: 0,
    });
    expect(revision?.amount).toBeUndefined();

    const note = (name: string) =>
      roleManifest.tools.find((tool) => tool.name === name)?.noApproval;
    expect(note("save_report_draft")).toContain("variance over the limit has no explanation");
    expect(note("save_report_draft")).toContain("money figure");
    expect(note("record_variance_explanation")).toContain("no ledger entry");
    expect(note("request_report_release")).toBeUndefined();
    expect(note("request_budget_revision")).toBeUndefined();
  });

  it("refuses the gated tools with no approval decision, in memory", () => {
    const refused = validateManifest({ ...roleManifest, approvals: [] });
    expect(refused.ok).toBe(false);
    for (const tool of ["request_report_release", "request_budget_revision"]) {
      expect(
        refused.issues.some(
          (issue) => issue.message.includes(tool) && issue.message.includes("no approval decision"),
        ),
        tool,
      ).toBe(true);
    }
  });

  it("takes the budget and people from the company, and the variance limit from its own manifest", () => {
    expect(Object.keys(roleManifest.limits ?? {})).toEqual(["variance_explanation_limit_cents"]);
    expect(roleManifest.limits?.variance_explanation_limit_cents?.default).toBe(500000);
    // The limit is a setting the business chooses, so the company record does not hold it.
    expect(company.budget).not.toHaveProperty("varianceLimitCents");
    expect(budgetApprover(company)).toBeDefined();
    expect(booksKeeper(company)).toBeDefined();

    // The demonstration actuals cover every budget line, and the cost shares name only cost lines.
    const lines = new Set(company.budget.lines.map((line) => line.id));
    for (const month of demoActuals(company.budget.lines, company.budget.fiscalYear).values()) {
      expect(new Set(month.keys())).toEqual(lines);
    }
    for (const [lineId, shares] of Object.entries(DEMO_DIRECT_COST_SHARES)) {
      expect(company.budget.lines.find((line) => line.id === lineId)?.kind).toBe("cost");
      expect(Object.values(shares).reduce((sum, share) => sum + share, 0)).toBe(1000);
      for (const service of Object.keys(shares)) {
        expect(company.budget.lines.find((line) => line.id === service)?.kind).toBe("revenue");
      }
    }
  });

  it("declares the generated handbook beside its own skills", () => {
    expect(roleManifest.skills.map((skill) => skill.id)).toEqual([
      "budget-against-actual",
      "management-report",
      "cash-and-receivables",
      "budget-revisions",
      "answering-from-spreadsheets",
      "company-handbook",
    ]);
  });

  it("hands the ledger, tax, outside parties and decisions to a person, and accepts finance work", () => {
    expect(roleManifest.department).toBe("finance");
    expect(roleManifest.channels).toEqual(["email", "chat"]);
    const mayNot = (roleManifest.mayNot ?? []).map((rule) => rule.action).join("\n");
    expect(mayNot).toContain("ledger entry");
    expect(mayNot).toContain("tax advice or investment advice");
    expect(mayNot).toContain("lender");
    expect(mayNot).toContain("State a forecast as a fact");
    expect(mayNot).toContain("Decide what action to take on a variance");
    expect(roleManifest.accepts.map((accept) => accept.type)).toEqual([
      "finance.report",
      "finance.question",
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

describe("finance analyst eval stubs", () => {
  it("read_company stubs match the generated facts", async () => {
    // The stubs were written at the manifest's default limit, which is what a role with no overlay
    // says.
    const tool = financeTools({
      desk: undefined,
      company,
      limits: () => ({
        variance_explanation_limit_cents:
          roleManifest.limits?.variance_explanation_limit_cents?.default ?? 0,
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

    // Through the validated path, so each scenario's stubs already carry the file's shared ones.
    const validated = await validatePackage(packageDirectory);
    if (!validated.ok) throw new Error("the finance-analyst package did not validate");
    const scenarios = Object.values(validated.value.suites).flatMap((suite) => suite.scenarios);
    const stale: string[] = [];
    for (const scenario of scenarios) {
      const stub = scenario.stubs.read_company;
      const texts =
        stub === undefined
          ? []
          : "byArgs" in stub
            ? [...stub.byArgs.map((entry) => entry.text), stub.otherwise?.text]
            : [stub.text];
      for (const text of texts) {
        for (const line of (text ?? "").split("\n")) {
          if (line.trim() !== "" && !real.has(line)) stale.push(`${scenario.id}: ${line}`);
        }
      }
    }
    expect(stale).toEqual([]);
  });
});
