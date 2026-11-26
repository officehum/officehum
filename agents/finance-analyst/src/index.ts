/**
 * The Finance Analysis role's entry point: the factory a host calls to get the role.
 *
 * ```ts
 * import financeAnalyst from "@officehum/finance-analyst";
 *
 * const role = financeAnalyst({ desk: myFinanceSystem, approve, overlays: ["./my-finance"] });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 *
 * The package brings its own prompt, skills, tools, the company's facts and a demonstration finance
 * desk; the host brings the desk that holds its real figures and, optionally, the person who decides
 * gated actions. Nothing here needs Office Hum, so the same bundle runs in a bare Pi Durable harness.
 *
 * With `demo: true` and no desk the role runs on `fakeFinanceDesk`: ten closed months of actuals for
 * the company's budget lines, one open month, open receivables, bills and payroll dates, in memory,
 * with nothing sent anywhere. That is what `officehum run --demo` and the evals run on. With neither,
 * the role still starts, and every tool that reads or writes the desk refuses and says how to bind
 * one.
 *
 * The data tools (`data_inspect`, `data_query`, `data_export`, `chart_render`) are declared here and
 * supplied by the office as the data pack (`packs`); this package has no code for them and no
 * dependency on it, and without the pack the role offers none of them.
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, defineRole, type ToolPack } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { DEMO_NOW, type FinanceDesk, fakeFinanceDesk } from "./desk.js";
import { financeTools } from "./tools.js";

export {
  type BudgetLine,
  type BudgetSettings,
  booksKeeper,
  budgetApprover,
  COMPANY_FACTS_URL,
  type CompanyFacts,
  type EscalationRule,
  type GlossaryEntry,
  type Hours,
  type LineKind,
  loadCompanyFacts,
  money,
  type Person,
  type Policies,
  type Profile,
  person,
  personByRecipient,
  personLabel,
  type Tone,
} from "./company.js";
export {
  AGING_BUCKETS,
  type AgedReceivable,
  type AgingBucket,
  type AgingReport,
  type BudgetVsActual,
  type CashForecast,
  type CashMovement,
  type CostLineActual,
  DEMO_DIRECT_COST_SHARES,
  DEMO_NOW,
  DEMO_OPENING_BALANCE_CENTS,
  type DeskRefusal,
  type Direction,
  type DraftInput,
  demoActuals,
  demoPayables,
  demoPayroll,
  demoReceivables,
  directionOf,
  EXPLANATION_KINDS,
  type ExplanationInput,
  type ExplanationKind,
  type FakeFinanceDeskOptions,
  type FinanceDesk,
  FinanceDeskError,
  type ForecastVersion,
  type ForecastWeek,
  fakeFinanceDesk,
  type LineResult,
  MAX_FORECAST_WEEKS,
  type MarginReport,
  moneyFigures,
  type Payable,
  type PayrollRun,
  type Period,
  periodName,
  type Receivable,
  type Recipient,
  type ReleaseInput,
  type ReportDraft,
  type RevisionInput,
  releaseFactsOf,
  type ServiceMargin,
  type TotalResult,
  type VarianceExplanation,
  type VarianceFigure,
} from "./desk.js";
export {
  type CompanySection,
  DEFAULT_FORECAST_WEEKS,
  type FinanceToolDependencies,
  type FinanceToolset,
  financeTools,
  REVISED_VALUE,
  VARIANCE_LIMIT,
} from "./tools.js";

export interface FinanceAnalystOptions {
  /**
   * The host's finance system: an accounting package's reporting API or a planning tool in
   * production, `fakeFinanceDesk` in a test. Omitted, the demonstration desk when `demo` is set;
   * otherwise none, and every desk tool refuses.
   */
  readonly desk?: FinanceDesk;
  /**
   * Run on the demonstration desk this package ships with when no `desk` is given. Set by the host
   * (`officehum run --demo`, the eval runner), never by a client or a user's config.
   */
  readonly demo?: boolean;
  /**
   * The company to work for. Omitted, the generated facts in this package. A host with its own
   * company passes its own, and nothing in `company/default/` is involved.
   */
  readonly company?: CompanyFacts;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /** Decides every gated action. Omitted: every release and revision is blocked. */
  readonly approve?: Approver;
  /**
   * The host's clock. The prompt's `today` section and the demonstration desk read it. Omitted: the
   * demonstration date (`DEMO_NOW`) on the demonstration desk, the system clock otherwise.
   */
  readonly now?: () => Date;
  /**
   * The tool packs the office supplies: the data pack (`@officehum/tools-data`) gives the four data
   * tools this manifest declares with `"pack": "data"`. Omitted: the role runs without them.
   */
  readonly packs?: readonly ToolPack[];
}

export default function financeAnalyst(options: FinanceAnalystOptions = {}): DefinedRole {
  // The demonstration desk is built only when the host asks for it (`demo`) and binds no desk of
  // its own; with neither, the tools refuse rather than invent figures.
  const demoDesk = options.desk === undefined && options.demo === true;
  // The demonstration data is dated around DEMO_NOW, so its desk keeps that date unless the host
  // passes a clock; otherwise the role runs on the system clock. The prompt reads the same clock.
  const now = options.now ?? (demoDesk ? () => new Date(DEMO_NOW) : () => new Date());
  const company = options.company ?? loadCompanyFacts();
  // The demonstration desk works from the company's own budget lines, so a first run and a real one
  // compare against the same budget.
  const desk = demoDesk ? fakeFinanceDesk({ company, now }) : options.desk;
  // The variance explanation limit is read from the role's own resolved limits at every call, so an
  // overlay's value is what a draft is checked against and a reload needs no rebuild. Before the
  // role exists no limit resolves, and the desk then needs every variance explained.
  let role: DefinedRole | undefined;
  const limits = () => role?.current().limits ?? {};
  const tools = financeTools({ desk, company, limits });
  role = defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    now,
    // "Today" in the prompt is the company's own day, as it is on the desk, not UTC's.
    timeZone: company.hours.timezone,
    tools: [
      tools.listPeriods,
      tools.budgetVsActual,
      tools.marginByService,
      tools.receivablesAging,
      tools.cashForecast,
      tools.recordVarianceExplanation,
      tools.saveReportDraft,
      tools.requestReportRelease,
      tools.requestBudgetRevision,
      tools.readCompany,
    ],
    // Both approvals are `officehum.json`'s, on every call. The model names only the draft and its
    // recipients, or the line and the reason: the gate reads what is approved from the desk, shows it
    // to the person and hands it to the tool on a yes, so the desk acts only on what they saw.
    approvalFacts: {
      release_report: tools.releaseApprovalFacts,
      budget_revision: tools.revisionApprovalFacts,
    },
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
    ...(options.packs === undefined ? {} : { packs: options.packs }),
  });
  return role;
}
