/**
 * One block per tool, against `fakePayrollDesk` and the company facts generated into this package,
 * through the registrations the factory builds and with the durable call identity Pi Durable hands to
 * `execute`. No network, no model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { APPROVED_FACTS_ARG, APPROVED_VALUE_ARG, money, type VerifiedSender } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import {
  loadCompanyFacts,
  payOwner,
  payrollApprover,
  personLabel,
  timesheetApprover,
} from "./company.js";
import { DEMO_NOW, type DeskRefusal, fakePayrollDesk, type PayrollDesk } from "./desk.js";
import { HINTS, type PayrollToolset, payrollTools, SPECIAL_ENROLLMENT_DAYS } from "./tools.js";

const company = loadCompanyFacts();
const NOW = new Date(DEMO_NOW);

const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;

const OFFICE: VerifiedSender = {
  origin: "internal",
  channel: "chat",
  contact: payrollApprover(company)?.id ?? "",
};
const DIEGO: VerifiedSender = {
  origin: "external",
  channel: "email",
  contact: "diego.ramirez@crew.example",
};
const ANA: VerifiedSender = {
  origin: "external",
  channel: "chat",
  contact: "ana.lopez@crew.example",
};

/** The tools, asked by `sender` (`null`: a host that knows nobody), with the role's limits. */
const tools = (
  desk: PayrollDesk | undefined,
  sender: VerifiedSender | null = OFFICE,
  limits: () => Readonly<Record<string, number>> = () => ({ [SPECIAL_ENROLLMENT_DAYS]: 30 }),
): PayrollToolset =>
  payrollTools({ desk, company, limits, sender: async () => sender ?? undefined });

const desk = (): PayrollDesk => fakePayrollDesk({ company, now: () => NOW });

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

/** Every contact detail on the company record, which no tool may ever print. */
const CONTACTS = (company.people as unknown as { email: string; phone: string }[]).flatMap(
  (worker) => [worker.email, worker.phone],
);

const approverLabel = (crewId: string) => personLabel(timesheetApprover(company, crewId));

describe("refusal hints", () => {
  it("has a next step for every refusal code the desk can give", () => {
    const codes: DeskRefusal[] = [
      "not_found",
      "ambiguous",
      "invalid",
      "unknown_sender",
      "not_staff",
      "not_office",
      "someone_else",
      "not_closed",
      "timesheets_open",
      "nothing_open",
      "already_approved",
      "still_draft",
      "run_changed",
      "changed",
      "no_statement",
      "outside_window",
      "event_too_old",
      "plan_not_eligible",
      "duplicate",
      "not_needed",
    ];
    const hints = HINTS(company);
    for (const code of codes) expect(hints[code].trim().length, code).toBeGreaterThan(10);
    expect(Object.keys(hints).sort()).toEqual([...codes].sort());
    expect(hints.outside_window).toContain("request_enrollment_exception");
    expect(hints.timesheets_open).toContain("request_timesheet_approval");
    expect(hints.already_approved).toContain("request_pay_adjustment");
  });
});

describe("list_pay_periods and list_timesheets", () => {
  it("lists periods with pay days and run status", async () => {
    const result = await tools(desk()).listPayPeriods.execute({}, call("p"), BACKGROUND_CONTEXT);
    expect(text(result)).toContain(
      "2026-11-23 to 2026-12-06 — pay day 2026-12-11 — closed — pay run PR-2026-11-23 (draft)",
    );
    expect(text(result)).toContain(
      "2026-12-07 to 2026-12-20 — pay day 2026-12-25 — open — no pay run",
    );
  });

  // `payroll.run`'s completion check (officehum.json): the board runs list_pay_periods with only the
  // period the ticket names. The demonstration already holds a draft for that period, so only an
  // approved run shows the work was done.
  it("finds a named period's run only once a person has approved it", async () => {
    const payroll = desk();
    const toolset = tools(payroll);
    const check = { period: "2026-11-30" };
    const before = await toolset.listPayPeriods.execute(check, call("before"), BACKGROUND_CONTEXT);
    expect(details(before)).toMatchObject({
      found: false,
      periods: [{ start: "2026-11-23", run: { id: "PR-2026-11-23", status: "draft" } }],
    });
    expect(text(before)).toContain("2026-11-23 to 2026-12-06");
    expect(text(before)).not.toContain("2026-12-07 to");

    await toolset.preparePayRun.execute({ period: "2026-11-30" }, call("p"), BACKGROUND_CONTEXT);
    const prepared = await toolset.listPayPeriods.execute(check, call("draft"), BACKGROUND_CONTEXT);
    expect(details(prepared)).toMatchObject({ found: false });

    const facts = await toolset.payRunApprovalFacts({ runId: "PR-2026-11-23" }, {} as never, {
      conversationId: 1,
      taskId: 1,
    });
    await toolset.submitPayRun.execute(
      { runId: "PR-2026-11-23", [APPROVED_FACTS_ARG]: facts.facts },
      call("s"),
      BACKGROUND_CONTEXT,
    );
    const after = await toolset.listPayPeriods.execute(check, call("after"), BACKGROUND_CONTEXT);
    expect(details(after)).toMatchObject({
      found: true,
      periods: [{ start: "2026-11-23", run: { status: "approved" } }],
    });
  });

  it("refuses a period that is not a date", async () => {
    const result = await tools(desk()).listPayPeriods.execute(
      { period: "last week" },
      call("p"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result)).toMatchObject({ found: false, code: "invalid" });
  });

  it("lists hours per workweek to office staff and refuses a crew member", async () => {
    const result = await tools(desk()).listTimesheets.execute({}, call("t"), BACKGROUND_CONTEXT);
    expect(text(result)).toContain(
      "Diego Ramirez — approved — week of 2026-11-23: 44 h; week of 2026-11-30: 36 h — 4 h overtime authorised",
    );
    expect(text(result)).not.toMatch(/\$/);
    const refused = await tools(desk(), DIEGO).listTimesheets.execute(
      {},
      call("t"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(refused)).toBe(true);
    expect(details(refused).code).toBe("not_office");
    const nobody = await tools(desk(), null).listTimesheets.execute(
      {},
      call("t"),
      BACKGROUND_CONTEXT,
    );
    expect(details(nobody).code).toBe("unknown_sender");
  });
});

describe("prepare_pay_run", () => {
  it("speaks hours per employee and the run's total, never one person's pay", async () => {
    const result = await tools(desk()).preparePayRun.execute({}, call("p"), BACKGROUND_CONTEXT);
    const said = text(result);
    expect(said).toContain(
      "Prepared draft pay run PR-2026-11-23 for 2026-11-23 to 2026-12-06, pay day 2026-12-11",
    );
    expect(said).toContain(
      "Diego Ramirez — 76 h regular, 4 h overtime (week of 2026-11-23: 44 h; week of 2026-11-30: 36 h)",
    );
    expect(said).toContain(
      `Overtime worked without authorisation, paid in full and noted for the person who approves the timesheet: Farid Haddad, 6 h in the week of 2026-11-30 (noted for ${approverLabel("cleaning-central")})`,
    );
    expect(said).toContain("Overtime is counted one workweek at a time");
    expect(said).toContain(`Gross total ${money(details(result).grossCents as number)}`);
    // No one person's gross.
    expect(said).not.toContain(money(76 * 2100 + 4 * 3150));
    expect(said).not.toContain(money(80 * 2100 + 6 * 3150));
    expect(said).toContain("submit_pay_run");
    expect(details(result)).not.toHaveProperty("lines");
  });

  it("refuses while timesheets are open and names the next step", async () => {
    const open = fakePayrollDesk({
      company,
      now: () => NOW,
      runs: [],
      timesheets: [],
    });
    const result = await tools(open).preparePayRun.execute({}, call("p"), BACKGROUND_CONTEXT);
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("timesheets_open");
    expect(text(result)).toContain("Ana Lopez (missing)");
    expect(text(result)).toContain("request_timesheet_approval");
  });

  it("nudges the approvers of open timesheets", async () => {
    const open = fakePayrollDesk({ company, now: () => NOW, runs: [], timesheets: [] });
    const result = await tools(open).requestTimesheetApproval.execute(
      {},
      call("n"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Asked the people who approve timesheets (NUDGE-1)");
    expect(text(result)).toContain(`Ana Lopez (missing) — ${approverLabel("cleaning-north")}`);
  });

  it("flags a timesheet for its approver", async () => {
    const result = await tools(desk()).flagTimesheet.execute(
      { employee: "Farid Haddad", reason: "Saturday looks high" },
      call("f"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(
      `Flagged FLAG-1 on Farid Haddad's timesheet for 2026-11-23 for ${approverLabel("cleaning-central")}`,
    );
  });
});

describe("submit_pay_run", () => {
  it("refuses with no approved facts and leaves the draft a draft", async () => {
    const payroll = desk();
    const result = await tools(payroll).submitPayRun.execute(
      { runId: "PR-2026-11-23" },
      call("s"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("not_approved");
    const periods = await payroll.listPayPeriods();
    expect(periods.find((period) => period.start === "2026-11-23")?.run?.status).toBe("draft");
  });

  it("shows the person the run's totals and approves exactly them", async () => {
    const payroll = desk();
    const toolset = tools(payroll);
    const facts = await toolset.payRunApprovalFacts({ runId: "PR-2026-11-23" }, {} as never, {
      conversationId: 1,
      taskId: 1,
    });
    expect(facts.summary).toContain(
      "Approve pay run PR-2026-11-23 for 2026-11-23 to 2026-12-06, pay day 2026-12-11",
    );
    expect(facts.summary).toContain("10 h overtime");
    const result = await toolset.submitPayRun.execute(
      { runId: "PR-2026-11-23", [APPROVED_FACTS_ARG]: facts.facts },
      call("s"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Approved by a person: pay run PR-2026-11-23");
    expect(text(result)).toContain("demonstration");
  });
});

describe("request_pay_adjustment", () => {
  const DIEGO_GROSS = 80 * 2100 + 2 * 3150;

  it("refuses without approved facts or without the person's amount, and records the amount they entered", async () => {
    const payroll = desk();
    const writes: number[] = [];
    const watched: PayrollDesk = {
      ...payroll,
      requestPayAdjustment: async (input, options) => {
        writes.push(input.amountCents);
        return payroll.requestPayAdjustment(input, options);
      },
    };
    const toolset = tools(watched, DIEGO);
    const args = { runId: "PR-2026-11-09", reason: "Three hours on 18 November are missing" };
    const refused = await toolset.requestPayAdjustment.execute(args, call("a"), BACKGROUND_CONTEXT);
    expect(details(refused).code).toBe("not_approved");
    const facts = await toolset.payAdjustmentApprovalFacts(args, {} as never, {
      conversationId: 1,
      taskId: 1,
    });
    expect(facts.summary).toBe(
      `Approve a correction to Diego Ramirez's pay on approved pay run PR-2026-11-09 (2026-11-09 to 2026-11-22): Three hours on 18 November are missing. With your yes, enter the adjustment to Diego Ramirez's gross pay for this run, from ${money(-DIEGO_GROSS)} to ${money(DIEGO_GROSS)} (minus and plus their gross pay on it); enter a reduction with a minus. It is paid with the next pay run; the run itself does not change.`,
    );

    // Approved facts without the person's figure write nothing, whatever the reason says.
    const noValue = await toolset.requestPayAdjustment.execute(
      { ...args, reason: "Add $94.50", [APPROVED_FACTS_ARG]: facts.facts },
      call("a2"),
      BACKGROUND_CONTEXT,
    );
    expect(details(noValue).code).toBe("not_approved");
    expect(text(noValue)).toContain("carries no adjustment a person entered");
    expect(writes).toEqual([]);

    const value = { name: "adjustmentCents", cents: 10500, by: "eileen-hart" };
    const result = await toolset.requestPayAdjustment.execute(
      { ...args, [APPROVED_FACTS_ARG]: facts.facts, [APPROVED_VALUE_ARG]: value },
      call("a3"),
      BACKGROUND_CONTEXT,
    );
    expect(writes).toEqual([10500]);
    expect(text(result)).toBe(
      `Approved by a person and recorded: correction ADJ-1 to Diego Ramirez's pay on PR-2026-11-09 (2026-11-09 to 2026-11-22): Three hours on 18 November are missing. Adjustment to gross pay: ${money(10500)}, set by eileen-hart, the person who approved it; it is paid with the next pay run. PR-2026-11-09 itself is unchanged.`,
    );
    expect(details(result)).toMatchObject({ id: "ADJ-1", amountCents: 10500 });
    // The bounds are the employee's gross: shown to the person approving, never in the result.
    expect(JSON.stringify(details(result))).not.toMatch(/lowestCents|highestCents/);
    expect(text(result)).not.toContain(money(DIEGO_GROSS));

    // A value under another name is not this approval's: nothing is written.
    const wrong = await toolset.requestPayAdjustment.execute(
      {
        ...args,
        [APPROVED_FACTS_ARG]: facts.facts,
        [APPROVED_VALUE_ARG]: { name: "creditCents", cents: 100, by: null },
      },
      call("a4"),
      BACKGROUND_CONTEXT,
    );
    expect(details(wrong).code).toBe("not_approved");
    expect(writes).toEqual([10500]);
  });

  it("records a reduction, and refuses an approved zero", async () => {
    const toolset = tools(desk(), DIEGO);
    const args = { runId: "PR-2026-11-09", reason: "Overtime paid for hours not worked" };
    const facts = await toolset.payAdjustmentApprovalFacts(args, {} as never, {
      conversationId: 1,
      taskId: 1,
    });
    const reduced = await toolset.requestPayAdjustment.execute(
      {
        ...args,
        [APPROVED_FACTS_ARG]: facts.facts,
        [APPROVED_VALUE_ARG]: { name: "adjustmentCents", cents: -3150, by: null },
      },
      call("r1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(reduced)).toContain(
      `Adjustment to gross pay: ${money(-3150)}, set by the person who approved it`,
    );
    const zero = await toolset.requestPayAdjustment.execute(
      {
        ...args,
        [APPROVED_FACTS_ARG]: facts.facts,
        [APPROVED_VALUE_ARG]: { name: "adjustmentCents", cents: 0, by: "eileen-hart" },
      },
      call("r2"),
      BACKGROUND_CONTEXT,
    );
    expect(details(zero).code).toBe("invalid");
    expect(text(zero)).toContain("An adjustment of zero changes no pay");
  });

  it("tells office staff a colleague's correction is recorded without its amount or bounds", async () => {
    const toolset = tools(desk(), OFFICE);
    const args = {
      runId: "PR-2026-11-09",
      employee: "Diego Ramirez",
      reason: "Three hours on 18 November are missing",
    };
    const facts = await toolset.payAdjustmentApprovalFacts(args, {} as never, {
      conversationId: 1,
      taskId: 1,
    });
    expect(facts.facts).toMatchObject({ lowestCents: -DIEGO_GROSS, highestCents: DIEGO_GROSS });
    const result = await toolset.requestPayAdjustment.execute(
      {
        ...args,
        [APPROVED_FACTS_ARG]: facts.facts,
        [APPROVED_VALUE_ARG]: { name: "adjustmentCents", cents: 10500, by: "eileen-hart" },
      },
      call("o1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Approved by a person and recorded: correction ADJ-1");
    expect(text(result)).toContain("is Diego Ramirez's pay, so it is not given here");
    expect(text(result)).not.toContain(money(10500));
    expect(text(result)).not.toContain(money(DIEGO_GROSS));
    expect(JSON.stringify(details(result))).not.toMatch(/cents/i);
  });

  it("asks nobody about a crew member's correction for a colleague", async () => {
    await expect(
      tools(desk(), ANA).payAdjustmentApprovalFacts(
        { runId: "PR-2026-11-09", employee: "Diego Ramirez", reason: "x" },
        {} as never,
        { conversationId: 1, taskId: 1 },
      ),
    ).rejects.toThrow("may ask only about their own pay");
  });
});

describe("get_pay_statement", () => {
  it("gives the sender their own statement, worked out by the desk", async () => {
    const result = await tools(desk(), DIEGO).getPayStatement.execute(
      {},
      call("g"),
      BACKGROUND_CONTEXT,
    );
    const said = text(result);
    expect(said).toContain("Pay statement for Diego Ramirez (the sender), pay run PR-2026-11-09");
    expect(said).toContain(`gross ${money(80 * 2100 + 2 * 3150)}`);
    expect(said).toContain("80 h regular and 2 h overtime");
    expect(said).toContain("tax withholding and net pay are not shown here");
  });

  it("gives nothing to an unknown sender", async () => {
    const result = await tools(desk(), null).getPayStatement.execute(
      {},
      call("g"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).code).toBe("unknown_sender");
    expect(text(result)).toContain("Nothing was shared");
  });
});

describe("benefits", () => {
  it("gives the sender their own plans and the window", async () => {
    const result = await tools(desk(), DIEGO).getBenefitsSummary.execute(
      {},
      call("b"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Benefits for Diego Ramirez (the sender)");
    expect(text(result)).toContain("Open enrolment: 2026-11-01 to 2026-11-30 (closed today)");
    expect(text(result)).toContain("30 days after a qualifying life event");
  });

  it("reads the special enrolment period from the role's limits at every call", async () => {
    let days = 30;
    const toolset = tools(desk(), ANA, () => ({ [SPECIAL_ENROLLMENT_DAYS]: days }));
    const args = {
      planId: "vision",
      action: "enroll",
      lifeEventKind: "birth",
      lifeEventDate: "2026-10-20",
    };
    const refused = await toolset.recordEnrollmentChange.execute(
      args,
      call("e1"),
      BACKGROUND_CONTEXT,
    );
    expect(details(refused).code).toBe("event_too_old");
    expect(text(refused)).toContain("request_enrollment_exception");
    days = 60;
    const recorded = await toolset.recordEnrollmentChange.execute(
      args,
      call("e2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(recorded)).toBe(false);
    expect(text(recorded)).toContain(
      "Recorded ENR-1: Ana Lopez enrolled in Vision after a birth on 2026-10-20",
    );
  });

  it("refuses a change outside open enrolment with no life event, pointing to the exception", async () => {
    const result = await tools(desk(), ANA).recordEnrollmentChange.execute(
      { planId: "vision", action: "enroll" },
      call("e"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).code).toBe("outside_window");
    expect(text(result)).toContain("request_enrollment_exception");
  });

  it("refuses an exception with no approved facts, and records one a person approved", async () => {
    const toolset = tools(desk(), ANA);
    const args = { planId: "vision", action: "enroll", reason: "Missed the window while on leave" };
    const refused = await toolset.requestEnrollmentException.execute(
      args,
      call("x"),
      BACKGROUND_CONTEXT,
    );
    expect(details(refused).code).toBe("not_approved");
    const facts = await toolset.enrollmentExceptionFacts(args, {} as never, {
      conversationId: 1,
      taskId: 1,
    });
    expect(facts.summary).toBe(
      "Approve enrolling Ana Lopez in Vision outside open enrolment, with no qualifying life event: Missed the window while on leave",
    );
    const result = await toolset.requestEnrollmentException.execute(
      { ...args, [APPROVED_FACTS_ARG]: facts.facts },
      call("x2"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Approved by a person and recorded ENR-1");
  });
});

describe("read_company", () => {
  it("states the payroll policy with every person from the record and no contact", async () => {
    const result = await tools(desk()).readCompany.execute(
      { section: "payroll" },
      call("r"),
      BACKGROUND_CONTEXT,
    );
    const said = text(result);
    expect(said).toContain("every two weeks");
    expect(said).toContain(
      `Hours over ${company.payroll.overtimeAfterWeeklyHours} in one workweek`,
    );
    expect(said).toContain(personLabel(payrollApprover(company)));
    expect(said).toContain(personLabel(payOwner(company)));
    for (const contact of CONTACTS) expect(said).not.toContain(contact);
  });
});

describe("privacy", () => {
  it("no tool prints a contact, a tax id or a bank detail", async () => {
    const payroll = desk();
    const office = tools(payroll);
    const own = tools(payroll, DIEGO);
    const outputs = [
      await office.listTimesheets.execute({}, call("1"), BACKGROUND_CONTEXT),
      await office.preparePayRun.execute({}, call("2"), BACKGROUND_CONTEXT),
      await own.getPayStatement.execute({}, call("3"), BACKGROUND_CONTEXT),
      await own.getBenefitsSummary.execute({}, call("4"), BACKGROUND_CONTEXT),
    ].map(text);
    for (const said of outputs) {
      for (const contact of CONTACTS) expect(said).not.toContain(contact);
      expect(said).not.toMatch(/crew\.example|social security|routing number|account number/i);
    }
  });
});
