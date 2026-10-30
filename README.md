# Office Hum

Open-source multi-agent office for medium-sized businesses, built on [Pi Durable](https://earendil.com/posts/pi-durable/).

Each specialized role inside a department, such as accounts payable in finance, a campaign manager in marketing, or a dispatcher in operations, is its own Pi Durable agent with its own instructions, tools, skills and eval suite. The design lets agents run alone or together on one machine, sharing work through a durable workboard and relay.

> Status: the local Front Desk solo workflow is available but unpublished. The shared workboard,
> relay, and multi-role team runtime remain planned.

The [visual system guide](docs/visualizations/officehum-built.html) is a standalone HTML map of the
repository, its current and planned interfaces, and the distinct roles of Office Hum, Pi Durable,
and Paper Instruments. Download or open the file locally to use its interactive workflow view.
The [owner's manual](docs/visualizations/officehum-owners-manual.html) explains the boundaries
between Office Hum, Pi Durable, role packages, and Paper Instruments, how several roles are designed
to work together, and what is built versus planned.

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

Live mode defaults to Paper's `ultramarine-1-flash` model with maximum thinking. Set
`PAPERINSTRUMENTS_API_KEY` in the process environment. Use `--provider openai` to select OpenAI;
that provider defaults to `gpt-6-sol`, and `--model ID` selects a different model within the chosen
provider. Live credentials are read only from the process environment. The Paper provider itself is
the portable [`@officehum/provider-paper`](packages/provider-paper/README.md) package, so a bare Pi
Durable install can register the model a role names as its default without Office Hum. The
credential-free `demo` command remains available without either model key. Live mode uses the local
calendar unless `--calendar google` is selected:

```sh
export PAPERINSTRUMENTS_API_KEY="..."
node packages/cli/dist/index.js start \
  --state .officehum/frontdesk-live \
  --message "Book Demo Guest on 2030-01-15" \
  --request-id booking-1 \
  --model ultramarine-1-flash
node packages/cli/dist/index.js resume --state .officehum/frontdesk-live
```

To use OpenAI, set `OPENAI_API_KEY` in the environment and pass `--provider openai` to `start` or
`listen`; `--model` can be supplied before or after `--provider`. A saved conversation resumes with
its stored provider, model, and thinking level. `start` and `listen` reject a provider or model that
does not match the state directory.

Use `bookings` to discover the exact managed booking ID before requesting a change. Rescheduling
and cancellation remain ordinary durable `start` submissions; there are no direct mutation CLI
commands. The agent lists current bookings, checks the target schedule before a move, and requests
the matching operator approval.

Contacts are session-local durable profiles. Create and correct them through ordinary approved
`start --message` submissions, then use the read-only `contacts` command to inspect current IDs,
revisions, names, and channels without loading a model or calendar provider:

```sh
node packages/cli/dist/index.js start \
  --state .officehum/frontdesk-live \
  --message "Create a contact named Example Guest with email guest@example.test" \
  --request-id contact-create-1 \
  --approval allow
node packages/cli/dist/index.js contacts --state .officehum/frontdesk-live
node packages/cli/dist/index.js start \
  --state .officehum/frontdesk-live \
  --message "For contact contact-1 at revision 1, clear email and set phone to +15551234567" \
  --request-id contact-update-1 \
  --approval allow
```

Profile corrections require the listed revision. Omitting a channel keeps it unchanged; explicitly
using `null` clears it. Email addresses and international phone numbers are unique, while equal names
remain separate identities. To associate a booking, ask the agent to use the exact contact ID and
the contact's current name. A booking without a contact ID keeps the existing free-text behavior and
does not create a profile. Contact profiles and booking links live only in the selected state
directory; they are not synchronized to Google Contacts or embedded in provider events.

Messaging uses the same ordinary durable submission path. The default console host records the
exact intent in `messages.sqlite` and never contacts a customer. Use an exact saved contact ID and
canonical destination:

```sh
node packages/cli/dist/index.js start \
  --state .officehum/frontdesk-live \
  --message "List contacts, then send contact-1 at guest@example.test exactly: Appointment confirmed." \
  --request-id message-contact-1 \
  --approval allow
```

The first successful message for an exact contact, channel, destination, and Messenger identity
needs approval. Later messages to that same tuple use its successful durable history. Changing any
part of the tuple requires fresh approval. Approval alone, failed sends, bookings, and contact edits
do not establish that history. Recovery after an intent is pinned keeps the approved old destination
and text; it cannot redirect to a later contact edit. `Recorded in console outbox; no customer
delivery` is the strongest claim the console host makes.

For real outbound plain-text email, explicitly select Resend on a fresh state directory. The account
ID is an operator-chosen, stable authority namespace; keep it unchanged when rotating credentials.
The sender must be a canonical lowercase mailbox, and the fixed subject is shown before work runs
and included in every provider request. Populate `RESEND_API_KEY` through your shell or approved
secret store without placing it in a project file or command argument.

```sh
export RESEND_ACCOUNT_ID="frontdesk-production"
export RESEND_FROM_EMAIL="frontdesk@example.com"
export RESEND_SUBJECT="Front Desk"
# Populate RESEND_API_KEY from the approved secret store in this shell.
node packages/cli/dist/index.js start \
  --messenger resend \
  --state .officehum/frontdesk-resend \
  --message "List contacts, then send contact-1 at guest@example.test exactly: Appointment confirmed." \
  --request-id message-contact-1 \
  --approval allow
node packages/cli/dist/index.js resume --state .officehum/frontdesk-resend
```

`Accepted by transport` means Resend accepted the idempotent request; it does not confirm inbox
delivery. Console history never authorizes a Resend first contact because the transport identities
differ. A state directory is permanently bound to its initial Messenger authority, including the
Resend account namespace, sender, and subject. Resume infers that saved nonsecret configuration and
still requires the credential. Unknown provider outcomes may retry only with the original payload
and key before the persisted first-attempt time plus 23 hours. At the cutoff, or after a detected
clock regression, automatic retry stops: retain the state and inspect Resend before authorizing a
separate new submission. Previously saved accepted receipts remain replayable without a credential.

Inbound Resend email uses a separate durable `inbound.sqlite` ledger and a native loopback webhook
listener. Configure the nonsecret inbound mailbox with `RESEND_INBOUND_EMAIL`; provide
`RESEND_WEBHOOK_SECRET` and, during rotation, optional `RESEND_WEBHOOK_SECRET_PREVIOUS` through the
shell or approved secret store. Build first, then start the listener:

```sh
npm run build
node packages/cli/dist/index.js listen \
  --state .officehum/frontdesk-resend \
  --messenger resend \
  --port 8787
node packages/cli/dist/index.js inbox --state .officehum/frontdesk-resend
node packages/cli/dist/index.js resume --state .officehum/frontdesk-resend
```

The listener binds `127.0.0.1` and accepts only `POST /webhooks/resend`. Resend needs a separately
configured public HTTPS forwarder to that local endpoint; Office Hum does not create a tunnel,
change DNS, or configure the provider. Default reply approval is interactive review. Explicit
`--approval allow` applies to approval requests handled by that runtime; customer email never
supplies approval or widens the customer tools beyond availability and replying.

`inbox` prints receipt IDs, state, reason codes, and conversation/submission IDs without sender,
subject, body, headers, attachment names, or credentials. Blocked receipts remain for inspection.
Pending uncertain sends retain their original target and provider key and stop automatic retries at
exactly 23 hours. Each inbound receipt permits one distinct reply operation. Preserve
`inbound.sqlite`, `email.sqlite`, `messenger.json`, and the Harness directory together. HTML is
converted locally; attachments remain inert metadata and are never downloaded. Live provider
send/receive acceptance still requires a human-configured webhook and a separate live verification.
SMS is inbound only: a signed Twilio webhook is accepted, and the office replies by email. There is
no outbound SMS path, no SMS credential, and no provider account behind it yet.

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
decisions, and pending/completed calendar operations are in `calendar.sqlite`; synthetic message
outbox rows are in `messages.sqlite`; Resend operations and accepted receipts are in `email.sqlite`;
signed inbound receipts, routing bindings, reply approvals, and reply operations are in
`inbound.sqlite`; the immutable transport authority is in `messenger.json`; and a lifetime
transaction in `ownership.sqlite` enforces one process at a time. An identity-free state with a
harness or any persisted booking, approval, or operation record is treated as legacy local state; an
empty preflight calendar database remains available for initial binding.
Retain `email.sqlite` and `messenger.json` together for recovery. Copying or deleting a state cannot
provide a global duplicate guarantee once the provider's idempotency window has elapsed.
`owner.lock` records its PID for diagnostics. A second live owner is rejected; after a crash,
the operating system releases the SQLite lock and the next owner reclaims a dead PID marker.
Malformed markers are left in place for inspection.

## Run one role package

`officehum run ROLE_DIR` runs a single role package on its own: it loads the package from its
directory, opens an office on one SQLite file, prints anything a previous run left unfinished, and
then reads lines from the terminal. Each line becomes one durable submission, so re-running the same
line is idempotent. Gated actions print their description and arguments and wait for a `y`/`n` answer;
anything other than `y`/`yes` declines, and the decision is recorded with the OS user as `by`.

```sh
officehum run agents/frontdesk \
  --model paper/ultramarine-1-flash \
  --db .officehum/frontdesk.sqlite
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--overlay DIR` | An overlay directory, lowest first; repeatable |
| `--db FILE` | The office SQLite file (default `./.officehum/<role-id>.sqlite`) |
| `--data DIR` | The engine's `OFFICEHUM_DATA_DIR` |
| `--work DIR` | The engine's `OFFICEHUM_WORK_DIR` |
| `--model provider/model` | The model to run; default is the manifest's `defaultModel` |
| `--clients FILE` | A JSON file naming the role's app clients |

At the prompt, `/commands` lists the manifest's operator views, `/NAME` runs one (an engine view with
no model involved), `/reload` re-reads the overlays and re-applies the role's settings, and `/help`,
`/quit` and end of input are available too.

Role loading refuses three things with every problem named at once: an invalid package, a Pi Durable
peer range that excludes the version Office Hum runs (`validatePackage` plus an exact-range check), and
a missing runtime program (`checkRuntimes`). The factory's bundle is then checked against the manifest
(`checkAgent`) before anything runs.

Role packages are portable, so a package ships compiled JavaScript. The SDK's fixture roles under
`packages/sdk/fixtures/` are TypeScript sources used by tests; they load under the test runner, not the
built CLI. Run them from a test, or build the SDK package you want to run from the terminal.

The `--clients` file maps a client name to the module that exports its factory; the factory is called
with no arguments and reads its own configuration from the environment, so the file can never hold a
credential. Only `module` and an optional `export` are allowed per entry, and anything else is refused:

```json
{
  "calendar": { "module": "./clients/calendar.mjs" },
  "quickbooks": { "module": "@officehum/quickbooks", "export": "quickbooksClient" }
}
```

## Eval a role package

`officehum eval ROLE_DIR` runs a role's eval suites and prints the SDK's report, exiting non-zero
when a suite fails. It is the release gate and the portability check: the runner installs only the
role's own extensions on a fresh in-memory Pi Durable harness, so a role that needs Office Hum fails
here. Every tool the manifest declares is stubbed — with its real name, description and parameters,
so the model is offered the tools a live run would offer while no real system is touched — `read_skill`
runs for real, and an approval a scenario does not script stops the trial rather than being guessed.

```sh
officehum eval packages/sdk/fixtures/sample-stockroom \
  --model scripted \
  --script evals.smoke.json
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--model provider/model` | The model to run; `scripted` reads a script file so CI needs no key; default is the manifest's `defaultModel` |
| `--tag TAG` | Run only the scenarios tagged `TAG` |
| `--trials N` | Trials per scenario, overriding each scenario's own `trials` |
| `--script FILE` | The script file `--model scripted` plays back |
| `--mode bare\|office` | Which harness a trial runs on; `bare` (the default) is the portability check above, `office` binds a board and a ticket and installs the office's real approval gate |

`--mode office` is for scenarios whose point is that something did not happen. On the bare harness
there is no board, so there is no gate, so a gated call cannot be refused at all — "the office
stopped it" and "nothing could have stopped it" look identical. Office mode binds a ticket to the
trial's conversation and runs the gate production runs, and it fails a trial in which nothing
executed: an empty ledger must not read as a perfect defence.

A script file is JSON mapping each scenario id to the turns the scripted model plays back, in order:

```json
{
  "reports-cited-levels": [
    { "toolCalls": [{ "name": "stock_levels", "args": { "sku": "BOLT-10" } }] },
    { "text": "120 units, from stock:BOLT-10." }
  ]
}
```

Every selected scenario must have an entry, or the command refuses before any trial runs. A script
that must branch on what a tool returned cannot be written as JSON; use `piDurableRunner` from
`@officehum/office` in a test for that.

## Packages

| Package | Path | What it is |
| --- | --- | --- |
| `@officehum/sdk` | `packages/sdk` | Manifest schema and helpers for building an agent package |
| `@officehum/provider-paper` | `packages/provider-paper` | Portable Paper Instruments provider for `pi-ai` |
| `@officehum/tools-paper-office` | `packages/tools-paper-office` | Task-leased Paper Office document worker and its `DocumentService` |
| `@officehum/google-calendar` | `packages/google-calendar` | Portable REST and fake Google Calendar scheduling client |
| `@officehum/office` | `packages/office` | Runtime: Pi Durable harness, workboard, relay, workflow engine |
| `@officehum/cli` | `packages/cli` | Run an office, watch the board, steer a live agent |
| `@officehum/role-factory` | `packages/role-factory` | `ROLE_SPEC.md`: the four-layer spec a role is generated from, its parser, and `officehum-role generate` |
| `@officehum/<role>` | `agents/<role>` | One role agent each (Front Desk, Bookkeeper, Office Manager first) |

## Paper Office document workspace

A task can be granted a **task lease** on immutable document versions and a bounded Python workspace
for Word, PowerPoint and Excel work. The grant is a lease, not a directory: it names input version IDs
with their hashes and the output formats the task may produce, and nothing else is reachable. Every
call binds a stable operation ID, the code and argument hashes, the source hashes, the policy version
and the pinned library versions into one receipt, so a replayed call returns the same commit and a
refusal or a timeout leaves the sources untouched.

The workspace runs in an isolated Python 3.13 subprocess with a scrubbed environment, kernel rlimits
and a lease-scoped staging directory. It needs an interpreter with the three Paper forks installed
exactly as pinned; there is no safe default, so the host names it:

```sh
packages/tools-paper-office/scripts/provision-worker.sh          # one-shot: uv + CPython 3.13
export OFFICEHUM_PAPER_PYTHON="$PWD/packages/tools-paper-office/.worker/bin/python"
```

Without that variable the interpreter-backed tests skip visibly and no document workspace is
available. See [`packages/tools-paper-office/README.md`](packages/tools-paper-office/README.md) for
the lease model, each enforced limit and — importantly — what is *not* enforced until the container
profile (RASF-3111) lands. The Python-level guards are a bounded workspace, not a sandbox.

## Development

Requires Node 22.19 or later.

```sh
npm install
npm run check   # lint, build, typecheck, test
```

Pi Durable is pinned to an exact version (`1.3.0`). Dependabot opens a pull request for each new upstream release, and it merges only when CI passes. Each Office Hum release ships one tested Pi Durable version, so installs never upgrade Pi Durable on their own. Pi Durable's API is experimental, so all calls into it go through the adapter in `@officehum/office`.

## License

MIT. Office Hum builds on [Pi](https://github.com/earendil-works/pi), also MIT licensed (Copyright (c) 2025 Mario Zechner).
