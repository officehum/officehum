/**
 * Word and Excel, read through the Paper Office worker with the task's lease.
 *
 * The run's code is `python/office_reader.py`, sent unchanged; what varies (the leased reference,
 * the format, where to resume) is in its arguments. The service stages only the lease's versions,
 * inspects each package before any parser sees it (so a malformed or unsafe file is refused with the
 * service's own code), and binds every run into a receipt. A long document needs more than one run,
 * because one run's result is bounded: each run continues from the cursor the last one returned,
 * under its own operation ID derived from the tool call's, so a replay resolves to the same receipts.
 */

import { readFileSync } from "node:fs";
import type { DocumentLease, DocumentService, LeasedInput } from "@officehum/tools-paper-office";
import { columnLetters, markdownTable } from "./csv.js";
import {
  checkSize,
  DEFAULT_READING_LIMITS,
  type DocumentReading,
  type ReadingCell,
  ReadingError,
  type ReadingLimits,
  type ReadingSection,
  type ReadingSheet,
  type ReadingTable,
} from "./reading.js";

/** The fixed program every Office read runs. */
export const OFFICE_READER_CODE = readFileSync(
  new URL("../python/office_reader.py", import.meta.url),
  "utf8",
);

/** Runs one read may take, so a pathological file cannot keep a call going forever. */
const MAX_RUNS = 40;

export interface ReadOfficeOptions {
  readonly service: DocumentService;
  readonly lease: DocumentLease;
  /** The leased version to read; it must be one of the lease's inputs. */
  readonly input: LeasedInput;
  readonly taskId: string;
  /** The tool call's operation ID; each run's ID is derived from it. */
  readonly operationId: string;
  /** A limit left out keeps its default. */
  readonly limits?: Partial<ReadingLimits>;
}

interface DocxItem {
  readonly story: string;
  readonly index: number;
  readonly kind: "heading" | "paragraph" | "list" | "table";
  readonly text?: string;
  readonly level?: number;
  readonly rows?: string[][];
}

interface XlsxSheetFacts {
  readonly position: number;
  readonly name: string;
  readonly dimensions: string;
  readonly maxRow: number;
  readonly maxColumn: number;
  readonly tables: readonly { readonly name: string; readonly range: string }[];
}

interface Page {
  readonly items: readonly unknown[];
  readonly nextCursor: number | null;
  readonly total: number;
  readonly sheets?: readonly XlsxSheetFacts[];
}

export async function readOfficeDocument(options: ReadOfficeOptions): Promise<DocumentReading> {
  const limits: ReadingLimits = { ...DEFAULT_READING_LIMITS, ...options.limits };
  const { input } = options;
  if (input.format !== "docx" && input.format !== "xlsx") {
    throw new ReadingError(
      "unsupported-format",
      `${input.name} is a ${input.format} file; this pack reads Word and Excel, not PowerPoint.`,
    );
  }
  checkSize(input.size, limits, input.name);
  const deadline = Date.now() + limits.timeoutMs;
  const items: unknown[] = [];
  let sheets: readonly XlsxSheetFacts[] | undefined;
  let cursor: number | null = 0;
  for (let run = 0; cursor !== null; run += 1) {
    if (run >= MAX_RUNS || Date.now() > deadline) {
      throw new ReadingError(
        "timeout",
        `reading ${input.name} did not finish within the limit per file. It may be unusually large.`,
      );
    }
    const page = await runReader(options, input, cursor, run);
    items.push(...page.items);
    sheets ??= page.sheets;
    if (page.nextCursor !== null && page.nextCursor <= cursor) {
      throw new ReadingError("malformed", "the reader did not move forward through the document");
    }
    cursor = page.nextCursor;
  }
  return input.format === "docx"
    ? docxReading(items as DocxItem[])
    : xlsxReading(items as ReadingCellItem[], sheets ?? []);
}

async function runReader(
  options: ReadOfficeOptions,
  input: LeasedInput,
  cursor: number,
  run: number,
): Promise<Page> {
  const ref = {
    fileId: input.fileId,
    versionId: input.versionId,
    name: input.name,
    sha256: input.sha256,
    size: input.size,
  };
  const outcome = await options.service.runDocumentPython({
    operationId: `${options.operationId}:read:${run}`,
    taskId: options.taskId,
    lease: options.lease,
    code: OFFICE_READER_CODE,
    arguments: { ref, format: input.format, cursor },
  });
  if (outcome.kind === "refused") throw new ReadingError(outcome.code, outcome.message);
  return pageOf(outcome.receipt.result);
}

/** The worker's answer, checked before anything trusts it. */
function pageOf(value: unknown): Page {
  const bad = () =>
    new ReadingError("malformed", "the document reader returned an unexpected shape");
  if (typeof value !== "object" || value === null) throw bad();
  const entry = value as Record<string, unknown>;
  if (!Array.isArray(entry.items)) throw bad();
  if (entry.nextCursor !== null && !Number.isSafeInteger(entry.nextCursor)) throw bad();
  if (!Number.isSafeInteger(entry.total)) throw bad();
  if (entry.sheets !== undefined && !Array.isArray(entry.sheets)) throw bad();
  for (const item of entry.items) {
    if (typeof item !== "object" || item === null) throw bad();
  }
  return {
    items: entry.items,
    nextCursor: entry.nextCursor as number | null,
    total: entry.total as number,
    ...(entry.sheets === undefined ? {} : { sheets: entry.sheets as XlsxSheetFacts[] }),
  };
}

// -- Word ------------------------------------------------------------------------------------------

function blockMarkdown(item: DocxItem): string {
  switch (item.kind) {
    case "heading":
      return `${"#".repeat(Math.min(Math.max(item.level ?? 1, 0) + 1, 6))} ${item.text ?? ""}`;
    case "list":
      return `- ${item.text ?? ""}`;
    case "table":
      return markdownTable(item.rows ?? []);
    default:
      return item.text ?? "";
  }
}

/** A section's blocks as Markdown: consecutive list items stay one list, the rest are paragraphs. */
function sectionText(blocks: readonly DocxItem[]): string {
  let text = "";
  let previous: DocxItem["kind"] | undefined;
  for (const block of blocks) {
    const markdown = blockMarkdown(block);
    if (markdown.trim() === "") continue;
    if (text !== "") text += previous === "list" && block.kind === "list" ? "\n" : "\n\n";
    text += markdown;
    previous = block.kind;
  }
  return text;
}

/** Sections start at each heading; text before the first heading is a section of its own. */
function docxReading(items: readonly DocxItem[]): DocumentReading {
  const sections: {
    heading: string | null;
    level: number | null;
    ref: string;
    blocks: DocxItem[];
  }[] = [];
  const tables: ReadingTable[] = [];
  for (const item of items) {
    const current = sections.at(-1);
    if (item.kind === "heading" || current === undefined) {
      sections.push({
        heading: item.kind === "heading" ? (item.text ?? "") : null,
        level: item.kind === "heading" ? (item.level ?? 1) : null,
        ref: `${item.story}#${item.index}`,
        blocks: [item],
      });
    } else {
      current.blocks.push(item);
    }
    if (item.kind === "table") {
      const rows = item.rows ?? [];
      tables.push({
        name: `Table ${tables.length + 1}`,
        location: `s. ${sections.length}`,
        rows: rows.length,
        columns: Math.max(0, ...rows.map((row) => row.length)),
        cells: rows,
      });
    }
  }
  const readingSections: ReadingSection[] = sections.map((section, index) => ({
    number: index + 1,
    heading: section.heading,
    level: section.level,
    ref: section.ref,
    text: sectionText(section.blocks),
  }));
  return {
    kind: "docx",
    sections: readingSections,
    tables,
    metadata: {
      blocks: items.length,
      headings: items.filter((item) => item.kind === "heading").length,
      tables: tables.length,
    },
    hasTextLayer: true,
  };
}

// -- Excel -----------------------------------------------------------------------------------------

interface ReadingCellItem extends ReadingCell {
  readonly sheet: string;
}

function display(cell: ReadingCell): string {
  if (cell.type === "formula") {
    const cached = cell.cached === null ? "no cached value" : String(cell.cached.value);
    return `${cached} (${cell.formula ?? ""})`;
  }
  return cell.value === null ? "" : String(cell.value);
}

function xlsxReading(
  items: readonly ReadingCellItem[],
  facts: readonly XlsxSheetFacts[],
): DocumentReading {
  const tables: ReadingTable[] = [];
  const sheets: ReadingSheet[] = facts.map((sheet) => {
    const cells = items
      .filter((item) => item.sheet === sheet.name)
      .map(({ sheet: _sheet, ...cell }) => cell);
    const grid: string[][] = Array.from({ length: sheet.maxRow }, () =>
      Array.from({ length: sheet.maxColumn }, () => ""),
    );
    for (const cell of cells) {
      const row = grid[cell.row - 1];
      if (row !== undefined && cell.column - 1 < row.length) row[cell.column - 1] = display(cell);
    }
    const header = Array.from({ length: sheet.maxColumn }, (_, index) => columnLetters(index + 1));
    const rows = grid.map((row, index) => [String(index + 1), ...row]);
    for (const table of sheet.tables) {
      const [start = "", end = start] = table.range.split(":");
      const size = rangeSize(start, end);
      tables.push({ name: table.name, location: `sheet: ${sheet.name}`, ...size });
    }
    return {
      name: sheet.name,
      position: sheet.position,
      dimensions: sheet.dimensions,
      rows: sheet.maxRow,
      columns: sheet.maxColumn,
      cells,
      text: cells.length === 0 ? "(empty sheet)" : markdownTable([["", ...header], ...rows]),
    };
  });
  return {
    kind: "xlsx",
    sheets,
    tables,
    metadata: {
      sheets: sheets.length,
      cells: items.length,
      formulas: items.filter((item) => item.type === "formula").length,
    },
    hasTextLayer: true,
  };
}

function rangeSize(start: string, end: string): { rows: number; columns: number } {
  const parse = (address: string) => {
    const match = /^\$?([A-Z]+)\$?(\d+)$/u.exec(address);
    if (match === null) return { column: 0, row: 0 };
    const column = [...(match[1] ?? "")].reduce(
      (total, char) => total * 26 + char.charCodeAt(0) - 64,
      0,
    );
    return { column, row: Number(match[2]) };
  };
  const from = parse(start);
  const to = parse(end);
  return { rows: to.row - from.row + 1, columns: to.column - from.column + 1 };
}
