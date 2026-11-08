/**
 * The desk: the HR system this role reads candidates, staff and availability from and writes stage
 * moves, onboarding checklists, time-off requests and hand-offs to.
 *
 * A host binds its own — an HRIS, an applicant tracker, a leave system with an API — and the role never
 * knows the difference. `fakePeopleOpsDesk` is what ships with the package: a hiring pipeline, the crew
 * members the company's crews count, their approved time off, and every rule worked out here, so a
 * test, an eval or a first run needs no network and no credential.
 *
 * The desk owns every date sum and every route. The model names an employee, dates and the kind of
 * reason the employee gave; the desk works out the notice, refuses a short one unless the reason may
 * be protected, picks the person who decides, and keeps a complaint away from the people it names. It
 * holds no contact or personal details at all, so nothing it returns can carry them. A refusal carries
 * a code, and the tools turn the code into the next step.
 */

import {
  type CompanyFacts,
  companyHead,
  escalationOwner,
  findPeople,
  loadCompanyFacts,
  type Person,
  peopleOwner,
  person,
  personLabel,
} from "./company.js";

/** Where a candidate stands. `hired` and `rejected` are a person's decision, never the desk's caller's. */
export type Stage = "applied" | "screening" | "interview" | "final_review" | "hired" | "rejected";

export const STAGES: readonly Stage[] = [
  "applied",
  "screening",
  "interview",
  "final_review",
  "hired",
  "rejected",
];

/** The stages this role may move a candidate between. */
export const REVIEW_STAGES: readonly Stage[] = [
  "applied",
  "screening",
  "interview",
  "final_review",
];

/** A candidate in the pipeline: where they stand, never how to reach them. */
export interface Candidate {
  readonly id: string;
  readonly name: string;
  readonly opening: string;
  readonly stage: Stage;
  /** Set by the person who hired them; `null` until then. */
  readonly startDate: string | null;
  readonly note: string;
}

export interface CandidateFilter {
  /** All or part of the opening's name. */
  readonly opening?: string;
  readonly stage?: string;
  readonly candidateId?: string;
}

export interface StageChange {
  readonly candidateId: string;
  readonly name: string;
  readonly opening: string;
  readonly from: Stage;
  readonly to: Stage;
}

export interface ChecklistStep {
  readonly task: string;
  /** `YYYY-MM-DD`, worked out from the start date. */
  readonly due: string;
}

export interface OnboardingChecklist {
  readonly id: string;
  readonly candidateId: string;
  readonly name: string;
  readonly opening: string;
  readonly startDate: string;
  readonly steps: readonly ChecklistStep[];
}

/** Someone who works here, as the desk knows them: no contact or personal details. */
export interface Employee {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  /** The crew they work on, or `null` for office staff. */
  readonly crewId: string | null;
}

/**
 * The kind of reason an employee gave, chosen from their words. The ones in `PROTECTED_REASONS` may be
 * protected by law: the desk never refuses them for notice and sends them to a person.
 */
export type ReasonCategory =
  | "vacation"
  | "personal"
  | "unspecified"
  | "other"
  | "medical"
  | "disability"
  | "pregnancy_or_parental"
  | "military"
  | "jury_duty"
  | "family_care"
  | "bereavement";

export const PROTECTED_REASONS: readonly ReasonCategory[] = [
  "medical",
  "disability",
  "pregnancy_or_parental",
  "military",
  "jury_duty",
  "family_care",
  "bereavement",
];

export const REASON_CATEGORIES: readonly ReasonCategory[] = [
  "vacation",
  "personal",
  "unspecified",
  "other",
  ...PROTECTED_REASONS,
];

/** Reasons that say too little to rule out a protected one underneath. */
const VAGUE_REASONS: readonly ReasonCategory[] = ["personal", "unspecified", "other"];

/** A recorded time-off request. `approved` only ever comes from a person's approval. */
export interface TimeOffRequest {
  readonly id: string;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly startDate: string;
  readonly endDate: string;
  /** Calendar days, first to last, counted by the desk. */
  readonly days: number;
  readonly reasonCategory: ReasonCategory;
  readonly protected: boolean;
  readonly status: "pending" | "approved";
  /** Days from today to the first day off. */
  readonly daysNotice: number;
  readonly noticeDays: number;
  /** Who decides it, from the company record. */
  readonly decidesName: string;
  readonly decidesTitle: string;
  /** The approval that approved it, or `null` while it waits. */
  readonly approvedVia: "time_off_exception" | null;
  readonly recordedOn: string;
}

export interface TimeOffInput {
  readonly employee: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly reasonCategory: ReasonCategory;
}

export interface MemberAvailability {
  readonly employeeId: string;
  readonly name: string;
  /** Days this week with approved time off. */
  readonly unavailable: readonly string[];
}

export interface CrewAvailability {
  readonly crewId: string;
  readonly crewName: string;
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly members: readonly MemberAvailability[];
}

export type ReferralTopic =
  | "pay"
  | "discipline"
  | "termination"
  | "employee_relations"
  | "accommodation";

export const REFERRAL_TOPICS: readonly ReferralTopic[] = [
  "pay",
  "discipline",
  "termination",
  "employee_relations",
  "accommodation",
];

/** Topics about someone's conduct or job: they must say who, and their summary is read for names too. */
const ABOUT_SOMEONE: readonly ReferralTopic[] = ["discipline", "termination", "employee_relations"];

export interface Referral {
  readonly id: string;
  readonly topic: ReferralTopic;
  readonly summary: string;
  readonly about: string | null;
  readonly toName: string;
  readonly toTitle: string;
  /** The person it normally goes to was named in it, so it went to someone else. */
  readonly rerouted: boolean;
}

/** What the role needs from whatever system holds its people records. */
export interface PeopleOpsDesk {
  listCandidates(filter?: CandidateFilter): Promise<readonly Candidate[]>;
  updateCandidateStage(
    input: { readonly candidateId: string; readonly stage: string },
    options: { readonly requestId: string },
  ): Promise<StageChange>;
  createOnboardingChecklist(
    input: { readonly candidateId: string },
    options: { readonly requestId: string },
  ): Promise<OnboardingChecklist>;
  recordTimeOffRequest(
    input: TimeOffInput,
    options: { readonly requestId: string },
  ): Promise<TimeOffRequest>;
  requestTimeOffException(
    input: TimeOffInput & { readonly daysNotice: number; readonly why: string },
    options: { readonly requestId: string },
  ): Promise<TimeOffRequest>;
  /** Every crew's week; the week the clock is in when `weekOf` is omitted. */
  listAvailability(options?: {
    readonly weekOf?: string;
    readonly crewId?: string;
  }): Promise<readonly CrewAvailability[]>;
  referToPerson(
    input: { readonly topic: ReferralTopic; readonly summary: string; readonly about?: string },
    options: { readonly requestId: string },
  ): Promise<Referral>;
}

/** Why the desk refused, so a tool can say what to do next without parsing the message. */
export type DeskRefusal =
  | "not_found"
  | "ambiguous"
  | "invalid"
  | "needs_person"
  | "decided"
  | "not_hired"
  | "exists"
  | "late_notice"
  | "not_late"
  | "notice_changed"
  | "protected"
  | "duplicate"
  | "no_one_left";

export class PeopleOpsDeskError extends Error {
  readonly code: DeskRefusal;
  /** For the notice refusals: the days of notice the desk worked out. */
  readonly daysNotice: number | undefined;
  /** For `late_notice`: the reason given says too little to rule out a protected one. */
  readonly mayBeProtected: boolean | undefined;

  constructor(
    code: DeskRefusal,
    message: string,
    extra: { readonly daysNotice?: number; readonly mayBeProtected?: boolean } = {},
  ) {
    super(message);
    this.name = "PeopleOpsDeskError";
    this.code = code;
    this.daysNotice = extra.daysNotice;
    this.mayBeProtected = extra.mayBeProtected;
  }
}

/** Approved time off already on the books, before this role recorded anything. */
export interface BookedTimeOff {
  readonly id: string;
  readonly employeeId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly reasonCategory: ReasonCategory;
  readonly status: "pending" | "approved";
}

export interface FakePeopleOpsDeskOptions {
  /** The company: its crews, notice period and who decides what. The generated facts when omitted. */
  readonly company?: CompanyFacts;
  /** Crew members; the demonstration crews when omitted. Office staff come from the company. */
  readonly employees?: readonly Employee[];
  readonly candidates?: readonly Candidate[];
  readonly timeOff?: readonly BookedTimeOff[];
  /** The clock. Omitted: Monday of the demonstration week. */
  readonly now?: () => Date;
}

/** Monday of the demonstration week, at the start of the office day on the US west coast. */
export const DEMO_NOW = "2026-11-09T15:00:00.000Z";

/**
 * The crew members the company's crews count, by crew. They are demonstration data, not the company
 * record, and carry no contact or personal details; a host that binds a real desk never sees them.
 */
export function demoEmployees(): readonly Employee[] {
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
      return {
        id: `E-${String(number).padStart(2, "0")}`,
        name,
        title: crewId === "maintenance" ? "Maintenance technician" : "Cleaner",
        crewId,
      };
    }),
  );
}

/** The demonstration hiring pipeline: two openings, five candidates, one hired and not yet onboarded. */
export function demoCandidates(): readonly Candidate[] {
  return [
    {
      id: "CAND-201",
      name: "Rachel Owens",
      opening: "Cleaner, North crews",
      stage: "interview",
      startDate: null,
      note: "Interview held on 2026-11-05.",
    },
    {
      id: "CAND-202",
      name: "Victor Lindqvist",
      opening: "Cleaner, North crews",
      stage: "screening",
      startDate: null,
      note: "Application meets the requirements; phone screen next.",
    },
    {
      id: "CAND-203",
      name: "Aisha Bello",
      opening: "Maintenance technician",
      stage: "final_review",
      startDate: null,
      note: "Interviewed; with the person who decides the hire.",
    },
    {
      id: "CAND-204",
      name: "Tomasz Nowak",
      opening: "Cleaner, North crews",
      stage: "hired",
      startDate: "2026-11-23",
      note: "Hired by a person on 2026-11-06. Onboarding not started.",
    },
    {
      id: "CAND-205",
      name: "Wendy Choi",
      opening: "Maintenance technician",
      stage: "applied",
      startDate: null,
      note: "Applied on 2026-11-07; not reviewed yet.",
    },
  ];
}

/**
 * Time off already on the books: two of the South crew's cleaners approved off on Thursday of the
 * demonstration week, which is why the schedule books that crew nowhere that day, and one request
 * still waiting for a person.
 */
export function demoTimeOff(): readonly BookedTimeOff[] {
  return [
    {
      id: "TO-101",
      employeeId: "E-09",
      startDate: "2026-11-12",
      endDate: "2026-11-12",
      reasonCategory: "vacation",
      status: "approved",
    },
    {
      id: "TO-102",
      employeeId: "E-10",
      startDate: "2026-11-12",
      endDate: "2026-11-12",
      reasonCategory: "personal",
      status: "approved",
    },
    {
      id: "TO-103",
      employeeId: "E-02",
      startDate: "2026-12-28",
      endDate: "2026-12-31",
      reasonCategory: "vacation",
      status: "pending",
    },
  ];
}

const DAY_MS = 86_400_000;

/** How far back a protected absence may be recorded; anything older is most likely a wrong year. */
export const PAST_ABSENCE_DAYS = 31;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A real calendar date in `YYYY-MM-DD` form, or `undefined`. */
function parseDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || isoDate(date) !== value ? undefined : date;
}

function daysBetween(from: string, to: string): number {
  const start = parseDate(from);
  const end = parseDate(to);
  if (start === undefined || end === undefined) return Number.NaN;
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

function addDays(value: string, days: number): string {
  const date = parseDate(value);
  if (date === undefined) return value;
  return isoDate(new Date(date.getTime() + days * DAY_MS));
}

/** Monday and Sunday of the week a date falls in. */
function weekOf(value: string): { readonly start: string; readonly end: string } {
  const date = parseDate(value);
  if (date === undefined) {
    throw new PeopleOpsDeskError("invalid", `${JSON.stringify(value)} is not a date (YYYY-MM-DD).`);
  }
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  const monday = isoDate(new Date(date.getTime() - sinceMonday * DAY_MS));
  return { start: monday, end: addDays(monday, 6) };
}

function required(value: string | undefined, what: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    throw new PeopleOpsDeskError("invalid", `Give ${what}. Nothing was recorded.`);
  }
  return trimmed;
}

/** An in-memory desk: the company's crews and rules, demonstration people, nothing that leaves the process. */
export function fakePeopleOpsDesk(options: FakePeopleOpsDeskOptions = {}): PeopleOpsDesk {
  const company = options.company ?? loadCompanyFacts();
  const staff = company.staffPolicies;
  const clock = options.now ?? (() => new Date(DEMO_NOW));
  const today = (): string => isoDate(clock());
  const crewMembers = options.employees ?? demoEmployees();
  // Office staff take time off too; they come from the company record, without its contact fields.
  const employees: readonly Employee[] = [
    ...crewMembers,
    ...company.people.map((worker) => ({
      id: worker.id,
      name: worker.name,
      title: worker.title,
      crewId: null,
    })),
  ];
  const candidates: Candidate[] = (options.candidates ?? demoCandidates()).map((c) => ({ ...c }));
  const timeOff: TimeOffRequest[] = [];
  const stageChanges = new Map<string, StageChange>();
  const checklists = new Map<string, OnboardingChecklist>();
  const requests = new Map<string, TimeOffRequest>();
  const referrals = new Map<string, Referral>();
  let timeOffNumber = 103;
  let checklistNumber = 0;
  let referralNumber = 0;

  const timeOffOwner = peopleOwner(company);
  const protectedOwner = person(company, staff.protectedLeaveTo) ?? timeOffOwner;

  const decider = (who: Person | undefined) => ({
    decidesName: who?.name ?? "a person",
    decidesTitle: who?.title ?? "",
  });

  const findEmployee = (id: string): Employee | undefined =>
    employees.find((employee) => employee.id === id);

  for (const entry of options.timeOff ?? demoTimeOff()) {
    const employee = findEmployee(entry.employeeId);
    if (employee === undefined) continue;
    const isProtected = PROTECTED_REASONS.includes(entry.reasonCategory);
    timeOff.push({
      id: entry.id,
      employeeId: employee.id,
      employeeName: employee.name,
      startDate: entry.startDate,
      endDate: entry.endDate,
      days: daysBetween(entry.startDate, entry.endDate) + 1,
      reasonCategory: entry.reasonCategory,
      protected: isProtected,
      status: entry.status,
      daysNotice: 0,
      noticeDays: staff.timeOffNoticeDays,
      ...decider(isProtected ? protectedOwner : timeOffOwner),
      approvedVia: null,
      recordedOn: "2026-10-20",
    });
  }

  const findCandidate = (id: string): Candidate => {
    const candidate = candidates.find((c) => c.id.toLowerCase() === id.trim().toLowerCase());
    if (candidate === undefined) {
      throw new PeopleOpsDeskError(
        "not_found",
        `No candidate has the id ${JSON.stringify(id)}. Find them with list_candidates.`,
      );
    }
    return candidate;
  };

  /** An employee by id or name; a first name or surname alone works when only one person has it. */
  const employeeNamed = (query: string): Employee => {
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
      throw new PeopleOpsDeskError(
        "not_found",
        `Nobody on staff is called ${JSON.stringify(query)}. Give the employee's full name. Nothing was recorded.`,
      );
    }
    if (others.length > 0) {
      throw new PeopleOpsDeskError(
        "ambiguous",
        `More than one person on staff matches ${JSON.stringify(query)}: ${matches.map((employee) => employee.name).join(", ")}. Give the full name. Nothing was recorded.`,
      );
    }
    return only;
  };

  /** Checks the dates and works out the notice. */
  const checkDates = (input: TimeOffInput) => {
    const isProtected = PROTECTED_REASONS.includes(input.reasonCategory);
    const start = input.startDate.trim();
    const end = input.endDate.trim();
    if (parseDate(start) === undefined || parseDate(end) === undefined) {
      throw new PeopleOpsDeskError(
        "invalid",
        `${JSON.stringify(start)} to ${JSON.stringify(end)} are not dates. Give them as YYYY-MM-DD. Nothing was recorded.`,
      );
    }
    if (end < start) {
      throw new PeopleOpsDeskError(
        "invalid",
        `The last day (${end}) is before the first (${start}). Nothing was recorded.`,
      );
    }
    // An absence the law may protect that already happened ("I was off sick yesterday") is still
    // recorded for a person: only an ordinary reason is refused for a date that has passed.
    // A past protected absence is recorded, but only a recent one: a date further back is almost always
    // a wrong year, and recording it would hide the mistake.
    if (isProtected && daysBetween(start, today()) > PAST_ABSENCE_DAYS) {
      throw new PeopleOpsDeskError(
        "invalid",
        `${start} is more than ${PAST_ABSENCE_DAYS} days ago (today is ${today()}). Check the year; an older absence goes to ${personLabel(person(company, staff.protectedLeaveTo))} directly. Nothing was recorded.`,
      );
    }
    if (start < today() && !isProtected) {
      throw new PeopleOpsDeskError(
        "invalid",
        `${start} has already passed (today is ${today()}). Time off is recorded from today on. Nothing was recorded.`,
      );
    }
    if (!REASON_CATEGORIES.includes(input.reasonCategory)) {
      throw new PeopleOpsDeskError(
        "invalid",
        `${JSON.stringify(input.reasonCategory)} is not a reason category. Use one of: ${REASON_CATEGORIES.join(", ")}. Nothing was recorded.`,
      );
    }
    return { start, end, daysNotice: Math.max(0, daysBetween(today(), start)) };
  };

  const refuseOverlap = (employee: Employee, start: string, end: string): void => {
    const clash = timeOff.find(
      (entry) =>
        entry.employeeId === employee.id && entry.startDate <= end && entry.endDate >= start,
    );
    if (clash !== undefined) {
      throw new PeopleOpsDeskError(
        "duplicate",
        `${employee.name} already has ${clash.id} for ${clash.startDate} to ${clash.endDate}, ${clash.status}. Nothing new was recorded.`,
      );
    }
  };

  const record = (
    employee: Employee,
    dates: { readonly start: string; readonly end: string; readonly daysNotice: number },
    reasonCategory: ReasonCategory,
    status: TimeOffRequest["status"],
  ): TimeOffRequest => {
    const isProtected = PROTECTED_REASONS.includes(reasonCategory);
    timeOffNumber += 1;
    const entry: TimeOffRequest = {
      id: `TO-${timeOffNumber}`,
      employeeId: employee.id,
      employeeName: employee.name,
      startDate: dates.start,
      endDate: dates.end,
      days: daysBetween(dates.start, dates.end) + 1,
      reasonCategory,
      protected: isProtected,
      status,
      daysNotice: dates.daysNotice,
      noticeDays: staff.timeOffNoticeDays,
      ...decider(isProtected ? protectedOwner : timeOffOwner),
      approvedVia: status === "approved" ? "time_off_exception" : null,
      recordedOn: today(),
    };
    timeOff.push(entry);
    return entry;
  };

  const ownerFor = (topic: ReferralTopic): Person | undefined => {
    switch (topic) {
      case "pay":
        return person(company, staff.payQuestionsTo);
      case "discipline":
      case "termination":
        return person(company, staff.disciplineTo);
      case "employee_relations":
        return person(company, staff.employeeRelationsTo);
      case "accommodation":
        return protectedOwner;
    }
  };

  return {
    async listCandidates(filter: CandidateFilter = {}): Promise<readonly Candidate[]> {
      const opening = filter.opening?.trim().toLowerCase();
      const stage = filter.stage?.trim().toLowerCase();
      const id = filter.candidateId?.trim().toLowerCase();
      return candidates
        .filter((c) => opening === undefined || c.opening.toLowerCase().includes(opening))
        .filter((c) => stage === undefined || stage === "" || c.stage === stage)
        .filter((c) => id === undefined || id === "" || c.id.toLowerCase() === id)
        .map((c) => ({ ...c }));
    },

    async updateCandidateStage(input, { requestId }): Promise<StageChange> {
      const prior = stageChanges.get(requestId);
      if (prior !== undefined) return prior;

      const index = candidates.findIndex((c) => c.id === findCandidate(input.candidateId).id);
      const candidate = candidates[index];
      if (candidate === undefined) throw new Error("unreachable");
      const to = input.stage.trim().toLowerCase() as Stage;
      if (!STAGES.includes(to)) {
        throw new PeopleOpsDeskError(
          "invalid",
          `${JSON.stringify(input.stage)} is not a stage. The review stages are ${REVIEW_STAGES.join(", ")}. Nothing was changed.`,
        );
      }
      // Who is hired, and who is turned down, is a person's decision: the pipeline only records where
      // a candidate stands while they are in review.
      if (to === "hired" || to === "rejected") {
        throw new PeopleOpsDeskError(
          "needs_person",
          `Moving ${candidate.name} (${candidate.id}) to ${to} is a hiring decision: ${personLabel(peopleOwner(company))} decides it. Nothing was changed.`,
        );
      }
      if (candidate.stage === "hired" || candidate.stage === "rejected") {
        throw new PeopleOpsDeskError(
          "decided",
          `${candidate.name} (${candidate.id}) was already ${candidate.stage} by a person, so their stage does not change. Nothing was changed.`,
        );
      }
      if (candidate.stage === to) {
        throw new PeopleOpsDeskError(
          "invalid",
          `${candidate.name} (${candidate.id}) is already at ${to}. Nothing was changed.`,
        );
      }
      candidates[index] = { ...candidate, stage: to };
      const change: StageChange = {
        candidateId: candidate.id,
        name: candidate.name,
        opening: candidate.opening,
        from: candidate.stage,
        to,
      };
      stageChanges.set(requestId, change);
      return change;
    },

    async createOnboardingChecklist(input, { requestId }): Promise<OnboardingChecklist> {
      const prior = checklists.get(requestId);
      if (prior !== undefined) return prior;

      const candidate = findCandidate(input.candidateId);
      if (candidate.stage !== "hired" || candidate.startDate === null) {
        throw new PeopleOpsDeskError(
          "not_hired",
          `${candidate.name} (${candidate.id}) is at ${candidate.stage}, not hired: onboarding starts once a person has hired them and set a start date. Nothing was created.`,
        );
      }
      const existing = [...checklists.values()].find((list) => list.candidateId === candidate.id);
      if (existing !== undefined) {
        throw new PeopleOpsDeskError(
          "exists",
          `${candidate.name} already has onboarding checklist ${existing.id}. Nothing new was created.`,
        );
      }
      const start = candidate.startDate;
      const before = (days: number) => {
        const due = addDays(start, -days);
        return due < today() ? today() : due;
      };
      const crew = personLabel(
        escalationOwner(company, "start-date"),
        "the person who owns the schedule",
      );
      const supplies = personLabel(
        escalationOwner(company, "supplies-and-equipment"),
        "the person who orders equipment",
      );
      checklistNumber += 1;
      const checklist: OnboardingChecklist = {
        id: `OB-${checklistNumber}`,
        candidateId: candidate.id,
        name: candidate.name,
        opening: candidate.opening,
        startDate: start,
        steps: [
          {
            task: `Tell ${crew} the start date, so the new hire is placed on a crew and given first shifts`,
            due: today(),
          },
          {
            task: `Tell ${supplies} what uniform and equipment the new hire needs`,
            due: before(7),
          },
          {
            task: "Prepare the first-day orientation and tell the new hire when and where it is",
            due: before(3),
          },
          {
            task: "Get the new-hire forms and the hiring paperwork the law requires completed and filed (in the US, for example, Form I-9)",
            due: start,
          },
          { task: "Agree the first tasks with the crew lead", due: start },
          { task: "Set up access to only what the job needs", due: start },
        ],
      };
      checklists.set(requestId, checklist);
      return checklist;
    },

    async recordTimeOffRequest(input, { requestId }): Promise<TimeOffRequest> {
      const prior = requests.get(requestId);
      if (prior !== undefined) return prior;

      const employee = employeeNamed(input.employee);
      const dates = checkDates(input);
      refuseOverlap(employee, dates.start, dates.end);
      // Leave the law may protect goes to a person whatever the notice: the notice rule never refuses
      // it, because only a person can weigh it.
      const isProtected = PROTECTED_REASONS.includes(input.reasonCategory);
      if (!isProtected && dates.daysNotice < staff.timeOffNoticeDays) {
        const mayBeProtected = VAGUE_REASONS.includes(input.reasonCategory);
        throw new PeopleOpsDeskError(
          "late_notice",
          `Needs approval: time off for ${employee.name} from ${dates.start} to ${dates.end} gives ${dates.daysNotice} days' notice, and the company asks for ${staff.timeOffNoticeDays}. Short notice for this reason is a person's call: call request_time_off_exception with employee ${employee.name}, startDate ${dates.start}, endDate ${dates.end}, reasonCategory ${input.reasonCategory}, daysNotice ${dates.daysNotice} and why. Nothing was recorded.`,
          { daysNotice: dates.daysNotice, mayBeProtected },
        );
      }
      const entry = record(employee, dates, input.reasonCategory, "pending");
      requests.set(requestId, entry);
      return entry;
    },

    async requestTimeOffException(input, { requestId }): Promise<TimeOffRequest> {
      const prior = requests.get(requestId);
      if (prior !== undefined) return prior;

      const employee = employeeNamed(input.employee);
      const dates = checkDates(input);
      if (PROTECTED_REASONS.includes(input.reasonCategory)) {
        throw new PeopleOpsDeskError(
          "protected",
          `A ${input.reasonCategory.replaceAll("_", " ")} reason needs no exception: record it with record_time_off_request, which never refuses it for notice and sends it to ${personLabel(protectedOwner)}. Nothing was recorded.`,
        );
      }
      if (dates.daysNotice >= staff.timeOffNoticeDays) {
        throw new PeopleOpsDeskError(
          "not_late",
          `${dates.start} is ${dates.daysNotice} days away, which is enough notice: record it with record_time_off_request. Nothing was recorded.`,
          { daysNotice: dates.daysNotice },
        );
      }
      // The person approves exactly the notice the desk worked out, never a figure of the caller's.
      if (!Number.isFinite(input.daysNotice) || input.daysNotice !== dates.daysNotice) {
        throw new PeopleOpsDeskError(
          "notice_changed",
          `Time off from ${dates.start} gives ${dates.daysNotice} days' notice, not ${String(input.daysNotice)}. Nothing was recorded.`,
          { daysNotice: dates.daysNotice },
        );
      }
      required(input.why, "why the employee needs the time off at short notice (why)");
      refuseOverlap(employee, dates.start, dates.end);
      const entry = record(employee, dates, input.reasonCategory, "approved");
      requests.set(requestId, entry);
      return entry;
    },

    async listAvailability(availability = {}): Promise<readonly CrewAvailability[]> {
      const week = weekOf(availability.weekOf?.trim() || today());
      const crewId = availability.crewId?.trim();
      const crews = company.crews.filter((crew) => !crewId || crew.id === crewId);
      if (crews.length === 0) {
        throw new PeopleOpsDeskError(
          "not_found",
          `No crew has the id ${JSON.stringify(crewId)}. The crews are: ${company.crews.map((crew) => crew.id).join(", ")}.`,
        );
      }
      return crews.map((crew) => ({
        crewId: crew.id,
        crewName: crew.name,
        weekStart: week.start,
        weekEnd: week.end,
        members: crewMembers
          .filter((employee) => employee.crewId === crew.id)
          .map((employee) => {
            const unavailable: string[] = [];
            for (let day = 0; day < 7; day += 1) {
              const date = addDays(week.start, day);
              // Only approved time off makes someone unavailable; a request waiting for a person
              // does not, and no reason is ever attached.
              if (
                timeOff.some(
                  (entry) =>
                    entry.employeeId === employee.id &&
                    entry.status === "approved" &&
                    entry.startDate <= date &&
                    entry.endDate >= date,
                )
              ) {
                unavailable.push(date);
              }
            }
            return { employeeId: employee.id, name: employee.name, unavailable };
          }),
      }));
    },

    async referToPerson(input, { requestId }): Promise<Referral> {
      const prior = referrals.get(requestId);
      if (prior !== undefined) return prior;

      if (!REFERRAL_TOPICS.includes(input.topic)) {
        throw new PeopleOpsDeskError(
          "invalid",
          `${JSON.stringify(input.topic)} is not a topic. Use one of: ${REFERRAL_TOPICS.join(", ")}. Nothing was handed on.`,
        );
      }
      const summary = required(input.summary, "a summary of what the person needs to know");
      const about = input.about?.trim() || null;
      const aboutSomeone = ABOUT_SOMEONE.includes(input.topic);
      if (aboutSomeone && about === null) {
        throw new PeopleOpsDeskError(
          "invalid",
          `A ${input.topic.replaceAll("_", " ")} matter names who it is about (about), so it never goes to them. Nothing was handed on.`,
        );
      }
      // A matter about someone is never handed to anyone it names: the usual owner, then the head of
      // the company, whoever is first and not named.
      // Matching is eager on purpose: a false match only ever sends a matter to someone else. `about`
      // is read for every topic; the summary too for matters about someone's conduct or job.
      const subjects = new Set(
        [
          ...(about === null ? [] : findPeople(company, about)),
          ...(aboutSomeone ? findPeople(company, summary) : []),
        ].map((named) => named.id),
      );
      const usual = ownerFor(input.topic);
      const candidatesFor = [usual, companyHead(company)].filter(
        (candidate): candidate is Person => candidate !== undefined,
      );
      const owner = candidatesFor.find((candidate) => !subjects.has(candidate.id));
      if (owner === undefined) {
        throw new PeopleOpsDeskError(
          "no_one_left",
          `Everyone the company record names for ${input.topic.replaceAll("_", " ")} is named in it, so it cannot go to any of them. Nothing was handed on.`,
        );
      }
      referralNumber += 1;
      const referral: Referral = {
        id: `REF-${referralNumber}`,
        topic: input.topic,
        summary,
        about,
        toName: owner.name,
        toTitle: owner.title,
        rerouted: usual !== undefined && usual.id !== owner.id,
      };
      referrals.set(requestId, referral);
      return referral;
    },
  };
}
