/**
 * What the typed Word, PowerPoint and Excel operations share.
 *
 * Each format has its own request shapes and its own result, but the ground they stand on is the same:
 * a request is untrusted JSON read with exact keys and explicit types, a file reference is resolved
 * against the lease and never trusted as given, a read answers with one bounded page, and the worker's
 * answer is validated field by field before a model sees it. Those pieces live here once, so a rule
 * about a lease or a page cannot drift between the three formats.
 */

import { type DocumentError, refusal } from "./errors.js";
import type { DocumentFormat } from "./formats.js";
import { type DocumentLease, findLeasedInput, type LeasedInput, permitsFormat } from "./lease.js";
import {
  assertFileId,
  assertHash,
  assertPathSegment,
  assertSize,
  exactKeys,
  isRecord,
  record,
} from "./validate.js";

/** A FileStore version as a caller names it and as a result reports it: never a path. */
export interface DocumentFileRef {
  readonly fileId: string;
  readonly versionId: string;
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}

/** One bounded page of a section, with the cursor that continues it. */
export interface DocumentPage<T> {
  readonly section: string;
  readonly pageSize: number;
  readonly cursor: number;
  readonly returned: number;
  readonly total: number;
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
  readonly items: readonly T[];
}

// -- reading the request --------------------------------------------------------------------------

export function object(
  value: unknown,
  what: string,
  allowed?: readonly string[],
): Record<string, unknown> {
  const entry = record(value, `${what} must be a JSON object`);
  if (allowed !== undefined) exactKeys(entry, allowed, `${what} carries an unknown field`);
  return entry;
}

export function text(value: unknown, what: string, limit: number): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    Buffer.byteLength(value, "utf8") > limit
  ) {
    throw refusal(
      "invalid-request",
      `${what} must be a non-empty string of at most ${limit} bytes`,
    );
  }
  return value;
}

export function maybeText(value: unknown, what: string, limit: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > limit) {
    throw refusal("invalid-request", `${what} must be a string of at most ${limit} bytes`);
  }
  return value;
}

export function flag(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw refusal("invalid-request", `${what} must be true or false`);
  return value;
}

export function whole(value: unknown, what: string, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < low || value > high) {
    throw refusal("invalid-request", `${what} must be an integer between ${low} and ${high}`);
  }
  return value;
}

export function oneOf(value: unknown, what: string, allowed: readonly string[]): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw refusal("invalid-request", `${what} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

/** The shape of a file reference, before the lease is consulted. */
export function assertFileRef(value: unknown, what: string): DocumentFileRef {
  const entry = object(value, what, ["fileId", "versionId", "name", "sha256", "size"]);
  assertFileId(entry.fileId, `${what} fileId`);
  assertFileId(entry.versionId, `${what} versionId`);
  assertPathSegment(entry.name, `${what} name`);
  assertHash(entry.sha256, `${what} sha256`);
  assertSize(entry.size, `${what} size`);
  return {
    fileId: entry.fileId,
    versionId: entry.versionId,
    name: entry.name,
    sha256: entry.sha256,
    size: entry.size,
  };
}

/**
 * The leased input a reference names, or a refusal. Every field is checked against the lease: the
 * lease, not the caller, decides what an operation may read, and each operation reads one format.
 */
export function resolveRef(
  lease: DocumentLease,
  value: unknown,
  what: string,
  format: DocumentFormat,
): LeasedInput {
  const ref = assertFileRef(value, what);
  const leased = findLeasedInput(lease, ref.versionId);
  if (leased === undefined) {
    throw refusal(
      "ungranted-input",
      `${what} names version ${ref.versionId}, which this task's lease does not grant`,
    );
  }
  if (
    leased.fileId !== ref.fileId ||
    leased.name !== ref.name ||
    leased.sha256 !== ref.sha256 ||
    leased.size !== ref.size
  ) {
    throw refusal(
      "ungranted-input",
      `${what} does not match the version the lease pinned for ${leased.name}`,
    );
  }
  if (leased.format !== format) {
    throw refusal("invalid-request", `${what} is a ${leased.format} file, not a .${format}`);
  }
  return leased;
}

/** The output name a request proposes: one path segment, of the format, and permitted by the lease. */
export function resolveOutput(
  lease: DocumentLease,
  value: unknown,
  format: DocumentFormat,
): string {
  const name = text(value, "an output name", 255);
  assertPathSegment(name, "an output name");
  if (!name.toLowerCase().endsWith(`.${format}`)) {
    throw refusal("output-format", `an output named ${name} is not a .${format} file`);
  }
  if (!permitsFormat(lease, format)) {
    throw refusal(
      "output-format",
      `this task's lease does not permit ${format === "xlsx" ? "an" : "a"} ${format} output`,
    );
  }
  return name;
}

/** The optional cursor and page size of a paged request, bounded. */
export function pageOf(
  entry: Record<string, unknown>,
  what: string,
  maxPage: number,
): Record<string, unknown> {
  return {
    ...(entry.cursor === undefined
      ? {}
      : { cursor: whole(entry.cursor, `${what} cursor`, 0, 1_000_000_000) }),
    ...(entry.pageSize === undefined
      ? {}
      : { pageSize: whole(entry.pageSize, `${what} pageSize`, 1, maxPage) }),
  };
}

/**
 * A leased input as a plain file reference: what a program hands its adapter, which echoes it back as
 * source evidence, and what a typed result is checked against.
 */
export function fileRefOf(leased: LeasedInput): DocumentFileRef {
  return {
    fileId: leased.fileId,
    versionId: leased.versionId,
    name: leased.name,
    sha256: leased.sha256,
    size: leased.size,
  };
}

/**
 * The Python program one typed operation runs: a constant per operation, plus the checked arguments.
 * The operation name lives in the code, so a receipt's code hash names the operation and its argument
 * hash names the request.
 */
export function adapterInstruction(adapter: string, operation: string): string {
  return [
    `import ${adapter}`,
    "",
    `documents.result(${adapter}.run(${JSON.stringify(operation)}, documents.arguments()))`,
  ].join("\n");
}

// -- reading the answer ---------------------------------------------------------------------------

export function invalid(what: string): DocumentError {
  return refusal("output-invalid", `the worker's ${what} is not the shape this operation promises`);
}

export function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(what);
  return value;
}

export function asString(value: unknown, what: string): string {
  if (typeof value !== "string") throw invalid(what);
  return value;
}

export function asNullableString(value: unknown, what: string): string | null {
  if (value === null) return null;
  return asString(value, what);
}

export function asInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalid(what);
  return value;
}

export function asNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(what);
  return value;
}

export function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw invalid(what);
  return value;
}

export function asList(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalid(what);
  return value;
}

export function asStrings(value: unknown, what: string): readonly string[] {
  return asList(value, what).map((item) => asString(item, what));
}

export function asRecords(value: unknown, what: string): readonly Record<string, unknown>[] {
  return asList(value, what).map((item) => asRecord(item, what));
}

export function asSourceRef(value: unknown, what: string): DocumentFileRef {
  const entry = asRecord(value, what);
  return {
    fileId: asString(entry.fileId, what),
    versionId: asString(entry.versionId, what),
    name: asString(entry.name, what),
    sha256: asString(entry.sha256, what),
    size: asInteger(entry.size, what),
  };
}

/** One page of a worker's answer, refused when its counts and cursors disagree with each other. */
export function asPage<T>(
  value: unknown,
  what: string,
  item: (value: unknown, what: string) => T,
  maxPage: number,
): DocumentPage<T> {
  const entry = asRecord(value, what);
  const pageSize = asInteger(entry.pageSize, what);
  const returned = asInteger(entry.returned, what);
  if (pageSize < 1 || pageSize > maxPage || returned > pageSize) throw invalid(what);
  const items = asList(entry.items, what).map((entry_) => item(entry_, what));
  if (items.length !== returned) throw invalid(what);
  const total = asInteger(entry.total, what);
  const cursor = asInteger(entry.cursor, what);
  if (cursor + returned > total) throw invalid(what);
  const nextCursor = entry.nextCursor === null ? null : asInteger(entry.nextCursor, what);
  if (nextCursor !== (cursor + returned < total ? cursor + returned : null)) throw invalid(what);
  return {
    section: asString(entry.section, what),
    pageSize,
    cursor,
    returned,
    total,
    nextCursor,
    hasMore: asBoolean(entry.hasMore, what),
    items,
  };
}
