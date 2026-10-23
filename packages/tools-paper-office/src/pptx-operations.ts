/**
 * The typed PowerPoint surface: what a role may ask of a `.pptx`, and the exact program each ask runs.
 *
 * A typed operation is not a second implementation of the Python adapter — it is the *only* way the
 * adapter is reached. The tool validates its arguments here, resolves every file reference against
 * the task's lease, and hands `pptx_adapter.run(operation, arguments)` a fixed, checked request. The
 * submitted code is a constant per operation, so the receipt's code hash names the operation and the
 * argument hash names the request: a replay returns the same receipt, and changed arguments under a
 * used operation ID fail closed.
 *
 * Nothing here takes a path. A file reference is a FileStore `fileId` with the `versionId`, `name`,
 * `sha256` and `size` the lease pinned; every one of those fields is checked against the lease before
 * the run, so a reference the lease does not grant refuses with `ungranted-input` rather than being
 * resolved by name.
 *
 * The paged sections (`read`, `preview`) always carry a page size, a cursor and a total, and the
 * result validator enforces that shape, so a huge deck cannot arrive as one unbounded reply.
 *
 * Seven operations, because PowerPoint has one primitive Word does not: a deck can absorb another
 * deck's slides (`compose`), and that import carries its own relationship-policy refusals and part
 * ledger. The other six mirror the Word adapter one for one — `inspect`, `read`, `create`, `edit`,
 * `preview`, `compare`.
 *
 * **What this surface does not do, and says so in every result:** there is no bitmap renderer.
 * `paper-pptx` ships no rasteriser and no text-fit helper, so a "preview" is structural and an
 * overflow report is a *computed estimate* from resolved font size and box geometry — or an explicit
 * limit when the estimate cannot be made. `rendering.bitmap` is `false` and a real renderer would need
 * isolation the worker does not have (RASF-3111).
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

export const INSPECT_PRESENTATION = "inspect_presentation";
export const READ_PRESENTATION = "read_presentation";
export const CREATE_PRESENTATION = "create_presentation";
export const EDIT_PRESENTATION = "edit_presentation";
export const PREVIEW_PRESENTATION = "preview_presentation";
export const COMPARE_PRESENTATION = "compare_presentation";
export const COMPOSE_PRESENTATION = "compose_presentation";

/** The seven typed PowerPoint operations, in the order the design names them. */
export type PptxOperation =
  | "inspect"
  | "read"
  | "create"
  | "edit"
  | "preview"
  | "compare"
  | "compose";

export const PPTX_OPERATIONS: readonly PptxOperation[] = [
  "inspect",
  "read",
  "create",
  "edit",
  "preview",
  "compare",
  "compose",
];

export const PPTX_TOOL_NAMES: Readonly<Record<PptxOperation, string>> = {
  inspect: INSPECT_PRESENTATION,
  read: READ_PRESENTATION,
  create: CREATE_PRESENTATION,
  edit: EDIT_PRESENTATION,
  preview: PREVIEW_PRESENTATION,
  compare: COMPARE_PRESENTATION,
  compose: COMPOSE_PRESENTATION,
};

export const PPTX_READ_SECTIONS = ["slides", "text", "shapes", "notes", "media"] as const;

export type PptxReadSection = (typeof PPTX_READ_SECTIONS)[number];

export const PPTX_BLOCK_KINDS = ["paragraph", "bullets", "table"] as const;
export const PPTX_COMPOSE_MODES = ["adopt_theme", "keep_appearance", "bake"] as const;
export const PPTX_DIFF_DETAILS = ["structure", "text", "full"] as const;

export const MAX_PPTX_PAGE = 50;
export const DEFAULT_PPTX_PAGE = 20;
export const MAX_PPTX_STEPS = 32;
export const MAX_PPTX_SLIDES = 100;
export const MAX_PPTX_BLOCKS = 200;

/** The one format this adapter owns. */
export const PPTX_FORMAT = "pptx";

// -- what a caller sends --------------------------------------------------------------------------

/** A leased PowerPoint file: the FileStore id and the version, name, hash and size the lease pinned. */
export interface PptxFileRef {
  readonly fileId: string;
  readonly versionId: string;
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}

/**
 * A block anchor: one exact paragraph's literal text, or the block `read_presentation` reported.
 *
 * The structural form is the fork's own `BlockAnchor`: `part`, `block_index`, `content_hash`, and —
 * for a current anchor — `version` and `locator`. `content_hash` is the fork's full structural
 * fingerprint; the fork refuses with `stale-anchor` when the block at that position no longer matches
 * it, which is the correct answer to "edit a proposal made against an older version".
 */
export type PptxAnchor =
  | { readonly text: string }
  | {
      readonly part: string;
      readonly block_index: number;
      readonly content_hash: string;
      readonly version: number;
      readonly locator: Readonly<Record<string, unknown>>;
    }
  | {
      readonly part: string;
      readonly block_index: number;
      readonly content_hash: string;
    };

// -- edit steps -----------------------------------------------------------------------------------

export interface PptxReplaceTextStep {
  readonly kind: "replaceText";
  readonly anchor: PptxAnchor;
  readonly find: string;
  readonly replace: string;
}

export interface PptxReplaceTextEverywhereStep {
  readonly kind: "replaceTextEverywhere";
  readonly find: string;
  readonly replace: string;
  readonly includeNotes?: boolean;
  /** Refuse unless exactly this many occurrences were replaced, so drift cannot pass silently. */
  readonly expect?: number;
}

export interface PptxWriteNotesStep {
  readonly kind: "writeNotes";
  readonly slide: number;
  readonly text: string;
}

export interface PptxAddSlideStep {
  readonly kind: "addSlide";
  readonly layout?: string;
  readonly at?: number;
}

export interface PptxCloneSlideStep {
  readonly kind: "cloneSlide";
  readonly slide: number;
  readonly at?: number;
}

export interface PptxDeleteSlideStep {
  readonly kind: "deleteSlide";
  readonly slide: number;
}

export interface PptxMoveSlideStep {
  readonly kind: "moveSlide";
  readonly slide: number;
  readonly to: number;
}

export interface PptxRebindLayoutStep {
  readonly kind: "rebindLayout";
  readonly slide: number;
  readonly layout: string;
  readonly orphanPolicy?: "refuse" | "bake";
}

export interface PptxApplyFootersStep {
  readonly kind: "applyFooters";
  readonly slide?: number;
  readonly footer?: string;
  readonly slideNumber?: boolean;
  readonly dateFormat?: string;
  readonly fixedDate?: string;
  readonly skipTitleSlides?: boolean;
}

export interface PptxDeleteShapeStep {
  readonly kind: "deleteShape";
  readonly slide: number;
  readonly shape?: string;
  readonly shapeId?: number;
}

export interface PptxMoveShapeStep {
  readonly kind: "moveShape";
  readonly slide: number;
  readonly shape?: string;
  readonly shapeId?: number;
  readonly to: number;
}

export interface PptxCopyShapeStep {
  readonly kind: "copyShape";
  readonly slide: number;
  readonly shape?: string;
  readonly shapeId?: number;
}

export type PptxEditStep =
  | PptxReplaceTextStep
  | PptxReplaceTextEverywhereStep
  | PptxWriteNotesStep
  | PptxAddSlideStep
  | PptxCloneSlideStep
  | PptxDeleteSlideStep
  | PptxMoveSlideStep
  | PptxRebindLayoutStep
  | PptxApplyFootersStep
  | PptxDeleteShapeStep
  | PptxMoveShapeStep
  | PptxCopyShapeStep;

// -- create blocks --------------------------------------------------------------------------------

export type PptxCreateBlock =
  | { readonly kind: "paragraph"; readonly text: string; readonly level?: number }
  | {
      readonly kind: "bullets";
      readonly items: readonly { readonly text: string; readonly level?: number }[];
    }
  | { readonly kind: "table"; readonly rows: readonly (readonly string[])[] };

export interface PptxSlideSpec {
  readonly title?: string;
  readonly layout?: string;
  readonly notes?: string;
  readonly blocks?: readonly PptxCreateBlock[];
}

/** What one typed operation asks for, with every output and source already resolved to the lease. */
export interface PptxProgram {
  readonly operation: PptxOperation;
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

function oneOf(value: unknown, what: string, allowed: readonly string[]): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw refusal("invalid-request", `${what} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

/** The shape of a file reference, before the lease is consulted. */
export function assertPptxFileRef(value: unknown, what: string): PptxFileRef {
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
 * lease, not the caller, decides what this operation may read, and a PowerPoint operation reads
 * `.pptx`.
 */
export function resolvePptxRef(lease: DocumentLease, value: unknown, what: string): LeasedInput {
  const ref = assertPptxFileRef(value, what);
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
  if (leased.format !== PPTX_FORMAT) {
    throw refusal("invalid-request", `${what} is a ${leased.format} file, not a .pptx`);
  }
  return leased;
}

/** The output name a request proposes: one path segment, `.pptx`, and permitted by the lease. */
export function resolvePptxOutput(lease: DocumentLease, value: unknown): string {
  const name = text(value, "an output name", 255);
  assertPathSegment(name, "an output name");
  if (!name.toLowerCase().endsWith(`.${PPTX_FORMAT}`)) {
    throw refusal("output-format", `an output named ${name} is not a .pptx file`);
  }
  if (!permitsFormat(lease, PPTX_FORMAT)) {
    throw refusal("output-format", "this task's lease does not permit a pptx output");
  }
  return name;
}

/** The structural anchor the adapter hands the fork, exactly as `read_presentation` reported it. */
function anchor(value: unknown, what: string): PptxAnchor {
  const entry = object(value, what);
  if ("text" in entry) {
    exactKeys(entry, ["text"], `${what} carries an unknown field`);
    return { text: text(entry.text, `${what} text`, 4_000) };
  }
  const hasVersion = entry.version !== undefined || entry.locator !== undefined;
  exactKeys(
    entry,
    hasVersion
      ? ["part", "block_index", "content_hash", "version", "locator"]
      : ["part", "block_index", "content_hash"],
    `${what} carries an unknown field`,
  );
  if (
    entry.part === undefined ||
    entry.block_index === undefined ||
    entry.content_hash === undefined
  ) {
    throw refusal("invalid-request", `${what} needs part, block_index and content_hash`);
  }
  const part = text(entry.part, `${what} part`, 512);
  const blockIndex = whole(entry.block_index, `${what} block_index`, 0, 100_000_000);
  const contentHash = text(entry.content_hash, `${what} content_hash`, 128);
  if (!/^[0-9a-f]{8,128}$/u.test(contentHash)) {
    throw refusal("invalid-request", `${what} content_hash must be lowercase hex`);
  }
  if (!hasVersion) return { part, block_index: blockIndex, content_hash: contentHash };
  if (entry.version === undefined || entry.locator === undefined) {
    throw refusal(
      "invalid-request",
      `${what} must carry both version and locator for a structural anchor, or neither`,
    );
  }
  const version = whole(entry.version, `${what} version`, 0, 1_000_000);
  const locator = object(entry.locator, `${what} locator`);
  return {
    part,
    block_index: blockIndex,
    content_hash: contentHash,
    version,
    locator,
  };
}

export const STEP_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  replaceText: ["anchor", "find", "replace"],
  replaceTextEverywhere: ["find", "replace"],
  writeNotes: ["slide", "text"],
  addSlide: [],
  cloneSlide: ["slide"],
  deleteSlide: ["slide"],
  moveSlide: ["slide", "to"],
  rebindLayout: ["slide", "layout"],
  applyFooters: [],
  deleteShape: ["slide"],
  moveShape: ["slide", "to"],
  copyShape: ["slide"],
};

export const STEP_OPTIONAL: Readonly<Record<string, readonly string[]>> = {
  replaceText: [],
  replaceTextEverywhere: ["includeNotes", "expect"],
  writeNotes: [],
  addSlide: ["layout", "at"],
  cloneSlide: ["at"],
  deleteSlide: [],
  moveSlide: [],
  rebindLayout: ["orphanPolicy"],
  applyFooters: ["slide", "footer", "slideNumber", "dateFormat", "fixedDate", "skipTitleSlides"],
  deleteShape: ["shape", "shapeId"],
  moveShape: ["shape", "shapeId"],
  copyShape: ["shape", "shapeId"],
};

/** One shape target: the adapter refuses unless exactly one of name and id is given. */
function shapeTarget(
  entry: Record<string, unknown>,
  what: string,
): { shape?: string; shapeId?: number } {
  const hasName = entry.shape !== undefined;
  const hasId = entry.shapeId !== undefined;
  if (hasName === hasId) {
    throw refusal(
      "invalid-request",
      `${what} must name its shape by exactly one of shape (display name) or shapeId`,
    );
  }
  if (hasName) return { shape: text(entry.shape, `${what} shape`, 255) };
  return { shapeId: whole(entry.shapeId, `${what} shapeId`, 0, 1_000_000_000) };
}

function stamp(entry: Record<string, unknown>, what: string): { orphanPolicy?: string } {
  const policy = entry.orphanPolicy;
  if (policy === undefined) return {};
  if (policy !== "refuse" && policy !== "bake") {
    throw refusal("invalid-request", `${what} orphanPolicy must be refuse or bake`);
  }
  return { orphanPolicy: policy };
}

/** Validates one edit step. The Python adapter validates the same shape again on the far side. */
export function assertPptxStep(value: unknown, index: number): PptxEditStep {
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
  const step = (fields: Record<string, unknown>): PptxEditStep => fields as unknown as PptxEditStep;

  switch (kind) {
    case "replaceText":
      return step({
        kind,
        anchor: anchor(entry.anchor, `${what} anchor`),
        find: text(entry.find, `${what} find`, 4_000),
        replace: maybeText(entry.replace, `${what} replace`, 4_000),
      });
    case "replaceTextEverywhere":
      return step({
        kind,
        find: text(entry.find, `${what} find`, 4_000),
        replace: maybeText(entry.replace, `${what} replace`, 4_000),
        ...(entry.includeNotes === undefined
          ? {}
          : { includeNotes: flag(entry.includeNotes, `${what} includeNotes`) }),
        ...(entry.expect === undefined
          ? {}
          : { expect: whole(entry.expect, `${what} expect`, 0, 1_000_000) }),
      });
    case "writeNotes":
      return step({
        kind,
        slide: whole(entry.slide, `${what} slide`, 0, 1_000_000),
        text: maybeText(entry.text, `${what} text`, 4_000),
      });
    case "addSlide":
      return step({
        kind,
        ...(entry.layout === undefined
          ? {}
          : { layout: text(entry.layout, `${what} layout`, 255) }),
        ...(entry.at === undefined ? {} : { at: whole(entry.at, `${what} at`, 0, 1_000_000) }),
      });
    case "cloneSlide":
      return step({
        kind,
        slide: whole(entry.slide, `${what} slide`, 0, 1_000_000),
        ...(entry.at === undefined ? {} : { at: whole(entry.at, `${what} at`, 0, 1_000_000) }),
      });
    case "deleteSlide":
      return step({ kind, slide: whole(entry.slide, `${what} slide`, 0, 1_000_000) });
    case "moveSlide":
      return step({
        kind,
        slide: whole(entry.slide, `${what} slide`, 0, 1_000_000),
        to: whole(entry.to, `${what} to`, 0, 1_000_000),
      });
    case "rebindLayout":
      return step({
        kind,
        slide: whole(entry.slide, `${what} slide`, 0, 1_000_000),
        layout: text(entry.layout, `${what} layout`, 255),
        ...stamp(entry, what),
      });
    case "applyFooters": {
      const fields: Record<string, unknown> = { kind };
      if (entry.slide !== undefined)
        fields.slide = whole(entry.slide, `${what} slide`, 0, 1_000_000);
      if (entry.footer !== undefined)
        fields.footer = maybeText(entry.footer, `${what} footer`, 1_000);
      if (entry.slideNumber !== undefined) {
        fields.slideNumber = flag(entry.slideNumber, `${what} slideNumber`);
      }
      if (entry.dateFormat !== undefined) {
        fields.dateFormat = text(entry.dateFormat, `${what} dateFormat`, 64);
      }
      if (entry.fixedDate !== undefined) {
        fields.fixedDate = text(entry.fixedDate, `${what} fixedDate`, 64);
      }
      if (entry.skipTitleSlides !== undefined) {
        fields.skipTitleSlides = flag(entry.skipTitleSlides, `${what} skipTitleSlides`);
      }
      return step(fields);
    }
    case "deleteShape":
      return step({
        kind,
        slide: whole(entry.slide, `${what} slide`, 0, 1_000_000),
        ...shapeTarget(entry, what),
      });
    case "moveShape":
      return step({
        kind,
        slide: whole(entry.slide, `${what} slide`, 0, 1_000_000),
        to: whole(entry.to, `${what} to`, 0, 1_000_000),
        ...shapeTarget(entry, what),
      });
    default:
      return step({
        kind,
        slide: whole(entry.slide, `${what} slide`, 0, 1_000_000),
        ...shapeTarget(entry, what),
      });
  }
}

/** Validates one block of a new draft slide. */
export function assertPptxBlock(value: unknown, index: number): PptxCreateBlock {
  const what = `block ${index}`;
  const entry = object(value, what);
  const kind = entry.kind;
  const allowed: Readonly<Record<string, readonly string[]>> = {
    paragraph: ["kind", "text", "level"],
    bullets: ["kind", "items"],
    table: ["kind", "rows"],
  };
  if (typeof kind !== "string" || allowed[kind] === undefined) {
    throw refusal("invalid-request", `${what} names an unknown kind`);
  }
  exactKeys(
    entry,
    allowed[kind] as readonly string[],
    `${what} carries a field it does not declare`,
  );
  if (kind === "paragraph") {
    return {
      kind,
      text: text(entry.text, `${what} text`, 4_000),
      ...(entry.level === undefined ? {} : { level: whole(entry.level, `${what} level`, 0, 8) }),
    };
  }
  if (kind === "bullets") {
    const items = entry.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 64) {
      throw refusal("invalid-request", `${what} needs 1 to 64 items`);
    }
    return {
      kind,
      items: items.map((item, itemIndex) => {
        const itemWhat = `${what} item ${itemIndex}`;
        const itemEntry = object(item, itemWhat, ["text", "level"]);
        if (itemEntry.text === undefined) {
          throw refusal("invalid-request", `${itemWhat} is missing text`);
        }
        return {
          text: text(itemEntry.text, `${itemWhat} text`, 4_000),
          ...(itemEntry.level === undefined
            ? {}
            : { level: whole(itemEntry.level, `${itemWhat} level`, 0, 8) }),
        };
      }),
    };
  }
  const rows = entry.rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 64) {
    throw refusal("invalid-request", `${what} needs 1 to 64 rows`);
  }
  const width = Array.isArray(rows[0]) ? rows[0].length : 0;
  if (width === 0 || width > 64)
    throw refusal("invalid-request", `${what} rows need 1 to 64 cells`);
  return {
    kind: "table",
    rows: rows.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== width) {
        throw refusal("invalid-request", `${what} rows must all hold ${width} cells`);
      }
      return row.map((cell, cellIndex) =>
        maybeText(cell, `${what} cell ${rowIndex}.${cellIndex}`, 4_000),
      );
    }),
  };
}

/** Validates one slide of a new draft. */
export function assertPptxSlide(value: unknown, index: number): PptxSlideSpec {
  const what = `slide ${index}`;
  const entry = object(value, what, ["title", "layout", "notes", "blocks"]);
  const blocks = entry.blocks;
  if (blocks !== undefined && (!Array.isArray(blocks) || blocks.length > MAX_PPTX_BLOCKS)) {
    throw refusal("invalid-request", `${what} takes at most ${MAX_PPTX_BLOCKS} blocks`);
  }
  if (Array.isArray(blocks) && blocks.length === 0) {
    throw refusal("invalid-request", `${what} needs a non-empty list of blocks`);
  }
  return {
    ...(entry.title === undefined ? {} : { title: text(entry.title, `${what} title`, 4_000) }),
    ...(entry.layout === undefined ? {} : { layout: text(entry.layout, `${what} layout`, 255) }),
    ...(entry.notes === undefined ? {} : { notes: text(entry.notes, `${what} notes`, 4_000) }),
    ...(blocks === undefined
      ? {}
      : { blocks: blocks.map((block, blockIndex) => assertPptxBlock(block, blockIndex)) }),
  };
}

// -- turning a request into a program ---------------------------------------------------------------

function pageOf(entry: Record<string, unknown>, what: string): Record<string, unknown> {
  return {
    ...(entry.cursor === undefined
      ? {}
      : { cursor: whole(entry.cursor, `${what} cursor`, 0, 1_000_000_000) }),
    ...(entry.pageSize === undefined
      ? {}
      : { pageSize: whole(entry.pageSize, `${what} pageSize`, 1, MAX_PPTX_PAGE) }),
  };
}

function detailOf(entry: Record<string, unknown>, what: string): Record<string, unknown> {
  return entry.detail === undefined
    ? {}
    : { detail: oneOf(entry.detail, `${what} detail`, PPTX_DIFF_DETAILS) };
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

/**
 * The Python program one typed operation runs: a constant per operation, plus the checked arguments.
 * The operation name lives in the code, so a receipt's code hash names the operation and its argument
 * hash names the request.
 */
export function pptxInstruction(operation: PptxOperation): string {
  return [
    "import pptx_adapter",
    "",
    `documents.result(pptx_adapter.run(${JSON.stringify(operation)}, documents.arguments()))`,
  ].join("\n");
}

/**
 * Validates a typed request against the lease and returns the program to run. Everything a path could
 * hide is resolved here: inputs are lease version IDs, the output is a single staging file name.
 */
export function pptxProgram(
  operation: PptxOperation,
  args: unknown,
  lease: DocumentLease,
): PptxProgram {
  const entry = object(args, `the ${PPTX_TOOL_NAMES[operation]} arguments`);
  const code = pptxInstruction(operation);
  const base = { operation, code, sources: [] as readonly LeasedInput[], output: null };

  switch (operation) {
    case "inspect": {
      exactKeys(entry, ["ref"], "inspect carries a field it does not declare");
      const source = resolvePptxRef(lease, entry.ref, "the inspect ref");
      return { ...base, sources: [source], arguments: { ref: refArgument(source) } };
    }
    case "read": {
      exactKeys(
        entry,
        ["ref", "section", "cursor", "pageSize"],
        "read carries a field it does not declare",
      );
      if (entry.ref === undefined || entry.section === undefined) {
        throw refusal("invalid-request", "read needs a ref and a section");
      }
      const section = oneOf(entry.section, "a read section", PPTX_READ_SECTIONS);
      const source = resolvePptxRef(lease, entry.ref, "the read ref");
      return {
        ...base,
        sources: [source],
        arguments: { ref: refArgument(source), section, ...pageOf(entry, "read") },
      };
    }
    case "preview": {
      exactKeys(
        entry,
        ["ref", "cursor", "pageSize"],
        "preview carries a field it does not declare",
      );
      if (entry.ref === undefined) throw refusal("invalid-request", "preview needs a ref");
      const source = resolvePptxRef(lease, entry.ref, "the preview ref");
      return {
        ...base,
        sources: [source],
        arguments: { ref: refArgument(source), ...pageOf(entry, "preview") },
      };
    }
    case "compare": {
      exactKeys(entry, ["from", "to", "detail"], "compare carries a field it does not declare");
      if (entry.from === undefined || entry.to === undefined) {
        throw refusal("invalid-request", "compare needs from and to");
      }
      const from = resolvePptxRef(lease, entry.from, "the compare from ref");
      const to = resolvePptxRef(lease, entry.to, "the compare to ref");
      return {
        ...base,
        sources: [from, to],
        arguments: {
          from: refArgument(from),
          to: refArgument(to),
          ...detailOf(entry, "compare"),
        },
      };
    }
    case "create": {
      exactKeys(entry, ["output", "slides"], "create carries a field it does not declare");
      const name = resolvePptxOutput(lease, entry.output);
      if (!Array.isArray(entry.slides) || entry.slides.length === 0) {
        throw refusal("invalid-request", "create needs a non-empty list of slides");
      }
      if (entry.slides.length > MAX_PPTX_SLIDES) {
        throw refusal("invalid-request", `create takes at most ${MAX_PPTX_SLIDES} slides`);
      }
      const slides = entry.slides.map((slide, index) => assertPptxSlide(slide, index));
      return {
        ...base,
        output: { name, editOf: null },
        arguments: { output: name, slides },
      };
    }
    case "compose": {
      exactKeys(
        entry,
        ["into", "from", "output", "mode", "notes", "detail"],
        "compose carries a field it does not declare",
      );
      for (const key of ["into", "from", "output", "mode"]) {
        if (entry[key] === undefined) throw refusal("invalid-request", `compose is missing ${key}`);
      }
      const into = resolvePptxRef(lease, entry.into, "the compose destination ref");
      if (!into.writable) {
        throw refusal(
          "unleased-path",
          `this task's lease grants read-only access to ${into.name}, so it cannot propose a new version of it`,
        );
      }
      const from = resolvePptxRef(lease, entry.from, "the compose source ref");
      const name = resolvePptxOutput(lease, entry.output);
      const mode = oneOf(entry.mode, "a compose mode", PPTX_COMPOSE_MODES);
      return {
        ...base,
        sources: [into, from],
        output: { name, editOf: into.versionId },
        arguments: {
          into: refArgument(into),
          from: refArgument(from),
          output: name,
          mode,
          ...(entry.notes === undefined ? {} : { notes: flag(entry.notes, "compose notes") }),
          ...detailOf(entry, "compose"),
        },
      };
    }
    default: {
      exactKeys(
        entry,
        ["ref", "output", "steps", "detail"],
        "edit carries a field it does not declare",
      );
      for (const key of ["ref", "output", "steps"]) {
        if (entry[key] === undefined) throw refusal("invalid-request", `edit is missing ${key}`);
      }
      const source = resolvePptxRef(lease, entry.ref, "the edit source ref");
      if (!source.writable) {
        throw refusal(
          "unleased-path",
          `this task's lease grants read-only access to ${source.name}, so it cannot propose a new version of it`,
        );
      }
      const name = resolvePptxOutput(lease, entry.output);
      if (!Array.isArray(entry.steps) || entry.steps.length === 0) {
        throw refusal("invalid-request", "edit needs a non-empty list of steps");
      }
      if (entry.steps.length > MAX_PPTX_STEPS) {
        throw refusal("invalid-request", `edit takes at most ${MAX_PPTX_STEPS} steps`);
      }
      const steps = entry.steps.map((step, index) => assertPptxStep(step, index));
      return {
        ...base,
        sources: [source],
        output: { name, editOf: source.versionId },
        arguments: {
          ref: refArgument(source),
          output: name,
          steps,
          ...detailOf(entry, "edit"),
        },
      };
    }
  }
}

// -- reading the answer ---------------------------------------------------------------------------

export type PptxSourceEvidence = PptxFileRef;

export interface PptxDeckCensus {
  readonly slides: number;
  readonly masters: number;
  readonly layouts: number;
  readonly shapes: number;
  readonly textBlocks: number;
  readonly blindTextBlocks: number;
  readonly notesSlides: number;
  readonly mediaParts: number;
  readonly mediaReferences: number;
  readonly orphanMediaParts: number;
  readonly pictures: number;
  readonly tables: number;
  readonly charts: number;
  readonly groups: number;
  readonly alternateContent: number;
  readonly slideWidthEmu: number | null;
  readonly slideHeightEmu: number | null;
}

export interface PptxOverflowTotals {
  readonly shapes: number;
  readonly overflowing: number;
  readonly compensated: number;
  readonly unresolved: number;
}

export interface PptxOverflowItem {
  readonly name: string;
  readonly shapeId: number;
  /** Whether a number was computed at all; `false` means the report says why it could not be. */
  readonly computed: boolean;
  readonly overflow: boolean | null;
  /** `true` when the deck's own declared autofit already accounts for the text. */
  readonly compensated: boolean;
  readonly method: string;
  readonly reason: string | null;
  readonly declared: Readonly<Record<string, unknown>>;
}

export interface PptxSlideOutline {
  readonly position: number;
  readonly slideId: number;
  readonly part: string;
  readonly layoutName: string;
  readonly titleShape: string | null;
  readonly titleText: string | null;
  readonly shapeCount: number;
  readonly textBlockCount: number;
  readonly hasNotes: boolean;
  readonly mediaCount: number;
  readonly alternateContent: number;
}

export interface PptxMediaItem {
  readonly position: number | null;
  readonly slideId: number | null;
  readonly part: string | null;
  readonly rId: string | null;
  readonly kind: string;
  readonly target: string;
  readonly contentType: string | null;
  readonly ext: string | null;
  readonly sha256: string | null;
  readonly bytes: number | null;
}

export interface PptxFontSummary {
  readonly sizeEmu: number | null;
  readonly sizePt: number | null;
  readonly sizeResolved: boolean;
  readonly name: string | null;
  readonly nameResolved: boolean;
  readonly colorRgb: string | null;
  readonly colorResolved: boolean;
}

export interface PptxRunItem {
  readonly text: string;
  readonly truncated: boolean;
  readonly font: PptxFontSummary;
  readonly fieldType?: string;
}

export interface PptxTextBlockItem {
  readonly position: number;
  readonly slideId: number;
  readonly part: string;
  readonly blockIndex: number;
  readonly anchor: Readonly<Record<string, unknown>>;
  readonly shapeId: number;
  readonly shapeName: string;
  readonly placeholderType: string | null;
  readonly container: string;
  readonly containerDetail: string | null;
  /** Table-cell text: its effective values are unresolvable by design, and it says so. */
  readonly blind: boolean;
  readonly level: number;
  readonly fields: readonly string[];
  readonly text: string;
  readonly truncated: boolean;
  readonly runs: readonly PptxRunItem[];
  readonly runsTruncated: boolean;
}

export interface PptxShapeItem {
  readonly position: number;
  readonly slideId: number;
  readonly shapeId: number;
  readonly name: string;
  readonly kind: string;
  readonly zIndex: number;
  readonly placeholderType: string | null;
  readonly left: number | null;
  readonly top: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly rotation: number | null;
  readonly textBlockCount: number;
  readonly autofit: Readonly<Record<string, unknown>> | null;
  readonly table: Readonly<Record<string, unknown>> | null;
  readonly chart: Readonly<Record<string, unknown>> | null;
  readonly image: Readonly<Record<string, unknown>> | null;
  readonly children: readonly PptxShapeItem[];
  readonly childrenTruncated: boolean;
}

export interface PptxNotesItem {
  readonly position: number;
  readonly slideId: number;
  readonly part: string;
  readonly present: boolean;
  readonly text: string;
  readonly truncated: boolean;
}

export type PptxItem =
  | PptxSlideOutline
  | PptxTextBlockItem
  | PptxShapeItem
  | PptxNotesItem
  | PptxMediaItem;

export interface PptxPage<T> {
  readonly section: string;
  readonly pageSize: number;
  readonly cursor: number;
  readonly returned: number;
  readonly total: number;
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
  readonly items: readonly T[];
}

export interface PptxPartChange {
  readonly part: string;
  readonly kind: string;
  readonly change: string;
  readonly detail: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly semanticChange: boolean;
}

/** The structural change set: what the edit added, removed, changed or left byte-identical. */
export interface PptxChangeSet {
  readonly schema: string;
  readonly version: number;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly PptxPartChange[];
  readonly byteIdenticalCount: number;
  readonly partCountBefore: number;
  readonly partCountAfter: number;
  readonly semanticallyEmpty: boolean;
}

export interface PptxDiff {
  readonly schema: string;
  readonly version: number;
  readonly detail: string;
  readonly slidesAdded: readonly Readonly<Record<string, unknown>>[];
  readonly slidesRemoved: readonly Readonly<Record<string, unknown>>[];
  readonly slidesMoved: readonly Readonly<Record<string, unknown>>[];
  readonly slideChanges: readonly Readonly<Record<string, unknown>>[];
  readonly slideChangeTotal: number;
  readonly packageChanges: readonly Readonly<Record<string, unknown>>[];
  readonly identical: boolean;
}

/** The byte-argued preservation evidence: which parts came back exactly as they arrived. */
export interface PptxPreservation {
  readonly byteIdenticalCount: number;
  /** A bounded, category-ordered sample of the byte-identical parts, each with its sha256. */
  readonly byteIdentical: readonly { readonly part: string; readonly sha256: string }[];
  readonly byteIdenticalTruncated: boolean;
  readonly byteIdenticalHashed: number;
  readonly changedParts: readonly string[];
  readonly addedParts: readonly string[];
  readonly removedParts: readonly string[];
  readonly mediaByteIdentical: readonly string[];
  readonly themeByteIdentical: readonly string[];
  readonly layoutByteIdentical: readonly string[];
  readonly masterByteIdentical: readonly string[];
  readonly notesByteIdentical: readonly string[];
  readonly slidePartsByteIdentical: readonly string[];
  readonly verbatimCopy: boolean;
}

export interface PptxPreviewLine {
  readonly marker: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly shape: string;
  readonly label: string;
}

export interface PptxSlidePreview {
  readonly position: number | null;
  readonly slideId: number;
  readonly part: string;
  readonly layoutName: string;
  readonly titleText: string | null;
  readonly lines: readonly PptxPreviewLine[];
  readonly linesTruncated: boolean;
  readonly notes: { readonly present: boolean; readonly text: string | null };
  readonly media: readonly PptxMediaItem[];
  readonly overflow: {
    readonly summary: PptxOverflowTotals;
    readonly items: readonly PptxOverflowItem[];
  };
}

/** Before/after structural previews for the slides a change set says changed. */
export interface PptxBeforeAfter {
  readonly changed: readonly {
    readonly slideId: number;
    readonly change: Readonly<Record<string, unknown>>;
    readonly before: PptxSlidePreview;
    readonly after: PptxSlidePreview;
  }[];
  readonly changedTotal: number;
  readonly added: readonly Readonly<Record<string, unknown>>[];
  readonly addedTotal: number;
  readonly removed: readonly Readonly<Record<string, unknown>>[];
  readonly removedTotal: number;
  readonly moved: readonly Readonly<Record<string, unknown>>[];
  readonly limit: number;
  readonly limitNote: string;
}

/** What a caller must know about rendering in this workspace. `bitmap` is always false. */
export interface PptxRendering {
  readonly bitmap: false;
  readonly method: string;
  readonly overflowMethod: string;
  readonly constants: Readonly<Record<string, number>>;
  readonly limits: readonly string[];
  readonly isolation: string;
}

/** A new draft, or a proposal for an existing file that nothing has published yet. */
export interface PptxProposal {
  readonly status: "draft" | "proposed";
  readonly name: string;
  readonly editOf: string | null;
  readonly sha256: string;
  readonly size: number;
  readonly published: false;
}

export interface PptxChangeRecord {
  readonly kind: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface PptxInspection {
  readonly operation: "inspect";
  readonly source: PptxSourceEvidence;
  readonly deck: PptxDeckCensus;
  readonly overflow: PptxOverflowTotals;
  readonly overflowSlides: readonly Readonly<Record<string, unknown>>[];
  readonly slideOutline: readonly PptxSlideOutline[];
  readonly slideOutlineTruncated: boolean;
  readonly mediaOutline: readonly PptxMediaItem[];
  readonly mediaOutlineTruncated: boolean;
  readonly orphanMediaParts: readonly string[];
  readonly warnings: readonly string[];
  readonly rendering: PptxRendering;
}

export interface PptxReading {
  readonly operation: "read";
  readonly source: PptxSourceEvidence;
  readonly deck: PptxDeckCensus;
  readonly page: PptxPage<PptxItem>;
}

export interface PptxDraft {
  readonly operation: "create";
  readonly draft: PptxProposal;
  readonly structure: PptxDeckCensus;
  readonly placements: readonly Readonly<Record<string, unknown>>[];
  readonly overflow: PptxOverflowTotals;
  readonly overflowSlides: readonly unknown[];
  readonly provenance: { readonly template: string; readonly source: null };
  readonly reopened: Readonly<Record<string, number>>;
  readonly rendering: PptxRendering;
}

export interface PptxPreview {
  readonly operation: "preview";
  readonly source: PptxSourceEvidence;
  readonly page: PptxPage<PptxSlidePreview>;
  readonly deck: PptxDeckCensus;
  readonly overflow: PptxOverflowTotals;
  readonly overflowSlides: readonly unknown[];
  readonly media: {
    readonly references: readonly PptxMediaItem[];
    readonly orphanParts: readonly string[];
  };
  readonly warnings: readonly string[];
  readonly rendering: PptxRendering;
}

/** The shared shape of `edit` and `compose`: a proposal, a change set, a diff and its evidence. */
interface PptxProposalReport {
  readonly source: PptxSourceEvidence;
  readonly proposal: PptxProposal;
  readonly changeSet: PptxChangeSet;
  readonly diff: PptxDiff;
  readonly preview: PptxBeforeAfter;
  readonly preservation: PptxPreservation;
  readonly patch: {
    readonly schema: string;
    readonly version: number;
    /** How many parts the fork's own narrow-save comparison reported as still different. */
    readonly residualCount: number;
    readonly isEmpty: boolean;
  };
  readonly overflow: PptxOverflowTotals;
  readonly overflowSlides: readonly unknown[];
  readonly reopened: Readonly<Record<string, number>>;
  readonly rendering: PptxRendering;
}

export interface PptxEdit extends PptxProposalReport {
  readonly operation: "edit";
  readonly changes: readonly PptxChangeRecord[];
  readonly steps: readonly string[];
}

export interface PptxCompose extends PptxProposalReport {
  readonly operation: "compose";
  readonly sources: { readonly into: PptxSourceEvidence; readonly from: PptxSourceEvidence };
  readonly mode: string;
  readonly imports: readonly Readonly<Record<string, unknown>>[];
  readonly importCount: number;
}

export interface PptxComparison {
  readonly operation: "compare";
  readonly sources: { readonly from: PptxSourceEvidence; readonly to: PptxSourceEvidence };
  readonly changeSet: PptxChangeSet;
  readonly diff: PptxDiff;
  readonly preview: PptxBeforeAfter;
  readonly identical: boolean;
  readonly rendering: PptxRendering;
}

export type PptxResult =
  | PptxInspection
  | PptxReading
  | PptxDraft
  | PptxEdit
  | PptxPreview
  | PptxComparison
  | PptxCompose;

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

function asNullableInteger(value: unknown, what: string): number | null {
  if (value === null) return null;
  return asInteger(value, what);
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

function asRecords(value: unknown, what: string): readonly Readonly<Record<string, unknown>>[] {
  return asList(value, what).map((item) => asRecord(item, what));
}

function asNullableRecord(value: unknown, what: string): Readonly<Record<string, unknown>> | null {
  if (value === null) return null;
  return asRecord(value, what);
}

function asNumberMap(value: unknown, what: string): Readonly<Record<string, number>> {
  const entry = asRecord(value, what);
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(entry)) out[key] = asNumber(item, what);
  return out;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(what);
  return value;
}

function asSourceRef(value: unknown, what: string): PptxSourceEvidence {
  const entry = asRecord(value, what);
  return {
    fileId: asString(entry.fileId, what),
    versionId: asString(entry.versionId, what),
    name: asString(entry.name, what),
    sha256: asString(entry.sha256, what),
    size: asInteger(entry.size, what),
  };
}

function asCensus(value: unknown, what: string): PptxDeckCensus {
  const entry = asRecord(value, what);
  return {
    slides: asInteger(entry.slides, what),
    masters: asInteger(entry.masters, what),
    layouts: asInteger(entry.layouts, what),
    shapes: asInteger(entry.shapes, what),
    textBlocks: asInteger(entry.textBlocks, what),
    blindTextBlocks: asInteger(entry.blindTextBlocks, what),
    notesSlides: asInteger(entry.notesSlides, what),
    mediaParts: asInteger(entry.mediaParts, what),
    mediaReferences: asInteger(entry.mediaReferences, what),
    orphanMediaParts: asInteger(entry.orphanMediaParts, what),
    pictures: asInteger(entry.pictures, what),
    tables: asInteger(entry.tables, what),
    charts: asInteger(entry.charts, what),
    groups: asInteger(entry.groups, what),
    alternateContent: asInteger(entry.alternateContent, what),
    slideWidthEmu: asNullableInteger(entry.slideWidthEmu, what),
    slideHeightEmu: asNullableInteger(entry.slideHeightEmu, what),
  };
}

function asOverflowTotals(value: unknown, what: string): PptxOverflowTotals {
  const entry = asRecord(value, what);
  return {
    shapes: asInteger(entry.shapes, what),
    overflowing: asInteger(entry.overflowing, what),
    compensated: asInteger(entry.compensated, what),
    unresolved: asInteger(entry.unresolved, what),
  };
}

function asOverflowItem(value: unknown, what: string): PptxOverflowItem {
  const entry = asRecord(value, what);
  const overflow = entry.overflow === null ? null : asBoolean(entry.overflow, what);
  const computed = asBoolean(entry.computed, what);
  const compensated = asBoolean(entry.compensated, what);
  // The contract: a report either computed an answer or says why it could not. Silence is refused.
  if (!computed && !compensated && entry.reason === null) {
    throw refusal(
      "output-invalid",
      "the worker reported an overflow it could not compute without saying why",
    );
  }
  return {
    name: asString(entry.name, what),
    shapeId: asInteger(entry.shapeId, what),
    computed,
    overflow,
    compensated,
    method: asString(entry.method, what),
    reason: asNullableString(entry.reason, what),
    declared: asRecord(entry.declared, what),
  };
}

function asRendering(value: unknown, what: string): PptxRendering {
  const entry = asRecord(value, what);
  if (entry.bitmap !== false) {
    throw refusal(
      "output-invalid",
      "the worker claimed a bitmap rendering this workspace cannot produce",
    );
  }
  return {
    bitmap: false,
    method: asString(entry.method, what),
    overflowMethod: asString(entry.overflowMethod, what),
    constants: asNumberMap(entry.constants, what),
    limits: asStrings(entry.limits, what),
    isolation: asString(entry.isolation, what),
  };
}

function asSlideOutline(value: unknown, what: string): PptxSlideOutline {
  const entry = asRecord(value, what);
  return {
    position: asInteger(entry.position, what),
    slideId: asInteger(entry.slideId, what),
    part: asString(entry.part, what),
    layoutName: asString(entry.layoutName, what),
    titleShape: asNullableString(entry.titleShape, what),
    titleText: asNullableString(entry.titleText, what),
    shapeCount: asInteger(entry.shapeCount, what),
    textBlockCount: asInteger(entry.textBlockCount, what),
    hasNotes: asBoolean(entry.hasNotes, what),
    mediaCount: asInteger(entry.mediaCount, what),
    alternateContent: asInteger(entry.alternateContent, what),
  };
}

function asMediaItem(value: unknown, what: string): PptxMediaItem {
  const entry = asRecord(value, what);
  return {
    position: asNullableInteger(entry.position, what),
    slideId: asNullableInteger(entry.slideId, what),
    part: asNullableString(entry.part, what),
    rId: asNullableString(entry.rId, what),
    kind: asString(entry.kind, what),
    target: asString(entry.target, what),
    contentType: asNullableString(entry.contentType, what),
    ext: asNullableString(entry.ext, what),
    sha256: asNullableString(entry.sha256, what),
    bytes: asNullableInteger(entry.bytes, what),
  };
}

function asFontSummary(value: unknown, what: string): PptxFontSummary {
  const entry = asRecord(value, what);
  return {
    sizeEmu: asNullableInteger(entry.sizeEmu, what),
    sizePt:
      entry.sizePt === null || entry.sizePt === undefined ? null : asNumber(entry.sizePt, what),
    sizeResolved: asBoolean(entry.sizeResolved, what),
    name: asNullableString(entry.name, what),
    nameResolved: asBoolean(entry.nameResolved, what),
    colorRgb: asNullableString(entry.colorRgb, what),
    colorResolved: asBoolean(entry.colorResolved, what),
  };
}

function asRunItem(value: unknown, what: string): PptxRunItem {
  const entry = asRecord(value, what);
  return {
    text: asString(entry.text, what),
    truncated: asBoolean(entry.truncated, what),
    font: asFontSummary(entry.font, what),
    ...(entry.fieldType === undefined ? {} : { fieldType: asString(entry.fieldType, what) }),
  };
}

function asTextBlockItem(value: unknown, what: string): PptxTextBlockItem {
  const entry = asRecord(value, what);
  return {
    position: asInteger(entry.position, what),
    slideId: asInteger(entry.slideId, what),
    part: asString(entry.part, what),
    blockIndex: asInteger(entry.blockIndex, what),
    anchor: asRecord(entry.anchor, what),
    shapeId: asInteger(entry.shapeId, what),
    shapeName: asString(entry.shapeName, what),
    placeholderType: asNullableString(entry.placeholderType, what),
    container: asString(entry.container, what),
    containerDetail: asNullableString(entry.containerDetail, what),
    blind: asBoolean(entry.blind, what),
    level: asInteger(entry.level, what),
    fields: asStrings(entry.fields, what),
    text: asString(entry.text, what),
    truncated: asBoolean(entry.truncated, what),
    runs: asList(entry.runs, what).map((run) => asRunItem(run, `${what} run`)),
    runsTruncated: asBoolean(entry.runsTruncated, what),
  };
}

function asShapeItem(value: unknown, what: string): PptxShapeItem {
  const entry = asRecord(value, what);
  return {
    position: asInteger(entry.position, what),
    slideId: asInteger(entry.slideId, what),
    shapeId: asInteger(entry.shapeId, what),
    name: asString(entry.name, what),
    kind: asString(entry.kind, what),
    zIndex: asInteger(entry.zIndex, what),
    placeholderType: asNullableString(entry.placeholderType, what),
    left: asNullableInteger(entry.left, what),
    top: asNullableInteger(entry.top, what),
    width: asNullableInteger(entry.width, what),
    height: asNullableInteger(entry.height, what),
    rotation: entry.rotation === null ? null : asNumber(entry.rotation, what),
    textBlockCount: asInteger(entry.textBlockCount, what),
    autofit: asNullableRecord(entry.autofit, what),
    table: asNullableRecord(entry.table, what),
    chart: asNullableRecord(entry.chart, what),
    image: asNullableRecord(entry.image, what),
    children: asList(entry.children, what).map((child) => asShapeItem(child, `${what} child`)),
    childrenTruncated: asBoolean(entry.childrenTruncated, what),
  };
}

function asNotesItem(value: unknown, what: string): PptxNotesItem {
  const entry = asRecord(value, what);
  return {
    position: asInteger(entry.position, what),
    slideId: asInteger(entry.slideId, what),
    part: asString(entry.part, what),
    present: asBoolean(entry.present, what),
    text: asString(entry.text, what),
    truncated: asBoolean(entry.truncated, what),
  };
}

/**
 * Which item validator a page's `section` promises. The section decides, so a table of the wrong
 * shape can never be read as text.
 */
function asItem(section: string, value: unknown, what: string): PptxItem {
  switch (section) {
    case "slides":
      return asSlideOutline(value, what);
    case "text":
      return asTextBlockItem(value, what);
    case "shapes":
      return asShapeItem(value, what);
    case "notes":
      return asNotesItem(value, what);
    default:
      return asMediaItem(value, what);
  }
}

function asPage<T>(
  value: unknown,
  what: string,
  item: (value: unknown, what: string) => T,
): PptxPage<T> {
  const entry = asRecord(value, what);
  const pageSize = asInteger(entry.pageSize, what);
  const returned = asInteger(entry.returned, what);
  if (pageSize < 1 || pageSize > MAX_PPTX_PAGE || returned > pageSize) throw invalid(what);
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

function asChangeSet(value: unknown, what: string): PptxChangeSet {
  const entry = asRecord(value, what);
  const changed = asList(entry.changed, what).map((part) => {
    const item = asRecord(part, what);
    return {
      part: asString(item.part, what),
      kind: asString(item.kind, what),
      change: asString(item.change, what),
      detail: asString(item.detail, what),
      beforeSha256: asNullableString(item.beforeSha256, what),
      afterSha256: asNullableString(item.afterSha256, what),
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
    partCountBefore: asInteger(entry.partCountBefore, what),
    partCountAfter: asInteger(entry.partCountAfter, what),
    semanticallyEmpty: asBoolean(entry.semanticallyEmpty, what),
  };
}

function asDiff(value: unknown, what: string): PptxDiff {
  const entry = asRecord(value, what);
  return {
    schema: asString(entry.schema, what),
    version: asInteger(entry.version, what),
    detail: asString(entry.detail, what),
    slidesAdded: asRecords(entry.slidesAdded, what),
    slidesRemoved: asRecords(entry.slidesRemoved, what),
    slidesMoved: asRecords(entry.slidesMoved, what),
    slideChanges: asRecords(entry.slideChanges, what),
    slideChangeTotal: asInteger(entry.slideChangeTotal, what),
    packageChanges: asRecords(entry.packageChanges, what),
    identical: asBoolean(entry.identical, what),
  };
}

function asPreservation(value: unknown, what: string): PptxPreservation {
  const entry = asRecord(value, what);
  const byteIdentical = asList(entry.byteIdentical, what).map((item) => {
    const record_ = asRecord(item, what);
    return {
      part: asString(record_.part, what),
      sha256: asString(record_.sha256, what),
    };
  });
  const count = asInteger(entry.byteIdenticalCount, what);
  if (byteIdentical.length > count) throw invalid(what);
  return {
    byteIdenticalCount: count,
    byteIdentical,
    byteIdenticalTruncated: asBoolean(entry.byteIdenticalTruncated, what),
    byteIdenticalHashed: asInteger(entry.byteIdenticalHashed, what),
    changedParts: asStrings(entry.changedParts, what),
    addedParts: asStrings(entry.addedParts, what),
    removedParts: asStrings(entry.removedParts, what),
    mediaByteIdentical: asStrings(entry.mediaByteIdentical, what),
    themeByteIdentical: asStrings(entry.themeByteIdentical, what),
    layoutByteIdentical: asStrings(entry.layoutByteIdentical, what),
    masterByteIdentical: asStrings(entry.masterByteIdentical, what),
    notesByteIdentical: asStrings(entry.notesByteIdentical, what),
    slidePartsByteIdentical: asStrings(entry.slidePartsByteIdentical, what),
    verbatimCopy: asBoolean(entry.verbatimCopy, what),
  };
}

function asPreviewLine(value: unknown, what: string): PptxPreviewLine {
  const entry = asRecord(value, what);
  return {
    marker: asString(entry.marker, what),
    text: asString(entry.text, what),
    truncated: asBoolean(entry.truncated, what),
    shape: asString(entry.shape, what),
    label: asString(entry.label, what),
  };
}

function asSlidePreview(value: unknown, what: string): PptxSlidePreview {
  const entry = asRecord(value, what);
  const notes = asRecord(entry.notes, what);
  const overflow = asRecord(entry.overflow, what);
  return {
    position: asNullableInteger(entry.position, what),
    slideId: asInteger(entry.slideId, what),
    part: asString(entry.part, what),
    layoutName: asString(entry.layoutName, what),
    titleText: asNullableString(entry.titleText, what),
    lines: asList(entry.lines, what).map((line) => asPreviewLine(line, what)),
    linesTruncated: asBoolean(entry.linesTruncated, what),
    notes: {
      present: asBoolean(notes.present, what),
      text: asNullableString(notes.text, what),
    },
    media: asList(entry.media, what).map((item) => asMediaItem(item, what)),
    overflow: {
      summary: asOverflowTotals(overflow.summary, what),
      items: asList(overflow.items, what).map((item) => asOverflowItem(item, what)),
    },
  };
}

function asBeforeAfter(value: unknown, what: string): PptxBeforeAfter {
  const entry = asRecord(value, what);
  return {
    changed: asList(entry.changed, what).map((pair) => {
      const item = asRecord(pair, what);
      return {
        slideId: asInteger(item.slideId, what),
        change: asRecord(item.change, what),
        before: asSlidePreview(item.before, what),
        after: asSlidePreview(item.after, what),
      };
    }),
    changedTotal: asInteger(entry.changedTotal, what),
    added: asRecords(entry.added, what),
    addedTotal: asInteger(entry.addedTotal, what),
    removed: asRecords(entry.removed, what),
    removedTotal: asInteger(entry.removedTotal, what),
    moved: asRecords(entry.moved, what),
    limit: asInteger(entry.limit, what),
    limitNote: asString(entry.limitNote, what),
  };
}

function asProposal(value: unknown, what: string): PptxProposal {
  const entry = asRecord(value, what);
  const status = asString(entry.status, what);
  if (status !== "draft" && status !== "proposed") throw invalid(what);
  if (entry.published !== false) {
    throw refusal(
      "output-invalid",
      "the worker reported a published PowerPoint file, which no operation does",
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

function asReopened(value: unknown, what: string): Readonly<Record<string, number>> {
  const entry = asRecord(value, what);
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(entry)) out[key] = asInteger(item, what);
  return out;
}

function asChanges(value: unknown, what: string): readonly PptxChangeRecord[] {
  return asList(value, what).map((item) => {
    const entry = asRecord(item, what);
    return {
      kind: asString(entry.kind, what),
      evidence: asRecord(entry.evidence, what),
    };
  });
}

function asWarnings(value: unknown, what: string): readonly string[] {
  return asStrings(value, what);
}

function asProposalReport(entry: Record<string, unknown>, what: string): PptxProposalReport {
  const source = asSourceRef(entry.source, what);
  const patch = asRecord(entry.patch, what);
  const overflow = asRecord(entry.overflow, what);
  return {
    source,
    proposal: asProposal(entry.proposal, `${what} proposal`),
    changeSet: asChangeSet(entry.changeSet, `${what} change set`),
    diff: asDiff(entry.diff, `${what} diff`),
    preview: asBeforeAfter(entry.preview, `${what} preview`),
    preservation: asPreservation(entry.preservation, `${what} preservation`),
    patch: {
      schema: asString(patch.schema, what),
      version: asInteger(patch.version, what),
      residualCount: asInteger(patch.residualCount, what),
      isEmpty: asBoolean(patch.isEmpty, what),
    },
    overflow: asOverflowTotals(entry.overflow, what),
    overflowSlides: asList(entry.overflowSlides, what),
    reopened: asReopened(entry.reopened, what),
    rendering: asRendering(entry.rendering, what),
  };
}

/**
 * Validates the worker's answer for one operation. The service already inspected every declared
 * output; this is the second half of that contract — the *typed result* is the shape the operation
 * promises, or the call is refused as `output-invalid` rather than shown to a model.
 */
export function parsePptxResult(
  operation: PptxOperation,
  value: unknown,
  expected: readonly PptxSourceEvidence[],
): PptxResult {
  const entry = asRecord(value, "result");
  const what = `${operation} result`;
  if (entry.schema !== "paper_pptx_operation" || entry.version !== 1 || entry.ok !== true) {
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
    seen: PptxSourceEvidence,
    ref: PptxSourceEvidence | undefined,
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
      const source = asSourceRef(entry.source, what);
      check(source, expected[0], "source");
      return {
        operation,
        source,
        deck: asCensus(entry.deck, what),
        overflow: asOverflowTotals(entry.overflow, what),
        overflowSlides: asRecords(entry.overflowSlides, what),
        slideOutline: asList(entry.slideOutline, what).map((item) => asSlideOutline(item, what)),
        slideOutlineTruncated: asBoolean(entry.slideOutlineTruncated, what),
        mediaOutline: asList(entry.mediaOutline, what).map((item) => asMediaItem(item, what)),
        mediaOutlineTruncated: asBoolean(entry.mediaOutlineTruncated, what),
        orphanMediaParts: asStrings(entry.orphanMediaParts, what),
        warnings: asWarnings(entry.warnings, what),
        rendering: asRendering(entry.rendering, what),
      };
    }
    case "read": {
      const source = asSourceRef(entry.source, what);
      check(source, expected[0], "source");
      const page = asRecord(entry.page, `${what} page`);
      const section = asString(page.section, `${what} page`);
      if (!(PPTX_READ_SECTIONS as readonly string[]).includes(section)) {
        throw refusal("output-invalid", `the worker paged a ${section} section, which is not one`);
      }
      return {
        operation,
        source,
        deck: asCensus(entry.deck, what),
        page: asPage(page, `${what} page`, (item, name) => asItem(section, item, name)),
      };
    }
    case "create": {
      const provenance = asRecord(entry.provenance, `${what} provenance`);
      if (provenance.source !== null) throw invalid(`${what} provenance`);
      return {
        operation,
        draft: asProposal(entry.draft, `${what} draft`),
        structure: asCensus(entry.structure, what),
        placements: asRecords(entry.placements, what),
        overflow: asOverflowTotals(entry.overflow, what),
        overflowSlides: asList(entry.overflowSlides, what),
        provenance: {
          template: asString(provenance.template, `${what} provenance`),
          source: null,
        },
        reopened: asReopened(entry.reopened, what),
        rendering: asRendering(entry.rendering, what),
      };
    }
    case "edit": {
      const base = asProposalReport(entry, what);
      check(base.source, expected[0], "source");
      return {
        operation,
        ...base,
        changes: asChanges(entry.changes, `${what} changes`),
        steps: asStrings(entry.steps, what),
      };
    }
    case "compose": {
      const base = asProposalReport(entry, what);
      check(base.source, expected[0], "destination");
      const sources = asRecord(entry.sources, `${what} sources`);
      const from = asSourceRef(sources.from, `${what} from`);
      check(from, expected[1], "source");
      return {
        operation,
        ...base,
        sources: { into: base.source, from },
        mode: asString(entry.mode, what),
        imports: asRecords(entry.imports, what),
        importCount: asInteger(entry.importCount, what),
      };
    }
    case "preview": {
      const source = asSourceRef(entry.source, what);
      check(source, expected[0], "source");
      const media = asRecord(entry.media, `${what} media`);
      return {
        operation,
        source,
        page: asPage(entry.page, `${what} page`, (item, name) => asSlidePreview(item, name)),
        deck: asCensus(entry.deck, what),
        overflow: asOverflowTotals(entry.overflow, what),
        overflowSlides: asList(entry.overflowSlides, what),
        media: {
          references: asList(media.references, what).map((item) => asMediaItem(item, what)),
          orphanParts: asStrings(media.orphanParts, what),
        },
        warnings: asWarnings(entry.warnings, what),
        rendering: asRendering(entry.rendering, what),
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
        preview: asBeforeAfter(entry.preview, `${what} preview`),
        identical: asBoolean(entry.identical, what),
        rendering: asRendering(entry.rendering, what),
      };
    }
  }
}

/** The file reference a typed result reports, as the receipt's lineage records it. */
export function pptxResultRef(leased: LeasedInput): PptxSourceEvidence {
  return {
    fileId: leased.fileId,
    versionId: leased.versionId,
    name: leased.name,
    sha256: leased.sha256,
    size: leased.size,
  };
}

/** Whether a leased input is a PowerPoint file this adapter may open. */
export function isPptxInput(leased: LeasedInput): boolean {
  return leased.format === PPTX_FORMAT;
}
