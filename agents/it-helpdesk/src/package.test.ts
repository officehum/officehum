/**
 * The IT Help Desk package as the office reads it: a strict package under `agents/`, a manifest that
 * states one approval decision per write, an approval on every call of each account change, and
 * people, systems and groups that come from the company package. The company facts are generated
 * from `company/default/`, so a person or group that drifts between the company and this role is
 * caught here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentManifest, validateManifest, validatePackage } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { companyFactLeaks } from "../../../scripts/company-fact-guard.js";
import manifest from "../officehum.json" with { type: "json" };
import { itApprover, loadCompanyFacts, purchasingDecider, systemOwner } from "./company.js";
import { demoAssets, demoMemberships, demoTickets } from "./desk.js";
import { itHelpdeskTools } from "./tools.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const roleManifest = manifest as unknown as AgentManifest;
const company = loadCompanyFacts();

const TOOLS = [
  "list_tickets",
  "log_ticket",
  "escalate_ticket",
  "resolve_ticket",
  "list_my_access",
  "send_password_reset",
  "request_sign_in_method_change",
  "request_access",
  "request_account_setup",
  "request_account_disable",
  "list_assets",
  "assign_asset",
  "return_asset",
  "report_security_concern",
  "read_company",
];

describe("it help desk package", () => {
  it("validates strictly as a package under agents/, with all fifteen tools stubbed in every scenario", async () => {
    const validated = await validatePackage(packageDirectory);
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.piDurableRange).toBe("1.6.x");
    expect(Object.keys(validated.value.suites)).toEqual(["evals/situations.json"]);
    const scenarios = Object.values(validated.value.suites).flatMap((suite) => suite.scenarios);
    expect(scenarios.length).toBeGreaterThanOrEqual(14);
    for (const scenario of scenarios) {
      expect(Object.keys(scenario.stubs).sort()).toEqual([...TOOLS].sort());
    }
  });

  it("declares fifteen tools, an approval on every call of each account change, and a reason for each other write", () => {
    expect(roleManifest.tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(validateManifest(roleManifest).ok).toBe(true);
    expect(roleManifest.approvals.map((approval) => [approval.tool, approval.id])).toEqual([
      ["request_sign_in_method_change", "sign_in_method_change"],
      ["request_access", "access_grant"],
      ["request_account_setup", "account_setup"],
      ["request_account_disable", "account_disable"],
    ]);
    // No condition can let an account change through without a person.
    for (const approval of roleManifest.approvals) expect(approval.when).toBeUndefined();

    const note = (name: string) =>
      roleManifest.tools.find((tool) => tool.name === name)?.noApproval;
    expect(note("send_password_reset")).toContain("address already on file");
    expect(note("send_password_reset")).toContain("privileged one");
    expect(note("log_ticket")).toContain("the desk sets the priority");
    expect(note("assign_asset")).toContain("already assigned");
    for (const gated of roleManifest.approvals) expect(note(gated.tool)).toBeUndefined();
  });

  it("refuses an account change with no approval decision, in memory", () => {
    const refused = validateManifest({ ...roleManifest, approvals: [] });
    expect(refused.ok).toBe(false);
    for (const tool of ["request_access", "request_account_disable"]) {
      expect(
        refused.issues.some(
          (issue) => issue.message.includes(tool) && issue.message.includes("no approval decision"),
        ),
        tool,
      ).toBe(true);
    }
  });

  it("takes people, systems and groups from the company, and its demo data names only them", () => {
    expect(itApprover(company)).toBeDefined();
    expect(purchasingDecider(company)).toBeDefined();
    for (const system of company.it.systems) expect(systemOwner(company, system.id)).toBeDefined();
    // The record marks at least one group privileged, which is what the desk refuses to grant.
    expect(company.it.accessGroups.some((group) => group.privileged)).toBe(true);

    const people = new Set(company.people.map((worker) => worker.id));
    const groups = new Set(company.it.accessGroups.map((group) => group.id));
    for (const [id, held] of demoMemberships(company)) {
      expect(people.has(id), id).toBe(true);
      for (const group of held) expect(groups.has(group), group).toBe(true);
    }
    for (const ticket of demoTickets(company)) expect(people.has(ticket.reporterId)).toBe(true);
    for (const asset of demoAssets(company)) {
      if (asset.assignedToId !== null) expect(people.has(asset.assignedToId)).toBe(true);
    }
  });

  it("declares the generated handbook beside its own skills", () => {
    expect(roleManifest.skills.map((skill) => skill.id)).toEqual([
      "handling-tickets",
      "accounts-and-access",
      "joiners-and-leavers",
      "security-concerns",
      "company-handbook",
    ]);
  });

  it("refuses passwords, codes, administrator rights and weakened controls, and accepts IT work", () => {
    expect(roleManifest.channels).toEqual(["email", "chat"]);
    const mayNot = (roleManifest.mayNot ?? []).map((rule) => rule.action).join("\n");
    expect(mayNot).toContain("password or a one-time sign-in code");
    expect(mayNot).toContain("Grant administrator rights");
    expect(mayNot).toContain("Switch off, weaken or bypass a security control");
    expect(mayNot).toContain("Buy software");
    expect(roleManifest.accepts.map((accept) => accept.type)).toEqual([
      "it.request",
      "it.onboarding",
      "it.offboarding",
    ]);
    for (const accept of roleManifest.accepts) expect(accept.done?.length ?? 0).toBeGreaterThan(0);
    // The board checks the joiner's equipment is on the register before a person is asked.
    expect(roleManifest.accepts.find((accept) => accept.type === "it.onboarding")?.done).toEqual([
      { tool: "list_assets", args: { person: "{ticket.data.person}" }, expect: "found" },
      { person: true },
    ]);
    expect((roleManifest.dispatches ?? []).map((dispatch) => dispatch.type)).toContain(
      "purchasing.request",
    );
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

describe("it help desk eval stubs", () => {
  it("read_company stubs are what the real tool says for each section", async () => {
    const tool = itHelpdeskTools({ desk: undefined, company }).readCompany;
    const suite = JSON.parse(
      readFileSync(join(packageDirectory, "evals", "situations.json"), "utf8"),
    ) as {
      scenarios: {
        id: string;
        stubs: { read_company?: { byArgs?: { args: { section: string }; text: string }[] } };
      }[];
    };
    const stale: string[] = [];
    for (const scenario of suite.scenarios) {
      const entries = scenario.stubs.read_company?.byArgs ?? [];
      expect(entries.length, scenario.id).toBeGreaterThan(0);
      for (const entry of entries) {
        const result = await tool.execute(
          { section: entry.args.section },
          { conversationId: "c", taskId: "t", callId: entry.args.section } as never,
          BACKGROUND_CONTEXT,
        );
        const real = (result.output ?? [])
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n");
        if (real !== entry.text) stale.push(`${scenario.id}: ${entry.args.section}`);
      }
    }
    expect(stale).toEqual([]);
  });
});
