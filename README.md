# Office Hum agents

Free, open-source AI agents for the jobs in a business: fifteen roles, each a portable
[Pi Durable](https://earendil.com/posts/pi-durable/) package you can install, run and grade on its
own.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/agents-board-dark.svg">
  <img alt="The fifteen agents by department. Customers: Front Desk, Sales, Support, Marketing. Operations: Operations, Purchasing, Inventory, Quality, Safety. Finance: Bookkeeper, Payroll, Finance Analyst. People and IT: People Ops, IT Help Desk. Coordination: Office Manager." src="docs/assets/agents-board-light.svg" width="600">
</picture>

> Status: nothing is published to npm yet. Everything below runs from a clone of this repository.

## What an agent is

An agent is one job, such as the front desk, the bookkeeper or the dispatcher in operations. Each one
is an npm package that holds four things:

- the **instructions** the model reads;
- the **skills** it reads when a job needs them;
- the **tools**, which are the only way it can act;
- an **eval suite** that grades it.

Its **guardrails** (the approvals, limits and refusals) are code and manifest data, not prompt text.
Any figure it states comes from a tool, never from the model's arithmetic.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/agent-anatomy-dark.svg">
  <img alt="Anatomy of an agent: one npm package holding instructions (AGENTS.md, APPEND_SYSTEM.md) and skills (prompt text), tools (src/index.ts) and guardrails (officehum.json and tool code), and an eval suite (evals/*.json), running on a Pi Durable harness with any model." src="docs/assets/agent-anatomy-light.svg" width="560">
</picture>

Here is one agent on its own, handling one request. A message asks the Bookkeeper to pay a bill, and
the forwarded email claims the payment is already approved. The agent reads the bill with a tool and
asks to pay it. The approval guardrail then holds the payment for a person, whatever the email says.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/request-flow-dark.svg">
  <img alt="A request, start to finish: a message asks the Bookkeeper to pay a bill and the email claims it is already approved; the agent reads the bill with list_vendor_bills; it calls pay_vendor_bill; the guardrail holds the payment for a person, and the email's claim changes nothing; a person says yes or no; the reply reports the payment from the receipt, or that it was not paid." src="docs/assets/request-flow-light.svg" width="560">
</picture>

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

`eval --model scripted` runs the role's whole suite with every tool stubbed and the model's turns
played back, so it costs nothing and needs no key. `run` opens the role in your terminal. A gated
action waits for your `y` or `n`, and unfinished work resumes after a restart. The
[quickstart](docs/quickstart.md) walks through both, with the output you should see.

## The agents

Every role ships the same fictitious company, Northwind Facilities (`company/default/`), so a demo and
every eval run out of the box. The [catalogue](agents/README.md#catalog) lists every tool and every
approval.

### Customers

| Role | What it does | Asks a person before |
| --- | --- | --- |
| [Front Desk](agents/frontdesk/README.md) | Contacts, messages and appointments | A new or corrected contact, a reply or first message, a booking, a discount, a change or a cancellation |
| [Sales](agents/sales/README.md) | Qualifies leads, quotes from the price book, keeps the pipeline | A quote with a discount or above the quote limit |
| [Support](agents/support/README.md) | Logs complaints as cases, books re-cleans, proposes credits | Issuing a credit note |
| [Marketing](agents/marketing/README.md) | Drafts posts and campaign emails from approved claims | Using a new claim, and every publication |

### Operations

| Role | What it does | Asks a person before |
| --- | --- | --- |
| [Operations](agents/operations/README.md) | Schedules and dispatches the field crews | Overtime, and moving a visit on a recurring contract |
| [Purchasing](agents/purchasing/README.md) | Buys supplies from approved suppliers inside the spending limit | An order over the limit, and a new supplier |
| [Inventory](agents/inventory/README.md) | Keeps the stock record by location | A large adjustment, and any write-off |
| [Quality](agents/quality/README.md) | Inspections and non-conformance reports | Closing a report |
| [Safety](agents/safety/README.md) | Training, incidents and reporting deadlines | A training exception, a recordable incident, a regulator report |

### Finance

| Role | What it does | Asks a person before |
| --- | --- | --- |
| [Bookkeeper](agents/bookkeeper/README.md) | Invoices jobs, chases overdue invoices, records and pays supplier bills | A large invoice, a new recipient, a final notice, and every payment |
| [Payroll](agents/payroll/README.md) | Prepares pay runs and records benefit changes | Submitting a pay run, a benefit change outside enrolment, a pay correction |
| [Finance Analyst](agents/finance-analyst/README.md) | Budget against actuals, margins, the cash forecast, the management report | Releasing a report, and revising a forecast |

### People and IT

| Role | What it does | Asks a person before |
| --- | --- | --- |
| [People Ops](agents/people-ops/README.md) | Hiring, onboarding and time off | Time off at short notice; who is hired is always a person's decision |
| [IT Help Desk](agents/it-helpdesk/README.md) | IT tickets, a sender's own password reset, the asset register | A sign-in change, access to a group, a new or closed account |

### Coordination

| Role | What it does | Asks a person before |
| --- | --- | --- |
| [Office Manager](agents/office-manager/README.md) | Says what a request is and where it belongs; writes the daily digest | Nothing: it has no tools and acts only in words |

## Guardrails

An agent's instructions tell it what to do, and a model can get them wrong. Its guardrails hold even
then, because they are code and manifest data rather than prompt text. There are three kinds:

- an **approval** a person must give before a gated action runs;
- a **limit** an action is checked against;
- a **refusal** of a decision that belongs to a person, such as who is hired, a deal reopened, or an
  order over the spending limit.

The role checks them in its own code before it calls whatever system is connected. So a backend that
accepts anything still cannot get round them.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/guardrails-dark.svg">
  <img alt="Instructions are prompt text the model reads, and a model can get them wrong. Guardrails are code and manifest data, checked before any call: a payment waits for a person, an order over the limit is saved as a draft, a move to hired is refused. The model asks for a tool call, the role's code checks the guardrail, and only then is your system called; otherwise the call is refused or held for a person." src="docs/assets/guardrails-light.svg" width="560">
</picture>

[agent-package.md](docs/design/agent-package.md) describes how they work, and the
[catalogue](agents/README.md#catalog) lists each role's approvals.

## Run it on your own model

The roles default to Paper's hosted `ultramarine-1-flash`, which reads `PAPERINSTRUMENTS_API_KEY`;
`--model openai/<model id>` uses OpenAI. To keep everything on your machine, serve a model behind an
OpenAI-compatible endpoint (llama.cpp's `llama-server`, vLLM or Ollama) and pass `--model local/<id>`.
That needs no hosted key:

```sh
export OFFICEHUM_LOCAL_BASE_URL=http://localhost:8080/v1
npx officehum eval agents/bookkeeper --model local/<model name> --report bookkeeper-local.json
```

The first two models we ran, one trial per scenario
([details](docs/local-models.md#models-we-have-tested)):

| Model | Front Desk | Sales | Bookkeeper | Critical misses |
| --- | --- | --- | --- | --- |
| Qwen 3.8 27B, NVFP4, on Ollama | 11 of 11 | 17 of 19 | 18 of 21 | 4 |
| Qwen 3.5 9B, Q4_K_M, on Ollama | 6 of 11 | 11 of 19 | 17 of 21 | 12 |

The larger model came close to the default hosted model. The smaller one wrote replies that cannot be
relied on, and once tried to pay a bill because a supplier's email told it to. The approval guardrail
stopped that payment and asked a person. [Local models](docs/local-models.md) covers the server
settings and how to read a result.

## Build or change a role

- **Change one without editing it.** An overlay is a directory with your own `AGENTS.md` additions,
  `APPEND_SYSTEM.md`, skills and `settings.json`. It can switch tools off, but never adds one
  ([overlays](docs/build-a-role.md#overlays-changing-a-role-without-editing-it)).
- **Generate one.** The [Role Factory](packages/role-factory/README.md) interviews a person, writes
  one reviewable spec (`ROLE_SPEC.md`), and generates the role package from it.
- **Write one by hand.** [Build a role](docs/build-a-role.md) covers the package, the manifest, evals
  and the checks.
- **Use one in your own harness.** A role is an npm package with Pi Durable as a peer dependency:
  install its extensions and give a conversation its agent
  ([how](docs/build-a-role.md#use-a-role-in-your-own-harness)).

The office that runs these agents together, with a shared work board, approvals and budgets, is a
separate hosted product at [officehum.com](https://officehum.com).

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
| `docs/` | The [quickstart](docs/quickstart.md), [build a role](docs/build-a-role.md), [local models](docs/local-models.md), [architecture](docs/architecture.md), [reference](docs/reference.md), [releasing](docs/releasing.md), [design notes](docs/design/) and the README's diagrams (`docs/assets/`) |
| `packages/` | The SDK, the runner, the CLI, memory, the role factory, the model provider, tool packs and app clients |
| `scripts/` | Repository checks: the company sync, the catalogue, licences, the publish check, docs links and the public boundary |

## Contributing and licence

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md); report security
problems as [SECURITY.md](SECURITY.md) says. MIT licensed ([LICENSE](LICENSE)); the licences of the
dependencies are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The passages quoted in each
role's `role.sources.json` belong to their publishers and are not covered by the MIT licence.
