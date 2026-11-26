/**
 * Word and Excel, read through the pinned Paper worker. These need a provisioned interpreter and skip
 * visibly when `OFFICEHUM_PAPER_PYTHON` is unset, exactly as the Paper Office suites do; CI provisions
 * one, so they run there.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localVersionedFileStore, type VersionedFileStore } from "@officehum/sdk";
import {
  type DocumentService,
  localDocumentService,
  runLedger,
  subprocessPaperWorker,
} from "@officehum/tools-paper-office";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOfficeDocument } from "./office.js";
import { renderRead, searchDocument } from "./render.js";
import {
  configuredInterpreter,
  fixture,
  leasedInput,
  leaseOf,
  putFixture,
} from "./test-helpers.js";

const interpreter = configuredInterpreter();
const suite = interpreter === undefined ? describe.skip : describe;

if (interpreter === undefined) {
  console.warn(
    "document reading Word and Excel fixtures skipped: set OFFICEHUM_PAPER_PYTHON to a provisioned " +
      "Python 3.13 (see packages/tools-paper-office/scripts/provision-worker.sh).",
  );
}

let root = "";
let store: VersionedFileStore;
let service: DocumentService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "documents-office-"));
  store = localVersionedFileStore(join(root, "files"));
  service = localDocumentService({
    store,
    worker: subprocessPaperWorker({ interpreter: interpreter ?? "", graceSeconds: 30 }),
    ledger: runLedger(join(root, "ledger")),
    createdBy: "role:reading-desk",
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

suite("Word, through paper-docx", () => {
  it("reads the contract's headings, list, table and full clause text with section references", async () => {
    const ref = await putFixture(store, "contract.docx", "docx");
    const input = leasedInput(ref, "docx");
    const reading = await readOfficeDocument({
      service,
      lease: leaseOf([input]),
      input,
      taskId: "task:1",
      operationId: "conv:1:call-1",
    });
    expect(reading.kind).toBe("docx");
    expect(
      reading.sections?.map((section) => [section.number, section.heading, section.ref]),
    ).toEqual([
      [1, "Cleaning Services Agreement", "word/document.xml#0"],
      [2, "1. Parties", "word/document.xml#1"],
      [3, "2. Fees", "word/document.xml#3"],
      [4, "3. Term and termination", "word/document.xml#8"],
    ]);
    const fees = reading.sections?.[2]?.text ?? "";
    expect(fees).toContain("## 2. Fees");
    expect(fees).toContain("| Service | Monthly fee |");
    expect(fees).toContain("| Office cleaning | 1,200.00 |");
    expect(fees).toContain("- Invoices are due within 30 days.");
    // The clause is longer than the editing adapter's 400-character item cap, and arrives whole.
    expect(reading.sections?.[3]?.text).toContain("This clause survives the end of the agreement.");
    expect(reading.tables).toEqual([
      {
        name: "Table 1",
        location: "s. 3",
        rows: 3,
        columns: 2,
        cells: [
          ["Service", "Monthly fee"],
          ["Office cleaning", "1,200.00"],
          ["Window washing", "300.00"],
        ],
      },
    ]);
    expect(renderRead(reading, { name: "contract.docx" }).text).toContain(
      "[s. 3, word/document.xml#3]",
    );
    expect(searchDocument(reading, "window washing")).toEqual([
      { marker: "s. 3", passage: "| Window washing | 300.00 |" },
    ]);
  });

  it("leaves the source version unchanged", async () => {
    const bytes = fixture("contract.docx");
    const ref = await putFixture(store, "contract.docx", "docx");
    const input = leasedInput(ref, "docx");
    await readOfficeDocument({
      service,
      lease: leaseOf([input]),
      input,
      taskId: "task:1",
      operationId: "conv:1:call-2",
    });
    const after = await store.getVersion(ref.id, ref.versionId);
    expect(sha256(after?.bytes ?? new Uint8Array())).toBe(sha256(bytes));
    expect((await store.getHead(ref.id))?.versionId).toBe(ref.versionId);
  });
});

suite("a long Word document", () => {
  it("is read in several bounded runs, and a replay reruns none of them", async () => {
    let runs = 0;
    const worker = subprocessPaperWorker({ interpreter: interpreter ?? "", graceSeconds: 30 });
    const counting = localDocumentService({
      store,
      worker: {
        run(request) {
          runs += 1;
          return worker.run(request);
        },
      },
      ledger: runLedger(join(root, "ledger")),
      createdBy: "role:reading-desk",
    });
    // 400 paragraphs of about 200 characters: more than one run's bounded result can carry.
    const made = await counting.runDocumentPython({
      operationId: "make-long",
      taskId: "task:1",
      lease: { ...leaseOf([]), outputFormats: ["docx"] },
      code: [
        "import docx",
        "d = docx.Document()",
        "for i in range(400):",
        "    d.add_paragraph(f'Paragraph {i:03d}. ' + 'Lorem ipsum dolor sit amet. ' * 6)",
        "d.save(documents.declare_output('long.docx', 'docx'))",
        "documents.result({})",
      ].join("\n"),
      arguments: {},
    });
    if (made.kind !== "committed") throw new Error(`could not build the fixture: ${made.message}`);
    const output = made.receipt.outputs[0];
    const ref =
      output === undefined ? undefined : await store.getVersion(output.fileId, output.versionId);
    if (ref === undefined) throw new Error("the long fixture is missing");
    const input = leasedInput(ref.ref, "docx");
    const read = () =>
      readOfficeDocument({
        service: counting,
        lease: leaseOf([input]),
        input,
        taskId: "task:1",
        operationId: "conv:1:call-long",
      });
    runs = 0;
    const reading = await read();
    const text = reading.sections?.map((section) => section.text).join("\n\n") ?? "";
    expect(text).toContain("Paragraph 000.");
    expect(text).toContain("Paragraph 399.");
    expect(reading.metadata.blocks).toBe(400);
    expect(runs).toBeGreaterThan(1);
    const first = runs;
    expect(await read()).toEqual(reading);
    expect(runs).toBe(first);
  }, 60_000);
});

suite("Excel, through paper-xlsx", () => {
  it("reads both sheets with cell types, formulas and cached values kept apart", async () => {
    const ref = await putFixture(store, "price-list.xlsx", "xlsx");
    const input = leasedInput(ref, "xlsx");
    const reading = await readOfficeDocument({
      service,
      lease: leaseOf([input]),
      input,
      taskId: "task:1",
      operationId: "conv:1:call-3",
    });
    expect(reading.sheets?.map((sheet) => [sheet.name, sheet.dimensions])).toEqual([
      ["Prices", "A1:D5"],
      ["Notes", "A1:B3"],
    ]);
    const prices = reading.sheets?.[0];
    expect(prices?.cells.find((cell) => cell.address === "B2")).toMatchObject({
      type: "number",
      value: 4.5,
      formula: null,
      cached: null,
    });
    expect(prices?.cells.find((cell) => cell.address === "D5")).toMatchObject({
      type: "formula",
      value: null,
      formula: "=SUM(D2:D4)",
      cached: { type: "number", value: 449.25 },
    });
    expect(reading.sheets?.[1]?.cells.find((cell) => cell.address === "A3")).toMatchObject({
      type: "boolean",
      value: true,
    });
    expect(prices?.text).toContain("| Grand total |  |  | 449.25 (=SUM(D2:D4)) |");
    const notes = renderRead(reading, { name: "price-list.xlsx", sheet: "Notes" }).text;
    expect(notes).toContain("[sheet: Notes]");
    expect(notes).toContain("Northwind Supplies Ltd");
    expect(notes).not.toContain("[sheet: Prices]");
  });
});
