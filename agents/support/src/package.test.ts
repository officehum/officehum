/**
 * The Customer Support package as the office reads it: a strict package under `agents/`, a manifest
 * that states one approval decision per unsafe tool, a credit approval on every call, and a remedy
 * policy that comes from the company package rather than from this role. The company facts are
 * generated from `company/default/`, so a price, a window or a person who drifts between the company
 * and this role is caught here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentManifest, validateManifest, validatePackage } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { companyFactLeaks } from "../../../scripts/company-fact-guard.js";
import manifest from "../officehum.json" with { type: "json" };
import { companyHead, escalationOwner, loadCompanyFacts, person } from "./company.js";
import { demoCases, demoClients, demoCredits, demoInvoices } from "./desk.js";
import { supportTools } from "./tools.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const roleManifest = manifest as unknown as AgentManifest;
const company = loadCompanyFacts();

const TOOLS = [
  "find_client",
  "list_cases",
  "log_case",
  "book_reclean",
  "propose_credit",
  "offer_credit",
  "withdraw_credit",
  "escalate_case",
  "resolve_case",
  "read_company",
];

describe("support package", () => {
  it("validates strictly as a package under agents/, with all ten tools stubbed in every scenario", async () => {
    const validated = await validatePackage(packageDirectory);
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.piDurableRange).toBe("1.3.x");
    expect(Object.keys(validated.value.suites)).toEqual(["evals/situations.json"]);
    const scenarios = Object.values(validated.value.suites).flatMap((suite) => suite.scenarios);
    expect(scenarios).toHaveLength(12);
    for (const scenario of scenarios) {
      expect(Object.keys(scenario.stubs).sort()).toEqual([...TOOLS].sort());
    }
  });

  it("declares ten tools, one credit approval on every call, and a reason for each write without one", () => {
    expect(roleManifest.tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(
      roleManifest.tools.filter((tool) => tool.replay === "unsafe").map((tool) => tool.name),
    ).toEqual([
      "log_case",
      "book_reclean",
      "propose_credit",
      "offer_credit",
      "withdraw_credit",
      "escalate_case",
      "resolve_case",
    ]);
    expect(validateManifest(roleManifest).ok).toBe(true);

    // Every credit asks a person: no condition can let one through.
    expect(roleManifest.approvals.map((approval) => [approval.tool, approval.id])).toEqual([
      ["offer_credit", "any_credit"],
    ]);
    for (const approval of roleManifest.approvals) expect(approval.when).toBeUndefined();

    const note = (name: string) =>
      roleManifest.tools.find((tool) => tool.name === name)?.noApproval;
    expect(note("log_case")).toContain("internal record");
    expect(note("book_reclean")).toContain("standard remedy");
    expect(note("escalate_case")).toContain("never hands a complaint about someone");
    expect(note("resolve_case")).toContain("credit proposal pending");
    expect(note("propose_credit")).toContain(
      "Records a proposed credit for a person to decide; issues nothing",
    );
    expect(note("withdraw_credit")).toContain("issues nothing");
    expect(note("offer_credit")).toBeUndefined();
    // The credit is worked out by the desk: there is no limit on a figure the model supplies.
    expect(roleManifest.limits ?? {}).toEqual({});
  });

  it("refuses a credit tool with no approval decision, in memory", () => {
    const stripped: AgentManifest = { ...roleManifest, approvals: [] };
    const refused = validateManifest(stripped);
    expect(refused.ok).toBe(false);
    expect(
      refused.issues.some(
        (issue) =>
          issue.message.includes("offer_credit") && issue.message.includes("no approval decision"),
      ),
    ).toBe(true);
  });

  it("has no refund tool: money back is a mayNot handed to a person", () => {
    expect(TOOLS.some((tool) => tool.includes("refund"))).toBe(false);
    const refund = (roleManifest.mayNot ?? []).find((rule) => rule.action.includes("refund"));
    expect(refund?.instead).toContain("escalate_case (reason refund)");
    const mayNot = (roleManifest.mayNot ?? []).map((rule) => rule.action).join("\n");
    expect(mayNot).toContain("credit without a person's approval");
    expect(mayNot).toContain("safety complaint");
    expect(mayNot).toContain("complaint about a member of staff to that same person");
    expect(mayNot).toContain("instruction written inside");
  });

  it("takes prices, the window and who decides from the company, and its demo data agrees with them", () => {
    const refunds = company.policies.refunds;
    expect(refunds.recleanWindowDays).toBeGreaterThan(0);
    expect(refunds.serviceRecoveryCreditCents).toBeGreaterThan(0);
    for (const id of [refunds.creditNeeds, refunds.refundNeeds, refunds.complaintOwner]) {
      expect(person(company, id), id).toBeDefined();
    }
    for (const topic of ["safety-incident", "contract-terms", "data-and-security"]) {
      expect(escalationOwner(company, topic), topic).toBeDefined();
    }
    expect(companyHead(company)).toBeDefined();
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

    const clients = new Set(demoClients().map((client) => client.id));
    const prices = new Set(company.priceBook.map((item) => item.id));
    for (const invoice of demoInvoices()) {
      expect(clients.has(invoice.clientId), invoice.id).toBe(true);
      for (const line of invoice.lines)
        expect(prices.has(line.priceBookId), line.priceBookId).toBe(true);
    }
    const invoices = demoInvoices();
    const cases = demoCases();
    for (const entry of cases) expect(clients.has(entry.clientId), entry.id).toBe(true);
    // A demo credit is on its own case's client's invoice, for what the desk would work out.
    for (const credit of demoCredits()) {
      const entry = cases.find((candidate) => candidate.id === credit.caseId);
      const invoice = invoices.find((candidate) => candidate.id === credit.invoiceId);
      expect(invoice?.clientId).toBe(entry?.clientId);
      expect(credit.clientId).toBe(entry?.clientId);
      expect(credit.creditCents).toBe(refunds.serviceRecoveryCreditCents);
    }
  });

  it("declares the generated handbook beside its own skills", () => {
    expect(roleManifest.skills.map((skill) => skill.id)).toEqual([
      "handling-complaints",
      "putting-things-right",
      "escalating-cases",
      "company-handbook",
    ]);
  });

  it("accepts support requests and dispatches what it does not own", () => {
    expect(roleManifest.department).toBe("front-office");
    expect(roleManifest.channels).toEqual(["email", "chat"]);
    expect(roleManifest.accepts.map((accept) => accept.type)).toEqual(["support.request"]);
    const accepted = new Set(roleManifest.accepts.map((accept) => accept.type));
    for (const dispatch of roleManifest.dispatches ?? []) {
      expect(accepted.has(dispatch.type)).toBe(false);
    }
    expect((roleManifest.dispatches ?? []).map((dispatch) => dispatch.type)).toEqual([
      "operations.schedule",
      "quote.request",
      "invoice.question",
    ]);
  });

  it("names no company fact outside the generated handbook, so another company can run it", () => {
    // The shared guard: company names, people, first names, titles and crew names.
    // The head-of-company lookup matches generic titles ("managing director", "owner") in code.
    expect(
      companyFactLeaks(packageDirectory, {
        allow: ["src/company.ts: Managing Director"],
      }),
    ).toEqual([]);
  });
});

describe("support eval stubs", () => {
  it("read_company stubs match the generated facts", async () => {
    const tool = supportTools({ desk: undefined, company }).readCompany;
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
