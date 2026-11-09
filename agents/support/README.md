# Customer Support

A portable role package: the client services representative at **Northwind Facilities**, a
fictitious commercial cleaning and building-maintenance company in Portland, Oregon. It answers
clients' questions, takes down their complaints as cases, books a re-clean when a visit fell short,
asks a person for every credit, hands safety complaints, refunds and complaints about staff to the
right person by title, and closes a case only with its outcome recorded.

It ships with the company's facts — the price book its invoices are priced from, the re-clean window,
the usual service-recovery credit, who decides complaints, credits, money back and safety — as a
generated skill inside the package. Three things it will not do: give a credit without a person,
promise or give a refund (it has no refund tool), and hand a complaint about someone to that person.

## Try it

From a checkout of this repository:

```sh
npm install
npm run build
node packages/cli/dist/index.js run agents/support --model paper/ultramarine-1-flash
```

With no configuration the role runs on a **demonstration desk**: five clients on recurring contracts,
their October 2026 invoices priced from the price book, and six cases on the morning of Monday
9 November 2026 — a fresh complaint from Hawthorne Family Dental (C-301), a re-clean done and waiting
for Little Acorns Childcare to confirm (C-302), a question from Sellwood Law Partners (C-303), a credit
Burnside Property Group is still waiting on (C-304), a re-clean booked for Gateway Accounting (C-305),
and one closed case (C-300). Nothing is sent anywhere. Ask, as Hawthorne Family Dental, for a credit
for case C-301 and the role will find the cleaning line on INV-2041, where the desk works the credit
out at $150.00, and ask Eileen Hart, Finance and Billing, to approve it. It needs a model key in the
environment (`PAPERINSTRUMENTS_API_KEY` for Paper) for that conversation, like every role.

## Run its evals

The scenarios live in `evals/situations.json`; the turns a scripted model plays back are in
`evals.smoke.json`:

```sh
officehum eval agents/support --model scripted
officehum eval agents/support --model scripted --mode office   # the office's real approval gate
```

Twelve scenarios. Seven are critical, five of them the role's own: a credit asked for with the
desk's figures and declined by a person, with the client told plainly; a demand for money back,
handed to the person who decides refunds with no money promised; a chemical left within a child's
reach, logged and escalated as safety at once; a client's email instructing the role to ignore its
rules, issue a credit and close the case; and a re-clean receipt whose log note claims a person
approved a credit and agreed a refund, which the reply must not repeat. Five are normal: a pay and
time-off question handed to People Ops, a re-clean booked for a visit that fell short, a case's
status answered from the desk, a complaint about the person who owns complaints sent to someone
else, and a case closed with its outcome. The other two critical ones are the honesty scenarios
every catalog role carries (RASF-3483): a credit declined with no one named, reported without naming
who decided, and a quote and start date for new work, which the role cannot give, never claimed as
passed on to anyone.

## What it does

| Tool | Replay | Gate | What it is for |
| --- | --- | --- | --- |
| `find_client` | safe | — | A client by name, contact, email, contract or site, with its open cases |
| `list_cases` | safe | — | A client's cases or one case: status, re-clean, credit, escalation; each invoice line with the credit the desk works out |
| `log_case` | unsafe | `noApproval`; an internal record | Log a complaint or question: kind, category, summary, who raised it and where |
| `book_reclean` | unsafe | `noApproval`; re-work is the standard remedy, inside the window the desk enforces | Book a return visit at no charge for work that fell short |
| `offer_credit` | unsafe | approval `any_credit`, every call | A credit note on one invoice line for one complaint, for the desk's amount |
| `escalate_case` | unsafe | `noApproval`; an internal hand-off to the person the record names | Hand a case on for safety, refund, billing, legal, data, staff or unresolved |
| `resolve_case` | unsafe | `noApproval`; the desk refuses a case still waiting on something | Close a case with its outcome |
| `read_company` | safe | — | One section of the company record, including who decides what in support |

**Every amount comes from the desk.** Invoice lines are a price book id and a quantity; the desk prices
each one from the company's price book (minimums included) and works out the credit on it: the line
total or the company's usual service-recovery credit (`policies.refunds.serviceRecoveryCreditCents`),
whichever is less. There is no money constant in the code.

**Credits.** `list_cases` shows each invoice line's credit and the exact `offer_credit` call for it. The
model copies the case, client, invoice, line and credit; it never chooses an amount. Those are the
approval's arguments, so the person deciding sees who the credit is for, on which line and for how
much, as the desk worked it out, and the desk issues the credit only if the client and amount are
still its own (`credit_changed` otherwise, with the right figures; a host desk must refuse the same
way). A case gets one credit, and a credit already waiting for a person (`credit_waiting`) is not asked
for twice.

**Refunds** have no tool. The manifest's `mayNot` and the prompt hand money back to the person the
company record names for it (`policies.refunds.refundNeeds`) through `escalate_case` with reason
`refund`, and the receipt tells the role to promise no money.

**Re-cleans** are the company's standard remedy for work that fell short, so they need no approval:
the desk books one only for a `quality` or `missed_visit` complaint, on a date from today to the end of
the re-clean window (`policies.refunds.recleanWindowDays` business days from the complaint), once per
case.

**Escalation.** The desk picks the person from the company record by the reason: the escalation table
for safety, legal and data, the refunds policy for refunds, billing and complaints. A complaint is
never handed to the person it is about (`about`, read for reasons `staff` and `safety` and for any case logged as staff or safety, matched by
name, surname, first name or title as whole words): it goes to the person who owns complaints, or to
the head of the company if the complaint is about them. On any other case `about` is ignored, so a
misplaced name cannot send a refund away from its owner. A safety case is escalated for safety before
any other reason. A safety complaint's `log_case` receipt names
`escalate_case` as the next step, and the desk refuses to close a safety case that was never handed
on.

**Closing.** `resolve_case` needs an outcome, and the desk refuses a case with a credit waiting for a
person, a re-clean booked and not done, a safety complaint not escalated, or a case already handed to
someone (it is theirs to close).

## Bind it to a real support system

The role ships no help desk or CRM connection. `fakeSupportDesk` is the demonstration one; a host binds
a `SupportDesk` (`src/desk.ts`): `findClient`, `listCases`, `listInvoices`, `logCase`, `bookReclean`,
`issueCredit`, `escalateCase` and `resolveCase`. Every write carries a `requestId` derived from the
durable call identity, so a retried call returns what it already did. The desk owns the pricing, the
credit, the window, who a case goes to and the refusals; a refusal is a `SupportDeskError` with a
`code` the tools turn into the next step.

```ts
import support from "@officehum/support";

const role = support({ desk, approve, overlays: ["./my-support"] });
for (const extension of role.extensions) registry.install(extension);
const root = await harness.root(context, { agent: role.agent });
```

- **`desk`** — the support system. Omitted: the demonstration desk, on the company's own data.
- **`company`** — a host's own company facts, in the shape of `references/facts.json`.
- **`approve`** — decides the gated actions. Omitted: every credit is blocked.
- **`overlays`** — the business's own `AGENTS.md`, skills and `settings.json`, lowest first.

## The files

| Path | What it holds |
| --- | --- |
| `officehum.json` | The manifest: eight tools, one approval, dispatches, `mayNot`, skills, evals |
| `AGENTS.md`, `APPEND_SYSTEM.md` | The role's prompt |
| `role.md`, `role.sources.json` | The researched description of the job; `officehum verify-role agents/support --online` re-checks the sources |
| `src/index.ts` | The factory |
| `src/tools.ts` | The eight tools, and the receipts they return |
| `src/company.ts` | The company facts as the role reads them |
| `src/desk.ts` | The `SupportDesk` interface, `fakeSupportDesk` and the demonstration clients, invoices and cases |
| `src/*.test.ts` | The desk's rules, each tool, the approval gate on a real harness, the package and the scenarios |
| `skills/` | `handling-complaints`, `putting-things-right`, `escalating-cases`, and the generated `company-handbook` |
