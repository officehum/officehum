/**
 * The Sales package as the office reads it: a strict package under `agents/`, a manifest that states
 * one approval decision per unsafe tool, and numbers that agree with the company package it quotes
 * for. The company facts are generated from `company/default/`, so a price or a limit that drifts
 * between the company and this role is caught here rather than in a client's inbox.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type AgentManifest,
  loadCompanyFacts as loadFacts,
  validateManifest,
  validatePackage,
} from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { companyFactLeaks } from "../../../scripts/company-fact-guard.js";
import manifest from "../officehum.json" with { type: "json" };
import { COMPANY_FACTS_URL, loadCompanyFacts } from "./company.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
/** The JSON import's inferred type is widened; the checks want the SDK's manifest type. */
const roleManifest = manifest as unknown as AgentManifest;
const company = loadCompanyFacts();

const TOOLS = [
  "list_leads",
  "get_quote",
  "search_price_book",
  "create_quote",
  "request_quote_approval",
  "log_activity",
  "update_lead_stage",
  "record_quote_outcome",
  "schedule_follow_up",
  "pipeline_report",
  "read_company",
];

describe("sales package", () => {
  it("validates strictly as a package under agents/, with all eleven tools stubbed in every scenario", async () => {
    const validated = await validatePackage(packageDirectory);
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.piDurableRange).toBe("1.3.x");
    expect(Object.keys(validated.value.suites)).toEqual(["evals/situations.json"]);
    const scenarios = Object.values(validated.value.suites).flatMap((suite) => suite.scenarios);
    expect(scenarios).toHaveLength(19);
    for (const scenario of scenarios) {
      expect(Object.keys(scenario.stubs).sort()).toEqual([...TOOLS].sort());
    }
  });

  it("declares eleven tools, one approval and the one limit the desk reads", () => {
    expect(roleManifest.tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(
      roleManifest.tools.filter((tool) => tool.replay === "unsafe").map((tool) => tool.name),
    ).toEqual([
      "create_quote",
      "request_quote_approval",
      "log_activity",
      "update_lead_stage",
      "record_quote_outcome",
      "schedule_follow_up",
    ]);
    expect(validateManifest(roleManifest).ok).toBe(true);

    // Reading a quote or counting the pipeline changes nothing, so a replayed call is harmless.
    expect(roleManifest.tools.find((tool) => tool.name === "get_quote")?.replay).toBe("safe");
    expect(roleManifest.tools.find((tool) => tool.name === "pipeline_report")?.replay).toBe("safe");

    // A stage, a quote's outcome and a follow-up are internal records the role's manager does not
    // decide (role.md, "Decisions that go to a manager"), so each states why it needs no approval.
    for (const name of ["update_lead_stage", "record_quote_outcome", "schedule_follow_up"]) {
      const tool = roleManifest.tools.find((candidate) => candidate.name === name);
      expect(tool?.noApproval, name).toContain("nothing is sent to the client");
      expect(tool?.skill, name).toBeUndefined();
    }

    // An internal note states why it needs no approval, and so does saving a quote: the desk holds a
    // discounted or over-limit quote until its approval says yes.
    const note = roleManifest.tools.find((tool) => tool.name === "log_activity");
    expect(note?.noApproval).toContain("internal note");
    const quote = roleManifest.tools.find((tool) => tool.name === "create_quote");
    expect(quote?.noApproval).toContain("awaiting approval");

    // One approval, on every call of request_quote_approval: the desk decides which quotes wait, on
    // the total it worked out, minimums included, so no condition reads the model's arguments.
    expect(roleManifest.approvals).toEqual([
      {
        id: "quote_approval",
        tool: "request_quote_approval",
        description:
          "Approve this quote as the desk holds it: its lead, its lines, any discount and its total, which is discounted or above the quote limit",
      },
    ]);
    expect(roleManifest.limits?.quote_limit_cents).toBeDefined();
    // Both quote tools live in the quoting skill, beside its checklist.
    expect(
      roleManifest.tools
        .filter((tool) => tool.skill === "quoting-from-the-price-book")
        .map((tool) => tool.name),
    ).toEqual(["create_quote", "request_quote_approval"]);
  });

  it("quotes under the limit the company records, not a number of its own", () => {
    // No code in the role reads the record's own quote limit, so the role's type does not carry it;
    // the record still holds it, and the manifest's default must not drift from it.
    const recorded = loadFacts<{ approvalLimits: { quoteOverCents: number } }>(COMPANY_FACTS_URL)
      .approvalLimits.quoteOverCents;
    expect(roleManifest.limits?.quote_limit_cents?.default).toBe(recorded);
    expect(recorded).toBe(500000);
  });

  it("counts a recurring month with the weeks the company records, and has a per-visit item to count", () => {
    expect(company.quoting.weeksPerMonth).toBe(4.33);
    expect(company.priceBook.some((item) => /\bvisit\b/.test(item.unit))).toBe(true);
  });

  it("takes its price book from the generated company facts, and its evals only name lines that exist", () => {
    const ids = new Set(company.priceBook.map((item) => item.id));
    expect(ids.size).toBeGreaterThan(10);
    const script = JSON.parse(
      readFileSync(fileURLToPath(new URL("../evals.smoke.json", import.meta.url)), "utf8"),
    ) as Record<
      string,
      { toolCalls?: { name: string; args?: { lines?: { priceBookItemId?: string }[] } }[] }[]
    >;
    for (const turns of Object.values(script)) {
      for (const turn of turns) {
        for (const call of turn.toolCalls ?? []) {
          for (const line of call.args?.lines ?? []) {
            if (line.priceBookItemId === undefined) continue;
            expect(
              ids.has(line.priceBookItemId),
              `${line.priceBookItemId} is not a price book item`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("declares the generated handbook, and its escalation names people who exist", () => {
    expect(roleManifest.skills.map((skill) => skill.id)).toEqual([
      "qualifying-a-lead",
      "quoting-from-the-price-book",
      "following-up",
      "company-handbook",
    ]);
    const people = new Set(company.people.map((person) => person.id));
    for (const rule of company.escalation) {
      expect(people.has(rule.toPersonId), `${rule.topic} goes to ${rule.toPersonId}`).toBe(true);
    }
  });

  it("refuses a quote approval tool with no approval decision, in memory", () => {
    const stripped: AgentManifest = {
      ...roleManifest,
      approvals: roleManifest.approvals.filter(
        (approval) => approval.tool !== "request_quote_approval",
      ),
    };
    const refused = validateManifest(stripped);
    expect(refused.ok).toBe(false);
    expect(
      refused.issues.some(
        (issue) =>
          issue.message.includes("request_quote_approval") &&
          issue.message.includes("no approval decision"),
      ),
    ).toBe(true);
  });

  it("advertises the company, the quote and the hand-offs a prospect needs", () => {
    expect(roleManifest.department).toBe("sales");
    expect(roleManifest.channels).toEqual(["email", "chat"]);
    expect(roleManifest.accepts.map((accept) => accept.type)).toEqual([
      "quote.request",
      "lead.qualify",
      "pipeline.review",
    ]);
    for (const accept of roleManifest.accepts) {
      expect(accept.done?.length ?? 0).toBeGreaterThan(0);
    }
    const accepted = new Set(roleManifest.accepts.map((accept) => accept.type));
    for (const dispatch of roleManifest.dispatches ?? []) {
      expect(accepted.has(dispatch.type)).toBe(false);
    }
    expect((roleManifest.dispatches ?? []).map((dispatch) => dispatch.type)).toEqual([
      "support.request",
      "finance.review",
      "operations.schedule",
    ]);
  });

  it("names no company fact outside the generated handbook, so another company can run it", () => {
    // The shared guard: company names, people, first names, titles and crew names.
    // The demo pipeline and its quotes (src/demo.ts) are demonstration data, allowed in that file only. role.md is the cited research on the
    // job, where "a sales manager" is the occupation, not the company's title. read_company labels
    // the record's maintenance technicians field in plain words.
    expect(
      companyFactLeaks(packageDirectory, {
        allow: [
          "src/demo.ts: Portland",
          "src/demo.ts: Marcus Oyelaran",
          "src/demo.ts: Marcus",
          "role.md: Sales Manager",
          "src/tools.ts: Maintenance technicians",
        ],
      }),
    ).toEqual([]);
  });
});
