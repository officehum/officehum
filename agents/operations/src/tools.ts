/**
 * The Operations role's eight tools.
 *
 * `list_jobs`, `list_crews` and `read_company` only read. `assign_crew`, `reschedule_job` and
 * `record_callout` write through the desk with no approval: the desk refuses an assignment past a
 * crew's weekly hours cap or on approved time off, and a move of a contract visit, and each refusal
 * names the approval-gated tool that asks a person. `request_overtime` and
 * `request_contract_reschedule` are those tools; their approvals are `officehum.json`'s, evaluated by
 * the SDK's gate before the tool runs (overtime's only while the company's staff policy requires it,
 * a condition `index.ts` passes), so this file holds no hours limit and no approval rule. It does
 * hold what the person is shown: `overtimeFacts` and `contractRescheduleFacts` read the crew, the
 * client, the dates and the hours from the desk before the gate asks anyone.
 *
 * Every hours figure a tool speaks comes back from the desk, and every name from the company record.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  APPROVED_FACTS_ARG,
  type ApprovalFactsReader,
  approvedFactsParameter,
  companyEscalationText,
  companyGlossaryText,
  companyHoursText,
  companyPeopleText,
  companyPoliciesText,
  companyProfileText,
  companyToneText,
  deskRefusal,
  readCompanyTool,
  refusal,
  requestId,
  requireDesk,
  textResult,
} from "@officehum/sdk";
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
  /**
   * The `overtime` approval's facts: the crew by name, the job's client, date and hours, and the
   * crew's week, read from the desk before anyone is asked.
   */
  readonly overtimeFacts: ApprovalFactsReader;
  /** The `contract_reschedule` approval's facts: the visit's client, contract, crew and both dates. */
  readonly contractRescheduleFacts: ApprovalFactsReader;
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

const DATE = Type.String({ description: "A date as YYYY-MM-DD, e.g. 2026-11-12" });

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

/** The services the company sells, with their lead times. */
function servicesText(company: CompanyFacts): string {
  return company.services
    .map(
      (service) =>
        `${service.name} — ${service.summary} Lead time about ${service.leadTimeDays} days.`,
    )
    .join("\n");
}

/** The crews with their weekly hours caps, and the staff policies with who answers each. */
function crewsText(company: CompanyFacts): string {
  const named = (id: string) => person(company, id)?.name ?? id;
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

/** Each section `read_company` answers for and how it reads, in the order the model is offered them. */
const COMPANY_SECTIONS: Readonly<Record<CompanySection, (company: CompanyFacts) => string>> = {
  profile: companyProfileText,
  hours: companyHoursText,
  people: (company) => companyPeopleText(company, "email"),
  services: servicesText,
  crews: crewsText,
  policies: companyPoliciesText,
  tone: companyToneText,
  escalation: companyEscalationText,
  glossary: companyGlossaryText,
};

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

  /**
   * The job and crew a gated call names, as the desk holds them. A reader that cannot find one
   * throws, so the gate asks nobody about something that is not on the schedule.
   */
  const jobFor = async (desk: OperationsDesk, jobId: string): Promise<Job> => {
    const wanted = jobId.trim();
    const job = (await desk.listJobs({ client: wanted })).find(
      (candidate) => candidate.id === wanted,
    );
    if (job === undefined) {
      throw new Error(
        `No job has the id ${JSON.stringify(jobId)}. Nothing was put to a person. Next: find it with list_jobs, by date, crew or client.`,
      );
    }
    return job;
  };

  const crewFor = async (desk: OperationsDesk, crewId: string, date: string): Promise<CrewWeek> => {
    const crew = (await desk.listCrews({ weekOf: date })).find(
      (candidate) => candidate.crewId === crewId.trim(),
    );
    if (crew === undefined) {
      throw new Error(
        `No crew has the id ${JSON.stringify(crewId)}. Nothing was put to a person. Next: find it with list_crews.`,
      );
    }
    return crew;
  };

  const overtimeFacts: ApprovalFactsReader = async (args) => {
    const desk = requireDesk(dependencies.desk, "operations");
    const job = await jobFor(desk, String(args.jobId));
    const crew = await crewFor(desk, String(args.crewId), job.date);
    const overtimeHours = Number(args.hours);
    const already =
      crew.overtimeHours === 0
        ? ""
        : `, with ${hours(crew.overtimeHours)} ${overtimeLabel(approvalRequired)} already`;
    return {
      summary: `Approve ${hours(overtimeHours)} hours of overtime for ${crew.name} so it can take ${job.id}: ${job.client}, ${job.service}, on ${job.date} (${hours(job.crewHours)} crew-hours). In the week of ${crew.weekStart} the crew has ${hours(crew.bookedHours)} of its ${hours(crew.weeklyHoursCap)} hours booked${already}.`,
      facts: {
        crewId: crew.crewId,
        crewName: crew.name,
        jobId: job.id,
        client: job.client,
        site: job.site,
        service: job.service,
        date: job.date,
        crewHours: job.crewHours,
        overtimeHours,
        weekStart: crew.weekStart,
        bookedHours: crew.bookedHours,
        weeklyHoursCap: crew.weeklyHoursCap,
      },
    };
  };

  const contractRescheduleFacts: ApprovalFactsReader = async (args) => {
    const desk = requireDesk(dependencies.desk, "operations");
    const job = await jobFor(desk, String(args.jobId));
    if (job.contractId === null) {
      throw new Error(
        `${job.id} is a one-off job, not a visit on a recurring contract: move it with reschedule_job. Nothing was put to a person.`,
      );
    }
    const crewName =
      job.crewId === null ? "no crew yet" : (await crewFor(desk, job.crewId, job.date)).name;
    const toDate = String(args.newDate).trim();
    const reason = String(args.reason)
      .trim()
      .replace(/[.\s]+$/, "");
    return {
      summary: `Move ${job.id} (${job.client}, ${job.service}, contract ${job.contractId}, ${crewName}) from ${job.date} to ${toDate}. The client's reason: ${reason}.`,
      facts: {
        jobId: job.id,
        client: job.client,
        site: job.site,
        service: job.service,
        contractId: job.contractId,
        crewId: job.crewId,
        crewName,
        fromDate: job.date,
        toDate,
        reason,
      },
    };
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
      const desk = requireDesk(dependencies.desk, "operations");
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
      const desk = requireDesk(dependencies.desk, "operations");
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
      const desk = requireDesk(dependencies.desk, "operations");
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
        // Pi Durable re-validates the arguments the gate returns, so the gate's key is declared. The
        // facts are what the person was shown; the desk works out the overtime itself at the write.
        [APPROVED_FACTS_ARG]: approvedFactsParameter(),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "operations");
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
      const desk = requireDesk(dependencies.desk, "operations");
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
        // Pi Durable re-validates the arguments the gate returns, so the gate's key is declared.
        [APPROVED_FACTS_ARG]: approvedFactsParameter(),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "operations");
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
      const desk = requireDesk(dependencies.desk, "operations");
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

  const readCompany = readCompanyTool({
    company,
    description:
      "Read one section of the company record: the profile, the hours, the people and what each decides, the services, the crews with their weekly hours caps and the staff policies, the safety rules and what is never promised, the tone of voice, the escalation path or the glossary.",
    sections: COMPANY_SECTIONS,
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
    overtimeFacts,
    contractRescheduleFacts,
  };
}
