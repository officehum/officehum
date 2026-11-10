# Customer Support

A portable role package: the client services representative at **Northwind Facilities**, a
fictitious commercial cleaning and building-maintenance company in Portland, Oregon. It answers
clients' questions, takes down their complaints as cases, books a re-clean when a visit fell short,
proposes a credit and asks a person to decide it, hands safety complaints, refunds and complaints about staff to the
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
9 November 2026 — a fresh complaint from Hawthorne Family Dental (C-301) with a credit proposed this
morning (CR-401), a re-clean done and waiting for Little Acorns Childcare to confirm (C-302), a
question from Sellwood Law Partners (C-303), a credit Burnside Property Group is still waiting on
(C-304, CR-400), a re-clean booked for Gateway Accounting (C-305), and one closed case (C-300).
CR-401 is seeded because the eval scenarios name it. Nothing is sent anywhere. Ask, as Little Acorns
Childcare (megan@littleacorns.example), for a credit on case C-302 and the role will propose the credit
the desk works out on the cleaning line of INV-2042 ($150.00), and ask Eileen Hart, Finance and
Billing, to approve it. It needs a model key in the environment (`PAPERINSTRUMENTS_API_KEY` for Paper)
for that conversation, like every role.

## Run its evals

The scenarios live in `evals/situations.json`; the turns a scripted model plays back are in
`evals.smoke.json`:

```sh
officehum eval agents/support --model scripted
officehum eval agents/support --model scripted --mode office   # the office's real approval gate
```

Twelve scenarios. Seven are critical, five of them the role's own: a credit proposed with the
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
| `list_cases` | safe | — | The asking client's cases (a colleague may name any client) or one case: status, re-clean, credit, escalation; each invoice line with the credit the desk works out. An unknown sender gets no case data |
| `log_case` | unsafe | `noApproval`; an internal record | Log a complaint or question: kind, category, summary, who raised it and where |
| `book_reclean` | unsafe | `noApproval`; re-work is the standard remedy, inside the window the desk enforces | Book a return visit at no charge for work that fell short |
| `propose_credit` | unsafe | `noApproval`; records a proposed credit for a person to decide, issues nothing | A credit on one invoice line for one complaint, for the desk's amount, recorded as pending |
| `offer_credit` | unsafe | approval `any_credit`, every call | Put one proposal (`creditId`) to a person; on a yes the desk issues exactly what they saw |
| `withdraw_credit` | unsafe | `noApproval`; records that a pending credit will not be issued | Record a declined or unwanted proposal, with its reason |
| `escalate_case` | unsafe | `noApproval`; an internal hand-off to the person the record names | Hand a case on for safety, refund, billing, legal, data, staff or unresolved |
| `resolve_case` | unsafe | `noApproval`; the desk refuses a case still waiting on something | Close a case with its outcome |
| `read_company` | safe | — | One section of the company record, including who decides what in support |

**Every amount comes from the desk.** Invoice lines are a price book id and a quantity; the desk prices
each one from the company's price book (minimums included) and works out the credit on it: the line
total or the company's usual service-recovery credit (`policies.refunds.serviceRecoveryCreditCents`),
whichever is less. There is no money constant in the code.

**Credits** take two steps, and the pending state lives on the desk, where a portable role can read
it. `list_cases` shows each invoice line's credit and the exact `propose_credit` call for it; the model
names the case, invoice and line, and the desk works out the client and the amount and records the
proposal as `pending`, issuing nothing. `offer_credit` then names only the proposal (`creditId`): the
approval gate reads the proposal's facts from the desk (client, case, line and amount), shows them to
the person, and hands exactly those facts to the tool on a yes, so a model-written amount never reaches
the desk. The desk issues only while the proposal still equals what the person saw (`credit_changed`
otherwise; a host desk must refuse the same way). On a decline the role records it with
`withdraw_credit` (reason: declined); until then the proposal stays `pending`, and `resolve_case` refuses
(`credit_pending`) while any proposal on the case is pending, whatever the office board says. A case
gets one credit: the same line again is `duplicate_credit`.

**Who is asking** comes from the host's verified sender (`sender`), never from a tool argument or the
message. A colleague on the company record (an internal sender) may read any client's cases; a sender
whose address is a client's contact on the desk sees only that client's cases, and another client's
case reads as one that does not exist; anyone else gets no case data, only "log it and a person will
look". The same holds for `find_client` (a client finds only its own record) and for a credit put to
a person (`offer_credit` and its facts reader answer another client's proposal as one that does not
exist, and check again before issuing). `log_case` and `escalate_case` stay open to everyone, so an
unknown sender's complaint still reaches a person, but a client logs only on its own account and an
unknown sender's hand-off receipt and refusals say nothing about the case.

**Refunds** have no tool. The manifest's `mayNot` and the prompt hand money back to the person the
company record names for it (`policies.refunds.refundNeeds`) through `escalate_case` with reason
`refund`, and the receipt tells the role to promise no money.

**Re-cleans** are the company's standard remedy for work that fell short, so they need no approval:
the desk books one only for a `quality` or `missed_visit` complaint, on a date from today to the end of
the re-clean window (`policies.refunds.recleanWindowDays` business days from the complaint), once per
case.

**Escalation.** The desk picks the person from the company record by the reason: the escalation table
for safety, legal and data, the refunds policy for refunds, billing and complaints. A case is never
handed to anyone it names, whatever the reason: `about`, the note and the case's summary are all read
(by name, surname, first name, title or an alias such as "DW", as whole words), and the case goes to
the person who owns complaints, or to the head of the company if it names them. When only the note
names the person the reason normally goes to ("for the owner to decide"), the desk cannot tell an
address from a complaint, so it refuses with `note_names_owner` and asks for the person in `about`
if the complaint is about them, or for a note that addresses no one. A safety case is
escalated for safety before any other reason. A safety complaint's `log_case` receipt names
`escalate_case` as the next step, and the desk refuses to close a safety case that was never handed
on.

**Closing.** `resolve_case` needs an outcome, and the desk refuses a case with a credit proposal
pending, a re-clean booked and not done, a safety complaint not escalated, or a case already handed to
someone (it is theirs to close).

## Bind it to a real support system

The role ships no help desk or CRM connection. `fakeSupportDesk` is the demonstration one; a host binds
a `SupportDesk` (`src/desk.ts`): `findClient`, `listCases`, `listInvoices`, `listCredits`, `logCase`,
`bookReclean`, `proposeCredit`, `issueCredit`, `withdrawCredit`, `escalateCase` and `resolveCase`. Every write carries a `requestId` derived from the
durable call identity, so a retried call returns what it already did. The desk owns the pricing, the
credit, the window, who a case goes to and the refusals; a refusal is a `SupportDeskError` with a
`code` the tools turn into the next step.

```ts
import support from "@officehum/support";

const role = support({ desk, approve, sender, overlays: ["./my-support"] });
for (const extension of role.extensions) registry.install(extension);
const root = await harness.root(context, { agent: role.agent });
```

- **`desk`** — the support system. Omitted: the demonstration desk, on the company's own data.
- **`company`** — a host's own company facts, in the shape of `references/facts.json`.
- **`approve`** — decides the gated actions. Omitted: every credit is blocked.
- **`sender`** — who each call's work came from, as the host verified it. A sender comes from one of
  three places: the eval runner (the scenario's `from`), `officehum run --as PERSON`
  (the operator at the terminal, as an internal sender), or a board-backed host that passes
  `boardSenderResolver(board)` (today that is only the eval runner's office mode). Omitted: every
  sender is unknown, so no case data is given out.
- **`overlays`** — the business's own `AGENTS.md`, skills and `settings.json`, lowest first.

## The files

| Path | What it holds |
| --- | --- |
| `officehum.json` | The manifest: ten tools, one approval, dispatches, `mayNot`, skills, evals |
| `AGENTS.md`, `APPEND_SYSTEM.md` | The role's prompt |
| `role.md`, `role.sources.json` | The researched description of the job; `officehum verify-role agents/support --online` re-checks the sources |
| `src/index.ts` | The factory |
| `src/tools.ts` | The ten tools, and the receipts they return |
| `src/company.ts` | The company facts as the role reads them |
| `src/desk.ts` | The `SupportDesk` interface, `fakeSupportDesk` and the demonstration clients, invoices and cases |
| `src/*.test.ts` | The desk's rules, each tool, the approval gate on a real harness, the package and the scenarios |
| `skills/` | `handling-complaints`, `putting-things-right`, `escalating-cases`, and the generated `company-handbook` |
