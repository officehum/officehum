/**
 * The demonstration desk's limits, each one enforced in code: unit costs and totals looked up and
 * worked out here, the spending limit, the approved-supplier list, a split order, an approval that
 * places only the draft it was asked for, and receipts checked against the order. Every write is
 * replayed under the same request id and must happen once.
 */

import { describe, expect, it } from "vitest";
import { loadCompanyFacts } from "./company.js";
import { DEMO_NOW, fakePurchasingDesk, type PurchasingDesk, PurchasingDeskError } from "./desk.js";

const company = loadCompanyFacts();
const LIMIT = company.approvalLimits.purchaseOrderOverCents;

const desk = (now = DEMO_NOW): PurchasingDesk => fakePurchasingDesk({ now: () => new Date(now) });

/** The order the paper goods need at their reorder quantities: over the limit on its own. */
const CASCADE_RESTOCK = {
  supplierId: "sup-cascade-paper",
  lines: [
    { itemId: "toilet-tissue", quantity: 16 },
    { itemId: "hand-towel", quantity: 12 },
    { itemId: "trash-liners", quantity: 20 },
  ],
};

/** What a person is asked to approve for that order: the draft, its supplier and the desk's total. */
const GRANT = { draftId: "PO-1004", supplierId: "sup-cascade-paper", totalCents: 217200 };

const PACIFIC_RESTOCK = {
  supplierId: "sup-pacific-janitorial",
  lines: [
    { itemId: "disinfectant", quantity: 12 },
    { itemId: "nitrile-gloves", quantity: 5 },
  ],
};

async function refusal(promise: Promise<unknown>): Promise<PurchasingDeskError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PurchasingDeskError) return error;
    throw error;
  }
  throw new Error("expected the desk to refuse");
}

describe("fakePurchasingDesk: stock", () => {
  it("flags reorders in code: on hand plus on order at or below the reorder point", async () => {
    const stock = await desk().listStock();
    const byId = (id: string) => stock.find((line) => line.itemId === id);
    expect(stock.map((line) => line.itemId)).toEqual(company.supplyCatalog.map((item) => item.id));
    expect(byId("disinfectant")).toMatchObject({ onHand: 4, onOrder: 0, needsReorder: true });
    expect(byId("hvac-filter-stock")).toMatchObject({
      onHand: 2,
      reorderPoint: 2,
      needsReorder: true,
    });
    // Floor pads are low on the shelf, but six are on order, so they are not reordered twice.
    expect(byId("floor-pad")).toMatchObject({ onHand: 1, onOrder: 6, needsReorder: false });
    expect(byId("neutral-cleaner")?.needsReorder).toBe(false);
    expect(stock.filter((line) => line.needsReorder).map((line) => line.itemId)).toEqual([
      "disinfectant",
      "nitrile-gloves",
      "toilet-tissue",
      "hand-towel",
      "trash-liners",
      "hvac-filter-stock",
    ]);
  });

  it("takes every reorder point and quantity from the company catalogue", async () => {
    for (const line of await desk().listStock()) {
      const item = company.supplyCatalog.find((candidate) => candidate.id === line.itemId);
      expect(line.reorderPoint).toBe(item?.reorderPoint);
      expect(line.reorderQuantity).toBe(item?.reorderQuantity);
    }
  });
});

describe("fakePurchasingDesk: suppliers", () => {
  it("lists every supplier on file with its approval from the company data", async () => {
    const suppliers = await desk().listSuppliers();
    expect(suppliers.map((supplier) => [supplier.id, supplier.approved])).toEqual(
      company.suppliers.map((supplier) => [supplier.id, supplier.approved]),
    );
    expect(suppliers.find((supplier) => supplier.id === "sup-cascade-paper")?.items).toContain(
      "trash-liners",
    );
  });

  it("compares an item's suppliers on unit cost and lead time from data, cheapest first", async () => {
    const comparison = await desk().compareSuppliers("nitrile-gloves");
    expect(comparison.offers.map((offer) => [offer.supplierId, offer.unitCostCents])).toEqual([
      ["sup-quickship-safety", 5900],
      ["sup-pacific-janitorial", 6800],
    ]);
    expect(comparison.offers[0]).toMatchObject({ approved: false, leadTimeDays: 2 });
    expect(comparison.offers[1]).toMatchObject({ approved: true, leadTimeDays: 3, usual: true });
    expect((await refusal(desk().compareSuppliers("caviar"))).code).toBe("not_found");
  });
});

describe("fakePurchasingDesk: raising a purchase order", () => {
  it("prices every line from data and places an order inside the limit", async () => {
    const purchasing = desk();
    const order = await purchasing.raisePurchaseOrder(PACIFIC_RESTOCK, { requestId: "r1" });
    expect(order).toMatchObject({
      id: "PO-1004",
      status: "placed",
      supplierName: "Pacific Janitorial Supply",
      totalCents: 12 * 2400 + 5 * 6800,
      placedOn: "2026-11-09",
      expectedOn: "2026-11-12",
    });
    expect(order.lines.map((line) => line.lineTotalCents)).toEqual([28800, 34000]);
    const stock = await purchasing.listStock();
    expect(stock.find((line) => line.itemId === "disinfectant")).toMatchObject({
      onOrder: 12,
      needsReorder: false,
    });
  });

  it("refuses over the limit and saves the order as a draft, with the total it worked out", async () => {
    const purchasing = desk();
    const refused = await refusal(
      purchasing.raisePurchaseOrder(CASCADE_RESTOCK, { requestId: "r2" }),
    );
    expect(refused.code).toBe("over_limit");
    expect(refused.draftId).toBe("PO-1004");
    expect(refused.totalCents).toBe(217200);
    expect(refused.totalCents).toBeGreaterThan(LIMIT);
    expect(refused.message).toContain("$2,172.00");
    const [draft] = await purchasing.listPurchaseOrders({ id: "PO-1004" });
    expect(draft).toMatchObject({ status: "draft", placedOn: null, totalCents: 217200 });
    expect(
      (await purchasing.listStock()).find((line) => line.itemId === "hand-towel")?.onOrder,
    ).toBe(0);
  });

  it("refuses a supplier that is not on the approved list, and saves nothing", async () => {
    const purchasing = desk();
    const refused = await refusal(
      purchasing.raisePurchaseOrder(
        { supplierId: "sup-quickship-safety", lines: [{ itemId: "nitrile-gloves", quantity: 5 }] },
        { requestId: "r3" },
      ),
    );
    expect(refused.code).toBe("unapproved_supplier");
    expect(refused.draftId).toBeUndefined();
    expect(await purchasing.listPurchaseOrders()).toHaveLength(3);
  });

  it("refuses an unknown supplier, an item the supplier does not offer, and a quantity that is not whole", async () => {
    const purchasing = desk();
    const unknown = await refusal(
      purchasing.raisePurchaseOrder(
        { supplierId: "sup-evergreen", lines: [{ itemId: "nitrile-gloves", quantity: 1 }] },
        { requestId: "r4" },
      ),
    );
    expect(unknown.code).toBe("not_found");
    const notOffered = await refusal(
      purchasing.raisePurchaseOrder(
        { supplierId: "sup-cascade-paper", lines: [{ itemId: "floor-finish", quantity: 1 }] },
        { requestId: "r5" },
      ),
    );
    expect(notOffered.code).toBe("not_offered");
    for (const quantity of [0, -2, 1.5]) {
      const bad = await refusal(
        purchasing.raisePurchaseOrder(
          { supplierId: "sup-cascade-paper", lines: [{ itemId: "hand-soap", quantity }] },
          { requestId: `r6-${quantity}` },
        ),
      );
      expect(bad.code).toBe("invalid");
    }
    const empty = await refusal(
      purchasing.raisePurchaseOrder(
        { supplierId: "sup-cascade-paper", lines: [] },
        { requestId: "r7" },
      ),
    );
    expect(empty.code).toBe("invalid");
  });

  it("refuses an order split to stay under the limit: same supplier, same day, combined total over it", async () => {
    const purchasing = desk();
    const first = await purchasing.raisePurchaseOrder(
      {
        supplierId: "sup-cascade-paper",
        lines: [
          { itemId: "toilet-tissue", quantity: 16 },
          { itemId: "hand-towel", quantity: 12 },
        ],
      },
      { requestId: "s1" },
    );
    expect(first.totalCents).toBe(145200);
    expect(first.totalCents).toBeLessThanOrEqual(LIMIT);
    const refused = await refusal(
      purchasing.raisePurchaseOrder(
        { supplierId: "sup-cascade-paper", lines: [{ itemId: "trash-liners", quantity: 20 }] },
        { requestId: "s2" },
      ),
    );
    expect(refused.code).toBe("split_order");
    expect(refused.draftId).toBe("PO-1005");
    expect(refused.message).toContain("$2,172.00");

    // Another supplier the same day is a separate order.
    await purchasing.raisePurchaseOrder(PACIFIC_RESTOCK, { requestId: "s3" });

    // The same supplier the next day is a separate order too: $1,452.00 placed on Monday and $720.00
    // on Tuesday would be over the limit if the day were not counted.
    let now = DEMO_NOW;
    const week = fakePurchasingDesk({ now: () => new Date(now) });
    await week.raisePurchaseOrder(
      {
        supplierId: "sup-cascade-paper",
        lines: [
          { itemId: "toilet-tissue", quantity: 16 },
          { itemId: "hand-towel", quantity: 12 },
        ],
      },
      { requestId: "t1" },
    );
    now = "2026-11-10T16:00:00.000Z";
    const next = await week.raisePurchaseOrder(
      { supplierId: "sup-cascade-paper", lines: [{ itemId: "trash-liners", quantity: 20 }] },
      { requestId: "t2" },
    );
    expect(next.status).toBe("placed");
  });

  it("places one order however many times the same call is replayed, and keeps one draft for a replayed refusal", async () => {
    const purchasing = desk();
    const first = await purchasing.raisePurchaseOrder(PACIFIC_RESTOCK, { requestId: "same" });
    const again = await purchasing.raisePurchaseOrder(PACIFIC_RESTOCK, { requestId: "same" });
    expect(again).toEqual(first);
    const refusedOnce = await refusal(
      purchasing.raisePurchaseOrder(CASCADE_RESTOCK, { requestId: "over" }),
    );
    const refusedAgain = await refusal(
      purchasing.raisePurchaseOrder(CASCADE_RESTOCK, { requestId: "over" }),
    );
    expect(refusedAgain.draftId).toBe(refusedOnce.draftId);
    expect(await purchasing.listPurchaseOrders()).toHaveLength(5);
  });
});

describe("fakePurchasingDesk: approving a draft", () => {
  it("places exactly the draft it was asked for, once", async () => {
    const purchasing = desk();
    const refused = await refusal(
      purchasing.raisePurchaseOrder(CASCADE_RESTOCK, { requestId: "a1" }),
    );
    const placed = await purchasing.placeDraft(GRANT, { requestId: "a2" });
    expect(placed).toMatchObject({
      id: refused.draftId,
      status: "placed",
      totalCents: 217200,
      placedOn: "2026-11-09",
      expectedOn: "2026-11-13",
      approved: true,
    });
    const replayed = await purchasing.placeDraft(GRANT, { requestId: "a2" });
    expect(replayed).toEqual(placed);
    // A second request for the same draft is not a second order.
    const twice = await refusal(purchasing.placeDraft(GRANT, { requestId: "a3" }));
    expect(twice.code).toBe("not_draft");
  });

  it("does not let an approval cover a changed order: a changed order is a new draft that needs its own", async () => {
    const purchasing = desk();
    await refusal(purchasing.raisePurchaseOrder(CASCADE_RESTOCK, { requestId: "b1" }));
    await purchasing.placeDraft(GRANT, { requestId: "b2" });
    const changed = await refusal(
      purchasing.raisePurchaseOrder(
        {
          supplierId: "sup-cascade-paper",
          lines: [
            { itemId: "toilet-tissue", quantity: 20 },
            { itemId: "hand-towel", quantity: 12 },
            { itemId: "trash-liners", quantity: 20 },
          ],
        },
        { requestId: "b3" },
      ),
    );
    expect(changed.code).toBe("over_limit");
    expect(changed.draftId).toBe("PO-1005");
    const [draft] = await purchasing.listPurchaseOrders({ id: "PO-1005" });
    expect(draft?.status).toBe("draft");
  });

  it("places nothing when the supplier or total asked about is not the draft's: the grant is for what was shown", async () => {
    const purchasing = desk();
    await refusal(purchasing.raisePurchaseOrder(CASCADE_RESTOCK, { requestId: "d1" }));
    for (const [grant, requestId] of [
      [{ ...GRANT, totalCents: 145200 }, "d2"],
      [{ ...GRANT, supplierId: "sup-pacific-janitorial" }, "d3"],
    ] as const) {
      const refused = await refusal(purchasing.placeDraft(grant, { requestId }));
      expect(refused.code).toBe("draft_changed");
      expect(refused.message).toContain("$2,172.00");
    }
    const [draft] = await purchasing.listPurchaseOrders({ id: "PO-1004" });
    expect(draft?.status).toBe("draft");
  });

  it("refuses an order that is not a draft, and one that does not exist", async () => {
    const purchasing = desk();
    expect(
      (await refusal(purchasing.placeDraft({ ...GRANT, draftId: "PO-1001" }, { requestId: "c1" })))
        .code,
    ).toBe("not_draft");
    expect(
      (await refusal(purchasing.placeDraft({ ...GRANT, draftId: "PO-9" }, { requestId: "c2" })))
        .code,
    ).toBe("not_found");
  });
});

describe("fakePurchasingDesk: adding a supplier", () => {
  it("approves a supplier on file, after which it can be ordered from", async () => {
    const purchasing = desk();
    const added = await purchasing.addSupplier(
      { supplier: "sup-quickship-safety", reason: "Cheaper gloves, two-day lead time" },
      { requestId: "n1" },
    );
    expect(added).toMatchObject({ supplierId: "sup-quickship-safety", approved: true });
    const order = await purchasing.raisePurchaseOrder(
      { supplierId: "sup-quickship-safety", lines: [{ itemId: "nitrile-gloves", quantity: 5 }] },
      { requestId: "n2" },
    );
    expect(order.totalCents).toBe(5 * 5900);
  });

  it("adds a supplier that is not on file by name, with no items until someone sets up its prices", async () => {
    const purchasing = desk();
    const added = await purchasing.addSupplier(
      { supplier: "Evergreen Supply Co.", reason: "Local stockist" },
      { requestId: "n3" },
    );
    expect(added.supplierName).toBe("Evergreen Supply Co.");
    const listed = (await purchasing.listSuppliers()).find(
      (supplier) => supplier.id === added.supplierId,
    );
    expect(listed).toMatchObject({ approved: true, items: [] });
  });

  it("refuses an approved supplier, an empty reason, and replays without adding twice", async () => {
    const purchasing = desk();
    expect(
      (
        await refusal(
          purchasing.addSupplier(
            { supplier: "sup-cascade-paper", reason: "x" },
            { requestId: "n4" },
          ),
        )
      ).code,
    ).toBe("already_approved");
    expect(
      (
        await refusal(
          purchasing.addSupplier(
            { supplier: "sup-quickship-safety", reason: " " },
            { requestId: "n5" },
          ),
        )
      ).code,
    ).toBe("invalid");
    const input = { supplier: "Evergreen Supply Co.", reason: "Local stockist" };
    const first = await purchasing.addSupplier(input, { requestId: "n6" });
    const again = await purchasing.addSupplier(input, { requestId: "n6" });
    expect(again).toEqual(first);
    expect(await purchasing.listSuppliers()).toHaveLength(company.suppliers.length + 1);
  });
});

describe("fakePurchasingDesk: receiving goods", () => {
  const REPORT = { reportedBy: "Dev Patel", source: "chat message, 9 November, 08:10" };

  it("records a partial delivery against the order's lines, with who reported it", async () => {
    const purchasing = desk();
    const receipt = await purchasing.recordReceipt(
      { purchaseOrderId: "PO-1003", lines: [{ itemId: "glass-cleaner", quantity: 10 }], ...REPORT },
      { requestId: "g1" },
    );
    expect(receipt).toMatchObject({
      id: "GR-1",
      purchaseOrderId: "PO-1003",
      reportedBy: "Dev Patel",
      source: REPORT.source,
      orderStatus: "partially_received",
    });
    expect(receipt.lines).toEqual([
      {
        itemId: "glass-cleaner",
        name: "Glass cleaner",
        unit: "gallon",
        quantity: 10,
        outstanding: 2,
      },
    ]);
    const stock = await purchasing.listStock();
    expect(stock.find((line) => line.itemId === "glass-cleaner")).toMatchObject({
      onHand: 13,
      onOrder: 2,
    });
    const rest = await purchasing.recordReceipt(
      { purchaseOrderId: "PO-1003", lines: [{ itemId: "glass-cleaner", quantity: 2 }], ...REPORT },
      { requestId: "g2" },
    );
    expect(rest.orderStatus).toBe("received");
  });

  it("refuses more than is outstanding, an item not on the order, and an order not placed", async () => {
    const purchasing = desk();
    const over = await refusal(
      purchasing.recordReceipt(
        {
          purchaseOrderId: "PO-1003",
          lines: [{ itemId: "glass-cleaner", quantity: 13 }],
          ...REPORT,
        },
        { requestId: "g3" },
      ),
    );
    expect(over.code).toBe("over_received");
    expect(over.message).toContain("12");
    const elsewhere = await refusal(
      purchasing.recordReceipt(
        { purchaseOrderId: "PO-1003", lines: [{ itemId: "disinfectant", quantity: 1 }], ...REPORT },
        { requestId: "g4" },
      ),
    );
    expect(elsewhere.code).toBe("not_on_order");
    const received = await refusal(
      purchasing.recordReceipt(
        { purchaseOrderId: "PO-1002", lines: [{ itemId: "mop-head", quantity: 1 }], ...REPORT },
        { requestId: "g5" },
      ),
    );
    expect(received.code).toBe("not_placed");
    await refusal(purchasing.raisePurchaseOrder(CASCADE_RESTOCK, { requestId: "g6" }));
    const draft = await refusal(
      purchasing.recordReceipt(
        { purchaseOrderId: "PO-1004", lines: [{ itemId: "hand-towel", quantity: 1 }], ...REPORT },
        { requestId: "g7" },
      ),
    );
    expect(draft.code).toBe("not_placed");
  });

  it("records nothing without a named person and the message the report came from", async () => {
    const purchasing = desk();
    for (const report of [
      { reportedBy: "", source: REPORT.source },
      { reportedBy: "  ", source: REPORT.source },
      { reportedBy: "Dev Patel", source: "" },
    ]) {
      const refused = await refusal(
        purchasing.recordReceipt(
          {
            purchaseOrderId: "PO-1003",
            lines: [{ itemId: "glass-cleaner", quantity: 1 }],
            ...report,
          },
          { requestId: `g8-${report.reportedBy}-${report.source}` },
        ),
      );
      expect(refused.code).toBe("invalid");
    }
    const [order] = await purchasing.listPurchaseOrders({ id: "PO-1003" });
    expect(order?.lines[0]?.receivedQuantity).toBe(0);
  });

  it("counts a replayed receipt once", async () => {
    const purchasing = desk();
    const input = {
      purchaseOrderId: "PO-1001",
      lines: [{ itemId: "floor-pad", quantity: 6 }],
      ...REPORT,
    };
    const first = await purchasing.recordReceipt(input, { requestId: "same" });
    const again = await purchasing.recordReceipt(input, { requestId: "same" });
    expect(again).toEqual(first);
    const stock = await purchasing.listStock();
    expect(stock.find((line) => line.itemId === "floor-pad")).toMatchObject({
      onHand: 7,
      onOrder: 0,
    });
  });
});

describe("fakePurchasingDesk: orders", () => {
  it("lists the demonstration orders, by number or supplier, consistent with the catalogue", async () => {
    const purchasing = desk();
    const orders = await purchasing.listPurchaseOrders();
    expect(orders.map((order) => [order.id, order.status])).toEqual([
      ["PO-1001", "placed"],
      ["PO-1002", "received"],
      ["PO-1003", "placed"],
    ]);
    for (const order of orders) {
      for (const line of order.lines) {
        const item = company.supplyCatalog.find((candidate) => candidate.id === line.itemId);
        expect(item?.supplierId).toBe(order.supplierId);
        expect(line.unitCostCents).toBe(item?.unitCostCents);
        expect(line.lineTotalCents).toBe(line.quantity * line.unitCostCents);
      }
      expect(order.totalCents).toBe(
        order.lines.reduce((sum, line) => sum + line.lineTotalCents, 0),
      );
      expect(order.totalCents).toBeLessThanOrEqual(LIMIT);
    }
    expect(
      (await purchasing.listPurchaseOrders({ supplier: "Columbia" })).map((o) => o.id),
    ).toEqual(["PO-1001"]);
  });
});
