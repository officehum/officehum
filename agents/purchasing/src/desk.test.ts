/**
 * The demonstration desk's limits, each one enforced in code: unit costs and totals looked up and
 * worked out here, the spending limit, the approved-supplier list, a split order, an approval that
 * places only the draft it was asked for, and receipts checked against the order. Every write is
 * replayed under the same request id and must happen once.
 */

import { addDays } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { loadCompanyFacts } from "./company.js";
import {
  DEMO_NOW,
  draftFacts,
  fakePurchasingDesk,
  type PurchasingDesk,
  PurchasingDeskError,
  supplierFacts,
} from "./desk.js";

const company = loadCompanyFacts();
/** The manifest's default: the limit a role with no overlay hands the desk at every call. */
const LIMIT = 150_000;
/** The options a raise carries: the call's identity and the limit the role resolved for it. */
const call = (requestId: string) => ({ requestId, purchaseOrderLimitCents: LIMIT });

/** An order a person on the company record asked for, as the tool passes the verified sender. */
const ASKED = {
  reason: "request" as const,
  requestedBy: "Priya Raman",
  requestSource: "chat message from Priya Raman, Monday 9 November",
};

const desk = (now = DEMO_NOW): PurchasingDesk => fakePurchasingDesk({ now: () => new Date(now) });

/** The order the paper goods need at their reorder quantities: over the limit on its own. */
const CASCADE_RESTOCK = {
  reason: "reorder_point" as const,
  supplierId: "sup-cascade-paper",
  lines: [
    { itemId: "toilet-tissue", quantity: 16 },
    { itemId: "hand-towel", quantity: 12 },
    { itemId: "trash-liners", quantity: 20 },
  ],
};

/**
 * A placement of one draft, carrying the facts a person approved as the desk held them then. The
 * demonstration desk holds the Cascade restock as draft PO-1004, refused for the limit this morning.
 */
async function approvedDraft(purchasing: PurchasingDesk, draftId = "PO-1004") {
  const [order] = await purchasing.listPurchaseOrders({ id: draftId });
  if (order === undefined) throw new Error(`no ${draftId} on the desk`);
  return { draftId, approved: draftFacts(order) };
}

/** An addition of one supplier, carrying its record as a person approved it. */
async function approvedSupplier(purchasing: PurchasingDesk, supplierId: string, reason: string) {
  const record = (await purchasing.listSuppliers()).find((supplier) => supplier.id === supplierId);
  if (record === undefined) throw new Error(`no ${supplierId} on file`);
  return { supplierId, reason, approved: supplierFacts(record) };
}

const PACIFIC_RESTOCK = {
  reason: "reorder_point" as const,
  supplierId: "sup-pacific-janitorial",
  lines: [
    { itemId: "disinfectant", quantity: 12 },
    { itemId: "nitrile-gloves", quantity: 5 },
  ],
};

async function statusOf(purchasing: PurchasingDesk, id: string): Promise<string | undefined> {
  return (await purchasing.listPurchaseOrders({ id }))[0]?.status;
}

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

describe("fakePurchasingDesk: an order with no limit resolved", () => {
  it("is held for a person, never placed as if there were no limit", async () => {
    const purchasing = desk();
    const error = (await purchasing
      .raisePurchaseOrder(
        {
          reason: "reorder_point",
          supplierId: "sup-willamette-filters",
          lines: [{ itemId: "hvac-filter-stock", quantity: 1 }],
        },
        // Written out: `call`'s default would fill the limit in.
        { requestId: "no-limit", purchaseOrderLimitCents: undefined },
      )
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      )) as PurchasingDeskError | undefined;
    expect(error).toBeInstanceOf(PurchasingDeskError);
    expect(error?.code).toBe("over_limit");
    expect(error?.message).toContain("no purchase order limit is set");
    const [saved] = await purchasing.listPurchaseOrders({ id: error?.draftId ?? "" });
    expect(saved?.status).toBe("draft");
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
    const order = await purchasing.raisePurchaseOrder(PACIFIC_RESTOCK, call("r1"));
    expect(order).toMatchObject({
      id: "PO-1005",
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
    const refused = await refusal(purchasing.raisePurchaseOrder(CASCADE_RESTOCK, call("r2")));
    expect(refused.code).toBe("over_limit");
    expect(refused.draftId).toBe("PO-1005");
    expect(refused.totalCents).toBe(217200);
    expect(refused.totalCents).toBeGreaterThan(LIMIT);
    expect(refused.message).toContain("$2,172.00");
    const [draft] = await purchasing.listPurchaseOrders({ id: "PO-1005" });
    expect(draft).toMatchObject({ status: "draft", placedOn: null, totalCents: 217200 });
    expect(
      (await purchasing.listStock()).find((line) => line.itemId === "hand-towel")?.onOrder,
    ).toBe(0);
  });

  it("refuses a supplier that is not on the approved list, and saves nothing", async () => {
    const purchasing = desk();
    const refused = await refusal(
      purchasing.raisePurchaseOrder(
        {
          ...ASKED,
          supplierId: "sup-quickship-safety",
          lines: [{ itemId: "nitrile-gloves", quantity: 5 }],
        },
        call("r3"),
      ),
    );
    expect(refused.code).toBe("unapproved_supplier");
    expect(refused.draftId).toBeUndefined();
    expect(await purchasing.listPurchaseOrders()).toHaveLength(4);
  });

  it("refuses an unknown supplier, an item the supplier does not offer, and a quantity that is not whole", async () => {
    const purchasing = desk();
    const unknown = await refusal(
      purchasing.raisePurchaseOrder(
        {
          ...ASKED,
          supplierId: "sup-evergreen",
          lines: [{ itemId: "nitrile-gloves", quantity: 1 }],
        },
        call("r4"),
      ),
    );
    expect(unknown.code).toBe("not_found");
    const notOffered = await refusal(
      purchasing.raisePurchaseOrder(
        {
          ...ASKED,
          supplierId: "sup-cascade-paper",
          lines: [{ itemId: "floor-finish", quantity: 1 }],
        },
        call("r5"),
      ),
    );
    expect(notOffered.code).toBe("not_offered");
    for (const quantity of [0, -2, 1.5]) {
      const bad = await refusal(
        purchasing.raisePurchaseOrder(
          { ...ASKED, supplierId: "sup-cascade-paper", lines: [{ itemId: "hand-soap", quantity }] },
          call(`r6-${quantity}`),
        ),
      );
      expect(bad.code).toBe("invalid");
    }
    const empty = await refusal(
      purchasing.raisePurchaseOrder(
        { ...ASKED, supplierId: "sup-cascade-paper", lines: [] },
        call("r7"),
      ),
    );
    expect(empty.code).toBe("invalid");
  });

  it("refuses an order split to stay under the limit: same supplier, same day, combined total over it", async () => {
    const purchasing = desk();
    const first = await purchasing.raisePurchaseOrder(
      {
        ...ASKED,
        supplierId: "sup-cascade-paper",
        lines: [
          { itemId: "toilet-tissue", quantity: 16 },
          { itemId: "hand-towel", quantity: 12 },
        ],
      },
      call("s1"),
    );
    expect(first.totalCents).toBe(145200);
    expect(first.totalCents).toBeLessThanOrEqual(LIMIT);
    const refused = await refusal(
      purchasing.raisePurchaseOrder(
        {
          ...ASKED,
          supplierId: "sup-cascade-paper",
          lines: [{ itemId: "trash-liners", quantity: 20 }],
        },
        call("s2"),
      ),
    );
    expect(refused.code).toBe("split_order");
    expect(refused.draftId).toBe("PO-1006");
    expect(refused.message).toContain("$2,172.00");

    // Another supplier the same day is a separate order.
    await purchasing.raisePurchaseOrder(PACIFIC_RESTOCK, call("s3"));

    // The same supplier the next day is a separate order too: $1,452.00 placed on Monday and $720.00
    // on Tuesday would be over the limit if the day were not counted.
    let now = DEMO_NOW;
    const week = fakePurchasingDesk({ now: () => new Date(now) });
    await week.raisePurchaseOrder(
      {
        ...ASKED,
        supplierId: "sup-cascade-paper",
        lines: [
          { itemId: "toilet-tissue", quantity: 16 },
          { itemId: "hand-towel", quantity: 12 },
        ],
      },
      call("t1"),
    );
    now = "2026-11-10T16:00:00.000Z";
    const next = await week.raisePurchaseOrder(
      {
        ...ASKED,
        supplierId: "sup-cascade-paper",
        lines: [{ itemId: "trash-liners", quantity: 20 }],
      },
      call("t2"),
    );
    expect(next.status).toBe("placed");
  });

  it("a refused split recalls the earlier same-day order", async () => {
    const purchasing = desk();
    const first = await purchasing.raisePurchaseOrder(
      {
        ...ASKED,
        supplierId: "sup-cascade-paper",
        lines: [
          { itemId: "toilet-tissue", quantity: 16 },
          { itemId: "hand-towel", quantity: 12 },
        ],
      },
      call("s1"),
    );
    expect(first.status).toBe("placed");
    const refused = await refusal(
      purchasing.raisePurchaseOrder(
        {
          ...ASKED,
          supplierId: "sup-cascade-paper",
          lines: [
            { itemId: "hand-towel", quantity: 2 },
            { itemId: "trash-liners", quantity: 20 },
          ],
        },
        call("s2"),
      ),
    );
    expect(refused.code).toBe("split_order");
    expect(refused.draftId).toBe("PO-1006");
    expect(refused.message).toContain("PO-1005");
    expect(refused.message).toContain("recalled into PO-1006");
    // The draft is now the whole order: the recalled lines merged with the refused ones.
    expect(refused.totalCents).toBe(145200 + 2 * 4900 + 72000);
    const [draft] = await purchasing.listPurchaseOrders({ id: "PO-1006" });
    expect(draft).toMatchObject({ status: "draft", totalCents: 145200 + 2 * 4900 + 72000 });
    expect(draft?.lines.map((line) => [line.itemId, line.quantity])).toEqual([
      ["hand-towel", 14],
      ["trash-liners", 20],
      ["toilet-tissue", 16],
    ]);
    // The first part is no longer out: a draft, noted where it went, and nothing of it on order.
    const [recalled] = await purchasing.listPurchaseOrders({ id: "PO-1005" });
    expect(recalled).toMatchObject({
      status: "draft",
      recalledInto: "PO-1006",
      placedOn: null,
      expectedOn: null,
    });
    const tissue = (await purchasing.listStock()).find((line) => line.itemId === "toilet-tissue");
    expect(tissue?.onOrder).toBe(0);
    // A received or part-received order has gone out for good and is never recalled.
    const pacific = desk();
    await pacific.raisePurchaseOrder(
      {
        ...ASKED,
        supplierId: "sup-pacific-janitorial",
        lines: [{ itemId: "disinfectant", quantity: 50 }],
      },
      call("p1"),
    );
    await pacific.recordReceipt(
      {
        purchaseOrderId: "PO-1005",
        lines: [{ itemId: "disinfectant", quantity: 1 }],
        reportedBy: "Priya Raman",
        source: "chat",
      },
      { requestId: "p2" },
    );
    const second = await refusal(
      pacific.raisePurchaseOrder(
        {
          ...ASKED,
          supplierId: "sup-pacific-janitorial",
          lines: [{ itemId: "nitrile-gloves", quantity: 5 }],
        },
        call("p3"),
      ),
    );
    expect(second.code).toBe("split_order");
    expect(await statusOf(pacific, "PO-1005")).toBe("partially_received");
    expect((await pacific.listPurchaseOrders({ id: "PO-1006" }))[0]?.totalCents).toBe(5 * 6800);
  });

  it("a refused split never recalls an approved order", async () => {
    // The reviewer's reproduction: a person approves and places PO-1004 ($2,172.00 to Cascade), then a
    // $54 Cascade order the same day. The day is over the limit, so the small order goes to a person,
    // but the order a person approved stays placed: a routine call never undoes their decision.
    const purchasing = desk();
    const placed = await purchasing.placeDraft(await approvedDraft(purchasing), {
      requestId: "a1",
    });
    expect(placed).toMatchObject({ id: "PO-1004", status: "placed", approved: true });
    const refused = await refusal(
      purchasing.raisePurchaseOrder(
        {
          ...ASKED,
          supplierId: "sup-cascade-paper",
          lines: [{ itemId: "toilet-tissue", quantity: 1 }],
        },
        call("s1"),
      ),
    );
    expect(refused.code).toBe("split_order");
    expect(refused.draftId).toBe("PO-1005");
    expect(refused.totalCents).toBe(5400);
    expect(refused.message).toContain(
      "PO-1004 was placed with a person's approval and stays placed",
    );
    expect(refused.message).not.toContain("recalled");
    const [approved] = await purchasing.listPurchaseOrders({ id: "PO-1004" });
    expect(approved).toMatchObject({ status: "placed", approved: true });
    expect(approved?.recalledInto).toBeUndefined();
    const [draft] = await purchasing.listPurchaseOrders({ id: "PO-1005" });
    expect(draft?.lines.map((line) => [line.itemId, line.quantity])).toEqual([
      ["toilet-tissue", 1],
    ]);
  });

  it("a refused split recalls only the unapproved part when an approved order is also out", async () => {
    const purchasing = desk();
    // A small order placed inside the limit, then the PO-1004 draft placed with a person's approval.
    const small = await purchasing.raisePurchaseOrder(
      { ...ASKED, supplierId: "sup-cascade-paper", lines: [{ itemId: "hand-soap", quantity: 2 }] },
      call("w1"),
    );
    expect(small).toMatchObject({ id: "PO-1005", status: "placed", approved: false });
    await purchasing.placeDraft(await approvedDraft(purchasing), { requestId: "w2" });
    const refused = await refusal(
      purchasing.raisePurchaseOrder(
        {
          ...ASKED,
          supplierId: "sup-cascade-paper",
          lines: [{ itemId: "trash-liners", quantity: 1 }],
        },
        call("w3"),
      ),
    );
    expect(refused.code).toBe("split_order");
    expect(refused.message).toContain(
      "PO-1005, placed earlier today, has been recalled into PO-1006",
    );
    expect(refused.message).toContain(
      "PO-1004 was placed with a person's approval and stays placed",
    );
    expect(await statusOf(purchasing, "PO-1004")).toBe("placed");
    expect(await statusOf(purchasing, "PO-1005")).toBe("draft");
    expect((await purchasing.listPurchaseOrders({ id: "PO-1006" }))[0]?.totalCents).toBe(
      2 * 5200 + 3600,
    );
  });

  it("carries a recalled order's requester onto the draft", async () => {
    const purchasing = desk();
    await purchasing.raisePurchaseOrder(
      {
        reason: "request",
        requestedBy: "Sam Oduya",
        requestSource: "chat message from Sam Oduya, 08:10",
        supplierId: "sup-cascade-paper",
        lines: [
          { itemId: "toilet-tissue", quantity: 16 },
          { itemId: "hand-towel", quantity: 12 },
        ],
      },
      call("s1"),
    );
    await refusal(
      purchasing.raisePurchaseOrder(
        {
          ...ASKED,
          supplierId: "sup-cascade-paper",
          lines: [{ itemId: "trash-liners", quantity: 20 }],
        },
        call("s2"),
      ),
    );
    const [draft] = await purchasing.listPurchaseOrders({ id: "PO-1006" });
    expect(draft).toMatchObject({ requestedBy: ASKED.requestedBy });
    expect(draft?.recalled).toEqual([
      {
        id: "PO-1005",
        requestedBy: "Sam Oduya",
        requestSource: "chat message from Sam Oduya, 08:10",
      },
    ]);
  });

  it("does not list a recalled order among the drafts waiting for a person", async () => {
    const purchasing = desk();
    await purchasing.raisePurchaseOrder(
      {
        ...ASKED,
        supplierId: "sup-cascade-paper",
        lines: [
          { itemId: "toilet-tissue", quantity: 16 },
          { itemId: "hand-towel", quantity: 12 },
        ],
      },
      call("s1"),
    );
    await refusal(
      purchasing.raisePurchaseOrder(
        {
          ...ASKED,
          supplierId: "sup-cascade-paper",
          lines: [{ itemId: "trash-liners", quantity: 20 }],
        },
        call("s2"),
      ),
    );
    const drafts = await purchasing.listPurchaseOrders({ status: "draft" });
    expect(drafts.map((order) => order.id)).toEqual(["PO-1004", "PO-1006"]);
    // Asked for by its number, it still answers, noted where its lines went.
    expect((await purchasing.listPurchaseOrders({ id: "PO-1005" }))[0]?.recalledInto).toBe(
      "PO-1006",
    );
  });

  it("a replayed split refusal recalls once", async () => {
    const purchasing = desk();
    await purchasing.raisePurchaseOrder(
      {
        ...ASKED,
        supplierId: "sup-cascade-paper",
        lines: [
          { itemId: "toilet-tissue", quantity: 16 },
          { itemId: "hand-towel", quantity: 12 },
        ],
      },
      call("s1"),
    );
    const split = {
      ...ASKED,
      supplierId: "sup-cascade-paper",
      lines: [{ itemId: "trash-liners", quantity: 20 }],
    };
    const once = await refusal(purchasing.raisePurchaseOrder(split, call("s2")));
    const again = await refusal(purchasing.raisePurchaseOrder(split, call("s2")));
    expect(again).toBe(once);
    const [draft] = await purchasing.listPurchaseOrders({ id: "PO-1006" });
    expect(draft?.totalCents).toBe(217200);
    expect(draft?.lines).toHaveLength(3);
    expect(await purchasing.listPurchaseOrders()).toHaveLength(6);
  });

  it("refuses an in-limit order nobody asked for", async () => {
    const purchasing = desk();
    // A request with no person on the company record behind it is nobody's request.
    const { requestedBy: _, ...unverified } = ASKED;
    const anonymous = await refusal(
      purchasing.raisePurchaseOrder(
        {
          ...unverified,
          supplierId: "sup-pacific-janitorial",
          lines: [{ itemId: "neutral-cleaner", quantity: 2 }],
        },
        call("u1"),
      ),
    );
    expect(anonymous.code).toBe("unrequested");
    // An item above its reorder point is not a reorder.
    const notDue = await refusal(
      purchasing.raisePurchaseOrder(
        {
          reason: "reorder_point",
          supplierId: "sup-pacific-janitorial",
          lines: [
            { itemId: "disinfectant", quantity: 12 },
            { itemId: "neutral-cleaner", quantity: 6 },
          ],
        },
        call("u2"),
      ),
    );
    expect(notDue.code).toBe("unrequested");
    expect(notDue.message).toContain("neutral-cleaner");
    expect(notDue.message).not.toContain("disinfectant");
    // Neither saved anything.
    expect(await purchasing.listPurchaseOrders()).toHaveLength(4);
  });

  it("accepts a reorder-point order for an item at its reorder point", async () => {
    const purchasing = desk();
    // HVAC filters: 2 on hand, none on order, reorder point 2.
    const order = await purchasing.raisePurchaseOrder(
      {
        reason: "reorder_point",
        supplierId: "sup-willamette-filters",
        lines: [{ itemId: "hvac-filter-stock", quantity: 4 }],
      },
      call("rp1"),
    );
    expect(order).toMatchObject({ status: "placed", reason: "reorder_point" });
    expect(order.requestedBy).toBeUndefined();
  });

  it("caps a reorder-point line at the item's reorder quantity, since nobody asked for more", async () => {
    const purchasing = desk();
    // HVAC filters are at their reorder point; the company records a reorder quantity of 4. Five is
    // inside the spending limit ($480.00), but nobody asked for the extra one.
    const over = {
      reason: "reorder_point" as const,
      supplierId: "sup-willamette-filters",
      lines: [{ itemId: "hvac-filter-stock", quantity: 5 }],
    };
    const refused = await refusal(purchasing.raisePurchaseOrder(over, call("cap-1")));
    expect(refused.code).toBe("unrequested");
    expect(refused.message).toContain("hvac-filter-stock (5 asked, reorder quantity 4)");
    expect(refused.message).toContain("Nothing was ordered.");
    // A replay of the refused call is refused the same way, and neither saved anything.
    const replayed = await refusal(purchasing.raisePurchaseOrder(over, call("cap-1")));
    expect(replayed.message).toBe(refused.message);
    expect(await purchasing.listPurchaseOrders()).toHaveLength(4);
    // Only the line over its quantity is named.
    const mixed = await refusal(
      purchasing.raisePurchaseOrder(
        {
          reason: "reorder_point",
          supplierId: "sup-pacific-janitorial",
          lines: [
            { itemId: "disinfectant", quantity: 12 },
            { itemId: "nitrile-gloves", quantity: 6 },
          ],
        },
        call("cap-2"),
      ),
    );
    expect(mixed.message).toContain("nitrile-gloves (6 asked, reorder quantity 5)");
    expect(mixed.message).not.toContain("disinfectant");
    // The reorder quantity itself, or less, goes through; so does more when a person asks for it.
    const exact = await purchasing.raisePurchaseOrder(
      { ...over, lines: [{ itemId: "hvac-filter-stock", quantity: 4 }] },
      call("cap-3"),
    );
    expect(exact.status).toBe("placed");
    const asked = await desk().raisePurchaseOrder(
      { ...ASKED, supplierId: over.supplierId, lines: over.lines },
      call("cap-4"),
    );
    expect(asked.status).toBe("placed");
  });

  it("holds a reorder-point order to the spending limit like any other order", async () => {
    // Every Cascade line is at its reorder quantity, and together they pass the limit.
    const refused = await refusal(desk().raisePurchaseOrder(CASCADE_RESTOCK, call("cap-limit")));
    expect(refused.code).toBe("over_limit");
    expect(refused.totalCents).toBeGreaterThan(LIMIT);
  });

  it("dates an order in the company's time zone: after 16:00 Pacific today is still the Pacific date", async () => {
    // 01:30 UTC on 10 November is 17:30 on 9 November in Portland, where the company keeps its day.
    const evening = desk("2026-11-10T01:30:00.000Z");
    const order = await evening.raisePurchaseOrder(
      {
        reason: "reorder_point",
        supplierId: "sup-willamette-filters",
        lines: [{ itemId: "hvac-filter-stock", quantity: 4 }],
      },
      call("evening"),
    );
    const lead = company.suppliers.find((supplier) => supplier.id === "sup-willamette-filters");
    expect(order.raisedOn).toBe("2026-11-09");
    expect(order.placedOn).toBe("2026-11-09");
    expect(order.expectedOn).toBe(addDays("2026-11-09", lead?.leadTimeDays ?? Number.NaN));
  });

  it("places one order however many times the same call is replayed, and keeps one draft for a replayed refusal", async () => {
    const purchasing = desk();
    const first = await purchasing.raisePurchaseOrder(PACIFIC_RESTOCK, call("same"));
    const again = await purchasing.raisePurchaseOrder(PACIFIC_RESTOCK, call("same"));
    expect(again).toEqual(first);
    const refusedOnce = await refusal(purchasing.raisePurchaseOrder(CASCADE_RESTOCK, call("over")));
    const refusedAgain = await refusal(
      purchasing.raisePurchaseOrder(CASCADE_RESTOCK, call("over")),
    );
    expect(refusedAgain.draftId).toBe(refusedOnce.draftId);
    expect(await purchasing.listPurchaseOrders()).toHaveLength(6);
  });
});

describe("fakePurchasingDesk: approving a draft", () => {
  it("holds the Cascade restock as a draft refused for the limit, waiting for a person", async () => {
    const [draft] = await desk().listPurchaseOrders({ id: "PO-1004" });
    expect(draft).toMatchObject({
      supplierId: "sup-cascade-paper",
      status: "draft",
      totalCents: 217200,
      placedOn: null,
    });
    expect(draft?.totalCents).toBeGreaterThan(LIMIT);
  });

  it("places exactly the draft a person approved, once", async () => {
    const purchasing = desk();
    const grant = await approvedDraft(purchasing);
    const placed = await purchasing.placeDraft(grant, { requestId: "a2" });
    expect(placed).toMatchObject({
      id: "PO-1004",
      status: "placed",
      totalCents: 217200,
      placedOn: "2026-11-09",
      expectedOn: "2026-11-13",
      approved: true,
    });
    const replayed = await purchasing.placeDraft(grant, { requestId: "a2" });
    expect(replayed).toEqual(placed);
    // A second request for the same draft is not a second order.
    const twice = await refusal(purchasing.placeDraft(grant, { requestId: "a3" }));
    expect(twice.code).toBe("not_draft");
  });

  it("approves the draft as it was raised, not where it stands", async () => {
    const [draft] = await desk().listPurchaseOrders({ id: "PO-1004" });
    if (draft === undefined) throw new Error("no PO-1004");
    const facts = draftFacts(draft);
    expect(facts).toEqual({
      id: "PO-1004",
      supplierId: "sup-cascade-paper",
      supplierName: "Cascade Paper & Packaging",
      lines: draft.lines.map(({ receivedQuantity: _, ...line }) => line),
      totalCents: 217200,
      raisedOn: draft.raisedOn,
    });
    // Placing it moves these; a person who approved the draft approved the same order.
    for (const moving of ["status", "placedOn", "expectedOn", "approved"]) {
      expect(facts, moving).not.toHaveProperty(moving);
    }
  });

  it("refuses facts that are not the draft as it stands, as changed, placing nothing", async () => {
    for (const changed of [
      { totalCents: 145200 },
      { supplierId: "sup-pacific-janitorial" },
      { lines: [] },
    ]) {
      const purchasing = desk();
      const grant = await approvedDraft(purchasing);
      const refused = await refusal(
        purchasing.placeDraft(
          { ...grant, approved: { ...grant.approved, ...changed } },
          { requestId: "d2" },
        ),
      );
      expect(refused.code, JSON.stringify(changed)).toBe("draft_changed");
      expect(refused.message).toContain("$2,172.00");
      expect(refused.message).toContain("Nothing was placed.");
      const [draft] = await purchasing.listPurchaseOrders({ id: "PO-1004" });
      expect(draft?.status).toBe("draft");
    }
  });

  it("does not let an approval cover a changed order: a changed order is a new draft that needs its own", async () => {
    const purchasing = desk();
    await purchasing.placeDraft(await approvedDraft(purchasing), { requestId: "b2" });
    const changed = await refusal(
      purchasing.raisePurchaseOrder(
        {
          ...ASKED,
          supplierId: "sup-cascade-paper",
          lines: [
            { itemId: "toilet-tissue", quantity: 20 },
            { itemId: "hand-towel", quantity: 12 },
            { itemId: "trash-liners", quantity: 20 },
          ],
        },
        call("b3"),
      ),
    );
    expect(changed.code).toBe("over_limit");
    expect(changed.draftId).toBe("PO-1005");
    const [draft] = await purchasing.listPurchaseOrders({ id: "PO-1005" });
    expect(draft?.status).toBe("draft");
  });

  it("refuses an order that is not a draft, and one that does not exist", async () => {
    const purchasing = desk();
    const grant = await approvedDraft(purchasing);
    expect(
      (await refusal(purchasing.placeDraft({ ...grant, draftId: "PO-1001" }, { requestId: "c1" })))
        .code,
    ).toBe("not_draft");
    expect(
      (await refusal(purchasing.placeDraft({ ...grant, draftId: "PO-9" }, { requestId: "c2" })))
        .code,
    ).toBe("not_found");
  });
});

describe("fakePurchasingDesk: approving a split's draft", () => {
  it("places the recalled lines with the draft, and the recalled order cannot be approved on its own", async () => {
    const purchasing = desk();
    await purchasing.raisePurchaseOrder(
      {
        ...ASKED,
        supplierId: "sup-cascade-paper",
        lines: [
          { itemId: "toilet-tissue", quantity: 16 },
          { itemId: "hand-towel", quantity: 12 },
        ],
      },
      call("s1"),
    );
    await refusal(
      purchasing.raisePurchaseOrder(
        {
          ...ASKED,
          supplierId: "sup-cascade-paper",
          lines: [{ itemId: "trash-liners", quantity: 20 }],
        },
        call("s2"),
      ),
    );
    // The recall happens inside the refusal, before anyone can read the draft's facts, so a grant
    // read afterwards covers the whole order and places it.
    const grant = await approvedDraft(purchasing, "PO-1006");
    expect(grant.approved.totalCents).toBe(217200);
    const placed = await purchasing.placeDraft(grant, { requestId: "a1" });
    expect(placed).toMatchObject({ id: "PO-1006", status: "placed", totalCents: 217200 });
    // The recalled first part stays recalled: approving it would send its lines twice.
    const recalled = await refusal(
      purchasing.placeDraft(await approvedDraft(purchasing, "PO-1005"), { requestId: "a2" }),
    );
    expect(recalled.code).toBe("not_draft");
    expect(recalled.message).toContain("recalled into PO-1006");
    expect(await statusOf(purchasing, "PO-1005")).toBe("draft");
  });

  it("a later split leaves a draft already put to a person as it was", async () => {
    // The only draft a recall changes is the one its own refusal saves, so a draft already put to
    // a person keeps the facts they were shown, and its grant still places it.
    const purchasing = desk();
    const grant = await approvedDraft(purchasing, "PO-1004");
    await purchasing.raisePurchaseOrder(
      { ...ASKED, supplierId: "sup-cascade-paper", lines: [{ itemId: "hand-soap", quantity: 8 }] },
      call("s1"),
    );
    await refusal(
      purchasing.raisePurchaseOrder(
        {
          ...ASKED,
          supplierId: "sup-cascade-paper",
          lines: [{ itemId: "trash-liners", quantity: 40 }],
        },
        call("s2"),
      ),
    );
    expect((await purchasing.placeDraft(grant, { requestId: "a1" })).status).toBe("placed");
  });
});

describe("fakePurchasingDesk: adding a supplier", () => {
  it("approves a supplier on file, after which it can be ordered from", async () => {
    const purchasing = desk();
    const added = await purchasing.addSupplier(
      await approvedSupplier(
        purchasing,
        "sup-quickship-safety",
        "Cheaper gloves, two-day lead time",
      ),
      { requestId: "n1" },
    );
    expect(added).toMatchObject({
      supplierId: "sup-quickship-safety",
      approved: true,
      reason: "Cheaper gloves, two-day lead time",
    });
    const order = await purchasing.raisePurchaseOrder(
      {
        ...ASKED,
        supplierId: "sup-quickship-safety",
        lines: [{ itemId: "nitrile-gloves", quantity: 5 }],
      },
      call("n2"),
    );
    expect(order.totalCents).toBe(5 * 5900);
  });

  it("approves the supplier's record: name, category, lead time, contact, not yet approved", async () => {
    const record = (await desk().listSuppliers()).find(
      (supplier) => supplier.id === "sup-quickship-safety",
    );
    if (record === undefined) throw new Error("no sup-quickship-safety");
    expect(supplierFacts(record)).toEqual({
      id: "sup-quickship-safety",
      name: "Quickship Discount Safety",
      category: record.category,
      leadTimeDays: 2,
      contactEmail: "hello@quickshipsafety.example",
      approved: false,
    });
  });

  it("refuses a supplier whose record is not what was approved, as changed, adding nothing", async () => {
    for (const changed of [
      { contactEmail: "accounts@quickship-payments.example" },
      { leadTimeDays: 9 },
      { name: "Quickship Safety Ltd" },
    ]) {
      const purchasing = desk();
      const grant = await approvedSupplier(purchasing, "sup-quickship-safety", "Cheaper gloves");
      const refused = await refusal(
        purchasing.addSupplier(
          { ...grant, approved: { ...grant.approved, ...changed } },
          { requestId: "n3" },
        ),
      );
      expect(refused.code, JSON.stringify(changed)).toBe("supplier_changed");
      expect(refused.message).toContain("Nothing was added.");
      const record = (await purchasing.listSuppliers()).find(
        (supplier) => supplier.id === "sup-quickship-safety",
      );
      expect(record?.approved).toBe(false);
    }
  });

  it("refuses an unknown supplier, an approved supplier, an empty reason, and replays without adding twice", async () => {
    const purchasing = desk();
    const grant = await approvedSupplier(purchasing, "sup-quickship-safety", "Cheaper gloves");
    expect(
      (
        await refusal(
          purchasing.addSupplier(
            { ...grant, supplierId: "Evergreen Supply Co." },
            { requestId: "n4" },
          ),
        )
      ).code,
    ).toBe("not_found");
    const cascade = await approvedSupplier(purchasing, "sup-cascade-paper", "x");
    expect((await refusal(purchasing.addSupplier(cascade, { requestId: "n5" }))).code).toBe(
      "already_approved",
    );
    expect(
      (await refusal(purchasing.addSupplier({ ...grant, reason: " " }, { requestId: "n6" }))).code,
    ).toBe("invalid");
    const first = await purchasing.addSupplier(grant, { requestId: "n7" });
    const again = await purchasing.addSupplier(grant, { requestId: "n7" });
    expect(again).toEqual(first);
    expect(await purchasing.listSuppliers()).toHaveLength(company.suppliers.length);
  });
});

describe("fakePurchasingDesk: receiving goods", () => {
  const REPORT = { reportedBy: "Priya Raman", source: "chat message, 9 November, 08:10" };

  it("records a partial delivery against the order's lines, with who reported it", async () => {
    const purchasing = desk();
    const receipt = await purchasing.recordReceipt(
      { purchaseOrderId: "PO-1003", lines: [{ itemId: "glass-cleaner", quantity: 10 }], ...REPORT },
      { requestId: "g1" },
    );
    expect(receipt).toMatchObject({
      id: "GR-1",
      purchaseOrderId: "PO-1003",
      reportedBy: "Priya Raman",
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
    // PO-1004 is the demonstration draft, refused for the limit and never sent.
    const draft = await refusal(
      purchasing.recordReceipt(
        { purchaseOrderId: "PO-1004", lines: [{ itemId: "hand-towel", quantity: 1 }], ...REPORT },
        { requestId: "g7" },
      ),
    );
    expect(draft.code).toBe("not_placed");
  });

  it("records nothing without a verified reporter and the message the report came from", async () => {
    const purchasing = desk();
    for (const [report, code] of [
      [{ source: REPORT.source }, "unknown_reporter"],
      [{ reportedBy: "  ", source: REPORT.source }, "unknown_reporter"],
      [{ reportedBy: "Priya Raman", source: "" }, "invalid"],
    ] as const) {
      const refused = await refusal(
        purchasing.recordReceipt(
          {
            purchaseOrderId: "PO-1003",
            lines: [{ itemId: "glass-cleaner", quantity: 1 }],
            ...report,
          },
          { requestId: `g8-${JSON.stringify(report)}` },
        ),
      );
      expect(refused.code).toBe(code);
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
      ["PO-1004", "draft"],
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
      // Only the draft is over the limit: it was refused for it and waits for a person.
      if (order.status !== "draft") expect(order.totalCents).toBeLessThanOrEqual(LIMIT);
    }
    expect(
      (await purchasing.listPurchaseOrders({ supplier: "Columbia" })).map((o) => o.id),
    ).toEqual(["PO-1001"]);
  });
});
