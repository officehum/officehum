/**
 * The desk's rules, against `fakePeopleOpsDesk` and the company facts generated into this package: the
 * pipeline stages a person decides, onboarding only for a hire, the notice rule and the protected
 * route it never refuses, availability with nothing personal in it, a complaint kept away from the
 * people it names, and a replayed write that happens once.
 */

import type { VerifiedSender } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import {
  type CompanyFacts,
  companyHead,
  escalationOwner,
  loadCompanyFacts,
  peopleOwner,
  person,
} from "./company.js";
import {
  demoCandidates,
  demoEmployees,
  demoTimeOff,
  fakePeopleOpsDesk,
  type PeopleOpsDesk,
  PeopleOpsDeskError,
  PROTECTED_REASONS,
} from "./desk.js";

const company = loadCompanyFacts();
const staff = company.staffPolicies;
const NOW = new Date("2026-11-09T15:00:00.000Z");

/** The People Ops owner, asking from inside the office: may file time off for anyone on staff. */
const OWNER: VerifiedSender = {
  origin: "internal",
  channel: "chat",
  contact: peopleOwner(company)?.id ?? "",
};
/** The People Ops owner's own address on the company record, which this role's types leave out. */
const OWNER_EMAIL = (peopleOwner(company) as unknown as { readonly email: string }).email;
/** A crew member writing in from the address the desk holds for her. */
const ANA: VerifiedSender = {
  origin: "external",
  channel: "email",
  contact: "ana.lopez@crew.example",
};

/**
 * The demonstration desk, with every time-off write filed by the People Ops owner unless a test says
 * who sent it: who may file for whom has its own tests below.
 */
const desk = (facts: CompanyFacts = company): PeopleOpsDesk => {
  const people = fakePeopleOpsDesk({ company: facts, now: () => NOW });
  return {
    ...people,
    recordTimeOffRequest: (input, options) =>
      people.recordTimeOffRequest({ from: OWNER, ...input }, options),
    // An exception is recorded only with the facts a person approved: here, the desk's own.
    requestTimeOffException: async (input, options) => {
      const full = { from: OWNER, ...input };
      const approved =
        (input as { approved?: Record<string, unknown> }).approved ??
        (await people.timeOffExceptionFacts(full).catch(() => ({})));
      return people.requestTimeOffException({ ...full, approved }, options);
    },
  };
};

/** The refusal a desk call ends in, so a test can read its code. */
async function refusal(promise: Promise<unknown>): Promise<PeopleOpsDeskError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PeopleOpsDeskError) return error;
    throw error;
  }
  throw new Error("expected the desk to refuse");
}

describe("demonstration data", () => {
  it("has one employee per crew place the company counts, and none of them on the company record", () => {
    for (const crew of company.crews) {
      const members = demoEmployees().filter((employee) => employee.crewId === crew.id);
      expect(members, crew.id).toHaveLength(crew.members);
    }
    const names = new Set(company.people.map((worker) => worker.name));
    for (const employee of demoEmployees()) expect(names.has(employee.name)).toBe(false);
  });

  it("carries no contact or personal details beyond each staff member's own contact", () => {
    const text = JSON.stringify([demoCandidates(), demoTimeOff()]);
    expect(text).not.toMatch(/@|\+\d|\d{3}[ -]\d{4}|\baddress\b|\bemail\b|\bsalary\b|\bwage\b/i);
    // Each crew member has one contact, so the host's verified sender can be matched to them.
    const contacts = demoEmployees().map((employee) => employee.contact);
    expect(new Set(contacts).size).toBe(demoEmployees().length);
    for (const employee of demoEmployees()) {
      expect(employee.contact, employee.name).toMatch(/^[a-z.]+@crew\.example$/);
      const { contact: _contact, ...rest } = employee;
      expect(JSON.stringify(rest)).not.toMatch(/@|\+\d/);
    }
  });

  it("keeps its time off on its own employees, and its hired candidate with a start date", () => {
    const ids = new Set(demoEmployees().map((employee) => employee.id));
    for (const entry of demoTimeOff()) expect(ids.has(entry.employeeId), entry.id).toBe(true);
    const hired = demoCandidates().filter((candidate) => candidate.stage === "hired");
    expect(hired.length).toBeGreaterThan(0);
    for (const candidate of hired) expect(candidate.startDate).not.toBeNull();
  });
});

describe("candidates", () => {
  it("filters by opening, stage and id", async () => {
    const people = desk();
    expect((await people.listCandidates({ stage: "screening" })).map((c) => c.id)).toEqual([
      "CAND-202",
    ]);
    expect((await people.listCandidates({ candidateId: "cand-203" }))[0]?.name).toBe("Aisha Bello");
    expect((await people.listCandidates({ opening: "maintenance" })).length).toBe(2);
  });

  it("moves a candidate between review stages, once however often the call is replayed", async () => {
    const people = desk();
    const first = await people.updateCandidateStage(
      { candidateId: "CAND-202", stage: "interview" },
      { requestId: "stage-1" },
    );
    expect(first).toMatchObject({ candidateId: "CAND-202", from: "screening", to: "interview" });
    const again = await people.updateCandidateStage(
      { candidateId: "CAND-202", stage: "interview" },
      { requestId: "stage-1" },
    );
    expect(again).toEqual(first);
    expect((await people.listCandidates({ candidateId: "CAND-202" }))[0]?.stage).toBe("interview");
  });

  it("refuses hired and rejected: a person decides them, and the desk names who", async () => {
    for (const stage of ["hired", "rejected"]) {
      const people = desk();
      const error = await refusal(
        people.updateCandidateStage({ candidateId: "CAND-203", stage }, { requestId: stage }),
      );
      expect(error.code).toBe("needs_person");
      expect(error.message).toContain("Nothing was changed");
      expect((await people.listCandidates({ candidateId: "CAND-203" }))[0]?.stage).toBe(
        "final_review",
      );
    }
  });

  it("refuses to move a candidate a person already decided, an unknown stage, and an unknown id", async () => {
    const people = desk();
    expect(
      (
        await refusal(
          people.updateCandidateStage(
            { candidateId: "CAND-204", stage: "interview" },
            { requestId: "d" },
          ),
        )
      ).code,
    ).toBe("decided");
    expect(
      (
        await refusal(
          people.updateCandidateStage(
            { candidateId: "CAND-202", stage: "offer" },
            { requestId: "o" },
          ),
        )
      ).code,
    ).toBe("invalid");
    expect(
      (
        await refusal(
          people.updateCandidateStage(
            { candidateId: "CAND-999", stage: "interview" },
            { requestId: "n" },
          ),
        )
      ).code,
    ).toBe("not_found");
  });
});

describe("onboarding", () => {
  it("builds the checklist for a hire from the start date, naming who to tell from the company", async () => {
    const checklist = await desk().createOnboardingChecklist(
      { candidateId: "CAND-204" },
      { requestId: "onboard-1" },
    );
    expect(checklist).toMatchObject({
      id: "OB-1",
      candidateId: "CAND-204",
      startDate: "2026-11-23",
    });
    const steps = checklist.steps.map((step) => step.task).join("\n");
    expect(steps).toContain(escalationOwner(company, "start-date")?.name ?? "missing");
    expect(steps).toContain(escalationOwner(company, "supplies-and-equipment")?.name ?? "missing");
    expect(steps).toContain("orientation");
    expect(steps).toContain("paperwork");
    expect(steps).toContain("only what the job needs");
    for (const step of checklist.steps) expect(step.due <= "2026-11-23").toBe(true);
  });

  it("refuses a candidate a person has not hired, and a second checklist; replays the first", async () => {
    const people = desk();
    expect(
      (
        await refusal(
          people.createOnboardingChecklist({ candidateId: "CAND-203" }, { requestId: "x" }),
        )
      ).code,
    ).toBe("not_hired");
    const first = await people.createOnboardingChecklist(
      { candidateId: "CAND-204" },
      { requestId: "a" },
    );
    expect(
      await people.createOnboardingChecklist({ candidateId: "CAND-204" }, { requestId: "a" }),
    ).toEqual(first);
    expect(
      (
        await refusal(
          people.createOnboardingChecklist({ candidateId: "CAND-204" }, { requestId: "b" }),
        )
      ).code,
    ).toBe("exists");
  });
});

describe("time off", () => {
  const owner = peopleOwner(company);
  const protectedOwner = person(company, staff.protectedLeaveTo);

  it("records a request with enough notice as pending, for the person who decides time off", async () => {
    const request = await desk().recordTimeOffRequest(
      {
        employee: "Ana Lopez",
        startDate: "2026-12-21",
        endDate: "2026-12-23",
        reasonCategory: "vacation",
      },
      { requestId: "to-1" },
    );
    expect(request).toMatchObject({
      employeeName: "Ana Lopez",
      status: "pending",
      protected: false,
      days: 3,
      daysNotice: 42,
      noticeDays: staff.timeOffNoticeDays,
      decidesName: owner?.name,
    });
  });

  it("refuses short notice for an ordinary reason, with the notice it worked out, and records nothing", async () => {
    const people = desk();
    const error = await refusal(
      people.recordTimeOffRequest(
        {
          employee: "Ana Lopez",
          startDate: "2026-11-20",
          endDate: "2026-11-20",
          reasonCategory: "vacation",
        },
        { requestId: "late" },
      ),
    );
    expect(error.code).toBe("late_notice");
    expect(error.daysNotice).toBe(11);
    expect(error.mayBeProtected).toBe(false);
    expect(error.message).toContain("request_time_off_exception");
    expect(error.message).toContain("Nothing was recorded");
  });

  it("says a reason given as personal, other or unspecified may be protected, from the field alone", async () => {
    for (const reasonCategory of ["personal", "other", "unspecified"] as const) {
      const error = await refusal(
        desk().recordTimeOffRequest(
          { employee: "Ana Lopez", startDate: "2026-11-12", endDate: "2026-11-12", reasonCategory },
          { requestId: reasonCategory },
        ),
      );
      expect(error.mayBeProtected, reasonCategory).toBe(true);
    }
  });

  it("never refuses a reason the law may protect for short notice: it records it and routes it to a person", async () => {
    for (const reasonCategory of PROTECTED_REASONS) {
      const request = await desk().recordTimeOffRequest(
        {
          employee: "Chloe Nguyen",
          startDate: "2026-11-09",
          endDate: "2026-11-30",
          reasonCategory,
        },
        { requestId: `protected-${reasonCategory}` },
      );
      expect(request, reasonCategory).toMatchObject({
        status: "pending",
        protected: true,
        daysNotice: 0,
        decidesName: protectedOwner?.name,
      });
    }
  });

  it("refuses dates that are not dates, run backwards or have passed, an unknown employee and an overlap", async () => {
    const people = desk();
    const base = { employee: "Ana Lopez", reasonCategory: "vacation" as const };
    const codes = await Promise.all(
      [
        { ...base, startDate: "2026-13-01", endDate: "2026-13-02" },
        { ...base, startDate: "2026-12-10", endDate: "2026-12-09" },
        { ...base, startDate: "2026-11-01", endDate: "2026-11-02" },
        { ...base, employee: "Nobody Here", startDate: "2026-12-10", endDate: "2026-12-10" },
      ].map(
        async (input, index) =>
          (await refusal(people.recordTimeOffRequest(input, { requestId: `bad-${index}` }))).code,
      ),
    );
    expect(codes).toEqual(["invalid", "invalid", "invalid", "not_found"]);
    // Jamal already has approved time off on 2026-11-12.
    const overlap = await refusal(
      people.recordTimeOffRequest(
        {
          employee: "Jamal Brooks",
          startDate: "2026-11-12",
          endDate: "2026-11-13",
          reasonCategory: "medical",
        },
        { requestId: "overlap" },
      ),
    );
    expect(overlap.code).toBe("duplicate");
  });

  it("records a protected absence that already happened, pending for a person, never refused", async () => {
    for (const reasonCategory of ["medical", "family_care"] as const) {
      const request = await desk().recordTimeOffRequest(
        { employee: "Ana Lopez", startDate: "2026-11-06", endDate: "2026-11-06", reasonCategory },
        { requestId: `past-${reasonCategory}` },
      );
      expect(request, reasonCategory).toMatchObject({
        status: "pending",
        protected: true,
        daysNotice: 0,
        decidesName: protectedOwner?.name,
      });
    }
    // An ordinary reason for a past date is still refused.
    const vacation = await refusal(
      desk().recordTimeOffRequest(
        {
          employee: "Ana Lopez",
          startDate: "2026-11-06",
          endDate: "2026-11-06",
          reasonCategory: "vacation",
        },
        { requestId: "past-vacation" },
      ),
    );
    expect(vacation.code).toBe("invalid");
  });

  it("refuses a protected absence dated long ago, naming today, so a wrong year is caught", async () => {
    const error = await refusal(
      desk().recordTimeOffRequest(
        {
          employee: "Chloe Nguyen",
          startDate: "2025-11-17",
          endDate: "2025-11-30",
          reasonCategory: "medical",
        },
        { requestId: "wrong-year" },
      ),
    );
    expect(error.code).toBe("invalid");
    expect(error.message).toContain("today is 2026-11-09");
    expect(error.message).toContain("Check the year");
    expect(error.message).toContain("never record it under another date");
  });

  it("records a protected absence exactly a month back, and refuses one a day older", async () => {
    const people = desk();
    const recorded = await people.recordTimeOffRequest(
      {
        employee: "Chloe Nguyen",
        startDate: "2026-10-09",
        endDate: "2026-10-09",
        reasonCategory: "medical",
      },
      { requestId: "day-31" },
    );
    expect(recorded.status).toBe("pending");
    const older = await refusal(
      people.recordTimeOffRequest(
        {
          employee: "Chloe Nguyen",
          startDate: "2026-10-08",
          endDate: "2026-10-08",
          reasonCategory: "medical",
        },
        { requestId: "day-32" },
      ),
    );
    expect(older.code).toBe("invalid");
  });

  it("sends a past protected absence asked for as an exception back to recording it", async () => {
    const error = await refusal(
      desk().requestTimeOffException(
        {
          employee: "Ana Lopez",
          startDate: "2026-11-06",
          endDate: "2026-11-06",
          reasonCategory: "medical",
          daysNotice: 0,
          why: "Sick",
        },
        { requestId: "past-exception" },
      ),
    );
    expect(error.code).toBe("protected");
  });

  it("finds an employee by a first name alone when only one person has it", async () => {
    const request = await desk().recordTimeOffRequest(
      {
        employee: "maya",
        startDate: "2026-12-14",
        endDate: "2026-12-18",
        reasonCategory: "vacation",
      },
      { requestId: "first-name" },
    );
    expect(request.employeeName).toBe("Maya Singh");
  });

  it("refuses a name more than one person shares, naming them", async () => {
    const people = fakePeopleOpsDesk({
      company,
      now: () => NOW,
      employees: [
        { id: "E-1", name: "Ana Lopez", title: "Cleaner", crewId: "cleaning-north" },
        { id: "E-2", name: "Ana Reyes", title: "Cleaner", crewId: "cleaning-north" },
      ],
    });
    const error = await refusal(
      people.recordTimeOffRequest(
        {
          employee: "Ana",
          startDate: "2026-12-14",
          endDate: "2026-12-14",
          reasonCategory: "vacation",
          from: OWNER,
        },
        { requestId: "ambiguous" },
      ),
    );
    expect(error.code).toBe("ambiguous");
    expect(error.message).toContain("Ana Reyes");
  });

  it("records one request however often the same call is replayed", async () => {
    const people = desk();
    const input = {
      employee: "Ana Lopez",
      startDate: "2026-12-21",
      endDate: "2026-12-21",
      reasonCategory: "vacation" as const,
    };
    const first = await people.recordTimeOffRequest(input, { requestId: "same" });
    expect(await people.recordTimeOffRequest(input, { requestId: "same" })).toEqual(first);
    const next = await people.recordTimeOffRequest(
      { ...input, startDate: "2026-12-28", endDate: "2026-12-28" },
      { requestId: "other" },
    );
    expect(Number(next.id.slice(3))).toBe(Number(first.id.slice(3)) + 1);
  });

  it("records an approved exception for exactly the late request, with the desk's notice figure", async () => {
    const people = desk();
    const input = {
      employee: "Ana Lopez",
      startDate: "2026-11-20",
      endDate: "2026-11-20",
      reasonCategory: "vacation" as const,
      daysNotice: 11,
      why: "Concert out of town",
    };
    const approved = await people.requestTimeOffException(input, { requestId: "ex-1" });
    expect(approved).toMatchObject({
      status: "approved",
      approvedVia: "time_off_exception",
      daysNotice: 11,
    });
    expect(await people.requestTimeOffException(input, { requestId: "ex-1" })).toEqual(approved);
    expect((await refusal(people.requestTimeOffException(input, { requestId: "ex-2" }))).code).toBe(
      "duplicate",
    );
  });

  it("refuses an exception with the wrong notice, one with enough notice, and one for a protected reason", async () => {
    const people = desk();
    const late = {
      employee: "Ana Lopez",
      startDate: "2026-11-20",
      endDate: "2026-11-20",
      reasonCategory: "vacation" as const,
      why: "Concert",
    };
    const wrong = await refusal(
      people.requestTimeOffException({ ...late, daysNotice: 14 }, { requestId: "w" }),
    );
    expect(wrong.code).toBe("notice_changed");
    expect(wrong.daysNotice).toBe(11);
    expect(
      (
        await refusal(
          people.requestTimeOffException(
            { ...late, startDate: "2026-12-21", endDate: "2026-12-21", daysNotice: 42 },
            { requestId: "early" },
          ),
        )
      ).code,
    ).toBe("not_late");
    expect(
      (
        await refusal(
          people.requestTimeOffException(
            { ...late, reasonCategory: "medical", daysNotice: 11 },
            { requestId: "p" },
          ),
        )
      ).code,
    ).toBe("protected");
  });
});

describe("availability", () => {
  it("lists each crew member's unavailable days for the week, and nothing else about them", async () => {
    const crews = await desk().listAvailability({ weekOf: "2026-11-12" });
    expect(crews.map((crew) => crew.crewId)).toEqual(company.crews.map((crew) => crew.id));
    const south = crews.find((crew) => crew.crewId === "cleaning-south");
    expect(south?.weekStart).toBe("2026-11-09");
    expect(
      south?.members.filter((member) => member.unavailable.includes("2026-11-12")),
    ).toHaveLength(2);
    for (const crew of crews) {
      for (const member of crew.members) {
        expect(Object.keys(member).sort()).toEqual(["employeeId", "name", "unavailable"]);
      }
    }
  });

  it("does not count a pending request as time off", async () => {
    const people = desk();
    await people.recordTimeOffRequest(
      {
        employee: "Ana Lopez",
        startDate: "2026-11-09",
        endDate: "2026-11-09",
        reasonCategory: "medical",
      },
      { requestId: "sick" },
    );
    const north = (await people.listAvailability({ crewId: "cleaning-north" }))[0];
    expect(north?.members.find((member) => member.name === "Ana Lopez")?.unavailable).toEqual([]);
  });
});

describe("referrals", () => {
  const pay = person(company, staff.payQuestionsTo);
  const discipline = person(company, staff.disciplineTo);
  const relations = person(company, staff.employeeRelationsTo);
  const head = companyHead(company);

  it("hands pay, discipline, termination and accommodation to the person the company names", async () => {
    const people = desk();
    const to = async (
      topic: "pay" | "discipline" | "termination" | "accommodation",
      about?: string,
    ) =>
      (
        await people.referToPerson(
          { topic, summary: "Needs a person.", ...(about === undefined ? {} : { about }) },
          { requestId: topic },
        )
      ).toName;
    expect(await to("pay")).toBe(pay?.name);
    expect(await to("discipline", "Farid Haddad")).toBe(discipline?.name);
    expect(await to("termination", "Farid Haddad")).toBe(discipline?.name);
    expect(await to("accommodation")).toBe(person(company, staff.protectedLeaveTo)?.name);
  });

  it("hands a workplace complaint to the person the company names, and never to anyone it is about", async () => {
    const people = desk();
    const plain = await people.referToPerson(
      { topic: "employee_relations", summary: "Comments about appearance.", about: "Ben Carter" },
      { requestId: "er-1" },
    );
    expect(plain).toMatchObject({ toName: relations?.name, rerouted: false });
    const owner = relations ?? head;
    if (owner === undefined) throw new Error("the company names nobody for complaints");
    const [first, ...rest] = owner.name.split(" ");
    for (const [index, about] of [owner.name, owner.title, first ?? "", rest.join(" ")].entries()) {
      const receipt = await people.referToPerson(
        { topic: "employee_relations", summary: "Comments about appearance.", about },
        { requestId: `er-named-${index}` },
      );
      expect(receipt.toName, about).not.toBe(owner.name);
      expect(receipt.toName).toBe(head?.name);
      expect(receipt.rerouted).toBe(true);
    }
  });

  it("keeps a complaint about the people ops person away from them when the sender calls them HR", async () => {
    for (const about of ["the HR manager", "human resources", "the personnel officer"]) {
      const receipt = await desk().referToPerson(
        { topic: "employee_relations", summary: "Comments about appearance.", about },
        { requestId: `hr-${about}` },
      );
      expect(receipt.toName, about).not.toBe(relations?.name);
      expect(receipt.rerouted).toBe(true);
    }
  });

  it("keeps a pay or accommodation matter that names its usual owner away from them", async () => {
    const people = desk();
    const payReceipt = await people.referToPerson(
      {
        topic: "pay",
        summary: "Says pay was docked after she complained.",
        about: pay?.name ?? "",
      },
      { requestId: "pay-about" },
    );
    expect(payReceipt.toName).not.toBe(pay?.name);
    expect(payReceipt.rerouted).toBe(true);
    const owner = person(company, staff.protectedLeaveTo);
    const accommodation = await people.referToPerson(
      { topic: "accommodation", summary: "Refused a seat at work.", about: owner?.name ?? "" },
      { requestId: "accommodation-about" },
    );
    expect(accommodation.toName).not.toBe(owner?.name);
  });

  it("reads the summary of a complaint for the people it names, as well as about", async () => {
    const receipt = await desk().referToPerson(
      {
        topic: "employee_relations",
        summary: `Comments from ${relations?.name ?? ""} and a crew member about her appearance.`,
        about: "a crew member",
      },
      { requestId: "summary-named" },
    );
    expect(receipt.toName).not.toBe(relations?.name);
  });

  it("never reads the summary of a plain pay question, so it reaches the person who takes pay", async () => {
    const receipt = await desk().referToPerson(
      { topic: "pay", summary: `Asks ${pay?.name ?? ""} about a short paycheck.` },
      { requestId: "pay-summary" },
    );
    expect(receipt.toName).toBe(pay?.name);
  });

  it("keeps discipline about the person it normally goes to away from them", async () => {
    const receipt = await desk().referToPerson(
      { topic: "discipline", summary: "Shouted at a cleaner.", about: discipline?.name ?? "" },
      { requestId: "d-1" },
    );
    expect(receipt.toName).toBe(head?.name);
  });

  it("refuses when everyone it could go to is named, and when a complaint names nobody it is about", async () => {
    const people = desk();
    const everyone = await refusal(
      people.referToPerson(
        {
          topic: "employee_relations",
          summary: "Both of them.",
          about: `${relations?.name} and ${head?.name}`,
        },
        { requestId: "all" },
      ),
    );
    expect(everyone.code).toBe("no_one_left");
    expect(
      (
        await refusal(
          people.referToPerson(
            { topic: "employee_relations", summary: "Comments." },
            { requestId: "n" },
          ),
        )
      ).code,
    ).toBe("invalid");
  });

  it("hands on once however often the same call is replayed", async () => {
    const people = desk();
    const input = { topic: "pay" as const, summary: "Short paycheck." };
    const first = await people.referToPerson(input, { requestId: "r" });
    expect(await people.referToPerson(input, { requestId: "r" })).toEqual(first);
    expect((await people.referToPerson(input, { requestId: "r2" })).id).toBe("REF-2");
  });
});

describe("company data and the verified sender", () => {
  it("the past-absence window comes from company data", async () => {
    const tenDays: CompanyFacts = {
      ...company,
      staffPolicies: { ...staff, pastAbsenceWindowDays: 10 },
    };
    const medical = (startDate: string) => ({
      employee: "Chloe Nguyen",
      startDate,
      endDate: startDate,
      reasonCategory: "medical" as const,
    });
    // 30 October is eleven days before Monday 9 November; 31 October is ten.
    const old = await refusal(
      desk(tenDays).recordTimeOffRequest(medical("2026-10-29"), { requestId: "a" }),
    );
    expect(old.code).toBe("invalid");
    expect(old.message).toContain("more than 10 days ago");
    const recent = await desk(tenDays).recordTimeOffRequest(medical("2026-10-30"), {
      requestId: "b",
    });
    expect(recent.status).toBe("pending");
    expect(staff.pastAbsenceWindowDays).toBe(31);
  });

  it("records requests go to the data owner", async () => {
    const dataOwner = escalationOwner(company, "data-and-security");
    if (dataOwner === undefined) throw new Error("company changed");
    const referral = await desk().referToPerson(
      { topic: "records_request", summary: "Asks for a copy of their own personnel file." },
      { requestId: "rec" },
    );
    expect(referral).toMatchObject({ topic: "records_request", toName: dataOwner.name });
    // A company whose escalation path names nobody for data sends it to the People Ops owner.
    const noData: CompanyFacts = {
      ...company,
      escalation: company.escalation.filter((rule) => rule.topic !== "data-and-security"),
    };
    const fallback = await desk(noData).referToPerson(
      { topic: "records_request", summary: "Asks for their file." },
      { requestId: "rec2" },
    );
    expect(fallback.toName).toBe(peopleOwner(company)?.name);
  });

  it("get_leave_balance returns the sender's own balance from code", async () => {
    const jamal = demoEmployees().find((employee) => employee.name === "Jamal Brooks");
    if (jamal === undefined) throw new Error("demo changed");
    const balance = await desk().leaveBalance({
      from: { origin: "external", channel: "email", contact: jamal.contact.toUpperCase() },
    });
    // Jamal has one approved day this year (TO-101, Thursday 12 November).
    expect(balance).toMatchObject({
      employeeId: jamal.id,
      name: "Jamal Brooks",
      year: 2026,
      allowanceDays: jamal.leaveAllowanceDays,
      takenDays: 1,
      remainingDays: jamal.leaveAllowanceDays - 1,
    });
    expect(balance.approved.map((entry) => entry.id)).toEqual(["TO-101"]);
    // An office colleague on the company record is matched by their verified id.
    const own = await desk().leaveBalance({ from: OWNER });
    expect(own).toMatchObject({ name: peopleOwner(company)?.name, takenDays: 0 });
  });

  it("records an exception only for the facts a person approved", async () => {
    const people = desk();
    const input = {
      employee: "Ana Lopez",
      startDate: "2026-11-20",
      endDate: "2026-11-20",
      reasonCategory: "vacation" as const,
      daysNotice: 11,
      why: "A wedding.",
      from: OWNER,
    };
    const facts = await people.timeOffExceptionFacts(input);
    expect(facts).toEqual({
      employeeId: "E-01",
      employee: "Ana Lopez",
      startDate: "2026-11-20",
      endDate: "2026-11-20",
      businessDays: 1,
      reasonCategory: "vacation",
      daysNotice: 11,
      noticeDays: staff.timeOffNoticeDays,
    });
    // A Friday-to-Monday exception is two business days, as the balance counts it.
    const weekend = await people.timeOffExceptionFacts({
      ...input,
      startDate: "2026-11-13",
      endDate: "2026-11-16",
      daysNotice: 4,
    });
    expect(weekend.businessDays).toBe(2);
    const changed = await refusal(
      people.requestTimeOffException(
        { ...input, approved: { ...facts, employee: "Ben Carter", employeeId: "E-02" } },
        { requestId: "ex-changed" },
      ),
    );
    expect(changed.code).toBe("exception_changed");
    const recorded = await people.requestTimeOffException(
      { ...input, approved: facts },
      { requestId: "ex-ok" },
    );
    expect(recorded).toMatchObject({ employeeName: "Ana Lopez", status: "approved" });
  });

  it("records an exception a person grants on a later day, with the notice given when it was asked", async () => {
    // Asked on 9 November, decided on 10 November: the approval is bound to the request, not the clock.
    let now = NOW;
    const people = fakePeopleOpsDesk({ company, now: () => now });
    const request = {
      employee: "Ana Lopez",
      startDate: "2026-11-20",
      endDate: "2026-11-20",
      reasonCategory: "vacation" as const,
      from: OWNER,
    };
    const input = { ...request, daysNotice: 11, why: "A wedding." };
    const late = await refusal(people.recordTimeOffRequest(request, { requestId: "ask" }));
    expect(late).toMatchObject({ code: "late_notice", daysNotice: 11 });
    const facts = await people.timeOffExceptionFacts(input);
    expect(facts.daysNotice).toBe(11);

    now = new Date("2026-11-10T09:00:00.000Z");
    // The grant on the next day still works out to what the person approved on the day it was asked.
    const recorded = await people.requestTimeOffException(
      { ...input, approved: facts },
      { requestId: "ex-next-day" },
    );
    expect(recorded).toMatchObject({
      status: "approved",
      daysNotice: 11,
      recordedOn: "2026-11-10",
    });
    expect(
      await people.requestTimeOffException(
        { ...input, approved: facts },
        { requestId: "ex-next-day" },
      ),
    ).toEqual(recorded);
    const balance = await people.leaveBalance({ from: ANA });
    expect(balance.approved.filter((entry) => entry.startDate === "2026-11-20")).toHaveLength(1);

    // A first day that has passed by the time the person decides is still refused.
    now = new Date("2026-11-21T09:00:00.000Z");
    const passed = await refusal(
      people.requestTimeOffException({ ...input, approved: facts }, { requestId: "ex-too-late" }),
    );
    expect(passed.code).toBe("invalid");
  });

  it("starts a new asking day for a new ask once an earlier one was declined", async () => {
    // Asked on 9 November and declined at the gate (the desk records nothing). Asked again on 12
    // November: the facts reader runs once per ask, so the new ask shows the notice left then.
    let now = NOW;
    const people = fakePeopleOpsDesk({ company, now: () => now });
    const request = {
      employee: "Ana Lopez",
      startDate: "2026-11-20",
      endDate: "2026-11-20",
      reasonCategory: "vacation" as const,
      from: OWNER,
    };
    const first = await people.timeOffExceptionFacts({
      ...request,
      daysNotice: 11,
      why: "A wedding.",
    });
    expect(first.daysNotice).toBe(11);

    now = new Date("2026-11-12T09:00:00.000Z");
    // The old figure is no longer the notice of a pending ask.
    const stale = await refusal(
      people.timeOffExceptionFacts({ ...request, daysNotice: 11, why: "A wedding." }),
    );
    expect(stale).toMatchObject({ code: "notice_changed", daysNotice: 8 });
    const again = { ...request, daysNotice: 8, why: "A wedding." };
    const second = await people.timeOffExceptionFacts(again);
    expect(second.daysNotice).toBe(8);
    // Granted the next day, it records with the new ask's notice.
    now = new Date("2026-11-13T09:00:00.000Z");
    const recorded = await people.requestTimeOffException(
      { ...again, approved: second },
      { requestId: "re-ask" },
    );
    expect(recorded).toMatchObject({ status: "approved", daysNotice: 8 });
  });

  it("counts the notice from the day an exception was first put to the desk, even with no refusal first", async () => {
    let now = NOW;
    const people = fakePeopleOpsDesk({ company, now: () => now });
    const input = {
      employee: "Ana Lopez",
      startDate: "2026-11-20",
      endDate: "2026-11-20",
      reasonCategory: "vacation" as const,
      daysNotice: 11,
      why: "A wedding.",
      from: OWNER,
    };
    const facts = await people.timeOffExceptionFacts(input);
    now = new Date("2026-11-12T09:00:00.000Z");
    const recorded = await people.requestTimeOffException(
      { ...input, approved: facts },
      { requestId: "ex-later" },
    );
    expect(recorded).toMatchObject({ status: "approved", daysNotice: 11 });
  });

  it("counts leave in business days, Monday to Friday", async () => {
    // Ana's approved Friday-to-Monday absence is two working days, not four calendar days.
    const people = fakePeopleOpsDesk({
      company,
      now: () => NOW,
      timeOff: [
        {
          id: "TO-1",
          employeeId: "E-01",
          startDate: "2026-11-13",
          endDate: "2026-11-16",
          reasonCategory: "vacation",
          status: "approved",
        },
      ],
    });
    const balance = await people.leaveBalance({ from: ANA });
    expect(balance).toMatchObject({ takenDays: 2, remainingDays: 13 });
    expect(balance.approved[0]).toMatchObject({ id: "TO-1", days: 2 });
  });

  it("checks a self-named sender first, but a shared first name stays ambiguous", async () => {
    // Two staff called Ana. Ana Lopez naming herself in full, or by her surname, is herself.
    const people = fakePeopleOpsDesk({
      company,
      now: () => NOW,
      employees: [
        { ...demoEmployees()[0], id: "E-01" } as never,
        { id: "E-2", name: "Ana Reyes", title: "Cleaner", crewId: "cleaning-north" },
      ],
    });
    const request = {
      startDate: "2026-12-21",
      endDate: "2026-12-21",
      reasonCategory: "vacation" as const,
      from: ANA,
    };
    const full = await people.recordTimeOffRequest(
      { ...request, employee: "Ana Lopez" },
      { requestId: "self-full" },
    );
    expect(full.employeeName).toBe("Ana Lopez");
    const surname = await people.recordTimeOffRequest(
      { ...request, startDate: "2026-12-22", endDate: "2026-12-22", employee: "Lopez" },
      { requestId: "self-surname" },
    );
    expect(surname.employeeName).toBe("Ana Lopez");
    // "Ana" names a colleague as well, so it is ambiguous, never quietly the sender.
    const shared = await refusal(
      people.recordTimeOffRequest(
        { ...request, startDate: "2026-12-23", endDate: "2026-12-23", employee: "Ana" },
        { requestId: "self-shared" },
      ),
    );
    expect(shared.code).toBe("ambiguous");
    // With nobody else called Ana, her first name alone is herself.
    const unique = await desk().recordTimeOffRequest(
      { ...request, employee: "Ana" },
      { requestId: "self-unique" },
    );
    expect(unique.employeeName).toBe("Ana Lopez");
  });

  it("get_leave_balance refuses an unknown sender", async () => {
    const people = desk();
    expect((await refusal(people.leaveBalance({ from: undefined }))).code).toBe("unknown_sender");
    const client = await refusal(
      people.leaveBalance({
        from: {
          origin: "external",
          channel: "email",
          contact: "grace@hawthornefamilydental.example",
        },
      }),
    );
    expect(client.code).toBe("not_staff");
    // A colleague's id typed by an outside sender is nobody.
    const spoofed = await refusal(people.leaveBalance({ from: { ...OWNER, origin: "external" } }));
    expect(spoofed.code).toBe("not_staff");
    // An outside email from a colleague's own address is not a colleague.
    const outsideEmail = await refusal(
      people.leaveBalance({
        from: { origin: "external", channel: "email", contact: OWNER_EMAIL },
      }),
    );
    expect(outsideEmail.code).toBe("not_staff");
  });

  it("files time off for someone else only for an internal colleague, never an outside email from their address", async () => {
    const people = fakePeopleOpsDesk({ company, now: () => NOW });
    const request = {
      employee: "Ana Lopez",
      startDate: "2026-12-21",
      endDate: "2026-12-21",
      reasonCategory: "vacation" as const,
    };
    const outside = await refusal(
      people.recordTimeOffRequest(
        {
          ...request,
          from: { origin: "external", channel: "email", contact: OWNER_EMAIL },
        },
        { requestId: "outside-owner" },
      ),
    );
    expect(outside.code).toBe("not_staff");
    const inside = await people.recordTimeOffRequest(
      { ...request, from: OWNER },
      { requestId: "inside-owner" },
    );
    expect(inside.employeeName).toBe("Ana Lopez");
  });

  it("a staff sender cannot file time off for someone else", async () => {
    const people = desk();
    const request = {
      startDate: "2026-12-21",
      endDate: "2026-12-23",
      reasonCategory: "vacation" as const,
    };
    const other = await refusal(
      people.recordTimeOffRequest(
        { ...request, employee: "Ben Carter", from: ANA },
        { requestId: "x1" },
      ),
    );
    expect(other.code).toBe("someone_else");
    expect(other.message).toContain("Nothing was recorded");
    // Her own request, named or not, is hers.
    const own = await people.recordTimeOffRequest({ ...request, from: ANA }, { requestId: "x2" });
    expect(own.employeeName).toBe("Ana Lopez");
    const named = await people.recordTimeOffRequest(
      { ...request, startDate: "2026-12-28", endDate: "2026-12-28", employee: "Ana", from: ANA },
      { requestId: "x3" },
    );
    expect(named.employeeName).toBe("Ana Lopez");
    // In the office her address arrives on an internal ticket; she is still herself, and only herself.
    const inOffice = await people.recordTimeOffRequest(
      {
        ...request,
        startDate: "2027-01-04",
        endDate: "2027-01-04",
        from: { ...ANA, origin: "internal" },
      },
      { requestId: "x-office" },
    );
    expect(inOffice.employeeName).toBe("Ana Lopez");
    // Nobody known, or somebody not on staff, files nothing.
    expect(
      (
        await refusal(
          people.recordTimeOffRequest({ ...request, from: undefined }, { requestId: "x4" }),
        )
      ).code,
    ).toBe("unknown_sender");
    expect(
      (
        await refusal(
          people.recordTimeOffRequest(
            {
              ...request,
              employee: "Ana Lopez",
              from: { ...ANA, contact: "someone@example.test" },
            },
            { requestId: "x5" },
          ),
        )
      ).code,
    ).toBe("not_staff");
    // The exception path follows the same rule.
    const exception = await refusal(
      people.requestTimeOffException(
        {
          employee: "Ben Carter",
          startDate: "2026-11-20",
          endDate: "2026-11-20",
          reasonCategory: "vacation",
          daysNotice: 11,
          why: "A wedding.",
          from: ANA,
        },
        { requestId: "x6" },
      ),
    );
    expect(exception.code).toBe("someone_else");
  });

  it("the People Ops owner can file for an employee", async () => {
    const people = desk();
    const filed = await people.recordTimeOffRequest(
      {
        employee: "Ana Lopez",
        startDate: "2026-12-21",
        endDate: "2026-12-23",
        reasonCategory: "vacation",
        from: OWNER,
      },
      { requestId: "own-1" },
    );
    expect(filed.employeeName).toBe("Ana Lopez");
    // Another person on the company record may too; with no employee named, it is their own.
    const ops = person(company, "priya-raman");
    if (ops === undefined) throw new Error("company changed");
    const priya: VerifiedSender = { origin: "internal", channel: "chat", contact: ops.id };
    const forCrew = await people.recordTimeOffRequest(
      {
        employee: "Ben Carter",
        startDate: "2026-12-21",
        endDate: "2026-12-21",
        reasonCategory: "vacation",
        from: priya,
      },
      { requestId: "own-2" },
    );
    expect(forCrew.employeeName).toBe("Ben Carter");
    const self = await people.recordTimeOffRequest(
      { startDate: "2026-12-22", endDate: "2026-12-22", reasonCategory: "vacation", from: priya },
      { requestId: "own-3" },
    );
    expect(self.employeeName).toBe(ops.name);
  });
});
