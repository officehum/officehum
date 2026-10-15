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

export const MAX_INLINE_IMAGE_BYTES = 100_000;

export function fileResult(
  refs: readonly FileRef[],
  options: { preview?: { bytes: Uint8Array; mimeType: string } } = {},
): { content: Array<TextContent | ImageContent>; details: { files: string[] } } {
  if (!Array.isArray(refs) || refs.length > 100) throw new Error("Invalid file references");
  for (const ref of refs) {
    assertId(ref.id);
    assertName(ref.name);
    assertMimeType(ref.mimeType);
    if (!Number.isSafeInteger(ref.size) || ref.size < 0) throw new Error("Invalid file size");
  }

  const files = refs.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }));
  const content: Array<TextContent | ImageContent> = [
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
    content.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType });
  }
  return { content, details: { files: refs.map((ref) => ref.id) } };
}
