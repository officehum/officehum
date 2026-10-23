/**
 * Durable operation identity.
 *
 * Every mutating call is bound to a stable operation ID derived from the Pi Durable
 * conversation/call identity, never from anything a model can author. The ID is bound to a canonical
 * hash of the intent: the submitted code, the arguments, the leased source hashes, the permitted
 * output formats, the resource limits, the policy version and the worker's library versions. Reuse
 * of an ID with changed intent fails closed in both the run ledger and the FileStore.
 */

import { createHash } from "node:crypto";
import { intentHash } from "@officehum/sdk";
import { refusal } from "./errors.js";
import { type DocumentFormat, PAPER_LIBRARY_PINS, PAPER_MODULE } from "./formats.js";
import type { DocumentLease, ResourceLimits } from "./lease.js";
import { assertLabel } from "./validate.js";

/** What the interpreter that ran is: the receipt records this so an upgrade is visible. */
export interface WorkerIdentity {
  /** The exact interpreter version the sentinel gate accepted, e.g. `3.13.17`. */
  readonly python: string;
  /** A stable name for the isolated worker, e.g. `paper-worker:python-3.13`. */
  readonly image: string;
  /** Pinned distributions and the interpreter, as the FileStore's `VersionContext` wants them. */
  readonly libraries: Readonly<Record<string, string>>;
  /** Import versions of the upstream module names the forks provide, as evidence of the reopen. */
  readonly modules: Readonly<Record<string, string>>;
}

export interface OperationIntent {
  readonly operationId: string;
  readonly taskId: string;
  readonly policyVersion: string;
  readonly code: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly leaseId: string;
  readonly sources: readonly { readonly versionId: string; readonly sha256: string }[];
  readonly outputFormats: readonly DocumentFormat[];
  readonly limits: ResourceLimits;
}

export const POLICY_VERSION = "paper-documents:1";

/**
 * The operation ID for one tool call. Pi Durable's call ID is stable across a crash and its replay,
 * so a replayed call derives the same ID and the service returns the same receipt.
 */
export function operationIdForCall(call: {
  readonly conversationId: string;
  readonly callId: string;
}): string {
  const raw = `${call.conversationId}:${call.callId}`;
  if (Buffer.byteLength(raw, "utf8") <= 256) {
    assertLabel(raw, "operation id");
    return raw;
  }
  return `call~${createHash("sha256").update(raw, "utf8").digest("hex")}`;
}

export function codeSha256(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function intentForRun(input: {
  readonly operationId: string;
  readonly taskId: string;
  readonly policyVersion: string;
  readonly code: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly lease: DocumentLease;
}): OperationIntent {
  return {
    operationId: input.operationId,
    taskId: input.taskId,
    policyVersion: input.policyVersion,
    code: input.code,
    arguments: input.arguments,
    leaseId: input.lease.leaseId,
    sources: [...input.lease.inputs]
      .map((leased) => ({ versionId: leased.versionId, sha256: leased.sha256 }))
      .sort((left, right) => left.versionId.localeCompare(right.versionId)),
    outputFormats: [...input.lease.outputFormats].sort(),
    limits: input.lease.limits,
  };
}

/** The canonical hash of an intent. Stable across processes: sorted keys, no floats, plain JSON. */
export function intentSha256(intent: OperationIntent): string {
  try {
    return intentHash({
      operationId: intent.operationId,
      taskId: intent.taskId,
      policyVersion: intent.policyVersion,
      codeSha256: codeSha256(intent.code),
      arguments: intent.arguments,
      leaseId: intent.leaseId,
      sources: intent.sources.map((source) => ({ ...source })),
      outputFormats: [...intent.outputFormats],
      limits: { ...intent.limits },
    });
  } catch {
    throw refusal("invalid-request", "The operation intent is not canonical JSON");
  }
}

/**
 * The operation ID one declared output commits under. Derived from the run's operation ID and the
 * output's name and format, so a replay of the same run addresses the same FileStore operation.
 */
export function outputOperationId(
  runOperationId: string,
  name: string,
  format: DocumentFormat,
): string {
  const run = createHash("sha256").update(runOperationId, "utf8").digest("hex").slice(0, 32);
  const out = createHash("sha256")
    .update(`${name}\u0000${format}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `run-${run}-${out}`;
}

/** The isolated worker's name, as the receipt records it. */
export function workerImage(python: string): string {
  const [major = "3", minor = "13"] = python.split(".");
  return `paper-worker:python-${major}.${minor}`;
}

/** The identity a worker reports; validated so a dishonest answer cannot enter a receipt. */
export function validateWorkerIdentity(value: unknown): WorkerIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw refusal("worker-refused", "The worker reported no identity");
  }
  const identity = value as Record<string, unknown>;
  const python = identity.python;
  const modules = identity.modules;
  if (typeof python !== "string" || !/^\d+\.\d+\.\d+$/u.test(python)) {
    throw refusal("worker-refused", "The worker reported no interpreter version");
  }
  if (typeof modules !== "object" || modules === null || Array.isArray(modules)) {
    throw refusal("worker-refused", "The worker reported no module versions");
  }
  const libraries: Record<string, string> = { python };
  for (const [name, pin] of Object.entries(PAPER_LIBRARY_PINS)) {
    const reported = (modules as Record<string, unknown>)[`${name}:dist`];
    if (reported !== pin) {
      throw refusal(
        "worker-refused",
        `The worker reported ${name} ${String(reported)} where the pin is ${pin}`,
      );
    }
    libraries[name] = pin;
  }
  const moduleVersions: Record<string, string> = {};
  for (const module of Object.values(PAPER_MODULE)) {
    const reported = (modules as Record<string, unknown>)[module];
    if (typeof reported !== "string" || reported.length === 0) continue;
    moduleVersions[module] = reported;
  }
  return { python, image: workerImage(python), libraries, modules: moduleVersions };
}
