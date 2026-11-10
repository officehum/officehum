/**
 * The Customer Support role's entry point: the factory a host calls to get the role.
 *
 * ```ts
 * import support from "@officehum/support";
 *
 * const role = support({ desk: myHelpDesk, approve, overlays: ["./my-support"] });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 *
 * The package brings its own prompt, skills, tools, the company's facts and a demonstration help
 * desk; the host brings the desk that holds its real clients, cases and invoices and, optionally, the
 * person who decides gated actions. Nothing here needs Office Hum, so the same bundle runs in a bare
 * Pi Durable harness.
 *
 * With no desk the role runs on `fakeSupportDesk`: five clients, their October invoices priced from
 * the company's price book, six cases in memory, and nothing sent anywhere.
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, defineRole, type SenderResolver } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { DEMO_NOW, fakeSupportDesk, type SupportDesk } from "./desk.js";
import { supportTools } from "./tools.js";

export {
  type Address,
  COMPANY_FACTS_URL,
  type CompanyFacts,
  companyHead,
  type EscalationRule,
  escalationOwner,
  findPeople,
  type GlossaryEntry,
  type Hours,
  loadCompanyFacts,
  money,
  type Person,
  type Policies,
  type PriceBookItem,
  type Profile,
  person,
  personLabel,
  type RefundPolicy,
  type Tone,
} from "./company.js";
export {
  CASE_CATEGORIES,
  type CaseCategory,
  type CaseFilter,
  type CaseKind,
  type CaseStatus,
  type Client,
  type ClientRecord,
  type Credit,
  type CreditFilter,
  type CreditNote,
  creditApprovalFacts,
  DEMO_NOW,
  type DeskRefusal,
  demoCases,
  demoClients,
  demoCredits,
  demoInvoices,
  ESCALATION_REASONS,
  type EscalateInput,
  type Escalation,
  type EscalationReason,
  type EscalationReceipt,
  type FakeSupportDeskOptions,
  fakeSupportDesk,
  type Invoice,
  type InvoiceLine,
  type InvoiceLineInput,
  type InvoiceRecord,
  type IssueCreditInput,
  type LogCaseInput,
  type Priority,
  type ProposeCreditInput,
  type Reclean,
  type SupportCase,
  type SupportDesk,
  SupportDeskError,
} from "./desk.js";
export {
  type CompanySection,
  type SupportToolDependencies,
  type SupportToolset,
  supportTools,
} from "./tools.js";

export interface SupportOptions {
  /**
   * The host's support system: a help desk or CRM in production, `fakeSupportDesk` in a test or an
   * eval. Omitted, the role runs on the demonstration desk it ships with.
   */
  readonly desk?: SupportDesk;
  /**
   * The company to answer for. Omitted, the generated facts in this package. A host with its own
   * company passes its own, and nothing in `company/default/` is involved.
   */
  readonly company?: CompanyFacts;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /** Decides every gated action. Omitted: every credit is blocked. */
  readonly approve?: Approver;
  /**
   * The host's clock. The prompt's `today` section and the demonstration desk read it. Omitted: the
   * demonstration date (`DEMO_NOW`) on the demonstration desk, the system clock with a host's desk.
   */
  readonly now?: () => Date;
  /**
   * Who each call's work came from, as the host verified it. A colleague on the company record may
   * read any client's cases, a client's contact on the desk only their own. Omitted: every sender is
   * unknown, so no case data is given out and a case can only be logged and handed to a person.
   */
  readonly sender?: SenderResolver;
}

export default function support(options: SupportOptions = {}): DefinedRole {
  // The demonstration data is dated around DEMO_NOW, so its desk keeps that date unless the host
  // passes a clock; a host's own desk runs on the system clock. The prompt reads the same clock.
  const now =
    options.now ?? (options.desk === undefined ? () => new Date(DEMO_NOW) : () => new Date());
  const company = options.company ?? loadCompanyFacts();
  // The demonstration desk prices invoices and works out credits from the company's own price book
  // and policies, so a first run and a real one refuse the same things.
  const desk = options.desk ?? fakeSupportDesk({ company, now });
  const tools = supportTools({
    desk,
    company,
    ...(options.sender === undefined ? {} : { sender: options.sender }),
  });
  return defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    now,
    tools: [
      tools.findClient,
      tools.listCases,
      tools.logCase,
      tools.bookReclean,
      tools.proposeCredit,
      tools.offerCredit,
      tools.withdrawCredit,
      tools.escalateCase,
      tools.resolveCase,
      tools.readCompany,
    ],
    // The credit approval is `officehum.json`'s, on every call of offer_credit. A credit names only
    // its proposal: the gate reads the proposal's facts from the desk, shows them to the person and
    // hands them to offer_credit on a yes, so the desk issues only the credit the person saw.
    approvalFacts: { any_credit: tools.creditFacts },
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
}
