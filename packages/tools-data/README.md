# @officehum/tools-data

A **portable data and spreadsheets pack** for a Pi Durable role: questions over CSV, Excel, Parquet
and JSON files answered with exact figures computed by DuckDB, exported as CSV or Excel, and charted
with Vega-Lite. The model writes SQL and a chart spec; it never types a figure.

It depends on Pi Durable, pi-ai and pi-schema (peers), `@officehum/sdk`, `@officehum/tools-documents`
(its lease-gated Excel reader and CSV decoding), `@officehum/tools-paper-office` (the lease, the
operation identity and the worker's `create_workbook` program) and four pinned libraries:

| Library | Version | Licence | Why |
| --- | --- | --- | --- |
| `@duckdb/node-api` | 2.0.0-r.1 | MIT | the query engine; prebuilt binaries for linux-x64, linux-arm64 and darwin-arm64, no install script, JSON and Parquet built in |
| `vega` | 6.4.0 | BSD-3-Clause | renders a chart to SVG in Node, with no canvas |
| `vega-lite` | 6.5.0 | BSD-3-Clause | compiles the model's spec to Vega |
| `@resvg/resvg-js` | 2.6.2 | MPL-2.0 (unmodified) | SVG to PNG; prebuilt, no install script |

`sharp` was not chosen: its libvips binary is LGPL-3.0. Never a host, so the same pack runs
in a bare Pi Durable harness (see `src/harness.test.ts`). It is opt-in: nothing on the office's default
path depends on it.

## Install

Not published to npm yet. In a clone of this repository, `npm ci && npm run build` builds it and
workspaces import it by name. For another project, pack it with the Office Hum packages it depends on
(`npm pack -w @officehum/sdk -w @officehum/tools-paper-office -w @officehum/tools-documents -w
@officehum/tools-data`) and install the tarballs beside Pi Durable 1.6.0 and its peers, as
[Build a role](../../docs/build-a-role.md#use-a-role-in-your-own-harness) shows for a role.

## Register it

```ts
import { localVersionedFileStore } from "@officehum/sdk";
import { localDocumentService, runLedger, subprocessPaperWorker } from "@officehum/tools-paper-office";
import { dataPack } from "@officehum/tools-data";

const store = localVersionedFileStore("/office/state/files");
const pack = dataPack({
  filesFor: async () => store, // the task's view of the store
  // Optional: Excel input and .xlsx export go through the Paper worker, on the task's lease.
  service: localDocumentService({
    store,
    worker: subprocessPaperWorker({ interpreter: process.env.OFFICEHUM_PAPER_PYTHON ?? "" }),
    ledger: runLedger("/office/state/document-runs"),
    createdBy: "role:finance-analyst",
  }),
  leaseFor: async ({ taskId }) => leases.get(taskId),
  createdBy: "role:finance-analyst",
  limits: { timeoutMs: 10_000 }, // lower than the defaults only
});
```

A role does not install the pack itself. It declares the tools it uses in its
`officehum.json` with `"pack": "data"` and a description, takes `packs` as a factory option and
passes it to `defineRole({ packs })`; the host builds the pack and gives it. Built without it, the
role does not offer those tools. `@officehum/tools-data/pack` exports `dataPack` and the tool
definitions without loading DuckDB, Vega or resvg: the engine is imported at a tool's first call, so a
host that only offers or stubs the tools never loads it. See
[pack tools](../../docs/design/agent-package.md#pack-tools).

```ts
import { dataPack } from "@officehum/tools-data/pack";

const pack = dataPack({ filesFor: async () => store, createdBy: "role:data-desk" });
const role = dataDesk({ packs: [pack] }); // a role whose factory passes packs to defineRole
```

## The tools

All four are `replay: "safe"`. A call that saves a file saves it under the call's operation ID, and a
replay returns the file the first run saved.

| Tool | Arguments | Result |
| --- | --- | --- |
| `data_inspect` | `file_id`, `sheet?` | columns and types, row count, missing values per column, the first ten rows |
| `data_query` | `tables: {name, file_id, sheet?}[]`, `sql` | up to 200 rows as a Markdown table; more are saved as a CSV file, returned by id with the row count |
| `data_export` | `tables`, `sql`, `format: "csv" \| "xlsx"`, `name` | a new CSV file, or a new `.xlsx` draft through the Paper worker (at most 4,096 cells) |
| `chart_render` | `tables`, `sql`, `spec`, `name?` | a PNG saved as a file, and a preview of at most 100 KB |

## What keeps a query to the loaded files

- **The statement check is DuckDB's parser.** `json_serialize_sql` serialises only SELECT statements
  and must return exactly one; the node API's statement extraction must also find one statement of
  type SELECT. COPY, ATTACH, INSTALL, LOAD, PRAGMA, SET, CREATE and several statements are refused.
- **The sandbox holds even when a statement gets past the check.** One in-memory database per call,
  one thread, no extension autoload or autoinstall, no spill directory, a memory limit. The files are
  staged in a private temporary folder, and before anything loads the database may read only that
  folder (`allowed_directories`, `enable_external_access = false`). After loading the folder is deleted
  and `lock_configuration = true`. `read_csv('/etc/passwd')` fails at this layer alone; the tests
  check each layer on its own.
- **Limits.** 20 s per call (the connection is interrupted), 512 MB, 50 MB per file, 100,000 result
  rows, 8 tables. A host may lower them. Each limit has its own refusal code and message.

## Figures

CSV columns are typed by DuckDB's sniffer with exact `DECIMAL(38,6)` tried before `DOUBLE`, so money
sums are exact. Results are DuckDB's own text for decimals, big integers and dates, and the shortest
exact form for doubles; nothing is rounded unless the SQL rounds. A workbook's sheet loads through the
same sniffer: its first row that holds anything is the header, and a formula contributes the value the
workbook cached, never a recalculation.

## Charts

The spec is Vega-Lite with marks bar, line, area, arc (a pie) or text (a table). It may not carry data:
any `values`, `url`, `href` or `datasets` key, any link in a string, and any data source other than
`{"name": "result"}` is refused, each problem with its path. Vega runs with a loader that refuses every
load, so nothing is fetched even for a spec that skipped the check. The SVG becomes a PNG at twice its
size by resvg, with the system's fonts; the preview is the largest of 1×, 0.75× or 0.5× that fits in
100 KB.

## Not here

Editing an existing business workbook is the Paper Office flow (`edit_workbook` and publication), not
this pack. The Finance Analyst and the Bookkeeper declare its four tools as pack tools.

## Tests

`npx vitest run packages/tools-data`. The fixtures (a 10,000-row sales CSV from a seeded generator, a
bank statement, open invoices as CSV and as a workbook) are made by `scripts/make-fixtures.mjs` and
`scripts/make-workbook.py`. The Excel tests in `src/office.test.ts` need `OFFICEHUM_PAPER_PYTHON` and
skip visibly without it, as the Paper Office suites do.
