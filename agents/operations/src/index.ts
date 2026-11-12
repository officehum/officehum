/**
 * The Operations role's entry point: the factory a host calls to get the role.
 *
 * ```ts
 * import operations from "@officehum/operations";
 *
 * const role = operations({ desk: myDispatchBoard, approve, overlays: ["./my-operations"] });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 *
 * The package brings its own prompt, skills, tools, the company's facts and a demonstration week of
 * jobs; the host brings the desk that holds its real schedule and, optionally, the person who decides
 * gated actions. Nothing here needs Office Hum, so the same bundle runs in a bare Pi Durable harness.
 *
 * With `demo: true` and no desk the role runs on `fakeOperationsDesk`: the company's own crews and caps, a week of jobs
 * in memory, and nothing written anywhere. That is
 * what `officehum run --demo` and the evals run on. With neither, the role still starts, and every
 * tool that reads or writes the desk refuses and says how to bind one.
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { DEMO_NOW, fakeOperationsDesk, type OperationsDesk } from "./desk.js";
import { operationsTools } from "./tools.js";

export {
  type Address,
  COMPANY_FACTS_URL,
  type CompanyFacts,
  type Crew,
  type EscalationRule,
  escalationRule,
  type GlossaryEntry,
  type Hours,
  loadCompanyFacts,
  type Person,
  type Policies,
  type Profile,
  person,
  personLabel,
  type Service,
  type StaffPolicies,
  scheduleOwner,
  type Tone,
} from "./company.js";
export {
  type Assignment,
  type Callout,
  type CrewWeek,
  DEMO_NOW,
  type DeskRefusal,
  demoJobs,
  demoTimeOff,
  type FakeOperationsDeskOptions,
  fakeOperationsDesk,
  type Job,
  type JobFilter,
  type OperationsDesk,
  OperationsDeskError,
  type OvertimeGrant,
  type Reschedule,
  type TimeOff,
} from "./desk.js";
export {
  type CompanySection,
  type OperationsToolDependencies,
  type OperationsToolset,
  operationsTools,
} from "./tools.js";

export interface OperationsOptions {
  /**
   * The host's scheduling system: field-service software in production, `fakeOperationsDesk` in a
   * test. Omitted, the demonstration week when `demo` is set; otherwise none, and every desk tool
   * refuses.
   */
  readonly desk?: OperationsDesk;
  /**
   * Run on the demonstration week this package ships with when no `desk` is given. Set by the host
   * (`officehum run --demo`, the eval runner), never by a client or a user's config.
   */
  readonly demo?: boolean;
  /**
   * The company to schedule for. Omitted, the generated facts in this package. A host with its own
   * company passes its own, and nothing in `company/default/` is involved.
   */
  readonly company?: CompanyFacts;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /**
   * Decides every gated action. Omitted: a contract visit's move is blocked, and so is overtime while
   * the company's `staffPolicies.overtimeNeedsApproval` holds.
   */
  readonly approve?: Approver;
  /**
   * The host's clock. The prompt's `today` section and the demonstration desk read it. Omitted: the
   * demonstration date (`DEMO_NOW`) on the demonstration desk, the system clock otherwise.
   */
  readonly now?: () => Date;
}

export default function operations(options: OperationsOptions = {}): DefinedRole {
  // The demonstration desk is built only when the host asks for it (`demo`) and binds no desk of
  // its own; with neither, the tools refuse rather than invent records.
  const demoDesk = options.desk === undefined && options.demo === true;
  // The demonstration data is dated around DEMO_NOW, so its desk keeps that date unless the host
  // passes a clock; otherwise the role runs on the system clock. The prompt reads the same clock.
  const now = options.now ?? (demoDesk ? () => new Date(DEMO_NOW) : () => new Date());
  const company = options.company ?? loadCompanyFacts();
  // The demonstration desk schedules the company's own crews against their own caps, so a first run
  // and a real one refuse the same week.
  const desk = demoDesk
    ? fakeOperationsDesk({ crews: company.crews, timeZone: company.hours.timezone, now })
    : options.desk;
  const tools = operationsTools({ desk, company });
  return defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    now,
    // The prompt's "today" is the company's day, the same one the desk reads this week from.
    timeZone: company.hours.timezone,
    tools: [
      tools.listJobs,
      tools.listCrews,
      tools.assignCrew,
      tools.requestOvertime,
      tools.rescheduleJob,
      tools.requestContractReschedule,
      tools.recordCallout,
      tools.readCompany,
    ],
    // Both approvals are `officehum.json`'s. A contract visit's move asks a person on every call.
    // Overtime asks only while the company's staff policy says it needs approval: the condition is
    // code, because it reads the company facts the host passed, which no manifest condition can. The
    // office's manifest-only gate never runs it and keeps asking on every call, which fails safe.
    when: { overtime: () => company.staffPolicies.overtimeNeedsApproval },
    // What the person is shown: the crew, the client, the dates and the hours, read from the desk
    // before anyone is asked, so they never approve a bare job id.
    approvalFacts: {
      overtime: tools.overtimeFacts,
      contract_reschedule: tools.contractRescheduleFacts,
    },
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
}
