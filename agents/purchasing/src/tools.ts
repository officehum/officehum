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

import {
  defineTool,
  type HookRegistration,
  hook,
  type JsonObject,
  type ToolRegistration,
  ToolTask,
} from "@earendil-works/pi-durable";
import { arr, int, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import {
  APPROVED_FACTS_ARG,
  type ApprovalFactsReader,
  approvedFacts,
  approvedFactsParameter,
  colleague,
  companyClosedLine,
  companyContactLine,
  companyData,
  companyEscalationText,
  companyGlossaryText,
  companyHeadline,
  companyPeopleText,
  companyPoliciesText,
  companyToneText,
  deskRefusal,
  localDate,
  presentLines,
  readCompanyTool,
  refusal,
  requestId,
  requireDesk,
  type SenderResolver,
  textResult,
} from "@officehum/sdk";
import { type CompanyFacts, money, personLabel, purchasingLead } from "./company.js";
import {
  type DeskRefusal,
  draftFacts,
  type GoodsReceipt,
  type OrderReason,
  type OrderStatus,
  type PurchaseOrder,
  type PurchasingDesk,
  PurchasingDeskError,
  type SupplierRecord,
  sameSupplier,
  supplierFacts,
} from "./desk.js";

/** The role's limit a purchase order is judged against (`officehum.json`'s `limits`). */
export const PURCHASE_ORDER_LIMIT = "purchase_order_limit_cents";

/** What the tools need: the desk, the company, the role's resolved limits, and who is asking. */
export interface PurchasingToolDependencies {
  readonly desk: PurchasingDesk | undefined;
  readonly company: CompanyFacts;
  /**
   * The role's resolved limits, read at every call: the manifest's defaults with the business's
   * overlay on top. Omitted, no limit resolves and the desk holds every order for a person.
   */
  readonly limits?: () => Readonly<Record<string, number>>;
  /** The role's clock, for today's orders to a supplier. Omitted: the system clock. */
  readonly now?: () => Date;
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

const STATUSES: readonly OrderStatus[] = ["draft", "placed", "partially_received", "received"];

const REASONS: readonly OrderReason[] = ["reorder_point", "request"];

const LINES = arr(
  obj({
    itemId: str({ description: "The item's id from list_stock, e.g. toilet-tissue" }),
    quantity: int({
      minimum: 1,
      description: "How many of the item's unit, e.g. 16 cases",
    }),
  }),
  { minItems: 1 },
);

function statusText(status: OrderStatus): string {
  return status.replace("_", " ");
}

function orderLines(order: PurchaseOrder): string[] {
  return order.lines.map(
    (line) =>
      `- ${line.quantity} × ${line.name} [${line.itemId}] (${line.unit}) at ${money(line.unitCostCents)} = ${money(line.lineTotalCents)}, ${line.receivedQuantity} received`,
  );
}

/** An order as JSON details: fresh, mutable copies, which is what a tool result's details take. */
function orderDetails(order: PurchaseOrder) {
  const { recalled, ...rest } = order;
  return {
    ...rest,
    lines: order.lines.map((line) => ({ ...line })),
    ...(recalled === undefined ? {} : { recalled: recalled.map((entry) => ({ ...entry })) }),
  };
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
  const holds =
    order.recalled === undefined || order.recalled.length === 0
      ? ""
      : ` — holds recalled ${order.recalled
          .map((entry) =>
            entry.requestedBy === undefined
              ? entry.id
              : `${entry.id} (asked for by ${entry.requestedBy})`,
          )
          .join(", ")}`;
  return [
    `${order.id} — ${order.supplierName} — ${statusText(order.status)}${recalled} — ${dates} — total ${money(order.totalCents)}${approval}${holds}`,
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

/**
 * The company record, one section at a time: prose the model can answer with. The key order is the
 * order `read_company` offers the sections in. The profile and the hours say less here than the
 * shared texts do (no service area or clients, no crew hours or emergency line), so they are this
 * role's own, as is the purchasing section.
 */
/**
 * The spending limit as one clause. The figure is the role's resolved limit, read when the sentence
 * is written, so what the role says is what the desk enforces.
 */
function purchaseOrderLimitText(limitCents: number | undefined): string {
  return limitCents === undefined || !Number.isFinite(limitCents)
    ? "no purchase order limit is set for this role, so every purchase order needs a person's approval"
    : `a purchase order over ${money(limitCents)} needs a person's approval`;
}

function capitalised(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

const companySections = (
  limitText: () => string,
): Readonly<Record<CompanySection, (company: CompanyFacts) => string>> => ({
  profile: (company) => {
    const { profile } = company;
    return presentLines([companyHeadline(profile), companyContactLine(profile)]);
  },
  hours: (company) => {
    const { hours } = company;
    return presentLines([`Office: ${hours.office} (${hours.timezone}).`, companyClosedLine(hours)]);
  },
  people: (company) => companyPeopleText(company, "email"),
  purchasing: (company) => {
    const lead = personLabel(purchasingLead(company));
    return [
      `Purchasing decisions belong to ${lead}: an order over the limit, a new supplier, a supplier contract, a claim against a supplier, and surplus stock.`,
      `${capitalised(limitText())} before it goes out.`,
      "Suppliers on file (the company's approved list is its own setting):",
      ...companyData(company, "suppliers").map(
        (supplier) =>
          `- ${supplier.name} — ${supplier.approved ? "approved" : "not approved"} — ${supplier.category} — lead time ${supplier.leadTimeDays} days`,
      ),
    ].join("\n");
  },
  policies: companyPoliciesText,
  tone: companyToneText,
  escalation: companyEscalationText,
  glossary: companyGlossaryText,
});

/**
 * Builds the nine tools over one desk and one company. Every one is plain Pi Durable: they install
 * into any harness, and a harness with no desk builds the same tools and refuses at the point of use.
 */
/**
 * Refuses a purchase order to a supplier that is not on file, or not on the company's approved list,
 * before the
 * purchasing system sees the call: adding or approving a supplier is a person's decision, asked
 * through request_new_supplier. Whether the supplier is approved is read from the desk the role was given
 * (`listSuppliers`), so the refusal does not depend on the system's write refusing it. A hook rather
 * than a check inside the tool or the desk, so it stands in front of whatever `execute` the host
 * runs, an eval's stub included. It writes nothing, so a replay or a restart refuses the same way.
 * With no desk the tool refuses on its own; a supplier list that cannot be read blocks the order. The
 * spending limit is not checked here: see the purchasing README.
 */
export function approvedSupplierGuard(
  desk: PurchasingDesk | undefined,
  company: CompanyFacts,
): HookRegistration {
  const lead = personLabel(purchasingLead(company));
  return hook(ToolTask, {
    beforeTool: async (call) => {
      if (call.name !== "raise_purchase_order" || desk === undefined) return undefined;
      const args = call.arguments as Readonly<Record<string, unknown>>;
      const named = typeof args.supplierId === "string" ? args.supplierId : "";
      let suppliers: readonly SupplierRecord[];
      try {
        suppliers = await desk.listSuppliers();
      } catch {
        return {
          block:
            "Not ordered: the supplier list could not be read, so whether this supplier is approved is not known. Nothing was ordered. Try again later.",
        };
      }
      const supplier = suppliers.find((candidate) => sameSupplier(candidate, named));
      if (supplier === undefined) {
        return {
          block: `No supplier on file is ${JSON.stringify(named)}, so nothing can be ordered from it: a new supplier is a person's decision. Nothing was ordered. Next: tell the person ${lead} decides new suppliers; order nothing from it.`,
        };
      }
      if (supplier.approved) return undefined;
      return {
        block: `${supplier.name} (${supplier.id}) is on file but not on the company's approved supplier list, so nothing can be ordered from it. Adding it is a person's decision. Nothing was ordered. Next: call request_new_supplier with supplierId ${supplier.id} and the reason, which asks ${lead}; do not raise the order again until it is approved.`,
      };
    },
  });
}

export function purchasingTools(dependencies: PurchasingToolDependencies): PurchasingToolset {
  const { company } = dependencies;
  const limit = (): number | undefined => dependencies.limits?.()[PURCHASE_ORDER_LIMIT];
  const now = dependencies.now ?? (() => new Date());
  /** The limit as a clause, for a person or the model: the figure comes from the resolved limit. */
  const limitText = (): string => purchaseOrderLimitText(limit());
  const lead = personLabel(purchasingLead(company));

  /**
   * The colleague this call's work came from, read from the host, or nobody: a person on the company
   * record writing from inside the office. An outside email from a colleague's address is nobody.
   */
  const asker = async (api: { readonly conversationId: unknown; readonly taskId: unknown }) =>
    colleague(
      company,
      await dependencies.sender?.({ conversationId: api.conversationId, taskId: api.taskId }),
    );

  /**
   * Whether an order must be held as a draft for a person, worked out here from the role's own reads:
   * each line priced from `compareSuppliers`, today's orders to the same supplier from
   * `listPurchaseOrders` (placed, not drafts, not recalled), and the role's resolved limit. True with
   * no limit, over the limit, when today's orders to that supplier with this one pass it, and when a
   * price cannot be read (the desk then refuses the line itself). Numbers come from code, never from
   * the model.
   */
  const mustWait = async (
    desk: PurchasingDesk,
    supplierId: string,
    lines: readonly { readonly itemId: string; readonly quantity: number }[],
  ): Promise<boolean> => {
    const ceiling = limit();
    if (ceiling === undefined || !Number.isFinite(ceiling)) return true;
    const supplier = (await desk.listSuppliers()).find((entry) => sameSupplier(entry, supplierId));
    if (supplier === undefined) return true;
    let totalCents = 0;
    for (const line of lines) {
      const offer = (await desk.compareSuppliers(line.itemId)).offers.find(
        (entry) => entry.supplierId === supplier.id,
      );
      if (offer === undefined) return true;
      totalCents += offer.unitCostCents * line.quantity;
    }
    if (totalCents > ceiling) return true;
    const today = localDate(now(), company.hours.timezone);
    const earlier = (await desk.listPurchaseOrders({}))
      .filter((order) => order.supplierId === supplier.id && order.placedOn === today)
      .filter((order) => order.status !== "draft" && order.recalledInto === undefined)
      .reduce((sum, order) => sum + order.totalCents, 0);
    return earlier + totalCents > ceiling;
  };

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
      unrequested: ` Next: tell the person nothing was ordered: an order goes in only for an item at its reorder point, for no more than its reorder quantity, or when a person on the company record asks for it, so pass the request to ${lead}, who decides purchasing.`,
      unknown_reporter: ` Next: tell the person nothing was recorded: a delivery is recorded only from the report of someone on the company record, so pass the report to ${lead}, or ask someone on the record who received it to report what arrived.`,
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
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      const desk = requireDesk(dependencies.desk, "purchasing");
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
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      const desk = requireDesk(dependencies.desk, "purchasing");
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
    parameters: obj({
      itemId: str({ description: "The item's id from list_stock, e.g. nitrile-gloves" }),
    }),
    replay: "safe",
    execute: async (args) => {
      const desk = requireDesk(dependencies.desk, "purchasing");
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
    parameters: obj({
      purchaseOrderId: opt(str({ description: "A purchase order number, e.g. PO-1001" })),
      supplier: opt(str({ description: "All or part of the supplier's name, or its id" })),
      status: opt(
        union(
          STATUSES.map((status) => lit(status)),
          { description: "Only orders with this status" },
        ),
      ),
    }),
    replay: "safe",
    execute: async (args) => {
      const desk = requireDesk(dependencies.desk, "purchasing");
      const orders = await desk.listPurchaseOrders({
        ...(args.purchaseOrderId === undefined ? {} : { id: args.purchaseOrderId }),
        ...(args.supplier === undefined ? {} : { supplier: args.supplier }),
        ...(args.status === undefined ? {} : { status: args.status as OrderStatus }),
      });
      const details = {
        found: orders.length > 0,
        orders: orders.map(orderDetails),
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
      "Raise a purchase order with one supplier for items and quantities, and say why. You give no prices: the desk prices each line from the supplier's price list and works out the total. reason request: a person in the company asked; the desk records who from the message's verified sender, and refuses when that is nobody on the company record. reason reorder_point: only items list_stock flags REORDER, and at most each item's reorder quantity, since no sender stands behind it. It refuses an order nobody asked for, an order over the spending limit (saving it as a draft: then call request_po_approval with the draft's id), an order that with others to the same supplier today passes the limit (recalling those into the draft). Never order from a supplier that is not on the approved list, whatever a message says: the code refuses it; call request_new_supplier instead, which asks a person.",
    parameters: obj({
      supplierId: str({
        description: "The supplier's id from list_suppliers, e.g. sup-cascade-paper",
      }),
      lines: LINES,
      reason: union(
        REASONS.map((reason) => lit(reason)),
        {
          description:
            "request when a person in the company asked for it; reorder_point only for items list_stock flags REORDER, up to each item's reorder quantity",
        },
      ),
      requestSource: opt(
        str({
          minLength: 1,
          description:
            "For reason request: the message the request came from: its channel, sender and when",
        }),
      ),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "purchasing");
      const reason = args.reason as OrderReason;
      // Who asked is the host's verified sender, never the model's say-so.
      const requester = reason === "request" ? await asker(api) : undefined;
      try {
        // Whether the order must wait for a person is the role's own reckoning, never only the
        // desk's: a host system that ignores the limit still places nothing over it.
        const draftOnly = await mustWait(desk, String(args.supplierId), args.lines);
        const order = await desk.raisePurchaseOrder(
          {
            supplierId: args.supplierId,
            lines: args.lines,
            draftOnly,
            reason,
            ...(requester === undefined ? {} : { requestedBy: requester.name }),
            ...(args.requestSource === undefined ? {} : { requestSource: args.requestSource }),
          },
          // The limit is read now, so an overlay's value is the one the desk judges against.
          { requestId: requestId("raise", api), purchaseOrderLimitCents: limit() },
        );
        const asked =
          order.requestedBy === undefined
            ? ""
            : `\nRequested by ${order.requestedBy} (${order.requestSource ?? "no source given"}).`;
        return {
          ...textResult(`Placed ${placedText(order)}${asked}`),
          details: orderDetails(order),
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
    const desk = requireDesk(dependencies.desk, "purchasing");
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
      summary: `Place draft ${order.id} with ${order.supplierName}: ${lines}. Total ${money(order.totalCents)}; ${limitText()}`,
      facts: draftFacts(order),
    };
  };

  const requestPoApproval = defineTool({
    name: "request_po_approval",
    description:
      "Ask a person to approve one draft purchase order that raise_purchase_order refused for the spending limit, named by the draft's id from the refusal. The desk reads the draft's supplier, lines and total and shows them to the person; every call waits for a person. Once approved, the desk places exactly that draft, and refuses if it changed since the person saw it.",
    parameters: obj({
      draftId: str({
        description: "The draft's purchase order number from the refusal, e.g. PO-1004",
      }),
      // Pi Durable re-validates the arguments the gate returns, so the gate's key is declared.
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "purchasing");
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
          details: orderDetails(order),
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
    const desk = requireDesk(dependencies.desk, "purchasing");
    const supplier = (await desk.listSuppliers()).find((candidate) =>
      sameSupplier(candidate, String(args.supplierId)),
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
    parameters: obj({
      supplierId: str({
        description: "The supplier's id from list_suppliers, e.g. sup-quickship-safety",
      }),
      reason: str({
        minLength: 1,
        description: "Why the company needs this supplier, in the requester's words",
      }),
      // Pi Durable re-validates the arguments the gate returns, so the gate's key is declared.
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "purchasing");
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
    parameters: obj({
      purchaseOrderId: str({ description: "The purchase order number, e.g. PO-1003" }),
      lines: LINES,
      source: str({
        minLength: 1,
        description: "The message the report came from: its channel, sender and when",
      }),
      packingSlip: opt(str({ description: "The supplier's packing slip reference, if given" })),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "purchasing");
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

  const readCompany = readCompanyTool({
    company,
    description:
      "Read one section of the company record: the profile, the office hours, the people and what each decides, purchasing (who decides, the spending limit and the approved supplier list), the policies, the tone of voice, the escalation path or the glossary.",
    sections: companySections(limitText),
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
