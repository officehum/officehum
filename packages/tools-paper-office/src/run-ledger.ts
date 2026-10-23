/**
 * The run ledger: one immutable record per durable operation.
 *
 * The FileStore is the byte and version authority; it binds one operation ID to one immutable
 * version. A document run can declare several outputs, so each output commits under its own derived
 * operation ID and this ledger joins them back to the run the tool call asked for — plus the lineage,
 * the worker identity and the reopen witnesses. It is a *cache with a recovery rule*, not a second
 * source of truth: a lost receipt is rebuilt from the FileStore's own operation lookup, and a plan
 * left behind by a crash is resumed from the staged bytes it recorded.
 *
 * A record is written by exclusive create into a temporary file and then renamed over its final
 * name, so a reader sees one whole record or none.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { refusal } from "./errors.js";
import { type DocumentFormat, isDocumentFormat } from "./formats.js";
import type { WorkerIdentity } from "./operation.js";
import {
  assertFileId,
  assertHash,
  assertLabel,
  isNotFound,
  messageOf,
  record,
} from "./validate.js";

const FILE_ID = /^file_[0-9A-HJKMNP-TV-Z]{26}$/u;
const OPERATION_RECEIPT_KINDS = new Set(["create", "version"]);

export interface LineageEntry {
  readonly fileId: string;
  readonly versionId: string;
  readonly name: string;
  readonly format: DocumentFormat;
  readonly sha256: string;
  readonly size: number;
  readonly sourceVersionId: string | null;
}

export interface PlannedOutput {
  readonly name: string;
  readonly format: DocumentFormat;
  readonly size: number;
  readonly sha256: string;
  /** The leased source version this output proposes a new version of, or `null` for a new file. */
  readonly editOf: string | null;
  /** The derived FileStore operation ID this output commits under. */
  readonly operationId: string;
  /** Where the staged bytes were kept, inside this ledger's staging root. */
  readonly stagedPath: string;
}

export interface RunPlan {
  readonly kind: "plan";
  readonly operationId: string;
  readonly intentSha256: string;
  readonly taskId: string;
  readonly policyVersion: string;
  readonly leaseId: string;
  readonly codeSha256: string;
  readonly worker: WorkerIdentity;
  readonly reads: readonly string[];
  readonly result: unknown;
  readonly resultDeclared: boolean;
  readonly reopen: readonly string[];
  readonly notes: readonly string[];
  readonly outputs: readonly PlannedOutput[];
  readonly createdAt: string;
}

/** A committed run: the receipt a replay returns, unchanged. */
export interface DocumentRunReceipt {
  readonly kind: "run";
  readonly operationId: string;
  readonly intentSha256: string;
  readonly taskId: string;
  readonly policyVersion: string;
  readonly leaseId: string;
  readonly codeSha256: string;
  readonly worker: WorkerIdentity;
  readonly reads: readonly LineageEntry[];
  readonly outputs: readonly LineageEntry[];
  readonly commit: readonly Record<string, unknown>[];
  readonly result: unknown;
  readonly resultDeclared: boolean;
  readonly reopen: readonly string[];
  readonly notes: readonly string[];
  readonly createdAt: string;
}

export type RunRecord = RunPlan | DocumentRunReceipt;

export interface RunLedger {
  read(operationId: string): Promise<RunRecord | undefined>;
  write(record: RunRecord): Promise<void>;
  /** The staging directory this operation's outputs are kept in until its receipt commits. */
  stagingDir(operationId: string): Promise<string>;
  discardStaging(operationId: string): Promise<void>;
}

export function runLedger(dir: string): RunLedger {
  const root = resolve(dir);
  const runsDir = join(root, "runs");
  const stagingRoot = join(root, "staging");

  return {
    async read(operationId) {
      const path = join(runsDir, `${digest(operationId)}.json`);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(path);
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw refusal("ledger-integrity", `the run ledger could not be read: ${messageOf(error)}`);
      }
      if (info.isSymbolicLink() || !info.isFile()) {
        throw refusal("ledger-integrity", "a run ledger entry is not a regular file");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch (error) {
        throw refusal("ledger-integrity", `a run ledger entry is corrupt: ${messageOf(error)}`);
      }
      return validateRunRecord(parsed, stagingRoot);
    },
    async write(value) {
      await mkdir(runsDir, { recursive: true, mode: 0o700 });
      const path = join(runsDir, `${digest(value.operationId)}.json`);
      const temp = join(runsDir, `.pending-${randomBytes(12).toString("hex")}`);
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(value), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temp, path);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw refusal(
          "ledger-integrity",
          `a run ledger entry could not be written: ${messageOf(error)}`,
        );
      }
    },
    async stagingDir(operationId) {
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      await assertRealDirectory(stagingRoot);
      const dir = join(stagingRoot, digest(operationId));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await assertRealDirectory(dir);
      return dir;
    },
    async discardStaging(operationId) {
      await rm(join(stagingRoot, digest(operationId)), { recursive: true, force: true });
    },
  };
}

function validateRunRecord(value: unknown, stagingRoot: string): RunRecord {
  const raw = record(value, "a run ledger entry must be an object", "ledger-integrity");
  const kind = raw.kind;
  if (kind !== "plan" && kind !== "run") {
    throw refusal("ledger-integrity", "a run ledger entry has an unknown kind");
  }
  assertLabel(raw.operationId, "a ledger operation id", "ledger-integrity");
  assertLabel(raw.taskId, "a ledger task id", "ledger-integrity");
  assertLabel(raw.policyVersion, "a ledger policy version", "ledger-integrity");
  assertLabel(raw.leaseId, "a ledger lease id", "ledger-integrity");
  assertHash(raw.intentSha256, "a ledger intent hash", "ledger-integrity");
  assertHash(raw.codeSha256, "a ledger code hash", "ledger-integrity");
  const worker = validateWorker(raw.worker);
  const common = {
    operationId: raw.operationId,
    taskId: raw.taskId,
    policyVersion: raw.policyVersion,
    leaseId: raw.leaseId,
    intentSha256: raw.intentSha256,
    codeSha256: raw.codeSha256,
    worker,
    result: raw.result,
    resultDeclared: raw.resultDeclared === true,
    reopen: labels(raw.reopen, true),
    notes: labels(raw.notes, true),
    createdAt: assertTimestamp(raw.createdAt),
  };
  if (kind === "plan") {
    return {
      kind: "plan",
      ...common,
      reads: labels(raw.reads, true),
      outputs: plannedOutputs(raw.outputs, stagingRoot),
    };
  }
  return {
    kind: "run",
    ...common,
    reads: lineage(raw.reads),
    outputs: lineage(raw.outputs),
    commit: receipts(raw.commit),
  };
}

function plannedOutputs(value: unknown, stagingRoot: string): readonly PlannedOutput[] {
  if (!Array.isArray(value)) throw refusal("ledger-integrity", "a run plan lists no outputs");
  return value.map((item) => {
    const entry = record(item, "a planned output must be an object", "ledger-integrity");
    const name = entry.name;
    if (typeof name !== "string" || name === "" || name.includes("/") || name.includes("\\")) {
      throw refusal("ledger-integrity", "a planned output has an unusable name");
    }
    const format = entry.format;
    if (!isDocumentFormat(format)) {
      throw refusal("ledger-integrity", "a planned output has an unsupported format");
    }
    const stagedPath = entry.stagedPath;
    if (typeof stagedPath !== "string" || !inside(resolve(stagingRoot), resolve(stagedPath))) {
      throw refusal(
        "ledger-integrity",
        "a planned output is not inside this ledger's staging root",
      );
    }
    const editOf = entry.editOf;
    if (editOf !== null) assertFileId(editOf, "a planned output source", "ledger-integrity");
    assertLabel(entry.operationId, "a planned output operation", "ledger-integrity");
    assertHash(entry.sha256, "a planned output hash", "ledger-integrity");
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) {
      throw refusal("ledger-integrity", "a planned output has an unusable size");
    }
    return {
      name,
      format,
      size: entry.size as number,
      sha256: entry.sha256,
      editOf: editOf as string | null,
      operationId: entry.operationId,
      stagedPath: resolve(stagedPath),
    };
  });
}

function lineage(value: unknown): readonly LineageEntry[] {
  if (!Array.isArray(value)) throw refusal("ledger-integrity", "a run receipt lists no lineage");
  return value.map((item) => {
    const entry = record(item, "a lineage entry must be an object", "ledger-integrity");
    assertFileId(entry.fileId, "a lineage file id", "ledger-integrity");
    assertFileId(entry.versionId, "a lineage version id", "ledger-integrity");
    const name = entry.name;
    if (typeof name !== "string" || name === "") {
      throw refusal("ledger-integrity", "a lineage entry has no name");
    }
    if (!isDocumentFormat(entry.format)) {
      throw refusal("ledger-integrity", "a lineage entry has an unsupported format");
    }
    assertHash(entry.sha256, "a lineage hash", "ledger-integrity");
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) {
      throw refusal("ledger-integrity", "a lineage entry has an unusable size");
    }
    const sourceVersionId = entry.sourceVersionId;
    if (sourceVersionId !== null)
      assertFileId(sourceVersionId, "a lineage source", "ledger-integrity");
    return {
      fileId: entry.fileId,
      versionId: entry.versionId,
      name,
      format: entry.format,
      sha256: entry.sha256,
      size: entry.size as number,
      sourceVersionId: sourceVersionId as string | null,
    };
  });
}

function receipts(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw refusal("ledger-integrity", "a run receipt lists no commits");
  return value.map((item) => {
    const entry = record(item, "a commit receipt must be an object", "ledger-integrity");
    if (typeof entry.kind !== "string" || !OPERATION_RECEIPT_KINDS.has(entry.kind)) {
      throw refusal("ledger-integrity", "a commit receipt has an unknown kind");
    }
    assertLabel(entry.operationId, "a commit operation", "ledger-integrity");
    assertHash(entry.intentSha256, "a commit intent hash", "ledger-integrity");
    const output = record(entry.output, "a commit receipt has no output", "ledger-integrity");
    if (typeof output.id !== "string" || !FILE_ID.test(output.id)) {
      throw refusal("ledger-integrity", "a commit receipt has no usable file id");
    }
    if (typeof output.versionId !== "string" || !FILE_ID.test(output.versionId)) {
      throw refusal("ledger-integrity", "a commit receipt has no usable version id");
    }
    return entry;
  });
}

function validateWorker(value: unknown): WorkerIdentity {
  const worker = record(value, "a ledger entry has no worker identity", "ledger-integrity");
  const python = worker.python;
  if (typeof python !== "string" || !/^\d+\.\d+\.\d+$/u.test(python)) {
    throw refusal("ledger-integrity", "a ledger worker identity has no interpreter version");
  }
  return {
    python,
    image: typeof worker.image === "string" ? worker.image : `paper-worker:python-${python}`,
    libraries: stringMap(worker.libraries ?? {}, "worker libraries"),
    modules: stringMap(worker.modules ?? {}, "worker modules"),
  };
}

function stringMap(value: unknown, what: string): Readonly<Record<string, string>> {
  const raw = record(value, `a ledger ${what} entry is not an object`, "ledger-integrity");
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item !== "string") {
      throw refusal("ledger-integrity", `a ledger ${what} entry is not a string`);
    }
    out[key] = item;
  }
  return out;
}

function labels(value: unknown, optional: boolean): readonly string[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) throw refusal("ledger-integrity", "a ledger list is not a list");
  return value.map((item) => {
    if (typeof item !== "string") {
      throw refusal("ledger-integrity", "a ledger list holds a non-string entry");
    }
    return item;
  });
}

function assertTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw refusal("ledger-integrity", "a ledger entry has no timestamp");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw refusal("ledger-integrity", "a ledger entry has an unusable timestamp");
  }
  return value;
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function assertRealDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch((error: unknown) => {
    if (isNotFound(error)) throw refusal("ledger-integrity", "a run staging directory is missing");
    throw refusal(
      "ledger-integrity",
      `a run staging directory could not be checked: ${messageOf(error)}`,
    );
  });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw refusal(
      "ledger-integrity",
      "a run staging directory is a symbolic link or not a directory",
    );
  }
}

function digest(operationId: string): string {
  return createHash("sha256").update(operationId, "utf8").digest("hex");
}
