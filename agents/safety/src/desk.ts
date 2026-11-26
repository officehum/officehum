/**
 * The desk: the safety records this role reads and writes — training, incidents, safety data sheets
 * and toolbox talks.
 *
 * A host binds its own (a training matrix, an incident reporting tool, an SDS library) and the role
 * never knows the difference. `fakeSafetyDesk` is what ships with the package: eight demonstration
 * workers with their training records, five logged incidents and sheets for the catalog's chemicals,
 * so a test, an eval or a first run needs no network and no credential.
 *
 * The desk owns every date and number that matters. It works out whether training is current from
 * each completion date and the course's renewal period against its own clock, and a serious
 * incident's reporting deadline from the time the company was told and the hours the tool hands it.
 * It holds no medical detail, refuses a description that carries one, and keeps a privacy case's name
 * out of everything it returns. A recordability decision, a regulator report and a training exception
 * are recorded only with the facts a person approved. A refusal carries a code, and the tools turn
 * the code into the next step.
 */

import { companyData, localDate, parseDate, sameFacts } from "@officehum/sdk";
import type { CompanyFacts, TrainingCourse } from "./company.js";
import { loadCompanyFacts, safetyOfficer } from "./company.js";

/** One worker on the training record. Not part of the company record: the desk's own data. */
export interface Worker {
  readonly id: string;
  readonly name: string;
  readonly crewId: string;
}

/** Where one required course stands for one person on the desk's day. */
export type TrainingState = "current" | "due-soon" | "overdue" | "never";

export interface CourseStatus {
  readonly courseId: string;
  readonly course: string;
  readonly renewalMonths: number;
  readonly lastCompleted: string | null;
  /** The day the last completion runs out; `null` when it was never done. */
  readonly dueOn: string | null;
  readonly state: TrainingState;
}

/** One person's required training: their name, crew and courses, and nothing else about them. */
export interface WorkerTraining {
  readonly workerId: string;
  readonly name: string;
  readonly crewId: string;
  readonly courses: readonly CourseStatus[];
}

export interface TrainingFilter {
  readonly person?: string;
  readonly crewId?: string;
  /** `not-current`: overdue or never done. `due-soon`: current but running out soon. */
  readonly state?: "not-current" | "due-soon";
}

export interface CompletionInput {
  readonly person: string;
  readonly courseId: string;
  readonly completedOn: string;
  readonly trainer: string;
  readonly contentSummary: string;
}

export interface Completion {
  readonly id: string;
  readonly workerId: string;
  readonly name: string;
  readonly courseId: string;
  readonly course: string;
  readonly completedOn: string;
  readonly trainer: string;
  readonly contentSummary: string;
  readonly recordedOn: string;
  readonly dueOn: string;
}

/** An exception a person approved: this person may do this one job though the course is not current. */
export interface TrainingException {
  readonly id: string;
  readonly workerId: string;
  readonly name: string;
  readonly courseId: string;
  readonly course: string;
  readonly job: string;
  readonly reason: string;
  readonly approvedOn: string;
}

export interface Clearance {
  readonly workerId: string;
  readonly name: string;
  readonly crewId: string;
  /** The crew whose work was checked: the person's own unless another was asked about. */
  readonly work: string;
  readonly cleared: boolean;
  readonly required: readonly CourseStatus[];
  readonly notCurrent: readonly CourseStatus[];
  readonly exceptions: readonly TrainingException[];
}

/** Who an incident was handed to: the safety officer, by name and title. */
export interface HandOff {
  readonly name: string;
  readonly title: string;
}

export interface RegulatorReport {
  readonly reference: string;
  readonly approvedOn: string;
  /** Where the desk sent it; `null` when it filed nothing, as the demonstration desk never does. */
  readonly submittedTo: string | null;
}

export type Recordability = "not-applicable" | "undecided" | "recordable";

export interface Incident {
  readonly id: string;
  readonly type: string;
  readonly serious: boolean;
  readonly occurredOn: string;
  readonly site: string;
  readonly description: string;
  /** Who was involved; always `null` for a privacy case, whose name the desk never returns. */
  readonly person: string | null;
  readonly privacyCase: boolean;
  readonly loggedOn: string;
  /** When the company was told, as an ISO instant: the regulator's clock runs from here. */
  readonly companyToldAt: string;
  readonly deadlineHours: number | null;
  readonly reportDeadline: string | null;
  readonly handedTo: HandOff | null;
  readonly recordability: Recordability;
  readonly regulatorReport: RegulatorReport | null;
}

export interface IncidentInput {
  readonly type: string;
  readonly occurredOn: string;
  readonly site: string;
  readonly description: string;
  readonly person?: string;
  /** When the company was told, `YYYY-MM-DDTHH:MM` in the company's time zone. Omitted: now. */
  readonly companyToldAt?: string;
}

export interface IncidentFilter {
  readonly id?: string;
  readonly type?: string;
  readonly from?: string;
  readonly to?: string;
}

/** The reporting deadlines in hours, as the tool read them from the role's limits at this call. */
export interface ReportingLimits {
  readonly fatalityHours?: number | undefined;
  readonly severeInjuryHours?: number | undefined;
}

export interface SafetyDataSheet {
  readonly chemicalId: string;
  readonly product: string;
  readonly signalWord: string;
  readonly hazards: readonly string[];
  readonly handling: string;
  readonly protection: string;
  readonly storage: string;
  readonly incompatible: string;
  readonly firstAid: string;
  readonly spill: string;
  readonly revised: string;
}

export interface ToolboxTalkInput {
  readonly crewId: string;
  readonly topic: string;
  readonly date: string;
  readonly leader?: string;
}

export interface ToolboxTalk {
  readonly id: string;
  readonly crewId: string;
  readonly crew: string;
  readonly topic: string;
  readonly date: string;
  readonly leader: string | null;
  readonly scheduledOn: string;
}

/** The interface a host implements over its own safety records. */
export interface SafetyDesk {
  trainingStatus(filter: TrainingFilter): Promise<readonly WorkerTraining[]>;
  recordTrainingCompletion(
    input: CompletionInput,
    options: { readonly requestId: string },
  ): Promise<Completion>;
  clearanceCheck(input: { readonly person: string; readonly work?: string }): Promise<Clearance>;
  recordTrainingException(
    input: { readonly approved: Record<string, unknown> },
    options: { readonly requestId: string },
  ): Promise<TrainingException>;
  logIncident(
    input: IncidentInput,
    options: { readonly requestId: string; readonly limits: ReportingLimits },
  ): Promise<Incident>;
  listIncidents(filter: IncidentFilter): Promise<readonly Incident[]>;
  recordRecordability(
    input: { readonly incidentId: string; readonly approved: Record<string, unknown> },
    options: { readonly requestId: string },
  ): Promise<Incident>;
  recordRegulatorReport(
    input: { readonly incidentId: string; readonly approved: Record<string, unknown> },
    options: { readonly requestId: string },
  ): Promise<Incident>;
  safetyDataSheet(chemical: string): Promise<SafetyDataSheet>;
  scheduleToolboxTalk(
    input: ToolboxTalkInput,
    options: { readonly requestId: string },
  ): Promise<ToolboxTalk>;
}

/** Why the desk refused, so a tool can say what to do next without parsing the message. */
export type DeskRefusal =
  | "not_found"
  | "ambiguous"
  | "invalid"
  | "medical_detail"
  | "not_applicable"
  | "already_decided"
  | "already_reported"
  | "facts_changed"
  | "no_sheet";

export class SafetyDeskError extends Error {
  readonly code: DeskRefusal;

  constructor(code: DeskRefusal, message: string) {
    super(message);
    this.name = "SafetyDeskError";
    this.code = code;
  }
}

/** Monday 23 November 2026, 09:00 on the US west coast: the start of the demonstration week. */
export const DEMO_NOW = "2026-11-23T17:00:00.000Z";

/** Incident types every company logs; the company's serious types are added to them. */
export const BASE_INCIDENT_TYPES = [
  "injury",
  "illness",
  "near-miss",
  "hazard-report",
  "exposure-incident",
] as const;

/** The serious type whose deadline is the fatality limit; every other serious type takes the severe-injury limit. */
export const FATALITY_TYPE = "fatality";
/** Types with no injured or ill person: there is nothing to record on an injury and illness log. */
const NOTHING_TO_RECORD = new Set(["near-miss", "hazard-report"]);
/** A privacy case: the name is kept off every list. */
const PRIVACY_TYPES = new Set(["exposure-incident"]);
/** A course running out within this many days is "due soon": time to book the refresher. */
export const DUE_SOON_DAYS = 30;

/**
 * Words that mark medical detail: a diagnosis, treatment, medication or test. The role holds none, so
 * a description carrying one is refused rather than stored where a list could show it.
 */
const MEDICAL_DETAIL =
  /\b(diagnos\w*|prescri\w*|medications?|medicines?|test results?|blood tests?|hiv|hepatitis|medical history|medical records?)\b/i;

const DAY_MS = 86_400_000;

/** The day `months` calendar months after a `YYYY-MM-DD` day, kept in the last day of a shorter month. */
export function addMonths(day: string, months: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date, last));
  return target.toISOString().slice(0, 10);
}

/** The offset of a time zone from UTC at an instant, in milliseconds. */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** A local `YYYY-MM-DDTHH:MM` in a time zone as a UTC instant, or `undefined` when it is not one. */
export function zonedInstant(local: string, timeZone: string): Date | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})$/.exec(local.trim());
  if (match === null) return undefined;
  const [, day = "", hours = "", minutes = ""] = match;
  const date = parseDate(day);
  if (date === undefined || Number(hours) > 23 || Number(minutes) > 59) return undefined;
  const wall = date.getTime() + Number(hours) * 3_600_000 + Number(minutes) * 60_000;
  let utc = wall - zoneOffset(wall, timeZone);
  utc = wall - zoneOffset(utc, timeZone);
  return new Date(utc);
}

/** An ISO instant as `YYYY-MM-DD HH:MM` in a time zone, for a person to read. */
export function localDateTime(iso: string, timeZone: string): string {
  const instant = new Date(iso);
  const offset = zoneOffset(instant.getTime(), timeZone);
  return new Date(instant.getTime() + offset).toISOString().slice(0, 16).replace("T", " ");
}

/** A course's state on a day, from its last completion. */
function courseStatus(
  course: TrainingCourse,
  lastCompleted: string | null,
  today: string,
): CourseStatus {
  if (lastCompleted === null) {
    return {
      courseId: course.id,
      course: course.name,
      renewalMonths: course.renewalMonths,
      lastCompleted: null,
      dueOn: null,
      state: "never",
    };
  }
  const dueOn = addMonths(lastCompleted, course.renewalMonths);
  const daysLeft = Math.round(
    ((parseDate(dueOn)?.getTime() ?? 0) - (parseDate(today)?.getTime() ?? 0)) / DAY_MS,
  );
  const state: TrainingState =
    daysLeft < 0 ? "overdue" : daysLeft <= DUE_SOON_DAYS ? "due-soon" : "current";
  return {
    courseId: course.id,
    course: course.name,
    renewalMonths: course.renewalMonths,
    lastCompleted,
    dueOn,
    state,
  };
}

const isCurrent = (status: CourseStatus): boolean =>
  status.state === "current" || status.state === "due-soon";

/**
 * The facts a person approves for a training exception: whose, which course and where it stands, the
 * job and the reason. The desk records the exception only while the course still stands there.
 */
export function exceptionFacts(
  worker: Pick<WorkerTraining, "workerId" | "name">,
  course: CourseStatus,
  job: string,
  reason: string,
): Record<string, unknown> {
  return {
    workerId: worker.workerId,
    name: worker.name,
    courseId: course.courseId,
    course: course.course,
    state: course.state,
    dueOn: course.dueOn,
    job: job.trim(),
    reason: reason.trim(),
  };
}

/** The facts a person decides an incident on: the incident as logged, without any name. */
export function incidentFacts(incident: Incident): Record<string, unknown> {
  return {
    id: incident.id,
    type: incident.type,
    occurredOn: incident.occurredOn,
    site: incident.site,
    description: incident.description,
    companyToldAt: incident.companyToldAt,
    reportDeadline: incident.reportDeadline,
  };
}

/** The demonstration workers: two on each cleaning crew and two on the maintenance crew. */
export function demoWorkers(): readonly Worker[] {
  return [
    { id: "W-01", name: "Ana Lucero", crewId: "cleaning-north" },
    { id: "W-02", name: "Ben Hollis", crewId: "cleaning-north" },
    { id: "W-03", name: "Carla Mendes", crewId: "cleaning-central" },
    { id: "W-04", name: "Dmitri Volkov", crewId: "cleaning-central" },
    { id: "W-05", name: "Grace Liu", crewId: "cleaning-south" },
    { id: "W-06", name: "Hector Ruiz", crewId: "cleaning-south" },
    { id: "W-07", name: "Ines Garza", crewId: "maintenance" },
    { id: "W-08", name: "Kofi Mensah", crewId: "maintenance" },
  ];
}

interface CompletionRecord {
  readonly workerId: string;
  readonly courseId: string;
  readonly completedOn: string;
  readonly trainer: string;
  readonly contentSummary: string;
}

/**
 * The completions already on the desk. On 23 November 2026: Ben Hollis's bloodborne pathogens ran
 * out in October, Grace Liu's ladder safety in September, Ines Garza's lockout/tagout on 2 November,
 * Hector Ruiz started without lone-worker training, and Carla Mendes's hazard communication runs out
 * on 5 December. Everyone else is current.
 */
export function demoCompletions(): readonly CompletionRecord[] {
  const hazcom = "Labels, safety data sheets and the site chemical list";
  const bbp =
    "Exposure control plan, universal precautions, sharps and what to do after an exposure";
  const ladder = "Choosing, inspecting and setting up step ladders; three points of contact";
  const lone = "Check-in at the start and end of a visit, and what a missed check-in means";
  const loto = "Energy sources, isolation, applying and removing locks and tags";
  const trainer = "External trainer";
  const row = (
    workerId: string,
    courseId: string,
    completedOn: string,
    contentSummary: string,
  ): CompletionRecord => ({ workerId, courseId, completedOn, trainer, contentSummary });
  return [
    row("W-01", "hazard-communication", "2026-03-10", hazcom),
    row("W-01", "bloodborne-pathogens", "2026-03-10", bbp),
    row("W-01", "ladder-safety", "2025-06-01", ladder),
    row("W-01", "lone-worker", "2025-06-01", lone),
    row("W-02", "hazard-communication", "2026-02-02", hazcom),
    row("W-02", "bloodborne-pathogens", "2025-10-15", bbp),
    row("W-02", "ladder-safety", "2025-04-20", ladder),
    row("W-02", "lone-worker", "2025-04-20", lone),
    row("W-03", "hazard-communication", "2025-12-05", hazcom),
    row("W-03", "bloodborne-pathogens", "2026-06-12", bbp),
    row("W-03", "ladder-safety", "2026-01-15", ladder),
    row("W-03", "lone-worker", "2026-01-15", lone),
    row("W-04", "hazard-communication", "2026-05-04", hazcom),
    row("W-04", "bloodborne-pathogens", "2026-05-04", bbp),
    row("W-04", "ladder-safety", "2025-09-09", ladder),
    row("W-04", "lone-worker", "2025-09-09", lone),
    row("W-05", "hazard-communication", "2026-04-14", hazcom),
    row("W-05", "bloodborne-pathogens", "2026-04-14", bbp),
    row("W-05", "ladder-safety", "2024-09-20", ladder),
    row("W-05", "lone-worker", "2025-08-30", lone),
    row("W-06", "hazard-communication", "2026-11-02", hazcom),
    row("W-06", "bloodborne-pathogens", "2026-11-02", bbp),
    row("W-06", "ladder-safety", "2026-11-02", ladder),
    row("W-07", "hazard-communication", "2026-01-20", hazcom),
    row("W-07", "bloodborne-pathogens", "2026-01-20", bbp),
    row("W-07", "ladder-safety", "2025-07-07", ladder),
    row("W-07", "lone-worker", "2025-07-07", lone),
    row("W-07", "lockout-tagout", "2025-11-02", loto),
    row("W-08", "hazard-communication", "2026-02-16", hazcom),
    row("W-08", "bloodborne-pathogens", "2026-02-16", bbp),
    row("W-08", "ladder-safety", "2025-10-01", ladder),
    row("W-08", "lone-worker", "2025-10-01", lone),
    row("W-08", "lockout-tagout", "2026-02-16", loto),
  ];
}

/** An incident as the desk keeps it: with the name, which a privacy case never lets out. */
type IncidentState = Omit<Incident, "person" | "recordability" | "regulatorReport"> & {
  personName: string | null;
  recordability: Recordability;
  regulatorReport: RegulatorReport | null;
};

/**
 * The incidents already on the desk: a near miss, a cut hand waiting for a recordability decision,
 * a privacy-case exposure, a hazard report, and this morning's hospital admission, logged at 07:55
 * with its regulator report not yet put to a person.
 */
export function demoIncidents(
  company: Pick<CompanyFacts, "hours" | "people" | "safety">,
): readonly IncidentState[] {
  const officer = safetyOfficer(company);
  const handOff = officer === undefined ? null : { name: officer.name, title: officer.title };
  const told = (local: string): string =>
    (zonedInstant(local, company.hours.timezone) ?? new Date(0)).toISOString();
  const admitted = told("2026-11-23T07:55");
  return [
    {
      id: "INC-401",
      type: "near-miss",
      serious: false,
      occurredOn: "2026-11-12",
      site: "Sellwood Law Partners, SE 13th Avenue",
      description: "Lobby mopped with no wet-floor sign out; a visitor slipped but did not fall",
      personName: null,
      privacyCase: false,
      loggedOn: "2026-11-12",
      companyToldAt: told("2026-11-12T19:10"),
      deadlineHours: null,
      reportDeadline: null,
      handedTo: null,
      recordability: "not-applicable",
      regulatorReport: null,
    },
    {
      id: "INC-402",
      type: "injury",
      serious: false,
      occurredOn: "2026-11-17",
      site: "Hawthorne Family Dental, SE Hawthorne Boulevard",
      description: "Cut to the left hand from broken glass inside a waste bin bag",
      personName: "Ben Hollis",
      privacyCase: false,
      loggedOn: "2026-11-17",
      companyToldAt: told("2026-11-17T20:30"),
      deadlineHours: null,
      reportDeadline: null,
      handedTo: null,
      recordability: "undecided",
      regulatorReport: null,
    },
    {
      id: "INC-403",
      type: "exposure-incident",
      serious: false,
      occurredOn: "2026-11-19",
      site: "Hawthorne Family Dental, SE Hawthorne Boulevard",
      description:
        "A needle left in a restroom waste bin went through a glove while the bin was emptied",
      personName: "Grace Liu",
      privacyCase: true,
      loggedOn: "2026-11-19",
      companyToldAt: told("2026-11-19T21:05"),
      deadlineHours: null,
      reportDeadline: null,
      handedTo: handOff,
      recordability: "undecided",
      regulatorReport: null,
    },
    {
      id: "INC-404",
      type: "hazard-report",
      serious: false,
      occurredOn: "2026-11-20",
      site: "Burnside Property Group, W Burnside Street",
      description: "Frayed power cord on the floor buffer kept in the basement store",
      personName: null,
      privacyCase: false,
      loggedOn: "2026-11-20",
      companyToldAt: told("2026-11-20T18:40"),
      deadlineHours: null,
      reportDeadline: null,
      handedTo: null,
      recordability: "not-applicable",
      regulatorReport: null,
    },
    {
      id: "INC-405",
      type: "hospitalization",
      serious: true,
      occurredOn: "2026-11-23",
      site: "Gateway Accounting, NE Halsey Street",
      description: "Fell from a step stool while dusting a high shelf and was admitted to hospital",
      personName: "Hector Ruiz",
      privacyCase: false,
      loggedOn: "2026-11-23",
      companyToldAt: admitted,
      deadlineHours: 24,
      reportDeadline: new Date(new Date(admitted).getTime() + 24 * 3_600_000).toISOString(),
      handedTo: handOff,
      recordability: "undecided",
      regulatorReport: null,
    },
  ];
}

/**
 * The safety data sheets the demonstration desk holds, by supply catalog id: the catalog's
 * chemicals. Illustrative sheets for a demonstration, not any manufacturer's.
 */
export function demoSafetyDataSheets(): readonly SafetyDataSheet[] {
  return [
    {
      chemicalId: "neutral-cleaner",
      product: "Neutral floor and surface cleaner (concentrate)",
      signalWord: "Warning",
      hazards: ["Causes serious eye irritation"],
      handling: "Dilute as the label directs. Avoid contact with eyes. Wash hands after handling.",
      protection: "Safety glasses when diluting the concentrate; gloves for prolonged contact",
      storage: "Keep in the original labelled container, closed, between 5 and 40 °C",
      incompatible: "Strong acids and strong oxidisers, including bleach",
      firstAid:
        "Eyes: rinse cautiously with water for several minutes; remove contact lenses if easy to do. If eye irritation persists, get medical attention.",
      spill: "Absorb with inert material and wipe up; rinse the area with water",
      revised: "2025-08-01",
    },
    {
      chemicalId: "disinfectant",
      product: "Hospital-grade disinfectant concentrate (quaternary ammonium)",
      signalWord: "Danger",
      hazards: [
        "Causes severe skin burns and eye damage (concentrate)",
        "Harmful if swallowed",
        "Very toxic to aquatic life",
      ],
      handling:
        "Dilute only as the label directs, in a ventilated area. Never decant the concentrate into an unlabelled bottle.",
      protection:
        "Chemical-resistant nitrile gloves and splash goggles when handling the concentrate",
      storage: "Original labelled container, closed, upright, away from food and other chemicals",
      incompatible:
        "Never mix with bleach (sodium hypochlorite), anionic detergents or strong oxidisers",
      firstAid:
        "Skin: remove contaminated clothing and rinse skin with water for 15 minutes. Eyes: rinse with water for 15 minutes and call a poison centre or doctor. Swallowed: rinse mouth, do not induce vomiting, call a poison centre.",
      spill: "Contain with absorbent; keep out of drains; dispose of as the label directs",
      revised: "2026-01-15",
    },
    {
      chemicalId: "glass-cleaner",
      product: "Glass cleaner (ready to use)",
      signalWord: "Warning",
      hazards: ["Flammable liquid and vapour", "Causes eye irritation"],
      handling:
        "Use in a ventilated area away from heat and sparks. Spray onto the cloth, not toward people.",
      protection: "None needed for normal use; safety glasses when refilling",
      storage: "Cool, ventilated place away from ignition sources, container closed",
      incompatible: "Strong oxidisers and bleach",
      firstAid:
        "Eyes: rinse with water for several minutes; if irritation persists, get medical attention. Inhaled: move to fresh air.",
      spill: "Remove ignition sources, absorb and ventilate the area",
      revised: "2025-11-20",
    },
    {
      chemicalId: "floor-finish",
      product: "Floor finish (acrylic polymer)",
      signalWord: "Warning",
      hazards: ["May cause an allergic skin reaction", "Slippery when wet"],
      handling:
        "Apply in a ventilated area and keep people off the floor until it is dry; post wet-floor signs.",
      protection: "Nitrile gloves; non-slip footwear while applying",
      storage: "Keep from freezing, in the original closed container",
      incompatible: "Strippers and strong alkalis in the same bucket",
      firstAid:
        "Skin: wash with soap and water; if a rash appears, get medical advice. Eyes: rinse with water for several minutes.",
      spill: "Absorb with inert material; the floor stays slippery until cleaned",
      revised: "2025-05-12",
    },
    {
      chemicalId: "hand-soap",
      product: "Foaming hand soap refill",
      signalWord: "None",
      hazards: ["Not classified as hazardous; may irritate eyes"],
      handling: "Use as supplied.",
      protection: "None needed",
      storage: "Original container, closed, at room temperature",
      incompatible: "None known",
      firstAid: "Eyes: rinse with water.",
      spill: "Wipe up; the floor may be slippery",
      revised: "2024-10-03",
    },
  ];
}

/** The demonstration desk's options: the company, demonstration records, a clock. */
export interface FakeSafetyDeskOptions {
  /** The courses, serious types, crews, catalog, officer and time zone; the company's own when omitted. */
  readonly company?: Pick<CompanyFacts, "hours" | "people" | "safety" | "crews" | "supplyCatalog">;
  readonly workers?: readonly Worker[];
  readonly completions?: readonly CompletionRecord[];
  readonly incidents?: readonly IncidentState[];
  readonly sheets?: readonly SafetyDataSheet[];
  /** The clock. Omitted: Monday 23 November 2026, 09:00 in the demonstration week. */
  readonly now?: () => Date;
}

/** An in-memory desk: demonstration workers, training, incidents and sheets, nothing sent. */
export function fakeSafetyDesk(options: FakeSafetyDeskOptions = {}): SafetyDesk {
  const facts = options.company ?? loadCompanyFacts();
  const courses = companyData(facts, "safety").requiredTraining;
  const timeZone = facts.hours.timezone;
  const clock = options.now ?? (() => new Date(DEMO_NOW));
  const today = (): string => localDate(clock(), timeZone);
  const workers = [...(options.workers ?? demoWorkers())];
  const completions: (CompletionRecord & { id: string; recordedOn: string })[] = (
    options.completions ?? demoCompletions()
  ).map((entry, index) => ({ ...entry, id: `TR-${101 + index}`, recordedOn: entry.completedOn }));
  const incidents: IncidentState[] = (options.incidents ?? demoIncidents(facts)).map((entry) => ({
    ...entry,
  }));
  const sheets = options.sheets ?? demoSafetyDataSheets();
  const exceptions: TrainingException[] = [];
  const talks: ToolboxTalk[] = [];
  const types = [...BASE_INCIDENT_TYPES, ...companyData(facts, "safety").seriousIncidentTypes];
  const officer = safetyOfficer(facts);
  // Every write is remembered by its request id, so a replayed call is answered with what it
  // already did and never writes twice.
  const done = new Map<string, unknown>();
  const replayed = <T>(requestId: string): T | undefined => done.get(requestId) as T | undefined;
  const remember = <T>(requestId: string, receipt: T): T => {
    done.set(requestId, receipt);
    return receipt;
  };

  const nextNumber = (prefix: string, existing: readonly string[], floor: number): string => {
    const highest = Math.max(floor, ...existing.map((id) => Number(id.replace(/\D/g, "")) || 0));
    return `${prefix}-${highest + 1}`;
  };

  const findWorker = (query: string): Worker => {
    const wanted = query.trim().toLowerCase();
    const exact = workers.filter(
      (worker) => worker.id.toLowerCase() === wanted || worker.name.toLowerCase() === wanted,
    );
    const matches =
      exact.length > 0
        ? exact
        : workers.filter((worker) =>
            worker.name
              .toLowerCase()
              .split(/\s+/)
              .some((part) => part === wanted),
          );
    const [only] = matches;
    if (matches.length === 1 && only !== undefined) return only;
    if (matches.length > 1) {
      throw new SafetyDeskError(
        "ambiguous",
        `More than one person on the training record is called ${JSON.stringify(query)}: ${matches.map((worker) => worker.name).join(", ")}. Give the full name.`,
      );
    }
    throw new SafetyDeskError(
      "not_found",
      `Nobody called ${JSON.stringify(query)} is on the training record. Check the full name with list_training_status.`,
    );
  };

  const findCrew = (id: string) => {
    const crew = companyData(facts, "crews").find((entry) => entry.id === id.trim());
    if (crew === undefined) {
      throw new SafetyDeskError(
        "not_found",
        `${JSON.stringify(id)} is not a crew. The crews are: ${companyData(facts, "crews")
          .map((entry) => entry.id)
          .join(", ")}.`,
      );
    }
    return crew;
  };

  const requiredFor = (crewId: string): readonly TrainingCourse[] =>
    courses.filter((course) => course.appliesTo === "all" || course.appliesTo === crewId);

  const lastCompletion = (workerId: string, courseId: string): string | null =>
    completions
      .filter((entry) => entry.workerId === workerId && entry.courseId === courseId)
      .map((entry) => entry.completedOn)
      .sort()
      .at(-1) ?? null;

  const statusesFor = (worker: Worker, crewId: string): CourseStatus[] =>
    requiredFor(crewId).map((course) =>
      courseStatus(course, lastCompletion(worker.id, course.id), today()),
    );

  const training = (worker: Worker): WorkerTraining => ({
    workerId: worker.id,
    name: worker.name,
    crewId: worker.crewId,
    courses: statusesFor(worker, worker.crewId),
  });

  const publicIncident = (state: IncidentState): Incident => {
    const { personName, ...rest } = state;
    return {
      ...rest,
      handedTo: rest.handedTo === null ? null : { ...rest.handedTo },
      regulatorReport: rest.regulatorReport === null ? null : { ...rest.regulatorReport },
      // A privacy case's name never leaves the desk.
      person: state.privacyCase ? null : personName,
    };
  };

  const findIncident = (id: string): IncidentState => {
    const incident = incidents.find((entry) => entry.id.toLowerCase() === id.trim().toLowerCase());
    if (incident === undefined) {
      throw new SafetyDeskError(
        "not_found",
        `No incident has the number ${JSON.stringify(id)}. Find it with list_incidents.`,
      );
    }
    return incident;
  };

  const sameIncident = (incident: IncidentState, approved: Record<string, unknown>): void => {
    if (!sameFacts(approved, incidentFacts(publicIncident(incident)))) {
      throw new SafetyDeskError(
        "facts_changed",
        `${incident.id} is not what the person decided on: its record differs from the facts they approved. Nothing was recorded.`,
      );
    }
  };

  return {
    async trainingStatus(filter): Promise<readonly WorkerTraining[]> {
      const chosen =
        filter.person !== undefined
          ? [findWorker(filter.person)]
          : filter.crewId !== undefined
            ? workers.filter((worker) => worker.crewId === findCrew(filter.crewId ?? "").id)
            : workers;
      const all = chosen.map(training);
      if (filter.state === undefined) return all;
      return all
        .map((worker) => ({
          ...worker,
          courses: worker.courses.filter((course) =>
            filter.state === "due-soon" ? course.state === "due-soon" : !isCurrent(course),
          ),
        }))
        .filter((worker) => worker.courses.length > 0);
    },

    async recordTrainingCompletion(input, { requestId }): Promise<Completion> {
      const prior = replayed<Completion>(requestId);
      if (prior !== undefined) return prior;
      const worker = findWorker(input.person);
      // Every problem is named at once, so one correction fixes the lot.
      const problems: string[] = [];
      const course = courses.find((entry) => entry.id === input.courseId.trim());
      if (course === undefined) {
        problems.push(
          `${JSON.stringify(input.courseId)} is not a course the company requires; the courses are ${courses.map((entry) => entry.id).join(", ")}.`,
        );
      } else if (!requiredFor(worker.crewId).includes(course)) {
        problems.push(
          `${course.name} is not required of ${worker.name}'s crew (${worker.crewId}); it applies to ${course.appliesTo}.`,
        );
      }
      if (parseDate(input.completedOn) === undefined) {
        problems.push(
          `${JSON.stringify(input.completedOn)} is not a date: give the day the session was held as YYYY-MM-DD.`,
        );
      } else if (input.completedOn > today()) {
        problems.push(
          `The date ${input.completedOn} is after today (${today()}): a completion records a session already held.`,
        );
      }
      if (input.trainer.trim() === "") problems.push("Say who the trainer was.");
      if (input.contentSummary.trim() === "") {
        problems.push("Give a short summary of what the session covered.");
      }
      if (problems.length > 0 || course === undefined) {
        throw new SafetyDeskError("invalid", `Nothing was recorded. ${problems.join(" ")}`);
      }
      const record = {
        id: nextNumber(
          "TR",
          completions.map((entry) => entry.id),
          100,
        ),
        workerId: worker.id,
        courseId: course.id,
        completedOn: input.completedOn,
        trainer: input.trainer.trim(),
        contentSummary: input.contentSummary.trim(),
        recordedOn: today(),
      };
      completions.push(record);
      return remember(requestId, {
        ...record,
        name: worker.name,
        course: course.name,
        dueOn: addMonths(record.completedOn, course.renewalMonths),
      });
    },

    async clearanceCheck(input): Promise<Clearance> {
      const worker = findWorker(input.person);
      const work = input.work === undefined ? worker.crewId : findCrew(input.work).id;
      const required = statusesFor(worker, work);
      const notCurrent = required.filter((course) => !isCurrent(course));
      return {
        workerId: worker.id,
        name: worker.name,
        crewId: worker.crewId,
        work,
        cleared: notCurrent.length === 0,
        required,
        notCurrent,
        exceptions: exceptions
          .filter((entry) => entry.workerId === worker.id)
          .map((entry) => ({ ...entry })),
      };
    },

    async recordTrainingException(input, { requestId }): Promise<TrainingException> {
      const prior = replayed<TrainingException>(requestId);
      if (prior !== undefined) return prior;
      const { approved } = input;
      const worker = findWorker(String(approved.workerId ?? ""));
      const course = courses.find((entry) => entry.id === approved.courseId);
      const status =
        course === undefined
          ? undefined
          : courseStatus(course, lastCompletion(worker.id, course.id), today());
      if (
        status === undefined ||
        !sameFacts(
          approved,
          exceptionFacts(training(worker), status, String(approved.job), String(approved.reason)),
        )
      ) {
        throw new SafetyDeskError(
          "facts_changed",
          `${worker.name}'s training is not what the person approved the exception on: it changed after its facts were read. Nothing was recorded.`,
        );
      }
      const exception: TrainingException = {
        id: nextNumber(
          "EX",
          exceptions.map((entry) => entry.id),
          300,
        ),
        workerId: worker.id,
        name: worker.name,
        courseId: status.courseId,
        course: status.course,
        job: String(approved.job),
        reason: String(approved.reason),
        approvedOn: today(),
      };
      exceptions.push(exception);
      return remember(requestId, { ...exception });
    },

    async logIncident(input, { requestId, limits }): Promise<Incident> {
      const prior = replayed<Incident>(requestId);
      if (prior !== undefined) return prior;
      const now = clock();
      const problems: string[] = [];
      const type = input.type.trim().toLowerCase();
      if (!types.includes(type)) {
        problems.push(
          `${JSON.stringify(input.type)} is not an incident type; give one of ${types.join(", ")}.`,
        );
      }
      if (parseDate(input.occurredOn) === undefined) {
        problems.push(
          `${JSON.stringify(input.occurredOn)} is not a date: give the day it happened as YYYY-MM-DD.`,
        );
      } else if (input.occurredOn > today()) {
        problems.push(
          `The date ${input.occurredOn} is after today (${today()}): log what has happened.`,
        );
      }
      let told = now;
      if (input.companyToldAt !== undefined && input.companyToldAt.trim() !== "") {
        const parsed = zonedInstant(input.companyToldAt, timeZone);
        if (parsed === undefined) {
          problems.push(
            `${JSON.stringify(input.companyToldAt)} is not a time: give when the company was told as YYYY-MM-DDTHH:MM, local time, or leave it out for now.`,
          );
        } else if (parsed.getTime() > now.getTime()) {
          problems.push(
            `The company was told at ${input.companyToldAt}, which has not happened yet; leave it out if the company is being told now.`,
          );
        } else {
          told = parsed;
        }
      }
      const site = input.site.trim();
      const description = input.description.trim();
      if (site === "") problems.push("Say where it happened.");
      if (description === "") problems.push("Say what happened.");
      const privacyCase = PRIVACY_TYPES.has(type);
      const personName = input.person?.trim() || null;
      if (privacyCase && personName !== null) {
        const names = personName
          .toLowerCase()
          .split(/\s+/)
          .filter((part) => part.length > 1);
        const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (
          names.some((part) => new RegExp(`\\b${escapeRegExp(part)}\\b`, "i").test(description))
        ) {
          problems.push(
            "This is a privacy case: leave the person's name out of the description and give it only as the person, so no list shows it.",
          );
        }
      }
      if (problems.length > 0) {
        throw new SafetyDeskError("invalid", `Nothing was logged. ${problems.join(" ")}`);
      }
      if (MEDICAL_DETAIL.test(description)) {
        throw new SafetyDeskError(
          "medical_detail",
          "Nothing was logged: the description carries medical detail (a diagnosis, treatment, medication or test), which this record does not hold. Describe what happened and the general kind of injury, such as a cut to the hand, and leave every medical detail out.",
        );
      }
      const serious = companyData(facts, "safety").seriousIncidentTypes.includes(type);
      const limit = serious
        ? type === FATALITY_TYPE
          ? limits.fatalityHours
          : limits.severeInjuryHours
        : undefined;
      // The role's resolved limit, as the tool read it for this call. None resolved sets no deadline.
      const hours = limit !== undefined && Number.isFinite(limit) && limit > 0 ? limit : null;
      const handedTo =
        (serious || privacyCase) && officer !== undefined
          ? { name: officer.name, title: officer.title }
          : null;
      const incident: IncidentState = {
        id: nextNumber(
          "INC",
          incidents.map((entry) => entry.id),
          400,
        ),
        type,
        serious,
        occurredOn: input.occurredOn,
        site,
        description,
        personName,
        privacyCase,
        loggedOn: today(),
        companyToldAt: told.toISOString(),
        deadlineHours: hours,
        reportDeadline:
          hours === null ? null : new Date(told.getTime() + hours * 3_600_000).toISOString(),
        handedTo,
        recordability: NOTHING_TO_RECORD.has(type) ? "not-applicable" : "undecided",
        regulatorReport: null,
      };
      incidents.push(incident);
      return remember(requestId, publicIncident(incident));
    },

    async listIncidents(filter): Promise<readonly Incident[]> {
      return incidents
        .filter(
          (entry) =>
            filter.id === undefined || entry.id.toLowerCase() === filter.id.trim().toLowerCase(),
        )
        .filter((entry) => filter.type === undefined || entry.type === filter.type.trim())
        .filter((entry) => filter.from === undefined || entry.occurredOn >= filter.from)
        .filter((entry) => filter.to === undefined || entry.occurredOn <= filter.to)
        .map(publicIncident);
    },

    async recordRecordability(input, { requestId }): Promise<Incident> {
      const prior = replayed<Incident>(requestId);
      if (prior !== undefined) return prior;
      const incident = findIncident(input.incidentId);
      if (incident.recordability === "not-applicable") {
        throw new SafetyDeskError(
          "not_applicable",
          `${incident.id} is a ${incident.type}: nobody was hurt or ill, so there is nothing to record on the injury and illness log.`,
        );
      }
      if (incident.recordability === "recordable") {
        throw new SafetyDeskError(
          "already_decided",
          `${incident.id} is already entered as recordable. Nothing was changed.`,
        );
      }
      sameIncident(incident, input.approved);
      incident.recordability = "recordable";
      return remember(requestId, publicIncident(incident));
    },

    async recordRegulatorReport(input, { requestId }): Promise<Incident> {
      const prior = replayed<Incident>(requestId);
      if (prior !== undefined) return prior;
      const incident = findIncident(input.incidentId);
      if (incident.regulatorReport !== null) {
        throw new SafetyDeskError(
          "already_reported",
          `${incident.id} already has its regulator report approved (${incident.regulatorReport.reference}). Nothing was changed.`,
        );
      }
      sameIncident(incident, input.approved);
      incident.regulatorReport = {
        reference: nextNumber(
          "RR",
          incidents.flatMap((entry) =>
            entry.regulatorReport === null ? [] : [entry.regulatorReport.reference],
          ),
          500,
        ),
        approvedOn: today(),
        submittedTo: null,
      };
      return remember(requestId, publicIncident(incident));
    },

    async safetyDataSheet(chemical): Promise<SafetyDataSheet> {
      const wanted = chemical.trim().toLowerCase();
      const exact = companyData(facts, "supplyCatalog").filter(
        (item) => item.id.toLowerCase() === wanted || item.name.toLowerCase() === wanted,
      );
      const loose = companyData(facts, "supplyCatalog").filter(
        (item) =>
          wanted.length > 2 &&
          (item.name.toLowerCase().includes(wanted) ||
            wanted.includes(item.id.toLowerCase()) ||
            wanted.includes(item.name.toLowerCase())),
      );
      const matches = exact.length > 0 ? exact : loose;
      const withSheet = (id: string) => sheets.find((sheet) => sheet.chemicalId === id);
      const held = companyData(facts, "supplyCatalog")
        .filter((item) => withSheet(item.id) !== undefined)
        .map((item) => `${item.id} (${item.name})`)
        .join(", ");
      const [item] = matches;
      if (matches.length !== 1 || item === undefined) {
        throw new SafetyDeskError(
          matches.length > 1 ? "ambiguous" : "not_found",
          `${matches.length > 1 ? "More than one" : "No"} item on the supply catalog matches ${JSON.stringify(chemical)}. The desk holds sheets for: ${held}.`,
        );
      }
      const sheet = withSheet(item.id);
      if (sheet === undefined) {
        throw new SafetyDeskError(
          "no_sheet",
          `${item.name} (${item.id}) is on the supply catalog, but the desk holds no safety data sheet for it. The desk holds sheets for: ${held}.`,
        );
      }
      return { ...sheet, hazards: [...sheet.hazards] };
    },

    async scheduleToolboxTalk(input, { requestId }): Promise<ToolboxTalk> {
      const prior = replayed<ToolboxTalk>(requestId);
      if (prior !== undefined) return prior;
      const crew = findCrew(input.crewId);
      const problems: string[] = [];
      if (input.topic.trim() === "") problems.push("Say what the talk is about.");
      if (parseDate(input.date) === undefined) {
        problems.push(`${JSON.stringify(input.date)} is not a date: give it as YYYY-MM-DD.`);
      } else if (input.date < today()) {
        problems.push(`The date ${input.date} is before today (${today()}).`);
      }
      if (problems.length > 0) {
        throw new SafetyDeskError("invalid", `Nothing was scheduled. ${problems.join(" ")}`);
      }
      const talk: ToolboxTalk = {
        id: nextNumber(
          "TT",
          talks.map((entry) => entry.id),
          600,
        ),
        crewId: crew.id,
        crew: crew.name,
        topic: input.topic.trim(),
        date: input.date,
        leader: input.leader?.trim() || null,
        scheduledOn: today(),
      };
      talks.push(talk);
      return remember(requestId, { ...talk });
    },
  };
}
