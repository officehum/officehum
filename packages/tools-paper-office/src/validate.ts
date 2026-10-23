/**
 * Input validation for everything the pack accepts: leases, run requests, ledger records and worker
 * answers. All of it is untrusted — a lease can come from a host workflow, a worker answer from a
 * subprocess — so every shape is checked with exact keys and explicit types rather than trusted.
 */

import { DocumentError, type DocumentRefusalCode, refusal } from "./errors.js";

const FILE_ID = /^file_[0-9A-HJKMNP-TV-Z]{26}$/u;
const HASH = /^[0-9a-f]{64}$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

export function record(
  value: unknown,
  message: string,
  code: DocumentRefusalCode = "invalid-request",
): Record<string, unknown> {
  if (!isRecord(value)) throw refusal(code, message);
  return value;
}

export function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  message: string,
  code: DocumentRefusalCode = "invalid-request",
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw refusal(code, message);
  }
}

/** A bounded, printable label: a task id, policy version, operation id or library version. */
export function assertLabel(
  value: unknown,
  what: string,
  code: DocumentRefusalCode = "invalid-request",
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /\p{Cc}/u.test(value) ||
    Buffer.byteLength(value, "utf8") > 256
  ) {
    throw refusal(code, `${what} must be a non-empty string of at most 256 bytes`);
  }
}

export function assertFileId(
  value: unknown,
  what = "file id",
  code: DocumentRefusalCode = "invalid-request",
): asserts value is string {
  if (typeof value !== "string" || !FILE_ID.test(value)) {
    throw refusal(code, `${what} must be a FileStore id`);
  }
}

export function assertHash(
  value: unknown,
  what = "hash",
  code: DocumentRefusalCode = "invalid-request",
): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw refusal(code, `${what} must be a lowercase sha256 hex digest`);
  }
}

export function assertSize(
  value: unknown,
  what = "size",
  code: DocumentRefusalCode = "invalid-request",
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw refusal(code, `${what} must be a non-negative integer`);
  }
}

/**
 * A single path segment: the only name shape the workspace accepts for an input or an output. A
 * lease never grants a directory, so a name that could traverse (`/`, `\`, `..`) is refused here,
 * before it can reach a filesystem call.
 */
export function assertPathSegment(
  value: unknown,
  what: string,
  code: DocumentRefusalCode = "traversal",
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    /\p{Cc}/u.test(value) ||
    Buffer.byteLength(value, "utf8") > 255
  ) {
    throw refusal(code, `${what} must be a single path segment of at most 255 bytes`);
  }
}

export function isNotFound(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asDocumentError(error: unknown): DocumentError {
  if (error instanceof DocumentError) return error;
  return new DocumentError("invalid-request", messageOf(error));
}
