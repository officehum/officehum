/**
 * The board's refusal type, in its own module so every part of the board can throw it.
 *
 * It used to be declared in `index.ts`, and the approvals store has to refuse with the same kinds: a
 * caller that catches `not_found` from `board.get` must be able to catch it from a decision too, or
 * every caller grows a second error type. Keeping it here means `approvals.ts` depends on this file
 * rather than on `index.ts`, so the board is a tree and not a cycle.
 *
 * `index.ts` re-exports both names, so nothing outside this directory has to know the move happened.
 */
export type BoardErrorKind =
  | "not_found"
  | "invalid_status"
  | "unauthorized"
  | "duplicate_key"
  | "immutable"
  | "max_hops"
  | "invalid_person"
  | "invalid_argument";

export class BoardError extends Error {
  constructor(
    readonly kind: BoardErrorKind,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "BoardError";
  }
}

export function fail(kind: BoardErrorKind, message: string, details?: unknown): BoardError {
  return new BoardError(kind, message, details);
}
