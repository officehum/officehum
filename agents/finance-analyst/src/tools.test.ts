/**
 * One block per tool, against `fakeFinanceDesk` and the company facts generated into this package,
 * through the registrations the factory builds and with the durable call identity Pi Durable hands to
 * `execute`. Every unsafe tool is replayed under the same call id here and must write once. No
 * network, no model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  APPROVED_FACTS_ARG,
  APPROVED_VALUE_ARG,
  type ApprovalCallIdentity,
  type HookContext,
} from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { budgetApprover, loadCompanyFacts, money } from "./company.js";
import { type FinanceDesk, fakeFinanceDesk } from "./desk.js";
import { type FinanceToolset, financeTools } from "./tools.js";

const company = loadCompanyFacts();
const LIMITS = () => ({ variance_explanation_limit_cents: 500000 });
const approver = budgetApprover(company);
const colleague = company.people.find((person) => person.id !== company.budget.approverId);

const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;
const HOOK_CONTEXT = {} as HookContext;
const CALL_IDENTITY: ApprovalCallIdentity = { conversationId: "conversation-1", taskId: "task-1" };

const tools = (
  desk: FinanceDesk | undefined,
  limits: () => Readonly<Record<string, number>> = LIMITS,
): FinanceToolset => financeTools({ desk, company, limits });

function text(result: { output?: readonly unknown[] }): string {
  return (result.output ?? [])
    .map((block) => (block as { type?: string; text?: string }).text ?? "")
    .join("\n");
}

function details(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

async function run(
  set: FinanceToolset,
  name: keyof FinanceToolset,
  args: Record<string, unknown>,
  callId: string = name,
) {
  const tool = set[name] as { execute: (a: never, c: never, x: never) => Promise<unknown> };
  return (await tool.execute(args as never, call(callId), BACKGROUND_CONTEXT as never)) as {
    output?: readonly unknown[];
  };
}

describe("every tool", () => {
  it("takes no amount from the model", () => {
    const set = tools(fakeFinanceDesk());
    // The approved value is the gate's argument, set from what a person entered; the gate strips
    // whatever the model sends under it.
    const gates = [APPROVED_FACTS_ARG, APPROVED_VALUE_ARG];
    for (const name of Object.keys(set) as (keyof FinanceToolset)[]) {
      const tool = set[name] as { parameters?: { properties?: Record<string, unknown> } };
      for (const key of Object.keys(tool.parameters?.properties ?? {})) {
        if (gates.includes(key)) continue;
        expect(key, `${name}.${key}`).not.toMatch(/amount|cents|figure|value|budget$/i);
      }
    }
    const revision = set.requestBudgetRevision.parameters as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(revision.properties).sort()).toEqual(
      ["lineId", "reason", APPROVED_FACTS_ARG, APPROVED_VALUE_ARG].sort(),
    );
  });
});

describe("list_periods", () => {
  it("lists the months, the drafts, the explanations and the forecast versions", async () => {
    const result = await run(tools(fakeFinanceDesk()), "listPeriods", {});
    const said = text(result);
    expect(said).toContain("2026-10 — October 2026 — closed 2026-11-06");
    expect(said).toContain("2026-11 — November 2026 — open");
    expect(said).toContain("RD-102 — September 2026 management report — 2026-09 — draft");
    expect(said).toContain("2026-10 field-wages");
    expect(said).toContain("FV-1");
  });
});

describe("budget_vs_actual", () => {
  it("states every variance with its value, its percentage and the desk's favourable or unfavourable", async () => {
    const result = await run(tools(fakeFinanceDesk()), "budgetVsActual", { period: "2026-10" });
    const said = text(result);
    expect(said).toContain("against the original budget");
    expect(said).toContain(
      `Recurring janitorial contracts (recurring-contracts, revenue): budget ${money(13500000)}, actual ${money(12860000)}, variance -${money(640000)} (-4.7%), unfavourable`,
    );
    expect(said).toContain("variance $1,500.00 (8.3%), favourable");
    expect(said).toContain("Vans, fuel and upkeep (vehicles, cost): budget $6,500.00");
    expect(said).toContain("variance -$1,100.00 (-16.9%), favourable");
    expect(said).toContain("Year to date (10 months, January to October 2026)");
    expect(said).toContain("prior month actual");
    expect(said).toContain("NOT EXPLAINED");
    expect(said).toContain("record_variance_explanation");
    expect(details(result).unexplained).toEqual(["recurring-contracts"]);
  });

  it("reads the explanation limit at every call", async () => {
    let limit = 500000;
    const set = tools(fakeFinanceDesk(), () => ({ variance_explanation_limit_cents: limit }));
    expect(details(await run(set, "budgetVsActual", { period: "2026-10" })).unexplained).toEqual([
      "recurring-contracts",
    ]);
    limit = 700000;
    const looser = await run(set, "budgetVsActual", { period: "2026-10" }, "b2");
    expect(details(looser).unexplained).toEqual([]);
    expect(text(looser)).toContain("over the $7,000.00 limit");

    const none = await run(
      tools(fakeFinanceDesk(), () => ({})),
      "budgetVsActual",
      {
        period: "2026-10",
      },
    );
    expect(text(none)).toContain("No variance explanation limit is set");
    expect((details(none).unexplained as string[]).length).toBeGreaterThan(1);
  });

  it("refuses a month that is not closed, and says so", async () => {
    const result = await run(tools(fakeFinanceDesk()), "budgetVsActual", { period: "2026-11" });
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("period_open");
    expect(text(result)).toContain("November 2026 is still open");
    expect(text(result)).toContain("Next:");
  });
});

describe("margin_by_service", () => {
  it("gives each service's margin and says overhead is not apportioned", async () => {
    const result = await run(tools(fakeFinanceDesk()), "marginByService", { period: "2026-10" });
    const said = text(result);
    expect(said).toContain("Recurring janitorial contracts: revenue");
    expect(said).toContain("gross margin");
    expect(said).toContain("Overhead is not apportioned to the services");
    expect(said).toContain("Net result after overhead");
  });
});

describe("receivables_aging", () => {
  it("ages by due date as of today", async () => {
    const said = text(await run(tools(fakeFinanceDesk()), "receivablesAging", {}));
    expect(said).toContain("as of 2026-11-09, by due date");
    expect(said).toContain("Not yet due: $145,250.00 (6 invoices, 81.8%)");
    expect(said).toContain("Total open: $177,580.00");
    expect(said).toContain(
      "INV-2280 — Burnside Property Group — due 2026-11-02 — $18,400.00 — 7 days overdue",
    );
  });
});

describe("cash_forecast", () => {
  it("labels the forecast an estimate and states its assumptions", async () => {
    const result = await run(tools(fakeFinanceDesk()), "cashForecast", {});
    const said = text(result);
    expect(said).toContain("CASH FORECAST — an estimate, not a fact");
    expect(said).toContain("Week 1 (2026-11-09 to 2026-11-15): opening $96,400.00");
    expect(said).toContain("closing $45,960.00");
    expect(said).toContain("Assumptions:");
    expect(said).toContain("Overdue invoices are left out");
    expect((details(result).weeks as unknown[]).length).toBe(6);
  });

  it("names a forecast shortfall as a person's decision", async () => {
    const said = text(await run(tools(fakeFinanceDesk()), "cashForecast", { weeks: 13 }));
    expect(said).toContain("below zero in weeks 7, 8, 9");
    expect(said).toContain(approver?.name ?? "missing");
  });
});

describe("record_variance_explanation", () => {
  const args = {
    period: "2026-10",
    lineId: "recurring-contracts",
    cause: "A client's contract ended on 30 September",
    kind: "permanent",
    givenBy: colleague?.name ?? "",
  };

  it("records the explanation as given, and writes once on replay", async () => {
    const desk = fakeFinanceDesk();
    const set = tools(desk);
    const first = await run(set, "recordVarianceExplanation", args, "e1");
    expect(text(first)).toContain(
      `Recorded the explanation of Recurring janitorial contracts for October 2026 (variance -${money(640000)}, unfavourable): permanent — A client's contract ended on 30 September — given by ${colleague?.name}, ${colleague?.title}.`,
    );
    await run(set, "recordVarianceExplanation", { ...args, cause: "changed" }, "e1");
    const recorded = await desk.listExplanations("2026-10");
    expect(recorded.filter((entry) => entry.lineId === "recurring-contracts")).toHaveLength(1);
    expect(recorded.find((entry) => entry.lineId === "recurring-contracts")?.cause).toBe(
      args.cause,
    );
  });

  it("refuses someone not on the company record", async () => {
    const result = await run(tools(fakeFinanceDesk()), "recordVarianceExplanation", {
      ...args,
      givenBy: "the bank manager",
    });
    expect(details(result).code).toBe("unknown_person");
  });
});

describe("save_report_draft", () => {
  const draft = {
    title: "October 2026 management report",
    period: "2026-10",
    commentary: "Revenue was below budget in October.",
  };

  it("refuses a draft while an over-limit variance is unexplained, naming the next step", async () => {
    const result = await run(tools(fakeFinanceDesk()), "saveReportDraft", draft);
    expect(details(result).code).toBe("unexplained_variance");
    expect(text(result)).toContain("Recurring janitorial contracts");
    expect(text(result)).toContain("Next: ask the budget holder");
    expect(text(result)).toContain("record_variance_explanation");
  });

  it("reads the limit at every call", async () => {
    let limit = 500000;
    const set = tools(fakeFinanceDesk(), () => ({ variance_explanation_limit_cents: limit }));
    expect(details(await run(set, "saveReportDraft", draft, "s1")).code).toBe(
      "unexplained_variance",
    );
    limit = 700000;
    const saved = await run(set, "saveReportDraft", draft, "s2");
    expect(text(saved)).toContain("Saved RD-103");
  });

  it("names a figure the results do not hold, and points to the computed results", async () => {
    const result = await run(tools(fakeFinanceDesk()), "saveReportDraft", {
      ...draft,
      period: "2026-09",
      commentary: "Revenue reached $190,000.",
    });
    expect(details(result).code).toBe("figure_not_in_results");
    expect(text(result)).toContain('"$190,000"');
    expect(text(result)).toContain("budget_vs_actual");
  });

  it("saves a checked draft once on replay, and says nothing was sent", async () => {
    const desk = fakeFinanceDesk();
    const set = tools(desk);
    const args = { ...draft, period: "2026-09", title: "September notes" };
    const first = await run(set, "saveReportDraft", args, "s3");
    expect(text(first)).toContain("Saved RD-103");
    expect(text(first)).toContain("Nothing has been released or sent");
    await run(set, "saveReportDraft", args, "s3");
    expect(await desk.listDrafts()).toHaveLength(3);
  });
});

describe("request_report_release", () => {
  it("asks nobody when a recipient is outside the company", async () => {
    const set = tools(fakeFinanceDesk());
    await expect(
      set.releaseApprovalFacts(
        { draftId: "RD-102", recipients: ["loans@riverbank.example"] },
        HOOK_CONTEXT,
        CALL_IDENTITY,
      ),
    ).rejects.toThrow(/not one of the company's people[\s\S]*Nothing was put to a person/);
  });

  it("shows the person the draft and its recipients, and releases only with approved facts", async () => {
    const desk = fakeFinanceDesk();
    const set = tools(desk);
    const args = { draftId: "RD-102", recipients: [approver?.email ?? ""] };
    const facts = await set.releaseApprovalFacts(args, HOOK_CONTEXT, CALL_IDENTITY);
    expect(facts.summary).toContain("Release RD-102 (September 2026 management report, 2026-09)");
    expect(facts.summary).toContain(`${approver?.name}, ${approver?.title}`);

    const unapproved = await run(set, "requestReportRelease", args, "r1");
    expect(details(unapproved).code).toBe("not_approved");
    expect((await desk.listDrafts()).find((entry) => entry.id === "RD-102")?.status).toBe("draft");

    const released = await run(
      set,
      "requestReportRelease",
      { ...args, [APPROVED_FACTS_ARG]: facts.facts },
      "r2",
    );
    expect(text(released)).toContain(`Approved and released: RD-102 to ${approver?.name}`);
    expect((await desk.listDrafts()).find((entry) => entry.id === "RD-102")?.status).toBe(
      "released",
    );
  });
});

describe("request_budget_revision", () => {
  it("puts the line and reason to a person, with no amount, and opens a forecast version at the amount they entered", async () => {
    const desk = fakeFinanceDesk();
    const set = tools(desk);
    const args = { lineId: "recurring-contracts", reason: "A client's contract ended" };
    const facts = await set.revisionApprovalFacts(args, HOOK_CONTEXT, CALL_IDENTITY);
    expect(facts.summary).toContain("Revise the forecast for Recurring janitorial contracts");
    expect(facts.summary).toContain(
      "No amount is proposed: you enter the line's revised monthly budget when you approve",
    );
    expect(facts.summary).toContain("original budget stays");

    const unapproved = await run(set, "requestBudgetRevision", args, "v1");
    expect(details(unapproved).code).toBe("not_approved");
    // Approved facts without the person's figure write nothing: the tool never falls back.
    const noValue = await run(
      set,
      "requestBudgetRevision",
      { ...args, [APPROVED_FACTS_ARG]: facts.facts },
      "v2",
    );
    expect(details(noValue).code).toBe("not_approved");
    expect(text(noValue)).toContain("carries no revised amount a person entered");
    expect(await desk.listForecastVersions()).toHaveLength(1);

    const value = { name: "revisedCents", cents: 12_860_000, by: "dana" };
    const opened = await run(
      set,
      "requestBudgetRevision",
      { ...args, [APPROVED_FACTS_ARG]: facts.facts, [APPROVED_VALUE_ARG]: value },
      "v3",
    );
    expect(text(opened)).toContain(
      `Approved: forecast version FV-2 opened from FV-1 for Recurring janitorial contracts at ${money(12_860_000)} a month, entered by dana`,
    );
    expect(text(opened)).toContain("the original budget is unchanged");
    expect((await desk.listForecastVersions()).at(-1)?.revision).toMatchObject({
      amountCents: 12_860_000,
      amountEnteredBy: "dana",
    });
    // A replay under the same call id writes nothing more.
    await run(
      set,
      "requestBudgetRevision",
      { ...args, [APPROVED_FACTS_ARG]: facts.facts, [APPROVED_VALUE_ARG]: value },
      "v3",
    );
    expect(await desk.listForecastVersions()).toHaveLength(2);
    // And list_periods says what was entered and by whom.
    expect(text(await run(set, "listPeriods", {}, "l1"))).toContain(
      `Recurring janitorial contracts revised to ${money(12_860_000)} a month, entered by dana`,
    );
  });

  it("asks nobody about a line that is not in the budget", async () => {
    await expect(
      tools(fakeFinanceDesk()).revisionApprovalFacts(
        { lineId: "marketing", reason: "More ads" },
        HOOK_CONTEXT,
        CALL_IDENTITY,
      ),
    ).rejects.toThrow(/No budget line[\s\S]*Nothing was put to a person/);
  });
});

describe("read_company", () => {
  it("states the budget and the limit the desk enforces", async () => {
    let limit = 500000;
    const set = tools(undefined, () => ({ variance_explanation_limit_cents: limit }));
    const said = text(await run(set, "readCompany", { section: "budget" }));
    expect(said).toContain("Fiscal year 2026");
    expect(said).toContain(`approved by ${approver?.name}, ${approver?.title}`);
    expect(said).toContain(
      "recurring-contracts — Recurring janitorial contracts — revenue — $135,000.00 a month",
    );
    expect(said).toContain("over $5,000.00 needs an explanation");
    limit = 250000;
    expect(text(await run(set, "readCompany", { section: "budget" }, "c2"))).toContain(
      "over $2,500.00 needs an explanation",
    );
  });
});

describe("with no desk bound", () => {
  it("refuses to read, and says how to bind a desk", async () => {
    await expect(run(tools(undefined), "budgetVsActual", { period: "2026-10" })).rejects.toThrow(
      "No finance desk is bound",
    );
  });
});
