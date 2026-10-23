/**
 * The local `DocumentService`: FileStore-backed, ledger-backed, and honest about its limits.
 *
 * The order of a run is the design's durable lifecycle:
 *
 * 1. Validate the lease, derive the operation's canonical intent hash, and look the operation up in
 *    the ledger. A receipt returns unchanged; a plan a crash left behind is resumed. An ID reused
 *    with different intent fails closed.
 * 2. Read every leased version from the FileStore, check it against the lease's hash, and inspect its
 *    package structure *before* any parser sees the bytes.
 * 3. Run the worker on a copy. Only staging is writable; the input copies are hashed again after.
 * 4. Inspect every declared output, keep its staged bytes, and write the plan (so a crash after the
 *    worker but before the commit can be resumed without a second execution).
 * 5. Commit each output as a new immutable FileStore version under a derived operation ID, then write
 *    the receipt and drop the staged bytes.
 *
 * A refusal or a timeout returns before step 4 and writes nothing, so sources are untouched. Two
 * concurrent edits of one file are settled by the FileStore's head compare-and-swap: the loser gets
 * `version-conflict`, never a silent overwrite.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  type FileMetadata,
  type FileOperationReceipt,
  FileStoreError,
  type VersionContext,
  type VersionedFileRef,
  type VersionedFileStore,
} from "@officehum/sdk";
import type {
  DocumentRunOutcome,
  DocumentRunRequest,
  DocumentService,
} from "./document-service.js";
import { DocumentError, type DocumentRefusalCode, refusal } from "./errors.js";
import {
  type DocumentFormat,
  FORMAT_MIME,
  formatFromName,
  isDocumentFormat,
  mimeTypeFor,
} from "./formats.js";
import {
  type DocumentLease,
  findLeasedInput,
  isLeaseExpired,
  type LeasedInput,
  validateLease,
} from "./lease.js";
import { inspectOfficePackage } from "./ooxml.js";
import {
  codeSha256,
  intentForRun,
  intentSha256,
  outputOperationId,
  POLICY_VERSION,
} from "./operation.js";
import type { PaperWorker, PaperWorkerInput } from "./paper-worker.js";
import type {
  DocumentRunReceipt,
  LineageEntry,
  PlannedOutput,
  RunLedger,
  RunPlan,
} from "./run-ledger.js";
import { assertLabel, isRecord, messageOf, record } from "./validate.js";

export interface LocalDocumentServiceOptions {
  readonly store: VersionedFileStore;
  readonly worker: PaperWorker;
  readonly ledger: RunLedger;
  /** The policy version every receipt binds, so a change of rules is visible in the durable record. */
  readonly policyVersion?: string;
  /** Who the FileStore records as the creator, e.g. `role:bookkeeper`. */
  readonly createdBy: string;
  readonly now?: () => Date;
}

const MIME_FORMAT: Readonly<Record<string, DocumentFormat>> = Object.fromEntries(
  Object.entries(FORMAT_MIME).map(([format, mime]) => [mime, format as DocumentFormat]),
);

export function localDocumentService(options: LocalDocumentServiceOptions): DocumentService {
  const policyVersion = options.policyVersion ?? POLICY_VERSION;
  const now = options.now ?? (() => new Date());

  return {
    async runDocumentPython(request) {
      const operationId =
        typeof request?.operationId === "string" ? request.operationId : "<unknown>";
      try {
        return await execute(request);
      } catch (error) {
        return refused(operationId, codeOf(error), messageOf(error));
      }
    },
  };

  async function execute(request: DocumentRunRequest): Promise<DocumentRunOutcome> {
    const lease = validateLease(record(request?.lease, "a run needs a lease", "invalid-lease"));
    assertLabel(request.operationId, "operation id");
    assertLabel(request.taskId, "task id");
    if (typeof request.code !== "string" || request.code.trim() === "") {
      throw refusal("invalid-request", "a run needs submitted code");
    }
    if (!isRecord(request.arguments)) {
      throw refusal("invalid-request", "run arguments must be a JSON object");
    }
    if (isLeaseExpired(lease, now())) {
      throw refusal("lease-expired", "this task's lease has expired; ask the host for a new one");
    }

    const intent = intentForRun({
      operationId: request.operationId,
      taskId: request.taskId,
      policyVersion,
      code: request.code,
      arguments: request.arguments,
      lease,
    });
    const bound = intentSha256(intent);

    const known = await options.ledger.read(request.operationId);
    if (known !== undefined) {
      if (known.intentSha256 !== bound) {
        throw refusal(
          "operation-collision",
          "this operation id was already used with different code, arguments or sources",
        );
      }
      if (known.kind === "run") return committed(known);
      return commit(known, lease);
    }

    const sources = await readSources(lease);
    let outcome: Awaited<ReturnType<PaperWorker["run"]>>;
    try {
      outcome = await options.worker.run({
        operationId: request.operationId,
        code: request.code,
        arguments: request.arguments,
        inputs: sources,
        outputFormats: lease.outputFormats,
        limits: lease.limits,
      });
    } catch (error) {
      if (error instanceof DocumentError) throw error;
      throw refusal("worker-crash", `the document worker failed: ${messageOf(error)}`);
    }
    if (outcome.kind === "refused") {
      return refused(request.operationId, outcome.code, outcome.message);
    }

    const plan = await planOf(request.operationId, bound, request.code, lease, outcome, now);
    await options.ledger.write(plan);
    return commit(plan, lease);
  }

  async function readSources(lease: DocumentLease): Promise<readonly PaperWorkerInput[]> {
    const inputs: PaperWorkerInput[] = [];
    for (const leased of lease.inputs) {
      const stored = await options.store.getVersion(leased.fileId, leased.versionId);
      if (stored === undefined) {
        throw refusal("not-found", `the lease names a version the file store does not hold`);
      }
      const { ref, bytes } = stored;
      if (ref.sha256 !== leased.sha256 || bytes.byteLength !== leased.size) {
        throw refusal(
          "input-integrity",
          "a leased version does not match the hash the lease pinned",
        );
      }
      const format = formatFromName(ref.name) ?? MIME_FORMAT[ref.mimeType];
      if (format !== leased.format) {
        throw refusal("invalid-request", "a leased version's format does not match the lease");
      }
      inspectOfficePackage(bytes, lease.limits, `the leased input ${leased.name}`);
      inputs.push({
        fileId: leased.fileId,
        versionId: leased.versionId,
        name: leased.name,
        format: leased.format,
        sha256: leased.sha256,
        size: leased.size,
        writable: leased.writable,
        bytes,
      });
    }
    return inputs;
  }

  async function planOf(
    operationId: string,
    bound: string,
    code: string,
    lease: DocumentLease,
    outcome: Extract<Awaited<ReturnType<PaperWorker["run"]>>, { kind: "completed" }>,
    clock: () => Date,
  ): Promise<RunPlan> {
    const stagingDir = await options.ledger.stagingDir(operationId);
    const outputs: PlannedOutput[] = [];
    if (outcome.outputs.length > lease.limits.fileCount) {
      throw refusal(
        "file-count",
        `the run declared ${outcome.outputs.length} files where the lease allows ${lease.limits.fileCount}`,
      );
    }
    let total = 0;
    for (const output of outcome.outputs) {
      if (!lease.outputFormats.includes(output.format)) {
        throw refusal("output-format", `the lease does not permit a ${output.format} output`);
      }
      if (output.bytes.byteLength !== output.size || sha256(output.bytes) !== output.sha256) {
        throw refusal(
          "output-invalid",
          `the bytes of ${output.name} do not match what was reported`,
        );
      }
      total += output.size;
      if (total > lease.limits.outputBytes) {
        throw refusal(
          "output-bytes",
          `the run declared ${total} bytes where the lease allows ${lease.limits.outputBytes}`,
        );
      }
      inspectOfficePackage(output.bytes, lease.limits, output.name);
      const stagedPath = `${stagingDir}/${output.name}`;
      await writeFile(stagedPath, output.bytes, { flag: "w", mode: 0o600 });
      outputs.push({
        name: output.name,
        format: output.format,
        size: output.size,
        sha256: output.sha256,
        editOf: output.editOf,
        operationId: outputOperationId(operationId, output.name, output.format),
        stagedPath,
      });
    }
    return {
      kind: "plan",
      operationId,
      intentSha256: bound,
      taskId: lease.taskId,
      policyVersion,
      leaseId: lease.leaseId,
      codeSha256: codeSha256(code),
      worker: outcome.evidence.identity,
      reads: outcome.evidence.reads,
      result: outcome.evidence.result,
      resultDeclared: outcome.evidence.resultDeclared,
      reopen: outcome.evidence.reopen,
      notes: outcome.evidence.notes,
      outputs,
      createdAt: clock().toISOString(),
    };
  }

  async function commit(plan: RunPlan, lease: DocumentLease): Promise<DocumentRunOutcome> {
    const commits: FileOperationReceipt[] = [];
    for (const output of plan.outputs) {
      const existing = await options.store.lookupOperation(output.operationId);
      if (existing !== undefined) {
        // The FileStore already holds a version under this derived operation. Accept it only when it
        // is the version this plan bound; otherwise the ID has been reused with other bytes, and the
        // only safe answer is to refuse rather than commit twice.
        const committed = committedOutput(existing);
        if (
          committed.name !== output.name ||
          committed.sha256 !== output.sha256 ||
          committed.size !== output.size
        ) {
          throw refusal(
            "operation-collision",
            `the durable operation for ${output.name} already committed different bytes, so this run ` +
              "will not commit again",
          );
        }
        commits.push(existing);
        continue;
      }
      const bytes = await stagedBytes(output);
      commits.push(await write(output, plan, lease, bytes));
    }
    const receipt = receiptOf(plan, lease, commits);
    await options.ledger.write(receipt);
    // The receipt is durable; the staged bytes are only a resume aid, so failing to drop them must
    // not turn a committed run into a refusal.
    await options.ledger.discardStaging(plan.operationId).catch(() => undefined);
    return committed(receipt);
  }

  async function stagedBytes(output: PlannedOutput): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(await readFile(output.stagedPath));
    } catch (error) {
      throw refusal(
        "incomplete-run",
        `the staged bytes of ${output.name} are gone, so this run cannot be finished: ${messageOf(error)}`,
      );
    }
    if (bytes.byteLength !== output.size || sha256(bytes) !== output.sha256) {
      throw refusal(
        "incomplete-run",
        `the staged bytes of ${output.name} no longer match the plan, so this run will not commit`,
      );
    }
    return bytes;
  }

  async function write(
    output: PlannedOutput,
    plan: RunPlan,
    lease: DocumentLease,
    bytes: Uint8Array,
  ): Promise<FileOperationReceipt> {
    const metadata = metadataFor(plan, lease, output);
    const context: VersionContext = {
      taskId: plan.taskId,
      policyVersion: plan.policyVersion,
      worker: { image: plan.worker.image, libraries: { ...plan.worker.libraries } },
      argumentsSha256: plan.intentSha256,
    };
    const common = {
      operationId: output.operationId,
      bytes,
      name: output.name,
      mimeType: mimeTypeFor(output.format),
      metadata,
      context,
    };
    if (output.editOf === null) return options.store.create({ ...common });
    const source = findLeasedInput(lease, output.editOf);
    if (source === undefined) {
      throw refusal("ungranted-input", "an output proposes an edit of a version outside the lease");
    }
    return options.store.putVersion({
      ...common,
      fileId: source.fileId,
      sourceVersionId: source.versionId,
    });
  }

  function metadataFor(plan: RunPlan, lease: DocumentLease, output: PlannedOutput): FileMetadata {
    const derived = new Set<string>();
    if (output.editOf !== null) {
      const source = findLeasedInput(lease, output.editOf);
      if (source !== undefined) derived.add(source.fileId);
    }
    for (const versionId of plan.reads) {
      const leased = findLeasedInput(lease, versionId);
      if (leased !== undefined) derived.add(leased.fileId);
    }
    const base = {
      createdBy: options.createdBy,
      source: derived.size > 0 ? ("derived" as const) : ("generated" as const),
    };
    return derived.size > 0 ? { ...base, derivedFrom: [...derived].sort() } : base;
  }

  function receiptOf(
    plan: RunPlan,
    lease: DocumentLease,
    commits: readonly FileOperationReceipt[],
  ): DocumentRunReceipt {
    const reads: LineageEntry[] = [];
    const seen = new Set<string>();
    for (const versionId of plan.reads) {
      if (seen.has(versionId)) continue;
      seen.add(versionId);
      const leased = findLeasedInput(lease, versionId);
      if (leased === undefined) {
        throw refusal("ungranted-input", "the run read a version outside the lease");
      }
      reads.push(lineageOf(leased));
    }
    const outputs = commits.map((commit) => outputLineage(commit));
    return {
      kind: "run",
      operationId: plan.operationId,
      intentSha256: plan.intentSha256,
      taskId: plan.taskId,
      policyVersion: plan.policyVersion,
      leaseId: plan.leaseId,
      codeSha256: plan.codeSha256,
      worker: plan.worker,
      reads,
      outputs,
      commit: commits.map(
        (commit) => structuredClone(commit) as unknown as Record<string, unknown>,
      ),
      result: plan.result,
      resultDeclared: plan.resultDeclared,
      reopen: plan.reopen,
      notes: plan.notes,
      createdAt: plan.createdAt,
    };
  }

  function committed(receipt: DocumentRunReceipt): DocumentRunOutcome {
    return { kind: "committed", receipt };
  }

  function refused(operationId: string, code: DocumentRefusalCode, message: string) {
    return { kind: "refused" as const, operationId, code, message: message.slice(0, 400) };
  }
}

function lineageOf(leased: LeasedInput): LineageEntry {
  return {
    fileId: leased.fileId,
    versionId: leased.versionId,
    name: leased.name,
    format: leased.format,
    sha256: leased.sha256,
    size: leased.size,
    sourceVersionId: null,
  };
}

function outputLineage(commit: FileOperationReceipt): LineageEntry {
  const output = committedOutput(commit);
  const format = formatFromName(output.name) ?? MIME_FORMAT[output.mimeType];
  if (format === undefined || !isDocumentFormat(format)) {
    throw refusal("invalid-request", "a committed output is not a document format");
  }
  return {
    fileId: output.id,
    versionId: output.versionId,
    name: output.name,
    format,
    sha256: output.sha256,
    size: output.size,
    sourceVersionId: output.sourceVersionId,
  };
}

/** The immutable version a FileStore operation receipt committed. */
function committedOutput(commit: FileOperationReceipt): VersionedFileRef {
  if (commit.kind !== "create" && commit.kind !== "version") {
    throw refusal(
      "operation-collision",
      "a publish receipt cannot stand in for a document version",
    );
  }
  return (commit as { output: VersionedFileRef }).output;
}

function codeOf(error: unknown): DocumentRefusalCode {
  if (error instanceof DocumentError) return error.code;
  if (error instanceof FileStoreError) {
    switch (error.code) {
      case "NOT_FOUND":
        return "not-found";
      case "VERSION_CONFLICT":
        return "version-conflict";
      case "OPERATION_COLLISION":
        return "operation-collision";
      case "INVALID_INPUT":
        return "invalid-request";
      default:
        return "store-error";
    }
  }
  return "invalid-request";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
