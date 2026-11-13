# Office Hum

Open-source multi-agent office for medium-sized businesses, built on [Pi Durable](https://earendil.com/posts/pi-durable/).

Each specialized role inside a department, such as accounts payable in finance, a campaign manager in marketing, or a dispatcher in operations, is its own Pi Durable agent with its own instructions, tools, skills and eval suite. The design lets agents run alone or together on one machine, sharing work through a durable workboard and relay.

> Status: nothing is published or deployed yet. Nine roles, the workboard, relay, runtime process,
> gateway and client are built and run locally.

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

The listener binds `127.0.0.1` and accepts `POST /webhooks/resend`. Resend needs a separately
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
SMS is inbound only, and off unless you turn it on. Set `TWILIO_AUTH_TOKEN` in the shell or an
approved secret store and `listen` also accepts `POST /hooks/twilio`, a signed Twilio webhook; without
the variable the route does not exist. The number texts arrive on is read from `office.config.json` in
the state directory (`{"version":1,"sms":{"businessNumber":"+15035550142"}}`); there is no command
that buys or registers a number, and `listen` refuses to start with the token set and no number. A
text from a saved contact's number reaches the Front Desk, which may check availability and answer by
email, with the usual approval for a first contact. A text from any other number becomes a
`phone.callback` ticket on the board for a person: whoever the company record routes that type to, or
else its first person. Unknown numbers are limited to three texts an hour; a saved contact's number
is not. There is no outbound SMS path and no provider account behind it yet. Twilio signs the public
URL it called. Behind a proxy or tunnel, name that address in the same config, beside the number
(`"sms":{"businessNumber":"+15035550142","publicBaseUrl":"https://office.example.com"}`), and the
signature is checked against `<publicBaseUrl>/hooks/twilio`; `listen` refuses to start if the value is
not an http(s) URL. Without it the signature is checked against the URL in the request's `Host` and
`X-Forwarded-*` headers.

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
  --request-id booking-1
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
`calendar.sqlite`; Google bookings are listed asynchronously from the provider, from now onwards:
an appointment that has already ended is not listed and cannot be moved or cancelled. The journal binds a
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
then reads lines from the terminal. Each line becomes one durable submission; a line typed again,
in this session or a later one, runs again. Gated actions print their description and arguments and wait for a `y`/`n` answer;
anything other than `y`/`yes` declines, and the decision is recorded with the OS user as `by`.

Nothing is published yet, so `officehum` in this and the following sections is this repository's
CLI: after `npm install` and `npm run build`, `npx officehum` from the repository root, or
`node packages/cli/dist/index.js`. A live model key must be in the environment
(`PAPERINSTRUMENTS_API_KEY` for Paper, `OPENAI_API_KEY` for OpenAI).

The Front Desk ships no calendar of its own, so give it one through `--clients` (the file format is
described below); without it the role starts, and every calendar tool fails when it is called. Save
these two files in the repository root:

```json
{ "calendar": { "module": "./calendar.mjs" } }
```

```js
// calendar.mjs: a stand-in that offers two slots a day and stores nothing.
// agents/frontdesk/README.md documents the Calendar interface a real one implements.
export default function createCalendar() {
  return {
    freeSlots: async (date) => [`${date}T09:00:00Z`, `${date}T10:00:00Z`],
    listBookings: async () => [],
    book: async (start, customer, idempotencyKey) => ({ id: "b1", start, customer }),
    reschedule: async (id, start, idempotencyKey) => ({ id, start, customer: "Demo Guest" }),
    cancel: async (id, idempotencyKey) => ({ id, status: "canceled", alreadyCanceled: false }),
  };
}
```

```sh
npx officehum run agents/frontdesk \
  --model paper/ultramarine-1-flash \
  --clients ./clients.json \
  --db .officehum/frontdesk.sqlite
```

A role that keeps its records behind a desk needs no client file to try: `npx officehum run
agents/sales --demo` runs on its demonstration records (see "The desk" below).

Flags:

| Flag | Meaning |
| --- | --- |
| `--overlay DIR` | An overlay directory, lowest first; repeatable |
| `--db FILE` | The office SQLite file (default `./.officehum/<role-id>.sqlite`) |
| `--data DIR` | The engine's `OFFICEHUM_DATA_DIR` |
| `--work DIR` | The engine's `OFFICEHUM_WORK_DIR` |
| `--model provider/model` | The model to run; default is the manifest's `defaultModel` |
| `--clients FILE` | A JSON file naming the role's app clients |
| `--as PERSON` | Who the operator at the terminal is: a person id or email on the role's company record |
| `--demo` | Run the role on its demonstration data when no desk is bound (takes no value) |

**Who is asking.** The terminal is the operator's own machine, so the operator says who they are with
`--as`. It must name a person on the company record generated into the role package
(`skills/company-handbook/references/facts.json`, matched by id or email), or the command refuses
before any role code runs and lists the ids it accepts. The role then gets that person as an internal
`VerifiedSender` from the `terminal` channel, so People Ops can record their time off, Purchasing can
place an order they asked for and Support can show them case data. With no `--as` the sender is
unknown, the startup banner says so, and anything a role gives only to a known sender is refused.

**The desk.** A role that keeps its records behind a desk (Bookkeeper's payables, Marketing,
Operations, People Ops, Purchasing, Sales, Support) builds its demonstration desk only when asked.
`--demo` asks: the role runs on the demonstration records it ships with, which live in memory and
write nowhere, and the banner says `Desk: demonstration data (--demo)`. A `desk` client in `--clients`
binds the business's own system instead. With neither, the role still starts, the banner says
`Desk: none bound (a role that keeps records refuses until you pass --demo or a desk in --clients)`, and every tool that reads or writes the desk
refuses and says how to bind one, so a forgotten connection never shows made-up records. Hosts pass
the same choice to `loadRole` as its reserved `demo` option; the eval runner always sets it.

**The date.** `officehum run` passes the role no clock, so a role on its demonstration desk works on
that desk's fixed demo date (`DEMO_NOW`) and its prompt has no `today` section.

At the prompt, `/commands` lists the manifest's operator views, `/NAME` runs one (an engine view with
no model involved), `/reload` re-reads the overlays and re-applies the role's settings except the model (a saved
conversation keeps the provider and model it started with; an overlay's model applies to new
conversations only), and `/help`,
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

## Run an office behind the Gateway Protocol

`officehum runtime` hosts one office (every role in its office file, one SQLite file) and speaks the
[Gateway Protocol](docs/design/gateway-protocol.md) on stdin/stdout: one JSON message per line in,
one per line out, and logs on stderr. The gateway supervises it; you can also run it directly and type
frames at it.

```sh
echo '{"version":1,"id":"my-office","roles":[{"dir":"agents/sales"}]}' > office.json
officehum runtime --db .officehum/office.sqlite --office office.json --demo
{"type":"submit","id":"c1","agent":"sales","requestId":"r1","input":{"kind":"message","text":"Hello"},"principal":{"id":"me","roles":["staff"]}}
```

| Flag | Meaning |
| --- | --- |
| `--db FILE` | The office SQLite file (Pi Durable's store) |
| `--office FILE` | The office file: its id and its roles, each with optional overlays |
| `--board FILE` | The office's workboard, a second SQLite file. With it the agents hand work to each other; without it each agent works alone |
| `--model provider/model` | Overrides every role's model for conversations it starts |
| `--demo` | Run roles that keep records on their demonstration data |

Every command carries a `principal`, which the gateway adds from the signed-in session; typed by hand,
you add it yourself. A command without one is refused as `unauthorized`.

### Connecting a role to a real system

A role's entry in the office file can name the calendar or the QuickBooks company it works in, so
it does real work without `--demo`. The file holds ids and paths only, never a credential.

```json
{
  "version": 1,
  "id": "my-office",
  "roles": [
    { "dir": "agents/frontdesk", "connections": { "calendar": { "kind": "local", "file": "state/calendar.sqlite" } } },
    { "dir": "agents/bookkeeper", "connections": { "quickbooks": { "kind": "quickbooks", "realmId": "4620816365", "environment": "sandbox" } } }
  ]
}
```

| Connection | Kind | Settings | Credential |
| --- | --- | --- | --- |
| `calendar` | `local` | `file`: a SQLite file the runtime creates | none |
| `calendar` | `google` | `calendarId` (never `primary`); `decisions`: a local file where the calendar records what it booked | `GOOGLE_CALENDAR_ACCESS_TOKEN` |
| `quickbooks` | `quickbooks` | `realmId`; `environment`: `sandbox` or `production` | `QUICKBOOKS_ACCESS_TOKEN` |

Paths are relative to the office file. A token is read from the environment each time the client
makes a call, so the runtime never stores it. If a variable a named connection needs is not set,
the runtime stops at start and names it. A Google calendar offers one-hour slots from 09:00 to 12:00
UTC, as it does in solo mode. The other six catalog roles keep their records in a desk that has only
a demonstration version, so they still need `--demo`.

### Agents working together

Give the runtime a workboard and its agents become a team:

```sh
echo '{"version":1,"id":"my-office","roles":[{"dir":"agents/sales"},{"dir":"agents/office-manager"}]}' > office.json
officehum runtime --db .officehum/harness.sqlite --board .officehum/office.sqlite --office office.json --demo
```

- **People.** At start the runtime reads the company record in each role's package
  (`skills/company-handbook/references/facts.json`) and adds its people to the board. Starting again
  adds nobody twice; a renamed person is renamed; nobody is removed.
- **Hand-offs.** Each agent gets `agent_dispatch`, `agent_inbox` and `agent_reply`. A dispatched
  ticket goes to the agent whose manifest accepts its type, in a conversation of its own, and the
  answer comes back to the agent that asked. A type the company record routes to a person
  (`ticketRoutes`) goes on the board assigned to them instead. The runtime delivers tickets for as
  long as it runs, and a restart picks up a hand-off where it stopped.
- **Budgets and hops.** The board's spend ceilings and hop limit apply to handed-on work.
- **Approvals in handed-on work.** A gated tool called while an agent works a ticket is asked
  through the gateway, exactly like one called from a request you submit: a signed-in person
  approves or declines it, within their approval limit, and unanswered it times out and is
  declined. The request survives a restart. With no gateway approver, it is refused.
- **Evidence before done.** An agent's reply finishes a ticket only when the checks its role
  declares for that ticket type pass; the office runs them, not the model. Every catalog ticket type
  also asks for a person, so a ticket then waits for the first person in the company record to
  confirm it, and the agent that asked waits with it. Anyone the gateway lets approve for that
  agent can confirm or decline it there, as an approval; it has no deadline. A failed check goes back to the agent; three
  failures block the ticket and hand it to that person.
- **Watching it, and confirming.** `officehum board --office .officehum` shows the board, when the
  board file is named `office.sqlite`. Tickets waiting for a confirmation are in the `waiting`
  column, marked `confirm? y/n`: `y <ticket>` confirms one, `n <ticket> <why>` sends it back, the
  same answers the gateway takes. `get_state` lists each agent's unfinished tickets. Keep `--db` and
  `--board` as two files.

What is not there yet:

- **Who sent it.** A ticket an agent opens records that it came through the gateway, not which
  signed-in person asked.

To serve an office over the network, run the gateway in front of it. It starts and supervises the
runtime, and signs clients in with JWTs verified against `OFFICEHUM_GATEWAY_JWT_PUBLIC_KEY`:

```sh
officehum-gateway --config gateway.json
```

```json
{
  "version": 1,
  "listen": { "host": "127.0.0.1", "port": 8443 },
  "runtime": { "command": "officehum", "args": ["runtime", "--db", "office.sqlite", "--office", "office.json"] },
  "permissions": {
    "submit": [{ "roles": ["staff"], "agents": "*" }],
    "approve": [{ "roles": ["manager"], "limit": 5000 }],
    "abort": [{ "roles": ["staff"] }]
  }
}
```

Clients connect to `/v1/ws` (WebSocket) or use `POST /v1/submit` and `GET /v1/requests/:id/events`
(Server-Sent Events); [the protocol spec](docs/design/gateway-protocol.md#the-gateway) lists the
routes, sign-in, permissions and audit log.

## Eval a role package

`officehum eval ROLE_DIR` runs a role's eval suites and prints the SDK's report, exiting non-zero
when a suite fails. It is the release gate and the portability check: the runner installs only the
role's own extensions on a fresh in-memory Pi Durable harness, so a role that needs Office Hum fails
here. Every tool the manifest declares is stubbed — with its real name, description and parameters,
so the model is offered the tools a live run would offer while no real system is touched — `read_skill`
runs for real, and an approval a scenario does not script stops the trial rather than being guessed.

```sh
officehum eval agents/frontdesk --model scripted
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--model provider/model` | The model to run; `scripted` reads a script file so CI needs no key; default is the manifest's `defaultModel` |
| `--tag TAG` | Run only the scenarios tagged `TAG` |
| `--trials N` | Trials per scenario, overriding each scenario's own `trials` |
| `--script FILE` | The script file `--model scripted` plays back; default is the role's own `evals.smoke.json` |
| `--report FILE` | Write the SDK's full report as JSON, with every trial's tool calls and arguments, approvals and reply; a failing trial also prints one line with its calls and the first 200 characters of its reply |
| `--mode bare\|office` | Which harness a trial runs on; `bare` (the default) is the portability check above, `office` binds a board and a ticket and installs the office's real approval gate |

`--mode office` is for scenarios whose point is that something did not happen. On the bare harness
there is no board, so there is no gate, so a gated call cannot be refused at all — "the office
stopped it" and "nothing could have stopped it" look identical. Office mode binds a ticket to the
trial's conversation and runs the gate production runs. When the scenario expects calls
(`expect.calls`), it fails a trial in which nothing executed: an empty ledger must not read as a
perfect defence. A scenario that expects no calls gets no such control, so for it "nothing ran" is a
check on the calls the model made, not proof that the gate refused one.

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
| `@officehum/client` | `packages/client` | TypeScript client for a gateway (Node 22 and browsers): submit, stream, reconnect, approve ([README](packages/client/README.md)) |
| `@officehum/gateway` | `packages/gateway` | The office's authenticated WebSocket and HTTP edge, supervising its runtime ([spec](docs/design/gateway-protocol.md#the-gateway)) |
| `@officehum/protocol` | `packages/protocol` | Gateway Protocol v1: message schemas, validators and the JSONL codec ([spec](docs/design/gateway-protocol.md)) |
| `@officehum/google-calendar` | `packages/google-calendar` | Portable REST and fake Google Calendar scheduling client |
| `@officehum/quickbooks` | `packages/quickbooks` | Portable QuickBooks client and fake for the Bookkeeper |
| `@officehum/channels` | `packages/channels` | Channel plugin contract and the SMS channel |
| `@officehum/office` | `packages/office` | Runtime: Pi Durable adapter, workboard, relay, approvals, budgets, runtime process |
| `@officehum/cli` | `packages/cli` | Run a role or an office runtime, grade evals, watch the board, review and publish documents |
| `@officehum/role-factory` | `packages/role-factory` | `ROLE_SPEC.md`: the four-layer spec a role is generated from, its parser, and `officehum-role generate` |
| `@officehum/<role>` | `agents/<role>` | One role agent each: Front Desk, Bookkeeper (Accounting), Office Manager, Sales, Operations, Purchasing, Marketing, Support, People Ops (catalog in `agents/README.md`) |

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
