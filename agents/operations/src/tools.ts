/**
 * The Operations role's eight tools.
 *
 * `list_jobs`, `list_crews` and `read_company` only read. `assign_crew`, `reschedule_job` and
 * `record_callout` write through the desk with no approval: the desk refuses an assignment past a
 * crew's weekly hours cap or on approved time off, and a move of a contract visit, and each refusal
 * names the approval-gated tool that asks a person. `request_overtime` and
 * `request_contract_reschedule` are those tools; their approvals are `officehum.json`'s, evaluated by
 * the SDK's gate before the tool runs (overtime's only while the company's staff policy requires it,
 * a condition `index.ts` passes), so this file holds no hours limit and no approval rule.
 *
 * Every hours figure a tool speaks comes back from the desk, and every name from the company record.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { deskRefusal, refusal, requestId, textResult } from "@officehum/sdk";
import { type CompanyFacts, person, personLabel, scheduleOwner } from "./company.js";
import {
  type Assignment,
  type CrewWeek,
  type DeskRefusal,
  type Job,
  type OperationsDesk,
  OperationsDeskError,
  type Reschedule,
} from "./desk.js";

/** What the tools need: the desk, and the company whose crews it schedules. */
export interface OperationsToolDependencies {
  readonly desk: OperationsDesk | undefined;
  readonly company: CompanyFacts;
}

/** The eight tools, named, so the factory places each one where the manifest declares it. */
export interface OperationsToolset {
  readonly listJobs: ToolRegistration;
  readonly listCrews: ToolRegistration;
  readonly assignCrew: ToolRegistration;
  readonly requestOvertime: ToolRegistration;
  readonly rescheduleJob: ToolRegistration;
  readonly requestContractReschedule: ToolRegistration;
  readonly recordCallout: ToolRegistration;
  readonly readCompany: ToolRegistration;
}

/** The company section `read_company` can answer for. */
export type CompanySection =
  | "profile"
  | "hours"
  | "people"
  | "services"
  | "crews"
  | "policies"
  | "tone"
  | "escalation"
  | "glossary";

const SECTIONS: readonly CompanySection[] = [
  "profile",
  "hours",
  "people",
  "services",
  "crews",
  "policies",
  "tone",
  "escalation",
  "glossary",
];

const DATE = Type.String({ description: "A date as YYYY-MM-DD, e.g. 2026-11-12" });

/** The desk, or a refusal: a host with no desk gets no read and no write. */
function requireDesk(dependencies: OperationsToolDependencies): OperationsDesk {
  if (dependencies.desk === undefined) {
    throw new Error(
      "No operations desk is bound to this role, so nothing was read or written. The host passes its system of record as `desk`, or sets `demo` to run on the demonstration data.",
    );
  }
  return dependencies.desk;
}

/** Hours as a person reads them. */
function hours(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function jobLine(job: Job): string {
  const crew = job.crewId === null ? "no crew yet" : `crew ${job.crewId}`;
  const kind = job.contractId === null ? "one-off" : `recurring contract ${job.contractId}`;
  return `${job.id} — ${job.date} ${job.start} — ${job.client} — ${job.service} — ${job.site} — ${hours(job.crewHours)} crew-hours — ${crew} — ${kind} — ${job.notes}`;
}

/**
 * How recorded overtime is described: "approved" only while the company requires a person to approve
 * it. With approval off nobody approved it, and the text must not say anyone did.
 */
function overtimeLabel(approvalRequired: boolean): string {
  return approvalRequired ? "approved overtime hours" : "overtime hours";
}

function crewLine(crew: CrewWeek, approvalRequired: boolean): string {
  const overtime =
    crew.overtimeHours === 0
      ? ""
      : ` (with ${hours(crew.overtimeHours)} ${overtimeLabel(approvalRequired)})`;
  const off =
    crew.timeOff.length === 0
      ? ""
      : ` — approved time off on ${crew.timeOff.map((entry) => entry.date).join(", ")}: not bookable those days`;
  return `${crew.crewId} — ${crew.name} (${crew.members} people) — ${hours(crew.bookedHours)} of ${hours(crew.weeklyHoursCap)} hours booked, ${hours(crew.hoursLeft)} left${overtime}${off}`;
}

function weekText(assignment: Assignment, approvalRequired: boolean): string {
  const overtime =
    assignment.overtimeHours === 0
      ? ""
      : ` plus ${hours(assignment.overtimeHours)} ${overtimeLabel(approvalRequired)}`;
  return `For ${assignment.crewName}, the week of ${assignment.weekStart} now has ${hours(assignment.bookedHours)} hours booked against a weekly cap of ${hours(assignment.weeklyHoursCap)}${overtime}.`;
}

function moveText(move: Reschedule): string {
  const contract = move.contractId === null ? "" : `, contract ${move.contractId}`;
  const reason = move.reason === null ? "" : ` Reason: ${move.reason}.`;
  return `Moved ${move.jobId} (${move.client}${contract}) from ${move.fromDate} to ${move.toDate}.${reason}`;
}

/** The company record as one section reads: prose the model can answer with. */
function companySection(company: CompanyFacts, section: CompanySection): string {
  const named = (id: string) => person(company, id)?.name ?? id;
  switch (section) {
    case "profile": {
      const { profile } = company;
      return [
        `${profile.legalName} — trading as ${profile.tradingName}. ${profile.tagline}`,
        `${profile.address.street}, ${profile.address.city}, ${profile.address.region} ${profile.address.postalCode}. Phone ${profile.phone}. Email ${profile.email}.`,
        `Service area: ${profile.serviceArea}`,
        `Clients: ${profile.clients}`,
      ].join("\n");
    }
    case "hours": {
      const { hours: open } = company;
      return [
        `Office: ${open.office} (${open.timezone}).`,
        `Crews: ${open.crews}.`,
        `Emergency line: ${open.emergencyLine}.`,
        `Closed: ${open.closedOn}.`,
        open.note,
      ].join("\n");
    }
    case "people":
      return company.people
        .map(
          (worker) =>
            `${worker.name} — ${worker.title} — ${worker.email} — decides: ${worker.decides.join("; ")}`,
        )
        .join("\n");
    case "services":
      return company.services
        .map(
          (service) =>
            `${service.name} — ${service.summary} Lead time about ${service.leadTimeDays} days.`,
        )
        .join("\n");
    case "crews": {
      const staff = company.staffPolicies;
      return [
        ...company.crews.map(
          (crew) =>
            `${crew.id} — ${crew.name} — ${crew.members} people — ${crew.weeklyHoursCap} hours a week before overtime — led by ${crew.leadPersonId === null ? "a cleaner from the crew" : named(crew.leadPersonId)}`,
        ),
        staff.overtimeNeedsApproval
          ? "Overtime needs a person's approval before it is worked."
          : "Overtime does not need a person's approval before it is worked.",
        `Time off is requested at least ${staff.timeOffNoticeDays} days ahead.`,
        `Questions about pay: ${named(staff.payQuestionsTo)}. Discipline: ${named(staff.disciplineTo)}.`,
      ].join("\n");
    }
    case "policies":
      return [
        "Safety:",
        ...company.policies.safety.map((rule) => `- ${rule}`),
        "Never promised:",
        ...company.policies.commitments.map((rule) => `- ${rule}`),
      ].join("\n");
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
        .map((rule) => {
          const owner = person(company, rule.toPersonId);
          return `${rule.topic} — ${owner?.name ?? rule.toPersonId}${owner === undefined ? "" : `, ${owner.title}`} — ${rule.when}`;
        })
        .join("\n");
    case "glossary":
      return company.glossary.map((entry) => `${entry.term}: ${entry.meaning}`).join("\n");
  }
}

/**
 * Builds the eight tools over one desk and one company. Every one is plain Pi Durable: they install
 * into any harness, and a harness with no desk builds the same tools and refuses at the point of use.
 */
export function operationsTools(dependencies: OperationsToolDependencies): OperationsToolset {
  const { company } = dependencies;
  const owner = personLabel(scheduleOwner(company));
  // The same policy the role's gate reads (index.ts), so a result never claims an approval the gate
  // did not ask for.
  const approvalRequired = company.staffPolicies.overtimeNeedsApproval;

  /** A desk refusal as the model reads it, with the next step that a person can take. */
  const refused = (error: unknown, extra: JsonObject) => {
    // Typed loosely on purpose: a refusal's details and a receipt's share one tool, so neither may
    // narrow what the other reports.
    if (!(error instanceof OperationsDeskError)) throw error;
    // The next step comes from the refusal's code, never from reading its message.
    const next: Record<DeskRefusal, string> = {
      over_cap: ` request_overtime asks ${owner}.`,
      recurring: ` request_contract_reschedule asks ${owner}.`,
      contract_crew: ` That is ${owner}: hand it to them, and do not call another tool for it.`,
      over_cap_move: ` The schedule's owner is ${owner}.`,
      // The desk's own message already says what to do for these.
      not_found: "",
      invalid: "",
      time_off: "",
      fits: "",
      one_off: "",
    };
    return deskRefusal(`${error.message}${next[error.code]}`, error.code, {
      ...(error.overtimeHoursNeeded === undefined
        ? {}
        : { overtimeHoursNeeded: error.overtimeHoursNeeded }),
      ...extra,
    });
  };

  const listJobs = defineTool({
    name: "list_jobs",
    description:
      "List the scheduled jobs, optionally filtered by date, crew or client. Returns each job's id, date and start, client, site, crew-hours, crew, and whether it is a one-off job or a visit on a recurring contract.",
    parameters: Type.Object(
      {
        date: Type.Optional(DATE),
        crewId: Type.Optional(
          Type.String({ description: "Only this crew's jobs, by its id from list_crews" }),
        ),
        client: Type.Optional(
          Type.String({ description: "All or part of the client's name, or a job id like J-2101" }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const desk = requireDesk(dependencies);
      const jobs = await desk.listJobs({
        ...(args.date === undefined ? {} : { date: args.date }),
        ...(args.crewId === undefined ? {} : { crewId: args.crewId }),
        ...(args.client === undefined ? {} : { client: args.client }),
      });
      const details = { found: jobs.length > 0, jobs: jobs.map((job) => ({ ...job })) };
      if (jobs.length === 0) {
        return refusal(
          "No job matches that. Try another spelling, part of the client's name, or fewer filters.",
          details,
        );
      }
      return {
        ...textResult([`Jobs (${jobs.length}):`, ...jobs.map(jobLine)].join("\n")),
        details,
      };
    },
  });

  const listCrews = defineTool({
    name: "list_crews",
    description:
      "List the crews for one week (Monday to Sunday): each crew's hours booked, its weekly hours cap, any approved overtime, the hours left, and any approved time off. The figures are the desk's.",
    parameters: Type.Object(
      {
        weekOf: Type.Optional(
          Type.String({
            description: "Any date in the week, as YYYY-MM-DD; this week when left out",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const desk = requireDesk(dependencies);
      try {
        const crews = await desk.listCrews(
          args.weekOf === undefined ? {} : { weekOf: args.weekOf },
        );
        const first = crews[0];
        const heading =
          first === undefined
            ? "No crews are set up."
            : `Crews for the week of ${first.weekStart} to ${first.weekEnd}:`;
        return {
          ...textResult(
            [heading, ...crews.map((crew) => crewLine(crew, approvalRequired))].join("\n"),
          ),
          details: {
            found: crews.length > 0,
            crews: crews.map((crew) => ({
              ...crew,
              timeOff: crew.timeOff.map((entry) => ({ ...entry })),
            })),
          },
        };
      } catch (error) {
        return refused(error, { found: false });
      }
    },
  });

  const assignCrew = defineTool({
    name: "assign_crew",
    description:
      "Assign a crew to a job. The desk adds the job's hours to the crew's week and refuses when that would pass the crew's weekly hours cap (then use request_overtime), or when the crew has approved time off that day. A visit on a recurring contract keeps its crew: a different one is a person's decision.",
    parameters: Type.Object(
      {
        jobId: Type.String({ description: "The job's id from list_jobs, e.g. J-2101" }),
        crewId: Type.String({ description: "The crew's id from list_crews, e.g. cleaning-north" }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const assignment = await desk.assignCrew(
          { jobId: args.jobId, crewId: args.crewId },
          { requestId: requestId("assign", api) },
        );
        return {
          ...textResult(
            `Assigned ${assignment.crewName} to ${assignment.jobId} (${assignment.client}, ${assignment.date}, ${hours(assignment.crewHours)} crew-hours). ${weekText(assignment, approvalRequired)}`,
          ),
          details: { ...assignment },
        };
      } catch (error) {
        return refused(error, { jobId: args.jobId, crewId: args.crewId });
      }
    },
  });

  const requestOvertime = defineTool({
    name: "request_overtime",
    description:
      "Ask for overtime so a crew can take a job its weekly hours cap cannot hold. Use the hours assign_crew's refusal stated. It waits for a person while the company requires approval for overtime; once approved, or when the company does not require approval, the desk records the overtime and assigns the crew.",
    parameters: Type.Object(
      {
        crewId: Type.String({ description: "The crew's id, e.g. cleaning-central" }),
        jobId: Type.String({ description: "The job the overtime is for, e.g. J-2101" }),
        hours: Type.Number({
          exclusiveMinimum: 0,
          description: "The overtime hours, exactly as assign_crew's refusal stated them",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const grant = await desk.requestOvertime(
          { crewId: args.crewId, jobId: args.jobId, hours: args.hours },
          { requestId: requestId("overtime", api) },
        );
        // Said from the policy the gate applied: "approved" only when a person had to approve it.
        const recorded = approvalRequired
          ? `Overtime ${grant.id} approved and recorded:`
          : `Overtime ${grant.id} recorded; the company does not require approval for overtime:`;
        return {
          ...textResult(
            `${recorded} ${hours(grant.hours)} hours for ${grant.crewName} in the week of ${grant.weekStart}. Assigned ${grant.crewName} to ${grant.jobId} (${grant.client}, ${grant.date}). ${weekText(grant, approvalRequired)}`,
          ),
          details: { ...grant },
        };
      } catch (error) {
        return refused(error, { crewId: args.crewId, jobId: args.jobId });
      }
    },
  });

  const rescheduleJob = defineTool({
    name: "reschedule_job",
    description:
      "Move a one-off job to a new date. A visit on a recurring contract is refused here: use request_contract_reschedule. The desk also refuses a date the job's crew has approved time off, or a week its hours cap cannot take.",
    parameters: Type.Object(
      {
        jobId: Type.String({ description: "The job's id from list_jobs" }),
        newDate: DATE,
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const moved = await desk.rescheduleJob(
          { jobId: args.jobId, newDate: args.newDate },
          { requestId: requestId("reschedule", api) },
        );
        return { ...textResult(moveText(moved)), details: { ...moved } };
      } catch (error) {
        return refused(error, { jobId: args.jobId });
      }
    },
  });

  const requestContractReschedule = defineTool({
    name: "request_contract_reschedule",
    description:
      "Ask a person to approve moving a visit on a recurring contract to a new date, with the client's reason. Every call waits for a person; once approved, the desk moves the visit.",
    parameters: Type.Object(
      {
        jobId: Type.String({ description: "The contract visit's job id from list_jobs" }),
        newDate: DATE,
        reason: Type.String({ description: "Why the client wants the visit moved" }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const moved = await desk.requestContractReschedule(
          { jobId: args.jobId, newDate: args.newDate, reason: args.reason },
          { requestId: requestId("contract-reschedule", api) },
        );
        return {
          ...textResult(`Approved and done. ${moveText(moved)}`),
          details: { ...moved },
        };
      } catch (error) {
        return refused(error, { jobId: args.jobId });
      }
    },
  });

  const recordCallout = defineTool({
    name: "record_callout",
    description:
      "Record that a client asked for a call-out on a job, and why. An internal record only: it books no crew, sends nothing, and needs no approval. A person decides the call-out.",
    parameters: Type.Object(
      {
        jobId: Type.String({ description: "The job at the client's site, from list_jobs" }),
        reason: Type.String({ description: "What the client reported, in their words" }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const callout = await desk.recordCallout(
          { jobId: args.jobId, reason: args.reason },
          { requestId: requestId("callout", api) },
        );
        return {
          ...textResult(
            `Recorded call-out ${callout.id} on ${callout.jobId} (${callout.client}) at ${callout.at}: ${callout.reason}. This is an internal record only: no crew is booked and nothing is sent to the client. The call-out is for ${owner} to decide.`,
          ),
          details: { ...callout },
        };
      } catch (error) {
        return refused(error, { jobId: args.jobId });
      }
    },
  });

  const readCompany = defineTool({
    name: "read_company",
    description:
      "Read one section of the company record: the profile, the hours, the people and what each decides, the services, the crews with their weekly hours caps and the staff policies, the safety rules and what is never promised, the tone of voice, the escalation path or the glossary.",
    parameters: Type.Object(
      {
        section: Type.Union(
          SECTIONS.map((section) => Type.Literal(section)),
          { description: "Which part of the record to read" },
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const section = args.section as CompanySection;
      return { ...textResult(companySection(company, section)), details: { section } };
    },
  });

  return {
    listJobs,
    listCrews,
    assignCrew,
    requestOvertime,
    rescheduleJob,
    requestContractReschedule,
    recordCallout,
    readCompany,
  };
}
