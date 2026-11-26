/**
 * What reading a document produces, whatever its format, and the limits every reader keeps.
 *
 * A reading is split into the units a person cites: pages for a PDF, sections for a Word document
 * or an email, sheets for a workbook or a CSV file. Each unit carries its own text, so the tools can
 * mark it (`[p. 3]`, `[s. 2, word/document.xml#3]`, `[sheet: Prices]`) and select it by number or
 * name. Tables are listed beside the units with where they sit, so a model can choose what to read.
 */

export const DOCUMENT_KINDS = ["pdf", "docx", "xlsx", "csv", "eml"] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_MIME: Readonly<Record<DocumentKind, string>> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  eml: "message/rfc822",
};

const MIME_ALIASES: Readonly<Record<string, DocumentKind>> = {
  "application/x-pdf": "pdf",
  "application/csv": "csv",
  "text/comma-separated-values": "csv",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsx",
};

const EXTENSIONS: Readonly<Record<string, DocumentKind>> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".csv": "csv",
  ".eml": "eml",
};

/** The kind a MIME type names, falling back to the file name's extension; `undefined` if neither. */
export function documentKindOf(mimeType: string, name?: string): DocumentKind | undefined {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const byMime = (Object.entries(DOCUMENT_MIME).find(([, value]) => value === mime)?.[0] ??
    MIME_ALIASES[mime]) as DocumentKind | undefined;
  if (byMime !== undefined) return byMime;
  if (name === undefined) return undefined;
  const lower = name.toLowerCase();
  const extension = Object.keys(EXTENSIONS).find((ending) => lower.endsWith(ending));
  return extension === undefined ? undefined : EXTENSIONS[extension];
}

/** One page of a PDF. */
export interface ReadingPage {
  readonly number: number;
  readonly text: string;
  /** False when the page carries no text at all: a scan, which a later OCR tool can take over. */
  readonly hasText: boolean;
}

/** One section of a Word document (split at headings) or of an email. */
export interface ReadingSection {
  readonly number: number;
  readonly heading: string | null;
  /** The heading's level: 0 for a title, 1 for Heading 1; `null` for a section with no heading. */
  readonly level: number | null;
  /** Where the section starts in the source, e.g. `word/document.xml#3`, or `email:body`. */
  readonly ref: string;
  /** The section's text in Markdown: headings, list items and tables kept. */
  readonly text: string;
}

/** A cell's value, as the workbook stored it. A formula's value is the one the package cached. */
export type CellType = "text" | "number" | "boolean" | "date" | "error" | "empty" | "formula";

export interface ReadingCell {
  readonly address: string;
  readonly row: number;
  readonly column: number;
  readonly type: CellType;
  /** The literal value; `null` for a formula cell, whose value is `cached`. */
  readonly value: string | number | boolean | null;
  readonly formula: string | null;
  /** What the package cached for a formula, or `null` when it holds none. Never calculated here. */
  readonly cached: {
    readonly type: Exclude<CellType, "formula" | "empty">;
    readonly value: string | number | boolean;
  } | null;
  readonly numberFormat?: string;
}

/** A CSV column's type, decided from every value in it. */
export type ColumnType = "integer" | "number" | "date" | "boolean" | "text" | "empty";

export interface ReadingColumn {
  readonly name: string;
  readonly type: ColumnType;
}

/** One sheet of a workbook, or the one sheet a CSV file is. */
export interface ReadingSheet {
  readonly name: string;
  readonly position: number;
  /** The used range, e.g. `A1:D5`. */
  readonly dimensions: string;
  readonly rows: number;
  readonly columns: number;
  readonly cells: readonly ReadingCell[];
  /** CSV only: each column's name and type. */
  readonly columnTypes?: readonly ReadingColumn[];
  /** The text as a Markdown table. */
  readonly text: string;
}

/** A table found in a document, and where it is. */
export interface ReadingTable {
  readonly name: string;
  /** The unit it sits in, as a marker would cite it: `s. 2`, `sheet: Prices`. */
  readonly location: string;
  readonly rows: number;
  readonly columns: number;
  /** The cell text, when the reader has it. */
  readonly cells?: readonly (readonly string[])[];
}

/** An email attachment, saved to the file store when the reader was given one. */
export interface ReadingAttachment {
  readonly fileId: string | null;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
}

export interface DocumentReading {
  readonly kind: DocumentKind;
  readonly pages?: readonly ReadingPage[];
  readonly sections?: readonly ReadingSection[];
  readonly sheets?: readonly ReadingSheet[];
  readonly tables: readonly ReadingTable[];
  readonly attachments?: readonly ReadingAttachment[];
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  /** False when any page has no text layer; true for every format that is text by nature. */
  readonly hasTextLayer: boolean;
}

/** The most V8 heap one PDF read's worker thread may use. */
export const MAX_PDF_MEMORY_MB = 256;

/** The most PDF reads that run at once in a process; more wait their turn. */
export const MAX_CONCURRENT_PDF_READS = 2;

/** The limits every reader keeps. The issue fixes the defaults; a host may only lower them. */
export interface ReadingLimits {
  readonly maxBytes: number;
  readonly maxPages: number;
  /** Per file, for the whole read. A PDF's worker thread is terminated when it runs out. */
  readonly timeoutMs: number;
  /** The heap a PDF read's worker thread may use; past it the thread ends and the read is refused. */
  readonly pdfMemoryMb: number;
  /** How many PDF reads may run at once; a read waits while that many are running. */
  readonly pdfConcurrentReads: number;
}

export const DEFAULT_READING_LIMITS: ReadingLimits = {
  maxBytes: 50 * 1024 * 1024,
  maxPages: 500,
  timeoutMs: 30_000,
  pdfMemoryMb: MAX_PDF_MEMORY_MB,
  pdfConcurrentReads: MAX_CONCURRENT_PDF_READS,
};

/** A host's limits, each at most its default: a host may lower a limit, never raise it. */
export function lowerReadingLimits(given: Partial<ReadingLimits> = {}): ReadingLimits {
  const lower = (key: keyof ReadingLimits) =>
    Math.min(given[key] ?? Infinity, DEFAULT_READING_LIMITS[key]);
  return {
    maxBytes: lower("maxBytes"),
    maxPages: lower("maxPages"),
    timeoutMs: lower("timeoutMs"),
    pdfMemoryMb: lower("pdfMemoryMb"),
    pdfConcurrentReads: lower("pdfConcurrentReads"),
  };
}

export const READING_ERROR_CODES = [
  "invalid-request",
  "no-files",
  "no-lease",
  "not-found",
  "ungranted-input",
  "unsupported-format",
  "too-large",
  "too-many-pages",
  "timeout",
  "malformed",
  "store-error",
  // Extraction's model refusals (`extract.ts`).
  "model-unavailable",
  "model-not-vision",
  "model-timeout",
  "model-error",
  "model-invalid-answer",
] as const;

export type ReadingErrorCode = (typeof READING_ERROR_CODES)[number];

/**
 * A reader's refusal. The message says what is wrong and what to do; it never quotes document
 * content. Office refusals keep the Paper Office service's own code (e.g. `archive-invalid`).
 */
export class ReadingError extends Error {
  constructor(
    readonly code: ReadingErrorCode | (string & {}),
    message: string,
  ) {
    super(message);
    this.name = "ReadingError";
  }
}

/** Refuses a file over the size limit before any parser sees it. */
export function checkSize(size: number, limits: ReadingLimits, name: string): void {
  if (size > limits.maxBytes) {
    throw new ReadingError(
      "too-large",
      `${name} is ${megabytes(size)}, over the ${megabytes(limits.maxBytes)} a document may be. ` +
        "Ask for a smaller file, or split it.",
    );
  }
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The refusal for a read that ran out of time. */
export function timeoutError(name: string, limits: Pick<ReadingLimits, "timeoutMs">): ReadingError {
  return new ReadingError(
    "timeout",
    `reading ${name} took longer than ${limits.timeoutMs / 1000} s, the limit per file. ` +
      "The file may be damaged or unusually complex.",
  );
}

/**
 * Runs one read under the per-file time limit. CSV and email are parsed in process and cannot be
 * stopped midway, so for them the limit stops the *wait*: the call refuses on time and the late
 * answer is dropped. A PDF is parsed in a worker thread, which its own limit terminates (`pdf.ts`).
 */
export async function withinTime<T>(
  work: () => Promise<T>,
  limits: Pick<ReadingLimits, "timeoutMs">,
  name: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(name, limits)), limits.timeoutMs);
  });
  try {
    return await Promise.race([work(), expired]);
  } finally {
    clearTimeout(timer);
  }
}
