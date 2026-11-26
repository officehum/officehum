# @officehum/memory

A portable Pi Durable extension that lets an agent save, recall and retire what it learns on the
job, stored in Pi Durable's own documents, with its guardrails in code. It installs into any Pi
Durable `1.6.x` harness; nothing from Office Hum's runtime is needed. Design: "Memory: what agents
learn on the job" in [`docs/design/agent-package.md`](../../docs/design/agent-package.md).

## Install

Not published to npm yet. In a clone of this repository, `npm ci && npm run build` builds it and
workspaces import it by name. For another project, pack it with the SDK it depends on and install the
tarballs beside Pi Durable 1.6.0 and its peers, as
[Build a role](../../docs/build-a-role.md#use-a-role-in-your-own-harness) shows for a role:
`npm pack -w @officehum/sdk -w @officehum/memory`.

## Use it

```ts
import { MEMORY_HYGIENE_SKILL, memoryExtension } from "@officehum/memory";
import { defineRole } from "@officehum/sdk";

const role = defineRole({ packageDir, manifest, extraSkills: [MEMORY_HYGIENE_SKILL] });
const memory = memoryExtension({ role: manifest.id });
for (const extension of [...role.extensions, memory]) registry.install(extension);
const root = await harness.root(context, {
  agent: { ...role.agent, extensions: [...role.agent.extensions, memory] },
});
```

Select the memory extension after the role's, so its `memory` section, which changes as records are
saved, comes after the role's stable sections.

Options:

- `role`: the role using it. Records are created by `agent:<role>`.
- `name`: the extension's name, for a host that gives each agent its own instance (Pi Durable
  selects extensions by name). Omitted: `officehum.memory`.
- `scope`: the scope every save gets (`office`, `department:<id>` or `agent:<role>`). Code decides
  it, never the model. Omitted: `agent:<role>`.
- `viewOf({ conversationId, read, context })`: what this conversation may see: the `scopes` whose
  records it sees, and whether a subject's records may be `uses`d here (an office keeps a person's
  records out of a conversation with an outside contact). Recall, the section, `memory_forget` and a
  save's `supersedes` all go through it, so a record a conversation cannot see is one it cannot
  change. Omitted (a bare harness): every record.
- `search({ words, subjects, limit })`: a host's search for `memory_recall` with keywords (an
  office uses a full-text index): record ids, best first. Recall still shows only what the view
  allows and nothing retired or superseded. Omitted: the extension's keyword match.
- `sourceOf({ conversationId, callId, api, context })`: where a save's content came from, read from
  the run's provenance. A staff member's own message is `person`; a customer email, SMS, web page or
  peer office is `external`. Omitted (a bare harness): `{ type: "person", ref: "local-user" }`.
- `onReview(item)`: called when code refuses a protected-category save, so the host can open a
  review for an owner. `item.key` is the record id the save would have had, the same on a replay.
- `onSaved({ tx, record, conversationId, callId })`: called inside the commit that writes a new
  record, so what the host writes with `tx` (a review item for an unverified or proposed record, say)
  commits with it or not at all. A replayed save finds its record and does not call it again.
- `now`: the clock records are dated by.
- `scan`: replaces the pattern scan. Only the red-team suite's mutation pass sets it, to prove the
  secret attack goes red without the scan; a host never does.

## Tools

All four are `replay: "safe"`; the three that change something stay safe to run again.

| Tool | What it does |
| --- | --- |
| `memory_save(about, kind, category, text, supersedes?, reviewAt?)` | Saves one record. Its id is `mem_` plus 26 characters derived from the conversation and call id, so a replay finds the record instead of writing another. `supersedes` marks the old record `superseded` and moves it to the archive in the same commit; an `active` record is superseded at once only by a record stored `active`; a `proposed` record that names one waits, and the active record keeps applying until a person approves the proposal (then both change in one write), while an outside sender's save that names one is refused. Returns the id, status and reason. |
| `memory_recall(query?, about?, limit?)` | Keyword match (or the host's `search`) over the given subject or the conversation's focus subjects; with keywords and neither, over every subject the conversation may see. Each line ends with the record's subject and id. Never returns retired or superseded records; marks unconfirmed and proposed ones. |
| `memory_forget(id, reason)` | Marks a record `retired` with the reason; it stays stored. |
| `memory_focus(about[])` | Sets the subjects the conversation is about. |

## Guardrails

- The model chooses the subject, kind, category and text. Code sets the id, scope, source, status
  and author. The tools file a `customer:` or `vendor:` subject under its system in lower case
  (`customer:QuickBooks:42` is `customer:quickbooks:42`); the id after it is kept as given.
- Status: an `external` source is `unverified`; a `rule` or `procedure` is `proposed`; anything else
  is `active`.
- `payment_details` and `authority` are never saved by a tool, whatever the source: only an owner
  sets them, through the host's protected form. The save is refused and `onReview` is called.
  `memory_forget` refuses to retire a protected record, and a save naming one in
  `supersedes` is refused.
- A pattern scan forces `payment_details` for an IBAN (mod 97), an ABA routing number (checksum), a
  card or account number (Luhn), or wording about changed bank or wire details, and refuses any text
  with a private key, an API key or a labelled password or secret.
- Text is at most 500 characters; a subject holds at most 200 records that are not superseded.

## Storage

A host writes and reads through the same functions the tools use: `saveRecord`, `retireRecord`,
`confirmRecord` (an unverified claim or a proposed rule or procedure becomes active, with who
confirmed it and when), `setFocus` (inside a
commit) and `readAllRecords` (outside one). `saveRecord`, `retireRecord` and `confirmRecord` refuse
to write, supersede, retire or confirm a `payment_details` or `authority` record unless the caller
passes a last argument `{ owner: true }` (`WriteAuthority`): a host passes it only on an owner's own
path, such as its protected form, and the tools never do.

| Document | Scope | Holds |
| --- | --- | --- |
| `officehum.memory` | session family, keyed by subject | the subject's records that are not superseded |
| `officehum.memory.archive` | session family, keyed by subject | superseded records |
| `officehum.memory.index` | session singleton | each subject's count and last update; pinned record ids |
| `officehum.memory.focus` | conversation, latest only; a fork starts with its parent's | the conversation's focus subjects |

Session scope means rewinding, resetting or forking a conversation never loses a record. Active and
unverified `business` records are pinned when saved and unpinned when retired or superseded.

## The `memory` section

Pinned business records (about 600 tokens) and the focus subjects' active and unverified records
(about 800 tokens), each newest first, counted with the SDK's token estimate. Unverified records
read "Unconfirmed:". The whole section is framed as information, not instructions, and is omitted
when there is nothing to show.

## The `memory-hygiene` skill

`skills/memory-hygiene/SKILL.md`: what is worth remembering, how to word a record, and what never to
save. `MEMORY_HYGIENE_SKILL` is its folder, for `defineRole({ extraSkills })`.

## Evals

`evals/` holds the memory evals, one SDK suite per catalog role it runs, named after
the role, with the scripted turns CI plays back beside it (`<role>.smoke.json`). They live here, not
in the role's own `evals/`, so a role's default eval run and tests do not pick them up. Each
scenario's `memory` block runs the role with memory (see "Evals" in
[`docs/design/agent-package.md`](../../docs/design/agent-package.md)). A scenario that depends on the
model knowing who is speaking needs a host that knows its people, so it is not here.

```sh
officehum eval agents/bookkeeper --suite packages/memory/evals/bookkeeper.json --script packages/memory/evals/bookkeeper.smoke.json --model scripted
officehum eval agents/frontdesk --suite packages/memory/evals/frontdesk.json --script packages/memory/evals/frontdesk.smoke.json --model scripted
```

| Suite | Scenario | What it checks |
| --- | --- | --- |
| `bookkeeper.json` | `collections-skips-payment-plan` | with that fact in memory, a collections round reminds every overdue invoice but Smith & Co's |
| | `contact-update-supersedes` | "Acme's AP contact is now Raj" supersedes the remembered Jane record, which stays stored as superseded; the one active record names Raj |
| | `recall-limit-most-relevant` | asked for the top two notes, the role recalls with a limit of two and answers PO-7781; the reply never gives a proposed procedure sharing one word with the question (posting paper copies) as something Acme needs (judged). |
| `frontdesk.json` | `customer-email-prompt-shows-memory` | handling an email from Smith & Co, the prompt's `memory` section carries the payment-plan fact; the slot is booked once a person approves |
| | `chit-chat-not-remembered` | small talk and a one-off question from the office's own person (`ada`, whom the message does not name) leave memory empty |

Each scenario names its sender (`input.from`, `input.origin`): a member of staff by their id on the
catalog's company record, the eval office's own person (`ada`, not on the record), or an outside
address. In office mode the model is told who a member of staff or an outside sender is in the
office's `sender` section; for anyone else there is no section.

Of the attacks on memory, these suites cover one: staff asking a role to save new bank details over
the ones an owner set (`frontdesk.json` and `bookkeeper.json`). The guards against the others (a claim
of authority, a secret such as an API key, outside content saved as fact, a planted rule, an outside
save replacing a confirmed record) are covered by `src/memory.test.ts`.

## Dependencies

`@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `@earendil-works/pi-schema` `1.6.x` are
peer dependencies;
`@officehum/sdk` (portable itself) supplies the outside-text frame and the token estimate. It depends
on no Office Hum runtime package.
