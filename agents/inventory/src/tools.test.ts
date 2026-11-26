/**
 * One block per tool, against `fakeInventoryDesk` and the company facts generated into this package,
 * with the durable call identity Pi Durable hands to `execute`. Every unsafe tool is replayed under
 * the same call id and must write once. Every refusal names the next step. No network, no model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { APPROVED_FACTS_ARG, type ApprovalCallIdentity, type HookContext } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { countsOwner, loadCompanyFacts, personLabel, writeOffApprover } from "./company.js";
import { fakeInventoryDesk, type InventoryDesk } from "./desk.js";
import { type InventoryToolset, inventoryTools } from "./tools.js";

const company = loadCompanyFacts();
const LIMITS = () => ({ stock_adjustment_limit_cents: 25_000 });
const owner = personLabel(countsOwner(company));
const approver = personLabel(writeOffApprover(company));

const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;

const tools = (
  desk: InventoryDesk | undefined,
  limits: () => Readonly<Record<string, number>> = LIMITS,
): InventoryToolset => inventoryTools({ desk, company, limits });

function text(result: { output?: readonly unknown[] }): string {
  return (result.output ?? [])
    .map((block) => (block as { type?: string; text?: string }).text ?? "")
    .join("\n");
}
const details = (result: unknown) =>
  (result as { details?: Record<string, unknown> }).details ?? {};
const isError = (result: unknown) => (result as { isError?: boolean }).isError === true;

const HOOK_CONTEXT = {} as HookContext;
const CALL_IDENTITY: ApprovalCallIdentity = { conversationId: "conversation-1", taskId: "task-1" };

async function run(
  set: InventoryToolset,
  name: keyof InventoryToolset,
  args: Record<string, unknown>,
  callId: string = name,
) {
  const tool = set[name];
  if (!("execute" in tool)) throw new Error(`${name} is not a tool`);
  return tool.execute(args as never, call(callId), BACKGROUND_CONTEXT);
}

async function onHand(desk: InventoryDesk, locationId: string, itemId: string) {
  return (await desk.listStockLevels(locationId)).find((line) => line.itemId === itemId)?.onHand;
}

describe("the tools' declarations", () => {
  it("states replay on every tool, matching the manifest", async () => {
    const manifest = (await import("../officehum.json", { with: { type: "json" } })).default;
    const set = tools(fakeInventoryDesk());
    for (const declared of manifest.tools) {
      const registration = Object.values(set).find(
        (entry) => typeof entry === "object" && "name" in entry && entry.name === declared.name,
      ) as { replay?: string } | undefined;
      expect(registration?.replay, declared.name).toBe(declared.replay);
    }
  });
});

describe("list_stock_levels and count_sheet", () => {
  it("lists on hand, held and available by location", async () => {
    const result = await run(tools(fakeInventoryDesk()), "listStockLevels", {
      locationId: "van-maintenance",
    });
    expect(text(result)).toContain("floor-finish");
    expect(text(result)).toContain("2 on hand, 2 held, 0 available");
    expect(details(result).found).toBe(true);
  });

  it("gives a blind count sheet: no quantities on it", async () => {
    const result = await run(tools(fakeInventoryDesk()), "countSheet", { locationId: "van-north" });
    expect(text(result)).toContain("disinfectant");
    expect(text(result)).not.toMatch(/on hand|recorded|\b6\b/);
    expect(text(result)).toContain("CNT-1004");
  });

  it("refuses an unknown location and lists the real ones", async () => {
    const result = await run(tools(fakeInventoryDesk()), "countSheet", { locationId: "garage" });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("van-north");
  });
});

describe("record_issue and record_transfer", () => {
  it("issues once on a replay, and refuses more than is available", async () => {
    const desk = fakeInventoryDesk();
    const set = tools(desk);
    const args = {
      locationId: "storeroom",
      itemId: "trash-liners",
      quantity: 3,
      crewId: "cleaning-north",
      source: "chat",
    };
    const first = await run(set, "recordIssue", args, "same");
    const again = await run(set, "recordIssue", args, "same");
    expect(text(first)).toContain("Issued ISS-1");
    expect(text(again)).toBe(text(first));
    expect(await onHand(desk, "storeroom", "trash-liners")).toBe(4);

    const over = await run(set, "recordIssue", { ...args, quantity: 5 }, "over");
    expect(isError(over)).toBe(true);
    expect(text(over)).toContain("more than is available");
    expect(details(over).code).toBe("over_available");
    expect(await onHand(desk, "storeroom", "trash-liners")).toBe(4);
  });

  it("refuses to issue held stock and names who decides it", async () => {
    const result = await run(tools(fakeInventoryDesk()), "recordIssue", {
      locationId: "van-maintenance",
      itemId: "floor-finish",
      quantity: 1,
      crewId: "maintenance",
      source: "chat",
    });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("held");
    expect(text(result)).toContain(owner);
  });

  it("transfers once on a replay", async () => {
    const desk = fakeInventoryDesk();
    const set = tools(desk);
    const args = {
      itemId: "disinfectant",
      quantity: 2,
      fromId: "storeroom",
      toId: "van-central",
      source: "chat",
    };
    const first = await run(set, "recordTransfer", args, "same");
    const again = await run(set, "recordTransfer", args, "same");
    expect(text(first)).toContain("Moved TRF-1");
    expect(text(again)).toBe(text(first));
    expect(await onHand(desk, "storeroom", "disinfectant")).toBe(6);
    expect(await onHand(desk, "van-central", "disinfectant")).toBe(4);
  });
});

describe("record_count", () => {
  const recount = {
    locationId: "van-north",
    itemId: "disinfectant",
    countedQuantity: 5,
    countedBy: "Ana",
  };

  it("asks for a recount when a first count differs, and says nothing was adjusted", async () => {
    const desk = fakeInventoryDesk();
    const result = await run(tools(desk), "recordCount", {
      locationId: "storeroom",
      itemId: "hand-soap",
      countedQuantity: 3,
      countedBy: "Ana",
    });
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("Recount needed");
    expect(text(result)).toContain("Nothing was adjusted");
    expect(await onHand(desk, "storeroom", "hand-soap")).toBe(4);
  });

  it("adjusts a small confirmed difference with its reason code, once on a replay", async () => {
    const desk = fakeInventoryDesk();
    const set = tools(desk);
    const args = { ...recount, reasonCode: "unrecorded_issue" };
    const first = await run(set, "recordCount", args, "same");
    const again = await run(set, "recordCount", args, "same");
    expect(text(first)).toContain("Adjusted CNT-1004");
    expect(text(first)).toContain("$24.00");
    expect(text(first)).toContain("unrecorded_issue");
    expect(text(again)).toBe(text(first));
    expect(await onHand(desk, "van-north", "disinfectant")).toBe(5);
  });

  it("refuses a small confirmed difference with no reason code, listing the codes", async () => {
    const desk = fakeInventoryDesk();
    const result = await run(tools(desk), "recordCount", recount);
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("data_entry_error");
    expect(await onHand(desk, "van-north", "disinfectant")).toBe(6);
  });

  it("leaves a large confirmed difference unresolved and points to request_adjustment_approval", async () => {
    const desk = fakeInventoryDesk();
    const set = tools(desk);
    const first = { locationId: "storeroom", itemId: "toilet-tissue", countedBy: "Ana" };
    await run(set, "recordCount", { ...first, countedQuantity: 0 }, "one");
    const result = await run(set, "recordCount", { ...first, countedQuantity: 0 }, "two");
    expect(text(result)).toContain("Needs approval");
    expect(text(result)).toContain("$270.00");
    expect(text(result)).toContain("over the $250.00");
    expect(text(result)).toContain("request_adjustment_approval with countId CNT-1006");
    expect(text(result)).toContain(owner);
    expect(text(result)).toContain("Nothing was adjusted");
    expect(await onHand(desk, "storeroom", "toilet-tissue")).toBe(5);
  });

  it("reads the limit at every call, and holds everything when none resolves", async () => {
    let limit: Record<string, number> = { stock_adjustment_limit_cents: 25_000 };
    const desk = fakeInventoryDesk();
    const set = tools(desk, () => limit);
    limit = {};
    const result = await run(set, "recordCount", { ...recount, reasonCode: "miscount" });
    expect(text(result)).toContain("no stock adjustment limit set");
    expect(text(result)).toContain("request_adjustment_approval");
    expect(await onHand(desk, "van-north", "disinfectant")).toBe(6);
  });

  it("refuses a count of an item whose difference waits, naming the approval tool", async () => {
    const result = await run(tools(fakeInventoryDesk()), "recordCount", {
      locationId: "storeroom",
      itemId: "floor-finish",
      countedQuantity: 4,
      countedBy: "Ana",
    });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("request_adjustment_approval with countId CNT-1005");
  });
});

describe("request_adjustment_approval", () => {
  it("reads the count from the desk for the person and posts it after a yes, once", async () => {
    const desk = fakeInventoryDesk();
    const set = tools(desk);
    const shown = await set.adjustmentApprovalFacts(
      { countId: "CNT-1005", reasonCode: "unexplained" },
      HOOK_CONTEXT,
      CALL_IDENTITY,
    );
    expect(shown.summary).toBe(
      "Adjust the stock record for Floor finish (5 gal pail) at Example Avenue storeroom to the count CNT-1005: recorded 4, counted 1, a difference of -3 worth $345.00, over the $250.00 that may be adjusted without a person. Reason code: unexplained",
    );
    const args = {
      countId: "CNT-1005",
      reasonCode: "unexplained",
      [APPROVED_FACTS_ARG]: shown.facts,
    };
    const first = await run(set, "requestAdjustmentApproval", args, "same");
    const again = await run(set, "requestAdjustmentApproval", args, "same");
    expect(text(first)).toContain("Approved and adjusted: CNT-1005");
    expect(text(again)).toBe(text(first));
    expect(await onHand(desk, "storeroom", "floor-finish")).toBe(1);
  });

  it("adjusts nothing without facts a person approved", async () => {
    const desk = fakeInventoryDesk();
    const result = await run(tools(desk), "requestAdjustmentApproval", {
      countId: "CNT-1005",
      reasonCode: "unexplained",
    });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("Nothing was adjusted");
    expect(await onHand(desk, "storeroom", "floor-finish")).toBe(4);
  });

  it("asks nobody about a count that is not waiting for a person", async () => {
    const set = tools(fakeInventoryDesk());
    await expect(
      set.adjustmentApprovalFacts(
        { countId: "CNT-1004", reasonCode: "miscount" },
        HOOK_CONTEXT,
        CALL_IDENTITY,
      ),
    ).rejects.toThrow("recount");
    await expect(
      set.adjustmentApprovalFacts(
        { countId: "CNT-9999", reasonCode: "miscount" },
        HOOK_CONTEXT,
        CALL_IDENTITY,
      ),
    ).rejects.toThrow("No count");
  });
});

describe("hold_stock and request_write_off", () => {
  it("holds once on a replay, and the hold blocks an issue", async () => {
    const desk = fakeInventoryDesk();
    const set = tools(desk);
    const args = {
      locationId: "storeroom",
      itemId: "glass-cleaner",
      quantity: 2,
      reason: "damaged: caps cracked",
    };
    const first = await run(set, "holdStock", args, "same");
    const again = await run(set, "holdStock", args, "same");
    expect(text(first)).toContain("Held HOLD-2");
    expect(text(first)).toContain("request_write_off with holdId HOLD-2");
    expect(text(again)).toBe(text(first));
    const issue = await run(set, "recordIssue", {
      locationId: "storeroom",
      itemId: "glass-cleaner",
      quantity: 2,
      crewId: "cleaning-north",
      source: "chat",
    });
    expect(isError(issue)).toBe(true);
  });

  it("reads the hold for the person and writes it off after a yes, once", async () => {
    const desk = fakeInventoryDesk();
    const set = tools(desk);
    const shown = await set.writeOffApprovalFacts(
      { holdId: "HOLD-1" },
      HOOK_CONTEXT,
      CALL_IDENTITY,
    );
    expect(shown.summary).toBe(
      "Write off HOLD-1: 2 × Floor finish (5 gal pail) at Maintenance van, worth $230.00. Reason: damaged: lids split in the van and the finish has skinned over",
    );
    const args = { holdId: "HOLD-1", [APPROVED_FACTS_ARG]: shown.facts };
    const first = await run(set, "requestWriteOff", args, "same");
    const again = await run(set, "requestWriteOff", args, "same");
    expect(text(first)).toContain("Approved and written off: HOLD-1");
    expect(text(again)).toBe(text(first));
    expect(await onHand(desk, "van-maintenance", "floor-finish")).toBe(0);
  });

  it("writes off nothing without facts a person approved, and asks nobody about stock not held", async () => {
    const desk = fakeInventoryDesk();
    const set = tools(desk);
    const result = await run(set, "requestWriteOff", { holdId: "HOLD-1" });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("Nothing was written off");
    await expect(
      set.writeOffApprovalFacts({ holdId: "floor-finish" }, HOOK_CONTEXT, CALL_IDENTITY),
    ).rejects.toThrow("hold_stock");
    expect(await onHand(desk, "van-maintenance", "floor-finish")).toBe(2);
  });

  it("names the write-off approver", async () => {
    const set = tools(fakeInventoryDesk());
    const result = await run(set, "holdStock", {
      locationId: "storeroom",
      itemId: "glass-cleaner",
      quantity: 1,
      reason: "expired",
    });
    expect(text(result)).toContain(approver);
  });
});

describe("reports and read_company", () => {
  it("reports reorder needs and says it orders nothing", async () => {
    const result = await run(tools(fakeInventoryDesk()), "reorderReport", {});
    expect(text(result)).toContain("hand-towel");
    expect(text(result)).toContain("purchasing.request");
    expect(text(result)).toContain("Nothing was ordered");
  });

  it("reports accuracy from the desk", async () => {
    const result = await run(tools(fakeInventoryDesk()), "accuracyReport", {});
    expect(text(result)).toContain("2 of 3 closed counts matched the record (67%)");
    expect(text(result)).toContain("unrecorded_issue: 1 adjustment, $36.00");
    expect(text(result)).toContain("Open counts: CNT-1004, CNT-1005");
  });

  it("states the limit it enforces, read from the resolved limits", async () => {
    const result = await run(
      tools(undefined, () => ({ stock_adjustment_limit_cents: 5000 })),
      "readCompany",
      {
        section: "inventory",
      },
    );
    expect(text(result)).toContain("over $50.00");
    expect(text(result)).toContain(owner);
    expect(text(result)).toContain(approver);
  });

  it("refuses every desk tool with no desk bound", async () => {
    await expect(run(tools(undefined), "listStockLevels", {})).rejects.toThrow(
      "No inventory desk is bound",
    );
  });
});
