/**
 * CSV: encoding and delimiter detection, a quote-aware parser and typed columns. A few lines of our
 * own: the job is small, and every library for it brings more than this pack needs.
 */

import type {
  ColumnType,
  DocumentReading,
  ReadingCell,
  ReadingColumn,
  ReadingSheet,
} from "./reading.js";

const DELIMITERS = [",", ";", "\t", "|"] as const;
const SAMPLE_LINES = 20;

/**
 * UTF-8 when the bytes are valid UTF-8 (a byte-order mark is dropped), otherwise Windows-1252: what
 * a spreadsheet exported on a Western desktop writes, and a superset of Latin-1 for text.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text: text.startsWith("\uFEFF") ? text.slice(1) : text, encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

/** The delimiter that gives the first lines the same, largest number of fields. Comma by default. */
export function detectDelimiter(text: string): string {
  const lines = text
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .slice(0, SAMPLE_LINES);
  let best: { delimiter: string; score: number } = { delimiter: ",", score: 0 };
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter));
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    const consistent = counts.filter((count) => count === first).length;
    const score = consistent * 1_000 + first;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) count += 1;
  }
  return count;
}

/** RFC 4180 fields: quoted fields may hold the delimiter, doubled quotes and line breaks. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value.trim() !== ""));
}

const INTEGER = /^[-+]?\d+$/u;
const DOT_DECIMAL = /^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/u;
const COMMA_DECIMAL = /^[-+]?\d+,\d+$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/u;
const BOOLEAN = /^(true|false)$/iu;

function typeOf(value: string, decimalComma: boolean): ColumnType {
  const trimmed = value.trim();
  if (trimmed === "") return "empty";
  if (INTEGER.test(trimmed)) return "integer";
  if (DOT_DECIMAL.test(trimmed) || (decimalComma && COMMA_DECIMAL.test(trimmed))) return "number";
  if (ISO_DATE.test(trimmed) && !Number.isNaN(Date.parse(trimmed.slice(0, 10)))) return "date";
  if (BOOLEAN.test(trimmed)) return "boolean";
  return "text";
}

/** One type for a whole column: the narrowest every non-empty value fits. */
function columnType(values: readonly string[], decimalComma: boolean): ColumnType {
  const types = new Set(values.map((value) => typeOf(value, decimalComma)));
  types.delete("empty");
  if (types.size === 0) return "empty";
  if (types.size === 1) return [...types][0] as ColumnType;
  if ([...types].every((type) => type === "integer" || type === "number")) return "number";
  return "text";
}

function typedValue(value: string, type: ColumnType): string | number | boolean | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (type === "integer" || type === "number") return Number(trimmed.replace(",", "."));
  if (type === "boolean") return trimmed.toLowerCase() === "true";
  return value;
}

function cellType(type: ColumnType, value: string): ReadingCell["type"] {
  if (value.trim() === "") return "empty";
  if (type === "integer") return "number";
  if (type === "empty") return "empty";
  return type;
}

export function columnLetters(column: number): string {
  let letters = "";
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }
  return letters;
}

/** A Markdown table, the first row as its header. Pipes and line breaks in cells are escaped. */
export function markdownTable(rows: readonly (readonly string[])[]): string {
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0) return "";
  const cell = (value: string | undefined) =>
    (value ?? "").replaceAll("|", "\\|").replace(/\r?\n/gu, " ").trim();
  const line = (row: readonly string[]) =>
    `| ${Array.from({ length: width }, (_, index) => cell(row[index])).join(" | ")} |`;
  const [header = [], ...body] = rows;
  return [line(header), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(line)].join(
    "\n",
  );
}

export function readCsv(bytes: Uint8Array, name: string): DocumentReading {
  const { text, encoding } = decodeText(bytes);
  const delimiter = detectDelimiter(text);
  const rows = parseCsv(text, delimiter);
  const width = Math.max(0, ...rows.map((row) => row.length));
  const [header = [], ...body] = rows;
  // A semicolon file is where a decimal comma lives: the comma is free to be one.
  const decimalComma = delimiter !== ",";
  const columnTypes: ReadingColumn[] = Array.from({ length: width }, (_, column) => ({
    name: header[column] ?? columnLetters(column + 1),
    type: columnType(
      body.map((row) => row[column] ?? ""),
      decimalComma,
    ),
  }));
  const cells: ReadingCell[] = [];
  rows.forEach((row, rowIndex) => {
    row.forEach((value, column) => {
      if (value === "") return;
      const type = rowIndex === 0 ? "text" : (columnTypes[column]?.type ?? "text");
      cells.push({
        address: `${columnLetters(column + 1)}${rowIndex + 1}`,
        row: rowIndex + 1,
        column: column + 1,
        type: rowIndex === 0 ? "text" : cellType(type, value),
        value: rowIndex === 0 ? value : typedValue(value, type),
        formula: null,
        cached: null,
      });
    });
  });
  const dimensions = width === 0 ? "A1" : `A1:${columnLetters(width)}${rows.length}`;
  const sheet: ReadingSheet = {
    name,
    position: 0,
    dimensions,
    rows: rows.length,
    columns: width,
    cells,
    columnTypes,
    text: [
      `Columns: ${columnTypes.map((column) => `${column.name} (${column.type})`).join(", ")}`,
      "",
      markdownTable(rows),
    ].join("\n"),
  };
  return {
    kind: "csv",
    sheets: [sheet],
    tables: [{ name, location: `sheet: ${name}`, rows: rows.length, columns: width }],
    metadata: {
      encoding,
      delimiter,
      rows: body.length,
      columns: width,
    },
    hasTextLayer: true,
  };
}
