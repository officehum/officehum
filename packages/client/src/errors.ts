import type { ErrorCode, ErrorMessage, Problem } from "@officehum/protocol";

/**
 * A command the gateway refused, or one that could not be answered. `code` is the protocol's error
 * code, so callers branch on it (`forbidden`, `not_found`, `busy` …); `problems` lists what was wrong
 * with an `invalid_message`.
 */
export class GatewayError extends Error {
  override readonly name = "GatewayError";
  readonly code: ErrorCode;
  readonly problems: readonly Problem[];

  constructor(code: ErrorCode, message: string, problems: readonly Problem[] = []) {
    super(message);
    this.code = code;
    this.problems = problems;
  }

  static from(error: ErrorMessage): GatewayError {
    return new GatewayError(error.code, error.message, error.problems ?? []);
  }
}

/** Whether `error` is a `GatewayError`, with `code` when given. */
export function isGatewayError<C extends ErrorCode>(
  error: unknown,
  code?: C,
): error is GatewayError & { readonly code: C } {
  return error instanceof GatewayError && (code === undefined || error.code === code);
}
