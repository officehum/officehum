# @officehum/tools-documents

A **portable document reading pack** for a Pi Durable role: the documents a business runs on (vendor
bills, contracts, price lists, forwarded emails) as text and tables, with page, section and sheet
references an agent can cite; and scanned bills, receipt photos and invoice PDFs as structured fields
that code has checked.

It depends on Pi Durable, pi-ai and pi-schema (peers), `@officehum/sdk`, `@officehum/tools-paper-office`
(for the `DocumentService`, the lease and the operation identity) and four libraries pinned exactly:

| Library | Version | Licence | Used for |
| --- | --- | --- | --- |
| `unpdf` | 1.9.1 | MIT | PDF text per page, and rendering scanned pages (it bundles pdf.js, Apache-2.0) |
| `postal-mime` | 4.2.0 | MIT-0 | Email parsing |
| `@napi-rs/canvas` | 1.1.0 | MIT | The canvas pdf.js renders a page onto (prebuilt Skia binary per platform, no install script) |
| `tesseract.js` | 7.0.0 | Apache-2.0 | OCR: Tesseract compiled to WebAssembly (`tesseract.js-core` 7.0.0, Apache-2.0), in a worker thread |

The English OCR data is committed in `tessdata/` (Tesseract's `eng` LSTM model, 2.95 MB, Apache-2.0;
see `tessdata/README.md`), so OCR never downloads anything.

Never a host, so the same pack runs in a bare Pi Durable harness (see
`src/harness.test.ts`).

## Install

Not published to npm yet. In a clone of this repository, `npm ci && npm run build` builds it and
workspaces import it by name. For another project, pack it with the Office Hum packages it depends on
(`npm pack -w @officehum/sdk -w @officehum/tools-paper-office -w @officehum/tools-documents`) and
install the tarballs beside Pi Durable 1.6.0 and its peers, as
[Build a role](../../docs/build-a-role.md#use-a-role-in-your-own-harness) shows for a role.

## Register it

```ts
import { localVersionedFileStore } from "@officehum/sdk";
import { localDocumentService, runLedger, subprocessPaperWorker } from "@officehum/tools-paper-office";
import { documentReadingPack } from "@officehum/tools-documents";

const store = localVersionedFileStore("/office/state/files");
const pack = documentReadingPack({
  // Word and Excel are read by the Paper worker, through the same service the Paper Office tools use.
  service: localDocumentService({
    store,
    worker: subprocessPaperWorker({ interpreter: process.env.OFFICEHUM_PAPER_PYTHON! }),
    ledger: runLedger("/office/state/document-runs"),
    createdBy: "role:bookkeeper",
  }),
  // The host owns both grants: the task's document lease, and its view of the file store.
  leaseFor: async ({ taskId }) => leases.get(taskId),
  filesFor: async ({ taskId }) => filesForTask(taskId),
  createdBy: "role:bookkeeper",
  // Optional: the model document_extract reads pages with, a { provider, modelId } that `models`
  // serves (see "Which model" below), and optionally a lower model-call limit than 180 s.
  // Without it the pack has no document_extract.
  extraction: { models, model: PAPER_MODEL_REF },
});
// Register pack.tools wherever the role's extension registers its tools.
```

In the role's `officehum.json`, declare the tools with `replay: "safe"`. `document_read` and
`document_outline` save an email's attachments, so they also state `writes: true` with a
`noApproval` note (see `fixtures/reading-desk/officehum.json`). `document_extract` writes nothing.

## The tools

| Tool | Arguments | What it returns |
| --- | --- | --- |
| `document_read` | `file_id`, `pages?`, `sheet?`, `max_chars?` | Markdown, every unit marked; cut at `max_chars` (default 12,000, at most 40,000) with a note naming what to ask for next |
| `document_outline` | `file_id` | Pages (and which have no text layer), sections and headings, sheets with sizes and formula counts, tables with sizes, an email's attachments by id |
| `document_search` | `file_id`, `query` | Up to 20 matching passages, each with its marker: the whole phrase where any passage has it, otherwise passages holding every word |
| `document_extract` | `file_id`, `kind` (`vendor_bill`, `receipt`, `customer_invoice`) | The fields, every value with its page and line, the checks and the status, as JSON (see below) |

| Format | Read by | Unit and marker | `pages` / `sheet` selects |
| --- | --- | --- | --- |
| PDF | `unpdf`, in a worker thread | page, `[p. 3]` | pages |
| Word (`.docx`) | `paper-docx` in the Paper worker | section (one per heading), `[s. 2, word/document.xml#3]` | sections |
| Excel (`.xlsx`) | `paper-xlsx` in the Paper worker | sheet, `[sheet: Prices]` | sheet |
| CSV | in process | the file as one sheet, `[sheet: prices.csv]` | sheet |
| Email (`.eml`) | `postal-mime`, in process | sections: headers, body, attachments | sections |

`readDocument(bytes, mimeType, options)` (PDF, CSV, email) and `readOfficeDocument(options)` (Word,
Excel) return the same `DocumentReading`: `pages`, `sections` or `sheets`, `tables`, `attachments`,
`metadata` and `hasTextLayer`. The tools are built on them; a host can call them directly.

### What each format gives

- **PDF**: text per page. Tables are not detected by layout; they arrive as their page's text. A page
  with no text at all is reported (`hasText: false`, and `hasTextLayer: false` for the document): it
  is almost always a scan, which `document_extract` reads by OCR.
- **Word**: headings (Markdown `#`), list items (`-`), tables (Markdown tables) and paragraphs, in
  document order, each section with the source reference of its first block. Text is read whole: the
  Paper Office adapters' `read` pages cap an item at 400 characters for editing, so this pack runs its
  own fixed program, `python/office_reader.py`, on the same worker and the same pinned library.
- **Excel**: each cell's address, type, literal value, formula and the value the package cached for it
  are kept apart (`type: "formula"`, `value: null`, `formula: "=SUM(D2:D4)"`,
  `cached: { type: "number", value: 449.25 }`). Nothing is calculated: a formula with no cached value
  says so. The Markdown shows the grid with row numbers and column letters, so a cell can be cited.
- **CSV**: UTF-8 (with or without a byte-order mark), otherwise Windows-1252; the delimiter (`,` `;`
  tab `|`) that splits the first lines most consistently; quoted fields kept whole; each column typed
  as integer, number, date, boolean or text. In a file not delimited by commas, `2,50` is a number.
- **Email**: the From, To, Cc, Subject and Date headers; the text body, or the HTML body converted to
  text when there is no text part; and each attachment, saved to the file store as `source: "external"`
  with `derivedFrom` naming the email, and listed by its file id so it can be read in turn.

## Extracting bills, receipts and invoices

`extractDocument(file, kind, { models, model })` (and the `document_extract` tool built on it) turns a
PDF, a JPEG or a PNG into structured fields:

1. **Scan** (`scanDocument`): numbered lines per page. A PDF page with a text layer keeps its own
   text; a page without one is rendered to PNG (pdf.js on `@napi-rs/canvas`, about 1190 by 1684
   pixels for A4) and read by OCR, as is a photo. OCR (`ocrImages`) turns a slanted photo upright
   first. At most 10 pages. **HEIC is refused** with a request for a JPEG: the libraries that could
   convert it ship without the HEVC decoder HEIC needs.
2. **Read**: one call to the host's model, with each page's numbered lines and, for a scanned page,
   its picture, and one tool whose parameters are the kind's schema (pi-schema builders): vendor (or
   customer, on a customer invoice) and address, document number, issue and due dates, currency,
   line items (description, quantity, unit price, amount), subtotal, tax lines, total, payment terms.
   Every value cites its page and line. A provider failure (`model-error`, with the provider's own
   message), a call over its time limit (`model-timeout`) or an answer that does not match the schema
   (`model-invalid-answer`) is refused, never retried on another model.
3. **Source**: the code quotes each cited line from its own reading, so `source.text` is never the
   model's. A value that cites no page of the document is withheld, and the `sources` check fails.
4. **Check**, in integer cents (`bigint`), with the model's figures as the data being checked:

   | Check | Passes when |
   | --- | --- |
   | `line-amount` (each line with a quantity or a unit price) | quantity × unit price, rounded half away from zero to the cent, equals the amount |
   | `lines-subtotal` | the line amounts add up to the subtotal |
   | `subtotal-tax-total` | subtotal plus the tax lines equals the total |
   | `dates` | the issue date is a real `YYYY-MM-DD` date, and the due date, if any, is one and not earlier |
   | `currency` | the currency is an ISO 4217 code |
   | `source-total` | the total appears in the page text (OCR or text layer), written `1,800.00`, `1.800,00` or `1800` |
   | `source-document-number` | the document number appears in the page text (ignoring case, spaces and punctuation) |
   | `sources` | every value cites a page the document has |

   A missing or malformed figure (no subtotal, `1,800.00` instead of `1800.00`) fails its check
   rather than being guessed. The result's `status` is `checked` only when every check passes;
   otherwise it is `unverified`.

The result also carries `usage`: the model call's tokens and cost, as the provider reported them. It
is data from outside the office: the tool frames it as untrusted text, and nothing is posted, saved or
sent anywhere.

### Which model

**Scans and photos need a model that takes images. The default Paper model,
`paper/ultramarine-1-flash`, reads text only, so with it only PDFs that have a text layer can be
extracted** (a bill exported from accounting software, like `fixtures/text-bill.pdf`). A scanned PDF
page, a JPEG or a PNG is refused at once (`model-not-vision`), before any OCR runs; the refusal says
a model that takes images is needed. Office Hum never switches to another model on its own.

### Time limits

Two limits, kept apart. The **reading limit** (30 s by default, the pack's per-file limit) covers
reading the file, rendering pages and OCR. The **model call** has its own, `MODEL_TIMEOUT_MS`
(180 s), because a live model that reasons before it answers often takes longer than that; a host
may lower it with `extraction.timeoutMs`, never raise it. A model call over its limit is aborted and
refused as `model-timeout`, which names the model call; a slow read is `timeout`.

### A live run

`scripts/live-extract.mjs` runs extraction against the default model, Paper's Ultramarine 1 Flash
(`@officehum/provider-paper`, `PAPER_MODEL_REF`). It calls the real API, so it is not a test. It reads
the key from `PAPERINSTRUMENTS_API_KEY` in your environment (export it from your password manager;
never type it on the command line):

```sh
npm run build
node packages/tools-documents/scripts/live-extract.mjs \
  vendor_bill text-bill.pdf bill-wrong-total.pdf
```

The first argument is the kind, the rest are files in `fixtures/` or paths. For each file it prints
the status, every check with pass or fail and its message, and the call's tokens and cost (billed, or
the catalog's estimate when the provider reports none); a refusal prints its code. The provider reads
the key from the environment when it calls; the script never prints it.

## Where a file may come from

- **Word and Excel only through the task's lease.** A `file_id` the lease names (by version id, or by
  file id when one version of it is leased) is read by the Paper worker through the injected
  `DocumentService`, which stages only leased, immutable versions and inspects each package before any
  parser sees it. A Word or Excel file the lease does not name is refused (`ungranted-input`, or
  `no-lease` when the task has none); a malformed package is refused with the service's own code
  (`archive-invalid`, `malformed-package`) and its bytes are untouched.
- **PDF, CSV and email through `filesFor`**, the host's view of the file store for the task. The
  lease admits only Office formats today, so the host scopes these reads itself; a task with no view
  is refused (`no-files`). `document_extract` reads its PDFs and pictures the same way.
- **PowerPoint** is not read (`unsupported-format`).

## Untrusted text, limits, replay

- **Document text is data.** Every result that carries it is framed with the SDK's
  `frameOutsideOutput`; a file whose provenance is external (an email attachment, an outside upload)
  is named as coming from outside the office. A leased version the store cannot describe is treated as
  outside.
- **Limits**: a file over 50 MB or a PDF over 500 pages is refused before it is parsed, with a message
  saying so. Each file has a time limit (30 s by default). A host may lower the limits (`limits`,
  clamped by `lowerReadingLimits`), never raise them.
- **A PDF is parsed off the host's event loop.** pdf.js runs in a worker thread of its own
  (`src/pdf-worker.ts`, built to `dist/pdf-worker.js`), one per read and per page render, so a crafted
  PDF that spins or swallows memory cannot stall or crash the process that runs the agents:
  - the thread is **terminated** at the time limit, and time spent waiting for a slot counts;
  - its V8 heap is capped at `MAX_PDF_MEMORY_MB` (256 MB, `limits.pdfMemoryMb`), past which the
    thread ends;
  - at most `MAX_CONCURRENT_PDF_READS` (2, `limits.pdfConcurrentReads`) run at once in a process;
    more wait their turn, so many simultaneous reads cannot exhaust memory.

  A read that times out is refused as `timeout`; one whose thread runs out of heap or stops is
  refused as `malformed` ("… is not a readable PDF (out of memory). Ask for an undamaged copy."). The
  thread writes no files, and a terminated one holds nothing open. The heap limit does not bound
  memory outside V8's heap (typed-array buffers, the canvas a page is rendered on).
- **OCR already runs off the event loop**: tesseract.js starts its own worker thread for each
  `ocrImages` call and terminates it when the call ends. Its time limit stops the wait, as for CSV.
- **CSV and email are parsed in process** and cannot be stopped midway, so for them the limit stops
  the wait and the call refuses on time. A Word or Excel run is also bounded by the lease's own wall
  clock in the Paper worker.
- **Replay**: a Word or Excel read takes one or more worker runs (a run's result is bounded, so a
  long document continues from the cursor the last run returned), each under an operation ID derived
  from the tool call's, so a replayed call resolves to the same receipts and runs nothing again. An
  attachment is saved under an operation ID derived from the task, the email's hash and its position,
  so a second read or a replay returns the same file.

## Tests

`npm run check` runs them. The Word and Excel suites (`src/office.test.ts`, and the Office half of
`src/harness.test.ts`) need the Paper worker's interpreter in `OFFICEHUM_PAPER_PYTHON` and **skip
visibly** without it, exactly as `tools-paper-office` does; CI provisions one. Everything else,
including the unleased and malformed Office refusals, runs everywhere.

The fixtures in `fixtures/` are made up, and `scripts/make-fixtures.py` regenerates them (run it with
the provisioned worker interpreter). The extraction fixtures (`scanned-bill.pdf`,
`bill-wrong-total.pdf`, `receipt-photo.jpg`, `handwritten-note.png`) are pictures with no text layer,
drawn by `scripts/make-scan-fixtures.mjs` with `@napi-rs/canvas`; the same script writes
`text-bill.pdf`, a clean bill with a text layer that a text-only model can extract.

The extraction evals (`src/extract.test.ts`) run each fixture through real rendering, real OCR and
the real checks, with a scripted model standing in for the vision model; no test calls a real model.
`src/ocr.test.ts` also runs OCR in a child process with every network door shut (`fetch`, `http`,
`https`, `net`, `tls`, DNS) in every thread, from the compiled `dist/`, so build first.

`src/pdf.test.ts` checks the PDF worker: every PDF fixture reads and renders byte for byte as pdf.js
does in process on the same machine, and its text, metadata and page sizes match what was recorded
before the move (`fixtures/pdf-readings.json`; rendered pixels vary by platform, so they are not
recorded), and test doubles
behind the worker boundary (`fixtures/workers/`: a parser that spins, one that eats its heap, one
that crashes, one that is slow) show a read abandoned at its limit while timers and other reads are
served, the memory limit ending one read only, and the concurrency cap queueing. The tests run the
worker from `src/pdf-worker.ts`, which Node runs by stripping its types; that file therefore imports
nothing from the package.

## Not built

Table detection in PDFs, HEIC conversion, OCR in languages other than English, handwriting beyond
best effort, writing documents, PowerPoint, and wiring the pack into a catalog role (the Bookkeeper's
use of extraction is its own work).
