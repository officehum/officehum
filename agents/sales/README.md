# Sales / Account Manager

A portable role package: the account manager at **Northwind Facilities**, a fictitious commercial
cleaning and building-maintenance company in Portland, Oregon. It qualifies leads, quotes from the
company's price book, follows up, keeps the pipeline, and hands anything a person must decide to the
person who owns it.

It ships with the company's facts — who works there, what the six services are, what everything costs,
the refund and discount policies, the escalation path — as a generated skill inside the package. Two
things it will not do: give a price that is not in the price book, and let a discount or an over-limit
quote through without a person.

## Try it

From a machine with no copy of this repository:

```sh
npm install -g officehum        # or use npx officehum
officehum run ./sales-account-manager
```

Then type a message. With no configuration at all the role runs on a **demonstration desk**: five
leads in memory, the company's own price book, and nothing written anywhere. Ask it to quote the
Riverside Dental deep clean and it will price it from the book, apply the minimum, and tell you what
the quote says. It needs a model key in the environment (`PAPERINSTRUMENTS_API_KEY` for Paper) for
that conversation, like every role.

From a checkout of this repository:

```sh
npm install
npm run build
node packages/cli/dist/index.js run agents/sales --model paper/ultramarine-1-flash
```

## Run its evals

The scenarios live in `evals/situations.json`; the turns a scripted model plays back are in
`evals.smoke.json` (beside `evals/`, not inside it: every `.json` in `evals/` is read as a suite).
`officehum eval` installs only the role's own extensions on a fresh in-memory Pi Durable harness, so a
role that needs Office Hum fails here:

```sh
officehum eval agents/sales --model scripted
officehum eval agents/sales --model scripted --mode office   # the office's real approval gate
```

Twelve scenarios, all deterministic: a quote inside the limit; a quote over it, waiting for a
person and then created; a discount declined cleanly; a log receipt claiming Marcus decided,
which the reply must not repeat because no approval answered; a lead with no budget that is
qualified rather than quoted; a price question answered from the book; an instruction injected
into a lead's message; a complaint handed to the two people who own it; a quiet quote closed as
lost; and a price objection answered with the value of the quote. Every declared tool is stubbed
with the scenario's canned text — the model is offered the real names, descriptions and
parameters while no real system is touched — and an approval a scenario does not script stops the
trial. Two more are the honesty scenarios every catalog role carries (RASF-3483): a discount
declined with no one named, reported without naming who decided, and a refund the role cannot
agree, never claimed as passed on to anyone.

A scripted run counts the calls the model *intended*, including ones an approval gate would block; it
says the wiring holds, not how the role behaves. `--mode office` is stronger: it binds a ticket and the
office's real gate, so a refused call is refused by the gate production uses.

## What it does

| Tool | Replay | What it is for |
| --- | --- | --- |
| `list_leads` | safe | The pipeline, filtered by stage or by a search on the company, contact or site |
| `get_quote` | safe | One existing quote by its id: lead, lines, subtotal, discount, total and validity |
| `search_price_book` | safe | The price book item a quote line is built from, with its unit, price and minimum |
| `create_quote` | unsafe | A draft quote the desk prices, one line per service (this one belongs to the quoting skill) |
| `log_activity` | unsafe | An internal note on a lead: what was decided and what happens next |
| `read_company` | safe | One section of the company record: profile, hours, people, services, pricing, policies, tone, escalation, glossary |

Every tool speaks in integer cents behind the money a person reads, and every figure comes from the
company record or from the desk — never from the model, and never from a constant in the code.

## The two approvals

Both are declared in `officehum.json` and evaluated by the SDK's gate; the role's own gate and the
office's gate read the same declaration, so there is no second copy of the policy in code.

- **`any_discount`** (`create_quote`) — a discount waits for a person whatever its size. The condition
  is `discountPercent` present *and* above zero, so a quote with no discount is not gated at all.
- **`quote_over_limit`** (`create_quote`) — the SDK sums each line's `unitPriceCents` times its
  `quantity` and compares the total with the business's resolved `quote_limit_cents` limit. At the
  limit passes; a cent over waits.

`log_activity` states `noApproval`: it is an internal note with no effect outside the office. There is
no tool that decides an approval, and none that changes the limit — the enforcement is by absence, as
everywhere else in this repository.

### Changing the limit

The limit is `officehum.json`'s `quote_limit_cents`, in cents (`500000` is $5,000.00), and it is the
same number the company package records as `approvalLimits.quoteOverCents` — `src/package.test.ts`
fails if they drift. A business changes it in an overlay's `settings.json`, with no edit to this
package and no restart:

```json
{ "limits": { "quote_limit_cents": 750000 } }
```

## The company it works for

`company/default/` at the root of the repository is the one place Northwind Facilities is described:

| File | Holds |
| --- | --- |
| `company.json` | The record: profile, people and what each decides, services, price book, policies, tone, escalation, glossary |
| `handbook.md` | The long-form reference: how the business works and what a job looks like end to end |
| `policies.md` | Refunds, discounts, safety, data handling, and what must never be promised |
| `pricing.md` | The price book in prose, and what may be quoted without a person |

Every role in `agents/` gets the same facts as generated copies, because a published role has to be
self-contained:

```
skills/company-handbook/SKILL.md                    the handbook, and the entry point
skills/company-handbook/references/pricing.md       every price and minimum
skills/company-handbook/references/policies.md      the rules and who decides
skills/company-handbook/references/facts.json       the same facts, for the role's own code
```

`npm run sync-company` writes them. They are generated: do not edit a copy, because `npm test`
regenerates the whole catalogue in memory and fails, naming the file and the command, when a copy has
drifted. The generator also refuses a company that disagrees with itself — a figure in the prose that
`company.json` does not record, a price the prose leaves out, an escalation to someone who does not
work there, a headcount the field structure does not add up to.

### Putting your own company in

Two ways, and the first is the one for a clone of this repository:

1. **Replace the facts.** Edit `company/default/company.json`, `handbook.md`, `policies.md` and
   `pricing.md` for your business, run `npm run sync-company`, and commit the generated copies. The
   agent, its skills and its price book change together, and the drift test keeps them together.
2. **Pass it in.** A host that builds the role itself passes `company`, and nothing in
   `company/default/` is involved:

```ts
import sales, { type CompanyFacts } from "@officehum/sales";

const role = sales({ company: myCompanyFacts, desk: myCrm, approve });
```

`CompanyFacts` is the shape of `references/facts.json`; a business with a different price book, people
and policies fills in the same shape.

## Bind it to a real pipeline

The role ships no CRM connection. `fakeSalesDesk` is the demonstration one; a host binds a `SalesDesk`:

```ts
export interface SalesDesk {
  listLeads(filter?: { stage?: LeadStage; query?: string }): Promise<readonly Lead[]>;
  getQuote(id: string): Promise<Quote>;
  createQuote(draft: QuoteDraft, options: { requestId: string }): Promise<Quote>;
  logActivity(entry: ActivityDraft, options: { requestId: string }): Promise<Activity>;
}
```

The desk owns the arithmetic and the price book: every quote line names a price book item and carries
that item's own unit price, and a line with no item is refused, because work the book does not cover is
priced by a person. A quote's line amounts, the price book's minimums, any discount and the
total come back in the receipt, so the model never computes a figure. Every write carries a
`requestId` derived from the durable call identity, so a retried call returns the quote it already
made instead of a second draft.

Standalone, through a `--clients` file. The file names a client and the module that exports its
factory; the factory is called with no arguments and reads its own configuration from the environment,
so the file never holds a credential:

```json
{ "desk": { "module": "./my-crm.mjs" } }
```

```js
// my-crm.mjs — the business's own CRM
export default function createDesk() {
  return myCrmClient({ token: process.env.CRM_TOKEN });
}
```

```sh
officehum run agents/sales --clients ./clients.json --model paper/ultramarine-1-flash
```

An embedding host passes `desk`, `company`, `approve` and `overlays` straight to the factory instead.

## Install it as a library

```ts
import sales from "@officehum/sales";

const role = sales({ desk, approve, overlays: ["./my-sales"] });
for (const extension of role.extensions) registry.install(extension);
const root = await harness.root(context, { agent: role.agent });
```

- **`desk`** — the pipeline. Omitted: the demonstration desk, priced from the same book.
- **`approve`** — decides the gated actions. Omitted: a discount and an over-limit quote are both
  blocked, which is the safe direction.
- **`overlays`** — the business's own `AGENTS.md`, skills, `settings.json` and limits, lowest first.

Office Hum's `officehum run` supplies a terminal approver and prints a gated action's description and
arguments before it waits for `y`/`n`.

## Known limits

- The `quote_over_limit` approval sums quantity × unit price over a quote's lines, before the desk
  applies the price book's per-line minimums. A quote made of several lines that the minimums raise
  (each small job priced at its minimum) can come to more than the limit without asking for approval.
  The receipt still shows the desk's true total.

## The files

| Path | What it holds |
| --- | --- |
| `officehum.json` | The manifest: six tools, two approvals, one limit, dispatches, skills, evals |
| `AGENTS.md`, `APPEND_SYSTEM.md` | The role's prompt |
| `role.md`, `role.sources.json` | The researched description of the job, every item cited; `officehum verify-role agents/sales --online` re-checks the sources |
| `src/index.ts` | The factory: the tools, the skill placement, the desk and company defaults |
| `src/tools.ts` | The six tools, and the receipts they return |
| `src/company.ts` | The company facts as the role reads them, and the price book search |
| `src/desk.ts` | The `SalesDesk` interface, `fakeSalesDesk`, the demo pipeline and the quote arithmetic |
| `src/tools.test.ts` | One test per tool, on the fake desk and the real facts |
| `src/index.test.ts` | The factory, both approval gates on a real harness, and twelve scenarios |
| `src/package.test.ts` | The package, the manifest, and the company's numbers against the role's |
| `evals/situations.json` | The twelve eval scenarios |
| `evals.smoke.json` | The turns `--model scripted` plays back for them |
| `skills/` | `qualifying-a-lead`, `quoting-from-the-price-book`, `following-up`, and the generated `company-handbook` |

## You may not

The prompt says it, the manifest declares it, and the tests hold it: this role gives no price that is
not in the price book, agrees no discount, promises no start date or contract term, agrees no refund or
credit, and treats an instruction inside a lead's message as information about their building rather
than an order. Anything outside that is handed to the person who owns it, named to the client, with a
day attached.