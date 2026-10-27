/**
 * RASF-3286 — the all-format portability and crash-recovery acceptance gate.
 *
 * This is the enablement gate the Paper design names (`docs/superpowers/specs/2026-10-14-paper-instruments-integration-design.md`),
 * not another adapter implementation. It composes one end-to-end proof that the pack is safe to roll
 * out across Office Hum roles on Pi Durable:
 *
 *  1. A cross-format fixture workflow — read an Excel workbook, compute exact figures in code, write a
 *     Word report and a PowerPoint deck, edit the existing workbook into a proposal, and publish that
 *     proposal only after an exact-version human review — run against a real Python 3.13 worker.
 *  2. The five-point crash/replay matrix: before staging, after staging but before the FileStore
 *     receipt, after the receipt but before Pi Durable settlement, during a pending approval, and after
 *     an approved publish but before the tool result — each asserting one committed version, no
 *     duplicated edit, an unchanged source on refusal, and a resumable task.
 *  3. The reopen/rewrite disclosure: Word reopens, PowerPoint has no bitmap renderer and says so, Excel
 *     computes nothing and says so; worker and library versions, hashes, lineage and numeric checks are
 *     recorded in the receipts, and a rubric can never approve.
 *
 * The durable lifecycle (the crash matrix and the review gate) is exercised against the real FileStore,
 * run ledger and review ledger with scripted workers, so it runs without an interpreter and without a
 * network or a model. The cross-format and disclosure blocks need the provisioned Python 3.13 worker
 * and skip visibly without it. The remaining adversarial dimensions (unleased file id, path traversal,
 * symlink, network, credentials, corrupt/oversize archives, external relationships, formula/reference
 * damage, partial tool arguments, provider stream interruption, concurrent published-version change)
 * are each pinned by name in their dedicated suites — `paper-worker`, `ooxml`, `lease`,
 * `local-document-service`, the per-format fixture suites and `provider-paper` — which `npm run check`
 * runs; the concurrent published-version change is also asserted here, on the publication gate itself.
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
import { DocumentError } from "./errors.js";
import { type DocumentFormat, formatFromName } from "./formats.js";
import { DEFAULT_LIMITS, type DocumentLease, type LeasedInput } from "./lease.js";
import { localDocumentService } from "./local-document-service.js";
import { POLICY_VERSION } from "./operation.js";
import { subprocessPaperWorker } from "./paper-worker.js";
import { INSPECT_PRESENTATION, type PptxInspection } from "./pptx-operations.js";
import {
  publicationGate,
  type ReviewArtifact,
  type ReviewIdentity,
  reviewLedger,
} from "./review.js";
import { type ReviewEvidence, reviewEvidenceFromWord, withRubric } from "./review-evidence.js";
import { reviewEvidenceFromService, reviewLeaseInputs } from "./review-service.js";
import { paperOfficeToolPack } from "./run-document-python.js";
import { type DocumentRunReceipt, type RunLedger, runLedger } from "./run-ledger.js";
import {
  configuredInterpreter,
  crashingWorker,
  declaredOutput,
  docxPackage,
  fakeWorker,
  type RecordingWorker,
} from "./test-helpers.js";
import { INSPECT_DOCUMENT, type WordInspection } from "./word-operations.js";
import { INSPECT_WORKBOOK, type XlsxInspection } from "./xlsx-operations.js";

const interpreter = configuredInterpreter();
const suite = interpreter === undefined ? describe.skip : describe;

if (interpreter === undefined) {
  console.warn(
    "all-format acceptance (real worker) skipped: set OFFICEHUM_PAPER_PYTHON to a provisioned " +
      "Python 3.13 (see packages/tools-paper-office/scripts/provision-worker.sh). The crash matrix " +
      "and the review gate still run.",
  );
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paper-acceptance-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// -- helpers shared across both halves -----------------------------------------------------------

function committed(outcome: DocumentRunOutcome): DocumentRunReceipt {
  if (outcome.kind !== "committed") {
    throw new Error(`expected a commit, got ${outcome.code}: ${outcome.message}`);
  }
  return outcome.receipt;
}

function refused(outcome: DocumentRunOutcome): { code: string; message: string } {
  if (outcome.kind !== "refused") throw new Error("expected a refusal, got a commit");
  return { code: outcome.code, message: outcome.message };
}

function leaseOf(
  refs: readonly VersionedFileRef[],
  formats: readonly DocumentFormat[],
  writable = true,
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
      writable,
    };
  });
  return {
    leaseId: "lease:acceptance",
    taskId: "task:acceptance",
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

async function seededDocx(store: VersionedFileStore): Promise<VersionedFileRef> {
  return await store.put({
    bytes: docxPackage(),
    name: "brief.docx",
    mimeType: DOCX_MIME,
    metadata: { createdBy: "host", source: "uploaded" },
  });
}

// -- the five-point crash/replay matrix (no interpreter, scripted workers) -----------------------

/**
 * A ledger that writes a plan and then dies, standing in for a host crash *after* the worker staged
 * its output and the plan became durable, but *before* the FileStore commit. See the design's step 4:
 * "a crash with only staging files either validates and commits the exact bound output or discards
 * staging and re-executes against the same pinned source under the same ID."
 */
function crashingAfterPlan(inner: RunLedger): RunLedger {
  return {
    ...inner,
    async write(record) {
      await inner.write(record);
      if (record.kind === "plan") {
        throw new Error("simulated crash after staging, before the FileStore receipt");
      }
    },
  };
}

/** A store that lands the commit and then dies, standing in for a host crash before the receipt. */
function crashAfterCommit(store: VersionedFileStore): VersionedFileStore {
  const die = (): never => {
    throw new DocumentError("incomplete-run", "the host died after the commit, before the receipt");
  };
  return {
    ...store,
    async create(input) {
      await store.create(input);
      return die();
    },
    async putVersion(input) {
      await store.putVersion(input);
      return die();
    },
  };
}

/** A published v1 with a proposed v2, as the review gate needs an existing business file. */
async function fileWithProposal(
  store: VersionedFileStore,
  firstMarker: string,
  secondMarker: string,
) {
  const created = await store.create({
    operationId: `acceptance:create:${firstMarker}`,
    bytes: docxBytes(firstMarker),
    name: "report.docx",
    mimeType: DOCX_MIME,
    metadata: { createdBy: "role:test", source: "generated" },
    context: CONTEXT,
  });
  await store.publish({
    operationId: `acceptance:seed:${firstMarker}`,
    fileId: created.output.id,
    expectedPublishedVersionId: null,
    versionId: created.output.versionId,
    approvalId: "seed",
  });
  const edited = await store.putVersion({
    operationId: `acceptance:edit:${secondMarker}`,
    fileId: created.output.id,
    sourceVersionId: created.output.versionId,
    bytes: docxBytes(secondMarker),
    name: "report.docx",
    mimeType: DOCX_MIME,
    metadata: { createdBy: "role:test", source: "derived" },
    context: CONTEXT,
  });
  return {
    fileId: created.output.id,
    source: created.output,
    proposed: edited.output,
  };
}

function docxBytes(marker: string): Uint8Array {
  return Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(marker)]);
}

const CONTEXT = {
  taskId: "task:acceptance",
  policyVersion: POLICY_VERSION,
  worker: { image: "paper-worker:python-3.13.17", libraries: { "paper-docx": "0.2.0" } },
  argumentsSha256: "a".repeat(64),
};

function artifactOf(ref: VersionedFileRef, name: string): ReviewArtifact {
  return {
    fileId: ref.id,
    versionId: ref.versionId,
    name,
    format: "docx",
    sha256: ref.sha256,
    size: ref.size,
  };
}

function identityOf(proposal: Awaited<ReturnType<typeof fileWithProposal>>): ReviewIdentity {
  return {
    fileId: proposal.fileId,
    name: "report.docx",
    format: "docx",
    source: artifactOf(proposal.source, "report.docx"),
    proposed: artifactOf(proposal.proposed, "report.docx"),
  };
}

function wordEvidence(
  proposal: Awaited<ReturnType<typeof fileWithProposal>>,
  changedText: string,
): ReviewEvidence {
  const ref = (versionId: string, sha256: string, size: number) => ({
    fileId: proposal.fileId,
    versionId,
    name: "report.docx",
    sha256,
    size,
  });
  return reviewEvidenceFromWord({
    operation: "compare",
    sources: {
      from: ref(proposal.source.versionId, proposal.source.sha256, proposal.source.size),
      to: ref(proposal.proposed.versionId, proposal.proposed.sha256, proposal.proposed.size),
    },
    changeSet: {
      schema: "paper_word_change_set",
      version: 1,
      added: [],
      removed: [],
      changed: [
        {
          part: "word/document.xml",
          kind: "text",
          beforeSha256: proposal.source.sha256,
          afterSha256: proposal.proposed.sha256,
          semanticChange: true,
        },
      ],
      byteIdenticalCount: 3,
      semanticallyEmpty: false,
    },
    diff: {
      schema: "paper_word_diff",
      version: 1,
      changedLineCount: 1,
      stories: [
        {
          story: "word/document.xml",
          diffLines: ["-old total", `+${changedText}`],
          omittedLines: 0,
        },
      ],
      truncated: false,
    },
    redline: {
      schema: "paper_word_redline",
      version: 1,
      insertedBlocks: 1,
      deletedBlocks: 0,
      entries: [
        {
          story: "word/document.xml",
          kind: "insert",
          index: 0,
          marker: "+",
          text: changedText,
          truncated: false,
        },
      ],
      total: 1,
      truncated: false,
      pendingChangedLineCount: 1,
      pendingLines: [`+${changedText}`],
    },
    identical: false,
  });
}

async function publishedPointer(store: VersionedFileStore, fileId: string): Promise<string | null> {
  return (await store.getPublished(fileId))?.versionId ?? null;
}

function simpleService(store: VersionedFileStore, worker: RecordingWorker, ledger: RunLedger) {
  return localDocumentService({
    store,
    worker,
    ledger,
    createdBy: "role:test",
    policyVersion: POLICY_VERSION,
    now: () => new Date("2026-10-23T00:00:00.000Z"),
  });
}

describe("the five-point crash/replay matrix (RASF-3286)", () => {
  it("before staging: a worker crash refuses, leaves the source untouched, and a retry re-runs", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const ref = await seededDocx(store);
    const worker = crashingWorker(new Error("the interpreter died"));
    const service = simpleService(store, worker, runLedger(join(root, "ledger")));

    const first = refused(
      await service.runDocumentPython({
        operationId: "acceptance:point-1",
        taskId: "task:acceptance",
        lease: leaseOf([ref], ["docx"]),
        code: "import docx",
        arguments: {},
      }),
    );
    expect(first.code).toBe("worker-crash");
    const head = await store.getHead(ref.id);
    expect(head?.versionId).toBe(ref.versionId);
    expect(head?.sha256).toBe(ref.sha256);

    // Nothing was staged or committed, so the same ID is free to run again (and does).
    const second = refused(
      await service.runDocumentPython({
        operationId: "acceptance:point-1",
        taskId: "task:acceptance",
        lease: leaseOf([ref], ["docx"]),
        code: "import docx",
        arguments: {},
      }),
    );
    expect(second.code).toBe("worker-crash");
    expect(worker.calls).toHaveLength(2);
    expect((await store.getHead(ref.id))?.versionId).toBe(ref.versionId);
  });

  it("after staging, before the receipt: the durable plan is resumed to one committed version, not re-run", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const ref = await seededDocx(store);
    const ledgerDir = join(root, "ledger");
    const firstWorker = fakeWorker(
      [declaredOutput("reviewed.docx", "docx", docxPackage(), ref.versionId)],
      { reads: [ref.versionId] },
    );

    const crashed = refused(
      await simpleService(
        store,
        firstWorker,
        crashingAfterPlan(runLedger(ledgerDir)),
      ).runDocumentPython({
        operationId: "acceptance:point-2",
        taskId: "task:acceptance",
        lease: leaseOf([ref], ["docx"]),
        code: "import docx",
        arguments: {},
      }),
    );
    // The plan is durable even though the run "crashed" — nothing source-side changed.
    expect(crashed.code).toBe("invalid-request");
    expect((await store.getHead(ref.id))?.versionId).toBe(ref.versionId);

    // A restart: a fresh service over the same ledger finds the plan and commits the exact staged
    // bytes. The worker is NOT invoked again, so no second edit can happen.
    const replayWorker = fakeWorker([declaredOutput("different.docx", "docx", docxPackage())]);
    const receipt = committed(
      await simpleService(store, replayWorker, runLedger(ledgerDir)).runDocumentPython({
        operationId: "acceptance:point-2",
        taskId: "task:acceptance",
        lease: leaseOf([ref], ["docx"]),
        code: "import docx",
        arguments: {},
      }),
    );
    expect(receipt.outputs).toHaveLength(1);
    expect(receipt.outputs[0]?.name).toBe("reviewed.docx");
    expect(replayWorker.calls).toHaveLength(0);
    const head = await store.getHead(ref.id);
    expect(head?.versionId).toBe(receipt.outputs[0]?.versionId);
    expect(head?.versionId).not.toBe(ref.versionId);
  });

  it("after the FileStore receipt, before settlement: a lost receipt is reconciled to one output", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const ref = await seededDocx(store);
    const worker = fakeWorker(
      [declaredOutput("reviewed.docx", "docx", docxPackage(), ref.versionId)],
      { reads: [ref.versionId] },
    );

    const first = refused(
      await localDocumentService({
        store: crashAfterCommit(store),
        worker,
        ledger: runLedger(join(root, "ledger")),
        createdBy: "role:test",
        now: () => new Date("2026-10-23T00:00:00.000Z"),
      }).runDocumentPython({
        operationId: "acceptance:point-3",
        taskId: "task:acceptance",
        lease: leaseOf([ref], ["docx"]),
        code: "import docx",
        arguments: {},
      }),
    );
    expect(first.code).toBe("incomplete-run");

    // The replay adopts the committed version from the FileStore's operation lookup, not a second edit.
    const receipt = committed(
      await simpleService(store, worker, runLedger(join(root, "ledger"))).runDocumentPython({
        operationId: "acceptance:point-3",
        taskId: "task:acceptance",
        lease: leaseOf([ref], ["docx"]),
        code: "import docx",
        arguments: {},
      }),
    );
    expect(worker.calls).toHaveLength(1);
    expect(receipt.outputs).toHaveLength(1);
    expect((await store.getHead(ref.id))?.versionId).toBe(receipt.outputs[0]?.versionId);
  });

  it("during a pending approval: a restart reopens the same review, never auto-approved", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const proposal = await fileWithProposal(store, "v1", "v2-edited");
    const gate = publicationGate({
      store,
      ledger: reviewLedger(join(root, "reviews")),
      now: () => new Date("2026-10-23T12:00:00.000Z"),
    });
    const opened = await gate.open({
      identity: identityOf(proposal),
      evidence: wordEvidence(proposal, "a new total"),
    });
    if (!opened.ok) throw new Error(`open refused: ${opened.message}`);

    // A restart: a fresh gate and ledger over the same directory.
    const reopened = publicationGate({
      store: localVersionedFileStore(join(root, "files")),
      ledger: reviewLedger(join(root, "reviews")),
    });
    const same = await reopened.open({
      identity: identityOf(proposal),
      evidence: wordEvidence(proposal, "a new total"),
    });
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect(same.value.reviewId).toBe(opened.value.reviewId);

    const record = await reopened.get(opened.value.reviewId);
    expect(record.ok).toBe(true);
    if (record.ok) expect(record.value.decision).toBeNull();
    const publish = await reopened.publish({
      reviewId: opened.value.reviewId,
      operationId: "acceptance:publish:pending",
    });
    expect(publish.ok).toBe(false);
    if (!publish.ok) expect(publish.code).toBe("not-approved");
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.source.versionId);
  });

  it("after an approved publish, before the tool result: replay is idempotent, no second move", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const proposal = await fileWithProposal(store, "v1", "v2-edited");
    const ledger = reviewLedger(join(root, "reviews"));
    const gate = publicationGate({
      store,
      ledger,
      now: () => new Date("2026-10-23T12:00:00.000Z"),
    });
    const opened = await gate.open({
      identity: identityOf(proposal),
      evidence: wordEvidence(proposal, "a new total"),
    });
    if (!opened.ok) throw new Error(`open refused: ${opened.message}`);
    await gate.decide({
      reviewId: opened.value.reviewId,
      verdict: "approved",
      by: "azmat",
      approvalId: "acceptance:approval",
    });
    const published = await gate.publish({
      reviewId: opened.value.reviewId,
      operationId: "acceptance:publish:1",
    });
    expect(published.ok).toBe(true);
    const pointer = await publishedPointer(store, proposal.fileId);
    expect(pointer).toBe(proposal.proposed.versionId);

    // Simulate the tool result being lost: the published record loses its publication, but the
    // FileStore keeps its own operation lookup. A replay must adopt that receipt, not move the pointer.
    const stored = await ledger.read(opened.value.reviewId);
    if (stored === undefined) throw new Error("record vanished");
    await ledger.write({ ...stored, publication: null });

    const replay = await publicationGate({ store, ledger }).publish({
      reviewId: opened.value.reviewId,
      operationId: "acceptance:publish:1",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.receipt.published.versionId).toBe(proposal.proposed.versionId);
    expect(await publishedPointer(store, proposal.fileId)).toBe(pointer);
  });

  it("a concurrent published-version change: the approval is refused as stale and nothing rewinds", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const proposal = await fileWithProposal(store, "v1", "v2-edited");
    const gate = publicationGate({
      store,
      ledger: reviewLedger(join(root, "reviews")),
      now: () => new Date("2026-10-23T12:00:00.000Z"),
    });
    const opened = await gate.open({
      identity: identityOf(proposal),
      evidence: wordEvidence(proposal, "a new total"),
    });
    if (!opened.ok) throw new Error(`open refused: ${opened.message}`);
    await gate.decide({
      reviewId: opened.value.reviewId,
      verdict: "approved",
      by: "azmat",
      approvalId: "acceptance:approval",
    });

    // Someone publishes the same proposed version under another operation before our publish lands.
    await store.publish({
      operationId: "acceptance:concurrent",
      fileId: proposal.fileId,
      expectedPublishedVersionId: proposal.source.versionId,
      versionId: proposal.proposed.versionId,
      approvalId: "someone-else",
    });
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.proposed.versionId);

    const stale = await gate.publish({
      reviewId: opened.value.reviewId,
      operationId: "acceptance:publish:1",
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("version-conflict");
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.proposed.versionId);
  });
});

// -- the cross-format fixture workflow, against a real worker ------------------------------------

suite("the all-format fixture workflow (real worker)", () => {
  function serviceWith(
    store: VersionedFileStore,
    ledgerDir = join(root, "ledger"),
  ): DocumentService {
    return localDocumentService({
      store,
      worker: subprocessPaperWorker({ interpreter: interpreter ?? "", graceSeconds: 30 }),
      ledger: runLedger(ledgerDir),
      createdBy: "role:test",
    });
  }

  it("reads a workbook, computes exact figures, writes a Word report and a PowerPoint deck, and edits the workbook", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const service = serviceWith(store);

    // 1. Seed the workbook with three line items, through the worker.
    const seeded = committed(
      await service.runDocumentPython({
        operationId: "acceptance:workflow:seed",
        taskId: "task:acceptance",
        lease: leaseOf([], ["xlsx"]),
        code: [
          "from openpyxl import Workbook",
          "book = Workbook()",
          "sheet = book.active",
          "sheet.title = 'Sales'",
          "sheet['A1'] = 'Product'",
          "sheet['B1'] = 'Units'",
          "sheet['C1'] = 'Price'",
          "sheet['A2'] = 'Widget'; sheet['B2'] = 12; sheet['C2'] = 10.50",
          "sheet['A3'] = 'Gadget'; sheet['B3'] = 7;  sheet['C3'] = 22.25",
          "sheet['A4'] = 'Doohickey'; sheet['B4'] = 5; sheet['C4'] = 3.10",
          "book.save(documents.declare_output('sales.xlsx', 'xlsx'))",
          "documents.result({'sheets': len(book.sheetnames)})",
        ].join("\n"),
        arguments: {},
      }),
    );
    const workbook = seeded.outputs[0];
    if (workbook === undefined) throw new Error("the seed produced no workbook");
    const v1 = await refOf(store, workbook.fileId, workbook.versionId);

    // Make it an existing business document: publish v1, so any later edit needs review.
    await store.publish({
      operationId: "acceptance:workflow:publish-v1",
      fileId: workbook.fileId,
      expectedPublishedVersionId: null,
      versionId: v1.versionId,
      approvalId: "seed",
    });

    // 2. The cross-format run: read the workbook, total the line items in code, write the report
    //    and the deck from the computed figure, and edit the workbook into a proposal.
    const workflow = committed(
      await service.runDocumentPython({
        operationId: "acceptance:workflow:transform",
        taskId: "task:acceptance",
        lease: leaseOf([v1], ["docx", "pptx", "xlsx"]),
        code: [
          "import docx, openpyxl, pptx",
          "book = openpyxl.load_workbook(documents.open_input('sales.xlsx'), data_only=False)",
          "sheet = book.active",
          "rows = [(sheet.cell(r, 2).value, sheet.cell(r, 3).value) for r in range(2, 5)]",
          "total = 0.0",
          "units = 0",
          "for u, p in rows:",
          "    if u is None: continue",
          "    amount = (u or 0) * (p or 0)",
          "    total += amount",
          "    units += u",
          "",
          "report = docx.Document()",
          "report.add_heading('Sales report', level=1)",
          "report.add_paragraph('Total revenue: ' + format(total, '.2f'))",
          "report.add_paragraph('Units shipped: ' + str(units))",
          "report.save(documents.declare_output('report.docx', 'docx'))",
          "",
          "deck = pptx.Presentation()",
          "slide = deck.slides.add_slide(deck.slide_layouts[0])",
          "slide.shapes.title.text = 'Quarterly sales: ' + format(total, '.2f')",
          "deck.save(documents.declare_output('deck.pptx', 'pptx'))",
          "",
          "sheet['A5'] = 'Total'",
          "sheet['B5'] = '=SUM(B2:B4)'",
          "sheet['C5'] = total",
          "book.save(documents.declare_output('sales.xlsx', 'xlsx', edit_of='sales.xlsx'))",
          "",
          "documents.result({'total': total, 'units': units})",
        ].join("\n"),
        arguments: {},
      }),
    );

    const report = workflow.outputs.find((output) => output.name === "report.docx");
    const deck = workflow.outputs.find((output) => output.name === "deck.pptx");
    const edited = workflow.outputs.find((output) => output.name === "sales.xlsx");
    expect(report).toBeDefined();
    expect(deck).toBeDefined();
    expect(edited).toBeDefined();
    if (report === undefined || deck === undefined || edited === undefined) return;

    // The exact figure is computed in code, not by a model: the result carries it, and it matches
    // the deterministic sum of the line items.
    expect(workflow.result).toEqual({ total: 297.25, units: 24 });

    // Lineage: the run read the source workbook once, and its outputs all derive from it.
    expect(workflow.reads.map((entry) => entry.name)).toEqual(["sales.xlsx"]);
    for (const output of [report, deck]) {
      expect(output.fileId).not.toBe(workbook.fileId);
      expect(output.sourceVersionId).toBeNull();
      const info = await store.info(output.fileId);
      expect(info?.metadata.derivedFrom).toEqual([workbook.fileId]);
    }

    // The edit is a new immutable version of the same workbook — never an edit in place.
    expect(edited.fileId).toBe(workbook.fileId);
    expect(edited.versionId).not.toBe(v1.versionId);
    expect(edited.sourceVersionId).toBe(v1.versionId);

    // The source version is untouched and unpublished state did not move yet.
    expect((await store.getVersion(workbook.fileId, v1.versionId))?.ref.sha256).toBe(v1.sha256);
    expect(await publishedPointer(store, workbook.fileId)).toBe(v1.versionId);

    // Workers and libraries are pinned and recorded, and every output reopened.
    expect(workflow.worker.libraries.python).toMatch(/^3\.13\./);
    // The patch level of the interpreter is deliberately not pinned: `uv` resolves the newest 3.13,
    // and a test that names today's patch turns a routine upstream release into a red build. What
    // the contract requires is a 3.13 interpreter with exactly these three forks owning their module
    // names.
    expect(workflow.worker.libraries.python).toMatch(/^3\.13\./);
    expect(workflow.worker.libraries).toMatchObject({
      "paper-docx": "0.2.0",
      "paper-pptx": "0.2.0",
      "paper-xlsx": "0.2.1",
    });
    expect(workflow.reopen.length).toBeGreaterThan(0);

    // 3. Reopen the generated report and deck in a later run and confirm the computed figure is in
    //    each document — the numeric claim traces to the deterministic code result, not to model
    //    arithmetic.
    const reportRef = await refOf(store, report.fileId, report.versionId);
    const deckRef = await refOf(store, deck.fileId, deck.versionId);
    const verified = committed(
      await service.runDocumentPython({
        operationId: "acceptance:workflow:verify",
        taskId: "task:acceptance",
        lease: leaseOf([reportRef, deckRef], ["docx", "pptx"]),
        code: [
          "import docx, pptx",
          "report = docx.Document(documents.open_input('report.docx'))",
          "report_text = ' '.join(p.text for p in report.paragraphs)",
          "deck = pptx.Presentation(documents.open_input('deck.pptx'))",
          "deck_text = ''",
          "for sl in deck.slides:",
          "    for sh in sl.shapes:",
          "        if getattr(sh, 'has_text_frame', False):",
          "            deck_text += sh.text_frame.text + ' '",
          "documents.result({",
          "    'report_has_total': '297.25' in report_text,",
          "    'deck_has_total': '297.25' in deck_text,",
          "})",
        ].join("\n"),
        arguments: {},
      }),
    );
    expect(verified.result).toEqual({ report_has_total: true, deck_has_total: true });

    // The workbook proposal lives at v2 for the review block to publish.
    const v2 = await refOf(store, workbook.fileId, edited.versionId);
    expect(v2.sourceVersionId).toBe(v1.versionId);
  }, 90_000);

  it("publishes the edited workbook only after an exact-version review", async () => {
    // Build a fresh workbook + proposal (mirrors the workflow above, then reviews the edit).
    const store = localVersionedFileStore(join(root, "files"));
    const service = serviceWith(store);

    const seeded = committed(
      await service.runDocumentPython({
        operationId: "acceptance:review:seed",
        taskId: "task:acceptance",
        lease: leaseOf([], ["xlsx"]),
        code: [
          "from openpyxl import Workbook",
          "book = Workbook()",
          "sheet = book.active",
          "sheet.title = 'Sales'",
          "sheet['A1'] = 'Product'; sheet['B1'] = 'Units'; sheet['C1'] = 'Price'",
          "sheet['A2'] = 'Widget'; sheet['B2'] = 12; sheet['C2'] = 10.50",
          "book.save(documents.declare_output('sales.xlsx', 'xlsx'))",
          "documents.result({})",
        ].join("\n"),
        arguments: {},
      }),
    );
    const first = seeded.outputs[0];
    if (first === undefined) throw new Error("the seed produced no workbook");
    const v1 = await refOf(store, first.fileId, first.versionId);
    await store.publish({
      operationId: "acceptance:review:publish-v1",
      fileId: first.fileId,
      expectedPublishedVersionId: null,
      versionId: v1.versionId,
      approvalId: "seed",
    });

    const edited = committed(
      await service.runDocumentPython({
        operationId: "acceptance:review:edit",
        taskId: "task:acceptance",
        lease: leaseOf([v1], ["xlsx"]),
        code: [
          "from openpyxl import load_workbook",
          "book = load_workbook(documents.open_input('sales.xlsx'))",
          "sheet = book.active",
          "sheet['A3'] = 'Total'",
          "sheet['B3'] = '=SUM(B2:B2)'",
          "book.save(documents.declare_output('sales.xlsx', 'xlsx', edit_of='sales.xlsx'))",
          "documents.result({})",
        ].join("\n"),
        arguments: {},
      }),
    );
    const proposed = edited.outputs[0];
    if (proposed === undefined) throw new Error("the edit produced no proposal");
    const v2 = await refOf(store, first.fileId, proposed.versionId);

    // The review evidence comes from the adapters, over the two immutable versions.
    const source: LeasedInput = {
      fileId: v1.id,
      versionId: v1.versionId,
      name: v1.name,
      format: "xlsx",
      sha256: v1.sha256,
      size: v1.size,
      writable: false,
    };
    const proposalInput: LeasedInput = {
      fileId: v2.id,
      versionId: v2.versionId,
      name: v2.name,
      format: "xlsx",
      sha256: v2.sha256,
      size: v2.size,
      writable: false,
    };
    const [sourceLeased, proposedLeased] = reviewLeaseInputs(source, proposalInput);
    const evidence = await reviewEvidenceFromService(service, {
      operationId: "acceptance:review:compare",
      taskId: "task:acceptance",
      lease: {
        leaseId: "lease:review",
        taskId: "task:acceptance",
        inputs: [sourceLeased, proposedLeased],
        outputFormats: ["xlsx"],
        limits: DEFAULT_LIMITS,
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
      sourceVersionId: v1.versionId,
      proposedVersionId: v2.versionId,
      format: "xlsx",
    });
    if (!evidence.ok) throw new Error(`compare refused: ${evidence.code}: ${evidence.message}`);

    // Deterministic checks pass, the no-recalculation limit is disclosed, and numeric checks recorded.
    expect(evidence.value.validation.deterministic).toBe(true);
    expect(evidence.value.validation.checks.every((entry) => entry.ok)).toBe(true);
    expect(evidence.value.validation.numeric.length).toBeGreaterThan(0);
    expect(evidence.value.limitations.join(" ")).toMatch(/no-recalculation/u);

    const gate = publicationGate({
      store,
      ledger: reviewLedger(join(root, "reviews")),
      now: () => new Date("2026-10-23T12:00:00.000Z"),
    });
    const artifact = (ref: VersionedFileRef): ReviewArtifact => ({
      fileId: ref.id,
      versionId: ref.versionId,
      name: ref.name,
      format: "xlsx",
      sha256: ref.sha256,
      size: ref.size,
    });
    const identity: ReviewIdentity = {
      fileId: v2.id,
      name: "sales.xlsx",
      format: "xlsx",
      source: artifact(v1),
      proposed: artifact(v2),
    };

    // Open a review: nothing publishes, and the pointer stays on the source version.
    const opened = await gate.open({ identity, evidence: evidence.value });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const beforeDecision = await gate.publish({
      reviewId: opened.value.reviewId,
      operationId: "acceptance:publish:1",
    });
    expect(beforeDecision.ok).toBe(false);
    if (!beforeDecision.ok) expect(beforeDecision.code).toBe("not-approved");
    expect(await publishedPointer(store, first.fileId)).toBe(v1.versionId);

    // A person decides, bound to the exact hashes, and only then does the pointer move.
    const decided = await gate.decide({
      reviewId: opened.value.reviewId,
      verdict: "approved",
      by: "azmat",
      approvalId: "acceptance:approval:xlsx",
    });
    expect(decided.ok).toBe(true);
    const published = await gate.publish({
      reviewId: opened.value.reviewId,
      operationId: "acceptance:publish:1",
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.value.receipt.previous?.versionId).toBe(v1.versionId);
    expect(published.value.receipt.published.versionId).toBe(v2.versionId);
    expect(await publishedPointer(store, first.fileId)).toBe(v2.versionId);
  }, 90_000);

  it("reopens every format and discloses unsupported rendering and recalculation", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const service = serviceWith(store);

    const allThree = committed(
      await service.runDocumentPython({
        operationId: "acceptance:disclosure:write",
        taskId: "task:acceptance",
        lease: leaseOf([], ["docx", "pptx", "xlsx"]),
        code: [
          "import docx, openpyxl, pptx",
          "report = docx.Document()",
          "report.add_paragraph('Draft')",
          "report.save(documents.declare_output('report.docx', 'docx'))",
          "deck = pptx.Presentation()",
          "slide = deck.slides.add_slide(deck.slide_layouts[0])",
          "slide.shapes.title.text = 'Draft'",
          "deck.save(documents.declare_output('deck.pptx', 'pptx'))",
          "book = openpyxl.Workbook()",
          "book.active['A1'] = 1",
          "book.save(documents.declare_output('figures.xlsx', 'xlsx'))",
          "documents.result({})",
        ].join("\n"),
        arguments: {},
      }),
    );
    expect(allThree.reopen.length).toBe(3); // one reopen witness per format

    const report = allThree.outputs.find((output) => output.name === "report.docx");
    const deck = allThree.outputs.find((output) => output.name === "deck.pptx");
    const figures = allThree.outputs.find((output) => output.name === "figures.xlsx");
    if (report === undefined || deck === undefined || figures === undefined) return;

    const reportRef = await refOf(store, report.fileId, report.versionId);
    const deckRef = await refOf(store, deck.fileId, deck.versionId);
    const figuresRef = await refOf(store, figures.fileId, figures.versionId);

    const tool = (name: string, lease: DocumentLease) => {
      const pack = paperOfficeToolPack({ service, leaseFor: async () => lease });
      return pack.tools.find((item) => item.name === name) as unknown as {
        execute(
          args: unknown,
          api: { taskId: string; conversationId: string; callId: string },
        ): Promise<{ output: { text: string }[]; isError?: boolean }>;
      };
    };
    const body = async <T>(name: string, lease: DocumentLease, args: unknown): Promise<T> => {
      const answer = await tool(name, lease).execute(args, {
        taskId: "task:acceptance",
        conversationId: "conv",
        callId: name,
      });
      if (answer.isError === true) throw new Error(`the tool refused: ${answer.output[0]?.text}`);
      const parsed = JSON.parse(answer.output[0]?.text ?? "{}") as { result: T };
      return parsed.result;
    };

    // Word: the inspect returns a structure census — the package reopened.
    const word = await body<WordInspection>(INSPECT_DOCUMENT, leaseOf([reportRef], ["docx"]), {
      ref: {
        fileId: reportRef.id,
        versionId: reportRef.versionId,
        name: reportRef.name,
        sha256: reportRef.sha256,
        size: reportRef.size,
      },
    });
    expect(word.operation).toBe("inspect");

    // PowerPoint: no bitmap renderer exists, and the result says so rather than implying a picture.
    const deckInspect = await body<PptxInspection>(
      INSPECT_PRESENTATION,
      leaseOf([deckRef], ["pptx"]),
      {
        ref: {
          fileId: deckRef.id,
          versionId: deckRef.versionId,
          name: deckRef.name,
          sha256: deckRef.sha256,
          size: deckRef.size,
        },
      },
    );
    expect(deckInspect.rendering.bitmap).toBe(false);
    expect(deckInspect.rendering.limits.join(" ")).toMatch(/no rasteriser/u);

    // Excel: nothing is recalculated here, and the result names the limit rather than fabricating one.
    const bookInspect = await body<XlsxInspection>(
      INSPECT_WORKBOOK,
      leaseOf([figuresRef], ["xlsx"]),
      {
        ref: {
          fileId: figuresRef.id,
          versionId: figuresRef.versionId,
          name: figuresRef.name,
          sha256: figuresRef.sha256,
          size: figuresRef.size,
        },
      },
    );
    expect(bookInspect.recalculation.computed).toBe(false);
    expect(bookInspect.recalculation.attempted).toBe(false);
    expect(bookInspect.recalculation.processSpawned).toBe(false);
    expect(bookInspect.recalculation.reason).toMatch(/LibreOffice|spawn/u);

    // A rubric on evidence is recorded but can never approve.
    const rubric = withRubric(
      reviewEvidenceFromWord({
        operation: "compare",
        sources: {
          from: {
            fileId: reportRef.id,
            versionId: reportRef.versionId,
            name: reportRef.name,
            sha256: reportRef.sha256,
            size: reportRef.size,
          },
          to: {
            fileId: reportRef.id,
            versionId: reportRef.versionId,
            name: reportRef.name,
            sha256: reportRef.sha256,
            size: reportRef.size,
          },
        },
        changeSet: {
          schema: "paper_word_change_set",
          version: 1,
          added: [],
          removed: [],
          changed: [],
          byteIdenticalCount: 1,
          semanticallyEmpty: true,
        },
        diff: {
          schema: "paper_word_diff",
          version: 1,
          changedLineCount: 0,
          stories: [],
          truncated: false,
        },
        redline: {
          schema: "paper_word_redline",
          version: 1,
          insertedBlocks: 0,
          deletedBlocks: 0,
          entries: [],
          total: 0,
          truncated: false,
          pendingChangedLineCount: 0,
          pendingLines: [],
        },
        identical: true,
      }),
      { score: 9, max: 10, notes: ["reads well"] },
    );
    expect(rubric.validation.rubric?.mayApprove).toBe(false);
  }, 90_000);
});
