/**
 * The Compliance and Safety role's entry point: the factory a host calls to get the role.
 *
 * ```ts
 * import safety from "@officehum/safety";
 *
 * const role = safety({ desk: mySafetyRecords, approve, overlays: ["./my-safety"] });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 *
 * The package brings its own prompt, skills, tools, the company's facts and a demonstration safety
 * desk; the host brings the desk that holds its real training records, incidents and safety data
 * sheets and, optionally, the person who decides gated actions. Nothing here needs Office Hum, so the
 * same bundle runs in a bare Pi Durable harness.
 *
 * With `demo: true` and no desk the role runs on `fakeSafetyDesk`: eight workers and their training,
 * five incidents and the catalog chemicals' sheets, in memory, with nothing sent anywhere. That is
 * what `officehum run --demo` and the evals run on. With neither, the role still starts, and every
 * tool that reads or writes the desk refuses and says how to bind one.
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { DEMO_NOW, fakeSafetyDesk, type SafetyDesk } from "./desk.js";
import { safetyTools } from "./tools.js";

export {
  COMPANY_FACTS_URL,
  type CompanyFacts,
  type Crew,
  type EscalationRule,
  type GlossaryEntry,
  type Hours,
  loadCompanyFacts,
  type Person,
  type Policies,
  type Profile,
  person,
  personLabel,
  type SafetyPolicy,
  type SupplyItem,
  safetyOfficer,
  type Tone,
  type TrainingCourse,
} from "./company.js";
export {
  addMonths,
  BASE_INCIDENT_TYPES,
  type Clearance,
  type Completion,
  type CompletionInput,
  type CourseStatus,
  DEMO_NOW,
  type DeskRefusal,
  DUE_SOON_DAYS,
  demoCompletions,
  demoIncidents,
  demoSafetyDataSheets,
  demoWorkers,
  exceptionFacts,
  FATALITY_TYPE,
  type FakeSafetyDeskOptions,
  fakeSafetyDesk,
  type HandOff,
  type Incident,
  type IncidentFilter,
  type IncidentInput,
  incidentFacts,
  localDateTime,
  type Recordability,
  type RegulatorReport,
  type ReportingLimits,
  type SafetyDataSheet,
  type SafetyDesk,
  SafetyDeskError,
  type ToolboxTalk,
  type ToolboxTalkInput,
  type TrainingException,
  type TrainingFilter,
  type TrainingState,
  type Worker,
  type WorkerTraining,
  zonedInstant,
} from "./desk.js";
export {
  type CompanySection,
  FATALITY_LIMIT,
  type SafetyToolDependencies,
  type SafetyToolset,
  SEVERE_INJURY_LIMIT,
  safetyTools,
} from "./tools.js";

export interface SafetyOptions {
  /**
   * The host's safety records: a training matrix, an incident reporting tool and an SDS library in
   * production, `fakeSafetyDesk` in a test. Omitted, the demonstration desk when `demo` is set;
   * otherwise none, and every desk tool refuses.
   */
  readonly desk?: SafetyDesk;
  /**
   * Run on the demonstration desk this package ships with when no `desk` is given. Set by the host
   * (`officehum run --demo`, the eval runner), never by a user's message or config.
   */
  readonly demo?: boolean;
  /**
   * The company to work for. Omitted, the generated facts in this package. A host with its own
   * company passes its own, and nothing in `company/default/` is involved.
   */
  readonly company?: CompanyFacts;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /** Decides every gated action. Omitted: every exception, recordability decision and report is blocked. */
  readonly approve?: Approver;
  /**
   * The host's clock. The prompt's `today` section and the demonstration desk read it. Omitted: the
   * demonstration date (`DEMO_NOW`) on the demonstration desk, the system clock otherwise.
   */
  readonly now?: () => Date;
}

export default function safety(options: SafetyOptions = {}): DefinedRole {
  // The demonstration desk is built only when the host asks for it (`demo`) and binds no desk of
  // its own; with neither, the tools refuse rather than invent records.
  const demoDesk = options.desk === undefined && options.demo === true;
  // The demonstration data is dated around DEMO_NOW, so its desk keeps that date unless the host
  // passes a clock; otherwise the role runs on the system clock. The prompt reads the same clock.
  const now = options.now ?? (demoDesk ? () => new Date(DEMO_NOW) : () => new Date());
  const company = options.company ?? loadCompanyFacts();
  // The demonstration desk works from the company's own courses, serious types and catalog, so a
  // first run and a real one judge training the same way.
  const desk = demoDesk ? fakeSafetyDesk({ company, now }) : options.desk;
  // The reporting deadlines are read from the role's own resolved limits at every call, so an
  // overlay's hours are what a deadline is worked out from and a reload needs no rebuild. Before the
  // role exists no limit resolves, and the desk then sets no deadline rather than guessing one.
  let role: DefinedRole | undefined;
  const limits = () => role?.current().limits ?? {};
  const tools = safetyTools({ desk, company, limits });
  role = defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    now,
    // "Today" in the prompt is the company's own day, as it is on the desk, not UTC's.
    timeZone: company.hours.timezone,
    tools: [
      tools.listTrainingStatus,
      tools.recordTrainingCompletion,
      tools.clearanceCheck,
      tools.requestTrainingException,
      tools.logIncident,
      tools.requestRecordabilityDecision,
      tools.requestRegulatorReport,
      tools.listIncidents,
      tools.getSafetyDataSheet,
      tools.scheduleToolboxTalk,
      tools.readCompany,
    ],
    // The three approvals are `officehum.json`'s, on every call of their tools. The model names only
    // the person and course, or the incident: each gate reads what the person decides on from the
    // desk, shows it to them and hands it to the tool on a yes, so the desk records only what they saw.
    approvalFacts: {
      training_exception: tools.exceptionApprovalFacts,
      recordability: tools.recordabilityApprovalFacts,
      regulator_report: tools.regulatorApprovalFacts,
    },
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
  return role;
}
