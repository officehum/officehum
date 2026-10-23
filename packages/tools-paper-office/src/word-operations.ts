/**
 * The typed Word surface: what a role may ask of a `.docx`, and the exact program each ask runs.
 *
 * A typed operation is not a second implementation of the Python adapter — it is the *only* way the
 * adapter is reached. The tool validates its arguments here, resolves every file reference against the
 * task's lease, and hands `word_adapter.run(operation, arguments)` a fixed, checked request. The
 * submitted code is a constant per operation, so the receipt's code hash names the operation and the
 * argument hash names the request: a replay returns the same receipt, and changed arguments under a
 * used operation ID fail closed.
 *
 * Nothing here takes a path. A file reference is a FileStore `fileId` with the `versionId`, `name`,
 * `sha256` and `size` the lease pinned; every one of those fields is checked against the lease before
 * the run, so a reference the lease does not grant refuses with `ungranted-input` rather than being
 * resolved by name.
 *
 * The paged sections (`read`, `preview`) always carry a page size, a cursor and a total, and the result
 * validator enforces that shape, so a huge document cannot arrive as one unbounded reply.
 */

import { type DocumentError, refusal } from "./errors.js";
import { type DocumentLease, findLeasedInput, type LeasedInput, permitsFormat } from "./lease.js";
import {
  assertFileId,
  assertHash,
  assertLabel,
  assertPathSegment,
  assertSize,
  exactKeys,
  isRecord,
  record,
} from "./validate.js";

export const INSPECT_DOCUMENT = "inspect_document";
export const READ_DOCUMENT = "read_document";
export const CREATE_DOCUMENT = "create_document";
export const EDIT_DOCUMENT = "edit_document";
export const PREVIEW_DOCUMENT = "preview_document";
export const COMPARE_DOCUMENT = "compare_document";

/** The six typed Word operations, in the order the design names them. */
export type WordOperation = "inspect" | "read" | "create" | "edit" | "preview" | "compare";

export const WORD_OPERATIONS: readonly WordOperation[] = [
  "inspect",
  "read",
  "create",
  "edit",
  "preview",
  "compare",
];

export const WORD_TOOL_NAMES: Readonly<Record<WordOperation, string>> = {
  inspect: INSPECT_DOCUMENT,
  read: READ_DOCUMENT,
  create: CREATE_DOCUMENT,
  edit: EDIT_DOCUMENT,
  preview: PREVIEW_DOCUMENT,
  compare: COMPARE_DOCUMENT,
};

export const WORD_READ_SECTIONS = [
  "blocks",
  "paragraphs",
  "headings",
  "tables",
  "comments",
  "revisions",
] as const;

export type WordReadSection = (typeof WORD_READ_SECTIONS)[number];

export const MAX_WORD_PAGE = 50;
export const DEFAULT_WORD_PAGE = 20;
export const MAX_WORD_STEPS = 32;
export const MAX_WORD_BLOCKS = 512;

/** The one format this adapter owns. */
export const WORD_FORMAT = "docx";

// -- what a caller sends --------------------------------------------------------------------------

/** A leased Word file: the FileStore id and the version, name, hash and size the lease pinned. */
export interface WordFileRef {
  readonly fileId: string;
  readonly versionId: string;
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}

/** A block anchor: exact paragraph text, or a block reacquired by story, index and content hash. */
export type WordAnchor =
  | { readonly text: string }
  | { readonly story: string; readonly index: number; readonly contentHash: string };

export interface WordInsertSectionStep {
  readonly kind: "insertSection";
  readonly anchor: WordAnchor;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly headingStyle?: string;
  readonly bodyStyle?: string;
  readonly tracked?: boolean;
  readonly author?: string;
  readonly date?: string;
}

export interface WordReplaceParagraphsStep {
  readonly kind: "replaceParagraphs";
  readonly anchor: WordAnchor;
  readonly paragraphs: readonly string[];
  readonly count?: number;
  readonly bodyStyle?: string;
  readonly tracked?: boolean;
  readonly author?: string;
  readonly date?: string;
}

export interface WordDeleteParagraphsStep {
  readonly kind: "deleteParagraphs";
  readonly anchor: WordAnchor;
  readonly count?: number;
  readonly tracked?: boolean;
  readonly author?: string;
  readonly date?: string;
}

export interface WordReplaceTextStep {
  readonly kind: "replaceText";
  readonly needle: string;
  readonly text: string;
  readonly story?: string;
  readonly nth?: number;
  readonly tracked?: boolean;
  readonly author?: string;
  readonly date?: string;
}

export interface WordUpdateCellStep {
  readonly kind: "updateCell";
  readonly nearText: string;
  readonly row: number;
  readonly column: number;
  readonly text: string;
  readonly tracked?: boolean;
  readonly author?: string;
  readonly date?: string;
}

export interface WordInsertRowStep {
  readonly kind: "insertRow";
  readonly nearText: string;
  readonly row: number;
  readonly values: readonly string[];
  readonly copyFormatFrom?: number;
}

export interface WordDeleteRowStep {
  readonly kind: "deleteRow";
  readonly nearText: string;
  readonly row: number;
}

export interface WordAddCommentStep {
  readonly kind: "addComment";
  readonly anchor: WordAnchor;
  readonly text: string;
  readonly author?: string;
  readonly date?: string;
}

export interface WordReplyCommentStep {
  readonly kind: "replyComment";
  readonly commentId: number;
  readonly text: string;
  readonly author?: string;
  readonly date?: string;
}

export interface WordResolveCommentStep {
  readonly kind: "resolveComment";
  readonly commentId: number;
  readonly resolved?: boolean;
}

export interface WordDeleteCommentStep {
  readonly kind: "deleteComment";
  readonly commentId: number;
}

export interface WordRevisionStep {
  readonly kind: "acceptRevisions" | "rejectRevisions";
  readonly revisionAuthor?: string;
}

export type WordEditStep =
  | WordInsertSectionStep
  | WordReplaceParagraphsStep
  | WordDeleteParagraphsStep
  | WordReplaceTextStep
  | WordUpdateCellStep
  | WordInsertRowStep
  | WordDeleteRowStep
  | WordAddCommentStep
  | WordReplyCommentStep
  | WordResolveCommentStep
  | WordDeleteCommentStep
  | WordRevisionStep;

export type WordCreateBlock =
  | { readonly kind: "heading"; readonly text: string; readonly level: number }
  | { readonly kind: "paragraph"; readonly text: string; readonly style?: string }
  | {
      readonly kind: "list";
      readonly items: readonly string[];
      readonly listKind?: "bullet" | "decimal";
      readonly level?: number;
    }
  | {
      readonly kind: "table";
      readonly rows: readonly (readonly string[])[];
      readonly style?: string;
    }
  | { readonly kind: "pageBreak" };

/** What one typed operation asks for, with every output and source already resolved to the lease. */
export interface WordProgram {
  readonly operation: WordOperation;
  readonly code: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** The leased inputs the request names, as the lease granted them. */
  readonly sources: readonly LeasedInput[];
  /** The output the request proposes, or `null` when it proposes none. */
  readonly output: { readonly name: string; readonly editOf: string | null } | null;
}

// -- reading the request --------------------------------------------------------------------------

function object(
  value: unknown,
  what: string,
  allowed?: readonly string[],
): Record<string, unknown> {
  const entry = record(value, `${what} must be a JSON object`);
  if (allowed !== undefined) exactKeys(entry, allowed, `${what} carries an unknown field`);
  return entry;
}

function text(value: unknown, what: string, limit: number): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    Buffer.byteLength(value, "utf8") > limit
  ) {
    throw refusal(
      "invalid-request",
      `${what} must be a non-empty string of at most ${limit} bytes`,
    );
  }
  return value;
}

function maybeText(value: unknown, what: string, limit: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > limit) {
    throw refusal("invalid-request", `${what} must be a string of at most ${limit} bytes`);
  }
  return value;
}

function flag(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw refusal("invalid-request", `${what} must be true or false`);
  return value;
}

function whole(value: unknown, what: string, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < low || value > high) {
    throw refusal("invalid-request", `${what} must be an integer between ${low} and ${high}`);
  }
  return value;
}

function texts(value: unknown, what: string, limit = MAX_WORD_BLOCKS): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw refusal("invalid-request", `${what} must be a non-empty list of strings`);
  }
  if (value.length > limit) {
    throw refusal("invalid-request", `${what} holds more than ${limit} entries`);
  }
  return value.map((item, index) => text(item, `${what} entry ${index}`, 4_000));
}

/** The shape of a file reference, before the lease is consulted. */
export function assertWordFileRef(value: unknown, what: string): WordFileRef {
  const entry = object(value, what, ["fileId", "versionId", "name", "sha256", "size"]);
  assertFileId(entry.fileId, `${what} fileId`);
  assertFileId(entry.versionId, `${what} versionId`);
  assertPathSegment(entry.name, `${what} name`);
  assertHash(entry.sha256, `${what} sha256`);
  assertSize(entry.size, `${what} size`);
  return {
    fileId: entry.fileId,
    versionId: entry.versionId,
    name: entry.name,
    sha256: entry.sha256,
    size: entry.size,
  };
}

/**
 * The leased input a reference names, or a refusal. Every field is checked against the lease: the
 * lease, not the caller, decides what this operation may read, and a Word operation reads `.docx`.
 */
export function resolveWordRef(lease: DocumentLease, value: unknown, what: string): LeasedInput {
  const ref = assertWordFileRef(value, what);
  const leased = findLeasedInput(lease, ref.versionId);
  if (leased === undefined) {
    throw refusal(
      "ungranted-input",
      `${what} names version ${ref.versionId}, which this task's lease does not grant`,
    );
  }
  if (
    leased.fileId !== ref.fileId ||
    leased.name !== ref.name ||
    leased.sha256 !== ref.sha256 ||
    leased.size !== ref.size
  ) {
    throw refusal(
      "ungranted-input",
      `${what} does not match the version the lease pinned for ${leased.name}`,
    );
  }
  if (leased.format !== WORD_FORMAT) {
    throw refusal("invalid-request", `${what} is a ${leased.format} file, not a .docx`);
  }
  return leased;
}

/** The output name a request proposes: one path segment, `.docx`, and permitted by the lease. */
export function resolveWordOutput(lease: DocumentLease, value: unknown): string {
  const name = text(value, "an output name", 255);
  assertPathSegment(name, "an output name");
  if (!name.toLowerCase().endsWith(`.${WORD_FORMAT}`)) {
    throw refusal("output-format", `an output named ${name} is not a .docx file`);
  }
  if (!permitsFormat(lease, WORD_FORMAT)) {
    throw refusal("output-format", "this task's lease does not permit a docx output");
  }
  return name;
}

function anchor(value: unknown, what: string): WordAnchor {
  const entry = object(value, what);
  if ("text" in entry) {
    exactKeys(entry, ["text"], `${what} carries an unknown field`);
    return { text: text(entry.text, `${what} text`, 4_000) };
  }
  exactKeys(entry, ["story", "index", "contentHash"], `${what} carries an unknown field`);
  if (entry.story === undefined || entry.index === undefined || entry.contentHash === undefined) {
    throw refusal("invalid-request", `${what} needs story, index and contentHash`);
  }
  const contentHash = text(entry.contentHash, `${what} contentHash`, 64);
  if (!/^[0-9a-f]{8}$/u.test(contentHash)) {
    throw refusal("invalid-request", `${what} contentHash must be the block's 8 hex digits`);
  }
  return {
    story: text(entry.story, `${what} story`, 255),
    index: whole(entry.index, `${what} index`, 0, 1_000_000),
    contentHash,
  };
}

export const STEP_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  insertSection: ["anchor", "heading", "paragraphs"],
  replaceParagraphs: ["anchor", "paragraphs"],
  deleteParagraphs: ["anchor"],
  replaceText: ["needle", "text"],
  updateCell: ["nearText", "row", "column", "text"],
  insertRow: ["nearText", "row", "values"],
  deleteRow: ["nearText", "row"],
  addComment: ["anchor", "text"],
  replyComment: ["commentId", "text"],
  resolveComment: ["commentId"],
  deleteComment: ["commentId"],
  acceptRevisions: [],
  rejectRevisions: [],
};

export const STEP_OPTIONAL: Readonly<Record<string, readonly string[]>> = {
  insertSection: ["headingStyle", "bodyStyle", "tracked", "author", "date"],
  replaceParagraphs: ["count", "bodyStyle", "tracked", "author", "date"],
  deleteParagraphs: ["count", "tracked", "author", "date"],
  replaceText: ["story", "nth", "tracked", "author", "date"],
  updateCell: ["tracked", "author", "date"],
  insertRow: ["copyFormatFrom"],
  deleteRow: [],
  addComment: ["author", "date"],
  replyComment: ["author", "date"],
  resolveComment: ["resolved"],
  deleteComment: [],
  acceptRevisions: ["revisionAuthor"],
  rejectRevisions: ["revisionAuthor"],
};

/** Validates one edit step. The Python adapter validates the same shape again on the far side. */
export function assertWordStep(value: unknown, index: number): WordEditStep {
  const what = `step ${index}`;
  const entry = object(value, what);
  const kind = entry.kind;
  if (typeof kind !== "string" || STEP_OPTIONAL[kind] === undefined) {
    throw refusal("invalid-request", `${what} names an unknown kind`);
  }
  const allowed = ["kind", ...(STEP_REQUIRED[kind] ?? []), ...(STEP_OPTIONAL[kind] ?? [])];
  exactKeys(entry, allowed, `${what} carries a field it does not declare`);
  for (const key of STEP_REQUIRED[kind] ?? []) {
    if (entry[key] === undefined) throw refusal("invalid-request", `${what} is missing ${key}`);
  }
  const stamp = {
    tracked: entry.tracked === undefined ? undefined : flag(entry.tracked, `${what} tracked`),
    author: entry.author === undefined ? undefined : text(entry.author, `${what} author`, 256),
    date: entry.date === undefined ? undefined : text(entry.date, `${what} date`, 64),
  };
  const step = (fields: Record<string, unknown>): WordEditStep =>
    withoutUndefined({ ...fields, ...stamp }) as unknown as WordEditStep;

  switch (kind) {
    case "insertSection":
      return step({
        kind,
        anchor: anchor(entry.anchor, `${what} anchor`),
        heading: text(entry.heading, `${what} heading`, 4_000),
        paragraphs: texts(entry.paragraphs, `${what} paragraphs`),
        headingStyle:
          entry.headingStyle === undefined
            ? undefined
            : text(entry.headingStyle, `${what} headingStyle`, 255),
        bodyStyle:
          entry.bodyStyle === undefined
            ? undefined
            : text(entry.bodyStyle, `${what} bodyStyle`, 255),
      });
    case "replaceParagraphs":
      return step({
        kind,
        anchor: anchor(entry.anchor, `${what} anchor`),
        paragraphs: texts(entry.paragraphs, `${what} paragraphs`),
        count:
          entry.count === undefined ? undefined : whole(entry.count, `${what} count`, 1, 1_000),
        bodyStyle:
          entry.bodyStyle === undefined
            ? undefined
            : text(entry.bodyStyle, `${what} bodyStyle`, 255),
      });
    case "deleteParagraphs":
      return step({
        kind,
        anchor: anchor(entry.anchor, `${what} anchor`),
        count:
          entry.count === undefined ? undefined : whole(entry.count, `${what} count`, 1, 1_000),
      });
    case "replaceText":
      return step({
        kind,
        needle: text(entry.needle, `${what} needle`, 4_000),
        text: maybeText(entry.text, `${what} text`, 4_000),
        story: entry.story === undefined ? undefined : text(entry.story, `${what} story`, 255),
        nth: entry.nth === undefined ? undefined : whole(entry.nth, `${what} nth`, 1, 1_000_000),
      });
    case "updateCell":
      return step({
        kind,
        nearText: text(entry.nearText, `${what} nearText`, 4_000),
        row: whole(entry.row, `${what} row`, 0, 1_000_000),
        column: whole(entry.column, `${what} column`, 0, 1_000_000),
        text: maybeText(entry.text, `${what} text`, 4_000),
      });
    case "insertRow":
      return step({
        kind,
        nearText: text(entry.nearText, `${what} nearText`, 4_000),
        row: whole(entry.row, `${what} row`, 0, 1_000_000),
        values: texts(entry.values, `${what} values`, 64),
        copyFormatFrom:
          entry.copyFormatFrom === undefined
            ? undefined
            : whole(entry.copyFormatFrom, `${what} copyFormatFrom`, 0, 1_000_000),
      });
    case "deleteRow":
      return step({
        kind,
        nearText: text(entry.nearText, `${what} nearText`, 4_000),
        row: whole(entry.row, `${what} row`, 0, 1_000_000),
      });
    case "addComment":
      return step({
        kind,
        anchor: anchor(entry.anchor, `${what} anchor`),
        text: text(entry.text, `${what} text`, 4_000),
      });
    case "replyComment":
      return step({
        kind,
        commentId: whole(entry.commentId, `${what} commentId`, 0, 1_000_000),
        text: text(entry.text, `${what} text`, 4_000),
      });
    case "resolveComment":
      return step({
        kind,
        commentId: whole(entry.commentId, `${what} commentId`, 0, 1_000_000),
        resolved:
          entry.resolved === undefined ? undefined : flag(entry.resolved, `${what} resolved`),
      });
    case "deleteComment":
      return step({ kind, commentId: whole(entry.commentId, `${what} commentId`, 0, 1_000_000) });
    default:
      return step({
        kind,
        revisionAuthor:
          entry.revisionAuthor === undefined
            ? undefined
            : text(entry.revisionAuthor, `${what} revisionAuthor`, 256),
      });
  }
}

/**
 * The adapter's arguments are hashed into the receipt's intent, and `intentHash` refuses a value that is
 * not finite JSON — so an absent field must be *absent*, never `undefined`. This runs before the request
 * leaves the tool for exactly that reason.
 */
function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out;
}

/** Validates one block of a new draft. */
export function assertWordBlock(value: unknown, index: number): WordCreateBlock {
  const what = `block ${index}`;
  const entry = object(value, what);
  const kind = entry.kind;
  const allowed: Readonly<Record<string, readonly string[]>> = {
    heading: ["kind", "text", "level"],
    paragraph: ["kind", "text", "style"],
    list: ["kind", "items", "listKind", "level"],
    table: ["kind", "rows", "style"],
    pageBreak: ["kind"],
  };
  if (typeof kind !== "string" || allowed[kind] === undefined) {
    throw refusal("invalid-request", `${what} names an unknown kind`);
  }
  exactKeys(
    entry,
    allowed[kind] as readonly string[],
    `${what} carries a field it does not declare`,
  );
  switch (kind) {
    case "heading":
      if (entry.level === undefined) throw refusal("invalid-request", `${what} is missing level`);
      return {
        kind,
        text: text(entry.text, `${what} text`, 4_000),
        level: whole(entry.level, `${what} level`, 0, 9),
      };
    case "paragraph":
      return {
        kind,
        text: text(entry.text, `${what} text`, 4_000),
        ...(entry.style === undefined ? {} : { style: text(entry.style, `${what} style`, 255) }),
      };
    case "list": {
      const listKind = entry.listKind;
      if (listKind !== undefined && listKind !== "bullet" && listKind !== "decimal") {
        throw refusal("invalid-request", `${what} listKind must be bullet or decimal`);
      }
      return {
        kind,
        items: texts(entry.items, `${what} items`, 64),
        ...(listKind === undefined ? {} : { listKind }),
        ...(entry.level === undefined ? {} : { level: whole(entry.level, `${what} level`, 0, 2) }),
      };
    }
    case "table": {
      const rows = entry.rows;
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > 64) {
        throw refusal("invalid-request", `${what} needs 1 to 64 rows`);
      }
      const width = Array.isArray(rows[0]) ? rows[0].length : 0;
      if (width === 0 || width > 64)
        throw refusal("invalid-request", `${what} rows need 1 to 64 cells`);
      const cells = rows.map((row, rowIndex) => {
        if (!Array.isArray(row) || row.length !== width) {
          throw refusal("invalid-request", `${what} rows must all hold ${width} cells`);
        }
        return row.map((cell, cellIndex) =>
          maybeText(cell, `${what} cell ${rowIndex}.${cellIndex}`, 4_000),
        );
      });
      return {
        kind,
        rows: cells,
        ...(entry.style === undefined ? {} : { style: text(entry.style, `${what} style`, 255) }),
      };
    }
    default:
      return { kind: "pageBreak" };
  }
}

// -- turning a request into a program ---------------------------------------------------------------

function pageOf(entry: Record<string, unknown>, what: string): Record<string, unknown> {
  return {
    ...(entry.cursor === undefined
      ? {}
      : { cursor: whole(entry.cursor, `${what} cursor`, 0, 1_000_000_000) }),
    ...(entry.pageSize === undefined
      ? {}
      : { pageSize: whole(entry.pageSize, `${what} pageSize`, 1, MAX_WORD_PAGE) }),
  };
}

/**
 * The Python program one typed operation runs: a constant per operation, plus the checked arguments.
 * The operation name lives in the code, so a receipt's code hash names the operation and its argument
 * hash names the request.
 */
export function wordInstruction(operation: WordOperation): string {
  return [
    "import word_adapter",
    "",
    `documents.result(word_adapter.run(${JSON.stringify(operation)}, documents.arguments()))`,
  ].join("\n");
}

/**
 * Validates a typed request against the lease and returns the program to run. Everything a path could
 * hide is resolved here: inputs are lease version IDs, the output is a single staging file name.
 */
export function wordProgram(
  operation: WordOperation,
  args: unknown,
  lease: DocumentLease,
): WordProgram {
  const entry = object(args, `the ${WORD_TOOL_NAMES[operation]} arguments`);
  const code = wordInstruction(operation);
  const base = { operation, code, sources: [] as readonly LeasedInput[], output: null };

  switch (operation) {
    case "inspect": {
      exactKeys(entry, ["ref"], "inspect carries a field it does not declare");
      const source = resolveWordRef(lease, entry.ref, "the inspect ref");
      return {
        ...base,
        sources: [source],
        arguments: { ref: refArgument(source) },
      };
    }
    case "read": {
      exactKeys(
        entry,
        ["ref", "section", "cursor", "pageSize", "includeCells"],
        "read carries a field it does not declare",
      );
      if (entry.ref === undefined || entry.section === undefined) {
        throw refusal("invalid-request", "read needs a ref and a section");
      }
      const section = entry.section;
      if (
        typeof section !== "string" ||
        !(WORD_READ_SECTIONS as readonly string[]).includes(section)
      ) {
        throw refusal(
          "invalid-request",
          `a read section must be one of ${WORD_READ_SECTIONS.join(", ")}`,
        );
      }
      const source = resolveWordRef(lease, entry.ref, "the read ref");
      return {
        ...base,
        sources: [source],
        arguments: {
          ref: refArgument(source),
          section,
          ...pageOf(entry, "read"),
          ...(entry.includeCells === undefined
            ? {}
            : { includeCells: flag(entry.includeCells, "read includeCells") }),
        },
      };
    }
    case "preview": {
      exactKeys(
        entry,
        ["ref", "cursor", "pageSize"],
        "preview carries a field it does not declare",
      );
      if (entry.ref === undefined) throw refusal("invalid-request", "preview needs a ref");
      const source = resolveWordRef(lease, entry.ref, "the preview ref");
      return {
        ...base,
        sources: [source],
        arguments: { ref: refArgument(source), ...pageOf(entry, "preview") },
      };
    }
    case "compare": {
      exactKeys(entry, ["from", "to"], "compare carries a field it does not declare");
      if (entry.from === undefined || entry.to === undefined) {
        throw refusal("invalid-request", "compare needs from and to");
      }
      const from = resolveWordRef(lease, entry.from, "the compare from ref");
      const to = resolveWordRef(lease, entry.to, "the compare to ref");
      return {
        ...base,
        sources: [from, to],
        arguments: { from: refArgument(from), to: refArgument(to) },
      };
    }
    case "create": {
      exactKeys(entry, ["output", "blocks"], "create carries a field it does not declare");
      const name = resolveWordOutput(lease, entry.output);
      if (!Array.isArray(entry.blocks) || entry.blocks.length === 0) {
        throw refusal("invalid-request", "create needs a non-empty list of blocks");
      }
      if (entry.blocks.length > MAX_WORD_BLOCKS) {
        throw refusal("invalid-request", `create takes at most ${MAX_WORD_BLOCKS} blocks`);
      }
      const blocks = entry.blocks.map((block, index) => assertWordBlock(block, index));
      return {
        ...base,
        output: { name, editOf: null },
        arguments: { output: name, blocks },
      };
    }
    default: {
      exactKeys(
        entry,
        ["ref", "output", "steps", "author", "date", "acknowledgeProtection"],
        "edit carries a field it does not declare",
      );
      for (const key of ["ref", "output", "steps", "author"]) {
        if (entry[key] === undefined) throw refusal("invalid-request", `edit is missing ${key}`);
      }
      const source = resolveWordRef(lease, entry.ref, "the edit source ref");
      if (!source.writable) {
        throw refusal(
          "unleased-path",
          `this task's lease grants read-only access to ${source.name}, so it cannot propose a new version of it`,
        );
      }
      const name = resolveWordOutput(lease, entry.output);
      if (!Array.isArray(entry.steps) || entry.steps.length === 0) {
        throw refusal("invalid-request", "edit needs a non-empty list of steps");
      }
      if (entry.steps.length > MAX_WORD_STEPS) {
        throw refusal("invalid-request", `edit takes at most ${MAX_WORD_STEPS} steps`);
      }
      const steps = entry.steps.map((step, index) => assertWordStep(step, index));
      const author = text(entry.author, "edit author", 256);
      assertLabel(author, "edit author");
      return {
        ...base,
        sources: [source],
        output: { name, editOf: source.versionId },
        arguments: {
          ref: refArgument(source),
          output: name,
          steps,
          author,
          ...(entry.date === undefined ? {} : { date: text(entry.date, "edit date", 64) }),
          ...(entry.acknowledgeProtection === undefined
            ? {}
            : {
                acknowledgeProtection: flag(
                  entry.acknowledgeProtection,
                  "edit acknowledgeProtection",
                ),
              }),
        },
      };
    }
  }
}

/** The reference the adapter echoes back as its source evidence, exactly as the lease pinned it. */
function refArgument(leased: LeasedInput): Record<string, unknown> {
  return {
    fileId: leased.fileId,
    versionId: leased.versionId,
    name: leased.name,
    sha256: leased.sha256,
    size: leased.size,
  };
}

// -- reading the answer ---------------------------------------------------------------------------

export interface WordProtection {
  readonly edit: string | null;
  readonly formatting: boolean;
  readonly enforced: boolean;
  readonly acknowledged: boolean;
}

export interface WordCounts {
  readonly storyParts: number;
  readonly blocks: number;
  readonly paragraphs: number;
  readonly headings: number;
  readonly tables: number;
  readonly characters: number;
}

export interface WordTableShape {
  readonly rows: number;
  readonly columns: number;
  readonly has_merges: boolean;
  readonly has_nested_table: boolean;
}

export interface WordBlockAnchor {
  readonly story: string;
  readonly index: number;
  readonly contentHash: string;
}

export interface WordBlockItem {
  readonly story: string;
  readonly kind: string;
  readonly index: number;
  readonly anchor: WordBlockAnchor;
  readonly text: string;
  readonly truncated: boolean;
  readonly styleId: string | null;
  readonly headingLevel: number | null;
  readonly inInsert: boolean;
  readonly inDelete: boolean;
  readonly inContentControl: boolean;
  readonly inTextBox: boolean;
  readonly hasField: boolean;
  readonly table: WordTableShape | null;
  readonly shape?: WordTableShape | null;
  readonly cells?: readonly (readonly string[])[] | null;
}

export interface WordCommentItem {
  readonly commentId: number;
  readonly author: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly resolved: boolean;
  readonly parentId: number | null;
  readonly anchoredText: string;
  readonly anchoredTruncated: boolean;
}

export interface WordRevisionItem {
  readonly revisionType: string;
  readonly author: string;
  readonly date: string | null;
  readonly text: string;
  readonly truncated: boolean;
  readonly story: string;
  readonly contentHash: string;
  readonly isParagraphMark: boolean;
  readonly resolvable: boolean;
}

export type WordItem = WordBlockItem | WordCommentItem | WordRevisionItem;

export interface WordPage<T> {
  readonly section: string;
  readonly pageSize: number;
  readonly cursor: number;
  readonly returned: number;
  readonly total: number;
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
  readonly items: readonly T[];
}

export interface WordDiffStory {
  readonly story: string;
  readonly diffLines: readonly string[];
  readonly omittedLines: number;
}

export interface WordDiff {
  readonly schema: string;
  readonly version: number;
  readonly changedLineCount: number;
  readonly stories: readonly WordDiffStory[];
  readonly truncated: boolean;
}

export interface WordPartChange {
  readonly part: string;
  readonly kind: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly semanticChange: boolean;
}

/** The structural change set: what the edit added, removed, changed or left byte-identical. */
export interface WordChangeSet {
  readonly schema: string;
  readonly version: number;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly WordPartChange[];
  readonly byteIdenticalCount: number;
  readonly semanticallyEmpty: boolean;
}

export interface WordRedlineEntry {
  readonly story: string;
  readonly kind: string;
  readonly index: number;
  readonly marker: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface WordRedline {
  readonly schema: string;
  readonly version: number;
  readonly insertedBlocks: number;
  readonly deletedBlocks: number;
  readonly entries: readonly WordRedlineEntry[];
  readonly total: number;
  readonly truncated: boolean;
  readonly pendingChangedLineCount: number;
  readonly pendingLines: readonly string[];
}

export interface WordReopened {
  readonly paragraphs: number;
  readonly headings: number;
  readonly tables: number;
  readonly comments: number;
  readonly revisions: number;
  readonly storyParts: readonly string[];
}

/** A new draft, or a proposal for an existing file that nothing has published yet. */
export interface WordProposal {
  readonly status: "draft" | "proposed";
  readonly name: string;
  readonly editOf: string | null;
  readonly sha256: string;
  readonly size: number;
  readonly published: false;
}

export interface WordChangeRecord {
  readonly kind: string;
  readonly tracked: boolean;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export type WordSourceEvidence = WordFileRef;

export interface WordInspectDocument extends WordCounts {
  readonly comments: number;
  readonly unresolvedComments: number;
  readonly threads: number;
  readonly revisions: number;
  readonly revisionTypes: Readonly<Record<string, number>>;
  readonly resolvableRevisions: number;
  readonly unsupportedRevisions: Readonly<Record<string, number>>;
  readonly blindRegions: Readonly<Record<string, number>>;
  readonly protection: WordProtection;
  readonly editsBlocked: boolean;
}

export interface WordInspection {
  readonly operation: "inspect";
  readonly source: WordSourceEvidence;
  readonly document: WordInspectDocument;
  readonly headingOutline: readonly WordBlockItem[];
  readonly headingOutlineTruncated: boolean;
  readonly tables: readonly WordBlockItem[];
  readonly tablesTruncated: boolean;
  readonly comments: readonly WordCommentItem[];
  readonly commentsTruncated: boolean;
}

export interface WordReading {
  readonly operation: "read";
  readonly source: WordSourceEvidence;
  readonly document: WordCounts;
  readonly page: WordPage<WordItem>;
}

export interface WordDraft {
  readonly operation: "create";
  readonly draft: WordProposal;
  readonly structure: WordCounts;
  readonly provenance: { readonly template: string; readonly source: null };
  readonly reopened: WordReopened;
}

export interface WordEdit {
  readonly operation: "edit";
  readonly source: WordSourceEvidence;
  readonly proposal: WordProposal;
  readonly changes: readonly WordChangeRecord[];
  readonly changeSet: WordChangeSet;
  readonly diff: WordDiff;
  readonly redline: WordRedline;
  readonly preservation: {
    readonly restoredParts: readonly string[];
    readonly changedParts: readonly string[];
    readonly addedParts: readonly string[];
    readonly removedParts: readonly string[];
    readonly verbatimCopy: boolean;
  };
  readonly protection: WordProtection;
  readonly reopened: WordReopened;
}

export interface WordPreviewItem {
  readonly story: string;
  readonly kind: string;
  readonly index: number;
  readonly label: string;
  readonly truncated: boolean;
}

export interface WordPreview {
  readonly operation: "preview";
  readonly source: WordSourceEvidence;
  readonly page: WordPage<WordPreviewItem>;
  readonly structure: WordCounts & { readonly comments: number; readonly revisions: number };
  readonly protection: WordProtection;
  readonly pending: WordDiff;
  readonly redline: WordRedline;
}

export interface WordComparison {
  readonly operation: "compare";
  readonly sources: { readonly from: WordSourceEvidence; readonly to: WordSourceEvidence };
  readonly changeSet: WordChangeSet;
  readonly diff: WordDiff;
  readonly redline: WordRedline;
  readonly identical: boolean;
}

export type WordResult =
  | WordInspection
  | WordReading
  | WordDraft
  | WordEdit
  | WordPreview
  | WordComparison;

// -- the result validator -------------------------------------------------------------------------

function invalid(what: string): DocumentError {
  return refusal("output-invalid", `the worker's ${what} is not the shape this operation promises`);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(what);
  return value;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string") throw invalid(what);
  return value;
}

function asNullableString(value: unknown, what: string): string | null {
  if (value === null) return null;
  return asString(value, what);
}

function asInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalid(what);
  return value;
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw invalid(what);
  return value;
}

function asList(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalid(what);
  return value;
}

function asStrings(value: unknown, what: string): readonly string[] {
  return asList(value, what).map((item) => asString(item, what));
}

function asCounts(value: unknown, what: string): WordCounts {
  const entry = asRecord(value, what);
  return {
    storyParts: asInteger(entry.storyParts, what),
    blocks: asInteger(entry.blocks, what),
    paragraphs: asInteger(entry.paragraphs, what),
    headings: asInteger(entry.headings, what),
    tables: asInteger(entry.tables, what),
    characters: asInteger(entry.characters, what),
  };
}

function asProtection(value: unknown, what: string): WordProtection {
  const entry = asRecord(value, what);
  return {
    edit: asNullableString(entry.edit, what),
    formatting: asBoolean(entry.formatting, what),
    enforced: asBoolean(entry.enforced, what),
    acknowledged: asBoolean(entry.acknowledged, what),
  };
}

function asNumberMap(value: unknown, what: string): Readonly<Record<string, number>> {
  const entry = asRecord(value, what);
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(entry)) out[key] = asInteger(item, what);
  return out;
}

function asSourceRef(value: unknown, what: string): WordSourceEvidence {
  const entry = asRecord(value, what);
  return {
    fileId: asString(entry.fileId, what),
    versionId: asString(entry.versionId, what),
    name: asString(entry.name, what),
    sha256: asString(entry.sha256, what),
    size: asInteger(entry.size, what),
  };
}

function asAnchor(value: unknown, what: string): WordBlockAnchor {
  const entry = asRecord(value, what);
  return {
    story: asString(entry.story, what),
    index: asInteger(entry.index, what),
    contentHash: asString(entry.contentHash, what),
  };
}

function asShape(value: unknown, what: string): WordTableShape | null {
  if (value === null) return null;
  const entry = asRecord(value, what);
  return {
    rows: asInteger(entry.rows, what),
    columns: asInteger(entry.columns, what),
    has_merges: asBoolean(entry.has_merges, what),
    has_nested_table: asBoolean(entry.has_nested_table, what),
  };
}

function asBlockItem(value: unknown, what: string): WordBlockItem {
  const entry = asRecord(value, what);
  return {
    story: asString(entry.story, what),
    kind: asString(entry.kind, what),
    index: asInteger(entry.index, what),
    anchor: asAnchor(entry.anchor, what),
    text: asString(entry.text, what),
    truncated: asBoolean(entry.truncated, what),
    styleId: asNullableString(entry.styleId, what),
    headingLevel: entry.headingLevel === null ? null : asInteger(entry.headingLevel, what),
    inInsert: asBoolean(entry.inInsert, what),
    inDelete: asBoolean(entry.inDelete, what),
    inContentControl: asBoolean(entry.inContentControl, what),
    inTextBox: asBoolean(entry.inTextBox, what),
    hasField: asBoolean(entry.hasField, what),
    table: asShape(entry.table, what),
    ...(entry.shape === undefined ? {} : { shape: asShape(entry.shape, what) }),
    ...(entry.cells === undefined
      ? {}
      : { cells: entry.cells === null ? null : asCells(entry.cells, what) }),
  };
}

function asCells(value: unknown, what: string): readonly (readonly string[])[] {
  return asList(value, what).map((row) => asStrings(row, what));
}

function asCommentItem(value: unknown, what: string): WordCommentItem {
  const entry = asRecord(value, what);
  return {
    commentId: asInteger(entry.commentId, what),
    author: asString(entry.author, what),
    text: asString(entry.text, what),
    truncated: asBoolean(entry.truncated, what),
    resolved: asBoolean(entry.resolved, what),
    parentId: entry.parentId === null ? null : asInteger(entry.parentId, what),
    anchoredText: asString(entry.anchoredText, what),
    anchoredTruncated: asBoolean(entry.anchoredTruncated, what),
  };
}

function asRevisionItem(value: unknown, what: string): WordRevisionItem {
  const entry = asRecord(value, what);
  return {
    revisionType: asString(entry.revisionType, what),
    author: asString(entry.author, what),
    date: asNullableString(entry.date, what),
    text: asString(entry.text, what),
    truncated: asBoolean(entry.truncated, what),
    story: asString(entry.story, what),
    contentHash: asString(entry.contentHash, what),
    isParagraphMark: asBoolean(entry.isParagraphMark, what),
    resolvable: asBoolean(entry.resolvable, what),
  };
}

function asItem(value: unknown, what: string): WordItem {
  const entry = asRecord(value, what);
  if (entry.kind === "paragraph" || entry.kind === "table") return asBlockItem(value, what);
  if (entry.anchor !== undefined) return asBlockItem(value, what);
  if (entry.commentId !== undefined) return asCommentItem(value, what);
  return asRevisionItem(value, what);
}

function asPage<T>(
  value: unknown,
  what: string,
  item: (value: unknown, what: string) => T,
): WordPage<T> {
  const entry = asRecord(value, what);
  const pageSize = asInteger(entry.pageSize, what);
  const returned = asInteger(entry.returned, what);
  if (pageSize < 1 || pageSize > MAX_WORD_PAGE || returned > pageSize) throw invalid(what);
  const items = asList(entry.items, what).map((entry_) => item(entry_, what));
  if (items.length !== returned) throw invalid(what);
  const total = asInteger(entry.total, what);
  const cursor = asInteger(entry.cursor, what);
  if (cursor + returned > total) throw invalid(what);
  const nextCursor = entry.nextCursor === null ? null : asInteger(entry.nextCursor, what);
  if (nextCursor !== (cursor + returned < total ? cursor + returned : null)) throw invalid(what);
  return {
    section: asString(entry.section, what),
    pageSize,
    cursor,
    returned,
    total,
    nextCursor,
    hasMore: asBoolean(entry.hasMore, what),
    items,
  };
}

function asDiff(value: unknown, what: string): WordDiff {
  const entry = asRecord(value, what);
  const stories = asList(entry.stories, what).map((story) => {
    const item = asRecord(story, what);
    return {
      story: asString(item.story, what),
      diffLines: asStrings(item.diffLines, what),
      omittedLines: asInteger(item.omittedLines, what),
    };
  });
  return {
    schema: asString(entry.schema, what),
    version: asInteger(entry.version, what),
    changedLineCount: asInteger(entry.changedLineCount, what),
    stories,
    truncated: asBoolean(entry.truncated, what),
  };
}

function asChangeSet(value: unknown, what: string): WordChangeSet {
  const entry = asRecord(value, what);
  const changed = asList(entry.changed, what).map((part) => {
    const item = asRecord(part, what);
    return {
      part: asString(item.part, what),
      kind: asString(item.kind, what),
      beforeSha256: asString(item.beforeSha256, what),
      afterSha256: asString(item.afterSha256, what),
      semanticChange: asBoolean(item.semanticChange, what),
    };
  });
  return {
    schema: asString(entry.schema, what),
    version: asInteger(entry.version, what),
    added: asStrings(entry.added, what),
    removed: asStrings(entry.removed, what),
    changed,
    byteIdenticalCount: asInteger(entry.byteIdenticalCount, what),
    semanticallyEmpty: asBoolean(entry.semanticallyEmpty, what),
  };
}

function asRedline(value: unknown, what: string): WordRedline {
  const entry = asRecord(value, what);
  const entries = asList(entry.entries, what).map((item) => {
    const item_ = asRecord(item, what);
    return {
      story: asString(item_.story, what),
      kind: asString(item_.kind, what),
      index: asInteger(item_.index, what),
      marker: asString(item_.marker, what),
      text: asString(item_.text, what),
      truncated: asBoolean(item_.truncated, what),
    };
  });
  return {
    schema: asString(entry.schema, what),
    version: asInteger(entry.version, what),
    insertedBlocks: asInteger(entry.insertedBlocks, what),
    deletedBlocks: asInteger(entry.deletedBlocks, what),
    entries,
    total: asInteger(entry.total, what),
    truncated: asBoolean(entry.truncated, what),
    pendingChangedLineCount: asInteger(entry.pendingChangedLineCount, what),
    pendingLines: asStrings(entry.pendingLines, what),
  };
}

function asProposal(value: unknown, what: string): WordProposal {
  const entry = asRecord(value, what);
  const status = asString(entry.status, what);
  if (status !== "draft" && status !== "proposed") throw invalid(what);
  if (entry.published !== false) {
    throw refusal(
      "output-invalid",
      "the worker reported a published Word file, which no operation does",
    );
  }
  return {
    status,
    name: asString(entry.name, what),
    editOf: asNullableString(entry.editOf, what),
    sha256: asString(entry.sha256, what),
    size: asInteger(entry.size, what),
    published: false,
  };
}

function asReopened(value: unknown, what: string): WordReopened {
  const entry = asRecord(value, what);
  return {
    paragraphs: asInteger(entry.paragraphs, what),
    headings: asInteger(entry.headings, what),
    tables: asInteger(entry.tables, what),
    comments: asInteger(entry.comments, what),
    revisions: asInteger(entry.revisions, what),
    storyParts: asStrings(entry.storyParts, what),
  };
}

function asChanges(value: unknown, what: string): readonly WordChangeRecord[] {
  return asList(value, what).map((item) => {
    const entry = asRecord(item, what);
    const evidence =
      entry.evidence === undefined ? {} : asRecord(entry.evidence, `${what} evidence`);
    return {
      kind: asString(entry.kind, what),
      tracked: asBoolean(entry.tracked, what),
      evidence: evidence as Readonly<Record<string, unknown>>,
    };
  });
}

function asPreservation(value: unknown, what: string): WordEdit["preservation"] {
  const entry = asRecord(value, what);
  return {
    restoredParts: asStrings(entry.restoredParts, what),
    changedParts: asStrings(entry.changedParts, what),
    addedParts: asStrings(entry.addedParts, what),
    removedParts: asStrings(entry.removedParts, what),
    verbatimCopy: asBoolean(entry.verbatimCopy, what),
  };
}

/**
 * Validates the worker's answer for one operation. The service already inspected every declared
 * output; this is the second half of that contract — the *typed result* is the shape the operation
 * promises, or the call is refused as `output-invalid` rather than shown to a model.
 */
export function parseWordResult(
  operation: WordOperation,
  value: unknown,
  expected: readonly WordSourceEvidence[],
): WordResult {
  const entry = asRecord(value, "result");
  const what = `${operation} result`;
  if (entry.schema !== "paper_word_operation" || entry.version !== 1 || entry.ok !== true) {
    throw invalid(what);
  }
  if (entry.operation !== operation) {
    throw refusal(
      "output-invalid",
      `the worker answered a ${String(entry.operation)} operation where ${operation} was asked for`,
    );
  }
  /** The result must name the version this call was given, or the answer is about some other file. */
  const check = (
    seen: WordSourceEvidence,
    ref: WordSourceEvidence | undefined,
    name: string,
  ): void => {
    if (ref === undefined) {
      throw refusal("output-invalid", `the worker reported a ${name} this call never named`);
    }
    if (
      seen.fileId !== ref.fileId ||
      seen.versionId !== ref.versionId ||
      seen.sha256 !== ref.sha256 ||
      seen.size !== ref.size
    ) {
      throw refusal(
        "output-invalid",
        `the worker reported ${name} as ${seen.versionId}, not the leased version it was given`,
      );
    }
  };

  switch (operation) {
    case "inspect": {
      const document = asRecord(entry.document, `${what} document`);
      const inspection: WordInspectDocument = {
        ...asCounts(document, what),
        comments: asInteger(document.comments, what),
        unresolvedComments: asInteger(document.unresolvedComments, what),
        threads: asInteger(document.threads, what),
        revisions: asInteger(document.revisions, what),
        revisionTypes: asNumberMap(document.revisionTypes, what),
        resolvableRevisions: asInteger(document.resolvableRevisions, what),
        unsupportedRevisions: asNumberMap(document.unsupportedRevisions, what),
        blindRegions: asNumberMap(document.blindRegions, what),
        protection: asProtection(document.protection, what),
        editsBlocked: asBoolean(document.editsBlocked, what),
      };
      const source = asSourceRef(entry.source, what);
      check(source, expected[0], "source");
      return {
        operation,
        source,
        document: inspection,
        headingOutline: asList(entry.headingOutline, what).map((item) => asBlockItem(item, what)),
        headingOutlineTruncated: asBoolean(entry.headingOutlineTruncated, what),
        tables: asList(entry.tables, what).map((item) => asBlockItem(item, what)),
        tablesTruncated: asBoolean(entry.tablesTruncated, what),
        comments: asList(entry.comments, what).map((item) => asCommentItem(item, what)),
        commentsTruncated: asBoolean(entry.commentsTruncated, what),
      };
    }
    case "read": {
      const source = asSourceRef(entry.source, what);
      check(source, expected[0], "source");
      return {
        operation,
        source,
        document: asCounts(entry.document, what),
        page: asPage(entry.page, `${what} page`, asItem),
      };
    }
    case "create": {
      const provenance = asRecord(entry.provenance, `${what} provenance`);
      if (provenance.source !== null) throw invalid(`${what} provenance`);
      return {
        operation,
        draft: asProposal(entry.draft, `${what} draft`),
        structure: asCounts(entry.structure, what),
        provenance: {
          template: asString(provenance.template, `${what} provenance`),
          source: null,
        },
        reopened: asReopened(entry.reopened, what),
      };
    }
    case "edit": {
      const source = asSourceRef(entry.source, what);
      check(source, expected[0], "source");
      return {
        operation,
        source,
        proposal: asProposal(entry.proposal, `${what} proposal`),
        changes: asChanges(entry.changes, `${what} changes`),
        changeSet: asChangeSet(entry.changeSet, `${what} change set`),
        diff: asDiff(entry.diff, `${what} diff`),
        redline: asRedline(entry.redline, `${what} redline`),
        preservation: asPreservation(entry.preservation, `${what} preservation`),
        protection: asProtection(entry.protection, `${what} protection`),
        reopened: asReopened(entry.reopened, what),
      };
    }
    case "preview": {
      const source = asSourceRef(entry.source, what);
      check(source, expected[0], "source");
      const structure = asRecord(entry.structure, `${what} structure`);
      return {
        operation,
        source,
        page: asPage(entry.page, `${what} page`, (item, name) => {
          const preview = asRecord(item, name);
          return {
            story: asString(preview.story, name),
            kind: asString(preview.kind, name),
            index: asInteger(preview.index, name),
            label: asString(preview.label, name),
            truncated: asBoolean(preview.truncated, name),
          };
        }),
        structure: {
          ...asCounts(structure, what),
          comments: asInteger(structure.comments, what),
          revisions: asInteger(structure.revisions, what),
        },
        protection: asProtection(entry.protection, `${what} protection`),
        pending: asDiff(entry.pending, `${what} pending changes`),
        redline: asRedline(entry.redline, `${what} redline`),
      };
    }
    default: {
      const sources = asRecord(entry.sources, `${what} sources`);
      const from = asSourceRef(sources.from, `${what} from`);
      const to = asSourceRef(sources.to, `${what} to`);
      check(from, expected[0], "from");
      check(to, expected[1], "to");
      return {
        operation: "compare",
        sources: { from, to },
        changeSet: asChangeSet(entry.changeSet, `${what} change set`),
        diff: asDiff(entry.diff, `${what} diff`),
        redline: asRedline(entry.redline, `${what} redline`),
        identical: asBoolean(entry.identical, what),
      };
    }
  }
}

/** The file reference a typed result reports, as the receipt's lineage records it. */
export function wordResultRef(leased: LeasedInput): WordSourceEvidence {
  return {
    fileId: leased.fileId,
    versionId: leased.versionId,
    name: leased.name,
    sha256: leased.sha256,
    size: leased.size,
  };
}

/** Whether a leased input is a Word file this adapter may open. */
export function isWordInput(leased: LeasedInput): boolean {
  return leased.format === WORD_FORMAT;
}
