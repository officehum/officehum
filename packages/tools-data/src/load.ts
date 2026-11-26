/**
 * Files from the task's view of the `FileStore`, staged as the named tables a query reads.
 *
 * CSV, Parquet and JSON are read from the store and handed to DuckDB's own readers. CSV is decoded
 * first as the reading pack decodes it (UTF-8, else Windows-1252), so DuckDB always sees UTF-8.
 * Excel is read the way every Office file is: only through the task's document lease, by the pinned
 * Paper reader the reading pack runs, in bounded runs; its sheet becomes CSV text for the same
 * sniffer, so a workbook's figures get the same exact types as a CSV file's.
 */

import { isExternalFile, type VersionedFileStore } from "@officehum/sdk";
import {
  columnLetters,
  decodeText,
  type ReadingCell,
  ReadingError,
  readOfficeDocument,
} from "@officehum/tools-documents";
import {
  type DocumentLease,
  type DocumentService,
  FORMAT_MIME,
  type LeasedInput,
} from "@officehum/tools-paper-office";
import { DataError } from "./errors.js";
import { type DataLimits, type StagedFormat, type StagedTable, tableName } from "./sandbox.js";

/** What the pack needs of the file store: to look a file up, read it, and save a result. */
export type DataFiles = Pick<VersionedFileStore, "info" | "get" | "create" | "lookupOperation">;

export type DataFileKind = "csv" | "xlsx" | "parquet" | "json";

/** The most tables one call may load. */
export const MAX_TABLES = 8;

const MIME: Readonly<Record<string, DataFileKind>> = {
  "text/csv": "csv",
  "application/csv": "csv",
  "text/tab-separated-values": "csv",
  [FORMAT_MIME.xlsx]: "xlsx",
  "application/vnd.apache.parquet": "parquet",
  "application/x-parquet": "parquet",
  "application/json": "json",
  "application/x-ndjson": "json",
  "application/jsonl": "json",
};

const EXTENSIONS: Readonly<Record<string, DataFileKind>> = {
  ".csv": "csv",
  ".tsv": "csv",
  ".xlsx": "xlsx",
  ".parquet": "parquet",
  ".json": "json",
  ".jsonl": "json",
  ".ndjson": "json",
};

/** The kind of data file a MIME type or, failing that, a file name says it is. */
export function dataFileKind(mimeType: string, name: string): DataFileKind | undefined {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const byMime = MIME[mime];
  if (byMime !== undefined) return byMime;
  const lower = name.toLowerCase();
  const ending = Object.keys(EXTENSIONS).find((extension) => lower.endsWith(extension));
  return ending === undefined ? undefined : EXTENSIONS[ending];
}

export interface TableRequest {
  readonly name: string;
  readonly fileId: string;
  readonly sheet?: string;
}

export interface LoadContext {
  readonly files: DataFiles | undefined;
  readonly lease: DocumentLease | undefined;
  readonly service: DocumentService | undefined;
  readonly taskId: string;
  /** The tool call's operation ID; each workbook read derives its own from it. */
  readonly operationId: string;
  readonly limits: DataLimits;
}

export interface StagedSources {
  readonly tables: readonly StagedTable[];
  /** Which file each table came from, to cite. */
  readonly sources: readonly {
    readonly table: string;
    readonly fileId: string;
    readonly name: string;
  }[];
  /** True when any file came from outside the office, so its values are framed as outside data. */
  readonly external: boolean;
}

/** The `tables` argument, checked: 1 to 8 entries, each a unique name, a file id, maybe a sheet. */
export function tableRequests(value: unknown): TableRequest[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TABLES) {
    throw new DataError("invalid-request", `tables must list 1 to ${MAX_TABLES} files to load`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new DataError("invalid-request", `tables[${index}] must be an object`);
    }
    const { name, file_id: fileId, sheet } = entry as Record<string, unknown>;
    const table = tableName(name, `tables[${index}].name`);
    if (seen.has(table.toLowerCase())) {
      throw new DataError(
        "invalid-request",
        `two tables are named ${table}; give each its own name`,
      );
    }
    seen.add(table.toLowerCase());
    if (typeof fileId !== "string" || fileId.trim() === "") {
      throw new DataError("invalid-request", `tables[${index}].file_id must be a file id`);
    }
    if (sheet !== undefined && (typeof sheet !== "string" || sheet === "")) {
      throw new DataError("invalid-request", `tables[${index}].sheet must be a sheet name`);
    }
    return { name: table, fileId, ...(sheet === undefined ? {} : { sheet }) };
  });
}

/** Reads every requested file and stages it as a table, refusing the first one it cannot load. */
export async function stageTables(
  requests: readonly TableRequest[],
  context: LoadContext,
): Promise<StagedSources> {
  const tables: StagedTable[] = [];
  const sources: { table: string; fileId: string; name: string }[] = [];
  let external = false;
  for (const request of requests) {
    const staged = await stage(request, context);
    tables.push(staged.table);
    sources.push({ table: request.name, fileId: staged.fileId, name: staged.fileName });
    external ||= staged.external;
  }
  return { tables, sources, external };
}

interface Staged {
  readonly table: StagedTable;
  readonly fileId: string;
  readonly fileName: string;
  readonly external: boolean;
}

async function stage(request: TableRequest, context: LoadContext): Promise<Staged> {
  const leased = leasedInputFor(context.lease, request.fileId);
  if (leased !== undefined) return stageWorkbook(request, leased, context);

  if (context.files === undefined) {
    throw new DataError(
      "no-files",
      "this task has no file access, so no file can be loaded. Ask the host to share the file.",
    );
  }
  const ref = await info(context.files, request.fileId);
  const kind = dataFileKind(ref.mimeType, ref.name);
  if (kind === undefined) {
    throw new DataError(
      "unsupported-format",
      `${ref.name} (${ref.mimeType}) is not a CSV, Excel, Parquet or JSON file`,
    );
  }
  if (kind === "xlsx") {
    throw context.lease === undefined
      ? new DataError(
          "no-lease",
          `${ref.name} is an Excel workbook, which is read only through the task's document lease, and this task has none. Ask the host to lease the file.`,
        )
      : new DataError(
          "ungranted-input",
          `${ref.name} is an Excel workbook that this task's document lease does not name. Ask the host to lease it.`,
        );
  }
  if (request.sheet !== undefined) {
    throw new DataError(
      "invalid-request",
      `${ref.name} is a ${kind} file, which has no sheets; leave sheet out`,
    );
  }
  tooLarge(ref.size, ref.name, context.limits);
  const stored = await context.files.get(ref.id);
  if (stored === undefined) {
    throw new DataError("not-found", `there is no file ${request.fileId} this task can read`);
  }
  const bytes =
    kind === "csv" ? new TextEncoder().encode(decodeText(stored.bytes).text) : stored.bytes;
  const format: StagedFormat = kind;
  return {
    table: { name: request.name, format, bytes },
    fileId: ref.id,
    fileName: ref.name,
    external: isExternalFile(ref),
  };
}

async function info(files: DataFiles, id: string) {
  let ref: Awaited<ReturnType<DataFiles["info"]>>;
  try {
    ref = await files.info(id);
  } catch {
    ref = undefined;
  }
  if (ref === undefined) {
    throw new DataError("not-found", `there is no file ${id} this task can read`);
  }
  return ref;
}

function tooLarge(size: number, name: string, limits: DataLimits): void {
  if (size > limits.maxFileBytes) {
    throw new DataError(
      "too-large",
      `${name} is ${size} bytes; the limit per file is ${limits.maxFileBytes} bytes`,
    );
  }
}

/** The lease's input a `file_id` names: by version id, or by file id when one version is leased. */
function leasedInputFor(lease: DocumentLease | undefined, id: string): LeasedInput | undefined {
  if (lease === undefined) return undefined;
  const byVersion = lease.inputs.find((input) => input.versionId === id);
  if (byVersion !== undefined) return byVersion;
  const byFile = lease.inputs.filter((input) => input.fileId === id);
  if (byFile.length > 1) {
    throw new DataError(
      "invalid-request",
      `this task's lease holds ${byFile.length} versions of ${id}; name the version id to load`,
    );
  }
  return byFile[0];
}

async function stageWorkbook(
  request: TableRequest,
  input: LeasedInput,
  context: LoadContext,
): Promise<Staged> {
  if (input.format !== "xlsx") {
    throw new DataError(
      "unsupported-format",
      `${input.name} is a ${input.format} file; only Excel workbooks load as tables`,
    );
  }
  if (context.service === undefined || context.lease === undefined) {
    throw new DataError(
      "no-service",
      `${input.name} is read by the Paper document worker, which the host has not connected`,
    );
  }
  tooLarge(input.size, input.name, context.limits);
  let reading: Awaited<ReturnType<typeof readOfficeDocument>>;
  try {
    reading = await readOfficeDocument({
      service: context.service,
      lease: context.lease,
      input,
      taskId: context.taskId,
      operationId: `${context.operationId}:${request.name}`,
      limits: {
        maxBytes: context.limits.maxFileBytes,
        maxPages: 500,
        timeoutMs: context.limits.timeoutMs,
      },
    });
  } catch (error) {
    if (error instanceof ReadingError) throw new DataError(error.code, error.message);
    throw error;
  }
  const sheets = reading.sheets ?? [];
  const sheet =
    request.sheet === undefined ? sheets[0] : sheets.find((entry) => entry.name === request.sheet);
  if (sheet === undefined) {
    throw new DataError(
      "not-found",
      request.sheet === undefined
        ? `${input.name} has no sheets`
        : `${input.name} has no sheet ${JSON.stringify(request.sheet)}; its sheets are ${sheets.map((entry) => entry.name).join(", ")}`,
    );
  }
  const bytes = sheetCsv(sheet.cells);
  if (bytes.byteLength === 0) {
    throw new DataError("not-found", `sheet ${sheet.name} of ${input.name} is empty`);
  }
  const ref =
    context.files === undefined
      ? undefined
      : await context.files.info(input.fileId).catch(() => undefined);
  return {
    table: { name: request.name, format: "csv", bytes },
    fileId: input.fileId,
    fileName: input.name,
    // A leased version the store cannot describe is treated as outside data: the safer reading.
    external: ref === undefined || isExternalFile(ref),
  };
}

/** A cell's value as the workbook holds it: a formula's cached value, never a calculated one. */
function cellValue(cell: ReadingCell): string | number | boolean | null {
  if (cell.type === "formula") return cell.cached?.value ?? null;
  return cell.value;
}

/**
 * A sheet as CSV text: its first row that holds anything is the header (a column without a heading is
 * named by its letter), and every row below it is data, from the first column used to the last.
 */
export function sheetCsv(cells: readonly ReadingCell[]): Uint8Array {
  const used = cells.filter((cell) => cellValue(cell) !== null);
  if (used.length === 0) return new TextEncoder().encode("");
  const top = Math.min(...used.map((cell) => cell.row));
  const bottom = Math.max(...used.map((cell) => cell.row));
  const left = Math.min(...used.map((cell) => cell.column));
  const right = Math.max(...used.map((cell) => cell.column));
  const grid = new Map<string, string | number | boolean>();
  for (const cell of used) grid.set(`${cell.row}:${cell.column}`, cellValue(cell) as string);
  const field = (value: string | number | boolean | undefined) => {
    if (value === undefined) return "";
    const text = String(value);
    return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines: string[] = [];
  for (let row = top; row <= bottom; row += 1) {
    const values: string[] = [];
    for (let column = left; column <= right; column += 1) {
      const value = grid.get(`${row}:${column}`);
      values.push(field(row === top && value === undefined ? columnLetters(column) : value));
    }
    lines.push(values.join(","));
  }
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}
