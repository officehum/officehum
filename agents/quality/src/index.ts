/**
 * The Quality role's entry point: the factory a host calls to get the role.
 *
 * ```ts
 * import quality from "@officehum/quality";
 *
 * const role = quality({ desk: myInspectionSystem, approve, overlays: ["./my-quality"] });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 *
 * The package brings its own prompt, skills, tools, the company's facts and a demonstration quality
 * desk; the host brings the desk that holds its real inspections and reports and, optionally, the
 * person who decides gated actions. Nothing here needs Office Hum, so the same bundle runs in a bare
 * Pi Durable harness.
 *
 * With `demo: true` and no desk the role runs on `fakeQualityDesk`: five sites, eight inspections
 * scored from the company's checklist and four open reports, in memory, with nothing sent anywhere.
 * That is what `officehum run --demo` and the evals run on. With neither, the role still starts, and
 * every tool that reads or writes the desk refuses and says how to bind one.
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { DEMO_NOW, fakeQualityDesk, type QualityDesk } from "./desk.js";
import { qualityTools } from "./tools.js";

export {
  type ChecklistItem,
  COMPANY_FACTS_URL,
  type CompanyFacts,
  creditDecider,
  disciplineDecider,
  type EscalationRule,
  type GlossaryEntry,
  type Hours,
  loadCompanyFacts,
  type Person,
  type Policies,
  type Profile,
  person,
  personLabel,
  type QualityPolicy,
  qualityOwner,
  type SafetyPolicy,
  safetyOfficer,
  type Tone,
} from "./company.js";
export {
  type ActionStatus,
  type Containment,
  type CorrectiveAction,
  closureFacts,
  DEMO_NOW,
  type DeskRefusal,
  demoInspections,
  demoNonconformances,
  demoSites,
  type FailedVerification,
  type FakeQualityDeskOptions,
  fakeQualityDesk,
  type HandOff,
  type Inspection,
  type InspectionFilter,
  type InspectionOutcome,
  type InspectionResult,
  type InspectionResultInput,
  type ItemResult,
  type Nonconformance,
  type NonconformanceFilter,
  type OpenNonconformanceInput,
  type ProposeActionInput,
  type QualityDesk,
  QualityDeskError,
  type QualityReport,
  type RecordInspectionInput,
  type RootCause,
  type Severity,
  type Site,
  type Source,
  scoreInspection,
  stageOf,
  type Verification,
} from "./desk.js";
export {
  type CompanySection,
  PASS_SCORE_LIMIT,
  type QualityToolDependencies,
  type QualityToolset,
  qualityTools,
} from "./tools.js";

export interface QualityOptions {
  /**
   * The host's quality system: inspection software or a quality management system in production,
   * `fakeQualityDesk` in a test. Omitted, the demonstration desk when `demo` is set; otherwise none,
   * and every desk tool refuses.
   */
  readonly desk?: QualityDesk;
  /**
   * Run on the demonstration desk this package ships with when no `desk` is given. Set by the host
   * (`officehum run --demo`, the eval runner), never by a client or a user's config.
   */
  readonly demo?: boolean;
  /**
   * The company to work for. Omitted, the generated facts in this package. A host with its own
   * company passes its own, and nothing in `company/default/` is involved.
   */
  readonly company?: CompanyFacts;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /** Decides every gated action. Omitted: every closure is blocked. */
  readonly approve?: Approver;
  /**
   * The host's clock. The prompt's `today` section and the demonstration desk read it. Omitted: the
   * demonstration date (`DEMO_NOW`) on the demonstration desk, the system clock otherwise.
   */
  readonly now?: () => Date;
}

export default function quality(options: QualityOptions = {}): DefinedRole {
  // The demonstration desk is built only when the host asks for it (`demo`) and binds no desk of
  // its own; with neither, the tools refuse rather than invent records.
  const demoDesk = options.desk === undefined && options.demo === true;
  // The demonstration data is dated around DEMO_NOW, so its desk keeps that date unless the host
  // passes a clock; otherwise the role runs on the system clock. The prompt reads the same clock.
  const now = options.now ?? (demoDesk ? () => new Date(DEMO_NOW) : () => new Date());
  const company = options.company ?? loadCompanyFacts();
  // The demonstration desk scores from the company's own checklist, so a first run and a real one
  // score the same inspection the same way.
  const desk = demoDesk ? fakeQualityDesk({ company, now }) : options.desk;
  // The pass score is read from the role's own resolved limits at every call, so an overlay's value
  // is what an inspection is judged against and a reload needs no rebuild. Before the role exists
  // no limit resolves, and the desk then scores without judging rather than guessing a pass mark.
  let role: DefinedRole | undefined;
  const limits = () => role?.current().limits ?? {};
  const tools = qualityTools({ desk, company, limits });
  role = defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    now,
    // "Today" in the prompt is the company's own day, as it is on the desk, not UTC's.
    timeZone: company.hours.timezone,
    tools: [
      tools.listInspections,
      tools.recordInspection,
      tools.openNonconformance,
      tools.listNonconformances,
      tools.recordContainment,
      tools.recordRootCause,
      tools.proposeCorrectiveAction,
      tools.recordVerification,
      tools.requestClosure,
      tools.qualityReport,
      tools.readCompany,
    ],
    // The closure approval is `officehum.json`'s, on every call of request_closure. The model names
    // only the report: the gate reads its cause, action and verification from the desk, shows them
    // to the person and hands them to the tool on a yes, so the desk closes only what they saw.
    approvalFacts: { close_nonconformance: tools.closureApprovalFacts },
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
  return role;
}
