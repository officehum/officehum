/**
 * The Sales / Account Manager's entry point: the factory a host calls to get the role.
 *
 * ```ts
 * import sales from "@officehum/sales";
 *
 * const role = sales({ desk: myCrm, approve, overlays: ["./my-sales"] });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 *
 * The package brings its own prompt, skills, tools, the company's facts and a demonstration pipeline;
 * the host brings the desk that holds its real leads and, optionally, the person who decides gated
 * actions. Nothing here needs Office Hum, so the same bundle runs in a bare Pi Durable harness.
 *
 * With no desk the role runs on `fakeSalesDesk`: five leads in memory, the company's own price book,
 * and nothing written anywhere. That is what makes `officehum run` work on a clean machine with no
 * account and no key — and what a host replaces on its first real day.
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { fakeSalesDesk, type SalesDesk } from "./desk.js";
import { salesTools } from "./tools.js";

export {
  type Address,
  COMPANY_FACTS_URL,
  type CompanyFacts,
  type DiscountLadderStep,
  type DiscountPolicy,
  type EscalationRule,
  escalationRule,
  type Field,
  type GlossaryEntry,
  type Hours,
  type Insurance,
  loadCompanyFacts,
  money,
  type Person,
  type Policies,
  type PriceBookItem,
  type Profile,
  person,
  priceBookItem,
  priceText,
  type RefundPolicy,
  type Service,
  searchPriceBook,
  searchWords,
  type Tone,
} from "./company.js";
export { demoLeads } from "./demo.js";
export {
  ACTIVITY_KINDS,
  type Activity,
  type ActivityDraft,
  type ActivityKind,
  type FakeSalesDeskOptions,
  fakeSalesDesk,
  LEAD_STAGES,
  type Lead,
  type LeadFilter,
  type LeadStage,
  type Quote,
  type QuoteApprovalReason,
  type QuoteDraft,
  type QuoteLine,
  type QuoteLineDraft,
  type QuoteStatus,
  quoteFacts,
  type SalesDesk,
  SalesDeskError,
  type SalesDeskRefusal,
} from "./desk.js";
export {
  type CompanySection,
  type SalesToolDependencies,
  type SalesToolset,
  salesTools,
} from "./tools.js";

export interface SalesOptions {
  /**
   * The host's system of record: a CRM in production, `fakeSalesDesk` in a test or an eval. Omitted,
   * the role runs on the demonstration pipeline it ships with, so it starts and answers on a machine
   * that has nothing else installed.
   */
  readonly desk?: SalesDesk;
  /**
   * The company to quote for. Omitted, the generated facts in this package — the default company, as
   * `npm run sync-company` wrote them. A host with its own company passes its own, and nothing in
   * `company/default/` is involved.
   */
  readonly company?: CompanyFacts;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /**
   * Decides every gated action. Omitted: a quote with a discount or over the limit stays saved
   * awaiting approval, and its approval is refused.
   */
  readonly approve?: Approver;
}

export default function sales(options: SalesOptions = {}): DefinedRole {
  const company = options.company ?? loadCompanyFacts();
  // The demonstration desk prices from the same book this role reads, so a first run and a real one
  // quote the same numbers.
  const desk = options.desk ?? fakeSalesDesk({ priceBook: company.priceBook });
  // The quote limit is read from the role's own resolved limits at every call, so an overlay's value
  // is what a quote is judged against and a reload needs no rebuild. Before the role exists no limit
  // resolves, and the desk then holds every quote for a person rather than guessing one.
  let role: DefinedRole | undefined;
  const limits = () => role?.current().limits ?? {};
  const tools = salesTools({ desk, company, limits });
  role = defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    tools: [
      tools.listLeads,
      tools.getQuote,
      tools.searchPriceBook,
      tools.logActivity,
      tools.readCompany,
    ],
    // The quote belongs to the quoting skill, which is where its checklist lives. `officehum.json`
    // declares it the same way, and `checkAgent` holds the two together.
    skillTools: {
      "quoting-from-the-price-book": [tools.createQuote, tools.requestQuoteApproval],
    },
    // The desk decides whether a quote needs a person, on the total it worked out itself, minimums
    // included; `officehum.json` declares `quote_approval` with no `when`, so every call of
    // request_quote_approval is gated. The model names only the quote: the gate reads its facts from
    // the desk, shows them to the person and hands them to the tool on a yes, so the desk approves
    // only the quote the person saw.
    approvalFacts: { quote_approval: tools.quoteApprovalFacts },
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
  return role;
}
