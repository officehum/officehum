import type { FileMetadata, FileRef } from "./files.js";

const FILE_ID = /^file_[0-9A-HJKMNP-TV-Z]{26}$/;
const SOURCE_VALUES = new Set(["generated", "uploaded", "external", "derived"]);
const METADATA_KEYS = new Set(["createdBy", "source", "aiGenerated", "derivedFrom", "provenance"]);

export function assertId(id: string): void {
  if (typeof id !== "string" || !FILE_ID.test(id)) throw new Error("Invalid file ID");
}

export function assertName(name: string): void {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.toLowerCase() === "meta.json" ||
    name.includes("/") ||
    name.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(name) ||
    Buffer.byteLength(name, "utf8") > 255
  ) {
    throw new Error("Invalid file name");
  }
}

export function assertMetadata(value: unknown): asserts value is FileMetadata {
  if (!isRecord(value)) throw new Error("Invalid file metadata");
  for (const key of Object.keys(value)) {
    if (!METADATA_KEYS.has(key)) throw new Error("Unknown file metadata field");
  }
  if (typeof value.createdBy !== "string" || value.createdBy.trim().length === 0) {
    throw new Error("Invalid file metadata creator");
  }
  if (typeof value.source !== "string" || !SOURCE_VALUES.has(value.source)) {
    throw new Error("Invalid file metadata source");
  }
  if (value.provenance !== undefined && value.provenance !== "internal" && value.provenance !== "external") {
    throw new Error("Invalid file provenance");
  }
  if (value.source === "external" && value.provenance === "internal") {
    throw new Error("External files cannot have internal provenance");
  }
  if (value.aiGenerated !== undefined) {
    if (
      !isRecord(value.aiGenerated) ||
      Object.keys(value.aiGenerated).some((key) => key !== "model" && key !== "prompt") ||
      typeof value.aiGenerated.model !== "string" ||
      typeof value.aiGenerated.prompt !== "string"
    ) {
      throw new Error("Invalid AI generation metadata");
    }
  }
  if (
    value.derivedFrom !== undefined &&
    (!Array.isArray(value.derivedFrom) || value.derivedFrom.some((id) => typeof id !== "string" || !FILE_ID.test(id)))
  ) {
    throw new Error("Invalid derived file IDs");
  }
}

export function assertRef(value: unknown, expectedId: string): asserts value is FileRef {
  assertId(expectedId);
  if (!isRecord(value)) throw new Error("Invalid file reference");
  if (value.id !== expectedId) throw new Error("File reference ID mismatch");
  assertName(value.name as string);
  if (typeof value.mimeType !== "string" || value.mimeType.trim().length === 0) {
    throw new Error("Invalid file MIME type");
  }
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) throw new Error("Invalid file size");
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)) {
    throw new Error("Invalid file hash");
  }
  if (typeof value.createdAt !== "string" || !isIsoTimestamp(value.createdAt)) {
    throw new Error("Invalid file timestamp");
  }
  assertMetadata(value.metadata);
  const allowed = new Set(["id", "name", "mimeType", "size", "sha256", "createdAt", "metadata"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Unknown file reference field");
}

export function assertSignature(bytes: Uint8Array, mimeType: string): void {
  const signatures: Array<{ mime: string; matches: (data: Uint8Array) => boolean }> = [
    { mime: "image/png", matches: (data) => startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { mime: "image/jpeg", matches: (data) => startsWith(data, [0xff, 0xd8, 0xff]) },
    { mime: "image/gif", matches: (data) => startsWith(data, ascii("GIF87a")) || startsWith(data, ascii("GIF89a")) },
    {
      mime: "image/webp",
      matches: (data) => startsWith(data, ascii("RIFF")) && startsWith(data.subarray(8), ascii("WEBP")),
    },
    { mime: "application/pdf", matches: (data) => startsWith(data, ascii("%PDF-")) },
  ];
  const declared = signatures.find((signature) => signature.mime === mimeType);
  const actual = signatures.find((signature) => signature.matches(bytes));
  if ((declared && !declared.matches(bytes)) || (actual && actual.mime !== mimeType)) {
    throw new Error("File signature does not match MIME type");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return data.length >= prefix.length && prefix.every((byte, index) => data[index] === byte);
}

function ascii(value: string): number[] {
  return Array.from(value, (character) => character.charCodeAt(0));
}

function isIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
