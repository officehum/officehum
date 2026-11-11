import type { ErrorCode } from "@officehum/protocol";

/** A command the runtime refuses with a protocol error code, sent back as `error`. */
export class RuntimeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
