/**
 * The Payroll and Benefits package as the office reads it: a strict package under `agents/`, a
 * manifest that states one approval decision per unsafe tool, the three approvals on every call, the
 * special enrolment period as a manifest limit, no tool that changes a pay rate, and every schedule,
 * plan and route from the company package rather than from this role.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentManifest, validateManifest, validatePackage } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { companyFactLeaks } from "../../../scripts/company-fact-guard.js";
import manifest from "../officehum.json" with { type: "json" };
import { loadCompanyFacts, payOwner, payrollApprover, timesheetApprover } from "./company.js";
import { demoEmployees } from "./desk.js";
import { payrollTools } from "./tools.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const roleManifest = manifest as unknown as AgentManifest;
const company = loadCompanyFacts();

const TOOLS = [
  "list_pay_periods",
  "list_timesheets",
  "flag_timesheet",
  "request_timesheet_approval",
  "prepare_pay_run",
  "submit_pay_run",
  "request_pay_adjustment",
  "get_pay_statement",
  "get_benefits_summary",
  "record_enrollment_change",
  "request_enrollment_exception",
  "read_company",
];

describe("payroll package", () => {
  it("validates strictly as a package under agents/, with all twelve tools stubbed in every scenario", async () => {
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

  it("declares twelve tools, three approvals on every call, and a reason for each write without one", () => {
    expect(roleManifest.tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(
      roleManifest.tools.filter((tool) => tool.replay === "unsafe").map((tool) => tool.name),
    ).toEqual([
      "flag_timesheet",
      "request_timesheet_approval",
      "prepare_pay_run",
      "submit_pay_run",
      "request_pay_adjustment",
      "record_enrollment_change",
      "request_enrollment_exception",
    ]);
    expect(validateManifest(roleManifest).ok).toBe(true);

    expect(roleManifest.approvals.map((approval) => [approval.tool, approval.id])).toEqual([
      ["submit_pay_run", "any_pay_run"],
      ["request_enrollment_exception", "enrollment_exception"],
      ["request_pay_adjustment", "pay_adjustment"],
    ]);
    // No `when`: every call of a gated tool waits for a person.
    for (const approval of roleManifest.approvals) expect(approval.when).toBeUndefined();
    // A correction's amount is the approver's, entered with their yes within minus and plus the
    // employee's gross on the run; nothing is proposed to them.
    const adjustment = roleManifest.approvals.find((approval) => approval.id === "pay_adjustment");
    expect(adjustment?.value).toEqual({
      name: "adjustmentCents",
      label: "Adjustment to gross pay for this pay run; enter a reduction with a minus",
      minFact: "lowestCents",
      maxFact: "highestCents",
    });
    expect(adjustment?.amount).toBeUndefined();
    for (const other of ["any_pay_run", "enrollment_exception"]) {
      expect(
        roleManifest.approvals.find((approval) => approval.id === other)?.value,
      ).toBeUndefined();
    }

    const note = (name: string) =>
      roleManifest.tools.find((tool) => tool.name === name)?.noApproval;
    expect(note("prepare_pay_run")).toContain("refuses while a timesheet is missing or unapproved");
    expect(note("record_enrollment_change")).toContain("request_enrollment_exception");
    expect(note("flag_timesheet")).toContain("changes no hours");
    for (const gated of [
      "submit_pay_run",
      "request_pay_adjustment",
      "request_enrollment_exception",
    ]) {
      expect(note(gated), gated).toBeUndefined();
    }
    expect(roleManifest.limits).toEqual({
      special_enrollment_days: {
        description: expect.stringContaining("qualifying life event"),
        default: 30,
        // A longer window lets more changes through without an exception.
        guard: "ceiling",
      },
    });
  });

  it("refuses each gated tool with no approval decision, in memory", () => {
    for (const tool of [
      "submit_pay_run",
      "request_pay_adjustment",
      "request_enrollment_exception",
    ]) {
      const refused = validateManifest({
        ...roleManifest,
        approvals: roleManifest.approvals.filter((approval) => approval.tool !== tool),
      });
      expect(refused.ok, tool).toBe(false);
      expect(
        refused.issues.some(
          (issue) => issue.message.includes(tool) && issue.message.includes("no approval decision"),
        ),
        tool,
      ).toBe(true);
    }
  });

  it("has no tool that changes a pay rate: rates, tax advice and others' pay are mayNot entries", () => {
    for (const word of ["rate", "salary", "tax", "raise"]) {
      expect(
        TOOLS.some((tool) => tool.includes(word)),
        word,
      ).toBe(false);
    }
    const mayNot = roleManifest.mayNot ?? [];
    const rule = (word: string) => mayNot.find((entry) => entry.action.includes(word));
    expect(rule("pay rate")?.instead).toContain("read_company (payroll)");
    expect(rule("another person's pay")?.instead).toContain("cannot be shared");
    expect(rule("tax advice")?.instead).toContain("estimator");
    expect(rule("Drop, cap")?.instead).toContain("pay every hour worked");
    expect(rule("instruction written inside")).toBeDefined();
  });

  it("takes the schedule, plans and every route from the company, and its demo crews match it", () => {
    expect(company.payroll.overtimeAfterWeeklyHours).toBeGreaterThan(0);
    expect(company.payroll.benefitPlans.length).toBeGreaterThan(0);
    expect(payrollApprover(company)).toBeDefined();
    expect(payOwner(company)).toBeDefined();
    for (const crew of company.crews)
      expect(timesheetApprover(company, crew.id), crew.id).toBeDefined();
    const crews = new Set(company.crews.map((crew) => crew.id));
    for (const employee of demoEmployees()) expect(crews.has(employee.crewId ?? "")).toBe(true);
  });

  it("declares the generated handbook beside its own skills", () => {
    expect(roleManifest.skills.map((skill) => skill.id)).toEqual([
      "running-pay-runs",
      "correcting-pay",
      "answering-pay-questions",
      "handling-benefits-enrolment",
      "company-handbook",
    ]);
  });

  it("accepts payroll questions and runs, with completion evidence, and dispatches what it does not own", () => {
    expect(roleManifest.channels).toEqual(["email", "chat"]);
    expect(roleManifest.accepts.map((accept) => [accept.type, accept.done])).toEqual([
      ["payroll.question", [{ person: true }]],
      // The board checks the named period's run is approved before a person is asked.
      [
        "payroll.run",
        [
          { tool: "list_pay_periods", args: { period: "{ticket.data.period}" }, expect: "found" },
          { person: true },
        ],
      ],
    ]);
    const accepted = new Set(roleManifest.accepts.map((accept) => accept.type));
    for (const dispatch of roleManifest.dispatches ?? []) {
      expect(accepted.has(dispatch.type)).toBe(false);
    }
  });

  it("names no company fact outside the generated handbook, so another company can run it", () => {
    expect(companyFactLeaks(packageDirectory)).toEqual([]);
  });
});

describe("payroll eval stubs", () => {
  it("read_company stubs match the generated facts", async () => {
    const tool = payrollTools({ desk: undefined, company }).readCompany;
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
