/**
 * The Marketing package as the office reads it: a strict package under `agents/`, a manifest that
 * states one approval decision per unsafe tool, and claims, prices and the approver that come from the
 * company package rather than from this role. The company facts are generated from `company/default/`,
 * so a claim or an approver that drifts between the company and this role is caught here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentManifest, validateManifest, validatePackage } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import manifest from "../officehum.json" with { type: "json" };
import { findResultClaims } from "./claims.js";
import { loadCompanyFacts, marketingApprover } from "./company.js";
import { demoDrafts } from "./desk.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const roleManifest = manifest as unknown as AgentManifest;
const company = loadCompanyFacts();

const TOOLS = [
  "read_services",
  "draft_post",
  "draft_campaign_email",
  "request_claim_approval",
  "publish",
  "list_drafts",
  "read_company",
];

describe("marketing package", () => {
  it("validates strictly as a package under agents/, with all seven tools stubbed in every scenario", async () => {
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

  it("declares seven tools, two approvals on every call, and a reason for each write without one", () => {
    expect(roleManifest.tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(
      roleManifest.tools.filter((tool) => tool.replay === "unsafe").map((tool) => tool.name),
    ).toEqual(["draft_post", "draft_campaign_email", "request_claim_approval", "publish"]);
    expect(validateManifest(roleManifest).ok).toBe(true);

    // Both ask a person on every call: no condition can let one through.
    expect(roleManifest.approvals.map((approval) => [approval.tool, approval.id])).toEqual([
      ["request_claim_approval", "claim"],
      ["publish", "publish"],
    ]);
    for (const approval of roleManifest.approvals) expect(approval.when).toBeUndefined();

    // The claim check is the desk's, on the text it saves: never a manifest condition.
    const note = (name: string) =>
      roleManifest.tools.find((tool) => tool.name === name)?.noApproval;
    expect(note("draft_post")).toContain("request_claim_approval");
    expect(note("draft_campaign_email")).toContain("unsubscribe");
    expect(roleManifest.limits ?? {}).toEqual({});
  });

  it("refuses a publish tool with no approval decision, in memory", () => {
    const stripped: AgentManifest = {
      ...roleManifest,
      approvals: roleManifest.approvals.filter((approval) => approval.tool !== "publish"),
    };
    const refused = validateManifest(stripped);
    expect(refused.ok).toBe(false);
    expect(
      refused.issues.some(
        (issue) =>
          issue.message.includes("publish") && issue.message.includes("no approval decision"),
      ),
    ).toBe(true);
  });

  it("takes its claims, prices and approver from the company, and its demo data agrees with them", () => {
    expect(company.marketing.approvedClaims.length).toBeGreaterThan(0);
    expect(marketingApprover(company)).toBeDefined();
    for (const draft of demoDrafts(company)) {
      expect(findResultClaims(draft.finalText, company.marketing.approvedClaims), draft.id).toEqual(
        [],
      );
    }

    // The scripted runs name only channels and audiences the desk has.
    const script = JSON.parse(
      readFileSync(fileURLToPath(new URL("../evals.smoke.json", import.meta.url)), "utf8"),
    ) as Record<string, { toolCalls?: { args?: { audienceId?: string } }[] }[]>;
    for (const turns of Object.values(script)) {
      for (const turn of turns) {
        for (const call of turn.toolCalls ?? []) {
          if (call.args?.audienceId !== undefined) {
            expect(["current-clients", "prospects"]).toContain(call.args.audienceId);
          }
        }
      }
    }
  });

  it("declares the generated handbook beside its own skills", () => {
    expect(roleManifest.skills.map((skill) => skill.id)).toEqual([
      "checking-claims",
      "writing-posts",
      "campaign-emails",
      "company-handbook",
    ]);
  });

  it("hands paid posts, the media, pricing and money to a person, and dispatches what it does not own", () => {
    expect(roleManifest.department).toBe("marketing");
    expect(roleManifest.channels).toEqual(["email", "chat"]);
    const mayNot = (roleManifest.mayNot ?? []).map((rule) => rule.action).join("\n");
    expect(mayNot).toContain("testimonial");
    expect(mayNot).toContain("influencer");
    expect(mayNot).toContain("media");
    expect(mayNot).toContain("unsubscribe");
    expect(mayNot).toContain("refund");
    expect(roleManifest.accepts.map((accept) => accept.type)).toEqual(["marketing.request"]);
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
      const text = readFileSync(file, "utf8");
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
