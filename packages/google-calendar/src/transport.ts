/**
 * How a Google Calendar request reaches the API, kept apart from what the request is. The client
 * builds each request and maps each response (`createGoogleCalendarOver`); a transport only sends
 * it. The REST transport adds the bearer token and Google's host and calls `fetch`; a host can send
 * the same request another way (the connector gateway, say) without a second copy of the mapping.
 */

/** One request, before any credential or host is attached. */
export interface CalendarRequest {
  /** What the call is, in words, for error messages: `"insert booking"`. */
  readonly operation: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** From the API root, query included: `/calendar/v3/calendars/c%40x/events?sendUpdates=none`. */
  readonly path: string;
  /** A JSON body, when the request has one. */
  readonly body?: string;
  /** The precondition a reschedule carries, so it never overwrites a newer edit. */
  readonly ifMatch?: string;
  /**
   * On a write, the caller's request id. Google takes no idempotency key (the client protects a
   * retry itself); a transport that audits or keys writes (the connector gateway) uses it.
   */
  readonly requestId?: string;
}

export interface CalendarResponse {
  readonly status: number;
  readonly body: string;
}

/** Sends one request. Throws an error that names the operation, and nothing else, when no response came back. */
export type CalendarTransport = (request: CalendarRequest) => Promise<CalendarResponse>;

export const GOOGLE_API_BASE = "https://www.googleapis.com";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The REST transport: the request goes straight to Google with a fresh bearer token from
 * `getAccessToken`. Neither the token nor a transport error's own text reaches an error message.
 */
export function restCalendarTransport(options: {
  readonly getAccessToken: () => Promise<string>;
  readonly fetch: typeof fetch;
}): CalendarTransport {
  return async (request) => {
    let token: string;
    try {
      token = await options.getAccessToken();
    } catch {
      throw new Error(`Google Calendar ${request.operation} could not obtain an access token.`);
    }
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new Error(`Google Calendar ${request.operation} requires a nonempty access token.`);
    }
    try {
      const headers = new Headers();
      if (request.ifMatch !== undefined) headers.set("if-match", request.ifMatch);
      headers.set("authorization", `Bearer ${token}`);
      if (request.body !== undefined) headers.set("content-type", "application/json");
      const response = await options.fetch(`${GOOGLE_API_BASE}${request.path}`, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return { status: response.status, body: await response.text() };
    } catch {
      throw new Error(`Google Calendar ${request.operation} request failed.`);
    }
  };
}
