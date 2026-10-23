# @officehum/tools-paper-office

A **task-leased Paper Office document workspace** for a Pi Durable role: a `DocumentService` a host
injects, an isolated Python 3.13 worker pinned to `paper-docx`, `paper-pptx` and `paper-xlsx`, the
portable `run_document_python` tool, and the typed Word operations built on top of it. It depends on Pi
Durable, `pi-ai` and `@officehum/sdk` (for the FileStore contract) — never on `@officehum/office` — so
the same pack runs in a bare Pi Durable harness with a fake service and inside Office Hum with the local
one.

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
fixtures — read, draft, edit, preservation, replay, portability — skip visibly without it.

## What later issues add

`DocumentService` is deliberately small. RASF-3283 lands the Python workspace operation and RASF-3300
lands the typed Word operations on it. The PowerPoint adapter (RASF-3284) and the Excel adapter
(RASF-3301) arrive on this same interface, and RASF-3285 adds `publish_document` — until it lands,
nothing in this pack can publish: every new document is a draft and every edit is a proposal.
RASF-3193 (the office file store) replaces the in-package ledger's staging root with its own store, and
RASF-3111 replaces the Python-level guards with container enforcement.

The typed Word tools add six refusal codes beside the ones RASF-3283 fixed — `document-protected`,
`malformed-package`, `unsupported-structure`, `boundary-violation`, `target-not-found` and
`ambiguous-target` — because each is a different thing a caller must react to differently. A worker code
the pack does not know still collapses to `worker-refused`, so a new code cannot widen the contract
silently.