# Office Hum

Open-source multi-agent office for medium-sized businesses, built on [Pi Durable](https://earendil.com/posts/pi-durable/).

Each specialized role inside a department, such as accounts payable in finance, a campaign manager in marketing, or a dispatcher in operations, is its own Pi Durable agent with its own instructions, tools, skills and eval suite. Agents run alone, or together on one machine where they share work through a durable workboard and a relay that delivers every hand-off exactly once.

> Status: the local Front Desk solo workflow is available but unpublished. The shared workboard,
> relay, and multi-role team runtime remain planned.

## Front Desk quick start

The Front Desk runs locally, checks a synthetic calendar, requires an operator decision for every
booking, reschedule, or cancellation, and keeps both its conversation and calendar on disk. All
displayed appointment times are UTC.

Build the workspaces, then run the credential-free demo:

```sh
npm run build
node packages/cli/dist/index.js demo --state .officehum/frontdesk-demo --approval allow
node packages/cli/dist/index.js bookings --state .officehum/frontdesk-demo
node packages/cli/dist/index.js resume --state .officehum/frontdesk-demo
```

The demo always requests `2030-01-15` for `Demo Guest`, labels its inference as synthetic, and uses
the fixed request ID needed to make command retries idempotent. Omit `--approval` to use the demo's
documented automatic `allow`, or pass `--approval deny` to exercise a declined booking.

Live mode uses the installed OpenAI model catalog and reads its credential only from the process
environment. It uses the local calendar unless `--calendar google` is selected:

```sh
export OPENAI_API_KEY="..."
node packages/cli/dist/index.js start \
  --state .officehum/frontdesk-live \
  --message "Book Demo Guest on 2030-01-15" \
  --request-id booking-1 \
  --model gpt-6-sol
node packages/cli/dist/index.js resume --state .officehum/frontdesk-live
```

Use `bookings` to discover the exact managed booking ID before requesting a change. Rescheduling
and cancellation remain ordinary durable `start` submissions; there are no direct mutation CLI
commands. The agent lists current bookings, checks the target schedule before a move, and requests
the matching operator approval.

```sh
node packages/cli/dist/index.js bookings --state .officehum/frontdesk-live
node packages/cli/dist/index.js start \
  --state .officehum/frontdesk-live \
  --message "Move booking BOOKING_ID to 2030-01-15T10:00:00Z" \
  --request-id move-BOOKING_ID \
  --approval allow
node packages/cli/dist/index.js start \
  --state .officehum/frontdesk-live \
  --message "Cancel booking BOOKING_ID" \
  --request-id cancel-BOOKING_ID \
  --approval allow
```

An absent or denied approval produces no calendar write. A successful tool receipt is the only
confirmation that the change completed. Reusing the same durable call recovers its original result;
a new cancellation of an already canceled managed booking reports that it was already canceled.

To use an externally authorized Google Calendar, provide a bearer token and an explicit calendar
ID through the environment. The CLI does not implement OAuth or persist either value. The token is
read again for every request, so replace an expired token in the environment and rerun `resume` or
`bookings`.

```sh
export GOOGLE_CALENDAR_ACCESS_TOKEN="..."
export GOOGLE_CALENDAR_ID="team-calendar@example.com"
node packages/cli/dist/index.js start \
  --calendar google \
  --state .officehum/frontdesk-google \
  --message "Book Demo Guest on 2030-01-15" \
  --request-id booking-1 \
  --model gpt-6-sol
node packages/cli/dist/index.js resume --state .officehum/frontdesk-google
node packages/cli/dist/index.js bookings --state .officehum/frontdesk-google
```

Obtain authorization outside Office Hum with the Google Calendar scopes
`calendar.freebusy`, `calendar.calendars.readonly`, and `calendar.events` so the connector can query
free/busy data, read calendar timezone metadata, and read/write events. The Google backend fixes the
Front Desk policy to UTC, 09:00–12:00, with 60-minute appointments. Its persisted connector metadata
binds a state directory to the chosen backend and explicit calendar ID; later `resume` and
`bookings` commands infer that binding, and reject backend or calendar changes. The alias `primary`
is rejected because it can refer to a different calendar after a token change.

Bookings disable default reminders, omit attendees, and use `sendUpdates=none`, so Office Hum does
not send invitations. Approval decisions and the operation journal remain in the local
`calendar.sqlite`; Google bookings are listed asynchronously from the provider. The journal binds a
key globally across booking, reschedule, and cancellation and records successful receipts and
pre-delete snapshots. A single Office Hum process owns each state directory, and one connector
client serializes its complete booking, reschedule, and cancel operations. Google
does not atomically combine availability checks with event creation, so independent connector or
provider writers can still take the same slot between the check and insert. Deterministic event IDs
make durable retries safe; they do not lock a slot across writers. External Google writers remain
outside the in-process slot guarantee. If a provider deletion is purged before Office Hum stores any
host receipt or snapshot, the provider cannot reconstruct that missing history.

Opening a pre-lifecycle local database performs a verified migration. Before rewriting the source,
Office Hum creates an adjacent `calendar.sqlite.backup-*.sqlite` snapshot that includes committed WAL
rows, migrates a disposable copy, verifies integrity and exact booking/approval records, then checks
the live source has not drifted. Canceled rows and operation receipts remain in the migrated database,
and only active rows reserve a slot. Migration failures leave the source schema readable and retain
the verified backup. To restore, stop every owner of the state directory, move the current
`calendar.sqlite`, `calendar.sqlite-wal`, and `calendar.sqlite-shm` files aside if present, copy the
chosen verified backup to `calendar.sqlite`, and reopen Office Hum. Keep the moved files until the
restored state is verified.

Without `--approval allow|deny`, live start or resume asks for the exact token `allow` or `deny`.
End-of-file or interruption leaves admitted work available to `resume`; it never implies consent.
Use separate state directories for demo and live modes; a persisted conversation keeps its original
provider/model, and the CLI rejects cross-mode reuse before admitting input. The default state is
`.officehum/frontdesk`: Pi Durable JSONL data is under `harness/`; bookings, tombstones, approval
decisions, and pending/completed calendar operations are in `calendar.sqlite`; and a lifetime
transaction in `ownership.sqlite` enforces one process at a time. An identity-free state with a
harness or any persisted booking, approval, or operation record is treated as legacy local state; an
empty preflight calendar database remains available for initial binding.
`owner.lock` records its PID for diagnostics. A second live owner is rejected; after a crash,
the operating system releases the SQLite lock and the next owner reclaims a dead PID marker.
Malformed markers are left in place for inspection.

## Packages

| Package | Path | What it is |
| --- | --- | --- |
| `@officehum/sdk` | `packages/sdk` | Manifest schema and helpers for building an agent package |
| `@officehum/google-calendar` | `packages/google-calendar` | Portable REST and fake Google Calendar scheduling client |
| `@officehum/office` | `packages/office` | Runtime: Pi Durable harness, workboard, relay, workflow engine |
| `@officehum/cli` | `packages/cli` | Run an office, watch the board, steer a live agent |
| `@officehum/<role>` | `agents/<role>` | One role agent each (Front Desk, Bookkeeper, Office Manager first) |

## Development

Requires Node 22.19 or later.

```sh
npm install
npm run check   # lint, build, typecheck, test
```

Pi Durable is pinned to an exact version (`1.0.2`). Dependabot opens a pull request for each new upstream release, and it merges only when CI passes. Each Office Hum release ships one tested Pi Durable version, so installs never upgrade Pi Durable on their own. Pi Durable's API is experimental, so all calls into it go through the adapter in `@officehum/office`.

## License

MIT. Office Hum builds on [Pi](https://github.com/earendil-works/pi), also MIT licensed (Copyright (c) 2025 Mario Zechner).
