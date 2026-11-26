# Reference

Every command of `officehum`, the command line for one role package, as the code runs it today. New
here? Start with the [quickstart](quickstart.md); for how the pieces fit, read
[architecture](architecture.md).

Nothing is published to npm yet, so `officehum` below is this repository's CLI, built from a clone:
after `npm ci` and `npm run build`, either run `node packages/cli/dist/index.js`, or run
`npm rebuild @officehum/cli` once so that `npx officehum` works from the repository root (a fresh
`npm ci` cannot link the command before the build has written it).

## Run one role package

`officehum run ROLE_DIR` runs a single role package on its own: it loads the package from its
directory, opens a Pi Durable harness on one SQLite file, prints anything a previous run left unfinished, and
then reads lines from the terminal. Each line becomes one durable submission; a line typed again,
in this session or a later one, runs again. Gated actions print their description and arguments and wait for a `y`/`n` answer;
anything other than `y`/`yes` declines, and the decision is recorded with the OS user as `by`. An
approval that asks for a value then asks for the amount, in dollars and cents within the bounds
shown; a typo or an amount out of bounds is asked again, and an empty answer declines.

`officehum` is `@officehum/cli`, as the top of this page describes. A live model key must be in the
environment
(`PAPERINSTRUMENTS_API_KEY` for Paper, `OPENAI_API_KEY` for OpenAI). `--model local/<id>` runs a model
on your own machine behind an OpenAI-compatible endpoint instead, and needs no hosted key:
`OFFICEHUM_LOCAL_BASE_URL` names the endpoint (for example `http://localhost:8080/v1`),
`OFFICEHUM_LOCAL_API_KEY` is sent only if your server was started with a key, and
`OFFICEHUM_LOCAL_CONTEXT_WINDOW` is the context the server was started with (default 32768). See
[Local models](local-models.md).

The Front Desk ships no calendar of its own, so give it one through `--clients` (the file format is
described below); without it the role starts, and every calendar tool fails when it is called. Save
these two files in the repository root:

```json
{ "calendar": { "module": "./calendar.mjs" } }
```

```js
// calendar.mjs: a stand-in that offers two slots a day and stores nothing.
// agents/frontdesk/README.md documents the Calendar interface a real one implements.
export default function createCalendar() {
  return {
    freeSlots: async (date) => [`${date}T09:00:00Z`, `${date}T10:00:00Z`],
    listBookings: async () => [],
    book: async (start, customer, idempotencyKey) => ({ id: "b1", start, customer }),
    reschedule: async (id, start, idempotencyKey) => ({ id, start, customer: "Demo Guest" }),
    cancel: async (id, idempotencyKey) => ({ id, status: "canceled", alreadyCanceled: false }),
  };
}
```

```sh
npx officehum run agents/frontdesk \
  --model paper/ultramarine-1-flash \
  --clients ./clients.json \
  --db .officehum/frontdesk.sqlite
```

A role that keeps its records behind a desk needs no client file to try: `npx officehum run
agents/sales --demo` runs on its demonstration records (see "The desk" below).

Flags:

| Flag | Meaning |
| --- | --- |
| `--overlay DIR` | An overlay directory, lowest first; repeatable |
| `--db FILE` | The SQLite file the run keeps (default `./.officehum/<role-id>.sqlite`) |
| `--data DIR` | The engine's `OFFICEHUM_DATA_DIR` |
| `--work DIR` | The engine's `OFFICEHUM_WORK_DIR` |
| `--model provider/model` | The model to run; default is the manifest's `defaultModel` |
| `--clients FILE` | A JSON file naming the role's app clients |
| `--as PERSON` | Who the operator at the terminal is: a person id or email on the role's company record |
| `--demo` | Run the role on its demonstration data when no desk is bound (takes no value) |

**Who is asking.** The terminal is the operator's own machine, so the operator says who they are with
`--as`. It must name a person on the company record generated into the role package
(`skills/company-handbook/references/facts.json`, matched by id or email), or the command refuses
before any role code runs and lists the ids it accepts. The role then gets that person as an internal
`VerifiedSender` from the `terminal` channel, so People Ops can record their time off, Purchasing can
place an order they asked for and Support can show them case data. With no `--as` the sender is
unknown, the startup banner says so, and anything a role gives only to a known sender is refused.

**The desk.** A role that keeps its records behind a desk (Bookkeeper's payables, Finance
Analysis, Inventory, IT Help Desk, Marketing, Operations, Payroll, People Ops, Purchasing, Quality,
Safety, Sales, Support) builds its demonstration desk only when asked.
`--demo` asks: the role runs on the demonstration records it ships with, which live in memory and
write nowhere, and the banner says `Desk: demonstration data (--demo)`. A `desk` client in `--clients`
binds the business's own system instead. With neither, the role still starts, the banner says
`Desk: none bound (a role that keeps records refuses until you pass --demo or a desk in --clients)`, and every tool that reads or writes the desk
refuses and says how to bind one, so a forgotten connection never shows made-up records. Hosts pass
the same choice to `loadRole` as its reserved `demo` option; the eval runner always sets it.

**The date.** `officehum run` passes the role no clock, so a role on its demonstration desk works on
that desk's fixed demo date (`DEMO_NOW`) and its prompt has no `today` section.

At the prompt, `/commands` lists the manifest's operator views, `/NAME` runs one (an engine view with
no model involved), `/reload` re-reads the overlays and re-applies the role's settings except the model (a saved
conversation keeps the provider and model it started with; an overlay's model applies to new
conversations only), and `/help`,
`/quit` and end of input are available too.

Role loading refuses three things with every problem named at once: an invalid package, a Pi Durable
peer range that excludes the version Office Hum runs (`validatePackage` plus an exact-range check), and
a missing runtime program (`checkRuntimes`). The factory's bundle is then checked against the manifest
(`checkAgent`) before anything runs.

Role packages are portable, so a package ships compiled JavaScript. The SDK's fixture roles under
`packages/sdk/fixtures/` are TypeScript sources used by tests; they load under the test runner, not the
built CLI. Run them from a test, or build the SDK package you want to run from the terminal.

The `--clients` file maps a client name to the module that exports its factory; the factory is called
with no arguments and reads its own configuration from the environment, so the file can never hold a
credential. Only `module` and an optional `export` are allowed per entry, and anything else is refused:

```json
{
  "calendar": { "module": "./clients/calendar.mjs" },
  "quickbooks": { "module": "@officehum/quickbooks", "export": "quickbooksClient" }
}
```

## Eval a role package

`officehum eval ROLE_DIR` runs a role's eval suites and prints the SDK's report, exiting non-zero
when a suite fails. It is the release gate and the portability check: the runner installs only the
role's own extensions on a fresh in-memory Pi Durable harness, so a role that needs more than Pi Durable
fails here. Every tool the manifest declares is stubbed — with its real name, description and parameters,
so the model is offered the tools a live run would offer while no real system is touched — `read_skill`
runs for real, and an approval a scenario does not script stops the trial rather than being guessed.

```sh
officehum eval agents/frontdesk --model scripted
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--model provider/model` | The model to run; `scripted` reads a script file so CI needs no key; default is the manifest's `defaultModel` |
| `--tag TAG` | Run only the scenarios tagged `TAG` |
| `--scenario ID` | Run only the scenario with this id; repeat it to run several. An unknown id is an error that lists the suite's ids and runs nothing. The report then covers only those scenarios, applies the pass threshold to them alone, prints a `Selected scenarios only` line and carries a `selected` list in the `--report` JSON, so a partial run never reads as a pass of the suite |
| `--trials N` | Trials per scenario, overriding each scenario's own `trials` |
| `--pack ID` | Give the role a tool pack its host would supply (today `data`), repeatable: the tools its manifest declares with `"pack"` are offered, stubbed like every declared tool, so the pack's engine never loads. A suite that declares `"packs": ["data"]` runs only with it; without it the run skips that suite and says so |
| `--normal-trials N` | Trials per normal scenario instead, so critical scenarios keep `--trials` while normal ones run fewer; each scenario's line in the report says how many it ran |
| `--retries N` | How many times a trial the model provider failed is run again, on the same provider and model; default 2, `0` turns retrying off |
| `--max-output-tokens N` | The most output tokens, reasoning included, any model request of the run asks for, the judge's included; default 8192. A trial whose reply hits it is errored, not graded |
| `--script FILE` | The script file `--model scripted` plays back; default is the role's own `evals.smoke.json` |
| `--suite FILE` | Run this one suite file against the role instead of the role's own `evals/`, checked against its manifest; how the memory evals in `packages/memory/evals/` run (`officehum eval agents/bookkeeper --suite packages/memory/evals/bookkeeper.json`) |
| `--report FILE` | Write the SDK's full report as JSON, with every trial's tool calls and arguments, approvals and reply; a failing trial also prints one line with its calls and the first 200 characters of its reply |
| `--judge provider/model` | The model that grades judged reply assertions (`expect.reply.judged`); default is the live `--model` the trials run on. A scripted run has no judge unless this names one, so it reports each judged assertion as not graded |

A live run ends with one line of model usage, the judge's calls included: input tokens (how many of
them were read from the provider's prompt cache), output tokens (how many were reasoning) and the
estimated cost from the model's price table. The `--report` JSON carries the same figures per trial,
scenario and run. See "What a run costs" in `docs/design/agent-package.md`.

A judged reply assertion asks a model one closed question about the reply, such as whether it
promises that someone will be in touch, so "Eileen will be in touch." fails it and "I cannot say she
will be in touch." passes. The judge sees only the reply and the claim. Each verdict, with the
prompt's version, the judge model and its raw answer, is in the trial's `trace.judged` in the
`--report` JSON. A judge whose provider fails, or that answers anything but `PRESENT` or `ABSENT`,
makes the trial errored, retried like any. A scripted run, CI's included, does not exercise judged
assertions: it prints `Judged assertions not graded: …` and grades the scenario on its other checks.

`officehum judge-check FIXTURE [--judge provider/model]` measures a judge before its verdicts are
trusted: it runs the judge over a labelled set of replies for one claim, with the prompt a trial
uses, and prints each verdict and the agreement (exit `0` only when every case agrees). The set for
the promise claim is `packages/sdk/src/fixtures/judged-promise-replies.json`, and for the offer
claim `judged-offer-replies.json` beside it; the judge defaults to
`paper/ultramarine-1-flash` and needs that provider's key.

A trial the model provider ends (an interrupted stream, a rate limit, a timeout, a server error) says
nothing about the role, so it is not graded: it is run again, up to `--retries` times, and the attempt
that finishes is graded. One that never finishes is reported `errored`, with every attempt's error, and
counts neither as a pass nor as a failure: the pass rate and the critical rule use graded trials only.
Each scenario line then shows how many trials passed, failed and errored and how many retries ran. The
command exits `0` when the suite passed, `1` when it failed, `2` on a usage error, and `3` when it is
incomplete: no graded trial failed it, but the provider did not complete some trial, so repeat the run.

A script file is JSON mapping each scenario id to the turns the scripted model plays back, in order:

```json
{
  "reports-cited-levels": [
    { "toolCalls": [{ "name": "stock_levels", "args": { "sku": "BOLT-10" } }] },
    { "text": "120 units, from stock:BOLT-10." }
  ]
}
```

Every selected scenario must have an entry, or the command refuses before any trial runs. A script
that must branch on what a tool returned cannot be written as JSON; use `piDurableRunner` from
`@officehum/runner` in a test for that.

## Paper Office document workspace

A task can be granted a **task lease** on immutable document versions and a bounded Python workspace
for Word, PowerPoint and Excel work. The grant is a lease, not a directory: it names input version IDs
with their hashes and the output formats the task may produce, and nothing else is reachable. Every
call binds a stable operation ID, the code and argument hashes, the source hashes, the policy version
and the pinned library versions into one receipt, so a replayed call returns the same commit and a
refusal or a timeout leaves the sources untouched.

The workspace runs in an isolated Python 3.13 subprocess with a scrubbed environment, kernel rlimits
and a lease-scoped staging directory. It needs an interpreter with the three Paper forks installed
exactly as pinned; there is no safe default, so the host names it:

```sh
packages/tools-paper-office/scripts/provision-worker.sh          # one-shot: uv + CPython 3.13
export OFFICEHUM_PAPER_PYTHON="$PWD/packages/tools-paper-office/.worker/bin/python"
```

Without that variable the interpreter-backed tests skip visibly and no document workspace is
available. See [`packages/tools-paper-office/README.md`](../packages/tools-paper-office/README.md) for
the lease model, each enforced limit and — importantly — what is *not* enforced until the container
profile lands. The Python-level guards are a bounded workspace, not a sandbox.

### Reading documents

`@officehum/tools-documents` gives a role three read tools, `document_read`, `document_outline` and
`document_search`, for the documents a business runs on: PDF (text per page, and `hasTextLayer: false`
for a scan), Word and Excel (through the same Paper worker, only for files the task's lease names), CSV
(delimiter, encoding and column types detected) and email (headers, body, and attachments saved to the
file store as outside files). Every page, section or sheet carries a marker to cite (`[p. 3]`,
`[s. 2, word/document.xml#3]`, `[sheet: Prices]`), long text is cut with a note saying how to ask for
more, and document text always reaches the model framed as data, not instructions.

Given a model by the host, the pack adds `document_extract` for scanned bills, phone
photos of receipts and invoice PDFs (PDF, JPEG, PNG; HEIC is refused with a request for a JPEG). Pages
without text are read by OCR (`tesseract.js` with English data shipped in the package, never
downloaded), the model returns vendor or customer, dates, line items, tax and total with the page and
line each came from, and code checks them in integer cents: line amounts, lines against the subtotal,
subtotal plus tax against the total, the dates, the currency, and the total and document number
against the page text. The result is `checked` only when every check passes, otherwise `unverified`;
nothing is posted anywhere. Scans and photos need a model that takes images; the default Paper model
reads text only, so with it only PDFs that have a text layer can be extracted. No catalog role
attaches the pack yet; see
[`packages/tools-documents/README.md`](../packages/tools-documents/README.md).

### Generating documents

`@officehum/tools-docgen` gives a role `document_generate` and `document_templates`: letters, memos,
reports, quotes, customer statements and meeting notes from templates, in the business's branding, as
PDF (rendered by Typst 0.13.1), Word or Excel (through the same Paper worker). Data is checked against
the template's JSON Schema, with every mismatch reported by field; a quote's or statement's totals must
agree with its lines; every file is a draft that records its template and version. A role's own tool
calls `renderDocument` with figures it fetched itself, so no model types a number. A business adds or
replaces templates in its overlay's `templates/` folder, and one that does not compile is refused. Typst is found through `OFFICEHUM_TYPST` or on the PATH and must be exactly 0.13.1; without it
PDFs are refused and the Typst tests skip visibly (CI does not install it yet). No catalog role attaches
the pack yet; see [`packages/tools-docgen/README.md`](../packages/tools-docgen/README.md).

### Answering questions over data

`@officehum/tools-data` gives a role `data_inspect`, `data_query`, `data_export` and `chart_render`
for questions over spreadsheets and exports ("which customers bought less this quarter", "reconcile
this bank CSV against open invoices"). The model writes one DuckDB `SELECT` over the files it loads as
named tables (CSV, Parquet, JSON, and Excel through the Paper worker for files the task's lease names);
DuckDB computes every figure exactly, and nothing is rounded unless the SQL asks. Each call runs in its
own in-memory DuckDB that can read only the files it loaded, with external access off and its
configuration locked, a time limit and a memory limit. Up to 200 rows come back inline; larger results,
CSV and `.xlsx` exports and charts are saved as new files. Charts are Vega-Lite specs the model writes
without data: the query result is their only data, and a spec that carries values or a URL is refused.
See [`packages/tools-data/README.md`](../packages/tools-data/README.md).

A role declares the tools it uses with `"pack": "data"` in its `officehum.json` (the Finance
Analyst and the Bookkeeper do, each with an `answering-from-spreadsheets` skill).
`officehum eval --pack data` evaluates a role with them, stubbed.

### Sending documents for signature

`@officehum/tools-esign` gives a role `esign_send`, `esign_status`, `esign_download`, `esign_void` and
`esign_templates`, over one `ESignature` interface whichever provider the business uses (no provider
client is built yet; tests use `fakeESignature()`). Every send and every void waits for a person, who
sees the documents (with their hashes), the signers and the message; exactly that is sent, and a call
whose details changed after the approval is refused. A send is idempotent by its call, including across
a restart. Signed copies are saved to the file store as outside files carrying the provider's id. No catalog role attaches the pack
yet; see [`packages/tools-esign/README.md`](../packages/tools-esign/README.md).
