/**
 * The People Ops role's eight tools.
 *
 * `list_candidates`, `list_availability` and `read_company` only read, and none of them can print a
 * contact or personal detail: the desk holds none and the company section types none. The writes go
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
import { type CompanyFacts, type Person, peopleOwner, person, personLabel } from "./company.js";
import {
  type Candidate,
  type CrewAvailability,
  type DeskRefusal,
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
}

export interface PeopleOpsToolset {
  readonly listCandidates: ToolRegistration;
  readonly updateCandidateStage: ToolRegistration;
  readonly onboardingChecklist: ToolRegistration;
  readonly recordTimeOffRequest: ToolRegistration;
  readonly requestTimeOffException: ToolRegistration;
  readonly listAvailability: ToolRegistration;
  readonly referToPerson: ToolRegistration;
  readonly readCompany: ToolRegistration;
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
  "The employee's name as they gave it: a full name, or a first name or surname alone. The desk finds them and says if more than one person has that name, so never ask for a surname first";

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

function textResult(value: string) {
  return { output: [{ type: "text" as const, text: value }] };
}

function refusal<TDetails extends JsonObject>(value: string, details: TDetails) {
  return { ...textResult(value), isError: true, details };
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
    entry.decidesTitle === "" ? entry.decidesName : `${entry.decidesName} (${entry.decidesTitle})`;
  if (entry.status === "approved") {
    return `Approved by a person and recorded: ${entry.id}, ${span}, with ${entry.daysNotice} days' notice.`;
  }
  if (entry.protected) {
    return `Recorded ${entry.id}: ${span}. Status: pending — not approved. The reason may be protected by law, so it went to ${decides} whatever the notice: it is never refused for short notice, and ${decides} decides it. Do not ask for medical details, and say nothing about whether the law applies.`;
  }
  return `Recorded ${entry.id}: ${span}, with ${entry.daysNotice} days' notice. Status: pending — not approved. ${decides} decides it. This is an internal record: nothing has been sent to anyone.`;
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
 * Builds the eight tools over one desk and one company. Every one is plain Pi Durable: they install
 * into any harness, and a harness with no desk builds the same tools and refuses at the point of use.
 */
export function peopleOpsTools(dependencies: PeopleOpsToolDependencies): PeopleOpsToolset {
  const { company } = dependencies;
  const hints = HINTS(company);
  const hiring = personLabel(peopleOwner(company), "the person who decides hiring");

  const requestId = (
    kind: string,
    api: { conversationId: unknown; taskId: unknown; callId: string },
  ) => `${kind}:${String(api.conversationId)}:${String(api.taskId)}:${api.callId}`;

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
    return refusal<JsonObject>(`${error.message}${next}`, {
      code: error.code,
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
      "Record an employee's time-off request. It is recorded as pending for the person who decides it; nothing is approved. The desk refuses a request with less notice than the company asks unless the reason may be protected by law (illness, disability, pregnancy or a new child, military, jury duty, family care, bereavement), which is always recorded and sent to a person.",
    parameters: Type.Object(
      {
        employee: Type.String({ description: EMPLOYEE }),
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
            employee: args.employee,
            startDate: args.startDate,
            endDate: args.endDate,
            reasonCategory: args.reasonCategory as ReasonCategory,
          },
          { requestId: requestId("time-off", api) },
        );
        return { ...textResult(timeOffText(entry)), details: { ...entry } };
      } catch (error) {
        return refused(error, { employee: args.employee });
      }
    },
  });

  const requestTimeOffException = defineTool({
    name: "request_time_off_exception",
    description:
      "Ask a person to approve time off requested with less notice than the company asks, with the daysNotice record_time_off_request's refusal stated and why. Every call waits for a person; once approved, the desk records the time off as approved by them.",
    parameters: Type.Object(
      {
        employee: Type.String({ description: EMPLOYEE }),
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
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const entry = await desk.requestTimeOffException(
          {
            employee: args.employee,
            startDate: args.startDate,
            endDate: args.endDate,
            reasonCategory: args.reasonCategory as ReasonCategory,
            daysNotice: args.daysNotice,
            why: args.why,
          },
          { requestId: requestId("time-off-exception", api) },
        );
        return { ...textResult(timeOffText(entry)), details: { ...entry } };
      } catch (error) {
        return refused(error, { employee: args.employee });
      }
    },
  });

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

  const referToPerson = defineTool({
    name: "refer_to_person",
    description:
      "Hand a matter to the person the company names for it: pay (a pay question or a raise), discipline, termination, employee_relations (harassment or how someone is treated at work) or accommodation. Give who it is about for discipline, termination and employee_relations: the desk never hands it to anyone named there. An internal hand-off: it decides nothing.",
    parameters: Type.Object(
      {
        topic: literals(REFERRAL_TOPICS, "What the matter is"),
        summary: Type.String({
          description: "What the person needs to know, in the sender's words",
        }),
        about: Type.Optional(
          Type.String({ description: "Who it is about, by name or title, as the sender put it" }),
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
        const holder = `${referral.toName} (${referral.toTitle})`;
        const rerouted = referral.rerouted
          ? " It names the person it would normally go to, so it went to someone else: never say it went to anyone it names."
          : "";
        return {
          ...textResult(
            `Handed ${referral.id} (${referral.topic.replaceAll("_", " ")}) to ${holder}.${rerouted} This is an internal hand-off: nothing has been sent to anyone, and nothing is decided. Tell them ${holder} has it and will come back to them.`,
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
    referToPerson,
    readCompany,
  };
}
