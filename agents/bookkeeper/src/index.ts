/**
 * The Accounting role's entry point (package `@officehum/bookkeeper`): the factory a host calls.
 *
 * ```ts
 * import bookkeeper from "@officehum/bookkeeper";
 *
 * const role = bookkeeper({ quickbooks, desk, approve, overlays: ["./my-bookkeeper"] });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 *
 * The package brings its own prompt, skills, tools and approval conditions; the host brings the
 * QuickBooks connection, its own accounts desk (payables and bank records; omitted, the
 * demonstration desk, which moves no money, when the host sets `demo`, and otherwise none, so the
 * payables tools refuse), and the person who decides gated actions. Nothing here needs Office Hum, so
 * the same bundle runs in a bare Pi Durable harness.
 */

import { fileURLToPath } from "node:url";
import type { QuickBooks } from "@officehum/quickbooks";
import { type Approver, type DefinedRole, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { type AccountingDesk, DEMO_NOW, fakeAccountingDesk } from "./desk.js";
import { payablesTools } from "./payables.js";
import { bookkeeperTools, largeInvoiceCondition, newRecipientCondition } from "./tools.js";

/**
 * The collections ledger, and the dispute marker a person owns. None of this is a tool and the
 * manifest declares none of it: a host's own script marks or clears a dispute, so the model cannot
 * declare one from a customer's message or clear one to get a reminder out.
 */
export {
  CollectionsDoc,
  type CollectionsDocument,
  clearDispute,
  type DisputeMark,
  dispute,
  disputed,
  disputedInvoices,
  type OpenDispute,
  type ReminderSent,
  type ReminderTone,
  sentStage,
} from "./collections.js";
export {
  COMPANY_FACTS_URL,
  type CompanyFacts,
  financeLead,
  loadCompanyFacts,
  money,
  type Person,
  personLabel,
  purchasingLead,
  type Supplier,
  type SupplyItem,
} from "./company.js";
export {
  type AccountingDesk,
  AccountingDeskError,
  type BankEntry,
  type BankStatement,
  type BillFilter,
  type BillLineInput,
  type BillStatus,
  billApprovalFacts,
  DEFAULT_TERMS_DAYS,
  DEMO_NOW,
  DESK_REFUSALS,
  type DeskRefusal,
  demoBills,
  demoBooks,
  demoStatements,
  type FakeAccountingDesk,
  type FakeAccountingDeskOptions,
  fakeAccountingDesk,
  type PaymentInput,
  type Reconciliation,
  type SeedBill,
  type UnmatchedItem,
  type VendorBill,
  type VendorBillLine,
  type VendorPayment,
} from "./desk.js";
export {
  MAJOR_UNMATCHED_LIMIT,
  type PayablesToolDependencies,
  type PayablesToolset,
  payablesTools,
} from "./payables.js";
export {
  type BookkeeperToolset,
  bookkeeperTools,
  type CallIdentity,
  type CollectionsCadence,
  collectionsCadence,
  collectionsStage,
  daysOverdue,
  findCustomerByReference,
  findInvoiceByReference,
  largeInvoiceCondition,
  newRecipientCondition,
  stageRequestId,
  stageStartDay,
  writeRequestId,
} from "./tools.js";

export interface BookkeeperOptions {
  /**
   * The host's QuickBooks connection: the REST client in production, `fakeQuickBooks` in a test or an
   * eval. Optional so the role still builds on a harness with no connection — its tools and
   * conditions then refuse rather than reaching for one, exactly as a role with no approver blocks
   * its gated actions.
   */
  readonly quickbooks?: QuickBooks;
  /**
   * The host's payables and bank records: accounting software in production, `fakeAccountingDesk` in
   * a test. Omitted, the demonstration desk when `demo` is set, whose payments are recorded in memory
   * and move no money; otherwise none, and every payables tool refuses.
   */
  readonly desk?: AccountingDesk;
  /**
   * Run on the demonstration accounts desk this package ships with when no `desk` is given. Set by
   * the host (`officehum run --demo`, the eval runner), never by a client or a user's config.
   */
  readonly demo?: boolean;
  /**
   * The company whose suppliers, catalogue and people the desk and the hand-offs use. Omitted, the
   * generated facts in this package.
   */
  readonly company?: CompanyFacts;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /**
   * Decides every gated action. Omitted: a large invoice, a send to another address, a final notice
   * and every supplier payment are all blocked.
   */
  readonly approve?: Approver;
  /**
   * The host's clock. The prompt's `today` section, the demonstration desk and the QuickBooks tools
   * (due dates, days overdue, reminder times) read it. Omitted: the demonstration date (`DEMO_NOW`)
   * on the demonstration desk with no QuickBooks connection, the system clock otherwise.
   */
  readonly now?: () => Date;
}

export default function bookkeeper(options: BookkeeperOptions): DefinedRole {
  // The demonstration desk is built only when the host asks for it (`demo`) and binds no desk of
  // its own; with neither, the payables tools refuse rather than invent bills.
  const demoDesk = options.desk === undefined && options.demo === true;
  // The demonstration data is dated around DEMO_NOW, so a role on it keeps that date unless the host
  // passes a clock. A host's own desk or QuickBooks connection holds real dates, so it runs on the
  // system clock. The prompt, the desk and the QuickBooks tools all read this one clock.
  const now =
    options.now ??
    (demoDesk && options.quickbooks === undefined ? () => new Date(DEMO_NOW) : () => new Date());
  // The collections cadence is read from the role's own resolved limits at every call, so an
  // overlay's value is what a reminder is measured against and a reload needs no rebuild. The
  // reader is bound to the role this call returns; before it exists no cadence resolves, and a
  // reminder then refuses rather than guessing a stage.
  let role: DefinedRole | undefined;
  const limits = () => role?.current().limits ?? {};
  const tools = bookkeeperTools(options.quickbooks, now, limits);
  const company = options.company ?? loadCompanyFacts();
  // The demonstration desk prices bills from the company's own catalogue, so a first run and a real
  // one refuse the same supplier. The major-item limit is read live, like the collections cadence.
  const payables = payablesTools({
    desk: demoDesk ? fakeAccountingDesk({ company, now }) : options.desk,
    company,
    limits,
  });
  const created = defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    now,
    tools: [
      tools.findCustomer,
      tools.listInvoices,
      tools.getInvoice,
      tools.createInvoice,
      tools.sendInvoice,
      payables.listVendorBills,
      payables.recordVendorBill,
      payables.payVendorBill,
      payables.reconcileSummary,
    ],
    // The reminder belongs to the collections skill, which is where its instructions live.
    skillTools: { collections: [tools.sendReminder] },
    // `large_invoice` is stated in `officehum.json` as the SDK's summed condition (a line's price
    // times its quantity), and stated again here as the code this role has always gated on, so the
    // role's own gate keeps deciding exactly as it did. Two readers of one policy: the role's gate
    // runs this code, the office gate reads the declaration and never runs it, and `gates.test.ts`
    // fails if the two reach different answers. `new_recipient` is code only: the address on file
    // comes from the client, which no manifest condition can read, so its declaration has no `when`
    // and the office gate asks a person about every send. That over-blocking is deliberate; the
    // README records why the manifest cannot. `final_notice` needs nothing but the tone and stays a
    // manifest condition. `any_payment` has no condition: every payment waits for a person.
    when: {
      large_invoice: largeInvoiceCondition,
      new_recipient: newRecipientCondition(options.quickbooks),
    },
    // A payment names only the bill: the gate reads its facts from the desk, shows them to the person
    // and hands them to pay_vendor_bill on a yes, so the desk pays only the bill the person saw.
    approvalFacts: { any_payment: payables.paymentApprovalFacts },
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
  role = created;
  return created;
}
