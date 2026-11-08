/**
 * The accounts desk: the payables and bank records this role reads supplier bills and statements
 * from, and writes bills and demonstration payments to.
 *
 * A host binds its own (accounting software, a bank feed) and the role never knows the difference.
 * `fakeAccountingDesk` is what ships with the package: the company's own suppliers and catalogue, four
 * demonstration bills and one month's bank statement, and all the money and date arithmetic done here,
 * so a test, an eval or a first run needs no network, no credential and no clock in the model.
 *
 * The desk owns every number. The model names a supplier, catalogue items and quantities; the desk
 * prices each line from the catalogue, works out the total and the due date, decides which bills are
 * due or overdue, pays exactly a bill's own total, and matches the statement against the books. A
 * refusal carries a code, and the tools turn the code into the next step a person can take.
 *
 * Paying is a demonstration backend only: the fake records a payment in memory and moves no money.
 */

import type { CompanyFacts, Supplier, SupplyItem } from "./company.js";
import { loadCompanyFacts, money } from "./company.js";

/** One line of a supplier bill, priced from the supply catalogue. */
export interface VendorBillLine {
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  readonly quantity: number;
  readonly unitCostCents: number;
  readonly lineTotalCents: number;
}

/**
 * Where a bill stands today, worked out by the desk from its due date and the desk's clock: `paid`,
 * `overdue` (past its due date), `due` (due within the desk's due-soon window) or `open`.
 */
export type BillStatus = "open" | "due" | "overdue" | "paid";

/** A supplier bill as the desk holds it, with its provenance: who recorded it, and from what. */
export interface VendorBill {
  readonly id: string;
  readonly supplierId: string;
  readonly supplierName: string;
  /** The supplier's own invoice number. */
  readonly supplierInvoice: string;
  readonly lines: readonly VendorBillLine[];
  readonly totalCents: number;
  /** `YYYY-MM-DD` the bill was recorded. */
  readonly recordedOn: string;
  /** The person who recorded it. */
  readonly recordedBy: string;
  /** The document or message it was recorded from. */
  readonly source: string;
  /** `YYYY-MM-DD`, the recorded date plus the supplier's payment terms. */
  readonly dueOn: string;
  readonly status: BillStatus;
  /** Whole days from the desk's today to the due date; negative once overdue. */
  readonly daysUntilDue: number;
  readonly paidOn: string | null;
  readonly paymentId: string | null;
  /** 1 when recorded; each correction adds one, so a payment approved before it is refused. */
  readonly revision: number;
}

/** A demonstration payment of one bill, for exactly the bill's total. */
export interface VendorPayment {
  readonly id: string;
  readonly billId: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly supplierInvoice: string;
  readonly amountCents: number;
  readonly paidOn: string;
  /** Always true here: the shipped backend records the payment and moves no money. */
  readonly demo: true;
}

/** One line of a bank statement or of the books' bank account, signed: money in is positive. */
export interface BankEntry {
  readonly date: string;
  readonly description: string;
  readonly amountCents: number;
  /** A reference both sides may carry (an invoice number, a payment id), or null. */
  readonly reference: string | null;
}

/** One month's bank statement. */
export interface BankStatement {
  /** `YYYY-MM`. */
  readonly period: string;
  readonly openingCents: number;
  readonly lines: readonly BankEntry[];
}

/** An item the desk could not match: on the statement and not in the books, or the other way round. */
export interface UnmatchedItem extends BankEntry {
  readonly side: "statement_only" | "books_only";
  /** Its size is over the business's major-item limit, or the limit did not resolve. */
  readonly major: boolean;
}

/** A period's reconciliation, every figure worked out by the desk. */
export interface Reconciliation {
  readonly period: string;
  readonly openingCents: number;
  readonly statementClosingCents: number;
  readonly booksClosingCents: number;
  /** Statement closing minus books closing. */
  readonly differenceCents: number;
  readonly matched: number;
  readonly unmatched: readonly UnmatchedItem[];
  /** The limit an unmatched item was measured against; null when none resolved. */
  readonly majorOverCents: number | null;
}

export interface BillLineInput {
  readonly itemId: string;
  readonly quantity: number;
}

export interface BillFilter {
  /** `unpaid` is every bill not yet paid. Omitted: every bill. */
  readonly status?: BillStatus | "unpaid";
  /** All or part of the supplier's name, or its id. */
  readonly supplier?: string;
  /** One bill by its id, e.g. BILL-2001. */
  readonly billId?: string;
}

/**
 * What a payment names: the bill, and the facts about it the person approving saw. The desk pays the
 * bill's own total, never this one; it refuses when any of these is not the bill as it stands.
 */
export interface PaymentInput {
  readonly billId: string;
  readonly supplierId: string;
  readonly supplierInvoice: string;
  readonly recordedBy: string;
  /** What the bill was recorded from, as the desk shows it: the main signal of where it came from. */
  readonly source: string;
  readonly lines: readonly BillLineInput[];
  readonly totalCents: number;
}

/** What the role needs from whatever system holds its payables and bank records. */
export interface AccountingDesk {
  listVendorBills(filter?: BillFilter): Promise<readonly VendorBill[]>;
  recordVendorBill(
    input: {
      readonly supplier: string;
      readonly supplierInvoice: string;
      readonly lines: readonly BillLineInput[];
      readonly recordedBy: string;
      readonly source: string;
      readonly termsDays?: number;
    },
    options: { readonly requestId: string },
  ): Promise<VendorBill>;
  /**
   * Pays one bill, for its own total. Called only once a person approved exactly this bill. A host
   * desk must refuse with `bill_changed` when the bill was corrected after the facts in `input` were
   * read, with `source_mismatch` when the bill was recorded from something other than `source`, and
   * with `bill_mismatch` when the other facts are not the bill's, so a grant never pays a bill nobody
   * was shown.
   */
  payVendorBill(
    input: PaymentInput,
    options: { readonly requestId: string },
  ): Promise<VendorPayment>;
  /**
   * Matches a month's statement against the books. `month` is the month's number (10 for October):
   * the desk works out the year, as the last month with that number that has ended, because the role
   * has no clock. Omitted: the last full month. `majorOverCents` null: every unmatched item is major.
   */
  reconcile(input: {
    readonly month?: number;
    readonly majorOverCents: number | null;
  }): Promise<Reconciliation>;
}

/** Why the desk refused, so a tool can say what to do next without parsing the message. */
export type DeskRefusal =
  | "not_found"
  | "invalid"
  | "unknown_supplier"
  | "unapproved_supplier"
  | "not_supplied"
  | "duplicate_bill"
  | "already_paid"
  | "bill_mismatch"
  | "source_mismatch"
  | "bill_changed"
  | "no_statement";

/** Every refusal code, so a test can hold the tools to a next step for each. */
export const DESK_REFUSALS: readonly DeskRefusal[] = [
  "not_found",
  "invalid",
  "unknown_supplier",
  "unapproved_supplier",
  "not_supplied",
  "duplicate_bill",
  "already_paid",
  "bill_mismatch",
  "source_mismatch",
  "bill_changed",
  "no_statement",
];

/** A refusal the model reads: an unknown supplier, a bill already paid, a bill that changed. */
export class AccountingDeskError extends Error {
  readonly code: DeskRefusal;
  /** For a refusal about one bill (duplicate, paid, mismatch, source, changed): the bill concerned. */
  readonly billId: string | undefined;

  constructor(code: DeskRefusal, message: string, extra: { readonly billId?: string } = {}) {
    super(message);
    this.name = "AccountingDeskError";
    this.code = code;
    this.billId = extra.billId;
  }
}

/** A bill as seeded: what was recorded, before the desk works out where it stands. */
export interface SeedBill {
  readonly id: string;
  readonly supplierId: string;
  readonly supplierInvoice: string;
  readonly lines: readonly BillLineInput[];
  readonly recordedOn: string;
  readonly recordedBy: string;
  readonly source: string;
  readonly termsDays: number;
  readonly paidOn?: string;
  readonly paymentId?: string;
}

export interface FakeAccountingDeskOptions {
  /** The suppliers and catalogue; the company's own when omitted. */
  readonly company?: Pick<CompanyFacts, "suppliers" | "supplyCatalog">;
  /** Bills already on the desk; the demonstration ones when omitted. */
  readonly bills?: readonly SeedBill[];
  /** Bank statements; the demonstration October when omitted. */
  readonly statements?: readonly BankStatement[];
  /** The books' bank account entries; the demonstration ones when omitted. */
  readonly books?: readonly BankEntry[];
  /** How many days ahead a bill counts as due. Omitted: 7. */
  readonly dueSoonDays?: number;
  /** The clock. Omitted: Monday 9 November 2026, the morning of the demonstration week. */
  readonly now?: () => Date;
}

/** The fake desk, plus the correction a person makes to a bill in the accounting system. */
export interface FakeAccountingDesk extends AccountingDesk {
  /**
   * A person corrects a bill's lines: a host operation, never a tool. The bill's revision goes up, so
   * a payment approved on the old facts is refused.
   */
  correctVendorBill(billId: string, lines: readonly BillLineInput[]): Promise<VendorBill>;
}

/** Monday 9 November 2026, at the start of the office day on the US west coast. */
export const DEMO_NOW = "2026-11-09T16:00:00.000Z";

/** Default payment terms when a bill states none: thirty days from the day it is recorded. */
export const DEFAULT_TERMS_DAYS = 30;

/**
 * The demonstration bills on the morning of Monday 9 November 2026: Rainier's is overdue, Pacific's
 * is due this week, Columbia's is open, and Cascade's was paid in October. Every line is a catalogue
 * item from the bill's own supplier, so the desk prices it exactly as it would a new one.
 */
export function demoBills(): readonly SeedBill[] {
  return [
    {
      id: "BILL-1998",
      supplierId: "sup-cascade-paper",
      supplierInvoice: "CP-3310",
      lines: [{ itemId: "toilet-tissue", quantity: 16 }],
      recordedOn: "2026-09-25",
      recordedBy: "Eileen Hart",
      source: "PDF invoice CP-3310 emailed by accounts@cascadepaper.example on 2026-09-25",
      termsDays: 30,
      paidOn: "2026-10-20",
      paymentId: "PAY-501",
    },
    {
      id: "BILL-2001",
      supplierId: "sup-rainier-tools",
      supplierInvoice: "RT-5520",
      lines: [
        { itemId: "microfiber-cloth", quantity: 20 },
        { itemId: "mop-head", quantity: 12 },
      ],
      recordedOn: "2026-10-05",
      recordedBy: "Eileen Hart",
      source: "PDF invoice RT-5520 emailed by sales@rainiertools.example on 2026-10-05",
      termsDays: 30,
    },
    {
      id: "BILL-2002",
      supplierId: "sup-pacific-janitorial",
      supplierInvoice: "PJ-55790",
      lines: [
        { itemId: "disinfectant", quantity: 12 },
        { itemId: "nitrile-gloves", quantity: 5 },
      ],
      recordedOn: "2026-10-16",
      recordedBy: "Eileen Hart",
      source: "paper invoice PJ-55790 delivered with the goods on 2026-10-16",
      termsDays: 30,
    },
    {
      id: "BILL-2003",
      supplierId: "sup-columbia-floor",
      supplierInvoice: "CF-7731",
      lines: [{ itemId: "floor-pad", quantity: 6 }],
      recordedOn: "2026-11-05",
      recordedBy: "Eileen Hart",
      source: "PDF invoice CF-7731 emailed by orders@columbiafloor.example on 2026-11-05",
      termsDays: 30,
    },
  ];
}

/** October 2026's bank statement: two customer deposits, Cascade's payment, a lease debit and a fee. */
export function demoStatements(): readonly BankStatement[] {
  return [
    {
      period: "2026-10",
      openingCents: 4_825_000,
      lines: [
        {
          date: "2026-10-03",
          description: "Deposit, customer payment for invoice 1031",
          amountCents: 345_000,
          reference: "1031",
        },
        {
          date: "2026-10-09",
          description: "Deposit, customer payment for invoice 1036",
          amountCents: 198_000,
          reference: "1036",
        },
        {
          date: "2026-10-20",
          description: "ACH payment to Cascade Paper & Packaging, CP-3310",
          amountCents: -86_400,
          reference: "PAY-501",
        },
        {
          date: "2026-10-24",
          description: "ACH debit, WESTCOAST EQUIP LEASING",
          amountCents: -124_000,
          reference: null,
        },
        {
          date: "2026-10-31",
          description: "Monthly account service charge",
          amountCents: -1_800,
          reference: null,
        },
      ],
    },
  ];
}

/** The books' bank account for October: the two receipts and Cascade's payment, nothing else. */
export function demoBooks(): readonly BankEntry[] {
  return [
    {
      date: "2026-10-03",
      description: "Customer receipt, invoice 1031",
      amountCents: 345_000,
      reference: "1031",
    },
    {
      date: "2026-10-09",
      description: "Customer receipt, invoice 1036",
      amountCents: 198_000,
      reference: "1036",
    },
    {
      date: "2026-10-20",
      description: "Payment of BILL-1998 to Cascade Paper & Packaging",
      amountCents: -86_400,
      reference: "PAY-501",
    },
  ];
}

const DAY_MS = 86_400_000;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return isoDate(new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS));
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS,
  );
}

/** Text compared the way a person would: case and surrounding space do not matter. */
function same(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * The last ended month with a given number, as `YYYY-MM`: this year's when it is before the current
 * month, last year's otherwise (the current month has not ended). Omitted: the month before today's.
 */
function endedMonth(today: string, wanted?: number): string {
  const year = Number(today.slice(0, 4));
  const current = Number(today.slice(5, 7));
  const month = wanted ?? (current === 1 ? 12 : current - 1);
  const inYear = month < current ? year : year - 1;
  return `${inYear}-${String(month).padStart(2, "0")}`;
}

interface BillState {
  id: string;
  supplierId: string;
  supplierName: string;
  supplierInvoice: string;
  lines: VendorBillLine[];
  totalCents: number;
  recordedOn: string;
  recordedBy: string;
  source: string;
  dueOn: string;
  paidOn: string | null;
  paymentId: string | null;
  revision: number;
  /** The lines of every earlier revision, so a payment approved on one of them is told so. */
  earlier: { lines: VendorBillLine[]; totalCents: number }[];
}

/** An in-memory desk: the company's suppliers and catalogue, demonstration bills, no money moved. */
export function fakeAccountingDesk(options: FakeAccountingDeskOptions = {}): FakeAccountingDesk {
  const facts = options.company ?? loadCompanyFacts();
  const suppliers: readonly Supplier[] = facts.suppliers;
  const catalog: readonly SupplyItem[] = facts.supplyCatalog;
  const clock = options.now ?? (() => new Date(DEMO_NOW));
  const dueSoonDays = options.dueSoonDays ?? 7;
  const statements = options.statements ?? demoStatements();
  const books: BankEntry[] = [...(options.books ?? demoBooks())];
  // Every write is remembered by its request id, so a replayed call is answered with what it already
  // did and never records or pays twice.
  const recorded = new Map<string, VendorBill>();
  const payments = new Map<string, VendorPayment>();
  let paymentNumber = 600;

  const today = (): string => isoDate(clock());

  const findSupplier = (query: string): Supplier => {
    const supplier = suppliers.find(
      (candidate) => same(candidate.id, query) || same(candidate.name, query),
    );
    if (supplier === undefined) {
      throw new AccountingDeskError(
        "unknown_supplier",
        `${JSON.stringify(query)} is not a supplier on file, so no bill from it can be recorded or paid. Nothing was recorded.`,
      );
    }
    return supplier;
  };

  /** Each line priced from the catalogue, and only items this supplier supplies. */
  const price = (supplier: Supplier, lines: readonly BillLineInput[]): VendorBillLine[] => {
    if (lines.length === 0) {
      throw new AccountingDeskError("invalid", "A bill needs at least one item and quantity.");
    }
    const seen = new Set<string>();
    return lines.map((input) => {
      const item = catalog.find(
        (candidate) => same(candidate.id, input.itemId) || same(candidate.name, input.itemId),
      );
      if (item === undefined || item.supplierId !== supplier.id) {
        throw new AccountingDeskError(
          "not_supplied",
          `${JSON.stringify(input.itemId)} is not an item ${supplier.name} supplies in the supply catalogue, so the desk cannot price that line. Nothing was recorded.`,
        );
      }
      if (seen.has(item.id)) {
        throw new AccountingDeskError(
          "invalid",
          `${item.id} appears twice: give each item once, with its whole quantity.`,
        );
      }
      seen.add(item.id);
      if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
        throw new AccountingDeskError(
          "invalid",
          `${String(input.quantity)} is not a quantity for ${item.id}: give a whole number, 1 or more.`,
        );
      }
      return {
        itemId: item.id,
        name: item.name,
        unit: item.unit,
        quantity: input.quantity,
        unitCostCents: item.unitCostCents,
        lineTotalCents: input.quantity * item.unitCostCents,
      };
    });
  };

  const total = (lines: readonly VendorBillLine[]): number =>
    lines.reduce((sum, line) => sum + line.lineTotalCents, 0);

  const bills: BillState[] = (options.bills ?? demoBills()).map((seed) => {
    const supplier = findSupplier(seed.supplierId);
    const lines = price(supplier, seed.lines);
    return {
      id: seed.id,
      supplierId: supplier.id,
      supplierName: supplier.name,
      supplierInvoice: seed.supplierInvoice,
      lines,
      totalCents: total(lines),
      recordedOn: seed.recordedOn,
      recordedBy: seed.recordedBy,
      source: seed.source,
      dueOn: addDays(seed.recordedOn, seed.termsDays),
      paidOn: seed.paidOn ?? null,
      paymentId: seed.paymentId ?? null,
      revision: 1,
      earlier: [],
    };
  });

  const nextBillId = (): string => {
    const highest = Math.max(2000, ...bills.map((bill) => Number(bill.id.replace(/\D/g, ""))));
    return `BILL-${highest + 1}`;
  };

  const snapshot = (bill: BillState): VendorBill => {
    const daysUntilDue = daysBetween(today(), bill.dueOn);
    const status: BillStatus =
      bill.paidOn !== null
        ? "paid"
        : daysUntilDue < 0
          ? "overdue"
          : daysUntilDue <= dueSoonDays
            ? "due"
            : "open";
    return {
      id: bill.id,
      supplierId: bill.supplierId,
      supplierName: bill.supplierName,
      supplierInvoice: bill.supplierInvoice,
      lines: bill.lines.map((line) => ({ ...line })),
      totalCents: bill.totalCents,
      recordedOn: bill.recordedOn,
      recordedBy: bill.recordedBy,
      source: bill.source,
      dueOn: bill.dueOn,
      status,
      daysUntilDue,
      paidOn: bill.paidOn,
      paymentId: bill.paymentId,
      revision: bill.revision,
    };
  };

  const findBill = (id: string): BillState => {
    const bill = bills.find((candidate) => same(candidate.id, id));
    if (bill === undefined) {
      throw new AccountingDeskError(
        "not_found",
        `No bill on the desk has the id ${JSON.stringify(id)}.`,
      );
    }
    return bill;
  };

  /** The lines a payment named, as item and quantity, against a priced set. */
  const sameLines = (named: readonly BillLineInput[], priced: readonly VendorBillLine[]): boolean =>
    named.length === priced.length &&
    priced.every((line) =>
      named.some((entry) => same(entry.itemId, line.itemId) && entry.quantity === line.quantity),
    );

  return {
    async listVendorBills(filter = {}): Promise<readonly VendorBill[]> {
      return bills
        .map(snapshot)
        .filter((bill) => filter.billId === undefined || same(bill.id, filter.billId))
        .filter(
          (bill) =>
            filter.supplier === undefined ||
            same(bill.supplierId, filter.supplier) ||
            bill.supplierName.toLowerCase().includes(filter.supplier.trim().toLowerCase()),
        )
        .filter((bill) => {
          if (filter.status === undefined) return true;
          if (filter.status === "unpaid") return bill.status !== "paid";
          return bill.status === filter.status;
        });
    },

    async recordVendorBill(input, { requestId }): Promise<VendorBill> {
      const prior = recorded.get(requestId);
      if (prior !== undefined) return prior;
      const supplier = findSupplier(input.supplier);
      if (!supplier.approved) {
        throw new AccountingDeskError(
          "unapproved_supplier",
          `${supplier.name} is on file but not on the company's approved supplier list, so a bill from it is not recorded here. Nothing was recorded.`,
        );
      }
      if (input.supplierInvoice.trim() === "") {
        throw new AccountingDeskError(
          "invalid",
          "Give the supplier's own invoice number, as it appears on the bill.",
        );
      }
      if (input.recordedBy.trim() === "" || input.source.trim() === "") {
        throw new AccountingDeskError(
          "invalid",
          "Say who in the company asked for the bill to be recorded and what it was recorded from (the message or document, with its date).",
        );
      }
      const terms = input.termsDays ?? DEFAULT_TERMS_DAYS;
      if (!Number.isInteger(terms) || terms < 0 || terms > 120) {
        throw new AccountingDeskError(
          "invalid",
          `${String(terms)} is not a payment term: give the days the bill allows, from 0 to 120, or leave it out.`,
        );
      }
      const duplicate = bills.find(
        (bill) =>
          bill.supplierId === supplier.id && same(bill.supplierInvoice, input.supplierInvoice),
      );
      if (duplicate !== undefined) {
        throw new AccountingDeskError(
          "duplicate_bill",
          `${supplier.name}'s invoice ${duplicate.supplierInvoice} is already on the desk as ${duplicate.id}. Nothing was recorded again.`,
          { billId: duplicate.id },
        );
      }
      const lines = price(supplier, input.lines);
      const recordedOn = today();
      const bill: BillState = {
        id: nextBillId(),
        supplierId: supplier.id,
        supplierName: supplier.name,
        supplierInvoice: input.supplierInvoice.trim(),
        lines,
        totalCents: total(lines),
        recordedOn,
        recordedBy: input.recordedBy.trim(),
        source: input.source.trim(),
        dueOn: addDays(recordedOn, terms),
        paidOn: null,
        paymentId: null,
        revision: 1,
        earlier: [],
      };
      bills.push(bill);
      const receipt = snapshot(bill);
      recorded.set(requestId, receipt);
      return receipt;
    },

    async payVendorBill(input, { requestId }): Promise<VendorPayment> {
      const prior = payments.get(requestId);
      if (prior !== undefined) return prior;
      const bill = findBill(input.billId);
      if (bill.paidOn !== null) {
        throw new AccountingDeskError(
          "already_paid",
          `${bill.id} (${bill.supplierName}, invoice ${bill.supplierInvoice}) was already paid on ${bill.paidOn}${bill.paymentId === null ? "" : ` as ${bill.paymentId}`}. Nothing was paid again.`,
          { billId: bill.id },
        );
      }
      const facts =
        same(input.supplierId, bill.supplierId) &&
        same(input.supplierInvoice, bill.supplierInvoice) &&
        same(input.recordedBy, bill.recordedBy);
      const sourced = same(input.source, bill.source);
      const content = input.totalCents === bill.totalCents && sameLines(input.lines, bill.lines);
      if (facts && content && !sourced) {
        // Everything else is the bill's, but the person would have been shown another origin for it.
        throw new AccountingDeskError(
          "source_mismatch",
          `${bill.id} was recorded from ${JSON.stringify(bill.source)}, not ${JSON.stringify(input.source)}, so the approval did not show what it was recorded from. Nothing was paid.`,
          { billId: bill.id },
        );
      }
      if (facts && content && sourced) {
        const payment: VendorPayment = {
          id: `PAY-${++paymentNumber}`,
          billId: bill.id,
          supplierId: bill.supplierId,
          supplierName: bill.supplierName,
          supplierInvoice: bill.supplierInvoice,
          amountCents: bill.totalCents,
          paidOn: today(),
          demo: true,
        };
        bill.paidOn = payment.paidOn;
        bill.paymentId = payment.id;
        books.push({
          date: payment.paidOn,
          description: `Payment of ${bill.id} to ${bill.supplierName}`,
          amountCents: -payment.amountCents,
          reference: payment.id,
        });
        payments.set(requestId, payment);
        return payment;
      }
      // The person approved the facts in the call; anything else is not what they approved.
      const wasEarlier =
        facts &&
        bill.earlier.some(
          (revision) =>
            revision.totalCents === input.totalCents && sameLines(input.lines, revision.lines),
        );
      if (wasEarlier) {
        throw new AccountingDeskError(
          "bill_changed",
          `${bill.id} was corrected after these facts were read: it now comes to ${money(bill.totalCents)}, not ${money(input.totalCents)}. Nothing was paid.`,
          { billId: bill.id },
        );
      }
      throw new AccountingDeskError(
        "bill_mismatch",
        `That is not ${bill.id} as the desk holds it: ${bill.supplierName} (${bill.supplierId}), invoice ${bill.supplierInvoice}, recorded by ${bill.recordedBy} from ${bill.source}, total ${money(bill.totalCents)} (${bill.totalCents} cents). Nothing was paid.`,
        { billId: bill.id },
      );
    },

    async reconcile(input): Promise<Reconciliation> {
      if (
        input.month !== undefined &&
        (!Number.isInteger(input.month) || input.month < 1 || input.month > 12)
      ) {
        throw new AccountingDeskError(
          "invalid",
          `${String(input.month)} is not a month: give its number from 1 to 12, or leave it out for the last full month.`,
        );
      }
      const period = endedMonth(today(), input.month);
      const statement = statements.find((candidate) => candidate.period === period);
      if (statement === undefined) {
        const onFile = statements.map((candidate) => candidate.period).join(", ") || "none";
        throw new AccountingDeskError(
          "no_statement",
          `No bank statement for ${period} is on the desk. Statements on file: ${onFile}.`,
        );
      }
      const inPeriod = books.filter((entry) => entry.date.startsWith(period));
      const unmatchedBooks = [...inPeriod];
      const statementOnly: BankEntry[] = [];
      for (const line of statement.lines) {
        // A line matches one book entry of the same amount and reference; with no reference on
        // either side, the same amount within three days.
        const index = unmatchedBooks.findIndex(
          (entry) =>
            entry.amountCents === line.amountCents &&
            (line.reference !== null && entry.reference !== null
              ? same(line.reference, entry.reference)
              : line.reference === null &&
                entry.reference === null &&
                Math.abs(daysBetween(line.date, entry.date)) <= 3),
        );
        if (index === -1) statementOnly.push(line);
        else unmatchedBooks.splice(index, 1);
      }
      const major = (amountCents: number): boolean =>
        input.majorOverCents === null || Math.abs(amountCents) > input.majorOverCents;
      const unmatched: UnmatchedItem[] = [
        ...statementOnly.map((line) => ({
          ...line,
          side: "statement_only" as const,
          major: major(line.amountCents),
        })),
        ...unmatchedBooks.map((entry) => ({
          ...entry,
          side: "books_only" as const,
          major: major(entry.amountCents),
        })),
      ];
      const sum = (entries: readonly BankEntry[]) =>
        entries.reduce((running, entry) => running + entry.amountCents, 0);
      const statementClosingCents = statement.openingCents + sum(statement.lines);
      const booksClosingCents = statement.openingCents + sum(inPeriod);
      return {
        period,
        openingCents: statement.openingCents,
        statementClosingCents,
        booksClosingCents,
        differenceCents: statementClosingCents - booksClosingCents,
        matched: statement.lines.length - statementOnly.length,
        unmatched,
        majorOverCents: input.majorOverCents,
      };
    },

    async correctVendorBill(billId, lines): Promise<VendorBill> {
      const bill = findBill(billId);
      const supplier = findSupplier(bill.supplierId);
      const priced = price(supplier, lines);
      bill.earlier.push({ lines: bill.lines, totalCents: bill.totalCents });
      bill.lines = priced;
      bill.totalCents = total(priced);
      bill.revision += 1;
      return snapshot(bill);
    },
  };
}
