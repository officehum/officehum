/**
 * The desk: the quality system this role reads inspections and non-conformance reports from and
 * writes them to.
 *
 * A host binds its own — inspection software, a quality management system, a spreadsheet with an
 * API — and the role never knows the difference. `fakeQualityDesk` is what ships with the package:
 * five demonstration sites, eight inspections and four open reports at different stages, scored from
 * the company's own checklist, so a test, an eval or a first run needs no network and no credential.
 *
 * The desk owns every number that matters. The model gives each checklist item's result; the desk
 * works out the score from the checklist weights and judges it against the pass score the tool hands
 * it. It also holds the order a report must follow: no corrective action before a root cause, no
 * verification from a failed inspection or another site's, no closure without a passing
 * verification, and neither once a later inspection of the report's item at its site failed it: the
 * latest inspection is the one that counts. A refusal carries a code, and the tools turn the code
 * into the next step.
 */

import { companyData, localDate, parseDate, sameFacts } from "@officehum/sdk";
import type { ChecklistItem, CompanyFacts } from "./company.js";
import { loadCompanyFacts, safetyOfficer } from "./company.js";

/** One demonstration site: a client's building the crews clean. */
export interface Site {
  readonly id: string;
  readonly name: string;
}

/** `na`: the item does not apply at this site (no break room, say); it is left out of the score. */
export type ItemResult = "pass" | "fail" | "na";

export const ITEM_RESULTS: readonly ItemResult[] = ["pass", "fail", "na"];

/** One checklist item's result as the inspector gives it. */
export interface InspectionResultInput {
  readonly itemId: string;
  readonly result: ItemResult;
  readonly note?: string;
}

/** One checklist item's result, with the item and its weight as the checklist had them. */
export interface InspectionResult {
  readonly itemId: string;
  readonly area: string;
  readonly item: string;
  readonly weight: number;
  readonly result: ItemResult;
  readonly note: string | null;
}

/** `unjudged`: no pass score resolved, so the desk gives the score and says nothing of pass or fail. */
export type InspectionOutcome = "pass" | "fail" | "unjudged";

export interface Inspection {
  readonly id: string;
  readonly siteId: string;
  readonly siteName: string;
  /** `YYYY-MM-DD` of the visit whose work was inspected. */
  readonly visitDate: string;
  /** `YYYY-MM-DD` the inspection was recorded. */
  readonly recordedOn: string;
  readonly results: readonly InspectionResult[];
  readonly earned: number;
  readonly possible: number;
  /** Earned over possible, as a percentage to one decimal place. */
  readonly scorePercent: number;
  /** The pass score it was judged against, or `null` when none resolved. */
  readonly passScore: number | null;
  readonly outcome: InspectionOutcome;
  readonly failedItems: readonly InspectionResult[];
  readonly notes: string | null;
}

export type Severity = "critical" | "major" | "minor";
export const SEVERITIES: readonly Severity[] = ["critical", "major", "minor"];

export type Source = "inspection" | "complaint" | "internal";
export const SOURCES: readonly Source[] = ["inspection", "complaint", "internal"];

/** A step recorded on a report, and the day it was recorded. */
export interface Containment {
  readonly action: string;
  readonly on: string;
}

export interface RootCause {
  readonly cause: string;
  readonly evidence: string;
  readonly on: string;
}

/**
 * `proposed`: waiting for a follow-up inspection. `verified`: a passing follow-up of the same site
 * showed it worked. `reopened`: a follow-up failed, so the action did not work and a revised one is
 * proposed in its place.
 */
export type ActionStatus = "proposed" | "verified" | "reopened";

export interface CorrectiveAction {
  readonly id: string;
  readonly action: string;
  readonly owner: string;
  readonly dueOn: string;
  readonly proposedOn: string;
  readonly status: ActionStatus;
}

export interface Verification {
  readonly inspectionId: string;
  readonly visitDate: string;
  readonly scorePercent: number;
  readonly on: string;
}

/** A follow-up inspection that failed, and so reopened the corrective action. */
export interface FailedVerification {
  readonly inspectionId: string;
  readonly actionId: string;
  readonly on: string;
}

/** Who a critical report was handed to, from the company record. */
export interface HandOff {
  readonly name: string;
  readonly title: string;
  readonly reason: "safety";
}

export interface Nonconformance {
  readonly id: string;
  readonly siteId: string;
  readonly siteName: string;
  readonly source: Source;
  /** The inspection's id, or where a complaint came from; `null` for an internal report with none. */
  readonly sourceRef: string | null;
  /** The checklist item the problem is against, when there is one. */
  readonly item: { readonly id: string; readonly area: string; readonly item: string } | null;
  readonly description: string;
  readonly severity: Severity;
  readonly openedOn: string;
  readonly handedTo: HandOff | null;
  readonly containment: readonly Containment[];
  readonly rootCause: RootCause | null;
  readonly correctiveAction: CorrectiveAction | null;
  /** Earlier actions a failed follow-up reopened, oldest first. */
  readonly previousActions: readonly CorrectiveAction[];
  readonly verification: Verification | null;
  readonly failedVerifications: readonly FailedVerification[];
  readonly status: "open" | "closed";
  readonly closedOn: string | null;
}

export interface InspectionFilter {
  readonly id?: string;
  readonly siteId?: string;
  /** `YYYY-MM-DD`, inclusive, on the visit date. */
  readonly from?: string;
  readonly to?: string;
}

export interface NonconformanceFilter {
  readonly id?: string;
  readonly siteId?: string;
  readonly status?: "open" | "closed";
}

export interface RecordInspectionInput {
  readonly siteId: string;
  readonly visitDate: string;
  readonly results: readonly InspectionResultInput[];
  readonly notes?: string;
}

export interface OpenNonconformanceInput {
  readonly siteId: string;
  readonly source: Source;
  readonly sourceRef?: string;
  readonly itemId?: string;
  readonly description: string;
  readonly severity: Severity;
}

export interface ProposeActionInput {
  readonly reportId: string;
  readonly action: string;
  readonly owner: string;
  readonly dueDate: string;
}

/** One report still open, and where it stands. */
export interface OpenReportLine {
  readonly id: string;
  readonly siteName: string;
  readonly severity: Severity;
  readonly stage: string;
}

/** Reports at the same site against the same checklist item. */
export interface RepeatLine {
  readonly siteId: string;
  readonly siteName: string;
  readonly itemId: string;
  readonly item: string;
  readonly reportIds: readonly string[];
}

export interface QualityReport {
  readonly from: string | null;
  readonly to: string | null;
  readonly inspections: number;
  readonly judged: number;
  readonly passed: number;
  readonly failed: number;
  /** Passed over judged, to one decimal place; `null` when nothing was judged. */
  readonly passRatePercent: number | null;
  readonly averageScorePercent: number | null;
  readonly openReports: readonly OpenReportLine[];
  readonly repeats: readonly RepeatLine[];
}

/**
 * The facts a person approves when closing a report: what was wrong, the cause, the action and the
 * follow-up that verified it. Its status and closing date are left out on purpose: they are what
 * closing changes, not the report the person was shown.
 */
export function closureFacts(report: Nonconformance): Record<string, unknown> {
  return {
    id: report.id,
    siteId: report.siteId,
    siteName: report.siteName,
    severity: report.severity,
    description: report.description,
    rootCause: report.rootCause === null ? null : { ...report.rootCause },
    correctiveAction: report.correctiveAction === null ? null : { ...report.correctiveAction },
    verification: report.verification === null ? null : { ...report.verification },
  };
}

/**
 * What a report still waits for, in a phrase. `inspections` are the desk's inspections of the
 * report's site: a verified report whose item a later one failed is open, not waiting for closure,
 * by the same rule the desk refuses closure with (`laterFailure`).
 */
export function stageOf(report: Nonconformance, inspections: readonly Inspection[]): string {
  if (report.status === "closed") return `closed ${report.closedOn ?? ""}`.trim();
  if (report.verification !== null) {
    const failed = overtakingInspection(report, report.verification, inspections);
    if (failed !== undefined) {
      const action = report.correctiveAction === null ? "" : ` ${report.correctiveAction.id}`;
      return `open because corrective action${action} did not hold: ${failed.id} (visit ${failed.visitDate}), after the verifying ${report.verification.inspectionId}, failed ${report.item?.id ?? "the item"}; it cannot be closed`;
    }
    return "verified; waiting for a person to approve closure";
  }
  if (report.correctiveAction?.status === "proposed") {
    return `corrective action ${report.correctiveAction.id} proposed; waiting for a passing follow-up inspection`;
  }
  if (report.correctiveAction?.status === "reopened") {
    return "corrective action reopened by a failed follow-up; waiting for a revised action";
  }
  if (report.rootCause !== null) return "root cause recorded; waiting for a corrective action";
  return "waiting for a root cause";
}

/** What the role needs from whatever system holds its inspections and reports. */
export interface QualityDesk {
  listSites(): Promise<readonly Site[]>;
  listInspections(filter?: InspectionFilter): Promise<readonly Inspection[]>;
  /**
   * Scores and records an inspection. The score comes from the checklist weights; `passScore` is the
   * role's resolved limit for this call. A host desk must record the outcome as `unjudged` when it is
   * `undefined`, never treat a missing limit as a pass.
   */
  recordInspection(
    input: RecordInspectionInput,
    options: { readonly requestId: string; readonly passScore: number | undefined },
  ): Promise<Inspection>;
  /** Opens a report; a critical one is handed to the safety officer the company names. */
  openNonconformance(
    input: OpenNonconformanceInput,
    options: { readonly requestId: string },
  ): Promise<Nonconformance>;
  listNonconformances(filter?: NonconformanceFilter): Promise<readonly Nonconformance[]>;
  recordContainment(
    input: { readonly reportId: string; readonly action: string },
    options: { readonly requestId: string },
  ): Promise<Nonconformance>;
  recordRootCause(
    input: { readonly reportId: string; readonly cause: string; readonly evidence: string },
    options: { readonly requestId: string },
  ): Promise<Nonconformance>;
  /** Refuses with `no_root_cause` until a root cause is recorded. */
  proposeCorrectiveAction(
    input: ProposeActionInput,
    options: { readonly requestId: string },
  ): Promise<Nonconformance>;
  /**
   * Records a follow-up inspection as the verification. A host desk must refuse one of another site
   * (`other_site`) and one that failed or failed the report's own item (`verification_failed`), and
   * a failed one must reopen the corrective action before it refuses. It must also refuse a passing
   * one when the latest inspection of the report's item at its site, after that one, failed the item
   * (`later_failure`), changing nothing.
   */
  recordVerification(
    input: { readonly reportId: string; readonly inspectionId: string },
    options: { readonly requestId: string },
  ): Promise<Nonconformance>;
  /**
   * Closes one report. Called only once a person approved it, with the facts the approval gate read
   * from this desk (`closureFacts`). A host desk must refuse with `no_verification` when the report
   * has no passing verification, with `later_failure` when the latest inspection of the report's item
   * at its site, after the verifying one, failed the item, and with `report_changed` when it no
   * longer equals `approved`.
   */
  closeNonconformance(
    input: { readonly reportId: string; readonly approved: Readonly<Record<string, unknown>> },
    options: { readonly requestId: string },
  ): Promise<Nonconformance>;
  qualityReport(period: { readonly from?: string; readonly to?: string }): Promise<QualityReport>;
}

/** Why the desk refused, so a tool can say what to do next without parsing the message. */
export type DeskRefusal =
  | "not_found"
  | "invalid"
  | "closed"
  | "no_root_cause"
  | "already_proposed"
  | "no_corrective_action"
  | "other_site"
  | "before_action"
  | "not_judged"
  | "verification_failed"
  | "already_verified"
  | "later_failure"
  | "no_verification"
  | "report_changed";

/** A refusal the model reads: an unknown site, a corrective action with no root cause. */
export class QualityDeskError extends Error {
  readonly code: DeskRefusal;

  constructor(code: DeskRefusal, message: string) {
    super(message);
    this.name = "QualityDeskError";
    this.code = code;
  }
}

/** Monday 9 November 2026, at the start of the office day on the US west coast. */
export const DEMO_NOW = "2026-11-09T16:00:00.000Z";

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * The score of a set of results against the checklist: the weights of the items that passed over the
 * weights of the items that applied, as a percentage to one decimal place. Not-applicable items are
 * out of both. The caller has checked that every item is on the checklist.
 */
export function scoreInspection(
  checklist: readonly ChecklistItem[],
  results: readonly { readonly itemId: string; readonly result: ItemResult }[],
): { readonly earned: number; readonly possible: number; readonly scorePercent: number } {
  let earned = 0;
  let possible = 0;
  for (const entry of results) {
    const weight = checklist.find((item) => item.id === entry.itemId)?.weight ?? 0;
    if (entry.result === "na") continue;
    possible += weight;
    if (entry.result === "pass") earned += weight;
  }
  return { earned, possible, scorePercent: possible === 0 ? 0 : round1((earned / possible) * 100) };
}

/** Pass or fail against a pass score, or `unjudged` with none. */
function judge(scorePercent: number, passScore: number | null): InspectionOutcome {
  if (passScore === null) return "unjudged";
  return scorePercent >= passScore ? "pass" : "fail";
}

/** The demonstration sites: five clients' buildings. Not part of the company record. */
export function demoSites(): readonly Site[] {
  return [
    { id: "S-101", name: "Hawthorne Family Dental, SE Hawthorne Boulevard" },
    { id: "S-102", name: "Little Acorns Childcare, N Williams Avenue" },
    { id: "S-103", name: "Sellwood Law Partners, SE 13th Avenue" },
    { id: "S-104", name: "Burnside Property Group, W Burnside Street" },
    { id: "S-105", name: "Gateway Accounting, NE Halsey Street" },
  ];
}

/** The pass score the demonstration inspections were judged against: the manifest's default. */
const DEMO_PASS_SCORE = 85;

/**
 * The inspections already on the desk, October and early November 2026, each scored here from the
 * company's checklist: two failed inspections in October that opened reports, the follow-ups that
 * passed, and a November failure at the same site and item as an October one.
 */
export function demoInspections(checklist: readonly ChecklistItem[]): readonly Inspection[] {
  const sites = demoSites();
  const inspection = (
    id: string,
    siteId: string,
    visitDate: string,
    fail: readonly string[],
  ): Inspection => {
    const results: InspectionResult[] = checklist.map((item) => ({
      itemId: item.id,
      area: item.area,
      item: item.item,
      weight: item.weight,
      result: fail.includes(item.id) ? "fail" : "pass",
      note: null,
    }));
    for (const itemId of fail) {
      if (!checklist.some((item) => item.id === itemId)) {
        throw new Error(`The demonstration inspections name ${itemId}, not on the checklist.`);
      }
    }
    const scored = scoreInspection(checklist, results);
    return {
      id,
      siteId,
      siteName: sites.find((site) => site.id === siteId)?.name ?? siteId,
      visitDate,
      recordedOn: visitDate,
      results,
      ...scored,
      passScore: DEMO_PASS_SCORE,
      outcome: judge(scored.scorePercent, DEMO_PASS_SCORE),
      failedItems: results.filter((entry) => entry.result === "fail"),
      notes: null,
    };
  };
  return [
    inspection("INS-501", "S-101", "2026-10-08", []),
    inspection("INS-502", "S-104", "2026-10-14", ["restroom-consumables", "break-room"]),
    inspection("INS-503", "S-103", "2026-10-15", ["trash", "break-room"]),
    inspection("INS-504", "S-102", "2026-10-20", ["carpets"]),
    inspection("INS-505", "S-104", "2026-10-28", []),
    inspection("INS-506", "S-103", "2026-10-30", []),
    inspection("INS-507", "S-103", "2026-11-04", ["break-room", "dusting"]),
    inspection("INS-508", "S-105", "2026-11-06", ["dusting"]),
  ];
}

/**
 * The reports already on the desk, at different stages: NC-201 and NC-202 verified by a passing
 * follow-up, NC-203 contained with no root cause yet, and NC-204 just opened, the second time the
 * break room at S-103 has failed. NC-201 waits for a person to close it. NC-204's failure means
 * NC-202's action did not hold, so the desk refuses to close NC-202 and names NC-204 as the repeat.
 *
 * NC-201's verification is seeded because an eval scenario records it: as for every role's
 * demonstration data, the desk holds the records the scenarios' stubbed writes leave behind, so the
 * approval gate reads the same report from the desk that the scenario's stubbed receipt describes.
 */
export function demoNonconformances(
  checklist: readonly ChecklistItem[],
): readonly Nonconformance[] {
  const sites = demoSites();
  const item = (id: string) => {
    const found = checklist.find((entry) => entry.id === id);
    if (found === undefined)
      throw new Error(`The demonstration reports name ${id}, not on the checklist.`);
    return { id: found.id, area: found.area, item: found.item };
  };
  const base = (
    id: string,
    siteId: string,
    source: Source,
    sourceRef: string,
    itemId: string,
    severity: Severity,
    description: string,
    openedOn: string,
  ): Nonconformance => ({
    id,
    siteId,
    siteName: sites.find((site) => site.id === siteId)?.name ?? siteId,
    source,
    sourceRef,
    item: item(itemId),
    description,
    severity,
    openedOn,
    handedTo: null,
    containment: [],
    rootCause: null,
    correctiveAction: null,
    previousActions: [],
    verification: null,
    failedVerifications: [],
    status: "open",
    closedOn: null,
  });
  return [
    {
      ...base(
        "NC-201",
        "S-104",
        "inspection",
        "INS-502",
        "break-room",
        "major",
        "Break room counters, sink and appliance fronts left unwiped",
        "2026-10-14",
      ),
      containment: [{ action: "Break room re-cleaned the next evening", on: "2026-10-15" }],
      rootCause: {
        cause:
          "The evening site card for the building left out the break room after the floor was refitted",
        evidence: "Site card read on 2026-10-15: no break room line",
        on: "2026-10-15",
      },
      correctiveAction: {
        id: "CA-301",
        action: "Reissue the site card with the break room and brief the evening crew on it",
        owner: "Evening crew lead",
        dueOn: "2026-10-23",
        proposedOn: "2026-10-16",
        status: "verified",
      },
      verification: {
        inspectionId: "INS-505",
        visitDate: "2026-10-28",
        scorePercent: 100,
        on: "2026-10-28",
      },
    },
    {
      ...base(
        "NC-202",
        "S-103",
        "inspection",
        "INS-503",
        "break-room",
        "minor",
        "Break room sink and counters left dirty",
        "2026-10-15",
      ),
      containment: [{ action: "Break room cleaned on the next visit", on: "2026-10-16" }],
      rootCause: {
        cause: "The break room dropped off the Thursday route when the visit days changed",
        evidence: "Route sheet for Thursdays compared with the site card on 2026-10-16",
        on: "2026-10-16",
      },
      correctiveAction: {
        id: "CA-302",
        action: "Add the break room back to the Thursday route sheet",
        owner: "Route planner",
        dueOn: "2026-10-29",
        proposedOn: "2026-10-16",
        status: "verified",
      },
      verification: {
        inspectionId: "INS-506",
        visitDate: "2026-10-30",
        scorePercent: 100,
        on: "2026-11-09",
      },
    },
    {
      ...base(
        "NC-203",
        "S-105",
        "complaint",
        "email from the client, Tuesday 3 November",
        "dusting",
        "major",
        "Desks and shelves left dusty all week, the client says",
        "2026-11-03",
      ),
      containment: [{ action: "Extra dusting pass on Thursday 5 November", on: "2026-11-04" }],
    },
    base(
      "NC-204",
      "S-103",
      "inspection",
      "INS-507",
      "break-room",
      "minor",
      "Break room counters and sink left dirty again",
      "2026-11-04",
    ),
  ];
}

/**
 * The latest inspection of a report's item at its site, of a visit after `verifiedBy`, when it failed
 * that item: the latest inspection is the one that counts, so the corrective action did not hold.
 * `undefined` when none did, or the report has no item.
 */
function overtakingInspection(
  report: Nonconformance,
  verifiedBy: { readonly visitDate: string },
  inspections: readonly Inspection[],
): Inspection | undefined {
  const item = report.item;
  if (item === null) return undefined;
  let latest: Inspection | undefined;
  let latestFailed = false;
  for (const inspection of inspections) {
    if (inspection.siteId !== report.siteId || inspection.visitDate <= verifiedBy.visitDate) {
      continue;
    }
    const result = inspection.results.find((entry) => entry.itemId === item.id)?.result;
    if (result === undefined || result === "na") continue;
    // On the same visit date, the one recorded last is the latest.
    if (latest === undefined || inspection.visitDate >= latest.visitDate) {
      latest = inspection;
      latestFailed = result === "fail";
    }
  }
  return latestFailed ? latest : undefined;
}

/**
 * The refusal when the latest inspection of a report's item at its site, of a visit after
 * `verifiedBy`, failed that item: the latest inspection is the one that counts, so the corrective
 * action did not hold and the report stays open. `undefined` when none did, or the report has no
 * item. The refusal names the repeat report among `reports`, or says how to open one.
 *
 * Exported so the closure approval asks nobody about a report the desk would refuse to close: the
 * desk and the approval read the same rule from here.
 */
export function laterFailure(
  report: Nonconformance,
  verifiedBy: { readonly inspectionId: string; readonly visitDate: string },
  inspections: readonly Inspection[],
  reports: readonly Nonconformance[],
  nothingDone: string,
): QualityDeskError | undefined {
  const item = report.item;
  const latest = overtakingInspection(report, verifiedBy, inspections);
  if (item === null || latest === undefined) return undefined;
  const failedOn = latest.visitDate;
  const repeats = reports.filter(
    (other) =>
      other.id !== report.id &&
      other.siteId === report.siteId &&
      other.item?.id === item.id &&
      other.openedOn >= failedOn,
  );
  const action = report.correctiveAction === null ? "" : ` ${report.correctiveAction.id}`;
  const repeat =
    repeats.length === 0
      ? `Next: open the repeat report with open_nonconformance (source inspection, sourceRef ${latest.id}, itemId ${item.id}) and name ${report.id} in its description.`
      : `The repeat is ${repeats.map((other) => other.id).join(", ")}: link it to ${report.id} when you tell the person, and work the new failure there.`;
  return new QualityDeskError(
    "later_failure",
    `${latest.id}, an inspection of ${report.siteId} on ${latest.visitDate}, after ${verifiedBy.inspectionId}, failed ${item.id}, the item ${report.id} is about. The latest inspection of that item at that site is the one that counts, so corrective action${action} did not hold and ${report.id} stays open. ${repeat} ${nothingDone}`,
  );
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type ReportState = Mutable<
  Omit<Nonconformance, "containment" | "previousActions" | "failedVerifications">
> & {
  containment: Containment[];
  previousActions: CorrectiveAction[];
  failedVerifications: FailedVerification[];
};

/** The demonstration desk's options: the company's checklist, demonstration records, a clock. */
export interface FakeQualityDeskOptions {
  /** The checklist, safety officer and time zone; the company's own when omitted. */
  readonly company?: Pick<CompanyFacts, "hours" | "people" | "quality" | "safety">;
  readonly sites?: readonly Site[];
  readonly inspections?: readonly Inspection[];
  readonly nonconformances?: readonly Nonconformance[];
  /** The clock. Omitted: Monday 9 November 2026, the morning of the demonstration week. */
  readonly now?: () => Date;
}

/** An in-memory desk: the company's checklist, demonstration sites and records, nothing sent. */
export function fakeQualityDesk(options: FakeQualityDeskOptions = {}): QualityDesk {
  const facts = options.company ?? loadCompanyFacts();
  const checklist = companyData(facts, "quality").checklist;
  const clock = options.now ?? (() => new Date(DEMO_NOW));
  const today = (): string => localDate(clock(), facts.hours.timezone);
  const sites = [...(options.sites ?? demoSites())];
  const inspections: Inspection[] = [...(options.inspections ?? demoInspections(checklist))];
  const reports: ReportState[] = (options.nonconformances ?? demoNonconformances(checklist)).map(
    (report) => ({
      ...report,
      containment: [...report.containment],
      previousActions: [...report.previousActions],
      failedVerifications: [...report.failedVerifications],
    }),
  );
  // Every write is remembered by its request id, refusals that changed something included, so a
  // replayed call is answered with what it already did and never writes twice.
  const done = new Map<string, Inspection | Nonconformance | QualityDeskError>();

  const replayed = <T>(requestId: string): T | undefined => {
    const prior = done.get(requestId);
    if (prior instanceof QualityDeskError) throw prior;
    return prior as T | undefined;
  };

  const snapshot = (report: ReportState): Nonconformance => ({
    ...report,
    item: report.item === null ? null : { ...report.item },
    handedTo: report.handedTo === null ? null : { ...report.handedTo },
    containment: report.containment.map((entry) => ({ ...entry })),
    rootCause: report.rootCause === null ? null : { ...report.rootCause },
    correctiveAction: report.correctiveAction === null ? null : { ...report.correctiveAction },
    previousActions: report.previousActions.map((entry) => ({ ...entry })),
    verification: report.verification === null ? null : { ...report.verification },
    failedVerifications: report.failedVerifications.map((entry) => ({ ...entry })),
  });

  const copyInspection = (inspection: Inspection): Inspection => ({
    ...inspection,
    results: inspection.results.map((entry) => ({ ...entry })),
    failedItems: inspection.failedItems.map((entry) => ({ ...entry })),
  });

  const nextNumber = (prefix: string, existing: readonly string[], floor: number): string => {
    const highest = Math.max(floor, ...existing.map((id) => Number(id.replace(/\D/g, "")) || 0));
    return `${prefix}-${highest + 1}`;
  };

  const findSite = (id: string): Site => {
    const site = sites.find((candidate) => candidate.id.toLowerCase() === id.trim().toLowerCase());
    if (site === undefined) {
      const known = sites.map((candidate) => `${candidate.id} (${candidate.name})`).join(", ");
      throw new QualityDeskError(
        "not_found",
        `No site has the id ${JSON.stringify(id)}. The sites are: ${known}.`,
      );
    }
    return site;
  };

  const findInspection = (id: string): Inspection => {
    const inspection = inspections.find(
      (candidate) => candidate.id.toLowerCase() === id.trim().toLowerCase(),
    );
    if (inspection === undefined) {
      throw new QualityDeskError(
        "not_found",
        `No inspection has the number ${JSON.stringify(id)}. Find it with list_inspections.`,
      );
    }
    return inspection;
  };

  const findReport = (id: string): ReportState => {
    const report = reports.find(
      (candidate) => candidate.id.toLowerCase() === id.trim().toLowerCase(),
    );
    if (report === undefined) {
      throw new QualityDeskError(
        "not_found",
        `No non-conformance report has the number ${JSON.stringify(id)}. Find it with list_nonconformances.`,
      );
    }
    return report;
  };

  const openReport = (id: string): ReportState => {
    const report = findReport(id);
    if (report.status === "closed") {
      throw new QualityDeskError(
        "closed",
        `${report.id} was closed on ${report.closedOn ?? "an earlier day"}; nothing more is recorded on a closed report. A new problem gets its own report with open_nonconformance.`,
      );
    }
    return report;
  };

  const required = (value: string | undefined, what: string): string => {
    const text = (value ?? "").trim();
    if (text === "") throw new QualityDeskError("invalid", `Say ${what}; it may not be empty.`);
    return text;
  };

  const inPeriod = (day: string, period: { from?: string; to?: string }): boolean =>
    (period.from === undefined || day >= period.from) &&
    (period.to === undefined || day <= period.to);

  return {
    async listSites(): Promise<readonly Site[]> {
      return sites.map((site) => ({ ...site }));
    },

    async listInspections(filter: InspectionFilter = {}): Promise<readonly Inspection[]> {
      return inspections
        .filter(
          (inspection) =>
            filter.id === undefined ||
            inspection.id.toLowerCase() === filter.id.trim().toLowerCase(),
        )
        .filter(
          (inspection) =>
            filter.siteId === undefined ||
            inspection.siteId.toLowerCase() === filter.siteId.trim().toLowerCase(),
        )
        .filter((inspection) => inPeriod(inspection.visitDate, filter))
        .map(copyInspection);
    },

    async recordInspection(input, { requestId, passScore }): Promise<Inspection> {
      const prior = replayed<Inspection>(requestId);
      if (prior !== undefined) return prior;
      // The role's resolved limit, as the tool read it for this call. None resolved judges nothing.
      const limit = passScore !== undefined && Number.isFinite(passScore) ? passScore : null;
      const site = findSite(input.siteId);

      // Every problem with the results is named at once, so one correction fixes the lot.
      const problems: string[] = [];
      if (parseDate(input.visitDate) === undefined) {
        problems.push(
          `${JSON.stringify(input.visitDate)} is not a visit date: give it as YYYY-MM-DD.`,
        );
      } else if (input.visitDate > today()) {
        problems.push(
          `The visit date ${input.visitDate} is after today (${today()}): an inspection records work already done.`,
        );
      }
      const seen = new Set<string>();
      for (const entry of input.results) {
        const id = entry.itemId.trim();
        if (!checklist.some((item) => item.id === id)) {
          problems.push(`${JSON.stringify(entry.itemId)} is not on the checklist.`);
        } else if (seen.has(id)) {
          problems.push(`${id} is given twice: give each checklist item once.`);
        } else if (!ITEM_RESULTS.includes(entry.result)) {
          problems.push(
            `${id}: ${JSON.stringify(entry.result)} is not a result; give pass, fail or na.`,
          );
        }
        seen.add(id);
      }
      const missing = checklist.filter((item) => !seen.has(item.id));
      if (missing.length > 0) {
        problems.push(
          `No result for ${missing.map((item) => `${item.id} (${item.item})`).join(", ")}: every checklist item needs pass, fail or na.`,
        );
      }
      if (problems.length === 0 && input.results.every((entry) => entry.result === "na")) {
        problems.push("Every item is marked not applicable, so there is nothing to score.");
      }
      if (problems.length > 0) {
        throw new QualityDeskError(
          "invalid",
          `The inspection was not recorded. ${problems.join(" ")} The checklist items are: ${checklist.map((item) => item.id).join(", ")}.`,
        );
      }

      const results: InspectionResult[] = checklist.map((item) => {
        const entry = input.results.find((candidate) => candidate.itemId.trim() === item.id);
        return {
          itemId: item.id,
          area: item.area,
          item: item.item,
          weight: item.weight,
          result: entry?.result ?? "na",
          note: entry?.note?.trim() || null,
        };
      });
      const scored = scoreInspection(checklist, results);
      const inspection: Inspection = {
        id: nextNumber(
          "INS",
          inspections.map((entry) => entry.id),
          500,
        ),
        siteId: site.id,
        siteName: site.name,
        visitDate: input.visitDate,
        recordedOn: today(),
        results,
        ...scored,
        passScore: limit,
        outcome: judge(scored.scorePercent, limit),
        failedItems: results.filter((entry) => entry.result === "fail"),
        notes: input.notes?.trim() || null,
      };
      inspections.push(inspection);
      const receipt = copyInspection(inspection);
      done.set(requestId, receipt);
      return receipt;
    },

    async openNonconformance(input, { requestId }): Promise<Nonconformance> {
      const prior = replayed<Nonconformance>(requestId);
      if (prior !== undefined) return prior;
      const site = findSite(input.siteId);
      if (!SOURCES.includes(input.source)) {
        throw new QualityDeskError(
          "invalid",
          `${JSON.stringify(input.source)} is not a source: give inspection, complaint or internal.`,
        );
      }
      if (!SEVERITIES.includes(input.severity)) {
        throw new QualityDeskError(
          "invalid",
          `${JSON.stringify(input.severity)} is not a severity: give critical, major or minor.`,
        );
      }
      const description = required(input.description, "what was wrong (description)");
      let sourceRef: string | null = input.sourceRef?.trim() || null;
      if (input.source === "inspection") {
        const inspection = findInspection(
          required(input.sourceRef, "which inspection found it (sourceRef, e.g. INS-502)"),
        );
        if (inspection.siteId !== site.id) {
          throw new QualityDeskError(
            "invalid",
            `${inspection.id} inspected ${inspection.siteId} (${inspection.siteName}), not ${site.id}. Open the report for the site the inspection found it at. Nothing was opened.`,
          );
        }
        sourceRef = inspection.id;
      } else if (input.source === "complaint") {
        sourceRef = required(
          input.sourceRef,
          "where the complaint came from (sourceRef): its channel, who and when",
        );
      }
      let item: Nonconformance["item"] = null;
      if (input.itemId !== undefined && input.itemId.trim() !== "") {
        const found = checklist.find((entry) => entry.id === input.itemId?.trim());
        if (found === undefined) {
          throw new QualityDeskError(
            "invalid",
            `${JSON.stringify(input.itemId)} is not on the checklist. The items are: ${checklist.map((entry) => entry.id).join(", ")}; leave it out for a problem no item covers. Nothing was opened.`,
          );
        }
        item = { id: found.id, area: found.area, item: found.item };
      }
      // A critical report is one likely to cause a hazard, so it goes to the safety officer at once.
      const officer = input.severity === "critical" ? safetyOfficer(facts) : undefined;
      const report: ReportState = {
        id: nextNumber(
          "NC",
          reports.map((entry) => entry.id),
          200,
        ),
        siteId: site.id,
        siteName: site.name,
        source: input.source,
        sourceRef,
        item,
        description,
        severity: input.severity,
        openedOn: today(),
        handedTo:
          officer === undefined
            ? null
            : { name: officer.name, title: officer.title, reason: "safety" },
        containment: [],
        rootCause: null,
        correctiveAction: null,
        previousActions: [],
        verification: null,
        failedVerifications: [],
        status: "open",
        closedOn: null,
      };
      reports.push(report);
      const receipt = snapshot(report);
      done.set(requestId, receipt);
      return receipt;
    },

    async listNonconformances(
      filter: NonconformanceFilter = {},
    ): Promise<readonly Nonconformance[]> {
      return reports
        .filter(
          (report) =>
            filter.id === undefined || report.id.toLowerCase() === filter.id.trim().toLowerCase(),
        )
        .filter(
          (report) =>
            filter.siteId === undefined ||
            report.siteId.toLowerCase() === filter.siteId.trim().toLowerCase(),
        )
        .filter((report) => filter.status === undefined || report.status === filter.status)
        .map(snapshot);
    },

    async recordContainment(input, { requestId }): Promise<Nonconformance> {
      const prior = replayed<Nonconformance>(requestId);
      if (prior !== undefined) return prior;
      const report = openReport(input.reportId);
      report.containment.push({
        action: required(input.action, "the containment action"),
        on: today(),
      });
      const receipt = snapshot(report);
      done.set(requestId, receipt);
      return receipt;
    },

    async recordRootCause(input, { requestId }): Promise<Nonconformance> {
      const prior = replayed<Nonconformance>(requestId);
      if (prior !== undefined) return prior;
      const report = openReport(input.reportId);
      const cause = required(input.cause, "the root cause");
      const evidence = required(
        input.evidence,
        "the evidence the cause rests on: what was checked, and when",
      );
      report.rootCause = { cause, evidence, on: today() };
      const receipt = snapshot(report);
      done.set(requestId, receipt);
      return receipt;
    },

    async proposeCorrectiveAction(input, { requestId }): Promise<Nonconformance> {
      const prior = replayed<Nonconformance>(requestId);
      if (prior !== undefined) return prior;
      const report = openReport(input.reportId);
      if (report.rootCause === null) {
        throw new QualityDeskError(
          "no_root_cause",
          `${report.id} has no root cause recorded, so no corrective action was proposed: an action is aimed at the cause, and the cause is not known yet. Nothing was recorded.`,
        );
      }
      const standing = report.correctiveAction;
      if (standing !== null && standing.status !== "reopened") {
        throw new QualityDeskError(
          "already_proposed",
          `${report.id} already has corrective action ${standing.id} (${standing.status}): ${standing.action}. A new one is proposed only when a failed follow-up inspection reopens it. Nothing was recorded.`,
        );
      }
      const action = required(input.action, "the corrective action");
      const owner = required(input.owner, "who owns the action");
      if (parseDate(input.dueDate) === undefined) {
        throw new QualityDeskError(
          "invalid",
          `${JSON.stringify(input.dueDate)} is not a due date: give it as YYYY-MM-DD. Nothing was recorded.`,
        );
      }
      if (input.dueDate < today()) {
        throw new QualityDeskError(
          "invalid",
          `The due date ${input.dueDate} is before today (${today()}). Nothing was recorded.`,
        );
      }
      const allActions = reports.flatMap((entry) => [
        ...(entry.correctiveAction === null ? [] : [entry.correctiveAction.id]),
        ...entry.previousActions.map((previous) => previous.id),
      ]);
      if (standing !== null) report.previousActions.push(standing);
      report.correctiveAction = {
        id: nextNumber("CA", allActions, 300),
        action,
        owner,
        dueOn: input.dueDate,
        proposedOn: today(),
        status: "proposed",
      };
      const receipt = snapshot(report);
      done.set(requestId, receipt);
      return receipt;
    },

    async recordVerification(input, { requestId }): Promise<Nonconformance> {
      const prior = replayed<Nonconformance>(requestId);
      if (prior !== undefined) return prior;
      const report = openReport(input.reportId);
      if (report.verification !== null) {
        throw new QualityDeskError(
          "already_verified",
          `${report.id} is already verified by ${report.verification.inspectionId}. Nothing was recorded.`,
        );
      }
      const action = report.correctiveAction;
      if (action === null || action.status !== "proposed") {
        throw new QualityDeskError(
          "no_corrective_action",
          `${report.id} has no corrective action waiting to be verified${action?.status === "reopened" ? ` (${action.id} was reopened by a failed follow-up)` : ""}. A follow-up inspection verifies an action, so one is proposed first. Nothing was recorded.`,
        );
      }
      const inspection = findInspection(input.inspectionId);
      if (inspection.siteId !== report.siteId) {
        throw new QualityDeskError(
          "other_site",
          `${inspection.id} inspected ${inspection.siteId} (${inspection.siteName}); ${report.id} is at ${report.siteId} (${report.siteName}). Only a follow-up inspection of the same site verifies it. Nothing was recorded.`,
        );
      }
      if (inspection.visitDate < action.proposedOn) {
        throw new QualityDeskError(
          "before_action",
          `${inspection.id} is of a visit on ${inspection.visitDate}, before ${action.id} was proposed on ${action.proposedOn}, so it cannot show the action worked. Nothing was recorded.`,
        );
      }
      if (inspection.outcome === "unjudged") {
        throw new QualityDeskError(
          "not_judged",
          `${inspection.id} scored ${inspection.scorePercent} with no pass score set, so the desk cannot say it passed. Nothing was recorded.`,
        );
      }
      const itemFailed =
        report.item !== null &&
        inspection.results.some(
          (entry) => entry.itemId === report.item?.id && entry.result === "fail",
        );
      if (inspection.outcome === "fail" || itemFailed) {
        // The action did not work: it is reopened before the refusal, so the report says so.
        const why =
          inspection.outcome === "fail"
            ? `failed, scoring ${inspection.scorePercent} against a pass score of ${inspection.passScore ?? "none"}`
            : `passed overall at ${inspection.scorePercent} but failed ${report.item?.id ?? "the item"}, the item ${report.id} is about`;
        report.correctiveAction = { ...action, status: "reopened" };
        report.failedVerifications.push({
          inspectionId: inspection.id,
          actionId: action.id,
          on: today(),
        });
        const refusal = new QualityDeskError(
          "verification_failed",
          `${inspection.id} ${why}, so it does not verify ${report.id}. Corrective action ${action.id} did not work and is reopened. Nothing was verified.`,
        );
        done.set(requestId, refusal);
        throw refusal;
      }
      const overtaken = laterFailure(
        report,
        { inspectionId: inspection.id, visitDate: inspection.visitDate },
        inspections,
        reports,
        "Nothing was verified.",
      );
      if (overtaken !== undefined) throw overtaken;
      report.correctiveAction = { ...action, status: "verified" };
      report.verification = {
        inspectionId: inspection.id,
        visitDate: inspection.visitDate,
        scorePercent: inspection.scorePercent,
        on: today(),
      };
      const receipt = snapshot(report);
      done.set(requestId, receipt);
      return receipt;
    },

    async closeNonconformance(input, { requestId }): Promise<Nonconformance> {
      const prior = replayed<Nonconformance>(requestId);
      if (prior !== undefined) return prior;
      const report = openReport(input.reportId);
      if (report.verification === null) {
        throw new QualityDeskError(
          "no_verification",
          `${report.id} has no passing follow-up inspection recorded as its verification, so it cannot be closed. Next: once a later inspection of ${report.siteId} passes, record it with record_verification. Nothing was closed.`,
        );
      }
      const overtaken = laterFailure(
        report,
        report.verification,
        inspections,
        reports,
        "Nothing was closed.",
      );
      if (overtaken !== undefined) throw overtaken;
      // The person approved the report as the gate read it; anything else is not what they approved.
      if (!sameFacts(input.approved, closureFacts(snapshot(report)))) {
        throw new QualityDeskError(
          "report_changed",
          `${report.id} is not what the person approved: it changed after its facts were read. Nothing was closed.`,
        );
      }
      report.status = "closed";
      report.closedOn = today();
      const receipt = snapshot(report);
      done.set(requestId, receipt);
      return receipt;
    },

    async qualityReport(period): Promise<QualityReport> {
      for (const [name, day] of [
        ["from", period.from],
        ["to", period.to],
      ] as const) {
        if (day !== undefined && parseDate(day) === undefined) {
          throw new QualityDeskError(
            "invalid",
            `${JSON.stringify(day)} is not a date for ${name}: give it as YYYY-MM-DD.`,
          );
        }
      }
      const counted = inspections.filter((inspection) => inPeriod(inspection.visitDate, period));
      const judged = counted.filter((inspection) => inspection.outcome !== "unjudged");
      const passed = judged.filter((inspection) => inspection.outcome === "pass").length;
      const scores = counted.map((inspection) => inspection.scorePercent);
      const repeats = new Map<string, ReportState[]>();
      for (const report of reports.filter((entry) => inPeriod(entry.openedOn, period))) {
        if (report.item === null) continue;
        const key = `${report.siteId}\u0000${report.item.id}`;
        repeats.set(key, [...(repeats.get(key) ?? []), report]);
      }
      return {
        from: period.from ?? null,
        to: period.to ?? null,
        inspections: counted.length,
        judged: judged.length,
        passed,
        failed: judged.length - passed,
        passRatePercent: judged.length === 0 ? null : round1((passed / judged.length) * 100),
        averageScorePercent:
          scores.length === 0
            ? null
            : round1(scores.reduce((sum, score) => sum + score, 0) / scores.length),
        openReports: reports
          .filter((report) => report.status === "open")
          .map((report) => ({
            id: report.id,
            siteName: report.siteName,
            severity: report.severity,
            stage: stageOf(snapshot(report), inspections),
          })),
        repeats: [...repeats.values()]
          .filter((group) => group.length > 1)
          .map((group) => {
            const [first] = group;
            return {
              siteId: first?.siteId ?? "",
              siteName: first?.siteName ?? "",
              itemId: first?.item?.id ?? "",
              item: first?.item?.item ?? "",
              reportIds: group.map((report) => report.id),
            };
          }),
      };
    },
  };
}
