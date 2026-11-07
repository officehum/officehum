/**
 * One block per tool, against `fakePurchasingDesk` and the company facts generated into this package,
 * through the registrations the factory builds and with the durable call identity Pi Durable hands to
 * `execute`. Every unsafe tool is replayed under the same call id here, at the tool level, and must
 * write once. No network, no model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { loadCompanyFacts, money, personLabel, purchasingLead } from "./company.js";
import { DEMO_NOW, fakePurchasingDesk, type PurchasingDesk } from "./desk.js";
import { type PurchasingToolset, purchasingTools } from "./tools.js";

const company = loadCompanyFacts();
const lead = personLabel(purchasingLead(company));

/** The durable identity one tool call runs under; only the ids matter to these tools. */
const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;

const tools = (desk: PurchasingDesk | undefined): PurchasingToolset =>
  purchasingTools({ desk, company });

const desk = (): PurchasingDesk => fakePurchasingDesk({ now: () => new Date(DEMO_NOW) });

function text(result: { output?: readonly unknown[] }): string {
  return (result.output ?? [])
    .map((block) => (block as { type?: string; text?: string }).text ?? "")
    .join("\n");
}

function details(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

const CASCADE = {
  supplierId: "sup-cascade-paper",
  lines: [
    { itemId: "toilet-tissue", quantity: 16 },
    { itemId: "hand-towel", quantity: 12 },
    { itemId: "trash-liners", quantity: 20 },
  ],
};

const PACIFIC = {
  supplierId: "sup-pacific-janitorial",
  lines: [
    { itemId: "disinfectant", quantity: 12 },
    { itemId: "nitrile-gloves", quantity: 5 },
  ],
};

const RECEIPT = {
  purchaseOrderId: "PO-1003",
  lines: [{ itemId: "glass-cleaner", quantity: 10 }],
  reportedBy: "Dev Patel",
  source: "chat message from Dev Patel, Monday 9 November",
  packingSlip: "PJ-55812",
};

describe("list_stock", () => {
  it("flags what needs reordering, from the desk", async () => {
    const result = await tools(desk()).listStock.execute({}, call("c1"), BACKGROUND_CONTEXT);
    expect(text(result)).toContain(
      "disinfectant — Hospital-grade disinfectant concentrate (gallon) — 4 on hand, 0 on order — reorder point 6, reorder quantity 12 — usual supplier sup-pacific-janitorial (Pacific Janitorial Supply) — REORDER",
    );
    expect(text(result)).toContain("floor-pad");
    expect(text(result)).toContain("1 on hand, 6 on order");
    expect(text(result)).toContain("6 items need reordering");
    expect(details(result).found).toBe(true);
  });
});

describe("list_suppliers", () => {
  it("marks each supplier approved or not, with its lead time", async () => {
    const result = await tools(desk()).listSuppliers.execute({}, call("c2"), BACKGROUND_CONTEXT);
    expect(text(result)).toContain(
      "sup-quickship-safety — Quickship Discount Safety — PPE — lead time 2 days — NOT on the approved list",
    );
    expect(text(result)).toContain("sup-cascade-paper — Cascade Paper & Packaging");
    expect(text(result)).toContain("approved");
  });
});

describe("compare_suppliers", () => {
  it("compares unit cost and lead time from data, and says which supplier is not approved", async () => {
    const result = await tools(desk()).compareSuppliers.execute(
      { itemId: "nitrile-gloves" },
      call("c3"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(
      "Quickship Discount Safety — $59.00 per case of 1,000 — lead time 2 days — NOT on the approved list",
    );
    expect(text(result)).toContain(
      "Pacific Janitorial Supply — $68.00 per case of 1,000 — lead time 3 days — approved, the usual supplier",
    );
  });

  it("refuses an item that is not stocked", async () => {
    const result = await tools(desk()).compareSuppliers.execute(
      { itemId: "caviar" },
      call("c4"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("not_found");
  });
});

describe("list_purchase_orders", () => {
  it("gives one order's status, lines and dates", async () => {
    const result = await tools(desk()).listPurchaseOrders.execute(
      { purchaseOrderId: "PO-1001" },
      call("c5"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("PO-1001 — Columbia Floor Care Supply — placed");
    expect(text(result)).toContain("placed 2026-11-04, expected 2026-11-09");
    expect(text(result)).toContain(
      "6 × Floor pads, 17 inch (case of 5) at $75.00 = $450.00, 0 received",
    );
    expect(text(result)).toContain("total $450.00");
  });

  it("says plainly when no order matches", async () => {
    const result = await tools(desk()).listPurchaseOrders.execute(
      { purchaseOrderId: "PO-42" },
      call("c6"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).found).toBe(false);
  });
});

describe("raise_purchase_order", () => {
  it("places an order inside the limit, with every figure from the desk", async () => {
    const result = await tools(desk()).raisePurchaseOrder.execute(
      PACIFIC,
      call("c7"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("Placed PO-1004 with Pacific Janitorial Supply");
    expect(text(result)).toContain(
      "12 × Hospital-grade disinfectant concentrate (gallon) at $24.00 = $288.00",
    );
    expect(text(result)).toContain("Total $628.00");
    expect(text(result)).toContain("expected 2026-11-12");
    expect(details(result)).toMatchObject({ id: "PO-1004", totalCents: 62800, status: "placed" });
  });

  it("refuses over the limit with the draft to ask about, naming request_po_approval and who decides", async () => {
    const purchasing = desk();
    const result = await tools(purchasing).raisePurchaseOrder.execute(
      CASCADE,
      call("c8"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("request_po_approval");
    expect(text(result)).toContain("draftId PO-1004");
    expect(text(result)).toContain(money(company.approvalLimits.purchaseOrderOverCents));
    expect(text(result)).toContain(lead);
    expect(details(result)).toMatchObject({
      code: "over_limit",
      draftId: "PO-1004",
      totalCents: 217200,
    });
    const [draft] = await purchasing.listPurchaseOrders({ id: "PO-1004" });
    expect(draft?.status).toBe("draft");
  });

  it("refuses an unapproved supplier, naming request_new_supplier and who decides", async () => {
    const result = await tools(desk()).raisePurchaseOrder.execute(
      { supplierId: "sup-quickship-safety", lines: [{ itemId: "nitrile-gloves", quantity: 5 }] },
      call("c9"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain(
      `Next: call request_new_supplier with supplier sup-quickship-safety and the reason, which asks ${lead}.`,
    );
    expect(details(result).code).toBe("unapproved_supplier");
  });

  it("chooses the next step from the refusal's code, not from its wording", async () => {
    // A host desk whose messages say nothing about the tools still gets the right next step.
    const quiet: PurchasingDesk = {
      ...desk(),
      raisePurchaseOrder: async () => {
        const { PurchasingDeskError } = await import("./desk.js");
        throw new PurchasingDeskError("split_order", "Too much today.", {
          draftId: "PO-77",
          totalCents: 1,
        });
      },
    };
    const result = await tools(quiet).raisePurchaseOrder.execute(
      PACIFIC,
      call("c10"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(
      `Next: call request_po_approval with draftId PO-77, which asks ${lead}.`,
    );
    expect(text(result)).not.toContain("request_new_supplier");
  });

  it("places one order when the same call is replayed, and keeps one draft for a replayed refusal", async () => {
    const purchasing = desk();
    const first = await tools(purchasing).raisePurchaseOrder.execute(
      PACIFIC,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    const again = await tools(purchasing).raisePurchaseOrder.execute(
      PACIFIC,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    expect(text(again)).toBe(text(first));
    const over = await tools(purchasing).raisePurchaseOrder.execute(
      CASCADE,
      call("over"),
      BACKGROUND_CONTEXT,
    );
    const overAgain = await tools(purchasing).raisePurchaseOrder.execute(
      CASCADE,
      call("over"),
      BACKGROUND_CONTEXT,
    );
    expect(text(overAgain)).toBe(text(over));
    expect(await purchasing.listPurchaseOrders()).toHaveLength(5);
  });
});

describe("request_po_approval", () => {
  it("places the approved draft, exactly as raised, and replays without placing twice", async () => {
    const purchasing = desk();
    await tools(purchasing).raisePurchaseOrder.execute(CASCADE, call("d1"), BACKGROUND_CONTEXT);
    const first = await tools(purchasing).requestPoApproval.execute(
      { draftId: "PO-1004" },
      call("d2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(first)).toBe(false);
    expect(text(first)).toContain("Approved and placed: PO-1004 with Cascade Paper & Packaging");
    expect(text(first)).toContain("Total $2,172.00");
    const again = await tools(purchasing).requestPoApproval.execute(
      { draftId: "PO-1004" },
      call("d2"),
      BACKGROUND_CONTEXT,
    );
    expect(text(again)).toBe(text(first));
    expect(await purchasing.listPurchaseOrders({ status: "placed" })).toHaveLength(3);
  });

  it("refuses an order that is not a draft", async () => {
    const result = await tools(desk()).requestPoApproval.execute(
      { draftId: "PO-1001" },
      call("d3"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("not_draft");
  });
});

describe("request_new_supplier", () => {
  it("adds the supplier to the approved list once, however often the call is replayed", async () => {
    const purchasing = desk();
    const args = {
      supplier: "sup-quickship-safety",
      reason: "Gloves are cheaper and come in two days",
    };
    const first = await tools(purchasing).requestNewSupplier.execute(
      args,
      call("e1"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(first)).toBe(false);
    expect(text(first)).toContain(
      "Quickship Discount Safety (sup-quickship-safety) is now on the approved supplier list",
    );
    expect(text(first)).toContain("Nothing has been ordered from it");
    const again = await tools(purchasing).requestNewSupplier.execute(
      args,
      call("e1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(again)).toBe(text(first));
    const second = await tools(purchasing).requestNewSupplier.execute(
      args,
      call("e2"),
      BACKGROUND_CONTEXT,
    );
    expect(details(second).code).toBe("already_approved");
  });
});

describe("record_receipt", () => {
  it("records what a named person reported, with the source, and what is still to come", async () => {
    const result = await tools(desk()).recordReceipt.execute(
      RECEIPT,
      call("f1"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("Recorded GR-1 against PO-1003 (Pacific Janitorial Supply)");
    expect(text(result)).toContain("reported by Dev Patel");
    expect(text(result)).toContain("packing slip PJ-55812");
    expect(text(result)).toContain("10 × Glass cleaner (gallon) received, 2 still to come");
    expect(text(result)).toContain("PO-1003 is partially received");
    expect(text(result)).toContain("nothing is paid");
  });

  it("refuses more than was ordered, and names who takes the extra up with the supplier", async () => {
    const result = await tools(desk()).recordReceipt.execute(
      { ...RECEIPT, lines: [{ itemId: "glass-cleaner", quantity: 14 }] },
      call("f2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("over_received");
    expect(text(result)).toContain(lead);
  });

  it("refuses a report with no named person", async () => {
    const result = await tools(desk()).recordReceipt.execute(
      { ...RECEIPT, reportedBy: " " },
      call("f3"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("invalid");
  });

  it("counts a replayed receipt once", async () => {
    const purchasing = desk();
    const first = await tools(purchasing).recordReceipt.execute(
      RECEIPT,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    const again = await tools(purchasing).recordReceipt.execute(
      RECEIPT,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    expect(text(again)).toBe(text(first));
    const glass = (await purchasing.listStock()).find((line) => line.itemId === "glass-cleaner");
    expect(glass).toMatchObject({ onHand: 13, onOrder: 2 });
  });
});

describe("read_company", () => {
  it("reads the purchasing section from the company: the limit, the approved list and who decides", async () => {
    const result = await tools(desk()).readCompany.execute(
      { section: "purchasing" },
      call("g1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(money(company.approvalLimits.purchaseOrderOverCents));
    expect(text(result)).toContain(lead);
    expect(text(result)).toContain("Quickship Discount Safety — not approved");
    expect(text(result)).toContain("Cascade Paper & Packaging — approved");
  });

  it("reads the people and who decides what", async () => {
    const result = await tools(desk()).readCompany.execute(
      { section: "people" },
      call("g2"),
      BACKGROUND_CONTEXT,
    );
    for (const worker of company.people) expect(text(result)).toContain(worker.name);
  });
});

describe("with no desk", () => {
  it("refuses at the point of use", async () => {
    await expect(
      tools(undefined).listStock.execute({}, call("h1"), BACKGROUND_CONTEXT),
    ).rejects.toThrow("No purchasing desk is configured");
  });
});
