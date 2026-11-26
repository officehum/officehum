/**
 * The Quality role's eleven tools.
 *
 * `list_inspections`, `list_nonconformances`, `quality_report` and `read_company` only read. The
 * other writes go through the desk with no approval: they are internal records, and the desk keeps
 * them honest. It scores every inspection from the checklist weights (the model gives results, never
 * a score) and judges it against the role's `inspection_pass_score` limit, read here at every call
 * and handed to the desk. It refuses a corrective action before a root cause, a verification from a
 * failed inspection or another site's, and a closure with no passing verification; each refusal names
 * the next step. `request_closure` is the one gated tool: its approval is `officehum.json`'s,
 * evaluated by the SDK's gate before the tool runs. The model names only the report:
 * `closureApprovalFacts` reads what the person approves from the desk, the gate hands those facts to
 * the tool on a yes, and the desk refuses when the report no longer equals what was approved.
 *
 * Every score a tool speaks comes back from the desk, and every name from the company record.
 */

import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { arr, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
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
import {
  type CompanyFacts,
  creditDecider,
  disciplineDecider,
  personLabel,
  qualityOwner,
  safetyOfficer,
} from "./company.js";
import {
  closureFacts,
  type DeskRefusal,
  type Inspection,
  ITEM_RESULTS,
  type ItemResult,
  laterFailure,
  type Nonconformance,
  type QualityDesk,
  QualityDeskError,
  type QualityReport,
  SEVERITIES,
  type Severity,
  SOURCES,
  type Source,
  stageOf,
} from "./desk.js";

/** The role's limit an inspection is judged against (`officehum.json`'s `limits`). */
export const PASS_SCORE_LIMIT = "inspection_pass_score";

/** What the tools need: the desk, the company, and the role's resolved limits. */
export interface QualityToolDependencies {
  readonly desk: QualityDesk | undefined;
  readonly company: CompanyFacts;
  /**
   * The role's resolved limits, read at every call: the manifest's defaults with the business's
   * overlay on top. Omitted, no pass score resolves and the desk judges no inspection.
   */
  readonly limits?: () => Readonly<Record<string, number>>;
}

/** The eleven tools, named, and the reader the closure approval asks with. */
export interface QualityToolset {
  readonly listInspections: ToolRegistration;
  readonly recordInspection: ToolRegistration;
  readonly openNonconformance: ToolRegistration;
  readonly listNonconformances: ToolRegistration;
  readonly recordContainment: ToolRegistration;
  readonly recordRootCause: ToolRegistration;
  readonly proposeCorrectiveAction: ToolRegistration;
  readonly recordVerification: ToolRegistration;
  readonly requestClosure: ToolRegistration;
  readonly qualityReport: ToolRegistration;
  readonly readCompany: ToolRegistration;
  /** Reads a report's cause, action and verification from the desk for the person closing it. */
  readonly closureApprovalFacts: ApprovalFactsReader;
}

/** The company section `read_company` can answer for. */
export type CompanySection =
  | "profile"
  | "hours"
  | "people"
  | "quality"
  | "policies"
  | "tone"
  | "escalation"
  | "glossary";

const REPORT_ID = str({ description: "The report's number, e.g. NC-201" });
const DATE = (description: string) => str({ description: `${description}, as YYYY-MM-DD` });

function outcomeText(inspection: Inspection): string {
  if (inspection.outcome === "unjudged") {
    return "No pass score is set for this role, so the desk cannot say whether it passed";
  }
  return `${inspection.outcome === "pass" ? "PASS" : "FAIL"} against the pass score of ${inspection.passScore ?? ""}`;
}

function inspectionLine(inspection: Inspection): string {
  const judged =
    inspection.outcome === "unjudged"
      ? "not judged (no pass score set)"
      : `${inspection.outcome.toUpperCase()} (pass score ${inspection.passScore ?? ""})`;
  const failed =
    inspection.failedItems.length === 0
      ? "no items failed"
      : `failed: ${inspection.failedItems.map((entry) => entry.itemId).join(", ")}`;
  return `${inspection.id} — ${inspection.siteId} (${inspection.siteName}) — visit ${inspection.visitDate} — score ${inspection.scorePercent} — ${judged} — ${failed}`;
}

function sourceText(report: Nonconformance): string {
  return report.sourceRef === null ? report.source : `${report.source} ${report.sourceRef}`;
}

/** A report as the model reads it; `inspections` are the desk's, for the report's stage. */
function reportText(report: Nonconformance, inspections: readonly Inspection[]): string {
  const action = report.correctiveAction;
  return [
    `${report.id} — ${report.siteId} (${report.siteName}) — ${report.severity} — ${report.status} — from ${sourceText(report)}${report.item === null ? "" : ` — item ${report.item.id} (${report.item.item})`} — opened ${report.openedOn}`,
    `  ${report.description}`,
    ...(report.handedTo === null
      ? []
      : [`  handed to ${report.handedTo.name}, ${report.handedTo.title}, the safety officer`]),
    `  containment: ${report.containment.length === 0 ? "none" : report.containment.map((entry) => `${entry.action} (${entry.on})`).join("; ")}`,
    `  root cause: ${report.rootCause === null ? "none recorded" : `${report.rootCause.cause} (evidence: ${report.rootCause.evidence})`}`,
    `  corrective action: ${action === null ? "none" : `${action.id} (${action.status}) — ${action.action} — owner ${action.owner} — due ${action.dueOn}`}`,
    ...(report.failedVerifications.length === 0
      ? []
      : [
          `  failed follow-ups: ${report.failedVerifications.map((entry) => `${entry.inspectionId} (reopened ${entry.actionId})`).join(", ")}`,
        ]),
    `  verification: ${report.verification === null ? "none" : `${report.verification.inspectionId}, visit ${report.verification.visitDate}, score ${report.verification.scorePercent}`}`,
    `  stage: ${stageOf(report, inspections)}`,
  ].join("\n");
}

/** A desk record as JSON details: a fresh copy, which is what a tool result's details take. */
function json(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

const reportDetails = (report: Nonconformance): JsonObject => json(report);

function reportSummary(report: QualityReport): string {
  const period =
    report.from === null && report.to === null
      ? "all records to date"
      : `${report.from ?? "the first record"} to ${report.to ?? "today"}`;
  const rate =
    report.passRatePercent === null
      ? "no inspection judged"
      : `pass rate ${report.passRatePercent}%`;
  const average =
    report.averageScorePercent === null ? "" : ` — average score ${report.averageScorePercent}`;
  return [
    `Quality report, ${period}, worked out by the desk:`,
    `${report.inspections} inspections, ${report.judged} judged: ${report.passed} passed, ${report.failed} failed — ${rate}${average}.`,
    `Open reports (${report.openReports.length}):`,
    ...report.openReports.map(
      (line) => `- ${line.id} — ${line.siteName} — ${line.severity} — ${line.stage}`,
    ),
    `Repeat non-conformances (${report.repeats.length}): the same checklist item at the same site more than once`,
    ...report.repeats.map(
      (line) =>
        `- ${line.siteId} (${line.siteName}) — ${line.itemId} (${line.item}) — ${line.reportIds.join(", ")}`,
    ),
  ].join("\n");
}

/**
 * The pass score as a sentence. The figure is the role's resolved limit, read when the sentence is
 * written, so what the role says is what the desk enforces.
 */
function passScoreText(limit: number | undefined): string {
  return limit === undefined || !Number.isFinite(limit)
    ? "No pass score is set for this role, so inspections are scored from the checklist weights but not judged pass or fail."
    : `An inspection passes at a score of ${limit} or more out of 100, worked out from the checklist weights.`;
}

const companySections = (
  limitText: () => string,
): Readonly<Record<CompanySection, (company: CompanyFacts) => string>> => ({
  profile: (company) => {
    const { profile } = company;
    return presentLines([companyHeadline(profile), companyContactLine(profile)]);
  },
  hours: (company) =>
    presentLines([
      `Office: ${company.hours.office} (${company.hours.timezone}).`,
      companyClosedLine(company.hours),
    ]),
  people: (company) => companyPeopleText(company, "email"),
  quality: (company) =>
    [
      `Quality is owned by ${personLabel(qualityOwner(company), "the person who owns quality")}: closing a non-conformance report, deciding on work that does not conform, and the checklist itself.`,
      limitText(),
      `A hazard found on an inspection goes to the safety officer: ${personLabel(safetyOfficer(company), "the safety officer")}.`,
      `Credits, price reductions and any other remedy for a client: ${personLabel(creditDecider(company), "the person who decides credits")}.`,
      `Discipline and other matters about a member of staff: ${personLabel(disciplineDecider(company), "the person who decides discipline")}.`,
      "Checklist (item — area: what is checked — weight):",
      ...companyData(company, "quality").checklist.map(
        (item) => `- ${item.id} — ${item.area}: ${item.item} — weight ${item.weight}`,
      ),
    ].join("\n"),
  policies: companyPoliciesText,
  tone: companyToneText,
  escalation: companyEscalationText,
  glossary: companyGlossaryText,
});

/**
 * Builds the eleven tools over one desk and one company. Every one is plain Pi Durable: they install
 * into any harness, and a harness with no desk builds the same tools and refuses at the point of use.
 */
export function qualityTools(dependencies: QualityToolDependencies): QualityToolset {
  const { company } = dependencies;
  const limit = (): number | undefined => dependencies.limits?.()[PASS_SCORE_LIMIT];
  const limitText = (): string => passScoreText(limit());
  const desk = () => requireDesk(dependencies.desk, "quality");
  /** The inspections a report's stage is read against: those of its site. */
  const siteInspections = (report: Nonconformance) =>
    desk().listInspections({ siteId: report.siteId });

  /** A desk refusal as the model reads it, with the next step. */
  const refused = (error: unknown, extra: Record<string, unknown>) => {
    if (!(error instanceof QualityDeskError)) throw error;
    const report = typeof extra.reportId === "string" ? extra.reportId : "the report";
    // The next step comes from the refusal's code, never from reading its message.
    const next: Record<DeskRefusal, string> = {
      no_root_cause:
        " Next: record the cause and its evidence with record_root_cause, then propose the action again. If the cause is not known, ask the person who looked into it; never guess one.",
      verification_failed: ` Next: tell the person ${report} stays open; look again at the root cause (record_root_cause if it was wrong) and propose a revised action with propose_corrective_action.`,
      other_site: ` Next: verify ${report} with a later inspection of its own site; list_inspections shows them.`,
      before_action: ` Next: verify ${report} with an inspection of a visit after the action was proposed.`,
      no_corrective_action: ` Next: propose an action with propose_corrective_action once a root cause is recorded.`,
      report_changed: ` Next: tell the person ${report} changed after it was put to a person, so it was not closed; read it again with list_nonconformances before anything else.`,
      // The desk's own message already says what to do for these.
      not_found: "",
      invalid: "",
      closed: "",
      already_proposed: "",
      not_judged: "",
      already_verified: "",
      later_failure: "",
      no_verification: "",
    };
    return deskRefusal(`${error.message}${next[error.code]}`, error.code, extra);
  };

  const listInspections = defineTool({
    name: "list_inspections",
    description:
      "List recorded site inspections, by site or visit dates: each one's visit, the score the desk worked out from the checklist weights, whether it passed, and the items that failed. Also lists the sites and their ids.",
    parameters: obj({
      inspectionId: opt(str({ description: "One inspection's number, e.g. INS-502" })),
      siteId: opt(str({ description: "The site's id, e.g. S-104" })),
      from: opt(DATE("The first visit date to include")),
      to: opt(DATE("The last visit date to include")),
    }),
    replay: "safe",
    execute: async (args) => {
      const quality = desk();
      const sites = await quality.listSites();
      const found = await quality.listInspections({
        ...(args.inspectionId === undefined ? {} : { id: args.inspectionId }),
        ...(args.siteId === undefined ? {} : { siteId: args.siteId }),
        ...(args.from === undefined ? {} : { from: args.from }),
        ...(args.to === undefined ? {} : { to: args.to }),
      });
      return {
        ...textResult(
          [
            `Sites: ${sites.map((site) => `${site.id} (${site.name})`).join(", ")}`,
            found.length === 0 ? "No inspection matches that." : `Inspections (${found.length}):`,
            ...found.map(inspectionLine),
          ].join("\n"),
        ),
        details: { found: found.length > 0, inspections: found.map(json) },
      };
    },
  });

  const recordInspection = defineTool({
    name: "record_inspection",
    description:
      "Record a site inspection: the site, the date of the visit inspected, and a result for every checklist item (pass, fail, or na when the item does not apply there). You give no score: the desk works it out from the checklist weights and says pass or fail against the role's pass score. It refuses a result list that leaves out or repeats an item, or names one not on the checklist. An internal record: nothing is sent to the client.",
    parameters: obj({
      siteId: str({ description: "The site's id from list_inspections, e.g. S-104" }),
      visitDate: DATE("The date of the visit whose work was inspected"),
      results: arr(
        obj({
          itemId: str({
            description: "The checklist item's id from read_company quality, e.g. carpets",
          }),
          result: union(
            ITEM_RESULTS.map((result) => lit(result)),
            { description: "pass, fail, or na when the item does not apply at this site" },
          ),
          note: opt(str({ description: "What the inspector saw, in a few words" })),
        }),
        { minItems: 1, description: "One result for every checklist item" },
      ),
      notes: opt(str({ description: "Anything else the inspector noted" })),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const quality = desk();
      try {
        const inspection = await quality.recordInspection(
          {
            siteId: args.siteId,
            visitDate: args.visitDate,
            results: args.results.map((entry) => ({
              itemId: entry.itemId,
              result: entry.result as ItemResult,
              ...(entry.note === undefined ? {} : { note: entry.note }),
            })),
            ...(args.notes === undefined ? {} : { notes: args.notes }),
          },
          // The pass score is read now, so an overlay's value is the one the desk judges against.
          { requestId: requestId("inspection", api), passScore: limit() },
        );
        const failed =
          inspection.failedItems.length === 0
            ? "No item failed."
            : `Failed items: ${inspection.failedItems.map((entry) => `${entry.itemId} (${entry.item}, weight ${entry.weight})`).join("; ")}.`;
        const next =
          inspection.outcome === "fail"
            ? `\nNext: open a non-conformance report with open_nonconformance (source inspection, sourceRef ${inspection.id}) for what failed.`
            : "";
        return {
          ...textResult(
            `Recorded ${inspection.id} for ${inspection.siteId} (${inspection.siteName}), visit ${inspection.visitDate}. Score ${inspection.scorePercent} out of 100 (${inspection.earned} of ${inspection.possible} points), worked out by the desk from the checklist weights: ${outcomeText(inspection)}.\n${failed}${next}\nThis is an internal record: nothing is sent to the client.`,
          ),
          details: json(inspection),
        };
      } catch (error) {
        return refused(error, { siteId: args.siteId });
      }
    },
  });

  const openNonconformance = defineTool({
    name: "open_nonconformance",
    description:
      "Open a non-conformance report for work that did not meet the standard: the site, its source (inspection with the inspection's number, complaint with where it came from, or internal), what was wrong, the checklist item if one covers it, and the severity: critical (likely to cause a hazard or unsafe conditions), major (the work failed or is much less usable) or minor. A critical report is handed to the safety officer the company names. An internal record: nothing is sent to the client and nothing is decided for them.",
    parameters: obj({
      siteId: str({ description: "The site's id, e.g. S-104" }),
      source: union(
        SOURCES.map((source) => lit(source)),
        { description: "inspection, complaint or internal" },
      ),
      sourceRef: opt(
        str({
          description:
            "For inspection: the inspection's number, e.g. INS-502. For complaint: where it came from (channel, who, when).",
        }),
      ),
      itemId: opt(str({ description: "The checklist item it is against, if one covers it" })),
      description: str({ minLength: 1, description: "What was wrong, in plain words" }),
      severity: union(
        SEVERITIES.map((severity) => lit(severity)),
        { description: "critical, major or minor" },
      ),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const quality = desk();
      try {
        const report = await quality.openNonconformance(
          {
            siteId: args.siteId,
            source: args.source as Source,
            description: args.description,
            severity: args.severity as Severity,
            ...(args.sourceRef === undefined ? {} : { sourceRef: args.sourceRef }),
            ...(args.itemId === undefined ? {} : { itemId: args.itemId }),
          },
          { requestId: requestId("nonconformance", api) },
        );
        const handed =
          report.handedTo === null
            ? ""
            : `\nHanded to ${report.handedTo.name}, ${report.handedTo.title}, the safety officer, as a likely hazard: an internal hand-off. Tell the person who reported it that ${report.handedTo.name} (${report.handedTo.title}) has it.`;
        return {
          ...textResult(
            `Opened ${report.id} for ${report.siteId} (${report.siteName}): ${report.severity}, from ${sourceText(report)}${report.item === null ? "" : `, checklist item ${report.item.id}`}. ${report.description}${handed}\nNext: record_containment for anything done to protect the client now, then find the cause with record_root_cause. This is an internal record: nothing is sent to the client.`,
          ),
          details: reportDetails(report),
        };
      } catch (error) {
        return refused(error, { siteId: args.siteId });
      }
    },
  });

  const listNonconformances = defineTool({
    name: "list_nonconformances",
    description:
      "List non-conformance reports, or one by its number: site, severity, source, containment, root cause, corrective action, verification, status, and what each still waits for.",
    parameters: obj({
      reportId: opt(REPORT_ID),
      siteId: opt(str({ description: "The site's id, e.g. S-103" })),
      status: opt(
        union([lit("open"), lit("closed")], {
          description: "open or closed",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args) => {
      const reports = await desk().listNonconformances({
        ...(args.reportId === undefined ? {} : { id: args.reportId }),
        ...(args.siteId === undefined ? {} : { siteId: args.siteId }),
        ...(args.status === undefined ? {} : { status: args.status as "open" | "closed" }),
      });
      const details = { found: reports.length > 0, reports: reports.map(reportDetails) };
      const inspections = reports.length === 0 ? [] : await desk().listInspections();
      if (reports.length === 0) {
        return refusal(
          "No non-conformance report matches that. Try the number, or fewer filters.",
          details,
        );
      }
      return {
        ...textResult(
          [
            `Non-conformance reports (${reports.length}):`,
            ...reports.map((report) => reportText(report, inspections)),
          ].join("\n"),
        ),
        details,
      };
    },
  });

  const recordContainment = defineTool({
    name: "record_containment",
    description:
      "Record a containment action on an open non-conformance report: the temporary step taken to protect the client until the permanent fix is in place, such as a re-clean or taking something out of use. An internal note.",
    parameters: obj({
      reportId: REPORT_ID,
      action: str({
        minLength: 1,
        description: "What was done to protect the client now",
      }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const report = await desk().recordContainment(
          { reportId: args.reportId, action: args.action },
          { requestId: requestId("containment", api) },
        );
        return {
          ...textResult(
            `Recorded containment on ${report.id}: ${report.containment.at(-1)?.action ?? args.action}. Where ${report.id} stands: ${stageOf(report, await siteInspections(report))}. An internal note: nothing is sent to the client.`,
          ),
          details: reportDetails(report),
        };
      } catch (error) {
        return refused(error, { reportId: args.reportId });
      }
    },
  });

  const recordRootCause = defineTool({
    name: "record_root_cause",
    description:
      "Record the root cause of an open non-conformance report and the evidence it rests on (what was checked, and when). Look for the cause in the work and its conditions, not a person to blame. A corrective action can be proposed only once a root cause is recorded.",
    parameters: obj({
      reportId: REPORT_ID,
      cause: str({
        minLength: 1,
        description: "The cause that, removed, stops it happening again",
      }),
      evidence: str({
        minLength: 1,
        description: "What shows it: what was checked, and when",
      }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const report = await desk().recordRootCause(
          { reportId: args.reportId, cause: args.cause, evidence: args.evidence },
          { requestId: requestId("root-cause", api) },
        );
        return {
          ...textResult(
            `Recorded the root cause of ${report.id}: ${report.rootCause?.cause ?? args.cause} (evidence: ${report.rootCause?.evidence ?? args.evidence}). Where ${report.id} stands: ${stageOf(report, await siteInspections(report))}. An internal note: nothing is sent to the client.`,
          ),
          details: reportDetails(report),
        };
      } catch (error) {
        return refused(error, { reportId: args.reportId });
      }
    },
  });

  const proposeCorrectiveAction = defineTool({
    name: "propose_corrective_action",
    description:
      "Propose a corrective action on an open non-conformance report: the action aimed at its root cause, who owns it and when it is due. The desk refuses it until a root cause is recorded (record it with record_root_cause first), and while an earlier action stands; a failed follow-up reopens an action so a revised one can be proposed. A proposal on the report: it changes no procedure and closes nothing.",
    parameters: obj({
      reportId: REPORT_ID,
      action: str({
        minLength: 1,
        description: "The change that removes the root cause",
      }),
      owner: str({ minLength: 1, description: "Who owns the action" }),
      dueDate: DATE("When it is due"),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const report = await desk().proposeCorrectiveAction(
          {
            reportId: args.reportId,
            action: args.action,
            owner: args.owner,
            dueDate: args.dueDate,
          },
          { requestId: requestId("corrective-action", api) },
        );
        const action = report.correctiveAction;
        return {
          ...textResult(
            `Proposed corrective action ${action?.id ?? ""} on ${report.id}: ${action?.action ?? args.action}, owner ${action?.owner ?? args.owner}, due ${action?.dueOn ?? args.dueDate}. Next: once a later inspection of ${report.siteId} passes, record it with record_verification. A proposal on the report: no procedure has changed and nothing is closed.`,
          ),
          details: reportDetails(report),
        };
      } catch (error) {
        return refused(error, { reportId: args.reportId });
      }
    },
  });

  const recordVerification = defineTool({
    name: "record_verification",
    description:
      "Record a follow-up inspection as the verification that a report's corrective action worked, by the report's and the inspection's numbers. The desk refuses an inspection of another site, one of a visit before the action, one no pass score judged, and one that failed or failed the report's own checklist item; a failed one reopens the corrective action. It also refuses a passing one when a later inspection of the same site failed the report's item: the latest inspection counts. It closes nothing: closure is request_closure.",
    parameters: obj({
      reportId: REPORT_ID,
      inspectionId: str({
        description: "The follow-up inspection's number, e.g. INS-505",
      }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const report = await desk().recordVerification(
          { reportId: args.reportId, inspectionId: args.inspectionId },
          { requestId: requestId("verification", api) },
        );
        return {
          ...textResult(
            `Verified ${report.id} with ${report.verification?.inspectionId ?? args.inspectionId}, a passing follow-up inspection of ${report.siteId} (score ${report.verification?.scorePercent ?? ""}). Next: request_closure with reportId ${report.id}, which asks a person; the report stays open until they approve.`,
          ),
          details: reportDetails(report),
        };
      } catch (error) {
        return refused(error, { reportId: args.reportId, inspectionId: args.inspectionId });
      }
    },
  });

  /**
   * The `close_nonconformance` approval's facts: the report as the desk holds it, read before anyone
   * is asked. A report not on the desk, closed, with no passing verification, or overtaken by a later
   * failed inspection of its item has nothing to approve, so it throws and the gate asks nobody.
   */
  const closureApprovalFacts: ApprovalFactsReader = async (args) => {
    const reportId = String(args.reportId);
    const [report] = await desk().listNonconformances({ id: reportId });
    if (report === undefined) {
      throw new Error(
        `No non-conformance report has the number ${JSON.stringify(reportId)}. Nothing was put to a person and nothing was closed. Next: find it with list_nonconformances.`,
      );
    }
    if (report.status === "closed") {
      throw new Error(
        `${report.id} is already closed (${report.closedOn ?? ""}). Nothing was put to a person. Next: tell the person it is closed.`,
      );
    }
    const inspections = await siteInspections(report);
    if (
      report.verification === null ||
      report.correctiveAction === null ||
      report.rootCause === null
    ) {
      throw new Error(
        `${report.id} has no passing follow-up inspection recorded as its verification, so it cannot be put to a person for closure. Where it stands: ${stageOf(report, inspections)}. Nothing was put to a person and nothing was closed. Next: once a later inspection of ${report.siteId} passes, record it with record_verification, then ask again.`,
      );
    }
    // The desk refuses to close a report a later failed inspection of its item overtook, so nobody
    // is asked to approve one.
    const overtaken = laterFailure(
      report,
      report.verification,
      inspections,
      await desk().listNonconformances({ siteId: report.siteId }),
      "Nothing was put to a person and nothing was closed.",
    );
    if (overtaken !== undefined) throw new Error(overtaken.message);
    const action = report.correctiveAction;
    return {
      summary: `Close ${report.id} at ${report.siteName} (${report.severity}): ${report.description}. Root cause: ${report.rootCause.cause} (evidence: ${report.rootCause.evidence}). Corrective action ${action.id}: ${action.action}, owner ${action.owner}, due ${action.dueOn}. Verified by ${report.verification.inspectionId}, a follow-up inspection of the visit on ${report.verification.visitDate} that scored ${report.verification.scorePercent}.`,
      facts: closureFacts(report),
    };
  };

  const requestClosure = defineTool({
    name: "request_closure",
    description:
      "Ask a person to close one non-conformance report, named by its number. Every call waits for a person. The desk refuses a report with no passing verification (record it with record_verification first), and one whose item a later inspection of the same site failed: the latest inspection counts. The person sees the report's root cause, corrective action and verification as the desk holds them; once approved, the desk closes exactly that report, and refuses if it changed since.",
    parameters: obj({
      reportId: REPORT_ID,
      // Pi Durable re-validates the arguments the gate returns, so the gate's key is declared.
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const quality = desk();
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return refusal(
          `Nothing was closed: this call to close ${args.reportId} carries no facts a person approved. A report is closed only after the approval gate has put it to a person and they said yes. Next: tell the person closing it needs a person's approval and nothing was closed.`,
          { code: "not_approved", reportId: args.reportId },
        );
      }
      try {
        const report = await quality.closeNonconformance(
          { reportId: args.reportId, approved },
          { requestId: requestId("closure", api) },
        );
        return {
          ...textResult(
            `Approved and closed: ${report.id} at ${report.siteName}, on ${report.closedOn ?? ""}. Verified by ${report.verification?.inspectionId ?? ""}.`,
          ),
          details: reportDetails(report),
        };
      } catch (error) {
        return refused(error, { reportId: args.reportId });
      }
    },
  });

  const qualityReport = defineTool({
    name: "quality_report",
    description:
      "Report quality over a period, or over every record when no dates are given: inspections, how many passed and the pass rate, the average score, the reports open now and where each stands, and repeat non-conformances (the same checklist item at the same site more than once). Every figure is worked out by the desk.",
    parameters: obj({
      from: opt(DATE("The first day to include")),
      to: opt(DATE("The last day to include")),
    }),
    replay: "safe",
    execute: async (args) => {
      try {
        const report = await desk().qualityReport({
          ...(args.from === undefined ? {} : { from: args.from }),
          ...(args.to === undefined ? {} : { to: args.to }),
        });
        return {
          ...textResult(reportSummary(report)),
          details: json(report),
        };
      } catch (error) {
        return refused(error, {});
      }
    },
  });

  const readCompany = readCompanyTool({
    company,
    description:
      "Read one section of the company record: the profile, the office hours, the people and what each decides, quality (who owns it, the pass score, the safety officer, who decides credits and staff matters, and the checklist with its weights), the policies, the tone of voice, the escalation path or the glossary.",
    sections: companySections(limitText),
  });

  return {
    listInspections,
    recordInspection,
    openNonconformance,
    listNonconformances,
    recordContainment,
    recordRootCause,
    proposeCorrectiveAction,
    recordVerification,
    requestClosure,
    qualityReport,
    readCompany,
    closureApprovalFacts,
  };
}
