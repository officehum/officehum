/**
 * The Sales package as the office reads it: a strict package under `agents/`, a manifest that states
 * one approval decision per unsafe tool, and numbers that agree with the company package it quotes
 * for. The company facts are generated from `company/default/`, so a price or a limit that drifts
 * between the company and this role is caught here rather than in a client's inbox.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentManifest, validateManifest, validatePackage } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import manifest from "../officehum.json" with { type: "json" };
import { loadCompanyFacts } from "./company.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
/** The JSON import's inferred type is widened; the checks want the SDK's manifest type. */
const roleManifest = manifest as unknown as AgentManifest;
const company = loadCompanyFacts();

const TOOLS = [
  "list_leads",
  "get_quote",
  "search_price_book",
  "create_quote",
  "log_activity",
  "read_company",
];

describe("sales package", () => {
  it("validates strictly as a package under agents/, with all six tools stubbed in every scenario", async () => {
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

  it("declares six tools, two approvals and the one limit they read", () => {
    expect(roleManifest.tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(
      roleManifest.tools.filter((tool) => tool.replay === "unsafe").map((tool) => tool.name),
    ).toEqual(["create_quote", "log_activity"]);
    expect(validateManifest(roleManifest).ok).toBe(true);

    // Reading a quote changes nothing, so a replayed call is harmless.
    expect(roleManifest.tools.find((tool) => tool.name === "get_quote")?.replay).toBe("safe");

    // An internal note states why it needs no approval; the quote states two approvals.
    const note = roleManifest.tools.find((tool) => tool.name === "log_activity");
    expect(note?.noApproval).toContain("internal note");
    expect(roleManifest.approvals.map((approval) => approval.id).sort()).toEqual([
      "any_discount",
      "quote_over_limit",
    ]);

    // The discount is `present` (and above zero), so an absent discount cannot gate a quote, and a
    // zero one cannot either.
    const discount = roleManifest.approvals.find((approval) => approval.id === "any_discount");
    expect(discount?.when).toEqual([
      { arg: "discountPercent", op: "present" },
      { arg: "discountPercent", op: "gt", value: 0 },
    ]);

    // The limit is the SDK's summed condition over the quote's own lines.
    const overLimit = roleManifest.approvals.find((approval) => approval.id === "quote_over_limit");
    expect(overLimit?.when?.[0]).toEqual({
      arg: "lines",
      op: "gt",
      field: "unitPriceCents",
      times: "quantity",
      value: { limit: "quote_limit_cents" },
    });
  });

  it("quotes under the limit the company records, not a number of its own", () => {
    expect(roleManifest.limits?.quote_limit_cents?.default).toBe(
      company.approvalLimits.quoteOverCents,
    );
    expect(company.approvalLimits.quoteOverCents).toBe(500000);
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

  it("refuses a quote tool with no approval decision, in memory", () => {
    const stripped: AgentManifest = {
      ...roleManifest,
      approvals: roleManifest.approvals.filter((approval) => approval.tool !== "create_quote"),
    };
    const refused = validateManifest(stripped);
    expect(refused.ok).toBe(false);
    expect(
      refused.issues.some(
        (issue) =>
          issue.message.includes("create_quote") && issue.message.includes("no approval decision"),
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
    // The company's names reach the model only through the generated handbook and `read_company`.
    // Evals, the smoke script, the README's description of the demo and the demo pipeline in the
    // fake desk are demonstration data by design; everything else must read the same for any company.
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
        // The demo pipeline and its quotes are demonstration data; the desk's logic is not.
        const start = text.indexOf("export function demoLeads");
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
});
