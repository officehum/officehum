import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertId } from "./file-validation.js";
import {
  type CreateVersionInput,
  type FileOperationReceipt,
  FileStoreError,
  type PutVersionInput,
  type VersionCommitReceipt,
  type VersionedFileRef,
  type VersionedFileStore,
} from "./files.js";
import { localFileStore } from "./local-files.js";
import { mutateState, readState, type VersionedState } from "./local-versioned-state.js";
import { intentHash, snapshotCreate, snapshotVersion } from "./versioned-file-validation.js";

const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

export function localVersionedFileStore(dir: string): Omit<VersionedFileStore, "publish"> {
  const root = resolve(dir);
  const blobs = localFileStore(join(root, "blobs"));

  async function verified(
    ref: VersionedFileRef,
  ): Promise<{ ref: VersionedFileRef; bytes: Uint8Array }> {
    try {
      const stored = await blobs.get(ref.versionId);
      if (!stored) throw integrity("Committed blob is missing");
      const projected = {
        id: ref.versionId,
        name: ref.name,
        mimeType: ref.mimeType,
        size: ref.size,
        sha256: ref.sha256,
        createdAt: ref.createdAt,
        metadata: ref.metadata,
      };
      if (!sameRef(stored.ref, projected)) throw integrity("Committed blob reference mismatch");
      return { ref: structuredClone(ref), bytes: Uint8Array.from(stored.bytes) };
    } catch (error) {
      if (error instanceof FileStoreError) throw error;
      throw integrity("Committed blob failed integrity validation");
    }
  }

  async function validateReceipt(receipt: FileOperationReceipt): Promise<void> {
    if (receipt.kind === "create" || receipt.kind === "version") {
      if (receipt.source) await verified(receipt.source);
      await verified(receipt.output);
    } else if (receipt.kind === "publish") {
      if (receipt.previous) await verified(receipt.previous);
      await verified(receipt.published);
    }
  }

  async function readVersion(state: VersionedState, fileId: string, versionId: string) {
    const ref = own(state.versions, versionId);
    if (!ref || ref.id !== fileId) return undefined;
    return verified(ref);
  }

  async function commitCreate(
    input: CreateVersionInput,
    legacy: boolean,
  ): Promise<VersionCommitReceipt> {
    const canonicalHash = intentHash({
      kind: "create",
      bytesSha256: hash(input.bytes),
      name: input.name,
      mimeType: input.mimeType,
      metadata: input.metadata,
      context: input.context,
    });
    const operationKey = digest(input.operationId);
    return mutateState(root, async (state) => {
      const previous = own(state.operations, operationKey);
      if (previous) {
        if (previous.kind !== "create" || previous.intentSha256 !== canonicalHash)
          throw collision();
        await validateReceipt(previous);
        return structuredClone(previous) as VersionCommitReceipt;
      }
      const blob = await blobs.put({
        bytes: input.bytes,
        name: input.name,
        mimeType: input.mimeType,
        metadata: input.metadata,
      });
      const output: VersionedFileRef = {
        ...blob,
        versionId: blob.id,
        sourceVersionId: null,
        operationId: legacy ? null : input.operationId,
        context: legacy ? null : structuredClone(input.context),
      };
      state.files[output.id] = {
        initial: output.versionId,
        head: output.versionId,
        published: null,
      };
      state.versions[output.versionId] = structuredClone(output);
      const receipt: VersionCommitReceipt = {
        kind: "create",
        operationId: input.operationId,
        intentSha256: canonicalHash,
        source: null,
        output,
      };
      state.operations[operationKey] = structuredClone(receipt);
      return receipt;
    });
  }

  async function edit(input: PutVersionInput): Promise<VersionCommitReceipt> {
    const canonicalBase = {
      kind: "version",
      bytesSha256: hash(input.bytes),
      name: input.name,
      mimeType: input.mimeType,
      metadata: input.metadata,
      context: input.context,
      fileId: input.fileId,
      sourceVersionId: input.sourceVersionId,
    };
    const operationKey = digest(input.operationId);
    return mutateState(root, async (state) => {
      const previous = own(state.operations, operationKey);
      if (previous) {
        if (previous.kind !== "version") throw collision();
        if (
          previous.output.id !== input.fileId ||
          previous.source?.versionId !== input.sourceVersionId
        )
          throw collision();
        const canonicalHash = intentHash({
          ...canonicalBase,
          sourceSha256: previous.source.sha256,
        });
        if (previous.intentSha256 !== canonicalHash) throw collision();
        await validateReceipt(previous);
        return structuredClone(previous);
      }
      const entry = own(state.files, input.fileId);
      const source = own(state.versions, input.sourceVersionId);
      if (!entry || !source || source.id !== input.fileId)
        throw notFound("Source version not found");
      await verified(source);
      const canonicalHash = intentHash({ ...canonicalBase, sourceSha256: source.sha256 });
      if (entry.head !== input.sourceVersionId)
        throw new FileStoreError("VERSION_CONFLICT", "Source version is no longer the head");
      const blob = await blobs.put({
        bytes: input.bytes,
        name: input.name,
        mimeType: input.mimeType,
        metadata: input.metadata,
      });
      const output: VersionedFileRef = {
        ...blob,
        id: input.fileId,
        versionId: blob.id,
        sourceVersionId: input.sourceVersionId,
        operationId: input.operationId,
        context: structuredClone(input.context),
      };
      state.versions[output.versionId] = structuredClone(output);
      entry.head = output.versionId;
      const receipt: VersionCommitReceipt = {
        kind: "version",
        operationId: input.operationId,
        intentSha256: canonicalHash,
        source: structuredClone(source),
        output,
      };
      state.operations[operationKey] = structuredClone(receipt);
      return receipt;
    });
  }

  return {
    async put(input) {
      const bytes = Uint8Array.from(input.bytes);
      const metadata = structuredClone(input.metadata);
      const blob = await blobs.put({ bytes, name: input.name, mimeType: input.mimeType, metadata });
      const output: VersionedFileRef = {
        ...blob,
        versionId: blob.id,
        sourceVersionId: null,
        operationId: null,
        context: null,
      };
      await mutateState(root, async (state) => {
        state.files[output.id] = {
          initial: output.versionId,
          head: output.versionId,
          published: null,
        };
        state.versions[output.versionId] = structuredClone(output);
        return undefined;
      });
      return structuredClone(output);
    },
    async create(input) {
      return commitCreate(snapshotCreate(input), false);
    },
    async putVersion(input) {
      return edit(snapshotVersion(input));
    },
    async get(id) {
      assertId(id);
      const state = await readState(root);
      const file = own(state.files, id);
      return file ? readVersion(state, id, file.initial) : undefined;
    },
    async info(id) {
      assertId(id);
      const state = await readState(root);
      const file = own(state.files, id);
      return file ? (await readVersion(state, id, file.initial))?.ref : undefined;
    },
    async getVersion(fileId, versionId) {
      assertId(fileId);
      assertId(versionId);
      return readVersion(await readState(root), fileId, versionId);
    },
    async getHead(fileId) {
      assertId(fileId);
      const state = await readState(root);
      const file = own(state.files, fileId);
      return file ? (await readVersion(state, fileId, file.head))?.ref : undefined;
    },
    async getPublished(fileId) {
      assertId(fileId);
      const state = await readState(root);
      const file = own(state.files, fileId);
      return file?.published ? (await readVersion(state, fileId, file.published))?.ref : undefined;
    },
    async lookupOperation(operationId) {
      assertOperationId(operationId);
      const receipt = own((await readState(root)).operations, digest(operationId));
      if (!receipt) return undefined;
      await validateReceipt(receipt);
      return structuredClone(receipt);
    },
  };
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function assertOperationId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /\p{Cc}/u.test(value) ||
    Buffer.byteLength(value, "utf8") > 256
  )
    throw new FileStoreError("INVALID_INPUT", "Invalid operation ID");
}
function sameRef(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
function collision(): FileStoreError {
  return new FileStoreError("OPERATION_COLLISION", "Operation ID has different intent");
}
function notFound(message: string): FileStoreError {
  return new FileStoreError("NOT_FOUND", message);
}
function integrity(message: string): FileStoreError {
  return new FileStoreError("INTEGRITY", message);
}
