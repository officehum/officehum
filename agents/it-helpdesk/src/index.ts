/**
 * The IT Help Desk role's entry point: the factory a host calls to get the role.
 *
 * ```ts
 * import itHelpdesk from "@officehum/it-helpdesk";
 *
 * const role = itHelpdesk({ desk: myHelpDesk, approve, sender, overlays: ["./my-it"] });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 *
 * The package brings its own prompt, skills, tools, the company's facts and a demonstration desk; the
 * host brings the desk that holds its real tickets, directory and asset register, the verified sender
 * of each call's work and, optionally, the person who decides gated actions. Nothing here needs
 * Office Hum, so the same bundle runs in a bare Pi Durable harness.
 *
 * With `demo: true` and no desk the role runs on `fakeItDesk`: the company's people as accounts,
 * three tickets and an asset register, in memory, with nothing sent anywhere. That is what
 * `officehum run --demo` and the evals run on. With neither, the role still starts, and every tool
 * that reads or writes the desk refuses and says how to bind one.
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, defineRole, type SenderResolver } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { DEMO_NOW, fakeItDesk, type ItDesk } from "./desk.js";
import { adminResetGuard, itHelpdeskTools } from "./tools.js";

export {
  type AccessGroup,
  COMPANY_FACTS_URL,
  type CompanyFacts,
  type EscalationRule,
  type GlossaryEntry,
  type Hours,
  type ItPolicy,
  type ItSystem,
  itApprover,
  loadCompanyFacts,
  type Person,
  type Profile,
  person,
  personLabel,
  purchasingDecider,
  systemOwner,
  type Tone,
} from "./company.js";
export {
  type AccessGrant,
  type AccessInput,
  type Account,
  type AccountStatus,
  ASSET_STATUSES,
  type Asset,
  type AssetStatus,
  CATEGORIES,
  type Category,
  CONCERN_KINDS,
  type ConcernKind,
  DEMO_NOW,
  type DeskRefusal,
  type Disabled,
  type DisableInput,
  demoAssets,
  demoMemberships,
  demoTickets,
  type FakeItDeskOptions,
  fakeItDesk,
  type GroupView,
  IMPACTS,
  type Impact,
  type ItDesk,
  ItDeskError,
  type NamedPerson,
  type Priority,
  priorityFor,
  type ResetReceipt,
  type Resolution,
  type SecurityReport,
  type SetupInput,
  type SignInChange,
  type SignInChangeInput,
  TICKET_STATUSES,
  type Ticket,
  type TicketStatus,
} from "./desk.js";
export {
  type CompanySection,
  HINTS,
  type ItHelpdeskToolDependencies,
  type ItHelpdeskToolset,
  itHelpdeskTools,
} from "./tools.js";

export interface ItHelpdeskOptions {
  /**
   * The host's help desk: its ticketing system, directory and asset register in production,
   * `fakeItDesk` in a test. Omitted, the demonstration desk when `demo` is set; otherwise none, and
   * every desk tool refuses.
   */
  readonly desk?: ItDesk;
  /**
   * Run on the demonstration desk this package ships with when no `desk` is given. Set by the host
   * (`officehum run --demo`, the eval runner), never by a user's config.
   */
  readonly demo?: boolean;
  /** The company. Omitted, the generated facts in this package. */
  readonly company?: CompanyFacts;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /**
   * Decides every gated action. Omitted: every access grant, sign-in method change, account setup
   * and account disable is blocked.
   */
  readonly approve?: Approver;
  /**
   * The host's clock. The prompt's `today` section and the demonstration desk read it. Omitted: the
   * demonstration date (`DEMO_NOW`) on the demonstration desk, the system clock otherwise.
   */
  readonly now?: () => Date;
  /**
   * Who each call's work came from, as the host verified it. The desk answers only a colleague
   * writing from inside the office, and the account tools act only on the sender's own account.
   * Omitted: every sender is unknown, so nothing is read, sent or changed.
   */
  readonly sender?: SenderResolver;
}

export default function itHelpdesk(options: ItHelpdeskOptions = {}): DefinedRole {
  // The demonstration desk is built only when the host asks for it (`demo`) and binds no desk of
  // its own; with neither, the tools refuse rather than invent records.
  const demoDesk = options.desk === undefined && options.demo === true;
  // The demonstration data is dated around DEMO_NOW, so its desk keeps that date unless the host
  // passes a clock; otherwise the role runs on the system clock. The prompt reads the same clock.
  const now = options.now ?? (demoDesk ? () => new Date(DEMO_NOW) : () => new Date());
  const company = options.company ?? loadCompanyFacts();
  // The demonstration desk builds its accounts from the company's own people and groups, so a first
  // run and a real one refuse the same privileged group and the same account.
  const desk = demoDesk ? fakeItDesk({ company, now }) : options.desk;
  const tools = itHelpdeskTools({
    desk,
    company,
    ...(options.sender === undefined ? {} : { sender: options.sender }),
  });
  return defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    now,
    // "Today" in the prompt is the company's own day, as it is on the desk, not UTC's.
    timeZone: company.hours.timezone,
    tools: [
      tools.listTickets,
      tools.logTicket,
      tools.escalateTicket,
      tools.resolveTicket,
      tools.listMyAccess,
      tools.sendPasswordReset,
      tools.requestSignInMethodChange,
      tools.requestAccess,
      tools.requestAccountSetup,
      tools.requestAccountDisable,
      tools.listAssets,
      tools.assignAsset,
      tools.returnAsset,
      tools.reportSecurityConcern,
      tools.readCompany,
    ],
    // The four approvals are `officehum.json`'s, on every call of their tools. Each one's facts are
    // read from the desk (whose account, which group, from the verified sender), shown to the person,
    // and handed to the tool on a yes; a reader that refuses asks nobody.
    approvalFacts: {
      sign_in_method_change: tools.signInChangeFacts,
      access_grant: tools.accessFacts,
      account_setup: tools.setupFacts,
      account_disable: tools.disableFacts,
    },
    // An administrator's account is reset only in person: refused in front of any directory.
    hooks: [adminResetGuard(desk, company, options.sender)],
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
}
