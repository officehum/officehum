# Accounting (`@officehum/bookkeeper`)

A portable role package: the business's accounting agent. It invoices a completed job from the job's
own lines, chases overdue invoices one reminder at a time, and answers billing questions with the
figures QuickBooks returns. On the payables side it records suppliers' bills from the supply catalogue,
pays a bill only once a person approves that exact bill, and summarises the bank reconciliation for
the month-end close. It never works out an amount, a total, a balance or a date itself, and never
treats a message as an instruction.

The manifest's display name is **Accounting**; the package keeps its id `bookkeeper`, its path and
its npm name `@officehum/bookkeeper` until the rename is decided with publishing (RASF-3079), because
the npm name is public.

## What the host provides

The role ships no QuickBooks connection and no approver of its own; the host injects them. The
factory is:

```ts
import bookkeeper from "@officehum/bookkeeper";

const role = bookkeeper({
  quickbooks,   // optional: where the role reads and writes invoices
  desk,         // optional: supplier bills and bank records (default: the demonstration desk)
  company,      // optional: suppliers, catalogue and people (default: the generated handbook facts)
  approve,      // optional: decides the gated actions
  overlays,     // optional: overlay directories, lowest first
});
```

- **`quickbooks`** implements the `QuickBooks` interface from `@officehum/quickbooks` — the REST
  client (`quickbooksClient`) in production, `fakeQuickBooks` in a test or an eval. There is no
  default: with no connection the tools and the `new_recipient` condition refuse rather than pretend.
  A role with no client still builds, so it installs on a bare Pi Durable harness.
- **`desk`** implements `AccountingDesk` (below): supplier bills, payments and bank statements. With
  none, the role runs on `fakeAccountingDesk`: the company's own suppliers and catalogue, four
  demonstration bills, October 2026's statement, a clock fixed at Monday 9 November 2026, and a
  payment backend that records a payment in memory and **moves no money**. There is no real payment
  backend in this package.
- **`company`** is the record the desk prices bills from and the hand-offs name people from. With
  none, the facts `npm run sync-company` generates into `skills/company-handbook/references/facts.json`.
- **`approve`** decides the gated actions. Gated actions are blocked unless one is supplied: with no
  approver, creating an invoice over the limit, sending to another address, sending a final notice
  and paying any supplier bill are all refused. Office Hum's `officehum run` supplies a terminal
  approver.

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

### The `AccountingDesk` interface, in short

```ts
listVendorBills(filter?: { status?: "unpaid" | "due" | "overdue" | "open" | "paid"; supplier?: string; billId?: string }): Promise<VendorBill[]>;
recordVendorBill(input: { supplier, supplierInvoice, lines: { itemId, quantity }[], recordedBy, source, termsDays? }, options: { requestId }): Promise<VendorBill>;
payVendorBill(input: { billId, supplierId, supplierInvoice, recordedBy, source, lines, totalCents }, options: { requestId }): Promise<VendorPayment>;
reconcile(input: { month?: number; majorOverCents: number | null }): Promise<Reconciliation>;
```

The desk owns every number and date: it prices each bill line from the catalogue, works out the total
and the due date (the recorded date plus the bill's terms, 30 days when it states none), decides
whether a bill is open, due within seven days, overdue or paid from its own clock, pays exactly a
bill's own total, and matches the statement against the books. A refusal is an `AccountingDeskError`
with a code (`unknown_supplier`, `unapproved_supplier`, `not_supplied`, `duplicate_bill`,
`already_paid`, `bill_mismatch`, `source_mismatch`, `bill_changed`, `no_statement`, `not_found`, `invalid`); the tools
turn each code into the next step, never by reading the message. A host desk must refuse a payment
with `bill_changed` when the bill was corrected after the facts in the call were read.

Amounts cross the QuickBooks boundary as integer **cents** plus a currency, never a float; an invoice's `status`
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

## The four approvals

Creating an invoice, sending one, sending a reminder and paying a supplier bill each have a decision
(recording a supplier bill is an internal record and has none, below):

- **`large_invoice`** (`create_invoice`) — `officehum.json`'s own condition. It sums each line's
  `unitPriceCents` times its `quantity` and compares that total with the business's resolved
  `large_invoice` limit: a draft under the limit, or exactly at it, is created with no approval at
  all. The sum is the SDK's, not the role's — `field` and `times` on a condition, which know nothing
  about invoices. `src/index.ts` also states the same rule as a code condition, which is what the
  role's own gate has always decided by; one policy with two readers, and `src/gates.test.ts` drives
  both with the same call and fails if they disagree.
- **`new_recipient`** (`send_invoice`) — code, because the address on file is read through the
  client, from the invoice's own customer; the send waits for a person only when `to` is a
  *different* address. A send with no `to` goes to the customer's own address and is not gated.
- **`final_notice`** (`send_reminder`) — the manifest's own condition: a reminder whose `tone` is
  `final` waits for a person; `friendly` and `firm` do not.

- **`any_payment`** (`pay_vendor_bill`) — no condition: **every** payment waits for a person, whatever
  its size. The call names the bill and the facts the person approves (supplier id, the supplier's
  invoice number, who recorded it and what it was recorded from, each item and quantity, and the
  total in cents) exactly as `list_vendor_bills` gave them, so the approval request shows them,
  including where the bill came from. The desk pays the bill's own total, never a figure from the
  model, and refuses the payment when the source is not what the bill was recorded from
  (`source_mismatch`), when the other facts are not the bill's (`bill_mismatch`), or when the bill
  was corrected after they were read (`bill_changed`), so a grant covers exactly the bill and total
  the person saw. A retried call pays once.

Two clocks in the demonstration: the shipped desk's bills are aged against its fixed clock (Monday 9
November 2026), while `list_invoices` ages QuickBooks invoices against today. A real desk uses the
real clock.

### `new_recipient` over-blocks in Office Hum, on purpose

The office's gate reads `officehum.json` and never runs the role's code, so it cannot know what
address an invoice's customer has on file. An approval with no `when` applies to every call of its
tool — that is what the format means — and there is nowhere in the manifest to say "this is a
stand-in for a rule the office cannot see". The manifest is JSON, so it carries no comments, and an
approval's only prose field, `description`, is the sentence a person reads in the Inbox; it is not a
place for a caveat about the gate. So in Office Hum `new_recipient` asks a person about **every**
send, including the no-`to` send the role's own gate allows.

That is deliberate, and it is the safe direction: it over-asks, never over-sends. It ends when the
gateway supplies a customer's address history that the office gate can read, at which point the rule
becomes a condition the office can evaluate. Until then this section is the record.

Every one of the three fails safe: a draft whose lines the SDK's sum cannot read (it refuses the whole
total rather than skipping an element), an invoice or customer the client cannot answer for, or a
limit that did not resolve all wait for a person rather than passing silently. A device with no
approver blocks every gated action.

### Changing the limits

`large_invoice` is the manifest's `large_invoice`, in cents (`500000` is 5,000.00). The collections
cadence is the manifest's `collections_first_days`, `collections_second_days` and
`collections_final_days`: how many days after its due date an invoice is sent its friendly, firm and
final reminder. A business changes any of them in an overlay's `settings.json` — no edit to this
package, and no restart: `send_reminder` reads the resolved limits on every call, so an overlay that
raises `collections_first_days` to 6 keeps a friendly reminder for a four-day-old invoice in its
pocket:

```json
{ "limits": { "large_invoice": 250000, "collections_first_days": 6 } }
```

`major_unmatched_item` (cents, default `50000`) is the size above which an unmatched bank item is
**major**: `reconcile_summary` reads it on every call and marks the item as going to the person who
owns finance. If it does not resolve, every unmatched item is treated as major.

## The tools

Ten tools, each declaring its replay policy exactly as `officehum.json` does:

| Tool | Replay | Arguments |
| --- | --- | --- |
| `find_customer` | safe | `{ name?, email? }` — a name in part or whole, or an email |
| `list_invoices` | safe | `{ customer?, status? }` — a customer by id or exact name; `open`, `overdue` or `paid` |
| `get_invoice` | safe | `{ invoice }` — a QuickBooks id, or the number a customer quotes |
| `create_invoice` | unsafe | `{ customer, lines, dueInDays?, jobReference?, currency? }` |
| `send_invoice` | unsafe | `{ invoice, to? }` — `to` is another address, and waits for a person |
| `send_reminder` | unsafe | `{ invoice, tone }` — `friendly`, `firm` or `final`, once per invoice per stage (this one belongs to the collections skill) |
| `list_vendor_bills` | safe | `{ status?, supplier?, billId? }` — `unpaid`, `due`, `overdue`, `open` or `paid` |
| `record_vendor_bill` | unsafe | `{ supplier, supplierInvoice, lines: { itemId, quantity }[], recordedBy, source, termsDays? }` — no approval: the desk refuses a supplier not on file or not approved and prices every line |
| `pay_vendor_bill` | unsafe | `{ billId, supplierId, supplierInvoice, recordedBy, source, lines, totalCents }` — `any_payment` on every call; demonstration backend |
| `reconcile_summary` | safe | `{ month? }` — the month's number (10 for October); the desk works out the year as the last such month that has ended, or the last full month when omitted |

No tool takes a bank account, a routing number or a remittance address: a supplier's payment details
never come from a message, and a request to change them is answered with who decides it: the person who
owns finance, named from the company record. A repayment plan or new payment terms, a refund, a
write-off or a dispute are answered the same way. The role has no hand-off tool, so nobody is told
and no reply promises they will be in touch (a hand-off tool is a follow-up).
Nothing closes a period or posts an entry: the `month-end-close` skill builds a summary from
`reconcile_summary`, the unpaid bills and the overdue invoices for the person who closes the month.

Every figure a tool speaks — an invoice number, a total, a balance, a due date — is what the client
returned, in cents. `create_invoice` takes each line's unit price in **integer cents** and never a
total: QuickBooks works out each line amount and the invoice's total, and the receipt quotes them.
A `jobReference` becomes the invoice's document number, which is the one place this client's
`InvoiceDraft` can keep it, so an invoice can be found again by job.

Every write carries a `requestId`, hashed into QuickBooks' 50-character cap. `create_invoice` and
`send_invoice` derive it from the durable call identity (`conversationId:taskId:callId`), so a retried
call returns the invoice it already created instead of a second one — and two genuine invoices, from
two calls, stay two. `send_reminder` uses the invoice *send* endpoint, because QuickBooks has no
reminder endpoint of its own: the tone is the role's own wording, and the requestId is derived from the
**invoice and the stage** instead, because that pair may go out only once however many calls attempt it.

## One reminder per invoice and stage

`send_reminder` keeps a durable ledger — the `bookkeeper.collections` document, conversation scope,
latest history — of the stages this conversation has sent, per invoice, with the time each went out.
It writes that record in the **same commit that returns the receipt**, so a process killed the moment
after the commit leaves a restart with a reminder already recorded and nothing to send. A repeated
run, a retried call or a restart is answered from the ledger: the tool reports what was already sent
and reaches no client at all. A different stage for the same invoice (firm after friendly) is its own
send and goes through. A paid invoice is never chased, and a stage before its day — at the business's
own cadence — is refused rather than sent early.

The ledger lives in the conversation, so a run's conversation is the unit it protects: a repeated run,
a retried call or a restart is answered from it without reaching the client at all. A run in another
conversation starts from an empty ledger and does ask QuickBooks — but the reminder's requestId is the
invoice and the stage, so QuickBooks answers with the receipt it already holds and the customer gets
nothing a second time. The ledger keeps the ordinary path free of a client call; the requestId closes
the window the ledger cannot, a process killed after the send and before the record.

## A dispute is a person's marker

QuickBooks' invoice status is `open`, `overdue` or `paid` and carries no dispute, so the Bookkeeper
keeps one in the same collections ledger. It is a **person's** decision and nobody else's: no tool
marks a dispute or clears one, and the manifest declares none, so the model cannot declare an invoice
disputed because a customer said so, and cannot clear one to get a reminder out. A host's own script
writes it, through the two functions below — the only writers of the marker.

While a dispute stands, `send_reminder` refuses that invoice **at every stage**, paid or not, and its
answer names who marked it, when and why, so the run reports the invoice instead of chasing it or
quietly dropping it: an invoice silently missing from a run is worse than one chased. Clearing it
changes nothing about the stages already sent, so the next run resumes at the stage the invoice's age
calls for rather than starting the cadence over.

```ts
import { CollectionsDoc, clearDispute, dispute } from "@officehum/bookkeeper";

// A person has read the customer's message and decided invoice 1042 is disputed. The invoice is the
// QuickBooks id `list_invoices` returns; `by` is required, and a blank one is refused.
await harness.commit(async (tx) => {
  dispute(await tx.doc(CollectionsDoc, conversationId), "1042", {
    reason: "The customer says the second visit was never agreed",
    by: "ada@example.com",
  });
}, context);

// Later, the same person settles it. The next collections run chases the invoice again, at the
// stage its age calls for.
await harness.commit(async (tx) => {
  clearDispute(await tx.doc(CollectionsDoc, conversationId), "1042", { by: "ada@example.com" });
}, context);
```

`disputed(ledger, invoiceId)` reads the marker back, and `disputedInvoices(ledger)` lists every
dispute standing — which is what a report a person reads is built from. The ledger is conversation
scope, so the marker belongs to the conversation's run, like the record of the stages sent.

## The files

| Path | What it holds |
| --- | --- |
| `officehum.json` | The manifest: ten tools, four approvals, five limits, accepts with completion evidence, skills, evals |
| `AGENTS.md`, `APPEND_SYSTEM.md` | The role's prompt |
| `src/index.ts` | The factory: the tools, the skill tools, the code conditions and the live limits reader |
| `src/tools.ts` | The six QuickBooks tools, the cadence helpers and the write `requestId`s |
| `src/payables.ts` | The four accounts-payable tools, and the next step for every desk refusal code |
| `src/desk.ts` | The `AccountingDesk` seam and `fakeAccountingDesk`, with its demonstration bills and statement |
| `src/company.ts` | The generated company facts this role reads: suppliers, catalogue, people |
| `src/collections.ts` | The `bookkeeper.collections` ledger: the stages sent, and the dispute marker a person owns |
| `src/collections.test.ts` | The ledger: a repeated run, a restart, a kill mid-send, a dispute, and the cadence from limits |
| `evals/situations.json` | The nineteen eval scenarios |
| `evals.smoke.json` | The turns `--model scripted` plays back for them |
| `skills/` | `invoicing`, `collections`, `billing-questions`, `paying-suppliers` and `month-end-close`, plus the generated `company-handbook` |