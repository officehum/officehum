/**
 * The `DocumentService` interface a host injects.
 *
 * This is the small surface the portable tool pack depends on — not the Office Hum host — so the same
 * pack runs in a bare Pi Durable harness with a fake service and inside Office Hum with the local
 * service below. The Python workspace operation and the typed
 * `inspect/read/edit/create/preview/compare/publish` operations of the format adapters and the review
 * surface share this one interface.
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
  /**
   * The document template the outputs are rendered from, when a generator runs the program (see
   * `@officehum/tools-docgen`). It is bound into the operation's intent and recorded in every
   * output's FileStore metadata.
   */
  readonly template?: DocumentTemplateRef;
}

/** A template by name and version, as a generated file's metadata records it. */
export interface DocumentTemplateRef {
  readonly name: string;
  readonly version: string;
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
