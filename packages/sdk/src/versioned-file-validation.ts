import { createHash } from "node:crypto";
import {
  assertId,
  assertMetadata,
  assertMimeType,
  assertName,
  assertSignature,
} from "./file-validation.js";
import {
  type CreateVersionInput,
  type FileMetadata,
  FileStoreError,
  type PublishVersionInput,
  type PutVersionInput,
  type VersionContext,
} from "./files.js";

const CREATE_KEYS = new Set(["operationId", "bytes", "name", "mimeType", "metadata", "context"]);
const VERSION_KEYS = new Set([...CREATE_KEYS, "fileId", "sourceVersionId"]);
const PUBLISH_KEYS = new Set([
  "operationId",
  "fileId",
  "expectedPublishedVersionId",
  "versionId",
  "approvalId",
]);
const METADATA_KEYS = new Set(["createdBy", "source", "aiGenerated", "derivedFrom", "provenance"]);

export function intentHash(value: unknown): string {
  const seen = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === "string" || typeof item === "boolean") {
      return JSON.stringify(item);
    }
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || seen.has(item)) {
      throw invalid("Intent must be finite acyclic JSON");
    }
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        for (let index = 0; index < item.length; index += 1) {
          if (!Object.hasOwn(item, index)) throw invalid("Sparse intent array");
        }
        return `[${item.map(encode).join(",")}]`;
      }
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      ) {
        throw invalid("Intent must contain plain objects");
      }
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
        .join(",")}}`;
    } finally {
      seen.delete(item);
    }
  }
  return createHash("sha256").update(encode(value)).digest("hex");
}

export function snapshotCreate(input: CreateVersionInput): CreateVersionInput {
  return capture(() => {
    assertPlainObject(input);
    assertAllowedKeys(input, CREATE_KEYS);
    assertOperationString(input.operationId);
    if (!(input.bytes instanceof Uint8Array)) throw invalid("Invalid file bytes");
    assertName(input.name);
    assertMimeType(input.mimeType);
    const bytes = Uint8Array.from(input.bytes);
    assertSignature(bytes, input.mimeType);
    const normalizedMetadata = snapshotMetadata(input.metadata);
    const context = snapshotContext(input.context);
    return {
      operationId: input.operationId,
      bytes,
      name: input.name,
      mimeType: input.mimeType,
      metadata: normalizedMetadata,
      context,
    };
  });
}

export function snapshotVersion(input: PutVersionInput): PutVersionInput {
  return capture(() => {
    assertPlainObject(input);
    assertAllowedKeys(input, VERSION_KEYS);
    assertId(input.fileId);
    assertId(input.sourceVersionId);
    const snapshot = snapshotCreate({
      operationId: input.operationId,
      bytes: input.bytes,
      name: input.name,
      mimeType: input.mimeType,
      metadata: input.metadata,
      context: input.context,
    });
    return { ...snapshot, fileId: input.fileId, sourceVersionId: input.sourceVersionId };
  });
}

export function snapshotPublish(input: PublishVersionInput): PublishVersionInput {
  return capture(() => {
    assertPlainObject(input);
    assertAllowedKeys(input, PUBLISH_KEYS);
    assertOperationString(input.operationId);
    assertId(input.fileId);
    if (input.expectedPublishedVersionId !== null) assertId(input.expectedPublishedVersionId);
    assertId(input.versionId);
    assertOperationString(input.approvalId);
    return {
      operationId: input.operationId,
      fileId: input.fileId,
      expectedPublishedVersionId: input.expectedPublishedVersionId,
      versionId: input.versionId,
      approvalId: input.approvalId,
    };
  });
}

function snapshotContext(value: VersionContext): VersionContext {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["taskId", "policyVersion", "worker", "argumentsSha256"]));
  assertOperationString(value.taskId);
  assertOperationString(value.policyVersion);
  if (typeof value.argumentsSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.argumentsSha256)) {
    throw invalid("Invalid context hash");
  }
  assertPlainObject(value.worker);
  assertAllowedKeys(value.worker, new Set(["image", "libraries"]));
  assertOperationString(value.worker.image);
  assertPlainObject(value.worker.libraries);
  const libraryEntries = Object.entries(value.worker.libraries);
  if (libraryEntries.length > 32) throw invalid("Too many worker libraries");
  const libraries: Record<string, string> = {};
  for (const [key, libraryVersion] of libraryEntries) {
    assertOperationString(key);
    assertOperationString(libraryVersion);
    libraries[key] = libraryVersion;
  }
  return {
    taskId: value.taskId,
    policyVersion: value.policyVersion,
    worker: { image: value.worker.image, libraries },
    argumentsSha256: value.argumentsSha256,
  };
}

function snapshotMetadata(value: FileMetadata): FileMetadata {
  if (!isRecord(value)) throw invalid("Invalid file metadata");
  assertAllowedKeys(value, METADATA_KEYS);
  // Build the metadata explicitly so optional properties set to undefined disappear.
  const normalized: Record<string, unknown> = {
    createdBy: value.createdBy,
    source: value.source,
  };
  if (value.aiGenerated !== undefined) normalized.aiGenerated = structuredClone(value.aiGenerated);
  if (value.derivedFrom !== undefined) normalized.derivedFrom = structuredClone(value.derivedFrom);
  if (value.provenance !== undefined) normalized.provenance = value.provenance;
  assertMetadata(normalized);
  return normalized as FileMetadata;
}

function assertOperationString(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /\p{Cc}/u.test(value) ||
    Buffer.byteLength(value, "utf8") > 256
  ) {
    throw invalid("Invalid operation context string");
  }
}

function assertAllowedKeys(value: object, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalid("Unknown input field");
}

function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw invalid("Expected a plain object");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capture<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof FileStoreError && error.code === "INVALID_INPUT") throw error;
    throw invalid("Invalid versioned file input");
  }
}

function invalid(message: string): FileStoreError {
  return new FileStoreError("INVALID_INPUT", message);
}
