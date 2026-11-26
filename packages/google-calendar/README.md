# @officehum/google-calendar

A portable scheduling client for Google Calendar, and an in-memory fake with the same interface
(`CalendarClient`: `freeSlots`, `listBookings`, `book`, `reschedule`, `cancel`). Every write carries
a request id, so a retry finds the first write instead of booking twice. The client does no OAuth
and stores no credential: the host passes a function that returns a fresh access token on every
call. No Office Hum dependency.

## Install

Not published to npm yet. In a clone of this repository, `npm ci && npm run build` builds it and
workspaces import it by name. For another project, pack it (`npm pack -w @officehum/google-calendar`)
and install the tarball.

## Example

```ts
import { createGoogleCalendar, fakeCalendar } from "@officehum/google-calendar";

const schedule = { timeZone: "UTC", workingHours: { start: "09:00", end: "12:00" }, durationMinutes: 60 };

// In tests and demos: no network.
const calendar = fakeCalendar(schedule);
const [slot] = await calendar.freeSlots("2030-01-15"); // { start: "2030-01-15T09:00:00Z", end: "…10:00:00Z" }
if (slot !== undefined) await calendar.book({ ...slot, customer: "Demo Guest", requestId: "booking-1" });

// Against Google: an explicit calendar id and a token you obtain yourself. (Office Hum's own
// commands refuse the alias "primary", which can name another calendar after a token change.)
const google = createGoogleCalendar({
  ...schedule,
  calendarId: "team-calendar@example.com",
  getAccessToken: async () => process.env.GOOGLE_CALENDAR_ACCESS_TOKEN ?? "",
});
```

## Docs

- ["Run one role package"](../../docs/reference.md#run-one-role-package) in the reference: giving
  the Front Desk a calendar with `--clients`.
- [Front Desk](../../agents/frontdesk/README.md), the role that books through it.
