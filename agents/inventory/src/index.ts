/**
 * The Inventory and Warehouse role's entry point: the factory a host calls to get the role.
 *
 * ```ts
 * import inventory from "@officehum/inventory";
 *
 * const role = inventory({ desk: myStockSystem, approve, overlays: ["./my-inventory"] });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 *
 * The package brings its own prompt, skills, tools, the company's facts and a demonstration stock
 * record; the host brings the desk that holds its real stock and, optionally, the person who decides
 * gated actions. Nothing here needs Office Hum, so the same bundle runs in a bare Pi Durable harness.
 *
 * With `demo: true` and no desk the role runs on `fakeInventoryDesk`: the company's own locations,
 * catalogue and crews, a stock record with counts in flight and one hold, in memory, and nothing sent
 * anywhere. That is what `officehum run --demo` and the evals run on. With neither, the role still
 * starts, and every tool that reads or writes the desk refuses and says how to bind one.
 */

import { fileURLToPath } from "node:url";
import { type Approver, type DefinedRole, declaredFacts, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import { DEMO_NOW, fakeInventoryDesk, type InventoryDesk } from "./desk.js";
import { deskIdReplyCheck } from "./reply-check.js";
import { inventoryTools } from "./tools.js";

export {
  COMPANY_FACTS_URL,
  type CompanyFacts,
  type Crew,
  countsOwner,
  type InventorySettings,
  loadCompanyFacts,
  money,
  type Person,
  person,
  personLabel,
  type StockLocation,
  type SupplyItem,
  writeOffApprover,
} from "./company.js";
export {
  type AccuracyReport,
  type CountSheet,
  type CountStatus,
  countFacts,
  DEMO_NOW,
  type DeskRefusal,
  demoCounts,
  demoHolds,
  demoStock,
  type FakeInventoryDeskOptions,
  fakeInventoryDesk,
  type HoldStockInput,
  holdFacts,
  type InventoryDesk,
  InventoryDeskError,
  type IssueReceipt,
  REASON_CODES,
  type ReasonCode,
  type RecordCountInput,
  type RecordIssueInput,
  type RecordTransferInput,
  type ReorderLine,
  type StockCount,
  type StockHold,
  type StockLine,
  type TransferReceipt,
} from "./desk.js";
export { deskIdReplyCheck, deskIds } from "./reply-check.js";
export {
  type CompanySection,
  type InventoryToolDependencies,
  type InventoryToolset,
  inventoryTools,
  STOCK_ADJUSTMENT_LIMIT,
} from "./tools.js";

export interface InventoryOptions {
  /**
   * The host's stock system: inventory or warehouse software in production, `fakeInventoryDesk` in a
   * test. Omitted, the demonstration record when `demo` is set; otherwise none, and every desk tool
   * refuses.
   */
  readonly desk?: InventoryDesk;
  /**
   * Run on the demonstration record this package ships with when no `desk` is given. Set by the host
   * (`officehum run --demo`, the eval runner), never by a client or a user's config.
   */
  readonly demo?: boolean;
  /** The company to keep stock for. Omitted, the generated facts in this package. */
  readonly company?: CompanyFacts;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /** Decides every gated action. Omitted: a large adjustment and every write-off are blocked. */
  readonly approve?: Approver;
  /**
   * The host's clock. The prompt's `today` section and the demonstration desk read it. Omitted: the
   * demonstration date (`DEMO_NOW`) on the demonstration desk, the system clock otherwise.
   */
  readonly now?: () => Date;
}

export default function inventory(options: InventoryOptions = {}): DefinedRole {
  const demoDesk = options.desk === undefined && options.demo === true;
  const now = options.now ?? (demoDesk ? () => new Date(DEMO_NOW) : () => new Date());
  const company = options.company ?? loadCompanyFacts();
  const desk = demoDesk ? fakeInventoryDesk({ company, now }) : options.desk;
  // The adjustment limit is read from the role's own resolved limits at every call, so an overlay's
  // value is what a count is judged against and a reload needs no rebuild. Before the role exists no
  // limit resolves, and the desk then holds every confirmed difference for a person.
  let role: DefinedRole | undefined;
  const limits = () => role?.current().limits ?? {};
  const tools = inventoryTools({ desk, company, limits });
  role = defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    now,
    timeZone: company.hours.timezone,
    tools: [
      tools.listStockLevels,
      tools.countSheet,
      tools.recordIssue,
      tools.recordTransfer,
      tools.recordCount,
      tools.requestAdjustmentApproval,
      tools.holdStock,
      tools.requestWriteOff,
      tools.reorderReport,
      tools.accuracyReport,
      tools.readCompany,
    ],
    // Both approvals are `officehum.json`'s, on every call of their tool. The model names the count or
    // the hold; the gate reads what the person approves from the desk and hands it to the tool on a
    // yes, and the desk writes only what they saw.
    approvalFacts: {
      stock_adjustment: declaredFacts(
        [
          "id",
          "locationId",
          "itemId",
          "recordedQuantity",
          "countedQuantity",
          "varianceQuantity",
          "varianceCents",
        ],
        tools.adjustmentApprovalFacts,
      ),
      write_off: declaredFacts(
        ["id", "locationId", "itemId", "quantity", "reason", "unitCostCents", "valueCents"],
        tools.writeOffApprovalFacts,
      ),
    },
    // A count or hold id named only in a reply reaches no tool; this checks it against the desk.
    hooks: [deskIdReplyCheck(desk)],
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
  return role;
}
