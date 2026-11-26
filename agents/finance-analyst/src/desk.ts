/**
 * The desk: the finance system this role reads the closed months, receivables, bills and payroll
 * dates from, and keeps its variance explanations, report drafts and forecast versions in.
 *
 * A host binds its own — an accounting package's reporting API, a planning tool, a spreadsheet with
 * an API — and the role never knows the difference. `fakeFinanceDesk` is what ships with the package:
 * ten closed months of actuals for the company's own budget lines, one open month, open receivables,
 * bills and payroll dates, so a test, an eval or a first run needs no network and no credential.
 *
 * The desk owns every number. Every amount is integer cents, every variance is actual less budget,
 * and whether it is favourable is decided here from the line's kind. It refuses a month that is not
 * closed, and it checks a report draft before keeping it: no variance over the limit without an
 * explanation, no money figure the computed results do not hold, no forecast figure that is not
 * labelled as an estimate. A release goes only to the company's own people, and a revision opens a
 * forecast version without touching the original budget. A refusal carries a code, and the tools
 * turn the code into the next step.
 */

import { addDays, companyData, daysBetween, localDate, sameFacts } from "@officehum/sdk";
import type { BudgetLine, CompanyFacts, LineKind, Person } from "./company.js";
import { budgetApprover, loadCompanyFacts, money, personByRecipient } from "./company.js";

/** One month of the fiscal year. `closed`: the books are finished and the month can be reported. */
export interface Period {
  readonly id: string;
  readonly name: string;
  readonly status: "closed" | "open";
  readonly closedOn: string | null;
}

/** What a variance means for the business, decided from the line's kind. */
export type Direction = "favourable" | "unfavourable" | "on budget";

/** A budget, an actual and the variance between them (actual less budget), all in cents. */
export interface VarianceFigure {
  readonly budgetCents: number;
  readonly actualCents: number;
  readonly varianceCents: number;
  /** The variance over the budget, as a percentage to one decimal place; `null` on a zero budget. */
  readonly variancePercent: number | null;
  readonly direction: Direction;
}

export type ExplanationKind = "timing" | "permanent";
export const EXPLANATION_KINDS: readonly ExplanationKind[] = ["timing", "permanent"];

/** Why a closed month's line differed from the budget, as the person who gave it said. */
export interface VarianceExplanation {
  readonly period: string;
  readonly lineId: string;
  readonly lineName: string;
  readonly varianceCents: number;
  readonly direction: Direction;
  readonly cause: string;
  readonly kind: ExplanationKind;
  readonly givenBy: { readonly name: string; readonly title: string };
  readonly recordedOn: string;
}

export interface LineResult {
  readonly lineId: string;
  readonly name: string;
  readonly kind: LineKind;
  readonly month: VarianceFigure;
  readonly yearToDate: VarianceFigure;
  /** The prior month's actual, the comparative; `null` for the first month of the year. */
  readonly priorMonthActualCents: number | null;
  /** The month's variance is over the limit (any variance, with no limit) and must be explained. */
  readonly needsExplanation: boolean;
  readonly explanation: VarianceExplanation | null;
}

export interface TotalResult {
  readonly name: string;
  readonly month: VarianceFigure;
  readonly yearToDate: VarianceFigure;
  readonly priorMonthActualCents: number | null;
}

export interface BudgetVsActual {
  readonly period: string;
  readonly periodName: string;
  readonly fiscalYear: number;
  readonly monthsToDate: number;
  /** The variance explanation limit this report was judged against; `null` when none resolved. */
  readonly limitCents: number | null;
  readonly lines: readonly LineResult[];
  readonly totals: {
    readonly revenue: TotalResult;
    readonly costs: TotalResult;
    /** Revenue less costs: more than budgeted is favourable. */
    readonly net: TotalResult;
  };
  /** The lines whose variance needs an explanation and has none, in budget order. */
  readonly unexplained: readonly string[];
}

export interface ServiceMargin {
  readonly lineId: string;
  readonly name: string;
  readonly revenueCents: number;
  readonly directCostCents: number;
  readonly marginCents: number;
  readonly marginPercent: number | null;
}

export interface CostLineActual {
  readonly lineId: string;
  readonly name: string;
  readonly actualCents: number;
}

export interface MarginReport {
  readonly period: string;
  readonly periodName: string;
  readonly services: readonly ServiceMargin[];
  readonly totals: {
    readonly revenueCents: number;
    readonly directCostCents: number;
    readonly marginCents: number;
    readonly marginPercent: number | null;
  };
  /** The cost lines shared out to the services, and their actuals. */
  readonly directCostLines: readonly CostLineActual[];
  /** The cost lines not shared out: overhead, left whole. */
  readonly overhead: { readonly lines: readonly CostLineActual[]; readonly totalCents: number };
  /** Gross margin less overhead: the month's net result. */
  readonly netResultCents: number;
  /** Always false: no service carries a share of overhead, and the receipt says so. */
  readonly overheadApportioned: false;
}

export type AgingBucket = "not yet due" | "1-30" | "31-60" | "61-90" | "over 90";
export const AGING_BUCKETS: readonly AgingBucket[] = [
  "not yet due",
  "1-30",
  "31-60",
  "61-90",
  "over 90",
];

/** One open invoice a customer owes. */
export interface Receivable {
  readonly invoice: string;
  readonly customer: string;
  readonly dueOn: string;
  readonly amountCents: number;
}

export interface AgedReceivable extends Receivable {
  /** Days past the due date as of today; zero or less when it is not yet due. */
  readonly daysOverdue: number;
  readonly bucket: AgingBucket;
}

export interface AgingReport {
  readonly asOf: string;
  readonly totalCents: number;
  readonly buckets: readonly {
    readonly bucket: AgingBucket;
    readonly totalCents: number;
    readonly count: number;
    /** The bucket's share of the total, as a percentage to one decimal place. */
    readonly sharePercent: number;
  }[];
  readonly invoices: readonly AgedReceivable[];
}

/** One bill the company owes a supplier. */
export interface Payable {
  readonly bill: string;
  readonly supplier: string;
  readonly dueOn: string;
  readonly amountCents: number;
}

/** One payroll run: the day it is paid and the amount the desk holds for it. */
export interface PayrollRun {
  readonly payOn: string;
  readonly amountCents: number;
}

export interface CashMovement {
  readonly ref: string;
  readonly what: string;
  readonly on: string;
  readonly amountCents: number;
}

export interface ForecastWeek {
  readonly week: number;
  readonly from: string;
  readonly to: string;
  readonly openingCents: number;
  readonly receiptsCents: number;
  readonly paymentsCents: number;
  readonly closingCents: number;
  readonly receipts: readonly CashMovement[];
  readonly payments: readonly CashMovement[];
}

export interface CashForecast {
  /** Always `forecast`: an estimate from the desk's records and the assumptions below, not a fact. */
  readonly kind: "forecast";
  readonly asOf: string;
  readonly openingCents: number;
  readonly weeks: readonly ForecastWeek[];
  readonly lowest: { readonly week: number; readonly closingCents: number };
  /** The weeks whose closing balance is below zero. */
  readonly shortfallWeeks: readonly number[];
  readonly assumptions: readonly string[];
}

/** A person a report is released to: always one of the company's people. */
export interface Recipient {
  readonly name: string;
  readonly title: string;
  readonly email: string;
}

export interface ReportDraft {
  readonly id: string;
  readonly title: string;
  readonly period: string;
  readonly periodName: string;
  readonly commentary: string;
  readonly savedOn: string;
  readonly status: "draft" | "released";
  readonly releasedOn: string | null;
  readonly releasedTo: readonly Recipient[];
}

/**
 * A forecast version. FV-1 is the original budget as the forecast; each approved revision opens the
 * next one, at the line's revised monthly budget the approver entered with their yes.
 */
export interface ForecastVersion {
  readonly id: string;
  readonly createdOn: string;
  readonly basedOn: string | null;
  readonly revision: {
    readonly lineId: string;
    readonly lineName: string;
    readonly reason: string;
    readonly originalMonthlyCents: number;
    /** The line's revised monthly budget, in whole cents, as the approver entered it. */
    readonly amountCents: number;
    /** Who entered it, as the approver reported them; `null` when the approver did not say. */
    readonly amountEnteredBy: string | null;
  } | null;
}

export interface ExplanationInput {
  readonly period: string;
  readonly lineId: string;
  readonly cause: string;
  readonly kind: ExplanationKind;
  /** The person on the company record who gave the explanation: their name, email or id. */
  readonly givenBy: string;
}

export interface DraftInput {
  readonly title: string;
  readonly period: string;
  readonly commentary: string;
}

export interface ReleaseInput {
  readonly draftId: string;
  readonly recipients: readonly string[];
}

export interface RevisionInput {
  readonly lineId: string;
  readonly reason: string;
}

/** What the role needs from whatever system holds its figures. */
export interface FinanceDesk {
  listPeriods(): Promise<readonly Period[]>;
  listDrafts(): Promise<readonly ReportDraft[]>;
  listExplanations(period?: string): Promise<readonly VarianceExplanation[]>;
  listForecastVersions(): Promise<readonly ForecastVersion[]>;
  /**
   * One closed month against the original budget. `limitCents` is the role's resolved limit for this
   * call; a host desk must treat `undefined` as no limit, so every variance needs an explanation.
   */
  budgetVsActual(
    period: string,
    options: { readonly limitCents: number | undefined },
  ): Promise<BudgetVsActual>;
  marginByService(period: string): Promise<MarginReport>;
  receivablesAging(): Promise<AgingReport>;
  cashForecast(weeks: number): Promise<CashForecast>;
  recordVarianceExplanation(
    input: ExplanationInput,
    options: { readonly requestId: string },
  ): Promise<VarianceExplanation>;
  /**
   * Keeps a draft. A host desk must refuse it with `unexplained_variance` while a variance over the
   * limit has no explanation, `figure_not_in_results` for a money figure the computed results do
   * not hold, and `forecast_not_labelled` for a forecast figure not labelled as an estimate.
   */
  saveReportDraft(
    input: DraftInput,
    options: { readonly requestId: string; readonly limitCents: number | undefined },
  ): Promise<ReportDraft>;
  /** What a person approves for a release; refuses a recipient outside the company. */
  releaseFacts(input: ReleaseInput): Promise<Record<string, unknown>>;
  /** Releases a draft once a person approved it, refusing when it no longer equals `approved`. */
  releaseReport(
    input: ReleaseInput & { readonly approved: Readonly<Record<string, unknown>> },
    options: { readonly requestId: string },
  ): Promise<ReportDraft>;
  /** What a person approves for a revision: the line, its original budget and the reason. */
  revisionFacts(input: RevisionInput): Promise<Record<string, unknown>>;
  /**
   * Opens a new forecast version once a person approved it, at the revised monthly budget they
   * entered (`amountCents`, whole cents, 0 or more) and recording who entered it; the original budget
   * never changes. A host desk must refuse an amount that is not whole cents of 0 or more (`invalid`).
   */
  reviseForecast(
    input: RevisionInput & {
      readonly approved: Readonly<Record<string, unknown>>;
      readonly amountCents: number;
      readonly enteredBy: string | null;
    },
    options: { readonly requestId: string },
  ): Promise<ForecastVersion>;
}

/** Why the desk refused, so a tool can say what to do next without parsing the message. */
export type DeskRefusal =
  | "not_found"
  | "invalid"
  | "period_open"
  | "unexplained_variance"
  | "figure_not_in_results"
  | "forecast_not_labelled"
  | "unknown_person"
  | "amount_in_reason"
  | "outside_recipient"
  | "already_released"
  | "facts_changed";

/** A refusal the model reads: an open month, an invented figure, a recipient outside the company. */
export class FinanceDeskError extends Error {
  readonly code: DeskRefusal;

  constructor(code: DeskRefusal, message: string) {
    super(message);
    this.name = "FinanceDeskError";
    this.code = code;
  }
}

/** Monday 9 November 2026, at the start of the office day on the US west coast. */
export const DEMO_NOW = "2026-11-09T16:00:00.000Z";

/** The longest cash forecast the desk makes, in weeks. */
export const MAX_FORECAST_WEEKS = 13;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const round1 = (value: number): number => Math.round(value * 10) / 10;
const percentOf = (part: number, whole: number): number | null =>
  whole === 0 ? null : round1((part / whole) * 100);

/** Favourable or not, from what kind of figure it is: more revenue or less cost is favourable. */
export function directionOf(kind: LineKind | "net", varianceCents: number): Direction {
  if (varianceCents === 0) return "on budget";
  const moreIsGood = kind !== "cost";
  return varianceCents > 0 === moreIsGood ? "favourable" : "unfavourable";
}

function figure(kind: LineKind | "net", budgetCents: number, actualCents: number): VarianceFigure {
  const varianceCents = actualCents - budgetCents;
  return {
    budgetCents,
    actualCents,
    varianceCents,
    variancePercent: percentOf(varianceCents, budgetCents),
    direction: directionOf(kind, varianceCents),
  };
}

const periodId = (year: number, month: number): string =>
  `${year}-${String(month).padStart(2, "0")}`;
/** "October 2026" for "2026-10". */
export const periodName = (id: string): string => {
  const [year, month] = id.split("-");
  return `${MONTHS[Number(month) - 1] ?? month} ${year}`;
};

/** Dollars to cents: the demonstration figures are whole dollars, as a person writes them. */
const dollars = (amount: number): number => amount * 100;

/**
 * The months the demonstration actuals override, in whole dollars of variance from the budget: a
 * September deep-clean surge explained as timing, and an October with a lost contract (unexplained)
 * and overtime on field wages (explained). Every other month and line follows `generic`.
 */
const DEMO_VARIANCES: Readonly<Record<number, Readonly<Record<string, number>>>> = {
  9: {
    "recurring-contracts": -1200,
    "deep-clean-floor-care": 5600,
    "window-cleaning": 0,
    "building-maintenance": 400,
    "after-hours-response": -200,
    "day-porter": 0,
    "field-wages": 2100,
    "office-salaries": 0,
    "payroll-taxes-benefits": 300,
    supplies: 400,
    vehicles: -300,
    subcontractors: 0,
    insurance: 0,
    rent: 0,
    "software-phones": 0,
    equipment: 250,
  },
  10: {
    "recurring-contracts": -6400,
    "deep-clean-floor-care": 1500,
    "window-cleaning": -700,
    "building-maintenance": 800,
    "after-hours-response": 300,
    "day-porter": 0,
    "field-wages": 5200,
    "office-salaries": 0,
    "payroll-taxes-benefits": 400,
    supplies: 900,
    vehicles: -1100,
    subcontractors: -600,
    insurance: 0,
    rent: 0,
    "software-phones": 120,
    equipment: -300,
  },
};

/** A small, fixed variance for the other months: within two per cent, in whole dollars. */
function generic(month: number, index: number, monthlyCents: number): number {
  const step = ((month * 7 + index * 5) % 11) - 5;
  return Math.round((monthlyCents * step) / 250 / 100) * 100;
}

/**
 * The demonstration actuals, January to October of the budget's year, for every budget line: the
 * budget plus the month's variance, in cents. Not part of the company record.
 */
export function demoActuals(
  lines: readonly BudgetLine[],
  year: number,
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const months = new Map<string, Map<string, number>>();
  for (let month = 1; month <= 10; month += 1) {
    const actuals = new Map<string, number>();
    const overrides = DEMO_VARIANCES[month];
    for (const [index, line] of lines.entries()) {
      const variance =
        overrides?.[line.id] === undefined
          ? generic(month, index, line.monthlyCents)
          : dollars(overrides[line.id] ?? 0);
      actuals.set(line.id, line.monthlyCents + variance);
    }
    months.set(periodId(year, month), actuals);
  }
  return months;
}

/**
 * How the demonstration shares each direct cost line out to the services (the revenue lines), in
 * thousandths. Overhead lines are not here: they are not apportioned.
 */
export const DEMO_DIRECT_COST_SHARES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "field-wages": {
    "recurring-contracts": 740,
    "deep-clean-floor-care": 120,
    "window-cleaning": 30,
    "building-maintenance": 40,
    "after-hours-response": 20,
    "day-porter": 50,
  },
  supplies: {
    "recurring-contracts": 700,
    "deep-clean-floor-care": 200,
    "window-cleaning": 40,
    "building-maintenance": 20,
    "after-hours-response": 20,
    "day-porter": 20,
  },
  vehicles: {
    "recurring-contracts": 450,
    "deep-clean-floor-care": 150,
    "window-cleaning": 100,
    "building-maintenance": 200,
    "after-hours-response": 80,
    "day-porter": 20,
  },
  subcontractors: {
    "recurring-contracts": 0,
    "deep-clean-floor-care": 100,
    "window-cleaning": 600,
    "building-maintenance": 250,
    "after-hours-response": 50,
    "day-porter": 0,
  },
};

/** The open invoices on the morning of Monday 9 November 2026. */
export function demoReceivables(): readonly Receivable[] {
  return [
    {
      invoice: "INV-2288",
      customer: "Sellwood Law Partners",
      dueOn: "2026-11-12",
      amountCents: dollars(16200),
    },
    {
      invoice: "INV-2291",
      customer: "Hawthorne Family Dental",
      dueOn: "2026-11-16",
      amountCents: dollars(8850),
    },
    {
      invoice: "INV-2295",
      customer: "Lloyd Tower Offices",
      dueOn: "2026-11-20",
      amountCents: dollars(42600),
    },
    {
      invoice: "INV-2296",
      customer: "Gateway Accounting",
      dueOn: "2026-11-23",
      amountCents: dollars(11900),
    },
    {
      invoice: "INV-2297",
      customer: "Burnside Property Group",
      dueOn: "2026-11-27",
      amountCents: dollars(38400),
    },
    {
      invoice: "INV-2299",
      customer: "Riverside Medical Plaza",
      dueOn: "2026-12-04",
      amountCents: dollars(27300),
    },
    {
      invoice: "INV-2280",
      customer: "Burnside Property Group",
      dueOn: "2026-11-02",
      amountCents: dollars(18400),
    },
    {
      invoice: "INV-2275",
      customer: "Gateway Accounting",
      dueOn: "2026-10-26",
      amountCents: dollars(3900),
    },
    {
      invoice: "INV-2262",
      customer: "Little Acorns Childcare",
      dueOn: "2026-10-05",
      amountCents: dollars(5300),
    },
    {
      invoice: "INV-2240",
      customer: "Riverside Medical Plaza",
      dueOn: "2026-09-04",
      amountCents: dollars(2750),
    },
    {
      invoice: "INV-2215",
      customer: "Pearl Street Lofts Association",
      dueOn: "2026-07-31",
      amountCents: dollars(1980),
    },
  ];
}

/** The bills to pay, by due date. */
export function demoPayables(): readonly Payable[] {
  return [
    {
      bill: "BILL-771",
      supplier: "Cascade Janitorial Supply",
      dueOn: "2026-11-13",
      amountCents: dollars(9840),
    },
    {
      bill: "BILL-774",
      supplier: "Fleetline Vehicle Services",
      dueOn: "2026-11-18",
      amountCents: dollars(5920),
    },
    {
      bill: "BILL-776",
      supplier: "Pacific Mutual Insurance",
      dueOn: "2026-11-30",
      amountCents: dollars(4200),
    },
    {
      bill: "BILL-779",
      supplier: "Eastside Storage Partners",
      dueOn: "2026-12-01",
      amountCents: dollars(3800),
    },
    {
      bill: "BILL-781",
      supplier: "Cascade Janitorial Supply",
      dueOn: "2026-12-10",
      amountCents: dollars(10450),
    },
  ];
}

/** Every other Friday, from 13 November 2026, at the amount the payroll desk holds for a run. */
export function demoPayroll(): readonly PayrollRun[] {
  const runs: PayrollRun[] = [];
  for (let day = "2026-11-13"; day <= "2027-02-28"; day = addDays(day, 14)) {
    runs.push({ payOn: day, amountCents: dollars(56800) });
  }
  return runs;
}

/** The bank balance the books hold at the close of Sunday 8 November 2026. */
export const DEMO_OPENING_BALANCE_CENTS = dollars(96400);

/** The facts a person approves when releasing a draft: the draft as saved, and who gets it. */
export function releaseFactsOf(
  draft: ReportDraft,
  recipients: readonly Recipient[],
): Record<string, unknown> {
  return {
    draftId: draft.id,
    title: draft.title,
    period: draft.period,
    commentary: draft.commentary,
    recipients: recipients.map((recipient) => ({ ...recipient })),
  };
}

/**
 * Money written in a commentary: "$6,400", "$6,400.00", "-$6,400", "$6.4k", "$1.2 million". Each is
 * read to cents; its sign is ignored, since a variance is often written as "$6,400 below budget".
 */
const MONEY =
  /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s?(k|thousand|m|mn|million|bn|billion)\b)?/gi;

const SCALE: Readonly<Record<string, number>> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mn: 1e6,
  million: 1e6,
  bn: 1e9,
  billion: 1e9,
};

/** Every money figure in a text, as written and in cents, with the sentence it sits in. */
export function moneyFigures(
  text: string,
): readonly { readonly written: string; readonly cents: number; readonly sentence: string }[] {
  const found: { written: string; cents: number; sentence: string }[] = [];
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .filter((sentence) => sentence.trim() !== "");
  for (const sentence of sentences) {
    for (const match of sentence.matchAll(MONEY)) {
      const whole = (match[1] ?? "0").replace(/,/g, "");
      const fraction = match[2] ?? "";
      const scale = SCALE[(match[3] ?? "").toLowerCase()] ?? 1;
      const cents = Math.round(Number(`${whole}.${fraction || "0"}`) * scale * 100);
      found.push({ written: match[0].trim(), cents, sentence });
    }
  }
  return found;
}

/** Words that label a figure as an estimate rather than a fact. */
const ESTIMATE_LABEL = /\b(estimate[sd]?|estimating|forecast(?:s|ed|ing)?|projected|projection)\b/i;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The demonstration desk's options: the company's budget and people, and a clock. */
export interface FakeFinanceDeskOptions {
  /** The budget, people and time zone; the company's own when omitted. */
  readonly company?: Pick<CompanyFacts, "hours" | "people" | "budget">;
  /** The clock. Omitted: Monday 9 November 2026, the morning of the demonstration week. */
  readonly now?: () => Date;
}

/** An in-memory desk: the company's budget, demonstration actuals and records, nothing sent. */
export function fakeFinanceDesk(options: FakeFinanceDeskOptions = {}): FinanceDesk {
  const facts = options.company ?? loadCompanyFacts();
  const budget = companyData(facts, "budget");
  const clock = options.now ?? (() => new Date(DEMO_NOW));
  const today = (): string => localDate(clock(), facts.hours.timezone);
  const actuals = demoActuals(budget.lines, budget.fiscalYear);
  const closedIds = [...actuals.keys()];
  const lastClosed = closedIds.length;
  const openId = periodId(budget.fiscalYear, lastClosed + 1);
  const periods: readonly Period[] = [
    ...closedIds.map((id, index) => ({
      id,
      name: periodName(id),
      status: "closed" as const,
      // The books close on the 6th of the next month.
      closedOn: `${index === 11 ? budget.fiscalYear + 1 : budget.fiscalYear}-${String(((index + 1) % 12) + 1).padStart(2, "0")}-06`,
    })),
    { id: openId, name: periodName(openId), status: "open", closedOn: null },
  ];
  for (const lineId of Object.keys(DEMO_DIRECT_COST_SHARES)) {
    if (!budget.lines.some((line) => line.id === lineId)) {
      throw new Error(`The demonstration cost shares name ${lineId}, not a budget line.`);
    }
  }

  const receivables = demoReceivables();
  const payables = demoPayables();
  const payroll = demoPayroll();
  const approver = budgetApprover(facts);
  const recipientOf = (person: Person): Recipient => ({
    name: person.name,
    title: person.title,
    email: person.email ?? "",
  });

  const explanations: VarianceExplanation[] = [];
  const drafts: Mutable<ReportDraft>[] = [];
  const versions: ForecastVersion[] = [
    { id: "FV-1", createdOn: `${budget.fiscalYear}-01-02`, basedOn: null, revision: null },
  ];
  // Every write is remembered by its request id, so a replayed call is answered with what it already
  // did and never writes twice.
  const done = new Map<string, VarianceExplanation | ReportDraft | ForecastVersion>();

  const findLine = (lineId: string): BudgetLine => {
    const line = budget.lines.find((entry) => entry.id === lineId.trim());
    if (line === undefined) {
      throw new FinanceDeskError(
        "not_found",
        `No budget line has the id ${JSON.stringify(lineId)}. The lines are: ${budget.lines.map((entry) => `${entry.id} (${entry.name})`).join(", ")}.`,
      );
    }
    return line;
  };

  /** The month's actuals, or a refusal for a month that is open, outside the year, or not a month. */
  const closedMonth = (period: string): ReadonlyMap<string, number> => {
    const id = period.trim();
    if (!/^\d{4}-\d{2}$/.test(id)) {
      throw new FinanceDeskError(
        "invalid",
        `${JSON.stringify(period)} is not a month: give it as YYYY-MM, e.g. ${closedIds.at(-1) ?? openId}.`,
      );
    }
    if (id === openId) {
      throw new FinanceDeskError(
        "period_open",
        `${periodName(id)} is still open: its books are not finished, so it cannot be reported. The latest closed month is ${periodName(closedIds.at(-1) ?? "")} (${closedIds.at(-1) ?? ""}).`,
      );
    }
    const month = actuals.get(id);
    if (month === undefined) {
      throw new FinanceDeskError(
        "not_found",
        `${id} is not a month of the ${budget.fiscalYear} fiscal year the desk holds. The closed months are ${closedIds[0] ?? ""} to ${closedIds.at(-1) ?? ""}.`,
      );
    }
    return month;
  };

  const explanationFor = (period: string, lineId: string) =>
    explanations.find((entry) => entry.period === period && entry.lineId === lineId) ?? null;

  const needsExplanation = (varianceCents: number, limitCents: number | null): boolean =>
    limitCents === null ? varianceCents !== 0 : Math.abs(varianceCents) > limitCents;

  const resolveLimit = (limitCents: number | undefined): number | null =>
    limitCents !== undefined && Number.isFinite(limitCents) ? limitCents : null;

  const budgetVsActual = (period: string, limitCents: number | null): BudgetVsActual => {
    const month = closedMonth(period);
    const id = period.trim();
    const index = closedIds.indexOf(id);
    const prior = index > 0 ? actuals.get(closedIds[index - 1] ?? "") : undefined;
    const toDate = closedIds.slice(0, index + 1).map((key) => actuals.get(key));
    const lines: LineResult[] = budget.lines.map((line) => {
      const actual = month.get(line.id) ?? 0;
      const ytdActual = toDate.reduce((sum, entry) => sum + (entry?.get(line.id) ?? 0), 0);
      const monthFigure = figure(line.kind, line.monthlyCents, actual);
      return {
        lineId: line.id,
        name: line.name,
        kind: line.kind,
        month: monthFigure,
        yearToDate: figure(line.kind, line.monthlyCents * (index + 1), ytdActual),
        priorMonthActualCents: prior === undefined ? null : (prior.get(line.id) ?? 0),
        needsExplanation: needsExplanation(monthFigure.varianceCents, limitCents),
        explanation: explanationFor(id, line.id),
      };
    });
    const total = (name: string, kind: LineKind): TotalResult => {
      const chosen = lines.filter((line) => line.kind === kind);
      const sum = (pick: (line: LineResult) => number) =>
        chosen.reduce((acc, line) => acc + pick(line), 0);
      return {
        name,
        month: figure(
          kind,
          sum((l) => l.month.budgetCents),
          sum((l) => l.month.actualCents),
        ),
        yearToDate: figure(
          kind,
          sum((l) => l.yearToDate.budgetCents),
          sum((l) => l.yearToDate.actualCents),
        ),
        priorMonthActualCents:
          prior === undefined ? null : sum((l) => l.priorMonthActualCents ?? 0),
      };
    };
    const revenue = total("Total revenue", "revenue");
    const costs = total("Total costs", "cost");
    const net: TotalResult = {
      name: "Net result (revenue less costs)",
      month: figure(
        "net",
        revenue.month.budgetCents - costs.month.budgetCents,
        revenue.month.actualCents - costs.month.actualCents,
      ),
      yearToDate: figure(
        "net",
        revenue.yearToDate.budgetCents - costs.yearToDate.budgetCents,
        revenue.yearToDate.actualCents - costs.yearToDate.actualCents,
      ),
      priorMonthActualCents:
        revenue.priorMonthActualCents === null || costs.priorMonthActualCents === null
          ? null
          : revenue.priorMonthActualCents - costs.priorMonthActualCents,
    };
    return {
      period: id,
      periodName: periodName(id),
      fiscalYear: budget.fiscalYear,
      monthsToDate: index + 1,
      limitCents,
      lines,
      totals: { revenue, costs, net },
      unexplained: lines
        .filter((line) => line.needsExplanation && line.explanation === null)
        .map((line) => line.lineId),
    };
  };

  const marginByService = (period: string): MarginReport => {
    const month = closedMonth(period);
    const id = period.trim();
    const actualOf = (line: BudgetLine): CostLineActual => ({
      lineId: line.id,
      name: line.name,
      actualCents: month.get(line.id) ?? 0,
    });
    const services = budget.lines.filter((line) => line.kind === "revenue");
    const costs = budget.lines.filter((line) => line.kind === "cost");
    const direct = costs.filter((line) => DEMO_DIRECT_COST_SHARES[line.id] !== undefined);
    const overhead = costs.filter((line) => DEMO_DIRECT_COST_SHARES[line.id] === undefined);
    const allocated = new Map<string, number>(services.map((line) => [line.id, 0]));
    for (const line of direct) {
      const shares = DEMO_DIRECT_COST_SHARES[line.id] ?? {};
      const actual = month.get(line.id) ?? 0;
      let given = 0;
      let largest = services[0]?.id ?? "";
      for (const service of services) {
        const share = shares[service.id] ?? 0;
        if (share > (shares[largest] ?? 0)) largest = service.id;
        // Whole dollars per service; what rounding leaves over goes to the largest share below.
        const part = Math.round((actual * share) / 1000 / 100) * 100;
        allocated.set(service.id, (allocated.get(service.id) ?? 0) + part);
        given += part;
      }
      allocated.set(largest, (allocated.get(largest) ?? 0) + (actual - given));
    }
    const lines: ServiceMargin[] = services.map((line) => {
      const revenueCents = month.get(line.id) ?? 0;
      const directCostCents = allocated.get(line.id) ?? 0;
      const marginCents = revenueCents - directCostCents;
      return {
        lineId: line.id,
        name: line.name,
        revenueCents,
        directCostCents,
        marginCents,
        marginPercent: percentOf(marginCents, revenueCents),
      };
    });
    const revenueCents = lines.reduce((sum, line) => sum + line.revenueCents, 0);
    const directCostCents = lines.reduce((sum, line) => sum + line.directCostCents, 0);
    const marginCents = revenueCents - directCostCents;
    const overheadLines = overhead.map(actualOf);
    const overheadCents = overheadLines.reduce((sum, line) => sum + line.actualCents, 0);
    return {
      period: id,
      periodName: periodName(id),
      services: lines,
      totals: {
        revenueCents,
        directCostCents,
        marginCents,
        marginPercent: percentOf(marginCents, revenueCents),
      },
      directCostLines: direct.map(actualOf),
      overhead: { lines: overheadLines, totalCents: overheadCents },
      netResultCents: marginCents - overheadCents,
      overheadApportioned: false,
    };
  };

  const receivablesAging = (): AgingReport => {
    const asOf = today();
    const invoices: AgedReceivable[] = receivables.map((entry) => {
      const daysOverdue = daysBetween(entry.dueOn, asOf);
      const bucket: AgingBucket =
        daysOverdue <= 0
          ? "not yet due"
          : daysOverdue <= 30
            ? "1-30"
            : daysOverdue <= 60
              ? "31-60"
              : daysOverdue <= 90
                ? "61-90"
                : "over 90";
      return { ...entry, daysOverdue, bucket };
    });
    const totalCents = invoices.reduce((sum, entry) => sum + entry.amountCents, 0);
    return {
      asOf,
      totalCents,
      buckets: AGING_BUCKETS.map((bucket) => {
        const inBucket = invoices.filter((entry) => entry.bucket === bucket);
        const bucketCents = inBucket.reduce((sum, entry) => sum + entry.amountCents, 0);
        return {
          bucket,
          totalCents: bucketCents,
          count: inBucket.length,
          sharePercent: percentOf(bucketCents, totalCents) ?? 0,
        };
      }),
      invoices,
    };
  };

  const cashForecast = (weeks: number): CashForecast => {
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_FORECAST_WEEKS) {
      throw new FinanceDeskError(
        "invalid",
        `${JSON.stringify(weeks)} weeks cannot be forecast: give a whole number of weeks from 1 to ${MAX_FORECAST_WEEKS}.`,
      );
    }
    const asOf = today();
    const list: ForecastWeek[] = [];
    let opening = DEMO_OPENING_BALANCE_CENTS;
    for (let week = 1; week <= weeks; week += 1) {
      const from = addDays(asOf, (week - 1) * 7);
      const to = addDays(from, 6);
      const within = (day: string) => day >= from && day <= to;
      // Overdue invoices have no date to be paid on, so they are left out: see the assumptions.
      const receipts: CashMovement[] = receivables
        .filter((entry) => entry.dueOn >= asOf && within(entry.dueOn))
        .map((entry) => ({
          ref: entry.invoice,
          what: entry.customer,
          on: entry.dueOn,
          amountCents: entry.amountCents,
        }));
      const payments: CashMovement[] = [
        ...payables
          .filter((entry) => entry.dueOn >= asOf && within(entry.dueOn))
          .map((entry) => ({
            ref: entry.bill,
            what: entry.supplier,
            on: entry.dueOn,
            amountCents: entry.amountCents,
          })),
        ...payroll
          .filter((run) => within(run.payOn))
          .map((run) => ({
            ref: `PAY-${run.payOn}`,
            what: "Payroll run",
            on: run.payOn,
            amountCents: run.amountCents,
          })),
      ].sort((a, b) => a.on.localeCompare(b.on));
      const receiptsCents = receipts.reduce((sum, entry) => sum + entry.amountCents, 0);
      const paymentsCents = payments.reduce((sum, entry) => sum + entry.amountCents, 0);
      const closing = opening + receiptsCents - paymentsCents;
      list.push({
        week,
        from,
        to,
        openingCents: opening,
        receiptsCents,
        paymentsCents,
        closingCents: closing,
        receipts,
        payments,
      });
      opening = closing;
    }
    const lowest = list.reduce(
      (low, week) => (week.closingCents < low.closingCents ? week : low),
      list[0] as ForecastWeek,
    );
    return {
      kind: "forecast",
      asOf,
      openingCents: DEMO_OPENING_BALANCE_CENTS,
      weeks: list,
      lowest: { week: lowest.week, closingCents: lowest.closingCents },
      shortfallWeeks: list.filter((week) => week.closingCents < 0).map((week) => week.week),
      assumptions: [
        `The opening balance is the bank balance the books hold at the end of ${addDays(asOf, -1)}.`,
        "Each invoice not yet due is paid on its due date.",
        "Overdue invoices are left out, since no date for them to be paid is known.",
        "Each bill is paid on its due date, and each payroll run on its pay date at the amount the desk holds.",
        "Invoices not yet raised and spending not yet billed are left out, so the later weeks understate both receipts and payments.",
      ],
    };
  };

  /** The money figures the period's computed results hold: actual results, and forecast ones. */
  const computedFigures = (period: string, limitCents: number | null) => {
    const actual = new Set<number>([0]);
    const add = (cents: number | null) => {
      if (cents !== null) actual.add(Math.abs(cents));
    };
    const addFigure = (value: VarianceFigure) => {
      add(value.budgetCents);
      add(value.actualCents);
      add(value.varianceCents);
    };
    const addReport = (report: BudgetVsActual) => {
      for (const entry of [
        ...report.lines,
        report.totals.revenue,
        report.totals.costs,
        report.totals.net,
      ]) {
        addFigure(entry.month);
        addFigure(entry.yearToDate);
        add(entry.priorMonthActualCents);
      }
    };
    const id = period.trim();
    addReport(budgetVsActual(id, limitCents));
    // Prior-period comparatives: the month before, whole.
    const index = closedIds.indexOf(id);
    if (index > 0) addReport(budgetVsActual(closedIds[index - 1] ?? "", limitCents));
    const margin = marginByService(id);
    for (const service of margin.services) {
      add(service.revenueCents);
      add(service.directCostCents);
      add(service.marginCents);
    }
    add(margin.totals.revenueCents);
    add(margin.totals.directCostCents);
    add(margin.totals.marginCents);
    for (const line of [...margin.directCostLines, ...margin.overhead.lines]) add(line.actualCents);
    add(margin.overhead.totalCents);
    add(margin.netResultCents);
    const aging = receivablesAging();
    add(aging.totalCents);
    for (const bucket of aging.buckets) add(bucket.totalCents);
    for (const invoice of aging.invoices) add(invoice.amountCents);
    add(limitCents);
    add(DEMO_OPENING_BALANCE_CENTS);
    // The forecast's figures: the longest forecast holds every shorter one.
    const forecast = new Set<number>();
    for (const week of cashForecast(MAX_FORECAST_WEEKS).weeks) {
      for (const cents of [
        week.openingCents,
        week.receiptsCents,
        week.paymentsCents,
        week.closingCents,
      ]) {
        if (!actual.has(Math.abs(cents))) forecast.add(Math.abs(cents));
      }
    }
    return { actual, forecast };
  };

  const required = (value: string | undefined, what: string): string => {
    const text = (value ?? "").trim();
    if (text === "") throw new FinanceDeskError("invalid", `Say ${what}; it may not be empty.`);
    return text;
  };

  const findDraft = (draftId: string): Mutable<ReportDraft> => {
    const draft = drafts.find((entry) => entry.id.toLowerCase() === draftId.trim().toLowerCase());
    if (draft === undefined) {
      throw new FinanceDeskError(
        "not_found",
        `No report draft has the number ${JSON.stringify(draftId)}. The drafts are: ${drafts.map((entry) => `${entry.id} (${entry.title})`).join(", ") || "none"}.`,
      );
    }
    return draft;
  };

  const copyDraft = (draft: ReportDraft): ReportDraft => ({
    ...draft,
    releasedTo: draft.releasedTo.map((entry) => ({ ...entry })),
  });

  const releaseFacts = (input: ReleaseInput): Record<string, unknown> => {
    const draft = findDraft(input.draftId);
    if (draft.status === "released") {
      throw new FinanceDeskError(
        "already_released",
        `${draft.id} was released on ${draft.releasedOn ?? "an earlier day"} to ${draft.releasedTo.map((entry) => entry.name).join(", ")}. Nothing was put to a person.`,
      );
    }
    if (input.recipients.length === 0) {
      throw new FinanceDeskError(
        "invalid",
        "Name at least one recipient from the company's people.",
      );
    }
    const resolved: Recipient[] = [];
    const outside: string[] = [];
    for (const recipient of input.recipients) {
      const person = personByRecipient(facts, recipient);
      if (person === undefined) outside.push(recipient);
      else if (!resolved.some((entry) => entry.email === person.email)) {
        resolved.push(recipientOf(person));
      }
    }
    if (outside.length > 0) {
      throw new FinanceDeskError(
        "outside_recipient",
        `${outside.map((entry) => JSON.stringify(entry)).join(", ")} ${outside.length === 1 ? "is" : "are"} not one of the company's people, so the report cannot be released to ${outside.length === 1 ? "them" : "them all"}. A report goes only to people on the company record, named by full name or email. Nothing was put to a person and nothing was sent.`,
      );
    }
    return releaseFactsOf(draft, resolved);
  };

  const revisionFacts = (input: RevisionInput): Record<string, unknown> => {
    const line = findLine(input.lineId);
    const reason = required(input.reason, "why the line's forecast should be revised (reason)");
    // The amount is the approver's to enter: a reason that carries one would put it to them as the
    // role's figure, so it is refused before anyone is asked.
    const amounts = moneyFigures(reason);
    if (amounts.length > 0) {
      throw new FinanceDeskError(
        "amount_in_reason",
        `The reason states ${amounts.map((entry) => JSON.stringify(entry.written)).join(", ")}: a revision carries no amount, because the person approving enters it. Give the reason in words only.`,
      );
    }
    const current = versions.at(-1);
    return {
      lineId: line.id,
      lineName: line.name,
      kind: line.kind,
      originalMonthlyCents: line.monthlyCents,
      reason,
      basedOn: current?.id ?? null,
    };
  };

  const desk: FinanceDesk = {
    async listPeriods() {
      return periods.map((period) => ({ ...period }));
    },

    async listDrafts() {
      return drafts.map(copyDraft);
    },

    async listExplanations(period) {
      return explanations
        .filter((entry) => period === undefined || entry.period === period.trim())
        .map((entry) => ({ ...entry, givenBy: { ...entry.givenBy } }));
    },

    async listForecastVersions() {
      return versions.map((version) => ({
        ...version,
        revision: version.revision === null ? null : { ...version.revision },
      }));
    },

    async budgetVsActual(period, { limitCents }) {
      return budgetVsActual(period, resolveLimit(limitCents));
    },

    async marginByService(period) {
      return marginByService(period);
    },

    async receivablesAging() {
      return receivablesAging();
    },

    async cashForecast(weeks) {
      return cashForecast(weeks);
    },

    async recordVarianceExplanation(input, { requestId }) {
      const prior = done.get(requestId) as VarianceExplanation | undefined;
      if (prior !== undefined) return prior;
      const month = closedMonth(input.period);
      const line = findLine(input.lineId);
      const cause = required(input.cause, "the cause of the variance");
      if (!EXPLANATION_KINDS.includes(input.kind)) {
        throw new FinanceDeskError(
          "invalid",
          `${JSON.stringify(input.kind)} is not a kind of variance: give timing (likely to be made up later) or permanent (not expected to be made up). Nothing was recorded.`,
        );
      }
      const person = personByRecipient(facts, input.givenBy);
      if (person === undefined) {
        throw new FinanceDeskError(
          "unknown_person",
          `${JSON.stringify(input.givenBy)} is not on the company record, so the explanation cannot be recorded as theirs. Give the full name or email of the person who explained it. Nothing was recorded.`,
        );
      }
      const varianceCents = (month.get(line.id) ?? 0) - line.monthlyCents;
      const explanation: VarianceExplanation = {
        period: input.period.trim(),
        lineId: line.id,
        lineName: line.name,
        varianceCents,
        direction: directionOf(line.kind, varianceCents),
        cause,
        kind: input.kind,
        givenBy: { name: person.name, title: person.title },
        recordedOn: today(),
      };
      // A later explanation of the same line and month replaces the earlier one.
      const existing = explanations.findIndex(
        (entry) => entry.period === explanation.period && entry.lineId === line.id,
      );
      if (existing >= 0) explanations.splice(existing, 1);
      explanations.push(explanation);
      done.set(requestId, explanation);
      return { ...explanation, givenBy: { ...explanation.givenBy } };
    },

    async saveReportDraft(input, { requestId, limitCents }) {
      const prior = done.get(requestId) as ReportDraft | undefined;
      if (prior !== undefined) return copyDraft(prior);
      const limit = resolveLimit(limitCents);
      const report = budgetVsActual(input.period, limit);
      const title = required(input.title, "the report's title");
      const commentary = required(input.commentary, "the report's commentary");

      // Every problem is named at once, so one correction fixes the lot.
      const problems: { code: DeskRefusal; text: string }[] = [];
      if (report.unexplained.length > 0) {
        const names = report.unexplained.map((lineId) => {
          const entry = report.lines.find((candidate) => candidate.lineId === lineId);
          return `${entry?.name ?? lineId} (${lineId}, ${money(entry?.month.varianceCents ?? 0)} ${entry?.month.direction ?? ""})`;
        });
        problems.push({
          code: "unexplained_variance",
          text: `${limit === null ? "No variance explanation limit is set, so every variance needs an explanation, and these have none" : `These variances are over the ${money(limit)} limit and have no explanation`}: ${names.join("; ")}.`,
        });
      }
      const { actual, forecast } = computedFigures(input.period, limit);
      const figures = moneyFigures(commentary);
      const unknown = figures.filter(
        (entry) => !actual.has(entry.cents) && !forecast.has(entry.cents),
      );
      if (unknown.length > 0) {
        problems.push({
          code: "figure_not_in_results",
          text: `The commentary states ${unknown.map((entry) => JSON.stringify(entry.written)).join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not in the computed results for ${report.periodName}, the month before it, its margins, the receivables or the cash forecast. Use each figure exactly as a tool returned it.`,
        });
      }
      const unlabelled = figures.filter(
        (entry) =>
          forecast.has(entry.cents) &&
          !actual.has(entry.cents) &&
          !ESTIMATE_LABEL.test(entry.sentence),
      );
      if (unlabelled.length > 0) {
        problems.push({
          code: "forecast_not_labelled",
          text: `${unlabelled.map((entry) => JSON.stringify(entry.written)).join(", ")} ${unlabelled.length === 1 ? "is a forecast figure" : "are forecast figures"}, so ${unlabelled.length === 1 ? "its" : "each"} sentence must label it as an estimate or a forecast.`,
        });
      }
      const [first] = problems;
      if (first !== undefined) {
        throw new FinanceDeskError(
          first.code,
          `The draft was not saved. ${problems.map((problem) => problem.text).join(" ")}`,
        );
      }

      const highest = Math.max(
        100,
        ...drafts.map((entry) => Number(entry.id.replace(/\D/g, "")) || 0),
      );
      const draft: Mutable<ReportDraft> = {
        id: `RD-${highest + 1}`,
        title,
        period: report.period,
        periodName: report.periodName,
        commentary,
        savedOn: today(),
        status: "draft",
        releasedOn: null,
        releasedTo: [],
      };
      drafts.push(draft);
      const receipt = copyDraft(draft);
      done.set(requestId, receipt);
      return receipt;
    },

    async releaseFacts(input) {
      return releaseFacts(input);
    },

    async releaseReport(input, { requestId }) {
      const prior = done.get(requestId) as ReportDraft | undefined;
      if (prior !== undefined) return copyDraft(prior);
      const current = releaseFacts(input);
      // The person approved this draft and these recipients; anything else is not what they saw.
      if (!sameFacts(input.approved, current)) {
        throw new FinanceDeskError(
          "facts_changed",
          `${input.draftId} or its recipients are not what the person approved: they changed after the approval was asked. Nothing was released.`,
        );
      }
      const draft = findDraft(input.draftId);
      draft.status = "released";
      draft.releasedOn = today();
      draft.releasedTo = (current.recipients as Recipient[]).map((entry) => ({ ...entry }));
      const receipt = copyDraft(draft);
      done.set(requestId, receipt);
      return receipt;
    },

    async revisionFacts(input) {
      return revisionFacts(input);
    },

    async reviseForecast(input, { requestId }) {
      const prior = done.get(requestId) as ForecastVersion | undefined;
      if (prior !== undefined) return prior;
      const current = revisionFacts(input);
      if (!sameFacts(input.approved, current)) {
        throw new FinanceDeskError(
          "facts_changed",
          `The revision of ${input.lineId} is not what the person approved: it changed after the approval was asked. No forecast version was opened.`,
        );
      }
      // A line's budget may be revised to nothing, never below it, and only in whole cents.
      if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0) {
        throw new FinanceDeskError(
          "invalid",
          `The revised budget for ${input.lineId} must be whole cents of 0 or more, as the person approving entered it; got ${String(input.amountCents)}. No forecast version was opened.`,
        );
      }
      const line = findLine(input.lineId);
      const version: ForecastVersion = {
        id: `FV-${versions.length + 1}`,
        createdOn: today(),
        basedOn: versions.at(-1)?.id ?? null,
        revision: {
          lineId: line.id,
          lineName: line.name,
          reason: String(current.reason),
          originalMonthlyCents: line.monthlyCents,
          amountCents: input.amountCents,
          amountEnteredBy: input.enteredBy,
        },
      };
      versions.push(version);
      done.set(requestId, version);
      return { ...version, revision: version.revision === null ? null : { ...version.revision } };
    },
  };

  seedDemoRecords({ facts, explanations, drafts, budgetVsActual, approver, recipientOf });
  return desk;
}

/**
 * The records already on the desk when the demonstration starts: the explanations given when
 * September and October closed (September's deep-clean surge, October's overtime; October's lost
 * contract is still unexplained), August's report released, and September's saved as a draft. The
 * explanations are recorded as given by the budget's approver, read from the company record, and the
 * drafts quote only figures the desk worked out.
 */
function seedDemoRecords(seed: {
  readonly facts: Pick<CompanyFacts, "people" | "budget">;
  readonly explanations: VarianceExplanation[];
  readonly drafts: Mutable<ReportDraft>[];
  readonly budgetVsActual: (period: string, limitCents: number | null) => BudgetVsActual;
  readonly approver: Person | undefined;
  readonly recipientOf: (person: Person) => Recipient;
}): void {
  const { facts, explanations, drafts, budgetVsActual, approver, recipientOf } = seed;
  const year = companyData(facts, "budget").fiscalYear;
  const giver = approver ?? facts.people[0];
  if (giver === undefined) return;
  const explain = (month: number, lineId: string, cause: string, kind: ExplanationKind) => {
    const line = companyData(facts, "budget").lines.find((entry) => entry.id === lineId);
    const report = budgetVsActual(periodId(year, month), null);
    const result = report.lines.find((entry) => entry.lineId === lineId);
    if (line === undefined || result === undefined) return;
    explanations.push({
      period: report.period,
      lineId,
      lineName: line.name,
      varianceCents: result.month.varianceCents,
      direction: result.month.direction,
      cause,
      kind,
      givenBy: { name: giver.name, title: giver.title },
      recordedOn: `${year}-${String(month + 1).padStart(2, "0")}-06`,
    });
  };
  explain(
    9,
    "deep-clean-floor-care",
    "A client's seasonal floor reset was brought forward from October into September",
    "timing",
  );
  explain(
    10,
    "field-wages",
    "Overtime covered two vacant cleaner posts through October; both are filled from November",
    "timing",
  );

  const summary = (month: number): string => {
    const report = budgetVsActual(periodId(year, month), null);
    const { revenue, costs, net } = report.totals;
    return `${report.periodName}: revenue was ${money(revenue.month.actualCents)} against a budget of ${money(revenue.month.budgetCents)}, and costs were ${money(costs.month.actualCents)} against ${money(costs.month.budgetCents)}, for a net result of ${money(net.month.actualCents)}. Year to date the net result is ${money(net.yearToDate.actualCents)} against ${money(net.yearToDate.budgetCents)} budgeted.`;
  };
  drafts.push(
    {
      id: "RD-101",
      title: `August ${year} management report`,
      period: periodId(year, 8),
      periodName: periodName(periodId(year, 8)),
      commentary: summary(8),
      savedOn: `${year}-09-08`,
      status: "released",
      releasedOn: `${year}-09-09`,
      releasedTo: approver === undefined ? [] : [recipientOf(approver)],
    },
    {
      id: "RD-102",
      title: `September ${year} management report`,
      period: periodId(year, 9),
      periodName: periodName(periodId(year, 9)),
      commentary: `${summary(9)} Deep clean and floor care was above budget because a client's seasonal floor reset was brought forward from October, a timing difference.`,
      savedOn: `${year}-10-08`,
      status: "draft",
      releasedOn: null,
      releasedTo: [],
    },
  );
}
