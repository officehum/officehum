/**
 * A reading as the model reads it: Markdown with a marker before every unit (`[p. 3]`,
 * `[s. 2, word/document.xml#3]`, `[sheet: Prices]`), cut to a limit with a note saying how to ask
 * for the rest; an outline to choose from; and search results that cite where each passage is.
 */

import { type DocumentReading, ReadingError } from "./reading.js";

export const DEFAULT_MAX_CHARS = 12_000;
export const MAX_MAX_CHARS = 40_000;
const MAX_MATCHES = 20;
const MAX_PASSAGE = 300;

/** One unit of a document as it is cited: a page, a section or a sheet, with its marked text. */
export interface DocumentUnit {
  readonly kind: "page" | "section" | "sheet";
  /** What a citation names: `p. 3`, `s. 2`, `sheet: Prices`. */
  readonly marker: string;
  /** What the text is headed with: the marker, plus a source reference for a section. */
  readonly label: string;
  readonly number: number;
  readonly name: string;
  readonly text: string;
}

type Unit = DocumentUnit;

/**
 * A reading's units in order, each with the marker a citation names (`p. 3`, `s. 2`,
 * `sheet: Prices`) and the label its text is headed with: what `renderRead` shows, for a host that
 * keeps a document as text (a company's own documents).
 */
export function documentUnits(reading: DocumentReading): readonly DocumentUnit[] {
  return unitsOf(reading);
}

function unitsOf(reading: DocumentReading): Unit[] {
  if (reading.pages !== undefined) {
    return reading.pages.map((page) => ({
      kind: "page",
      marker: `p. ${page.number}`,
      label: `p. ${page.number}`,
      number: page.number,
      name: String(page.number),
      text: page.hasText ? page.text : "(no text layer on this page)",
    }));
  }
  if (reading.sections !== undefined) {
    return reading.sections.map((section) => ({
      kind: "section",
      marker: `s. ${section.number}`,
      label: `s. ${section.number}, ${section.ref}`,
      number: section.number,
      name: section.heading ?? String(section.number),
      text: section.text,
    }));
  }
  return (reading.sheets ?? []).map((sheet, index) => ({
    kind: "sheet",
    marker: `sheet: ${sheet.name}`,
    label: `sheet: ${sheet.name}`,
    number: index + 1,
    name: sheet.name,
    text: sheet.text,
  }));
}

/** `"3"`, `"1-2, 5"` → the page numbers, in order, without duplicates. */
export function parsePages(value: string): number[] {
  const numbers = new Set<number>();
  for (const part of value.split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/u.exec(part);
    const from = Number(match?.[1]);
    const to = match?.[2] === undefined ? from : Number(match[2]);
    if (match === null || from < 1 || to < from || to - from > 10_000) {
      throw new ReadingError(
        "invalid-request",
        `"${value}" is not a page list; write pages like "3", "2-4" or "1-2, 5"`,
      );
    }
    for (let page = from; page <= to; page += 1) numbers.add(page);
  }
  return [...numbers].sort((a, b) => a - b);
}

function plural(kind: Unit["kind"]): string {
  return kind === "page" ? "pages" : kind === "section" ? "sections" : "sheets";
}

function select(
  units: readonly Unit[],
  name: string,
  pages: string | undefined,
  sheet: string | undefined,
): Unit[] {
  const kind = units[0]?.kind;
  if (pages !== undefined) {
    if (kind === "sheet") {
      throw new ReadingError(
        "invalid-request",
        `${name} is read by sheet, not by page; ask for a sheet by name instead`,
      );
    }
    const wanted = parsePages(pages);
    const last = units.length;
    const outside = wanted.filter((page) => page > last);
    if (outside.length > 0) {
      throw new ReadingError(
        "invalid-request",
        `${name} has ${plural(kind ?? "page")} 1 to ${last}; there is no ${outside.join(", ")}`,
      );
    }
    return units.filter((unit) => wanted.includes(unit.number));
  }
  if (sheet !== undefined) {
    if (kind !== "sheet") {
      throw new ReadingError(
        "invalid-request",
        `${name} has no sheets; ask for ${plural(kind ?? "page")} with pages instead`,
      );
    }
    const found = units.filter((unit) => unit.name === sheet);
    if (found.length === 0) {
      throw new ReadingError(
        "invalid-request",
        `${name} has no sheet "${sheet}"; its sheets are ${units.map((unit) => unit.name).join(", ")}`,
      );
    }
    return found;
  }
  return [...units];
}

export interface RenderReadOptions {
  readonly name: string;
  readonly pages?: string;
  readonly sheet?: string;
  readonly maxChars?: number;
}

export interface RenderedRead {
  readonly text: string;
  readonly truncated: boolean;
  /** The markers of the units shown, whole or in part. */
  readonly shown: readonly string[];
}

export function renderRead(reading: DocumentReading, options: RenderReadOptions): RenderedRead {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const units = select(unitsOf(reading), options.name, options.pages, options.sheet);
  const blocks = units.map((unit) => `[${unit.label}]\n${unit.text}`);
  const body = blocks.join("\n\n");
  if (body.length <= maxChars) {
    return { text: body, truncated: false, shown: units.map((unit) => unit.marker) };
  }

  const cutAt = Math.max(body.lastIndexOf("\n", maxChars), 0) || maxChars;
  const kept = body.slice(0, cutAt).trimEnd();
  // The unit the cut fell in is the first one to ask for again.
  let start = 0;
  let partial = 0;
  for (const [index, block] of blocks.entries()) {
    if (start + block.length > kept.length) {
      partial = index;
      break;
    }
    start += block.length + 2;
    partial = index + 1;
  }
  const next = units[Math.min(partial, units.length - 1)] as Unit;
  const last = units.at(-1) as Unit;
  const more =
    next.kind === "sheet"
      ? `sheet: "${next.name}"`
      : `pages: "${next.number === last.number ? next.number : `${next.number}-${last.number}`}"`;
  const note =
    `[Cut at ${maxChars} characters, in ${next.marker}. Ask for more with ${more}, ` +
    `or a larger max_chars (up to ${MAX_MAX_CHARS}).]`;
  return {
    text: `${kept}\n\n${note}`,
    truncated: true,
    shown: units.slice(0, partial + 1).map((unit) => unit.marker),
  };
}

const KIND_LABEL: Readonly<Record<DocumentReading["kind"], string>> = {
  pdf: "PDF",
  docx: "Word document",
  xlsx: "Excel workbook",
  csv: "CSV file",
  eml: "email",
};

function firstLine(text: string): string {
  const line = text.split("\n").find((entry) => entry.trim() !== "") ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

export function renderOutline(reading: DocumentReading, name: string): string {
  const units = unitsOf(reading);
  const lines = [
    `${name}: ${KIND_LABEL[reading.kind]}, ${units.length} ${plural(units[0]?.kind ?? "page")}, ` +
      `hasTextLayer: ${reading.hasTextLayer}`,
  ];
  const metadata = Object.entries(reading.metadata).filter(([, value]) => value !== null);
  if (metadata.length > 0) {
    lines.push(`Metadata: ${metadata.map(([key, value]) => `${key}=${String(value)}`).join("; ")}`);
  }
  if (reading.pages !== undefined) {
    lines.push("", "Pages:");
    for (const page of reading.pages) {
      lines.push(
        page.hasText
          ? `- p. ${page.number}: ${page.text.length} characters, starts "${firstLine(page.text)}"`
          : `- p. ${page.number}: no text layer (a scan; its text needs OCR)`,
      );
    }
  }
  if (reading.sections !== undefined) {
    lines.push("", "Sections:");
    for (const section of reading.sections) {
      const indent = "  ".repeat(Math.max((section.level ?? 1) - 1, 0));
      lines.push(
        `${indent}- s. ${section.number} (${section.ref}): ${section.heading ?? "(before the first heading)"}, ` +
          `${section.text.length} characters`,
      );
    }
  }
  if (reading.sheets !== undefined) {
    lines.push("", "Sheets:");
    for (const sheet of reading.sheets) {
      const formulas = sheet.cells.filter((cell) => cell.type === "formula").length;
      lines.push(
        `- sheet: ${sheet.name} (${sheet.dimensions}): ${sheet.rows} rows x ${sheet.columns} columns, ` +
          `${sheet.cells.length} cells, ${formulas} formulas`,
      );
      if (sheet.columnTypes !== undefined) {
        lines.push(
          `  Columns: ${sheet.columnTypes.map((column) => `${column.name} (${column.type})`).join(", ")}`,
        );
      }
    }
  }
  if (reading.tables.length > 0) {
    lines.push("", "Tables:");
    for (const table of reading.tables) {
      lines.push(
        `- ${table.name} in ${table.location}: ${table.rows} rows x ${table.columns} columns`,
      );
    }
  }
  if (reading.attachments !== undefined && reading.attachments.length > 0) {
    lines.push("", "Attachments:");
    for (const attachment of reading.attachments) {
      lines.push(
        `- ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes): ${attachment.fileId ?? "not saved"}`,
      );
    }
  }
  return lines.join("\n");
}

export interface SearchMatch {
  readonly marker: string;
  readonly passage: string;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ").trim();
}

function excerpt(line: string, needle: string): string {
  const passage = line.trim();
  if (passage.length <= MAX_PASSAGE) return passage;
  const at = Math.max(passage.toLowerCase().indexOf(needle), 0);
  const from = Math.max(at - Math.floor(MAX_PASSAGE / 3), 0);
  return `${from > 0 ? "..." : ""}${passage.slice(from, from + MAX_PASSAGE)}...`;
}

/**
 * Passages (lines; a table row is a line) that hold the query: the whole phrase where any passage
 * has it, otherwise every word of it. Case and spacing are ignored. At most 20, in document order.
 */
export function searchDocument(reading: DocumentReading, query: string): SearchMatch[] {
  const phrase = normalise(query);
  if (phrase === "") throw new ReadingError("invalid-request", "a search needs some words to find");
  const words = phrase.split(" ");
  const passages = unitsOf(reading).flatMap((unit) =>
    unit.text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => ({ marker: unit.marker, line, normal: normalise(line) })),
  );
  let found = passages.filter((passage) => passage.normal.includes(phrase));
  if (found.length === 0) {
    found = passages.filter((passage) => words.every((word) => passage.normal.includes(word)));
  }
  return found.slice(0, MAX_MATCHES).map((passage) => ({
    marker: passage.marker,
    passage: excerpt(passage.line, words[0] ?? phrase),
  }));
}
