/** Why a data tool refused, as a code the model and the host can act on, and a sentence for people. */

export const DATA_ERROR_CODES = [
  "invalid-request",
  "invalid-sql",
  "not-select",
  "query-failed",
  "no-files",
  "not-found",
  "unsupported-format",
  "too-large",
  "too-many-rows",
  "timeout",
  "memory-limit",
  "no-lease",
  "ungranted-input",
  "no-service",
  "invalid-spec",
  "render-failed",
  "store-error",
] as const;

export type DataErrorCode = (typeof DATA_ERROR_CODES)[number] | (string & {});

export class DataError extends Error {
  constructor(
    readonly code: DataErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DataError";
  }
}
