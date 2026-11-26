/**
 * The Compliance and Safety role's eleven tools.
 *
 * `list_training_status`, `clearance_check`, `list_incidents`, `get_safety_data_sheet` and
 * `read_company` only read. `record_training_completion`, `log_incident` and `schedule_toolbox_talk`
 * write internal records with no approval, within rules the desk enforces: training currency is
 * worked out from dates, a serious incident's deadline from the role's limits (read here at every call
 * and handed to the desk), medical detail is refused and a privacy case's name never comes back.
 *
 * Three tools are gated, each by an approval in `officehum.json` on every call: a training exception,
 * a recordability decision and a regulator report. The model names only the person and course, or the
 * incident: the facts readers read what the person decides on from the desk, the gate hands those
 * facts to the tool on a yes, and the desk records only what matches them.
 *
 * Every date and deadline a tool speaks comes back from the desk, and every name from the company
 * record or the desk's own records.
 */

import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import {
  APPROVED_FACTS_ARG,
  type ApprovalFactsReader,
  approvedFacts,
  approvedFactsParameter,
  companyClosedLine,
  companyContactLine,
  companyData,
  companyEscalationText,
  companyGlossaryText,
  companyHeadline,
  companyPeopleText,
  companyPoliciesText,
  companyToneText,
  deskRefusal,
  presentLines,
  readCompanyTool,
  refusal,
  requestId,
  requireDesk,
  textResult,
} from "@officehum/sdk";
import { type CompanyFacts, personLabel, safetyOfficer } from "./company.js";
import {
  BASE_INCIDENT_TYPES,
  type Clearance,
  type CourseStatus,
  type DeskRefusal,
  DUE_SOON_DAYS,
  exceptionFacts,
  FATALITY_TYPE,
  type Incident,
  incidentFacts,
  localDateTime,
  type SafetyDesk,
  SafetyDeskError,
  type WorkerTraining,
} from "./desk.js";

/** The role's limits a serious incident's reporting deadline is worked out from (`officehum.json`). */
export const FATALITY_LIMIT = "fatality_report_hours";
export const SEVERE_INJURY_LIMIT = "severe_injury_report_hours";

/** What the tools need: the desk, the company, and the role's resolved limits. */
export interface SafetyToolDependencies {
  readonly desk: SafetyDesk | undefined;
  readonly company: CompanyFacts;
  /**
   * The role's resolved limits, read at every call: the manifest's defaults with the business's
   * overlay on top. Omitted, no deadline resolves and a serious incident's receipt says so.
   */
  readonly limits?: () => Readonly<Record<string, number>>;
}

/** The eleven tools, named, and the readers the three approvals ask with. */
export interface SafetyToolset {
  readonly listTrainingStatus: ToolRegistration;
  readonly recordTrainingCompletion: ToolRegistration;
  readonly clearanceCheck: ToolRegistration;
  readonly requestTrainingException: ToolRegistration;
  readonly logIncident: ToolRegistration;
  readonly requestRecordabilityDecision: ToolRegistration;
  readonly requestRegulatorReport: ToolRegistration;
  readonly listIncidents: ToolRegistration;
  readonly getSafetyDataSheet: ToolRegistration;
  readonly scheduleToolboxTalk: ToolRegistration;
  readonly readCompany: ToolRegistration;
  readonly exceptionApprovalFacts: ApprovalFactsReader;
  readonly recordabilityApprovalFacts: ApprovalFactsReader;
  readonly regulatorApprovalFacts: ApprovalFactsReader;
}

/** The company section `read_company` can answer for. */
export type CompanySection =
  | "profile"
  | "hours"
  | "people"
  | "safety"
  | "policies"
  | "tone"
  | "escalation"
  | "glossary";

const DATE = (description: string) => str({ description: `${description}, as YYYY-MM-DD` });
const PERSON = str({
  minLength: 1,
  description: "The person's full name as on the training record, e.g. Ana Lucero",
});
const INCIDENT_ID = str({ description: "The incident's number, e.g. INC-402" });

/** A desk record as JSON details: a fresh copy, which is what a tool result's details take. */
function json(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function stateText(course: CourseStatus): string {
  switch (course.state) {
    case "never":
      return "NEVER COMPLETED";
    case "overdue":
      return `OVERDUE since ${course.dueOn ?? ""} (last completed ${course.lastCompleted ?? ""})`;
    case "due-soon":
      return `current, DUE SOON on ${course.dueOn ?? ""} (last completed ${course.lastCompleted ?? ""})`;
    default:
      return `current until ${course.dueOn ?? ""} (last completed ${course.lastCompleted ?? ""})`;
  }
}

function trainingLines(worker: WorkerTraining): string[] {
  return [
    `${worker.name} (${worker.crewId}):`,
    ...worker.courses.map(
      (course) => `  - ${course.courseId} (${course.course}): ${stateText(course)}`,
    ),
  ];
}

export function incidentLine(incident: Incident, timeZone: string): string {
  const who = incident.privacyCase
    ? "privacy case, name withheld"
    : (incident.person ?? "no person named");
  const deadline = incident.serious
    ? incident.reportDeadline === null
      ? " — SERIOUS, no reporting deadline set"
      : ` — SERIOUS, reporting deadline ${localDateTime(incident.reportDeadline, timeZone)} (${timeZone})`
    : "";
  const report =
    incident.regulatorReport === null
      ? ""
      : ` — regulator report ${incident.regulatorReport.reference} approved ${incident.regulatorReport.approvedOn}`;
  const recordability =
    incident.recordability === "not-applicable"
      ? ""
      : ` — recordability: ${incident.recordability === "recordable" ? "recordable (a person decided)" : "undecided, for a person to decide"}`;
  return `${incident.id} — ${incident.type} — ${incident.occurredOn} — ${incident.site} — ${who} — ${incident.description}${deadline}${recordability}${report}`;
}

/**
 * Builds the eleven tools over one desk and one company. Every one is plain Pi Durable: they install
 * into any harness, and a harness with no desk builds the same tools and refuses at the point of use.
 */
export function safetyTools(dependencies: SafetyToolDependencies): SafetyToolset {
  const { company } = dependencies;
  const timeZone = company.hours.timezone;
  const officer = safetyOfficer(company);
  const officerText = personLabel(officer, "the safety officer");
  const limit = (name: string): number | undefined => dependencies.limits?.()[name];
  const desk = () => requireDesk(dependencies.desk, "safety");
  // With no safety programme on the record, an incident can still be logged under the base types.
  const types = [...BASE_INCIDENT_TYPES, ...(company.safety?.seriousIncidentTypes ?? [])];
  const local = (iso: string) => `${localDateTime(iso, timeZone)} (${timeZone})`;

  /** A desk refusal as the model reads it, with the next step. */
  const refused = (error: unknown, extra: Record<string, unknown>) => {
    if (!(error instanceof SafetyDeskError)) throw error;
    // The next step comes from the refusal's code, never from reading its message.
    const next: Record<DeskRefusal, string> = {
      medical_detail:
        " Next: log it again with the description of what happened only; tell the person medical details stay private and are not held here.",
      facts_changed:
        " Next: tell the person it changed after it was put to a person, so nothing was recorded; read it again before anything else.",
      not_found: "",
      ambiguous: "",
      invalid: "",
      not_applicable: "",
      already_decided: "",
      already_reported: "",
      no_sheet: ` Next: tell the person the desk holds no sheet for it and that ${officerText} can find it.`,
    };
    return deskRefusal(`${error.message}${next[error.code]}`, error.code, extra);
  };

  const notApproved = (what: string, extra: Record<string, unknown>) =>
    refusal(
      `Nothing was recorded: this call for ${what} carries no facts a person approved. It is recorded only after the approval gate has put it to a person and they said yes. Next: tell the person it needs a person's decision and nothing was recorded.`,
      { code: "not_approved", ...extra },
    );

  const listTrainingStatus = defineTool({
    name: "list_training_status",
    description:
      "List required training for one person, a crew, or everyone: each course's last completion, the day it runs out, and whether it is current, due soon, overdue or never completed, all worked out by the desk from the dates and each course's renewal period. Filter to what is not current (overdue or never done) or due soon. Names and courses only.",
    parameters: obj({
      person: opt(PERSON),
      crewId: opt(str({ description: "A crew's id from read_company, e.g. maintenance" })),
      state: opt(
        union([lit("not-current"), lit("due-soon")], {
          description: "not-current: overdue or never done; due-soon: current but running out soon",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args) => {
      try {
        const workers = await desk().trainingStatus({
          ...(args.person === undefined ? {} : { person: args.person }),
          ...(args.crewId === undefined ? {} : { crewId: args.crewId }),
          ...(args.state === undefined ? {} : { state: args.state as "not-current" | "due-soon" }),
        });
        return {
          ...textResult(
            workers.length === 0
              ? "Nobody matches that: no course in that state."
              : [
                  `Training, worked out by the desk (due soon means within ${DUE_SOON_DAYS} days):`,
                  ...workers.flatMap(trainingLines),
                ].join("\n"),
          ),
          details: { found: workers.length > 0, workers: workers.map(json) },
        };
      } catch (error) {
        return refused(error, {});
      }
    },
  });

  const recordTrainingCompletion = defineTool({
    name: "record_training_completion",
    description:
      "Record that a person completed a required course in a session someone held: the course's id, the date, the trainer, and a summary of what the session covered. The desk works out when it is next due, and refuses an unknown course, one the person's crew does not need, and a date after today. A toolbox talk is not a completion.",
    parameters: obj({
      person: PERSON,
      courseId: str({
        description: "The course's id from read_company safety, e.g. bloodborne-pathogens",
      }),
      completedOn: DATE("The day the session was held"),
      trainer: str({ minLength: 1, description: "Who gave the training" }),
      contentSummary: str({
        minLength: 1,
        description: "What the session covered, in a few words",
      }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const completion = await desk().recordTrainingCompletion(
          {
            person: args.person,
            courseId: args.courseId,
            completedOn: args.completedOn,
            trainer: args.trainer,
            contentSummary: args.contentSummary,
          },
          { requestId: requestId("completion", api) },
        );
        return {
          ...textResult(
            `Recorded ${completion.id}: ${completion.name} completed ${completion.courseId} (${completion.course}) on ${completion.completedOn}, trainer ${completion.trainer}; covered: ${completion.contentSummary}. The desk works it out as current, next due ${completion.dueOn}. An internal record: nothing is sent.`,
          ),
          details: json(completion),
        };
      } catch (error) {
        return refused(error, { person: args.person });
      }
    },
  });

  const clearanceText = (clearance: Clearance): string => {
    const exceptions =
      clearance.exceptions.length === 0
        ? ""
        : `\nExceptions a person approved: ${clearance.exceptions.map((entry) => `${entry.id} — ${entry.courseId} — for ${entry.job} only (approved ${entry.approvedOn})`).join("; ")}. An exception covers that job only; the training is still not current.`;
    if (clearance.cleared) {
      return `CLEARED: every course ${clearance.name} needs for ${clearance.work} work is current, worked out by the desk.\n${clearance.required.map((course) => `- ${course.courseId}: ${stateText(course)}`).join("\n")}${exceptions}`;
    }
    return `NOT CLEARED: ${clearance.name} is not cleared for ${clearance.work} work, worked out by the desk. Not current:\n${clearance.notCurrent.map((course) => `- ${course.courseId} (${course.course}): ${stateText(course)}`).join("\n")}${exceptions}\nNext: say plainly they are not cleared. The routes are the training itself (record_training_completion once a session is held) or, if someone wants them to do one job anyway, request_training_exception, which a person decides. Do not ask for an exception unless someone asks you to.`;
  };

  const clearanceCheck = defineTool({
    name: "clearance_check",
    description:
      "Say whether a person's required training is current for their own crew's work, or for another crew's work if given, worked out by the desk: cleared or not, the courses that are not current, and any exception a person approved for one job.",
    parameters: obj({
      person: PERSON,
      work: opt(
        str({
          description:
            "The crew id whose work they would do, when it is not their own crew's, e.g. maintenance",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args) => {
      try {
        const clearance = await desk().clearanceCheck({
          person: args.person,
          ...(args.work === undefined ? {} : { work: args.work }),
        });
        return { ...textResult(clearanceText(clearance)), details: json(clearance) };
      } catch (error) {
        return refused(error, { person: args.person });
      }
    },
  });

  /**
   * The `training_exception` approval's facts: the course's state as the desk holds it, read before
   * anyone is asked. A course that is current, or not required of the person, has nothing to except.
   */
  const exceptionApprovalFacts: ApprovalFactsReader = async (args) => {
    const person = String(args.person ?? "");
    const courseId = String(args.courseId ?? "");
    const job = String(args.job ?? "").trim();
    const reason = String(args.reason ?? "").trim();
    let worker: WorkerTraining | undefined;
    try {
      [worker] = await desk().trainingStatus({ person });
    } catch (error) {
      if (error instanceof SafetyDeskError) {
        throw new Error(`${error.message} Nothing was put to a person.`);
      }
      throw error;
    }
    if (worker === undefined) {
      throw new Error(
        `Nobody called ${JSON.stringify(person)} is on the training record. Nothing was put to a person.`,
      );
    }
    const course = worker.courses.find((entry) => entry.courseId === courseId);
    if (course === undefined) {
      throw new Error(
        `${JSON.stringify(courseId)} is not required of ${worker.name}'s crew, so there is nothing to make an exception to. Nothing was put to a person. Their courses are ${worker.courses.map((entry) => entry.courseId).join(", ")}.`,
      );
    }
    if (course.state === "current" || course.state === "due-soon") {
      throw new Error(
        `${worker.name}'s ${course.courseId} is current until ${course.dueOn ?? ""}, so no exception is needed. Nothing was put to a person.`,
      );
    }
    if (job === "" || reason === "") {
      throw new Error(
        "Say the one job the exception is for and the reason. Nothing was put to a person.",
      );
    }
    const standing =
      course.state === "never"
        ? "has never been completed"
        : `is overdue since ${course.dueOn ?? ""}`;
    return {
      summary: `Let ${worker.name} (${worker.crewId}) do this one job although ${course.courseId} (${course.course}) ${standing}: ${job}. Reason: ${reason}. This approves this job only; it does not make the training current.`,
      facts: exceptionFacts(worker, course, job, reason),
    };
  };

  const requestTrainingException = defineTool({
    name: "request_training_exception",
    description:
      "Ask a person to approve an exception to a required course that is not current, for one named job, with the reason. Every call waits for a person, who sees the course's state as the desk holds it. An approved exception covers that job only and never makes the training current.",
    parameters: obj({
      person: PERSON,
      courseId: str({ description: "The course's id, e.g. lockout-tagout" }),
      job: str({
        minLength: 1,
        description: "The one job the exception is for: what, where, when",
      }),
      reason: str({ minLength: 1, description: "Why it is asked for" }),
      // Pi Durable re-validates the arguments the gate returns, so the gate's key is declared.
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return notApproved(`an exception to ${args.courseId} for ${args.person}`, {
          person: args.person,
        });
      }
      try {
        const exception = await desk().recordTrainingException(
          { approved },
          { requestId: requestId("exception", api) },
        );
        return {
          ...textResult(
            `Approved by a person: exception ${exception.id} lets ${exception.name} do this one job without current ${exception.courseId}: ${exception.job}. The training is still not current: it covers this job only, and ${exception.courseId} still needs a session recorded with record_training_completion.`,
          ),
          details: json(exception),
        };
      } catch (error) {
        return refused(error, { person: args.person });
      }
    },
  });

  const logIncident = defineTool({
    name: "log_incident",
    description:
      "Log an incident someone reported: its type, the day it happened, the site, what happened and who was involved. For a serious type the desk states the reporting deadline from when the company was told (now, unless told earlier). An exposure incident is a privacy case: the name is kept off every list. Describe what happened and the general kind of injury only: no diagnosis, treatment, medication or test, which the desk refuses. Never discourage or delay a report.",
    parameters: obj({
      type: union(
        types.map((type) => lit(type)),
        {
          description:
            "injury, illness, near-miss (could have hurt someone), hazard-report, exposure-incident (contact with blood or other potentially infectious material), or a serious type",
        },
      ),
      occurredOn: DATE("The day it happened"),
      site: str({
        minLength: 1,
        description: "Where it happened: the site and the spot",
      }),
      description: str({
        minLength: 1,
        description: "What happened and the general kind of injury, e.g. cut to the left hand",
      }),
      person: opt(str({ description: "Who was hurt or involved, if anyone" })),
      companyToldAt: opt(
        str({
          description:
            "When the company was first told, as YYYY-MM-DDTHH:MM local time, if earlier than now; leave it out when the company is being told now",
        }),
      ),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const incident = await desk().logIncident(
          {
            type: args.type,
            occurredOn: args.occurredOn,
            site: args.site,
            description: args.description,
            ...(args.person === undefined ? {} : { person: args.person }),
            ...(args.companyToldAt === undefined ? {} : { companyToldAt: args.companyToldAt }),
          },
          {
            requestId: requestId("incident", api),
            // The limits are read now, so an overlay's hours are the ones the deadline is worked out from.
            limits: {
              fatalityHours: limit(FATALITY_LIMIT),
              severeInjuryHours: limit(SEVERE_INJURY_LIMIT),
            },
          },
        );
        const lines = [
          `Logged ${incident.id}: ${incident.type} at ${incident.site} on ${incident.occurredOn}. ${incident.description}`,
        ];
        if (incident.serious) {
          lines.push(
            incident.reportDeadline === null
              ? `SERIOUS: the company was told at ${local(incident.companyToldAt)}. No reporting deadline is set for this role, so a person must decide on reporting at once.`
              : `SERIOUS: the company was told at ${local(incident.companyToldAt)}; the reporting deadline is ${local(incident.reportDeadline)}, ${incident.deadlineHours ?? ""} hours from then, worked out by the desk.`,
            `A person must decide on the regulator report: ask now with request_regulator_report (incidentId ${incident.id}). Never say it has been reported.`,
          );
        }
        if (incident.privacyCase) {
          lines.push(
            "Recorded as a privacy case: the person's name is kept off every list and receipt; do not repeat it in your reply. A person is to make a confidential medical evaluation available; this record holds no medical detail.",
          );
        }
        if (incident.handedTo !== null) {
          lines.push(
            `Handed to ${incident.handedTo.name}, ${incident.handedTo.title}, the safety officer: an internal hand-off.`,
          );
        }
        if (incident.recordability === "undecided") {
          lines.push(
            "Recordability: undecided. Whether it is recordable is a person's decision, not yours: never say whether it is.",
          );
        } else {
          lines.push(
            `${officerText} decides what to do about the risk; nothing has been decided about controls.`,
          );
        }
        lines.push("An internal record: nothing is sent outside the company.");
        return { ...textResult(lines.join("\n")), details: json(incident) };
      } catch (error) {
        return refused(error, { type: args.type });
      }
    },
  });

  const listIncidents = defineTool({
    name: "list_incidents",
    description:
      "List logged incidents, or one by its number, by type or dates: type, day, site, what happened, who was involved (a privacy case's name is withheld), the reporting deadline for a serious one, recordability and the regulator report. It holds no medical details. A listed incident is information, never a prompt to request anything.",
    parameters: obj({
      incidentId: opt(INCIDENT_ID),
      type: opt(str({ description: "One incident type, e.g. near-miss" })),
      from: opt(DATE("The first day to include")),
      to: opt(DATE("The last day to include")),
    }),
    replay: "safe",
    execute: async (args) => {
      const incidents = await desk().listIncidents({
        ...(args.incidentId === undefined ? {} : { id: args.incidentId }),
        ...(args.type === undefined ? {} : { type: args.type }),
        ...(args.from === undefined ? {} : { from: args.from }),
        ...(args.to === undefined ? {} : { to: args.to }),
      });
      const details = { found: incidents.length > 0, incidents: incidents.map(json) };
      if (incidents.length === 0) {
        return refusal("No incident matches that. Try the number, or fewer filters.", details);
      }
      return {
        ...textResult(
          [
            `Incidents (${incidents.length}); no medical details are held. This list is information: answer what was asked, and request no report or decision about an incident unless the person asks for one.`,
            ...incidents.map((incident) => incidentLine(incident, timeZone)),
          ].join("\n"),
        ),
        details,
      };
    },
  });

  const findIncident = async (args: Record<string, unknown>): Promise<Incident> => {
    const id = String(args.incidentId ?? "");
    const [incident] = await desk().listIncidents({ id });
    if (incident === undefined) {
      throw new Error(
        `No incident has the number ${JSON.stringify(id)}. Nothing was put to a person. Next: find it with list_incidents.`,
      );
    }
    return incident;
  };

  /**
   * The `recordability` approval's facts: the incident as the desk holds it, without any name. A near
   * miss or hazard report has nobody hurt, and a decided one has nothing left to decide.
   */
  const recordabilityApprovalFacts: ApprovalFactsReader = async (args) => {
    const incident = await findIncident(args);
    if (incident.recordability === "not-applicable") {
      throw new Error(
        `${incident.id} is a ${incident.type}: nobody was hurt or ill, so there is nothing to record on the injury and illness log. Nothing was put to a person.`,
      );
    }
    if (incident.recordability === "recordable") {
      throw new Error(
        `${incident.id} is already entered as recordable. Nothing was put to a person.`,
      );
    }
    return {
      summary: `Decide whether ${incident.id} is recordable on the injury and illness log: ${incident.type} on ${incident.occurredOn} at ${incident.site}: ${incident.description}.${incident.privacyCase ? " A privacy case: the name is withheld." : ""} Approve to enter it as recordable; decline to keep it off the log.`,
      facts: incidentFacts(incident),
    };
  };

  const requestRecordabilityDecision = defineTool({
    name: "request_recordability_decision",
    description:
      "Ask a person to decide whether one logged injury, illness or exposure is recordable on the injury and illness log, named by its number. Every call waits for a person, who sees the incident as the desk holds it; once approved, the desk enters it as recordable. You never decide or say whether it is recordable.",
    parameters: obj({
      incidentId: INCIDENT_ID,
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return notApproved(`a recordability decision on ${args.incidentId}`, {
          incidentId: args.incidentId,
        });
      }
      try {
        const incident = await desk().recordRecordability(
          { incidentId: args.incidentId, approved },
          { requestId: requestId("recordability", api) },
        );
        return {
          ...textResult(
            `A person decided ${incident.id} is recordable: it is entered on the injury and illness log as recordable.`,
          ),
          details: json(incident),
        };
      } catch (error) {
        return refused(error, { incidentId: args.incidentId });
      }
    },
  });

  /**
   * The `regulator_report` approval's facts: the incident, when the company was told and the deadline,
   * with what the person making the report needs: the site, the time and a contact.
   */
  const regulatorApprovalFacts: ApprovalFactsReader = async (args) => {
    const incident = await findIncident(args);
    if (incident.regulatorReport !== null) {
      throw new Error(
        `${incident.id} already has its regulator report approved (${incident.regulatorReport.reference}, ${incident.regulatorReport.approvedOn}). Nothing was put to a person.`,
      );
    }
    const deadline =
      incident.reportDeadline === null
        ? "No reporting deadline is set for this role."
        : `The reporting deadline is ${local(incident.reportDeadline)}.`;
    return {
      summary: `Approve the regulator report for ${incident.id}: ${incident.type} at ${incident.site} on ${incident.occurredOn}: ${incident.description}. The company was told at ${local(incident.companyToldAt)}. ${deadline} Contact: ${officerText}, ${company.profile.phone}. The responsible person makes the report.`,
      facts: incidentFacts(incident),
    };
  };

  const requestRegulatorReport = defineTool({
    name: "request_regulator_report",
    description:
      "Ask a person to approve the regulator report for one logged incident, named by its number: only for a serious incident you logged in this conversation, or when the person asks for the report. Every call waits for a person, who sees the incident, when the company was told and the deadline as the desk holds them. You never make or promise the report yourself.",
    parameters: obj({
      incidentId: INCIDENT_ID,
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return notApproved(`the regulator report on ${args.incidentId}`, {
          incidentId: args.incidentId,
        });
      }
      try {
        const incident = await desk().recordRegulatorReport(
          { incidentId: args.incidentId, approved },
          { requestId: requestId("regulator-report", api) },
        );
        const report = incident.regulatorReport;
        const where =
          report?.submittedTo === null || report?.submittedTo === undefined
            ? `Nothing was sent to any regulator: this desk files nothing, so the responsible person makes the report${incident.reportDeadline === null ? "" : ` before ${local(incident.reportDeadline)}`}.`
            : `The desk sent it to ${report.submittedTo}.`;
        return {
          ...textResult(
            `Approved by a person: the regulator report for ${incident.id} is recorded as ${report?.reference ?? ""} on ${report?.approvedOn ?? ""}. ${where}`,
          ),
          details: json(incident),
        };
      } catch (error) {
        return refused(error, { incidentId: args.incidentId });
      }
    },
  });

  const getSafetyDataSheet = defineTool({
    name: "get_safety_data_sheet",
    description:
      "Read the safety data sheet for a chemical on the company's supply catalog, by its id or name: signal word, hazards, handling, protective equipment, storage, what never to mix it with, first-aid measures and spills, as the sheet states them. A sheet is not a risk assessment.",
    parameters: obj({
      chemical: str({
        minLength: 1,
        description: "The chemical's supply catalog id or name, e.g. disinfectant",
      }),
    }),
    replay: "safe",
    execute: async (args) => {
      try {
        const sheet = await desk().safetyDataSheet(args.chemical);
        return {
          ...textResult(
            [
              `Safety data sheet: ${sheet.product} (${sheet.chemicalId}), revised ${sheet.revised}. As the sheet states it:`,
              `- Signal word: ${sheet.signalWord}`,
              `- Hazards: ${sheet.hazards.join("; ")}`,
              `- Handling: ${sheet.handling}`,
              `- Protective equipment: ${sheet.protection}`,
              `- Storage: ${sheet.storage}`,
              `- Do not mix with: ${sheet.incompatible}`,
              `- First-aid measures (the sheet's own words, not medical advice): ${sheet.firstAid}`,
              `- Spills: ${sheet.spill}`,
              `A safety data sheet is not a risk assessment: whether a particular task is safe is for ${officerText} to assess. In an emergency, call the emergency number.`,
            ].join("\n"),
          ),
          details: json(sheet),
        };
      } catch (error) {
        return refused(error, { chemical: args.chemical });
      }
    },
  });

  const scheduleToolboxTalk = defineTool({
    name: "schedule_toolbox_talk",
    description:
      "Schedule a short toolbox talk for a crew: the topic, the date and who leads it. A talk reinforces training; it is never recorded as anyone's training completion and renews no course.",
    parameters: obj({
      crewId: str({
        description: "The crew's id from read_company, e.g. cleaning-south",
      }),
      topic: str({ minLength: 1, description: "What the talk is about" }),
      date: DATE("The day of the talk"),
      leader: opt(str({ description: "Who leads it, if known" })),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const talk = await desk().scheduleToolboxTalk(
          {
            crewId: args.crewId,
            topic: args.topic,
            date: args.date,
            ...(args.leader === undefined ? {} : { leader: args.leader }),
          },
          { requestId: requestId("toolbox-talk", api) },
        );
        return {
          ...textResult(
            `Scheduled ${talk.id}: a toolbox talk on ${talk.topic} for ${talk.crewId} on ${talk.date}${talk.leader === null ? "" : `, led by ${talk.leader}`}. A toolbox talk reinforces training: it is not recorded as anyone's training completion and renews no course. Required training is recorded only with record_training_completion after a training session.`,
          ),
          details: json(talk),
        };
      } catch (error) {
        return refused(error, { crewId: args.crewId });
      }
    },
  });

  const safetySection = (facts: CompanyFacts): string => {
    const fatal = limit(FATALITY_LIMIT);
    const severe = limit(SEVERE_INJURY_LIMIT);
    const others = companyData(facts, "safety").seriousIncidentTypes.filter(
      (type) => type !== FATALITY_TYPE,
    );
    const hours = (value: number | undefined) =>
      value === undefined || !Number.isFinite(value)
        ? "no deadline is set for this role"
        : `within ${value} hours`;
    return [
      `The safety officer is ${officerText}: incidents and safety questions go to them.`,
      `Training exceptions, whether an incident is recordable, and every regulator report are decided by a person, through the approval on each request.`,
      "Required training (course id — name — renewal — who needs it):",
      ...companyData(facts, "safety").requiredTraining.map(
        (course) =>
          `- ${course.id} — ${course.name} — every ${course.renewalMonths} months — ${course.appliesTo === "all" ? "everyone" : `the ${course.appliesTo} crew`}`,
      ),
      `Serious incident types: ${companyData(facts, "safety").seriousIncidentTypes.join(", ")}.`,
      `Reporting deadline, counted from when the company was told: a fatality ${hours(fatal)}; ${others.join(", ")} ${hours(severe)}.`,
      `Crews: ${companyData(facts, "crews")
        .map((crew) => crew.id)
        .join(", ")}.`,
    ].join("\n");
  };

  const readCompany = readCompanyTool({
    company,
    description:
      "Read one section of the company record: the profile, the office hours, the people and what each decides, safety (the safety officer, the required courses with their renewal periods and who needs them, the serious incident types, the reporting deadlines and the crews), the policies and safety rules, the tone of voice, the escalation path or the glossary.",
    sections: {
      profile: (facts) =>
        presentLines([companyHeadline(facts.profile), companyContactLine(facts.profile)]),
      hours: (facts) =>
        presentLines([
          `Office: ${facts.hours.office} (${facts.hours.timezone}).`,
          companyClosedLine(facts.hours),
        ]),
      people: (facts) => companyPeopleText(facts, "email"),
      safety: safetySection,
      policies: companyPoliciesText,
      tone: companyToneText,
      escalation: companyEscalationText,
      glossary: companyGlossaryText,
    } satisfies Readonly<Record<CompanySection, (facts: CompanyFacts) => string>>,
  });

  return {
    listTrainingStatus,
    recordTrainingCompletion,
    clearanceCheck,
    requestTrainingException,
    logIncident,
    requestRecordabilityDecision,
    requestRegulatorReport,
    listIncidents,
    getSafetyDataSheet,
    scheduleToolboxTalk,
    readCompany,
    exceptionApprovalFacts,
    recordabilityApprovalFacts,
    regulatorApprovalFacts,
  };
}
