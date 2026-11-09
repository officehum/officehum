/**
 * The Purchasing role's entry point: the factory a host calls to get the role.
 *
 * ```ts
 * import purchasing from "@officehum/purchasing";
 *
 * const role = purchasing({ desk: myInventorySystem, approve, overlays: ["./my-purchasing"] });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 *
 * The package brings its own prompt, skills, tools, the company's facts and a demonstration stockroom;
 * the host brings the desk that holds its real stock and orders and, optionally, the person who
 * decides gated actions. Nothing here needs Office Hum, so the same bundle runs in a bare Pi Durable
 * harness.
 *
 * With no desk the role runs on `fakePurchasingDesk`: the company's own suppliers, catalogue and
 * spending limit, a stockroom and three orders in memory, and nothing sent anywhere.
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { DEMO_NOW, fakePurchasingDesk, type PurchasingDesk } from "./desk.js";
import { purchasingTools } from "./tools.js";

export {
  type Address,
  type ApprovalLimits,
  COMPANY_FACTS_URL,
  type CompanyFacts,
  type EscalationRule,
  type GlossaryEntry,
  type Hours,
  loadCompanyFacts,
  money,
  type Person,
  type Policies,
  type Profile,
  person,
  personLabel,
  purchasingLead,
  type Supplier,
  type SupplyItem,
  type Tone,
} from "./company.js";
export {
  DEMO_NOW,
  type DeskRefusal,
  demoOffers,
  demoOrders,
  demoStock,
  draftFacts,
  type FakePurchasingDeskOptions,
  fakePurchasingDesk,
  type GoodsReceipt,
  type OfferLine,
  type OrderFilter,
  type OrderLineInput,
  type OrderStatus,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type PurchasingDesk,
  PurchasingDeskError,
  type StockLevel,
  type SupplierApproval,
  type SupplierComparison,
  type SupplierOffer,
  type SupplierRecord,
  supplierFacts,
} from "./desk.js";
export {
  type CompanySection,
  type PurchasingToolDependencies,
  type PurchasingToolset,
  purchasingTools,
} from "./tools.js";

export interface PurchasingOptions {
  /**
   * The host's purchasing system: an ERP or inventory software in production, `fakePurchasingDesk`
   * in a test or an eval. Omitted, the role runs on the demonstration stockroom it ships with.
   */
  readonly desk?: PurchasingDesk;
  /**
   * The company to buy for. Omitted, the generated facts in this package. A host with its own company
   * passes its own, and nothing in `company/default/` is involved.
   */
  readonly company?: CompanyFacts;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /** Decides every gated action. Omitted: an order over the limit and a new supplier are both blocked. */
  readonly approve?: Approver;
  /**
   * The host's clock. The prompt's `today` section and the demonstration desk read it. Omitted: the
   * demonstration date (`DEMO_NOW`) on the demonstration desk, the system clock with a host's desk.
   */
  readonly now?: () => Date;
}

export default function purchasing(options: PurchasingOptions = {}): DefinedRole {
  // The demonstration data is dated around DEMO_NOW, so its desk keeps that date unless the host
  // passes a clock; a host's own desk runs on the system clock. The prompt reads the same clock.
  const now =
    options.now ?? (options.desk === undefined ? () => new Date(DEMO_NOW) : () => new Date());
  const company = options.company ?? loadCompanyFacts();
  // The demonstration desk prices and limits from the company's own catalogue and limit, so a first
  // run and a real one refuse the same order.
  const desk = options.desk ?? fakePurchasingDesk({ company, now });
  const tools = purchasingTools({ desk, company });
  return defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    now,
    tools: [
      tools.listStock,
      tools.listSuppliers,
      tools.compareSuppliers,
      tools.listPurchaseOrders,
      tools.raisePurchaseOrder,
      tools.requestPoApproval,
      tools.requestNewSupplier,
      tools.recordReceipt,
      tools.readCompany,
    ],
    // Both approvals are `officehum.json`'s, on every call of their tool; the SDK's gate evaluates
    // them here and in the office from the same declaration. Neither has a `when`, so every call
    // gets facts: the model names the draft or the supplier, the gate reads what the person approves
    // from the desk and hands it to the tool on a yes, and the desk writes only what they saw.
    approvalFacts: {
      po_over_limit: tools.poApprovalFacts,
      new_supplier: tools.newSupplierApprovalFacts,
    },
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
}
