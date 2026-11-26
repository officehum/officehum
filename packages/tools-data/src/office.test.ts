/**
 * Excel in and out, through the pinned Paper worker. These need a provisioned interpreter and skip
 * visibly when `OFFICEHUM_PAPER_PYTHON` is unset, exactly as the Paper Office suites do; CI provisions
 * one, so they run there.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localVersionedFileStore, type VersionedFileStore } from "@officehum/sdk";
import {
  type DocumentLease,
  type DocumentService,
  localDocumentService,
  runLedger,
  subprocessPaperWorker,
} from "@officehum/tools-paper-office";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_EXPORT, DATA_INSPECT, DATA_QUERY } from "./definitions.js";
import { dataPack } from "./pack.js";
import {
  callTool,
  configuredInterpreter,
  leasedInput,
  leaseOf,
  putFile,
  tableRows,
} from "./test-helpers.js";

const interpreter = configuredInterpreter();
const suite = interpreter === undefined ? describe.skip : describe;

if (interpreter === undefined) {
  console.warn(
    "data pack Excel tests skipped: set OFFICEHUM_PAPER_PYTHON to a provisioned Python 3.13 " +
      "(see packages/tools-paper-office/scripts/provision-worker.sh).",
  );
}

let root = "";
let store: VersionedFileStore;
let service: DocumentService;
let lease: DocumentLease;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "data-office-"));
  store = localVersionedFileStore(join(root, "files"));
  service = localDocumentService({
    store,
    worker: subprocessPaperWorker({ interpreter: interpreter ?? "", graceSeconds: 30 }),
    ledger: runLedger(join(root, "ledger")),
    createdBy: "role:data-desk",
  });
  lease = leaseOf([]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const pack = () =>
  dataPack({
    filesFor: async () => store,
    leaseFor: async () => lease,
    service,
    createdBy: "role:data-desk",
  });

suite("Excel through the Paper worker", () => {
  it("reconciles a bank CSV against an open-invoices workbook by amount and reference", async () => {
    const bank = await putFile(store, "bank-statement.csv");
    const workbook = await putFile(store, "open-invoices.xlsx");
    lease = leaseOf([leasedInput(workbook)]);
    const inspected = await callTool(pack(), DATA_INSPECT, {
      file_id: workbook.id,
      sheet: "Open invoices",
    });
    expect(inspected.text).toContain("10 rows, 5 columns.");
    expect(inspected.text).toContain("| amount | DECIMAL(38,6) | 0 |");

    const matched = await callTool(pack(), DATA_QUERY, {
      tables: [
        { name: "bank", file_id: bank.id },
        { name: "invoices", file_id: workbook.id },
      ],
      sql: [
        "SELECT i.invoice_number, b.amount FROM invoices i JOIN bank b",
        "  ON b.amount = i.amount AND strpos(b.description, i.invoice_number) > 0",
        "ORDER BY i.invoice_number",
      ].join("\n"),
    });
    expect(tableRows(matched.text).slice(1)).toEqual([
      ["INV-1001", "1250.000000"],
      ["INV-1002", "480.500000"],
      ["INV-1006", "156.200000"],
      ["INV-1008", "1999.990000"],
      ["INV-1009", "899.000000"],
    ]);
  }, 60_000);

  it("names the sheets when the one asked for is not there", async () => {
    const workbook = await putFile(store, "open-invoices.xlsx");
    lease = leaseOf([leasedInput(workbook)]);
    const result = await callTool(pack(), DATA_INSPECT, { file_id: workbook.id, sheet: "Paid" });
    expect(result.details.code).toBe("not-found");
    expect(result.text).toContain("its sheets are Open invoices");
  }, 60_000);

  it("exports a query as a new .xlsx draft with numbers as numbers", async () => {
    const bank = await putFile(store, "bank-statement.csv");
    const exported = await callTool(pack(), DATA_EXPORT, {
      tables: [{ name: "bank", file_id: bank.id }],
      sql: "SELECT description, amount FROM bank WHERE amount < 0 ORDER BY date",
      format: "xlsx",
      name: "outgoings",
    });
    expect(exported.isError).toBeUndefined();
    const [fileId] = exported.details.files as string[];
    const ref = await store.info(fileId ?? "");
    if (ref === undefined) throw new Error("the export was not saved");
    expect(ref.name).toBe("outgoings.xlsx");

    lease = leaseOf([leasedInput(ref)]);
    const back = await callTool(pack(), DATA_QUERY, {
      tables: [{ name: "outgoings", file_id: fileId ?? "" }],
      sql: "SELECT sum(amount) AS total, typeof(sum(amount)) AS type FROM outgoings",
    });
    expect(tableRows(back.text)[1]).toEqual(["-3080.980000", "DECIMAL(38,6)"]);
  }, 60_000);
});
