/**
 * The desk: the stock system this role reads levels, counts and holds from and writes issues,
 * transfers, counts, adjustments, holds and write-offs to.
 *
 * A host binds its own (inventory software, a warehouse system, a spreadsheet with an API) and the
 * role never knows the difference. `fakeInventoryDesk` is what ships with the package: the company's
 * own locations, catalogue and crews, a demonstration stock record with a few counts in flight and one
 * hold, and all the arithmetic done here, so a test, an eval or a first run needs no network and no
 * credential.
 *
 * The desk owns every number that matters. The model names a location, an item and a quantity; the
 * desk works out what is available, compares a count with the record, values the difference from the
 * catalogue's unit cost, and decides whether it is adjusted, waits for a recount, or waits for a
 * person. A refusal carries a code, and the tools turn the code into the next step a person can take.
 */

import { companyData, localDate, sameFacts } from "@officehum/sdk";
import type { CompanyFacts, StockLocation, SupplyItem } from "./company.js";
import { loadCompanyFacts, money } from "./company.js";

/**
 * Why a recount confirmed a difference, from a fixed list, so adjustments can be counted by cause.
 * Suspected theft is not a code: it is a person's question, not an entry.
 */
export const REASON_CODES = [
  "unrecorded_issue",
  "unrecorded_transfer",
  "receiving_error",
  "data_entry_error",
  "miscount",
  "unexplained",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** One item's stock at one location. */
export interface StockLine {
  readonly locationId: string;
  readonly locationName: string;
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  readonly onHand: number;
  /** On hold: still on the record, never issued or moved. */
  readonly held: number;
  /** On hand less held, never below zero. */
  readonly available: number;
}

/** A blind count sheet: what to count at a location, never how many the record says. */
export interface CountSheet {
  readonly locationId: string;
  readonly locationName: string;
  readonly items: readonly {
    readonly itemId: string;
    readonly name: string;
    readonly unit: string;
  }[];
  /** Counts at this location whose first count differed and that wait for a recount. */
  readonly awaitingRecount: readonly { readonly id: string; readonly itemId: string }[];
}

/**
 * `recount_needed`: a first count differed; nothing changed. `accurate`: the record was right.
 * `adjusted`: a confirmed difference was posted, inside the limit or with a person's approval.
 * `unresolved`: a confirmed difference over the limit, waiting for a person; nothing changed.
 */
export type CountStatus = "recount_needed" | "accurate" | "adjusted" | "unresolved";

export interface StockCount {
  readonly id: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  readonly unitCostCents: number;
  /** On hand on the record when the count was last taken. */
  readonly recordedQuantity: number;
  readonly firstCount: number;
  readonly recount: number | null;
  readonly countedBy: string;
  readonly recountedBy: string | null;
  /** Counted less recorded, once a count is closed or confirmed; `null` while a recount is due. */
  readonly varianceQuantity: number | null;
  /** The difference's value at the catalogue's unit cost, always positive; `null` with no variance yet. */
  readonly varianceCents: number | null;
  readonly status: CountStatus;
  readonly reasonCode: ReasonCode | null;
  /** How an adjusted count was posted: inside the limit, or with a person's approval. */
  readonly adjustedBy: "limit" | "approval" | null;
  readonly countedOn: string;
}

export interface IssueReceipt {
  readonly id: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  readonly quantity: number;
  readonly crewId: string;
  readonly crewName: string;
  readonly source: string;
  readonly onHandAfter: number;
  readonly availableAfter: number;
  readonly at: string;
}

export interface TransferReceipt {
  readonly id: string;
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  readonly quantity: number;
  readonly fromId: string;
  readonly fromName: string;
  readonly toId: string;
  readonly toName: string;
  readonly fromAvailableAfter: number;
  readonly toOnHandAfter: number;
  readonly source: string;
  readonly at: string;
}

export interface StockHold {
  readonly id: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  readonly quantity: number;
  readonly reason: string;
  readonly unitCostCents: number;
  readonly valueCents: number;
  readonly status: "held" | "written_off";
  readonly heldOn: string;
  readonly writtenOffOn: string | null;
}

export interface ReorderLine {
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  /** Available across every location. */
  readonly available: number;
  readonly reorderPoint: number;
  readonly reorderQuantity: number;
  readonly supplierId: string;
}

export interface AccuracyReport {
  readonly countsClosed: number;
  readonly countsAccurate: number;
  /** Accurate over closed, as a whole percent; `null` with nothing closed. */
  readonly accuracyPercent: number | null;
  readonly adjustments: readonly {
    readonly reasonCode: ReasonCode;
    readonly count: number;
    readonly valueCents: number;
  }[];
  readonly openCounts: readonly string[];
}

export interface RecordIssueInput {
  readonly locationId: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly crewId: string;
  /** The message the request came from. */
  readonly source: string;
}

export interface RecordTransferInput {
  readonly itemId: string;
  readonly quantity: number;
  readonly fromId: string;
  readonly toId: string;
  readonly source: string;
}

export interface RecordCountInput {
  readonly locationId: string;
  readonly itemId: string;
  readonly countedQuantity: number;
  readonly countedBy: string;
  /** Needed when a recount confirms a difference the desk may adjust. */
  readonly reasonCode?: ReasonCode;
}

export interface HoldStockInput {
  readonly locationId: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly reason: string;
}

/**
 * The facts a person approves when adjusting the record to a count: where, what, the record and the
 * count, and the difference's value. Who counted and when are left out: they are not the change.
 */
export function countFacts(count: StockCount): Record<string, unknown> {
  return {
    id: count.id,
    locationId: count.locationId,
    itemId: count.itemId,
    recordedQuantity: count.recordedQuantity,
    countedQuantity: count.recount ?? count.firstCount,
    varianceQuantity: count.varianceQuantity,
    varianceCents: count.varianceCents,
  };
}

/** The facts a person approves when writing off a hold: where, what, how many, why, and its value. */
export function holdFacts(hold: StockHold): Record<string, unknown> {
  return {
    id: hold.id,
    locationId: hold.locationId,
    itemId: hold.itemId,
    quantity: hold.quantity,
    reason: hold.reason,
    unitCostCents: hold.unitCostCents,
    valueCents: hold.valueCents,
  };
}

/** What the role needs from whatever system holds its stock. */
export interface InventoryDesk {
  /** Every location's lines, or one location's. */
  listStockLevels(locationId?: string): Promise<readonly StockLine[]>;
  countSheet(locationId: string): Promise<CountSheet>;
  /** Refuses `over_available` when the quantity is more than on hand less held at the location. */
  recordIssue(
    input: RecordIssueInput,
    options: { readonly requestId: string },
  ): Promise<IssueReceipt>;
  /** Refuses `over_available` at the location it leaves; moves stock at once. */
  recordTransfer(
    input: RecordTransferInput,
    options: { readonly requestId: string },
  ): Promise<TransferReceipt>;
  /**
   * Records a count. A first count that differs from the record changes nothing and asks for a
   * recount. A recount's figure stands: a difference valued at or under `stockAdjustmentLimitCents`
   * is adjusted with its reason code (refused `reason_needed` without one), and one over it stays
   * `unresolved`. A host desk must treat an `undefined` limit as "every difference waits for a
   * person", never as no limit.
   */
  recordCount(
    input: RecordCountInput,
    options: {
      readonly requestId: string;
      readonly stockAdjustmentLimitCents: number | undefined;
    },
  ): Promise<StockCount>;
  listCounts(filter?: { readonly id?: string }): Promise<readonly StockCount[]>;
  /**
   * Posts one unresolved count, once a person approved it, with the facts the gate read and showed
   * them (`countFacts`). A host desk must refuse `count_changed` when the count no longer equals
   * `approved`, and `record_moved` when the record changed since the count.
   */
  applyAdjustment(
    input: {
      readonly countId: string;
      readonly reasonCode: ReasonCode;
      readonly approved: Readonly<Record<string, unknown>>;
    },
    options: { readonly requestId: string },
  ): Promise<StockCount>;
  holdStock(input: HoldStockInput, options: { readonly requestId: string }): Promise<StockHold>;
  listHolds(filter?: { readonly id?: string }): Promise<readonly StockHold[]>;
  /**
   * Writes off one hold, once a person approved it, with the facts they were shown (`holdFacts`). Only
   * held stock is ever written off; a host desk must refuse `hold_changed` when the hold no longer
   * equals `approved`.
   */
  writeOff(
    input: { readonly holdId: string; readonly approved: Readonly<Record<string, unknown>> },
    options: { readonly requestId: string },
  ): Promise<StockHold>;
  reorderReport(): Promise<readonly ReorderLine[]>;
  accuracyReport(): Promise<AccuracyReport>;
}

/** Why the desk refused, so a tool can say what to do next without parsing the message. */
export type DeskRefusal =
  | "not_found"
  | "invalid"
  | "over_available"
  | "reason_needed"
  | "count_waiting"
  | "not_unresolved"
  | "count_changed"
  | "record_moved"
  | "not_held"
  | "hold_changed";

export class InventoryDeskError extends Error {
  readonly code: DeskRefusal;
  /** For `count_waiting`: the count that waits for a person. */
  readonly countId: string | undefined;

  constructor(code: DeskRefusal, message: string, extra: { readonly countId?: string } = {}) {
    super(message);
    this.name = "InventoryDeskError";
    this.code = code;
    this.countId = extra.countId;
  }
}

export interface FakeInventoryDeskOptions {
  /** Locations, catalogue, crews and time zone; the company's own when omitted. */
  readonly company?: Pick<CompanyFacts, "hours" | "inventory" | "supplyCatalog" | "crews">;
  /** On hand by location and item; the demonstration record when omitted. */
  readonly stock?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly counts?: readonly StockCount[];
  readonly holds?: readonly StockHold[];
  /** The clock. Omitted: Monday 9 November 2026, the morning of the demonstration week. */
  readonly now?: () => Date;
}

/** Monday 9 November 2026, at the start of the office day on the US west coast. */
export const DEMO_NOW = "2026-11-09T16:00:00.000Z";

/**
 * The demonstration stock record on the morning of Monday 9 November 2026: the storeroom holds most
 * of it, each van a little. Five items are at or below their reorder point across all locations.
 */
export function demoStock(): Readonly<Record<string, Readonly<Record<string, number>>>> {
  return {
    storeroom: {
      "neutral-cleaner": 6,
      disinfectant: 8,
      "glass-cleaner": 3,
      "nitrile-gloves": 2,
      "toilet-tissue": 5,
      "hand-towel": 4,
      "hand-soap": 4,
      "trash-liners": 7,
      "microfiber-cloth": 10,
      "mop-head": 6,
      "floor-pad": 1,
      "floor-finish": 4,
      "hvac-filter-stock": 2,
    },
    "van-north": {
      "neutral-cleaner": 1,
      disinfectant: 6,
      "glass-cleaner": 2,
      "nitrile-gloves": 1,
      "trash-liners": 2,
      "microfiber-cloth": 2,
    },
    "van-central": {
      "neutral-cleaner": 1,
      disinfectant: 2,
      "glass-cleaner": 1,
      "trash-liners": 1,
      "microfiber-cloth": 1,
      "mop-head": 1,
    },
    "van-south": {
      "neutral-cleaner": 1,
      disinfectant: 2,
      "glass-cleaner": 1,
      "trash-liners": 1,
      "microfiber-cloth": 1,
    },
    "van-maintenance": { "floor-finish": 2, "floor-pad": 1, "hvac-filter-stock": 1 },
  };
}

/** The bare facts of a demonstration count or hold; the desk fills in names, units and costs. */
type DemoCount = Pick<
  StockCount,
  | "id"
  | "locationId"
  | "itemId"
  | "recordedQuantity"
  | "firstCount"
  | "recount"
  | "countedBy"
  | "recountedBy"
  | "status"
  | "reasonCode"
  | "adjustedBy"
  | "countedOn"
>;

/**
 * The counts on the desk: three closed last week (two matched the record, one adjusted inside the
 * limit), the North van's disinfectant waiting for a recount, and the storeroom's floor finish, where
 * a recount confirmed three pails missing, over the limit, waiting for a person. The eval scenarios
 * name the last two, so the approval gate reads the same counts the stubbed tools describe.
 */
export function demoCounts(): readonly DemoCount[] {
  const closed = { recountedBy: null, reasonCode: null, adjustedBy: null } as const;
  return [
    {
      id: "CNT-1001",
      locationId: "storeroom",
      itemId: "nitrile-gloves",
      recordedQuantity: 2,
      firstCount: 2,
      recount: null,
      countedBy: "storeroom cycle count",
      status: "accurate",
      countedOn: "2026-11-02",
      ...closed,
    },
    {
      id: "CNT-1002",
      locationId: "storeroom",
      itemId: "microfiber-cloth",
      recordedQuantity: 12,
      firstCount: 10,
      recount: 10,
      countedBy: "storeroom cycle count",
      recountedBy: "storeroom recount",
      status: "adjusted",
      reasonCode: "unrecorded_issue",
      adjustedBy: "limit",
      countedOn: "2026-11-03",
    },
    {
      id: "CNT-1003",
      locationId: "van-south",
      itemId: "glass-cleaner",
      recordedQuantity: 1,
      firstCount: 1,
      recount: null,
      countedBy: "van check",
      status: "accurate",
      countedOn: "2026-11-05",
      ...closed,
    },
    {
      id: "CNT-1004",
      locationId: "van-north",
      itemId: "disinfectant",
      recordedQuantity: 6,
      firstCount: 5,
      recount: null,
      countedBy: "van check",
      status: "recount_needed",
      countedOn: "2026-11-06",
      ...closed,
    },
    {
      id: "CNT-1005",
      locationId: "storeroom",
      itemId: "floor-finish",
      recordedQuantity: 4,
      firstCount: 1,
      recount: 1,
      countedBy: "storeroom cycle count",
      recountedBy: "storeroom recount",
      status: "unresolved",
      reasonCode: null,
      adjustedBy: null,
      countedOn: "2026-11-06",
    },
  ];
}

/** The hold on the desk: two pails of floor finish in the maintenance van with split lids. */
export function demoHolds(): readonly Pick<
  StockHold,
  "id" | "locationId" | "itemId" | "quantity" | "reason" | "status" | "heldOn" | "writtenOffOn"
>[] {
  return [
    {
      id: "HOLD-1",
      locationId: "van-maintenance",
      itemId: "floor-finish",
      quantity: 2,
      reason: "damaged: lids split in the van and the finish has skinned over",
      status: "held",
      heldOn: "2026-11-06",
      writtenOffOn: null,
    },
  ];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** An in-memory desk: the company's locations, catalogue and crews, a demonstration record, nothing sent. */
export function fakeInventoryDesk(options: FakeInventoryDeskOptions = {}): InventoryDesk {
  const facts = options.company ?? loadCompanyFacts();
  const catalog = companyData(facts, "supplyCatalog");
  const locations = companyData(facts, "inventory").locations;
  const clock = options.now ?? (() => new Date(DEMO_NOW));
  const today = (): string => localDate(clock(), facts.hours.timezone);

  const findLocation = (query: string): StockLocation => {
    const wanted = query.trim().toLowerCase();
    const location = locations.find(
      (candidate) => candidate.id === wanted || candidate.name.toLowerCase() === wanted,
    );
    if (location === undefined) {
      const known = locations.map((candidate) => `${candidate.id} (${candidate.name})`).join(", ");
      throw new InventoryDeskError(
        "not_found",
        `No stock location is ${JSON.stringify(query)}. The locations are: ${known}.`,
      );
    }
    return location;
  };

  const findItem = (id: string): SupplyItem => {
    const item = catalog.find((candidate) => candidate.id === id.trim());
    if (item === undefined) {
      throw new InventoryDeskError(
        "not_found",
        `No stocked item has the id ${JSON.stringify(id)}. Find it with list_stock_levels or count_sheet.`,
      );
    }
    return item;
  };

  const findCrew = (query: string) => {
    const wanted = query.trim().toLowerCase();
    const crew = companyData(facts, "crews").find(
      (candidate) => candidate.id === wanted || candidate.name.toLowerCase() === wanted,
    );
    if (crew === undefined) {
      const known = companyData(facts, "crews")
        .map((candidate) => `${candidate.id} (${candidate.name})`)
        .join(", ");
      throw new InventoryDeskError(
        "not_found",
        `No crew is ${JSON.stringify(query)}. The crews are: ${known}.`,
      );
    }
    return crew;
  };

  const wholeQuantity = (quantity: number, what: string, allowZero = false): void => {
    if (!Number.isInteger(quantity) || quantity < (allowZero ? 0 : 1)) {
      throw new InventoryDeskError(
        "invalid",
        `${String(quantity)} is not a quantity for ${what}: give a whole number of units${allowZero ? ", 0 or more" : ", 1 or more"}.`,
      );
    }
  };

  // On hand by location, then item. A location with no line for an item holds none of it.
  const stock = new Map<string, Map<string, number>>(
    locations.map((location) => [
      location.id,
      new Map(Object.entries((options.stock ?? demoStock())[location.id] ?? {})),
    ]),
  );
  const onHandOf = (locationId: string, itemId: string): number =>
    stock.get(locationId)?.get(itemId) ?? 0;
  const setOnHand = (locationId: string, itemId: string, quantity: number): void => {
    stock.get(locationId)?.set(itemId, quantity);
  };

  const holds: Mutable<StockHold>[] = (options.holds ?? demoHolds()).map((hold) => {
    const item = findItem(hold.itemId);
    return {
      ...hold,
      locationName: findLocation(hold.locationId).name,
      name: item.name,
      unit: item.unit,
      unitCostCents: item.unitCostCents,
      valueCents: hold.quantity * item.unitCostCents,
    };
  });
  const heldOf = (locationId: string, itemId: string): number =>
    holds
      .filter(
        (hold) =>
          hold.status === "held" && hold.locationId === locationId && hold.itemId === itemId,
      )
      .reduce((total, hold) => total + hold.quantity, 0);
  const availableOf = (locationId: string, itemId: string): number =>
    Math.max(0, onHandOf(locationId, itemId) - heldOf(locationId, itemId));

  const counts: Mutable<StockCount>[] = (options.counts ?? demoCounts()).map((count) => {
    const item = findItem(count.itemId);
    const counted = count.recount ?? count.firstCount;
    const confirmed = count.status !== "recount_needed";
    const variance = counted - count.recordedQuantity;
    return {
      ...count,
      locationName: findLocation(count.locationId).name,
      name: item.name,
      unit: item.unit,
      unitCostCents: item.unitCostCents,
      varianceQuantity: confirmed ? variance : null,
      varianceCents: confirmed ? Math.abs(variance) * item.unitCostCents : null,
    };
  });

  // Every write is remembered by its request id, refusals included, so a replayed call is answered
  // with what it already did and never writes twice.
  const replies = new Map<string, unknown>();
  const once = async <T>(requestId: string, write: () => T): Promise<T> => {
    if (replies.has(requestId)) {
      const prior = replies.get(requestId);
      if (prior instanceof InventoryDeskError) throw prior;
      return prior as T;
    }
    try {
      const result = write();
      replies.set(requestId, result);
      return result;
    } catch (error) {
      if (error instanceof InventoryDeskError) replies.set(requestId, error);
      throw error;
    }
  };
  let issueNumber = 0;
  let transferNumber = 0;

  const nextId = (prefix: string, ids: readonly string[], floor: number): string => {
    const highest = Math.max(floor, ...ids.map((id) => Number(id.replace(/\D/g, ""))));
    return `${prefix}-${highest + 1}`;
  };

  const snapshotCount = (count: Mutable<StockCount>): StockCount => ({ ...count });
  const snapshotHold = (hold: Mutable<StockHold>): StockHold => ({ ...hold });

  /** Refuses more than is available, saying how much is held, so a person sees why. */
  const requireAvailable = (location: StockLocation, item: SupplyItem, quantity: number): void => {
    const available = availableOf(location.id, item.id);
    if (quantity <= available) return;
    const held = heldOf(location.id, item.id);
    const heldText = held === 0 ? "" : `, of which ${held} held and not to be issued or moved`;
    throw new InventoryDeskError(
      "over_available",
      `${location.name} has ${available} available of ${item.name} (${item.unit}): ${onHandOf(location.id, item.id)} on hand${heldText}. ${quantity} is more than is available. Nothing was recorded.`,
    );
  };

  const reasonList = REASON_CODES.join(", ");

  return {
    async listStockLevels(locationId?: string): Promise<readonly StockLine[]> {
      const chosen = locationId === undefined ? locations : [findLocation(locationId)];
      return chosen.flatMap((location) =>
        catalog
          .filter((item) => stock.get(location.id)?.has(item.id) ?? false)
          .map((item) => ({
            locationId: location.id,
            locationName: location.name,
            itemId: item.id,
            name: item.name,
            unit: item.unit,
            onHand: onHandOf(location.id, item.id),
            held: heldOf(location.id, item.id),
            available: availableOf(location.id, item.id),
          })),
      );
    },

    async countSheet(locationId: string): Promise<CountSheet> {
      const location = findLocation(locationId);
      return {
        locationId: location.id,
        locationName: location.name,
        items: catalog
          .filter((item) => stock.get(location.id)?.has(item.id) ?? false)
          .map((item) => ({ itemId: item.id, name: item.name, unit: item.unit })),
        awaitingRecount: counts
          .filter((count) => count.locationId === location.id && count.status === "recount_needed")
          .map((count) => ({ id: count.id, itemId: count.itemId })),
      };
    },

    recordIssue(input, { requestId }) {
      return once(requestId, (): IssueReceipt => {
        const location = findLocation(input.locationId);
        const item = findItem(input.itemId);
        const crew = findCrew(input.crewId);
        wholeQuantity(input.quantity, item.name);
        if (input.source.trim() === "") {
          throw new InventoryDeskError(
            "invalid",
            "Say which message the request came from (source). Nothing was recorded.",
          );
        }
        requireAvailable(location, item, input.quantity);
        setOnHand(location.id, item.id, onHandOf(location.id, item.id) - input.quantity);
        issueNumber += 1;
        return {
          id: `ISS-${issueNumber}`,
          locationId: location.id,
          locationName: location.name,
          itemId: item.id,
          name: item.name,
          unit: item.unit,
          quantity: input.quantity,
          crewId: crew.id,
          crewName: crew.name,
          source: input.source.trim(),
          onHandAfter: onHandOf(location.id, item.id),
          availableAfter: availableOf(location.id, item.id),
          at: clock().toISOString(),
        };
      });
    },

    recordTransfer(input, { requestId }) {
      return once(requestId, (): TransferReceipt => {
        const from = findLocation(input.fromId);
        const to = findLocation(input.toId);
        const item = findItem(input.itemId);
        wholeQuantity(input.quantity, item.name);
        if (from.id === to.id) {
          throw new InventoryDeskError(
            "invalid",
            `${from.name} is both ends of the transfer: name two different locations. Nothing was recorded.`,
          );
        }
        if (input.source.trim() === "") {
          throw new InventoryDeskError(
            "invalid",
            "Say which message the transfer came from (source). Nothing was recorded.",
          );
        }
        requireAvailable(from, item, input.quantity);
        setOnHand(from.id, item.id, onHandOf(from.id, item.id) - input.quantity);
        setOnHand(to.id, item.id, onHandOf(to.id, item.id) + input.quantity);
        transferNumber += 1;
        return {
          id: `TRF-${transferNumber}`,
          itemId: item.id,
          name: item.name,
          unit: item.unit,
          quantity: input.quantity,
          fromId: from.id,
          fromName: from.name,
          toId: to.id,
          toName: to.name,
          fromAvailableAfter: availableOf(from.id, item.id),
          toOnHandAfter: onHandOf(to.id, item.id),
          source: input.source.trim(),
          at: clock().toISOString(),
        };
      });
    },

    recordCount(input, { requestId, stockAdjustmentLimitCents }) {
      // The role's resolved limit, as the tool read it for this call. None resolved is not "no limit".
      const limit =
        stockAdjustmentLimitCents !== undefined && Number.isFinite(stockAdjustmentLimitCents)
          ? stockAdjustmentLimitCents
          : null;
      return once(requestId, (): StockCount => {
        const location = findLocation(input.locationId);
        const item = findItem(input.itemId);
        wholeQuantity(input.countedQuantity, item.name, true);
        const countedBy = input.countedBy.trim();
        if (countedBy === "") {
          throw new InventoryDeskError(
            "invalid",
            "Say who counted (countedBy). Nothing was recorded.",
          );
        }
        if (input.reasonCode !== undefined && !REASON_CODES.includes(input.reasonCode)) {
          throw new InventoryDeskError(
            "invalid",
            `${JSON.stringify(input.reasonCode)} is not a reason code. Give one of: ${reasonList}. Nothing was recorded.`,
          );
        }
        const open = counts.filter(
          (count) =>
            count.locationId === location.id &&
            count.itemId === item.id &&
            (count.status === "recount_needed" || count.status === "unresolved"),
        );
        const waiting = open.find((count) => count.status === "unresolved");
        if (waiting !== undefined) {
          throw new InventoryDeskError(
            "count_waiting",
            `${waiting.id} already holds a confirmed difference for ${item.name} at ${location.name}, waiting for a person's approval, so another count changes nothing. Nothing was recorded.`,
            { countId: waiting.id },
          );
        }
        const recorded = onHandOf(location.id, item.id);
        const counted = input.countedQuantity;
        const variance = counted - recorded;
        const value = Math.abs(variance) * item.unitCostCents;
        const recountOf = open.find((count) => count.status === "recount_needed");

        if (recountOf === undefined) {
          // A first count: it closes when it agrees with the record, and otherwise changes nothing
          // until a recount confirms it.
          const count: Mutable<StockCount> = {
            id: nextId(
              "CNT",
              counts.map((entry) => entry.id),
              1000,
            ),
            locationId: location.id,
            locationName: location.name,
            itemId: item.id,
            name: item.name,
            unit: item.unit,
            unitCostCents: item.unitCostCents,
            recordedQuantity: recorded,
            firstCount: counted,
            recount: null,
            countedBy,
            recountedBy: null,
            varianceQuantity: variance === 0 ? 0 : null,
            varianceCents: variance === 0 ? 0 : null,
            status: variance === 0 ? "accurate" : "recount_needed",
            reasonCode: null,
            adjustedBy: null,
            countedOn: today(),
          };
          counts.push(count);
          return snapshotCount(count);
        }

        // A recount: its figure stands, against the record as it is now.
        const withinLimit = limit !== null && value <= limit;
        if (variance !== 0 && withinLimit && input.reasonCode === undefined) {
          throw new InventoryDeskError(
            "reason_needed",
            `The recount confirms ${counted} ${item.unit} of ${item.name} at ${location.name} against ${recorded} on the record, a difference worth ${money(value)} that can be adjusted, but every adjustment carries a reason code. Give one of: ${reasonList}. Nothing was recorded; ${recountOf.id} still waits for its recount.`,
          );
        }
        recountOf.recordedQuantity = recorded;
        recountOf.recount = counted;
        recountOf.recountedBy = countedBy;
        recountOf.varianceQuantity = variance;
        recountOf.varianceCents = value;
        recountOf.reasonCode = input.reasonCode ?? null;
        if (variance === 0) {
          recountOf.status = "accurate";
          recountOf.reasonCode = null;
        } else if (withinLimit) {
          recountOf.status = "adjusted";
          recountOf.adjustedBy = "limit";
          setOnHand(location.id, item.id, counted);
        } else {
          recountOf.status = "unresolved";
        }
        return snapshotCount(recountOf);
      });
    },

    async listCounts(filter = {}): Promise<readonly StockCount[]> {
      return counts
        .filter(
          (count) =>
            filter.id === undefined || count.id.toLowerCase() === filter.id.trim().toLowerCase(),
        )
        .map(snapshotCount);
    },

    applyAdjustment(input, { requestId }) {
      return once(requestId, (): StockCount => {
        const count = counts.find(
          (candidate) => candidate.id.toLowerCase() === input.countId.trim().toLowerCase(),
        );
        if (count === undefined) {
          throw new InventoryDeskError(
            "not_found",
            `No count has the id ${JSON.stringify(input.countId)}. Nothing was adjusted.`,
          );
        }
        if (count.status !== "unresolved") {
          throw new InventoryDeskError(
            "not_unresolved",
            `${count.id} is not a confirmed difference waiting for a person: it is ${count.status.replace("_", " ")}. Nothing was adjusted.`,
          );
        }
        if (!REASON_CODES.includes(input.reasonCode)) {
          throw new InventoryDeskError(
            "invalid",
            `${JSON.stringify(input.reasonCode)} is not a reason code. Give one of: ${reasonList}. Nothing was adjusted.`,
          );
        }
        if (!sameFacts(input.approved, countFacts(snapshotCount(count)))) {
          throw new InventoryDeskError(
            "count_changed",
            `${count.id} is not what the person approved: it changed after its facts were read. Nothing was adjusted.`,
          );
        }
        const now = onHandOf(count.locationId, count.itemId);
        if (now !== count.recordedQuantity) {
          throw new InventoryDeskError(
            "record_moved",
            `The record for ${count.name} at ${count.locationName} moved since ${count.id} was counted: it was ${count.recordedQuantity} and is now ${now}, so the approved adjustment no longer fits. Nothing was adjusted; count it again.`,
          );
        }
        setOnHand(count.locationId, count.itemId, count.recount ?? count.firstCount);
        count.status = "adjusted";
        count.adjustedBy = "approval";
        count.reasonCode = input.reasonCode;
        return snapshotCount(count);
      });
    },

    holdStock(input, { requestId }) {
      return once(requestId, (): StockHold => {
        const location = findLocation(input.locationId);
        const item = findItem(input.itemId);
        wholeQuantity(input.quantity, item.name);
        const reason = input.reason.trim();
        if (reason === "") {
          throw new InventoryDeskError(
            "invalid",
            "Say why the stock is held: damaged, defective, expired or under investigation. Nothing was held.",
          );
        }
        requireAvailable(location, item, input.quantity);
        const hold: Mutable<StockHold> = {
          id: nextId(
            "HOLD",
            holds.map((entry) => entry.id),
            0,
          ),
          locationId: location.id,
          locationName: location.name,
          itemId: item.id,
          name: item.name,
          unit: item.unit,
          quantity: input.quantity,
          reason,
          unitCostCents: item.unitCostCents,
          valueCents: input.quantity * item.unitCostCents,
          status: "held",
          heldOn: today(),
          writtenOffOn: null,
        };
        holds.push(hold);
        return snapshotHold(hold);
      });
    },

    async listHolds(filter = {}): Promise<readonly StockHold[]> {
      return holds
        .filter(
          (hold) =>
            filter.id === undefined || hold.id.toLowerCase() === filter.id.trim().toLowerCase(),
        )
        .map(snapshotHold);
    },

    writeOff(input, { requestId }) {
      return once(requestId, (): StockHold => {
        const hold = holds.find(
          (candidate) => candidate.id.toLowerCase() === input.holdId.trim().toLowerCase(),
        );
        if (hold === undefined) {
          throw new InventoryDeskError(
            "not_found",
            `No hold has the id ${JSON.stringify(input.holdId)}: only held stock can be written off. Hold it first with hold_stock. Nothing was written off.`,
          );
        }
        if (hold.status !== "held") {
          throw new InventoryDeskError(
            "not_held",
            `${hold.id} was already written off on ${hold.writtenOffOn ?? "an earlier day"}. Nothing was written off.`,
          );
        }
        if (!sameFacts(input.approved, holdFacts(snapshotHold(hold)))) {
          throw new InventoryDeskError(
            "hold_changed",
            `${hold.id} is not what the person approved: it changed after its facts were read. Nothing was written off.`,
          );
        }
        setOnHand(
          hold.locationId,
          hold.itemId,
          Math.max(0, onHandOf(hold.locationId, hold.itemId) - hold.quantity),
        );
        hold.status = "written_off";
        hold.writtenOffOn = today();
        return snapshotHold(hold);
      });
    },

    async reorderReport(): Promise<readonly ReorderLine[]> {
      return catalog
        .map((item) => ({
          itemId: item.id,
          name: item.name,
          unit: item.unit,
          available: locations.reduce(
            (total, location) => total + availableOf(location.id, item.id),
            0,
          ),
          reorderPoint: item.reorderPoint,
          reorderQuantity: item.reorderQuantity,
          supplierId: item.supplierId,
        }))
        .filter((line) => line.available <= line.reorderPoint);
    },

    async accuracyReport(): Promise<AccuracyReport> {
      const closed = counts.filter(
        (count) => count.status === "accurate" || count.status === "adjusted",
      );
      const accurate = closed.filter((count) => count.status === "accurate").length;
      const byReason = new Map<ReasonCode, { count: number; valueCents: number }>();
      for (const count of closed) {
        if (count.status !== "adjusted" || count.reasonCode === null) continue;
        const entry = byReason.get(count.reasonCode) ?? { count: 0, valueCents: 0 };
        entry.count += 1;
        entry.valueCents += count.varianceCents ?? 0;
        byReason.set(count.reasonCode, entry);
      }
      return {
        countsClosed: closed.length,
        countsAccurate: accurate,
        accuracyPercent: closed.length === 0 ? null : Math.round((accurate / closed.length) * 100),
        adjustments: REASON_CODES.filter((code) => byReason.has(code)).map((code) => ({
          reasonCode: code,
          count: byReason.get(code)?.count ?? 0,
          valueCents: byReason.get(code)?.valueCents ?? 0,
        })),
        openCounts: counts
          .filter((count) => count.status === "recount_needed" || count.status === "unresolved")
          .map((count) => count.id),
      };
    },
  };
}
