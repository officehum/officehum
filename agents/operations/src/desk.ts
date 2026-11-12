/**
 * The desk: the scheduling system this role reads jobs and crews from and writes assignments to.
 *
 * A host binds its own — field-service software, a dispatch board, a spreadsheet with an API — and the
 * role never knows the difference. `fakeOperationsDesk` is what ships with the package: the company's
 * own crews, a demonstration week of jobs, and hours arithmetic done here, so a test, an eval or a
 * first run needs no network and no credential.
 *
 * The desk owns the limits that depend on a sum. A crew's booked hours for a week, whether a job would
 * take it past its weekly hours cap, and how many overtime hours that would need are worked out here
 * and returned in the receipt or the refusal, never by the model. A refusal that a person can lift
 * names the approval-gated tool that asks them.
 *
 * The two gated writes are bound to what the person approved. The approval gate reads the facts below
 * (`overtimeFacts`, `contractRescheduleFacts`) from this desk and shows them; the write carries them
 * back as `approved`, and the desk refuses with `changed` when the schedule no longer equals them.
 */

import { localDate, parseDate, sameFacts, weekOf as weekContaining } from "@officehum/sdk";
import type { Crew } from "./company.js";
import { loadCompanyFacts } from "./company.js";

/** One job on the schedule: a single visit to a single site. */
export interface Job {
  id: string;
  client: string;
  /** The site, in the client's own terms. */
  site: string;
  /** What the visit is, in the company's service words. */
  service: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM`, local to the business. */
  start: string;
  /** The crew-hours the job books against its crew's week, set by the job, never by the caller. */
  crewHours: number;
  /** The crew assigned, by id, or `null` when nobody is assigned yet. */
  crewId: string | null;
  /** The recurring contract the visit belongs to, or `null` for a one-off job. */
  contractId: string | null;
  notes: string;
}

/** A day a crew cannot be booked, because a person approved time off for it. */
export interface TimeOff {
  readonly crewId: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly note: string;
}

/** How jobs are filtered. All are optional; none is a wildcard. */
export interface JobFilter {
  /** `YYYY-MM-DD`. */
  readonly date?: string;
  readonly crewId?: string;
  /** All or part of the client's name, or a job id such as J-2101. */
  readonly client?: string;
}

/** One crew's week: the hours booked against its cap, worked out by the desk. */
export interface CrewWeek {
  readonly crewId: string;
  readonly name: string;
  readonly members: number;
  /** Monday of the week, `YYYY-MM-DD`. */
  readonly weekStart: string;
  /** Sunday of the week, `YYYY-MM-DD`. */
  readonly weekEnd: string;
  readonly bookedHours: number;
  readonly weeklyHoursCap: number;
  /** Overtime a person approved for this crew this week. */
  readonly overtimeHours: number;
  /** Cap plus approved overtime, less booked hours, never below zero. */
  readonly hoursLeft: number;
  readonly timeOff: readonly TimeOff[];
}

/** A crew assigned to a job, and where that leaves the crew's week. */
export interface Assignment {
  readonly jobId: string;
  readonly client: string;
  readonly date: string;
  readonly crewId: string;
  readonly crewName: string;
  readonly crewHours: number;
  readonly weekStart: string;
  readonly bookedHours: number;
  readonly weeklyHoursCap: number;
  readonly overtimeHours: number;
}

/** Overtime a person approved, and the assignment it made possible. */
export interface OvertimeGrant extends Assignment {
  readonly id: string;
  readonly hours: number;
}

/** A job moved to another date. */
export interface Reschedule {
  readonly id: string;
  readonly jobId: string;
  readonly client: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly crewId: string | null;
  readonly contractId: string | null;
  readonly reason: string | null;
}

/** A call-out somebody asked for, recorded and nothing more. */
export interface Callout {
  readonly id: string;
  readonly jobId: string;
  readonly client: string;
  readonly site: string;
  readonly reason: string;
  readonly at: string;
}

/** What the role needs from whatever system holds its schedule. */
export interface OperationsDesk {
  listJobs(filter?: JobFilter): Promise<readonly Job[]>;
  /** Every crew's week; the week the clock is in when `weekOf` is omitted. */
  listCrews(options?: { readonly weekOf?: string }): Promise<readonly CrewWeek[]>;
  assignCrew(
    input: { readonly jobId: string; readonly crewId: string },
    options: { readonly requestId: string },
  ): Promise<Assignment>;
  /**
   * Records overtime for a crew and assigns it the job. `approved` is the facts the approval gate
   * read from this desk and showed a person (`overtimeFacts`); a host desk must refuse with `changed`
   * when the job, the crew's week or the hours no longer equal them. It is `undefined` only when the
   * company does not require approval for overtime, so nobody was asked and there is nothing to
   * compare.
   */
  requestOvertime(
    input: {
      readonly crewId: string;
      readonly jobId: string;
      readonly hours: number;
      readonly approved: Readonly<Record<string, unknown>> | undefined;
    },
    options: { readonly requestId: string },
  ): Promise<OvertimeGrant>;
  rescheduleJob(
    input: { readonly jobId: string; readonly newDate: string },
    options: { readonly requestId: string },
  ): Promise<Reschedule>;
  /**
   * Moves a visit on a recurring contract. Called only once a person approved it, with the facts the
   * approval gate read from this desk and showed them (`contractRescheduleFacts`). A host desk must
   * refuse with `changed` when the visit, the new date or the reason no longer equal `approved`.
   */
  requestContractReschedule(
    input: {
      readonly jobId: string;
      readonly newDate: string;
      readonly reason: string;
      readonly approved: Readonly<Record<string, unknown>>;
    },
    options: { readonly requestId: string },
  ): Promise<Reschedule>;
  recordCallout(
    input: { readonly jobId: string; readonly reason: string },
    options: { readonly requestId: string },
  ): Promise<Callout>;
}

/** Why the desk refused, so a tool can say what to do next without parsing the message. */
export type DeskRefusal =
  | "not_found"
  | "invalid"
  | "over_cap"
  | "over_cap_move"
  | "contract_crew"
  | "time_off"
  | "fits"
  | "recurring"
  | "one_off"
  | "changed";

/** A refusal the model reads: a job that does not exist, a week that is full, a contract visit. */
export class OperationsDeskError extends Error {
  readonly code: DeskRefusal;
  /** For `over_cap` and a wrong overtime figure: the overtime hours the job needs, from code. */
  readonly overtimeHoursNeeded: number | undefined;

  constructor(code: DeskRefusal, message: string, overtimeHoursNeeded?: number) {
    super(message);
    this.name = "OperationsDeskError";
    this.code = code;
    this.overtimeHoursNeeded = overtimeHoursNeeded;
  }
}

/**
 * The facts a person approves on an overtime request: the crew and its week as booked, the job with
 * the crew it has now, and the overtime hours asked for.
 */
export function overtimeFacts(job: Job, crew: CrewWeek, overtimeHours: number) {
  return {
    crewId: crew.crewId,
    crewName: crew.name,
    jobId: job.id,
    client: job.client,
    site: job.site,
    service: job.service,
    date: job.date,
    crewHours: job.crewHours,
    // Who has the job now: an approval to give it to this crew does not cover taking it from another.
    assignedCrewId: job.crewId,
    overtimeHours,
    weekStart: crew.weekStart,
    bookedHours: crew.bookedHours,
    weeklyHoursCap: crew.weeklyHoursCap,
  };
}

/**
 * The facts a person approves on a contract visit's move: the visit as it stands, its crew's week
 * (`undefined` when it has no crew yet), and the new date and reason as they were asked.
 */
export function contractRescheduleFacts(
  job: Job,
  crew: CrewWeek | undefined,
  move: { readonly newDate: string; readonly reason: string },
) {
  return {
    jobId: job.id,
    client: job.client,
    site: job.site,
    service: job.service,
    contractId: job.contractId,
    crewId: job.crewId,
    crewName: crew?.name ?? "no crew yet",
    fromDate: job.date,
    toDate: move.newDate.trim(),
    // Without the closing full stop, so the summary can end the sentence itself.
    reason: move.reason.trim().replace(/[.\s]+$/, ""),
  };
}

export interface FakeOperationsDeskOptions {
  /** The crews and their caps; the company's own when omitted. */
  readonly crews?: readonly Crew[];
  /** The schedule; the demonstration week when omitted. */
  readonly jobs?: readonly Job[];
  /** Approved time off; the demonstration week's when omitted. */
  readonly timeOff?: readonly TimeOff[];
  /**
   * The IANA time zone "today" and "this week" are read in: the company's `hours.timezone`. Omitted:
   * the generated company's.
   */
  readonly timeZone?: string;
  /** The clock. Omitted: the Monday of the demonstration week, so "this week" has work in it. */
  readonly now?: () => Date;
}

/** Monday of the demonstration week, at the start of the office day on the US west coast. */
export const DEMO_NOW = "2026-11-09T15:00:00.000Z";

/**
 * The demonstration week the package ships with: the week of Monday 9 November 2026. The recurring
 * contracts give each cleaning crew its nightly visits; three one-off jobs and a repair sit on top.
 * They are demonstration data, not part of the company record, and a host that binds a real desk
 * never sees them.
 */
export function demoJobs(): readonly Job[] {
  const weekdays = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
  const contracts = [
    {
      contractId: "CT-301",
      client: "Hawthorne Family Dental",
      site: "2,400 sq ft dental suite on SE Hawthorne Boulevard",
      service: "Recurring janitorial",
      crewId: "cleaning-north",
      start: "18:30",
      crewHours: 12,
      dates: weekdays,
    },
    {
      contractId: "CT-302",
      client: "Little Acorns Childcare",
      site: "childcare centre on N Williams Avenue: two classrooms, a kitchen and restrooms",
      service: "Recurring janitorial",
      crewId: "cleaning-north",
      start: "18:00",
      crewHours: 12,
      dates: weekdays,
    },
    {
      contractId: "CT-303",
      client: "Sellwood Law Partners",
      site: "two office floors on SE 13th Avenue",
      service: "Recurring janitorial",
      crewId: "cleaning-central",
      start: "19:00",
      crewHours: 14,
      dates: weekdays,
    },
    {
      contractId: "CT-304",
      client: "Burnside Property Group",
      site: "lobby, corridors and restrooms of the five-storey office building on W Burnside Street",
      service: "Recurring janitorial",
      crewId: "cleaning-central",
      start: "20:00",
      crewHours: 13,
      dates: weekdays,
    },
    {
      contractId: "CT-305",
      client: "Gateway Accounting",
      site: "office suite on NE Halsey Street",
      service: "Recurring janitorial",
      crewId: "cleaning-south",
      start: "18:30",
      crewHours: 11,
      // No Thursday visit: that is the South crew's approved day off this week.
      dates: ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-13"],
    },
    {
      contractId: "CT-306",
      client: "Woodstock Community Church",
      site: "sanctuary, hall and restrooms on SE Woodstock Boulevard",
      service: "Recurring janitorial",
      crewId: "cleaning-south",
      start: "14:00",
      crewHours: 6,
      dates: ["2026-11-15"],
    },
    {
      contractId: "CT-307",
      client: "Burnside Property Group",
      site: "the five-storey office building on W Burnside Street",
      service: "Building maintenance",
      crewId: "maintenance",
      start: "08:00",
      crewHours: 16,
      dates: weekdays,
    },
  ];
  const visits: Job[] = contracts.flatMap((contract, index) =>
    contract.dates.map((date, day) => ({
      id: `J-10${index + 1}${day + 1}`,
      client: contract.client,
      site: contract.site,
      service: contract.service,
      date,
      start: contract.start,
      crewHours: contract.crewHours,
      crewId: contract.crewId,
      contractId: contract.contractId,
      notes: `Visit on recurring contract ${contract.contractId}.`,
    })),
  );
  const oneOff: Job[] = [
    {
      id: "J-2101",
      client: "Riverside Dental",
      site: "3,200 sq ft suite on SE Hawthorne Boulevard",
      service: "Deep clean and floor care",
      date: "2026-11-12",
      start: "18:00",
      crewHours: 12,
      crewId: null,
      contractId: null,
      notes: "First deep clean before the dental chairs go in. Quote accepted; no crew yet.",
    },
    {
      id: "J-2102",
      client: "Hawthorne Family Dental",
      site: "2,400 sq ft dental suite on SE Hawthorne Boulevard",
      service: "Deep clean and floor care",
      date: "2026-11-14",
      start: "09:00",
      crewHours: 10,
      crewId: null,
      contractId: null,
      notes: "Strip and re-wax of the treatment-room floors, one-off. No crew yet.",
    },
    {
      id: "J-2103",
      client: "Little Acorns Childcare",
      site: "childcare centre on N Williams Avenue",
      service: "Deep clean and floor care",
      date: "2026-11-13",
      start: "18:30",
      crewHours: 8,
      crewId: "cleaning-north",
      contractId: null,
      notes: "Carpet extraction in both classrooms, one-off.",
    },
    {
      id: "J-2104",
      client: "Burnside Property Group",
      site: "the five-storey office building on W Burnside Street",
      service: "Building maintenance",
      date: "2026-11-10",
      start: "10:00",
      crewHours: 3,
      crewId: "maintenance",
      contractId: null,
      notes: "Replace the closer on the third-floor fire door.",
    },
  ];
  return [...visits, ...oneOff];
}

/** The demonstration week's approved time off. */
export function demoTimeOff(): readonly TimeOff[] {
  return [
    {
      crewId: "cleaning-south",
      date: "2026-11-12",
      note: "Two of the four cleaners on approved time off; the crew is not booked that day.",
    },
  ];
}

/** Monday and Sunday of the week a date falls in. The week runs Monday to Sunday. */
function weekOf(value: string): { readonly start: string; readonly end: string } {
  const week = weekContaining(value);
  if (week === undefined) {
    throw new OperationsDeskError(
      "invalid",
      `${JSON.stringify(value)} is not a date (YYYY-MM-DD).`,
    );
  }
  return week;
}

/** Hours as a person reads them: whole hours plainly, anything else to two places. */
function hoursText(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(2);
}

/** Sums of hours, kept to two places so a fractional job does not drift. */
function round(hours: number): number {
  return Math.round(hours * 100) / 100;
}

/** An in-memory desk: the company's crews, the demonstration week, and nothing that leaves the process. */
export function fakeOperationsDesk(options: FakeOperationsDeskOptions = {}): OperationsDesk {
  const crews = options.crews ?? loadCompanyFacts().crews;
  const clock = options.now ?? (() => new Date(DEMO_NOW));
  const timeZone = options.timeZone ?? loadCompanyFacts().hours.timezone;
  // The company's day, not the UTC one: Sunday evening in the office is still this week.
  const today = (): string => localDate(clock(), timeZone);
  const jobs: Job[] = (options.jobs ?? demoJobs()).map((job) => ({ ...job }));
  const timeOff = [...(options.timeOff ?? demoTimeOff())];
  const assignments = new Map<string, Assignment>();
  const grants = new Map<string, OvertimeGrant>();
  const moves = new Map<string, Reschedule>();
  const callouts = new Map<string, Callout>();
  let grantNumber = 0;
  let moveNumber = 0;
  let calloutNumber = 0;

  const findJob = (id: string): Job => {
    const job = jobs.find((candidate) => candidate.id === id.trim());
    if (job === undefined) {
      throw new OperationsDeskError(
        "not_found",
        `No job has the id ${JSON.stringify(id)}. Find it with list_jobs, by date, crew or client.`,
      );
    }
    return job;
  };

  const findCrew = (id: string): Crew => {
    const crew = crews.find((candidate) => candidate.id === id.trim());
    if (crew === undefined) {
      const known = crews.map((candidate) => `${candidate.id} (${candidate.name})`).join(", ");
      throw new OperationsDeskError(
        "not_found",
        `No crew has the id ${JSON.stringify(id)}. The crews are: ${known}.`,
      );
    }
    return crew;
  };

  /** Hours booked on a crew in a week, leaving out one job (the one being placed or moved). */
  const booked = (crewId: string, weekStart: string, except?: string): number =>
    round(
      jobs
        .filter((job) => job.crewId === crewId && job.id !== except)
        .filter((job) => weekOf(job.date).start === weekStart)
        .reduce((total, job) => total + job.crewHours, 0),
    );

  /**
   * Overtime a person approved for a crew in a week: the grants made for that crew and week whose job
   * is still there. An approval is for one crew, one week and one job, so when the job moves or changes
   * crew its overtime stops counting: it pays for no other work, and it is no headroom for the crew or
   * week the job went to.
   */
  const overtimeFor = (crewId: string, weekStart: string): number =>
    round(
      [...grants.values()]
        .filter((grant) => {
          const job = jobs.find((candidate) => candidate.id === grant.jobId);
          return (
            grant.crewId === crewId &&
            grant.weekStart === weekStart &&
            job !== undefined &&
            job.crewId === crewId &&
            weekOf(job.date).start === weekStart
          );
        })
        .reduce((total, grant) => total + grant.hours, 0),
    );

  const crewWeek = (
    crew: Crew,
    week: { readonly start: string; readonly end: string },
  ): CrewWeek => {
    const bookedHours = booked(crew.id, week.start);
    const overtimeHours = overtimeFor(crew.id, week.start);
    return {
      crewId: crew.id,
      name: crew.name,
      members: crew.members,
      weekStart: week.start,
      weekEnd: week.end,
      bookedHours,
      weeklyHoursCap: crew.weeklyHoursCap,
      overtimeHours,
      hoursLeft: round(Math.max(0, crew.weeklyHoursCap + overtimeHours - bookedHours)),
      timeOff: timeOff.filter(
        (entry) => entry.crewId === crew.id && entry.date >= week.start && entry.date <= week.end,
      ),
    };
  };

  /** A recurring contract promises the same crew each visit, so a different one is a person's call. */
  const refuseContractCrew = (job: Job, crew: Crew): void => {
    if (job.contractId !== null && job.crewId !== null && job.crewId !== crew.id) {
      throw new OperationsDeskError(
        "contract_crew",
        `${job.id} is a visit on recurring contract ${job.contractId}, which keeps its crew (${job.crewId}). A different crew on a contract visit is the decision of the person who owns the schedule: hand it to them. Nothing was assigned.`,
      );
    }
  };

  const refuseTimeOff = (crew: Crew, date: string, job: Job): void => {
    const off = timeOff.find((entry) => entry.crewId === crew.id && entry.date === date);
    if (off !== undefined) {
      throw new OperationsDeskError(
        "time_off",
        `${crew.name} has approved time off on ${date} (${off.note}), so it cannot take ${job.id}. Choose another crew or another date.`,
      );
    }
  };

  /** The hours a job would put a crew over its cap plus approved overtime on a date; 0 when it fits. */
  const overage = (crew: Crew, job: Job, date: string): number => {
    const week = weekOf(date).start;
    const total = round(booked(crew.id, week, job.id) + job.crewHours);
    return round(Math.max(0, total - (crew.weeklyHoursCap + overtimeFor(crew.id, week))));
  };

  const assignmentOf = (job: Job, crew: Crew): Assignment => {
    const week = weekOf(job.date).start;
    return {
      jobId: job.id,
      client: job.client,
      date: job.date,
      crewId: crew.id,
      crewName: crew.name,
      crewHours: job.crewHours,
      weekStart: week,
      bookedHours: booked(crew.id, week),
      weeklyHoursCap: crew.weeklyHoursCap,
      overtimeHours: overtimeFor(crew.id, week),
    };
  };

  /** A new date for a job: a real date, a different one, and not one already past. */
  const checkNewDate = (job: Job, newDate: string): void => {
    if (parseDate(newDate.trim()) === undefined) {
      throw new OperationsDeskError(
        "invalid",
        `${JSON.stringify(newDate)} is not a date. Give the new date as YYYY-MM-DD.`,
      );
    }
    if (newDate.trim() === job.date) {
      throw new OperationsDeskError("invalid", `${job.id} is already on ${job.date}.`);
    }
    if (newDate.trim() < today()) {
      throw new OperationsDeskError(
        "invalid",
        `${newDate.trim()} has already passed (today is ${today()}). Choose a date from today on.`,
      );
    }
  };

  /** Whether the job's crew can take it on the new date: no time off, and room in that week. */
  const checkCrewOn = (job: Job, newDate: string): void => {
    if (job.crewId === null) return;
    const crew = findCrew(job.crewId);
    refuseTimeOff(crew, newDate, job);
    const over = overage(crew, job, newDate);
    if (over > 0) {
      throw new OperationsDeskError(
        "over_cap_move",
        `Moving ${job.id} to ${newDate} would put ${crew.name} ${hoursText(over)} hours over its weekly hours cap for the week of ${weekOf(newDate).start}. Choose another date, or ask the person who owns the schedule.`,
        over,
      );
    }
  };

  const move = (job: Job, newDate: string, reason: string | null): Reschedule => {
    const fromDate = job.date;
    job.date = newDate;
    moveNumber += 1;
    return {
      id: `R-${moveNumber}`,
      jobId: job.id,
      client: job.client,
      fromDate,
      toDate: newDate,
      crewId: job.crewId,
      contractId: job.contractId,
      reason,
    };
  };

  return {
    async listJobs(filter: JobFilter = {}): Promise<readonly Job[]> {
      const client = filter.client?.trim().toLowerCase();
      return jobs
        .filter((job) => filter.date === undefined || job.date === filter.date.trim())
        .filter((job) => filter.crewId === undefined || job.crewId === filter.crewId.trim())
        .filter(
          (job) =>
            client === undefined ||
            client === "" ||
            job.client.toLowerCase().includes(client) ||
            job.id.toLowerCase() === client,
        )
        .sort(
          (left, right) =>
            left.date.localeCompare(right.date) ||
            left.start.localeCompare(right.start) ||
            left.id.localeCompare(right.id),
        )
        .map((job) => ({ ...job }));
    },

    async listCrews(listOptions: { readonly weekOf?: string } = {}): Promise<readonly CrewWeek[]> {
      const week = weekOf(listOptions.weekOf?.trim() ?? today());
      return crews.map((crew) => crewWeek(crew, week));
    },

    async assignCrew(input, { requestId }): Promise<Assignment> {
      // A retried call is answered with the assignment it already made: the hours count once.
      const prior = assignments.get(requestId);
      if (prior !== undefined) return prior;

      const job = findJob(input.jobId);
      const crew = findCrew(input.crewId);
      refuseContractCrew(job, crew);
      refuseTimeOff(crew, job.date, job);
      const over = overage(crew, job, job.date);
      if (over > 0) {
        const week = weekOf(job.date).start;
        const total = round(booked(crew.id, week, job.id) + job.crewHours);
        throw new OperationsDeskError(
          "over_cap",
          `Needs approval: ${job.id} (${hoursText(job.crewHours)} crew-hours on ${job.date}) would put ${crew.name} at ${hoursText(total)} hours for the week of ${week}, over its weekly hours cap of ${hoursText(crew.weeklyHoursCap + overtimeFor(crew.id, week))}. That is ${hoursText(over)} hours of overtime, which a person approves: call request_overtime with crewId ${crew.id}, jobId ${job.id} and hours ${hoursText(over)}. Nothing was assigned.`,
          over,
        );
      }
      job.crewId = crew.id;
      const assignment = assignmentOf(job, crew);
      assignments.set(requestId, assignment);
      return assignment;
    },

    async requestOvertime(input, { requestId }): Promise<OvertimeGrant> {
      const prior = grants.get(requestId);
      if (prior !== undefined) return prior;

      const job = findJob(input.jobId);
      const crew = findCrew(input.crewId);
      // The person approved the job and the crew's week as the gate read them; anything else is not
      // what they approved.
      if (
        input.approved !== undefined &&
        !sameFacts(
          input.approved,
          overtimeFacts(job, crewWeek(crew, weekOf(job.date)), input.hours),
        )
      ) {
        const week = weekOf(job.date).start;
        throw new OperationsDeskError(
          "changed",
          `This is not the overtime the person approved: ${job.id} or ${crew.name}'s week changed after its facts were read. ${job.id} is now on ${job.date} with ${job.crewId === null ? "no crew" : `crew ${job.crewId}`}, and ${crew.name} has ${hoursText(booked(crew.id, week))} of its ${hoursText(crew.weeklyHoursCap)} hours booked for the week of ${week}. Nothing was recorded.`,
        );
      }
      // Overtime assigns the job too, so it keeps the rule an assignment keeps.
      refuseContractCrew(job, crew);
      refuseTimeOff(crew, job.date, job);
      const needed = overage(crew, job, job.date);
      if (needed === 0) {
        throw new OperationsDeskError(
          "fits",
          `${job.id} fits inside ${crew.name}'s weekly hours cap, so it needs no overtime: assign it with assign_crew.`,
        );
      }
      // The overtime is the overage the desk worked out, never a figure of the caller's: a person is
      // asked to approve exactly what the job needs.
      if (!Number.isFinite(input.hours) || round(input.hours) !== needed) {
        throw new OperationsDeskError(
          "invalid",
          `${job.id} needs exactly ${hoursText(needed)} hours of overtime for ${crew.name}, not ${String(input.hours)}. Nothing was recorded.`,
          needed,
        );
      }
      job.crewId = crew.id;
      grantNumber += 1;
      const id = `OT-${grantNumber}`;
      // The grant is stored first so the week's overtime counts it, then stored again with the
      // receipt's figures: both entries are the same grant, under the same requestId.
      grants.set(requestId, { ...assignmentOf(job, crew), id, hours: needed });
      const grant: OvertimeGrant = { ...assignmentOf(job, crew), id, hours: needed };
      grants.set(requestId, grant);
      return grant;
    },

    async rescheduleJob(input, { requestId }): Promise<Reschedule> {
      const prior = moves.get(requestId);
      if (prior !== undefined) return prior;

      const job = findJob(input.jobId);
      if (job.contractId !== null) {
        throw new OperationsDeskError(
          "recurring",
          `${job.id} is a visit on recurring contract ${job.contractId}, and a contract visit moves only with a person's approval: call request_contract_reschedule with the job, the new date and the client's reason. Nothing was moved.`,
        );
      }
      checkNewDate(job, input.newDate);
      checkCrewOn(job, input.newDate.trim());
      const moved = move(job, input.newDate.trim(), null);
      moves.set(requestId, moved);
      return moved;
    },

    async requestContractReschedule(input, { requestId }): Promise<Reschedule> {
      const prior = moves.get(requestId);
      if (prior !== undefined) return prior;

      const job = findJob(input.jobId);
      if (job.contractId === null) {
        throw new OperationsDeskError(
          "one_off",
          `${job.id} is a one-off job, not a visit on a recurring contract: move it with reschedule_job.`,
        );
      }
      // The person approved the visit, the new date and the reason as the gate read them; anything
      // else is not what they approved.
      const crew = job.crewId === null ? undefined : findCrew(job.crewId);
      const current = contractRescheduleFacts(
        job,
        crew === undefined ? undefined : crewWeek(crew, weekOf(job.date)),
        input,
      );
      if (!sameFacts(input.approved, current)) {
        throw new OperationsDeskError(
          "changed",
          `This is not the move the person approved: ${job.id} or the request changed after its facts were read. ${job.id} is now on ${job.date} with ${job.crewId === null ? "no crew" : `crew ${job.crewId}`}. Nothing was moved.`,
        );
      }
      const reason = input.reason.trim();
      if (reason === "") {
        throw new OperationsDeskError(
          "invalid",
          "A contract visit moves for a reason: say why the client wants it moved.",
        );
      }
      checkNewDate(job, input.newDate);
      checkCrewOn(job, input.newDate.trim());
      const moved = move(job, input.newDate.trim(), reason);
      moves.set(requestId, moved);
      return moved;
    },

    async recordCallout(input, { requestId }): Promise<Callout> {
      const prior = callouts.get(requestId);
      if (prior !== undefined) return prior;

      const job = findJob(input.jobId);
      const reason = input.reason.trim();
      if (reason === "") {
        throw new OperationsDeskError("invalid", "A call-out needs the reason the client gave.");
      }
      calloutNumber += 1;
      const callout: Callout = {
        id: `CO-${calloutNumber}`,
        jobId: job.id,
        client: job.client,
        site: job.site,
        reason,
        at: clock().toISOString(),
      };
      callouts.set(requestId, callout);
      return callout;
    },
  };
}
