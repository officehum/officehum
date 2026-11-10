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
 * With `demo: true` and no desk the role runs on `fakePeopleOpsDesk`: the company's own crews and rules, demonstration
 * candidates and crew members in memory, and nothing written anywhere. That is
 * what `officehum run --demo` and the evals run on. With neither, the role still starts, and every
 * tool that reads or writes the desk refuses and says how to bind one.
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, defineRole, type SenderResolver } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { DEMO_NOW, fakePeopleOpsDesk, type PeopleOpsDesk } from "./desk.js";
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
  DEMO_LEAVE_ALLOWANCE_DAYS,
  DEMO_NOW,
  type DeskRefusal,
  demoCandidates,
  demoEmployees,
  demoTimeOff,
  type Employee,
  type FakePeopleOpsDeskOptions,
  fakePeopleOpsDesk,
  type LeaveBalance,
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
  type TimeOffExceptionFacts,
  type TimeOffExceptionInput,
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
   * The host's HR system: an HRIS or applicant tracker in production, `fakePeopleOpsDesk` in a test.
   * Omitted, the demonstration data when `demo` is set; otherwise none, and every desk tool refuses.
   */
  readonly desk?: PeopleOpsDesk;
  /**
   * Run on the demonstration data this package ships with when no `desk` is given. Set by the host
   * (`officehum run --demo`, the eval runner), never by a client or a user's config.
   */
  readonly demo?: boolean;
  /** The company. Omitted, the generated facts in this package. */
  readonly company?: CompanyFacts;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /** Decides every gated action. Omitted: every short-notice time-off exception is blocked. */
  readonly approve?: Approver;
  /**
   * The host's clock. The prompt's `today` section and the demonstration desk read it. Omitted: the
   * demonstration date (`DEMO_NOW`) on the demonstration desk, the system clock otherwise.
   */
  readonly now?: () => Date;
  /**
   * Who each call's work came from, as the host verified it. A time-off request is the sender's own
   * unless a person on the company record files it, and a leave balance is only ever the sender's.
   * Omitted: every sender is unknown, so no time off is recorded and no balance is given.
   */
  readonly sender?: SenderResolver;
}

export default function peopleOps(options: PeopleOpsOptions = {}): DefinedRole {
  // The demonstration desk is built only when the host asks for it (`demo`) and binds no desk of
  // its own; with neither, the tools refuse rather than invent records.
  const demoDesk = options.desk === undefined && options.demo === true;
  // The demonstration data is dated around DEMO_NOW, so its desk keeps that date unless the host
  // passes a clock; otherwise the role runs on the system clock. The prompt reads the same clock.
  const now = options.now ?? (demoDesk ? () => new Date(DEMO_NOW) : () => new Date());
  const company = options.company ?? loadCompanyFacts();
  // The demonstration desk applies the company's own notice period and routes to its own people, so a
  // first run and a real one refuse and route the same way.
  const desk = demoDesk ? fakePeopleOpsDesk({ company, now }) : options.desk;
  const tools = peopleOpsTools({
    desk,
    company,
    ...(options.sender === undefined ? {} : { sender: options.sender }),
  });
  return defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    now,
    tools: [
      tools.listCandidates,
      tools.updateCandidateStage,
      tools.onboardingChecklist,
      tools.recordTimeOffRequest,
      tools.requestTimeOffException,
      tools.listAvailability,
      tools.getLeaveBalance,
      tools.referToPerson,
      tools.readCompany,
    ],
    // The one approval is `officehum.json`'s, on every call of its tool; the SDK's gate evaluates it
    // here and in the office from the same declaration. Its facts are read from the desk (whose time
    // off, from the verified sender), shown to the person, and handed to the tool on a yes.
    approvalFacts: { time_off_exception: tools.exceptionFacts },
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
}
