/**
 * Why a document was not generated. Every refusal carries a stable code a caller can react to, a
 * message saying what is wrong and how to fix it, and, for data that does not match a template's
 * schema, every problem with its field path.
 */

export const DOCGEN_ERROR_CODES = [
  "invalid-request",
  "unknown-template",
  "unsupported-format",
  "invalid-data",
  "typst-missing",
  "typst-version",
  "compile-failed",
  "timeout",
  "page-limit",
  "output-invalid",
  "invalid-branding",
  "no-lease",
  "no-service",
  "store-error",
] as const;

/** A code of this pack's own, or a Paper document service refusal passed through unchanged. */
export type DocgenErrorCode = (typeof DOCGEN_ERROR_CODES)[number] | (string & {});

/** One field of the data that does not match: `data.lines[0].amount`, and what is wrong with it. */
export interface DataProblem {
  readonly path: string;
  readonly message: string;
}

export class DocgenError extends Error {
  constructor(
    readonly code: DocgenErrorCode,
    message: string,
    readonly problems: readonly DataProblem[] = [],
  ) {
    super(message);
    this.name = "DocgenError";
  }
}
