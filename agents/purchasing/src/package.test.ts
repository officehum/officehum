/**
 * The Purchasing package as the office reads it: a strict package under `agents/`, a manifest that
 * states one approval decision per unsafe tool, and money limits that come from the company package
 * rather than from this role. The company facts are generated from `company/default/`, so a limit or a
 * supplier that drifts between the company and this role is caught here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentManifest, validateManifest, validatePackage } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import manifest from "../officehum.json" with { type: "json" };
import { loadCompanyFacts, purchasingLead } from "./company.js";
import { demoOffers, demoOrders, demoStock } from "./desk.js";
import { purchasingTools } from "./tools.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const roleManifest = manifest as unknown as AgentManifest;
const company = loadCompanyFacts();

const TOOLS = [
  "list_stock",
  "list_suppliers",
  "compare_suppliers",
  "list_purchase_orders",
  "raise_purchase_order",
  "request_po_approval",
  "request_new_supplier",
  "record_receipt",
  "read_company",
];

describe("purchasing package", () => {
  it("validates strictly as a package under agents/, with all nine tools stubbed in every scenario", async () => {
    const validated = await validatePackage(packageDirectory);
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.piDurableRange).toBe("1.3.x");
    expect(Object.keys(validated.value.suites)).toEqual(["evals/situations.json"]);
    const scenarios = Object.values(validated.value.suites).flatMap((suite) => suite.scenarios);
    expect(scenarios).toHaveLength(13);
    for (const scenario of scenarios) {
      expect(Object.keys(scenario.stubs).sort()).toEqual([...TOOLS].sort());
    }
  });

  it("declares nine tools, two approvals on every call, and a reason for each write without one", () => {
    expect(roleManifest.tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(
      roleManifest.tools.filter((tool) => tool.replay === "unsafe").map((tool) => tool.name),
    ).toEqual([
      "raise_purchase_order",
      "request_po_approval",
      "request_new_supplier",
      "record_receipt",
    ]);
    expect(validateManifest(roleManifest).ok).toBe(true);

    // The two requests ask a person on every call: no condition can let one through.
    expect(roleManifest.approvals.map((approval) => [approval.tool, approval.id])).toEqual([
      ["request_po_approval", "po_over_limit"],
      ["request_new_supplier", "new_supplier"],
    ]);
    for (const approval of roleManifest.approvals) expect(approval.when).toBeUndefined();

    // The spending limit is the desk's, on the total it works out: never a manifest condition on a
    // figure the model supplies.
    const note = (name: string) =>
      roleManifest.tools.find((tool) => tool.name === name)?.noApproval;
    expect(note("raise_purchase_order")).toContain("request_po_approval");
    expect(note("raise_purchase_order")).toContain("request_new_supplier");
    expect(note("record_receipt")).toContain("named person");
    expect(roleManifest.limits ?? {}).toEqual({});
  });

  it("refuses an over-limit approval tool with no approval decision, in memory", () => {
    const stripped: AgentManifest = {
      ...roleManifest,
      approvals: roleManifest.approvals.filter(
        (approval) => approval.tool !== "request_po_approval",
      ),
    };
    const refused = validateManifest(stripped);
    expect(refused.ok).toBe(false);
    expect(
      refused.issues.some(
        (issue) =>
          issue.message.includes("request_po_approval") &&
          issue.message.includes("no approval decision"),
      ),
    ).toBe(true);
  });

  it("takes the limit, suppliers and catalogue from the company, and its demo data agrees with them", () => {
    expect(company.approvalLimits.purchaseOrderOverCents).toBeGreaterThan(0);
    expect(company.suppliers.some((supplier) => !supplier.approved)).toBe(true);
    const items = new Set(company.supplyCatalog.map((item) => item.id));
    const suppliers = new Set(company.suppliers.map((supplier) => supplier.id));
    expect(Object.keys(demoStock()).sort()).toEqual([...items].sort());
    for (const offer of demoOffers()) {
      expect(items.has(offer.itemId), offer.itemId).toBe(true);
      expect(suppliers.has(offer.supplierId), offer.supplierId).toBe(true);
    }
    for (const order of demoOrders(company.supplyCatalog, company.suppliers)) {
      expect(suppliers.has(order.supplierId), order.supplierId).toBe(true);
    }

    // The scripted runs name only suppliers and items the company has, or a supplier not on file.
    const script = JSON.parse(
      readFileSync(fileURLToPath(new URL("../evals.smoke.json", import.meta.url)), "utf8"),
    ) as Record<
      string,
      { toolCalls?: { args?: { supplierId?: string; lines?: { itemId: string }[] } }[] }[]
    >;
    for (const turns of Object.values(script)) {
      for (const turn of turns) {
        for (const call of turn.toolCalls ?? []) {
          if (call.args?.supplierId !== undefined) {
            expect(suppliers.has(call.args.supplierId), call.args.supplierId).toBe(true);
          }
          for (const line of call.args?.lines ?? []) {
            expect(items.has(line.itemId), line.itemId).toBe(true);
          }
        }
      }
    }
  });

  it("declares the generated handbook, and purchasing has a lead the company names", () => {
    expect(roleManifest.skills.map((skill) => skill.id)).toEqual([
      "restocking",
      "choosing-suppliers",
      "receiving-goods",
      "company-handbook",
    ]);
    expect(purchasingLead(company)).toBeDefined();
  });

  it("hands contracts, claims and surplus to a person, and dispatches what it does not own", () => {
    expect(roleManifest.department).toBe("operations");
    expect(roleManifest.channels).toEqual(["email", "chat"]);
    const mayNot = (roleManifest.mayNot ?? []).map((rule) => rule.action).join("\n");
    expect(mayNot).toContain("contract");
    expect(mayNot).toContain("claim or dispute");
    expect(mayNot).toContain("surplus");
    expect(mayNot).toContain("split");
    expect(mayNot).toContain("supplier's own delivery notice");
    expect(roleManifest.accepts.map((accept) => accept.type)).toEqual(["purchasing.request"]);
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

describe("purchasing eval stubs", () => {
  it("read_company stubs match the generated facts", async () => {
    const tool = purchasingTools({ desk: undefined, company }).readCompany;
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
