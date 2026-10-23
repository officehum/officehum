/**
 * The typed Word tools, as Pi Durable registrations.
 *
 * Six tools — `inspect_document`, `read_document`, `create_document`, `edit_document`,
 * `preview_document`, `compare_document` — on the same `DocumentService` the Python workspace uses.
 * Each one validates its arguments, resolves every file reference against the task's lease, and runs a
 * fixed Python operation through `runDocumentPython`, so a typed call and a submitted snippet share the
 * same receipts, the same staging, the same package inspection and the same idempotency.
 *
 * The operation ID comes from the Pi Durable conversation and call identity, never from an argument: a
 * model cannot choose its own replay identity. The rules the tools enforce, and where:
 *
 * - **A lease, not a path.** A file reference is a FileStore id with the version, name, hash and size the
 *   lease pinned; all five are checked against the lease before the run. A reference the lease does not
 *   grant is `ungranted-input`, and the output is one staging file name, never a directory.
 * - **Drafts and proposals, never publications.** `create_document` writes a new file (a draft);
 *   `edit_document` proposes a new immutable version of a leased file and leaves it unpublished. Both
 *   report `published: false`, and the result validator refuses anything else.
 * - **Bounded only.** `read_document` and `preview_document` answer with a page: page size, cursor and
 *   total. The validator refuses a page that is inconsistent with itself.
 * - **Nothing is edited in place.** Every mutating call commits a new immutable version; the source
 *   version is untouched, and one refusal leaves it byte-identical.
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
  COMPARE_DOCUMENT,
  CREATE_DOCUMENT,
  EDIT_DOCUMENT,
  INSPECT_DOCUMENT,
  MAX_WORD_PAGE,
  PREVIEW_DOCUMENT,
  parseWordResult,
  READ_DOCUMENT,
  type WordDiff,
  type WordOperation,
  type WordProgram,
  type WordRedline,
  type WordResult,
  wordProgram,
  wordResultRef,
} from "./word-operations.js";

const MAX_TOOL_TEXT = 16_000;

/** The keys a too-large reply gives up, in the order it gives them up. */
const DROPPABLE = ["read", "notes", "reopened", "worker", "wrote"] as const;

/** What the Word tools need: the injected service and the host's lease lookup. */
export interface WordToolOptions {
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
    name: Type.String({ minLength: 1, description: "The leased file name, e.g. brief.docx." }),
    sha256: Type.String({
      minLength: 1,
      description: "The version's sha256, as the lease pinned it.",
    }),
    size: Type.Integer({ minimum: 0, description: "The version's size in bytes." }),
  },
  { additionalProperties: false },
);

const AnchorText = Type.Object(
  {
    text: Type.String({
      minLength: 1,
      description:
        "The exact text of one paragraph. Paper refuses when it matches nothing, or more than once.",
    }),
  },
  { additionalProperties: false },
);

const AnchorBlock = Type.Object(
  {
    story: Type.String({ minLength: 1, description: "The story part, e.g. word/document.xml." }),
    index: Type.Integer({ minimum: 0, description: "The block index read_document reported." }),
    contentHash: Type.String({
      minLength: 8,
      description: "The block's contentHash from read_document; a mismatch refuses as stale.",
    }),
  },
  { additionalProperties: false },
);

const Anchor = Type.Union([AnchorText, AnchorBlock], {
  description:
    "Where the edit lands: by exact paragraph text, or by a block read_document reported.",
});

const tracked = Type.Optional(
  Type.Boolean({
    description: "Record a Word revision (default true for paragraphs, so the redline is real).",
  }),
);
const author = Type.Optional(
  Type.String({
    minLength: 1,
    description: "Who the change is attributed to. Defaults to the call's author.",
  }),
);
const date = Type.Optional(
  Type.String({ minLength: 1, description: "ISO 8601 instant to stamp the revision with." }),
);

const StepSchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal("insertSection"),
        anchor: Anchor,
        heading: Type.String({ minLength: 1 }),
        paragraphs: Type.Array(Type.String(), { minItems: 1 }),
        headingStyle: Type.Optional(Type.String()),
        bodyStyle: Type.Optional(Type.String()),
        tracked,
        author,
        date,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("replaceParagraphs"),
        anchor: Anchor,
        paragraphs: Type.Array(Type.String(), { minItems: 1 }),
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
        bodyStyle: Type.Optional(Type.String()),
        tracked,
        author,
        date,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("deleteParagraphs"),
        anchor: Anchor,
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
        tracked,
        author,
        date,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("replaceText"),
        needle: Type.String({ minLength: 1 }),
        text: Type.String({
          description: "The replacement, or the empty string to delete the match.",
        }),
        story: Type.Optional(Type.String()),
        nth: Type.Optional(Type.Integer({ minimum: 1 })),
        tracked,
        author,
        date,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("updateCell"),
        nearText: Type.String({
          minLength: 1,
          description: "Text in the table to edit, matched uniquely.",
        }),
        row: Type.Integer({ minimum: 0 }),
        column: Type.Integer({ minimum: 0 }),
        text: Type.String(),
        tracked,
        author,
        date,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("insertRow"),
        nearText: Type.String({ minLength: 1 }),
        row: Type.Integer({ minimum: 0, description: "Insert after this 0-based row." }),
        values: Type.Array(Type.String(), { minItems: 1 }),
        copyFormatFrom: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("deleteRow"),
        nearText: Type.String({ minLength: 1 }),
        row: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("addComment"),
        anchor: Anchor,
        text: Type.String({ minLength: 1 }),
        author,
        date,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("replyComment"),
        commentId: Type.Integer({ minimum: 0 }),
        text: Type.String({ minLength: 1 }),
        author,
        date,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("resolveComment"),
        commentId: Type.Integer({ minimum: 0 }),
        resolved: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal("deleteComment"), commentId: Type.Integer({ minimum: 0 }) },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("acceptRevisions"),
        revisionAuthor: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("rejectRevisions"),
        revisionAuthor: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
  ],
  { description: "One edit step. Steps apply in the order given, each validating its own anchor." },
);

const BlockSchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal("heading"),
        text: Type.String({ minLength: 1 }),
        level: Type.Integer({ minimum: 0, maximum: 9, description: "0 is Title, 1 is Heading 1." }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("paragraph"),
        text: Type.String({ minLength: 1 }),
        style: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("list"),
        items: Type.Array(Type.String(), { minItems: 1 }),
        listKind: Type.Optional(Type.Union([Type.Literal("bullet"), Type.Literal("decimal")])),
        level: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("table"),
        rows: Type.Array(Type.Array(Type.String()), { minItems: 1 }),
        style: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    Type.Object({ kind: Type.Literal("pageBreak") }, { additionalProperties: false }),
  ],
  { description: "One block of a new draft, applied in order." },
);

const paging = {
  cursor: Type.Optional(
    Type.Integer({ minimum: 0, description: "The nextCursor a previous page reported, or 0." }),
  ),
  pageSize: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_WORD_PAGE,
      description: `1 to ${MAX_WORD_PAGE} items per page.`,
    }),
  ),
};

const INSPECT_PARAMETERS = Type.Object(
  { ref: FileRef },
  { additionalProperties: false, description: "The leased .docx to inspect." },
);

const READ_PARAMETERS = Type.Object(
  {
    ref: FileRef,
    section: Type.Union(
      [
        Type.Literal("blocks"),
        Type.Literal("paragraphs"),
        Type.Literal("headings"),
        Type.Literal("tables"),
        Type.Literal("comments"),
        Type.Literal("revisions"),
      ],
      {
        description:
          "What to page through: blocks, paragraphs, headings, tables, comments or revisions.",
      },
    ),
    ...paging,
    includeCells: Type.Optional(
      Type.Boolean({ description: "For the tables section: include each table's cell text." }),
    ),
  },
  { additionalProperties: false, description: "A bounded page of one section of a leased .docx." },
);

const CREATE_PARAMETERS = Type.Object(
  {
    output: Type.String({
      minLength: 1,
      description: "The new draft's file name, e.g. close-summary.docx.",
    }),
    blocks: Type.Array(BlockSchema, { minItems: 1 }),
  },
  { additionalProperties: false, description: "A new Word draft, built from typed blocks." },
);

const EDIT_PARAMETERS = Type.Object(
  {
    ref: FileRef,
    output: Type.String({
      minLength: 1,
      description: "The proposal's file name, e.g. close-summary.docx.",
    }),
    steps: Type.Array(StepSchema, { minItems: 1 }),
    author: Type.String({ minLength: 1, description: "Who the edit is attributed to." }),
    date: Type.Optional(
      Type.String({ minLength: 1, description: "ISO 8601 instant for the revisions." }),
    ),
    acknowledgeProtection: Type.Optional(
      Type.Boolean({
        description:
          "Set only after reviewing why the source is protected: without it a protected document refuses.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description: "An edit of a leased .docx, as an unpublished proposal.",
  },
);

const PREVIEW_PARAMETERS = Type.Object(
  { ref: FileRef, ...paging },
  {
    additionalProperties: false,
    description: "A bounded text and structure preview of a leased .docx.",
  },
);

const COMPARE_PARAMETERS = Type.Object(
  { from: FileRef, to: FileRef },
  { additionalProperties: false, description: "Two leased .docx versions to diff and redline." },
);

// -- descriptions ----------------------------------------------------------------------------------

const REF_NOTE = [
  "Every operation takes a **file reference** (`fileId`, `versionId`, `name`, `sha256`, `size`) from this",
  "task's lease or from an earlier operation's output. It never takes a path or a URL: a reference the",
  "lease does not grant is refused, and no operation can widen the lease.",
].join("\n");

const DESCRIPTIONS: Readonly<Record<WordOperation, string>> = {
  inspect: [
    "Summarise a leased Word (.docx) document: story parts, block and paragraph counts, the heading",
    "outline, table shapes, comments with their thread state, tracked changes by type, the document's",
    "protection state, and which structure the reader could not see into.",
    "",
    REF_NOTE,
    "",
    "- Read-only: nothing is written and no file is created.",
    "- The reply is bounded — the heading outline and the table and comment lists are capped, and say so.",
    "- The `document.protection` block reports `w:documentProtection`; `editsBlocked` says whether a",
    "  later edit would refuse.",
  ].join("\n"),
  read: [
    "Read a leased Word (.docx) document in **bounded pages**: paragraphs, headings, tables, comments or",
    "tracked changes. Each answer carries a page size, the cursor it started at, the section's total, and",
    "the next cursor, so a long document is walked page by page rather than dumped into one reply.",
    "",
    REF_NOTE,
    "",
    '- `section: "comments"` reports thread state, resolution and the anchored text.',
    '- `section: "revisions"` reports every tracked change with its type, author and resolvability, and',
    "  whether it is a paragraph-mark revision.",
    "- Every block item carries `anchor` (story, index, contentHash) so `edit_document` can address it.",
    "- Read-only: nothing is written.",
  ].join("\n"),
  create: [
    "Create a new Word (.docx) **draft** from typed blocks: headings, paragraphs, bullet or decimal lists,",
    "tables and page breaks. The draft is a new immutable file — it has no source version and nothing",
    "publishes it.",
    "",
    "- `output` is a single file name; the task's lease decides whether a docx output is permitted.",
    "- The result reports the draft's name and sha256, the structure it built, and a reopen witness.",
    "- A new document is a draft, never a published business file.",
  ].join("\n"),
  edit: [
    "Edit a leased Word (.docx) document into an **unpublished proposal**, as a new immutable version.",
    "The source version is never modified; the proposal stays unpublished until the review surface",
    "(RASF-3285) publishes it.",
    "",
    REF_NOTE,
    "",
    "- Steps: `insertSection`, `replaceParagraphs`, `deleteParagraphs`, `replaceText`, `updateCell`,",
    "  `insertRow`, `deleteRow`, `addComment`, `replyComment`, `resolveComment`, `deleteComment`,",
    "  `acceptRevisions`, `rejectRevisions`. They apply in the order given, and each validates its own",
    "  anchor — a stale one refuses instead of editing whatever moved into its place.",
    "- Word-level edits are recorded as real tracked changes by default, so review gets a redline.",
    "- The result reports source and output sha256, the structural change set (added, removed, changed and",
    "  byte-identical parts), a text diff and a redline, and a reopen witness.",
    "- Untouched parts come back byte-identical: relationships, styles, headers and footers survive.",
  ].join("\n"),
  preview: [
    "Preview a leased Word (.docx) document as bounded, structure-marked text: `H1:`/`H2:` for headings,",
    "`P:` for paragraphs, `L:` for list items, `T<rows>x<columns>:` for tables. Paged like `read_document`.",
    "",
    REF_NOTE,
    "",
    "- Also reports pending tracked changes: what accepting every revision would change, and the redline",
    "  view of the markup that is there.",
    "- Read-only: nothing is written. Preview artifacts are derived from the exact version, not a path.",
  ].join("\n"),
  compare: [
    "Diff two leased Word (.docx) versions: the structural change set (parts added, removed, changed and",
    "left byte-identical), a per-story unified text diff, and the redline view of the second version's",
    "tracked changes.",
    "",
    REF_NOTE,
    "",
    "- Use it to review a proposal against the version it came from, before anyone publishes.",
    "- Both versions must be leased to this task.",
    "- Read-only: nothing is written.",
  ].join("\n"),
};

// -- the tool --------------------------------------------------------------------------------------

/**
 * The six typed Word tools. Every one is `replay: "safe"`: the service is idempotent by operation ID, so
 * an interrupted call that reruns resolves to the same committed receipt instead of a second edit.
 */
export function wordTools(options: WordToolOptions): readonly ToolRegistration[] {
  return [
    wordTool("inspect", INSPECT_DOCUMENT, INSPECT_PARAMETERS, options),
    wordTool("read", READ_DOCUMENT, READ_PARAMETERS, options),
    wordTool("create", CREATE_DOCUMENT, CREATE_PARAMETERS, options),
    wordTool("edit", EDIT_DOCUMENT, EDIT_PARAMETERS, options),
    wordTool("preview", PREVIEW_DOCUMENT, PREVIEW_PARAMETERS, options),
    wordTool("compare", COMPARE_DOCUMENT, COMPARE_PARAMETERS, options),
  ];
}

/** A type alias, not an interface, so it keeps the implicit index signature `JsonValue` needs. */
type WordToolDetails = {
  operationId: string;
  operation: string;
  files?: string[];
  worker?: string;
  truncated?: boolean;
  code?: string;
};

type WordToolResult = {
  readonly output: { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
  readonly details: WordToolDetails;
};

function wordTool(
  operation: WordOperation,
  name: string,
  parameters: TSchema,
  options: WordToolOptions,
): ToolRegistration {
  return defineTool({
    name,
    description: DESCRIPTIONS[operation],
    parameters,
    replay: "safe",
    execute: async (args: unknown, api): Promise<WordToolResult> => {
      const taskId = String(api.taskId);
      const conversationId = String(api.conversationId);
      const operationId = operationIdForCall({ conversationId, callId: api.callId });

      const lease = await options.leaseFor({ taskId, conversationId });
      if (lease === undefined) {
        return refusalResult(
          operation,
          operationId,
          "no-lease",
          "this task has no document lease, so no Word document was granted. Ask the host for one.",
        );
      }

      let program: WordProgram;
      try {
        program = wordProgram(operation, args, lease);
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
        const result = parseWordResult(
          operation,
          outcome.receipt.result,
          program.sources.map(wordResultRef),
        );
        return committed(operation, operationId, taskId, outcome, result);
      } catch (error) {
        return refused(error, operation, operationId);
      }
    },
  }) as unknown as ToolRegistration;
}

function committed(
  operation: WordOperation,
  operationId: string,
  taskId: string,
  outcome: DocumentRunCommitted,
  result: WordResult,
): WordToolResult {
  const receipt = outcome.receipt;
  const compose = (value: WordResult | null): Record<string, unknown> => ({
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
 * review *lines* go first — their counts, the change set, the hashes and the file ids all stay — then the
 * droppable keys in priority order, and the body names what it left out. Slicing the string instead would
 * leave a model with a document it cannot parse and no way to tell.
 */
function boundedBody(
  compose: (value: WordResult | null) => Record<string, unknown>,
  result: WordResult,
): { text: string; truncated: boolean } {
  const full = compose(result);
  if (JSON.stringify(full, null, 2).length <= MAX_TOOL_TEXT) {
    return { text: JSON.stringify(full, null, 2), truncated: false };
  }
  const omitted: string[] = [
    "the diff lines and redline entries, which compare_document and read_document page",
    "the per-step change evidence",
  ];
  const body = compose(reviewed(result));
  for (const key of DROPPABLE) {
    if (JSON.stringify(body, null, 2).length <= MAX_TOOL_TEXT) break;
    if (key in body) {
      delete body[key];
      omitted.push(key);
    }
  }
  if (JSON.stringify(body, null, 2).length > MAX_TOOL_TEXT) {
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

/** The same result with its line-by-line artifacts reduced to the counts that describe them. */
function reviewed(result: WordResult): WordResult {
  switch (result.operation) {
    case "edit":
      return {
        ...result,
        changes: result.changes.map((change) => ({ ...change, evidence: {} })),
        diff: withoutLines(result.diff),
        redline: withoutEntries(result.redline),
      };
    case "compare":
      return {
        ...result,
        diff: withoutLines(result.diff),
        redline: withoutEntries(result.redline),
      };
    case "preview":
      return {
        ...result,
        pending: withoutLines(result.pending),
        redline: withoutEntries(result.redline),
      };
    default:
      return result;
  }
}

function withoutLines(diff: WordDiff): WordDiff {
  return {
    ...diff,
    stories: diff.stories.map((story) => ({
      ...story,
      diffLines: [],
      omittedLines: story.omittedLines + story.diffLines.length,
    })),
    truncated: true,
  };
}

function withoutEntries(redline: WordRedline): WordRedline {
  return { ...redline, entries: [], pendingLines: [], truncated: true };
}

function refusedOutcome(outcome: DocumentRunRefused, operation: WordOperation): WordToolResult {
  return refusalResult(operation, outcome.operationId, outcome.code, outcome.message);
}

function refused(error: unknown, operation: WordOperation, operationId: string): WordToolResult {
  if (error instanceof DocumentError) {
    return refusalResult(operation, operationId, error.code, error.message);
  }
  throw error;
}

function refusalResult(
  operation: WordOperation,
  operationId: string,
  code: string,
  message: string,
): WordToolResult {
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
export const WORD_TOOL_REGISTRATIONS = [
  INSPECT_DOCUMENT,
  READ_DOCUMENT,
  CREATE_DOCUMENT,
  EDIT_DOCUMENT,
  PREVIEW_DOCUMENT,
  COMPARE_DOCUMENT,
] as const;
