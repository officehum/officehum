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
  put(input: { bytes: Uint8Array; name: string; mimeType: string; metadata: FileMetadata }): Promise<FileRef>;
  get(id: string): Promise<{ ref: FileRef; bytes: Uint8Array } | undefined>;
  info(id: string): Promise<FileRef | undefined>;
}

export const MAX_INLINE_IMAGE_BYTES = 100_000;
