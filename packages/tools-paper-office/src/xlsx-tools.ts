/**
 * The typed Excel tools, as Pi Durable registrations.
 *
 * Six tools — `inspect_workbook`, `read_workbook`, `create_workbook`, `edit_workbook`,
 * `preview_workbook`, `compare_workbook` — on the same `DocumentService` the Python workspace uses.
 * Each one validates its arguments, resolves every file reference against the task's lease, and runs a
 * fixed Python operation through `runDocumentPython`, so a typed call and a submitted snippet share
 * the same receipts, the same staging, the same package inspection and the same idempotency.
 *
 * The operation ID comes from the Pi Durable conversation and call identity, never from an argument:
 * a model cannot choose its own replay identity. The rules the tools enforce, and where:
 *
 * - **A lease, not a path.** A file reference is a FileStore id with the version, name, hash and size
 *   the lease pinned; all five are checked against the lease before the run. A reference the lease
 *   does not grant is `ungranted-input`, and the output is one staging file name, never a directory.
 * - **Drafts and proposals, never publications.** `create_workbook` writes a new file (a draft);
 *   `edit_workbook` proposes a new immutable version of a leased workbook and leaves it unpublished.
 *   Both report `published: false`, and the result validator refuses anything else.
 * - **Bounded only.** `read_workbook` and `preview_workbook` answer with a page: page size, cursor and
 *   total. The validator refuses a page that is inconsistent with itself, and a section's items are
 *   validated against the section that promised them.
 * - **Nothing is edited in place.** Every mutating call commits a new immutable version; the source
 *   version is untouched, and one refusal leaves it byte-identical.
 * - **Figures come from the caller.** A `value` is written exactly as given — a model's arithmetic
 *   never reaches a cell, because this pack performs none: the only number it computes is an explicit
 *   sum of cells it names, reported in the diff as its own sum rather than as a recalculation.
 *
 * Two things these tools say plainly rather than implying:
 *
 * - **No calculation happens here.** `recalculation` reports `available`, `attempted: false`, the
 *   reason, and the functions the oracle would refuse even where it can run; the validator refuses a
 *   worker that claims a computed value or a spawned process.
 * - **Reference verification is evidence, not assurance.** A broken reference in a source is reported
 *   with where it is and what it names; an operation that would *create* one refuses with
 *   `broken-reference` and writes nothing.
 */

import { type TSchema, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type {
  DocumentRunCommitted,
  DocumentRunRefused,
  DocumentService,
} from "./document-service.js";
import { DocumentError } from "./errors.js";
import type { DocumentLease } from "./lease.js";
import { operationIdForCall } from "./operation.js";
import type { LeaseLookup } from "./run-document-python.js";
import {
  COMPARE_WORKBOOK,
  CREATE_WORKBOOK,
  EDIT_WORKBOOK,
  INSPECT_WORKBOOK,
  MAX_XLSX_PAGE,
  MAX_XLSX_SHEETS,
  PREVIEW_WORKBOOK,
  parseXlsxResult,
  READ_WORKBOOK,
  XLSX_OPERATIONS,
  XLSX_READ_SECTIONS,
  type XlsxChangeSet,
  type XlsxEditReceipt,
  type XlsxOperation,
  type XlsxPreservation,
  type XlsxProgram,
  type XlsxResult,
  xlsxProgram,
  xlsxResultRef,
} from "./xlsx-operations.js";

/**
 * The reply budget. An Excel result is dense — every changed cell carries its before and after, and
 * every numeric check carries an exact sum — so the budget is smaller than the PowerPoint tools' 32 KB
 * rather than larger: less survives trimming here, and anything above this is trimmed by
 * `boundedBody`, which names what it left out. The whole result is always in the receipt.
 */
const MAX_TOOL_TEXT = 32_000;

/** The keys a too-large reply gives up, in the order it gives them up. */
const DROPPABLE = ["editReceipt", "preservation", "reopened", "worker", "wrote"] as const;

/** What the Excel tools need: the injected service and the host's lease lookup. */
export interface XlsxToolOptions {
  readonly service: DocumentService;
  readonly leaseFor: (lookup: LeaseLookup) => Promise<DocumentLease | undefined>;
}

// -- schemas ---------------------------------------------------------------------------------------

const FileRef = Type.Object(
  {
    fileId: Type.String({ minLength: 1, description: "The FileStore file id the lease pinned." }),
    versionId: Type.String({
      minLength: 1,
      description: "The immutable version id the lease pinned.",
    }),
    name: Type.String({ minLength: 1, description: "The leased file name, e.g. close.xlsx." }),
    sha256: Type.String({
      minLength: 1,
      description: "The version's sha256, as the lease pinned it.",
    }),
    size: Type.Integer({ minimum: 0, description: "The version's size in bytes." }),
  },
  { additionalProperties: false },
);

const StyleSchema = Type.Object(
  {
    bold: Type.Optional(Type.Boolean()),
    italic: Type.Optional(Type.Boolean()),
    size: Type.Optional(
      Type.Number({ minimum: 1, maximum: 400, description: "Font size in points." }),
    ),
    name: Type.Optional(Type.String({ minLength: 1, description: "Font name." })),
    color: Type.Optional(
      Type.String({ description: "Font colour, six hexadecimal digits such as FF0000." }),
    ),
    fillColor: Type.Optional(
      Type.String({ description: "Solid fill colour, six hexadecimal digits such as DDEEFF." }),
    ),
    numberFormat: Type.Optional(
      Type.String({ description: "A number format code, e.g. #,##0.00 or 0.00%." }),
    ),
    horizontal: Type.Optional(
      Type.Union(
        [
          Type.Literal("left"),
          Type.Literal("center"),
          Type.Literal("right"),
          Type.Literal("fill"),
          Type.Literal("justify"),
        ],
        { description: "Horizontal alignment." },
      ),
    ),
    vertical: Type.Optional(
      Type.Union(
        [
          Type.Literal("top"),
          Type.Literal("center"),
          Type.Literal("bottom"),
          Type.Literal("justify"),
        ],
        { description: "Vertical alignment." },
      ),
    ),
    wrapText: Type.Optional(Type.Boolean()),
  },
  {
    additionalProperties: false,
    description:
      "Formatting to set. Only the fields given are applied, and only to the range named beside them.",
  },
);

const StyleTargetSchema = Type.Object(
  { range: Type.String({ minLength: 1 }), style: StyleSchema },
  { additionalProperties: false },
);

const NameSchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      description: "The defined name, e.g. RevenueTotal.",
    }),
    reference: Type.String({
      minLength: 1,
      description:
        "The range it names, with its sheet, e.g. Revenue!$B$2. A reference to a sheet the workbook " +
        "does not have is refused before it is written.",
    }),
    scope: Type.Optional(
      Type.Union([Type.Literal("workbook"), Type.Literal("sheet")], {
        description: "Workbook-scoped (default) or scoped to the sheet its reference names.",
      }),
    ),
  },
  { additionalProperties: false },
);

const ColumnWidthSchema = Type.Object(
  {
    column: Type.Optional(Type.String({ description: "One column letter, e.g. B." })),
    columns: Type.Optional(
      Type.Array(Type.String(), { maxItems: 64, description: "Up to 64 column letters." }),
    ),
    width: Type.Number({
      minimum: 0,
      maximum: 255,
      description: "Column width in characters, as Excel reports it.",
    }),
  },
  { additionalProperties: false },
);

const CellValue = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()], {
  description:
    "One literal: a string, number, boolean, or null to clear the cell. The value is written exactly " +
    "as given — this pack does no arithmetic on it. A string beginning with = must use `formula`.",
});

const StepSchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal("setCell"),
        sheet: Type.Optional(
          Type.String({ minLength: 1, description: "The sheet; omitted uses the first sheet." }),
        ),
        cell: Type.String({ minLength: 1, description: "One A1 address, e.g. B7." }),
        value: Type.Optional(CellValue),
        formula: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "A formula beginning with =, such as =SUM(B2:B5). Its references are verified before " +
              "anything is written.",
          }),
        ),
      },
      {
        additionalProperties: false,
        description: "Write one cell: exactly one of value or formula.",
      },
    ),
    Type.Object(
      {
        kind: Type.Literal("setRange"),
        sheet: Type.Optional(Type.String({ minLength: 1 })),
        range: Type.String({
          minLength: 1,
          description: "The block it fills, e.g. A1:C4. It must match the rows exactly.",
        }),
        rows: Type.Array(Type.Array(CellValue), {
          minItems: 1,
          description: "Literal values, one array per row, all the same width.",
        }),
      },
      {
        additionalProperties: false,
        description: "Write a rectangular block of literals. A formula uses setCell.",
      },
    ),
    Type.Object(
      {
        kind: Type.Literal("clearCells"),
        sheet: Type.Optional(Type.String({ minLength: 1 })),
        range: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false, description: "Clear the values in a range; styles stay." },
    ),
    Type.Object(
      {
        kind: Type.Literal("setStyle"),
        sheet: Type.Optional(Type.String({ minLength: 1 })),
        range: Type.String({ minLength: 1 }),
        style: StyleSchema,
      },
      { additionalProperties: false, description: "Apply formatting to a range." },
    ),
    Type.Object(
      {
        kind: Type.Literal("setColumnWidth"),
        sheet: Type.Optional(Type.String({ minLength: 1 })),
        column: Type.Optional(Type.String({ minLength: 1 })),
        columns: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
        width: Type.Number({ minimum: 0, maximum: 255 }),
      },
      { additionalProperties: false, description: "Set one or more column widths." },
    ),
    Type.Object(
      {
        kind: Type.Literal("addSheet"),
        name: Type.String({ minLength: 1, description: "The new sheet's name; must be free." }),
        at: Type.Optional(Type.Integer({ minimum: 0, description: "Move it to this position." })),
      },
      { additionalProperties: false, description: "Add a sheet to the workbook." },
    ),
    Type.Object(
      {
        kind: Type.Literal("deleteSheet"),
        sheet: Type.String({ minLength: 1 }),
      },
      {
        additionalProperties: false,
        description:
          "Delete a sheet. Refused with broken-reference when anything on another sheet still points " +
          "at it, naming every reference.",
      },
    ),
    Type.Object(
      {
        kind: Type.Literal("renameSheet"),
        sheet: Type.String({ minLength: 1 }),
        to: Type.String({ minLength: 1, description: "The new name; must be free." }),
      },
      {
        additionalProperties: false,
        description:
          "Rename a sheet; the references that name it are rewritten with it, so nothing is left " +
          "pointing at the old title.",
      },
    ),
    Type.Object(
      {
        kind: Type.Literal("setName"),
        name: Type.String({ minLength: 1 }),
        reference: Type.String({
          minLength: 1,
          description: "The range it names, with its sheet, e.g. Revenue!$B$2.",
        }),
        scope: Type.Optional(Type.Union([Type.Literal("workbook"), Type.Literal("sheet")])),
      },
      {
        additionalProperties: false,
        description: "Define a named range. A reference that points nowhere is refused.",
      },
    ),
    Type.Object(
      {
        kind: Type.Literal("removeName"),
        name: Type.String({ minLength: 1 }),
        scope: Type.Optional(Type.Union([Type.Literal("workbook"), Type.Literal("sheet")])),
        sheet: Type.Optional(
          Type.String({ minLength: 1, description: "The sheet, for a sheet-scoped name." }),
        ),
      },
      {
        additionalProperties: false,
        description:
          "Remove a defined name. Refused with broken-reference when a formula still uses it.",
      },
    ),
  ],
  {
    description:
      "One edit step. Steps apply in the order given, each validating its own target before anything " +
      "is written; the workbook's references are verified afterwards, and a step that would leave a " +
      "reference pointing nowhere refuses the whole edit.",
  },
);

const SheetSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, description: "The sheet's name." }),
    rows: Type.Array(Type.Array(CellValue), {
      minItems: 1,
      description:
        "The values to write, row by row from `at`. A string beginning with = is written as a " +
        "formula; every other value is written exactly as given.",
    }),
    at: Type.Optional(Type.String({ description: "The top-left cell of the block, default A1." })),
    styles: Type.Optional(Type.Array(StyleTargetSchema, { maxItems: 64 })),
    names: Type.Optional(Type.Array(NameSchema, { maxItems: 64 })),
    columnWidths: Type.Optional(Type.Array(ColumnWidthSchema, { maxItems: 64 })),
    freeze: Type.Optional(
      Type.String({ description: "Freeze panes at this cell, e.g. A2 freezes row 1." }),
    ),
  },
  { additionalProperties: false },
);

const paging = {
  cursor: Type.Optional(
    Type.Integer({ minimum: 0, description: "The nextCursor a previous page reported, or 0." }),
  ),
  pageSize: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_XLSX_PAGE,
      description: `1 to ${MAX_XLSX_PAGE} items per page.`,
    }),
  ),
};

const INSPECT_PARAMETERS = Type.Object(
  { ref: FileRef },
  { additionalProperties: false, description: "The leased .xlsx to inspect." },
);

const READ_PARAMETERS = Type.Object(
  {
    ref: FileRef,
    section: Type.Union(
      XLSX_READ_SECTIONS.map((section) => Type.Literal(section)),
      {
        description:
          "What to page through: sheets (order, size, protection), cells (with their formulas and " +
          "cached values), formulas (with every reference they make), names (defined ranges), styles, " +
          "or charts.",
      },
    ),
    sheet: Type.Optional(
      Type.String({
        minLength: 1,
        description: "The sheet to read: required for cells and styles, optional elsewhere.",
      }),
    ),
    range: Type.Optional(
      Type.String({
        description:
          "For the cells section: the block to read, e.g. Revenue!A1:C10 or A1:C10 beside `sheet`.",
      }),
    ),
    ...paging,
  },
  { additionalProperties: false, description: "A bounded page of one section of a leased .xlsx." },
);

const CREATE_PARAMETERS = Type.Object(
  {
    output: Type.String({
      minLength: 1,
      description: "The new draft's file name, e.g. close-summary.xlsx.",
    }),
    sheets: Type.Array(SheetSchema, { minItems: 1, maxItems: MAX_XLSX_SHEETS }),
  },
  { additionalProperties: false, description: "A new Excel draft, built from typed sheets." },
);

const EDIT_PARAMETERS = Type.Object(
  {
    ref: FileRef,
    output: Type.String({
      minLength: 1,
      description: "The proposal's file name, e.g. close-summary.xlsx.",
    }),
    steps: Type.Array(StepSchema, { minItems: 1 }),
  },
  {
    additionalProperties: false,
    description: "An edit of a leased .xlsx, as an unpublished proposal.",
  },
);

const PREVIEW_PARAMETERS = Type.Object(
  { ref: FileRef, ...paging },
  {
    additionalProperties: false,
    description: "A bounded structural preview of a leased .xlsx, one page of sheets at a time.",
  },
);

const COMPARE_PARAMETERS = Type.Object(
  { from: FileRef, to: FileRef },
  {
    additionalProperties: false,
    description: "Two leased .xlsx versions to diff: cells, formulas, styles and dependencies.",
  },
);

// -- descriptions ----------------------------------------------------------------------------------

const REF_NOTE = [
  "Every operation takes a **file reference** (`fileId`, `versionId`, `name`, `sha256`, `size`) from this",
  "task's lease or from an earlier operation's output. It never takes a path or a URL: a reference the",
  "lease does not grant is refused, and no operation can widen the lease.",
].join("\n");

const CALC_NOTE = [
  "**No calculation happens in this workspace.** `openpyxl.oracle` implements no formula engine — it",
  "delegates to headless LibreOffice, and this worker cannot spawn a process — so every result carries a",
  "`recalculation` block saying so, with the functions the oracle would refuse anyway. A cached value in",
  "a result is one the file already held, quoted with its source; the only number this pack computes is",
  "its own explicit sum of cells it names, reported as such.",
].join("\n");

const REFERENCE_NOTE = [
  "References are **verified**: every formula surface the library knows about — cells, defined names,",
  "print areas, validation, conditional formatting, table ranges and chart series — is resolved against",
  "the workbook's own sheets and names, and anything that cannot resolve is reported with where it is.",
  "An operation that would *create* a broken reference refuses with `broken-reference` and writes nothing.",
].join("\n");

const DESCRIPTIONS: Readonly<Record<XlsxOperation, string>> = {
  inspect: [
    "Summarise a leased Excel (.xlsx) workbook: sheet count and order with each sheet's size,",
    "protection and freeze state; cell, formula, styled-cell, table, merged-range and data-validation",
    "counts; the named ranges with the range each one names; the charts with their series references;",
    "and how many chart parts the package holds that this version does not model.",
    "",
    REF_NOTE,
    "",
    "- Read-only: nothing is written and no file is created.",
    "- The reply is bounded — the sheet outline, the named ranges and the charts are capped, and say so.",
    "- The workbook's references are verified and any that cannot resolve are reported, not repaired.",
    CALC_NOTE,
  ].join("\n"),
  read: [
    "Read a leased Excel (.xlsx) workbook in **bounded pages**: sheet order and size, cells with their",
    "formulas and cached values, the formulas with every reference each one makes, the named ranges, the",
    "styled cells, or the charts. Each answer carries a page size, the cursor it started at, the",
    "section's total, and the next cursor, so a large workbook is walked page by page.",
    "",
    REF_NOTE,
    "",
    '- `section: "cells"` reads a range (`A1:C10`, or `Revenue!A1:C10`); omitting it reads the sheet\'s',
    "  used window, and the answer says when that window was narrowed and why.",
    '- `section: "cells"` reports a formula cell\'s text and, when the package holds one, the value it',
    "  *cached* — marked `cachedKnown`, and never recomputed.",
    '- `section: "formulas"` reports each formula\'s references with whether each resolved, so a broken',
    "  one is visible where a reviewer will look.",
    "- Read-only: nothing is written.",
  ].join("\n"),
  create: [
    "Create a new Excel (.xlsx) **draft** from typed sheets: names, blocks of literal values,",
    "formulas, styles, named ranges, column widths and a frozen pane. The draft is a new immutable",
    "file — it has no source version and nothing publishes it.",
    "",
    "- `output` is a single file name; the task's lease decides whether an xlsx output is permitted.",
    "- A value is written exactly as given: a figure comes from your source data or your code, never",
    "  from arithmetic this pack performs. A defined name that points at a sheet the workbook does not",
    "  have is refused before it is written.",
    "- **Charts are read here, not drawn**: a chart is added by the data pack (RASF-3204), so no",
    "  operation of this adapter creates one.",
    "- The result reports the draft's name and sha256, the structure it built, where each sheet's",
    "  content landed, and a reopen witness.",
    CALC_NOTE,
  ].join("\n"),
  edit: [
    "Edit a leased Excel (.xlsx) workbook into an **unpublished proposal**, as a new immutable version.",
    "The source version is never modified; the proposal stays unpublished until the review surface",
    "(RASF-3285) publishes it.",
    "",
    REF_NOTE,
    "",
    "- Steps: `setCell`, `setRange`, `clearCells`, `setStyle`, `setColumnWidth`, `addSheet`,",
    "  `deleteSheet`, `renameSheet`, `setName`, `removeName`. They apply in the order given; each",
    "  validates its own target before anything is written.",
    "- The result reports source and output sha256, the fork's own edit receipt (the changed-cell set",
    "  keyed by the part that holds each cell), the structural change set with each part's before and",
    "  after sha256, and a reopen witness.",
    "- The cell and formula diff, the style diff, the affected dependencies and explicit numeric checks",
    "  are reported for review: each changed cell with its exact before and after, the formulas that",
    "  read a changed cell, and this adapter's own exact sum of the cells a `SUM` names beside the value",
    "  the file cached.",
    "- Untouched parts come back byte-identical — other sheets, charts, drawings and the theme — because",
    "  the edit saves through the fork's preserve-mode splice rather than re-serializing the workbook.",
    REFERENCE_NOTE,
    CALC_NOTE,
  ].join("\n"),
  preview: [
    "Preview a leased Excel (.xlsx) workbook as bounded, **structural** sheet previews: `V:`/`F:`/`S:`",
    "lines for values, formulas and styled cells, `N:` for a named range, `T:` for a table, `C:` for a",
    "chart, `M:` for a merged range and `AF:` for an autofilter. Paged by sheet.",
    "",
    REF_NOTE,
    "",
    "- Read-only: nothing is written. A preview is derived from the exact leased version, not a path.",
    CALC_NOTE,
  ].join("\n"),
  compare: [
    "Diff two leased Excel (.xlsx) versions: the structural change set (parts added, removed, changed",
    "and left byte-identical, each hashed before and after), the cell and formula diff, the style diff,",
    "the formulas that depend on a changed cell, and **explicit numeric checks** for each change.",
    "",
    REF_NOTE,
    "",
    "- Use it to review a proposal against the version it came from, before anyone publishes.",
    "- Both versions must be leased to this task, and both have their references verified.",
    CALC_NOTE,
  ].join("\n"),
};

// -- the tools -------------------------------------------------------------------------------------

/**
 * The six typed Excel tools. Every one is `replay: "safe"`: the service is idempotent by operation ID,
 * so an interrupted call that reruns resolves to the same committed receipt instead of a second edit.
 */
export function xlsxTools(options: XlsxToolOptions): readonly ToolRegistration[] {
  return [
    xlsxTool("inspect", INSPECT_WORKBOOK, INSPECT_PARAMETERS, options),
    xlsxTool("read", READ_WORKBOOK, READ_PARAMETERS, options),
    xlsxTool("create", CREATE_WORKBOOK, CREATE_PARAMETERS, options),
    xlsxTool("edit", EDIT_WORKBOOK, EDIT_PARAMETERS, options),
    xlsxTool("preview", PREVIEW_WORKBOOK, PREVIEW_PARAMETERS, options),
    xlsxTool("compare", COMPARE_WORKBOOK, COMPARE_PARAMETERS, options),
  ];
}

/** A type alias, not an interface, so it keeps the implicit index signature `JsonValue` needs. */
type XlsxToolDetails = {
  operationId: string;
  operation: string;
  files?: string[];
  worker?: string;
  truncated?: boolean;
  code?: string;
};

type XlsxToolResult = {
  readonly output: { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
  readonly details: XlsxToolDetails;
};

function xlsxTool(
  operation: XlsxOperation,
  name: string,
  parameters: TSchema,
  options: XlsxToolOptions,
): ToolRegistration {
  return defineTool({
    name,
    description: DESCRIPTIONS[operation],
    parameters,
    replay: "safe",
    execute: async (args: unknown, api): Promise<XlsxToolResult> => {
      const taskId = String(api.taskId);
      const conversationId = String(api.conversationId);
      const operationId = operationIdForCall({ conversationId, callId: api.callId });

      const lease = await options.leaseFor({ taskId, conversationId });
      if (lease === undefined) {
        return refusalResult(
          operation,
          operationId,
          "no-lease",
          "this task has no document lease, so no Excel file was granted. Ask the host for one.",
        );
      }

      let program: XlsxProgram;
      try {
        program = xlsxProgram(operation, args, lease);
      } catch (error) {
        return refused(error, operation, operationId);
      }

      const outcome = await options.service.runDocumentPython({
        operationId,
        taskId,
        lease,
        code: program.code,
        arguments: program.arguments,
      });
      if (outcome.kind === "refused") return refusedOutcome(outcome, operation);

      try {
        const result = parseXlsxResult(
          operation,
          outcome.receipt.result,
          program.sources.map(xlsxResultRef),
        );
        return committed(operation, operationId, taskId, outcome, result);
      } catch (error) {
        return refused(error, operation, operationId);
      }
    },
  }) as unknown as ToolRegistration;
}

function committed(
  operation: XlsxOperation,
  operationId: string,
  taskId: string,
  outcome: DocumentRunCommitted,
  result: XlsxResult,
): XlsxToolResult {
  const receipt = outcome.receipt;
  const compose = (value: XlsxResult | null): Record<string, unknown> => ({
    ok: true,
    operation,
    operationId,
    taskId,
    ...(value === null ? {} : { result: value }),
    wrote: receipt.outputs.map((entry) => ({
      fileId: entry.fileId,
      versionId: entry.versionId,
      name: entry.name,
      format: entry.format,
      size: entry.size,
      sha256: entry.sha256,
      versionOf: entry.sourceVersionId,
    })),
    read: receipt.reads.map((entry) => ({
      fileId: entry.fileId,
      versionId: entry.versionId,
      name: entry.name,
      sha256: entry.sha256,
    })),
    reopened: receipt.reopen,
    worker: { python: receipt.worker.python, libraries: receipt.worker.libraries },
    notes: receipt.notes,
  });
  const { text, truncated } = boundedBody(compose, result);
  return {
    output: [{ type: "text", text }],
    details: {
      operationId,
      operation,
      files: receipt.outputs.map((entry) => entry.fileId),
      worker: receipt.worker.image,
      ...(truncated ? { truncated: true } : {}),
    },
  };
}

/**
 * A reply a model reads is JSON, so trimming it must keep it JSON. When a body does not fit, the verbose
 * review material goes first — counts, hashes, the change set and the file ids all stay — then the
 * droppable keys in priority order, and the body names what it left out. Slicing the string instead
 * would leave a model with a sheet it cannot parse and no way to tell.
 */
function boundedBody(
  compose: (value: XlsxResult | null) => Record<string, unknown>,
  result: XlsxResult,
): { text: string; truncated: boolean } {
  const fits = (value: Record<string, unknown>): boolean =>
    JSON.stringify(value, null, 2).length <= MAX_TOOL_TEXT;
  const full = compose(result);
  if (fits(full)) return { text: JSON.stringify(full, null, 2), truncated: false };

  const omitted: string[] = [
    "the preview lines, which preview_workbook and read_workbook page",
    "the byte-identical parts' hash sample and each part change's own detail lines, which the change",
    "set, the edit receipt and the receipt's own record all hold",
  ];
  let body = compose(light(result));
  if (!fits(body)) {
    body = compose(reduced(result));
    omitted.push(
      "the dependency list, the per-step change evidence and the per-cell numeric checks",
    );
  }
  for (const key of DROPPABLE) {
    if (fits(body)) break;
    if (key in body) {
      delete body[key];
      omitted.push(key);
    }
  }
  if (!fits(body)) {
    return {
      text: JSON.stringify(
        {
          ok: true,
          operation: result.operation,
          truncated: true,
          omitted:
            "every field; the run ledger holds the receipt and the versions hold the artifacts",
        },
        null,
        2,
      ),
      truncated: true,
    };
  }
  body.omitted = omitted;
  body.truncated = true;
  return { text: JSON.stringify(body, null, 2), truncated: true };
}

/**
 * The result with its verbose per-part material reduced to the counts that describe it.
 *
 * The *review* material — the changed cells, the explicit numeric checks and the dependencies — stays:
 * a person deciding whether to approve a proposal needs those, and they are the reason the tool answer
 * is worth reading at all. What goes first is the repetition around them: each part's own XML delta
 * lines and the hash sample of every byte-identical part.
 */
function light(result: XlsxResult): XlsxResult {
  switch (result.operation) {
    case "edit":
      return {
        ...result,
        changeSet: withoutPartDetail(result.changeSet),
        preservation: withoutPartHashes(result.preservation),
        editReceipt: withoutCellMap(result.editReceipt),
      };
    case "compare":
      return {
        ...result,
        changeSet: withoutPartDetail(result.changeSet),
        preservation: withoutPartHashes(result.preservation),
      };
    case "preview":
      return {
        ...result,
        page: {
          ...result.page,
          items: result.page.items.map((sheet) => ({
            ...sheet,
            lines: [],
            linesTruncated: true,
          })),
        },
      };
    case "inspect":
      return { ...result, sheetOutline: [], namedRanges: [], chartOutline: [] };
    default:
      return result;
  }
}

/** The light result with its dependencies, numeric checks and step evidence removed too. */
function reduced(result: XlsxResult): XlsxResult {
  const lighter = light(result);
  if (lighter.operation === "edit") {
    return {
      ...lighter,
      changes: lighter.changes.map((change) => ({ ...change, evidence: {} })),
      diff: { ...lighter.diff, dependencies: [], numericChecks: [], numericChecksTruncated: true },
    };
  }
  if (lighter.operation === "compare") {
    return {
      ...lighter,
      diff: { ...lighter.diff, dependencies: [], numericChecks: [], numericChecksTruncated: true },
    };
  }
  return lighter;
}

function withoutPartHashes(preservation: XlsxPreservation): XlsxPreservation {
  return {
    ...preservation,
    byteIdentical: [],
    byteIdenticalHashed: 0,
    byteIdenticalTruncated: true,
  };
}

function withoutPartDetail(changeSet: XlsxChangeSet): XlsxChangeSet {
  return {
    ...changeSet,
    changed: changeSet.changed.map((change) => ({ ...change, detail: [] })),
  };
}

function withoutCellMap(receipt: XlsxEditReceipt): XlsxEditReceipt {
  return {
    ...receipt,
    cellsChanged: { parts: {}, total: receipt.cellsChanged.total, truncated: true },
  };
}

function refusedOutcome(outcome: DocumentRunRefused, operation: XlsxOperation): XlsxToolResult {
  return refusalResult(operation, outcome.operationId, outcome.code, outcome.message);
}

function refused(error: unknown, operation: XlsxOperation, operationId: string): XlsxToolResult {
  if (error instanceof DocumentError) {
    return refusalResult(operation, operationId, error.code, error.message);
  }
  throw error;
}

function refusalResult(
  operation: XlsxOperation,
  operationId: string,
  code: string,
  message: string,
): XlsxToolResult {
  return {
    output: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, operation, operationId, code, message }, null, 2),
      },
    ],
    isError: true,
    details: { operationId, operation, code },
  };
}

/** The typed tools' names, in the order they are registered. */
export const XLSX_TOOL_REGISTRATIONS = [
  INSPECT_WORKBOOK,
  READ_WORKBOOK,
  CREATE_WORKBOOK,
  EDIT_WORKBOOK,
  PREVIEW_WORKBOOK,
  COMPARE_WORKBOOK,
] as const;

/** Every typed operation, in the order the tools register them. Used by the contract tests. */
export const XLSX_TOOL_ORDER: readonly XlsxOperation[] = XLSX_OPERATIONS;
