/**
 * The `DocumentService` interface a host injects.
 *
 * This is the small surface the portable tool pack depends on — not the Office Hum host — so the same
 * pack runs in a bare Pi Durable harness with a fake service and inside Office Hum with the local
 * service below. RASF-3283 lands the Python workspace operation; the typed
 * `inspect/read/edit/create/preview/compare/publish` operations the design also names arrive with the
 * format adapters (RASF-3284) and the review surface (RASF-3285) on this same interface.
 *
 * Every method answers with an outcome rather than throwing: a refusal is a typed, inspectable result
 * the model can be shown, and it is always the same shape whatever went wrong.
 */

import type { DocumentRefusalCode } from "./errors.js";
import type { DocumentLease } from "./lease.js";
import type { DocumentRunReceipt } from "./run-ledger.js";

export interface DocumentRunRequest {
  /** Stable across a crash and its replay: derived from the Pi Durable conversation/call identity. */
  readonly operationId: string;
  readonly taskId: string;
  /** The task's lease. It cannot be widened by the code, the arguments or a document. */
  readonly lease: DocumentLease;
  readonly code: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface DocumentRunCommitted {
  readonly kind: "committed";
  readonly receipt: DocumentRunReceipt;
}

export interface DocumentRunRefused {
  readonly kind: "refused";
  readonly operationId: string;
  readonly code: DocumentRefusalCode;
  readonly message: string;
}

export type DocumentRunOutcome = DocumentRunCommitted | DocumentRunRefused;

export interface DocumentService {
  /**
   * Runs submitted Python against a task-scoped workspace. A replay of the same operation ID with the
   * same intent returns the same committed receipt; a refusal or a timeout leaves every source
   * untouched; a new call always produces a new immutable version, never an edit.
   */
  runDocumentPython(request: DocumentRunRequest): Promise<DocumentRunOutcome>;
}

export function isCommitted(outcome: DocumentRunOutcome): outcome is DocumentRunCommitted {
  return outcome.kind === "committed";
}

export function isRefused(outcome: DocumentRunOutcome): outcome is DocumentRunRefused {
  return outcome.kind === "refused";
}
