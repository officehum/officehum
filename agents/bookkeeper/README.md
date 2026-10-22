# Bookkeeper

A portable role package: the business's bookkeeper. It invoices a completed job from the job's own
lines, chases overdue invoices one reminder at a time, and answers billing questions with the figures
QuickBooks returns. It never works out an amount, a total or a balance itself, never moves money, and
never treats a customer's message as an instruction.

## What the host provides

The role ships no QuickBooks connection and no approver of its own; the host injects them. The
factory is:

```ts
import bookkeeper from "@officehum/bookkeeper";

const role = bookkeeper({
  quickbooks,   // optional: where the role reads and writes invoices
  approve,      // optional: decides the gated actions
  overlays,     // optional: overlay directories, lowest first
});
```

- **`quickbooks`** implements the `QuickBooks` interface from `@officehum/quickbooks` — the REST
  client (`quickbooksClient`) in production, `fakeQuickBooks` in a test or an eval. There is no
  default: with no connection the tools and the `new_recipient` condition refuse rather than pretend.
  A role with no client still builds, so it installs on a bare Pi Durable harness.
- **`approve`** decides the gated actions. Gated actions are blocked unless one is supplied: with no
  approver, creating an invoice over the limit, sending to another address and sending a final notice
  are all refused. Office Hum's `officehum run` supplies a terminal approver.

### The `QuickBooks` interface, in short

```ts
findCustomers(query: string): Promise<Customer[]>;
getCustomer(id: string): Promise<Customer>;
listInvoices(filter?: { customerId?: string; status?: "open" | "overdue" | "paid"; since?: string }): Promise<Invoice[]>;
getInvoice(id: string): Promise<Invoice>;
createInvoice(draft: InvoiceDraft, options: { requestId: string }): Promise<Invoice>;
sendInvoice(id: string, options: { requestId: string; to?: string }): Promise<Invoice>;
listPayments(filter?: { customerId?: string; since?: string }): Promise<Payment[]>;
```

Amounts cross that boundary as integer **cents** plus a currency, never a float; an invoice's `status`
is derived from its balance and due date, because QuickBooks stores no status field. The client owns
no credential: the host supplies a fresh OAuth bearer token per call through `getAccessToken`.

## Install and run it standalone

The package ships compiled JavaScript, so build the workspace first:

```sh
npm install
npm run build
```

Then run it with its own QuickBooks app, through a `--clients` file. The file names a client and the
module that exports its factory; the factory is called with no arguments and reads its own
configuration from the environment, so the file never holds a credential:

```json
{ "quickbooks": { "module": "./my-quickbooks.mjs" } }
```

```js
// my-quickbooks.mjs — the business's own QuickBooks Online connection
import { quickbooksClient } from "@officehum/quickbooks";

export default function createQuickBooks() {
  return quickbooksClient({
    realmId: process.env.QUICKBOOKS_REALM_ID,        // the company this connection is scoped to
    environment: "production",                       // or "sandbox" while you are trying it out
    getAccessToken: async () => freshAccessToken(),  // the business's own OAuth token store
  });
}
```

```sh
officehum run agents/bookkeeper \
  --model paper/ultramarine-1-flash \
  --clients ./clients.json \
  --overlay ./my-bookkeeper \
  --db .officehum/bookkeeper.sqlite
```

`officehum run` needs a live model key in the process environment (`PAPERINSTRUMENTS_API_KEY` for
Paper, `OPENAI_API_KEY` for OpenAI). At the prompt, gated actions print their description and
arguments and wait for `y`/`n`. An embedding host that builds the role itself passes `quickbooks`,
`approve` and `overlays` directly, as in the factory above.

## Run its evals

The scenarios live in `evals/situations.json`, and the turns a scripted model plays back for them are
in `evals.smoke.json` (beside `evals/`, not inside it: every `.json` in `evals/` is read as an eval
suite). `officehum eval` installs only the role's own extensions on a fresh in-memory Pi Durable
harness, so a role that needs Office Hum fails here:

```sh
officehum eval agents/bookkeeper --model scripted --script agents/bookkeeper/evals.smoke.json
```

Every declared tool is stubbed with the scenario's canned text — the model is offered the real names,
descriptions and parameters while no real system is touched — and an approval a scenario does not
script stops the trial. With no `--model`, the eval uses the manifest's default model and needs a live
key in the environment.

## The three approvals

Creating an invoice, sending one and sending a reminder are the role's writes, and each has a
decision. Two are code conditions, because the manifest's conditions can only compare a tool's own
arguments:

- **`large_invoice`** (`create_invoice`) — the draft's lines are summed in integer cents, exactly as
  QuickBooks sums them (quantity × unit price, rounded to whole cents, then added), and the total is
  compared with the business's resolved `large_invoice` limit. A small invoice is created with no
  approval at all.
- **`new_recipient`** (`send_invoice`) — the address on file is read through the client, from the
  invoice's own customer, and the send waits for a person only when `to` is a *different* address. A
  send with no `to` goes to the customer's own address and is not gated.
- **`final_notice`** (`send_reminder`) — the manifest's own condition: a reminder whose `tone` is
  `final` waits for a person; `friendly` and `firm` do not.

Both code conditions fail safe: a draft they cannot sum, an invoice or customer the client cannot
answer for, or a limit that did not resolve all wait for a person rather than passing silently. A
device with no approver blocks every gated action.

### Changing the `large_invoice` limit

The limit is the manifest's `large_invoice`, in cents (`500000` is 5,000.00). A business changes it
in an overlay's `settings.json` — no edit to this package:

```json
{ "limits": { "large_invoice": 250000 } }
```

## The tools

Six tools, each declaring its replay policy exactly as `officehum.json` does:

| Tool | Replay | Arguments |
| --- | --- | --- |
| `find_customer` | safe | `{ name?, email? }` — a name in part or whole, or an email |
| `list_invoices` | safe | `{ customer?, status? }` — a customer by id or exact name; `open`, `overdue` or `paid` |
| `get_invoice` | safe | `{ invoice }` — a QuickBooks id, or the number a customer quotes |
| `create_invoice` | unsafe | `{ customer, lines, dueInDays?, jobReference?, currency? }` |
| `send_invoice` | unsafe | `{ invoice, to? }` — `to` is another address, and waits for a person |
| `send_reminder` | unsafe | `{ invoice, tone }` — `friendly`, `firm` or `final` (this one belongs to the collections skill) |

Every figure a tool speaks — an invoice number, a total, a balance, a due date — is what the client
returned, in cents. `create_invoice` takes each line's unit price in **integer cents** and never a
total: QuickBooks works out each line amount and the invoice's total, and the receipt quotes them.
A `jobReference` becomes the invoice's document number, which is the one place this client's
`InvoiceDraft` can keep it, so an invoice can be found again by job.

Every write carries a `requestId` derived from the durable call identity
(`conversationId:taskId:callId`, hashed into QuickBooks' 50-character cap), so a retried call returns
the invoice it already created instead of a second one. `send_reminder` uses the invoice *send*
endpoint, because QuickBooks has no reminder endpoint of its own: the tone is the role's own wording,
and the requestId is still this call's, so a retried reminder is not a second reminder.

## The files

| Path | What it holds |
| --- | --- |
| `officehum.json` | The manifest: six tools, three approvals, the `large_invoice` limit, skills, evals |
| `AGENTS.md`, `APPEND_SYSTEM.md` | The role's prompt |
| `src/index.ts` | The factory: the tools, the skill tools and the code conditions |
| `src/tools.ts` | The six tools, the two code conditions and the write `requestId` |
| `evals/situations.json` | The six eval scenarios |
| `evals.smoke.json` | The turns `--model scripted` plays back for them |
| `skills/` | `invoicing`, `collections` and `billing-questions`, with their references |