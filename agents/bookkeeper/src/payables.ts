/**
 * The four accounts-payable and bank tools, over the accounts desk.
 *
 * `list_vendor_bills` and `reconcile_summary` only read. `record_vendor_bill` writes through the desk
 * with no approval: the desk refuses a supplier that is not on file or not approved, prices every line
 * from the supply catalogue, and works out the total and the due date. `pay_vendor_bill` waits for a
 * person on every call (`any_payment` in `officehum.json`, evaluated by the SDK's gate before the
 * tool runs); it names the bill and the facts the person approves, and the desk pays the bill's own
 * total and refuses when the bill is not what was approved.
 *
 * No tool takes a bank account, a routing number or a remittance address: a supplier's payment
 * details never come from a message. Every amount a tool speaks comes back from the desk, and every
 * name from the company record.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { type CompanyFacts, financeLead, money, personLabel, purchasingLead } from "./company.js";
import {
  type AccountingDesk,
  AccountingDeskError,
  type BillStatus,
  type DeskRefusal,
  type Reconciliation,
  type VendorBill,
  type VendorPayment,
} from "./desk.js";

/** The limit an unmatched bank item is measured against, in cents. */
export const MAJOR_UNMATCHED_LIMIT = "major_unmatched_item";

/** What the tools need: the desk, the company, and the role's resolved limits, read per call. */
export interface PayablesToolDependencies {
  readonly desk: AccountingDesk | undefined;
  readonly company: CompanyFacts;
  readonly limits: () => Readonly<Record<string, number>>;
}

/** The four tools, named, so the factory places each one where the manifest declares it. */
export interface PayablesToolset {
  readonly listVendorBills: ToolRegistration;
  readonly recordVendorBill: ToolRegistration;
  readonly payVendorBill: ToolRegistration;
  readonly reconcileSummary: ToolRegistration;
}

const STATUSES: readonly (BillStatus | "unpaid")[] = ["unpaid", "due", "overdue", "open", "paid"];

const LINES = Type.Array(
  Type.Object(
    {
      itemId: Type.String({
        description: "The item's id in the supply catalogue, e.g. microfiber-cloth",
      }),
      quantity: Type.Integer({ minimum: 1, description: "How many of the item's unit, e.g. 20" }),
    },
    { additionalProperties: false },
  ),
  { minItems: 1 },
);

function requireDesk(dependencies: PayablesToolDependencies): AccountingDesk {
  if (dependencies.desk === undefined) {
    throw new Error("No accounts desk is configured for this role.");
  }
  return dependencies.desk;
}

function textResult(value: string) {
  return { output: [{ type: "text" as const, text: value }] };
}

function refusal<TDetails extends JsonObject>(value: string, details: TDetails) {
  return { ...textResult(value), isError: true, details };
}

function billDetails(bill: VendorBill): JsonObject {
  return { ...bill, lines: bill.lines.map((line) => ({ ...line })) };
}

function dueText(bill: VendorBill): string {
  if (bill.status === "paid") {
    return `paid ${bill.paidOn ?? ""}${bill.paymentId === null ? "" : ` (${bill.paymentId})`}`;
  }
  if (bill.daysUntilDue < 0) {
    const days = -bill.daysUntilDue;
    return `due ${bill.dueOn}, overdue by ${days} ${days === 1 ? "day" : "days"}`;
  }
  if (bill.daysUntilDue === 0) return `due ${bill.dueOn}, today`;
  return `due ${bill.dueOn}, in ${bill.daysUntilDue} ${bill.daysUntilDue === 1 ? "day" : "days"}`;
}

function billText(bill: VendorBill): string {
  return [
    `${bill.id} — ${bill.supplierName} (${bill.supplierId}) — supplier invoice ${bill.supplierInvoice} — total ${money(bill.totalCents)} (${bill.totalCents} cents) — ${bill.status.toUpperCase()}, ${dueText(bill)} — recorded ${bill.recordedOn} by ${bill.recordedBy}, from ${bill.source}`,
    ...bill.lines.map(
      (line) =>
        `- ${line.quantity} × ${line.name} [${line.itemId}] (${line.unit}) at ${money(line.unitCostCents)} = ${money(line.lineTotalCents)}`,
    ),
  ].join("\n");
}

function paymentText(payment: VendorPayment): string {
  return `Paid ${payment.billId} (${payment.supplierName}, supplier invoice ${payment.supplierInvoice}): ${money(payment.amountCents)}, the bill's own total, on ${payment.paidOn}, payment ${payment.id}. Demonstration backend: the payment is recorded on the desk and no money moved.`;
}

function signed(cents: number): string {
  return cents < 0 ? `-${money(-cents)}` : money(cents);
}

/**
 * Builds the four tools over one desk and one company. Every one is plain Pi Durable: they install
 * into any harness, and a harness with no desk builds the same tools and refuses at the point of use.
 */
export function payablesTools(dependencies: PayablesToolDependencies): PayablesToolset {
  const { company } = dependencies;
  const finance = personLabel(financeLead(company), "the person who owns finance");
  const purchasing = personLabel(purchasingLead(company), "the person who decides purchasing");

  const requestId = (
    kind: string,
    api: { conversationId: unknown; taskId: unknown; callId: string },
  ) => `${kind}:${String(api.conversationId)}:${String(api.taskId)}:${api.callId}`;

  /**
   * The next step for every refusal code, chosen from the code and never from the message. The
   * record is complete by type, so a new code cannot ship without one.
   */
  const NEXT: Record<DeskRefusal, (billId: string | undefined) => string> = {
    not_found: () => " Next: find the bill with list_vendor_bills.",
    invalid: () => " Next: correct the call as described; nothing was changed.",
    unknown_supplier: () =>
      ` Next: tell the person a new supplier is for ${purchasing} to decide, and the bill is for ${finance} to check; record and pay nothing.`,
    unapproved_supplier: () =>
      ` Next: tell the person approving the supplier is for ${purchasing} to decide, and the bill is for ${finance} to check; record and pay nothing.`,
    not_supplied: () =>
      ` Next: tell the person the bill is for ${finance} to check against what was ordered; record nothing.`,
    duplicate_bill: (billId) =>
      ` Next: use ${billId ?? "the bill already on the desk"}; do not record it again.`,
    already_paid: () => " Next: tell the person it is already paid; there is nothing to pay.",
    bill_mismatch: (billId) =>
      ` Next: read ${billId ?? "the bill"} with list_vendor_bills and name its facts exactly as the desk holds them.`,
    source_mismatch: (billId) =>
      ` Next: read ${billId ?? "the bill"} with list_vendor_bills and name what it was recorded from exactly as the desk shows it, so the person approving sees where it came from.`,
    bill_changed: (billId) =>
      ` Next: tell the person ${billId ?? "the bill"} changed after it was put to a person, so it was not paid; read it again with list_vendor_bills before anything else.`,
    no_statement: () => " Next: ask which of the periods on file is wanted.",
  };

  const refused = (error: unknown, extra: JsonObject) => {
    if (!(error instanceof AccountingDeskError)) throw error;
    return refusal<JsonObject>(`${error.message}${NEXT[error.code](error.billId)}`, {
      code: error.code,
      ...(error.billId === undefined ? {} : { billId: error.billId }),
      ...extra,
    });
  };

  const listVendorBills = defineTool({
    name: "list_vendor_bills",
    description:
      "List the supplier bills on the desk, or one by its id: supplier, the supplier's invoice number, each line, the total, who recorded it and from what, and where it stands today (OPEN, DUE soon, OVERDUE or PAID), all worked out by the desk. Filter by status: unpaid, due, overdue, open or paid.",
    parameters: Type.Object(
      {
        status: Type.Optional(
          Type.Union(
            STATUSES.map((status) => Type.Literal(status)),
            { description: "Only bills in this state; unpaid is every bill not yet paid" },
          ),
        ),
        supplier: Type.Optional(
          Type.String({ description: "All or part of the supplier's name, or its id" }),
        ),
        billId: Type.Optional(Type.String({ description: "One bill by its id, e.g. BILL-2001" })),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const desk = requireDesk(dependencies);
      const bills = await desk.listVendorBills({
        ...(args.status === undefined ? {} : { status: args.status as BillStatus | "unpaid" }),
        ...(args.supplier === undefined ? {} : { supplier: args.supplier }),
        ...(args.billId === undefined ? {} : { billId: args.billId }),
      });
      const details = { found: bills.length > 0, bills: bills.map(billDetails) };
      if (bills.length === 0) {
        return refusal("No supplier bill matches that. Try fewer filters, or no filter.", details);
      }
      const unpaid = bills.filter((bill) => bill.status !== "paid");
      const overdue = bills.filter((bill) => bill.status === "overdue");
      return {
        ...textResult(
          [
            `Supplier bills (${bills.length}; ${unpaid.length} unpaid, ${overdue.length} overdue):`,
            ...bills.map(billText),
            `Supplier payments and payment questions belong to ${finance}.`,
          ].join("\n"),
        ),
        details,
      };
    },
  });

  const recordVendorBill = defineTool({
    name: "record_vendor_bill",
    description:
      "Record a supplier's bill when someone in the company asks: the supplier, its own invoice number, each catalogue item and quantity on the bill, who asked for it to be recorded and what it came from. You give no prices or totals: the desk prices each line from the supply catalogue and works out the total and due date. It refuses a supplier not on file or not approved, an item that supplier does not supply, and a bill already recorded. It pays nothing.",
    parameters: Type.Object(
      {
        supplier: Type.String({
          description: "The supplier's id or its name exactly as on file, e.g. sup-rainier-tools",
        }),
        supplierInvoice: Type.String({
          minLength: 1,
          description: "The supplier's own invoice number on the bill, e.g. RT-5588",
        }),
        lines: LINES,
        recordedBy: Type.String({
          minLength: 1,
          description: "The name of the person in the company who asked for it to be recorded",
        }),
        source: Type.String({
          minLength: 1,
          description: "What the bill came from: the message or document, who sent it and when",
        }),
        termsDays: Type.Optional(
          Type.Integer({
            minimum: 0,
            maximum: 120,
            description: "The days the bill allows for payment, e.g. 30 for net 30; omit if none",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const bill = await desk.recordVendorBill(
          {
            supplier: args.supplier,
            supplierInvoice: args.supplierInvoice,
            lines: args.lines,
            recordedBy: args.recordedBy,
            source: args.source,
            ...(args.termsDays === undefined ? {} : { termsDays: args.termsDays }),
          },
          { requestId: requestId("record-bill", api) },
        );
        return {
          ...textResult(`Recorded ${billText(bill)}\nNothing has been paid.`),
          details: billDetails(bill),
        };
      } catch (error) {
        return refused(error, { supplier: args.supplier });
      }
    },
  });

  const payVendorBill = defineTool({
    name: "pay_vendor_bill",
    description:
      "Ask a person to approve paying one supplier bill, naming the bill and its facts exactly as list_vendor_bills gave them (supplier id, the supplier's invoice number, who recorded it and from what, each item and quantity, and the total in cents), so the person sees what they approve. Every call waits for a person. Once approved, the desk pays the bill's own total, and refuses if the bill is not what the approval named or changed since. Demonstration backend: no money moves.",
    parameters: Type.Object(
      {
        billId: Type.String({ description: "The bill's id, e.g. BILL-2001" }),
        supplierId: Type.String({
          description: "The bill's supplier id, e.g. sup-rainier-tools",
        }),
        supplierInvoice: Type.String({
          description: "The supplier's invoice number on the bill, e.g. RT-5520",
        }),
        recordedBy: Type.String({ description: "Who recorded the bill, as the desk shows it" }),
        source: Type.String({
          description:
            "What the bill was recorded from, exactly as the desk shows it after 'from', e.g. PDF invoice RT-5520 emailed by sales@rainiertools.example on 2026-10-05",
        }),
        lines: LINES,
        totalCents: Type.Integer({
          minimum: 1,
          description: "The bill's total in cents, exactly as the desk gave it, e.g. 64800",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const payment = await desk.payVendorBill(
          {
            billId: args.billId,
            supplierId: args.supplierId,
            supplierInvoice: args.supplierInvoice,
            recordedBy: args.recordedBy,
            source: args.source,
            lines: args.lines,
            totalCents: args.totalCents,
          },
          { requestId: requestId("pay-bill", api) },
        );
        return { ...textResult(paymentText(payment)), details: { ...payment } };
      } catch (error) {
        return refused(error, { billId: args.billId });
      }
    },
  });

  const reconcileText = (summary: Reconciliation): string => {
    const limit =
      summary.majorOverCents === null
        ? "No major-item limit resolved, so every unmatched item is treated as major."
        : `An unmatched item over ${money(summary.majorOverCents)} is major.`;
    const unmatched =
      summary.unmatched.length === 0
        ? ["Unmatched: none."]
        : [
            `Unmatched (${summary.unmatched.length}):`,
            ...summary.unmatched.map(
              (item) =>
                `- ${item.date} — ${item.description} — ${signed(item.amountCents)} — ${item.side === "statement_only" ? "on the statement, not in the books" : "in the books, not on the statement"} — ${item.major ? `MAJOR: goes to ${finance}; do not correct it yourself` : "minor: listed for the person who closes the month"}`,
            ),
          ];
    return [
      `Bank reconciliation for ${summary.period}: opening ${money(summary.openingCents)}, statement closing ${money(summary.statementClosingCents)}, books closing ${money(summary.booksClosingCents)}, difference ${signed(summary.differenceCents)}.`,
      `Matched: ${summary.matched} statement lines.`,
      ...unmatched,
      limit,
      "This is a summary: nothing was posted, corrected or closed.",
    ].join("\n");
  };

  const reconcileSummary = defineTool({
    name: "reconcile_summary",
    description:
      "Match one month's bank statement against the books and summarise it: the balances, how many lines matched, and every unmatched item, each marked major or minor by the desk. It posts, corrects and closes nothing. Give the month's number (never a year: the desk works it out), or leave it out for the last full month.",
    parameters: Type.Object(
      {
        month: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 12,
            description:
              "The month's number, e.g. 10 for October; omit it for the last full month. The desk works out the year.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const desk = requireDesk(dependencies);
      const limit = dependencies.limits()[MAJOR_UNMATCHED_LIMIT];
      const majorOverCents =
        typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0 ? limit : null;
      try {
        const summary = await desk.reconcile({
          ...(args.month === undefined ? {} : { month: args.month }),
          majorOverCents,
        });
        return {
          ...textResult(reconcileText(summary)),
          details: { ...summary, unmatched: summary.unmatched.map((item) => ({ ...item })) },
        };
      } catch (error) {
        return refused(error, { month: args.month ?? null });
      }
    },
  });

  return { listVendorBills, recordVendorBill, payVendorBill, reconcileSummary };
}
