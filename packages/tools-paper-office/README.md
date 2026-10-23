# @officehum/tools-paper-office

A **task-leased Paper Office document workspace** for a Pi Durable role: a `DocumentService` a host
injects, an isolated Python 3.13 worker pinned to `paper-docx`, `paper-pptx` and `paper-xlsx`, the
portable `run_document_python` tool, and the typed Word, PowerPoint and Excel operations built on top
of it.
It depends on Pi Durable, `pi-ai` and `@officehum/sdk` (for the FileStore contract) — never on
`@officehum/office` — so the same pack runs in a bare Pi Durable harness with a fake service and inside
Office Hum with the local one.

Design: [`docs/superpowers/specs/2026-10-14-paper-instruments-integration-design.md`](../../docs/superpowers/specs/2026-10-14-paper-instruments-integration-design.md).

## Register it

```ts
import { localVersionedFileStore } from "@officehum/sdk";
import {
  localDocumentService,
  paperOfficeToolPack,
  runLedger,
  subprocessPaperWorker,
} from "@officehum/tools-paper-office";

const store = localVersionedFileStore("/office/state/documents");
const service = localDocumentService({
  store,
  worker: subprocessPaperWorker({ interpreter: process.env.OFFICEHUM_PAPER_PYTHON! }),
  ledger: runLedger("/office/state/document-runs"),
  createdBy: "role:bookkeeper",
});

const pack = paperOfficeToolPack({
  service,
  // The host owns leases: this is the task's grant, or undefined when it has none.
  leaseFor: async ({ taskId }) => leases.get(taskId),
});
// Register pack.tools wherever the role's extension registers its tools.
```

A bare harness supplies its own `DocumentService`; see `src/portability.test.ts` for the shape.

## A lease, not a directory

A lease grants exactly: immutable input **version IDs with their hashes**, the permitted **output
formats**, and a **resource budget**. It has no field for a path, a URL, a credential or a connector,
so prompt text, skill content, document content and submitted Python all have nowhere to widen it.

```ts
const lease: DocumentLease = {
  leaseId: "lease:42", taskId: "task:42",
  inputs: [{ fileId, versionId, name: "brief.docx", format: "docx", sha256, size, writable: true }],
  outputFormats: ["docx", "xlsx"],
  limits: { ...DEFAULT_LIMITS, wallSeconds: 30, outputBytes: 8 * 1024 * 1024 },
  expiresAt: "2026-11-01T00:00:00.000Z",
};
```

A role may hold the capability and receive **no usable lease** for a task: `run_document_python` then
refuses with `no-lease` instead of reaching for anything wider.

## The workspace API submitted code sees

```python
import docx, openpyxl

# documents is already in scope.
brief = docx.Document(documents.open_input("brief.docx"))     # a leased name or version ID
book = openpyxl.load_workbook(documents.open_input("figures.xlsx"), data_only=False)
revenue = book.active["B1"].value

brief.add_paragraph("Revenue: " + str(revenue))
brief.save(documents.declare_output("brief.docx", "docx", edit_of="brief.docx"))

documents.result({"revenue": revenue})
```

`documents.inputs()` · `open_input(ref)` · `read_input(ref)` · `declare_output(name, format, edit_of)`
· `write_output(name, bytes)` · `outputs()` · `staging()` · `limits()` · `arguments()` ·
`environment()` · `result(value)`.

Every refusal raises `WorkspaceError` with a stable `code`. There is no function that takes a path, and
`open`/`eval`/`exec`/`compile`/`input` are not in the submitted code's builtins.

## The typed Word operations

`inspect_document`, `read_document`, `create_document`, `edit_document`, `preview_document` and
`compare_document` are the same operation underneath as `run_document_python`: each one validates its
arguments, resolves them against the task's lease, and runs a fixed program
(`python/word_adapter.py`) through the same `DocumentService` — so typed calls and submitted snippets
share the lease, the staging, the package inspection, the receipts and the idempotency. Withhold them
with `paperOfficeToolPack({ includeWordTools: false })` if a role should get only the workspace.

**A file reference, never a path.** Every operation takes `{ fileId, versionId, name, sha256, size }`
from the task's lease or from an earlier operation's output. All five fields are checked against the
lease before the run; a reference the lease does not grant is `ungranted-input`, and an output is one
staging file name (`traversal` if it could be anything else).

| Tool | What it does | What it refuses |
| --- | --- | --- |
| `inspect_document` | Counts, story parts, the heading outline, table shapes, comments with their thread state, tracked changes by type, blind regions, `w:documentProtection` | a reference outside the lease; an unreadable package |
| `read_document` | **Bounded pages** of `paragraphs`, `headings`, `tables` (with optional cell text), `comments` or `revisions`, each page carrying its size, cursor, total and next cursor | a page size over 50, a cursor past the end, an unknown section |
| `create_document` | A new `.docx` **draft** from typed blocks (headings, paragraphs, bullet/decimal lists, tables, page breaks) | a non-`.docx` name, a ragged table, an undefined style, a format the lease does not permit |
| `edit_document` | An **unpublished proposal**: a new immutable version of a leased file, from ordered steps (see below) | a read-only source, a protected document without an explicit acknowledgment, a stale anchor, an ambiguous or missing target, a step the fork cannot do untracked |
| `preview_document` | Bounded, structure-marked text (`H1:`, `P:`, `L:`, `T2x2:`) plus the pending-change redline | the same page rules as `read_document` |
| `compare_document` | Structural change set, per-story unified text diff, and the redline of the second version | an unreadable version of either side |

**Edits.** Steps apply in the order given, and each validates its own anchor — exact paragraph text, or a
`{ story, index, contentHash }` anchor reacquired from `read_document` and refused if the content has
moved on. The kinds are `insertSection`, `replaceParagraphs`, `deleteParagraphs`, `replaceText`,
`updateCell`, `insertRow`, `deleteRow`, `addComment`, `replyComment`, `resolveComment`, `deleteComment`,
`acceptRevisions` and `rejectRevisions`. Word-level steps are recorded as **real tracked changes** by
default, so a reviewer gets a Word redline and not just a text diff; an edit carries an author, and an
optional ISO date so a host can pin what the revisions are stamped with.

**What an edit proves.** The proposal's result reports the source and output `sha256`, the structural
change set (`added`, `removed`, `changed`, and `byteIdenticalCount`), a text diff, a redline, per-step
evidence, a reopen witness, and the `patch_save` part lists. Untouched parts come back **byte-identical**
— relationships, styles, headers, footers, numbering, theme, settings, `docProps` and untouched sections
— because the edit writes through `docx.package.patch_save`, which restores the original bytes of every
part that is semantically unchanged. The variant test fixture makes `word/styles.xml` deliberately
different from what a re-serialization would emit, so the proposal matching it exactly is evidence that
the part was restored rather than rewritten.

**Drafts and proposals, never publications.** `create_document` writes a new file; `edit_document`
proposes a new version of a leased one. Both report `published: false` and the result validator refuses
anything else, because publication belongs to the review surface (RASF-3285).

**What the fork cannot do** (worked around, not hidden): paragraph removal and replacement exist only as
tracked changes, so `deleteParagraphs`/`replaceParagraphs` refuse `tracked: false` with
`unsupported-structure`; row insertion and deletion have no tracked variant, so they appear in the change
set and the text diff but are recorded as `tracked: false` rather than pretending to be revisions;
`diff_package`, `text_diff` and `pending_changes` are path-based, so the adapter opens each version a
bounded number of times rather than once.

## The typed PowerPoint operations

`inspect_presentation`, `read_presentation`, `create_presentation`, `edit_presentation`,
`preview_presentation`, `compare_presentation` and `compose_presentation` are the same operation
underneath as `run_document_python`: each one validates its arguments, resolves them against the task's
lease, and runs a fixed program (`python/pptx_adapter.py`) through the same `DocumentService` — so typed
calls and submitted snippets share the lease, the staging, the package inspection, the receipts and the
idempotency. Withhold them with `paperOfficeToolPack({ includePptxTools: false })` if a role should get
only the workspace, or with `includeWordTools: false` if it should get only PowerPoint.

Seven, where Word has six: a deck can absorb another deck's slides, and that import carries its own
relationship-policy refusals and part ledger. The rest mirror the Word adapter one for one.

| Tool | What it does | What it refuses |
| --- | --- | --- |
| `inspect_presentation` | Slide, master, layout, shape, text-block, notes, media, picture, table and chart counts; the bounded slide outline with each slide's layout and title; media references with their part hashes; which text is a blind region; how much text is estimated to overflow its box | a reference outside the lease; an unreadable package; an external relationship |
| `read_presentation` | **Bounded pages** of `slides` (order and layout), `text` (every block with its resolved effective font and a structural anchor), `shapes`, `notes` or `media` references, each page carrying its size, cursor, total and next cursor | a page size over 50, a cursor past the end, an unknown section |
| `create_presentation` | A new `.pptx` **draft** from typed slides: a title, paragraphs, bullet lists, tables and speaker notes | a non-`.pptx` name, a ragged table, a layout this deck does not define, a format the lease does not permit |
| `edit_presentation` | An **unpublished proposal**: a new immutable version of a leased deck, from ordered steps (see below) | a read-only source, a stale or ambiguous anchor, a missing target, a layout rebind whose placeholders cannot be reconciled, a step that would not reopen as a presentation |
| `preview_presentation` | Bounded **structural** slide previews — `T:`/`B:`/`P:`/`TC:` text lines, `TB<rows>x<columns>:`, `PIC:<ext>:`, `CH:<type>:` — plus notes, media and estimated overflow | the same page rules as `read_presentation` |
| `compare_presentation` | Structural change set, the fork's own slide-level diff, and a **before/after preview of every changed slide** | an unreadable version of either side |
| `compose_presentation` | Appends one leased deck's slides into another as an unpublished proposal, by `adopt_theme`, `keep_appearance` or `bake` | a read-only destination, a mode that is not one of the three, a relationship the import cannot carry |

**Edits.** Steps apply in the order given, and each validates its own target before anything is written:
`replaceText` (anchored, formatting-preserving), `replaceTextEverywhere` (with an optional `expect`
count so drift refuses instead of passing silently), `writeNotes`, `addSlide`, `cloneSlide`,
`deleteSlide`, `moveSlide`, `rebindLayout`, `applyFooters`, `deleteShape`, `moveShape`, `copyShape`.
An anchor is either the block `read_presentation` reported — `part`, `block_index`, `content_hash`, and
`version`/`locator` for a current anchor — or that paragraph's exact literal text. The fork refuses a
stale anchor with `stale-anchor` rather than editing whatever moved into its place, which is the correct
answer to "edit a proposal made against an older version".

**What an edit proves.** The proposal's result reports the source and output `sha256`, the structural
change set (parts `added`, `removed`, `changed` — each with its **before and after sha256** — and
`byteIdenticalCount`), the fork's own slide-level diff, a before/after structural preview of each changed
slide, per-step evidence, a reopen witness, and the preservation block. Untouched parts come back
**byte-identical** — layouts, masters, both themes, media, the notes master, and the slides the edit did
not touch — because the edit writes through `pptx.package.patch_save`, which restores the original bytes
of every part that is semantically unchanged. The fixtures argue this with per-part sha256 rather than by
eye: the test unzips both versions, hashes every member, and checks the hashes the result *reports*
against the hashes the packages actually hold.

**Drafts and proposals, never publications.** `create_presentation` writes a new file;
`edit_presentation` and `compose_presentation` propose a new version of a leased one. All report
`published: false` and the result validator refuses anything else, because publication belongs to the
review surface (RASF-3285).

### There is no bitmap renderer, and the results say so

`paper-pptx` 0.2.0 has **no rasteriser** — nothing in the fork turns a slide into an image — and this
worker has no isolation to run one (RASF-3111). Nor can it measure text the way PowerPoint would: the
fork's only measurement path is `TextFrame.fit_text`, which is a fit *application* rather than a report
(it turns autofit off and writes a best-fit point size into every run), and it resolves a TrueType font
**installed on the host** via `FontFiles.find`, so its answer changes with the machine and cannot be
bound into a receipt. So:

- A **preview is structural**, not a picture: slide text with structure markers, the shape inventory with
  effective formatting, speaker notes, media references, and the per-slide change set. `rendering.bitmap`
  is `false` in every result, `rendering.limits` names exactly what is missing and why, and the result
  validator **refuses a worker that claims a bitmap rendering**.
- **Overflow is computed and reported**, or reported as a limit. The estimate multiplies the resolved
  font size by a published constant pair (`averageGlyphAdvanceEm` 0.5, `lineHeightEm` 1.2), compares the
  result with the box's own geometry minus its own text insets, and reports the numbers it used —
  `linesNeeded`, `requiredHeightEmu`, `availableHeightEmu`, `estimatedWidthEmu`, `availableWidthEmu`.
  It is an estimate, not a measurement, and it is labelled `advance-estimate`; the constants ride in
  every result so a caller can see what was assumed.
- Before estimating anything, the report reads the frame's **own declared autofit**: `normAutofit` with a
  font scale means the deck already shrank the text (`compensated: true`), and `spAutoFit` means the box
  grows to the text, so a fixed-box overflow cannot occur. Only when neither is declared is a number
  computed.
- When the estimate cannot be made, the report says why — an inherited shape geometry, an unresolved font
  size, a box narrower than its own insets, table-cell text — with `computed: false` and a `reason`. The
  result validator refuses an uncomputed, uncompensated overflow that gives no reason, so a limit can
  never be silently ignored.

**What the fork cannot do** (worked around or reported, not hidden): table-cell text is a **blind
region** for effective values (the resolver does not walk table styles), so its formatting is reported
unresolved rather than guessed; PowerPoint carries no revision markup, so there is no redline — review
gets the structural change set, the slide diff and the before/after preview; `shape_by_name` refuses an
ambiguity, and because `add_copy` keeps its source's display name a copy is addressed by `shapeId` (the
step evidence reports the new id); `rebind_layout` refuses a placeholder it cannot reconcile unless
`orphanPolicy: "bake"` is passed; `mc:AlternateContent` subtrees are not surveyable, so an operation that
must see everything refuses rather than guessing.

## The typed Excel operations

`inspect_workbook`, `read_workbook`, `create_workbook`, `edit_workbook`, `preview_workbook` and
`compare_workbook` are the same shape as their Word and PowerPoint siblings: each validates its
arguments, resolves them against the task's lease, and runs a fixed program (`python/xlsx_adapter.py`)
through the same `DocumentService`. Withhold them with `paperOfficeToolPack({ includeXlsxTools: false })`.

Six, mirroring Word: Excel has one primitive the other formats do not need — a *cell*, addressed by
sheet and A1 coordinate — and a formula is a value a caller supplies rather than one this pack computes.
There is no `compose`: a workbook does not absorb another workbook's sheets in one operation.

| Tool | What it does | What it refuses |
| --- | --- | --- |
| `inspect_workbook` | Sheet order with each sheet's size, protection and freeze state; cell, formula, styled-cell, table, merged-range and validation counts; the named ranges with the range each names; the charts with their series references; how many chart parts the package holds that this version does not model | a reference outside the lease; an unreadable package; a macro; an external link |
| `read_workbook` | **Bounded pages** of `sheets`, `cells` (with each formula and the value the package cached), `formulas` (with every reference each makes), `names`, `styles` or `charts`, each page carrying its size, cursor, total and next cursor | a page size over 50, a cursor past the end, an unknown section, a range over 4 096 cells, a `cells` read with no sheet or range |
| `create_workbook` | A new `.xlsx` **draft** from typed sheets: names, blocks of literals and formulas, styles, named ranges, column widths and a frozen pane | a non-`.xlsx` name, a ragged or oversized block, a defined name whose reference points at a sheet the workbook does not have, a format the lease does not permit |
| `edit_workbook` | An **unpublished proposal**: a new immutable version of a leased workbook, from ordered steps (see below) | a read-only source, an unknown sheet, a sheet this workbook does not have, an edit that would leave a reference pointing nowhere, a step that would not reopen as a workbook |
| `preview_workbook` | Bounded **structural** sheet previews — `V:`/`F:`/`S:` value, formula and style lines, `N:` names, `T:` tables, `C:` charts, `M:` merges, `AF:` autofilters | the same page rules as `read_workbook` |
| `compare_workbook` | The structural change set, the cell and formula diff, the style diff, the formulas that read a changed cell, and explicit numeric checks | an unreadable version of either side |

**Edits.** Steps apply in the order given, and each validates its own target before anything is written:
`setCell` (a literal, `null` to clear, or a formula), `setRange` (literals only, exactly the block the
range covers), `clearCells`, `setStyle`, `setColumnWidth`, `addSheet`, `deleteSheet`, `renameSheet`,
`setName`, `removeName`. A value that begins with `=` must use the `formula` field in an edit, so a
string that looks like a formula is never silently given a new meaning — in `create_workbook`, a string
beginning with `=` *is* the formula, because that is how a draft's totals are laid out from source data.
A rename rewrites the references that name the sheet; a delete or a name removal that would strand a
reference refuses with `broken-reference` **before anything is written**, naming every reference it found.

**What an edit proves.** The proposal's result reports the source and output `sha256`, the fork's own
edit receipt (the changed-cell set, keyed by the part that holds each cell), the structural change set
with each part's before and after `sha256`, the cell and formula diff, the style diff, the formulas that
read a changed cell, explicit numeric checks, a reopen witness, and the preservation block. Untouched
parts come back **byte-identical** — other sheets, charts, drawings and the theme — because
`openpyxl.preserve` is on by default for `load_workbook(path)`: the original package is the source of
truth and the save is a splice, so an untouched part is raw-copied rather than re-serialized. The
fixtures argue this with per-part sha256 *and* with a stock round trip of the same source: one fixture's
untouched sheet carries an x14 sparkline group, which openpyxl's own reader warns it "will be removed" —
the stock round trip drops it, and the proposal returns the original bytes.

### No calculation happens here, and the results say so

`openpyxl.oracle` is the fork's only calculation path and it implements **no engine**: its own
documentation says a partial engine would be a "silent-wrongness machine", so it delegates to headless
LibreOffice. This worker cannot spawn a process — its import guard denies `subprocess` and it patches
`os.system`, `os.popen`, `os.fork` and `os.exec*` — so a recalculation is impossible here even where
LibreOffice is installed, and `openpyxl.oracle.available()` is `false` on a machine without it. So:

- Every result carries a `recalculation` block: `available`, `attempted: false`, `computed: false`,
  `processSpawned: false`, the reason in words, and the 22 functions `ORACLE_UNSUPPORTED_FUNCS` names
  that the oracle would refuse *anywhere* (`LAMBDA`, `LET`, `WEBSERVICE`, the `CUBE*` family, …). The
  result validator **refuses a worker that claims a computed value, an attempted run or a spawned
  process**, and refuses a block whose reason or limits are empty.
- No operation returns a calculated value. A `cachedValue` a read reports is one the *package* already
  held, marked `cachedKnown`, and the `create` result says plainly that a formula written into a draft
  has no cached value until Excel or LibreOffice opens it.
- What the adapter *does* verify arithmetically: the exact before and after of each changed cell with
  its exact decimal delta, and — where a changed cell's own formula is `SUM(<range>)` — **its own exact
  sum of the cells that range names**, reported beside whatever value the file cached. When the splice
  drops a cache because an input changed, `agrees` is `null` with that reason rather than a guess; when
  the file's cache is there to compare against, `agrees` is the comparison (`true` or `false`), and a
  difference is reported rather than resolved. Every sum names the cells it added.
- The proposal's own recalculation request is read out of the package and reported
  (`workbookRequest.requestsRecalculation`), so a reviewer knows Excel will recalculate on open.

**Reference verification.** `inspect`, `read`, `edit` and `compare` walk every formula surface the
library itself knows about — cells, defined names, print areas, data validation, conditional formatting,
table ranges and chart series — and report the ones that cannot resolve: a sheet prefix naming a sheet
the workbook does not have, a name that is not defined, a range outside the grid, a structured reference
to a table that is gone, an `[1]Sheet!A1` reference to another workbook, and the `#REF!` operands and
cached error values `openpyxl.preserve.hygiene` finds. A source that already has one is **reported, not
refused and not repaired** — a reviewer needs to see it — while an operation that would *add* one refuses
with `broken-reference`. The two claims the design makes about preservation and calculation are therefore
both checkable: `preservation.byteIdentical` is a sha256 list, and `recalculation.computed` is `false`
with a reason.

**Charts are read, never drawn.** A chart's series references are part of the reference verification, and
a chart part the library cannot model is counted in `unmodeledChartParts` rather than silently ignored.
Creating a chart belongs to the data pack ([RASF-3204](https://linear.app/riseandshinefutures/issue/RASF-3204)).

## Receipts, replay and immutability

Every call gets an operation ID derived from the Pi Durable conversation and call identity — never from
an argument — and the receipt binds that ID to the code hash, the argument hash, the leased source
hashes, the permitted formats, the resource limits, the policy version and the worker's library
versions. Then:

- A **replay** of the same operation returns the same committed receipt, with no second execution.
- **Changed intent** under a used ID (`operation-collision`) refuses in the run ledger *and* in the
  FileStore, which binds its own receipts to the content hash.
- A **refusal or a timeout** returns before anything is staged for commit: no ledger entry, no version,
  every source byte-identical.
- A **crash** between the commit and the receipt is reconciled from the FileStore's operation lookup —
  one immutable output, or a stable refusal. A lost ledger with different bytes refuses rather than
  editing twice.
- Outputs are **immortal**: a new call produces a new immutable version. Editing a leased file
  proposes a new version; two concurrent edits are settled by the FileStore's head compare-and-swap
  (`version-conflict`), never a silent overwrite.
- `reads` in a receipt is what the run actually opened — the lineage of a cross-format transformation —
  and output metadata records `derivedFrom`.

## Review and publication

An edit to an existing business file is a **proposal**, and nothing publishes it until a person has
reviewed *that exact version*. `publicationGate` is the surface: it opens a durable review from the
immutable source and proposed hashes, records a person's decision bound to those hashes, and only then
lets the FileStore's own publish compare-and-swap move the published pointer.

- **One evidence shape.** Word, PowerPoint and Excel each keep their native comparison, and
  `reviewEvidenceFromWord/Pptx/Xlsx` normalise it into one `ReviewEvidence`: the change set, the native
  diff, the format's preview (redline / before-and-after slides / changed cells), a set of deterministic
  checks and the limits of that evidence. `reviewEvidenceFromService` runs the format's own `compare_*`
  through the worker, so the evidence is the adapter's, not a second differ.
- **The approval *is* the hashes.** `reviewBindingOf` seals the file, the source version and hash, the
  proposed version and hash, the diff digest and the validation digest; the review ID is that binding.
  Two proposals that differ in one byte of the document or one line of evidence have different bindings,
  different review IDs, and therefore no shared approval. A decision carries the whole binding and the
  gate compares it by value (`approvalCovers`), so an approval for one proposal cannot publish another.
- **A rubric cannot approve.** `withRubric` records a qualitative score beside the deterministic checks;
  `mayApprove` is always `false` and the publish path never reads it.
- **Every refusal leaves the pointer where it was.** A missing decision (`not-approved`), a denial
  (`denied`), a mismatched approval (`approval-mismatch`), a proposal a newer edit superseded
  (`stale-review`) and a published pointer that moved after the review (`version-conflict`) all return
  before the FileStore is asked to publish.
- **Restart-safe.** The review is written to a durable ledger before anyone decides. A restart reopens
  the same pending review — it is neither re-created nor auto-approved.
- **A new file is a draft.** It needs no review; the gate only guards an existing file's published
  pointer.
- **An agent may ask; a person decides.** `publish_document` is in the pack only when the host supplies
  a gate (withhold it and the pack has no publish path at all). It resolves the host's review for the
  exact proposed version and asks the gate; with no review, a pending review, a denial or an approval
  bound to other hashes, it returns the refusal and nothing moves. The agent cannot name an approval.

The CLI is the person's surface: `officehum review list|show|decide|publish` shows the file, both
versions with their hashes, the evidence, the deterministic checks and the stated limits, then records
the decision and publishes behind the FileStore compare-and-swap. This is deliberately **not** the
`--approval allow|deny` tool-approval flag: that one decides whether a gated tool call may run, and says
nothing about which bytes would become the published version.

## Limits, and exactly where each is enforced

| Limit | Enforced by | How |
| --- | --- | --- |
| CPU seconds | the kernel, in the worker | `RLIMIT_CPU`; the process dies on `SIGXCPU` → `cpu-limit` |
| Memory bytes | the kernel, in the worker | `RLIMIT_AS`; **not enforceable on macOS** (see below) |
| Per-file size | the kernel, in the worker | `RLIMIT_FSIZE`; writes fail with `EFBIG` → `file-size-limit` |
| Wall clock | the worker's `SIGALRM`, then the host | a graceful `timeout`, with the host's kill as backstop |
| Total output bytes | the worker and the host, twice | the collector, then the service before any commit |
| File count | the worker and the host, twice | the workspace API, the collector, then the service |
| Output formats | the workspace API and the host | the lease's list, re-checked before the commit |
| Archive safety | the host, before any parser | central-directory entry count, total expansion and ratio |
| Entry names | the host | no absolute, traversing, backslashed or controlled names; no duplicates |
| Macros | the host | `vbaProject.bin` and executable extensions are refused outright |
| External links | the host | `TargetMode="External"`, URI-scheme targets, and targets that leave the package |
| Symlinks | the worker, on staging | `lstat` on every staged entry; a symlink refuses the run |
| Traversal | the workspace API and the worker | single-path-segment names; the staged path must stay in staging |
| Undeclared effects | the worker | staging holds only declared names; a directory or stray file refuses |
| Sources unchanged | the worker and the host | inputs are hashed before and after; a change refuses |
| Credentials, no `HOME` | the host | the interpreter's environment is built from scratch and stripped |
| Network, shell, process | the worker, in process | an import guard plus socket and `os` patches (see below) |

An interpreter that cannot apply a limit says so: the worker reports which limits it applied, and the
receipt records the ones it could not. On macOS `RLIMIT_AS` cannot be lowered at all (`current limit
exceeds maximum limit`), so the memory limit is reported as **not enforced** there; on Linux it is
enforced.

A typed reply is bounded too. A deck-shaped result is intrinsically richer than a document-shaped one —
every package part has a hash, and a before/after preview is per slide — so the PowerPoint tools budget
32 KB of JSON where the Word tools budget 16 KB, rather than dropping evidence a reviewer needs. The
Excel tools budget 32 KB like the PowerPoint ones, because their review material is dense — every changed
cell carries its exact before and after, and every numeric check carries an exact sum — and that material
is the **last** thing to go: a reply gives up its preview lines first, then each part change's own XML
delta lines, the byte-identical parts' hash sample and the changed-cell map, and only then the dependency
list, the per-step evidence and the numeric checks — naming what it left out in an `omitted` list. The
whole result is always in the receipt.

## What is *not* enforced yet

The Python-level guards are a **bounded workspace, not a sandbox**. In particular:

- A `ctypes` call can reach libc `socket()`. The import guard blocks `ctypes`, `socket` and friends from
  submitted code, and the socket module's constructors are patched, but a reference smuggled out of a
  library would still work.
- The **filesystem cannot be confined in process at all**: `io.open` and `pathlib` are shared with the
  Paper libraries, and replacing them would break the libraries. Submitted code cannot call `open`, but
  a library function that takes a path can reach the host.
- The only host filesystem visible to a well-behaved run is the run directory, and only staging is
  writable — but a determined run is not stopped by permission bits.

[RASF-3111](https://linear.app/riseandshinefutures/issue/RASF-3111) (still Backlog) is what makes those
boundaries load-bearing: a read-only root filesystem, dropped capabilities, `no-new-privileges`,
`tmpfs` for `/tmp`, deny-all egress with an allowlist, and only the lease's directories mounted. Until
it lands, enable this capability only where a bounded workspace is acceptable, and treat the worker's
own `enforcement` field and the receipt's notes as the honest statement of what ran.

## The interpreter

There is no safe default, so the host names one:

```sh
packages/tools-paper-office/scripts/provision-worker.sh
export OFFICEHUM_PAPER_PYTHON="$PWD/packages/tools-paper-office/.worker/bin/python"
```

`requirements.lock` is the frozen install set — `paper-docx==0.2.0`, `paper-pptx==0.2.0`,
`paper-xlsx==0.2.1` and their dependencies — and the worker **refuses to run** unless:

1. the interpreter is Python 3.13 (`interpreter-version` otherwise), and
2. all three sentinels — `paper_docx_doctor`, `paper_pptx_doctor`, `paper_xlsx_doctor` — import and
   `verify_install()` reports the pinned version (`doctor-missing` / `doctor-failed` otherwise).

That second gate is what keeps a fork and its upstream package from ever being importable together:
each fork installs the upstream import name (`docx`, `pptx`, `openpyxl`) and its sentinel raises
`DoctorError` when both are present. Never install these beside `python-docx`, `python-pptx` or
`openpyxl`.

Newer releases exist (`paper-docx` 0.2.1, `paper-pptx` 0.2.1, `paper-xlsx` 0.2.2); this package honours
the versions the issue pinned. Move them here and in `PAPER_LIBRARY_PINS` together, and re-run the
all-format fixtures, because the receipt records the pins.

Tests that need a real interpreter **skip visibly** when `OFFICEHUM_PAPER_PYTHON` is unset — no test
guesses at a path, and no test touches the network. The typed Word tests follow the same rule:
`word-operations.test.ts`, `word-tools.test.ts` and the two refusal fixtures in `word-fixtures.test.ts`
run in both configurations (the package inspection is in process), and the interpreter-backed Word
fixtures — read, draft, edit, preservation, replay, portability — skip visibly without it. The typed
PowerPoint tests do the same: `pptx-operations.test.ts` always runs, `pptx-fixtures.test.ts` runs its
three no-interpreter refusal fixtures in both configurations and skips its eleven interpreter-backed
fixtures with a named reason when no interpreter is configured. The typed Excel tests do the same:
`xlsx-operations.test.ts` always runs, and `xlsx-fixtures.test.ts` runs its four no-interpreter refusal
fixtures (a malformed archive, a VBA project, an external relationship, an ungranted reference) in both
configurations while its ten interpreter-backed fixtures skip visibly without one.

## What later issues add

`DocumentService` is deliberately small. RASF-3283 landed the Python workspace operation, RASF-3300 the
typed Word operations on it, RASF-3284 the typed PowerPoint operations, RASF-3301 the typed Excel
operations and RASF-3285 the review-and-publication gate above — all three format adapters are on this
same interface, and an existing file's published pointer now moves only behind a person's approval bound
to the exact hashes. RASF-3193 (the office file
store) replaces the in-package ledger's staging root with its own store, RASF-3111 replaces the
Python-level guards with container enforcement (and is the only route to a real renderer), and a review
surface that can render a before/after *picture* needs that same isolation.

The review gate adds four refusal codes of its own — `not-approved`, `denied`, `approval-mismatch` and
`stale-review` — because each is a different thing a person or a host must react to differently.

The typed Word tools added six refusal codes beside the ones RASF-3283 fixed —
`document-protected`, `malformed-package`, `unsupported-structure`, `boundary-violation`,
`target-not-found` and `ambiguous-target`. The typed PowerPoint tools add three more, because each is a
different thing a caller must react to differently: `stale-anchor` (the anchored content moved on),
`package-limit` (the archive has no single unambiguous reading) and `relationship-policy` (a
relationship graph cannot be carried across as asked). The typed Excel tools add one more —
`broken-reference`, for a reference this workbook cannot resolve, which only a spreadsheet has — and
share the macro and external-link codes the host already enforces structurally. All three adapters share
the five codes that mean the same thing to any format. A worker code the pack does not know still collapses to `worker-refused`, so
a new code cannot widen the contract silently.