/**
 * The desk: the payroll and benefits system this role reads timesheets, pay runs and enrolments from
 * and writes drafts, approvals, corrections and benefit changes to.
 *
 * A host binds its own — a payroll service, a timekeeping system, a benefits portal with an API — and
 * the role never knows the difference. `fakePayrollDesk` is what ships with the package: the crew
 * members the company's crews count, their timesheets for two pay periods, their enrolments, and
 * every rule worked out here, so a test, an eval or a first run needs no network and no credential.
 *
 * The desk owns every hour and every amount. The model names a period, a run, a plan or an employee;
 * the desk splits each period into workweeks from the company's period start, counts overtime one
 * workweek at a time (never averaged across the period), pays every hour worked whether or not anyone
 * authorised it, and notes unauthorised overtime for the person who approves the timesheet. Who is
 * asking comes from the host's verified sender: a pay statement, a benefits summary and a benefit
 * change are only ever the sender's own, and only office staff list timesheets or prepare and submit
 * a pay run. No result carries a tax id or a bank detail: the desk holds neither. A refusal carries a
 * code, and the tools turn the code into the next step.
 */

import {
  addDays,
  colleague,
  companyData,
  daysBetween,
  localDate,
  parseDate,
  sameFacts,
  senderPerson,
  type VerifiedSender,
} from "@officehum/sdk";
import {
  type BenefitPlanFact,
  type CompanyFacts,
  loadCompanyFacts,
  type Person,
  timesheetApprover,
} from "./company.js";

/** Monday 7 December 2026, at the start of the office day on the US west coast. */
export const DEMO_NOW = "2026-12-07T16:00:00.000Z";

/** Days in one pay period: the company pays every two weeks. */
const PERIOD_DAYS = 14;

/** How an employee is paid. Salaried staff are exempt from overtime and keep no timesheet here. */
export type PayBasis =
  | { readonly kind: "hourly"; readonly rateCents: number }
  | { readonly kind: "salary"; readonly perPeriodCents: number };

/** Someone on the payroll, as the desk knows them: no tax id, no bank detail, no address. */
export interface PayEmployee {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  /** The crew they work on, or `null` for office staff. */
  readonly crewId: string | null;
  /** Their own email or phone, matched against the verified sender and never returned. */
  readonly contact?: string;
  readonly pay: PayBasis;
}

export type TimesheetStatus = "missing" | "submitted" | "approved";

/** One employee's time for one pay period, as the timekeeping system holds it. */
export interface Timesheet {
  readonly employeeId: string;
  /** The period's first day, `YYYY-MM-DD`. */
  readonly periodStart: string;
  readonly status: Exclude<TimesheetStatus, "missing">;
  /** Hours worked each day of the period, first day first: fourteen entries. */
  readonly days: readonly number[];
  /** Overtime hours a manager authorised in advance for the period. */
  readonly overtimeAuthorisedHours: number;
}

export interface PayPeriod {
  /** The first day; also the period's id. */
  readonly start: string;
  readonly end: string;
  readonly payDay: string;
  /** The last day has passed. */
  readonly closed: boolean;
  readonly run: { readonly id: string; readonly status: PayRunStatus } | null;
}

export interface WorkweekHours {
  readonly start: string;
  readonly end: string;
  readonly hours: number;
}

/** One employee's timesheet as office staff see it: hours, never pay. */
export interface TimesheetSummary {
  readonly employeeId: string;
  readonly name: string;
  readonly crewId: string;
  readonly status: TimesheetStatus;
  readonly weeks: readonly WorkweekHours[];
  readonly totalHours: number;
  readonly overtimeAuthorisedHours: number;
  readonly approverName: string;
  readonly approverTitle: string;
}

export interface TimesheetPeriod {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly sheets: readonly TimesheetSummary[];
}

export interface TimesheetFlag {
  readonly id: string;
  readonly employee: string;
  readonly periodStart: string;
  readonly reason: string;
  readonly toName: string;
  readonly toTitle: string;
}

export interface TimesheetNudge {
  readonly id: string;
  readonly periodStart: string;
  readonly open: readonly {
    readonly employee: string;
    readonly status: Exclude<TimesheetStatus, "approved">;
    readonly toName: string;
    readonly toTitle: string;
  }[];
}

export type PayRunStatus = "draft" | "approved";

export interface RunWeek extends WorkweekHours {
  readonly regularHours: number;
  readonly overtimeHours: number;
}

/** One employee's line on a pay run. Only the employee's own statement ever shows its amounts. */
export interface PayRunLine {
  readonly employeeId: string;
  readonly name: string;
  readonly salaried: boolean;
  /** The hourly rate; `null` for salaried staff. */
  readonly rateCents: number | null;
  readonly weeks: readonly RunWeek[];
  readonly regularHours: number;
  readonly overtimeHours: number;
  /** Overtime worked beyond what was authorised in advance: paid all the same, and noted. */
  readonly unauthorisedOvertimeHours: number;
  readonly grossCents: number;
  readonly benefitDeductionsCents: number;
}

/** Overtime nobody authorised, noted for the person who approves the employee's timesheet. */
export interface OvertimeNote {
  readonly employee: string;
  readonly weekStart: string;
  readonly hours: number;
  readonly toName: string;
  readonly toTitle: string;
}

export interface PayRun {
  readonly id: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly payDay: string;
  readonly status: PayRunStatus;
  readonly lines: readonly PayRunLine[];
  readonly employees: number;
  readonly regularHours: number;
  readonly overtimeHours: number;
  readonly unauthorisedOvertimeHours: number;
  readonly grossCents: number;
  readonly overtimeNotes: readonly OvertimeNote[];
  readonly preparedOn: string;
  readonly approvedOn: string | null;
}

/** What a person approves when a pay run is submitted, read from the draft. No one person's pay. */
export interface PayRunFacts {
  readonly runId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly payDay: string;
  readonly employees: number;
  readonly regularHours: number;
  readonly overtimeHours: number;
  readonly unauthorisedOvertimeHours: number;
  readonly grossCents: number;
}

export interface PayAdjustmentInput {
  readonly runId: string;
  /** Whose pay, by name; omitted for the sender's own. */
  readonly employee?: string;
  readonly reason: string;
  readonly from: VerifiedSender | undefined;
}

/**
 * What a person approves for a correction. The amount is theirs to enter with their yes, so none is
 * proposed; the bounds they may enter it within are minus and plus the employee's gross pay on the
 * run, read from the run's line. The bounds are that employee's pay: they go to the person approving,
 * never into a tool's result.
 */
export interface PayAdjustmentFacts {
  readonly runId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly employeeId: string;
  readonly employee: string;
  readonly reason: string;
  /** Minus the employee's gross pay on the run, in whole cents. */
  readonly lowestCents: number;
  /** The employee's gross pay on the run, in whole cents. */
  readonly highestCents: number;
}

export interface PayAdjustment extends PayAdjustmentFacts {
  readonly id: string;
  readonly approvedOn: string;
  /** The adjustment to gross pay the person approving entered, in whole cents; never zero. */
  readonly amountCents: number;
  /** Who entered it, as the approver reported them; `null` when the approver did not say. */
  readonly amountSetBy: string | null;
  /** The correction is to the sender's own pay, so its amount may be told to them. */
  readonly sendersOwn: boolean;
}

/** The sender's own pay statement from one approved run. */
export interface PayStatement {
  readonly runId: string;
  readonly employee: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly payDay: string;
  readonly salaried: boolean;
  readonly rateCents: number | null;
  readonly weeks: readonly RunWeek[];
  readonly regularHours: number;
  readonly overtimeHours: number;
  readonly grossCents: number;
  readonly benefitDeductionsCents: number;
  readonly deductions: readonly { readonly planName: string; readonly perPeriodCents: number }[];
}

export type EnrollmentAction = "enroll" | "drop";

export const ENROLLMENT_ACTIONS: readonly EnrollmentAction[] = ["enroll", "drop"];

/** A change in someone's life that may open a plan outside open enrolment. */
export type LifeEventKind =
  | "marriage"
  | "divorce"
  | "birth"
  | "adoption"
  | "loss_of_other_coverage"
  | "death_of_dependent";

export const LIFE_EVENTS: readonly LifeEventKind[] = [
  "marriage",
  "divorce",
  "birth",
  "adoption",
  "loss_of_other_coverage",
  "death_of_dependent",
];

/** The plan kinds a qualifying life event opens; any other plan changes in open enrolment only. */
export const LIFE_EVENT_PLAN_KINDS: readonly string[] = ["medical", "dental", "vision"];

/** Each plan kind's demonstration deduction per pay period. */
export const DEMO_PLAN_COSTS_CENTS: Readonly<Record<string, number>> = {
  medical: 6500,
  dental: 1200,
  vision: 400,
  retirement: 5000,
};

export interface BenefitsSummary {
  readonly employeeId: string;
  readonly employee: string;
  readonly enrolled: readonly {
    readonly planId: string;
    readonly planName: string;
    readonly kind: string;
    readonly perPeriodCents: number;
  }[];
  readonly offered: readonly BenefitPlanFact[];
  readonly window: { readonly opens: string; readonly closes: string; readonly open: boolean };
  /** The special enrolment period the role's limit gives; `null` when none is set. */
  readonly specialEnrollmentDays: number | null;
}

export interface EnrollmentChangeInput {
  readonly planId: string;
  readonly action: EnrollmentAction;
  readonly lifeEvent?: { readonly kind: LifeEventKind; readonly date: string };
  readonly from: VerifiedSender | undefined;
  /** The role's resolved limit, read at the call; `undefined` when none resolves. */
  readonly specialEnrollmentDays: number | undefined;
}

export interface EnrollmentExceptionInput extends Omit<EnrollmentChangeInput, "lifeEvent"> {
  readonly reason: string;
}

export interface EnrollmentExceptionFacts {
  readonly employeeId: string;
  readonly employee: string;
  readonly planId: string;
  readonly planName: string;
  readonly action: EnrollmentAction;
  readonly reason: string;
}

export interface EnrollmentChange {
  readonly id: string;
  readonly employeeId: string;
  readonly employee: string;
  readonly planId: string;
  readonly planName: string;
  readonly action: EnrollmentAction;
  readonly basis: "open_enrollment" | "life_event" | "exception";
  readonly lifeEvent: { readonly kind: LifeEventKind; readonly date: string } | null;
  readonly recordedOn: string;
  readonly approvedVia: "enrollment_exception" | null;
}

type Write = { readonly requestId: string };
type From = { readonly from: VerifiedSender | undefined };

/** What the role needs from whatever system holds its payroll and benefits records. */
export interface PayrollDesk {
  /** The periods around today, or only the one `period` (any day in it) falls in. */
  listPayPeriods(input?: { readonly period?: string }): Promise<readonly PayPeriod[]>;
  /** One period's timesheets, for office staff. `period` is any day in it; the last closed one when omitted. */
  listTimesheets(input: From & { readonly period?: string }): Promise<TimesheetPeriod>;
  flagTimesheet(
    input: { readonly employee: string; readonly period?: string; readonly reason: string },
    options: Write,
  ): Promise<TimesheetFlag>;
  requestTimesheetApproval(
    input: { readonly period?: string },
    options: Write,
  ): Promise<TimesheetNudge>;
  /** Prepares (or prepares again) the draft run for a closed period, for office staff. */
  preparePayRun(input: From & { readonly period?: string }, options: Write): Promise<PayRun>;
  /** What a person approves for a draft run; refuses exactly what `submitPayRun` refuses. */
  payRunFacts(input: From & { readonly runId: string }): Promise<PayRunFacts>;
  /**
   * Approves a draft run. Called only once a person approved it, with the facts they were shown; a
   * host desk must refuse with `run_changed` when the draft no longer works out to them.
   */
  submitPayRun(
    input: From & { readonly runId: string; readonly approved: Readonly<Record<string, unknown>> },
    options: Write,
  ): Promise<PayRun>;
  payAdjustmentFacts(input: PayAdjustmentInput): Promise<PayAdjustmentFacts>;
  /**
   * Records an approved correction at the amount the person approving entered (`amountCents`), with
   * who entered it; the approved run itself never changes. A host desk must refuse (`invalid`) an
   * amount that is not whole cents, is zero, or lies outside the approved bounds.
   */
  requestPayAdjustment(
    input: PayAdjustmentInput & {
      readonly approved: Readonly<Record<string, unknown>>;
      readonly amountCents: number;
      readonly amountSetBy: string | null;
    },
    options: Write,
  ): Promise<PayAdjustment>;
  /** The sender's own statement: the latest approved run when `runId` is omitted. */
  payStatement(input: From & { readonly runId?: string }): Promise<PayStatement>;
  benefitsSummary(
    input: From & { readonly specialEnrollmentDays: number | undefined },
  ): Promise<BenefitsSummary>;
  recordEnrollmentChange(input: EnrollmentChangeInput, options: Write): Promise<EnrollmentChange>;
  enrollmentExceptionFacts(input: EnrollmentExceptionInput): Promise<EnrollmentExceptionFacts>;
  requestEnrollmentException(
    input: EnrollmentExceptionInput & { readonly approved: Readonly<Record<string, unknown>> },
    options: Write,
  ): Promise<EnrollmentChange>;
}

/** Why the desk refused, so a tool can say what to do next without parsing the message. */
export type DeskRefusal =
  | "not_found"
  | "ambiguous"
  | "invalid"
  | "unknown_sender"
  | "not_staff"
  | "not_office"
  | "someone_else"
  | "not_closed"
  | "timesheets_open"
  | "nothing_open"
  | "already_approved"
  | "still_draft"
  | "run_changed"
  | "changed"
  | "no_statement"
  | "outside_window"
  | "event_too_old"
  | "plan_not_eligible"
  | "duplicate"
  | "not_needed";

export class PayrollDeskError extends Error {
  readonly code: DeskRefusal;

  constructor(code: DeskRefusal, message: string) {
    super(message);
    this.name = "PayrollDeskError";
    this.code = code;
  }
}

/** A pay run the desk starts with, prepared from the timesheets it holds. */
export interface SeededRun {
  readonly periodStart: string;
  readonly status: PayRunStatus;
  /** The day a person approved it; required for an approved run. */
  readonly approvedOn?: string;
}

export interface FakePayrollDeskOptions {
  /** The company: its schedule, overtime threshold, plans and people. The generated facts when omitted. */
  readonly company?: CompanyFacts;
  /** Crew members; the demonstration crews when omitted. Office staff come from the company. */
  readonly employees?: readonly PayEmployee[];
  readonly timesheets?: readonly Timesheet[];
  /** Plan ids by employee id; the demonstration enrolments when omitted. */
  readonly enrollments?: Readonly<Record<string, readonly string[]>>;
  /** Runs already on the books; the demonstration's approved and draft runs when omitted. */
  readonly runs?: readonly SeededRun[];
  /** The clock. Omitted: the demonstration Monday. */
  readonly now?: () => Date;
}

/** The salary per pay period each demonstration office record carries. */
export const DEMO_OFFICE_SALARY_CENTS = 260000;

/** Hourly rates the demonstration crews are paid. */
const CLEANER_RATE_CENTS = 2100;
const TECHNICIAN_RATE_CENTS = 2950;

/**
 * The crew members the company's crews count, by crew: the same demonstration people every role's
 * desk uses. Each carries only their own contact, for matching the verified sender, and an hourly
 * rate. They are demonstration data, not the company record.
 */
export function demoEmployees(): readonly (PayEmployee & { readonly contact: string })[] {
  const crews: Readonly<Record<string, readonly string[]>> = {
    "cleaning-north": ["Ana Lopez", "Ben Carter", "Chloe Nguyen", "Diego Ramirez"],
    "cleaning-central": ["Erin Walsh", "Farid Haddad", "Hana Sato", "Ivan Petrov"],
    "cleaning-south": ["Jamal Brooks", "Keiko Tanaka", "Luis Moreno", "Maya Singh"],
    maintenance: ["Nate Fischer", "Olga Ivanova", "Paul Mensah"],
  };
  let number = 0;
  return Object.entries(crews).flatMap(([crewId, names]) =>
    names.map((name) => {
      number += 1;
      const technician = crewId === "maintenance";
      return {
        id: `E-${String(number).padStart(2, "0")}`,
        name,
        title: technician ? "Maintenance technician" : "Cleaner",
        crewId,
        contact: `${name.toLowerCase().replace(" ", ".")}@crew.example`,
        pay: {
          kind: "hourly" as const,
          rateCents: technician ? TECHNICIAN_RATE_CENTS : CLEANER_RATE_CENTS,
        },
      };
    }),
  );
}

/** Eight hours Monday to Friday, nothing at the weekend: one workweek of forty hours. */
const STANDARD_WEEK: readonly number[] = [8, 8, 8, 8, 8, 0, 0];

/**
 * Timesheets for the two most recent closed periods, all approved. In the earlier one (paid on its
 * approved run) Diego Ramirez worked two authorised hours of overtime. In the later one (its run a
 * draft) he worked 44 hours and then 36, with four hours authorised for the Saturday, and Farid
 * Haddad worked a 46-hour second week that nobody authorised.
 */
export function demoTimesheets(): readonly Timesheet[] {
  const week = (saturday: number, weekday = 8): number[] => [
    weekday,
    weekday,
    weekday,
    weekday,
    weekday,
    saturday,
    0,
  ];
  const special: Readonly<Record<string, Readonly<Record<string, readonly [number[], number]>>>> = {
    "2026-11-09": { "E-04": [[...week(2), ...STANDARD_WEEK], 2] },
    "2026-11-23": {
      "E-04": [[...week(4), ...week(0, 7.2)], 4],
      "E-06": [[...STANDARD_WEEK, ...week(6)], 0],
    },
  };
  return Object.entries(special).flatMap(([periodStart, overrides]) =>
    demoEmployees().map((employee) => {
      const [days, authorised] = overrides[employee.id] ?? [
        [...STANDARD_WEEK, ...STANDARD_WEEK],
        0,
      ];
      return {
        employeeId: employee.id,
        periodStart,
        status: "approved" as const,
        days,
        overtimeAuthorisedHours: authorised,
      };
    }),
  );
}

/**
 * Plans each demonstration employee is enrolled in: every crew member in medical and dental, the
 * maintenance crew in the retirement plan too, and one cleaner in vision. Office staff, from
 * the company record, are enrolled in medical, dental and retirement.
 */
export function demoEnrollments(): Readonly<Record<string, readonly string[]>> {
  const plans: Record<string, readonly string[]> = {};
  for (const employee of demoEmployees()) {
    plans[employee.id] =
      employee.crewId === "maintenance"
        ? ["medical-ppo", "dental", "retirement-401k"]
        : employee.id === "E-03"
          ? ["medical-ppo", "dental", "vision"]
          : ["medical-ppo", "dental"];
  }
  return plans;
}

/** The runs on the books in the demonstration: the earlier period approved and paid, the later a draft. */
export function demoRuns(): readonly SeededRun[] {
  return [
    { periodStart: "2026-11-09", status: "approved", approvedOn: "2026-11-24" },
    { periodStart: "2026-11-23", status: "draft" },
  ];
}

/** Hours to two decimal places, so a sum of quarter and tenth hours prints as it was entered. */
const hours = (value: number): number => Math.round(value * 100) / 100;

function required(value: string | undefined, what: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") throw new PayrollDeskError("invalid", `Give ${what}. Nothing was recorded.`);
  return trimmed;
}

/** An in-memory desk: the company's schedule and plans, demonstration people, nothing that leaves the process. */
export function fakePayrollDesk(options: FakePayrollDeskOptions = {}): PayrollDesk {
  const company = options.company ?? loadCompanyFacts();
  const policy = companyData(company, "payroll");
  const clock = options.now ?? (() => new Date(DEMO_NOW));
  const today = (): string => localDate(clock(), company.hours.timezone);
  const crewMembers = options.employees ?? demoEmployees();
  // Office staff are paid too; they come from the company record, without its contact fields, and are
  // salaried in the demonstration.
  const employees: readonly PayEmployee[] = [
    ...crewMembers,
    ...company.people.map((worker) => ({
      id: worker.id,
      name: worker.name,
      title: worker.title,
      crewId: null,
      pay: { kind: "salary" as const, perPeriodCents: DEMO_OFFICE_SALARY_CENTS },
    })),
  ];
  const timesheets = new Map<string, Timesheet>();
  for (const sheet of options.timesheets ?? demoTimesheets()) {
    timesheets.set(`${sheet.periodStart}|${sheet.employeeId}`, sheet);
  }
  const enrollments = new Map<string, string[]>();
  const seeded = options.enrollments ?? {
    ...demoEnrollments(),
    ...Object.fromEntries(
      company.people.map((worker) => [worker.id, ["medical-ppo", "dental", "retirement-401k"]]),
    ),
  };
  for (const [id, plans] of Object.entries(seeded)) enrollments.set(id, [...plans]);
  const runs = new Map<string, PayRun>();
  const replies = new Map<string, unknown>();
  const counters = { flag: 0, nudge: 0, adjustment: 0, enrollment: 0 };

  /** The same answer for a retried call: a write happens once per request id. */
  const once = async <T>(requestId: string, write: () => T | Promise<T>): Promise<T> => {
    if (replies.has(requestId)) return replies.get(requestId) as T;
    const result = await write();
    replies.set(requestId, result);
    return result;
  };

  // ---- periods -------------------------------------------------------------------------------

  /** The first day of the period a day falls in, counted in whole periods from the company's start. */
  const periodStartOf = (day: string): string => {
    const offset = daysBetween(policy.periodStartsOn, day);
    if (Number.isNaN(offset)) {
      throw new PayrollDeskError("invalid", `${JSON.stringify(day)} is not a date (YYYY-MM-DD).`);
    }
    return addDays(policy.periodStartsOn, Math.floor(offset / PERIOD_DAYS) * PERIOD_DAYS);
  };
  const periodEnd = (start: string): string => addDays(start, PERIOD_DAYS - 1);
  const payDay = (start: string): string => addDays(periodEnd(start), policy.payDayOffsetDays);
  const lastClosed = (): string => addDays(periodStartOf(today()), -PERIOD_DAYS);
  const resolvePeriod = (period: string | undefined): string => {
    const day = period?.trim() ?? "";
    if (day === "") return lastClosed();
    if (parseDate(day) === undefined) {
      throw new PayrollDeskError(
        "invalid",
        `${JSON.stringify(day)} is not a date. Give any day in the pay period as YYYY-MM-DD. Nothing was recorded.`,
      );
    }
    return periodStartOf(day);
  };
  const runId = (start: string): string => `PR-${start}`;
  const findRun = (id: string): PayRun => {
    const run = runs.get(id.trim().toUpperCase());
    if (run === undefined) {
      throw new PayrollDeskError(
        "not_found",
        `No pay run has the id ${JSON.stringify(id)}. Pay runs are named PR- and the period's first day; list_pay_periods shows them.`,
      );
    }
    return run;
  };

  // ---- people --------------------------------------------------------------------------------

  const findEmployee = (id: string): PayEmployee | undefined =>
    employees.find((employee) => employee.id === id);

  /** An employee by id or name; a first name or surname alone works when only one person has it. */
  const employeeNamed = (query: string): PayEmployee => {
    const wanted = query.trim().toLowerCase();
    const exact = employees.filter(
      (employee) => employee.id.toLowerCase() === wanted || employee.name.toLowerCase() === wanted,
    );
    const matches =
      exact.length > 0
        ? exact
        : employees.filter((employee) =>
            employee.name
              .toLowerCase()
              .split(" ")
              .some((part) => part === wanted),
          );
    const [only, ...others] = matches;
    if (only === undefined) {
      throw new PayrollDeskError(
        "not_found",
        `Nobody on the payroll is called ${JSON.stringify(query)}. Give the employee's full name. Nothing was recorded.`,
      );
    }
    if (others.length > 0) {
      throw new PayrollDeskError(
        "ambiguous",
        `More than one person on the payroll matches ${JSON.stringify(query)}: ${matches.map((employee) => employee.name).join(", ")}. Give the full name. Nothing was recorded.`,
      );
    }
    return only;
  };

  /**
   * The payroll record a verified sender is: office staff only as a colleague (on the company record,
   * writing from inside the office), crew by the contact their record holds.
   */
  const staffFor = (from: VerifiedSender): PayEmployee | undefined => {
    const office = colleague(company, from);
    if (office !== undefined) return findEmployee(office.id);
    const member = senderPerson(
      {
        people: crewMembers.flatMap((employee) =>
          employee.contact === undefined
            ? []
            : [{ ...employee, email: employee.contact, phone: employee.contact }],
        ),
      },
      { ...from, origin: "external" },
    );
    return member === undefined ? undefined : findEmployee(member.id);
  };

  const unknownSender = (what: string) =>
    new PayrollDeskError("unknown_sender", `Nobody verified who sent this, so ${what}.`);

  /** The sender's own payroll record, or the refusal for a sender nobody knows or who is not on staff. */
  const senderStaff = (from: VerifiedSender | undefined, what: string): PayEmployee => {
    if (from === undefined) throw unknownSender(what);
    const own = staffFor(from);
    if (own === undefined) {
      throw new PayrollDeskError(
        "not_staff",
        `The sender is not anyone on the payroll here, so ${what}.`,
      );
    }
    return own;
  };

  /** Office staff only: timesheets and pay runs are the office's working records. */
  const officeOnly = (from: VerifiedSender | undefined, what: string): Person => {
    if (from === undefined) throw unknownSender(what);
    const office = colleague(company, from);
    if (office === undefined) {
      throw new PayrollDeskError(
        "not_office",
        `The sender is not a person on the company record asking from inside the office, so ${what}.`,
      );
    }
    return office;
  };

  const approverOf = (employee: PayEmployee) => {
    const who = timesheetApprover(company, employee.crewId);
    return { toName: who?.name ?? "a person", toTitle: who?.title ?? "" };
  };

  // ---- hours and pay -------------------------------------------------------------------------

  /** The period's workweeks, from the company's period start: never one fourteen-day block. */
  const workweeks = (start: string, days: readonly number[]): WorkweekHours[] =>
    [0, 7].map((offset) => ({
      start: addDays(start, offset),
      end: addDays(start, offset + 6),
      hours: hours(days.slice(offset, offset + 7).reduce((sum, value) => sum + value, 0)),
    }));

  const sheetOf = (start: string, employee: PayEmployee): Timesheet | undefined =>
    timesheets.get(`${start}|${employee.id}`);

  const hourly = (): readonly PayEmployee[] =>
    employees.filter((employee) => employee.pay.kind === "hourly");

  const planCost = (planId: string): number => {
    const plan = policy.benefitPlans.find((candidate) => candidate.id === planId);
    return plan === undefined ? 0 : (DEMO_PLAN_COSTS_CENTS[plan.kind] ?? 0);
  };
  const deductionsOf = (employee: PayEmployee): number =>
    (enrollments.get(employee.id) ?? []).reduce((sum, planId) => sum + planCost(planId), 0);

  /** The open timesheets of a period: every hourly employee whose sheet is missing or not approved. */
  const openSheets = (start: string) =>
    hourly().flatMap((employee) => {
      const sheet = sheetOf(start, employee);
      const status: TimesheetStatus = sheet?.status ?? "missing";
      return status === "approved"
        ? []
        : [{ employee, status: status as Exclude<TimesheetStatus, "approved"> }];
    });

  /**
   * One employee's line. Overtime is counted in each workweek on its own; authorised hours are set
   * against the first week's overtime first, and whatever is left is still paid, and noted.
   */
  const lineFor = (
    start: string,
    employee: PayEmployee,
  ): { line: PayRunLine; notes: OvertimeNote[] } => {
    const deductions = deductionsOf(employee);
    if (employee.pay.kind === "salary") {
      return {
        line: {
          employeeId: employee.id,
          name: employee.name,
          salaried: true,
          rateCents: null,
          weeks: [],
          regularHours: 0,
          overtimeHours: 0,
          unauthorisedOvertimeHours: 0,
          grossCents: employee.pay.perPeriodCents,
          benefitDeductionsCents: deductions,
        },
        notes: [],
      };
    }
    const sheet = sheetOf(start, employee);
    const threshold = policy.overtimeAfterWeeklyHours;
    const weeks: RunWeek[] = workweeks(start, sheet?.days ?? []).map((week) => ({
      ...week,
      regularHours: hours(Math.min(week.hours, threshold)),
      overtimeHours: hours(Math.max(0, week.hours - threshold)),
    }));
    let authorised = sheet?.overtimeAuthorisedHours ?? 0;
    const notes: OvertimeNote[] = [];
    for (const week of weeks) {
      const covered = Math.min(authorised, week.overtimeHours);
      authorised = hours(authorised - covered);
      const unauthorised = hours(week.overtimeHours - covered);
      if (unauthorised > 0) {
        notes.push({
          employee: employee.name,
          weekStart: week.start,
          hours: unauthorised,
          ...approverOf(employee),
        });
      }
    }
    const regular = hours(weeks.reduce((sum, week) => sum + week.regularHours, 0));
    const overtime = hours(weeks.reduce((sum, week) => sum + week.overtimeHours, 0));
    const rate = employee.pay.rateCents;
    return {
      line: {
        employeeId: employee.id,
        name: employee.name,
        salaried: false,
        rateCents: rate,
        weeks,
        regularHours: regular,
        overtimeHours: overtime,
        unauthorisedOvertimeHours: hours(notes.reduce((sum, note) => sum + note.hours, 0)),
        // Overtime at one and a half times the hourly rate, rounded once to the cent.
        grossCents: Math.round(regular * rate) + Math.round(overtime * rate * 1.5),
        benefitDeductionsCents: deductions,
      },
      notes,
    };
  };

  const build = (start: string, status: PayRunStatus, approvedOn: string | null): PayRun => {
    const built = employees.map((employee) => lineFor(start, employee));
    const lines = built.map((entry) => entry.line);
    const sum = (pick: (line: PayRunLine) => number) =>
      lines.reduce((total, line) => total + pick(line), 0);
    return {
      id: runId(start),
      periodStart: start,
      periodEnd: periodEnd(start),
      payDay: payDay(start),
      status,
      lines,
      employees: lines.length,
      regularHours: hours(sum((line) => line.regularHours)),
      overtimeHours: hours(sum((line) => line.overtimeHours)),
      unauthorisedOvertimeHours: hours(sum((line) => line.unauthorisedOvertimeHours)),
      grossCents: sum((line) => line.grossCents),
      overtimeNotes: built.flatMap((entry) => entry.notes),
      preparedOn: today(),
      approvedOn,
    };
  };

  const describeOpen = (open: ReturnType<typeof openSheets>): string =>
    open
      .map(
        ({ employee, status }) =>
          `${employee.name} (${status === "missing" ? "missing" : "submitted, not approved"})`,
      )
      .join(", ");

  const runFacts = (run: PayRun): PayRunFacts => ({
    runId: run.id,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    payDay: run.payDay,
    employees: run.employees,
    regularHours: run.regularHours,
    overtimeHours: run.overtimeHours,
    unauthorisedOvertimeHours: run.unauthorisedOvertimeHours,
    grossCents: run.grossCents,
  });

  for (const seed of options.runs ?? demoRuns()) {
    const open = openSheets(seed.periodStart);
    if (open.length > 0) {
      throw new Error(
        `A seeded run for ${seed.periodStart} has open timesheets: ${describeOpen(open)}.`,
      );
    }
    const run = build(
      seed.periodStart,
      seed.status,
      seed.status === "approved" ? (seed.approvedOn ?? null) : null,
    );
    runs.set(run.id, { ...run, preparedOn: seed.approvedOn ?? seed.periodStart });
  }

  const draftRun = (id: string): PayRun => {
    const run = findRun(id);
    if (run.status === "approved") {
      throw new PayrollDeskError(
        "already_approved",
        `${run.id} was approved on ${run.approvedOn ?? "an earlier day"} and is final: it cannot be submitted or changed again. A correction is a new adjustment, asked for with request_pay_adjustment.`,
      );
    }
    return run;
  };

  // ---- benefits ------------------------------------------------------------------------------

  const findPlan = (planId: string): BenefitPlanFact => {
    const wanted = planId.trim().toLowerCase();
    const plan = policy.benefitPlans.find(
      (candidate) => candidate.id === wanted || candidate.name.toLowerCase() === wanted,
    );
    if (plan === undefined) {
      throw new PayrollDeskError(
        "not_found",
        `The company offers no plan ${JSON.stringify(planId)}. Plans offered: ${policy.benefitPlans.map((entry) => `${entry.id} (${entry.name})`).join(", ")}. Nothing was recorded.`,
      );
    }
    return plan;
  };

  /** Open enrolment in today's year, and whether today falls inside it. */
  const enrollmentWindow = () => {
    const now = today();
    const year = now.slice(0, 4);
    const opens = `${year}-${policy.enrollmentWindow.opens}`;
    const closes = `${year}-${policy.enrollmentWindow.closes}`;
    return { opens, closes, open: now >= opens && now <= closes };
  };

  /** Checks the plan and the action against the sender's enrolments; returns the employee and plan. */
  const checkChange = (
    input: Omit<EnrollmentChangeInput, "lifeEvent" | "specialEnrollmentDays">,
  ) => {
    const employee = senderStaff(input.from, "no benefit change is recorded for them");
    const plan = findPlan(input.planId);
    if (!ENROLLMENT_ACTIONS.includes(input.action)) {
      throw new PayrollDeskError(
        "invalid",
        `${JSON.stringify(input.action)} is not enroll or drop. Nothing was recorded.`,
      );
    }
    const enrolled = (enrollments.get(employee.id) ?? []).includes(plan.id);
    if (input.action === "enroll" && enrolled) {
      throw new PayrollDeskError(
        "duplicate",
        `${employee.name} is already enrolled in ${plan.name}. Nothing was recorded.`,
      );
    }
    if (input.action === "drop" && !enrolled) {
      throw new PayrollDeskError(
        "invalid",
        `${employee.name} is not enrolled in ${plan.name}, so there is nothing to drop. Nothing was recorded.`,
      );
    }
    return { employee, plan };
  };

  const applyChange = (
    employee: PayEmployee,
    plan: BenefitPlanFact,
    change: Omit<
      EnrollmentChange,
      "id" | "employeeId" | "employee" | "planId" | "planName" | "recordedOn"
    >,
  ): EnrollmentChange => {
    const current = enrollments.get(employee.id) ?? [];
    enrollments.set(
      employee.id,
      change.action === "enroll" ? [...current, plan.id] : current.filter((id) => id !== plan.id),
    );
    counters.enrollment += 1;
    return {
      id: `ENR-${counters.enrollment}`,
      employeeId: employee.id,
      employee: employee.name,
      planId: plan.id,
      planName: plan.name,
      recordedOn: today(),
      ...change,
    };
  };

  const exceptionFacts = (input: EnrollmentExceptionInput): EnrollmentExceptionFacts => {
    const { employee, plan } = checkChange(input);
    if (enrollmentWindow().open) {
      throw new PayrollDeskError(
        "not_needed",
        `Open enrolment runs ${enrollmentWindow().opens} to ${enrollmentWindow().closes} and today is inside it, so no exception is needed. Nothing was put to a person.`,
      );
    }
    return {
      employeeId: employee.id,
      employee: employee.name,
      planId: plan.id,
      planName: plan.name,
      action: input.action,
      reason: required(input.reason, "the reason the change is needed outside open enrolment"),
    };
  };

  // ---- adjustments ---------------------------------------------------------------------------

  const adjustmentFacts = (input: PayAdjustmentInput): PayAdjustmentFacts => {
    const sender = senderStaff(input.from, "no correction is asked for");
    const named = input.employee?.trim() ?? "";
    let employee = sender;
    if (named !== "") {
      const wanted = employeeNamed(named);
      if (wanted.id !== sender.id && colleague(company, input.from) === undefined) {
        throw new PayrollDeskError(
          "someone_else",
          `${sender.name} may ask only about their own pay: ${wanted.name}'s is theirs to raise, or for office staff to raise for them. Nothing was asked.`,
        );
      }
      employee = wanted;
    }
    const run = findRun(input.runId);
    if (run.status === "draft") {
      throw new PayrollDeskError(
        "still_draft",
        `${run.id} is still a draft: correct the timesheet and prepare it again with prepare_pay_run; no adjustment is needed. Nothing was asked.`,
      );
    }
    const line = run.lines.find((entry) => entry.employeeId === employee.id);
    if (line === undefined) {
      throw new PayrollDeskError(
        "not_found",
        `${employee.name} is not on ${run.id}. Nothing was asked.`,
      );
    }
    return {
      runId: run.id,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      employeeId: employee.id,
      employee: employee.name,
      reason: required(input.reason, "what is wrong with the pay"),
      lowestCents: -line.grossCents,
      highestCents: line.grossCents,
    };
  };

  return {
    async listPayPeriods(input = {}) {
      const current = periodStartOf(today());
      const starts =
        (input.period?.trim() ?? "") === ""
          ? [-2, -1, 0, 1].map((step) => addDays(current, step * PERIOD_DAYS))
          : [resolvePeriod(input.period)];
      return starts.map((start) => {
        const run = runs.get(runId(start));
        return {
          start,
          end: periodEnd(start),
          payDay: payDay(start),
          closed: periodEnd(start) < today(),
          run: run === undefined ? null : { id: run.id, status: run.status },
        };
      });
    },

    async listTimesheets(input) {
      officeOnly(input.from, "no timesheet is listed for them");
      const start = resolvePeriod(input.period);
      return {
        periodStart: start,
        periodEnd: periodEnd(start),
        sheets: hourly().map((employee) => {
          const sheet = sheetOf(start, employee);
          const weeks = workweeks(start, sheet?.days ?? []);
          const approver = approverOf(employee);
          return {
            employeeId: employee.id,
            name: employee.name,
            crewId: employee.crewId ?? "",
            status: sheet?.status ?? "missing",
            weeks,
            totalHours: hours(weeks.reduce((sum, week) => sum + week.hours, 0)),
            overtimeAuthorisedHours: sheet?.overtimeAuthorisedHours ?? 0,
            approverName: approver.toName,
            approverTitle: approver.toTitle,
          };
        }),
      };
    },

    flagTimesheet(input, options) {
      return once(options.requestId, () => {
        const employee = employeeNamed(input.employee);
        const reason = required(input.reason, "what looks wrong on the timesheet");
        const start = resolvePeriod(input.period);
        counters.flag += 1;
        return {
          id: `FLAG-${counters.flag}`,
          employee: employee.name,
          periodStart: start,
          reason,
          ...approverOf(employee),
        };
      });
    },

    requestTimesheetApproval(input, options) {
      return once(options.requestId, () => {
        const start = resolvePeriod(input.period);
        const open = openSheets(start);
        if (open.length === 0) {
          throw new PayrollDeskError(
            "nothing_open",
            `Every timesheet for the period from ${start} is approved, so nobody needs a nudge. Nothing was sent.`,
          );
        }
        counters.nudge += 1;
        return {
          id: `NUDGE-${counters.nudge}`,
          periodStart: start,
          open: open.map(({ employee, status }) => ({
            employee: employee.name,
            status,
            ...approverOf(employee),
          })),
        };
      });
    },

    preparePayRun(input, options) {
      return once(options.requestId, () => {
        officeOnly(input.from, "no pay run is prepared for them");
        const start = resolvePeriod(input.period);
        if (periodEnd(start) >= today()) {
          throw new PayrollDeskError(
            "not_closed",
            `The period ${start} to ${periodEnd(start)} has not ended (today is ${today()}): a pay run is prepared once its last day has passed. Nothing was prepared.`,
          );
        }
        const existing = runs.get(runId(start));
        if (existing?.status === "approved") draftRun(existing.id);
        const open = openSheets(start);
        if (open.length > 0) {
          throw new PayrollDeskError(
            "timesheets_open",
            `The pay run for ${start} to ${periodEnd(start)} cannot be prepared while timesheets are open: ${describeOpen(open)}. Nothing was prepared.`,
          );
        }
        const run = build(start, "draft", null);
        runs.set(run.id, run);
        return run;
      });
    },

    async payRunFacts(input) {
      officeOnly(input.from, "no pay run is put to a person for them");
      return runFacts(draftRun(input.runId));
    },

    submitPayRun(input, options) {
      return once(options.requestId, () => {
        officeOnly(input.from, "no pay run is submitted for them");
        const run = draftRun(input.runId);
        if (!sameFacts(input.approved, runFacts(run))) {
          throw new PayrollDeskError(
            "run_changed",
            `${run.id} no longer matches what the person approved, so it was not approved. Nothing was paid.`,
          );
        }
        const approved: PayRun = { ...run, status: "approved", approvedOn: today() };
        runs.set(run.id, approved);
        return approved;
      });
    },

    async payAdjustmentFacts(input) {
      return adjustmentFacts(input);
    },

    requestPayAdjustment(input, options) {
      return once(options.requestId, () => {
        const facts = adjustmentFacts(input);
        if (!sameFacts(input.approved, facts)) {
          throw new PayrollDeskError(
            "changed",
            `The correction no longer matches what the person approved, so nothing was recorded.`,
          );
        }
        const amount = input.amountCents;
        if (!Number.isSafeInteger(amount)) {
          throw new PayrollDeskError(
            "invalid",
            `The adjustment must be whole cents, as the person approving entered it; got ${String(amount)}. Nothing was recorded.`,
          );
        }
        // The bounds straddle zero, so they cannot exclude it; a correction that changes nothing is
        // refused here instead.
        if (amount === 0) {
          throw new PayrollDeskError(
            "invalid",
            "An adjustment of zero changes no pay, so nothing was recorded. A correction is an amount above or below zero, entered by the person approving.",
          );
        }
        if (amount < facts.lowestCents || amount > facts.highestCents) {
          throw new PayrollDeskError(
            "invalid",
            `The adjustment is outside what the person approving could enter for ${facts.employee} on ${facts.runId}. Nothing was recorded.`,
          );
        }
        const sender = senderStaff(input.from, "no correction is asked for");
        counters.adjustment += 1;
        return {
          id: `ADJ-${counters.adjustment}`,
          ...facts,
          approvedOn: today(),
          amountCents: amount,
          amountSetBy: input.amountSetBy,
          sendersOwn: sender.id === facts.employeeId,
        };
      });
    },

    async payStatement(input) {
      const employee = senderStaff(input.from, "no pay statement is given");
      const approved = [...runs.values()]
        .filter((run) => run.status === "approved")
        .sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1));
      const wanted = input.runId?.trim().toUpperCase() ?? "";
      const run = wanted === "" ? approved[0] : approved.find((entry) => entry.id === wanted);
      const line = run?.lines.find((entry) => entry.employeeId === employee.id);
      if (run === undefined || line === undefined) {
        throw new PayrollDeskError(
          "no_statement",
          wanted === ""
            ? `No approved pay run holds a statement for ${employee.name} yet.`
            : `There is no approved pay run ${JSON.stringify(input.runId)} with a statement for ${employee.name}: a draft run has no statement until a person approves it.`,
        );
      }
      return {
        runId: run.id,
        employee: employee.name,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        payDay: run.payDay,
        salaried: line.salaried,
        rateCents: line.rateCents,
        weeks: line.weeks,
        regularHours: line.regularHours,
        overtimeHours: line.overtimeHours,
        grossCents: line.grossCents,
        benefitDeductionsCents: line.benefitDeductionsCents,
        deductions: (enrollments.get(employee.id) ?? []).map((planId) => ({
          planName: findPlan(planId).name,
          perPeriodCents: planCost(planId),
        })),
      };
    },

    async benefitsSummary(input) {
      const employee = senderStaff(input.from, "no benefits are given");
      return {
        employeeId: employee.id,
        employee: employee.name,
        enrolled: (enrollments.get(employee.id) ?? []).map((planId) => {
          const plan = findPlan(planId);
          return {
            planId: plan.id,
            planName: plan.name,
            kind: plan.kind,
            perPeriodCents: planCost(plan.id),
          };
        }),
        offered: policy.benefitPlans,
        window: enrollmentWindow(),
        specialEnrollmentDays: input.specialEnrollmentDays ?? null,
      };
    },

    recordEnrollmentChange(input, options) {
      return once(options.requestId, () => {
        const { employee, plan } = checkChange(input);
        const window = enrollmentWindow();
        if (window.open) {
          return applyChange(employee, plan, {
            action: input.action,
            basis: "open_enrollment",
            lifeEvent: null,
            approvedVia: null,
          });
        }
        const event = input.lifeEvent;
        if (event === undefined) {
          throw new PayrollDeskError(
            "outside_window",
            `Open enrolment ran ${window.opens} to ${window.closes}, and no qualifying life event was given. Qualifying life events: marriage, divorce, a birth or adoption, losing other coverage, a dependant's death. Nothing was recorded.`,
          );
        }
        if (!LIFE_EVENTS.includes(event.kind)) {
          throw new PayrollDeskError(
            "invalid",
            `${JSON.stringify(event.kind)} is not a qualifying life event. Use one of: ${LIFE_EVENTS.join(", ")}. Nothing was recorded.`,
          );
        }
        const ago = daysBetween(event.date, today());
        if (Number.isNaN(ago) || ago < 0) {
          throw new PayrollDeskError(
            "invalid",
            `${JSON.stringify(event.date)} is not a past date (today is ${today()}): a life event is recorded once it has happened. Nothing was recorded.`,
          );
        }
        if (!LIFE_EVENT_PLAN_KINDS.includes(plan.kind)) {
          throw new PayrollDeskError(
            "plan_not_eligible",
            `A life event does not open ${plan.name}: it changes in open enrolment only (${window.opens} to ${window.closes}). Nothing was recorded.`,
          );
        }
        // The special enrolment period is the role's limit, read at this call; with none set the
        // desk allows no life-event change on its own and a person decides.
        const allowed = input.specialEnrollmentDays;
        if (allowed === undefined || !Number.isFinite(allowed) || ago > allowed) {
          throw new PayrollDeskError(
            "event_too_old",
            allowed === undefined || !Number.isFinite(allowed)
              ? `No special enrolment period is set for this role, so a life-event change is a person's decision. Nothing was recorded.`
              : `The ${event.kind.replaceAll("_", " ")} on ${event.date} was ${ago} days ago, past the ${allowed}-day special enrolment period. Nothing was recorded.`,
          );
        }
        return applyChange(employee, plan, {
          action: input.action,
          basis: "life_event",
          lifeEvent: { kind: event.kind, date: event.date },
          approvedVia: null,
        });
      });
    },

    async enrollmentExceptionFacts(input) {
      return exceptionFacts(input);
    },

    requestEnrollmentException(input, options) {
      return once(options.requestId, () => {
        const facts = exceptionFacts(input);
        if (!sameFacts(input.approved, facts)) {
          throw new PayrollDeskError(
            "changed",
            "The benefit change no longer matches what the person approved, so nothing was recorded.",
          );
        }
        const { employee, plan } = checkChange(input);
        return applyChange(employee, plan, {
          action: input.action,
          basis: "exception",
          lifeEvent: null,
          approvedVia: "enrollment_exception",
        });
      });
    },
  };
}
