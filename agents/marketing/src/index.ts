/**
 * The Marketing role's entry point: the factory a host calls to get the role.
 *
 * ```ts
 * import marketing from "@officehum/marketing";
 *
 * const role = marketing({ desk: mySocialScheduler, approve, overlays: ["./my-marketing"] });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 *
 * The package brings its own prompt, skills, tools, the company's facts and a demonstration backend;
 * the host brings the desk that holds its real drafts and publishes them and, optionally, the person
 * who decides gated actions. Nothing here needs Office Hum, so the same bundle runs in a bare Pi
 * Durable harness.
 *
 * With no desk the role runs on `fakeMarketingDesk`: the company's own claims, prices and address,
 * three demonstration drafts in memory, and nothing published anywhere.
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { DEMO_NOW, fakeMarketingDesk, type MarketingDesk } from "./desk.js";
import { marketingTools } from "./tools.js";

export { findResultClaims, normalizeClaim, type ResultClaim } from "./claims.js";
export {
  type Address,
  COMPANY_FACTS_URL,
  type CompanyFacts,
  type EscalationRule,
  type GlossaryEntry,
  type Hours,
  loadCompanyFacts,
  type Marketing,
  marketingApprover,
  money,
  type Person,
  type Policies,
  type PriceBookLine,
  type Profile,
  person,
  personLabel,
  postalAddress,
  type Service,
  type Testimonial,
  type Tone,
} from "./company.js";
export {
  type Audience,
  type Channel,
  campaignFooter,
  DEMO_NOW,
  type DeskRefusal,
  type Draft,
  type DraftFilter,
  type DraftStatus,
  demoAudiences,
  demoDrafts,
  type FakeMarketingDeskOptions,
  fakeMarketingDesk,
  type MarketingDesk,
  MarketingDeskError,
  POST_CHANNELS,
  type PostChannel,
  type Publication,
  sameText,
} from "./desk.js";
export {
  type CompanySection,
  type MarketingToolDependencies,
  type MarketingToolset,
  marketingTools,
} from "./tools.js";

export interface MarketingOptions {
  /**
   * The host's marketing system: a social scheduler, an email platform or a CMS in production,
   * `fakeMarketingDesk` in a test or an eval. Omitted, the role runs on the demonstration backend it
   * ships with.
   */
  readonly desk?: MarketingDesk;
  /**
   * The company to market. Omitted, the generated facts in this package. A host with its own company
   * passes its own, and nothing in `company/default/` is involved.
   */
  readonly company?: CompanyFacts;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /** Decides every gated action. Omitted: every claim approval and every publication is blocked. */
  readonly approve?: Approver;
  /**
   * The host's clock. The prompt's `today` section and the demonstration desk read it. Omitted: the
   * demonstration date (`DEMO_NOW`) on the demonstration desk, the system clock with a host's desk.
   */
  readonly now?: () => Date;
}

export default function marketing(options: MarketingOptions = {}): DefinedRole {
  // The demonstration data is dated around DEMO_NOW, so its desk keeps that date unless the host
  // passes a clock; a host's own desk runs on the system clock. The prompt reads the same clock.
  const now =
    options.now ?? (options.desk === undefined ? () => new Date(DEMO_NOW) : () => new Date());
  const company = options.company ?? loadCompanyFacts();
  // The demonstration desk checks claims against the company's own list and signs emails with its
  // own address, so a first run and a real one refuse the same draft.
  const desk = options.desk ?? fakeMarketingDesk({ company, now });
  const tools = marketingTools({ desk, company });
  return defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    now,
    tools: [
      tools.readServices,
      tools.draftPost,
      tools.draftCampaignEmail,
      tools.requestClaimApproval,
      tools.publish,
      tools.listDrafts,
      tools.readCompany,
    ],
    // Both approvals are `officehum.json`'s, on every call of their tool; the SDK's gate evaluates
    // them here and in the office from the same declaration.
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
}
