/**
 * The Inventory and Warehouse package as the office reads it: a strict package under `agents/`, a
 * manifest that states one approval decision per write, the adjustment limit as its own manifest
 * limit, and demonstration data and scripts that name only what the company has. Nothing outside the
 * generated handbook names the company, so another company can run it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentManifest, validateManifest, validatePackage } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { companyFactLeaks } from "../../../scripts/company-fact-guard.js";
import manifest from "../officehum.json" with { type: "json" };
import { countsOwner, loadCompanyFacts, writeOffApprover } from "./company.js";
import { inventoryTools } from "./tools.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const roleManifest = manifest as unknown as AgentManifest;
const company = loadCompanyFacts();

const TOOLS = [
  "list_stock_levels",
  "count_sheet",
  "record_issue",
  "record_transfer",
  "record_count",
  "request_adjustment_approval",
  "hold_stock",
  "request_write_off",
  "reorder_report",
  "accuracy_report",
  "read_company",
];

describe("inventory package", () => {
  it("validates strictly as a package under agents/, with every tool stubbed in every scenario", async () => {
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

  it("declares its tools, two approvals on every call, and a reason for each write without one", () => {
    expect(roleManifest.tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(
      roleManifest.tools.filter((tool) => tool.replay === "unsafe").map((tool) => tool.name),
    ).toEqual([
      "record_issue",
      "record_transfer",
      "record_count",
      "request_adjustment_approval",
      "hold_stock",
      "request_write_off",
    ]);
    expect(validateManifest(roleManifest).ok).toBe(true);
    expect(roleManifest.approvals.map((approval) => [approval.tool, approval.id])).toEqual([
      ["request_adjustment_approval", "stock_adjustment"],
      ["request_write_off", "write_off"],
    ]);
    for (const approval of roleManifest.approvals) expect(approval.when).toBeUndefined();
    const note = (name: string) =>
      roleManifest.tools.find((tool) => tool.name === name)?.noApproval;
    expect(note("record_count")).toContain("request_adjustment_approval");
    expect(note("record_issue")).toContain("available");
    expect(note("hold_stock")).toContain("cannot be issued");
  });

  it("refuses the write-off tool with no approval decision, in memory", () => {
    const stripped: AgentManifest = {
      ...roleManifest,
      approvals: roleManifest.approvals.filter((approval) => approval.tool !== "request_write_off"),
    };
    const refused = validateManifest(stripped);
    expect(refused.ok).toBe(false);
    expect(
      refused.issues.some(
        (issue) =>
          issue.message.includes("request_write_off") &&
          issue.message.includes("no approval decision"),
      ),
    ).toBe(true);
  });

  it("takes the adjustment limit from its own manifest and the people from the company", () => {
    expect(Object.keys(roleManifest.limits ?? {})).toEqual(["stock_adjustment_limit_cents"]);
    expect(roleManifest.limits?.stock_adjustment_limit_cents?.default).toBe(25000);
    expect(company.inventory).not.toHaveProperty("adjustmentLimitCents");
    expect(countsOwner(company)).toBeDefined();
    expect(writeOffApprover(company)).toBeDefined();
  });

  it("scripts only locations, items and crews the company has", () => {
    const locations = new Set(company.inventory.locations.map((location) => location.id));
    const items = new Set(company.supplyCatalog.map((item) => item.id));
    const crews = new Set(company.crews.map((crew) => crew.id));
    const script = JSON.parse(
      readFileSync(fileURLToPath(new URL("../evals.smoke.json", import.meta.url)), "utf8"),
    ) as Record<string, { toolCalls?: { args?: Record<string, unknown> }[] }[]>;
    for (const turns of Object.values(script)) {
      for (const turn of turns) {
        for (const call of turn.toolCalls ?? []) {
          const args = call.args ?? {};
          for (const key of ["locationId", "fromId", "toId"]) {
            if (typeof args[key] === "string") expect(locations.has(args[key]), key).toBe(true);
          }
          if (typeof args.itemId === "string") expect(items.has(args.itemId)).toBe(true);
          if (typeof args.crewId === "string") expect(crews.has(args.crewId)).toBe(true);
        }
      }
    }
  });

  it("declares its skills and the generated handbook", () => {
    expect(roleManifest.skills.map((skill) => skill.id)).toEqual([
      "issuing-and-moving-stock",
      "counting-stock",
      "damaged-stock",
      "company-handbook",
    ]);
  });

  it("accepts counts and issues, never orders, and hands a reorder need to Purchasing", () => {
    expect(roleManifest.department).toBe("operations");
    expect(roleManifest.channels).toEqual(["email", "chat"]);
    expect(roleManifest.accepts.map((accept) => [accept.type, accept.done])).toEqual([
      ["inventory.count", [{ person: true }]],
      ["inventory.issue", [{ person: true }]],
    ]);
    expect((roleManifest.dispatches ?? []).map((dispatch) => dispatch.type)).toEqual([
      "purchasing.request",
    ]);
    const mayNot = (roleManifest.mayNot ?? []).map((rule) => rule.action).join("\n");
    expect(mayNot).toContain("Order supplies");
    expect(mayNot).toContain("Write off");
    expect(mayNot).toContain("without a recount");
    expect(mayNot).toContain("held stock");
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

describe("inventory eval stubs", () => {
  it("read_company stubs match the generated facts at the manifest's default limit", async () => {
    const tool = inventoryTools({
      desk: undefined,
      company,
      limits: () => ({
        stock_adjustment_limit_cents:
          roleManifest.limits?.stock_adjustment_limit_cents?.default ?? 0,
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
