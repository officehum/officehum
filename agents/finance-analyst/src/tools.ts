/**
 * The Finance Analysis role's ten tools.
 *
 * `list_periods`, `budget_vs_actual`, `margin_by_service`, `receivables_aging`, `cash_forecast` and
 * `read_company` only read, and every figure they speak was worked out by the desk in integer cents
 * and formatted here. `record_variance_explanation` and `save_report_draft` write internal records
 * with no approval; the desk keeps them honest, and the role's `variance_explanation_limit_cents`
 * limit is read here at every call and handed to it. `request_report_release` and
 * `request_budget_revision` are gated on every call by `officehum.json`'s approvals. The model names
 * only the draft and its recipients, or the line and the reason: the facts readers read what the
 * person approves from the desk (refusing a recipient outside the company before anyone is asked),
 * the gate hands those facts to the tool on a yes, and the desk acts only on what was approved. No
 * tool takes an amount: a revision's amount is the person's, entered with their yes and handed to
 * `request_budget_revision` by the gate (`approvedValue`).
 */

import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { arr, int, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import {
  APPROVED_FACTS_ARG,
  APPROVED_VALUE_ARG,
  type ApprovalFactsReader,
  type ApprovedValue,
  approvedFacts,
  approvedFactsParameter,
  approvedValue,
  approvedValueParameter,
  companyClosedLine,
  companyContactLine,
  companyData,
  companyEscalationText,
  companyGlossaryText,
  companyHeadline,
  companyPeopleText,
  companyPoliciesText,
  companyToneText,
  deskRefusal,
  presentLines,
  readCompanyTool,
  refusal,
  requestId,
  requireDesk,
  textResult,
} from "@officehum/sdk";
import { booksKeeper, budgetApprover, type CompanyFacts, money, personLabel } from "./company.js";
import {
  type BudgetVsActual,
  type CashForecast,
  type DeskRefusal,
  EXPLANATION_KINDS,
  type ExplanationKind,
  type FinanceDesk,
  FinanceDeskError,
  type ForecastVersion,
  MAX_FORECAST_WEEKS,
  periodName,
  type Recipient,
  type VarianceFigure,
} from "./desk.js";

/** The role's limit a month's variance is judged against (`officehum.json`'s `limits`). */
export const VARIANCE_LIMIT = "variance_explanation_limit_cents";

/** The cash forecast's horizon when none is asked for, in weeks. */
export const DEFAULT_FORECAST_WEEKS = 6;

/** The value the `budget_revision` approval asks the person for (`officehum.json`'s approvals). */
export const REVISED_VALUE = "revisedCents";

/** What the tools need: the desk, the company, and the role's resolved limits. */
export interface FinanceToolDependencies {
  readonly desk: FinanceDesk | undefined;
  readonly company: CompanyFacts;
  /**
   * The role's resolved limits, read at every call: the manifest's defaults with the business's
   * overlay on top. Omitted, no limit resolves and every variance needs an explanation.
   */
  readonly limits?: () => Readonly<Record<string, number>>;
}

/** The ten tools, named, and the readers the two approvals ask with. */
export interface FinanceToolset {
  readonly listPeriods: ToolRegistration;
  readonly budgetVsActual: ToolRegistration;
  readonly marginByService: ToolRegistration;
  readonly receivablesAging: ToolRegistration;
  readonly cashForecast: ToolRegistration;
  readonly recordVarianceExplanation: ToolRegistration;
  readonly saveReportDraft: ToolRegistration;
  readonly requestReportRelease: ToolRegistration;
  readonly requestBudgetRevision: ToolRegistration;
  readonly readCompany: ToolRegistration;
  /** Reads a draft and its recipients from the desk for the person releasing it. */
  readonly releaseApprovalFacts: ApprovalFactsReader;
  /** Reads a budget line and the reason from the desk for the person revising its forecast. */
  readonly revisionApprovalFacts: ApprovalFactsReader;
}

/** The company section `read_company` can answer for. */
export type CompanySection =
  | "profile"
  | "hours"
  | "people"
  | "budget"
  | "policies"
  | "tone"
  | "escalation"
  | "glossary";

const PERIOD = str({
  description: "The month, as YYYY-MM, e.g. 2026-10; list_periods shows which are closed",
});

const percent = (value: number | null): string => (value === null ? "n/a" : `${value}%`);

/** One budget, actual and variance as a person reads them; every figure is the desk's. */
function figureText(value: VarianceFigure): string {
  return `budget ${money(value.budgetCents)}, actual ${money(value.actualCents)}, variance ${money(value.varianceCents)} (${percent(value.variancePercent)}), ${value.direction}`;
}

/** The limit as one clause; the figure is the role's resolved limit, read when it is written. */
function limitText(limitCents: number | null | undefined): string {
  return limitCents === null || limitCents === undefined || !Number.isFinite(limitCents)
    ? "No variance explanation limit is set for this role, so every variance in a month needs an explanation before a report draft is saved."
    : `A month's variance on one line over ${money(limitCents)} needs an explanation before a report draft is saved.`;
}

function budgetVsActualText(report: BudgetVsActual): string {
  const prior = (cents: number | null) =>
    cents === null ? "" : `; prior month actual ${money(cents)}`;
  const explained = (line: BudgetVsActual["lines"][number]): string => {
    if (!line.needsExplanation) return "";
    if (line.explanation === null) {
      return " — NOT EXPLAINED: needs an explanation before a draft is saved";
    }
    return ` — explained (${line.explanation.kind}): ${line.explanation.cause}, given by ${line.explanation.givenBy.name}, ${line.explanation.givenBy.title}`;
  };
  const limit =
    report.limitCents === null
      ? "No variance explanation limit is set, so every variance needs an explanation."
      : `Variances over the ${money(report.limitCents)} limit need an explanation.`;
  const { revenue, costs, net } = report.totals;
  return [
    `Budget against actual for ${report.periodName} (${report.period}), against the original budget, worked out by the desk. Variance is actual less budget; favourable or unfavourable is the desk's, from each line's kind.`,
    limit,
    "Month:",
    ...report.lines.map(
      (line) =>
        `- ${line.name} (${line.lineId}, ${line.kind}): ${figureText(line.month)}${prior(line.priorMonthActualCents)}${explained(line)}`,
    ),
    `- ${revenue.name}: ${figureText(revenue.month)}${prior(revenue.priorMonthActualCents)}`,
    `- ${costs.name}: ${figureText(costs.month)}${prior(costs.priorMonthActualCents)}`,
    `- ${net.name}: ${figureText(net.month)}${prior(net.priorMonthActualCents)}`,
    `Year to date (${report.monthsToDate} months, January to ${report.periodName}):`,
    ...report.lines.map(
      (line) => `- ${line.name} (${line.lineId}): ${figureText(line.yearToDate)}`,
    ),
    `- ${revenue.name}: ${figureText(revenue.yearToDate)}`,
    `- ${costs.name}: ${figureText(costs.yearToDate)}`,
    `- ${net.name}: ${figureText(net.yearToDate)}`,
    report.unexplained.length === 0
      ? "Every variance that needs an explanation has one."
      : `Not yet explained: ${report.unexplained.join(", ")}. Next: ask the budget holder why, and record what they say with record_variance_explanation; a report draft is refused until then.`,
  ].join("\n");
}

function forecastText(forecast: CashForecast, decider: string): string {
  return [
    `CASH FORECAST — an estimate, not a fact — from ${forecast.asOf}, ${forecast.weeks.length} weeks, worked out by the desk from its receivables, bills and payroll dates. Actual cash will differ.`,
    ...forecast.weeks.map(
      (week) =>
        `Week ${week.week} (${week.from} to ${week.to}): opening ${money(week.openingCents)}, receipts ${money(week.receiptsCents)}, payments ${money(week.paymentsCents)}, closing ${money(week.closingCents)}${
          week.receipts.length + week.payments.length === 0
            ? ""
            : ` [in: ${week.receipts.map((entry) => `${entry.ref} ${money(entry.amountCents)}`).join(", ") || "none"}; out: ${week.payments.map((entry) => `${entry.ref} ${money(entry.amountCents)}`).join(", ") || "none"}]`
        }`,
    ),
    `Lowest forecast closing balance: ${money(forecast.lowest.closingCents)}, in week ${forecast.lowest.week}.`,
    forecast.shortfallWeeks.length === 0
      ? "The forecast shows no week below zero."
      : `The forecast falls below zero in week${forecast.shortfallWeeks.length === 1 ? "" : "s"} ${forecast.shortfallWeeks.join(", ")}. A plan to cover it is a person's decision: ${decider}.`,
    "Assumptions:",
    ...forecast.assumptions.map((assumption) => `- ${assumption}`),
  ].join("\n");
}

/** A desk record as JSON details: a fresh copy, which is what a tool result's details take. */
function json(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/** A revision's amount and who entered it: "<amount> a month, entered by <the approver's id>". */
const revisedText = (revision: NonNullable<ForecastVersion["revision"]>): string =>
  `${money(revision.amountCents)} a month, entered by ${revision.amountEnteredBy ?? "the person who approved it"}`;

const recipientText = (recipients: readonly Recipient[]): string =>
  recipients.map((recipient) => `${recipient.name}, ${recipient.title}`).join("; ");

const companySections = (
  limit: () => string,
): Readonly<Record<CompanySection, (company: CompanyFacts) => string>> => ({
  profile: (company) => {
    const { profile } = company;
    return presentLines([companyHeadline(profile), companyContactLine(profile)]);
  },
  hours: (company) =>
    presentLines([
      `Office: ${company.hours.office} (${company.hours.timezone}).`,
      companyClosedLine(company.hours),
    ]),
  people: (company) => companyPeopleText(company, "email"),
  budget: (company) =>
    [
      `Fiscal year ${companyData(company, "budget").fiscalYear}, January to December, approved by ${personLabel(budgetApprover(company), "the person who approves the budget")}, who also approves every revision and the release of a financial report, inside or outside the company.`,
      `The books are kept by ${personLabel(booksKeeper(company), "the person who keeps the books")}: a ledger entry that looks wrong goes to them.`,
      limit(),
      "Lines (id — name — kind — original monthly budget):",
      ...companyData(company, "budget").lines.map(
        (line) =>
          `- ${line.id} — ${line.name} — ${line.kind} — ${money(line.monthlyCents)} a month`,
      ),
    ].join("\n"),
  policies: companyPoliciesText,
  tone: companyToneText,
  escalation: companyEscalationText,
  glossary: companyGlossaryText,
});

/**
 * Builds the ten tools over one desk and one company. Every one is plain Pi Durable: they install
 * into any harness, and a harness with no desk builds the same tools and refuses at the point of use.
 */
export function financeTools(dependencies: FinanceToolDependencies): FinanceToolset {
  const { company } = dependencies;
  const limit = (): number | undefined => dependencies.limits?.()[VARIANCE_LIMIT];
  const desk = () => requireDesk(dependencies.desk, "finance");
  const approver = () => personLabel(budgetApprover(company), "the person who approves the budget");

  /** A desk refusal as the model reads it, with the next step. */
  const refused = (error: unknown, extra: Record<string, unknown>) => {
    if (!(error instanceof FinanceDeskError)) throw error;
    // The next step comes from the refusal's code, never from reading its message.
    const next: Record<DeskRefusal, string> = {
      period_open:
        " Next: tell the person the month is still open and its books are not finished, so it cannot be reported yet; offer the latest closed month.",
      unexplained_variance:
        " Next: ask the budget holder why each of these lines differed, record what they say with record_variance_explanation, then save the draft again. Never write an explanation nobody gave.",
      figure_not_in_results:
        " Next: take every figure from budget_vs_actual, margin_by_service, receivables_aging or cash_forecast exactly as the tool gave it, then save the draft again.",
      forecast_not_labelled:
        " Next: label each forecast figure as an estimate or a forecast in its sentence, then save the draft again.",
      unknown_person:
        " Next: ask who gave the explanation, by full name, from the company's people (read_company people).",
      amount_in_reason:
        " Next: ask again with the reason in words only; the person approving enters the amount.",
      outside_recipient: ` Next: send nothing. A report for anyone outside the company, a lender or a bank included, is ${approver()}'s decision; say so.`,
      facts_changed:
        " Next: tell the person it changed after it was put to a person, so nothing was done; read it again before anything else.",
      // The desk's own message already says what to do for these.
      not_found: "",
      invalid: "",
      already_released: "",
    };
    return deskRefusal(`${error.message}${next[error.code]}`, error.code, extra);
  };

  const listPeriods = defineTool({
    name: "list_periods",
    description:
      "List the fiscal year's months and which are closed (reportable) and which is still open, the report drafts saved and whether each was released, the variance explanations recorded, and the forecast versions.",
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      const finance = desk();
      const [periods, drafts, explanations, versions] = await Promise.all([
        finance.listPeriods(),
        finance.listDrafts(),
        finance.listExplanations(),
        finance.listForecastVersions(),
      ]);
      return {
        ...textResult(
          [
            "Months:",
            ...periods.map(
              (period) =>
                `- ${period.id} — ${period.name} — ${period.status === "closed" ? `closed ${period.closedOn ?? ""}` : "open: the books are not finished"}`,
            ),
            `Report drafts (${drafts.length}):`,
            ...drafts.map(
              (draft) =>
                `- ${draft.id} — ${draft.title} — ${draft.period} — ${draft.status === "released" ? `released ${draft.releasedOn ?? ""} to ${recipientText(draft.releasedTo)}` : "draft, not released"}`,
            ),
            `Variance explanations (${explanations.length}):`,
            ...explanations.map(
              (entry) =>
                `- ${entry.period} ${entry.lineId} — ${entry.kind} — ${entry.cause} — given by ${entry.givenBy.name}, ${entry.givenBy.title}`,
            ),
            "Forecast versions (the original budget never changes):",
            ...versions.map((version) =>
              version.revision === null
                ? `- ${version.id} — the original budget as the forecast`
                : `- ${version.id} — from ${version.basedOn ?? ""}, ${version.createdOn}: ${version.revision.lineName} revised to ${revisedText(version.revision)} (${version.revision.reason})`,
            ),
          ].join("\n"),
        ),
        details: json({ periods, drafts, explanations, versions }),
      };
    },
  });

  const budgetVsActual = defineTool({
    name: "budget_vs_actual",
    description:
      "Compare one closed month with the original budget, for the month and the year to date: every line's budget, actual and variance (value and percentage), whether it is favourable or unfavourable, the prior month's actual, the totals, and which variances over the explanation limit still need an explanation. Every figure is the desk's. Refuses a month that is not closed.",
    parameters: obj({ period: PERIOD }),
    replay: "safe",
    execute: async (args) => {
      try {
        // The limit is read now, so an overlay's value is the one the desk judges against.
        const report = await desk().budgetVsActual(args.period, { limitCents: limit() });
        return { ...textResult(budgetVsActualText(report)), details: json(report) };
      } catch (error) {
        return refused(error, { period: args.period });
      }
    },
  });

  const marginByService = defineTool({
    name: "margin_by_service",
    description:
      "Work out one closed month's revenue, direct costs and gross margin for each service, and the overhead left over. Overhead is not apportioned to the services, so a service's margin is before overhead. Every figure is the desk's. Refuses a month that is not closed.",
    parameters: obj({ period: PERIOD }),
    replay: "safe",
    execute: async (args) => {
      try {
        const margin = await desk().marginByService(args.period);
        return {
          ...textResult(
            [
              `Margin by service for ${margin.periodName} (${margin.period}), worked out by the desk:`,
              ...margin.services.map(
                (service) =>
                  `- ${service.name}: revenue ${money(service.revenueCents)}, direct costs ${money(service.directCostCents)}, gross margin ${money(service.marginCents)} (${percent(service.marginPercent)})`,
              ),
              `- All services: revenue ${money(margin.totals.revenueCents)}, direct costs ${money(margin.totals.directCostCents)}, gross margin ${money(margin.totals.marginCents)} (${percent(margin.totals.marginPercent)})`,
              `Direct costs shared out: ${margin.directCostLines.map((line) => `${line.name} ${money(line.actualCents)}`).join("; ")}.`,
              `Overhead is not apportioned to the services: ${margin.overhead.lines.map((line) => `${line.name} ${money(line.actualCents)}`).join("; ")} — ${money(margin.overhead.totalCents)} in all. Each service's margin is before overhead; say so when you give it.`,
              `Net result after overhead: ${money(margin.netResultCents)}.`,
            ].join("\n"),
          ),
          details: json(margin),
        };
      } catch (error) {
        return refused(error, { period: args.period });
      }
    },
  });

  const receivablesAging = defineTool({
    name: "receivables_aging",
    description:
      "Age the open receivables by due date as of today: not yet due, then overdue by 1 to 30, 31 to 60, 61 to 90 and over 90 days, with each period's total, count and share, and every open invoice. Every figure is the desk's.",
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      const aging = await desk().receivablesAging();
      const label = (bucket: string) =>
        bucket === "not yet due" ? "Not yet due" : `${bucket} days overdue`;
      return {
        ...textResult(
          [
            `Receivables as of ${aging.asOf}, by due date, worked out by the desk:`,
            ...aging.buckets.map(
              (bucket) =>
                `${label(bucket.bucket)}: ${money(bucket.totalCents)} (${bucket.count} ${bucket.count === 1 ? "invoice" : "invoices"}, ${bucket.sharePercent}%)`,
            ),
            `Total open: ${money(aging.totalCents)}.`,
            "Invoices:",
            ...aging.invoices.map(
              (invoice) =>
                `- ${invoice.invoice} — ${invoice.customer} — due ${invoice.dueOn} — ${money(invoice.amountCents)} — ${invoice.daysOverdue > 0 ? `${invoice.daysOverdue} days overdue` : "not yet due"}`,
            ),
          ].join("\n"),
        ),
        details: json(aging),
      };
    },
  });

  const cashForecast = defineTool({
    name: "cash_forecast",
    description: `Forecast cash week by week from today's bank balance, the open receivables, the bills and the payroll dates the desk holds: each week's opening balance, receipts, payments and closing balance, the lowest balance and any week below zero. A forecast is an estimate only; the result states its assumptions. Default ${DEFAULT_FORECAST_WEEKS} weeks, at most ${MAX_FORECAST_WEEKS}.`,
    parameters: obj({
      weeks: opt(
        int({
          minimum: 1,
          maximum: MAX_FORECAST_WEEKS,
          description: `How many weeks to forecast, 1 to ${MAX_FORECAST_WEEKS}; ${DEFAULT_FORECAST_WEEKS} when omitted`,
        }),
      ),
    }),
    replay: "safe",
    execute: async (args) => {
      try {
        const forecast = await desk().cashForecast(args.weeks ?? DEFAULT_FORECAST_WEEKS);
        return { ...textResult(forecastText(forecast, approver())), details: json(forecast) };
      } catch (error) {
        return refused(error, {});
      }
    },
  });

  const recordVarianceExplanation = defineTool({
    name: "record_variance_explanation",
    description:
      "Record why one budget line of a closed month differed from the budget, as the person who explained it said: the cause, whether it is timing (likely to be made up in later months) or permanent (not expected to be made up), and who gave it, by full name or email from the company's people. A later explanation of the same line and month replaces the earlier one. An internal note: it changes no figure and no budget.",
    parameters: obj({
      period: PERIOD,
      lineId: str({
        description: "The budget line's id from budget_vs_actual, e.g. recurring-contracts",
      }),
      cause: str({ minLength: 1, description: "The cause, as the person gave it" }),
      kind: union(
        EXPLANATION_KINDS.map((kind) => lit(kind)),
        { description: "timing or permanent" },
      ),
      givenBy: str({
        minLength: 1,
        description: "Who explained it: their full name or email, from the company's people",
      }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const explanation = await desk().recordVarianceExplanation(
          {
            period: args.period,
            lineId: args.lineId,
            cause: args.cause,
            kind: args.kind as ExplanationKind,
            givenBy: args.givenBy,
          },
          { requestId: requestId("explanation", api) },
        );
        return {
          ...textResult(
            `Recorded the explanation of ${explanation.lineName} for ${periodName(explanation.period)} (variance ${money(explanation.varianceCents)}, ${explanation.direction}): ${explanation.kind} — ${explanation.cause} — given by ${explanation.givenBy.name}, ${explanation.givenBy.title}. An internal note: no figure, budget or ledger entry changed.`,
          ),
          details: json(explanation),
        };
      } catch (error) {
        return refused(error, { period: args.period, lineId: args.lineId });
      }
    },
  });

  const saveReportDraft = defineTool({
    name: "save_report_draft",
    description:
      "Save a draft management report for a closed month: a title and the commentary. The desk refuses it while a variance over the explanation limit has no explanation, names any money figure that is not in the computed results (the month, the year to date, the month before, the margins, the receivables or the cash forecast), and refuses a forecast figure whose sentence does not label it as an estimate. A draft is internal: nothing is released or sent.",
    parameters: obj({
      title: str({ minLength: 1, description: "The report's title" }),
      period: PERIOD,
      commentary: str({
        minLength: 1,
        description:
          "The commentary: a short summary first, then the significant variances and their explanations; every figure exactly as a tool gave it",
      }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const draft = await desk().saveReportDraft(
          { title: args.title, period: args.period, commentary: args.commentary },
          // The limit is read now, so an overlay's value is the one the draft is checked against.
          { requestId: requestId("draft", api), limitCents: limit() },
        );
        return {
          ...textResult(
            `Saved ${draft.id}: ${draft.title}, for ${draft.periodName}. Every money figure in it is in the computed results. It is a draft: Nothing has been released or sent. Releasing it to named people in the company is request_report_release, which asks a person.`,
          ),
          details: json(draft),
        };
      } catch (error) {
        return refused(error, { period: args.period });
      }
    },
  });

  /**
   * The `release_report` approval's facts: the draft and its recipients as the desk holds them, read
   * before anyone is asked. A recipient outside the company, a released draft or an unknown one has
   * nothing to approve, so it throws and the gate asks nobody.
   */
  const releaseApprovalFacts: ApprovalFactsReader = async (args) => {
    const draftId = String(args.draftId);
    const recipients = Array.isArray(args.recipients) ? args.recipients.map(String) : [];
    let facts: Record<string, unknown>;
    try {
      facts = await desk().releaseFacts({ draftId, recipients });
    } catch (error) {
      if (!(error instanceof FinanceDeskError)) throw error;
      const outside =
        error.code === "outside_recipient"
          ? ` Anything for someone outside the company is ${approver()}'s decision.`
          : "";
      throw new Error(
        `${error.message}${outside} Nothing was put to a person and nothing was sent.`,
      );
    }
    const chosen = facts.recipients as Recipient[];
    return {
      summary: `Release ${draftId} (${String(facts.title)}, ${String(facts.period)}) to ${recipientText(chosen)}. Commentary as saved: ${String(facts.commentary)}`,
      facts,
    };
  };

  const requestReportRelease = defineTool({
    name: "request_report_release",
    description:
      "Ask a person to release one saved report draft to named recipients, each one of the company's people by full name or email. Every call waits for a person. The desk refuses anyone outside the company before anyone is asked: a lender, a bank or any other outside party is never a recipient. Once approved, the desk releases exactly that draft to exactly those people.",
    parameters: obj({
      draftId: str({ description: "The draft's number, e.g. RD-102" }),
      recipients: arr(
        str({ description: "A person's full name or email, from the company's people" }),
        { minItems: 1, description: "Who receives it: the company's people only" },
      ),
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return refusal(
          `Nothing was released: this call to release ${args.draftId} carries no facts a person approved. A report is released only after the approval gate has put it to a person and they said yes. Next: tell the person releasing it needs a person's approval and nothing was released.`,
          { code: "not_approved", draftId: args.draftId },
        );
      }
      try {
        const draft = await desk().releaseReport(
          { draftId: args.draftId, recipients: args.recipients, approved },
          { requestId: requestId("release", api) },
        );
        return {
          ...textResult(
            `Approved and released: ${draft.id} to ${recipientText(draft.releasedTo)}, on ${draft.releasedOn ?? ""}. Released inside the company only.`,
          ),
          details: json(draft),
        };
      } catch (error) {
        return refused(error, { draftId: args.draftId });
      }
    },
  });

  /**
   * The `budget_revision` approval's facts: the line, its original monthly budget, the current
   * forecast version and the reason, read before anyone is asked. No amount: the person approving
   * enters it. An unknown line or an empty reason throws, and the gate asks nobody.
   */
  const revisionApprovalFacts: ApprovalFactsReader = async (args) => {
    let facts: Record<string, unknown>;
    try {
      facts = await desk().revisionFacts({
        lineId: String(args.lineId),
        reason: String(args.reason ?? ""),
      });
    } catch (error) {
      if (!(error instanceof FinanceDeskError)) throw error;
      throw new Error(`${error.message} Nothing was put to a person and nothing was revised.`);
    }
    return {
      summary: `Revise the forecast for ${String(facts.lineName)} (${String(facts.lineId)}, ${String(facts.kind)}; original budget ${money(Number(facts.originalMonthlyCents))} a month), from forecast version ${String(facts.basedOn)}. Reason: ${String(facts.reason)}. No amount is proposed: you enter the line's revised monthly budget when you approve, and the forecast version is opened at that amount. The original budget stays as it is, and actuals stay reported against it.`,
      facts,
    };
  };

  const requestBudgetRevision = defineTool({
    name: "request_budget_revision",
    description:
      "Ask a person to revise one budget line's forecast, giving the line and the reason only: never an amount. Every call waits for a person, who enters the line's revised monthly budget with their yes. Once approved, the desk opens a new forecast version at the amount they entered; the original budget never changes and actuals stay reported against it.",
    parameters: obj({
      lineId: str({ description: "The budget line's id, e.g. recurring-contracts" }),
      reason: str({
        minLength: 1,
        description: "Why the line's forecast should change, as the budget holder explained it",
      }),
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
      [APPROVED_VALUE_ARG]: approvedValueParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return refusal(
          `Nothing was revised: this call to revise ${args.lineId} carries no facts a person approved. A forecast is revised only after the approval gate has put it to a person and they said yes. Next: tell the person the revision needs a person's approval and nothing was revised.`,
          { code: "not_approved", lineId: args.lineId },
        );
      }
      // The amount is the person's, entered with their yes; there is no other figure to fall back on.
      let entered: ApprovedValue;
      try {
        entered = approvedValue(args, REVISED_VALUE);
      } catch {
        return refusal(
          `Nothing was revised: this call to revise ${args.lineId} carries no revised amount a person entered. The amount is entered by the person approving, with their yes. Next: tell the person the revision needs a person's approval and nothing was revised.`,
          { code: "not_approved", lineId: args.lineId },
        );
      }
      try {
        const version = await desk().reviseForecast(
          {
            lineId: args.lineId,
            reason: args.reason,
            approved,
            amountCents: entered.cents,
            enteredBy: entered.by,
          },
          { requestId: requestId("revision", api) },
        );
        return {
          ...textResult(
            `Approved: forecast version ${version.id} opened from ${version.basedOn ?? ""} for ${version.revision?.lineName ?? args.lineId} at ${version.revision === null ? money(entered.cents) : revisedText(version.revision)} (${version.revision?.reason ?? args.reason}). The amount is the one the person approving entered, not this role's; the original budget is unchanged and actuals stay reported against it.`,
          ),
          details: json(version),
        };
      } catch (error) {
        return refused(error, { lineId: args.lineId });
      }
    },
  });

  const readCompany = readCompanyTool({
    company,
    description:
      "Read one section of the company record: the profile, the office hours, the people and what each decides, the budget (the fiscal year, who approves it and releases financial reports, who keeps the books, every line with its kind and original monthly budget, and the variance explanation limit), the policies, the tone of voice, the escalation path or the glossary.",
    sections: companySections(() => limitText(limit())),
  });

  return {
    listPeriods,
    budgetVsActual,
    marginByService,
    receivablesAging,
    cashForecast,
    recordVarianceExplanation,
    saveReportDraft,
    requestReportRelease,
    requestBudgetRevision,
    readCompany,
    releaseApprovalFacts,
    revisionApprovalFacts,
  };
}
