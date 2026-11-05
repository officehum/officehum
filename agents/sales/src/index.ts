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
export {
  ACTIVITY_KINDS,
  type Activity,
  type ActivityDraft,
  type ActivityKind,
  demoLeads,
  type FakeSalesDeskOptions,
  fakeSalesDesk,
  LEAD_STAGES,
  type Lead,
  type LeadFilter,
  type LeadStage,
  type Quote,
  type QuoteDraft,
  type QuoteLine,
  type QuoteLineDraft,
  type SalesDesk,
  SalesDeskError,
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
  /** Decides every gated action. Omitted: a discount and an over-limit quote are both blocked. */
  readonly approve?: Approver;
}

export default function sales(options: SalesOptions = {}): DefinedRole {
  const company = options.company ?? loadCompanyFacts();
  // The demonstration desk prices from the same book this role reads, so a first run and a real one
  // quote the same numbers.
  const desk = options.desk ?? fakeSalesDesk({ priceBook: company.priceBook });
  const tools = salesTools({ desk, company });
  return defineRole({
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
    skillTools: { "quoting-from-the-price-book": [tools.createQuote] },
    // Both approvals are `officehum.json`'s own conditions — a discount present, and a sum over the
    // lines above the business's limit — so there is no second reader of the policy in code. The
    // SDK's gate evaluates them here and in the office, from the same declaration.
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
}
