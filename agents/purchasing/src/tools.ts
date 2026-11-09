/**
 * The Purchasing role's nine tools.
 *
 * `list_stock`, `list_suppliers`, `compare_suppliers`, `list_purchase_orders` and `read_company` only
 * read. `raise_purchase_order` and `record_receipt` write through the desk with no approval: the desk
 * prices every order and refuses one over the spending limit, one split to stay under it, and one to a
 * supplier not on the approved list, and it checks every receipt against the order. Each refusal a
 * person can lift names the approval-gated tool that asks them. `request_po_approval` and
 * `request_new_supplier` are those tools; their approvals are `officehum.json`'s, evaluated by the
 * SDK's gate before the tool runs, so this file holds no money limit and no approval rule. The model
 * names only the draft or the supplier: `poApprovalFacts` and `newSupplierApprovalFacts` read what the
 * person approves from the desk, the gate hands those facts to the tool on a yes, and the desk refuses
 * when the draft or supplier no longer equals what was approved.
 *
 * Who asked for an order and who reported a delivery are never the model's to say: both tools read
 * the host's verified sender (`SenderResolver`) and pass the person on the company record it names to
 * the desk, which refuses an order nobody asked for (`unrequested`) and a receipt nobody on the
 * record reported (`unknown_reporter`).
 *
 * Every amount a tool speaks comes back from the desk, and every name from the company record.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  APPROVED_FACTS_ARG,
  type ApprovalFactsReader,
  approvedFacts,
  approvedFactsParameter,
  deskRefusal,
  refusal,
  requestId,
  type SenderResolver,
  senderPerson,
  textResult,
} from "@officehum/sdk";
import { type CompanyFacts, money, person, personLabel, purchasingLead } from "./company.js";
import {
  type DeskRefusal,
  draftFacts,
  type GoodsReceipt,
  type OrderReason,
  type OrderStatus,
  type PurchaseOrder,
  type PurchasingDesk,
  PurchasingDeskError,
  supplierFacts,
} from "./desk.js";

/** What the tools need: the desk, the company whose supplies it buys, and who is asking. */
export interface PurchasingToolDependencies {
  readonly desk: PurchasingDesk | undefined;
  readonly company: CompanyFacts;
  /** The host's verified sender of each call's work. Omitted: every sender is unknown. */
  readonly sender?: SenderResolver;
}

/**
 * The nine tools, named, so the factory places each one where the manifest declares it, and the
 * readers the two approvals ask with.
 */
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
  /** Reads a draft's supplier, lines and total from the desk for the person approving it. */
  readonly poApprovalFacts: ApprovalFactsReader;
  /** Reads a supplier's record from the desk for the person approving it. */
  readonly newSupplierApprovalFacts: ApprovalFactsReader;
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

const REASONS: readonly OrderReason[] = ["reorder_point", "request"];

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
  const recalled =
    order.recalledInto === undefined
      ? ""
      : ` — recalled into ${order.recalledInto}, never placed on its own`;
  return [
    `${order.id} — ${order.supplierName} — ${statusText(order.status)}${recalled} — ${dates} — total ${money(order.totalCents)}${approval}`,
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

  /** The person on the company record this call's work came from, read from the host, or nobody. */
  const asker = async (api: { readonly conversationId: unknown; readonly taskId: unknown }) =>
    senderPerson(
      company,
      await dependencies.sender?.({ conversationId: api.conversationId, taskId: api.taskId }),
    );

  /** A desk refusal as the model reads it, with the next step that a person can take. */
  const refused = (error: unknown, extra: JsonObject) => {
    if (!(error instanceof PurchasingDeskError)) throw error;
    // The next step comes from the refusal's code, never from reading its message.
    const supplier = typeof extra.supplierId === "string" ? extra.supplierId : undefined;
    // The approval names only the draft: the gate reads its supplier, lines and total from the desk.
    const grant = error.draftId === undefined ? "" : ` with draftId ${error.draftId}`;
    const approval = ` Next: call request_po_approval${grant}, which asks ${lead}.`;
    const draft = error.draftId ?? "the draft";
    const next: Record<DeskRefusal, string> = {
      over_limit: approval,
      split_order: approval,
      unapproved_supplier: ` Next: call request_new_supplier${supplier === undefined ? " with the supplier's id" : ` with supplierId ${supplier}`} and the reason, which asks ${lead}.`,
      over_received: ` Any extra is ${lead}'s to take up with the supplier.`,
      // The desk's own message already says what to do for these.
      not_found: "",
      invalid: "",
      not_offered: "",
      not_draft: "",
      draft_changed: ` Next: tell the person ${draft} changed after it was put to a person, so it was not placed; read it again with list_purchase_orders before anything else.`,
      supplier_changed: ` Next: tell the person the supplier's record changed after it was put to a person, so it was not added; read it again with list_suppliers before anything else.`,
      already_approved: "",
      not_placed: "",
      not_on_order: "",
      unrequested: ` Next: tell the person nothing was ordered: an order goes in only for an item at its reorder point or when a person on the company record asks for it, and ${lead} decides purchasing.`,
      unknown_reporter: ` Next: tell the person nothing was recorded: ask someone on the company record who received the delivery to report what arrived.`,
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
      "Raise a purchase order with one supplier for items and quantities, and say why. You give no prices: the desk prices each line from the supplier's price list and works out the total. reason request: a person in the company asked; the desk records who from the message's verified sender, and refuses when that is nobody on the company record. reason reorder_point: only items list_stock flags REORDER. It refuses an order nobody asked for, an order over the spending limit (saving it as a draft: then call request_po_approval with the draft's id), an order that with others to the same supplier today passes the limit (recalling those into the draft), and a supplier not on the approved list (then call request_new_supplier).",
    parameters: Type.Object(
      {
        supplierId: Type.String({
          description: "The supplier's id from list_suppliers, e.g. sup-cascade-paper",
        }),
        lines: LINES,
        reason: Type.Union(
          REASONS.map((reason) => Type.Literal(reason)),
          {
            description:
              "request when a person in the company asked for it; reorder_point only for items list_stock flags REORDER",
          },
        ),
        requestSource: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "For reason request: the message the request came from: its channel, sender and when",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      const reason = args.reason as OrderReason;
      // Who asked is the host's verified sender, never the model's say-so.
      const requester = reason === "request" ? await asker(api) : undefined;
      try {
        const order = await desk.raisePurchaseOrder(
          {
            supplierId: args.supplierId,
            lines: args.lines,
            reason,
            ...(requester === undefined ? {} : { requestedBy: requester.name }),
            ...(args.requestSource === undefined ? {} : { requestSource: args.requestSource }),
          },
          { requestId: requestId("raise", api) },
        );
        const asked =
          order.requestedBy === undefined
            ? ""
            : `\nRequested by ${order.requestedBy} (${order.requestSource ?? "no source given"}).`;
        return {
          ...textResult(`Placed ${placedText(order)}${asked}`),
          details: { ...order, lines: order.lines.map((line) => ({ ...line })) },
        };
      } catch (error) {
        return refused(error, { supplierId: args.supplierId });
      }
    },
  });

  /**
   * The `po_over_limit` approval's facts: the draft as the desk holds it, read before anyone is asked.
   * An order that is not on the desk or is not a draft has nothing to approve, so it throws and the
   * gate asks nobody.
   */
  const poApprovalFacts: ApprovalFactsReader = async (args) => {
    const desk = requireDesk(dependencies);
    const draftId = String(args.draftId);
    const [order] = await desk.listPurchaseOrders({ id: draftId });
    if (order === undefined) {
      throw new Error(
        `No purchase order has the number ${JSON.stringify(draftId)}. Nothing was put to a person and nothing was placed. Next: find the draft with list_purchase_orders.`,
      );
    }
    if (order.recalledInto !== undefined) {
      throw new Error(
        `${order.id} was recalled into ${order.recalledInto} when a split order was refused, so it is never placed on its own. Nothing was put to a person and nothing was placed. Next: ask about ${order.recalledInto}, which holds its lines.`,
      );
    }
    if (order.status !== "draft") {
      throw new Error(
        `${order.id} is not a draft waiting for approval: it is ${statusText(order.status)}. Nothing was put to a person and nothing was placed again. Next: tell the person; a new or changed order is raised with raise_purchase_order.`,
      );
    }
    const lines = order.lines
      .map(
        (line) =>
          `${line.quantity} × ${line.name} (${line.unit}) at ${money(line.unitCostCents)} = ${money(line.lineTotalCents)}`,
      )
      .join("; ");
    return {
      summary: `Place draft ${order.id} with ${order.supplierName}: ${lines}. Total ${money(order.totalCents)}; a purchase order over ${money(company.approvalLimits.purchaseOrderOverCents)} needs a person's approval`,
      facts: draftFacts(order),
    };
  };

  const requestPoApproval = defineTool({
    name: "request_po_approval",
    description:
      "Ask a person to approve one draft purchase order that raise_purchase_order refused for the spending limit, named by the draft's id from the refusal. The desk reads the draft's supplier, lines and total and shows them to the person; every call waits for a person. Once approved, the desk places exactly that draft, and refuses if it changed since the person saw it.",
    parameters: Type.Object(
      {
        draftId: Type.String({
          description: "The draft's purchase order number from the refusal, e.g. PO-1004",
        }),
        // Pi Durable re-validates the arguments the gate returns, so the gate's key is declared.
        [APPROVED_FACTS_ARG]: approvedFactsParameter(),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return refusal(
          `Nothing was placed: this call to place ${args.draftId} carries no facts a person approved. A draft is placed only after the approval gate has put it to a person and they said yes. Next: tell the person placing it needs a person's approval and nothing was placed.`,
          { code: "not_approved", draftId: args.draftId },
        );
      }
      try {
        const order = await desk.placeDraft(
          { draftId: args.draftId, approved },
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

  /**
   * The `new_supplier` approval's facts: the supplier's record as the desk holds it. A supplier not on
   * file has no record to show, and one already approved has nothing to approve, so either throws and
   * the gate asks nobody. The reason stays in the call's arguments: it is the requester's words.
   */
  const newSupplierApprovalFacts: ApprovalFactsReader = async (args) => {
    const desk = requireDesk(dependencies);
    const wanted = String(args.supplierId).trim().toLowerCase();
    const supplier = (await desk.listSuppliers()).find(
      (candidate) =>
        candidate.id.toLowerCase() === wanted || candidate.name.toLowerCase() === wanted,
    );
    if (supplier === undefined) {
      throw new Error(
        `No supplier on file is ${JSON.stringify(String(args.supplierId))}. Nothing was put to a person and nothing was added. Next: tell the person who asked that setting up a supplier not on file is for ${lead} to decide; nothing was asked or added.`,
      );
    }
    if (supplier.approved) {
      throw new Error(
        `${supplier.name} (${supplier.id}) is already on the approved supplier list. Nothing was put to a person. Next: order from it with raise_purchase_order.`,
      );
    }
    const reason = String(args.reason ?? "").trim();
    if (reason === "") {
      throw new Error(
        "Say why the supplier should be added: what it supplies and why the approved ones will not do. Nothing was put to a person and nothing was added.",
      );
    }
    return {
      // The reason is the requester's words, not a desk fact: quoted, so the person sees where the
      // desk's text ends.
      summary: `Add ${supplier.name} (${supplier.id}) to the approved supplier list: ${supplier.category}, lead time ${supplier.leadTimeDays} days, contact ${supplier.contactEmail}. Reason given by the requester: ${JSON.stringify(reason)}`,
      facts: supplierFacts(supplier),
    };
  };

  const requestNewSupplier = defineTool({
    name: "request_new_supplier",
    description:
      "Ask a person to add a supplier on file to the company's approved supplier list, named by its id from list_suppliers, with the requester's reason. The desk reads the supplier's record and shows it to the person; every call waits for a person. Once approved, the supplier is on the list. It orders nothing.",
    parameters: Type.Object(
      {
        supplierId: Type.String({
          description: "The supplier's id from list_suppliers, e.g. sup-quickship-safety",
        }),
        reason: Type.String({
          minLength: 1,
          description: "Why the company needs this supplier, in the requester's words",
        }),
        // Pi Durable re-validates the arguments the gate returns, so the gate's key is declared.
        [APPROVED_FACTS_ARG]: approvedFactsParameter(),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return refusal(
          `Nothing was added: this call to add ${args.supplierId} to the approved list carries no facts a person approved. A supplier is added only after the approval gate has put it to a person and they said yes. Next: tell the person adding it needs a person's approval and nothing was added.`,
          { code: "not_approved", supplierId: args.supplierId },
        );
      }
      try {
        const added = await desk.addSupplier(
          { supplierId: args.supplierId, reason: args.reason, approved },
          { requestId: requestId("new-supplier", api) },
        );
        return {
          ...textResult(
            `Approved: ${added.supplierName} (${added.supplierId}) is now on the approved supplier list. Reason recorded: ${added.reason}. Nothing has been ordered from it.`,
          ),
          details: { ...added },
        };
      } catch (error) {
        return refused(error, { supplierId: args.supplierId });
      }
    },
  });

  const recordReceipt = defineTool({
    name: "record_receipt",
    description:
      "Record goods received against a placed purchase order, from the report of a person on the company record: the message it came from and what arrived. The desk records the reporter from the message's verified sender and refuses a report from anyone not on the company record. It checks each quantity against the order and refuses more than is still to come. An internal record: it pays nothing and sends nothing.",
    parameters: Type.Object(
      {
        purchaseOrderId: Type.String({ description: "The purchase order number, e.g. PO-1003" }),
        lines: LINES,
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
      // Who reported it is the host's verified sender, never the model's say-so.
      const reporter = await asker(api);
      try {
        const receipt = await desk.recordReceipt(
          {
            purchaseOrderId: args.purchaseOrderId,
            lines: args.lines,
            ...(reporter === undefined ? {} : { reportedBy: reporter.name }),
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
    poApprovalFacts,
    newSupplierApprovalFacts,
  };
}
