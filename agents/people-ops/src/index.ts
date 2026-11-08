/**
 * The People Ops role's entry point: the factory a host calls to get the role.
 *
 * ```ts
 * import peopleOps from "@officehum/people-ops";
 *
 * const role = peopleOps({ desk: myHrSystem, approve, overlays: ["./my-people-ops"] });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 *
 * The package brings its own prompt, skills, tools, the company's facts and a demonstration pipeline
 * and crew; the host brings the desk that holds its real people records and, optionally, the person
 * who decides gated actions. Nothing here needs Office Hum, so the same bundle runs in a bare Pi
 * Durable harness.
 *
 * With no desk the role runs on `fakePeopleOpsDesk`: the company's own crews and rules, demonstration
 * candidates and crew members in memory, and nothing written anywhere.
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { fakePeopleOpsDesk, type PeopleOpsDesk } from "./desk.js";
import { peopleOpsTools } from "./tools.js";

export {
  COMPANY_FACTS_URL,
  type CompanyFacts,
  type Crew,
  companyHead,
  type EscalationRule,
  escalationOwner,
  findPeople,
  type GlossaryEntry,
  type Hours,
  loadCompanyFacts,
  type Person,
  type Profile,
  peopleOwner,
  person,
  personLabel,
  type StaffPolicies,
  type Tone,
} from "./company.js";
export {
  type BookedTimeOff,
  type Candidate,
  type CandidateFilter,
  type ChecklistStep,
  type CrewAvailability,
  DEMO_NOW,
  type DeskRefusal,
  demoCandidates,
  demoEmployees,
  demoTimeOff,
  type Employee,
  type FakePeopleOpsDeskOptions,
  fakePeopleOpsDesk,
  type MemberAvailability,
  type OnboardingChecklist,
  type PeopleOpsDesk,
  PeopleOpsDeskError,
  PROTECTED_REASONS,
  REASON_CATEGORIES,
  REFERRAL_TOPICS,
  REVIEW_STAGES,
  type ReasonCategory,
  type Referral,
  type ReferralTopic,
  STAGES,
  type Stage,
  type StageChange,
  type TimeOffInput,
  type TimeOffRequest,
} from "./desk.js";
export {
  type CompanySection,
  HINTS,
  type PeopleOpsToolDependencies,
  type PeopleOpsToolset,
  peopleOpsTools,
} from "./tools.js";

export interface PeopleOpsOptions {
  /**
   * The host's HR system: an HRIS or applicant tracker in production, `fakePeopleOpsDesk` in a test or
   * an eval. Omitted, the role runs on the demonstration data it ships with.
   */
  readonly desk?: PeopleOpsDesk;
  /** The company. Omitted, the generated facts in this package. */
  readonly company?: CompanyFacts;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /** Decides every gated action. Omitted: every short-notice time-off exception is blocked. */
  readonly approve?: Approver;
}

export default function peopleOps(options: PeopleOpsOptions = {}): DefinedRole {
  const company = options.company ?? loadCompanyFacts();
  // The demonstration desk applies the company's own notice period and routes to its own people, so a
  // first run and a real one refuse and route the same way.
  const desk = options.desk ?? fakePeopleOpsDesk({ company });
  const tools = peopleOpsTools({ desk, company });
  return defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    tools: [
      tools.listCandidates,
      tools.updateCandidateStage,
      tools.onboardingChecklist,
      tools.recordTimeOffRequest,
      tools.requestTimeOffException,
      tools.listAvailability,
      tools.referToPerson,
      tools.readCompany,
    ],
    // The one approval is `officehum.json`'s, on every call of its tool; the SDK's gate evaluates it
    // here and in the office from the same declaration.
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
}
