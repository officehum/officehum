/**
 * One block per tool, against `fakePurchasingDesk` and the company facts generated into this package,
 * through the registrations the factory builds and with the durable call identity Pi Durable hands to
 * `execute`. Every unsafe tool is replayed under the same call id here, at the tool level, and must
 * write once. No network, no model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { APPROVED_FACTS_ARG, type HookContext, type SenderResolver } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { loadCompanyFacts, money, personLabel, purchasingLead } from "./company.js";
import { DEMO_NOW, fakePurchasingDesk, type PurchasingDesk } from "./desk.js";
import { type PurchasingToolset, purchasingTools } from "./tools.js";

const company = loadCompanyFacts();
const lead = personLabel(purchasingLead(company));

/** The durable identity one tool call runs under; only the ids matter to these tools. */
const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;

const tools = (desk: PurchasingDesk | undefined, sender?: SenderResolver): PurchasingToolset =>
  purchasingTools({ desk, company, ...(sender === undefined ? {} : { sender }) });

/** A verified sender, as the host resolves it from the call's conversation. */
const from =
  (contact: string, origin: "internal" | "external" = "internal"): SenderResolver =>
  async () => ({ origin, channel: "chat", contact });

/** Priya Raman, Operations Manager: a person on the company record, by her email. */
const PRIYA = from("priya@northwindfacilities.com");

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
  reason: "reorder_point",
  supplierId: "sup-cascade-paper",
  lines: [
    { itemId: "toilet-tissue", quantity: 16 },
    { itemId: "hand-towel", quantity: 12 },
    { itemId: "trash-liners", quantity: 20 },
  ],
};

const PACIFIC = {
  reason: "reorder_point",
  supplierId: "sup-pacific-janitorial",
  lines: [
    { itemId: "disinfectant", quantity: 12 },
    { itemId: "nitrile-gloves", quantity: 5 },
  ],
};

const HOOK_CONTEXT = {} as HookContext;

/**
 * A `request_po_approval` call as the approval gate hands it to the tool after a yes: the draft's id
 * and the facts the gate read from the desk and showed the person. The demonstration desk holds the
 * Cascade restock as draft PO-1004.
 */
async function approvedDraftCall(set: PurchasingToolset, draftId = "PO-1004") {
  const { facts } = await set.poApprovalFacts({ draftId }, HOOK_CONTEXT);
  return { draftId, [APPROVED_FACTS_ARG]: facts };
}

/** A `request_new_supplier` call as the gate hands it over after a yes. */
async function approvedSupplierCall(set: PurchasingToolset, supplierId: string, reason: string) {
  const { facts } = await set.newSupplierApprovalFacts({ supplierId, reason }, HOOK_CONTEXT);
  return { supplierId, reason, [APPROVED_FACTS_ARG]: facts };
}

/** A tool's parameter names, leaving out the key only the approval gate sets. */
function named(tool: { parameters: unknown }): {
  readonly keys: string[];
  readonly schema: {
    properties: Record<string, { description?: string }>;
    required?: string[];
    additionalProperties?: boolean;
  };
} {
  const schema = tool.parameters as {
    properties: Record<string, { description?: string }>;
    required?: string[];
    additionalProperties?: boolean;
  };
  return {
    keys: Object.keys(schema.properties).filter((key) => key !== APPROVED_FACTS_ARG),
    schema,
  };
}

const RECEIPT = {
  purchaseOrderId: "PO-1003",
  lines: [{ itemId: "glass-cleaner", quantity: 10 }],
  source: "chat message from Priya Raman, Monday 9 November",
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
      "6 × Floor pads, 17 inch [floor-pad] (case of 5) at $75.00 = $450.00, 0 received",
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
    expect(text(result)).toContain("Placed PO-1005 with Pacific Janitorial Supply");
    expect(text(result)).toContain(
      "12 × Hospital-grade disinfectant concentrate [disinfectant] (gallon) at $24.00 = $288.00",
    );
    expect(text(result)).toContain("Total $628.00");
    expect(text(result)).toContain("expected 2026-11-12");
    expect(details(result)).toMatchObject({ id: "PO-1005", totalCents: 62800, status: "placed" });
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
    expect(text(result)).toContain(
      `Next: call request_po_approval with draftId PO-1005, which asks ${lead}.`,
    );
    expect(text(result)).toContain(money(company.approvalLimits.purchaseOrderOverCents));
    expect(text(result)).toContain(lead);
    expect(details(result)).toMatchObject({
      code: "over_limit",
      draftId: "PO-1005",
      totalCents: 217200,
    });
    const [draft] = await purchasing.listPurchaseOrders({ id: "PO-1005" });
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
      `Next: call request_new_supplier with supplierId sup-quickship-safety and the reason, which asks ${lead}.`,
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

  it("a requested order records the verified sender as requester", async () => {
    const purchasing = desk();
    const result = await tools(purchasing, PRIYA).raisePurchaseOrder.execute(
      {
        reason: "request",
        requestSource: "chat message from Priya Raman, Monday 9 November",
        supplierId: "sup-pacific-janitorial",
        lines: [{ itemId: "neutral-cleaner", quantity: 2 }],
      },
      call("q1"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(details(result)).toMatchObject({
      id: "PO-1005",
      reason: "request",
      requestedBy: "Priya Raman",
      requestSource: "chat message from Priya Raman, Monday 9 November",
    });
    expect(text(result)).toContain(
      "Requested by Priya Raman (chat message from Priya Raman, Monday 9 November).",
    );
  });

  it("names whoever the company record puts in purchasing, not a fixed name", async () => {
    const people = company.people.map((who) =>
      who.department === "purchasing" ? { ...who, name: "Avery Lin", title: "Buyer" } : who,
    );
    const result = await purchasingTools({
      desk: desk(),
      company: { ...company, people },
    }).recordReceipt.execute(RECEIPT, call("lead"), BACKGROUND_CONTEXT);
    expect(text(result)).toContain("pass the report to Avery Lin, Buyer");
    expect(text(result)).not.toContain("Rosa");
  });

  it("refuses a request when the sender is not on record", async () => {
    for (const sender of [
      undefined,
      from("tasha@crews.example", "external"),
      // An id names a colleague only inside the office; from outside it is nobody.
      from("priya-raman", "external"),
      // An outside email from a colleague's own address is not a colleague either.
      from("priya@northwindfacilities.com", "external"),
    ]) {
      const purchasing = desk();
      const result = await tools(purchasing, sender).raisePurchaseOrder.execute(
        {
          reason: "request",
          requestSource: "chat message, Monday 9 November",
          supplierId: "sup-pacific-janitorial",
          lines: [{ itemId: "neutral-cleaner", quantity: 2 }],
        },
        call("q2"),
        BACKGROUND_CONTEXT,
      );
      expect(isError(result)).toBe(true);
      expect(details(result).code).toBe("unrequested");
      expect(text(result)).toContain("Nothing was ordered.");
      expect(text(result)).toContain(`pass the request to ${lead}`);
      expect(await purchasing.listPurchaseOrders()).toHaveLength(4);
    }
  });

  it("refuses an in-limit order nobody asked for", async () => {
    // Neutral cleaner has 9 on hand against a reorder point of 4: not a reorder, and nobody asked.
    const result = await tools(desk(), PRIYA).raisePurchaseOrder.execute(
      {
        reason: "reorder_point",
        supplierId: "sup-pacific-janitorial",
        lines: [{ itemId: "neutral-cleaner", quantity: 6 }],
      },
      call("q3"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("unrequested");
    expect(text(result)).toContain("neutral-cleaner (9 on hand, 0 on order, reorder point 4)");
  });

  it("raise_purchase_order takes a reason and the request's source, never who asked", () => {
    const { keys, schema } = named(tools(desk()).raisePurchaseOrder);
    expect(keys).toEqual(["supplierId", "lines", "reason", "requestSource"]);
    expect(schema.required).toEqual(["supplierId", "lines", "reason"]);
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
    expect(await purchasing.listPurchaseOrders()).toHaveLength(6);
  });
});

describe("request_po_approval", () => {
  it("request_po_approval takes only draftId", () => {
    const { keys, schema } = named(tools(desk()).requestPoApproval);
    // The model names the draft; every fact the person approves is read from the desk by the gate.
    expect(keys).toEqual(["draftId"]);
    expect(schema.required).toEqual(["draftId"]);
    expect(schema.additionalProperties).toBe(false);
    // Declared only because Pi Durable re-validates the arguments the gate returns.
    expect(schema.properties[APPROVED_FACTS_ARG]?.description).toBe(
      "set by the approval gate; never supply it",
    );
  });

  it("the approval reads the draft's supplier, lines and total from the desk", async () => {
    const read = await tools(desk()).poApprovalFacts({ draftId: "PO-1004" }, HOOK_CONTEXT);
    expect(read.summary).toBe(
      `Place draft PO-1004 with Cascade Paper & Packaging: 16 × Toilet tissue (case of 96 rolls) at $54.00 = $864.00; 12 × Roll hand towels (case of 12 rolls) at $49.00 = $588.00; 20 × Trash liners, 33 gallon (case of 250) at $36.00 = $720.00. Total $2,172.00; a purchase order over ${money(company.approvalLimits.purchaseOrderOverCents)} needs a person's approval`,
    );
    expect(read.facts).toMatchObject({
      id: "PO-1004",
      supplierId: "sup-cascade-paper",
      supplierName: "Cascade Paper & Packaging",
      totalCents: 217200,
      lines: [
        { itemId: "toilet-tissue", quantity: 16, lineTotalCents: 86400 },
        { itemId: "hand-towel", quantity: 12, lineTotalCents: 58800 },
        { itemId: "trash-liners", quantity: 20, lineTotalCents: 72000 },
      ],
    });
  });

  it("the approval refuses, asking nobody, an order not on the desk or not a draft", async () => {
    const set = tools(desk());
    await expect(set.poApprovalFacts({ draftId: "PO-42" }, HOOK_CONTEXT)).rejects.toThrow(
      'No purchase order has the number "PO-42". Nothing was put to a person and nothing was placed. Next: find the draft with list_purchase_orders.',
    );
    await expect(set.poApprovalFacts({ draftId: "PO-1001" }, HOOK_CONTEXT)).rejects.toThrow(
      "PO-1001 is not a draft waiting for approval: it is placed. Nothing was put to a person and nothing was placed again.",
    );
  });

  it("the approval refuses, asking nobody, an order a refused split recalled", async () => {
    const purchasing = desk();
    const set = tools(purchasing, PRIYA);
    const order = (lines: { itemId: string; quantity: number }[], id: string) =>
      set.raisePurchaseOrder.execute(
        { reason: "request", requestSource: "chat", supplierId: "sup-cascade-paper", lines },
        call(id),
        BACKGROUND_CONTEXT,
      );
    await order(
      [
        { itemId: "toilet-tissue", quantity: 16 },
        { itemId: "hand-towel", quantity: 12 },
      ],
      "r1",
    );
    const split = await order([{ itemId: "trash-liners", quantity: 20 }], "r2");
    expect(details(split).code).toBe("split_order");
    expect(text(split)).toContain("PO-1005, placed earlier today, has been recalled into PO-1006");
    expect(text(split)).toContain("Next: call request_po_approval with draftId PO-1006");
    await expect(set.poApprovalFacts({ draftId: "PO-1005" }, HOOK_CONTEXT)).rejects.toThrow(
      "PO-1005 was recalled into PO-1006",
    );
    const listed = await set.listPurchaseOrders.execute(
      { purchaseOrderId: "PO-1005" },
      call("l1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(listed)).toContain(
      "PO-1005 — Cascade Paper & Packaging — draft — recalled into PO-1006",
    );
  });

  it("places the approved draft, exactly as raised", async () => {
    const purchasing = desk();
    const set = tools(purchasing);
    const first = await set.requestPoApproval.execute(
      await approvedDraftCall(set),
      call("d2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(first)).toBe(false);
    expect(text(first)).toContain("Approved and placed: PO-1004 with Cascade Paper & Packaging");
    expect(text(first)).toContain("Total $2,172.00");
    expect((await purchasing.listPurchaseOrders({ id: "PO-1004" }))[0]?.status).toBe("placed");
  });

  it("refuses without approved facts", async () => {
    // A bare call with no gate in front of it: nothing says a person saw anything.
    const purchasing = desk();
    const result = await tools(purchasing).requestPoApproval.execute(
      { draftId: "PO-1004" },
      call("d-bare"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result)).toMatchObject({ code: "not_approved", draftId: "PO-1004" });
    expect(text(result)).toContain("Nothing was placed");
    expect((await purchasing.listPurchaseOrders({ id: "PO-1004" }))[0]?.status).toBe("draft");
  });

  it("refuses when the draft changed after the facts were read", async () => {
    // A host system that lets a draft be edited: the person was shown it before the edit.
    const purchasing = desk();
    const [draft] = await purchasing.listPurchaseOrders({ id: "PO-1004" });
    if (draft === undefined) throw new Error("no PO-1004");
    const earlier = { ...draft, lines: draft.lines.slice(0, 2), totalCents: 145200 };
    const edited: PurchasingDesk = {
      ...purchasing,
      listPurchaseOrders: async (filter) =>
        filter?.id === "PO-1004" ? [earlier] : purchasing.listPurchaseOrders(filter),
    };
    const shown = await tools(edited).poApprovalFacts({ draftId: "PO-1004" }, HOOK_CONTEXT);
    const result = await tools(purchasing).requestPoApproval.execute(
      { draftId: "PO-1004", [APPROVED_FACTS_ARG]: shown.facts },
      call("d5"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("draft_changed");
    expect(text(result)).toContain("Nothing was placed.");
    expect(text(result)).toContain("list_purchase_orders");
    expect((await purchasing.listPurchaseOrders({ id: "PO-1004" }))[0]?.status).toBe("draft");
  });

  it("refuses a draft the desk does not hold, placing nothing", async () => {
    const purchasing = desk();
    const set = tools(purchasing);
    const { [APPROVED_FACTS_ARG]: facts } = await approvedDraftCall(set);
    const result = await set.requestPoApproval.execute(
      { draftId: "PO-9999", [APPROVED_FACTS_ARG]: facts },
      call("d9"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("not_found");
    expect(text(result)).toContain('No purchase order has the number "PO-9999"');
    expect(await purchasing.listPurchaseOrders({ status: "placed" })).toHaveLength(2);
  });

  it("a replayed request_po_approval call writes once", async () => {
    const purchasing = desk();
    const set = tools(purchasing);
    const approved = await approvedDraftCall(set);
    const first = await set.requestPoApproval.execute(approved, call("same"), BACKGROUND_CONTEXT);
    const replayed = await tools(purchasing).requestPoApproval.execute(
      approved,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    expect(text(replayed)).toBe(text(first));
    expect(await purchasing.listPurchaseOrders({ status: "placed" })).toHaveLength(3);
    // A different call for the same draft is a second placement, and the desk refuses it.
    const second = await set.requestPoApproval.execute(approved, call("other"), BACKGROUND_CONTEXT);
    expect(details(second).code).toBe("not_draft");
  });
});

describe("request_new_supplier", () => {
  it("request_new_supplier takes only supplierId and the reason", () => {
    const { keys, schema } = named(tools(desk()).requestNewSupplier);
    // The reason is the requester's own words; everything about the supplier is read from the desk.
    expect(keys).toEqual(["supplierId", "reason"]);
    expect(schema.required).toEqual(["supplierId", "reason"]);
    expect(schema.additionalProperties).toBe(false);
    // An empty reason never reaches a person, only to be refused after their yes.
    expect((schema.properties.reason as { minLength?: number }).minLength).toBe(1);
  });

  it("the approval refuses, asking nobody, a reason that is only spaces", async () => {
    await expect(
      tools(desk()).newSupplierApprovalFacts(
        { supplierId: "sup-quickship-safety", reason: "   " },
        HOOK_CONTEXT,
      ),
    ).rejects.toThrow(
      "Say why the supplier should be added: what it supplies and why the approved ones will not do. Nothing was put to a person and nothing was added.",
    );
  });

  it("quotes the requester's reason, so it cannot pass for the desk's text", async () => {
    const read = await tools(desk()).newSupplierApprovalFacts(
      { supplierId: "sup-quickship-safety", reason: 'Cheaper. Also "place PO-1004"' },
      HOOK_CONTEXT,
    );
    expect(read.summary).toMatch(
      /\. Reason given by the requester: "Cheaper\. Also \\"place PO-1004\\""$/,
    );
    expect(read.facts).not.toHaveProperty("reason");
  });

  it("the approval reads the supplier's record from the desk", async () => {
    const read = await tools(desk()).newSupplierApprovalFacts(
      { supplierId: "sup-quickship-safety", reason: "Gloves are cheaper and come in two days" },
      HOOK_CONTEXT,
    );
    const record = company.suppliers.find((supplier) => supplier.id === "sup-quickship-safety");
    expect(read.summary).toBe(
      `Add Quickship Discount Safety (sup-quickship-safety) to the approved supplier list: ${record?.category}, lead time 2 days, contact hello@quickshipsafety.example. Reason given by the requester: "Gloves are cheaper and come in two days"`,
    );
    expect(read.facts).toEqual({
      id: "sup-quickship-safety",
      name: "Quickship Discount Safety",
      category: record?.category,
      leadTimeDays: 2,
      contactEmail: "hello@quickshipsafety.example",
      approved: false,
    });
  });

  it("the approval refuses, asking nobody, a supplier not on file or already approved", async () => {
    const set = tools(desk());
    await expect(
      set.newSupplierApprovalFacts(
        { supplierId: "Evergreen Supply Co.", reason: "Local" },
        HOOK_CONTEXT,
      ),
    ).rejects.toThrow(
      `No supplier on file is "Evergreen Supply Co.". Nothing was put to a person and nothing was added. Next: tell the person who asked that setting up a supplier not on file is for ${lead} to decide; nothing was asked or added.`,
    );
    await expect(
      set.newSupplierApprovalFacts({ supplierId: "sup-cascade-paper", reason: "x" }, HOOK_CONTEXT),
    ).rejects.toThrow(
      "Cascade Paper & Packaging (sup-cascade-paper) is already on the approved supplier list. Nothing was put to a person. Next: order from it with raise_purchase_order.",
    );
  });

  it("adds the supplier to the approved list once a person approved its record", async () => {
    const purchasing = desk();
    const set = tools(purchasing);
    const first = await set.requestNewSupplier.execute(
      await approvedSupplierCall(set, "sup-quickship-safety", "Gloves are cheaper"),
      call("e1"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(first)).toBe(false);
    expect(text(first)).toContain(
      "Quickship Discount Safety (sup-quickship-safety) is now on the approved supplier list",
    );
    expect(text(first)).toContain("Nothing has been ordered from it");
  });

  it("refuses without approved facts", async () => {
    const purchasing = desk();
    const result = await tools(purchasing).requestNewSupplier.execute(
      { supplierId: "sup-quickship-safety", reason: "Gloves are cheaper" },
      call("e-bare"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result)).toMatchObject({
      code: "not_approved",
      supplierId: "sup-quickship-safety",
    });
    expect(text(result)).toContain("Nothing was added");
    const record = (await purchasing.listSuppliers()).find(
      (supplier) => supplier.id === "sup-quickship-safety",
    );
    expect(record?.approved).toBe(false);
  });

  it("refuses when the supplier changed after the facts were read", async () => {
    const purchasing = desk();
    const set = tools(purchasing);
    const approved = await approvedSupplierCall(set, "sup-quickship-safety", "Gloves are cheaper");
    // The record the person saw named another contact than the one on file now.
    const shown = approved[APPROVED_FACTS_ARG] as Record<string, unknown>;
    const result = await set.requestNewSupplier.execute(
      { ...approved, [APPROVED_FACTS_ARG]: { ...shown, contactEmail: "old@quickship.example" } },
      call("e3"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).code).toBe("supplier_changed");
    expect(text(result)).toContain("Nothing was added.");
  });

  it("a replayed request_new_supplier call writes once", async () => {
    const purchasing = desk();
    const set = tools(purchasing);
    const approved = await approvedSupplierCall(set, "sup-quickship-safety", "Gloves are cheaper");
    const first = await set.requestNewSupplier.execute(approved, call("e1"), BACKGROUND_CONTEXT);
    const again = await tools(purchasing).requestNewSupplier.execute(
      approved,
      call("e1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(again)).toBe(text(first));
    const second = await set.requestNewSupplier.execute(approved, call("e2"), BACKGROUND_CONTEXT);
    expect(details(second).code).toBe("already_approved");
  });
});

describe("record_receipt", () => {
  it("record_receipt records the verified sender as reporter", async () => {
    // A colleague inside the office, matched by phone as the gateway hands it over: "+" and digits.
    // The same number on an outside text is not a colleague (the refusal test below).
    const result = await tools(desk(), from("+15035550149")).recordReceipt.execute(
      RECEIPT,
      call("f0"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(details(result).reportedBy).toBe("Rosa Martinez");
  });

  it("record_receipt takes no reporter: the desk records the verified sender", () => {
    const { keys } = named(tools(desk()).recordReceipt);
    expect(keys).toEqual(["purchaseOrderId", "lines", "source", "packingSlip"]);
  });

  it("refuses a receipt with no verified sender", async () => {
    for (const sender of [
      undefined,
      from("orders@pacificjanitorial.example", "external"),
      // An outside email or text from a colleague's own address or number is not a colleague's report.
      from("priya@northwindfacilities.com", "external"),
      from("+15035550149", "external"),
    ]) {
      const purchasing = desk();
      const result = await tools(purchasing, sender).recordReceipt.execute(
        RECEIPT,
        call("f3"),
        BACKGROUND_CONTEXT,
      );
      expect(isError(result)).toBe(true);
      expect(details(result).code).toBe("unknown_reporter");
      expect(text(result)).toContain("Nothing was recorded.");
      // Someone off the record is not a dead end: the report goes to the purchasing lead, named from
      // the company record.
      expect(text(result)).toContain(`pass the report to ${lead}`);
      const [order] = await purchasing.listPurchaseOrders({ id: "PO-1003" });
      expect(order?.lines[0]?.receivedQuantity).toBe(0);
    }
  });

  it("refuses a purchase order the desk does not hold", async () => {
    const result = await tools(desk(), PRIYA).recordReceipt.execute(
      { ...RECEIPT, purchaseOrderId: "PO-9999" },
      call("f4"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("not_found");
    expect(text(result)).toContain('No purchase order has the number "PO-9999"');
  });

  it("records what a named person reported, with the source, and what is still to come", async () => {
    const result = await tools(desk(), PRIYA).recordReceipt.execute(
      RECEIPT,
      call("f1"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("Recorded GR-1 against PO-1003 (Pacific Janitorial Supply)");
    expect(text(result)).toContain("reported by Priya Raman");
    expect(text(result)).toContain("packing slip PJ-55812");
    expect(text(result)).toContain(
      "10 × Glass cleaner [glass-cleaner] (gallon) received, 2 still to come",
    );
    expect(text(result)).toContain("PO-1003 is partially received");
    expect(text(result)).toContain("nothing is paid");
  });

  it("refuses more than was ordered, and names who takes the extra up with the supplier", async () => {
    const result = await tools(desk(), PRIYA).recordReceipt.execute(
      { ...RECEIPT, lines: [{ itemId: "glass-cleaner", quantity: 14 }] },
      call("f2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("over_received");
    expect(text(result)).toContain(lead);
  });

  it("counts a replayed receipt once", async () => {
    const purchasing = desk();
    const first = await tools(purchasing, PRIYA).recordReceipt.execute(
      RECEIPT,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    const again = await tools(purchasing, PRIYA).recordReceipt.execute(
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
