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
 * With `demo: true` and no desk the role runs on `fakePurchasingDesk`: the company's own suppliers, catalogue and
 * spending limit, a stockroom and four orders in memory, and nothing sent anywhere. That is
 * what `officehum run --demo` and the evals run on. With neither, the role still starts, and every
 * tool that reads or writes the desk refuses and says how to bind one.
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, defineRole, type SenderResolver } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { DEMO_NOW, fakePurchasingDesk, type PurchasingDesk } from "./desk.js";
import { purchaseOrderReplyCheck } from "./reply-check.js";
import { purchasingTools } from "./tools.js";

export {
  type Address,
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
  type OrderReason,
  type OrderStatus,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type PurchasingDesk,
  PurchasingDeskError,
  type RaisePurchaseOrderInput,
  type RecalledOrder,
  type RecordReceiptInput,
  type StockLevel,
  type SupplierApproval,
  type SupplierComparison,
  type SupplierOffer,
  type SupplierRecord,
  supplierFacts,
} from "./desk.js";
export { purchaseOrderIds, purchaseOrderReplyCheck } from "./reply-check.js";
export {
  type CompanySection,
  type PurchasingToolDependencies,
  type PurchasingToolset,
  purchasingTools,
} from "./tools.js";

export interface PurchasingOptions {
  /**
   * The host's purchasing system: an ERP or inventory software in production, `fakePurchasingDesk`
   * in a test. Omitted, the demonstration stockroom when `demo` is set; otherwise none, and every
   * desk tool refuses.
   */
  readonly desk?: PurchasingDesk;
  /**
   * Run on the demonstration stockroom this package ships with when no `desk` is given. Set by the host
   * (`officehum run --demo`, the eval runner), never by a client or a user's config.
   */
  readonly demo?: boolean;
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
   * demonstration date (`DEMO_NOW`) on the demonstration desk, the system clock otherwise.
   */
  readonly now?: () => Date;
  /**
   * Who each call's work came from, as the host verified it. An order's requester and a delivery's
   * reporter are the person on the company record it names. Omitted: every sender is unknown, so a
   * requested order and a receipt are both refused.
   */
  readonly sender?: SenderResolver;
}

export default function purchasing(options: PurchasingOptions = {}): DefinedRole {
  // The demonstration desk is built only when the host asks for it (`demo`) and binds no desk of
  // its own; with neither, the tools refuse rather than invent records.
  const demoDesk = options.desk === undefined && options.demo === true;
  // The demonstration data is dated around DEMO_NOW, so its desk keeps that date unless the host
  // passes a clock; otherwise the role runs on the system clock. The prompt reads the same clock.
  const now = options.now ?? (demoDesk ? () => new Date(DEMO_NOW) : () => new Date());
  const company = options.company ?? loadCompanyFacts();
  // The demonstration desk prices from the company's own catalogue, so a first run and a real one
  // price the same order.
  const desk = demoDesk ? fakePurchasingDesk({ company, now }) : options.desk;
  // The spending limit is read from the role's own resolved limits at every call, so an overlay's
  // value is what an order is judged against and a reload needs no rebuild. Before the role exists
  // no limit resolves, and the desk then holds every order for a person rather than guessing one.
  let role: DefinedRole | undefined;
  const limits = () => role?.current().limits ?? {};
  const tools = purchasingTools({
    desk,
    company,
    limits,
    ...(options.sender === undefined ? {} : { sender: options.sender }),
  });
  role = defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    now,
    // "Today" in the prompt is the company's own day, as it is on the desk, not UTC's.
    timeZone: company.hours.timezone,
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
    // A purchase order number named only in a reply reaches no tool; this checks it against the desk.
    hooks: [purchaseOrderReplyCheck(desk)],
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
  return role;
}
