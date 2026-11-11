# Agents

Each folder here is one Office Hum role, published free as `@officehum/<role>`.

Every role is a **portable Pi Durable agent**: an MIT package that installs into any Pi Durable 1.3.x
harness, with or without Office Hum. Office Hum composes, coordinates and configures roles; it never
modifies them, and a role never depends on it.

A role is mostly files Pi users already know:

```
AGENTS.md            the role: who it is, what it does, how it works, house style
APPEND_SYSTEM.md     rules appended to the end of the system prompt
skills/<name>/       Agent Skills format: SKILL.md plus optional reference files
officehum.json       tools (each safe or unsafe to rerun), approvals, connectors, accepts with completion evidence, skills, evals
src/index.ts         the tools, then defineRole(...)
evals/               scenarios with expected outcomes
```

Install one into your own Pi Durable harness:

```ts
import bookkeeper from "@officehum/bookkeeper";

const role = bookkeeper({ quickbooks, overlays: ["./my-bookkeeper"] });
for (const extension of role.extensions) registry.install(extension);
const root = await harness.root(context, { agent: role.agent });
```

Customize a role without changing it with an **overlay**: a directory with your own `AGENTS.md`
additions, `APPEND_SYSTEM.md`, skills and `settings.json` (model; skills and tools on or off).

## Two roles on your own harness

Inside Office Hum, roles hand work to each other with `agent_dispatch`, `agent_inbox` and
`agent_reply`. On your own harness, the SDK's **local board** gives them the same three tools:
tickets live in a document in your harness, and routing goes by ticket type, from each manifest's
`accepts`. Install one local board per role, then create one conversation per role, each with that
role's agent. A dispatched ticket is delivered into its assignee's conversation, once.

```ts
import { localBoardExtension } from "@officehum/sdk";
import bookkeeper from "@officehum/bookkeeper";
import frontdesk from "@officehum/frontdesk";

const roles = { frontdesk: frontdesk({ calendar }), bookkeeper: bookkeeper({ quickbooks }) };
// Each role's officehum.json, which ships in its package: the local board routes by their `accepts`.
const manifests = [frontdeskManifest, bookkeeperManifest];
const conversations = new Map<string, ConversationId>();

for (const [id, role] of Object.entries(roles)) {
  const board = localBoardExtension({
    manifests,
    role: id,
    conversationOf: (roleId) => conversations.get(roleId),
  });
  for (const extension of [...role.extensions, board]) registry.install(extension);
  const agent = { ...role.agent, extensions: [...role.agent.extensions, board] };
  const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
  conversations.set(id, conversation.id);
}
```

Front Desk can now `agent_dispatch` an `invoice.create` ticket. It lands in the Bookkeeper's
conversation, the Bookkeeper finishes it with `agent_reply`, and with `wait: true` Front Desk gets the
result back. The tools match Office Hum's names, parameters and answers, so a role behaves the same
either way. Office Hum adds what a local board does not have: budgets, hop limits, provenance,
routing to people, and approvals. One conversation per role means two roles that each wait on the
other deadlock, so wait in one direction only, or set `waitTimeoutMs`.

## The company every role works for

`company/default/` at the root of the repository is the business the catalogue's roles work for:
Northwind Facilities, a fictitious commercial cleaning and facilities company in Portland, Oregon.
`company.json` holds the record a program reads (people, services, price book in integer cents,
policies, escalation, glossary); `handbook.md`, `policies.md` and `pricing.md` are written for an agent
to read.

A published role has to be self-contained, so the facts reach each role as generated copies inside it:

```
skills/company-handbook/SKILL.md                    the handbook, and the entry point
skills/company-handbook/references/pricing.md       every price and minimum
skills/company-handbook/references/policies.md      the rules and who decides
skills/company-handbook/references/facts.json       the same facts, for the role's own code
```

`npm run sync-company` writes them for every role folder here; `scripts/sync-company.ts` refuses a
company package that disagrees with itself, and `scripts/company.test.ts` regenerates the whole
catalogue in memory and fails when a copy has drifted. One source, many readers — the same rule as the
JSON Schema. Do not edit a generated copy.

Rules, enforced by `@officehum/sdk` (`validatePackage`, `checkAgent`, `checkFourLayers`,
`resolveRoleFiles`):

- Pi Durable and pi-ai are peer dependencies (`1.3.x`); no dependency on `@officehum/office` or `@officehum/cli`.
- Every tool states `replay` explicitly and matches the manifest.
- Every **unsafe** tool states exactly one approval decision: an approval in `approvals`, or a
  `noApproval` note (at most 300 characters) saying why it needs none. Never both, never neither; a
  safe tool states neither. The rule holds whichever way the role was written.
- Every accepted ticket type declares `done` completion evidence, which the **host** runs, never the
  model: an engine check that returns findings, a declared **safe** tool whose result reports
  `found`, a file the result attaches, or `{ "person": true }`. All entries must pass.
  `{ticket.id}` and `{ticket.data.<path>}` are the only interpolation.
- Gated actions are blocked unless the host supplies an approver.
- Overlays can switch tools off but never add them; overlay skills hold instructions only.
- The four layers stay apart, checked by `checkFourLayers`: context under 1,000 words with a
  "You may not" section and no amounts, percentages or thresholds; references only in
  `skills/<id>/references/`; no `data/`, `work/` or `deliverables/` folder; no generic shell or file
  tool; and completion evidence on every accepted type. Strict (every issue an error) for a role
  under `agents/` and for generated roles; elsewhere context, knowledge and workflow issues are
  warnings and wisdom issues stay errors.
- The eval suite passes in a bare Pi Durable harness.

See [docs/design/agent-package.md](../docs/design/agent-package.md). For a minimal working role, see
[packages/sdk/fixtures/sample-desk](../packages/sdk/fixtures/sample-desk).

## Catalog

Every role below is built. `sales/` is the shape the rest of the catalog follows: a manifest, a system prompt, tools behind
a fake-backed seam, skills, evals and a README a stranger can follow. The roster keeps growing toward a free role for every
department of a company (RASF-3293). Tools and approvals are copied from each role's `officehum.json`, and
`scripts/catalog.test.ts` fails when this table drifts from the manifests.

| Folder | Package | Job | Tools | Asks a person before |
| --- | --- | --- | --- | --- |
| `frontdesk` | `@officehum/frontdesk` | Manages approved contacts, messages, and UTC appointments | `check_schedule`, `list_bookings`, `list_contacts`, `create_contact`, `update_contact`, `send_message`, `reply_message`, `book_appointment`, `reschedule_appointment`, `cancel_appointment` | `confirm_contact_creation` creating a contact; `confirm_contact_update` correcting a contact; `confirm_inbound_reply` replying to an inbound sender; `first_contact` messaging a destination for the first time; `confirm_booking` booking an appointment; `discount_booking` a discount above the business's set rate; `confirm_reschedule` rescheduling an appointment; `confirm_cancellation` cancelling an appointment |
| `bookkeeper` | `@officehum/bookkeeper` | The Accounting agent: invoices jobs, chases overdue invoices and answers billing questions; records supplier bills and pays them with approval | `find_customer`, `list_invoices`, `get_invoice`, `create_invoice`, `send_invoice`, `send_reminder`, `list_vendor_bills`, `record_vendor_bill`, `pay_vendor_bill`, `reconcile_summary` | `large_invoice` an invoice over the business's set amount; `new_recipient` sending an invoice to an address other than the one on file; `final_notice` a final notice to a customer; `any_payment` paying a supplier bill |
| `office-manager` | `@officehum/office-manager` | Reads a request and says what it is, where it belongs and what is missing; writes the daily digest | None | Nothing: it has no tools and acts only in words |
| `sales` | `@officehum/sales` | Qualifies leads, quotes from the price book, follows up and keeps the pipeline | `list_leads`, `get_quote`, `search_price_book`, `create_quote`, `request_quote_approval`, `log_activity`, `update_lead_stage`, `record_quote_outcome`, `schedule_follow_up`, `pipeline_report`, `read_company` | `quote_approval` a quote the desk held because it carries a discount or its total is above the quote limit |
| `operations` | `@officehum/operations` | Schedules and dispatches the field crews inside their weekly hours, and asks a person for overtime and contract changes | `list_jobs`, `list_crews`, `assign_crew`, `request_overtime`, `reschedule_job`, `request_contract_reschedule`, `record_callout`, `read_company` | `overtime` overtime for a crew and job; `contract_reschedule` moving a visit on a recurring contract |
| `purchasing` | `@officehum/purchasing` | Buys supplies from approved suppliers inside the spending limit; asks a person above it or for a new supplier | `list_stock`, `list_suppliers`, `compare_suppliers`, `list_purchase_orders`, `raise_purchase_order`, `request_po_approval`, `request_new_supplier`, `record_receipt`, `read_company` | `po_over_limit` a purchase order over the spending limit; `new_supplier` adding a supplier to the approved list |
| `marketing` | `@officehum/marketing` | Drafts posts and campaign emails from approved claims; a person approves each new claim and every publication | `read_services`, `draft_post`, `draft_campaign_email`, `request_claim_approval`, `publish`, `list_drafts`, `read_company` | `claim` using a new claim in a draft; `publish` publishing a draft |
| `support` | `@officehum/support` | Logs client complaints as cases, books re-cleans, proposes credits a person decides, and escalates safety and refunds | `find_client`, `list_cases`, `log_case`, `book_reclean`, `propose_credit`, `offer_credit`, `withdraw_credit`, `escalate_case`, `resolve_case`, `read_company` | `any_credit` issuing a proposed credit note to a client |
| `people-ops` | `@officehum/people-ops` | Keeps hiring and onboarding moving, records time off for a person to answer, and hands pay and discipline to a person | `list_candidates`, `update_candidate_stage`, `onboarding_checklist`, `record_time_off_request`, `request_time_off_exception`, `list_availability`, `get_leave_balance`, `refer_to_person`, `read_company` | `time_off_exception` time off with less notice than the company asks |
