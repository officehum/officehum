/**
 * The typed Excel surface: what a role may ask of an `.xlsx`, and the exact program each ask runs.
 *
 * A typed operation is not a second implementation of the Python adapter — it is the *only* way the
 * adapter is reached. The tool validates its arguments here, resolves every file reference against the
 * task's lease, and hands `xlsx_adapter.run(operation, arguments)` a fixed, checked request. The
 * submitted code is a constant per operation, so the receipt's code hash names the operation and the
 * argument hash names the request: a replay returns the same receipt, and changed arguments under a
 * used operation ID fail closed.
 *
 * Nothing here takes a path. A file reference is a FileStore `fileId` with the `versionId`, `name`,
 * `sha256` and `size` the lease pinned; every one of those fields is checked against the lease before
 * the run, so a reference the lease does not grant refuses with `ungranted-input` rather than being
 * resolved by name.
 *
 * Six operations, mirroring the Word adapter one for one — `inspect`, `read`, `create`, `edit`,
 * `preview`, `compare`. Excel has one primitive PowerPoint does not need: a *cell*, addressed by
 * sheet and A1 coordinate, and a formula is a value a caller supplies rather than one this pack
 * computes. There is no `compose`: a workbook does not absorb another workbook's sheets in one
 * operation, and prevaricating about that would be worse than saying so.
 *
 * The paged sections (`read`, `preview`) always carry a page size, a cursor and a total, and the
 * result validator enforces that shape, so a large sheet cannot arrive as one unbounded reply.
 *
 * **What this surface does not do, and says so in every result.** No calculation happens here:
 * `openpyxl.oracle` implements no formula engine and delegates to headless LibreOffice, and the worker
 * cannot spawn a process, so a `recalculation` block reports `available`, `attempted: false`, the
 * reason and the functions the oracle would refuse anyway — and the validator refuses a worker that
 * claims a computed value. A cached value a result reports is one the *package* already held, quoted
 * with its source; the one number this adapter computes is an explicit sum of cells it names, labelled
 * as its own sum rather than a recalculation. Charts are read, never drawn (RASF-3204 draws them).
 *
 * Every result also carries the reference verification the issue asks for: the formula surfaces the
 * library itself knows about, the ones that cannot resolve, and — on an `edit` — the refusal that
 * follows from *creating* one. A source with a broken reference is reported, not refused; an operation
 * that would add one refuses with `broken-reference` and writes nothing.
 */

import { type DocumentError, refusal } from "./errors.js";
import { type DocumentLease, findLeasedInput, type LeasedInput, permitsFormat } from "./lease.js";
import {
  assertFileId,
  assertHash,
  assertPathSegment,
  assertSize,
  exactKeys,
  isRecord,
  record,
} from "./validate.js";

export const INSPECT_WORKBOOK = "inspect_workbook";
export const READ_WORKBOOK = "read_workbook";
export const CREATE_WORKBOOK = "create_workbook";
export const EDIT_WORKBOOK = "edit_workbook";
export const PREVIEW_WORKBOOK = "preview_workbook";
export const COMPARE_WORKBOOK = "compare_workbook";

/** The six typed Excel operations, in the order the design names them. */
export type XlsxOperation = "inspect" | "read" | "create" | "edit" | "preview" | "compare";

export const XLSX_OPERATIONS: readonly XlsxOperation[] = [
  "inspect",
  "read",
  "create",
  "edit",
  "preview",
  "compare",
];

export const XLSX_TOOL_NAMES: Readonly<Record<XlsxOperation, string>> = {
  inspect: INSPECT_WORKBOOK,
  read: READ_WORKBOOK,
  create: CREATE_WORKBOOK,
  edit: EDIT_WORKBOOK,
  preview: PREVIEW_WORKBOOK,
  compare: COMPARE_WORKBOOK,
};

export const XLSX_READ_SECTIONS = [
  "sheets",
  "cells",
  "formulas",
  "names",
  "styles",
  "charts",
] as const;

export type XlsxReadSection = (typeof XLSX_READ_SECTIONS)[number];

/** The edit steps this adapter runs. A step never carries code, only data. */
export const XLSX_STEP_KINDS = [
  "setCell",
  "setRange",
  "clearCells",
  "setStyle",
  "setColumnWidth",
  "addSheet",
  "deleteSheet",
  "renameSheet",
  "setName",
  "removeName",
] as const;

export const XLSX_STYLE_FIELDS = [
  "bold",
  "italic",
  "size",
  "name",
  "color",
  "fillColor",
  "numberFormat",
  "horizontal",
  "vertical",
  "wrapText",
] as const;

export const MAX_XLSX_PAGE = 50;
export const DEFAULT_XLSX_PAGE = 20;
export const MAX_XLSX_STEPS = 32;
export const MAX_XLSX_SHEETS = 32;
export const MAX_XLSX_RANGE_CELLS = 4_096;

/** The one format this adapter owns. */
export const XLSX_FORMAT = "xlsx";

// -- what a caller sends --------------------------------------------------------------------------

/** A leased Excel file: the FileStore id and the version, name, hash and size the lease pinned. */
export interface XlsxFileRef {
  readonly fileId: string;
  readonly versionId: string;
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}

/** One cell's literal or formula. A caller supplies the figure; this pack never computes one. */
export type XlsxCellValue = string | number | boolean | null;

export interface XlsxStyleSpec {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly size?: number;
  readonly name?: string;
  readonly color?: string;
  readonly fillColor?: string;
  readonly numberFormat?: string;
  readonly horizontal?: string;
  readonly vertical?: string;
  readonly wrapText?: boolean;
}

export interface XlsxStyleTarget {
  readonly range: string;
  readonly style: XlsxStyleSpec;
}

export interface XlsxNameSpec {
  readonly name: string;
  readonly reference: string;
  readonly scope?: "workbook" | "sheet";
}

export interface XlsxColumnWidthSpec {
  readonly column?: string;
  readonly columns?: readonly string[];
  readonly width: number;
}

// -- edit steps -----------------------------------------------------------------------------------

export interface XlsxSetCellStep {
  readonly kind: "setCell";
  readonly sheet?: string;
  readonly cell: string;
  /** A literal, or `null` to clear the cell. Exactly one of `value` and `formula` is given. */
  readonly value?: XlsxCellValue;
  readonly formula?: string;
}

export interface XlsxSetRangeStep {
  readonly kind: "setRange";
  readonly sheet?: string;
  readonly range: string;
  /** Literal values only, exactly the block the range covers. A formula uses `setCell`. */
  readonly rows: readonly (readonly XlsxCellValue[])[];
}

export interface XlsxClearCellsStep {
  readonly kind: "clearCells";
  readonly sheet?: string;
  readonly range: string;
}

export interface XlsxSetStyleStep {
  readonly kind: "setStyle";
  readonly sheet?: string;
  readonly range: string;
  readonly style: XlsxStyleSpec;
}

export interface XlsxSetColumnWidthStep {
  readonly kind: "setColumnWidth";
  readonly sheet?: string;
  readonly column?: string;
  readonly columns?: readonly string[];
  readonly width: number;
}

export interface XlsxAddSheetStep {
  readonly kind: "addSheet";
  readonly name: string;
  readonly at?: number;
}

export interface XlsxDeleteSheetStep {
  readonly kind: "deleteSheet";
  readonly sheet: string;
}

export interface XlsxRenameSheetStep {
  readonly kind: "renameSheet";
  readonly sheet: string;
  readonly to: string;
}

export interface XlsxSetNameStep {
  readonly kind: "setName";
  readonly name: string;
  readonly reference: string;
  readonly scope?: "workbook" | "sheet";
}

export interface XlsxRemoveNameStep {
  readonly kind: "removeName";
  readonly name: string;
  readonly scope?: "workbook" | "sheet";
  readonly sheet?: string;
}

export type XlsxEditStep =
  | XlsxSetCellStep
  | XlsxSetRangeStep
  | XlsxClearCellsStep
  | XlsxSetStyleStep
  | XlsxSetColumnWidthStep
  | XlsxAddSheetStep
  | XlsxDeleteSheetStep
  | XlsxRenameSheetStep
  | XlsxSetNameStep
  | XlsxRemoveNameStep;

// -- create sheets --------------------------------------------------------------------------------

export interface XlsxSheetSpec {
  readonly name: string;
  readonly rows: readonly (readonly XlsxCellValue[])[];
  readonly at?: string;
  readonly styles?: readonly XlsxStyleTarget[];
  readonly names?: readonly XlsxNameSpec[];
  readonly columnWidths?: readonly XlsxColumnWidthSpec[];
  readonly freeze?: string;
}

/** What one typed operation asks for, with every output and source already resolved to the lease. */
export interface XlsxProgram {
  readonly operation: XlsxOperation;
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

function quantity(value: unknown, what: string, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) {
    throw refusal("invalid-request", `${what} must be a finite number between ${low} and ${high}`);
  }
  return value;
}

function oneOf(value: unknown, what: string, allowed: readonly string[]): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw refusal("invalid-request", `${what} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

/** A cell's literal: JSON has no other scalar, and null clears the cell. */
function cellValue(value: unknown, what: string): XlsxCellValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && value.startsWith("=")) {
      throw refusal(
        "invalid-request",
        `${what} begins with =, which the adapter would write as a formula; use the formula field so ` +
          "the intent is explicit",
      );
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw refusal("invalid-request", `${what} must be a finite number`);
    return value;
  }
  throw refusal(
    "invalid-request",
    `${what} must be a string, number, boolean or null; a figure comes from source data or code, ` +
      "never from arithmetic this pack performs",
  );
}

/**
 * A cell of a *new* draft: the same literals as everywhere else, plus a formula — a string beginning
 * with `=` is written as a formula, which is how a draft's totals are laid out from source data. An
 * *edit* of an existing cell requires the explicit `formula` field instead, so a value that happens to
 * start with `=` is never silently given a new meaning.
 */
function draftCellValue(value: unknown, what: string): XlsxCellValue {
  if (typeof value === "string" && value.startsWith("=")) {
    if (value.length <= 4_000) return value;
    throw refusal("invalid-request", `${what} formula is longer than 4000 characters`);
  }
  return cellValue(value, what);
}

function columnLetter(value: unknown, what: string): string {
  const letter = text(value, what, 8).replace("$", "").toUpperCase();
  if (!/^[A-Z]{1,3}$/u.test(letter)) {
    throw refusal("invalid-request", `${what} must be a column letter such as B`);
  }
  return letter;
}

/** One A1 coordinate, normalized. Absolute markers are accepted and dropped, as Excel writes them. */
function coordinateText(value: unknown, what: string): string {
  const address = text(value, what, 32).replace(/\$/gu, "").toUpperCase();
  if (!/^[A-Z]{1,3}[0-9]{1,7}$/u.test(address)) {
    throw refusal("invalid-request", `${what} must be a single cell address such as B7`);
  }
  return address;
}

function rangeText(value: unknown, what: string): string {
  const range = text(value, what, 128);
  const core = range.includes("!") ? (range.split("!").pop() ?? "") : range;
  if (!/^[A-Za-z$]{1,3}[0-9$]{1,7}(:[A-Za-z$]{1,3}[0-9$]{1,7})?$/u.test(core)) {
    throw refusal("invalid-request", `${what} must be a range such as A1:C10 or Revenue!A1:C10`);
  }
  return range;
}

/**
 * A range's own bounds, or `null` when it is not a range. Used to refuse a block that does not fit the
 * range it claims to fill, before anything is sent to the worker.
 */
function rangeBounds(
  range: string,
): { minRow: number; minCol: number; maxRow: number; maxCol: number } | null {
  const core = (range.includes("!") ? (range.split("!").pop() ?? "") : range)
    .replace(/\$/gu, "")
    .toUpperCase();
  const match = /^([A-Z]{1,3})([0-9]{1,7})(?::([A-Z]{1,3})([0-9]{1,7}))?$/u.exec(core);
  if (match === null) return null;
  const column = (letters: string): number =>
    [...letters].reduce((total, character) => total * 26 + (character.charCodeAt(0) - 64), 0);
  const minCol = column(match[1] ?? "");
  const minRow = Number(match[2]);
  const maxCol = match[3] === undefined ? minCol : column(match[3]);
  const maxRow = match[4] === undefined ? minRow : Number(match[4]);
  return { minRow, minCol, maxRow, maxCol };
}

/** The shape of a file reference, before the lease is consulted. */
export function assertXlsxFileRef(value: unknown, what: string): XlsxFileRef {
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
 * lease, not the caller, decides what this operation may read, and an Excel operation reads `.xlsx`.
 */
export function resolveXlsxRef(lease: DocumentLease, value: unknown, what: string): LeasedInput {
  const ref = assertXlsxFileRef(value, what);
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
  if (leased.format !== XLSX_FORMAT) {
    throw refusal("invalid-request", `${what} is a ${leased.format} file, not a .xlsx`);
  }
  return leased;
}

/** The output name a request proposes: one path segment, `.xlsx`, and permitted by the lease. */
export function resolveXlsxOutput(lease: DocumentLease, value: unknown): string {
  const name = text(value, "an output name", 255);
  assertPathSegment(name, "an output name");
  if (!name.toLowerCase().endsWith(`.${XLSX_FORMAT}`)) {
    throw refusal("output-format", `an output named ${name} is not a .xlsx file`);
  }
  if (!permitsFormat(lease, XLSX_FORMAT)) {
    throw refusal("output-format", "this task's lease does not permit an xlsx output");
  }
  return name;
}

function styleSpec(value: unknown, what: string): XlsxStyleSpec {
  const entry = object(
    value,
    what,
    XLSX_STYLE_FIELDS.map((field) => String(field)),
  );
  if (Object.keys(entry).length === 0) {
    throw refusal("invalid-request", `${what} names no style`);
  }
  const style: Record<string, unknown> = {};
  if (entry.bold !== undefined) style.bold = flag(entry.bold, `${what} bold`);
  if (entry.italic !== undefined) style.italic = flag(entry.italic, `${what} italic`);
  if (entry.wrapText !== undefined) style.wrapText = flag(entry.wrapText, `${what} wrapText`);
  if (entry.size !== undefined) style.size = quantity(entry.size, `${what} size`, 1, 400);
  if (entry.name !== undefined) style.name = text(entry.name, `${what} name`, 128);
  if (entry.color !== undefined) {
    const color = text(entry.color, `${what} color`, 16).replace("#", "").toUpperCase();
    if (!/^[0-9A-F]{6}$/u.test(color)) {
      throw refusal("invalid-request", `${what} color must be six hexadecimal digits`);
    }
    style.color = color;
  }
  if (entry.fillColor !== undefined) {
    const fill = text(entry.fillColor, `${what} fillColor`, 16).replace("#", "").toUpperCase();
    if (!/^[0-9A-F]{6}$/u.test(fill)) {
      throw refusal("invalid-request", `${what} fillColor must be six hexadecimal digits`);
    }
    style.fillColor = fill;
  }
  if (entry.numberFormat !== undefined) {
    style.numberFormat = text(entry.numberFormat, `${what} numberFormat`, 128);
  }
  if (entry.horizontal !== undefined) {
    style.horizontal = oneOf(entry.horizontal, `${what} horizontal`, [
      "left",
      "center",
      "right",
      "fill",
      "justify",
    ]);
  }
  if (entry.vertical !== undefined) {
    style.vertical = oneOf(entry.vertical, `${what} vertical`, [
      "top",
      "center",
      "bottom",
      "justify",
    ]);
  }
  return style as XlsxStyleSpec;
}

function nameSpec(value: unknown, what: string): XlsxNameSpec {
  const entry = object(value, what, ["name", "reference", "scope"]);
  if (entry.name === undefined || entry.reference === undefined) {
    throw refusal("invalid-request", `${what} needs a name and a reference`);
  }
  const name = text(entry.name, `${what} name`, 255);
  if (!/^[A-Za-z_\\][A-Za-z0-9_.\\]*$/u.test(name)) {
    throw refusal("invalid-request", `${what} name must be a defined name such as RevenueTotal`);
  }
  const reference = text(entry.reference, `${what} reference`, 512);
  return {
    name,
    reference,
    ...(entry.scope === undefined
      ? {}
      : {
          scope: oneOf(entry.scope, `${what} scope`, ["workbook", "sheet"]) as "workbook" | "sheet",
        }),
  };
}

function widthSpec(value: unknown, what: string): XlsxColumnWidthSpec {
  const entry = object(value, what, ["column", "columns", "width"]);
  if (entry.width === undefined) throw refusal("invalid-request", `${what} needs a width`);
  const width = quantity(entry.width, `${what} width`, 0, 255);
  const columns: string[] = [];
  if (entry.column !== undefined) columns.push(columnLetter(entry.column, `${what} column`));
  if (entry.columns !== undefined) {
    const list = entry.columns;
    if (!Array.isArray(list) || list.length === 0 || list.length > 64) {
      throw refusal("invalid-request", `${what} columns must hold 1 to 64 column letters`);
    }
    for (const item of list) columns.push(columnLetter(item, `${what} column`));
  }
  if (columns.length === 0) {
    throw refusal("invalid-request", `${what} needs a column or a list of columns`);
  }
  return { columns, width };
}

export const STEP_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  setCell: ["cell"],
  setRange: ["range", "rows"],
  clearCells: ["range"],
  setStyle: ["range", "style"],
  setColumnWidth: ["width"],
  addSheet: ["name"],
  deleteSheet: ["sheet"],
  renameSheet: ["sheet", "to"],
  setName: ["name", "reference"],
  removeName: ["name"],
};

export const STEP_OPTIONAL: Readonly<Record<string, readonly string[]>> = {
  setCell: ["sheet", "value", "formula"],
  setRange: ["sheet"],
  clearCells: ["sheet"],
  setStyle: ["sheet"],
  setColumnWidth: ["sheet", "column", "columns"],
  addSheet: ["at"],
  deleteSheet: [],
  renameSheet: [],
  setName: ["scope"],
  removeName: ["scope", "sheet"],
};

/** Validates one edit step. The Python adapter validates the same shape again on the far side. */
export function assertXlsxStep(value: unknown, index: number): XlsxEditStep {
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
  const sheet = (): Record<string, unknown> =>
    entry.sheet === undefined ? {} : { sheet: text(entry.sheet, `${what} sheet`, 255) };
  const step = (fields: Record<string, unknown>): XlsxEditStep => fields as unknown as XlsxEditStep;

  switch (kind) {
    case "setCell": {
      const hasValue = entry.value !== undefined;
      const hasFormula = entry.formula !== undefined;
      if (hasValue === hasFormula) {
        throw refusal(
          "invalid-request",
          `${what} needs exactly one of value (a literal, or null to clear) or formula`,
        );
      }
      return step({
        kind,
        ...sheet(),
        cell: coordinateText(entry.cell, `${what} cell`),
        ...(hasValue ? { value: cellValue(entry.value, `${what} value`) } : {}),
        ...(hasFormula
          ? {
              formula: (() => {
                const formula = text(entry.formula, `${what} formula`, 4_000);
                if (!formula.startsWith("=")) {
                  throw refusal("invalid-request", `${what} formula must begin with =`);
                }
                return formula;
              })(),
            }
          : {}),
      });
    }
    case "setRange": {
      const rows = entry.rows;
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_XLSX_RANGE_CELLS) {
        throw refusal("invalid-request", `${what} needs 1 to ${MAX_XLSX_RANGE_CELLS} rows`);
      }
      const width = Array.isArray(rows[0]) ? rows[0].length : 0;
      if (width === 0) throw refusal("invalid-request", `${what} rows need at least one cell`);
      if (rows.length * width > MAX_XLSX_RANGE_CELLS) {
        throw refusal(
          "invalid-request",
          `${what} writes ${rows.length * width} cells; the limit is ${MAX_XLSX_RANGE_CELLS}`,
        );
      }
      const range = rangeText(entry.range, `${what} range`);
      const bounds = rangeBounds(range);
      if (bounds === null) {
        throw refusal("invalid-request", `${what} range must be a range such as A1:C10`);
      }
      if (
        bounds.minRow + rows.length - 1 > bounds.maxRow ||
        bounds.minCol + width - 1 > bounds.maxCol
      ) {
        throw refusal(
          "invalid-request",
          `${what} values (${rows.length}x${width}) do not fit the range ${range}; a range that does ` +
            "not match the block it carries is refused rather than half written",
        );
      }
      return step({
        kind,
        ...sheet(),
        range,
        rows: rows.map((row, rowIndex) => {
          if (!Array.isArray(row) || row.length !== width) {
            throw refusal("invalid-request", `${what} rows must all hold ${width} cells`);
          }
          return row.map((cell, cellIndex) =>
            cellValue(cell, `${what} cell ${rowIndex}.${cellIndex}`),
          );
        }),
      });
    }
    case "clearCells":
      return step({ kind, ...sheet(), range: rangeText(entry.range, `${what} range`) });
    case "setStyle":
      return step({
        kind,
        ...sheet(),
        range: rangeText(entry.range, `${what} range`),
        style: styleSpec(entry.style, `${what} style`),
      });
    case "setColumnWidth":
      return step({
        kind,
        ...sheet(),
        ...widthSpec(
          { column: entry.column, columns: entry.columns, width: entry.width },
          `${what} width`,
        ),
      });
    case "addSheet":
      return step({
        kind,
        name: text(entry.name, `${what} name`, 255),
        ...(entry.at === undefined ? {} : { at: whole(entry.at, `${what} at`, 0, 10_000) }),
      });
    case "deleteSheet":
      return step({ kind, sheet: text(entry.sheet, `${what} sheet`, 255) });
    case "renameSheet":
      return step({
        kind,
        sheet: text(entry.sheet, `${what} sheet`, 255),
        to: text(entry.to, `${what} to`, 255),
      });
    case "setName":
      return step({
        kind,
        ...nameSpec(
          {
            name: entry.name,
            reference: entry.reference,
            ...(entry.scope === undefined ? {} : { scope: entry.scope }),
          },
          what,
        ),
      });
    default:
      return step({
        kind,
        name: text(entry.name, `${what} name`, 255),
        scope: oneOf(entry.scope ?? "workbook", `${what} scope`, ["workbook", "sheet"]) as
          | "workbook"
          | "sheet",
        ...(entry.sheet === undefined ? {} : { sheet: text(entry.sheet, `${what} sheet`, 255) }),
      });
  }
}

/** Validates one sheet of a new draft. */
export function assertXlsxSheet(value: unknown, index: number): XlsxSheetSpec {
  const what = `sheet ${index}`;
  const entry = object(value, what, [
    "name",
    "rows",
    "at",
    "styles",
    "names",
    "columnWidths",
    "freeze",
  ]);
  if (entry.name === undefined || entry.rows === undefined) {
    throw refusal("invalid-request", `${what} needs a name and rows`);
  }
  const rows = entry.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw refusal("invalid-request", `${what} needs a non-empty list of rows`);
  }
  const width = Array.isArray(rows[0]) ? rows[0].length : 0;
  if (width === 0) throw refusal("invalid-request", `${what} rows need at least one cell`);
  if (rows.length * width > MAX_XLSX_RANGE_CELLS) {
    throw refusal(
      "invalid-request",
      `${what} writes ${rows.length * width} cells; the limit is ${MAX_XLSX_RANGE_CELLS}`,
    );
  }
  const styles = entry.styles;
  if (styles !== undefined && (!Array.isArray(styles) || styles.length > 64)) {
    throw refusal("invalid-request", `${what} takes at most 64 style targets`);
  }
  const names = entry.names;
  if (names !== undefined && (!Array.isArray(names) || names.length > 64)) {
    throw refusal("invalid-request", `${what} takes at most 64 named ranges`);
  }
  const widths = entry.columnWidths;
  if (widths !== undefined && (!Array.isArray(widths) || widths.length > 64)) {
    throw refusal("invalid-request", `${what} takes at most 64 column widths`);
  }
  return {
    name: text(entry.name, `${what} name`, 255),
    rows: rows.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== width) {
        throw refusal("invalid-request", `${what} rows must all hold ${width} cells`);
      }
      return row.map((cell, cellIndex) =>
        draftCellValue(cell, `${what} cell ${rowIndex}.${cellIndex}`),
      );
    }),
    ...(entry.at === undefined ? {} : { at: coordinateText(entry.at, `${what} at`) }),
    ...(styles === undefined
      ? {}
      : {
          styles: (styles as readonly unknown[]).map((item, itemIndex) => {
            const target = object(item, `${what} style ${itemIndex}`, ["range", "style"]);
            if (target.range === undefined || target.style === undefined) {
              throw refusal(
                "invalid-request",
                `${what} style ${itemIndex} needs a range and a style`,
              );
            }
            return {
              range: rangeText(target.range, `${what} style ${itemIndex} range`),
              style: styleSpec(target.style, `${what} style ${itemIndex}`),
            };
          }),
        }),
    ...(names === undefined
      ? {}
      : {
          names: (names as readonly unknown[]).map((item, itemIndex) =>
            nameSpec(item, `${what} name ${itemIndex}`),
          ),
        }),
    ...(widths === undefined
      ? {}
      : {
          columnWidths: (widths as readonly unknown[]).map((item, itemIndex) =>
            widthSpec(item, `${what} columnWidths ${itemIndex}`),
          ),
        }),
    ...(entry.freeze === undefined
      ? {}
      : { freeze: coordinateText(entry.freeze, `${what} freeze`) }),
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
      : { pageSize: whole(entry.pageSize, `${what} pageSize`, 1, MAX_XLSX_PAGE) }),
  };
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
export function xlsxInstruction(operation: XlsxOperation): string {
  return [
    "import xlsx_adapter",
    "",
    `documents.result(xlsx_adapter.run(${JSON.stringify(operation)}, documents.arguments()))`,
  ].join("\n");
}

/**
 * Validates a typed request against the lease and returns the program to run. Everything a path could
 * hide is resolved here: inputs are lease version IDs, the output is a single staging file name.
 */
export function xlsxProgram(
  operation: XlsxOperation,
  args: unknown,
  lease: DocumentLease,
): XlsxProgram {
  const entry = object(args, `the ${XLSX_TOOL_NAMES[operation]} arguments`);
  const code = xlsxInstruction(operation);
  const base = { operation, code, sources: [] as readonly LeasedInput[], output: null };

  switch (operation) {
    case "inspect": {
      exactKeys(entry, ["ref"], "inspect carries a field it does not declare");
      const source = resolveXlsxRef(lease, entry.ref, "the inspect ref");
      return { ...base, sources: [source], arguments: { ref: refArgument(source) } };
    }
    case "read": {
      exactKeys(
        entry,
        ["ref", "section", "sheet", "range", "cursor", "pageSize"],
        "read carries a field it does not declare",
      );
      if (entry.ref === undefined || entry.section === undefined) {
        throw refusal("invalid-request", "read needs a ref and a section");
      }
      const section = oneOf(entry.section, "a read section", XLSX_READ_SECTIONS);
      const source = resolveXlsxRef(lease, entry.ref, "the read ref");
      if (section === "cells" && entry.sheet === undefined && entry.range === undefined) {
        throw refusal(
          "invalid-request",
          "a cells read needs a sheet, or a range that names the sheet it is on",
        );
      }
      if (section === "styles" && entry.sheet === undefined) {
        throw refusal("invalid-request", "a styles read needs a sheet");
      }
      return {
        ...base,
        sources: [source],
        arguments: {
          ref: refArgument(source),
          section,
          ...(entry.sheet === undefined ? {} : { sheet: text(entry.sheet, "the read sheet", 255) }),
          ...(entry.range === undefined ? {} : { range: rangeText(entry.range, "the read range") }),
          ...pageOf(entry, "read"),
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
      const source = resolveXlsxRef(lease, entry.ref, "the preview ref");
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
      const from = resolveXlsxRef(lease, entry.from, "the compare from ref");
      const to = resolveXlsxRef(lease, entry.to, "the compare to ref");
      return {
        ...base,
        sources: [from, to],
        arguments: { from: refArgument(from), to: refArgument(to) },
      };
    }
    case "create": {
      exactKeys(entry, ["output", "sheets"], "create carries a field it does not declare");
      const name = resolveXlsxOutput(lease, entry.output);
      if (!Array.isArray(entry.sheets) || entry.sheets.length === 0) {
        throw refusal("invalid-request", "create needs a non-empty list of sheets");
      }
      if (entry.sheets.length > MAX_XLSX_SHEETS) {
        throw refusal("invalid-request", `create takes at most ${MAX_XLSX_SHEETS} sheets`);
      }
      const sheets = entry.sheets.map((sheet, index) => assertXlsxSheet(sheet, index));
      return {
        ...base,
        output: { name, editOf: null },
        arguments: { output: name, sheets },
      };
    }
    default: {
      exactKeys(entry, ["ref", "output", "steps"], "edit carries a field it does not declare");
      for (const key of ["ref", "output", "steps"]) {
        if (entry[key] === undefined) throw refusal("invalid-request", `edit is missing ${key}`);
      }
      const source = resolveXlsxRef(lease, entry.ref, "the edit source ref");
      if (!source.writable) {
        throw refusal(
          "unleased-path",
          `this task's lease grants read-only access to ${source.name}, so it cannot propose a new version of it`,
        );
      }
      const name = resolveXlsxOutput(lease, entry.output);
      if (!Array.isArray(entry.steps) || entry.steps.length === 0) {
        throw refusal("invalid-request", "edit needs a non-empty list of steps");
      }
      if (entry.steps.length > MAX_XLSX_STEPS) {
        throw refusal("invalid-request", `edit takes at most ${MAX_XLSX_STEPS} steps`);
      }
      const steps = entry.steps.map((step, index) => assertXlsxStep(step, index));
      return {
        ...base,
        sources: [source],
        output: { name, editOf: source.versionId },
        arguments: { ref: refArgument(source), output: name, steps },
      };
    }
  }
}

// -- reading the answer ---------------------------------------------------------------------------

export type XlsxSourceEvidence = XlsxFileRef;

export interface XlsxWorkbookCensus {
  readonly sheets: number;
  readonly chartsheets: number;
  readonly hiddenSheets: number;
  readonly protectedSheets: number;
  readonly namedRanges: number;
  readonly sheetScopedNames: number;
  readonly cells: number;
  readonly formulas: number;
  readonly styledCells: number;
  readonly tables: number;
  readonly mergedRanges: number;
  readonly dataValidations: number;
  readonly conditionalFormatting: number;
  readonly charts: number;
  readonly chartParts: number;
  readonly pivotParts: number;
  readonly macros: boolean;
  readonly calcChain: boolean;
  readonly parts: number;
}

export interface XlsxSheetOutline {
  readonly position: number;
  readonly title: string;
  readonly part: string | null;
  readonly state: string;
  readonly dimensions: string | null;
  readonly usedRange: string;
  readonly maxRow: number;
  readonly maxColumn: number;
  readonly cells: number;
  readonly formulas: number;
  readonly styledCells: number;
  readonly namedRanges: number;
  readonly mergedRanges: number;
  readonly tables: number;
  readonly charts: number;
  readonly protected: boolean;
  readonly freezePanes: string | null;
  readonly autoFilter: boolean;
  readonly dataValidations: number;
  readonly conditionalFormatting: number;
}

export interface XlsxNamedRange {
  readonly name: string;
  readonly scope: string;
  readonly sheet: string | null;
  readonly reference: string;
  readonly referenceTruncated: boolean;
  readonly kind: string;
  readonly resolved: boolean;
  readonly reason: string | null;
}

export interface XlsxChartReference {
  readonly kind: string;
  readonly role: string;
  readonly reference: string;
}

export interface XlsxChartItem {
  readonly sheet: string;
  readonly position: number;
  readonly type: string;
  readonly title: string | null;
  readonly titleResolved: boolean;
  readonly titleReason: string | null;
  readonly seriesCount: number;
  readonly references: readonly XlsxChartReference[];
  readonly referencesTruncated: boolean;
  /** Always true for a modelled chart; an unmodelled part is named in `unmodeledChartParts`. */
  readonly modeled: boolean;
}

export interface XlsxCellItem {
  readonly sheet: string;
  readonly address: string;
  readonly row: number;
  readonly column: number;
  readonly value: unknown;
  readonly valueKind: string;
  readonly exact: string | null;
  readonly formula: string | null;
  readonly formulaTruncated: boolean;
  readonly cachedValue: unknown;
  readonly cachedKnown: boolean;
  readonly nonFinite: boolean;
  readonly numberFormat: string;
  readonly styled: boolean;
  readonly truncated?: boolean;
}

export interface XlsxFormulaReference {
  readonly raw: string;
  readonly kind: string;
  readonly resolved: boolean;
  readonly detail: string;
  readonly sheet?: string | null;
}

export interface XlsxFormulaItem {
  readonly sheet: string;
  readonly address: string;
  readonly formula: string;
  readonly formulaTruncated: boolean;
  readonly references: readonly XlsxFormulaReference[];
  readonly referencesTotal: number;
  readonly referencesTruncated: boolean;
  readonly brokenReferences: readonly XlsxFormulaReference[];
  readonly tokenizerError: string | null;
  readonly cachedValue: unknown;
  readonly cachedKnown: boolean;
}

export interface XlsxStyleItem {
  readonly sheet: string;
  readonly address: string;
  readonly style: Readonly<Record<string, unknown>>;
  readonly value: unknown;
  readonly formula: string | null;
}

export type XlsxItem =
  | XlsxSheetOutline
  | XlsxCellItem
  | XlsxFormulaItem
  | XlsxNamedRange
  | XlsxStyleItem
  | XlsxChartItem;

export interface XlsxPage<T> {
  readonly section: string;
  readonly pageSize: number;
  readonly cursor: number;
  readonly returned: number;
  readonly total: number;
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
  readonly items: readonly T[];
}

export interface XlsxBrokenReference {
  readonly where: string;
  readonly owner: string;
  readonly raw: string;
  readonly kind: string;
  readonly resolved: boolean;
  readonly detail: string;
  readonly sheet?: string | null;
}

/** The reference verification: what was scanned, what could not resolve, and why. */
export interface XlsxReferenceCheck {
  readonly checkedReferences: number;
  readonly checkedSurfaces: number;
  readonly kinds: Readonly<Record<string, number>>;
  readonly broken: readonly XlsxBrokenReference[];
  readonly brokenTotal: number;
  readonly brokenTruncated: boolean;
  readonly brokenKinds: readonly string[];
  readonly unscannable: readonly Readonly<Record<string, unknown>>[];
  readonly clean: boolean;
  readonly scope: string;
  readonly partsScanned: number;
}

/**
 * What this workspace can and cannot calculate. `computed` is always false: the validator refuses a
 * worker that claims a calculated value, because no engine runs here.
 */
export interface XlsxRecalculation {
  readonly available: boolean;
  readonly attempted: boolean;
  /** Always false: a calculated value is never reported by this adapter. */
  readonly computed: false;
  readonly engine: string;
  readonly engineInProcess: false;
  readonly processSpawned: false;
  readonly reason: string;
  readonly unsupportedFunctions: readonly string[];
  readonly unsupportedFunctionCount: number;
  readonly limits: readonly string[];
  readonly limitsNote: string;
  readonly workbookRequest: Readonly<Record<string, unknown>>;
}

export interface XlsxProtections {
  readonly protectedSheets: readonly Readonly<Record<string, unknown>>[];
  readonly protectedSheetCount: number;
  readonly structureLocked: boolean;
  /** Always false: this adapter reports protection, never enforces or bypasses it. */
  readonly enforced: false;
  readonly note: string;
}

export interface XlsxPackageFacts {
  readonly parts: number;
  readonly macros: boolean;
  readonly externalLinks: readonly string[];
  readonly calcChain: boolean;
}

export interface XlsxSectionRange {
  readonly sheet: string;
  readonly requested: string | null;
  readonly window: string | null;
  readonly clamped: boolean;
  readonly note: string | null;
}

export interface XlsxPartChange {
  readonly part: string;
  readonly kind: string;
  readonly detail: readonly string[];
  readonly detailTotal: number;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly semanticChange: boolean;
}

/** The structural change set: what the edit added, removed, changed or left byte-identical. */
export interface XlsxChangeSet {
  readonly schema: string;
  readonly version: number;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly XlsxPartChange[];
  readonly byteIdentical: readonly string[];
  readonly byteIdenticalCount: number;
  readonly partCountBefore: number;
  readonly partCountAfter: number;
  readonly semanticallyEmpty: boolean;
}

/** The byte-argued preservation evidence: which parts came back exactly as they arrived. */
export interface XlsxPreservation {
  readonly byteIdenticalCount: number;
  readonly byteIdentical: readonly { readonly part: string; readonly sha256: string }[];
  readonly byteIdenticalTruncated: boolean;
  readonly byteIdenticalHashed: number;
  readonly changedParts: readonly string[];
  readonly addedParts: readonly string[];
  readonly removedParts: readonly string[];
  readonly worksheetByteIdentical: readonly string[];
  readonly chartByteIdentical: readonly string[];
  readonly mediaByteIdentical: readonly string[];
  readonly themeByteIdentical: readonly string[];
  readonly styleByteIdentical: readonly string[];
  readonly drawingByteIdentical: readonly string[];
  readonly pivotByteIdentical: readonly string[];
  readonly verbatimCopy: boolean;
}

/** The fork's own edit receipt: the changed-cell set, keyed by the part that holds each cell. */
export interface XlsxEditReceipt {
  readonly schema: string;
  readonly version: number;
  readonly cellsChanged: {
    readonly parts: Readonly<Record<string, Readonly<Record<string, string>>>>;
    readonly total: number;
    readonly truncated: boolean;
  };
  readonly partsChanged: readonly string[];
  readonly partsAdded: readonly string[];
  readonly partsRemoved: readonly string[];
  readonly confession: readonly Readonly<Record<string, unknown>>[];
  readonly confessionTotal: number;
  readonly derivedEffects: readonly Readonly<Record<string, unknown>>[];
  readonly derivedEffectsTotal: number;
  readonly recalc: Readonly<Record<string, unknown>> | null;
}

export interface XlsxCellChange {
  readonly address: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly beforeType: string | null;
  readonly afterType: string | null;
  readonly kind: string;
  readonly shifted: boolean;
}

export interface XlsxDependency {
  readonly formulaCell: string;
  readonly reference: string;
  readonly changedCell: string;
  readonly sheet: string;
  readonly sameSheet: boolean;
}

/** This adapter's own explicit sum over the cells a `SUM` names, and the file's cached value. */
export interface XlsxSumCheck {
  readonly function: string;
  readonly range: string;
  readonly adapterSum: number | null;
  readonly adapterSumExact: string | null;
  readonly cells: readonly string[];
  readonly cellsTruncated: boolean;
  readonly blankCells: number | null;
  readonly nonNumericCells: readonly string[];
  readonly workbookCachedValue: unknown;
  readonly workbookCachedKnown?: boolean;
  readonly agrees: boolean | null;
  readonly reason: string | null;
  readonly side?: string;
}

export interface XlsxNumericCheck {
  readonly address: string;
  readonly kind: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly exactBefore: string | null;
  readonly exactAfter: string | null;
  readonly delta: number | null;
  readonly deltaExact: string | null;
  readonly method: string;
  readonly note: string | null;
  readonly sum: XlsxSumCheck | null;
}

export interface XlsxStyleChange {
  readonly address: string;
  readonly keys: readonly string[];
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
}

/** The cell, formula and style diff, with its dependencies and its explicit numeric checks. */
export interface XlsxDiff {
  readonly cells: readonly XlsxCellChange[];
  readonly cellsTotal: number;
  readonly cellsTruncated: boolean;
  readonly styleChanges: readonly XlsxStyleChange[];
  readonly styleChangesTotal: number;
  readonly dependencies: readonly XlsxDependency[];
  readonly dependenciesTotal: number;
  readonly numericChecks: readonly XlsxNumericCheck[];
  readonly numericChecksTotal: number;
  readonly numericChecksTruncated: boolean;
  readonly measurement: string;
}

/** A new draft, or a proposal for an existing file that nothing has published yet. */
export interface XlsxProposal {
  readonly status: "draft" | "proposed";
  readonly name: string;
  readonly editOf: string | null;
  readonly sha256: string;
  readonly size: number;
  readonly published: false;
}

export interface XlsxPreviewLine {
  readonly marker: string;
  readonly label: string;
  readonly address: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface XlsxSheetPreview {
  readonly position: number;
  readonly title: string;
  readonly part: string | null;
  readonly usedRange: string;
  readonly protected: boolean;
  readonly lines: readonly XlsxPreviewLine[];
  readonly linesTruncated: boolean;
  readonly lineTotal: number;
  readonly counts: {
    readonly cells: number;
    readonly formulas: number;
    readonly styledCells: number;
    readonly tables: number;
    readonly charts: number;
  };
}

export interface XlsxChangeRecord {
  readonly kind: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface XlsxReopened {
  readonly sheets: number;
  readonly cells: number;
  readonly formulas: number;
  readonly namedRanges: number;
  readonly styledCells: number;
  readonly tables: number;
  readonly charts: number;
  readonly chartParts: number;
  readonly parts: number;
  readonly referenceCheck: number;
}

export interface XlsxInspection {
  readonly operation: "inspect";
  readonly source: XlsxSourceEvidence;
  readonly workbook: XlsxWorkbookCensus;
  readonly sheetOutline: readonly XlsxSheetOutline[];
  readonly sheetOutlineTruncated: boolean;
  readonly namedRanges: readonly XlsxNamedRange[];
  readonly namedRangesTruncated: boolean;
  readonly chartOutline: readonly XlsxChartItem[];
  readonly chartOutlineTruncated: boolean;
  readonly unmodeledChartParts: readonly string[];
  readonly package: XlsxPackageFacts;
  readonly referenceCheck: XlsxReferenceCheck;
  readonly recalculation: XlsxRecalculation;
  readonly protections: XlsxProtections;
  readonly warnings: readonly string[];
}

export interface XlsxReading {
  readonly operation: "read";
  readonly source: XlsxSourceEvidence;
  readonly workbook: XlsxWorkbookCensus;
  readonly page: XlsxPage<XlsxItem>;
  readonly sectionRange: XlsxSectionRange | null;
  readonly cachedValuesRead: boolean;
  readonly package: XlsxPackageFacts;
}

export interface XlsxPlacement {
  readonly name: string;
  readonly rows: number;
  readonly columns: number;
  readonly at: string;
  readonly cellsWritten: number;
  readonly formulas: number;
  readonly styles: number;
  readonly namedRanges: number;
  readonly cellsPresent: number;
}

export interface XlsxDraft {
  readonly operation: "create";
  readonly draft: XlsxProposal;
  readonly structure: XlsxWorkbookCensus;
  readonly placements: readonly XlsxPlacement[];
  readonly namedRanges: readonly XlsxNamedRange[];
  readonly provenance: {
    readonly template: string;
    readonly source: null;
    readonly note: string;
  };
  readonly reopened: XlsxReopened;
  readonly parts: Readonly<Record<string, string>>;
  readonly unmodeledChartParts: readonly string[];
  readonly recalculation: XlsxRecalculation;
  readonly warnings: readonly string[];
}

export interface XlsxPreview {
  readonly operation: "preview";
  readonly source: XlsxSourceEvidence;
  readonly page: XlsxPage<XlsxSheetPreview>;
  readonly workbook: XlsxWorkbookCensus;
  readonly namedRanges: readonly XlsxNamedRange[];
  readonly unmodeledChartParts: readonly string[];
  readonly package: XlsxPackageFacts;
  readonly referenceCheck: XlsxReferenceCheck;
  readonly recalculation: XlsxRecalculation;
  readonly protections: XlsxProtections;
  readonly warnings: readonly string[];
}

/** The shared shape of `edit` and `compare`: a change set, a diff, and their evidence. */
interface XlsxReport {
  readonly changeSet: XlsxChangeSet;
  readonly preservation: XlsxPreservation;
  readonly diff: XlsxDiff;
  readonly recalculation: XlsxRecalculation;
  readonly reopened: XlsxReopened;
  readonly warnings: readonly string[];
}

export interface XlsxEdit extends XlsxReport {
  readonly operation: "edit";
  readonly source: XlsxSourceEvidence;
  readonly proposal: XlsxProposal;
  readonly editReceipt: XlsxEditReceipt;
  readonly changes: readonly XlsxChangeRecord[];
  readonly steps: readonly string[];
  readonly referenceCheck: {
    readonly source: XlsxReferenceCheck;
    readonly output: XlsxReferenceCheck;
    readonly sourceBroken: number;
    readonly outputBroken: number;
    readonly newBroken: readonly XlsxBrokenReference[];
    readonly note: string;
  };
  readonly protections: XlsxProtections;
}

export interface XlsxComparison {
  readonly operation: "compare";
  readonly sources: { readonly from: XlsxSourceEvidence; readonly to: XlsxSourceEvidence };
  readonly changeSet: XlsxChangeSet;
  readonly preservation: XlsxPreservation;
  readonly diff: XlsxDiff & { readonly identical: boolean };
  readonly referenceCheck: {
    readonly from: XlsxReferenceCheck;
    readonly to: XlsxReferenceCheck;
  };
  readonly recalculation: XlsxRecalculation;
  readonly reopened: XlsxReopened;
  readonly warnings: readonly string[];
  readonly identical: boolean;
}

export type XlsxResult =
  | XlsxInspection
  | XlsxReading
  | XlsxDraft
  | XlsxEdit
  | XlsxPreview
  | XlsxComparison;

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

function asNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(what);
  return value;
}

function asNullableNumber(value: unknown, what: string): number | null {
  if (value === null) return null;
  return asNumber(value, what);
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw invalid(what);
  return value;
}

function asFalse(value: unknown, what: string): false {
  if (value !== false) throw invalid(what);
  return false;
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

function asNumberMap(value: unknown, what: string): Readonly<Record<string, number>> {
  const entry = asRecord(value, what);
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(entry)) out[key] = asInteger(item, what);
  return out;
}

function asSourceRef(value: unknown, what: string): XlsxSourceEvidence {
  const entry = asRecord(value, what);
  return {
    fileId: asString(entry.fileId, what),
    versionId: asString(entry.versionId, what),
    name: asString(entry.name, what),
    sha256: asString(entry.sha256, what),
    size: asInteger(entry.size, what),
  };
}

function asCensus(value: unknown, what: string): XlsxWorkbookCensus {
  const entry = asRecord(value, what);
  return {
    sheets: asInteger(entry.sheets, what),
    chartsheets: asInteger(entry.chartsheets, what),
    hiddenSheets: asInteger(entry.hiddenSheets, what),
    protectedSheets: asInteger(entry.protectedSheets, what),
    namedRanges: asInteger(entry.namedRanges, what),
    sheetScopedNames: asInteger(entry.sheetScopedNames, what),
    cells: asInteger(entry.cells, what),
    formulas: asInteger(entry.formulas, what),
    styledCells: asInteger(entry.styledCells, what),
    tables: asInteger(entry.tables, what),
    mergedRanges: asInteger(entry.mergedRanges, what),
    dataValidations: asInteger(entry.dataValidations, what),
    conditionalFormatting: asInteger(entry.conditionalFormatting, what),
    charts: asInteger(entry.charts, what),
    chartParts: asInteger(entry.chartParts, what),
    pivotParts: asInteger(entry.pivotParts, what),
    macros: asBoolean(entry.macros, what),
    calcChain: asBoolean(entry.calcChain, what),
    parts: asInteger(entry.parts, what),
  };
}

function asPackageFacts(value: unknown, what: string): XlsxPackageFacts {
  const entry = asRecord(value, what);
  return {
    parts: asInteger(entry.parts, what),
    macros: asBoolean(entry.macros, what),
    externalLinks: asStrings(entry.externalLinks, what),
    calcChain: asBoolean(entry.calcChain, what),
  };
}

function asSheetOutline(value: unknown, what: string): XlsxSheetOutline {
  const entry = asRecord(value, what);
  return {
    position: asInteger(entry.position, what),
    title: asString(entry.title, what),
    part: asNullableString(entry.part, what),
    state: asString(entry.state, what),
    dimensions: asNullableString(entry.dimensions, what),
    usedRange: asString(entry.usedRange, what),
    maxRow: asInteger(entry.maxRow, what),
    maxColumn: asInteger(entry.maxColumn, what),
    cells: asInteger(entry.cells, what),
    formulas: asInteger(entry.formulas, what),
    styledCells: asInteger(entry.styledCells, what),
    namedRanges: asInteger(entry.namedRanges, what),
    mergedRanges: asInteger(entry.mergedRanges, what),
    tables: asInteger(entry.tables, what),
    charts: asInteger(entry.charts, what),
    protected: asBoolean(entry.protected, what),
    freezePanes: asNullableString(entry.freezePanes, what),
    autoFilter: asBoolean(entry.autoFilter, what),
    dataValidations: asInteger(entry.dataValidations, what),
    conditionalFormatting: asInteger(entry.conditionalFormatting, what),
  };
}

function asNamedRange(value: unknown, what: string): XlsxNamedRange {
  const entry = asRecord(value, what);
  const scope = asString(entry.scope, what);
  if (scope !== "workbook" && scope !== "sheet") throw invalid(what);
  return {
    name: asString(entry.name, what),
    scope,
    sheet: asNullableString(entry.sheet, what),
    reference: asString(entry.reference, what),
    referenceTruncated: asBoolean(entry.referenceTruncated, what),
    kind: asString(entry.kind, what),
    resolved: asBoolean(entry.resolved, what),
    reason: asNullableString(entry.reason, what),
  };
}

function asChartItem(value: unknown, what: string): XlsxChartItem {
  const entry = asRecord(value, what);
  return {
    sheet: asString(entry.sheet, what),
    position: asInteger(entry.position, what),
    type: asString(entry.type, what),
    title: asNullableString(entry.title, what),
    titleResolved: asBoolean(entry.titleResolved, what),
    titleReason: asNullableString(entry.titleReason, what),
    seriesCount: asInteger(entry.seriesCount, what),
    references: asList(entry.references, what).map((item) => {
      const reference = asRecord(item, what);
      return {
        kind: asString(reference.kind, what),
        role: asString(reference.role, what),
        reference: asString(reference.reference, what),
      };
    }),
    referencesTruncated: asBoolean(entry.referencesTruncated, what),
    modeled: asBoolean(entry.modeled, what),
  };
}

function asCellItem(value: unknown, what: string): XlsxCellItem {
  const entry = asRecord(value, what);
  return {
    sheet: asString(entry.sheet, what),
    address: asString(entry.address, what),
    row: asInteger(entry.row, what),
    column: asInteger(entry.column, what),
    value: entry.value,
    valueKind: asString(entry.valueKind, what),
    exact: asNullableString(entry.exact, what),
    formula: asNullableString(entry.formula, what),
    formulaTruncated: asBoolean(entry.formulaTruncated, what),
    cachedValue: entry.cachedValue,
    cachedKnown: asBoolean(entry.cachedKnown, what),
    nonFinite: asBoolean(entry.nonFinite, what),
    numberFormat: asString(entry.numberFormat, what),
    styled: asBoolean(entry.styled, what),
    ...(entry.truncated === undefined ? {} : { truncated: asBoolean(entry.truncated, what) }),
  };
}

function asFormulaReference(value: unknown, what: string): XlsxFormulaReference {
  const entry = asRecord(value, what);
  return {
    raw: asString(entry.raw, what),
    kind: asString(entry.kind, what),
    resolved: asBoolean(entry.resolved, what),
    detail: asString(entry.detail, what),
    ...(entry.sheet === undefined ? {} : { sheet: asNullableString(entry.sheet, what) }),
  };
}

function asFormulaItem(value: unknown, what: string): XlsxFormulaItem {
  const entry = asRecord(value, what);
  return {
    sheet: asString(entry.sheet, what),
    address: asString(entry.address, what),
    formula: asString(entry.formula, what),
    formulaTruncated: asBoolean(entry.formulaTruncated, what),
    references: asList(entry.references, what).map((item) =>
      asFormulaReference(item, `${what} reference`),
    ),
    referencesTotal: asInteger(entry.referencesTotal, what),
    referencesTruncated: asBoolean(entry.referencesTruncated, what),
    brokenReferences: asList(entry.brokenReferences, what).map((item) =>
      asFormulaReference(item, `${what} broken reference`),
    ),
    tokenizerError: asNullableString(entry.tokenizerError, what),
    cachedValue: entry.cachedValue,
    cachedKnown: asBoolean(entry.cachedKnown, what),
  };
}

function asStyleItem(value: unknown, what: string): XlsxStyleItem {
  const entry = asRecord(value, what);
  return {
    sheet: asString(entry.sheet, what),
    address: asString(entry.address, what),
    style: asRecord(entry.style, what),
    value: entry.value,
    formula: asNullableString(entry.formula, what),
  };
}

/** Which item validator a page's `section` promises. The section decides, not the item's own shape. */
function asItem(section: string, value: unknown, what: string): XlsxItem {
  switch (section) {
    case "sheets":
      return asSheetOutline(value, what);
    case "cells":
      return asCellItem(value, what);
    case "formulas":
      return asFormulaItem(value, what);
    case "names":
      return asNamedRange(value, what);
    case "styles":
      return asStyleItem(value, what);
    default:
      return asChartItem(value, what);
  }
}

function asPage<T>(
  value: unknown,
  what: string,
  item: (value: unknown, what: string) => T,
): XlsxPage<T> {
  const entry = asRecord(value, what);
  const pageSize = asInteger(entry.pageSize, what);
  const returned = asInteger(entry.returned, what);
  if (pageSize < 1 || pageSize > MAX_XLSX_PAGE || returned > pageSize) throw invalid(what);
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

function asReferenceCheck(value: unknown, what: string): XlsxReferenceCheck {
  const entry = asRecord(value, what);
  const broken = asList(entry.broken, what).map((item) => {
    const found = asRecord(item, what);
    return {
      where: asString(found.where, what),
      owner: asString(found.owner, what),
      raw: asString(found.raw, what),
      kind: asString(found.kind, what),
      resolved: asBoolean(found.resolved, what),
      detail: asString(found.detail, what),
      ...(found.sheet === undefined ? {} : { sheet: asNullableString(found.sheet, what) }),
    };
  });
  const total = asInteger(entry.brokenTotal, what);
  if (broken.length > total) throw invalid(what);
  const clean = asBoolean(entry.clean, what);
  // The contract: a clean report has no broken entries, and a broken one says what they are.
  if (clean !== (total === 0)) {
    throw refusal(
      "output-invalid",
      "the worker reported a reference check whose verdict contradicts its own findings",
    );
  }
  if (total > 0 && broken.length === 0) {
    throw refusal("output-invalid", "the worker reported broken references without naming any");
  }
  for (const item of broken) {
    if (item.resolved) {
      throw refusal("output-invalid", "the worker listed a resolved reference as broken");
    }
  }
  return {
    checkedReferences: asInteger(entry.checkedReferences, what),
    checkedSurfaces: asInteger(entry.checkedSurfaces, what),
    kinds: asNumberMap(entry.kinds, what),
    broken,
    brokenTotal: total,
    brokenTruncated: asBoolean(entry.brokenTruncated, what),
    brokenKinds: asStrings(entry.brokenKinds, what),
    unscannable: asRecords(entry.unscannable, what),
    clean,
    scope: asString(entry.scope, what),
    partsScanned: asInteger(entry.partsScanned, what),
  };
}

/**
 * The recalculation block, held to its one promise: this workspace computes nothing. A worker that
 * claims a calculated value, or claims to have run an engine it cannot spawn, is refused.
 */
function asRecalculation(value: unknown, what: string): XlsxRecalculation {
  const entry = asRecord(value, what);
  if (entry.computed !== false) {
    throw refusal(
      "output-invalid",
      "the worker claimed a calculated value, which no engine in this workspace can produce",
    );
  }
  if (entry.attempted !== false) {
    throw refusal(
      "output-invalid",
      "the worker claimed to have attempted a recalculation it cannot perform here",
    );
  }
  if (entry.processSpawned !== false) {
    throw refusal(
      "output-invalid",
      "the worker claimed to have spawned a process, which its guard refuses",
    );
  }
  const unsupported = asStrings(entry.unsupportedFunctions, what);
  if (unsupported.length === 0) {
    throw refusal(
      "output-invalid",
      "the worker reported no calculation limits, so a caller cannot see what would not be checked",
    );
  }
  const reason = asString(entry.reason, what);
  if (reason.trim() === "") {
    throw refusal(
      "output-invalid",
      "the worker did not say why no recalculation was attempted, so a caller cannot tell why the " +
        "figures are unchecked",
    );
  }
  const limits = asStrings(entry.limits, what);
  if (limits.length === 0) {
    throw refusal(
      "output-invalid",
      "the worker reported a recalculation limit with no evidence behind it",
    );
  }
  return {
    available: asBoolean(entry.available, what),
    attempted: false,
    computed: false,
    engine: asString(entry.engine, what),
    engineInProcess: asFalse(entry.engineInProcess, what),
    processSpawned: false,
    reason,
    unsupportedFunctions: unsupported,
    unsupportedFunctionCount: asInteger(entry.unsupportedFunctionCount, what),
    limits,
    limitsNote: asString(entry.limitsNote, what),
    workbookRequest: asRecord(entry.workbookRequest, what),
  };
}

function asProtections(value: unknown, what: string): XlsxProtections {
  const entry = asRecord(value, what);
  return {
    protectedSheets: asRecords(entry.protectedSheets, what),
    protectedSheetCount: asInteger(entry.protectedSheetCount, what),
    structureLocked: asBoolean(entry.structureLocked, what),
    enforced: asFalse(entry.enforced, what),
    note: asString(entry.note, what),
  };
}

function asChangeSet(value: unknown, what: string): XlsxChangeSet {
  const entry = asRecord(value, what);
  const changed = asList(entry.changed, what).map((item) => {
    const part = asRecord(item, what);
    return {
      part: asString(part.part, what),
      kind: asString(part.kind, what),
      detail: asStrings(part.detail, what),
      detailTotal: asInteger(part.detailTotal, what),
      beforeSha256: asNullableString(part.beforeSha256, what),
      afterSha256: asNullableString(part.afterSha256, what),
      semanticChange: asBoolean(part.semanticChange, what),
    };
  });
  return {
    schema: asString(entry.schema, what),
    version: asInteger(entry.version, what),
    added: asStrings(entry.added, what),
    removed: asStrings(entry.removed, what),
    changed,
    byteIdentical: asStrings(entry.byteIdentical, what),
    byteIdenticalCount: asInteger(entry.byteIdenticalCount, what),
    partCountBefore: asInteger(entry.partCountBefore, what),
    partCountAfter: asInteger(entry.partCountAfter, what),
    semanticallyEmpty: asBoolean(entry.semanticallyEmpty, what),
  };
}

function asPreservation(value: unknown, what: string): XlsxPreservation {
  const entry = asRecord(value, what);
  const byteIdentical = asList(entry.byteIdentical, what).map((item) => {
    const part = asRecord(item, what);
    return { part: asString(part.part, what), sha256: asString(part.sha256, what) };
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
    worksheetByteIdentical: asStrings(entry.worksheetByteIdentical, what),
    chartByteIdentical: asStrings(entry.chartByteIdentical, what),
    mediaByteIdentical: asStrings(entry.mediaByteIdentical, what),
    themeByteIdentical: asStrings(entry.themeByteIdentical, what),
    styleByteIdentical: asStrings(entry.styleByteIdentical, what),
    drawingByteIdentical: asStrings(entry.drawingByteIdentical, what),
    pivotByteIdentical: asStrings(entry.pivotByteIdentical, what),
    verbatimCopy: asBoolean(entry.verbatimCopy, what),
  };
}

function asEditReceipt(value: unknown, what: string): XlsxEditReceipt {
  const entry = asRecord(value, what);
  const cells = asRecord(entry.cellsChanged, what);
  const parts = asRecord(cells.parts, what);
  const boundedParts: Record<string, Record<string, string>> = {};
  for (const [part, cellsOfPart] of Object.entries(parts)) {
    const inner = asRecord(cellsOfPart, what);
    const mapped: Record<string, string> = {};
    for (const [address, state] of Object.entries(inner)) mapped[address] = asString(state, what);
    boundedParts[part] = mapped;
  }
  return {
    schema: asString(entry.schema, what),
    version: asInteger(entry.version, what),
    cellsChanged: {
      parts: boundedParts,
      total: asInteger(cells.total, what),
      truncated: asBoolean(cells.truncated, what),
    },
    partsChanged: asStrings(entry.partsChanged, what),
    partsAdded: asStrings(entry.partsAdded, what),
    partsRemoved: asStrings(entry.partsRemoved, what),
    confession: asRecords(entry.confession, what),
    confessionTotal: asInteger(entry.confessionTotal, what),
    derivedEffects: asRecords(entry.derivedEffects, what),
    derivedEffectsTotal: asInteger(entry.derivedEffectsTotal, what),
    recalc: entry.recalc === null ? null : asRecord(entry.recalc, what),
  };
}

function asCellChange(value: unknown, what: string): XlsxCellChange {
  const entry = asRecord(value, what);
  return {
    address: asString(entry.address, what),
    before: entry.before,
    after: entry.after,
    beforeType: asNullableString(entry.beforeType, what),
    afterType: asNullableString(entry.afterType, what),
    kind: asString(entry.kind, what),
    shifted: asBoolean(entry.shifted, what),
  };
}

function asDependency(value: unknown, what: string): XlsxDependency {
  const entry = asRecord(value, what);
  return {
    formulaCell: asString(entry.formulaCell, what),
    reference: asString(entry.reference, what),
    changedCell: asString(entry.changedCell, what),
    sheet: asString(entry.sheet, what),
    sameSheet: asBoolean(entry.sameSheet, what),
  };
}

function asSumCheck(value: unknown, what: string): XlsxSumCheck {
  const entry = asRecord(value, what);
  const agrees = entry.agrees === null ? null : asBoolean(entry.agrees, what);
  const adapterSumExact = asNullableString(entry.adapterSumExact, what);
  const reason = asNullableString(entry.reason, what);
  const cachedKnown =
    entry.workbookCachedKnown === undefined ? null : asBoolean(entry.workbookCachedKnown, what);
  // The contract: a sum either compares two values or says why it could not. Silence is refused.
  if (agrees === null && reason === null) {
    throw refusal(
      "output-invalid",
      "the worker reported a sum it could not compare without saying why",
    );
  }
  if (agrees !== null && adapterSumExact === null) {
    throw refusal("output-invalid", "the worker compared a sum it never computed");
  }
  if (agrees !== null && cachedKnown !== true) {
    throw refusal(
      "output-invalid",
      "the worker compared its own sum against a cached value the file does not hold",
    );
  }
  return {
    function: asString(entry.function, what),
    range: asString(entry.range, what),
    adapterSum: asNullableNumber(entry.adapterSum, what),
    adapterSumExact,
    cells: asStrings(entry.cells, what),
    cellsTruncated: asBoolean(entry.cellsTruncated, what),
    blankCells: entry.blankCells === null ? null : asInteger(entry.blankCells, what),
    nonNumericCells: asStrings(entry.nonNumericCells, what),
    workbookCachedValue: entry.workbookCachedValue,
    ...(cachedKnown === null ? {} : { workbookCachedKnown: cachedKnown }),
    agrees,
    reason,
    ...(entry.side === undefined ? {} : { side: asString(entry.side, what) }),
  };
}

function asNumericCheck(value: unknown, what: string): XlsxNumericCheck {
  const entry = asRecord(value, what);
  const delta = asNullableNumber(entry.delta, what);
  const deltaExact = asNullableString(entry.deltaExact, what);
  return {
    address: asString(entry.address, what),
    kind: asString(entry.kind, what),
    before: entry.before,
    after: entry.after,
    exactBefore: asNullableString(entry.exactBefore, what),
    exactAfter: asNullableString(entry.exactAfter, what),
    delta,
    deltaExact,
    method: asString(entry.method, what),
    note: asNullableString(entry.note, what),
    sum: entry.sum === null ? null : asSumCheck(entry.sum, what),
  };
}

function asStyleChange(value: unknown, what: string): XlsxStyleChange {
  const entry = asRecord(value, what);
  return {
    address: asString(entry.address, what),
    keys: asStrings(entry.keys, what),
    before: asRecord(entry.before, what),
    after: asRecord(entry.after, what),
  };
}

function asDiff(value: unknown, what: string): XlsxDiff {
  const entry = asRecord(value, what);
  const cells = asList(entry.cells, what).map((item) => asCellChange(item, `${what} cell change`));
  const cellsTotal = asInteger(entry.cellsTotal, what);
  if (cells.length > cellsTotal) throw invalid(what);
  return {
    cells,
    cellsTotal,
    cellsTruncated: asBoolean(entry.cellsTruncated, what),
    styleChanges: asList(entry.styleChanges, what).map((item) =>
      asStyleChange(item, `${what} style change`),
    ),
    styleChangesTotal: asInteger(entry.styleChangesTotal, what),
    dependencies: asList(entry.dependencies, what).map((item) =>
      asDependency(item, `${what} dependency`),
    ),
    dependenciesTotal: asInteger(entry.dependenciesTotal, what),
    numericChecks: asList(entry.numericChecks, what).map((item) =>
      asNumericCheck(item, `${what} numeric check`),
    ),
    numericChecksTotal: asInteger(entry.numericChecksTotal, what),
    numericChecksTruncated: asBoolean(entry.numericChecksTruncated, what),
    measurement: asString(entry.measurement, what),
  };
}

function asProposal(value: unknown, what: string): XlsxProposal {
  const entry = asRecord(value, what);
  const status = asString(entry.status, what);
  if (status !== "draft" && status !== "proposed") throw invalid(what);
  if (entry.published !== false) {
    throw refusal(
      "output-invalid",
      "the worker reported a published workbook, which no operation does",
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

function asReopened(value: unknown, what: string): XlsxReopened {
  const entry = asRecord(value, what);
  return {
    sheets: asInteger(entry.sheets, what),
    cells: asInteger(entry.cells, what),
    formulas: asInteger(entry.formulas, what),
    namedRanges: asInteger(entry.namedRanges, what),
    styledCells: asInteger(entry.styledCells, what),
    tables: asInteger(entry.tables, what),
    charts: asInteger(entry.charts, what),
    chartParts: asInteger(entry.chartParts, what),
    parts: asInteger(entry.parts, what),
    referenceCheck: asInteger(entry.referenceCheck, what),
  };
}

function asChanges(value: unknown, what: string): readonly XlsxChangeRecord[] {
  return asList(value, what).map((item) => {
    const entry = asRecord(item, what);
    return { kind: asString(entry.kind, what), evidence: asRecord(entry.evidence, what) };
  });
}

function asSheetPreview(value: unknown, what: string): XlsxSheetPreview {
  const entry = asRecord(value, what);
  const counts = asRecord(entry.counts, what);
  return {
    position: asInteger(entry.position, what),
    title: asString(entry.title, what),
    part: asNullableString(entry.part, what),
    usedRange: asString(entry.usedRange, what),
    protected: asBoolean(entry.protected, what),
    lines: asList(entry.lines, what).map((item) => {
      const line = asRecord(item, what);
      return {
        marker: asString(line.marker, what),
        label: asString(line.label, what),
        address: asString(line.address, what),
        text: asString(line.text, what),
        truncated: asBoolean(line.truncated, what),
      };
    }),
    linesTruncated: asBoolean(entry.linesTruncated, what),
    lineTotal: asInteger(entry.lineTotal, what),
    counts: {
      cells: asInteger(counts.cells, what),
      formulas: asInteger(counts.formulas, what),
      styledCells: asInteger(counts.styledCells, what),
      tables: asInteger(counts.tables, what),
      charts: asInteger(counts.charts, what),
    },
  };
}

function asReport(entry: Record<string, unknown>, what: string): XlsxReport {
  return {
    changeSet: asChangeSet(entry.changeSet, `${what} change set`),
    preservation: asPreservation(entry.preservation, `${what} preservation`),
    diff: asDiff(entry.diff, `${what} diff`),
    recalculation: asRecalculation(entry.recalculation, `${what} recalculation`),
    reopened: asReopened(entry.reopened, `${what} reopened`),
    warnings: asStrings(entry.warnings, `${what} warnings`),
  };
}

/**
 * Validates the worker's answer for one operation. The service already inspected every declared
 * output; this is the second half of that contract — the *typed result* is the shape the operation
 * promises, or the call is refused as `output-invalid` rather than shown to a model.
 */
export function parseXlsxResult(
  operation: XlsxOperation,
  value: unknown,
  expected: readonly XlsxSourceEvidence[],
): XlsxResult {
  const entry = asRecord(value, "result");
  const what = `${operation} result`;
  if (entry.schema !== "paper_xlsx_operation" || entry.version !== 1 || entry.ok !== true) {
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
    seen: XlsxSourceEvidence,
    ref: XlsxSourceEvidence | undefined,
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
        workbook: asCensus(entry.workbook, what),
        sheetOutline: asList(entry.sheetOutline, what).map((item) =>
          asSheetOutline(item, `${what} sheet`),
        ),
        sheetOutlineTruncated: asBoolean(entry.sheetOutlineTruncated, what),
        namedRanges: asList(entry.namedRanges, what).map((item) =>
          asNamedRange(item, `${what} named range`),
        ),
        namedRangesTruncated: asBoolean(entry.namedRangesTruncated, what),
        chartOutline: asList(entry.chartOutline, what).map((item) =>
          asChartItem(item, `${what} chart`),
        ),
        chartOutlineTruncated: asBoolean(entry.chartOutlineTruncated, what),
        unmodeledChartParts: asStrings(entry.unmodeledChartParts, what),
        package: asPackageFacts(entry.package, what),
        referenceCheck: asReferenceCheck(entry.referenceCheck, `${what} reference check`),
        recalculation: asRecalculation(entry.recalculation, `${what} recalculation`),
        protections: asProtections(entry.protections, `${what} protections`),
        warnings: asStrings(entry.warnings, what),
      };
    }
    case "read": {
      const source = asSourceRef(entry.source, what);
      check(source, expected[0], "source");
      const page = asRecord(entry.page, `${what} page`);
      const section = asString(page.section, `${what} page`);
      if (!(XLSX_READ_SECTIONS as readonly string[]).includes(section)) {
        throw refusal("output-invalid", `the worker paged a ${section} section, which is not one`);
      }
      if (entry.cachedValuesRead !== true && entry.cachedValuesRead !== false) throw invalid(what);
      return {
        operation,
        source,
        workbook: asCensus(entry.workbook, what),
        page: asPage(page, `${what} page`, (item, name) => asItem(section, item, name)),
        sectionRange:
          entry.sectionRange === null
            ? null
            : (() => {
                const range = asRecord(entry.sectionRange, what);
                return {
                  sheet: asString(range.sheet, what),
                  requested: asNullableString(range.requested, what),
                  window: asNullableString(range.window, what),
                  clamped: asBoolean(range.clamped, what),
                  note: asNullableString(range.note, what),
                };
              })(),
        cachedValuesRead: asBoolean(entry.cachedValuesRead, what),
        package: asPackageFacts(entry.package, what),
      };
    }
    case "create": {
      const provenance = asRecord(entry.provenance, `${what} provenance`);
      if (provenance.source !== null) throw invalid(`${what} provenance`);
      const parts = asRecord(entry.parts, `${what} parts`);
      const mapped: Record<string, string> = {};
      for (const [title, part] of Object.entries(parts)) mapped[title] = asString(part, what);
      return {
        operation,
        draft: asProposal(entry.draft, `${what} draft`),
        structure: asCensus(entry.structure, what),
        placements: asList(entry.placements, what).map((item) => {
          const placement = asRecord(item, `${what} placement`);
          return {
            name: asString(placement.name, what),
            rows: asInteger(placement.rows, what),
            columns: asInteger(placement.columns, what),
            at: asString(placement.at, what),
            cellsWritten: asInteger(placement.cellsWritten, what),
            formulas: asInteger(placement.formulas, what),
            styles: asInteger(placement.styles, what),
            namedRanges: asInteger(placement.namedRanges, what),
            cellsPresent: asInteger(placement.cellsPresent, what),
          };
        }),
        namedRanges: asList(entry.namedRanges, what).map((item) =>
          asNamedRange(item, `${what} named range`),
        ),
        provenance: {
          template: asString(provenance.template, `${what} provenance`),
          source: null,
          note: asString(provenance.note, `${what} provenance`),
        },
        reopened: asReopened(entry.reopened, `${what} reopened`),
        parts: mapped,
        unmodeledChartParts: asStrings(entry.unmodeledChartParts, what),
        recalculation: asRecalculation(entry.recalculation, `${what} recalculation`),
        warnings: asStrings(entry.warnings, what),
      };
    }
    case "edit": {
      const base = asReport(entry, what);
      const source = asSourceRef(entry.source, what);
      check(source, expected[0], "source");
      const referenceCheck = asRecord(entry.referenceCheck, `${what} reference check`);
      const newBroken = asList(referenceCheck.newBroken, `${what} new broken`).map((item) => {
        const broken = asRecord(item, `${what} new broken`);
        return {
          where: asString(broken.where, what),
          owner: asString(broken.owner, what),
          raw: asString(broken.raw, what),
          kind: asString(broken.kind, what),
          resolved: asBoolean(broken.resolved, what),
          detail: asString(broken.detail, what),
          ...(broken.sheet === undefined ? {} : { sheet: asNullableString(broken.sheet, what) }),
        };
      });
      if (newBroken.length > 0) {
        throw refusal(
          "output-invalid",
          "the worker produced a proposal that breaks references it was supposed to refuse",
        );
      }
      return {
        operation,
        ...base,
        source,
        proposal: asProposal(entry.proposal, `${what} proposal`),
        editReceipt: asEditReceipt(entry.editReceipt, `${what} edit receipt`),
        changes: asChanges(entry.changes, `${what} changes`),
        steps: asStrings(entry.steps, what),
        referenceCheck: {
          source: asReferenceCheck(referenceCheck.source, `${what} source reference check`),
          output: asReferenceCheck(referenceCheck.output, `${what} output reference check`),
          sourceBroken: asInteger(referenceCheck.sourceBroken, what),
          outputBroken: asInteger(referenceCheck.outputBroken, what),
          newBroken,
          note: asString(referenceCheck.note, what),
        },
        protections: asProtections(entry.protections, `${what} protections`),
      };
    }
    case "preview": {
      const source = asSourceRef(entry.source, what);
      check(source, expected[0], "source");
      return {
        operation,
        source,
        page: asPage(entry.page, `${what} page`, (item, name) => asSheetPreview(item, name)),
        workbook: asCensus(entry.workbook, what),
        namedRanges: asList(entry.namedRanges, what).map((item) =>
          asNamedRange(item, `${what} named range`),
        ),
        unmodeledChartParts: asStrings(entry.unmodeledChartParts, what),
        package: asPackageFacts(entry.package, what),
        referenceCheck: asReferenceCheck(entry.referenceCheck, `${what} reference check`),
        recalculation: asRecalculation(entry.recalculation, `${what} recalculation`),
        protections: asProtections(entry.protections, `${what} protections`),
        warnings: asStrings(entry.warnings, what),
      };
    }
    default: {
      const sources = asRecord(entry.sources, `${what} sources`);
      const from = asSourceRef(sources.from, `${what} from`);
      const to = asSourceRef(sources.to, `${what} to`);
      check(from, expected[0], "from");
      check(to, expected[1], "to");
      const referenceCheck = asRecord(entry.referenceCheck, `${what} reference check`);
      const base = asReport(entry, what);
      const identical = asBoolean(entry.identical, what);
      return {
        operation: "compare",
        sources: { from, to },
        changeSet: base.changeSet,
        preservation: base.preservation,
        diff: { ...base.diff, identical: asBoolean(asRecord(entry.diff, what).identical, what) },
        referenceCheck: {
          from: asReferenceCheck(referenceCheck.from, `${what} from reference check`),
          to: asReferenceCheck(referenceCheck.to, `${what} to reference check`),
        },
        recalculation: base.recalculation,
        reopened: base.reopened,
        warnings: base.warnings,
        identical,
      };
    }
  }
}

/** The file reference a typed result reports, as the receipt's lineage records it. */
export function xlsxResultRef(leased: LeasedInput): XlsxSourceEvidence {
  return {
    fileId: leased.fileId,
    versionId: leased.versionId,
    name: leased.name,
    sha256: leased.sha256,
    size: leased.size,
  };
}

/** Whether a leased input is a workbook this adapter may open. */
export function isXlsxInput(leased: LeasedInput): boolean {
  return leased.format === XLSX_FORMAT;
}
