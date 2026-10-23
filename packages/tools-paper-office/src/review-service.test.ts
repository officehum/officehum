/**
 * Review evidence produced by the real adapters, through a real worker.
 *
 * The gate's evidence must come from the format adapters themselves, not from a second differ written
 * for review. This suite creates a Word, a PowerPoint and an Excel file through the pinned worker,
 * edits each into a proposed version, and asks `reviewEvidenceFromService` for the evidence a person
 * would review. It needs the provisioned Python 3.13 interpreter and skips visibly without one.
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
import type { DocumentService } from "./document-service.js";
import { type DocumentFormat, formatFromName } from "./formats.js";
import { DEFAULT_LIMITS, type DocumentLease, type LeasedInput } from "./lease.js";
import { localDocumentService } from "./local-document-service.js";
import { subprocessPaperWorker } from "./paper-worker.js";
import { reviewEvidenceFromService, reviewLeaseInputs } from "./review-service.js";
import { runLedger } from "./run-ledger.js";
import { configuredInterpreter } from "./test-helpers.js";

const interpreter = configuredInterpreter();
const suite = interpreter === undefined ? describe.skip : describe;

if (interpreter === undefined) {
  console.warn(
    "paper review evidence skipped: set OFFICEHUM_PAPER_PYTHON to provisioned Python 3.13 " +
      "(see packages/tools-paper-office/scripts/provision-worker.sh)",
  );
}

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paper-review-evidence-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function serviceWith(store: VersionedFileStore): DocumentService {
  return localDocumentService({
    store,
    worker: subprocessPaperWorker({ interpreter: interpreter ?? "", graceSeconds: 20 }),
    ledger: runLedger(join(root, "ledger")),
    createdBy: "role:test",
  });
}

function leaseOf(
  refs: readonly VersionedFileRef[],
  formats: readonly DocumentFormat[],
  writable = false,
): DocumentLease {
  const staged = refs.map((ref) => {
    const format = formatFromName(ref.name);
    if (format === undefined) throw new Error(`${ref.name} is not an Office file`);
    return {
      fileId: ref.id,
      versionId: ref.versionId,
      name: ref.name,
      format,
      sha256: ref.sha256,
      size: ref.size,
      writable,
    } satisfies LeasedInput;
  });
  // Two versions of one file share a name; the worker stages by name, so derive a distinct one.
  const first = staged[0];
  const second = staged[1];
  const inputs =
    first !== undefined && second !== undefined && first.name === second.name
      ? reviewLeaseInputs(first, second)
      : staged;
  return {
    leaseId: "lease:review",
    taskId: "task:review",
    inputs,
    outputFormats: formats,
    limits: DEFAULT_LIMITS,
    expiresAt: "2999-01-01T00:00:00.000Z",
  };
}

async function refOf(store: VersionedFileStore, fileId: string, versionId: string) {
  const stored = await store.getVersion(fileId, versionId);
  if (stored === undefined) throw new Error(`version ${versionId} is missing`);
  return stored.ref;
}

async function createThenEdit(
  service: DocumentService,
  store: VersionedFileStore,
  format: DocumentFormat,
  name: string,
  createCode: string,
  editCode: string,
) {
  const created = await service.runDocumentPython({
    operationId: `${format}:create`,
    taskId: "task:review",
    lease: leaseOf([], [format]),
    code: createCode,
    arguments: {},
  });
  if (created.kind !== "committed") throw new Error(`create refused: ${created.message}`);
  const first = created.receipt.outputs[0];
  if (first === undefined) throw new Error("create committed no output");
  const v1 = await refOf(store, first.fileId, first.versionId);

  const edited = await service.runDocumentPython({
    operationId: `${format}:edit`,
    taskId: "task:review",
    lease: leaseOf([v1], [format], true),
    code: editCode,
    arguments: {},
  });
  if (edited.kind !== "committed") throw new Error(`edit refused: ${edited.message}`);
  const second = edited.receipt.outputs[0];
  if (second === undefined) throw new Error("edit committed no output");
  const v2 = await refOf(store, second.fileId, second.versionId);
  expect(v2.id).toBe(v1.id);
  expect(v2.sourceVersionId).toBe(v1.versionId);
  expect(v2.sha256).not.toBe(v1.sha256);
  return { v1, v2, name };
}

suite("review evidence from the real adapters", () => {
  it("produces Word review evidence from a real docx pair", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const service = serviceWith(store);
    const { v1, v2 } = await createThenEdit(
      service,
      store,
      "docx",
      "brief.docx",
      [
        "import docx",
        "document = docx.Document()",
        "document.add_heading('Quarterly close', level=1)",
        "document.add_paragraph('Revenue was 1250 dollars.')",
        "document.save(documents.declare_output('brief.docx', 'docx'))",
        "documents.result({'paragraphs': len(docx.Document(documents.staging() + '/brief.docx').paragraphs)})",
      ].join("\n"),
      [
        "import docx",
        "document = docx.Document(documents.open_input('brief.docx'))",
        "document.add_paragraph('Reviewed by the office.')",
        "document.save(documents.declare_output('brief.docx', 'docx', edit_of='brief.docx'))",
        "documents.result({'added': 1})",
      ].join("\n"),
    );

    const evidence = await reviewEvidenceFromService(service, {
      operationId: "review:compare:docx",
      taskId: "task:review",
      lease: leaseOf([v1, v2], ["docx"]),
      sourceVersionId: v1.versionId,
      proposedVersionId: v2.versionId,
      format: "docx",
    });
    if (!evidence.ok) throw new Error(`compare refused: ${evidence.code}: ${evidence.message}`);
    expect(evidence.value.format).toBe("docx");
    expect(evidence.value.validation.deterministic).toBe(true);
    expect(evidence.value.sources.from).toEqual({ versionId: v1.versionId, sha256: v1.sha256 });
    expect(evidence.value.sources.to).toEqual({ versionId: v2.versionId, sha256: v2.sha256 });
    expect(evidence.value.changeSet.changed.length).toBeGreaterThan(0);
    expect(evidence.value.validation.checks.every((entry) => entry.ok)).toBe(true);
    expect(evidence.value.limitations.length).toBeGreaterThan(0);

    // A lease that does not grant the proposed version cannot be compared.
    const ungranted = await reviewEvidenceFromService(service, {
      operationId: "review:compare:docx:ungranted",
      taskId: "task:review",
      lease: leaseOf([v1], ["docx"]),
      sourceVersionId: v1.versionId,
      proposedVersionId: v2.versionId,
      format: "docx",
    });
    expect(ungranted.ok).toBe(false);
    if (!ungranted.ok) expect(ungranted.code).toBe("ungranted-input");
  });

  it("produces PowerPoint review evidence from a real pptx pair", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const service = serviceWith(store);
    const { v1, v2 } = await createThenEdit(
      service,
      store,
      "pptx",
      "deck.pptx",
      [
        "import pptx",
        "deck = pptx.Presentation()",
        "slide = deck.slides.add_slide(deck.slide_layouts[0])",
        "slide.shapes.title.text = 'Quarter close'",
        "deck.save(documents.declare_output('deck.pptx', 'pptx'))",
        "documents.result({'slides': len(pptx.Presentation(documents.staging() + '/deck.pptx').slides)})",
      ].join("\n"),
      [
        "import pptx",
        "deck = pptx.Presentation(documents.open_input('deck.pptx'))",
        "deck.slides[0].shapes.title.text = 'Quarter close (revised)'",
        "deck.save(documents.declare_output('deck.pptx', 'pptx', edit_of='deck.pptx'))",
        "documents.result({'slides': len(pptx.Presentation(documents.staging() + '/deck.pptx').slides)})",
      ].join("\n"),
    );

    const evidence = await reviewEvidenceFromService(service, {
      operationId: "review:compare:pptx",
      taskId: "task:review",
      lease: leaseOf([v1, v2], ["pptx"]),
      sourceVersionId: v1.versionId,
      proposedVersionId: v2.versionId,
      format: "pptx",
    });
    if (!evidence.ok) throw new Error(`compare refused: ${evidence.code}: ${evidence.message}`);
    expect(evidence.value.format).toBe("pptx");
    expect(evidence.value.diff.kind).toBe("pptx-slide-diff");
    expect(evidence.value.preview.kind).toBe("pptx-changed-slides");
    expect(evidence.value.validation.checks.every((entry) => entry.ok)).toBe(true);
    expect(evidence.value.limitations.join(" ")).toMatch(/bitmap is false/u);
  });

  it("produces Excel review evidence from a real xlsx pair", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const service = serviceWith(store);
    const { v1, v2 } = await createThenEdit(
      service,
      store,
      "xlsx",
      "figures.xlsx",
      [
        "import openpyxl",
        "book = openpyxl.Workbook()",
        "sheet = book.active",
        "sheet['A1'] = 'Revenue'",
        "sheet['B1'] = 1250",
        "sheet['B3'] = '=SUM(B1:B2)'",
        "book.save(documents.declare_output('figures.xlsx', 'xlsx'))",
        "documents.result({})",
      ].join("\n"),
      [
        "import openpyxl",
        "book = openpyxl.load_workbook(documents.open_input('figures.xlsx'))",
        "sheet = book.active",
        "sheet['B1'] = 1300",
        "book.save(documents.declare_output('figures.xlsx', 'xlsx', edit_of='figures.xlsx'))",
        "documents.result({})",
      ].join("\n"),
    );

    const evidence = await reviewEvidenceFromService(service, {
      operationId: "review:compare:xlsx",
      taskId: "task:review",
      lease: leaseOf([v1, v2], ["xlsx"]),
      sourceVersionId: v1.versionId,
      proposedVersionId: v2.versionId,
      format: "xlsx",
    });
    if (!evidence.ok) throw new Error(`compare refused: ${evidence.code}: ${evidence.message}`);
    expect(evidence.value.format).toBe("xlsx");
    expect(evidence.value.diff.kind).toBe("xlsx-cell-diff");
    expect(evidence.value.validation.checks.every((entry) => entry.ok)).toBe(true);
    expect(
      evidence.value.validation.checks.find((entry) => entry.name === "recalculation-not-computed")
        ?.ok,
    ).toBe(true);
    expect(evidence.value.limitations.join(" ")).toMatch(/no-recalculation/u);
  });
});
