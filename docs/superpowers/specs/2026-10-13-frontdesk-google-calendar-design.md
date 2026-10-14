# Front Desk Google Calendar design

Date: 2026-10-13. Architectural integration; autonomous execution already authorized. GPT-6.1 Sol designs/reviews; GPT-5.6 Sol implements. RASF-3125 supplies connector context, not permission to add unrelated scheduling features.

## Intent and scope

Make the existing approved, durable Front Desk workflow book into a configured Google Calendar while retaining the credential-free local demo. Deliver one complete slice: portable REST/fake client, host adapter, CLI selection, persisted backend binding, meaningful recovery tests and operator documentation. Connector API includes freeSlots/listBookings/book/reschedule/cancel; cancellation and rescheduling are library capabilities, not new role tools or CLI commands.

Keep the existing role Calendar/Booking contract and UTC display/date semantics. CLI Google scheduling uses explicit caller policy: UTC, 09:00–12:00 daily, 60-minute slots. The standalone package supports caller-provided IANA timezones and working hours. OAuth login/refresh flows, service-account provisioning, invitations, recurring booking creation, generalized scheduling preferences and deployment are outside scope.

## Architecture and alternatives

Create `@officehum/google-calendar` without dependencies on SDK, Office runtime or CLI. Use native fetch and injected token callback/transport; one justified runtime dependency is `@js-temporal/polyfill` exactly `0.5.1`, verified against its [maintainer package manifest](https://raw.githubusercontent.com/js-temporal/temporal-polyfill/main/package.json). Temporal handles real dates, offsets and IANA transitions; reject ambiguous/nonexistent working-hour endpoints rather than silently shifting them. Node remains >=22.19.0; Pi stays 1.0.2.

Put the Front Desk mapping in `packages/office/src/google-calendar.ts`; retain `calendar.sqlite` for persisted approvals in both modes. The adapter maps portable UTC slot/booking objects into the existing role contract, derives end from configured duration, and exposes asynchronous listing. No role imports the host. A large Google SDK adds no value for this small REST surface; putting Google directly into the role would break its existing portable boundary.

## Portable contract

```ts
interface Slot { readonly start: string; readonly end: string }
interface CalendarBooking extends Slot {
  readonly id: string; readonly customer: string; readonly timeZone: string;
}
interface CalendarClient {
  freeSlots(date: string): Promise<Slot[]>;
  listBookings(): Promise<CalendarBooking[]>;
  book(input: Slot & {customer: string; requestId: string}): Promise<CalendarBooking>;
  reschedule(id: string, slot: Slot, requestId: string): Promise<CalendarBooking>;
  cancel(id: string, requestId: string): Promise<void>;
}
```

`createGoogleCalendar({calendarId,getAccessToken,timeZone,workingHours:{start,end},durationMinutes,fetch?})` returns CalendarClient. Callback is `() => Promise<string>`; invoke on every HTTP request, never persist its result. Require explicit nonempty calendar ID; CLI rejects `primary` because a token change can redirect that alias. `fakeCalendar` implements the same contract with seeded busy intervals/bookings and shared scheduling/idempotency validation; it makes no network calls.

Validate real dates, HH:mm boundaries with start < end, positive integral duration, bounded nonempty customer and requestId, and offset-bearing RFC3339 instants with end > start. Book durations must equal configured duration; appointments must fit/alignment-match caller working hours. Canonicalize timestamps to UTC instants before equality/fingerprints. Returned slots and bookings use UTC start/end plus configured timezone. Endpoint ambiguity uses Temporal disambiguation `reject`; ordinary DST days use actual offsets. No homegrown timezone offset search.

## REST, retries and recovery

Free slots: build candidates inside caller working hours, POST freeBusy for the exact window/calendar, subtract any half-open busy intersection (`start < busyEnd && end > busyStart`). Missing calendar data, malformed busy intervals, calendar-level errors or auth errors fail closed. Adjacent events do not block each other. FreeBusy includes external/all-day/recurring busy events. See [freeBusy reference](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query).

Booking: deterministic event ID `oh` + SHA-256 hex(requestId), valid in Google's base32hex ID alphabet. Persist private metadata for connector owner, request ID digest, normalized customer, and canonical argument fingerprint (calendar, start/end, customer, timezone). GET the ID first: an active matching event returns its real record; argument mismatch, moved/edited time, foreign ownership, or canceled event rejects. On genuine 404, recheck availability and INSERT the same ID. On insert 409, GET and validate the existing record. A lost successful insert response or interrupted tool retries with exactly the same ID/fingerprint, producing one event. Do not return success from an error body or create a new ID on conflict. See [insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) and [error codes](https://developers.google.com/workspace/calendar/api/guides/errors).

Google does not provide atomic freeBusy-and-reserve or guaranteed collision detection across concurrent creators. The single-process host serializes its own durable workflow; independent Google writers can overlap after the check. Document this limitation and do not present the provider as an atomic slot lock. Deterministic IDs address retries, not competing request IDs.

`listBookings` paginates events.list with owner private-property filter, showDeleted=false, singleEvents=true; returns only valid connector-owned active timed bookings, sorted by start/id. Canceled tombstones need not contain start/customer and are ignored before parsing. See [list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

`reschedule` GETs a managed active event, validates slot/duration, then checks all target-window events via paginated events.list(timeMin=start,timeMax=end,singleEvents=true). Exclude only exact self ID, canceled/transparent/workingLocation events; reject any remaining half-open overlap. Interpret all-day date endpoints in the calendar's IANA timezone obtained from calendars.get, not the caller's timezone; recurring instances are already expanded. Malformed intervals/timezone fail closed. This refuses currently taken targets, while retaining the external concurrent-writer limitation.

PATCH start/end and a reschedule request receipt together using If-Match etag. Receipt key is `r` + SHA-256(requestId) in base64url (44 characters), value is canonical target fingerprint. Preserve previous receipts and immutable original-book fingerprint. Matching receipt/current target returns existing booking; reused request with changed args or superseded target rejects, preventing an old retry from undoing a later move. Cap reschedule receipts at 64 per booking; reject a new operation at capacity rather than evicting retry history. Verify returned receipt after successful PATCH. These bounds fit Google's [extended-property limits](https://developers.google.com/workspace/calendar/api/guides/extended-properties). A lost PATCH response recovers through GET; ETag alone is not a retry receipt.

`cancel` validates requestId and deletes a managed event, accepting already canceled/410 and absent/404 as idempotent completion; rejects a found foreign event. Cancellation's effect is naturally idempotent by immutable event ID; requestId does not promise cross-event uniqueness without a separate journal. No resurrection. Canceled/deleted GETs reject book retries; tombstones eventually disappear, so provider-only request history cannot distinguish a purged external deletion from a never-created ID indefinitely. Normal successful-write-before-checkpoint recovery remains supported. See [patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch), [delete](https://developers.google.com/workspace/calendar/api/v3/reference/events/delete) and [event deletion state](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert).

All writes use sendUpdates=none, omit attendees, conference data and notification channels, and disable default reminders. Modifying an event that acquired attendees externally rejects, preserving the no-customer-send boundary. No live events are created for acceptance. Errors expose safe operation/status guidance (401 refresh token externally, 403 check scopes/permissions, 429/5xx retry); never raw token, headers, provider response body or network exception text. No blanket automatic write retries or auth-flow implementation. A request timeout fails visibly; explicit/durable retry uses the ID above.

## Host identity and CLI

Add `--calendar local|google` to start/resume/bookings; demo remains local and rejects Google. New start defaults local; omitted selection on resume/list follows persisted identity. Google needs GOOGLE_CALENDAR_ACCESS_TOKEN and an explicit GOOGLE_CALENDAR_ID on initial binding, but no OpenAI key for listings. Access callback reads the environment at request time. Existing approval prompts, persisted decisions, EOF handling, model binding and replay:safe policy remain intact.

Extend openSolo with optional nonsecret connector identity, checked/written under acquired ownership before opening Harness/admitting/replaying work. Identity version/backend plus Google calendar ID, UTC working hours and duration are immutable for that state. Existing harness/calendar state without identity is legacy local and cannot bind Google. Malformed identity rejects; explicit backend/calendar changes reject before tool effects. An omitted host identity means local for compatibility, never a bypass of a stored Google binding. Resume/list use stored ID, rejecting a conflicting provided GOOGLE_CALENDAR_ID; token changes alone are permitted. Listing validates stored identity without opening live models; local listing remains credential-free. Never write Google credentials to metadata/SQLite.

## Acceptance

Full portable contract and fake are tested with injected HTTP; UTC/offset equivalence, DST date boundaries, adjacent/busy intervals, bad input and provider/calendar errors have pinned behavior. Prove insert-response loss, 409 recovery, argument mismatch and canceled/foreign events. Verify paginated listing and reschedule/cancel semantics without invitations.

Use the actual durable Harness with fake REST: approve once, stop after provider insert before tool settlement, reopen, resume original submission and observe one event/one stored approval. Test Google identity mismatch/legacy-local rejection before admission, listing without OpenAI, and unchanged demo/deny/EOF behavior. Run targeted tests, npm run check, and the credential-free CLI smoke sequence. No deployment or live Google/model request is required.
