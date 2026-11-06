# The default standard company, and the agent catalogue — build spec

2026-10-31. Decisions: six new roles on one shared company package, published open source on npm.

## Why a company at all

An agent with no facts about its employer can only produce plausible words. Every role in the catalogue works for the
same fictitious business, so every agent can quote the same price book, follow the same refund policy, use the same tone
and escalate to the same people. A stranger downloading one agent gets something that behaves in a real context on the
first run, and can replace the facts with their own.

**Northwind Facilities Ltd.** — a 24-person commercial cleaning and facilities company in Portland, Oregon. Recurring
contracts, one-off deep cleans, a small maintenance crew, six suppliers, a price book, a refund policy, a tone of voice.
Fictitious, but internally consistent: the numbers add up, the policies have edges, and the escalation path names real
people.

## One source, generated copies

```
company/default/
  company.json          profile, contacts, people, services, price book, policies, tone, escalation, glossary
  handbook.md           the long-form reference: how the company works, written for an agent to read
  policies.md           refunds, discounts, safety, data handling
  pricing.md            what things cost and what may be quoted freely
```

Agents read skills from their own directory, and a published agent has to be self-contained — so the company facts reach
each role as a **generated** skill:

```
agents/<role>/skills/company-handbook/SKILL.md   generated from company/default/, never hand-edited
```

`npm run sync-company` writes those copies; a drift test regenerates in memory and compares bytes. One writer, many
readers, the same rule as the JSON Schema.

## The six roles

Each is a Pi Durable agent: a manifest, a system prompt, tools with fakes, skills, evals, a README. Each must be
**functional on Pi Durable** — it runs through the real harness.

| role | does | must ask a person before | tools (fake-backed) |
| --- | --- | --- | --- |
| Sales / Account Manager | qualify leads, quote from the price book, follow up, keep the pipeline | any discount, any non-standard term | `search_price_book`, `create_quote`, `log_activity`, `list_leads`, `read_company` |
| Customer Support | answer service questions, take complaints, book a re-clean | any refund or credit, any goodwill gesture | `lookup_customer`, `create_ticket`, `schedule_reclean`, `read_company` |
| People Ops | hiring pipeline, onboarding checklist, availability, time off | anything about pay, discipline, termination | `list_candidates`, `advance_candidate`, `record_time_off`, `read_policy` |
| Operations / Project Coordinator | schedule jobs, assign crews, handle call-outs | overtime, subcontracting, rescheduling a contract | `list_jobs`, `assign_crew`, `reschedule_job`, `flag_shortfall` |
| Purchasing | restock supplies, compare suppliers, raise purchase orders | any order over the limit, any new supplier | `search_supplies`, `compare_suppliers`, `raise_purchase_order`, `read_price_book` |
| Marketing | draft posts and campaign emails from the service catalogue | anything published, any claim about results | `draft_post`, `draft_email`, `read_company`, `publish` (gated) |

Every role also gets `read_skill`, and none of them gets a tool that decides an approval — the enforcement is by
absence, as everywhere else in this repository.

## What "functional on Pi Durable" means for each agent

Three checks, in this order, all recorded in the PR:

1. `officehum eval agents/<role> --model scripted` — the eval suite passes, on the office-mode runner where it makes
   sense. Deterministic, runs in CI.
2. `officehum run agents/<role> --model paper/ultramarine-1-flash` with one realistic message — the agent answers and
   uses its tools through the real harness. Needs a key; run it when one is available and put the transcript in the PR.
3. `npm run check` — the whole repository stays green.

An agent that only typechecks is not built. An agent that only passes scripted evals is not published.

## Order of work

1. The company package and the sync script, with the drift test.
2. **Sales / Account Manager** as the template — built end to end, verified all three ways, and reviewed before it is
   copied.
3. The other five, each following the template. They can be built in parallel once the template is merged, but each one
   needs its own live run before it is offered.

## What a stranger must be able to do

```bash
npm install -g officehum            # or npx officehum
officehum run ./sales-account-manager     # it starts, with the company facts, and can quote a job
officehum eval ./sales-account-manager --model scripted
```

If that does not work from a clean machine with no repository checkout, the agent is not published yet.

## Out of scope for this exercise

Hosting, the tenant product, web chat, memory. The deliverable is a set of agents someone can download today and a
company they can substitute for their own.