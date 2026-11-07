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
 * With no desk the role runs on `fakeOperationsDesk`: the company's own crews and caps, a week of jobs
 * in memory, and nothing written anywhere.
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { fakeOperationsDesk, type OperationsDesk } from "./desk.js";
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
   * test or an eval. Omitted, the role runs on the demonstration week it ships with.
   */
  readonly desk?: OperationsDesk;
  /**
   * The company to schedule for. Omitted, the generated facts in this package. A host with its own
   * company passes its own, and nothing in `company/default/` is involved.
   */
  readonly company?: CompanyFacts;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /** Decides every gated action. Omitted: overtime and a contract visit's move are both blocked. */
  readonly approve?: Approver;
}

export default function operations(options: OperationsOptions = {}): DefinedRole {
  const company = options.company ?? loadCompanyFacts();
  // The demonstration desk schedules the company's own crews against their own caps, so a first run
  // and a real one refuse the same week.
  const desk = options.desk ?? fakeOperationsDesk({ crews: company.crews });
  const tools = operationsTools({ desk, company });
  return defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
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
    // Both approvals are `officehum.json`'s, on every call of their tool; the SDK's gate evaluates
    // them here and in the office from the same declaration.
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
}
