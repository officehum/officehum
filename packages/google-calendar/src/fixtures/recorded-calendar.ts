/**
 * A recorded Google Calendar upstream: a `fetch` that answers the way the Calendar API does for one
 * calendar — freeBusy from the events it holds, event insert with a client-chosen id (409 when the id
 * exists), `If-Match` on PATCH (412 when stale), DELETE (404 once gone) — and records every request.
 * Options lose a response after the write lands, or answer an insert with 409, so a test can drive
 * the client's recovery. No network, no credential.
 *
 * Test-only: the package's build excludes it. The REST client's tests run against it directly, and
 * the connector gateway's tests (`@officehum/connectors`) import it by path.
 */

export type Json = Record<string, unknown>;
export type StoredEvent = Json & { id: string; etag: string; status?: string };

/** The calendar every recording answers for. */
export const CALENDAR_ID = "calendar@example.test";

export function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface RecordedCalendarOptions {
  /** The first insert lands but its response is lost. */
  readonly loseInsert?: boolean;
  /** The first PATCH lands but its response is lost. */
  readonly losePatch?: boolean;
  /** An insert stores the event and answers 409, as a write racing its own retry would see. */
  readonly conflictInsert?: boolean;
}

export interface RecordedCalendar {
  readonly fetch: typeof fetch;
  readonly events: Map<string, StoredEvent>;
  readonly requests: Array<{ url: URL; init: RequestInit; body?: Json }>;
}

const overlaps = (start: string, end: string, from: string, to: string): boolean =>
  Date.parse(start) < Date.parse(to) && Date.parse(end) > Date.parse(from);

export function recordedGoogleCalendar(options: RecordedCalendarOptions = {}): RecordedCalendar {
  const events = new Map<string, StoredEvent>();
  const requests: Array<{ url: URL; init: RequestInit; body?: Json }> = [];
  let lostInsert = false;
  let lostPatch = false;
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Json) : undefined;
    requests.push({ url, init, ...(body === undefined ? {} : { body }) });
    if (url.pathname.endsWith("/freeBusy")) {
      const from = String(body?.timeMin);
      const to = String(body?.timeMax);
      const busy = [...events.values()]
        .filter((event) => event.status !== "cancelled")
        .map((event) => ({
          start: String((event.start as Json | undefined)?.dateTime),
          end: String((event.end as Json | undefined)?.dateTime),
        }))
        .filter((interval) => overlaps(interval.start, interval.end, from, to));
      return json(200, { calendars: { [CALENDAR_ID]: { busy } } });
    }
    if (
      url.pathname.endsWith(`/calendars/${encodeURIComponent(CALENDAR_ID)}`) &&
      (init.method === "GET" || init.method === undefined)
    ) {
      return json(200, { timeZone: "America/Chicago" });
    }
    const eventPath = /\/events\/([^/]+)$/.exec(url.pathname);
    if (eventPath !== null) {
      const id = decodeURIComponent(eventPath[1] ?? "");
      const event = events.get(id);
      if (init.method === "GET" || init.method === undefined)
        return event === undefined
          ? json(404, { error: { message: "secret provider body" } })
          : json(200, event);
      if (init.method === "PATCH") {
        if (event === undefined) return json(404);
        if (
          init.headers instanceof Headers
            ? init.headers.get("if-match") !== event.etag
            : (init.headers as Record<string, string> | undefined)?.["If-Match"] !== event.etag
        )
          return json(412);
        const next = {
          ...event,
          ...body,
          etag: `"etag-${requests.length}"`,
          extendedProperties: {
            private: {
              ...((event.extendedProperties as Json | undefined)?.private as Json | undefined),
              ...((body?.extendedProperties as Json | undefined)?.private as Json | undefined),
            },
          },
        } as StoredEvent;
        events.set(id, next);
        if (options.losePatch && !lostPatch) {
          lostPatch = true;
          throw new Error("raw patch network secret");
        }
        return json(200, next);
      }
      if (init.method === "DELETE") {
        if (event === undefined) return json(404);
        events.delete(id);
        return new Response(undefined, { status: 204 });
      }
    }
    if (url.pathname.endsWith("/events") && init.method === "POST") {
      const id = String(body?.id);
      if (options.conflictInsert && !events.has(id)) {
        events.set(id, {
          ...body,
          id,
          etag: '"etag-conflict"',
          status: "confirmed",
        } as StoredEvent);
        return json(409);
      }
      if (events.has(id)) return json(409);
      const stored = { ...body, id, etag: '"etag-1"', status: "confirmed" } as StoredEvent;
      events.set(id, stored);
      if (options.loseInsert && !lostInsert) {
        lostInsert = true;
        throw new Error("raw insert network secret");
      }
      return json(200, stored);
    }
    if (url.pathname.endsWith("/events") && (init.method === "GET" || init.method === undefined)) {
      return json(200, { items: [...events.values()] });
    }
    return json(500, { error: { message: "unexpected fixture request" } });
  };
  return { fetch, events, requests };
}
