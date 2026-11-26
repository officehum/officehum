# Office Hum agents

Free, open-source AI agents for the jobs in a business, each a portable
[Pi Durable](https://earendil.com/posts/pi-durable/) package you can install, run and test on its own.

A role is one job: the front desk, the bookkeeper, a dispatcher in operations. Each one is an npm
package with its instructions, skills, tools and an eval suite. It acts only through its declared
tools, asks a person before the actions its manifest gates, and states figures that come from code,
never from the model's arithmetic. Every guardrail is code or manifest data, not prompt text.

> Status: nothing is published to npm yet. Everything below runs from a clone of this repository.

## Try one

You need Node 22.19 or later and Git.

```sh
git clone https://github.com/officehum/officehum.git
cd officehum
npm ci
npm run build
npm rebuild @officehum/cli
npx officehum eval agents/frontdesk --model scripted   # grade the Front Desk: no model key needed
npx officehum run agents/sales --demo                  # talk to Sales (needs PAPERINSTRUMENTS_API_KEY)
```

The [quickstart](docs/quickstart.md) walks through it with the output you should see.

## The agents

| Role | Folder | What it does |
| --- | --- | --- |
| Front Desk | [`agents/frontdesk`](agents/frontdesk/README.md) | Contacts, messages and appointments |
| Bookkeeper | [`agents/bookkeeper`](agents/bookkeeper/README.md) | Invoices jobs, chases overdue invoices, answers billing questions, records and pays supplier bills |
| Office Manager | [`agents/office-manager`](agents/office-manager/README.md) | Says what a request is and where it belongs; writes the daily digest |
| Sales | [`agents/sales`](agents/sales/README.md) | Qualifies leads, quotes from the price book, keeps the pipeline |
| Operations | [`agents/operations`](agents/operations/README.md) | Schedules and dispatches field crews |
| Purchasing | [`agents/purchasing`](agents/purchasing/README.md) | Buys supplies from approved suppliers inside the spending limit |
| Inventory | [`agents/inventory`](agents/inventory/README.md) | Keeps the stock record by location |
| Marketing | [`agents/marketing`](agents/marketing/README.md) | Drafts posts and campaign emails from approved claims |
| Support | [`agents/support`](agents/support/README.md) | Logs complaints as cases, books re-cleans, proposes credits |
| People Ops | [`agents/people-ops`](agents/people-ops/README.md) | Hiring, onboarding and time off |
| Payroll | [`agents/payroll`](agents/payroll/README.md) | Prepares pay runs a person approves |
| Quality | [`agents/quality`](agents/quality/README.md) | Inspections and non-conformance reports |
| Safety | [`agents/safety`](agents/safety/README.md) | Training, incidents and reporting deadlines |
| IT Help Desk | [`agents/it-helpdesk`](agents/it-helpdesk/README.md) | IT tickets, password resets, the asset register |
| Finance Analyst | [`agents/finance-analyst`](agents/finance-analyst/README.md) | Budget against actuals, margins, cash forecast, the management report |

Every role ships the same fictitious company, Northwind Facilities (`company/default/`), so a demo
and every eval run out of the box. The [catalogue](agents/README.md) lists every tool and every action
each role asks a person about.

## Guardrails

An agent's instructions tell it what to do. Its guardrails are what hold even when the model ignores
an instruction: they are code and manifest data, not prompt text. They are the approvals a person
must give before a gated action runs, the limits an action is checked against, and the refusals of
decisions that belong to a person (who is hired, a deal reopened, an order over the spending limit).
They apply whatever system is connected: a role checks them itself, so a backend that accepts
anything still cannot get round them. The [catalogue](agents/README.md) lists what each role asks a
person about, and [agent-package.md](docs/design/agent-package.md) describes how they work.

## Run and test one

- **Grade it.** `officehum eval agents/<role> --model scripted` runs the role's suite on a fresh Pi
  Durable harness with every tool stubbed and the model's turns played back, so it costs nothing and
  needs no key. It is also the portability check: a role that needs anything beyond Pi Durable and its
  own package fails here. Drop `--model scripted` to run the same suite on a real model.
- **Talk to it.** `officehum run agents/<role>` opens the role in your terminal on one SQLite file;
  gated actions wait for your `y` or `n`, and unfinished work resumes after a restart.
- **Use it in your own harness.** A role is an npm package with Pi Durable as a peer dependency:
  install its extensions and give a conversation its agent
  ([how](docs/build-a-role.md#use-a-role-in-your-own-harness)).
- **Write your own.** [Build a role](docs/build-a-role.md) covers the package, overlays, evals and the
  Role Factory, which generates a role from one reviewable spec.

## Packages

| Package | What it is |
| --- | --- |
| [`@officehum/sdk`](packages/sdk/README.md) | The role package contract: manifest, `defineRole`, the approval gate, overlays, engines, evals |
| [`@officehum/runner`](packages/runner/README.md) | Runs one role on a Pi Durable harness: role loading, one-role runs, the eval runner, the scripted model |
| [`@officehum/cli`](packages/cli/README.md) | `officehum`: `run`, `eval`, `judge-check`, `verify-role` and `review` |
| [`@officehum/memory`](packages/memory/README.md) | Portable memory: what an agent learns on the job, with its guardrails in code |
| [`@officehum/role-factory`](packages/role-factory/README.md) | `ROLE_SPEC.md` and `officehum-role`, which interviews a person and generates a role |
| [`@officehum/provider-paper`](packages/provider-paper/README.md) | The Paper Instruments model provider for pi-ai |
| [`@officehum/tools-paper-office`](packages/tools-paper-office/README.md) | A bounded Word, PowerPoint and Excel workspace |
| [`@officehum/tools-documents`](packages/tools-documents/README.md) | Read PDF, Word, Excel, CSV and email into text and tables with references |
| [`@officehum/tools-docgen`](packages/tools-docgen/README.md) | Generate branded PDF, Word and Excel from templates |
| [`@officehum/tools-data`](packages/tools-data/README.md) | Questions over spreadsheets and exports, answered exactly by DuckDB |
| [`@officehum/tools-esign`](packages/tools-esign/README.md) | Send for signature behind an approval that always asks |
| [`@officehum/google-calendar`](packages/google-calendar/README.md) | A portable Google Calendar client and fake |
| [`@officehum/quickbooks`](packages/quickbooks/README.md) | A portable QuickBooks Online client and fake |

## Repository layout

| Path | What it holds |
| --- | --- |
| `agents/` | The fifteen roles, one package each |
| `company/` | Northwind Facilities, the sample company every role ships with |
| `docs/` | The [quickstart](docs/quickstart.md), [build a role](docs/build-a-role.md), [architecture](docs/architecture.md), [reference](docs/reference.md), [releasing](docs/releasing.md) and [design notes](docs/design/) |
| `packages/` | The SDK, the runner, the CLI, memory, the role factory, the model provider, tool packs and app clients |
| `scripts/` | Repository checks: the company sync, the catalogue, licences, the publish check, docs links and the public boundary |

## Contributing and licence

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md); report security
problems as [SECURITY.md](SECURITY.md) says. MIT licensed ([LICENSE](LICENSE)); the licences of the
dependencies are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The passages quoted in each
role's `role.sources.json` belong to their publishers and are not covered by the MIT licence.
