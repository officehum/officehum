import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localVersionedFileStore,
  type VersionedFileRef,
  type VersionedFileStore,
} from "@officehum/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocumentRunOutcome } from "./document-service.js";
import { DocumentError } from "./errors.js";
import { DEFAULT_LIMITS, type DocumentLease, type LeasedInput } from "./lease.js";
import { localDocumentService } from "./local-document-service.js";
import { POLICY_VERSION } from "./operation.js";
import { runLedger } from "./run-ledger.js";
import {
  crashingWorker,
  declaredOutput,
  docxLike,
  docxPackage,
  fakeWorker,
  type RecordingWorker,
  refusingWorker,
  sequenceWorker,
} from "./test-helpers.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paper-service-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seeded(bytes: Uint8Array, name: string, format: "docx" | "pptx" | "xlsx") {
  const store = localVersionedFileStore(join(root, "files"));
  const mime = `application/vnd.openxmlformats-officedocument.${format === "xlsx" ? "spreadsheetml.sheet" : format === "pptx" ? "presentationml.presentation" : "wordprocessingml.document"}`;
  const ref = await store.put({
    bytes,
    name,
    mimeType: mime,
    metadata: { createdBy: "host", source: "uploaded" },
  });
  return { store, ref };
}

function leaseFor(
  ref: VersionedFileRef,
  overrides: Partial<DocumentLease> = {},
  writable = true,
  hash = ref.sha256,
): DocumentLease {
  const input: LeasedInput = {
    fileId: ref.id,
    versionId: ref.versionId,
    name: ref.name,
    format: "docx",
    sha256: hash,
    size: ref.size,
    writable,
  };
  return {
    leaseId: "lease:1",
    taskId: "task:1",
    inputs: [input],
    outputFormats: ["docx", "xlsx", "pptx"],
    limits: DEFAULT_LIMITS,
    expiresAt: "2999-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function service(store: VersionedFileStore, worker: RecordingWorker) {
  return localDocumentService({
    store,
    worker,
    ledger: runLedger(join(root, "ledger")),
    createdBy: "role:test",
    policyVersion: POLICY_VERSION,
    now: () => new Date("2026-10-23T00:00:00.000Z"),
  });
}

function committed(outcome: DocumentRunOutcome) {
  if (outcome.kind !== "committed") throw new Error(`expected a commit, got ${outcome.code}`);
  return outcome.receipt;
}

function refused(outcome: DocumentRunOutcome) {
  if (outcome.kind !== "refused") throw new Error("expected a refusal, got a commit");
  return outcome;
}

describe("the durable document run", () => {
  it("commits one immutable output, with lineage from the version it read", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const worker = fakeWorker(
      [declaredOutput("reviewed.docx", "docx", docxPackage(), ref.versionId)],
      {
        reads: [ref.versionId],
      },
    );
    const receipt = committed(
      await service(store, worker).runDocumentPython({
        operationId: "conv:1",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "documents.result(1)",
        arguments: {},
      }),
    );

    expect(receipt.outputs).toHaveLength(1);
    const output = receipt.outputs[0];
    expect(output?.name).toBe("reviewed.docx");
    expect(output?.fileId).toBe(ref.id);
    expect(output?.sourceVersionId).toBe(ref.versionId);
    expect(receipt.reads.map((entry) => entry.versionId)).toEqual([ref.versionId]);
    expect(receipt.worker.libraries["paper-xlsx"]).toBe("0.2.1");
    expect(receipt.policyVersion).toBe(POLICY_VERSION);

    // The source version is untouched and the new version is the head: never an edit in place.
    const head = await store.getHead(ref.id);
    expect(head?.versionId).toBe(output?.versionId);
    expect(head?.versionId).not.toBe(ref.versionId);
    const original = await store.getVersion(ref.id, ref.versionId);
    expect(original?.ref.sha256).toBe(ref.sha256);
    expect(head?.sourceVersionId).toBe(ref.versionId);
    expect(head?.metadata.derivedFrom).toEqual([ref.id]);
    expect(head?.context?.worker.libraries).toEqual(receipt.worker.libraries);
    expect(head?.context?.argumentsSha256).toBe(receipt.intentSha256);
  });

  it("creates a new draft for a new document, with no source version", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const worker = fakeWorker([declaredOutput("fresh.xlsx", "xlsx", docxPackage())], {
      reads: [ref.versionId],
    });
    const receipt = committed(
      await service(store, worker).runDocumentPython({
        operationId: "conv:2",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "documents.result(2)",
        arguments: {},
      }),
    );
    const output = receipt.outputs[0];
    expect(output?.fileId).not.toBe(ref.id);
    expect(output?.sourceVersionId).toBeNull();
    const stored = await store.info(output?.fileId ?? "");
    expect(stored?.metadata.source).toBe("derived");
    expect(stored?.metadata.derivedFrom).toEqual([ref.id]);
  });

  it("returns the same committed receipt on a replay and does not run the worker twice", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const worker = fakeWorker(
      [declaredOutput("reviewed.docx", "docx", docxPackage(), ref.versionId)],
      {
        reads: [ref.versionId],
      },
    );
    const run = service(store, worker);
    const request = {
      operationId: "conv:3",
      taskId: "task:1",
      lease: leaseFor(ref),
      code: "documents.result(3)",
      arguments: { k: 1 },
    };
    const first = committed(await run.runDocumentPython(request));
    const second = committed(await run.runDocumentPython(request));
    expect(second).toEqual(first);
    expect(worker.calls).toHaveLength(1);
    const head = await store.getHead(ref.id);
    expect(head?.versionId).toBe(first.outputs[0]?.versionId);
  });

  it("fails closed when one operation ID is reused with different intent", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const worker = fakeWorker([
      declaredOutput("reviewed.docx", "docx", docxPackage(), ref.versionId),
    ]);
    const run = service(store, worker);
    const lease = leaseFor(ref);
    committed(
      await run.runDocumentPython({
        operationId: "conv:4",
        taskId: "task:1",
        lease,
        code: "documents.result(4)",
        arguments: {},
      }),
    );
    const collision = refused(
      await run.runDocumentPython({
        operationId: "conv:4",
        taskId: "task:1",
        lease,
        code: "documents.result('something else')",
        arguments: {},
      }),
    );
    expect(collision.code).toBe("operation-collision");
    expect(worker.calls).toHaveLength(1);
  });

  it("a refusal leaves every source untouched and writes no ledger entry", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const worker = refusingWorker("symlink", "a staging entry was a symbolic link");
    const outcome = refused(
      await service(store, worker).runDocumentPython({
        operationId: "conv:5",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "import docx",
        arguments: {},
      }),
    );
    expect(outcome.code).toBe("symlink");
    const head = await store.getHead(ref.id);
    expect(head?.versionId).toBe(ref.versionId);
    expect(head?.sha256).toBe(ref.sha256);
    const files = await readFile(join(root, "ledger", "runs", `${digest("conv:5")}.json`)).catch(
      () => undefined,
    );
    expect(files).toBeUndefined();
    // And a retry with the same ID is free to run: nothing was committed under it.
    const retry = refused(
      await service(store, worker).runDocumentPython({
        operationId: "conv:5",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "import docx",
        arguments: {},
      }),
    );
    expect(retry.code).toBe("symlink");
  });

  it("a crash while staging returns a stable refusal and commits nothing", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const worker = crashingWorker(new Error("the interpreter died"));
    const outcome = refused(
      await service(store, worker).runDocumentPython({
        operationId: "conv:6",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "import docx",
        arguments: {},
      }),
    );
    expect(outcome.code).toBe("worker-crash");
    expect((await store.getHead(ref.id))?.versionId).toBe(ref.versionId);
  });

  it("a crash after the commit — a lost receipt — is reconciled to one immutable output", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const worker = fakeWorker([
      declaredOutput("reviewed.docx", "docx", docxPackage(), ref.versionId),
    ]);
    const crashing = crashAfterCommit(store);
    const first = refused(
      await localDocumentService({
        store: crashing,
        worker,
        ledger: runLedger(join(root, "ledger")),
        createdBy: "role:test",
        now: () => new Date("2026-10-23T00:00:00.000Z"),
      }).runDocumentPython({
        operationId: "conv:7",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "documents.result(7)",
        arguments: {},
      }),
    );
    expect(first.code).toBe("incomplete-run");
    // The commit landed but the receipt never did: the ledger still holds the plan, which is exactly
    // the "lost receipt" state a crash between the FileStore commit and Pi Durable settlement leaves.
    const ledgerPath = join(root, "ledger", "runs", `${digest("conv:7")}.json`);
    const plan = JSON.parse(await readFile(ledgerPath, "utf8")) as { kind: string };
    expect(plan.kind).toBe("plan");

    // The replay must reconcile it without a second execution.
    const receipt = committed(
      await localDocumentService({
        store,
        worker,
        ledger: runLedger(join(root, "ledger")),
        createdBy: "role:test",
        now: () => new Date("2026-10-23T00:00:00.000Z"),
      }).runDocumentPython({
        operationId: "conv:7",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "documents.result(7)",
        arguments: {},
      }),
    );
    expect(receipt.outputs).toHaveLength(1);
    expect(worker.calls).toHaveLength(1);
    const head = await store.getHead(ref.id);
    expect(head?.versionId).toBe(receipt.outputs[0]?.versionId);
    expect(head?.sourceVersionId).toBe(ref.versionId);
    const settled = JSON.parse(await readFile(ledgerPath, "utf8")) as { kind: string };
    expect(settled.kind).toBe("run");
  });

  it("a lost ledger with different output bytes refuses rather than editing a second time", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const other = docxLike({ targets: ["settings.xml", "styles.xml"] });
    const worker = sequenceWorker([
      [declaredOutput("reviewed.docx", "docx", docxPackage(), ref.versionId)],
      [declaredOutput("reviewed.docx", "docx", other, ref.versionId)],
    ]);
    const before = committed(
      await service(store, worker).runDocumentPython({
        operationId: "conv:8",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "documents.result(8)",
        arguments: {},
      }),
    );
    // The whole ledger is gone; only the FileStore still remembers the operation.
    await rm(join(root, "ledger"), { recursive: true, force: true });
    const outcome = refused(
      await service(store, worker).runDocumentPython({
        operationId: "conv:8",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "documents.result(8)",
        arguments: {},
      }),
    );
    expect(outcome.code).toBe("operation-collision");
    const head = await store.getHead(ref.id);
    expect(head?.versionId).toBe(before.outputs[0]?.versionId);
    expect((await store.getVersion(ref.id, before.outputs[0]?.versionId ?? ""))?.ref.sha256).toBe(
      before.outputs[0]?.sha256,
    );
  });

  it("settles two concurrent edits with a version conflict, never a silent overwrite", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const first = fakeWorker([declaredOutput("a.docx", "docx", docxPackage(), ref.versionId)]);
    const winner = committed(
      await service(store, first).runDocumentPython({
        operationId: "conv:9a",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "documents.result('a')",
        arguments: {},
      }),
    );
    const second = fakeWorker([
      declaredOutput("b.docx", "docx", docxLike({ targets: ["settings.xml"] }), ref.versionId),
    ]);
    const loser = refused(
      await service(store, second).runDocumentPython({
        operationId: "conv:9b",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "documents.result('b')",
        arguments: {},
      }),
    );
    expect(loser.code).toBe("version-conflict");
    expect((await store.getHead(ref.id))?.versionId).toBe(winner.outputs[0]?.versionId);
  });

  it("a cross-format transformation declares what it read and what it wrote", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const worker = fakeWorker([declaredOutput("figures.xlsx", "xlsx", docxPackage())], {
      reads: [ref.versionId],
      result: { total: 42 },
    });
    const receipt = committed(
      await service(store, worker).runDocumentPython({
        operationId: "conv:10",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "import openpyxl",
        arguments: {},
      }),
    );
    expect(receipt.reads).toEqual([
      {
        fileId: ref.id,
        versionId: ref.versionId,
        name: "brief.docx",
        format: "docx",
        sha256: ref.sha256,
        size: ref.size,
        sourceVersionId: null,
      },
    ]);
    expect(receipt.outputs[0]?.fileId).not.toBe(ref.id);
    expect(receipt.result).toEqual({ total: 42 });
    expect(receipt.resultDeclared).toBe(true);
    expect((await store.info(receipt.outputs[0]?.fileId ?? ""))?.metadata.derivedFrom).toEqual([
      ref.id,
    ]);
  });

  it("a run that only reads commits nothing and records its lineage", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const worker = fakeWorker([], { reads: [ref.versionId], result: { paragraphs: 3 } });
    const receipt = committed(
      await service(store, worker).runDocumentPython({
        operationId: "conv:11",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "import docx",
        arguments: {},
      }),
    );
    expect(receipt.outputs).toEqual([]);
    expect(receipt.commit).toEqual([]);
    expect(receipt.reads).toHaveLength(1);
    expect((await store.getHead(ref.id))?.versionId).toBe(ref.versionId);
  });

  it("refuses an expired lease before the worker is asked to run", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const worker = fakeWorker([declaredOutput("x.docx", "docx", docxPackage())]);
    const outcome = refused(
      await service(store, worker).runDocumentPython({
        operationId: "conv:12",
        taskId: "task:1",
        lease: leaseFor(ref, { expiresAt: "2026-10-22T00:00:00.000Z" }),
        code: "import docx",
        arguments: {},
      }),
    );
    expect(outcome.code).toBe("lease-expired");
    expect(worker.calls).toHaveLength(0);
  });

  it("refuses a leased version whose bytes no longer match the lease's hash", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const worker = fakeWorker([declaredOutput("x.docx", "docx", docxPackage())]);
    const outcome = refused(
      await service(store, worker).runDocumentPython({
        operationId: "conv:13",
        taskId: "task:1",
        lease: leaseFor(ref, {}, true, "c".repeat(64)),
        code: "import docx",
        arguments: {},
      }),
    );
    expect(outcome.code).toBe("input-integrity");
    expect(worker.calls).toHaveLength(0);
  });

  it("refuses a hostile leased package before any parser sees it", async () => {
    const hostile = docxLike({ external: ["http://evil.example/steal"] });
    const { store, ref } = await seeded(hostile, "brief.docx", "docx");
    const worker = fakeWorker([declaredOutput("x.docx", "docx", docxPackage())]);
    const outcome = refused(
      await service(store, worker).runDocumentPython({
        operationId: "conv:14",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "import docx",
        arguments: {},
      }),
    );
    expect(outcome.code).toBe("external-relationship");
    expect(worker.calls).toHaveLength(0);
  });

  it("refuses an output format, a file count and a byte total the lease does not allow", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const lease = leaseFor(ref, { outputFormats: ["docx"] });
    const wrongFormat = refused(
      await service(
        store,
        fakeWorker([declaredOutput("x.xlsx", "xlsx", docxPackage())]),
      ).runDocumentPython({
        operationId: "conv:15a",
        taskId: "task:1",
        lease,
        code: "x",
        arguments: {},
      }),
    );
    expect(wrongFormat.code).toBe("output-format");

    const many = refused(
      await service(
        store,
        fakeWorker([
          declaredOutput("a.docx", "docx", docxPackage()),
          declaredOutput("b.docx", "docx", docxPackage()),
        ]),
      ).runDocumentPython({
        operationId: "conv:15b",
        taskId: "task:1",
        lease: leaseFor(ref, { limits: { ...DEFAULT_LIMITS, fileCount: 1 } }),
        code: "x",
        arguments: {},
      }),
    );
    expect(many.code).toBe("file-count");

    const big = refused(
      await service(
        store,
        fakeWorker([declaredOutput("a.docx", "docx", docxPackage())]),
      ).runDocumentPython({
        operationId: "conv:15c",
        taskId: "task:1",
        lease: leaseFor(ref, { limits: { ...DEFAULT_LIMITS, outputBytes: 16 } }),
        code: "x",
        arguments: {},
      }),
    );
    expect(big.code).toBe("output-bytes");
    expect((await store.getHead(ref.id))?.versionId).toBe(ref.versionId);
  });

  it("refuses an output whose bytes are not the Office package it claims to be", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const notAPackage = new TextEncoder().encode("plain text pretending to be a task list");
    const outcome = refused(
      await service(
        store,
        fakeWorker([declaredOutput("a.docx", "docx", notAPackage)]),
      ).runDocumentPython({
        operationId: "conv:16",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "x",
        arguments: {},
      }),
    );
    expect(outcome.code).toBe("archive-invalid");
  });

  it("refuses an output whose bytes drifted from what the worker reported", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const output = declaredOutput("a.docx", "docx", docxPackage());
    const outcome = refused(
      await service(store, fakeWorker([{ ...output, sha256: "d".repeat(64) }])).runDocumentPython({
        operationId: "conv:17",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "x",
        arguments: {},
      }),
    );
    expect(outcome.code).toBe("output-invalid");
  });

  it("refuses a tampered run ledger rather than trusting it", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const worker = fakeWorker([declaredOutput("a.docx", "docx", docxPackage(), ref.versionId)]);
    await mkdir(join(root, "ledger", "runs"), { recursive: true });
    await writeFile(join(root, "ledger", "runs", `${digest("conv:18")}.json`), '{"kind":"plan"}');
    const outcome = refused(
      await service(store, worker).runDocumentPython({
        operationId: "conv:18",
        taskId: "task:1",
        lease: leaseFor(ref),
        code: "x",
        arguments: {},
      }),
    );
    expect(outcome.code).toBe("ledger-integrity");
    expect(worker.calls).toHaveLength(0);
  });

  it("never hands the worker a path, only the lease's staged bytes", async () => {
    const { store, ref } = await seeded(docxPackage(), "brief.docx", "docx");
    const worker = fakeWorker([declaredOutput("a.docx", "docx", docxPackage(), ref.versionId)]);
    await service(store, worker).runDocumentPython({
      operationId: "conv:19",
      taskId: "task:1",
      lease: leaseFor(ref),
      code: "x",
      arguments: {},
    });
    const request = worker.calls[0];
    expect(request?.inputs).toHaveLength(1);
    expect(Object.keys(request?.inputs[0] ?? {}).sort()).toEqual([
      "bytes",
      "fileId",
      "format",
      "name",
      "sha256",
      "size",
      "versionId",
      "writable",
    ]);
    expect(request?.outputFormats).toEqual(["docx", "xlsx", "pptx"]);
  });
});

function digest(operationId: string): string {
  return createHash("sha256").update(operationId, "utf8").digest("hex");
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
