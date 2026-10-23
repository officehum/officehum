/**
 * A task lease, not a directory.
 *
 * The lease is the whole of what one tool call may reach: immutable input version ids with their
 * hashes, the output formats it may produce, and a resource budget. It is bound to a Pi Durable task
 * and role by the host and cannot be widened by prompt text, skill content, document content or
 * submitted Python. There is no field in it for a path, a URL, a credential or a connector, and the
 * workspace API the worker injects has no way to open anything but a leased version id.
 */

import { refusal } from "./errors.js";
import { type DocumentFormat, isDocumentFormat } from "./formats.js";
import {
  assertFileId,
  assertHash,
  assertLabel,
  assertPathSegment,
  assertSize,
  exactKeys,
  record,
} from "./validate.js";

export interface LeasedInput {
  readonly fileId: string;
  readonly versionId: string;
  readonly name: string;
  readonly format: DocumentFormat;
  readonly sha256: string;
  readonly size: number;
  /** A writable input may be edited: the run may propose a new version of it. Never edited in place. */
  readonly writable: boolean;
}

export interface ResourceLimits {
  /** CPU seconds the interpreter may burn; the kernel enforces this with `RLIMIT_CPU`. */
  readonly cpuSeconds: number;
  /** Address space the interpreter may map; the kernel enforces this with `RLIMIT_AS`. */
  readonly memoryBytes: number;
  /** Wall clock for the whole run; the host enforces this by killing the process group. */
  readonly wallSeconds: number;
  /** Total bytes all declared outputs may hold; the host checks this before any commit. */
  readonly outputBytes: number;
  /** How many files a run may declare; the host checks this before any commit. */
  readonly fileCount: number;
  /** Total uncompressed bytes an Office package may hold, so a zip bomb is refused, not opened. */
  readonly archiveBytes: number;
  /** Most central-directory entries an Office package may hold. */
  readonly archiveEntries: number;
  /** Largest uncompressed-to-compressed ratio an Office package may hold. */
  readonly archiveRatio: number;
}

export interface DocumentLease {
  readonly leaseId: string;
  readonly taskId: string;
  /** Immutable input versions, and the permitted output formats. Nothing else is reachable. */
  readonly inputs: readonly LeasedInput[];
  readonly outputFormats: readonly DocumentFormat[];
  readonly limits: ResourceLimits;
  /** ISO timestamp; a run started at or after it is refused before the interpreter is spawned. */
  readonly expiresAt: string;
}

export const MAX_LEASED_INPUTS = 64;
export const MAX_OUTPUT_FORMATS = 3;

export const DEFAULT_LIMITS: ResourceLimits = {
  cpuSeconds: 30,
  memoryBytes: 1_024 * 1_024 * 1_024,
  wallSeconds: 60,
  outputBytes: 64 * 1_024 * 1_024,
  fileCount: 16,
  archiveBytes: 256 * 1_024 * 1_024,
  archiveEntries: 4_096,
  archiveRatio: 200,
};

const LIMIT_KEYS = [
  "cpuSeconds",
  "memoryBytes",
  "wallSeconds",
  "outputBytes",
  "fileCount",
  "archiveBytes",
  "archiveEntries",
  "archiveRatio",
] as const;

const LEASE_KEYS = ["leaseId", "taskId", "inputs", "outputFormats", "limits", "expiresAt"] as const;
const INPUT_KEYS = ["fileId", "versionId", "name", "format", "sha256", "size", "writable"] as const;

/** Parses and validates a lease. Anything unexpected is refused; the lease is never repaired. */
export function validateLease(value: unknown): DocumentLease {
  const lease = record(value, "A lease must be an object", "invalid-lease");
  exactKeys(lease, LEASE_KEYS, "A lease carries only its declared fields", "invalid-lease");
  assertLabel(lease.leaseId, "lease id", "invalid-lease");
  assertLabel(lease.taskId, "lease task id", "invalid-lease");
  if (typeof lease.expiresAt !== "string" || !isIsoTimestamp(lease.expiresAt)) {
    throw refusal("invalid-lease", "A lease needs an ISO 8601 expiry");
  }

  if (!Array.isArray(lease.inputs) || lease.inputs.length > MAX_LEASED_INPUTS) {
    throw refusal("invalid-lease", `A lease lists at most ${MAX_LEASED_INPUTS} input versions`);
  }
  const inputs = lease.inputs.map((input, index) => leasedInput(input, index));
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.versionId)) {
      throw refusal("invalid-lease", "A lease lists the same input version twice");
    }
    seen.add(input.versionId);
  }

  if (!Array.isArray(lease.outputFormats) || lease.outputFormats.length === 0) {
    throw refusal("invalid-lease", "A lease must permit at least one output format");
  }
  if (lease.outputFormats.length > MAX_OUTPUT_FORMATS) {
    throw refusal("invalid-lease", "A lease permits at most three output formats");
  }
  const outputFormats: DocumentFormat[] = [];
  for (const format of lease.outputFormats) {
    if (!isDocumentFormat(format)) {
      throw refusal("invalid-lease", "A lease permits only docx, pptx and xlsx");
    }
    if (outputFormats.includes(format)) {
      throw refusal("invalid-lease", "A lease lists the same output format twice");
    }
    outputFormats.push(format);
  }

  return {
    leaseId: lease.leaseId,
    taskId: lease.taskId,
    inputs,
    outputFormats,
    limits: validateLimits(lease.limits),
    expiresAt: lease.expiresAt,
  };
}

export function validateLimits(value: unknown): ResourceLimits {
  const limits = record(value, "A lease must carry resource limits", "invalid-lease");
  exactKeys(limits, LIMIT_KEYS, "Unknown resource limit", "invalid-lease");
  const bounded = (name: (typeof LIMIT_KEYS)[number], low: number, high: number): number => {
    const item = limits[name];
    if (!Number.isSafeInteger(item) || (item as number) < low || (item as number) > high) {
      throw refusal(
        "invalid-lease",
        `The ${name} limit must be an integer between ${low} and ${high}`,
      );
    }
    return item as number;
  };
  return {
    cpuSeconds: bounded("cpuSeconds", 1, 600),
    memoryBytes: bounded("memoryBytes", 32 * 1_024 * 1_024, 8 * 1_024 * 1_024 * 1_024),
    wallSeconds: bounded("wallSeconds", 1, 3_600),
    outputBytes: bounded("outputBytes", 1, 512 * 1_024 * 1_024),
    fileCount: bounded("fileCount", 1, 256),
    archiveBytes: bounded("archiveBytes", 1_024, 2 * 1_024 * 1_024 * 1_024),
    archiveEntries: bounded("archiveEntries", 1, 65_535),
    archiveRatio: bounded("archiveRatio", 1, 10_000),
  };
}

export function isLeaseExpired(lease: DocumentLease, now: Date): boolean {
  return new Date(lease.expiresAt).getTime() <= now.getTime();
}

export function findLeasedInput(lease: DocumentLease, versionId: string): LeasedInput | undefined {
  return lease.inputs.find((input) => input.versionId === versionId);
}

export function permitsFormat(lease: DocumentLease, format: DocumentFormat): boolean {
  return lease.outputFormats.includes(format);
}

function leasedInput(value: unknown, index: number): LeasedInput {
  const input = record(value, `Leased input ${index} must be an object`, "invalid-lease");
  exactKeys(input, INPUT_KEYS, "A leased input carries only its declared fields", "invalid-lease");
  assertFileId(input.fileId, `Leased input ${index} file id`, "invalid-lease");
  assertFileId(input.versionId, `Leased input ${index} version id`, "invalid-lease");
  assertPathSegment(input.name, `Leased input ${index} name`);
  if (!isDocumentFormat(input.format)) {
    throw refusal("invalid-lease", `Leased input ${index} has an unsupported format`);
  }
  assertHash(input.sha256, `Leased input ${index} hash`, "invalid-lease");
  assertSize(input.size, `Leased input ${index} size`, "invalid-lease");
  if (typeof input.writable !== "boolean") {
    throw refusal("invalid-lease", `Leased input ${index} must say whether it is writable`);
  }
  return {
    fileId: input.fileId,
    versionId: input.versionId,
    name: input.name,
    format: input.format,
    sha256: input.sha256,
    size: input.size,
    writable: input.writable,
  };
}

function isIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
