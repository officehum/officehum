/**
 * Office package inspection, in pure Node.
 *
 * Every leased input is inspected before it is staged for the worker and every declared output is
 * inspected before it is committed. The check is structural, not a parser: it reads the ZIP central
 * directory and the OPC relationship parts and refuses
 *
 * - an archive that is a zip bomb (too many entries, too much uncompressed data, too high a ratio),
 * - an entry name that is absolute, traversing, backslashed, controlled or duplicated,
 * - a package without `[Content_Types].xml`, so a plain archive renamed `.docx` is refused,
 * - a macro or executable payload (`vbaProject.bin` and executable extensions),
 * - an external relationship: `TargetMode="External"`, a URI-scheme target, or a relative target
 *   that escapes the package root (a docx linking to `http://…`, an xlsx `externalLink`, a pptx
 *   relationship pointing elsewhere).
 *
 * Doing this here, before any parser sees the bytes, is what keeps a hostile document away from the
 * pinned libraries. It also means the structural refusals are enforced on every platform, even where
 * no Python interpreter is configured.
 */

import { posix } from "node:path";
import { inflateRawSync } from "node:zlib";
import { refusal } from "./errors.js";
import type { ResourceLimits } from "./lease.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT = 65_535;
const CONTENT_TYPES = "[Content_Types].xml";
const EXECUTABLE_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".js",
  ".vbs",
  ".vba",
  ".bat",
  ".cmd",
  ".com",
  ".ps1",
  ".scr",
  ".jar",
  ".msi",
  ".sh",
]);

export interface PackageInspection {
  readonly entries: readonly string[];
  readonly uncompressedBytes: number;
}

interface Entry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

/**
 * Checks the archive and its relationships. `what` names the file for the message (a leaked path is
 * never included). Throws a `DocumentError` with a specific code on any refusal.
 */
export function inspectOfficePackage(
  bytes: Uint8Array,
  limits: Pick<ResourceLimits, "archiveBytes" | "archiveEntries" | "archiveRatio">,
  what: string,
): PackageInspection {
  const entries = readCentralDirectory(bytes, limits, what);
  const names = new Set<string>();
  let uncompressedBytes = 0;
  let compressedBytes = 0;

  for (const entry of entries) {
    checkEntryName(entry.name, what);
    if (names.has(entry.name)) {
      throw refusal("entry-name", `${what} holds a duplicated package entry`);
    }
    names.add(entry.name);
    checkPayload(entry.name, what);
    uncompressedBytes += entry.uncompressedSize;
    compressedBytes += entry.compressedSize;
  }

  if (!names.has(CONTENT_TYPES)) {
    throw refusal("archive-invalid", `${what} is not an Office package: no [Content_Types].xml`);
  }
  if (uncompressedBytes > limits.archiveBytes) {
    throw refusal(
      "archive-unsafe",
      `${what} expands to ${uncompressedBytes} bytes, above its ${limits.archiveBytes} byte allowance`,
    );
  }
  if (uncompressedBytes > 0 && compressedBytes === 0) {
    throw refusal("archive-unsafe", `${what} declares compressed data without a compressed size`);
  }
  if (compressedBytes > 0 && uncompressedBytes / compressedBytes > limits.archiveRatio) {
    throw refusal(
      "archive-unsafe",
      `${what} expands more than ${limits.archiveRatio} times its compressed size`,
    );
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".rels")) continue;
    checkRelationships(entry, readEntry(bytes, entry, limits, what), what);
  }

  return { entries: [...names], uncompressedBytes };
}

function readCentralDirectory(
  bytes: Uint8Array,
  limits: Pick<ResourceLimits, "archiveEntries">,
  what: string,
): readonly Entry[] {
  if (bytes.byteLength < 22)
    throw refusal("archive-invalid", `${what} is too short to be a package`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const limit = Math.min(bytes.byteLength, MAX_COMMENT + 22);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= bytes.byteLength - limit; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw refusal("archive-invalid", `${what} is not a ZIP archive`);

  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw refusal("archive-unsafe", `${what} is a ZIP64 archive, beyond this workspace's limits`);
  }
  if (directoryOffset + directorySize > bytes.byteLength) {
    throw refusal("archive-invalid", `${what} has a truncated central directory`);
  }
  if (count > limits.archiveEntries) {
    throw refusal(
      "archive-unsafe",
      `${what} holds ${count} package entries, above its ${limits.archiveEntries} entry allowance`,
    );
  }

  const entries: Entry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.byteLength) {
      throw refusal("archive-invalid", `${what} has a truncated central directory entry`);
    }
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw refusal("archive-invalid", `${what} has a malformed central directory entry`);
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) {
      throw refusal("archive-invalid", `${what} has a truncated package entry name`);
    }
    entries.push({
      name: decodeUtf8(bytes.subarray(nameStart, nameEnd), what),
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    cursor = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function checkEntryName(name: string, what: string): void {
  if (
    name.length === 0 ||
    name.length > 1_024 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    /^[A-Za-z]:/u.test(name) ||
    name.split("/").includes("..") ||
    /\p{Cc}/u.test(name)
  ) {
    throw refusal("entry-name", `${what} holds an unsafe package entry name`);
  }
}

function checkPayload(name: string, what: string): void {
  const base = posix.basename(name).toLowerCase();
  const extension = posix.extname(base);
  if (base === "vbaproject.bin" || EXECUTABLE_EXTENSIONS.has(extension)) {
    throw refusal("macro-payload", `${what} holds a macro or executable payload`);
  }
}

function readEntry(
  bytes: Uint8Array,
  entry: Entry,
  limits: Pick<ResourceLimits, "archiveBytes">,
  what: string,
): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.localOffset + 30 > bytes.byteLength) {
    throw refusal("archive-invalid", `${what} has a truncated package entry`);
  }
  if (view.getUint32(entry.localOffset, true) !== LOCAL_SIGNATURE) {
    throw refusal("archive-invalid", `${what} has a malformed package entry header`);
  }
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) {
    throw refusal("archive-invalid", `${what} has a truncated package entry body`);
  }
  const data = bytes.subarray(start, end);
  if (entry.uncompressedSize > limits.archiveBytes) {
    throw refusal("archive-unsafe", `${what} holds an oversized package part`);
  }
  let raw: Uint8Array;
  if (entry.method === 0) {
    raw = data;
  } else if (entry.method === 8) {
    try {
      raw = inflateRawSync(data, { maxOutputLength: limits.archiveBytes });
    } catch {
      throw refusal("archive-invalid", `${what} holds a package part that will not inflate`);
    }
  } else {
    throw refusal("archive-invalid", `${what} uses an unsupported compression method`);
  }
  return decodeUtf8(raw, what);
}

const RELATIONSHIP = /<(?:[A-Za-z0-9_.-]+:)?Relationship\b([^>]*?)\/?>/gu;
const ATTRIBUTE = /([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/gu;

function checkRelationships(entry: Entry, xml: string, what: string): void {
  const base = posix.dirname(posix.dirname(entry.name));
  for (const match of xml.matchAll(RELATIONSHIP)) {
    const attributes = new Map<string, string>();
    for (const attribute of (match[1] ?? "").matchAll(ATTRIBUTE)) {
      const key = attribute[1];
      const value = attribute[2];
      if (key !== undefined && value !== undefined) attributes.set(key.toLowerCase(), value);
    }
    if ((attributes.get("targetmode") ?? "").toLowerCase() === "external") {
      throw refusal("external-relationship", `${what} links to an external resource`);
    }
    const target = attributes.get("target");
    if (target === undefined) continue;
    if (target.length === 0 || target.length > 2_048) {
      throw refusal("external-relationship", `${what} links to an unusable target`);
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target) || target.startsWith("//")) {
      throw refusal("external-relationship", `${what} links to an external URI`);
    }
    if (!target.startsWith("/")) {
      const resolved = posix.normalize(posix.join(base, target));
      if (resolved === ".." || resolved.startsWith("../")) {
        throw refusal("external-relationship", `${what} links to a path outside the package`);
      }
    }
  }
}

function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw refusal("archive-invalid", `${what} holds a package entry that is not valid UTF-8`);
  }
}
