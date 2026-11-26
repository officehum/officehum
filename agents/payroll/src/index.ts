/**
 * The Payroll and Benefits role's entry point: the factory a host calls to get the role.
 *
 * ```ts
 * import payroll from "@officehum/payroll";
 *
 * const role = payroll({ desk: myPayrollSystem, approve, sender, overlays: ["./my-payroll"] });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 *
 * The package brings its own prompt, skills, tools, the company's facts and demonstration timesheets,
 * runs and enrolments; the host brings the desk that holds its real payroll and benefits records, who
 * sent each piece of work, and, optionally, the person who decides gated actions. Nothing here needs
 * Office Hum, so the same bundle runs in a bare Pi Durable harness.
 *
 * With `demo: true` and no desk the role runs on `fakePayrollDesk`: the company's own schedule, crews
 * and plans, demonstration people in memory, and nothing written anywhere. That is what
 * `officehum run --demo` and the evals run on. With neither, the role still starts, and every tool
 * that reads or writes the desk refuses and says how to bind one.
 */

import { fileURLToPath } from "node:url";
import {
  type Approver,
  type DefinedRole,
  declaredFacts,
  defineRole,
  type SenderResolver,
} from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { DEMO_NOW, fakePayrollDesk, type PayrollDesk } from "./desk.js";
import { payrollTools } from "./tools.js";

export {
  type BenefitPlanFact,
  COMPANY_FACTS_URL,
  type CompanyFacts,
  type Crew,
  type EscalationRule,
  escalationOwner,
  type GlossaryEntry,
  type Hours,
  loadCompanyFacts,
  type PayrollPolicy,
  type Person,
  type Profile,
  payOwner,
  payrollApprover,
  person,
  personLabel,
  type StaffPolicies,
  type Tone,
  timesheetApprover,
} from "./company.js";
export {
  type BenefitsSummary,
  DEMO_NOW,
  DEMO_OFFICE_SALARY_CENTS,
  DEMO_PLAN_COSTS_CENTS,
  type DeskRefusal,
  demoEmployees,
  demoEnrollments,
  demoRuns,
  demoTimesheets,
  ENROLLMENT_ACTIONS,
  type EnrollmentAction,
  type EnrollmentChange,
  type EnrollmentChangeInput,
  type EnrollmentExceptionFacts,
  type EnrollmentExceptionInput,
  type FakePayrollDeskOptions,
  fakePayrollDesk,
  LIFE_EVENT_PLAN_KINDS,
  LIFE_EVENTS,
  type LifeEventKind,
  type OvertimeNote,
  type PayAdjustment,
  type PayAdjustmentFacts,
  type PayAdjustmentInput,
  type PayBasis,
  type PayEmployee,
  type PayPeriod,
  type PayRun,
  type PayRunFacts,
  type PayRunLine,
  type PayRunStatus,
  type PayrollDesk,
  PayrollDeskError,
  type PayStatement,
  type RunWeek,
  type SeededRun,
  type Timesheet,
  type TimesheetFlag,
  type TimesheetNudge,
  type TimesheetPeriod,
  type TimesheetStatus,
  type TimesheetSummary,
  type WorkweekHours,
} from "./desk.js";
export {
  ADJUSTMENT_VALUE,
  type CompanySection,
  HINTS,
  type PayrollToolDependencies,
  type PayrollToolset,
  payrollTools,
  SPECIAL_ENROLLMENT_DAYS,
} from "./tools.js";

export interface PayrollOptions {
  /**
   * The host's payroll and benefits system: a payroll service in production, `fakePayrollDesk` in a
   * test. Omitted, the demonstration data when `demo` is set; otherwise none, and every desk tool
   * refuses.
   */
  readonly desk?: PayrollDesk;
  /**
   * Run on the demonstration data this package ships with when no `desk` is given. Set by the host
   * (`officehum run --demo`, the eval runner), never by a client or a user's config.
   */
  readonly demo?: boolean;
  /** The company. Omitted, the generated facts in this package. */
  readonly company?: CompanyFacts;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /** Decides every gated action. Omitted: every pay run, correction and enrolment exception is blocked. */
  readonly approve?: Approver;
  /**
   * The host's clock. The prompt's `today` section and the demonstration desk read it. Omitted: the
   * demonstration date (`DEMO_NOW`) on the demonstration desk, the system clock otherwise.
   */
  readonly now?: () => Date;
  /**
   * Who each call's work came from, as the host verified it. A pay statement, a benefits summary and
   * a benefit change are only ever the sender's own, and only office staff list timesheets or prepare
   * and submit a pay run. Omitted: every sender is unknown, so nothing personal is given out.
   */
  readonly sender?: SenderResolver;
}

export default function payroll(options: PayrollOptions = {}): DefinedRole {
  // The demonstration desk is built only when the host asks for it (`demo`) and binds no desk of
  // its own; with neither, the tools refuse rather than invent records.
  const demoDesk = options.desk === undefined && options.demo === true;
  // The demonstration data is dated around DEMO_NOW, so its desk keeps that date unless the host
  // passes a clock; otherwise the role runs on the system clock. The prompt reads the same clock.
  const now = options.now ?? (demoDesk ? () => new Date(DEMO_NOW) : () => new Date());
  const company = options.company ?? loadCompanyFacts();
  const desk = demoDesk ? fakePayrollDesk({ company, now }) : options.desk;
  // The special enrolment period is read from the role's own resolved limits at every call, so an
  // overlay's value is what a life-event change is judged against and a reload needs no rebuild.
  // Before the role exists no limit resolves, and the desk then sends every such change to a person.
  let role: DefinedRole | undefined;
  const limits = () => role?.current().limits ?? {};
  const tools = payrollTools({
    desk,
    company,
    limits,
    ...(options.sender === undefined ? {} : { sender: options.sender }),
  });
  role = defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    now,
    // The prompt's "today" is the company's day, the same one the desk counts periods from.
    timeZone: company.hours.timezone,
    tools: [
      tools.listPayPeriods,
      tools.listTimesheets,
      tools.flagTimesheet,
      tools.requestTimesheetApproval,
      tools.preparePayRun,
      tools.submitPayRun,
      tools.requestPayAdjustment,
      tools.getPayStatement,
      tools.getBenefitsSummary,
      tools.recordEnrollmentChange,
      tools.requestEnrollmentException,
      tools.readCompany,
    ],
    // The three approvals are `officehum.json`'s, on every call of their tool; the SDK's gate
    // evaluates them here and in the office from the same declaration. Their facts are read from the
    // desk (whose pay or benefits, from the verified sender), shown to the person, and handed to the
    // tool on a yes, so the desk writes only what they saw.
    approvalFacts: {
      any_pay_run: declaredFacts(
        [
          "runId",
          "periodStart",
          "periodEnd",
          "payDay",
          "employees",
          "regularHours",
          "overtimeHours",
          "unauthorisedOvertimeHours",
          "grossCents",
        ],
        tools.payRunApprovalFacts,
      ),
      // The bounds are facts the reader states, so `checkAgent` can see the value's minFact and maxFact.
      pay_adjustment: declaredFacts(
        [
          "runId",
          "periodStart",
          "periodEnd",
          "employeeId",
          "employee",
          "reason",
          "lowestCents",
          "highestCents",
        ],
        tools.payAdjustmentApprovalFacts,
      ),
      enrollment_exception: tools.enrollmentExceptionFacts,
    },
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
  return role;
}
