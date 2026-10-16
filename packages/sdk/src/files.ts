import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { assertId, assertMimeType, assertName, assertSignature } from "./file-validation.js";

export interface FileMetadata {
  readonly createdBy: string;
  readonly source: "generated" | "uploaded" | "external" | "derived";
  readonly aiGenerated?: { readonly model: string; readonly prompt: string };
  readonly derivedFrom?: readonly string[];
  readonly provenance?: "internal" | "external";
}

export interface FileRef {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly metadata: FileMetadata;
}

export interface FileStore {
  put(input: {
    bytes: Uint8Array;
    name: string;
    mimeType: string;
    metadata: FileMetadata;
  }): Promise<FileRef>;
  get(id: string): Promise<{ ref: FileRef; bytes: Uint8Array } | undefined>;
  info(id: string): Promise<FileRef | undefined>;
}

export interface VersionContext {
  readonly taskId: string;
  readonly policyVersion: string;
  readonly worker: {
    readonly image: string;
    readonly libraries: Readonly<Record<string, string>>;
  };
  readonly argumentsSha256: string;
}

export interface VersionedFileRef extends FileRef {
  readonly versionId: string;
  readonly sourceVersionId: string | null;
  readonly operationId: string | null;
  readonly context: VersionContext | null;
}

export interface CreateVersionInput {
  readonly operationId: string;
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly mimeType: string;
  readonly metadata: FileMetadata;
  readonly context: VersionContext;
}

export interface PutVersionInput extends CreateVersionInput {
  readonly fileId: string;
  readonly sourceVersionId: string;
}

export interface PublishVersionInput {
  readonly operationId: string;
  readonly fileId: string;
  readonly expectedPublishedVersionId: string | null;
  readonly versionId: string;
  readonly approvalId: string;
}

export interface VersionCommitReceipt {
  readonly kind: "create" | "version";
  readonly operationId: string;
  readonly intentSha256: string;
  readonly source: VersionedFileRef | null;
  readonly output: VersionedFileRef;
}

export interface PublishReceipt {
  readonly kind: "publish";
  readonly operationId: string;
  readonly intentSha256: string;
  readonly approvalId: string;
  readonly previous: VersionedFileRef | null;
  readonly published: VersionedFileRef;
}

export type FileOperationReceipt = VersionCommitReceipt | PublishReceipt;

export class FileStoreError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "VERSION_CONFLICT"
      | "OPERATION_COLLISION"
      | "INTEGRITY"
      | "BUSY",
    message: string,
  ) {
    super(message);
    this.name = "FileStoreError";
  }
}

export interface VersionedFileStore extends FileStore {
  put(input: Parameters<FileStore["put"]>[0]): Promise<VersionedFileRef>;
  get(id: string): Promise<{ ref: VersionedFileRef; bytes: Uint8Array } | undefined>;
  info(id: string): Promise<VersionedFileRef | undefined>;
  create(input: CreateVersionInput): Promise<VersionCommitReceipt>;
  putVersion(input: PutVersionInput): Promise<VersionCommitReceipt>;
  getVersion(
    fileId: string,
    versionId: string,
  ): Promise<{ ref: VersionedFileRef; bytes: Uint8Array } | undefined>;
  getHead(fileId: string): Promise<VersionedFileRef | undefined>;
  getPublished(fileId: string): Promise<VersionedFileRef | undefined>;
  lookupOperation(operationId: string): Promise<FileOperationReceipt | undefined>;
  publish(input: PublishVersionInput): Promise<PublishReceipt>;
}

export const MAX_INLINE_IMAGE_BYTES = 100_000;

export function fileResult(
  refs: readonly FileRef[],
  options: { preview?: { bytes: Uint8Array; mimeType: string } } = {},
): { output: Array<TextContent | ImageContent>; details: { files: string[] } } {
  if (!Array.isArray(refs) || refs.length > 100) throw new Error("Invalid file references");
  for (const ref of refs) {
    assertId(ref.id);
    assertName(ref.name);
    assertMimeType(ref.mimeType);
    if (!Number.isSafeInteger(ref.size) || ref.size < 0) throw new Error("Invalid file size");
  }

  const files = refs.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }));
  const output: Array<TextContent | ImageContent> = [
    { type: "text", text: JSON.stringify({ files }) },
  ];
  if (options.preview) {
    const { bytes, mimeType } = options.preview;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
      throw new Error("Invalid or oversized image preview");
    }
    assertMimeType(mimeType);
    if (!new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]).has(mimeType)) {
      throw new Error("Unsupported image preview MIME type");
    }
    assertSignature(bytes, mimeType);
    output.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType });
  }
  return { output, details: { files: refs.map((ref) => ref.id) } };
}
