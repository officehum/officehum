/**
 * One block per tool, against `fakePeopleOpsDesk` and the company facts generated into this package,
 * through the registrations the factory builds and with the durable call identity Pi Durable hands to
 * `execute`. No network, no model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { APPROVED_FACTS_ARG, type VerifiedSender } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { companyHead, loadCompanyFacts, peopleOwner, person, personLabel } from "./company.js";
import { type DeskRefusal, demoEmployees, fakePeopleOpsDesk, type PeopleOpsDesk } from "./desk.js";
import { HINTS, type PeopleOpsToolset, peopleOpsTools } from "./tools.js";

const company = loadCompanyFacts();
const staff = company.staffPolicies;
const decider = personLabel(peopleOwner(company));
const NOW = new Date("2026-11-09T15:00:00.000Z");

const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;

/** The People Ops owner, asking from inside the office: may file time off for anyone on staff. */
const OWNER: VerifiedSender = {
  origin: "internal",
  channel: "chat",
  contact: peopleOwner(company)?.id ?? "",
};

/** The tools, asked by `sender`; `null` is a host that knows nobody. */
const tools = (
  desk: PeopleOpsDesk | undefined,
  sender: VerifiedSender | null = OWNER,
): PeopleOpsToolset => peopleOpsTools({ desk, company, sender: async () => sender ?? undefined });

const desk = (): PeopleOpsDesk => fakePeopleOpsDesk({ company, now: () => NOW });

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

describe("refusal hints", () => {
  it("has a next step for every refusal code the desk can give", () => {
    const codes: DeskRefusal[] = [
      "not_found",
      "ambiguous",
      "invalid",
      "needs_person",
      "decided",
      "not_hired",
      "exists",
      "late_notice",
      "not_late",
      "notice_changed",
      "protected",
      "duplicate",
      "no_one_left",
      "unknown_sender",
      "not_staff",
      "someone_else",
      "exception_changed",
    ];
    const hints = HINTS(company);
    for (const code of codes) expect(hints[code].trim().length, code).toBeGreaterThan(10);
    expect(Object.keys(hints).sort()).toEqual([...codes].sort());
  });
});

describe("list_candidates", () => {
  it("lists the pipeline by stage and opening, with no contact details", async () => {
    const result = await tools(desk()).listCandidates.execute({}, call("c1"), BACKGROUND_CONTEXT);
    expect(text(result)).toContain(
      "CAND-203 — Aisha Bello — Maintenance technician — final_review",
    );
    expect(text(result)).not.toMatch(/@|\+\d/);
    expect(text(result)).not.toContain("update_candidate_stage");
    expect(details(result).found).toBe(true);
    const none = await tools(desk()).listCandidates.execute(
      { candidateId: "CAND-999" },
      call("c2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(none)).toBe(true);
    expect(details(none).found).toBe(false);
  });
});

describe("update_candidate_stage", () => {
  it("moves a candidate between review stages, once however often the call is replayed", async () => {
    const people = desk();
    const toolset = tools(people);
    const args = { candidateId: "CAND-202", stage: "interview" };
    const first = await toolset.updateCandidateStage.execute(args, call("s1"), BACKGROUND_CONTEXT);
    expect(text(first)).toContain("Moved Victor Lindqvist (CAND-202");
    expect(text(first)).toContain("from screening to interview");
    const again = await toolset.updateCandidateStage.execute(args, call("s1"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    // A second call under a new identity finds the candidate already there: one move, not two.
    const other = await toolset.updateCandidateStage.execute(args, call("s2"), BACKGROUND_CONTEXT);
    expect(isError(other)).toBe(true);
  });

  it("refuses hired and rejected, names who decides, and says not to try again", async () => {
    const people = desk();
    const result = await tools(people).updateCandidateStage.execute(
      { candidateId: "CAND-203", stage: "hired" },
      call("s3"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result)).toMatchObject({ code: "needs_person" });
    expect(text(result)).toContain(decider);
    expect(text(result)).toContain("do not call update_candidate_stage for it again");
    expect((await people.listCandidates({ candidateId: "CAND-203" }))[0]?.stage).toBe(
      "final_review",
    );
  });
});

describe("onboarding_checklist", () => {
  it("creates the checklist for a hire, once however often the call is replayed", async () => {
    const toolset = tools(desk());
    const first = await toolset.onboardingChecklist.execute(
      { candidateId: "CAND-204" },
      call("o1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(first)).toContain("Created onboarding checklist OB-1 for Tomasz Nowak");
    expect(text(first)).toContain("2026-11-23");
    expect(text(first)).toContain("nothing has been sent");
    const again = await toolset.onboardingChecklist.execute(
      { candidateId: "CAND-204" },
      call("o1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(again)).toBe(text(first));
    const second = await toolset.onboardingChecklist.execute(
      { candidateId: "CAND-204" },
      call("o2"),
      BACKGROUND_CONTEXT,
    );
    expect(details(second)).toMatchObject({ code: "exists" });
  });

  it("refuses a candidate nobody has hired, and names who hires", async () => {
    const result = await tools(desk()).onboardingChecklist.execute(
      { candidateId: "CAND-203" },
      call("o3"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result)).toMatchObject({ code: "not_hired" });
    expect(text(result)).toContain(decider);
  });
});

describe("record_time_off_request", () => {
  const late = {
    employee: "Ana Lopez",
    startDate: "2026-11-20",
    endDate: "2026-11-20",
    reasonCategory: "vacation",
  };

  it("records a request as pending, never approved, and names who decides", async () => {
    const people = desk();
    const toolset = tools(people);
    const args = { ...late, startDate: "2026-12-21", endDate: "2026-12-23" };
    const first = await toolset.recordTimeOffRequest.execute(args, call("t1"), BACKGROUND_CONTEXT);
    expect(text(first)).toContain("Recorded TO-104");
    expect(text(first)).toContain("pending");
    expect(text(first)).toContain("not approved");
    expect(text(first)).toContain(decider);
    expect(details(first)).toMatchObject({ status: "pending", days: 3 });
    // Replayed: the same receipt, and the next request is TO-105, not TO-106.
    const again = await toolset.recordTimeOffRequest.execute(args, call("t1"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    const next = await toolset.recordTimeOffRequest.execute(
      { ...args, startDate: "2027-01-04", endDate: "2027-01-04" },
      call("t2"),
      BACKGROUND_CONTEXT,
    );
    expect(text(next)).toContain("TO-105");
  });

  it("refuses short notice with the notice figure and the approval path, and records nothing", async () => {
    const people = desk();
    const result = await tools(people).recordTimeOffRequest.execute(
      late,
      call("t3"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result)).toMatchObject({ code: "late_notice", daysNotice: 11 });
    expect(text(result)).toContain("request_time_off_exception");
    expect(text(result)).toContain("daysNotice 11");
    // A vacation is not a reason the law may protect: the protected route is not offered.
    expect(text(result)).not.toContain("may be protected");
  });

  it("points a vague reason refused for notice to the protected route, from the reason field alone", async () => {
    const result = await tools(desk()).recordTimeOffRequest.execute(
      { ...late, reasonCategory: "personal" },
      call("t4"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result)).toMatchObject({ code: "late_notice", mayBeProtected: true });
    expect(text(result)).toContain("may be protected");
    expect(text(result)).toContain("record_time_off_request again");
  });

  it("records short-notice medical leave as pending for the person the company names, never refused", async () => {
    const result = await tools(desk()).recordTimeOffRequest.execute(
      {
        employee: "Chloe Nguyen",
        startDate: "2026-11-17",
        endDate: "2026-11-30",
        reasonCategory: "medical",
      },
      call("t5"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(details(result)).toMatchObject({ status: "pending", protected: true, daysNotice: 8 });
    expect(text(result)).toContain(personLabel(person(company, staff.protectedLeaveTo)));
    expect(text(result)).toContain("never refused for short notice");
    expect(text(result)).toContain("Do not ask for medical details");
    // A record, not a send: the receipt claims no hand-off.
    expect(text(result)).not.toContain("went to");
    expect(text(result)).toContain("nothing has been sent to anyone");
  });
});

describe("request_time_off_exception", () => {
  it("records the time off a person approved, as approved by them; a replay records it once", async () => {
    const people = desk();
    const toolset = tools(people);
    const args = {
      employee: "Ana Lopez",
      startDate: "2026-11-20",
      endDate: "2026-11-20",
      reasonCategory: "vacation",
      daysNotice: 11,
      why: "Concert tickets out of town",
    };
    // What the approval gate hands the tool after a yes: the arguments and the desk-read facts.
    const read = await toolset.exceptionFacts(args, BACKGROUND_CONTEXT as never, call("x0"));
    expect(read.summary).toBe(
      "Approve time off for Ana Lopez, 2026-11-20 to 2026-11-20 (1 day), vacation, with 11 days' notice where the company asks for 14",
    );
    const approved = { ...args, [APPROVED_FACTS_ARG]: read.facts };
    const first = await toolset.requestTimeOffException.execute(
      approved,
      call("x1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(first)).toContain("Approved by a person");
    expect(details(first)).toMatchObject({ status: "approved", approvedVia: "time_off_exception" });
    // Replayed, and replayed again from freshly built tools over the same desk (a restart).
    const again = await toolset.requestTimeOffException.execute(
      approved,
      call("x1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(again)).toBe(text(first));
    const restarted = await tools(people).requestTimeOffException.execute(
      approved,
      call("x1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(restarted)).toBe(text(first));
    const twice = await toolset.requestTimeOffException.execute(
      approved,
      call("x2"),
      BACKGROUND_CONTEXT,
    );
    expect(details(twice)).toMatchObject({ code: "duplicate" });
    // Without facts a person approved, nothing is recorded.
    const unapproved = await tools(desk()).requestTimeOffException.execute(
      args,
      call("x9"),
      BACKGROUND_CONTEXT,
    );
    expect(details(unapproved).code).toBe("not_approved");
  });

  it("refuses a notice figure that is not the desk's, giving the right one", async () => {
    const args = {
      employee: "Ana Lopez",
      startDate: "2026-11-20",
      endDate: "2026-11-20",
      reasonCategory: "vacation",
      daysNotice: 14,
      why: "Concert",
    };
    // Nobody is asked about a figure the desk would refuse.
    await expect(
      tools(desk()).exceptionFacts(args, BACKGROUND_CONTEXT as never, call("x4")),
    ).rejects.toThrow("gives 11 days' notice, not 14");
    const result = await tools(desk()).requestTimeOffException.execute(
      { ...args, [APPROVED_FACTS_ARG]: {} },
      call("x3"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result)).toMatchObject({ code: "notice_changed", daysNotice: 11 });
    expect(text(result)).toContain("daysNotice 11");
  });
});

describe("list_availability", () => {
  it("gives availability only: no reasons, no contact details, no pending requests", async () => {
    const result = await tools(desk()).listAvailability.execute(
      { weekOf: "2026-11-12" },
      call("a1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Jamal Brooks — not available 2026-11-12");
    expect(text(result)).toContain("Ana Lopez — available all week");
    expect(text(result)).not.toMatch(/vacation|personal|medical|reason:|@|\+\d/i);
    expect(details(result).found).toBe(true);
  });
});

describe("refer_to_person", () => {
  it("hands pay to the person the company names, once however often the call is replayed", async () => {
    const toolset = tools(desk());
    const args = { topic: "pay", summary: "Paycheck short by six hours." };
    const first = await toolset.referToPerson.execute(args, call("r1"), BACKGROUND_CONTEXT);
    expect(text(first)).toContain("Handed REF-1 (pay)");
    expect(text(first)).toContain(personLabel(person(company, staff.payQuestionsTo)));
    expect(text(first)).toContain("nothing is decided");
    const again = await toolset.referToPerson.execute(args, call("r1"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    const next = await toolset.referToPerson.execute(args, call("r2"), BACKGROUND_CONTEXT);
    expect(text(next)).toContain("REF-2");
  });

  it("sends a complaint about the usual owner to someone else, and says not to name them as its holder", async () => {
    const owner = person(company, staff.employeeRelationsTo);
    const result = await tools(desk()).referToPerson.execute(
      { topic: "employee_relations", summary: "Comments about appearance.", about: owner?.name },
      call("r3"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(personLabel(companyHead(company)));
    expect(details(result)).toMatchObject({ rerouted: true });
    expect(text(result)).toContain("never say it is with anyone it names");
  });

  it("gives a next step when no one is left to take it", async () => {
    const result = await tools(desk()).referToPerson.execute(
      {
        topic: "employee_relations",
        summary: "Both.",
        about: `${person(company, staff.employeeRelationsTo)?.name} and ${companyHead(company)?.name}`,
      },
      call("r4"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result)).toMatchObject({ code: "no_one_left" });
    expect(text(result)).toContain("manager they trust");
  });
});

describe("refer_to_person description", () => {
  it("tells the model to resolve a job description to a name from read_company", () => {
    const parameters = JSON.stringify(tools(desk()).referToPerson.parameters);
    expect(parameters).toContain("read_company");
    expect(parameters).toContain("my supervisor");
  });
});

describe("read_company", () => {
  it("gives people with their titles and what each decides, and no contact details in any section", async () => {
    const toolset = tools(desk());
    const sections = [
      "profile",
      "hours",
      "people",
      "crews",
      "staff",
      "tone",
      "escalation",
      "glossary",
    ];
    for (const section of sections) {
      const result = await toolset.readCompany.execute(
        { section },
        call(section),
        BACKGROUND_CONTEXT,
      );
      for (const contact of CONTACTS) expect(text(result), section).not.toContain(contact);
    }
    const staffText = text(
      await toolset.readCompany.execute({ section: "staff" }, call("s"), BACKGROUND_CONTEXT),
    );
    expect(staffText).toContain(`${staff.timeOffNoticeDays} days`);
    expect(staffText).toContain(personLabel(person(company, staff.disciplineTo)));
  });
});

describe("get_leave_balance", () => {
  const jamal = demoEmployees().find((employee) => employee.name === "Jamal Brooks");
  const JAMAL: VerifiedSender = {
    origin: "external",
    channel: "sms",
    contact: jamal?.contact ?? "",
  };

  it("get_leave_balance returns the sender's own balance from code", async () => {
    const result = await tools(desk(), JAMAL).getLeaveBalance.execute(
      {},
      call("lb1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toBe(
      "Leave for Jamal Brooks (the sender) in 2026, in business days (Monday to Friday): allowance 15; approved and taken or booked 1; 14 left. Approved: TO-101, 2026-11-12 to 2026-11-12 (1 business day this year). Worked out by the desk; this is the sender's own balance only.",
    );
    expect(details(result)).toMatchObject({ remainingDays: 14, takenDays: 1 });
    expect(JSON.stringify(details(result))).not.toContain("@");
    // It takes no employee: there is nothing to name another person with.
    const schema = tools(desk()).getLeaveBalance.parameters as unknown as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).toEqual([]);
  });

  it("get_leave_balance refuses an unknown sender", async () => {
    const nobody = await tools(desk(), null).getLeaveBalance.execute(
      {},
      call("lb2"),
      BACKGROUND_CONTEXT,
    );
    expect(details(nobody).code).toBe("unknown_sender");
    expect(text(nobody)).toContain("tell them nothing was recorded or shared");
    const client = await tools(desk(), {
      origin: "external",
      channel: "email",
      contact: "ravi@gatewayaccounting.example",
    }).getLeaveBalance.execute({}, call("lb3"), BACKGROUND_CONTEXT);
    expect(details(client).code).toBe("not_staff");
    expect(text(client)).toContain("for staff only");
  });

  it("a staff sender cannot file time off for someone else, and records their own without a name", async () => {
    const ANA: VerifiedSender = {
      origin: "external",
      channel: "email",
      contact: "ana.lopez@crew.example",
    };
    const toolset = tools(desk(), ANA);
    const request = { startDate: "2026-12-21", endDate: "2026-12-21", reasonCategory: "vacation" };
    const other = await toolset.recordTimeOffRequest.execute(
      { ...request, employee: "Ben Carter" },
      call("se1"),
      BACKGROUND_CONTEXT,
    );
    expect(details(other)).toMatchObject({ code: "someone_else", employee: "Ben Carter" });
    expect(text(other)).toContain("record nothing under the sender's name instead");
    const own = await toolset.recordTimeOffRequest.execute(
      request,
      call("se2"),
      BACKGROUND_CONTEXT,
    );
    expect(details(own)).toMatchObject({ employeeName: "Ana Lopez", status: "pending" });
  });
});

describe("no desk", () => {
  it("refuses rather than pretending", async () => {
    await expect(
      tools(undefined).listCandidates.execute({}, call("n"), BACKGROUND_CONTEXT),
    ).rejects.toThrow("No people desk is configured");
  });
});

describe("no contact details anywhere", () => {
  it("prints none of the company's contact details from any tool", async () => {
    const toolset = tools(desk());
    const crewContacts = demoEmployees().map((employee) => employee.contact);
    const outputs = [
      await toolset.listCandidates.execute({}, call("1"), BACKGROUND_CONTEXT),
      await toolset.listAvailability.execute({}, call("2"), BACKGROUND_CONTEXT),
      await toolset.onboardingChecklist.execute(
        { candidateId: "CAND-204" },
        call("3"),
        BACKGROUND_CONTEXT,
      ),
      await toolset.referToPerson.execute(
        { topic: "pay", summary: "x" },
        call("4"),
        BACKGROUND_CONTEXT,
      ),
      await toolset.recordTimeOffRequest.execute(
        {
          employee: "Noah Kim",
          startDate: "2026-12-21",
          endDate: "2026-12-21",
          reasonCategory: "vacation",
        },
        call("5"),
        BACKGROUND_CONTEXT,
      ),
    ];
    outputs.push(await toolset.getLeaveBalance.execute({}, call("6"), BACKGROUND_CONTEXT));
    for (const output of outputs) {
      const all = `${text(output)}\n${JSON.stringify(details(output))}`;
      for (const contact of [...CONTACTS, ...crewContacts]) expect(all).not.toContain(contact);
    }
  });
});
