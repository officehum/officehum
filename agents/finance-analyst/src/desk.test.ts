/**
 * The finance desk: every figure worked out in integer cents, favourable and unfavourable decided
 * from the line's kind, the closed-period rule, the variance explanation limit, the draft checks
 * (an unexplained variance, a figure the results do not hold, an unlabelled forecast figure), the
 * recipients a release may go to, and a revision that never touches the original budget. Each write
 * is replayed by its request id.
 */

import { describe, expect, it } from "vitest";
import { loadCompanyFacts, money } from "./company.js";
import {
  type BudgetVsActual,
  FinanceDeskError,
  fakeFinanceDesk,
  type Recipient,
  releaseFactsOf,
} from "./desk.js";

const company = loadCompanyFacts();
const LIMIT = 500000;

async function refusalOf(promise: Promise<unknown>): Promise<FinanceDeskError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FinanceDeskError) return error;
    throw error;
  }
  throw new Error("expected the desk to refuse");
}

const line = (report: BudgetVsActual, id: string) => {
  const found = report.lines.find((entry) => entry.lineId === id);
  if (found === undefined) throw new Error(`no line ${id}`);
  return found;
};

describe("periods", () => {
  it("lists January to October as closed and November as open", async () => {
    const periods = await fakeFinanceDesk().listPeriods();
    expect(periods.map((period) => period.id)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
    ]);
    expect(periods.filter((period) => period.status === "open").map((period) => period.id)).toEqual(
      ["2026-11"],
    );
    expect(periods.find((period) => period.id === "2026-10")).toMatchObject({
      name: "October 2026",
      status: "closed",
      closedOn: "2026-11-06",
    });
  });
});

describe("budget against actual", () => {
  it("reports the month and the year to date against the original budget, in cents", async () => {
    const desk = fakeFinanceDesk();
    const october = await desk.budgetVsActual("2026-10", { limitCents: LIMIT });
    expect(october.monthsToDate).toBe(10);
    const recurring = line(october, "recurring-contracts");
    const budgetLine = company.budget.lines.find((entry) => entry.id === "recurring-contracts");
    expect(recurring.month).toEqual({
      budgetCents: budgetLine?.monthlyCents,
      actualCents: (budgetLine?.monthlyCents ?? 0) - 640000,
      varianceCents: -640000,
      variancePercent: -4.7,
      direction: "unfavourable",
    });
    expect(recurring.yearToDate.budgetCents).toBe((budgetLine?.monthlyCents ?? 0) * 10);

    // The year to date is the sum of the closed months, each read on its own.
    let actual = 0;
    for (const month of ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]) {
      const report = await desk.budgetVsActual(`2026-${month}`, { limitCents: LIMIT });
      actual += line(report, "recurring-contracts").month.actualCents;
    }
    expect(recurring.yearToDate.actualCents).toBe(actual);
    expect(recurring.yearToDate.varianceCents).toBe(actual - recurring.yearToDate.budgetCents);
  });

  it("decides favourable or unfavourable from the line's kind, never from the sign alone", async () => {
    const october = await fakeFinanceDesk().budgetVsActual("2026-10", { limitCents: LIMIT });
    // Revenue above budget: favourable. Cost above budget: unfavourable.
    expect(line(october, "deep-clean-floor-care").month).toMatchObject({
      varianceCents: 150000,
      direction: "favourable",
    });
    expect(line(october, "field-wages").month).toMatchObject({
      varianceCents: 520000,
      direction: "unfavourable",
    });
    // Revenue below budget: unfavourable. Cost below budget: favourable.
    expect(line(october, "window-cleaning").month).toMatchObject({
      varianceCents: -70000,
      direction: "unfavourable",
    });
    expect(line(october, "vehicles").month).toMatchObject({
      varianceCents: -110000,
      direction: "favourable",
    });
    expect(line(october, "day-porter").month).toMatchObject({
      varianceCents: 0,
      direction: "on budget",
    });

    // The totals: revenue, costs, and the net result, which is revenue less costs.
    const { revenue, costs, net } = october.totals;
    expect(net.month.actualCents).toBe(revenue.month.actualCents - costs.month.actualCents);
    expect(net.month.budgetCents).toBe(revenue.month.budgetCents - costs.month.budgetCents);
    expect(revenue.month.varianceCents).toBe(-640000 + 150000 - 70000 + 80000 + 30000);
    expect(net.month.direction).toBe(net.month.varianceCents > 0 ? "favourable" : "unfavourable");
  });

  it("gives the prior month's actual beside each line, and none for the first month", async () => {
    const desk = fakeFinanceDesk();
    const september = await desk.budgetVsActual("2026-09", { limitCents: LIMIT });
    const october = await desk.budgetVsActual("2026-10", { limitCents: LIMIT });
    expect(line(october, "field-wages").priorMonthActualCents).toBe(
      line(september, "field-wages").month.actualCents,
    );
    const january = await desk.budgetVsActual("2026-01", { limitCents: LIMIT });
    expect(line(january, "field-wages").priorMonthActualCents).toBeNull();
  });

  it("flags the variances over the limit that have no explanation", async () => {
    const desk = fakeFinanceDesk();
    const october = await desk.budgetVsActual("2026-10", { limitCents: LIMIT });
    // Two lines are over the limit; field wages was explained when the month closed.
    expect(
      october.lines.filter((entry) => entry.needsExplanation).map((entry) => entry.lineId),
    ).toEqual(["recurring-contracts", "field-wages"]);
    expect(line(october, "field-wages").explanation?.kind).toBe("timing");
    expect(october.unexplained).toEqual(["recurring-contracts"]);

    // A variance exactly at the limit is not over it.
    const atLimit = await desk.budgetVsActual("2026-10", { limitCents: 640000 });
    expect(atLimit.unexplained).toEqual([]);
  });

  it("needs every variance explained when no limit resolves", async () => {
    const october = await fakeFinanceDesk().budgetVsActual("2026-10", { limitCents: undefined });
    expect(october.limitCents).toBeNull();
    const nonZero = october.lines
      .filter((entry) => entry.month.varianceCents !== 0)
      .map((entry) => entry.lineId);
    expect(october.lines.filter((entry) => entry.needsExplanation).map((e) => e.lineId)).toEqual(
      nonZero,
    );
    expect(october.unexplained).toEqual(nonZero.filter((id) => id !== "field-wages"));
  });

  it("refuses a month that is not closed, one outside the year, and one that is not a month", async () => {
    const desk = fakeFinanceDesk();
    const open = await refusalOf(desk.budgetVsActual("2026-11", { limitCents: LIMIT }));
    expect(open.code).toBe("period_open");
    expect(open.message).toContain("November 2026 is still open");
    expect((await refusalOf(desk.budgetVsActual("2025-12", { limitCents: LIMIT }))).code).toBe(
      "not_found",
    );
    expect((await refusalOf(desk.budgetVsActual("October", { limitCents: LIMIT }))).code).toBe(
      "invalid",
    );
  });
});

describe("margin by service", () => {
  it("allocates the direct costs to the services exactly and leaves overhead unapportioned", async () => {
    const desk = fakeFinanceDesk();
    const margin = await desk.marginByService("2026-10");
    const october = await desk.budgetVsActual("2026-10", { limitCents: LIMIT });
    expect(margin.overheadApportioned).toBe(false);

    // Every revenue line is a service, at its actual.
    expect(margin.services.map((service) => service.lineId)).toEqual(
      company.budget.lines.filter((entry) => entry.kind === "revenue").map((entry) => entry.id),
    );
    for (const service of margin.services) {
      expect(service.revenueCents).toBe(line(october, service.lineId).month.actualCents);
      expect(service.marginCents).toBe(service.revenueCents - service.directCostCents);
    }
    // The direct costs allocated add up to the direct cost lines' actuals, to the cent.
    const direct = margin.directCostLines.reduce((sum, entry) => sum + entry.actualCents, 0);
    expect(margin.services.reduce((sum, service) => sum + service.directCostCents, 0)).toBe(direct);
    expect(margin.totals.directCostCents).toBe(direct);
    // Margin less unapportioned overhead is the month's net result.
    expect(margin.totals.marginCents - margin.overhead.totalCents).toBe(
      october.totals.net.month.actualCents,
    );
    expect(margin.netResultCents).toBe(october.totals.net.month.actualCents);
  });

  it("refuses a month that is not closed", async () => {
    expect((await refusalOf(fakeFinanceDesk().marginByService("2026-11"))).code).toBe(
      "period_open",
    );
  });
});

describe("receivables aging", () => {
  it("ages every open invoice by its due date as of today", async () => {
    const aging = await fakeFinanceDesk().receivablesAging();
    expect(aging.asOf).toBe("2026-11-09");
    expect(aging.totalCents).toBe(17758000);
    expect(aging.buckets.map((bucket) => [bucket.bucket, bucket.totalCents, bucket.count])).toEqual(
      [
        ["not yet due", 14525000, 6],
        ["1-30", 2230000, 2],
        ["31-60", 530000, 1],
        ["61-90", 275000, 1],
        ["over 90", 198000, 1],
      ],
    );
    expect(aging.buckets.reduce((sum, bucket) => sum + bucket.totalCents, 0)).toBe(
      aging.totalCents,
    );
    expect(aging.invoices.find((invoice) => invoice.invoice === "INV-2280")).toMatchObject({
      daysOverdue: 7,
      bucket: "1-30",
    });
    expect(aging.buckets[0]?.sharePercent).toBe(81.8);
  });
});

describe("cash forecast", () => {
  it("rolls each week's closing balance into the next week's opening, and says it is a forecast", async () => {
    const forecast = await fakeFinanceDesk().cashForecast(6);
    expect(forecast.kind).toBe("forecast");
    expect(forecast.weeks).toHaveLength(6);
    expect(forecast.weeks[0]).toMatchObject({
      week: 1,
      from: "2026-11-09",
      to: "2026-11-15",
      openingCents: 9640000,
      receiptsCents: 1620000,
      paymentsCents: 6664000,
      closingCents: 4596000,
    });
    for (const [index, week] of forecast.weeks.entries()) {
      expect(week.closingCents).toBe(week.openingCents + week.receiptsCents - week.paymentsCents);
      const next = forecast.weeks[index + 1];
      if (next !== undefined) expect(next.openingCents).toBe(week.closingCents);
    }
    expect(forecast.lowest).toEqual({ week: 5, closingCents: 3704000 });
    expect(forecast.shortfallWeeks).toEqual([]);
    expect(forecast.assumptions.join(" ")).toContain("due date");
    expect(forecast.assumptions.join(" ")).toContain("Overdue");
  });

  it("finds a shortfall further out, and refuses a horizon it cannot forecast", async () => {
    const desk = fakeFinanceDesk();
    const long = await desk.cashForecast(13);
    expect(long.weeks).toHaveLength(13);
    expect(long.shortfallWeeks[0]).toBe(7);
    // A shorter forecast is the start of the longer one.
    expect((await desk.cashForecast(6)).weeks).toEqual(long.weeks.slice(0, 6));
    expect((await refusalOf(desk.cashForecast(0))).code).toBe("invalid");
    expect((await refusalOf(desk.cashForecast(14))).code).toBe("invalid");
  });
});

describe("variance explanations", () => {
  const input = {
    period: "2026-10",
    lineId: "recurring-contracts",
    cause: "A client's contract ended on 30 September and was not replaced",
    kind: "permanent" as const,
    givenBy: company.people[1]?.name ?? "",
  };

  it("records an explanation as the person gave it, once per request", async () => {
    const desk = fakeFinanceDesk();
    const recorded = await desk.recordVarianceExplanation(input, { requestId: "x1" });
    expect(recorded).toMatchObject({
      period: "2026-10",
      lineId: "recurring-contracts",
      varianceCents: -640000,
      direction: "unfavourable",
      kind: "permanent",
      givenBy: { name: company.people[1]?.name, title: company.people[1]?.title },
      recordedOn: "2026-11-09",
    });
    const again = await desk.recordVarianceExplanation(
      { ...input, cause: "something else" },
      { requestId: "x1" },
    );
    expect(again).toEqual(recorded);
    expect((await desk.listExplanations("2026-10")).map((entry) => entry.lineId)).toEqual([
      "field-wages",
      "recurring-contracts",
    ]);
    expect((await desk.budgetVsActual("2026-10", { limitCents: LIMIT })).unexplained).toEqual([]);
  });

  it("refuses someone not on the company record, an open month, an unknown line and a bad kind", async () => {
    const desk = fakeFinanceDesk();
    const stranger = await refusalOf(
      desk.recordVarianceExplanation({ ...input, givenBy: "Pat Lender" }, { requestId: "x2" }),
    );
    expect(stranger.code).toBe("unknown_person");
    expect(
      (
        await refusalOf(
          desk.recordVarianceExplanation({ ...input, period: "2026-11" }, { requestId: "x3" }),
        )
      ).code,
    ).toBe("period_open");
    expect(
      (
        await refusalOf(
          desk.recordVarianceExplanation({ ...input, lineId: "marketing" }, { requestId: "x4" }),
        )
      ).code,
    ).toBe("not_found");
    expect(
      (
        await refusalOf(
          desk.recordVarianceExplanation(
            { ...input, kind: "one-off" as never },
            { requestId: "x5" },
          ),
        )
      ).code,
    ).toBe("invalid");
    expect(
      (
        await refusalOf(
          desk.recordVarianceExplanation({ ...input, cause: " " }, { requestId: "x6" }),
        )
      ).code,
    ).toBe("invalid");
  });
});

describe("report drafts", () => {
  it("refuses a draft while a variance over the limit has no explanation, then saves it", async () => {
    const desk = fakeFinanceDesk();
    const draft = { title: "October 2026 management report", period: "2026-10", commentary: "" };
    const refused = await refusalOf(
      desk.saveReportDraft(
        { ...draft, commentary: "Revenue was below budget." },
        { requestId: "d1", limitCents: LIMIT },
      ),
    );
    expect(refused.code).toBe("unexplained_variance");
    expect(refused.message).toContain("Recurring janitorial contracts");
    expect(await desk.listDrafts()).toHaveLength(2);

    await desk.recordVarianceExplanation(
      {
        period: "2026-10",
        lineId: "recurring-contracts",
        cause: "A contract ended",
        kind: "permanent",
        givenBy: company.people[1]?.name ?? "",
      },
      { requestId: "e1" },
    );
    const saved = await desk.saveReportDraft(
      { ...draft, commentary: "Revenue was below budget." },
      { requestId: "d2", limitCents: LIMIT },
    );
    expect(saved).toMatchObject({ id: "RD-103", status: "draft", period: "2026-10" });
    // A replay is answered with the same draft.
    expect(
      await desk.saveReportDraft(
        { ...draft, commentary: "Revenue was below budget." },
        { requestId: "d2", limitCents: LIMIT },
      ),
    ).toEqual(saved);
    expect(await desk.listDrafts()).toHaveLength(3);
  });

  it("needs every variance explained when no limit resolves", async () => {
    const refused = await refusalOf(
      fakeFinanceDesk().saveReportDraft(
        { title: "September", period: "2026-09", commentary: "A quiet month." },
        { requestId: "d3", limitCents: undefined },
      ),
    );
    expect(refused.code).toBe("unexplained_variance");
  });

  it("refuses a money figure the computed results do not hold, naming it", async () => {
    const desk = fakeFinanceDesk();
    const refused = await refusalOf(
      desk.saveReportDraft(
        {
          title: "September 2026 management report",
          period: "2026-09",
          commentary: "Revenue reached $190,000 and costs were $1.2 million.",
        },
        { requestId: "d4", limitCents: LIMIT },
      ),
    );
    expect(refused.code).toBe("figure_not_in_results");
    expect(refused.message).toContain('"$190,000"');
    expect(refused.message).toContain('"$1.2 million"');
  });

  it("accepts figures from the month, the year to date, the prior month, margins and receivables", async () => {
    const desk = fakeFinanceDesk();
    const september = await desk.budgetVsActual("2026-09", { limitCents: LIMIT });
    const august = await desk.budgetVsActual("2026-08", { limitCents: LIMIT });
    const margin = await desk.marginByService("2026-09");
    const aging = await desk.receivablesAging();
    const deep = line(september, "deep-clean-floor-care");
    const commentary = [
      `Revenue was ${money(september.totals.revenue.month.actualCents)}, against ${money(september.totals.revenue.month.budgetCents)} budgeted.`,
      // A variance may be written without its sign, and a whole-dollar figure without its cents.
      `Deep clean was ${money(Math.abs(deep.month.varianceCents)).replace(".00", "")} above budget.`,
      `Year to date the net result is ${money(september.totals.net.yearToDate.actualCents)}.`,
      // The month before is a comparative: its own variances count, not only its actuals.
      `In August revenue was ${money(august.totals.revenue.month.actualCents)}, ${money(Math.abs(august.totals.revenue.month.varianceCents))} from budget.`,
      `Gross margin was ${money(margin.totals.marginCents)}.`,
      `Receivables stand at ${money(aging.totalCents)}.`,
    ].join(" ");
    const saved = await desk.saveReportDraft(
      { title: "September 2026 management report", period: "2026-09", commentary },
      { requestId: "d5", limitCents: LIMIT },
    );
    expect(saved.commentary).toBe(commentary);
  });

  it("refuses a forecast figure that is not labelled as an estimate", async () => {
    const desk = fakeFinanceDesk();
    const forecast = await desk.cashForecast(6);
    const lowest = money(forecast.lowest.closingCents);
    const refused = await refusalOf(
      desk.saveReportDraft(
        {
          title: "September",
          period: "2026-09",
          commentary: `Cash will fall to ${lowest} in December.`,
        },
        { requestId: "d6", limitCents: LIMIT },
      ),
    );
    expect(refused.code).toBe("forecast_not_labelled");
    expect(refused.message).toContain(lowest);

    const saved = await desk.saveReportDraft(
      {
        title: "September",
        period: "2026-09",
        commentary: `On the cash forecast, an estimate only, cash is projected to fall to ${lowest} in December.`,
      },
      { requestId: "d7", limitCents: LIMIT },
    );
    expect(saved.status).toBe("draft");
  });

  it("names every problem at once, and refuses an open month", async () => {
    const desk = fakeFinanceDesk();
    const refused = await refusalOf(
      desk.saveReportDraft(
        { title: "October", period: "2026-10", commentary: "Revenue was $999,999." },
        { requestId: "d8", limitCents: LIMIT },
      ),
    );
    expect(refused.code).toBe("unexplained_variance");
    expect(refused.message).toContain('"$999,999"');
    expect(
      (
        await refusalOf(
          desk.saveReportDraft(
            { title: "November", period: "2026-11", commentary: "Early days." },
            { requestId: "d9", limitCents: LIMIT },
          ),
        )
      ).code,
    ).toBe("period_open");
  });
});

describe("releasing a report", () => {
  const approver = company.people.find((person) => person.id === company.budget.approverId);

  it("resolves recipients from the company's people, and refuses anyone outside it", async () => {
    const desk = fakeFinanceDesk();
    const facts = await desk.releaseFacts({
      draftId: "RD-102",
      recipients: [approver?.name ?? "", company.people[4]?.email ?? ""],
    });
    expect((facts.recipients as Recipient[]).map((recipient) => recipient.name)).toEqual([
      approver?.name,
      company.people[4]?.name,
    ]);
    const outside = await refusalOf(
      desk.releaseFacts({
        draftId: "RD-102",
        recipients: [approver?.name ?? "", "loans@riverbank.example"],
      }),
    );
    expect(outside.code).toBe("outside_recipient");
    expect(outside.message).toContain('"loans@riverbank.example"');
    expect((await refusalOf(desk.releaseFacts({ draftId: "RD-102", recipients: [] }))).code).toBe(
      "invalid",
    );
    expect(
      (
        await refusalOf(
          desk.releaseFacts({ draftId: "RD-101", recipients: [approver?.name ?? ""] }),
        )
      ).code,
    ).toBe("already_released");
    expect(
      (
        await refusalOf(
          desk.releaseFacts({ draftId: "RD-999", recipients: [approver?.name ?? ""] }),
        )
      ).code,
    ).toBe("not_found");
  });

  it("releases exactly what a person approved, and refuses what changed since", async () => {
    const desk = fakeFinanceDesk();
    const request = { draftId: "RD-102", recipients: [approver?.name ?? ""] };
    const facts = await desk.releaseFacts(request);
    const changed = await refusalOf(
      desk.releaseReport(
        { ...request, approved: { ...facts, recipients: [] } },
        { requestId: "r1" },
      ),
    );
    expect(changed.code).toBe("facts_changed");
    const released = await desk.releaseReport(
      { ...request, approved: { ...facts } },
      { requestId: "r2" },
    );
    expect(released).toMatchObject({ id: "RD-102", status: "released", releasedOn: "2026-11-09" });
    expect(releaseFactsOf(released, released.releasedTo)).toBeDefined();
    expect(
      await desk.releaseReport({ ...request, approved: { ...facts } }, { requestId: "r2" }),
    ).toEqual(released);
  });
});

describe("budget revisions", () => {
  it("opens a new forecast version with the amount the approver entered, and the original budget never changes", async () => {
    const desk = fakeFinanceDesk();
    const before = await desk.budgetVsActual("2026-10", { limitCents: LIMIT });
    const request = { lineId: "recurring-contracts", reason: "A contract ended in September" };
    const facts = await desk.revisionFacts(request);
    expect(facts).toMatchObject({
      lineId: "recurring-contracts",
      originalMonthlyCents: 13500000,
      basedOn: "FV-1",
    });
    const entered = { amountCents: 12860000, enteredBy: "dana" };
    const version = await desk.reviseForecast(
      { ...request, approved: { ...facts }, ...entered },
      { requestId: "v1" },
    );
    expect(version).toMatchObject({
      id: "FV-2",
      basedOn: "FV-1",
      revision: {
        lineId: "recurring-contracts",
        originalMonthlyCents: 13500000,
        amountCents: 12860000,
        amountEnteredBy: "dana",
      },
    });
    // A replay of the same request returns what was written, whatever amount it carries.
    expect(
      await desk.reviseForecast(
        { ...request, approved: { ...facts }, amountCents: 1, enteredBy: "someone" },
        { requestId: "v1" },
      ),
    ).toEqual(version);
    expect((await desk.listForecastVersions()).map((entry) => entry.id)).toEqual(["FV-1", "FV-2"]);
    expect(await desk.budgetVsActual("2026-10", { limitCents: LIMIT })).toEqual(before);
    expect(company.budget.lines[0]?.monthlyCents).toBe(13500000);
  });

  it("refuses a reason that carries an amount: the person approving enters it", async () => {
    const refused = await refusalOf(
      fakeFinanceDesk().revisionFacts({
        lineId: "recurring-contracts",
        reason: "Lower it to $128,600 a month after the lost contract",
      }),
    );
    expect(refused.code).toBe("amount_in_reason");
    expect(refused.message).toContain('"$128,600"');
  });

  it("refuses an unknown line, an empty reason and facts that changed", async () => {
    const desk = fakeFinanceDesk();
    expect((await refusalOf(desk.revisionFacts({ lineId: "bonus", reason: "x" }))).code).toBe(
      "not_found",
    );
    expect((await refusalOf(desk.revisionFacts({ lineId: "supplies", reason: "  " }))).code).toBe(
      "invalid",
    );
    const facts = await desk.revisionFacts({ lineId: "supplies", reason: "Prices rose" });
    const entered = { amountCents: 1200000, enteredBy: "dana" };
    expect(
      (
        await refusalOf(
          desk.reviseForecast(
            { lineId: "supplies", reason: "Prices rose a lot", approved: facts, ...entered },
            { requestId: "v2" },
          ),
        )
      ).code,
    ).toBe("facts_changed");
  });

  it("refuses an amount that is not whole cents of zero or more, and keeps a zero budget", async () => {
    const desk = fakeFinanceDesk();
    const request = { lineId: "supplies", reason: "Prices rose" };
    const approved = await desk.revisionFacts(request);
    for (const amountCents of [-1, 12.5, Number.NaN]) {
      expect(
        (
          await refusalOf(
            desk.reviseForecast(
              { ...request, approved, amountCents, enteredBy: "dana" },
              { requestId: `bad-${amountCents}` },
            ),
          )
        ).code,
      ).toBe("invalid");
    }
    expect(await desk.listForecastVersions()).toHaveLength(1);
    const zero = await desk.reviseForecast(
      { ...request, approved, amountCents: 0, enteredBy: null },
      { requestId: "zero" },
    );
    expect(zero.revision).toMatchObject({ amountCents: 0, amountEnteredBy: null });
  });
});
