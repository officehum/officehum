import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { assertId, assertRef } from "./file-validation.js";
import type {
  FileOperationReceipt,
  PublishReceipt,
  VersionCommitReceipt,
  VersionContext,
  VersionedFileRef,
} from "./files.js";
import { FileStoreError as StoreError } from "./files.js";

export interface VersionedState {
  schema: 1;
  files: Record<string, { initial: string; head: string; published: string | null }>;
  versions: Record<string, VersionedFileRef>;
  operations: Record<string, FileOperationReceipt>;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const EMPTY_STATE = (): VersionedState => ({ schema: 1, files: {}, versions: {}, operations: {} });

export async function readState(root: string): Promise<VersionedState> {
  const manifestPath = join(root, "manifest.json");
  let rootStat: Stats;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (isNotFound(error)) return EMPTY_STATE();
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw integrity("Invalid state root");

  let manifestStat: Stats;
  try {
    manifestStat = await lstat(manifestPath);
  } catch (error) {
    if (isNotFound(error)) return EMPTY_STATE();
    throw error;
  }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile())
    throw integrity("Invalid manifest entry");

  const handle = await open(manifestPath, constants.O_RDONLY | NOFOLLOW);
  let parsed: unknown;
  try {
    if (!(await handle.stat()).isFile()) throw integrity("Invalid manifest entry");
    const contents = await handle.readFile("utf8");
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      throw integrity("Corrupt manifest JSON");
    }
  } finally {
    await handle.close();
  }
  return validateState(parsed);
}

export async function mutateState<T>(
  root: string,
  change: (state: VersionedState) => Promise<T>,
): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertDirectory(root, "Invalid state root");
  const lockPath = join(root, ".write-lock");
  let ownsLock = false;
  let lockIdentity: { dev: number; ino: number } | undefined;
  let tempPath: string | undefined;
  try {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        ownsLock = true;
        const lockStat = await lstat(lockPath);
        if (lockStat.isSymbolicLink() || !lockStat.isDirectory())
          throw integrity("Invalid write lock");
        lockIdentity = { dev: lockStat.dev, ino: lockStat.ino };
        break;
      } catch (error) {
        if (ownsLock) throw error;
        if (!isExists(error)) throw error;
        let existing: Stats;
        try {
          existing = await lstat(lockPath);
        } catch (statError) {
          if (isNotFound(statError)) continue;
          throw statError;
        }
        if (existing.isSymbolicLink()) throw integrity("Invalid write lock");
        if (!existing.isDirectory()) throw integrity("Invalid write lock");
        if (attempt === 499) throw new StoreError("BUSY", "Timed out waiting for manifest lock");
        await delay(10);
      }
    }
    if (!ownsLock) throw new StoreError("BUSY", "Timed out waiting for manifest lock");

    const state = await readState(root);
    const result = await change(state);
    const checked = validateState(state);
    tempPath = join(root, `.manifest-${randomBytes(16).toString("hex")}.json`);
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(checked), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, join(root, "manifest.json"));
    tempPath = undefined;
    return structuredClone(result);
  } finally {
    if (tempPath)
      await unlink(tempPath).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    if (ownsLock && lockIdentity) {
      const current = await lstat(lockPath).catch((error: unknown) => {
        if (isNotFound(error)) return undefined;
        throw error;
      });
      if (
        current &&
        !current.isSymbolicLink() &&
        current.isDirectory() &&
        current.dev === lockIdentity.dev &&
        current.ino === lockIdentity.ino
      ) {
        await rmdir(lockPath);
      }
    }
  }
}

function validateState(value: unknown): VersionedState {
  try {
    const object = record(value, "Invalid manifest");
    exactKeys(object, ["schema", "files", "versions", "operations"]);
    if (object.schema !== 1) throw new Error("Unsupported manifest schema");
    const fileInput = record(object.files, "Invalid files map");
    const versionInput = record(object.versions, "Invalid versions map");
    const operationInput = record(object.operations, "Invalid operations map");
    const files: VersionedState["files"] = Object.fromEntries(
      Object.entries(fileInput).map(([id, raw]) => {
        assertId(id);
        const entry = record(raw, "Invalid file state");
        exactKeys(entry, ["initial", "head", "published"]);
        if (
          typeof entry.initial !== "string" ||
          typeof entry.head !== "string" ||
          (entry.published !== null && typeof entry.published !== "string")
        ) {
          throw new Error("Invalid file state references");
        }
        return [id, { initial: entry.initial, head: entry.head, published: entry.published }];
      }),
    );

    const versions: VersionedState["versions"] = Object.fromEntries(
      Object.entries(versionInput).map(([versionId, raw]) => {
        assertId(versionId);
        const ref = record(raw, "Invalid version reference");
        const { id } = ref;
        if (typeof id !== "string") throw new Error("Invalid version file ID");
        assertId(id);
        assertRef(projectRef(ref), id);
        exactKeys(ref, [
          "id",
          "name",
          "mimeType",
          "size",
          "sha256",
          "createdAt",
          "metadata",
          "versionId",
          "sourceVersionId",
          "operationId",
          "context",
        ]);
        if (ref.versionId !== versionId) throw new Error("Version key mismatch");
        if (ref.sourceVersionId !== null) assertId(asString(ref.sourceVersionId));
        if (ref.operationId !== null) assertOperationId(ref.operationId);
        const context = ref.context === null ? null : parseContext(ref.context);
        const base = projectRef(ref) as unknown as VersionedFileRef;
        return [
          versionId,
          {
            ...base,
            versionId,
            sourceVersionId: ref.sourceVersionId as string | null,
            operationId: ref.operationId as string | null,
            context,
          },
        ];
      }),
    );

    const operations: VersionedState["operations"] = Object.fromEntries(
      Object.entries(operationInput).map(([digest, raw]) => {
        if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error("Invalid operation key");
        const receipt = parseReceipt(raw);
        if (operationDigest(receipt.operationId) !== digest)
          throw new Error("Operation key mismatch");
        return [digest, receipt];
      }),
    );

    for (const [fileId, entry] of Object.entries(files)) {
      for (const versionId of [entry.initial, entry.head, entry.published].filter(
        (item): item is string => item !== null,
      )) {
        assertId(versionId);
        const ref = own(versions, versionId);
        if (!ref || ref.id !== fileId) throw new Error("Dangling or cross-file version reference");
      }
      const initial = own(versions, entry.initial);
      if (!initial || initial.sourceVersionId !== null)
        throw new Error("Initial version has a source");
    }
    for (const [versionId, ref] of Object.entries(versions)) {
      if (!Object.hasOwn(files, ref.id)) throw new Error("Version has no file state");
      const sourceId = ref.sourceVersionId;
      if (sourceId !== null) {
        const source = own(versions, sourceId);
        if (!source || source.id !== ref.id || source.versionId === versionId)
          throw new Error("Invalid source version chain");
        const visited = new Set([versionId]);
        let ancestor: VersionedFileRef | undefined = source;
        while (ancestor) {
          if (visited.has(ancestor.versionId)) throw new Error("Cyclic source version chain");
          visited.add(ancestor.versionId);
          ancestor =
            ancestor.sourceVersionId === null ? undefined : own(versions, ancestor.sourceVersionId);
          if (ancestor && ancestor.id !== ref.id)
            throw new Error("Cross-file source version chain");
        }
      }
      if (ref.operationId !== null) {
        const receipt = own(operations, operationDigest(ref.operationId));
        if (
          !receipt ||
          receipt.operationId !== ref.operationId ||
          receipt.kind === "publish" ||
          receipt.output.versionId !== versionId
        )
          throw new Error("Version operation receipt mismatch");
      }
    }
    for (const receipt of Object.values(operations)) {
      if (receipt.kind === "create" || receipt.kind === "version") {
        const output = own(versions, receipt.output.versionId);
        if (
          !output ||
          !same(output, receipt.output) ||
          receipt.output.operationId !== receipt.operationId ||
          (receipt.kind === "create" && receipt.output.sourceVersionId !== null) ||
          (receipt.kind === "version" &&
            receipt.output.sourceVersionId !== receipt.source?.versionId)
        ) {
          throw new Error("Receipt output mismatch");
        }
        if (receipt.source !== null) {
          const source = own(versions, receipt.source.versionId);
          if (!source || !same(source, receipt.source)) throw new Error("Receipt source mismatch");
        }
      } else if (receipt.kind === "publish") {
        const published = own(versions, receipt.published.versionId);
        if (
          !published ||
          !same(published, receipt.published) ||
          (receipt.previous && receipt.previous.id !== receipt.published.id)
        )
          throw new Error("Receipt publication mismatch");
        if (receipt.previous !== null) {
          const previous = own(versions, receipt.previous.versionId);
          if (!previous || !same(previous, receipt.previous))
            throw new Error("Receipt previous mismatch");
        }
      }
    }
    return { schema: 1, files, versions, operations };
  } catch (error) {
    if (error instanceof StoreError && error.code === "INTEGRITY") throw error;
    throw integrity(error instanceof Error ? error.message : "Invalid manifest");
  }
}

function parseReceipt(value: unknown): FileOperationReceipt {
  const receipt = record(value, "Invalid operation receipt");
  if (receipt.kind === "create" || receipt.kind === "version") {
    exactKeys(receipt, ["kind", "operationId", "intentSha256", "source", "output"]);
    assertOperationId(receipt.operationId);
    assertHash(receipt.intentSha256);
    const source = receipt.source === null ? null : parseVersionRef(receipt.source);
    const output = parseVersionRef(receipt.output);
    if (receipt.kind === "create" && source !== null)
      throw new Error("Create receipt has a source");
    if (receipt.kind === "version" && source === null)
      throw new Error("Version receipt lacks a source");
    return {
      kind: receipt.kind,
      operationId: receipt.operationId,
      intentSha256: receipt.intentSha256,
      source,
      output,
    } as VersionCommitReceipt;
  }
  if (receipt.kind === "publish") {
    exactKeys(receipt, [
      "kind",
      "operationId",
      "intentSha256",
      "approvalId",
      "previous",
      "published",
    ]);
    assertOperationId(receipt.operationId);
    assertOperationId(receipt.approvalId);
    assertHash(receipt.intentSha256);
    const previous = receipt.previous === null ? null : parseVersionRef(receipt.previous);
    const published = parseVersionRef(receipt.published);
    return {
      kind: "publish",
      operationId: receipt.operationId,
      intentSha256: receipt.intentSha256,
      approvalId: receipt.approvalId,
      previous,
      published,
    } as PublishReceipt;
  }
  throw new Error("Invalid operation kind");
}

function parseVersionRef(value: unknown): VersionedFileRef {
  const ref = record(value, "Invalid receipt reference");
  const id = asString(ref.id);
  assertId(id);
  assertRef(projectRef(ref), id);
  exactKeys(ref, [
    "id",
    "name",
    "mimeType",
    "size",
    "sha256",
    "createdAt",
    "metadata",
    "versionId",
    "sourceVersionId",
    "operationId",
    "context",
  ]);
  assertId(asString(ref.versionId));
  if (ref.sourceVersionId !== null) assertId(asString(ref.sourceVersionId));
  if (ref.operationId !== null) assertOperationId(ref.operationId);
  const context = ref.context === null ? null : parseContext(ref.context);
  return {
    ...projectRef(ref),
    versionId: ref.versionId,
    sourceVersionId: ref.sourceVersionId,
    operationId: ref.operationId,
    context,
  } as VersionedFileRef;
}

function parseContext(value: unknown): VersionContext {
  const context = record(value, "Invalid version context");
  exactKeys(context, ["taskId", "policyVersion", "worker", "argumentsSha256"]);
  assertOperationId(context.taskId);
  assertOperationId(context.policyVersion);
  assertHash(context.argumentsSha256);
  const worker = record(context.worker, "Invalid worker context");
  exactKeys(worker, ["image", "libraries"]);
  assertOperationId(worker.image);
  const libraries = record(worker.libraries, "Invalid worker libraries");
  if (Object.keys(libraries).length > 32) throw new Error("Too many worker libraries");
  for (const [key, item] of Object.entries(libraries)) {
    assertOperationId(key);
    assertOperationId(item);
  }
  return {
    taskId: context.taskId,
    policyVersion: context.policyVersion,
    worker: {
      image: worker.image,
      libraries: Object.fromEntries(Object.entries(libraries)) as Record<string, string>,
    },
    argumentsSha256: context.argumentsSha256,
  };
}

function projectRef(ref: Record<string, unknown>) {
  return {
    id: ref.id,
    name: ref.name,
    mimeType: ref.mimeType,
    size: ref.size,
    sha256: ref.sha256,
    createdAt: ref.createdAt,
    metadata: ref.metadata,
  };
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new Error(message);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Unknown stored field");
}

function assertOperationId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /\p{Cc}/u.test(value) ||
    Buffer.byteLength(value, "utf8") > 256
  ) {
    throw new Error("Invalid operation ID");
  }
}

function assertHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error("Invalid hash");
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}

function operationDigest(operationId: string): string {
  return createHash("sha256").update(operationId, "utf8").digest("hex");
}

function own<T>(value: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function same(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

async function assertDirectory(path: string, message: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw integrity(message);
}

function integrity(message: string): StoreError {
  return new StoreError("INTEGRITY", message);
}

function isNotFound(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function isExists(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
