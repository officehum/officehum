/**
 * A typed, inspectable refusal.
 *
 * Every refusal the document pack emits carries one of these codes. A worker refusal is mapped into
 * this set: a code the pack does not know becomes `worker-refused`, so a new worker code can never
 * widen the contract silently. The message is for a person and for the model; it never contains
 * document content, a path outside the lease, or a secret.
 */

export const DOCUMENT_REFUSAL_CODES = [
  // Lease and request
  "invalid-request",
  "invalid-lease",
  "no-lease",
  "lease-expired",
  // Durable operation identity
  "operation-collision",
  "version-conflict",
  "not-found",
  "store-error",
  // Worker reachability
  "interpreter-missing",
  "interpreter-version",
  "doctor-missing",
  "doctor-failed",
  "worker-crash",
  "worker-refused",
  // Resource limits
  "timeout",
  "resource-limit",
  "cpu-limit",
  "memory-limit",
  "file-size-limit",
  // Lease enforcement
  "ungranted-input",
  "unleased-path",
  "input-integrity",
  "source-integrity",
  // Output shaping
  "undeclared-output",
  "missing-output",
  "output-format",
  "output-bytes",
  "file-count",
  "archive-unsafe",
  "archive-invalid",
  "entry-name",
  "macro-payload",
  "external-relationship",
  "symlink",
  "traversal",
  "output-invalid",
  // Submitted code
  "code-error",
  "code-syntax",
  "network",
  "process",
  // Ledger and recovery
  "ledger-integrity",
  "incomplete-run",
] as const;

export type DocumentRefusalCode = (typeof DOCUMENT_REFUSAL_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(DOCUMENT_REFUSAL_CODES);

/** The code to report for a worker-supplied one: unknown worker codes collapse to `worker-refused`. */
export function refusalCodeFromWorker(value: unknown): DocumentRefusalCode {
  return typeof value === "string" && KNOWN_CODES.has(value)
    ? (value as DocumentRefusalCode)
    : "worker-refused";
}

export function isDocumentRefusalCode(value: unknown): value is DocumentRefusalCode {
  return typeof value === "string" && KNOWN_CODES.has(value);
}

export class DocumentError extends Error {
  constructor(
    readonly code: DocumentRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "DocumentError";
  }
}

export function refusal(code: DocumentRefusalCode, message: string): DocumentError {
  return new DocumentError(code, message);
}
