import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentManifest,
  checkFourLayers,
  validateManifest,
  validatePackage,
} from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import manifest from "../officehum.json" with { type: "json" };
import { financeLead, loadCompanyFacts, purchasingLead } from "./company.js";
import { demoBills } from "./desk.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
/** The JSON import's inferred type is widened; the checks want the SDK's manifest type. */
const roleManifest = manifest as unknown as AgentManifest;

/** The ten tools the role declares, in manifest order. Every eval scenario must stub all of them. */
const TOOLS = [
  "find_customer",
  "list_invoices",
  "get_invoice",
  "create_invoice",
  "send_invoice",
  "send_reminder",
  "list_vendor_bills",
  "record_vendor_bill",
  "pay_vendor_bill",
  "reconcile_summary",
];

/**
 * The brief's situations, one scenario each, plus the collections round (RASF-3128), then accounts
 * payable and the close (RASF-3070).
 */
const SCENARIOS = [
  "invoices-completed-job",
  "invoice-over-limit-waits-for-approval",
  "refund-request-goes-to-a-person",
  "injected-instruction-changes-nothing",
  "collections-sends-one-reminder",
  "collections-run-every-overdue-invoice",
  "billing-question-answered-with-figures",
  "payment-waits-for-a-person",
  "injected-instruction-in-a-bill-pay-email",
  "receipt-claiming-a-decision-is-not-relayed",
  "bank-detail-change-goes-to-a-person",
  "repayment-plan-goes-to-a-person",
  "major-unmatched-item-goes-to-a-person",
  "out-of-department-request",
  "unknown-supplier-bill-is-refused",
  "bills-due-answered-from-the-desk",
  "bill-recorded-from-catalogue-lines",
  "month-end-close-summary",
  "payment-approved-and-paid",
  "decline-names-no-decider",
  "unhandled-request-claims-no-hand-off",
];

const company = loadCompanyFacts();

const tempCopy = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "officehum-bookkeeper-"));
  temps.push(directory);
  cpSync(packageDirectory, directory, { recursive: true });
  return directory;
};

describe("bookkeeper package (RASF-3126)", () => {
  it("validates strictly as a package under agents/, with every situation stubbing all ten tools", async () => {
    const validated = await validatePackage(packageDirectory);
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.piDurableRange).toBe("1.3.x");
    expect(Object.keys(validated.value.suites)).toEqual(["evals/situations.json"]);
    const suites = Object.values(validated.value.suites);
    expect(suites.flatMap((suite) => suite.scenarios.map((scenario) => scenario.id))).toEqual(
      SCENARIOS,
    );

    // The suite validator already requires this; restate it so a drift in the rule is caught here.
    for (const suite of suites) {
      for (const scenario of suite.scenarios) {
        expect(Object.keys(scenario.stubs).sort()).toEqual([...TOOLS].sort());
      }
    }
  });

  it("declares the ten tools, the four approvals, the named limits and completion evidence", () => {
    expect(roleManifest.tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(
      roleManifest.tools.filter((tool) => tool.replay === "unsafe").map((tool) => tool.name),
    ).toEqual([
      "create_invoice",
      "send_invoice",
      "send_reminder",
      "record_vendor_bill",
      "pay_vendor_bill",
    ]);
    // The manifest is internally consistent: one approval decision per unsafe tool, none on a safe one.
    expect(validateManifest(roleManifest).ok).toBe(true);

    expect(roleManifest.limits?.large_invoice?.default).toBe(500000);
    // The collections cadence: the business sets its own days through the same limits, so the skill's
    // reference holds the defaults and the code reads what resolved.
    expect(roleManifest.limits?.collections_first_days?.default).toBe(3);
    expect(roleManifest.limits?.collections_second_days?.default).toBe(14);
    expect(roleManifest.limits?.collections_final_days?.default).toBe(30);
    expect(roleManifest.limits?.major_unmatched_item?.default).toBe(50000);
    expect(roleManifest.approvals.map((approval) => approval.id).sort()).toEqual([
      "any_payment",
      "final_notice",
      "large_invoice",
      "new_recipient",
    ]);

    // Every payment waits for a person: no condition can let one through. Recording a bill needs no
    // approval, and says why: the desk prices it and refuses an unknown supplier.
    const payment = roleManifest.approvals.find((approval) => approval.id === "any_payment");
    expect(payment?.tool).toBe("pay_vendor_bill");
    expect(payment?.when).toBeUndefined();
    const record = roleManifest.tools.find((tool) => tool.name === "record_vendor_bill");
    expect(record?.noApproval).toContain("refuses a supplier not on file");

    // The large_invoice approval is what compares a created invoice against the business's set amount.
    const largeInvoice = roleManifest.approvals.find((approval) => approval.id === "large_invoice");
    expect(largeInvoice?.tool).toBe("create_invoice");
    expect(largeInvoice?.when?.[0]?.value).toEqual({ limit: "large_invoice" });

    // The collections skill owns the reminder tool; a final notice is gated on the tone it is sent in.
    expect(roleManifest.tools.find((tool) => tool.name === "send_reminder")?.skill).toBe(
      "collections",
    );
    const finalNotice = roleManifest.approvals.find((approval) => approval.id === "final_notice");
    expect(finalNotice?.tool).toBe("send_reminder");
    expect(finalNotice?.when?.[0]).toMatchObject({ arg: "tone", op: "eq", value: "final" });

    // A refund, a write-off or a dispute is handed off, never accepted; a collections round is accepted
    // and its evidence is a person confirming what the round reported.
    const accepted = new Set(roleManifest.accepts.map((accept) => accept.type));
    expect([...accepted].sort()).toEqual([
      "books.close",
      "collections.run",
      "invoice.create",
      "invoice.question",
      "payables.bill",
    ]);
    const collections = roleManifest.accepts.find((accept) => accept.type === "collections.run");
    expect(collections?.done).toEqual([{ person: true }]);
    for (const accept of roleManifest.accepts) {
      expect(accept.done?.length ?? 0).toBeGreaterThan(0);
    }
    for (const dispatch of roleManifest.dispatches ?? []) {
      expect(accepted.has(dispatch.type)).toBe(false);
    }
  });

  it("refuses a money amount and a missing approval decision, on a copy, leaving the package untouched", () => {
    const copy = tempCopy();
    const copiedAgents = join(copy, "AGENTS.md");

    writeFileSync(copiedAgents, "# Bookkeeper\n\n## You may not\n\nInvoices cost $40.\n");
    const money = checkFourLayers(copy, roleManifest, { strict: true });
    expect(
      money.some(
        (issue) => issue.layer === "context" && issue.message.includes("money amount") === true,
      ),
    ).toBe(true);

    writeFileSync(
      copiedAgents,
      `# Bookkeeper\n\n${"word ".repeat(1001)}\n## You may not\n- nothing\n`,
    );
    const long = checkFourLayers(copy, roleManifest, { strict: true });
    expect(
      long.some((issue) => issue.layer === "context" && issue.message.includes("words") === true),
    ).toBe(true);

    // Strip send_invoice's approval: an unsafe tool with no approval decision is refused.
    const stripped: AgentManifest = {
      ...roleManifest,
      approvals: roleManifest.approvals.filter((approval) => approval.id !== "new_recipient"),
    };
    const refused = validateManifest(stripped);
    expect(refused.ok).toBe(false);
    expect(
      refused.issues.some(
        (issue) =>
          issue.message.includes("send_invoice") && issue.message.includes("no approval decision"),
      ),
    ).toBe(true);

    // The check ran against the copy; the package's own body file was never given the money amount.
    const realAgents = existsSync(join(packageDirectory, "AGENTS.md"))
      ? readFileSync(join(packageDirectory, "AGENTS.md"), "utf8")
      : undefined;
    expect(realAgents?.includes("$40") ?? false).toBe(false);
  });

  it("no longer forbids moving money, and hands refunds, payment details, terms and the close to a person", () => {
    const actions = (roleManifest.mayNot ?? []).map((rule) => rule.action);
    expect(actions.some((action) => /move money/i.test(action))).toBe(false);
    const text = actions.join("\n");
    expect(text).toContain("Issue a refund or a write-off, or settle a dispute");
    expect(text).toContain("bank account, routing number or remittance address");
    expect(text).toContain("repayment plan");
    expect(text).toContain("close a period");
    expect(roleManifest.name).toBe("Accounting");
    expect(roleManifest.id).toBe("bookkeeper");
  });

  it("takes suppliers and the catalogue from the company, and its demo bills and scripts agree", () => {
    expect(financeLead(company)).toBeDefined();
    expect(purchasingLead(company)).toBeDefined();
    const suppliers = new Set(company.suppliers.map((supplier) => supplier.id));
    const items = new Set(company.supplyCatalog.map((item) => item.id));
    for (const bill of demoBills()) expect(suppliers.has(bill.supplierId), bill.id).toBe(true);
    const script = JSON.parse(
      readFileSync(fileURLToPath(new URL("../evals.smoke.json", import.meta.url)), "utf8"),
    ) as Record<
      string,
      { toolCalls?: { name: string; args?: { lines?: { itemId?: string }[] } }[] }[]
    >;
    for (const turns of Object.values(script)) {
      for (const turn of turns) {
        for (const call of turn.toolCalls ?? []) {
          if (call.name !== "record_vendor_bill" && call.name !== "pay_vendor_bill") continue;
          for (const line of call.args?.lines ?? []) {
            expect(items.has(line.itemId ?? ""), line.itemId).toBe(true);
          }
        }
      }
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

    const facts = company as unknown as {
      profile: { legalName: string; tradingName: string; address: { city: string } };
    };
    const names = [
      facts.profile.legalName,
      facts.profile.tradingName,
      facts.profile.address.city,
      ...company.people.flatMap((worker) => [worker.name, worker.name.split(" ")[0] ?? ""]),
    ].filter((fact) => fact !== "");
    // The demonstration desk's bills record who entered them; demo data may name people.
    const demoData = join(packageDirectory, "src", "desk.ts");
    const found: string[] = [];
    for (const file of files.filter((path) => path !== demoData)) {
      const text = readFileSync(file, "utf8");
      for (const fact of names) {
        const pattern = new RegExp(`\\b${fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (pattern.test(text)) found.push(`${relative(packageDirectory, file)}: ${fact}`);
      }
    }
    expect(found).toEqual([]);
  });
});
