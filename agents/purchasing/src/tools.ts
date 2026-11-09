/**
 * The Purchasing role's nine tools.
 *
 * `list_stock`, `list_suppliers`, `compare_suppliers`, `list_purchase_orders` and `read_company` only
 * read. `raise_purchase_order` and `record_receipt` write through the desk with no approval: the desk
 * prices every order and refuses one over the spending limit, one split to stay under it, and one to a
 * supplier not on the approved list, and it checks every receipt against the order. Each refusal a
 * person can lift names the approval-gated tool that asks them. `request_po_approval` and
 * `request_new_supplier` are those tools; their approvals are `officehum.json`'s, evaluated by the
 * SDK's gate before the tool runs, so this file holds no money limit and no approval rule.
 *
 * Every amount a tool speaks comes back from the desk, and every name from the company record.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { deskRefusal, refusal, requestId, textResult } from "@officehum/sdk";
import { type CompanyFacts, money, person, personLabel, purchasingLead } from "./company.js";
import {
  type DeskRefusal,
  type GoodsReceipt,
  type OrderStatus,
  type PurchaseOrder,
  type PurchasingDesk,
  PurchasingDeskError,
} from "./desk.js";

/** What the tools need: the desk, and the company whose supplies it buys. */
export interface PurchasingToolDependencies {
  readonly desk: PurchasingDesk | undefined;
  readonly company: CompanyFacts;
}

/** The nine tools, named, so the factory places each one where the manifest declares it. */
export interface PurchasingToolset {
  readonly listStock: ToolRegistration;
  readonly listSuppliers: ToolRegistration;
  readonly compareSuppliers: ToolRegistration;
  readonly listPurchaseOrders: ToolRegistration;
  readonly raisePurchaseOrder: ToolRegistration;
  readonly requestPoApproval: ToolRegistration;
  readonly requestNewSupplier: ToolRegistration;
  readonly recordReceipt: ToolRegistration;
  readonly readCompany: ToolRegistration;
}

/** The company section `read_company` can answer for. */
export type CompanySection =
  | "profile"
  | "hours"
  | "people"
  | "purchasing"
  | "policies"
  | "tone"
  | "escalation"
  | "glossary";

const SECTIONS: readonly CompanySection[] = [
  "profile",
  "hours",
  "people",
  "purchasing",
  "policies",
  "tone",
  "escalation",
  "glossary",
];

const STATUSES: readonly OrderStatus[] = ["draft", "placed", "partially_received", "received"];

const LINES = Type.Array(
  Type.Object(
    {
      itemId: Type.String({ description: "The item's id from list_stock, e.g. toilet-tissue" }),
      quantity: Type.Integer({
        minimum: 1,
        description: "How many of the item's unit, e.g. 16 cases",
      }),
    },
    { additionalProperties: false },
  ),
  { minItems: 1 },
);

/** The desk, or a refusal: a host with no desk gets no read and no write. */
function requireDesk(dependencies: PurchasingToolDependencies): PurchasingDesk {
  if (dependencies.desk === undefined) {
    throw new Error("No purchasing desk is configured for this role.");
  }
  return dependencies.desk;
}

function statusText(status: OrderStatus): string {
  return status.replace("_", " ");
}

function orderLines(order: PurchaseOrder): string[] {
  return order.lines.map(
    (line) =>
      `- ${line.quantity} × ${line.name} [${line.itemId}] (${line.unit}) at ${money(line.unitCostCents)} = ${money(line.lineTotalCents)}, ${line.receivedQuantity} received`,
  );
}

function orderText(order: PurchaseOrder): string {
  const dates =
    order.placedOn === null
      ? `raised ${order.raisedOn}, not sent`
      : `placed ${order.placedOn}, expected ${order.expectedOn ?? "not set"}`;
  const approval = order.approved ? " — placed with a person's approval" : "";
  return [
    `${order.id} — ${order.supplierName} — ${statusText(order.status)} — ${dates} — total ${money(order.totalCents)}${approval}`,
    ...orderLines(order),
  ].join("\n");
}

function placedText(order: PurchaseOrder): string {
  return [
    `${order.id} with ${order.supplierName}:`,
    ...order.lines.map(
      (line) =>
        `- ${line.quantity} × ${line.name} [${line.itemId}] (${line.unit}) at ${money(line.unitCostCents)} = ${money(line.lineTotalCents)}`,
    ),
    `Total ${money(order.totalCents)}. Placed ${order.placedOn ?? ""}, expected ${order.expectedOn ?? "not set"}.`,
  ].join("\n");
}

function receiptText(receipt: GoodsReceipt): string {
  const slip = receipt.packingSlip === null ? "" : `, packing slip ${receipt.packingSlip}`;
  return [
    `Recorded ${receipt.id} against ${receipt.purchaseOrderId} (${receipt.supplierName}), reported by ${receipt.reportedBy} (${receipt.source})${slip}:`,
    ...receipt.lines.map(
      (line) =>
        `- ${line.quantity} × ${line.name} [${line.itemId}] (${line.unit}) received, ${line.outstanding} still to come`,
    ),
    `${receipt.purchaseOrderId} is ${statusText(receipt.orderStatus)}. This is an internal record: nothing is paid and nothing is sent to the supplier.`,
  ].join("\n");
}

/** The company record as one section reads: prose the model can answer with. */
function companySection(company: CompanyFacts, section: CompanySection): string {
  switch (section) {
    case "profile": {
      const { profile } = company;
      return [
        `${profile.legalName} — trading as ${profile.tradingName}. ${profile.tagline}`,
        `${profile.address.street}, ${profile.address.city}, ${profile.address.region} ${profile.address.postalCode}. Phone ${profile.phone}. Email ${profile.email}.`,
      ].join("\n");
    }
    case "hours": {
      const { hours } = company;
      return [`Office: ${hours.office} (${hours.timezone}).`, `Closed: ${hours.closedOn}.`].join(
        "\n",
      );
    }
    case "people":
      return company.people
        .map(
          (worker) =>
            `${worker.name} — ${worker.title} — ${worker.email} — decides: ${worker.decides.join("; ")}`,
        )
        .join("\n");
    case "purchasing": {
      const lead = personLabel(purchasingLead(company));
      return [
        `Purchasing decisions belong to ${lead}: an order over the limit, a new supplier, a supplier contract, a claim against a supplier, and surplus stock.`,
        `A purchase order over ${money(company.approvalLimits.purchaseOrderOverCents)} needs a person's approval before it goes out.`,
        "Suppliers on file (the company's approved list is its own setting):",
        ...company.suppliers.map(
          (supplier) =>
            `- ${supplier.name} — ${supplier.approved ? "approved" : "not approved"} — ${supplier.category} — lead time ${supplier.leadTimeDays} days`,
        ),
      ].join("\n");
    }
    case "policies":
      return [
        "Safety:",
        ...company.policies.safety.map((rule) => `- ${rule}`),
        "Never promised:",
        ...company.policies.commitments.map((rule) => `- ${rule}`),
      ].join("\n");
    case "tone":
      return [
        company.tone.summary,
        "Always:",
        ...company.tone.always.map((rule) => `- ${rule}`),
        "Never:",
        ...company.tone.never.map((rule) => `- ${rule}`),
      ].join("\n");
    case "escalation":
      return company.escalation
        .map((rule) => {
          const owner = person(company, rule.toPersonId);
          return `${rule.topic} — ${owner?.name ?? rule.toPersonId}${owner === undefined ? "" : `, ${owner.title}`} — ${rule.when}`;
        })
        .join("\n");
    case "glossary":
      return company.glossary.map((entry) => `${entry.term}: ${entry.meaning}`).join("\n");
  }
}

/**
 * Builds the nine tools over one desk and one company. Every one is plain Pi Durable: they install
 * into any harness, and a harness with no desk builds the same tools and refuses at the point of use.
 */
export function purchasingTools(dependencies: PurchasingToolDependencies): PurchasingToolset {
  const { company } = dependencies;
  const lead = personLabel(purchasingLead(company));

  /** A desk refusal as the model reads it, with the next step that a person can take. */
  const refused = (error: unknown, extra: JsonObject) => {
    if (!(error instanceof PurchasingDeskError)) throw error;
    // The next step comes from the refusal's code, never from reading its message.
    const supplier = typeof extra.supplierId === "string" ? extra.supplierId : undefined;
    // The approval names the draft, its supplier and the desk's total, so the person sees what they
    // approve and the desk can refuse a grant for anything else.
    const grant =
      error.draftId === undefined
        ? ""
        : ` with draftId ${error.draftId}${supplier === undefined ? "" : `, supplierId ${supplier}`}${error.totalCents === undefined ? "" : ` and totalCents ${error.totalCents}`}`;
    const approval = ` Next: call request_po_approval${grant}, which asks ${lead}.`;
    const next: Record<DeskRefusal, string> = {
      over_limit: approval,
      split_order: approval,
      unapproved_supplier: ` Next: call request_new_supplier${supplier === undefined ? "" : ` with supplier ${supplier}`} and the reason, which asks ${lead}.`,
      over_received: ` Any extra is ${lead}'s to take up with the supplier.`,
      // The desk's own message already says what to do for these.
      not_found: "",
      invalid: "",
      not_offered: "",
      not_draft: "",
      draft_changed: "",
      already_approved: "",
      not_placed: "",
      not_on_order: "",
    };
    return deskRefusal(`${error.message}${next[error.code]}`, error.code, {
      ...(error.draftId === undefined ? {} : { draftId: error.draftId }),
      ...(error.totalCents === undefined ? {} : { totalCents: error.totalCents }),
      ...extra,
    });
  };

  const listStock = defineTool({
    name: "list_stock",
    description:
      "List every stocked item: the quantity on hand, the quantity on order, its reorder point and reorder quantity, its usual supplier, and REORDER when on hand plus on order is at or below the reorder point. The desk works the flags out.",
    parameters: Type.Object({}, { additionalProperties: false }),
    replay: "safe",
    execute: async () => {
      const desk = requireDesk(dependencies);
      const stock = await desk.listStock();
      const due = stock.filter((line) => line.needsReorder);
      return {
        ...textResult(
          [
            `Stock (${stock.length} items; ${due.length} items need reordering):`,
            ...stock.map(
              (line) =>
                `${line.itemId} — ${line.name} (${line.unit}) — ${line.onHand} on hand, ${line.onOrder} on order — reorder point ${line.reorderPoint}, reorder quantity ${line.reorderQuantity} — usual supplier ${line.supplierId} (${line.supplierName})${line.needsReorder ? " — REORDER" : ""}`,
            ),
          ].join("\n"),
        ),
        details: { found: stock.length > 0, stock: stock.map((line) => ({ ...line })) },
      };
    },
  });

  const listSuppliers = defineTool({
    name: "list_suppliers",
    description:
      "List the suppliers on file: what each supplies, its lead time in days, the items it has a price for, and whether it is on the company's approved supplier list.",
    parameters: Type.Object({}, { additionalProperties: false }),
    replay: "safe",
    execute: async () => {
      const desk = requireDesk(dependencies);
      const suppliers = await desk.listSuppliers();
      return {
        ...textResult(
          [
            `Suppliers (${suppliers.length}):`,
            ...suppliers.map(
              (supplier) =>
                `${supplier.id} — ${supplier.name} — ${supplier.category} — lead time ${supplier.leadTimeDays} days — ${supplier.approved ? "approved" : "NOT on the approved list"} — items: ${supplier.items.join(", ") || "none priced yet"}`,
            ),
          ].join("\n"),
        ),
        details: {
          found: suppliers.length > 0,
          suppliers: suppliers.map((supplier) => ({ ...supplier, items: [...supplier.items] })),
        },
      };
    },
  });

  const compareSuppliers = defineTool({
    name: "compare_suppliers",
    description:
      "Compare the suppliers that have a price for one item: each one's unit cost and lead time from the desk's price lists, cheapest first, whether it is approved, and which is the usual supplier.",
    parameters: Type.Object(
      {
        itemId: Type.String({ description: "The item's id from list_stock, e.g. nitrile-gloves" }),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const desk = requireDesk(dependencies);
      try {
        const comparison = await desk.compareSuppliers(args.itemId);
        return {
          ...textResult(
            [
              `${comparison.name} (${comparison.itemId}), per ${comparison.unit}, cheapest first:`,
              ...comparison.offers.map(
                (offer) =>
                  `${offer.supplierName} — ${money(offer.unitCostCents)} per ${comparison.unit} — lead time ${offer.leadTimeDays} days — ${offer.approved ? "approved" : "NOT on the approved list"}${offer.usual ? ", the usual supplier" : ""}`,
              ),
            ].join("\n"),
          ),
          details: { ...comparison, offers: comparison.offers.map((offer) => ({ ...offer })) },
        };
      } catch (error) {
        return refused(error, { itemId: args.itemId });
      }
    },
  });

  const listPurchaseOrders = defineTool({
    name: "list_purchase_orders",
    description:
      "List purchase orders, or one by its number: supplier, status (draft, placed, partially received, received), when it was placed and is expected, each line with what has been received, and the total.",
    parameters: Type.Object(
      {
        purchaseOrderId: Type.Optional(
          Type.String({ description: "A purchase order number, e.g. PO-1001" }),
        ),
        supplier: Type.Optional(
          Type.String({ description: "All or part of the supplier's name, or its id" }),
        ),
        status: Type.Optional(
          Type.Union(
            STATUSES.map((status) => Type.Literal(status)),
            { description: "Only orders with this status" },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const desk = requireDesk(dependencies);
      const orders = await desk.listPurchaseOrders({
        ...(args.purchaseOrderId === undefined ? {} : { id: args.purchaseOrderId }),
        ...(args.supplier === undefined ? {} : { supplier: args.supplier }),
        ...(args.status === undefined ? {} : { status: args.status as OrderStatus }),
      });
      const details = {
        found: orders.length > 0,
        orders: orders.map((order) => ({
          ...order,
          lines: order.lines.map((line) => ({ ...line })),
        })),
      };
      if (orders.length === 0) {
        return refusal(
          "No purchase order matches that. Try the number on the order, or fewer filters.",
          details,
        );
      }
      return {
        ...textResult([`Purchase orders (${orders.length}):`, ...orders.map(orderText)].join("\n")),
        details,
      };
    },
  });

  const raisePurchaseOrder = defineTool({
    name: "raise_purchase_order",
    description:
      "Raise a purchase order with one supplier for items and quantities. You give no prices: the desk prices each line from the supplier's price list and works out the total. It refuses an order over the spending limit (saving it as a draft: then call request_po_approval with the draft's id), an order that with others to the same supplier today passes the limit, and a supplier not on the approved list (then call request_new_supplier).",
    parameters: Type.Object(
      {
        supplierId: Type.String({
          description: "The supplier's id from list_suppliers, e.g. sup-cascade-paper",
        }),
        lines: LINES,
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const order = await desk.raisePurchaseOrder(
          { supplierId: args.supplierId, lines: args.lines },
          { requestId: requestId("raise", api) },
        );
        return {
          ...textResult(`Placed ${placedText(order)}`),
          details: { ...order, lines: order.lines.map((line) => ({ ...line })) },
        };
      } catch (error) {
        return refused(error, { supplierId: args.supplierId });
      }
    },
  });

  const requestPoApproval = defineTool({
    name: "request_po_approval",
    description:
      "Ask a person to approve one draft purchase order that raise_purchase_order refused for the spending limit, with the draft's id, supplier and total exactly as the refusal gave them, so the person sees what they approve. Every call waits for a person; once approved, the desk places exactly that draft, and refuses if the draft is not what the approval named.",
    parameters: Type.Object(
      {
        draftId: Type.String({
          description: "The draft's purchase order number from the refusal, e.g. PO-1004",
        }),
        supplierId: Type.String({
          description: "The draft's supplier id from the refusal, e.g. sup-cascade-paper",
        }),
        totalCents: Type.Integer({
          minimum: 1,
          description: "The draft's total in cents, exactly as the refusal gave it, e.g. 217200",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const order = await desk.placeDraft(
          { draftId: args.draftId, supplierId: args.supplierId, totalCents: args.totalCents },
          { requestId: requestId("po-approval", api) },
        );
        return {
          ...textResult(`Approved and placed: ${placedText(order)}`),
          details: { ...order, lines: order.lines.map((line) => ({ ...line })) },
        };
      } catch (error) {
        return refused(error, { draftId: args.draftId });
      }
    },
  });

  const requestNewSupplier = defineTool({
    name: "request_new_supplier",
    description:
      "Ask a person to add a supplier to the company's approved supplier list, with the reason. Use the supplier's id from list_suppliers, or its name if it is not on file. Every call waits for a person; once approved, the supplier is on the list. It orders nothing.",
    parameters: Type.Object(
      {
        supplier: Type.String({
          description: "The supplier's id from list_suppliers, or its name if it is not on file",
        }),
        reason: Type.String({ description: "Why the company needs this supplier" }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const added = await desk.addSupplier(
          { supplier: args.supplier, reason: args.reason },
          { requestId: requestId("new-supplier", api) },
        );
        return {
          ...textResult(
            `Approved: ${added.supplierName} (${added.supplierId}) is now on the approved supplier list. Reason recorded: ${added.reason}. Nothing has been ordered from it.`,
          ),
          details: { ...added },
        };
      } catch (error) {
        return refused(error, { supplier: args.supplier });
      }
    },
  });

  const recordReceipt = defineTool({
    name: "record_receipt",
    description:
      "Record goods received against a placed purchase order, from a named person's report: who reported it, the message it came from, and what arrived. The desk checks each quantity against the order and refuses more than is still to come. An internal record: it pays nothing and sends nothing.",
    parameters: Type.Object(
      {
        purchaseOrderId: Type.String({ description: "The purchase order number, e.g. PO-1003" }),
        lines: LINES,
        reportedBy: Type.String({
          minLength: 1,
          description: "The name of the person who reported the delivery",
        }),
        source: Type.String({
          minLength: 1,
          description: "The message the report came from: its channel, sender and when",
        }),
        packingSlip: Type.Optional(
          Type.String({ description: "The supplier's packing slip reference, if given" }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const receipt = await desk.recordReceipt(
          {
            purchaseOrderId: args.purchaseOrderId,
            lines: args.lines,
            reportedBy: args.reportedBy,
            source: args.source,
            ...(args.packingSlip === undefined ? {} : { packingSlip: args.packingSlip }),
          },
          { requestId: requestId("receipt", api) },
        );
        return {
          ...textResult(receiptText(receipt)),
          details: { ...receipt, lines: receipt.lines.map((line) => ({ ...line })) },
        };
      } catch (error) {
        return refused(error, { purchaseOrderId: args.purchaseOrderId });
      }
    },
  });

  const readCompany = defineTool({
    name: "read_company",
    description:
      "Read one section of the company record: the profile, the office hours, the people and what each decides, purchasing (who decides, the spending limit and the approved supplier list), the policies, the tone of voice, the escalation path or the glossary.",
    parameters: Type.Object(
      {
        section: Type.Union(
          SECTIONS.map((section) => Type.Literal(section)),
          { description: "Which part of the record to read" },
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const section = args.section as CompanySection;
      return { ...textResult(companySection(company, section)), details: { section } };
    },
  });

  return {
    listStock,
    listSuppliers,
    compareSuppliers,
    listPurchaseOrders,
    raisePurchaseOrder,
    requestPoApproval,
    requestNewSupplier,
    recordReceipt,
    readCompany,
  };
}
