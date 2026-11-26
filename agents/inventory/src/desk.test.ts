/**
 * The demonstration desk: the stock arithmetic, every refusal the desk enforces in code, the
 * count-recount-adjust rule against the limit it is handed, and replay of every write by its request
 * id. The company facts are the generated copy, so a unit cost that changes in the company package
 * changes the values asserted here only through the catalogue.
 */

import { describe, expect, it } from "vitest";
import { loadCompanyFacts } from "./company.js";
import {
  countFacts,
  DEMO_NOW,
  demoCounts,
  demoHolds,
  demoStock,
  fakeInventoryDesk,
  holdFacts,
  type InventoryDesk,
  InventoryDeskError,
  REASON_CODES,
} from "./desk.js";

const company = loadCompanyFacts();
const LIMIT = 25000;
const opts = (requestId: string) => ({ requestId });
const countOpts = (requestId: string, limit: number | null = LIMIT) => ({
  requestId,
  // null stands for "no limit resolved", which the desk is handed as undefined.
  stockAdjustmentLimitCents: limit ?? undefined,
});

async function onHand(desk: InventoryDesk, locationId: string, itemId: string) {
  const line = (await desk.listStockLevels(locationId)).find((entry) => entry.itemId === itemId);
  return line === undefined
    ? undefined
    : { onHand: line.onHand, held: line.held, available: line.available };
}

async function refusalOf(promise: Promise<unknown>): Promise<InventoryDeskError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InventoryDeskError) return error;
    throw error;
  }
  throw new Error("the desk did not refuse");
}

const unitCost = (itemId: string): number => {
  const item = company.supplyCatalog.find((entry) => entry.id === itemId);
  if (item === undefined) throw new Error(`no ${itemId}`);
  return item.unitCostCents;
};

describe("demonstration data", () => {
  it("names only the company's locations and catalogue items", () => {
    const locations = new Set(company.inventory.locations.map((location) => location.id));
    const items = new Set(company.supplyCatalog.map((item) => item.id));
    for (const [location, stock] of Object.entries(demoStock())) {
      expect(locations.has(location), location).toBe(true);
      for (const item of Object.keys(stock)) expect(items.has(item), item).toBe(true);
    }
    for (const count of demoCounts()) {
      expect(locations.has(count.locationId)).toBe(true);
      expect(items.has(count.itemId)).toBe(true);
    }
    for (const hold of demoHolds()) {
      expect(locations.has(hold.locationId)).toBe(true);
      expect(items.has(hold.itemId)).toBe(true);
    }
    expect(DEMO_NOW).toBe("2026-11-09T16:00:00.000Z");
  });
});

describe("stock levels and the count sheet", () => {
  it("lists on hand, held and available, with held stock taken out of available", async () => {
    const desk = fakeInventoryDesk();
    expect(await onHand(desk, "van-maintenance", "floor-finish")).toEqual({
      onHand: 2,
      held: 2,
      available: 0,
    });
    expect(await onHand(desk, "storeroom", "floor-finish")).toEqual({
      onHand: 4,
      held: 0,
      available: 4,
    });
    const all = await desk.listStockLevels();
    expect(new Set(all.map((line) => line.locationId)).size).toBe(5);
  });

  it("refuses a location that is not the company's", async () => {
    const error = await refusalOf(fakeInventoryDesk().listStockLevels("garage"));
    expect(error.code).toBe("not_found");
    expect(error.message).toContain("storeroom");
  });

  it("gives a count sheet with no recorded quantities, and the counts waiting for a recount", async () => {
    const sheet = await fakeInventoryDesk().countSheet("van-north");
    expect(sheet.locationId).toBe("van-north");
    expect(sheet.items.map((item) => item.itemId)).toContain("disinfectant");
    for (const item of sheet.items) {
      expect(Object.keys(item).sort()).toEqual(["itemId", "name", "unit"]);
    }
    expect(sheet.awaitingRecount.map((count) => count.id)).toEqual(["CNT-1004"]);
    expect(JSON.stringify(sheet.awaitingRecount)).not.toMatch(/recorded|firstCount|quantity/i);
  });
});

describe("issues and transfers", () => {
  it("issues to a crew and reduces the record", async () => {
    const desk = fakeInventoryDesk();
    const receipt = await desk.recordIssue(
      {
        locationId: "storeroom",
        itemId: "trash-liners",
        quantity: 3,
        crewId: "cleaning-north",
        source: "chat",
      },
      opts("i1"),
    );
    expect(receipt).toMatchObject({ id: "ISS-1", quantity: 3, crewName: "North cleaning crews" });
    expect(receipt.availableAfter).toBe(4);
    expect((await onHand(desk, "storeroom", "trash-liners"))?.onHand).toBe(4);
  });

  it("refuses more than is available, and never issues held stock", async () => {
    const desk = fakeInventoryDesk();
    const over = await refusalOf(
      desk.recordIssue(
        {
          locationId: "storeroom",
          itemId: "trash-liners",
          quantity: 8,
          crewId: "cleaning-north",
          source: "chat",
        },
        opts("i1"),
      ),
    );
    expect(over.code).toBe("over_available");
    expect(over.message).toContain("7");
    const held = await refusalOf(
      desk.recordIssue(
        {
          locationId: "van-maintenance",
          itemId: "floor-finish",
          quantity: 1,
          crewId: "maintenance",
          source: "chat",
        },
        opts("i2"),
      ),
    );
    expect(held.code).toBe("over_available");
    expect(held.message).toContain("held");
    expect(await onHand(desk, "van-maintenance", "floor-finish")).toEqual({
      onHand: 2,
      held: 2,
      available: 0,
    });
  });

  it("refuses an unknown crew and a quantity that is not a whole number", async () => {
    const desk = fakeInventoryDesk();
    const base = { locationId: "storeroom", itemId: "trash-liners", source: "chat" };
    expect(
      (await refusalOf(desk.recordIssue({ ...base, quantity: 1, crewId: "night" }, opts("a"))))
        .code,
    ).toBe("not_found");
    expect(
      (
        await refusalOf(
          desk.recordIssue({ ...base, quantity: 1.5, crewId: "cleaning-north" }, opts("b")),
        )
      ).code,
    ).toBe("invalid");
  });

  it("answers a replayed issue with what it already did", async () => {
    const desk = fakeInventoryDesk();
    const input = {
      locationId: "storeroom",
      itemId: "trash-liners",
      quantity: 2,
      crewId: "cleaning-south",
      source: "chat",
    };
    const first = await desk.recordIssue(input, opts("same"));
    const again = await desk.recordIssue(input, opts("same"));
    expect(again).toEqual(first);
    expect((await onHand(desk, "storeroom", "trash-liners"))?.onHand).toBe(5);
  });

  it("moves stock between locations and refuses more than is available where it leaves", async () => {
    const desk = fakeInventoryDesk();
    const moved = await desk.recordTransfer(
      {
        itemId: "disinfectant",
        quantity: 3,
        fromId: "storeroom",
        toId: "van-south",
        source: "chat",
      },
      opts("t1"),
    );
    expect(moved).toMatchObject({
      id: "TRF-1",
      quantity: 3,
      fromAvailableAfter: 5,
      toOnHandAfter: 5,
    });
    const again = await desk.recordTransfer(
      {
        itemId: "disinfectant",
        quantity: 3,
        fromId: "storeroom",
        toId: "van-south",
        source: "chat",
      },
      opts("t1"),
    );
    expect(again).toEqual(moved);
    expect((await onHand(desk, "storeroom", "disinfectant"))?.onHand).toBe(5);

    const over = await refusalOf(
      desk.recordTransfer(
        {
          itemId: "disinfectant",
          quantity: 6,
          fromId: "storeroom",
          toId: "van-south",
          source: "chat",
        },
        opts("t2"),
      ),
    );
    expect(over.code).toBe("over_available");
    const held = await refusalOf(
      desk.recordTransfer(
        {
          itemId: "floor-finish",
          quantity: 1,
          fromId: "van-maintenance",
          toId: "storeroom",
          source: "chat",
        },
        opts("t3"),
      ),
    );
    expect(held.code).toBe("over_available");
    const same = await refusalOf(
      desk.recordTransfer(
        {
          itemId: "disinfectant",
          quantity: 1,
          fromId: "storeroom",
          toId: "storeroom",
          source: "chat",
        },
        opts("t4"),
      ),
    );
    expect(same.code).toBe("invalid");
  });
});

describe("counts", () => {
  it("closes a first count that matches the record as accurate", async () => {
    const desk = fakeInventoryDesk();
    const count = await desk.recordCount(
      { locationId: "storeroom", itemId: "hand-soap", countedQuantity: 4, countedBy: "Ana" },
      countOpts("c1"),
    );
    expect(count).toMatchObject({ id: "CNT-1006", status: "accurate", varianceQuantity: 0 });
  });

  it("asks for a recount when a first count differs, and adjusts nothing", async () => {
    const desk = fakeInventoryDesk();
    const count = await desk.recordCount(
      { locationId: "storeroom", itemId: "hand-soap", countedQuantity: 3, countedBy: "Ana" },
      countOpts("c1"),
    );
    expect(count).toMatchObject({ status: "recount_needed", firstCount: 3, recount: null });
    expect(count.varianceQuantity).toBeNull();
    expect((await onHand(desk, "storeroom", "hand-soap"))?.onHand).toBe(4);
  });

  it("adjusts a confirmed difference at or under the limit, with a reason code", async () => {
    const desk = fakeInventoryDesk();
    // CNT-1004: the North van's disinfectant, recorded 6, first counted 5.
    const count = await desk.recordCount(
      {
        locationId: "van-north",
        itemId: "disinfectant",
        countedQuantity: 5,
        countedBy: "Ana",
        reasonCode: "unrecorded_issue",
      },
      countOpts("c1"),
    );
    expect(count).toMatchObject({
      id: "CNT-1004",
      status: "adjusted",
      recount: 5,
      varianceQuantity: -1,
      varianceCents: unitCost("disinfectant"),
      reasonCode: "unrecorded_issue",
      adjustedBy: "limit",
    });
    expect((await onHand(desk, "van-north", "disinfectant"))?.onHand).toBe(5);
  });

  it("adjusts a difference exactly at the limit, and holds one a cent over", async () => {
    const cost = unitCost("disinfectant");
    const at = fakeInventoryDesk();
    expect(
      (
        await at.recordCount(
          {
            locationId: "van-north",
            itemId: "disinfectant",
            countedQuantity: 5,
            countedBy: "Ana",
            reasonCode: "miscount",
          },
          countOpts("c1", cost),
        )
      ).status,
    ).toBe("adjusted");
    const over = fakeInventoryDesk();
    const held = await over.recordCount(
      {
        locationId: "van-north",
        itemId: "disinfectant",
        countedQuantity: 5,
        countedBy: "Ana",
        reasonCode: "miscount",
      },
      countOpts("c1", cost - 1),
    );
    expect(held.status).toBe("unresolved");
    expect((await onHand(over, "van-north", "disinfectant"))?.onHand).toBe(6);
  });

  it("refuses a confirmed difference inside the limit with no reason code, and records nothing", async () => {
    const desk = fakeInventoryDesk();
    const error = await refusalOf(
      desk.recordCount(
        { locationId: "van-north", itemId: "disinfectant", countedQuantity: 5, countedBy: "Ana" },
        countOpts("c1"),
      ),
    );
    expect(error.code).toBe("reason_needed");
    for (const code of REASON_CODES) expect(error.message).toContain(code);
    const [still] = await desk.listCounts({ id: "CNT-1004" });
    expect(still?.status).toBe("recount_needed");
    expect((await onHand(desk, "van-north", "disinfectant"))?.onHand).toBe(6);
  });

  it("refuses a reason code that is not on the list", async () => {
    const error = await refusalOf(
      fakeInventoryDesk().recordCount(
        {
          locationId: "van-north",
          itemId: "disinfectant",
          countedQuantity: 5,
          countedBy: "Ana",
          reasonCode: "supplier said so" as never,
        },
        countOpts("c1"),
      ),
    );
    expect(error.code).toBe("invalid");
  });

  it("leaves a confirmed difference over the limit unresolved and changes nothing", async () => {
    const desk = fakeInventoryDesk();
    await desk.recordCount(
      { locationId: "storeroom", itemId: "toilet-tissue", countedQuantity: 0, countedBy: "Ana" },
      countOpts("c1"),
    );
    const recount = await desk.recordCount(
      {
        locationId: "storeroom",
        itemId: "toilet-tissue",
        countedQuantity: 0,
        countedBy: "Lee",
        reasonCode: "unexplained",
      },
      countOpts("c2"),
    );
    expect(recount).toMatchObject({
      status: "unresolved",
      varianceQuantity: -5,
      varianceCents: 5 * unitCost("toilet-tissue"),
    });
    expect((await onHand(desk, "storeroom", "toilet-tissue"))?.onHand).toBe(5);
  });

  it("holds every difference for a person when no limit is set", async () => {
    const desk = fakeInventoryDesk();
    const count = await desk.recordCount(
      {
        locationId: "van-north",
        itemId: "disinfectant",
        countedQuantity: 5,
        countedBy: "Ana",
        reasonCode: "miscount",
      },
      countOpts("c1", null),
    );
    expect(count.status).toBe("unresolved");
    expect((await onHand(desk, "van-north", "disinfectant"))?.onHand).toBe(6);
  });

  it("closes a recount that finds the record right without adjusting", async () => {
    const desk = fakeInventoryDesk();
    const count = await desk.recordCount(
      { locationId: "van-north", itemId: "disinfectant", countedQuantity: 6, countedBy: "Ana" },
      countOpts("c1"),
    );
    expect(count).toMatchObject({ status: "accurate", varianceQuantity: 0 });
  });

  it("refuses another count of an item whose difference waits for a person", async () => {
    const error = await refusalOf(
      fakeInventoryDesk().recordCount(
        { locationId: "storeroom", itemId: "floor-finish", countedQuantity: 4, countedBy: "Ana" },
        countOpts("c1"),
      ),
    );
    expect(error.code).toBe("count_waiting");
    expect(error.message).toContain("CNT-1005");
    expect(error.countId).toBe("CNT-1005");
  });

  it("answers a replayed count with what it already did", async () => {
    const desk = fakeInventoryDesk();
    const input = {
      locationId: "van-north",
      itemId: "disinfectant",
      countedQuantity: 5,
      countedBy: "Ana",
      reasonCode: "unrecorded_issue" as const,
    };
    const first = await desk.recordCount(input, countOpts("same"));
    const again = await desk.recordCount(input, countOpts("same"));
    expect(again).toEqual(first);
    expect((await onHand(desk, "van-north", "disinfectant"))?.onHand).toBe(5);
  });
});

describe("approved adjustments", () => {
  const approvedOf = async (desk: InventoryDesk, id: string) => {
    const [count] = await desk.listCounts({ id });
    if (count === undefined) throw new Error(`no ${id}`);
    return countFacts(count);
  };

  it("sets the record to the counted quantity once approved, once", async () => {
    const desk = fakeInventoryDesk();
    const approved = await approvedOf(desk, "CNT-1005");
    const adjusted = await desk.applyAdjustment(
      { countId: "CNT-1005", reasonCode: "unexplained", approved },
      opts("a1"),
    );
    expect(adjusted).toMatchObject({ status: "adjusted", adjustedBy: "approval" });
    expect((await onHand(desk, "storeroom", "floor-finish"))?.onHand).toBe(1);
    expect(
      await desk.applyAdjustment(
        { countId: "CNT-1005", reasonCode: "unexplained", approved },
        opts("a1"),
      ),
    ).toEqual(adjusted);
    const twice = await refusalOf(
      desk.applyAdjustment(
        { countId: "CNT-1005", reasonCode: "unexplained", approved },
        opts("a2"),
      ),
    );
    expect(twice.code).toBe("not_unresolved");
  });

  it("refuses facts that are not the count as the desk holds it", async () => {
    const desk = fakeInventoryDesk();
    const approved = { ...(await approvedOf(desk, "CNT-1005")), countedQuantity: 4 };
    const error = await refusalOf(
      desk.applyAdjustment(
        { countId: "CNT-1005", reasonCode: "unexplained", approved },
        opts("a1"),
      ),
    );
    expect(error.code).toBe("count_changed");
    expect((await onHand(desk, "storeroom", "floor-finish"))?.onHand).toBe(4);
  });

  it("refuses when the record moved after the count", async () => {
    const desk = fakeInventoryDesk();
    const approved = await approvedOf(desk, "CNT-1005");
    await desk.recordIssue(
      {
        locationId: "storeroom",
        itemId: "floor-finish",
        quantity: 1,
        crewId: "maintenance",
        source: "chat",
      },
      opts("i1"),
    );
    const error = await refusalOf(
      desk.applyAdjustment(
        { countId: "CNT-1005", reasonCode: "unexplained", approved },
        opts("a1"),
      ),
    );
    expect(error.code).toBe("record_moved");
    expect((await onHand(desk, "storeroom", "floor-finish"))?.onHand).toBe(3);
  });

  it("refuses a count that is not waiting for a person", async () => {
    const desk = fakeInventoryDesk();
    const approved = await approvedOf(desk, "CNT-1004");
    const error = await refusalOf(
      desk.applyAdjustment({ countId: "CNT-1004", reasonCode: "miscount", approved }, opts("a1")),
    );
    expect(error.code).toBe("not_unresolved");
  });
});

describe("holds and write-offs", () => {
  it("holds stock, which then cannot be issued, and refuses more than is available", async () => {
    const desk = fakeInventoryDesk();
    const hold = await desk.holdStock(
      { locationId: "storeroom", itemId: "glass-cleaner", quantity: 2, reason: "leaking caps" },
      opts("h1"),
    );
    expect(hold).toMatchObject({
      id: "HOLD-2",
      status: "held",
      quantity: 2,
      valueCents: 2 * unitCost("glass-cleaner"),
    });
    expect(await onHand(desk, "storeroom", "glass-cleaner")).toEqual({
      onHand: 3,
      held: 2,
      available: 1,
    });
    expect(
      await desk.holdStock(
        { locationId: "storeroom", itemId: "glass-cleaner", quantity: 2, reason: "leaking caps" },
        opts("h1"),
      ),
    ).toEqual(hold);
    const over = await refusalOf(
      desk.holdStock(
        { locationId: "storeroom", itemId: "glass-cleaner", quantity: 2, reason: "more" },
        opts("h2"),
      ),
    );
    expect(over.code).toBe("over_available");
    const issue = await refusalOf(
      desk.recordIssue(
        {
          locationId: "storeroom",
          itemId: "glass-cleaner",
          quantity: 2,
          crewId: "cleaning-north",
          source: "chat",
        },
        opts("i1"),
      ),
    );
    expect(issue.code).toBe("over_available");
  });

  it("refuses a hold with no reason", async () => {
    const error = await refusalOf(
      fakeInventoryDesk().holdStock(
        { locationId: "storeroom", itemId: "glass-cleaner", quantity: 1, reason: "  " },
        opts("h1"),
      ),
    );
    expect(error.code).toBe("invalid");
  });

  it("writes off a hold once approved, once, and takes it off the record", async () => {
    const desk = fakeInventoryDesk();
    const [hold] = await desk.listHolds({ id: "HOLD-1" });
    if (hold === undefined) throw new Error("no HOLD-1");
    const approved = holdFacts(hold);
    const written = await desk.writeOff({ holdId: "HOLD-1", approved }, opts("w1"));
    expect(written).toMatchObject({ status: "written_off", writtenOffOn: "2026-11-09" });
    expect(await onHand(desk, "van-maintenance", "floor-finish")).toEqual({
      onHand: 0,
      held: 0,
      available: 0,
    });
    expect(await desk.writeOff({ holdId: "HOLD-1", approved }, opts("w1"))).toEqual(written);
    const twice = await refusalOf(desk.writeOff({ holdId: "HOLD-1", approved }, opts("w2")));
    expect(twice.code).toBe("not_held");
  });

  it("refuses to write off anything that is not a hold, or a hold that changed", async () => {
    const desk = fakeInventoryDesk();
    expect(
      (await refusalOf(desk.writeOff({ holdId: "floor-finish", approved: {} }, opts("w1")))).code,
    ).toBe("not_found");
    const [hold] = await desk.listHolds({ id: "HOLD-1" });
    if (hold === undefined) throw new Error("no HOLD-1");
    const error = await refusalOf(
      desk.writeOff(
        { holdId: "HOLD-1", approved: { ...holdFacts(hold), quantity: 1 } },
        opts("w2"),
      ),
    );
    expect(error.code).toBe("hold_changed");
    expect((await onHand(desk, "van-maintenance", "floor-finish"))?.onHand).toBe(2);
  });
});

describe("reports", () => {
  it("flags items whose available stock across locations is at or below the reorder point", async () => {
    const report = await fakeInventoryDesk().reorderReport();
    expect(report.map((line) => line.itemId).sort()).toEqual(
      ["floor-pad", "hand-soap", "hand-towel", "nitrile-gloves", "toilet-tissue"].sort(),
    );
    const towels = report.find((line) => line.itemId === "hand-towel");
    expect(towels).toMatchObject({ available: 4, reorderPoint: 6, reorderQuantity: 12 });
  });

  it("works out accuracy, adjustments by reason code and open counts", async () => {
    const desk = fakeInventoryDesk();
    const report = await desk.accuracyReport();
    expect(report).toMatchObject({
      countsClosed: 3,
      countsAccurate: 2,
      accuracyPercent: 67,
      openCounts: ["CNT-1004", "CNT-1005"],
    });
    expect(report.adjustments).toEqual([
      { reasonCode: "unrecorded_issue", count: 1, valueCents: 2 * unitCost("microfiber-cloth") },
    ]);
    await desk.recordCount(
      {
        locationId: "van-north",
        itemId: "disinfectant",
        countedQuantity: 5,
        countedBy: "Ana",
        reasonCode: "unrecorded_issue",
      },
      countOpts("c1"),
    );
    const after = await desk.accuracyReport();
    expect(after).toMatchObject({ countsClosed: 4, countsAccurate: 2, accuracyPercent: 50 });
    expect(after.adjustments[0]).toMatchObject({ reasonCode: "unrecorded_issue", count: 2 });
  });
});
