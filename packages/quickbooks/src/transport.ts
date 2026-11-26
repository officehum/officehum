/**
 * How a QuickBooks request reaches the API, kept apart from what the request is. The client builds
 * each request and maps each response (`quickbooksClientOver`); a transport only sends it. The REST
 * transport adds the bearer token and the environment's base URL and calls `fetch`; a host can send
 * the same request another way (the connector gateway, say) without a second copy of the mapping.
 */

import { QuickBooksNetworkError } from "./errors.js";

/** One request, before any credential or host is attached. */
export interface QuickBooksRequest {
  /** What the call is, in words, for error messages: `"invoice creation"`. */
  readonly operation: string;
  readonly method: "GET" | "POST";
  /** From the API root, query included: `/v3/company/123/invoice?minorversion=75&requestid=r-1`. */
  readonly path: string;
  /** A JSON body, when the request has one. */
  readonly body?: string;
  /**
   * On a write, the caller's idempotency key. The path already carries it as QuickBooks'
   * `requestid`; a transport that derives its own key from it (the connector gateway) replaces that.
   */
  readonly requestId?: string;
}

export interface QuickBooksResponse {
  readonly status: number;
  readonly body: string;
}

/** Sends one request. Throws a `QuickBooksError` when no response came back. */
export type QuickBooksTransport = (request: QuickBooksRequest) => Promise<QuickBooksResponse>;

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The REST transport: the request goes straight to `baseUrl` with a fresh bearer token from
 * `getAccessToken`. Neither the token nor a transport error's own text reaches an error message.
 */
export function restTransport(options: {
  readonly baseUrl: string;
  readonly getAccessToken: () => Promise<string>;
  readonly fetch: typeof fetch;
}): QuickBooksTransport {
  return async (request) => {
    let token: string;
    try {
      token = await options.getAccessToken();
    } catch {
      throw new QuickBooksNetworkError(
        `The ${request.operation} could not obtain an access token from the host; check getAccessToken and retry.`,
      );
    }
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new QuickBooksNetworkError(
        `The ${request.operation} needs a nonempty access token; the host's getAccessToken returned none.`,
      );
    }
    try {
      const headers = new Headers();
      headers.set("authorization", `Bearer ${token}`);
      headers.set("accept", "application/json");
      if (request.body !== undefined) headers.set("content-type", "application/json");
      const response = await options.fetch(new URL(request.path, options.baseUrl), {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return { status: response.status, body: await response.text() };
    } catch {
      throw new QuickBooksNetworkError(
        `The ${request.operation} could not reach the QuickBooks API; check the network and retry.`,
      );
    }
  };
}
