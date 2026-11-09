/**
 * The desk: the purchasing system this role reads stock, suppliers and orders from and writes orders
 * and receipts to.
 *
 * A host binds its own — an ERP, inventory software, a spreadsheet with an API — and the role never
 * knows the difference. `fakePurchasingDesk` is what ships with the package: the company's own
 * suppliers and catalogue, a demonstration stockroom and three orders, and all the money arithmetic
 * done here, so a test, an eval or a first run needs no network and no credential.
 *
 * The desk owns every number that matters. The model names a supplier, items and quantities; the desk
 * looks up each unit cost, works out each line and the total, and decides whether the order is over
 * the spending limit, from a supplier not on the approved list, or a split of a bigger order. A
 * refusal carries a code, and the tools turn the code into the next step a person can take.
 */

import { sameFacts } from "@officehum/sdk";
import type { CompanyFacts, Supplier, SupplyItem } from "./company.js";
import { loadCompanyFacts, money } from "./company.js";

/** One item's stock, with the reorder decision worked out by the desk. */
export interface StockLevel {
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly onHand: number;
  /** Ordered and not yet received, on placed orders. A draft is not on order. */
  readonly onOrder: number;
  readonly reorderPoint: number;
  readonly reorderQuantity: number;
  /** On hand plus on order is at or below the reorder point. */
  readonly needsReorder: boolean;
}

/** A supplier on file, and the items it has a price for. */
export interface SupplierRecord {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly approved: boolean;
  readonly leadTimeDays: number;
  /** Where the supplier is reached, as the company records it. */
  readonly contactEmail: string;
  readonly items: readonly string[];
}

/** One supplier's price for one item, from its price list. */
export interface SupplierOffer {
  readonly supplierId: string;
  readonly itemId: string;
  readonly unitCostCents: number;
}

/** What one supplier charges for an item and how long it takes, for a comparison. */
export interface OfferLine {
  readonly supplierId: string;
  readonly supplierName: string;
  readonly approved: boolean;
  /** The supplier the company's catalogue buys this item from. */
  readonly usual: boolean;
  readonly unitCostCents: number;
  readonly leadTimeDays: number;
}

export interface SupplierComparison {
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  /** Cheapest first. */
  readonly offers: readonly OfferLine[];
}

export interface PurchaseOrderLine {
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  readonly quantity: number;
  readonly unitCostCents: number;
  readonly lineTotalCents: number;
  readonly receivedQuantity: number;
}

/**
 * `draft`: refused for the spending limit and saved, not sent; only a person's approval places it.
 * `placed`: sent to the supplier. `partially_received` and `received` follow receipts.
 */
export type OrderStatus = "draft" | "placed" | "partially_received" | "received";

export interface PurchaseOrder {
  readonly id: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly status: OrderStatus;
  readonly lines: readonly PurchaseOrderLine[];
  readonly totalCents: number;
  /** `YYYY-MM-DD` the order was raised, placed or not. */
  readonly raisedOn: string;
  readonly placedOn: string | null;
  /** Placed date plus the supplier's lead time. */
  readonly expectedOn: string | null;
  /** Placed over the limit with a person's approval. */
  readonly approved: boolean;
}

/** Goods recorded as received against an order, and who said they arrived. */
export interface GoodsReceipt {
  readonly id: string;
  readonly purchaseOrderId: string;
  readonly supplierName: string;
  readonly lines: readonly {
    readonly itemId: string;
    readonly name: string;
    readonly unit: string;
    readonly quantity: number;
    /** Still to come on that line after this receipt. */
    readonly outstanding: number;
  }[];
  readonly reportedBy: string;
  /** The message the report came from. */
  readonly source: string;
  readonly packingSlip: string | null;
  readonly at: string;
  readonly orderStatus: OrderStatus;
}

/** A supplier added to the approved list once a person approved it. */
export interface SupplierApproval {
  readonly supplierId: string;
  readonly supplierName: string;
  readonly approved: true;
  readonly reason: string;
}

export interface OrderLineInput {
  readonly itemId: string;
  readonly quantity: number;
}

export interface OrderFilter {
  /** A purchase order number such as PO-1001. */
  readonly id?: string;
  /** All or part of the supplier's name, or its id. */
  readonly supplier?: string;
  readonly status?: OrderStatus;
}

/**
 * The facts a person approves when placing a draft: the supplier, each line as priced and the total,
 * and when it was raised. Its status, dates of placing and received quantities are left out on
 * purpose: they are what placing it changes, not the order the person was shown.
 */
export function draftFacts(order: PurchaseOrder): Record<string, unknown> {
  return {
    id: order.id,
    supplierId: order.supplierId,
    supplierName: order.supplierName,
    lines: order.lines.map(({ receivedQuantity: _, ...line }) => ({ ...line })),
    totalCents: order.totalCents,
    raisedOn: order.raisedOn,
  };
}

/**
 * The facts a person approves when adding a supplier to the approved list: its record as the desk
 * holds it. The items it has prices for are left out: a price list is not what the list approves.
 */
export function supplierFacts(supplier: SupplierRecord): Record<string, unknown> {
  return {
    id: supplier.id,
    name: supplier.name,
    category: supplier.category,
    leadTimeDays: supplier.leadTimeDays,
    contactEmail: supplier.contactEmail,
    approved: supplier.approved,
  };
}

/** What the role needs from whatever system holds its purchasing. */
export interface PurchasingDesk {
  listStock(): Promise<readonly StockLevel[]>;
  listSuppliers(): Promise<readonly SupplierRecord[]>;
  compareSuppliers(itemId: string): Promise<SupplierComparison>;
  listPurchaseOrders(filter?: OrderFilter): Promise<readonly PurchaseOrder[]>;
  raisePurchaseOrder(
    input: { readonly supplierId: string; readonly lines: readonly OrderLineInput[] },
    options: { readonly requestId: string },
  ): Promise<PurchaseOrder>;
  /**
   * Places one draft, exactly as it was raised. Called only once a person approved it, with the facts
   * the approval gate read from this desk and showed them (`draftFacts`). A host desk must refuse with
   * `draft_changed` when the draft no longer equals `approved` (a draft edited since, in a system that
   * allows that), so a grant never places an order nobody was shown.
   */
  placeDraft(
    input: { readonly draftId: string; readonly approved: Readonly<Record<string, unknown>> },
    options: { readonly requestId: string },
  ): Promise<PurchaseOrder>;
  /**
   * Marks a supplier on file approved. Called only once a person approved it, with the record they
   * were shown (`supplierFacts`). A host desk must refuse with `supplier_changed` when the record no
   * longer equals `approved`. `reason` is the requester's own words, recorded with the approval.
   */
  addSupplier(
    input: {
      readonly supplierId: string;
      readonly reason: string;
      readonly approved: Readonly<Record<string, unknown>>;
    },
    options: { readonly requestId: string },
  ): Promise<SupplierApproval>;
  recordReceipt(
    input: {
      readonly purchaseOrderId: string;
      readonly lines: readonly OrderLineInput[];
      readonly reportedBy: string;
      readonly source: string;
      readonly packingSlip?: string;
    },
    options: { readonly requestId: string },
  ): Promise<GoodsReceipt>;
}

/** Why the desk refused, so a tool can say what to do next without parsing the message. */
export type DeskRefusal =
  | "not_found"
  | "invalid"
  | "unapproved_supplier"
  | "not_offered"
  | "over_limit"
  | "split_order"
  | "not_draft"
  | "draft_changed"
  | "supplier_changed"
  | "already_approved"
  | "not_placed"
  | "not_on_order"
  | "over_received";

/** A refusal the model reads: an unknown item, an order over the limit, more than was ordered. */
export class PurchasingDeskError extends Error {
  readonly code: DeskRefusal;
  /** For `over_limit` and `split_order`: the draft the order was saved as. */
  readonly draftId: string | undefined;
  /** For `over_limit` and `split_order`: the total the desk worked out. */
  readonly totalCents: number | undefined;

  constructor(
    code: DeskRefusal,
    message: string,
    extra: { readonly draftId?: string; readonly totalCents?: number } = {},
  ) {
    super(message);
    this.name = "PurchasingDeskError";
    this.code = code;
    this.draftId = extra.draftId;
    this.totalCents = extra.totalCents;
  }
}

/** The demonstration stock and orders; the company's own catalogue, suppliers and limit. */
export interface FakePurchasingDeskOptions {
  /** The suppliers, catalogue and limit; the company's own when omitted. */
  readonly company?: Pick<CompanyFacts, "suppliers" | "supplyCatalog" | "approvalLimits">;
  /** On-hand quantity by item id; the demonstration stockroom when omitted. */
  readonly stock?: Readonly<Record<string, number>>;
  /** Existing orders; the demonstration ones when omitted. */
  readonly orders?: readonly PurchaseOrder[];
  /** Prices from suppliers other than an item's usual one; the demonstration ones when omitted. */
  readonly offers?: readonly SupplierOffer[];
  /** The clock. Omitted: Monday 9 November 2026, the morning of the demonstration week. */
  readonly now?: () => Date;
}

/** Monday 9 November 2026, at the start of the office day on the US west coast. */
export const DEMO_NOW = "2026-11-09T16:00:00.000Z";

/**
 * The demonstration stockroom on the morning of Monday 9 November 2026: what is on the shelf. Six
 * items are at or below their reorder point; glass cleaner and floor pads are low but on order.
 */
export function demoStock(): Readonly<Record<string, number>> {
  return {
    "neutral-cleaner": 9,
    disinfectant: 4,
    "glass-cleaner": 3,
    "nitrile-gloves": 2,
    "toilet-tissue": 5,
    "hand-towel": 4,
    "hand-soap": 6,
    "trash-liners": 7,
    "microfiber-cloth": 14,
    "mop-head": 8,
    "floor-pad": 1,
    "floor-finish": 4,
    "hvac-filter-stock": 2,
  };
}

/**
 * Prices from suppliers that are not an item's usual one, so a comparison has something to compare.
 * The usual supplier's price is the catalogue's own unit cost and is not repeated here.
 */
export function demoOffers(): readonly SupplierOffer[] {
  return [
    { supplierId: "sup-quickship-safety", itemId: "nitrile-gloves", unitCostCents: 5900 },
    { supplierId: "sup-pacific-janitorial", itemId: "trash-liners", unitCostCents: 3900 },
  ];
}

/**
 * The orders already on the desk, priced from the catalogue: floor pads on order from last week,
 * microfiber delivered in full, glass cleaner placed on Friday and due today, and this morning's
 * paper goods restock from Cascade, refused for the spending limit and saved as draft PO-1004 for a
 * person to decide. They are demonstration data, not part of the company record.
 *
 * The draft is seeded because eval scenarios name it: as for every role's demonstration data, the desk
 * holds the records the scenarios' stubbed tools refer to, so the approval gate reads the same draft
 * from the desk that the scenario's stubbed refusal tells the model about.
 */
export function demoOrders(
  catalog: readonly SupplyItem[],
  suppliers: readonly Supplier[],
): readonly PurchaseOrder[] {
  const line = (itemId: string, quantity: number, received: number): PurchaseOrderLine => {
    const item = catalog.find((candidate) => candidate.id === itemId);
    if (item === undefined)
      throw new Error(`The demonstration orders name ${itemId}, not stocked.`);
    return {
      itemId,
      name: item.name,
      unit: item.unit,
      quantity,
      unitCostCents: item.unitCostCents,
      lineTotalCents: quantity * item.unitCostCents,
      receivedQuantity: received,
    };
  };
  const order = (
    id: string,
    supplierId: string,
    status: OrderStatus,
    placedOn: string,
    expectedOn: string,
    lines: readonly PurchaseOrderLine[],
  ): PurchaseOrder => ({
    id,
    supplierId,
    supplierName: suppliers.find((supplier) => supplier.id === supplierId)?.name ?? supplierId,
    status,
    lines,
    totalCents: lines.reduce((total, entry) => total + entry.lineTotalCents, 0),
    raisedOn: placedOn,
    placedOn,
    expectedOn,
    approved: false,
  });
  return [
    order("PO-1001", "sup-columbia-floor", "placed", "2026-11-04", "2026-11-09", [
      line("floor-pad", 6, 0),
    ]),
    order("PO-1002", "sup-rainier-tools", "received", "2026-10-28", "2026-11-02", [
      line("microfiber-cloth", 20, 20),
      line("mop-head", 12, 12),
    ]),
    order("PO-1003", "sup-pacific-janitorial", "placed", "2026-11-06", "2026-11-09", [
      line("glass-cleaner", 12, 0),
    ]),
    {
      ...order("PO-1004", "sup-cascade-paper", "draft", "2026-11-09", "", [
        line("toilet-tissue", 16, 0),
        line("hand-towel", 12, 0),
        line("trash-liners", 20, 0),
      ]),
      placedOn: null,
      expectedOn: null,
    },
  ];
}

const DAY_MS = 86_400_000;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return isoDate(new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * DAY_MS));
}

/** A supplier id, ignoring case and spaces, or its name. */
function sameSupplier(supplier: { id: string; name: string }, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  return supplier.id.toLowerCase() === wanted || supplier.name.toLowerCase() === wanted;
}

interface SupplierState {
  id: string;
  name: string;
  category: string;
  approved: boolean;
  leadTimeDays: number;
  contactEmail: string;
}

interface OrderState {
  id: string;
  supplierId: string;
  supplierName: string;
  status: OrderStatus;
  lines: { -readonly [K in keyof PurchaseOrderLine]: PurchaseOrderLine[K] }[];
  totalCents: number;
  raisedOn: string;
  placedOn: string | null;
  expectedOn: string | null;
  approved: boolean;
}

/** An in-memory desk: the company's suppliers and catalogue, demonstration stock, nothing sent. */
export function fakePurchasingDesk(options: FakePurchasingDeskOptions = {}): PurchasingDesk {
  const facts = options.company ?? loadCompanyFacts();
  const catalog = facts.supplyCatalog;
  const limit = facts.approvalLimits.purchaseOrderOverCents;
  const clock = options.now ?? (() => new Date(DEMO_NOW));
  const suppliers: SupplierState[] = facts.suppliers.map((supplier) => ({
    id: supplier.id,
    name: supplier.name,
    category: supplier.category,
    approved: supplier.approved,
    leadTimeDays: supplier.leadTimeDays,
    contactEmail: supplier.contactEmail,
  }));
  const offers: SupplierOffer[] = [
    ...catalog.map((item) => ({
      supplierId: item.supplierId,
      itemId: item.id,
      unitCostCents: item.unitCostCents,
    })),
    ...(options.offers ?? demoOffers()),
  ];
  const onHand = new Map(Object.entries(options.stock ?? demoStock()));
  const orders: OrderState[] = (options.orders ?? demoOrders(catalog, facts.suppliers)).map(
    (order) => ({ ...order, lines: order.lines.map((line) => ({ ...line })) }),
  );
  // Every write is remembered by its request id, refusals that saved a draft included, so a replayed
  // call is answered with what it already did and never writes twice.
  const raised = new Map<string, PurchaseOrder | PurchasingDeskError>();
  const placements = new Map<string, PurchaseOrder>();
  const additions = new Map<string, SupplierApproval>();
  const receipts = new Map<string, GoodsReceipt>();
  let receiptNumber = 0;

  const nextOrderId = (): string => {
    const highest = Math.max(1000, ...orders.map((order) => Number(order.id.replace(/\D/g, ""))));
    return `PO-${highest + 1}`;
  };

  const snapshot = (order: OrderState): PurchaseOrder => ({
    ...order,
    lines: order.lines.map((line) => ({ ...line })),
  });

  const findSupplier = (query: string): SupplierState => {
    const supplier = suppliers.find((candidate) => sameSupplier(candidate, query));
    if (supplier === undefined) {
      const known = suppliers.map((candidate) => `${candidate.id} (${candidate.name})`).join(", ");
      throw new PurchasingDeskError(
        "not_found",
        `No supplier on file is ${JSON.stringify(query)}. The suppliers are: ${known}.`,
      );
    }
    return supplier;
  };

  const findItem = (id: string): SupplyItem => {
    const item = catalog.find((candidate) => candidate.id === id.trim());
    if (item === undefined) {
      throw new PurchasingDeskError(
        "not_found",
        `No stocked item has the id ${JSON.stringify(id)}. Find it with list_stock.`,
      );
    }
    return item;
  };

  const findOrder = (id: string): OrderState => {
    const order = orders.find(
      (candidate) => candidate.id.toLowerCase() === id.trim().toLowerCase(),
    );
    if (order === undefined) {
      throw new PurchasingDeskError(
        "not_found",
        `No purchase order has the number ${JSON.stringify(id)}. Find it with list_purchase_orders.`,
      );
    }
    return order;
  };

  const wholeQuantity = (quantity: number, what: string): void => {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new PurchasingDeskError(
        "invalid",
        `${String(quantity)} is not a quantity for ${what}: give a whole number of units, 1 or more.`,
      );
    }
  };

  const onOrderOf = (itemId: string): number =>
    orders
      .filter((order) => order.status === "placed" || order.status === "partially_received")
      .flatMap((order) => order.lines)
      .filter((line) => line.itemId === itemId)
      .reduce((total, line) => total + line.quantity - line.receivedQuantity, 0);

  /** Each line priced from the supplier's own price for it: the model never supplies a cost. */
  const price = (supplier: SupplierState, lines: readonly OrderLineInput[]) => {
    if (lines.length === 0) {
      throw new PurchasingDeskError("invalid", "An order needs at least one item and quantity.");
    }
    const ids = new Set<string>();
    return lines.map((input) => {
      const item = findItem(input.itemId);
      if (ids.has(item.id)) {
        throw new PurchasingDeskError(
          "invalid",
          `${item.id} is on the order twice: give each item once, with its whole quantity.`,
        );
      }
      ids.add(item.id);
      wholeQuantity(input.quantity, item.name);
      const offer = offers.find(
        (candidate) => candidate.supplierId === supplier.id && candidate.itemId === item.id,
      );
      if (offer === undefined) {
        const usual = suppliers.find((candidate) => candidate.id === item.supplierId);
        throw new PurchasingDeskError(
          "not_offered",
          `${supplier.name} has no price for ${item.name}. Its usual supplier is ${usual?.name ?? item.supplierId} (${item.supplierId}); compare_suppliers lists who offers it. Nothing was ordered.`,
        );
      }
      return {
        itemId: item.id,
        name: item.name,
        unit: item.unit,
        quantity: input.quantity,
        unitCostCents: offer.unitCostCents,
        lineTotalCents: input.quantity * offer.unitCostCents,
        receivedQuantity: 0,
      };
    });
  };

  const record = (supplier: SupplierState): SupplierRecord => ({
    ...supplier,
    items: offers.filter((offer) => offer.supplierId === supplier.id).map((offer) => offer.itemId),
  });

  const place = (order: OrderState, supplier: SupplierState, approved: boolean): void => {
    const today = isoDate(clock());
    order.status = "placed";
    order.placedOn = today;
    order.expectedOn = addDays(today, supplier.leadTimeDays);
    order.approved = approved;
  };

  return {
    async listStock(): Promise<readonly StockLevel[]> {
      return catalog.map((item) => {
        const held = onHand.get(item.id) ?? 0;
        const ordered = onOrderOf(item.id);
        return {
          itemId: item.id,
          name: item.name,
          unit: item.unit,
          supplierId: item.supplierId,
          supplierName:
            suppliers.find((supplier) => supplier.id === item.supplierId)?.name ?? item.supplierId,
          onHand: held,
          onOrder: ordered,
          reorderPoint: item.reorderPoint,
          reorderQuantity: item.reorderQuantity,
          needsReorder: held + ordered <= item.reorderPoint,
        };
      });
    },

    async listSuppliers(): Promise<readonly SupplierRecord[]> {
      return suppliers.map(record);
    },

    async compareSuppliers(itemId: string): Promise<SupplierComparison> {
      const item = findItem(itemId);
      const lines: OfferLine[] = offers
        .filter((offer) => offer.itemId === item.id)
        .map((offer) => {
          const supplier = findSupplier(offer.supplierId);
          return {
            supplierId: supplier.id,
            supplierName: supplier.name,
            approved: supplier.approved,
            usual: supplier.id === item.supplierId,
            unitCostCents: offer.unitCostCents,
            leadTimeDays: supplier.leadTimeDays,
          };
        })
        .sort((left, right) => left.unitCostCents - right.unitCostCents);
      return { itemId: item.id, name: item.name, unit: item.unit, offers: lines };
    },

    async listPurchaseOrders(filter: OrderFilter = {}): Promise<readonly PurchaseOrder[]> {
      const supplier = filter.supplier?.trim().toLowerCase();
      return orders
        .filter(
          (order) =>
            filter.id === undefined || order.id.toLowerCase() === filter.id.trim().toLowerCase(),
        )
        .filter(
          (order) =>
            supplier === undefined ||
            supplier === "" ||
            order.supplierId.toLowerCase() === supplier ||
            order.supplierName.toLowerCase().includes(supplier),
        )
        .filter((order) => filter.status === undefined || order.status === filter.status)
        .map(snapshot);
    },

    async raisePurchaseOrder(input, { requestId }): Promise<PurchaseOrder> {
      const prior = raised.get(requestId);
      if (prior instanceof PurchasingDeskError) throw prior;
      if (prior !== undefined) return prior;

      const supplier = findSupplier(input.supplierId);
      if (!supplier.approved) {
        throw new PurchasingDeskError(
          "unapproved_supplier",
          `${supplier.name} (${supplier.id}) is on file but not on the company's approved supplier list, so nothing can be ordered from it. Adding it is a person's decision. Nothing was ordered.`,
        );
      }
      const lines = price(supplier, input.lines);
      const totalCents = lines.reduce((total, line) => total + line.lineTotalCents, 0);
      const today = isoDate(clock());
      const order: OrderState = {
        id: nextOrderId(),
        supplierId: supplier.id,
        supplierName: supplier.name,
        status: "draft",
        lines,
        totalCents,
        raisedOn: today,
        placedOn: null,
        expectedOn: null,
        approved: false,
      };

      // The limit applies to what goes to one supplier in one day, so an order cut into pieces that
      // each pass is still the order it was. Drafts are not counted: nothing in them has gone out.
      const placedToday = orders
        .filter((other) => other.supplierId === supplier.id && other.placedOn === today)
        .filter((other) => other.status !== "draft");
      const earlier = placedToday.reduce((total, other) => total + other.totalCents, 0);

      let refusal: PurchasingDeskError | undefined;
      if (totalCents > limit) {
        refusal = new PurchasingDeskError(
          "over_limit",
          `Needs approval: this order to ${supplier.name} comes to ${money(totalCents)}, over the ${money(limit)} a purchase order may reach without a person's approval. It is saved as draft ${order.id} and has not been sent; do not raise it again or split it. Nothing was ordered.`,
          { draftId: order.id, totalCents },
        );
      } else if (earlier + totalCents > limit) {
        refusal = new PurchasingDeskError(
          "split_order",
          `Needs approval: ${supplier.name} already has ${placedToday.map((other) => other.id).join(", ")} placed today for ${money(earlier)}; with this order (${money(totalCents)}) that is ${money(earlier + totalCents)}, over the ${money(limit)} a purchase order may reach without a person's approval. Orders are not split to stay under the limit. This one is saved as draft ${order.id} and has not been sent. Nothing was ordered.`,
          { draftId: order.id, totalCents },
        );
      }
      orders.push(order);
      if (refusal !== undefined) {
        raised.set(requestId, refusal);
        throw refusal;
      }
      place(order, supplier, false);
      const receipt = snapshot(order);
      raised.set(requestId, receipt);
      return receipt;
    },

    async placeDraft(input, { requestId }): Promise<PurchaseOrder> {
      const prior = placements.get(requestId);
      if (prior !== undefined) return prior;

      const order = findOrder(input.draftId);
      if (order.status !== "draft") {
        throw new PurchasingDeskError(
          "not_draft",
          `${order.id} is not a draft waiting for approval: it is ${order.status.replace("_", " ")}. An approval places one draft once; a new or changed order is raised with raise_purchase_order.`,
        );
      }
      // The person approved the draft as the gate read it; anything else is not what they approved.
      if (!sameFacts(input.approved, draftFacts(snapshot(order)))) {
        throw new PurchasingDeskError(
          "draft_changed",
          `${order.id} is not what the person approved: it changed after its facts were read. It now stands as ${order.lines.length} lines with ${order.supplierName} (${order.supplierId}), total ${money(order.totalCents)}. Nothing was placed.`,
          { draftId: order.id, totalCents: order.totalCents },
        );
      }
      const supplier = findSupplier(order.supplierId);
      if (!supplier.approved) {
        throw new PurchasingDeskError(
          "unapproved_supplier",
          `${supplier.name} is not on the approved supplier list, so ${order.id} cannot be placed until a person adds it.`,
        );
      }
      // The approval is for this draft as it was raised: its lines and total are the ones the
      // person was asked about, and nothing else rides on it.
      place(order, supplier, true);
      const placed = snapshot(order);
      placements.set(requestId, placed);
      return placed;
    },

    async addSupplier(input, { requestId }): Promise<SupplierApproval> {
      const prior = additions.get(requestId);
      if (prior !== undefined) return prior;

      const reason = input.reason.trim();
      if (reason === "") {
        throw new PurchasingDeskError(
          "invalid",
          "Say why the supplier should be added: what it supplies and why the approved ones will not do.",
        );
      }
      // Only a supplier on file can be approved: its record is what the person is shown.
      const supplier = findSupplier(input.supplierId);
      if (supplier.approved) {
        throw new PurchasingDeskError(
          "already_approved",
          `${supplier.name} is already on the approved supplier list: order from it with raise_purchase_order.`,
        );
      }
      if (!sameFacts(input.approved, supplierFacts(record(supplier)))) {
        throw new PurchasingDeskError(
          "supplier_changed",
          `${supplier.name} (${supplier.id}) is not what the person approved: its record changed after it was read. It now stands as ${supplier.category}, lead time ${supplier.leadTimeDays} days, contact ${supplier.contactEmail}. Nothing was added.`,
        );
      }
      supplier.approved = true;
      const approval: SupplierApproval = {
        supplierId: supplier.id,
        supplierName: supplier.name,
        approved: true,
        reason,
      };
      additions.set(requestId, approval);
      return approval;
    },

    async recordReceipt(input, { requestId }): Promise<GoodsReceipt> {
      const prior = receipts.get(requestId);
      if (prior !== undefined) return prior;

      const reportedBy = input.reportedBy.trim();
      const source = input.source.trim();
      if (reportedBy === "" || source === "") {
        throw new PurchasingDeskError(
          "invalid",
          "A receipt is recorded from a named person's report: give who reported the delivery (reportedBy) and the message the report came from (source). Nothing was recorded.",
        );
      }
      const order = findOrder(input.purchaseOrderId);
      if (order.status !== "placed" && order.status !== "partially_received") {
        throw new PurchasingDeskError(
          "not_placed",
          order.status === "draft"
            ? `${order.id} is a draft that has not been sent, so nothing can arrive against it.`
            : `${order.id} is already fully received. Check the purchase order number on the packing slip.`,
        );
      }
      if (input.lines.length === 0) {
        throw new PurchasingDeskError("invalid", "Say which items arrived and how many.");
      }
      // Every line is checked before any is recorded, so a refused receipt changes nothing.
      const seen = new Set<string>();
      const checked = input.lines.map((entry) => {
        if (seen.has(entry.itemId.trim())) {
          throw new PurchasingDeskError(
            "invalid",
            `${entry.itemId} is on the receipt twice: give each item once, with the whole quantity that arrived. Nothing was recorded.`,
          );
        }
        seen.add(entry.itemId.trim());
        const line = order.lines.find((candidate) => candidate.itemId === entry.itemId.trim());
        if (line === undefined) {
          throw new PurchasingDeskError(
            "not_on_order",
            `${entry.itemId} is not on ${order.id}, which orders ${order.lines.map((candidate) => candidate.itemId).join(", ")}. Nothing was recorded.`,
          );
        }
        wholeQuantity(entry.quantity, line.name);
        const outstanding = line.quantity - line.receivedQuantity;
        if (entry.quantity > outstanding) {
          throw new PurchasingDeskError(
            "over_received",
            `${order.id} has ${outstanding} ${line.unit} of ${line.name} still to come, so ${entry.quantity} is more than was ordered. Record at most ${outstanding}; the extra is for the person who decides purchasing to take up with ${order.supplierName}. Nothing was recorded.`,
          );
        }
        return { line, quantity: entry.quantity };
      });
      for (const { line, quantity } of checked) {
        line.receivedQuantity += quantity;
        onHand.set(line.itemId, (onHand.get(line.itemId) ?? 0) + quantity);
      }
      order.status = order.lines.every((line) => line.receivedQuantity === line.quantity)
        ? "received"
        : "partially_received";
      receiptNumber += 1;
      const receipt: GoodsReceipt = {
        id: `GR-${receiptNumber}`,
        purchaseOrderId: order.id,
        supplierName: order.supplierName,
        lines: checked.map(({ line, quantity }) => ({
          itemId: line.itemId,
          name: line.name,
          unit: line.unit,
          quantity,
          outstanding: line.quantity - line.receivedQuantity,
        })),
        reportedBy,
        source,
        packingSlip: input.packingSlip?.trim() || null,
        at: clock().toISOString(),
        orderStatus: order.status,
      };
      receipts.set(requestId, receipt);
      return receipt;
    },
  };
}
