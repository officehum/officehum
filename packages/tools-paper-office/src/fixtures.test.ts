/**
 * The all-format fixtures, against a real interpreter: a docx, a pptx and an xlsx are created, saved
 * and read back **through the worker**, once with the service called directly (a bare Pi Durable
 * harness supplies the service) and once through the portable tool pack (Office Hum's shape).
 *
 * The two paths must produce equivalent receipts for the same operation ID, code, arguments and lease,
 * which is the design's portability gate. Skips visibly when no interpreter is configured.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localVersionedFileStore,
  type VersionedFileRef,
  type VersionedFileStore,
} from "@officehum/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocumentRunOutcome, DocumentService } from "./document-service.js";
import { type DocumentFormat, formatFromName, mimeTypeFor } from "./formats.js";
import { DEFAULT_LIMITS, type DocumentLease, type LeasedInput } from "./lease.js";
import { localDocumentService } from "./local-document-service.js";
import { subprocessPaperWorker } from "./paper-worker.js";
import { PPTX_TOOL_REGISTRATIONS } from "./pptx-tools.js";
import { paperOfficeToolPack, RUN_DOCUMENT_PYTHON } from "./run-document-python.js";
import type { DocumentRunReceipt } from "./run-ledger.js";
import { runLedger } from "./run-ledger.js";
import { configuredInterpreter } from "./test-helpers.js";
import { WORD_TOOL_REGISTRATIONS } from "./word-tools.js";
import { XLSX_TOOL_REGISTRATIONS } from "./xlsx-tools.js";

const interpreter = configuredInterpreter();
const suite = interpreter === undefined ? describe.skip : describe;

if (interpreter === undefined) {
  console.warn(
    "paper fixtures skipped: set OFFICEHUM_PAPER_PYTHON to provisioned Python 3.13 " +
      "(see packages/tools-paper-office/scripts/provision-worker.sh)",
  );
}

const ALL_THREE = [
  "import docx, openpyxl, pptx",
  "report = docx.Document()",
  "report.add_paragraph('Quarterly close checklist')",
  "report.add_paragraph('Reviewed by the office')",
  "report.save(documents.declare_output('report.docx', 'docx'))",
  "deck = pptx.Presentation()",
  "slide = deck.slides.add_slide(deck.slide_layouts[0])",
  "slide.shapes.title.text = 'Quarter close'",
  "deck.save(documents.declare_output('deck.pptx', 'pptx'))",
  "book = openpyxl.Workbook()",
  "sheet = book.active",
  "sheet['A1'] = 'Revenue'",
  "sheet['B1'] = 1250",
  "sheet['B2'] = '=B1*2'",
  "book.save(documents.declare_output('figures.xlsx', 'xlsx'))",
  "documents.result({",
  "  'docx': len(docx.Document(documents.staging() + '/report.docx').paragraphs),",
  "  'pptx': len(pptx.Presentation(documents.staging() + '/deck.pptx').slides),",
  "  'xlsx': openpyxl.load_workbook(documents.staging() + '/figures.xlsx').active['B1'].value,",
  "})",
].join("\n");

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paper-fixtures-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function serviceWith(store: VersionedFileStore, ledgerDir = join(root, "ledger")): DocumentService {
  return localDocumentService({
    store,
    worker: subprocessPaperWorker({ interpreter: interpreter ?? "", graceSeconds: 20 }),
    ledger: runLedger(ledgerDir),
    createdBy: "role:test",
  });
}

function committed(outcome: DocumentRunOutcome): DocumentRunReceipt {
  if (outcome.kind !== "committed") throw new Error(`expected a commit, got ${outcome.code}`);
  return outcome.receipt;
}

function leaseOf(
  refs: readonly VersionedFileRef[],
  formats: readonly DocumentFormat[] = ["docx", "pptx", "xlsx"],
): DocumentLease {
  const inputs: LeasedInput[] = refs.map((ref) => {
    const format = formatFromName(ref.name);
    if (format === undefined) throw new Error(`${ref.name} is not an Office file`);
    return {
      fileId: ref.id,
      versionId: ref.versionId,
      name: ref.name,
      format,
      sha256: ref.sha256,
      size: ref.size,
      writable: true,
    };
  });
  return {
    leaseId: "lease:fixture",
    taskId: "task:fixture",
    inputs,
    outputFormats: formats,
    limits: DEFAULT_LIMITS,
    expiresAt: "2999-01-01T00:00:00.000Z",
  };
}

async function refsOf(
  store: VersionedFileStore,
  receipt: DocumentRunReceipt,
): Promise<readonly VersionedFileRef[]> {
  const refs: VersionedFileRef[] = [];
  for (const output of receipt.outputs) {
    const stored = await store.getVersion(output.fileId, output.versionId);
    if (stored === undefined) throw new Error(`committed version ${output.versionId} is missing`);
    refs.push(stored.ref);
  }
  return refs;
}

suite("the Office Hum fixture runs all three libraries", () => {
  it("creates, saves and reads back a docx, a pptx and an xlsx through the worker", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const service = serviceWith(store);
    const receipt = committed(
      await service.runDocumentPython({
        operationId: "conv:fixture-all-three",
        taskId: "task:fixture",
        lease: leaseOf([]),
        code: ALL_THREE,
        arguments: {},
      }),
    );

    expect(receipt.outputs.map((output) => output.name).sort()).toEqual([
      "deck.pptx",
      "figures.xlsx",
      "report.docx",
    ]);
    expect(receipt.reopen).toEqual([
      "report.docx: 2 paragraphs",
      "deck.pptx: 1 slides",
      "figures.xlsx: 1 sheets",
    ]);
    expect(receipt.resultDeclared).toBe(true);
    expect(receipt.result).toMatchObject({ docx: 2, pptx: 1, xlsx: 1250 });
    expect(receipt.reads).toEqual([]);
    expect(receipt.worker.libraries.python).toMatch(/^3\.13\./);
    // The patch level of the interpreter is deliberately not pinned: `uv` resolves the newest 3.13,
    // and a test that names today's patch turns a routine upstream release into a red build. What
    // the contract requires is a 3.13 interpreter with exactly these three forks owning their module
    // names.
    expect(receipt.worker.libraries.python).toMatch(/^3\.13\./);
    expect(receipt.worker.libraries).toMatchObject({
      "paper-docx": "0.2.0",
      "paper-pptx": "0.2.0",
      "paper-xlsx": "0.2.1",
    });
    // Every output is a real Office package that survived the structural inspection.
    for (const output of receipt.outputs) {
      const stored = await store.getVersion(output.fileId, output.versionId);
      expect(stored?.bytes.byteLength).toBe(output.size);
      expect(stored?.ref.sha256).toBe(output.sha256);
    }
  });

  it("reads a committed version back through the worker in a later run", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const ledgerDir = join(root, "ledger");
    const first = committed(
      await serviceWith(store, ledgerDir).runDocumentPython({
        operationId: "conv:fixture-write",
        taskId: "task:fixture",
        lease: leaseOf([]),
        code: ALL_THREE,
        arguments: {},
      }),
    );
    const figures = first.outputs.find((output) => output.name === "figures.xlsx");
    const report = first.outputs.find((output) => output.name === "report.docx");
    expect(figures).toBeDefined();
    expect(report).toBeDefined();

    const second = committed(
      await serviceWith(store, ledgerDir).runDocumentPython({
        operationId: "conv:fixture-read",
        taskId: "task:fixture",
        lease: leaseOf(await refsOf(store, first)),
        code: [
          "import docx, openpyxl",
          "book = openpyxl.load_workbook(documents.open_input('figures.xlsx'), data_only=False)",
          "revenue = book.active['B1'].value",
          "report = docx.Document(documents.open_input('report.docx'))",
          "report.add_paragraph('Revenue: ' + str(revenue))",
          "report.save(documents.declare_output('report.docx', 'docx', edit_of='report.docx'))",
          "documents.result({'revenue': revenue, 'read': len(documents.inputs())})",
        ].join("\n"),
        arguments: {},
      }),
    );

    expect(second.result).toEqual({ revenue: 1250, read: 3 });
    // The lineage names what the run actually opened, not everything the lease permitted.
    expect(second.reads.map((entry) => entry.name).sort()).toEqual(["figures.xlsx", "report.docx"]);
    expect(second.outputs).toHaveLength(1);
    // The edit is a new immutable version of the same file, never an edit in place.
    expect(second.outputs[0]?.fileId).toBe(report?.fileId);
    expect(second.outputs[0]?.versionId).not.toBe(report?.versionId);
    const head = await store.getHead(second.outputs[0]?.fileId ?? "");
    expect(head?.versionId).toBe(second.outputs[0]?.versionId);
    expect(head?.sourceVersionId).not.toBeNull();
    expect(head?.metadata.derivedFrom).toBeDefined();
  });

  it("carries the lineage of a cross-format transformation", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const ledgerDir = join(root, "ledger");
    const first = committed(
      await serviceWith(store, ledgerDir).runDocumentPython({
        operationId: "conv:lineage-write",
        taskId: "task:fixture",
        lease: leaseOf([]),
        code: ALL_THREE,
        arguments: {},
      }),
    );
    const figures = first.outputs.find((output) => output.name === "figures.xlsx");
    if (figures === undefined) throw new Error("the fixture produced no spreadsheet");

    const second = committed(
      await serviceWith(store, ledgerDir).runDocumentPython({
        operationId: "conv:lineage-transform",
        taskId: "task:fixture",
        lease: leaseOf(await refsOf(store, first), ["docx"]),
        code: [
          "import docx, openpyxl",
          "book = openpyxl.load_workbook(documents.open_input('figures.xlsx'), data_only=False)",
          "value = book.active['B1'].value",
          "report = docx.Document()",
          "report.add_paragraph('Revenue: ' + str(value))",
          "report.save(documents.declare_output('revenue.docx', 'docx'))",
          "documents.result({'source': 'figures.xlsx'})",
        ].join("\n"),
        arguments: {},
      }),
    );

    const read = second.reads.find((entry) => entry.name === "figures.xlsx");
    expect(read).toBeDefined();
    expect(read?.format).toBe("xlsx");
    expect(read?.fileId).toBe(figures.fileId);
    const wrote = second.outputs[0];
    expect(wrote?.format).toBe("docx");
    expect(wrote?.sourceVersionId).toBeNull();
    expect(wrote?.fileId).not.toBe(figures.fileId);
    const stored = await store.info(wrote?.fileId ?? "");
    expect(stored?.mimeType).toBe(mimeTypeFor("docx"));
    expect(stored?.metadata.derivedFrom).toEqual([figures.fileId]);
  });
});

suite("the bare harness and Office Hum shapes agree", () => {
  it("gives equivalent receipts for the same operation through the service and the tool pack", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const service = serviceWith(store);
    const lease = leaseOf([]);
    const operationId = "conv:tool-call-1";

    const viaService = committed(
      await service.runDocumentPython({
        operationId,
        taskId: "task:fixture",
        lease,
        code: ALL_THREE,
        arguments: { note: "portability" },
      }),
    );

    const pack = paperOfficeToolPack({ service, leaseFor: async () => lease });
    const tool = pack.tools[0] as unknown as {
      execute(
        args: { code: string; arguments?: Record<string, unknown> },
        api: { taskId: string; conversationId: string; callId: string },
      ): Promise<{ output: { text: string }[]; isError?: boolean }>;
    };
    const viaTool = await tool.execute(
      { code: ALL_THREE, arguments: { note: "portability" } },
      { taskId: "task:fixture", conversationId: "conv", callId: "tool-call-1" },
    );

    const body = JSON.parse(viaTool.output[0]?.text ?? "{}") as {
      ok: boolean;
      operationId: string;
      wrote: { fileId: string; versionId: string; sha256: string }[];
    };
    expect(viaTool.isError).toBeUndefined();
    expect(body.ok).toBe(true);
    // The same tool call replayed through the pack returns the receipt the service already committed.
    expect(body.operationId).toBe(operationId);
    expect(body.wrote.map((output) => output.versionId).sort()).toEqual(
      viaService.outputs.map((output) => output.versionId).sort(),
    );
    // The pack now carries the typed Word, PowerPoint and Excel tools beside the Python workspace;
    // the workspace comes first.
    expect(pack.tools[0]?.name).toBe(RUN_DOCUMENT_PYTHON);
    expect(pack.tools.map((item) => item.name)).toEqual([
      RUN_DOCUMENT_PYTHON,
      ...WORD_TOOL_REGISTRATIONS,
      ...PPTX_TOOL_REGISTRATIONS,
      ...XLSX_TOOL_REGISTRATIONS,
    ]);
  });
});
