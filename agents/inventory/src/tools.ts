/**
 * The Inventory and Warehouse role's eleven tools.
 *
 * `list_stock_levels`, `count_sheet`, `reorder_report`, `accuracy_report` and `read_company` only
 * read. `record_issue`, `record_transfer`, `record_count` and `hold_stock` write through the desk with
 * no approval: the desk refuses an issue, transfer or hold of more than is available, adjusts a count
 * only once a recount confirms it and its value is inside the limit, and otherwise leaves it
 * unresolved. Each refusal or hold a person can lift names the approval-gated tool that asks them.
 * `request_adjustment_approval` and `request_write_off` are those tools; their approvals are
 * `officehum.json`'s, evaluated by the SDK's gate before the tool runs, so this file holds no money
 * limit and no approval rule. The model names only the count or the hold: the facts readers read what
 * the person approves from the desk, the gate hands those facts to the tool on a yes, and the desk
 * refuses when the count or hold no longer equals what was approved.
 *
 * Every quantity and value a tool speaks comes back from the desk, and every name from the company
 * record. No tool orders anything: a reorder need is the Purchasing role's.
 */

import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { int, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import {
  APPROVED_FACTS_ARG,
  type ApprovalFactsReader,
  approvedFacts,
  approvedFactsParameter,
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
  presentLines,
  readCompanyTool,
  refusal,
  requestId,
  requireDesk,
  textResult,
} from "@officehum/sdk";
import { type CompanyFacts, countsOwner, money, personLabel, writeOffApprover } from "./company.js";
import {
  countFacts,
  type DeskRefusal,
  holdFacts,
  type InventoryDesk,
  InventoryDeskError,
  REASON_CODES,
  type ReasonCode,
  type StockCount,
  type StockHold,
} from "./desk.js";

/** The role's limit a confirmed count difference is judged against (`officehum.json`'s `limits`). */
export const STOCK_ADJUSTMENT_LIMIT = "stock_adjustment_limit_cents";

export interface InventoryToolDependencies {
  readonly desk: InventoryDesk | undefined;
  readonly company: CompanyFacts;
  /**
   * The role's resolved limits, read at every call: the manifest's defaults with the business's
   * overlay on top. Omitted, no limit resolves and every confirmed difference waits for a person.
   */
  readonly limits?: () => Readonly<Record<string, number>>;
}

export interface InventoryToolset {
  readonly listStockLevels: ToolRegistration;
  readonly countSheet: ToolRegistration;
  readonly recordIssue: ToolRegistration;
  readonly recordTransfer: ToolRegistration;
  readonly recordCount: ToolRegistration;
  readonly requestAdjustmentApproval: ToolRegistration;
  readonly holdStock: ToolRegistration;
  readonly requestWriteOff: ToolRegistration;
  readonly reorderReport: ToolRegistration;
  readonly accuracyReport: ToolRegistration;
  readonly readCompany: ToolRegistration;
  /** Reads an unresolved count from the desk for the person approving its adjustment. */
  readonly adjustmentApprovalFacts: ApprovalFactsReader;
  /** Reads a hold from the desk for the person approving its write-off. */
  readonly writeOffApprovalFacts: ApprovalFactsReader;
}

export type CompanySection =
  | "profile"
  | "hours"
  | "people"
  | "inventory"
  | "crews"
  | "policies"
  | "tone"
  | "escalation"
  | "glossary";

const REASON = union(
  REASON_CODES.map((code) => lit(code)),
  {
    description:
      "Why the record and the shelf differ: unrecorded_issue, unrecorded_transfer, receiving_error, data_entry_error, miscount or unexplained",
  },
);

const LOCATION = (what: string) =>
  str({ description: `${what}: a location id from list_stock_levels, e.g. storeroom` });
const ITEM = str({ description: "The item's id, e.g. disinfectant" });
const QUANTITY = int({ minimum: 1, description: "How many of the item's unit" });
const SOURCE = str({
  minLength: 1,
  description: "The message this came from: its channel, sender and when",
});

/** The limit as one clause; the figure is the role's resolved limit, read when it is written. */
function limitText(limitCents: number | undefined): string {
  return limitCents === undefined || !Number.isFinite(limitCents)
    ? "no stock adjustment limit is set for this role, so every confirmed difference waits for a person"
    : `a confirmed difference worth over ${money(limitCents)} waits for a person's approval`;
}

/** Why an adjustment is put to a person, for the person deciding it. */
function approvalLimitText(limitCents: number | undefined): string {
  return limitCents === undefined || !Number.isFinite(limitCents)
    ? "with no stock adjustment limit set, so every difference waits for a person"
    : `over the ${money(limitCents)} that may be adjusted without a person`;
}

function countLine(count: StockCount): string {
  const counted = count.recount ?? count.firstCount;
  const variance =
    count.varianceQuantity === null
      ? ""
      : `, difference ${count.varianceQuantity > 0 ? "+" : ""}${count.varianceQuantity} worth ${money(count.varianceCents ?? 0)}`;
  return `${count.id}: ${count.name} [${count.itemId}] (${count.unit}) at ${count.locationName}, recorded ${count.recordedQuantity}, counted ${counted}${variance}`;
}

function holdLine(hold: StockHold): string {
  return `${hold.id}: ${hold.quantity} × ${hold.name} [${hold.itemId}] (${hold.unit}) at ${hold.locationName}, worth ${money(hold.valueCents)}. Reason: ${hold.reason}`;
}

const companySections = (
  limit: () => string,
): Readonly<Record<CompanySection, (company: CompanyFacts) => string>> => ({
  profile: (company) => {
    const { profile } = company;
    return presentLines([companyHeadline(profile), companyContactLine(profile)]);
  },
  hours: (company) =>
    presentLines([
      `Office: ${company.hours.office} (${company.hours.timezone}).`,
      companyClosedLine(company.hours),
    ]),
  people: (company) => companyPeopleText(company, "email"),
  inventory: (company) => {
    const limitClause = limit();
    return [
      `${personLabel(countsOwner(company))} owns the counts and decides an adjustment that waits for a person.`,
      `${personLabel(writeOffApprover(company), "the person who approves write-offs")} approves every write-off.`,
      `${limitClause.charAt(0).toUpperCase()}${limitClause.slice(1)}.`,
      "Stock locations:",
      ...companyData(company, "inventory").locations.map(
        (location) => `- ${location.id} — ${location.name} (${location.kind})`,
      ),
    ].join("\n");
  },
  crews: (company) =>
    [
      "Crews stock is issued to:",
      ...companyData(company, "crews").map((crew) => `- ${crew.id} — ${crew.name}`),
    ].join("\n"),
  policies: companyPoliciesText,
  tone: companyToneText,
  escalation: companyEscalationText,
  glossary: companyGlossaryText,
});

/**
 * Builds the eleven tools over one desk and one company. Every one is plain Pi Durable: they install
 * into any harness, and a harness with no desk builds the same tools and refuses at the point of use.
 */
export function inventoryTools(dependencies: InventoryToolDependencies): InventoryToolset {
  const { company } = dependencies;
  const limit = (): number | undefined => dependencies.limits?.()[STOCK_ADJUSTMENT_LIMIT];
  const owner = personLabel(countsOwner(company));
  const approver = personLabel(writeOffApprover(company), "the person who approves write-offs");
  const desk = () => requireDesk(dependencies.desk, "inventory");

  /** A desk refusal as the model reads it, with the next step a person can take. */
  const refused = (error: unknown, extra: JsonObject) => {
    if (!(error instanceof InventoryDeskError)) throw error;
    const next: Record<DeskRefusal, string> = {
      over_available: ` Next: tell the person what is available; held stock is for ${owner} to decide, and a shortage is a reorder need for the Purchasing role.`,
      count_waiting: ` Next: call request_adjustment_approval with countId ${error.countId ?? "the waiting count"} and its reason code, which asks ${owner}.`,
      record_moved:
        " Next: tell the person the record moved, so nothing was adjusted; count it again.",
      count_changed:
        " Next: tell the person the count changed after it was put to a person, so nothing was adjusted.",
      hold_changed:
        " Next: tell the person the hold changed after it was put to a person, so nothing was written off.",
      // The desk's own message already says what to do for these.
      not_found: "",
      invalid: "",
      reason_needed: "",
      not_unresolved: "",
      not_held: "",
    };
    return deskRefusal(`${error.message}${next[error.code]}`, error.code, {
      ...(error.countId === undefined ? {} : { countId: error.countId }),
      ...extra,
    });
  };

  const listStockLevels = defineTool({
    name: "list_stock_levels",
    description:
      "List the stock record, for every location or one: each item's quantity on hand, the quantity held, and the quantity available to issue or move (on hand less held). The desk works it out.",
    parameters: obj({ locationId: opt(LOCATION("Only this location")) }),
    replay: "safe",
    execute: async (args) => {
      try {
        const lines = await desk().listStockLevels(args.locationId);
        return {
          ...textResult(
            [
              `Stock (${lines.length} lines):`,
              ...lines.map(
                (line) =>
                  `${line.locationId} — ${line.itemId} — ${line.name} (${line.unit}) — ${line.onHand} on hand, ${line.held} held, ${line.available} available`,
              ),
            ].join("\n"),
          ),
          details: { found: lines.length > 0, lines: lines.map((line) => ({ ...line })) },
        };
      } catch (error) {
        return refused(error, { locationId: args.locationId ?? null });
      }
    },
  });

  const countSheet = defineTool({
    name: "count_sheet",
    description:
      "The blind count sheet for one location: the items to count, by id, name and unit, with no recorded quantities, and the counts there waiting for a recount. Give it to the counter as it is.",
    parameters: obj({ locationId: LOCATION("The location to count") }),
    replay: "safe",
    execute: async (args) => {
      try {
        const sheet = await desk().countSheet(args.locationId);
        const waiting =
          sheet.awaitingRecount.length === 0
            ? "No count here waits for a recount."
            : `Waiting for a recount: ${sheet.awaitingRecount.map((count) => `${count.id} (${count.itemId})`).join(", ")}.`;
        return {
          ...textResult(
            [
              `Count sheet for ${sheet.locationName} (${sheet.locationId}): count each item and report the number found.`,
              ...sheet.items.map((item) => `- ${item.itemId} — ${item.name} (${item.unit})`),
              waiting,
            ].join("\n"),
          ),
          details: {
            found: sheet.items.length > 0,
            ...sheet,
            items: sheet.items.map((item) => ({ ...item })),
            awaitingRecount: sheet.awaitingRecount.map((count) => ({ ...count })),
          },
        };
      } catch (error) {
        return refused(error, { locationId: args.locationId });
      }
    },
  });

  const recordIssue = defineTool({
    name: "record_issue",
    description:
      "Record supplies issued from one location to one crew, with the message the request came from. The desk refuses more than is available there (on hand less held): held stock is never issued. An internal record: it orders nothing.",
    parameters: obj({
      locationId: LOCATION("Where the stock is issued from"),
      itemId: ITEM,
      quantity: QUANTITY,
      crewId: str({ description: "The crew's id from read_company crews" }),
      source: SOURCE,
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const receipt = await desk().recordIssue(args, { requestId: requestId("issue", api) });
        return {
          ...textResult(
            `Issued ${receipt.id}: ${receipt.quantity} × ${receipt.name} [${receipt.itemId}] (${receipt.unit}) from ${receipt.locationName} to ${receipt.crewName}. ${receipt.locationName} now has ${receipt.onHandAfter} on hand, ${receipt.availableAfter} available.`,
          ),
          details: { ...receipt },
        };
      } catch (error) {
        return refused(error, { itemId: args.itemId });
      }
    },
  });

  const recordTransfer = defineTool({
    name: "record_transfer",
    description:
      "Record stock moved from one of the company's locations to another, with the message it came from. The desk refuses more than is available at the location it leaves: held stock never moves.",
    parameters: obj({
      itemId: ITEM,
      quantity: QUANTITY,
      fromId: LOCATION("Where the stock leaves"),
      toId: LOCATION("Where the stock arrives"),
      source: SOURCE,
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const receipt = await desk().recordTransfer(args, {
          requestId: requestId("transfer", api),
        });
        return {
          ...textResult(
            `Moved ${receipt.id}: ${receipt.quantity} × ${receipt.name} [${receipt.itemId}] (${receipt.unit}) from ${receipt.fromName} to ${receipt.toName}. ${receipt.fromName} now has ${receipt.fromAvailableAfter} available; ${receipt.toName} has ${receipt.toOnHandAfter} on hand.`,
          ),
          details: { ...receipt },
        };
      } catch (error) {
        return refused(error, { itemId: args.itemId });
      }
    },
  });

  const recordCount = defineTool({
    name: "record_count",
    description:
      "Record the quantity counted for one item at one location, and who counted it. Never give an amount: the desk compares the count with the record and values any difference from the catalogue. A first count that differs asks for a recount and adjusts nothing. A recount's figure stands: a difference at or under the adjustment limit is adjusted with the reasonCode you give; over the limit it stays unresolved, and the next step is request_adjustment_approval.",
    parameters: obj({
      locationId: LOCATION("Where the count was taken"),
      itemId: ITEM,
      countedQuantity: int({ minimum: 0, description: "The number found on the shelf" }),
      countedBy: str({ minLength: 1, description: "Who counted, as they said" }),
      reasonCode: opt(REASON),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const cap = limit();
      try {
        const count = await desk().recordCount(
          {
            locationId: args.locationId,
            itemId: args.itemId,
            countedQuantity: args.countedQuantity,
            countedBy: args.countedBy,
            ...(args.reasonCode === undefined ? {} : { reasonCode: args.reasonCode as ReasonCode }),
          },
          // The limit is read now, so an overlay's value is the one the desk judges against.
          { requestId: requestId("count", api), stockAdjustmentLimitCents: cap },
        );
        const line = countLine(count);
        const messages: Record<StockCount["status"], string> = {
          accurate: `Counted ${line}. The record is right; nothing was adjusted.`,
          recount_needed: `Recount needed: ${count.id}: ${count.name} [${count.itemId}] (${count.unit}) at ${count.locationName}, counted ${count.firstCount}, does not agree with the record. Nothing was adjusted. Next: ask for a blind recount of ${count.name} at ${count.locationName}, by someone else if possible, without telling the counter the recorded quantity, and record it with record_count.`,
          adjusted: `Adjusted ${line}. The record now shows ${count.recount ?? count.firstCount}, reason code ${count.reasonCode ?? "none"}.`,
          unresolved: `Needs approval: the recount confirms ${line}, ${approvalLimitText(cap)}. The count is recorded as unresolved. Nothing was adjusted. Next: call request_adjustment_approval with countId ${count.id} and a reason code, which asks ${owner}.`,
        };
        return { ...textResult(messages[count.status]), details: { ...count } };
      } catch (error) {
        return refused(error, { itemId: args.itemId, locationId: args.locationId });
      }
    },
  });

  const adjustmentApprovalFacts: ApprovalFactsReader = async (args) => {
    const countId = String(args.countId);
    const [count] = await desk().listCounts({ id: countId });
    if (count === undefined) {
      throw new Error(
        `No count has the id ${JSON.stringify(countId)}. Nothing was put to a person and nothing was adjusted.`,
      );
    }
    if (count.status !== "unresolved") {
      const why =
        count.status === "recount_needed"
          ? "its first count differed and it waits for a recount, so record the recount with record_count first"
          : `it is ${count.status}`;
      throw new Error(
        `${count.id} is not a confirmed difference waiting for a person: ${why}. Nothing was put to a person and nothing was adjusted.`,
      );
    }
    const counted = count.recount ?? count.firstCount;
    return {
      summary: `Adjust the stock record for ${count.name} (${count.unit}) at ${count.locationName} to the count ${count.id}: recorded ${count.recordedQuantity}, counted ${counted}, a difference of ${count.varianceQuantity ?? 0} worth ${money(count.varianceCents ?? 0)}, ${approvalLimitText(limit())}. Reason code: ${String(args.reasonCode ?? "")}`,
      facts: countFacts(count),
    };
  };

  const requestAdjustmentApproval = defineTool({
    name: "request_adjustment_approval",
    description:
      "Ask a person to approve the adjustment for one unresolved count, named by the count's id from record_count, with the reason code. The desk reads the count and shows it to the person; every call waits for a person. Once approved, the record is set to the counted quantity, unless it moved since.",
    parameters: obj({
      countId: str({ description: "The count's id, e.g. CNT-1005" }),
      reasonCode: REASON,
      // Pi Durable re-validates the arguments the gate returns, so the gate's key is declared.
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return refusal(
          `Nothing was adjusted: this call carries no facts a person approved. A count is adjusted only after the approval gate has put it to a person and they said yes. Next: tell the person the adjustment needs a person's approval and nothing was adjusted.`,
          { code: "not_approved", countId: args.countId },
        );
      }
      try {
        const count = await desk().applyAdjustment(
          { countId: args.countId, reasonCode: args.reasonCode as ReasonCode, approved },
          { requestId: requestId("adjustment", api) },
        );
        return {
          ...textResult(
            `Approved and adjusted: ${countLine(count)}. The record now shows ${count.recount ?? count.firstCount}, reason code ${count.reasonCode ?? "none"}.`,
          ),
          details: { ...count },
        };
      } catch (error) {
        return refused(error, { countId: args.countId });
      }
    },
  });

  const holdStock = defineTool({
    name: "hold_stock",
    description:
      "Put stock on hold at one location, with the reason: damaged, defective, expired or under investigation. Held stock stays on the record but cannot be issued or moved. The desk refuses more than is available. A write-off is asked for afterwards with request_write_off.",
    parameters: obj({
      locationId: LOCATION("Where the stock is"),
      itemId: ITEM,
      quantity: QUANTITY,
      reason: str({ minLength: 1, description: "Why it is held, as reported" }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const hold = await desk().holdStock(args, { requestId: requestId("hold", api) });
        return {
          ...textResult(
            `Held ${holdLine(hold)}. It cannot be issued or moved. To write it off, call request_write_off with holdId ${hold.id}, which asks ${approver}.`,
          ),
          details: { ...hold },
        };
      } catch (error) {
        return refused(error, { itemId: args.itemId });
      }
    },
  });

  const writeOffApprovalFacts: ApprovalFactsReader = async (args) => {
    const holdId = String(args.holdId);
    const [hold] = await desk().listHolds({ id: holdId });
    if (hold === undefined) {
      throw new Error(
        `No hold has the id ${JSON.stringify(holdId)}: only held stock can be written off, so hold it first with hold_stock. Nothing was put to a person and nothing was written off.`,
      );
    }
    if (hold.status !== "held") {
      throw new Error(
        `${hold.id} was already written off. Nothing was put to a person and nothing was written off again.`,
      );
    }
    return {
      summary: `Write off ${hold.id}: ${hold.quantity} × ${hold.name} (${hold.unit}) at ${hold.locationName}, worth ${money(hold.valueCents)}. Reason: ${hold.reason}`,
      facts: holdFacts(hold),
    };
  };

  const requestWriteOff = defineTool({
    name: "request_write_off",
    description:
      "Ask a person to approve writing off one hold, named by its id from hold_stock or list_stock_levels. Only held stock can be written off. The desk reads the hold and its value and shows them to the person; every call waits for a person. Once approved, the stock comes off the record.",
    parameters: obj({
      holdId: str({ description: "The hold's id, e.g. HOLD-1" }),
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return refusal(
          `Nothing was written off: this call carries no facts a person approved. Held stock is written off only after the approval gate has put it to a person and they said yes. Next: tell the person the write-off needs a person's approval and nothing was written off.`,
          { code: "not_approved", holdId: args.holdId },
        );
      }
      try {
        const hold = await desk().writeOff(
          { holdId: args.holdId, approved },
          { requestId: requestId("write-off", api) },
        );
        return {
          ...textResult(`Approved and written off: ${holdLine(hold)}. It is off the record.`),
          details: { ...hold },
        };
      } catch (error) {
        return refused(error, { holdId: args.holdId });
      }
    },
  });

  const reorderReport = defineTool({
    name: "reorder_report",
    description:
      "List the items whose available stock across every location is at or below the reorder point, with the reorder quantity, worked out by the desk. It orders nothing: a reorder need goes to the Purchasing role as a purchasing.request.",
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      const lines = await desk().reorderReport();
      const body =
        lines.length === 0
          ? ["No item is at or below its reorder point."]
          : [
              `At or below the reorder point (${lines.length} items):`,
              ...lines.map(
                (line) =>
                  `- ${line.itemId} — ${line.name} (${line.unit}) — ${line.available} available, reorder point ${line.reorderPoint}, reorder quantity ${line.reorderQuantity}`,
              ),
            ];
      return {
        ...textResult(
          [
            ...body,
            "Nothing was ordered: ordering is the Purchasing role's. Hand the need on as a purchasing.request with agent_dispatch when that tool is available.",
          ].join("\n"),
        ),
        details: { found: lines.length > 0, lines: lines.map((line) => ({ ...line })) },
      };
    },
  });

  const accuracyReport = defineTool({
    name: "accuracy_report",
    description:
      "The count accuracy report, worked out by the desk: closed counts, how many matched the record, the accuracy rate, adjustments by reason code with their value, and the counts still open.",
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      const report = await desk().accuracyReport();
      const rate =
        report.accuracyPercent === null ? "no closed counts" : `${report.accuracyPercent}%`;
      return {
        ...textResult(
          [
            `${report.countsAccurate} of ${report.countsClosed} closed counts matched the record (${rate}).`,
            report.adjustments.length === 0 ? "No adjustments." : "Adjustments by reason code:",
            ...report.adjustments.map(
              (entry) =>
                `- ${entry.reasonCode}: ${entry.count} adjustment${entry.count === 1 ? "" : "s"}, ${money(entry.valueCents)}`,
            ),
            `Open counts: ${report.openCounts.join(", ") || "none"}.`,
          ].join("\n"),
        ),
        details: {
          found: report.countsClosed > 0,
          ...report,
          adjustments: report.adjustments.map((entry) => ({ ...entry })),
          openCounts: [...report.openCounts],
        },
      };
    },
  });

  const readCompany = readCompanyTool({
    company,
    description:
      "Read one section of the company record: the profile, the office hours, the people and what each decides, inventory (stock locations, who owns the counts, who approves a write-off, the adjustment limit), the crews, the policies, the tone of voice, the escalation path or the glossary.",
    sections: companySections(() => limitText(limit())),
  });

  return {
    listStockLevels,
    countSheet,
    recordIssue,
    recordTransfer,
    recordCount,
    requestAdjustmentApproval,
    holdStock,
    requestWriteOff,
    reorderReport,
    accuracyReport,
    readCompany,
    adjustmentApprovalFacts,
    writeOffApprovalFacts,
  };
}
