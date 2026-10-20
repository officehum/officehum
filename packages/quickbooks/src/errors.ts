/**
 * Typed failures. Every error carries QuickBooks' own message (and code) so a caller can show the
 * business why the API refused, and a one-line hint at what to do next. `status` is the HTTP status
 * the API returned; `0` means the failure happened before a response (a dropped connection, a
 * missing token, or a response that did not match the QuickBooks schema).
 */

export interface QuickBooksFault {
  readonly status: number;
  readonly code: string | undefined;
  readonly type: string | undefined;
}

const NO_RESPONSE: QuickBooksFault = { status: 0, code: undefined, type: undefined };

export class QuickBooksError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly type: string | undefined;

  constructor(message: string, fault: QuickBooksFault = NO_RESPONSE) {
    super(message);
    this.name = "QuickBooksError";
    this.status = fault.status;
    this.code = fault.code;
    this.type = fault.type;
  }
}

/** The access token is missing, expired, or lacks the scope this call needs (HTTP 401/403). */
export class QuickBooksAuthError extends QuickBooksError {
  constructor(message: string, fault: QuickBooksFault = NO_RESPONSE) {
    super(message, fault);
    this.name = "QuickBooksAuthError";
  }
}

/** No record exists for the id asked for (HTTP 404). */
export class QuickBooksNotFoundError extends QuickBooksError {
  constructor(message: string, fault: QuickBooksFault = NO_RESPONSE) {
    super(message, fault);
    this.name = "QuickBooksNotFoundError";
  }
}

/** QuickBooks rejected a request as invalid (HTTP 400/422), e.g. a duplicate document number. */
export class QuickBooksValidationError extends QuickBooksError {
  constructor(message: string, fault: QuickBooksFault = NO_RESPONSE) {
    super(message, fault);
    this.name = "QuickBooksValidationError";
  }
}

/** QuickBooks is rate limiting this company (HTTP 429). */
export class QuickBooksThrottleError extends QuickBooksError {
  constructor(message: string, fault: QuickBooksFault = NO_RESPONSE) {
    super(message, fault);
    this.name = "QuickBooksThrottleError";
  }
}

/** QuickBooks failed server-side (HTTP 5xx). */
export class QuickBooksServerError extends QuickBooksError {
  constructor(message: string, fault: QuickBooksFault = NO_RESPONSE) {
    super(message, fault);
    this.name = "QuickBooksServerError";
  }
}

/** The request never reached a response: a dropped connection, a timeout, or no token. */
export class QuickBooksNetworkError extends QuickBooksError {
  constructor(message: string, fault: QuickBooksFault = NO_RESPONSE) {
    super(message, fault);
    this.name = "QuickBooksNetworkError";
  }
}
