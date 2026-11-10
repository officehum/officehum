/**
 * The People Ops role's nine tools.
 *
 * `list_candidates`, `list_availability`, `get_leave_balance` and `read_company` only read, and none
 * of them can print a contact or personal detail: the desk returns none and the company section types
 * none. Who is asking comes from the host's verified sender (`SenderResolver`), never from an argument
 * or the message: `get_leave_balance` gives only the sender's own balance, and a time-off request is
 * the sender's own unless a person on the company record files it for someone. The writes go
 * through the desk with no approval — a stage move, an onboarding checklist, a pending time-off
 * request, a hand-off to a person — and each refusal comes back with a code the tools turn into the
 * next step. `request_time_off_exception` is the one approval-gated tool; its approval is
 * `officehum.json`'s, evaluated by the SDK's gate before the tool runs, so this file holds no notice
 * rule and no approval rule.
 *
 * Every date sum a tool speaks comes back from the desk, and every name from the company record.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  APPROVED_FACTS_ARG,
  type ApprovalFactsReader,
  approvedFacts,
  approvedFactsParameter,
  deskRefusal,
  refusal,
  requestId,
  type SenderResolver,
  textResult,
} from "@officehum/sdk";
import { type CompanyFacts, type Person, peopleOwner, person, personLabel } from "./company.js";
import {
  type Candidate,
  type CrewAvailability,
  type DeskRefusal,
  type LeaveBalance,
  type PeopleOpsDesk,
  PeopleOpsDeskError,
  REASON_CATEGORIES,
  REFERRAL_TOPICS,
  type ReasonCategory,
  type ReferralTopic,
  STAGES,
  type TimeOffRequest,
} from "./desk.js";

export interface PeopleOpsToolDependencies {
  readonly desk: PeopleOpsDesk | undefined;
  readonly company: CompanyFacts;
  /** The host's verified sender of each call's work. Omitted: every sender is unknown. */
  readonly sender?: SenderResolver;
}

export interface PeopleOpsToolset {
  readonly listCandidates: ToolRegistration;
  readonly updateCandidateStage: ToolRegistration;
  readonly onboardingChecklist: ToolRegistration;
  readonly recordTimeOffRequest: ToolRegistration;
  readonly requestTimeOffException: ToolRegistration;
  readonly listAvailability: ToolRegistration;
  readonly getLeaveBalance: ToolRegistration;
  readonly referToPerson: ToolRegistration;
  readonly readCompany: ToolRegistration;
  /**
   * The `time_off_exception` approval's facts: whose time off (from the verified sender), the dates,
   * the reason and the desk's notice, read before anyone is asked.
   */
  readonly exceptionFacts: ApprovalFactsReader;
}

export type CompanySection =
  | "profile"
  | "hours"
  | "people"
  | "crews"
  | "staff"
  | "tone"
  | "escalation"
  | "glossary";

const SECTIONS: readonly CompanySection[] = [
  "profile",
  "hours",
  "people",
  "crews",
  "staff",
  "tone",
  "escalation",
  "glossary",
];

const DATE = Type.String({
  description:
    "A date as YYYY-MM-DD. When the person gives no year, it is the next such date from today: list_availability's heading gives this week's dates",
});

const EMPLOYEE =
  "Only when someone files for another employee: that employee's name as given, a full name or a first name or surname alone. Leave it out for the sender's own time off: the desk knows who sent the message. The desk finds the employee and says if more than one person has that name, so never ask for a surname first";

const literals = <T extends string>(values: readonly T[], description: string) =>
  Type.Union(
    values.map((value) => Type.Literal(value)),
    { description },
  );

const REASON = literals(
  REASON_CATEGORIES,
  "The kind of reason the employee gave, from their own words: medical (illness, injury, surgery, a medical appointment), disability, pregnancy_or_parental (pregnancy, birth, adoption, a new child), military, jury_duty, family_care (caring for a sick family member), bereavement, vacation, personal, other, or unspecified when they gave none",
);

function requireDesk(dependencies: PeopleOpsToolDependencies): PeopleOpsDesk {
  if (dependencies.desk === undefined) {
    throw new Error("No people desk is configured for this role.");
  }
  return dependencies.desk;
}

const reasonWords = (reason: ReasonCategory): string => reason.replaceAll("_", " ");

/**
 * The next step for every refusal the desk can give, keyed by its code and never by its message. A
 * `Record` over the whole union, so a new code does not compile until it has a hint.
 */
export function HINTS(company: CompanyFacts): Record<DeskRefusal, string> {
  const hiring = personLabel(peopleOwner(company), "the person who decides hiring");
  return {
    not_found: " Check the id with list_candidates, or ask for the person's full name.",
    ambiguous: " Ask which of them it is, by full name.",
    invalid: " Fix what it says and try once, or ask the person for what is missing.",
    needs_person: ` Next: tell the asker that ${hiring} decides it and the candidate stays in review; do not call update_candidate_stage for it again.`,
    decided: ` That decision was ${hiring}'s: tell the asker where the candidate stands.`,
    not_hired: ` Onboarding waits until ${hiring} hires them: say so.`,
    exists:
      " Tell the asker onboarding is already under way with that checklist; do not create another.",
    late_notice:
      " Next: request_time_off_exception asks a person, with the figures above; do not record it again for the same reason.",
    not_late: " Next: record it with record_time_off_request.",
    notice_changed: " Ask again with the desk's notice figure.",
    protected: " Next: record_time_off_request, with the same reasonCategory.",
    duplicate:
      " Tell the employee what is already recorded and its status; do not record it again.",
    no_one_left:
      " Next: hand it to nobody it names. Tell the person plainly that you could not pass it to anyone on record who is not named in it, and that they can raise it directly with a manager they trust.",
    unknown_sender: ` Next: tell them nothing was recorded or shared, and that they can ask from the address or number the company has for them, or ask the person who decides time off directly: ${hiring}.`,
    not_staff: ` Next: say time off and leave balances are for staff only, and that ${hiring} decides time off; share nothing about anyone.`,
    exception_changed:
      " Next: nothing was recorded, because the request no longer matches what the person approved. If the employee still wants it, call request_time_off_exception again with the figures above, which puts that request to a person, and tell the employee it waits for them.",
    someone_else:
      " Next: tell the sender each employee asks for their own time off, or a person on the company record files it for them; record nothing under the sender's name instead.",
  };
}

function candidateLine(candidate: Candidate): string {
  const start = candidate.startDate === null ? "" : ` — starts ${candidate.startDate}`;
  return `${candidate.id} — ${candidate.name} — ${candidate.opening} — ${candidate.stage}${start} — ${candidate.note}`;
}

function availabilityText(crews: readonly CrewAvailability[]): string {
  const first = crews[0];
  if (first === undefined) return "No crews are set up.";
  return [
    `Availability for the week of ${first.weekStart} to ${first.weekEnd} (approved time off only):`,
    ...crews.flatMap((crew) => [
      `${crew.crewName} (${crew.crewId}):`,
      ...crew.members.map(
        (member) =>
          `- ${member.name} — ${member.unavailable.length === 0 ? "available all week" : `not available ${member.unavailable.join(", ")}`}`,
      ),
    ]),
  ].join("\n");
}

function timeOffText(entry: TimeOffRequest): string {
  const span = `${entry.employeeName}, ${entry.startDate} to ${entry.endDate} (${entry.days} ${entry.days === 1 ? "day" : "days"}), ${reasonWords(entry.reasonCategory)}`;
  const decides =
    entry.decidesTitle === ""
      ? entry.decidesName
      : personLabel({ id: "", name: entry.decidesName, title: entry.decidesTitle });
  if (entry.status === "approved") {
    return `Approved by a person and recorded: ${entry.id}, ${span}, with ${entry.daysNotice} days' notice.`;
  }
  if (entry.protected) {
    return `Recorded ${entry.id}: ${span}. Status: pending — not approved. The reason may be protected by law, so ${decides} decides it whatever the notice: it is never refused for short notice. This is an internal record: nothing has been sent to anyone. Do not ask for medical details, and say nothing about whether the law applies.`;
  }
  return `Recorded ${entry.id}: ${span}, with ${entry.daysNotice} days' notice. Status: pending — not approved. ${decides} decides it. This is an internal record: nothing has been sent to anyone.`;
}

function balanceText(balance: LeaveBalance): string {
  const approved =
    balance.approved.length === 0
      ? "none"
      : balance.approved
          .map(
            (entry) =>
              `${entry.id}, ${entry.startDate} to ${entry.endDate} (${entry.days} business ${entry.days === 1 ? "day" : "days"} this year)`,
          )
          .join("; ");
  const pending =
    balance.pending === 0
      ? ""
      : ` ${balance.pending} ${balance.pending === 1 ? "request is" : "requests are"} still waiting for a person and not counted.`;
  return `Leave for ${balance.name} (the sender) in ${balance.year}, in business days (Monday to Friday): allowance ${balance.allowanceDays}; approved and taken or booked ${balance.takenDays}; ${balance.remainingDays} left. Approved: ${approved}.${pending} Worked out by the desk; this is the sender's own balance only.`;
}

function companySection(company: CompanyFacts, section: CompanySection): string {
  const named = (id: string | null) => {
    return personLabel(id === null ? undefined : person(company, id));
  };
  switch (section) {
    case "profile": {
      const { profile } = company;
      return [
        `${profile.legalName} — trading as ${profile.tradingName}. ${profile.tagline}`,
        `Service area: ${profile.serviceArea}`,
      ].join("\n");
    }
    case "hours": {
      const open = company.hours;
      return [
        `Office: ${open.office} (${open.timezone}).`,
        `Crews: ${open.crews}.`,
        `Closed: ${open.closedOn}.`,
        open.note,
      ].join("\n");
    }
    case "people":
      // Names, titles and what each decides: who to hand something to. Never a phone or an email.
      return company.people
        .map(
          (worker: Person) =>
            `${worker.name} — ${worker.title} — decides: ${worker.decides.join("; ")}`,
        )
        .join("\n");
    case "crews":
      return company.crews
        .map(
          (crew) =>
            `${crew.id} — ${crew.name} — ${crew.members} people — led by ${crew.leadPersonId === null ? "a cleaner from the crew" : named(crew.leadPersonId)}`,
        )
        .join("\n");
    case "staff": {
      const staff = company.staffPolicies;
      return [
        `Time off is asked for at least ${staff.timeOffNoticeDays} days ahead. ${named(peopleOwner(company)?.id ?? null)} decides time off and hiring.`,
        `Leave for a reason the law may protect, and accommodation requests: ${named(staff.protectedLeaveTo)}, whatever the notice.`,
        `Questions about pay: ${named(staff.payQuestionsTo)}.`,
        `Discipline and termination: ${named(staff.disciplineTo)}.`,
        `Complaints about harassment or how someone is treated at work: ${named(staff.employeeRelationsTo)}, never anyone the complaint is about.`,
      ].join("\n");
    }
    case "tone":
      return [
        company.tone.summary,
        "Always:",
        ...company.tone.always.map((rule) => `- ${rule}`),
        "Never:",
        ...company.tone.never.map((rule) => `- ${rule}`),
      ].join("\n");
    case "escalation":
      return company.escalation
        .map((rule) => `${rule.topic} — ${named(rule.toPersonId)} — ${rule.when}`)
        .join("\n");
    case "glossary":
      return company.glossary.map((entry) => `${entry.term}: ${entry.meaning}`).join("\n");
  }
}

/**
 * Builds the nine tools over one desk and one company. Every one is plain Pi Durable: they install
 * into any harness, and a harness with no desk builds the same tools and refuses at the point of use.
 */
export function peopleOpsTools(dependencies: PeopleOpsToolDependencies): PeopleOpsToolset {
  const { company } = dependencies;
  const hints = HINTS(company);

  /** A short-notice exception's request from the call's arguments, without who sent it. */
  const exceptionInput = (args: Readonly<Record<string, unknown>>) => ({
    ...(typeof args.employee === "string" ? { employee: args.employee } : {}),
    startDate: String(args.startDate),
    endDate: String(args.endDate),
    reasonCategory: args.reasonCategory as ReasonCategory,
    daysNotice: Number(args.daysNotice),
    why: String(args.why ?? ""),
  });

  /** Who this call's work came from, as the host verified it; `undefined` when nobody is known. */
  const from = (api: { readonly conversationId: unknown; readonly taskId: unknown }) =>
    dependencies.sender?.({ conversationId: api.conversationId, taskId: api.taskId }) ??
    Promise.resolve(undefined);
  const hiring = personLabel(peopleOwner(company), "the person who decides hiring");

  /** A desk refusal as the model reads it, with the next step its code names. */
  const refused = (error: unknown, extra: JsonObject) => {
    if (!(error instanceof PeopleOpsDeskError)) throw error;
    let next = hints[error.code];
    if (error.code === "notice_changed" && error.daysNotice !== undefined) {
      next = ` Ask again with daysNotice ${error.daysNotice}.`;
    }
    // From the reason field, never the employee's words: a vague reason may hide a protected one.
    if (error.code === "late_notice" && error.mayBeProtected === true) {
      next += ` The reason given says too little to rule out one the law may protect. If the employee's reason is illness or injury, disability, pregnancy or a new child, military service, jury duty, caring for family or bereavement, it may be protected: call record_time_off_request again with that reasonCategory instead, and the desk sends it to ${personLabel(person(company, company.staffPolicies.protectedLeaveTo))} whatever the notice. Do not ask for medical details.`;
    }
    return deskRefusal(`${error.message}${next}`, error.code, {
      ...(error.daysNotice === undefined ? {} : { daysNotice: error.daysNotice }),
      ...(error.mayBeProtected === undefined ? {} : { mayBeProtected: error.mayBeProtected }),
      ...extra,
    });
  };

  const listCandidates = defineTool({
    name: "list_candidates",
    description:
      "List the candidates in the hiring pipeline, optionally for one opening, stage or candidate: each one's id, name, opening, stage, start date once hired, and a note on where they stand. No contact or personal details.",
    parameters: Type.Object(
      {
        opening: Type.Optional(Type.String({ description: "All or part of the opening's name" })),
        stage: Type.Optional(literals(STAGES, "Only candidates at this stage")),
        candidateId: Type.Optional(Type.String({ description: "One candidate, e.g. CAND-202" })),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const desk = requireDesk(dependencies);
      const candidates = await desk.listCandidates({
        ...(args.opening === undefined ? {} : { opening: args.opening }),
        ...(args.stage === undefined ? {} : { stage: args.stage }),
        ...(args.candidateId === undefined ? {} : { candidateId: args.candidateId }),
      });
      const details = {
        found: candidates.length > 0,
        candidates: candidates.map((candidate) => ({ ...candidate })),
      };
      if (candidates.length === 0) {
        return refusal(
          "No candidate matches that. Try fewer filters or another spelling.",
          details,
        );
      }
      return {
        ...textResult(
          [`Candidates (${candidates.length}):`, ...candidates.map(candidateLine)].join("\n"),
        ),
        details,
      };
    },
  });

  const updateCandidateStage = defineTool({
    name: "update_candidate_stage",
    description:
      "Move a candidate to another review stage: applied, screening, interview or final_review (referred to the person who decides the hire). Hired and rejected are a person's decision: the desk refuses them and names who decides.",
    parameters: Type.Object(
      {
        candidateId: Type.String({ description: "The candidate's id from list_candidates" }),
        stage: literals(STAGES, "The stage to move them to"),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const change = await desk.updateCandidateStage(
          { candidateId: args.candidateId, stage: args.stage },
          { requestId: requestId("stage", api) },
        );
        return {
          ...textResult(
            `Moved ${change.name} (${change.candidateId}, ${change.opening}) from ${change.from} to ${change.to}. This is an internal record: nothing was sent to the candidate, and no hiring decision was made.`,
          ),
          details: { ...change },
        };
      } catch (error) {
        return refused(error, { candidateId: args.candidateId });
      }
    },
  });

  const onboardingChecklist = defineTool({
    name: "onboarding_checklist",
    description: `Create the onboarding checklist for a new hire a person has hired, from their start date: who to tell, the orientation, the hiring paperwork, first tasks and access. Refused for a candidate not yet hired (${hiring} hires).`,
    parameters: Type.Object(
      {
        candidateId: Type.String({ description: "The hired candidate's id from list_candidates" }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const checklist = await desk.createOnboardingChecklist(
          { candidateId: args.candidateId },
          { requestId: requestId("onboarding", api) },
        );
        return {
          ...textResult(
            [
              `Created onboarding checklist ${checklist.id} for ${checklist.name} (${checklist.opening}), starting ${checklist.startDate}:`,
              ...checklist.steps.map((step) => `- by ${step.due}: ${step.task}`),
              "The checklist is an internal record: nothing has been sent to anyone yet.",
            ].join("\n"),
          ),
          details: { ...checklist, steps: checklist.steps.map((step) => ({ ...step })) },
        };
      } catch (error) {
        return refused(error, { candidateId: args.candidateId });
      }
    },
  });

  const recordTimeOffRequest = defineTool({
    name: "record_time_off_request",
    description:
      "Record a time-off request: the sender's own, or, when a person on the company record files it, the employee they name. It is recorded as pending for the person who decides it; nothing is approved. The desk refuses a request with less notice than the company asks unless the reason may be protected by law (illness, disability, pregnancy or a new child, military, jury duty, family care, bereavement), which is always recorded and sent to a person. It refuses a crew member filing for someone else, and a sender not on staff.",
    parameters: Type.Object(
      {
        employee: Type.Optional(Type.String({ description: EMPLOYEE })),
        startDate: DATE,
        endDate: Type.String({
          description: "The last day off, as YYYY-MM-DD; the start date for one day",
        }),
        reasonCategory: REASON,
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const entry = await desk.recordTimeOffRequest(
          {
            ...(args.employee === undefined ? {} : { employee: args.employee }),
            startDate: args.startDate,
            endDate: args.endDate,
            reasonCategory: args.reasonCategory as ReasonCategory,
            from: await from(api),
          },
          { requestId: requestId("time-off", api) },
        );
        return { ...textResult(timeOffText(entry)), details: { ...entry } };
      } catch (error) {
        return refused(error, args.employee === undefined ? {} : { employee: args.employee });
      }
    },
  });

  const requestTimeOffException = defineTool({
    name: "request_time_off_exception",
    description:
      "Ask a person to approve time off requested with less notice than the company asks, with the daysNotice record_time_off_request's refusal stated and why. Every call waits for a person; once approved, the desk records the time off as approved by them.",
    parameters: Type.Object(
      {
        employee: Type.Optional(Type.String({ description: EMPLOYEE })),
        startDate: DATE,
        endDate: Type.String({ description: "The last day off, as YYYY-MM-DD" }),
        reasonCategory: REASON,
        daysNotice: Type.Integer({
          minimum: 0,
          description:
            "The days of notice, exactly as record_time_off_request's refusal stated them",
        }),
        why: Type.String({
          description: "Why the employee needs it at short notice, in their words",
        }),
        // Pi Durable re-validates the arguments the gate returns, so the gate's key is declared.
        [APPROVED_FACTS_ARG]: approvedFactsParameter(),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return refusal(
          "Nothing was recorded: this call carries no facts a person approved. A short-notice exception is recorded only after the approval gate has put it to a person and they said yes. Next: tell the employee it needs a person's approval and nothing was recorded.",
          { code: "not_approved" },
        );
      }
      try {
        const entry = await desk.requestTimeOffException(
          { ...exceptionInput(args), from: await from(api), approved },
          { requestId: requestId("time-off-exception", api) },
        );
        return { ...textResult(timeOffText(entry)), details: { ...entry } };
      } catch (error) {
        return refused(error, args.employee === undefined ? {} : { employee: args.employee });
      }
    },
  });

  const exceptionFacts: ApprovalFactsReader = async (args, _context, call) => {
    const desk = requireDesk(dependencies);
    let facts: Awaited<ReturnType<PeopleOpsDesk["timeOffExceptionFacts"]>>;
    try {
      facts = await desk.timeOffExceptionFacts({ ...exceptionInput(args), from: await from(call) });
    } catch (error) {
      // Nobody is asked about a request the desk would refuse; the model reads why, with its step.
      if (!(error instanceof PeopleOpsDeskError)) throw error;
      throw new Error(`${error.message}${hints[error.code]} Nothing was put to a person.`);
    }
    return {
      summary: `Approve time off for ${facts.employee}, ${facts.startDate} to ${facts.endDate} (${facts.businessDays} business ${facts.businessDays === 1 ? "day" : "days"}, Monday to Friday), ${reasonWords(facts.reasonCategory)}, with ${facts.daysNotice} days' notice where the company asks for ${facts.noticeDays}`,
      facts: { ...facts },
    };
  };

  const listAvailability = defineTool({
    name: "list_availability",
    description:
      "List crew members' availability for one week (Monday to Sunday): the days each one has approved time off. Availability only: no reasons, contact or personal details.",
    parameters: Type.Object(
      {
        weekOf: Type.Optional(
          Type.String({
            description: "Any date in the week, as YYYY-MM-DD; this week when left out",
          }),
        ),
        crewId: Type.Optional(Type.String({ description: "Only this crew, e.g. cleaning-north" })),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const desk = requireDesk(dependencies);
      try {
        const crews = await desk.listAvailability({
          ...(args.weekOf === undefined ? {} : { weekOf: args.weekOf }),
          ...(args.crewId === undefined ? {} : { crewId: args.crewId }),
        });
        return {
          ...textResult(availabilityText(crews)),
          details: {
            found: crews.length > 0,
            crews: crews.map((crew) => ({
              ...crew,
              members: crew.members.map((member) => ({
                ...member,
                unavailable: [...member.unavailable],
              })),
            })),
          },
        };
      } catch (error) {
        return refused(error, { found: false });
      }
    },
  });

  const getLeaveBalance = defineTool({
    name: "get_leave_balance",
    description:
      "The sender's own leave this year: their allowance, the approved days, and the days left, worked out by the desk. It takes no employee: the desk knows who sent the message, and nobody gets another person's balance. Refused for a sender who is not on staff.",
    parameters: Type.Object({}, { additionalProperties: false }),
    replay: "safe",
    execute: async (_args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const balance = await desk.leaveBalance({ from: await from(api) });
        return {
          ...textResult(balanceText(balance)),
          details: { ...balance, approved: balance.approved.map((entry) => ({ ...entry })) },
        };
      } catch (error) {
        return refused(error, {});
      }
    },
  });

  const referToPerson = defineTool({
    name: "refer_to_person",
    description:
      "Hand a matter to the person the company names for it: pay (a pay question or a raise), discipline, termination, employee_relations (harassment or how someone is treated at work), accommodation, or records_request (someone asking for a copy of their own personnel file or records, or for their data to be corrected or deleted). Give who it is about for discipline, termination and employee_relations: the desk never hands it to anyone named there. An internal hand-off: it decides nothing.",
    parameters: Type.Object(
      {
        topic: literals(REFERRAL_TOPICS, "What the matter is"),
        summary: Type.String({
          description: "What the person needs to know, in the sender's words",
        }),
        about: Type.Optional(
          Type.String({
            description:
              "Who it is about. When the sender describes someone by their job (HR, the office manager, my supervisor), find their name with read_company (people) first and give it here with the sender's words",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const referral = await desk.referToPerson(
          {
            topic: args.topic as ReferralTopic,
            summary: args.summary,
            ...(args.about === undefined ? {} : { about: args.about }),
          },
          { requestId: requestId("refer", api) },
        );
        const holder = personLabel({ id: "", name: referral.toName, title: referral.toTitle });
        const rerouted = referral.rerouted
          ? " It names the person it would normally go to, so it is with someone else: never say it is with anyone it names."
          : "";
        return {
          ...textResult(
            `Handed ${referral.id} (${referral.topic.replaceAll("_", " ")}) to ${holder}.${rerouted} This is an internal hand-off: nothing has been sent to anyone, and nothing is decided. Tell them ${holder} has it; do not say when they will reply.`,
          ),
          details: { ...referral },
        };
      } catch (error) {
        return refused(error, { topic: args.topic });
      }
    },
  });

  const readCompany = defineTool({
    name: "read_company",
    description:
      "Read one section of the company record: the profile, the hours, the people (names, titles and what each decides), the crews, the staff policies (notice, and who takes pay, discipline, protected leave and workplace complaints), the tone of voice, the escalation path or the glossary.",
    parameters: Type.Object(
      { section: literals(SECTIONS, "Which part of the record to read") },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const section = args.section as CompanySection;
      return { ...textResult(companySection(company, section)), details: { section } };
    },
  });

  return {
    listCandidates,
    updateCandidateStage,
    onboardingChecklist,
    recordTimeOffRequest,
    requestTimeOffException,
    listAvailability,
    getLeaveBalance,
    referToPerson,
    readCompany,
    exceptionFacts,
  };
}
