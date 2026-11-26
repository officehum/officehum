# @officehum/tools-docgen

A **portable document generation pack** for a Pi Durable role: quotes, customer statements, letters,
reports, memos and meeting notes in the business's branding, as PDF, Word or Excel, where every
number comes from data that code supplied and never from the model typing it.

It depends on Pi Durable, pi-ai and pi-schema (peers), `@officehum/sdk`,
`@officehum/tools-paper-office` (the `DocumentService`, the lease, the operation identity and the
worker's own `create_document` / `create_workbook` programs) and `typebox` (the JSON Schema validator
the SDK already pins). No other library. Never a host, so the same pack runs in a bare
Pi Durable harness (see `src/harness.test.ts`).

| Format | Rendered by | Saved as |
| --- | --- | --- |
| PDF | **Typst 0.13.1**, a declared runtime, in a temporary directory | a new file in the versioned store, under the call's operation ID |
| Word (`.docx`) | `paper-docx` in the Paper worker, from typed blocks | an immutable draft through the `DocumentService` |
| Excel (`.xlsx`) | `paper-xlsx` in the Paper worker, with number formats, column widths and formulas | an immutable draft through the `DocumentService` |

## Install

Not published to npm yet. In a clone of this repository, `npm ci && npm run build` builds it and
workspaces import it by name. For another project, pack it with the Office Hum packages it depends on
(`npm pack -w @officehum/sdk -w @officehum/tools-paper-office -w @officehum/tools-docgen`) and install
the tarballs beside Pi Durable 1.6.0 and its peers, as
[Build a role](../../docs/build-a-role.md#use-a-role-in-your-own-harness) shows for a role.

## Register it

```ts
import { localVersionedFileStore } from "@officehum/sdk";
import { localDocumentService, runLedger, subprocessPaperWorker } from "@officehum/tools-paper-office";
import { documentGenerationPack } from "@officehum/tools-docgen";

const store = localVersionedFileStore("/office/state/files");
const pack = documentGenerationPack({
  store,
  // Word and Excel go through the Paper worker, on the task's lease.
  service: localDocumentService({
    store,
    worker: subprocessPaperWorker({ interpreter: process.env.OFFICEHUM_PAPER_PYTHON! }),
    ledger: runLedger("/office/state/document-runs"),
    createdBy: "role:bookkeeper",
  }),
  leaseFor: async ({ taskId }) => leases.get(taskId),
  createdBy: "role:bookkeeper",
  // Explicit until the brand-guide skill exists; neutral where it says nothing.
  branding: { companyName: "Acme Supplies", primaryColor: "#0B5394", logoFileId: "file_01J…" },
  // The business's own templates, from its overlay.
  templates: () => role.current().templates,
});
// Register pack.tools wherever the role's extension registers its tools.
```

In the role's `officehum.json`, declare `document_generate` (`replay: "safe"`, `writes: true` with a
`noApproval` note) and `document_templates` (`replay: "safe"`), and the runtime
`{ "name": "typst", "version": "0.13.1" }` (see `fixtures/document-desk/officehum.json`).

## The tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `document_generate` | `template`, `data`, `format` (`pdf`, `docx` or `xlsx`), `name` | Checks `data` against the template's schema (every mismatch reported with its field path), renders, saves a new draft and returns it with `fileResult`, plus a first-page PNG preview (at most 100 KB) for a PDF |
| `document_templates` | none | The templates: name, title, description, formats, origin, version and data schema |

`document_generate`'s description tells the model: for documents with financial figures, use the role's
own tool that supplies the data; `document_generate` is for prose documents and for figures a tool
already returned in the conversation, copied exactly.

### A role's own tool: `renderDocument`

```ts
const figures = await ledger.statement(customerId, period);   // exact numbers, from code
const { ref } = await pack.generator.renderDocument({
  template: "customer-statement",
  data: figures,
  format: "pdf",
  name: `statement-${customerId}`,
  operationId: operationIdForCall({ conversationId, callId }),
  taskId,
  lease, // for docx or xlsx
});
```

No model stands between the figures and the document.

## Templates

| Template | Formats | Data |
| --- | --- | --- |
| `letter` | PDF, Word | date, recipient, subject, salutation, body, closing, signature |
| `memo` | PDF, Word | to, from, cc, date, subject, body |
| `report` | PDF, Word, Excel | title, subtitle, author, date, summary, sections with paragraphs and a table |
| `quote` | PDF, Word, Excel | number, dates, customer, lines, subtotal, tax, total, terms |
| `customer-statement` | PDF, Word, Excel | customer, dates, opening balance, lines with running balance, totals, closing balance, amount due |
| `meeting-notes` | PDF, Word | title, date, attendees, agenda, notes by topic, decisions, actions |

Each built-in is `templates/<name>.typ` with `templates/<name>.schema.json`; the Word and Excel forms
are layouts in `src/layouts.ts`. Every schema carries an `examples` entry (not shown to the model).

- **Figures are the data's.** The templates and layouts print numbers; they never compute one. A
  quote's subtotal must equal its line amounts and its total the subtotal plus tax; a statement's
  totals must equal its lines' charges and payments, and its closing balance the opening balance plus
  charges less payments. Data that disagrees is refused before anything renders. In Excel a total is
  a formula over exactly the rows that hold the figures it adds (`=SUM(D9:D11)`), and the reopened
  workbook must hold every formula the layout wrote and no broken reference.
- **Text stays text.** Data never becomes Typst markup (a string is inserted as text), and a
  spreadsheet cell whose text begins with `=` is written with a leading apostrophe so it is never a
  formula.
- **Every file is a draft**, `source: "generated"`, with `template: { name, version }` in its
  metadata. The version is `sha256:` and 16 hex digits of everything that renders it.

### A business's own templates

An overlay adds or replaces a template with `templates/<name>.typ` and `templates/<name>.schema.json`
(a JSON Schema for its data). A template reads its data with `json("data.json")`, and may use the
helpers in `_officehum.typ` (`#import "_officehum.typ": *`: `brand`, `money()`, `lines()`,
`officehum-page`). An overlay template renders **PDF only**; one that replaces a built-in replaces it
for every format, so its Word and Excel forms are no longer offered.

`overlayTemplateValidator` lets a host's overlay store refuse a draft whose template does not compile
with sample data from its schema (its first `examples` entry, otherwise data built from the schema),
with the compiler's message. When Typst is not
installed, overlay templates are refused rather than accepted unchecked.

### Branding

`companyName`, `address`, `primaryColor`, `accentColor`, `textColor` (`#RRGGBB`), `font` (falls back
to Libertinus Serif when the machine lacks it) and `logoFileId` (a PNG or JPEG of at most 2 MB in the
store). It is a host option, not a tool argument, so a model cannot point a document at another file.
The brand-guide skill it will come from is not built. PDF uses all of it; Excel uses the
colours for its header rows; Word prints the company name and address (the Paper `create_document`
program has no colour, font or image blocks).

## Typst

Typst is a declared runtime, pinned to **0.13.1** (`TYPST_VERSION`). The pack runs
`OFFICEHUM_TYPST` when it is set, otherwise the first `typst` on the PATH, and refuses any other
version (`typst-version`) or none (`typst-missing`). No npm package downloads it and no binary is
committed: install it yourself, for example from the Typst release archives, and either put it on the
PATH or:

```sh
export OFFICEHUM_TYPST=/opt/typst-0.13.1/typst
```

A host that runs the pack in a container image installs this exact Typst version in it.

### What a compile may reach

Each compile gets a fresh temporary directory holding only the template, `_officehum.typ`,
`data.json`, `brand.json` and the copied logo, with `--root` set to it. The command is fixed
(`typst compile --root <dir> --diagnostic-format short --format pdf <dir>/<name>.typ <out>`, plus
`--pages 1 --ppi <n>` for the preview), and nothing a model or a template says changes it.

| Rule | How |
| --- | --- |
| No file outside the directory | `--root`: Typst resolves even `/etc/passwd` inside the root, and refuses `..` out of it |
| No network | the environment is built from nothing; package paths point at empty directories; every proxy variable points at an unreachable address |
| No secrets | the environment has no `HOME`, no credentials, nothing from the host's environment |
| Time | killed at 20 s (10 s for an overlay check) |
| Pages | at most 50; a longer PDF is refused and not saved |
| Size | a rendered file over 32 MB is refused |

That is defence in process, not a sandbox: until the container profile takes
the network away, a Typst bug that ignored the proxy variables could reach it.

### Previews

A PDF's first page is rendered with Typst's own PNG export at 72, 48 or 32 pixels per inch, the
highest that fits in 100 KB. Word and Excel get no preview (no renderer exists here without a new
dependency), and the result says so.

## Replay and refusals

- One operation ID is one file. A PDF is saved with the store's `create` under the call's operation ID,
  and a replay finds it with `lookupOperation` and renders nothing again. Word and Excel get the
  `DocumentService`'s receipts: a replay returns the same committed draft.
- A refusal writes nothing: data that does not fit, a compile error, a timeout, a page-limit breach or
  a worker refusal all return before any file is saved.

## Tests

`npm run check` runs them.

- Everywhere: the schema checks, the layouts (validated by the Paper Office request validators), the
  Typst runner against a fake `typst` (the fixed command, the environment, the directory, the time
  limit, the version check), PDF replay and refusals, the overlay check, the fixture role in a bare
  harness, and the package boundary.
- With the Paper worker (`OFFICEHUM_PAPER_PYTHON`, which CI provisions): every built-in renders Word
  and Excel, and a replay keeps one draft (`src/office-real.test.ts`).
- With Typst 0.13.1 (`src/typst-real.test.ts`): every built-in renders a PDF with a preview, a
  customer statement's totals appear in the PDF's text exactly as given, `/etc/passwd`, `..`, a URL
  and a package import fail to compile, the page limit holds, and a broken overlay template is
  rejected with the compiler's message. **These skip visibly where Typst is not installed, and CI does
  not install it yet**, so today they run only on a machine that has it.

## Not built

Editing existing files, wiring into a catalog role, images in Word output, a Word or Excel preview,
and the container image. E-signature is its own pack, `@officehum/tools-esign`.
