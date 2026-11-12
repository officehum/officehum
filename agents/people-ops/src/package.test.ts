/**
 * The People Ops package as the office reads it: a strict package under `agents/`, a manifest that
 * states one approval decision per unsafe tool, an exception approval on every call, no tool for pay,
 * discipline or termination, and every route and notice period from the company package rather than
 * from this role.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentManifest, validateManifest, validatePackage } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { companyFactLeaks } from "../../../scripts/company-fact-guard.js";
import manifest from "../officehum.json" with { type: "json" };
import { companyHead, escalationOwner, loadCompanyFacts, peopleOwner, person } from "./company.js";
import { demoEmployees } from "./desk.js";
import { peopleOpsTools } from "./tools.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const roleManifest = manifest as unknown as AgentManifest;
const company = loadCompanyFacts();

const TOOLS = [
  "list_candidates",
  "update_candidate_stage",
  "onboarding_checklist",
  "record_time_off_request",
  "request_time_off_exception",
  "list_availability",
  "get_leave_balance",
  "refer_to_person",
  "read_company",
];

describe("people ops package", () => {
  it("validates strictly as a package under agents/, with all nine tools stubbed in every scenario", async () => {
    const validated = await validatePackage(packageDirectory);
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.piDurableRange).toBe("1.3.x");
    expect(Object.keys(validated.value.suites)).toEqual(["evals/situations.json"]);
    const scenarios = Object.values(validated.value.suites).flatMap((suite) => suite.scenarios);
    expect(scenarios).toHaveLength(14);
    for (const scenario of scenarios) {
      expect(Object.keys(scenario.stubs).sort()).toEqual([...TOOLS].sort());
    }
  });

  it("declares nine tools, one exception approval on every call, and a reason for each write without one", () => {
    expect(roleManifest.tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(
      roleManifest.tools.filter((tool) => tool.replay === "unsafe").map((tool) => tool.name),
    ).toEqual([
      "update_candidate_stage",
      "onboarding_checklist",
      "record_time_off_request",
      "request_time_off_exception",
      "refer_to_person",
    ]);
    expect(validateManifest(roleManifest).ok).toBe(true);

    expect(roleManifest.approvals.map((approval) => [approval.tool, approval.id])).toEqual([
      ["request_time_off_exception", "time_off_exception"],
    ]);
    for (const approval of roleManifest.approvals) expect(approval.when).toBeUndefined();

    const note = (name: string) =>
      roleManifest.tools.find((tool) => tool.name === name)?.noApproval;
    expect(note("update_candidate_stage")).toContain("refuses hired and rejected");
    expect(note("onboarding_checklist")).toContain("already hired");
    expect(note("record_time_off_request")).toContain("approves nothing");
    expect(note("refer_to_person")).toContain("never hands a complaint to anyone it names");
    expect(note("request_time_off_exception")).toBeUndefined();
    // The notice is worked out by the desk: there is no limit on a figure the model supplies.
    expect(roleManifest.limits ?? {}).toEqual({});
  });

  it("refuses the exception tool with no approval decision, in memory", () => {
    const refused = validateManifest({ ...roleManifest, approvals: [] });
    expect(refused.ok).toBe(false);
    expect(
      refused.issues.some(
        (issue) =>
          issue.message.includes("request_time_off_exception") &&
          issue.message.includes("no approval decision"),
      ),
    ).toBe(true);
  });

  it("has no tool for pay, discipline or termination: each is a mayNot handed to a person", () => {
    for (const word of ["pay", "discipline", "terminat", "warning", "fire"]) {
      expect(
        TOOLS.some((tool) => tool.includes(word)),
        word,
      ).toBe(false);
    }
    const mayNot = roleManifest.mayNot ?? [];
    const rule = (word: string) => mayNot.find((entry) => entry.action.includes(word));
    expect(rule("pay")?.instead).toContain("refer_to_person (topic pay)");
    expect(rule("Discipline")?.instead).toContain("topic discipline or termination");
    expect(rule("phone number")?.instead).toContain("cannot be shared");
    expect(rule("law may protect")?.instead).toContain("whatever the notice");
    expect(rule("Hire or reject")).toBeDefined();
    expect(rule("instruction written inside")).toBeDefined();
  });

  it("takes every route and the notice period from the company, and its demo crews match its headcount", () => {
    const staff = company.staffPolicies;
    expect(staff.timeOffNoticeDays).toBeGreaterThan(0);
    for (const id of [
      staff.payQuestionsTo,
      staff.disciplineTo,
      staff.protectedLeaveTo,
      staff.employeeRelationsTo,
    ]) {
      expect(person(company, id), id).toBeDefined();
    }
    expect(peopleOwner(company)).toBeDefined();
    expect(companyHead(company)).toBeDefined();
    expect(escalationOwner(company, "start-date")).toBeDefined();
    expect(escalationOwner(company, "supplies-and-equipment")).toBeDefined();
    // A complaint about the person who takes complaints has somewhere else to go.
    expect(companyHead(company)?.id).not.toBe(staff.employeeRelationsTo);
    // The head is the head title, never the first "director" in record order.
    const retitled = {
      ...company,
      people: [
        { ...company.people[1], id: "finance-director", title: "Finance Director" },
        ...company.people,
      ],
    } as typeof company;
    expect(companyHead(retitled)?.title).toMatch(
      /managing director|owner|president|chief executive/i,
    );
    const crews = new Set(company.crews.map((crew) => crew.id));
    for (const employee of demoEmployees()) expect(crews.has(employee.crewId ?? "")).toBe(true);
  });

  it("declares the generated handbook beside its own skills", () => {
    expect(roleManifest.skills.map((skill) => skill.id)).toEqual([
      "hiring-candidates",
      "onboarding-new-hires",
      "handling-time-off",
      "routing-people-matters",
      "company-handbook",
    ]);
  });

  it("accepts people requests and dispatches what it does not own", () => {
    expect(roleManifest.department).toBe("people");
    expect(roleManifest.channels).toEqual(["email", "chat"]);
    expect(roleManifest.accepts.map((accept) => accept.type)).toEqual(["people.request"]);
    const accepted = new Set(roleManifest.accepts.map((accept) => accept.type));
    for (const dispatch of roleManifest.dispatches ?? []) {
      expect(accepted.has(dispatch.type)).toBe(false);
    }
    expect((roleManifest.dispatches ?? []).map((dispatch) => dispatch.type)).toEqual([
      "operations.schedule",
      "invoice.question",
      "finance.review",
      "support.request",
    ]);
  });

  it("names no company fact outside the generated handbook, so another company can run it", () => {
    // The shared guard: company names, people, first names, titles and crew names.
    // The role is called People Ops, the same words as one person's title.
    expect(companyFactLeaks(packageDirectory, { allow: ["People Ops"] })).toEqual([]);
  });
});

describe("people-ops eval stubs", () => {
  it("read_company stubs match the generated facts", async () => {
    const tool = peopleOpsTools({ desk: undefined, company }).readCompany;
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
