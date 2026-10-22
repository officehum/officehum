import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentManifest,
  checkFourLayers,
  validateManifest,
  validatePackage,
} from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import manifest from "../officehum.json" with { type: "json" };

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
/** The JSON import's inferred type is widened; the checks want the SDK's manifest type. */
const roleManifest = manifest as unknown as AgentManifest;

/** The six tools the role declares, in manifest order. Every eval scenario must stub all of them. */
const TOOLS = [
  "find_customer",
  "list_invoices",
  "get_invoice",
  "create_invoice",
  "send_invoice",
  "send_reminder",
];

/** The brief's situations, one scenario each, plus the collections round (RASF-3128). */
const SCENARIOS = [
  "invoices-completed-job",
  "invoice-over-limit-waits-for-approval",
  "refund-request-goes-to-a-person",
  "injected-instruction-changes-nothing",
  "collections-sends-one-reminder",
  "collections-run-every-overdue-invoice",
  "billing-question-answered-with-figures",
];

const tempCopy = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "officehum-bookkeeper-"));
  temps.push(directory);
  cpSync(packageDirectory, directory, { recursive: true });
  return directory;
};

describe("bookkeeper package (RASF-3126)", () => {
  it("validates strictly as a package under agents/, with the brief's six situations", async () => {
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

  it("declares the six tools, the three approvals, the named limit and completion evidence", () => {
    expect(roleManifest.tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(
      roleManifest.tools.filter((tool) => tool.replay === "unsafe").map((tool) => tool.name),
    ).toEqual(["create_invoice", "send_invoice", "send_reminder"]);
    // The manifest is internally consistent: one approval decision per unsafe tool, none on a safe one.
    expect(validateManifest(roleManifest).ok).toBe(true);

    expect(roleManifest.limits?.large_invoice?.default).toBe(500000);
    // The collections cadence: the business sets its own days through the same limits, so the skill's
    // reference holds the defaults and the code reads what resolved.
    expect(roleManifest.limits?.collections_first_days?.default).toBe(3);
    expect(roleManifest.limits?.collections_second_days?.default).toBe(14);
    expect(roleManifest.limits?.collections_final_days?.default).toBe(30);
    expect(roleManifest.approvals.map((approval) => approval.id).sort()).toEqual([
      "final_notice",
      "large_invoice",
      "new_recipient",
    ]);

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
    expect([...accepted].sort()).toEqual(["collections.run", "invoice.create", "invoice.question"]);
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
});
