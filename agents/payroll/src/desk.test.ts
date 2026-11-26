/**
 * The desk's rules, against `fakePayrollDesk` and the company facts generated into this package: pay
 * periods and pay days from the company's schedule, overtime counted one workweek at a time and never
 * averaged, unauthorised overtime paid and noted, a pay run refused while a timesheet is open, an
 * approved run that never changes, own-record-only pay and benefits, the enrolment window and the
 * special enrolment period, and a replayed write that happens once.
 */

import type { VerifiedSender } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { loadCompanyFacts, payrollApprover, timesheetApprover } from "./company.js";
import {
  DEMO_NOW,
  DEMO_OFFICE_SALARY_CENTS,
  demoEmployees,
  demoTimesheets,
  fakePayrollDesk,
  type PayrollDesk,
  PayrollDeskError,
  type Timesheet,
} from "./desk.js";

const company = loadCompanyFacts();
const NOW = new Date(DEMO_NOW);
const desk = (options: Parameters<typeof fakePayrollDesk>[0] = {}): PayrollDesk =>
  fakePayrollDesk({ company, now: () => NOW, ...options });

/** The person who approves pay runs, asking from inside the office. */
const OFFICE: VerifiedSender = {
  origin: "internal",
  channel: "chat",
  contact: payrollApprover(company)?.id ?? "",
};
const crew = (name: string): VerifiedSender => ({
  origin: "external",
  channel: "email",
  contact: `${name.toLowerCase().replace(" ", ".")}@crew.example`,
});
const DIEGO = crew("Diego Ramirez");
const ANA = crew("Ana Lopez");
const STRANGER: VerifiedSender = {
  origin: "external",
  channel: "email",
  contact: "x@else.example",
};

const CLOSED = "2026-11-23";
const PAID = "2026-11-09";

async function refusedWith(promise: Promise<unknown>, code: string): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PayrollDeskError);
    expect((error as PayrollDeskError).code).toBe(code);
    return (error as Error).message;
  }
  throw new Error(`expected a ${code} refusal`);
}

/** Every key, at any depth, whose name says it holds money. */
function moneyKeys(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) => [
    ...(/cents/i.test(key) ? [`${path}${key}`] : []),
    ...moneyKeys(inner, `${path}${key}.`),
  ]);
}

describe("pay periods", () => {
  it("counts biweekly periods and pay days from the company's schedule", async () => {
    const periods = await desk().listPayPeriods();
    const byStart = new Map(periods.map((period) => [period.start, period]));
    expect(byStart.get(PAID)).toMatchObject({
      end: "2026-11-22",
      payDay: "2026-11-27",
      closed: true,
      run: { id: "PR-2026-11-09", status: "approved" },
    });
    expect(byStart.get(CLOSED)).toMatchObject({
      end: "2026-12-06",
      payDay: "2026-12-11",
      closed: true,
      run: { id: "PR-2026-11-23", status: "draft" },
    });
    expect(byStart.get("2026-12-07")).toMatchObject({ closed: false, run: null });
    expect(company.payroll.payDayOffsetDays).toBe(5);
  });
});

describe("timesheets", () => {
  it("lists hours per workweek and status, with no pay, only to office staff", async () => {
    const sheets = await desk().listTimesheets({ from: OFFICE });
    expect(sheets.periodStart).toBe(CLOSED);
    const diego = sheets.sheets.find((sheet) => sheet.name === "Diego Ramirez");
    expect(diego).toMatchObject({
      status: "approved",
      weeks: [
        { start: "2026-11-23", end: "2026-11-29", hours: 44 },
        { start: "2026-11-30", end: "2026-12-06", hours: 36 },
      ],
      overtimeAuthorisedHours: 4,
      approverName: timesheetApprover(company, "cleaning-north")?.name,
    });
    expect(sheets.sheets).toHaveLength(demoEmployees().length);
    expect(moneyKeys(sheets)).toEqual([]);
  });

  it("refuses an unknown sender and a crew member", async () => {
    await refusedWith(desk().listTimesheets({ from: undefined }), "unknown_sender");
    await refusedWith(desk().listTimesheets({ from: DIEGO }), "not_office");
    await refusedWith(desk().listTimesheets({ from: STRANGER }), "not_office");
  });

  it("flags a timesheet for its approver, once per request id", async () => {
    const payroll = desk();
    const input = { employee: "Farid", reason: "Saturday hours look high" };
    const flag = await payroll.flagTimesheet(input, { requestId: "f1" });
    expect(flag).toMatchObject({
      id: "FLAG-1",
      employee: "Farid Haddad",
      periodStart: CLOSED,
      toName: timesheetApprover(company, "cleaning-central")?.name,
    });
    expect(await payroll.flagTimesheet(input, { requestId: "f1" })).toEqual(flag);
    expect((await payroll.flagTimesheet(input, { requestId: "f2" })).id).toBe("FLAG-2");
    await refusedWith(
      payroll.flagTimesheet({ ...input, employee: "Nobody" }, { requestId: "f3" }),
      "not_found",
    );
    await refusedWith(
      payroll.flagTimesheet({ ...input, reason: " " }, { requestId: "f4" }),
      "invalid",
    );
  });
});

/** The demonstration timesheets with one employee's replaced. */
function withSheet(name: string, change: Partial<Timesheet>): readonly Timesheet[] {
  const id = demoEmployees().find((employee) => employee.name === name)?.id;
  return demoTimesheets().map((sheet) =>
    sheet.employeeId === id && sheet.periodStart === CLOSED ? { ...sheet, ...change } : sheet,
  );
}

describe("prepare_pay_run", () => {
  it("counts overtime per workweek, never averaged over the period", async () => {
    const run = await desk().preparePayRun({ from: OFFICE }, { requestId: "p1" });
    expect(run).toMatchObject({ id: "PR-2026-11-23", status: "draft", payDay: "2026-12-11" });
    const diego = run.lines.find((line) => line.name === "Diego Ramirez");
    // 44 and 36 hours: 80 in the period, yet 4 hours over 40 in the first workweek.
    expect(diego).toMatchObject({
      regularHours: 76,
      overtimeHours: 4,
      unauthorisedOvertimeHours: 0,
      grossCents: 76 * 2100 + 4 * 3150,
    });
    expect(diego?.weeks.map((week) => [week.hours, week.overtimeHours])).toEqual([
      [44, 4],
      [36, 0],
    ]);
  });

  it("pays overtime nobody authorised and notes it for the approver", async () => {
    const run = await desk().preparePayRun({ from: OFFICE }, { requestId: "p1" });
    const farid = run.lines.find((line) => line.name === "Farid Haddad");
    expect(farid).toMatchObject({
      regularHours: 80,
      overtimeHours: 6,
      unauthorisedOvertimeHours: 6,
      grossCents: 80 * 2100 + 6 * 3150,
    });
    expect(run.overtimeNotes).toEqual([
      {
        employee: "Farid Haddad",
        weekStart: "2026-11-30",
        hours: 6,
        toName: timesheetApprover(company, "cleaning-central")?.name ?? "",
        toTitle: timesheetApprover(company, "cleaning-central")?.title ?? "",
      },
    ]);
    expect(run.overtimeHours).toBe(10);
    expect(run.regularHours).toBe(13 * 80 + 76 + 80);
    // Office staff are salaried and need no timesheet.
    expect(run.employees).toBe(demoEmployees().length + company.people.length);
    expect(run.grossCents).toBe(run.lines.reduce((sum, line) => sum + line.grossCents, 0));
  });

  it("refuses while a timesheet is missing or unapproved, naming each", async () => {
    const open = withSheet("Ivan Petrov", { status: "submitted" }).filter(
      (sheet) =>
        !(
          sheet.periodStart === CLOSED &&
          sheet.employeeId === demoEmployees().find((e) => e.name === "Olga Ivanova")?.id
        ),
    );
    const message = await refusedWith(
      desk({ timesheets: open, runs: [] }).preparePayRun({ from: OFFICE }, { requestId: "p1" }),
      "timesheets_open",
    );
    expect(message).toContain("Ivan Petrov (submitted, not approved)");
    expect(message).toContain("Olga Ivanova (missing)");
    expect(message).toContain("Nothing was prepared");
  });

  it("refuses an open period, an approved one, and anyone outside the office", async () => {
    const payroll = desk();
    await refusedWith(
      payroll.preparePayRun({ period: "2026-12-08", from: OFFICE }, { requestId: "a" }),
      "not_closed",
    );
    await refusedWith(
      payroll.preparePayRun({ period: PAID, from: OFFICE }, { requestId: "b" }),
      "already_approved",
    );
    await refusedWith(payroll.preparePayRun({ from: DIEGO }, { requestId: "c" }), "not_office");
    await refusedWith(
      payroll.preparePayRun({ from: undefined }, { requestId: "d" }),
      "unknown_sender",
    );
    await refusedWith(
      payroll.preparePayRun({ period: "soon", from: OFFICE }, { requestId: "e" }),
      "invalid",
    );
  });

  it("nudges the approvers of open timesheets, and refuses when none is open", async () => {
    const open = withSheet("Ivan Petrov", { status: "submitted" });
    const payroll = desk({ timesheets: open, runs: [] });
    const nudge = await payroll.requestTimesheetApproval({}, { requestId: "n1" });
    expect(nudge).toMatchObject({
      id: "NUDGE-1",
      periodStart: CLOSED,
      open: [
        {
          employee: "Ivan Petrov",
          status: "submitted",
          toName: timesheetApprover(company, "cleaning-central")?.name,
        },
      ],
    });
    expect(await payroll.requestTimesheetApproval({}, { requestId: "n1" })).toEqual(nudge);
    await refusedWith(desk().requestTimesheetApproval({}, { requestId: "n2" }), "nothing_open");
  });
});

describe("submit_pay_run", () => {
  it("reads the draft's facts and approves exactly them, once", async () => {
    const payroll = desk();
    const facts = await payroll.payRunFacts({ runId: "PR-2026-11-23", from: OFFICE });
    expect(facts).toMatchObject({
      runId: "PR-2026-11-23",
      periodStart: CLOSED,
      periodEnd: "2026-12-06",
      payDay: "2026-12-11",
      overtimeHours: 10,
      unauthorisedOvertimeHours: 6,
    });
    const run = await payroll.submitPayRun(
      { runId: "PR-2026-11-23", from: OFFICE, approved: { ...facts } },
      { requestId: "s1" },
    );
    expect(run).toMatchObject({ status: "approved", approvedOn: "2026-12-07" });
    expect(
      await payroll.submitPayRun(
        { runId: "PR-2026-11-23", from: OFFICE, approved: { ...facts } },
        { requestId: "s1" },
      ),
    ).toEqual(run);
    await refusedWith(
      payroll.submitPayRun(
        { runId: "PR-2026-11-23", from: OFFICE, approved: { ...facts } },
        { requestId: "s2" },
      ),
      "already_approved",
    );
  });

  it("refuses facts that are not the draft's, an unknown run and a crew member", async () => {
    const payroll = desk();
    const facts = await payroll.payRunFacts({ runId: "PR-2026-11-23", from: OFFICE });
    await refusedWith(
      payroll.submitPayRun(
        { runId: "PR-2026-11-23", from: OFFICE, approved: { ...facts, grossCents: 1 } },
        { requestId: "s1" },
      ),
      "run_changed",
    );
    expect((await payroll.listPayPeriods()).find((p) => p.start === CLOSED)?.run?.status).toBe(
      "draft",
    );
    await refusedWith(payroll.payRunFacts({ runId: "PR-9", from: OFFICE }), "not_found");
    await refusedWith(payroll.payRunFacts({ runId: "PR-2026-11-23", from: DIEGO }), "not_office");
    await refusedWith(payroll.payRunFacts({ runId: PAID_RUN, from: OFFICE }), "already_approved");
  });
});

const PAID_RUN = "PR-2026-11-09";

describe("pay statements", () => {
  it("gives the sender their own statement from the latest approved run", async () => {
    const statement = await desk().payStatement({ from: DIEGO });
    expect(statement).toMatchObject({
      runId: PAID_RUN,
      employee: "Diego Ramirez",
      payDay: "2026-11-27",
      rateCents: 2100,
      regularHours: 80,
      overtimeHours: 2,
      grossCents: 80 * 2100 + 2 * 3150,
      benefitDeductionsCents: 6500 + 1200,
    });
  });

  it("gives nothing to an unknown sender or someone not on staff, and never takes an employee", async () => {
    await refusedWith(desk().payStatement({ from: undefined }), "unknown_sender");
    await refusedWith(desk().payStatement({ from: STRANGER }), "not_staff");
    await refusedWith(desk().payStatement({ from: DIEGO, runId: "PR-2026-11-23" }), "no_statement");
  });
});

describe("pay adjustments", () => {
  /** Diego's gross on the approved run: 80 regular hours and 2 overtime hours at $21.00. */
  const DIEGO_GROSS = 80 * 2100 + 2 * 3150;

  it("asks for a correction on an approved run, bounded by the employee's gross, and records the approved amount once", async () => {
    const payroll = desk();
    const before = await payroll.payStatement({ from: DIEGO });
    expect(before.grossCents).toBe(DIEGO_GROSS);
    const input = {
      runId: PAID_RUN,
      reason: "Three hours on 18 November are missing",
      from: DIEGO,
    };
    const facts = await payroll.payAdjustmentFacts(input);
    expect(facts).toEqual({
      runId: PAID_RUN,
      periodStart: PAID,
      periodEnd: "2026-11-22",
      employeeId: "E-04",
      employee: "Diego Ramirez",
      reason: "Three hours on 18 November are missing",
      lowestCents: -DIEGO_GROSS,
      highestCents: DIEGO_GROSS,
    });
    // The only money in the facts is the bounds the person approving is shown.
    expect(moneyKeys(facts)).toEqual(["lowestCents", "highestCents"]);
    const adjustment = await payroll.requestPayAdjustment(
      { ...input, approved: { ...facts }, amountCents: 10500, amountSetBy: "eileen-hart" },
      { requestId: "a1" },
    );
    expect(adjustment).toMatchObject({
      id: "ADJ-1",
      runId: PAID_RUN,
      employee: "Diego Ramirez",
      amountCents: 10500,
      amountSetBy: "eileen-hart",
      sendersOwn: true,
    });
    // A replay of the same request returns what was written, whatever amount it carries.
    expect(
      await payroll.requestPayAdjustment(
        { ...input, approved: { ...facts }, amountCents: 1, amountSetBy: "someone" },
        { requestId: "a1" },
      ),
    ).toEqual(adjustment);
    expect(await payroll.payStatement({ from: DIEGO })).toEqual(before);
  });

  it("records a reduction inside the bounds, down to minus the whole gross", async () => {
    const payroll = desk();
    const input = { runId: PAID_RUN, reason: "Overtime paid for hours not worked", from: DIEGO };
    const approved = { ...(await payroll.payAdjustmentFacts(input)) };
    const reduced = await payroll.requestPayAdjustment(
      { ...input, approved, amountCents: -3150, amountSetBy: null },
      { requestId: "r1" },
    );
    expect(reduced).toMatchObject({ id: "ADJ-1", amountCents: -3150, amountSetBy: null });
    const whole = await payroll.requestPayAdjustment(
      { ...input, approved, amountCents: -DIEGO_GROSS, amountSetBy: "eileen-hart" },
      { requestId: "r2" },
    );
    expect(whole).toMatchObject({ id: "ADJ-2", amountCents: -DIEGO_GROSS });
  });

  it("refuses zero, an amount outside the bounds and one that is not whole cents, recording nothing", async () => {
    const payroll = desk();
    const input = { runId: PAID_RUN, reason: "Missing hours", from: DIEGO };
    const approved = { ...(await payroll.payAdjustmentFacts(input)) };
    const zero = await refusedWith(
      payroll.requestPayAdjustment(
        { ...input, approved, amountCents: 0, amountSetBy: "eileen-hart" },
        { requestId: "z" },
      ),
      "invalid",
    );
    expect(zero).toContain("An adjustment of zero changes no pay");
    for (const amountCents of [DIEGO_GROSS + 1, -DIEGO_GROSS - 1, 12.5, Number.NaN]) {
      await refusedWith(
        payroll.requestPayAdjustment(
          { ...input, approved, amountCents, amountSetBy: "eileen-hart" },
          { requestId: `bad-${amountCents}` },
        ),
        "invalid",
      );
    }
    // Nothing was recorded: the next correction is still the first.
    const first = await payroll.requestPayAdjustment(
      { ...input, approved, amountCents: 100, amountSetBy: "eileen-hart" },
      { requestId: "ok" },
    );
    expect(first.id).toBe("ADJ-1");
  });

  it("lets the office ask for anyone, bounded by that employee's gross, and refuses a crew member asking for a colleague", async () => {
    const payroll = desk();
    const input = {
      runId: PAID_RUN,
      employee: "Diego Ramirez",
      reason: "Missing hours",
      from: OFFICE,
    };
    const facts = await payroll.payAdjustmentFacts(input);
    expect(facts).toMatchObject({
      employee: "Diego Ramirez",
      lowestCents: -DIEGO_GROSS,
      highestCents: DIEGO_GROSS,
    });
    // With no employee named the correction is the sender's own, bounded by their own gross.
    const own = await payroll.payAdjustmentFacts({ runId: PAID_RUN, reason: "x", from: OFFICE });
    expect(own).toMatchObject({
      lowestCents: -DEMO_OFFICE_SALARY_CENTS,
      highestCents: DEMO_OFFICE_SALARY_CENTS,
    });
    const recorded = await payroll.requestPayAdjustment(
      { ...input, approved: { ...facts }, amountCents: 9450, amountSetBy: "eileen-hart" },
      { requestId: "o1" },
    );
    expect(recorded).toMatchObject({ employee: "Diego Ramirez", sendersOwn: false });
    await refusedWith(
      payroll.payAdjustmentFacts({ runId: PAID_RUN, employee: "Diego", reason: "x", from: ANA }),
      "someone_else",
    );
    await refusedWith(
      payroll.payAdjustmentFacts({ runId: PAID_RUN, reason: "x", from: undefined }),
      "unknown_sender",
    );
  });

  it("refuses a draft run, which is still corrected by preparing it again, and changed facts", async () => {
    const payroll = desk();
    await refusedWith(
      payroll.payAdjustmentFacts({ runId: "PR-2026-11-23", reason: "x", from: DIEGO }),
      "still_draft",
    );
    const facts = await payroll.payAdjustmentFacts({ runId: PAID_RUN, reason: "x", from: DIEGO });
    for (const [index, approved] of [
      { ...facts, employee: "Ana Lopez" },
      { ...facts, highestCents: facts.highestCents + 100 },
    ].entries()) {
      await refusedWith(
        payroll.requestPayAdjustment(
          {
            runId: PAID_RUN,
            reason: "x",
            from: DIEGO,
            approved,
            amountCents: 100,
            amountSetBy: "eileen-hart",
          },
          { requestId: `c${index}` },
        ),
        "changed",
      );
    }
  });
});

describe("benefits", () => {
  it("gives the sender their own plans and the window, and nobody else's", async () => {
    const summary = await desk().benefitsSummary({ from: DIEGO, specialEnrollmentDays: 30 });
    expect(summary).toMatchObject({
      employee: "Diego Ramirez",
      window: { opens: "2026-11-01", closes: "2026-11-30", open: false },
      specialEnrollmentDays: 30,
    });
    expect(summary.enrolled.map((plan) => [plan.planId, plan.perPeriodCents])).toEqual([
      ["medical-ppo", 6500],
      ["dental", 1200],
    ]);
    expect(summary.offered.map((plan) => plan.id)).toEqual(
      company.payroll.benefitPlans.map((plan) => plan.id),
    );
    await refusedWith(
      desk().benefitsSummary({ from: undefined, specialEnrollmentDays: 30 }),
      "unknown_sender",
    );
    await refusedWith(
      desk().benefitsSummary({ from: STRANGER, specialEnrollmentDays: 30 }),
      "not_staff",
    );
  });

  const change = {
    planId: "vision",
    action: "enroll" as const,
    from: ANA,
    specialEnrollmentDays: 30,
  };

  it("records a change after a qualifying life event inside the special enrolment period", async () => {
    const payroll = desk();
    const recorded = await payroll.recordEnrollmentChange(
      { ...change, lifeEvent: { kind: "marriage", date: "2026-11-28" } },
      { requestId: "e1" },
    );
    expect(recorded).toMatchObject({
      id: "ENR-1",
      employee: "Ana Lopez",
      planName: "Vision",
      action: "enroll",
      basis: "life_event",
      approvedVia: null,
    });
    const summary = await payroll.benefitsSummary({ from: ANA, specialEnrollmentDays: 30 });
    expect(summary.enrolled.map((plan) => plan.planId)).toContain("vision");
  });

  it("refuses a change outside open enrolment with no life event, and points to the exception", async () => {
    const message = await refusedWith(
      desk().recordEnrollmentChange(change, { requestId: "e1" }),
      "outside_window",
    );
    expect(message).toContain("no qualifying life event was given");
  });

  it("reads the special enrolment period it is given at every call", async () => {
    const late = { ...change, lifeEvent: { kind: "birth" as const, date: "2026-10-20" } };
    // 48 days ago: outside 30, inside 60.
    await refusedWith(desk().recordEnrollmentChange(late, { requestId: "e1" }), "event_too_old");
    const recorded = await desk().recordEnrollmentChange(
      { ...late, specialEnrollmentDays: 60 },
      { requestId: "e1" },
    );
    expect(recorded.basis).toBe("life_event");
    await refusedWith(
      desk().recordEnrollmentChange(
        { ...late, specialEnrollmentDays: undefined },
        { requestId: "e1" },
      ),
      "event_too_old",
    );
  });

  it("refuses a future life event, a plan a life event does not open, and a duplicate", async () => {
    await refusedWith(
      desk().recordEnrollmentChange(
        { ...change, lifeEvent: { kind: "birth", date: "2027-01-05" } },
        { requestId: "e1" },
      ),
      "invalid",
    );
    await refusedWith(
      desk().recordEnrollmentChange(
        {
          ...change,
          planId: "retirement-401k",
          lifeEvent: { kind: "marriage", date: "2026-11-28" },
        },
        { requestId: "e1" },
      ),
      "plan_not_eligible",
    );
    await refusedWith(
      desk().recordEnrollmentChange(
        { ...change, planId: "medical-ppo", lifeEvent: { kind: "marriage", date: "2026-11-28" } },
        { requestId: "e1" },
      ),
      "duplicate",
    );
    await refusedWith(
      desk().recordEnrollmentChange({ ...change, planId: "gym" }, { requestId: "e1" }),
      "not_found",
    );
    await refusedWith(
      desk().recordEnrollmentChange({ ...change, from: undefined }, { requestId: "e1" }),
      "unknown_sender",
    );
  });

  it("records any change inside open enrolment", async () => {
    const november = desk({ now: () => new Date("2026-11-16T16:00:00.000Z") });
    const recorded = await november.recordEnrollmentChange(change, { requestId: "e1" });
    expect(recorded.basis).toBe("open_enrollment");
  });

  it("asks a person for an exception, records exactly what they approved, and refuses one not needed", async () => {
    const payroll = desk();
    const input = { ...change, reason: "Missed the window while on leave" };
    const facts = await payroll.enrollmentExceptionFacts(input);
    expect(facts).toEqual({
      employeeId: "E-01",
      employee: "Ana Lopez",
      planId: "vision",
      planName: "Vision",
      action: "enroll",
      reason: "Missed the window while on leave",
    });
    await refusedWith(
      payroll.requestEnrollmentException(
        { ...input, approved: { ...facts, planId: "dental" } },
        { requestId: "x1" },
      ),
      "changed",
    );
    const recorded = await payroll.requestEnrollmentException(
      { ...input, approved: { ...facts } },
      { requestId: "x2" },
    );
    expect(recorded).toMatchObject({ basis: "exception", approvedVia: "enrollment_exception" });
    const november = desk({ now: () => new Date("2026-11-16T16:00:00.000Z") });
    await refusedWith(november.enrollmentExceptionFacts(input), "not_needed");
  });
});

describe("demonstration data", () => {
  it("matches the company's crews and headcount", () => {
    const crews = new Map(company.crews.map((entry) => [entry.id, entry.members]));
    const counted = new Map<string, number>();
    for (const employee of demoEmployees()) {
      counted.set(employee.crewId ?? "", (counted.get(employee.crewId ?? "") ?? 0) + 1);
    }
    expect(counted).toEqual(crews);
  });
});
