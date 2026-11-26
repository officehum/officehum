/**
 * The Payroll and Benefits role's twelve tools.
 *
 * `list_pay_periods`, `list_timesheets`, `get_pay_statement`, `get_benefits_summary` and
 * `read_company` only read. Who is asking comes from the host's verified sender (`SenderResolver`),
 * never from an argument or the message: a pay statement, a benefits summary and a benefit change are
 * only ever the sender's own, and only office staff list timesheets or prepare and submit a pay run.
 * No tool speaks one person's pay to anyone but that person: `prepare_pay_run` gives hours per
 * employee and the run's total only.
 *
 * The writes with no approval — a timesheet flag, a nudge to the timesheet approvers, a draft pay run,
 * a benefit change inside the rules — go through the desk, and each refusal comes back with a code the
 * tools turn into the next step. `submit_pay_run`, `request_pay_adjustment` and
 * `request_enrollment_exception` are approval-gated on every call; their approvals are
 * `officehum.json`'s, evaluated by the SDK's gate before the tool runs, and the facts a person sees are
 * read from the desk here. A correction's amount is the person's, entered with their yes and handed
 * to `request_pay_adjustment` by the gate (`approvedValue`); no tool takes one from the model. The
 * special enrolment period is the role's own limit, read at every call
 * and handed to the desk, so an overlay's value is the one a life-event change is judged against.
 *
 * Every hour and amount a tool speaks comes back from the desk, and every name from the company record.
 */

import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { lit, obj, opt, str, union } from "@earendil-works/pi-schema";
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
  companyData,
  companyGlossaryText,
  companyHeadline,
  companyPeopleText,
  companyToneText,
  deskRefusal,
  money,
  presentLines,
  readCompanyTool,
  refusal,
  requestId,
  requireDesk,
  type SenderResolver,
  textResult,
} from "@officehum/sdk";
import {
  type CompanyFacts,
  payOwner,
  payrollApprover,
  person,
  personLabel,
  timesheetApprover,
} from "./company.js";
import {
  type DeskRefusal,
  ENROLLMENT_ACTIONS,
  type EnrollmentAction,
  type EnrollmentChange,
  LIFE_EVENTS,
  type LifeEventKind,
  type PayPeriod,
  type PayRun,
  type PayrollDesk,
  PayrollDeskError,
  type WorkweekHours,
} from "./desk.js";

/** The role's limit a life-event change is judged against (`officehum.json`'s `limits`). */
export const SPECIAL_ENROLLMENT_DAYS = "special_enrollment_days";

/** The value the `pay_adjustment` approval asks the person for (`officehum.json`'s approvals). */
export const ADJUSTMENT_VALUE = "adjustmentCents";

export interface PayrollToolDependencies {
  readonly desk: PayrollDesk | undefined;
  readonly company: CompanyFacts;
  /**
   * The role's resolved limits, read at every call: the manifest's defaults with the business's
   * overlay on top. Omitted, no limit resolves and every life-event change goes to a person.
   */
  readonly limits?: () => Readonly<Record<string, number>>;
  /** The host's verified sender of each call's work. Omitted: every sender is unknown. */
  readonly sender?: SenderResolver;
}

export interface PayrollToolset {
  readonly listPayPeriods: ToolRegistration;
  readonly listTimesheets: ToolRegistration;
  readonly flagTimesheet: ToolRegistration;
  readonly requestTimesheetApproval: ToolRegistration;
  readonly preparePayRun: ToolRegistration;
  readonly submitPayRun: ToolRegistration;
  readonly requestPayAdjustment: ToolRegistration;
  readonly getPayStatement: ToolRegistration;
  readonly getBenefitsSummary: ToolRegistration;
  readonly recordEnrollmentChange: ToolRegistration;
  readonly requestEnrollmentException: ToolRegistration;
  readonly readCompany: ToolRegistration;
  /** The `any_pay_run` approval's facts: the draft's period, pay day, headcount, hours and total. */
  readonly payRunApprovalFacts: ApprovalFactsReader;
  /**
   * The `pay_adjustment` approval's facts: whose pay (from the verified sender), which run, why, and
   * the bounds the person approving enters the adjustment within (minus and plus that gross).
   */
  readonly payAdjustmentApprovalFacts: ApprovalFactsReader;
  /** The `enrollment_exception` approval's facts: whose change (the sender's), which plan, why. */
  readonly enrollmentExceptionFacts: ApprovalFactsReader;
}

export type CompanySection =
  | "profile"
  | "hours"
  | "people"
  | "crews"
  | "payroll"
  | "tone"
  | "escalation"
  | "glossary";

const PERIOD = opt(
  str({
    description:
      "Any day in the pay period, as YYYY-MM-DD. Leave it out for the most recent closed period",
  }),
);

const RUN_ID = str({ description: "The pay run's id, e.g. PR-2026-11-23" });

const literals = <T extends string>(values: readonly T[], description: string) =>
  union(
    values.map((value) => lit(value)),
    { description },
  );

const words = (value: string): string => value.replaceAll("_", " ");

/** "44 h", with the hours as the desk gave them. */
const h = (value: number): string => `${value} h`;

const weeksText = (weeks: readonly WorkweekHours[]): string =>
  weeks.map((week) => `week of ${week.start}: ${h(week.hours)}`).join("; ");

/**
 * The next step for every refusal the desk can give, keyed by its code and never by its message. A
 * `Record` over the whole union, so a new code does not compile until it has a hint.
 */
export function HINTS(company: CompanyFacts): Record<DeskRefusal, string> {
  const pay = personLabel(payOwner(company), "the person who answers pay questions");
  return {
    not_found: " Check the name or id, with list_pay_periods for runs, and try once.",
    ambiguous: " Ask which of them it is, by full name.",
    invalid: " Fix what it says and try once, or ask the person for what is missing.",
    unknown_sender: ` Next: tell them nothing was shared or recorded, and that they can ask from the address or number the company has for them, or ask ${pay} directly.`,
    not_staff: ` Next: say pay and benefits are for the employee only, and share nothing about anyone; ${pay} answers pay questions.`,
    not_office:
      " Next: say timesheets and pay runs are kept by the office, and share nothing about anyone; an employee can ask for their own pay statement.",
    someone_else:
      " Next: tell the sender each employee asks about their own pay, or office staff raise it for them; ask nothing under the sender's name instead.",
    not_closed: " Next: say the pay run is prepared once the period has ended, and when that is.",
    timesheets_open:
      " Next: request_timesheet_approval for the period asks the people who approve them; tell the asker which timesheets are open and that the run waits for them. Do not prepare it again until they are approved.",
    nothing_open: " Next: every timesheet is approved: prepare the pay run with prepare_pay_run.",
    already_approved:
      " Next: an approved pay run is final. If something on it is wrong, request_pay_adjustment asks a person to approve a correction.",
    still_draft:
      " Next: the run is still a draft, so correct it by fixing the timesheet and calling prepare_pay_run again; no adjustment is needed.",
    run_changed:
      " Next: nothing was approved, because the draft no longer matches what the person saw. Call submit_pay_run again to put the current draft to a person.",
    changed:
      " Next: nothing was recorded, because it no longer matches what the person approved. If it is still wanted, call the same tool again, which puts it to a person.",
    no_statement:
      " Next: say no approved pay run holds a statement for them yet; a draft has none until a person approves it.",
    outside_window:
      " Next: if the employee named a qualifying life event, call record_enrollment_change again with its kind and date; if not, request_enrollment_exception asks a person.",
    event_too_old:
      " Next: request_enrollment_exception asks a person, with the employee's reason; do not record it again.",
    plan_not_eligible:
      " Next: request_enrollment_exception asks a person, with the employee's reason; do not record it again.",
    duplicate: " Tell the employee what is already on record; do not record it again.",
    not_needed: " Next: record it with record_enrollment_change.",
  };
}

function periodLine(period: PayPeriod): string {
  const run =
    period.run === null ? "no pay run" : `pay run ${period.run.id} (${period.run.status})`;
  return `${period.start} to ${period.end} — pay day ${period.payDay} — ${period.closed ? "closed" : "open"} — ${run}`;
}

/** A pay run as office staff read it: hours per employee and the run's total, never one person's pay. */
function runText(run: PayRun, company: CompanyFacts): string {
  const hourly = run.lines.filter((line) => !line.salaried);
  const salaried = run.lines.length - hourly.length;
  const notes =
    run.overtimeNotes.length === 0
      ? "No overtime was worked without authorisation."
      : `Overtime worked without authorisation, paid in full and noted for the person who approves the timesheet: ${run.overtimeNotes
          .map(
            (note) =>
              `${note.employee}, ${h(note.hours)} in the week of ${note.weekStart} (noted for ${personLabel({ id: "", name: note.toName, title: note.toTitle })})`,
          )
          .join("; ")}.`;
  return [
    `Prepared draft pay run ${run.id} for ${run.periodStart} to ${run.periodEnd}, pay day ${run.payDay}: ${run.employees} employees (${hourly.length} hourly, ${salaried} salaried). Nobody has been paid.`,
    ...hourly.map(
      (line) =>
        `- ${line.name} — ${h(line.regularHours)} regular, ${h(line.overtimeHours)} overtime (${weeksText(line.weeks)})`,
    ),
    `Overtime is counted one workweek at a time, over ${companyData(company, "payroll").overtimeAfterWeeklyHours} hours in a week, never averaged across the period.`,
    notes,
    `Totals: ${h(run.regularHours)} regular, ${h(run.overtimeHours)} overtime. Gross total ${money(run.grossCents)}, worked out by the desk.`,
    `Next: submit_pay_run with ${run.id} puts it to ${personLabel(payrollApprover(company), "the person who approves pay runs")}, who approves every pay run.`,
  ].join("\n");
}

function changeText(change: EnrollmentChange): string {
  const verb =
    change.action === "enroll"
      ? `enrolled in ${change.planName}`
      : `removed from ${change.planName}`;
  const basis =
    change.basis === "open_enrollment"
      ? "during open enrolment"
      : change.basis === "life_event" && change.lifeEvent !== null
        ? `after a ${words(change.lifeEvent.kind)} on ${change.lifeEvent.date}, inside the special enrolment period`
        : "outside open enrolment";
  if (change.approvedVia === "enrollment_exception") {
    return `Approved by a person and recorded ${change.id}: ${change.employee} ${verb} ${basis}. Payroll takes the new deduction from the next pay run.`;
  }
  return `Recorded ${change.id}: ${change.employee} ${verb} ${basis}. Payroll takes the new deduction from the next pay run. This is the sender's own record; nothing was sent to anyone.`;
}

/** "Name, Title" for a person id on the record; "a person" for an id it does not hold. */
const named = (company: CompanyFacts, id: string | null): string =>
  personLabel(id === null ? undefined : person(company, id));

function profileText(company: CompanyFacts): string {
  const { profile } = company;
  return presentLines([
    companyHeadline(profile),
    profile.serviceArea === undefined ? undefined : `Service area: ${profile.serviceArea}`,
  ]);
}

function hoursText(company: CompanyFacts): string {
  const open = company.hours;
  return presentLines([
    `Office: ${open.office} (${open.timezone}).`,
    open.crews === undefined ? undefined : `Crews: ${open.crews}.`,
    companyClosedLine(open),
    open.note,
  ]);
}

function crewsText(company: CompanyFacts): string {
  return companyData(company, "crews")
    .map(
      (crew) =>
        `${crew.id} — ${crew.name} — ${crew.members} people — timesheets approved by ${personLabel(timesheetApprover(company, crew.id))}`,
    )
    .join("\n");
}

/** The pay schedule, overtime, who approves what, open enrolment and the plans offered. */
function payrollText(company: CompanyFacts): string {
  const policy = companyData(company, "payroll");
  return [
    `Pay is every two weeks. Pay periods run from ${policy.periodStartsOn} in fourteen-day blocks, each two workweeks; pay day is ${policy.payDayOffsetDays} days after a period ends.`,
    `Hours over ${policy.overtimeAfterWeeklyHours} in one workweek are overtime, paid at one and a half times the hourly rate. ${companyData(company, "staffPolicies").overtimeNeedsApproval ? "Overtime needs a manager's approval before it is worked, but every hour worked is paid." : "Every hour worked is paid."}`,
    `Every pay run, a correction to pay and a benefits exception: ${named(company, policy.approverId)}.`,
    `Questions about a person's pay, and any change to a pay rate or salary: ${named(company, companyData(company, "staffPolicies").payQuestionsTo)}.`,
    `Open enrolment: ${policy.enrollmentWindow.opens} to ${policy.enrollmentWindow.closes} (month-day) each year. Outside it, a change needs a qualifying life event or an approved exception.`,
    `Plans: ${policy.benefitPlans.map((plan) => `${plan.name} (${plan.id}, ${plan.kind})`).join("; ")}.`,
  ].join("\n");
}

function escalationText(company: CompanyFacts): string {
  return company.escalation
    .map((rule) => `${rule.topic} — ${named(company, rule.toPersonId)} — ${rule.when}`)
    .join("\n");
}

const COMPANY_SECTIONS: Readonly<Record<CompanySection, (company: CompanyFacts) => string>> = {
  profile: profileText,
  hours: hoursText,
  // Names, titles and what each decides: who to hand something to. Never a phone or an email.
  people: (company) => companyPeopleText(company, "none"),
  crews: crewsText,
  payroll: payrollText,
  tone: companyToneText,
  escalation: escalationText,
  glossary: companyGlossaryText,
};

/**
 * Builds the twelve tools over one desk and one company. Every one is plain Pi Durable: they install
 * into any harness, and a harness with no desk builds the same tools and refuses at the point of use.
 */
export function payrollTools(dependencies: PayrollToolDependencies): PayrollToolset {
  const { company } = dependencies;
  const hints = HINTS(company);
  const approver = personLabel(payrollApprover(company), "the person who approves pay runs");

  /** Who this call's work came from, as the host verified it; `undefined` when nobody is known. */
  const from = (api: { readonly conversationId: unknown; readonly taskId: unknown }) =>
    dependencies.sender?.({ conversationId: api.conversationId, taskId: api.taskId }) ??
    Promise.resolve(undefined);

  /** The special enrolment period, read now, so an overlay's value is the one the desk applies. */
  const specialDays = (): number | undefined => dependencies.limits?.()[SPECIAL_ENROLLMENT_DAYS];

  /** A desk refusal as the model reads it, with the next step its code names. */
  const refused = (error: unknown, extra: JsonObject = {}) => {
    if (!(error instanceof PayrollDeskError)) throw error;
    const shared =
      error.code === "unknown_sender" || error.code === "not_staff" || error.code === "not_office"
        ? " Nothing was shared."
        : "";
    return deskRefusal(`${error.message}${shared}${hints[error.code]}`, error.code, extra);
  };

  /** For an approval facts reader: nobody is asked about something the desk would refuse. */
  const unasked = (error: unknown): never => {
    if (!(error instanceof PayrollDeskError)) throw error;
    throw new Error(`${error.message}${hints[error.code]} Nothing was put to a person.`);
  };

  const notApproved = (what: string, extra: JsonObject) =>
    refusal(
      `Nothing was done for ${what}: this call carries no facts a person approved. It happens only after the approval gate has put it to a person and they said yes. Next: tell the asker it needs a person's approval and nothing was done.`,
      { code: "not_approved", ...extra },
    );

  const listPayPeriods = defineTool({
    name: "list_pay_periods",
    description:
      "List the pay periods around today, or one named period: each one's first and last day, pay day, whether it has closed, and its pay run's id and status (draft or approved). Pay periods and pay days are worked out by the desk from the company's schedule.",
    parameters: obj({
      period: opt(
        str({
          description:
            "Any day in one pay period, as YYYY-MM-DD, to list only that period. Leave it out for the periods around today",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args) => {
      const desk = requireDesk(dependencies.desk, "payroll");
      let periods: readonly PayPeriod[];
      try {
        periods = await desk.listPayPeriods(
          args.period === undefined ? {} : { period: args.period },
        );
      } catch (error) {
        return refused(error, { found: false });
      }
      // A named period is found once its run is approved, which ends a pay run's work: a draft can
      // predate the request (the demonstration holds one), so it shows nothing was done.
      const found =
        args.period === undefined
          ? {}
          : { found: periods.some((period) => period.run?.status === "approved") };
      return {
        ...textResult(["Pay periods:", ...periods.map(periodLine)].join("\n")),
        details: { ...found, periods: periods.map((period) => ({ ...period })) },
      };
    },
  });

  const listTimesheets = defineTool({
    name: "list_timesheets",
    description:
      "List one pay period's timesheets: each hourly employee's hours in each workweek, the overtime authorised in advance, the status (missing, submitted or approved) and who approves it. Hours only, never pay. Only for a person on the company record asking from inside the office: anyone else is refused.",
    parameters: obj({ period: PERIOD }),
    replay: "safe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "payroll");
      try {
        const sheets = await desk.listTimesheets({
          from: await from(api),
          ...(args.period === undefined ? {} : { period: args.period }),
        });
        return {
          ...textResult(
            [
              `Timesheets for ${sheets.periodStart} to ${sheets.periodEnd}:`,
              ...sheets.sheets.map(
                (sheet) =>
                  `- ${sheet.name} — ${sheet.status} — ${weeksText(sheet.weeks)} — ${h(sheet.overtimeAuthorisedHours)} overtime authorised — approved by ${personLabel({ id: "", name: sheet.approverName, title: sheet.approverTitle })}`,
              ),
            ].join("\n"),
          ),
          details: {
            found: true,
            periodStart: sheets.periodStart,
            periodEnd: sheets.periodEnd,
            sheets: sheets.sheets.map((sheet) => ({
              ...sheet,
              weeks: sheet.weeks.map((week) => ({ ...week })),
            })),
          },
        };
      } catch (error) {
        return refused(error, { found: false });
      }
    },
  });

  const flagTimesheet = defineTool({
    name: "flag_timesheet",
    description:
      "Note a discrepancy on one employee's timesheet (a missing punch, hours that look wrong, a day that does not match the schedule) for the person who approves it. An internal note: it changes no hours and pays nothing. Unauthorised overtime needs no flag: prepare_pay_run notes it itself.",
    parameters: obj({
      employee: str({ description: "The employee's name, as given" }),
      period: PERIOD,
      reason: str({ description: "What looks wrong, in the asker's words" }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "payroll");
      try {
        const flag = await desk.flagTimesheet(
          {
            employee: args.employee,
            reason: args.reason,
            ...(args.period === undefined ? {} : { period: args.period }),
          },
          { requestId: requestId("flag", api) },
        );
        const to = personLabel({ id: "", name: flag.toName, title: flag.toTitle });
        return {
          ...textResult(
            `Flagged ${flag.id} on ${flag.employee}'s timesheet for ${flag.periodStart} for ${to}: ${flag.reason}. An internal note: no hours were changed and nothing is decided.`,
          ),
          details: { ...flag },
        };
      } catch (error) {
        return refused(error, { employee: args.employee });
      }
    },
  });

  const requestTimesheetApproval = defineTool({
    name: "request_timesheet_approval",
    description:
      "Ask the people who approve timesheets to submit and approve the ones a pay period is still missing or has not approved, so the pay run can be prepared. An internal nudge: it approves nothing.",
    parameters: obj({ period: PERIOD }),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "payroll");
      try {
        const nudge = await desk.requestTimesheetApproval(
          args.period === undefined ? {} : { period: args.period },
          { requestId: requestId("nudge", api) },
        );
        return {
          ...textResult(
            [
              `Asked the people who approve timesheets (${nudge.id}) for the period from ${nudge.periodStart}:`,
              ...nudge.open.map(
                (entry) =>
                  `- ${entry.employee} (${entry.status === "missing" ? "missing" : "submitted, not approved"}) — ${personLabel({ id: "", name: entry.toName, title: entry.toTitle })}`,
              ),
              "The pay run waits until every timesheet is approved. Nothing has been approved.",
            ].join("\n"),
          ),
          details: { ...nudge, open: nudge.open.map((entry) => ({ ...entry })) },
        };
      } catch (error) {
        return refused(error);
      }
    },
  });

  const preparePayRun = defineTool({
    name: "prepare_pay_run",
    description:
      "Prepare the draft pay run for a closed pay period. The desk splits the period into workweeks, counts overtime in each week on its own, pays every hour worked (overtime nobody authorised included, which it notes for the timesheet's approver) and works out gross pay. It refuses while any timesheet is missing or unapproved, naming them. Preparing again replaces the draft. Only for office staff.",
    parameters: obj({ period: PERIOD }),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "payroll");
      try {
        const run = await desk.preparePayRun(
          { from: await from(api), ...(args.period === undefined ? {} : { period: args.period }) },
          { requestId: requestId("prepare", api) },
        );
        // The details carry the run's totals, never its lines: one person's pay stays theirs.
        return {
          ...textResult(runText(run, company)),
          details: {
            runId: run.id,
            periodStart: run.periodStart,
            periodEnd: run.periodEnd,
            payDay: run.payDay,
            status: run.status,
            employees: run.employees,
            regularHours: run.regularHours,
            overtimeHours: run.overtimeHours,
            unauthorisedOvertimeHours: run.unauthorisedOvertimeHours,
            grossCents: run.grossCents,
            overtimeNotes: run.overtimeNotes.map((note) => ({ ...note })),
          },
        };
      } catch (error) {
        return refused(error);
      }
    },
  });

  const submitPayRun = defineTool({
    name: "submit_pay_run",
    description: `Submit a draft pay run, by its id from prepare_pay_run called in this conversation (prepare it first even when a draft already exists), for ${approver} to approve. Every call waits for a person; the desk shows them the period, pay day, headcount, hours and gross total. Once approved the run is final and cannot be edited. Demonstration backend only: nothing is paid.`,
    parameters: obj({
      runId: RUN_ID,
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "payroll");
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return notApproved(`pay run ${args.runId}`, { runId: args.runId });
      }
      try {
        const run = await desk.submitPayRun(
          { runId: args.runId, from: await from(api), approved },
          { requestId: requestId("submit", api) },
        );
        return {
          ...textResult(
            `Approved by a person: pay run ${run.id} for ${run.periodStart} to ${run.periodEnd}, pay day ${run.payDay}, ${run.employees} employees, gross total ${money(run.grossCents)}. It is final: a correction is a new adjustment. This is the demonstration backend: nothing was paid to anyone.`,
          ),
          details: { runId: run.id, status: run.status, approvedOn: run.approvedOn ?? "" },
        };
      } catch (error) {
        return refused(error, { runId: args.runId });
      }
    },
  });

  const payRunApprovalFacts: ApprovalFactsReader = async (args, _context, call) => {
    const desk = requireDesk(dependencies.desk, "payroll");
    const facts = await desk
      .payRunFacts({ runId: String(args.runId), from: await from(call) })
      .catch(unasked);
    return {
      summary: `Approve pay run ${facts.runId} for ${facts.periodStart} to ${facts.periodEnd}, pay day ${facts.payDay}: ${facts.employees} employees, ${h(facts.regularHours)} regular and ${h(facts.overtimeHours)} overtime (${h(facts.unauthorisedOvertimeHours)} of it worked without authorisation, paid all the same), gross total ${money(facts.grossCents)}`,
      facts: { ...facts },
    };
  };

  const adjustmentInput = (args: Readonly<Record<string, unknown>>) => ({
    runId: String(args.runId),
    reason: String(args.reason ?? ""),
    ...(typeof args.employee === "string" ? { employee: args.employee } : {}),
  });

  const requestPayAdjustment = defineTool({
    name: "request_pay_adjustment",
    description: `Ask ${approver} to approve a correction to one employee's pay on an approved pay run: missed hours, a wrong rate, a deduction that should not have been taken. It takes no amount: the person approving enters the adjustment to gross pay with their yes, above zero to add pay or below it to take pay back. The run itself is never edited; the correction is a new adjustment recorded at the amount they entered. It is the sender's own pay unless office staff raise it for an employee. Every call waits for a person. A draft run is corrected by preparing it again instead.`,
    parameters: obj({
      runId: RUN_ID,
      employee: opt(
        str({
          description:
            "Only when office staff raise it for an employee: that employee's name. Leave it out for the sender's own pay",
        }),
      ),
      reason: str({ description: "What is wrong with the pay, in the asker's words" }),
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
      [APPROVED_VALUE_ARG]: approvedValueParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "payroll");
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return notApproved(`a correction on ${args.runId}`, { runId: args.runId });
      }
      // The amount is the person's, entered with their yes; there is no other figure to fall back on.
      let entered: ApprovedValue;
      try {
        entered = approvedValue(args, ADJUSTMENT_VALUE);
      } catch {
        return refusal(
          `Nothing was recorded: this correction on ${args.runId} carries no adjustment a person entered. The amount is entered by the person approving, with their yes. Next: tell the asker the correction needs a person's approval and nothing was recorded.`,
          { code: "not_approved", runId: args.runId },
        );
      }
      try {
        const adjustment = await desk.requestPayAdjustment(
          {
            ...adjustmentInput(args),
            from: await from(api),
            approved,
            amountCents: entered.cents,
            amountSetBy: entered.by,
          },
          { requestId: requestId("adjust", api) },
        );
        const { lowestCents: _low, highestCents: _high, amountCents, ...recorded } = adjustment;
        const head = `Approved by a person and recorded: correction ${adjustment.id} to ${adjustment.employee}'s pay on ${adjustment.runId} (${adjustment.periodStart} to ${adjustment.periodEnd}): ${adjustment.reason}.`;
        // The bounds are the employee's gross pay and never leave the approval. The amount is told
        // only to the employee it pays: office staff raising it for someone see no one person's pay.
        return adjustment.sendersOwn
          ? {
              ...textResult(
                `${head} Adjustment to gross pay: ${money(amountCents)}, set by ${adjustment.amountSetBy === null ? "the person who approved it" : `${adjustment.amountSetBy}, the person who approved it`}; it is paid with the next pay run. ${adjustment.runId} itself is unchanged.`,
              ),
              details: { ...recorded, amountCents },
            }
          : {
              ...textResult(
                `${head} The person who approved it entered the amount, recorded with the correction and paid with the next pay run; the amount is ${adjustment.employee}'s pay, so it is not given here. ${adjustment.runId} itself is unchanged.`,
              ),
              details: { ...recorded },
            };
      } catch (error) {
        return refused(error, { runId: args.runId });
      }
    },
  });

  const payAdjustmentApprovalFacts: ApprovalFactsReader = async (args, _context, call) => {
    const desk = requireDesk(dependencies.desk, "payroll");
    const facts = await desk
      .payAdjustmentFacts({ ...adjustmentInput(args), from: await from(call) })
      .catch(unasked);
    return {
      summary: `Approve a correction to ${facts.employee}'s pay on approved pay run ${facts.runId} (${facts.periodStart} to ${facts.periodEnd}): ${facts.reason}. With your yes, enter the adjustment to ${facts.employee}'s gross pay for this run, from ${money(facts.lowestCents)} to ${money(facts.highestCents)} (minus and plus their gross pay on it); enter a reduction with a minus. It is paid with the next pay run; the run itself does not change.`,
      facts: { ...facts },
    };
  };

  const getPayStatement = defineTool({
    name: "get_pay_statement",
    description:
      "The sender's own pay statement from an approved pay run: hours in each workweek, regular and overtime hours, the rate, gross pay and benefit deductions, worked out by the desk. It takes no employee: the desk knows who sent the message, and nobody gets another person's pay. Refused for a sender not on staff.",
    parameters: obj({
      runId: opt(str({ description: "One approved pay run; the most recent when left out" })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "payroll");
      try {
        const statement = await desk.payStatement({
          from: await from(api),
          ...(args.runId === undefined ? {} : { runId: args.runId }),
        });
        const work = statement.salaried
          ? "salaried, so no hours are counted for overtime"
          : `${h(statement.regularHours)} regular and ${h(statement.overtimeHours)} overtime at ${money(statement.rateCents ?? 0)} an hour, overtime at one and a half times (${weeksText(statement.weeks)})`;
        const deductions =
          statement.deductions.length === 0
            ? "none"
            : statement.deductions
                .map((entry) => `${entry.planName} ${money(entry.perPeriodCents)}`)
                .join(", ");
        return {
          ...textResult(
            `Pay statement for ${statement.employee} (the sender), pay run ${statement.runId}, ${statement.periodStart} to ${statement.periodEnd}, paid ${statement.payDay}: ${work}; gross ${money(statement.grossCents)}. Benefit deductions: ${deductions} (${money(statement.benefitDeductionsCents)} in all). Worked out by the desk; tax withholding and net pay are not shown here. This is the sender's own statement only.`,
          ),
          details: {
            ...statement,
            weeks: statement.weeks.map((week) => ({ ...week })),
            deductions: statement.deductions.map((entry) => ({ ...entry })),
          },
        };
      } catch (error) {
        return refused(error);
      }
    },
  });

  const getBenefitsSummary = defineTool({
    name: "get_benefits_summary",
    description:
      "The sender's own benefits: the plans they are enrolled in with each one's deduction per pay period, the plans the company offers, open enrolment and whether it is open today, and the special enrolment period after a qualifying life event. It takes no employee: nobody gets another person's benefits. Refused for a sender not on staff.",
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, api) => {
      const desk = requireDesk(dependencies.desk, "payroll");
      try {
        const summary = await desk.benefitsSummary({
          from: await from(api),
          specialEnrollmentDays: specialDays(),
        });
        const enrolled =
          summary.enrolled.length === 0
            ? "none"
            : summary.enrolled
                .map((plan) => `${plan.planName} (${money(plan.perPeriodCents)} a pay period)`)
                .join(", ");
        const special =
          summary.specialEnrollmentDays === null
            ? "No special enrolment period is set, so a change after a life event goes to a person."
            : `Outside it, a medical, dental or vision change is allowed within ${summary.specialEnrollmentDays} days after a qualifying life event.`;
        return {
          ...textResult(
            `Benefits for ${summary.employee} (the sender). Enrolled: ${enrolled}. Offered: ${summary.offered.map((plan) => plan.name).join(", ")}. Open enrolment: ${summary.window.opens} to ${summary.window.closes} (${summary.window.open ? "open today" : "closed today"}). ${special} This is the sender's own record only.`,
          ),
          details: {
            ...summary,
            enrolled: summary.enrolled.map((plan) => ({ ...plan })),
            offered: summary.offered.map((plan) => ({ ...plan })),
            window: { ...summary.window },
          },
        };
      } catch (error) {
        return refused(error);
      }
    },
  });

  const recordEnrollmentChange = defineTool({
    name: "record_enrollment_change",
    description:
      "Record the sender's own enrolment in, or removal from, one benefit plan. Recorded during open enrolment; outside it, only a medical, dental or vision change after a qualifying life event inside the special enrolment period. The desk refuses the rest and points to request_enrollment_exception. Only the sender's own benefits.",
    parameters: obj({
      planId: str({ description: "The plan's id or name, e.g. vision" }),
      action: literals(ENROLLMENT_ACTIONS, "enroll to join the plan, drop to leave it"),
      lifeEventKind: opt(
        literals(
          LIFE_EVENTS,
          "Only when the employee names a qualifying life event: marriage, divorce, birth, adoption, loss_of_other_coverage or death_of_dependent",
        ),
      ),
      lifeEventDate: opt(
        str({ description: "The life event's date, as YYYY-MM-DD; with lifeEventKind" }),
      ),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "payroll");
      try {
        const change = await desk.recordEnrollmentChange(
          {
            planId: args.planId,
            action: args.action as EnrollmentAction,
            ...(args.lifeEventKind === undefined
              ? {}
              : {
                  lifeEvent: {
                    kind: args.lifeEventKind as LifeEventKind,
                    date: String(args.lifeEventDate ?? ""),
                  },
                }),
            from: await from(api),
            // Read now, so an overlay's value is the one the desk judges the change against.
            specialEnrollmentDays: specialDays(),
          },
          { requestId: requestId("enrollment", api) },
        );
        return { ...textResult(changeText(change)), details: { ...change } };
      } catch (error) {
        return refused(error, { planId: args.planId });
      }
    },
  });

  const exceptionInput = (args: Readonly<Record<string, unknown>>) => ({
    planId: String(args.planId),
    action: args.action as EnrollmentAction,
    reason: String(args.reason ?? ""),
  });

  const requestEnrollmentException = defineTool({
    name: "request_enrollment_exception",
    description: `Ask ${approver} to approve the sender's benefit change outside open enrolment that no qualifying life event allows, after record_enrollment_change refused it. Every call waits for a person; once approved, the desk records the change.`,
    parameters: obj({
      planId: str({ description: "The plan's id or name, e.g. vision" }),
      action: literals(ENROLLMENT_ACTIONS, "enroll to join the plan, drop to leave it"),
      reason: str({
        description: "Why the employee needs the change now, in their words",
      }),
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "payroll");
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return notApproved(`the ${args.action} on ${args.planId}`, { planId: args.planId });
      }
      try {
        const change = await desk.requestEnrollmentException(
          {
            ...exceptionInput(args),
            from: await from(api),
            specialEnrollmentDays: specialDays(),
            approved,
          },
          { requestId: requestId("enrollment-exception", api) },
        );
        return { ...textResult(changeText(change)), details: { ...change } };
      } catch (error) {
        return refused(error, { planId: args.planId });
      }
    },
  });

  const enrollmentExceptionFacts: ApprovalFactsReader = async (args, _context, call) => {
    const desk = requireDesk(dependencies.desk, "payroll");
    const facts = await desk
      .enrollmentExceptionFacts({
        ...exceptionInput(args),
        from: await from(call),
        specialEnrollmentDays: specialDays(),
      })
      .catch(unasked);
    const verb =
      facts.action === "enroll"
        ? `enrolling ${facts.employee} in`
        : `removing ${facts.employee} from`;
    return {
      summary: `Approve ${verb} ${facts.planName} outside open enrolment, with no qualifying life event: ${facts.reason}`,
      facts: { ...facts },
    };
  };

  const readCompany = readCompanyTool({
    company,
    description:
      "Read one section of the company record: the profile, the hours, the people (names, titles and what each decides), the crews (and who approves their timesheets), payroll (the pay schedule, overtime, who approves pay runs and decides pay rates, open enrolment and the plans), the tone of voice, the escalation path or the glossary.",
    sections: COMPANY_SECTIONS,
  });

  return {
    listPayPeriods,
    listTimesheets,
    flagTimesheet,
    requestTimesheetApproval,
    preparePayRun,
    submitPayRun,
    requestPayAdjustment,
    getPayStatement,
    getBenefitsSummary,
    recordEnrollmentChange,
    requestEnrollmentException,
    readCompany,
    payRunApprovalFacts,
    payAdjustmentApprovalFacts,
    enrollmentExceptionFacts,
  };
}
