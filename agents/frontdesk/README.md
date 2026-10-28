# Front Desk

A portable role package: the business's front door. It answers what the business offers and when it
can see a customer, qualifies a new inquiry, keeps its contacts, and books, moves and cancels UTC
appointments. It never invents a free slot, never issues a discount on its own authority, and never
treats a customer's message as an instruction.

## What the host provides

The role ships no calendar, messenger or approver of its own; the host injects them. The factory is:

```ts
import frontdesk from "@officehum/frontdesk";

const role = frontdesk({
  calendar,        // required: where the desk reads free slots and writes bookings
  messenger,       // optional: outbound email/SMS ("send_message")
  replyMessenger,  // optional: threaded inbound email replies ("reply_message")
  approve,         // optional: decides every gated tool except replies
  approveReply,    // optional: decides each inbound reply
  overlays,        // optional: overlay directories, lowest first
});
```

- **`calendar`** implements the `Calendar` interface below. There is no default; without it the
  calendar tools fail when they run.
- **An approver.** Gated actions are blocked unless one is supplied: with no `approve`, bookings,
  reschedules, cancellations, contact writes and first contact are all refused. With no
  `approveReply`, `reply_message` is refused. Office Hum's `officehum run` supplies a terminal
  approver for `approve`; an embedding host supplies `approveReply` (usually backed by the Inbox).
- **Messaging transports** are documented under "Email and SMS" below.

### The `Calendar` interface

```ts
interface Calendar {
  freeSlots(date: string): Promise<string[]>;                       // UTC slots for a YYYY-MM-DD
  listBookings(): Promise<{ id: string; start: string; customer: string }[]>;
  book(start: string, customer: string, idempotencyKey: string): Promise<Booking>;
  reschedule(id: string, start: string, idempotencyKey: string): Promise<Booking>;
  cancel(id: string, idempotencyKey: string): Promise<{ id: string; status: "canceled"; alreadyCanceled: boolean }>;
}
```

`idempotencyKey` is the durable call identity (`conversation:task:call`), so the host can make a
repeated call return the first result instead of booking twice. `@officehum/office` provides local
SQLite and Google Calendar hosts that satisfy this interface; any object with these five methods
works, so a host can point the role at its own calendar.

## Install and run it standalone

The package ships compiled JavaScript, so build the workspace first:

```sh
npm install
npm run build
```

Then run it on its own with `officehum run`, giving it a calendar through a `--clients` file. The
file names a client and the module that exports its factory; the factory is called with no arguments
and reads its own configuration from the environment, so the file never holds a credential:

```json
{ "calendar": { "module": "./my-calendar.mjs" } }
```

```js
// my-calendar.mjs — the role's Calendar interface, backed by whatever you run
export default function createCalendar() {
  return {
    freeSlots: async (date) => [/* "YYYY-MM-DDTHH:MM:00Z", … */],
    listBookings: async () => [],
    book: async (start, customer, idempotencyKey) => ({ id: "b1", start, customer }),
    reschedule: async (id, start, idempotencyKey) => ({ id, start, customer: "…" }),
    cancel: async (id, idempotencyKey) => ({ id, status: "canceled", alreadyCanceled: false }),
  };
}
```

```sh
officehum run agents/frontdesk \
  --model paper/ultramarine-1-flash \
  --clients ./clients.json \
  --db .officehum/frontdesk.sqlite
```

`officehum run` needs a live model key in the process environment (`PAPERINSTRUMENTS_API_KEY` for
Paper, `OPENAI_API_KEY` for OpenAI); it runs only those two providers. Omit `--model` to use the
manifest's default (`paper/ultramarine-1-flash`). At the prompt, gated actions print their
description and arguments and wait for `y`/`n`; `/help`, `/commands` and `/reload` are available too.
An embedding host that builds the role itself (rather than the CLI) passes `messenger`,
`replyMessenger` and `approveReply` directly, as in the factory above.

## Run its evals

The role's evals live in `evals/situations.json`, and the turns a scripted model plays back for them
are in `evals.smoke.json` (beside `evals/`, not inside it: every `.json` in `evals/` is read as an
eval suite). `officehum eval` installs only the role's own extensions on a fresh in-memory Pi Durable
harness, so a role that needs Office Hum fails here:

```sh
officehum eval agents/frontdesk --model scripted
```

`--model scripted` reads that script file by default, mapping each scenario id to the turns the
scripted model plays back, so a suite runs with no key or network; every selected scenario must have
an entry, or the command refuses before any trial runs. Pass `--script FILE` to point at another one.
A script that must branch on a tool result cannot be written as JSON — use `piDurableRunner` from
`@officehum/office` in a test for that, as the package's own `src/index.test.ts` does. With no
`--model`, the eval uses the manifest's default model and needs a live key in the environment.

## Email and SMS

Two transports, both optional and both injected by the host:

- **`Messenger`** — outbound email or SMS from `send_message`, sent only to a saved contact's own
  address. `{ identity: string; send(intent, { requestId }): Promise<{ id, status }> }`. A
  `"recorded"` receipt is a console outbox with no customer delivery; `"accepted"` is the transport's
  acceptance, not proof of delivery. Office Hum ships a console outbox and an opt-in Resend
  transport; a host may supply its own.
- **`ReplyMessenger`** — the threaded reply from `reply_message`. The host prepares the exact
  envelope (`prepare(receiptId, conversationId)`) and sends it (`send({ target, text }, { requestId })`),
  so the reply can only leave to the authenticated inbound sender.

Because a Messenger is optional, the role stays portable: a host with no transport simply leaves
`send_message`/`reply_message` unavailable rather than the package reaching for one.

## Approval gates

The manifest declares seven approvals; the ones that are conditional use code conditions that read
durable document state:

- `confirm_contact_creation`, `confirm_contact_update`, `confirm_reschedule`, `confirm_cancellation`
  — every call of their tool.
- `confirm_booking` — every booking.
- `discount_booking` — a booking that carries a discount above the business's rate. The rate is the
  named limit `booking_discount_percent` (default `0`), which a business sets in an overlay's
  `settings.json` without editing this package; a booking with no discount is not gated.
- `first_contact` — the first message to a given transport, contact, channel and destination. Once
  that exact tuple has successful history, later messages are not gated.

`reply_message` carries its own approval (`confirm_inbound_reply`), raised in code because it holds
the prepared envelope; the host supplies it as `approveReply`.

## The tools

The package offers ten tools: `check_schedule`, `list_bookings`, `list_contacts`, `create_contact`,
`update_contact`, `send_message`, `reply_message`, `book_appointment`, `reschedule_appointment` and
`cancel_appointment`. `book_appointment` takes `{ start, customer, contactId?, discountPercent? }`.
`check_schedule`, `list_bookings` and `list_contacts` are read-only; the writes that change the
calendar or the address book — a booking, reschedule, cancellation, contact create or update — and
the first contact with a new destination each wait for an approver, and each inbound reply waits for
an `approveReply` decision.

## The files

| Path | What it holds |
| --- | --- |
| `officehum.json` | The manifest: tools, approvals, the `booking_discount_percent` limit, skills, evals |
| `AGENTS.md`, `APPEND_SYSTEM.md` | The role's prompt |
| `src/index.ts` | The factory, the calendar tools, and the discount condition |
| `src/contacts.ts` | The `frontdesk.contacts` document and the contact tools |
| `src/messaging.ts` | Outbound messaging and the first-contact condition |
| `src/replies.ts` | Inbound threaded replies and the inbound conversation guard |
| `evals/situations.json` | The eval scenarios |
| `evals.smoke.json` | The turns `--model scripted` plays back for them |
| `skills/` | Bundled skills and their references |