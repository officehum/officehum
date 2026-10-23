/**
 * The three Office formats Paper Office owns, and the exact library pins their worker verifies.
 *
 * Paper's forks install the upstream module names (`docx`, `pptx`, `openpyxl`) and ship a sentinel
 * module each (`paper_docx_doctor`, `paper_pptx_doctor`, `paper_xlsx_doctor`) whose `verify_install`
 * refuses a fork that does not own the installed module. The pins here are the versions the receipt
 * records; the sentinel is what proves the running interpreter really is the fork.
 */

export const DOCUMENT_FORMATS = ["docx", "pptx", "xlsx"] as const;

export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/** The pinned distribution for each format, exactly as the design and the issue name them. */
export const PAPER_LIBRARY: Readonly<Record<DocumentFormat, string>> = {
  docx: "paper-docx",
  pptx: "paper-pptx",
  xlsx: "paper-xlsx",
};

export const PAPER_LIBRARY_PINS: Readonly<Record<string, string>> = {
  "paper-docx": "0.2.0",
  "paper-pptx": "0.2.0",
  "paper-xlsx": "0.2.1",
};

/**
 * The sentinel module that must import and answer `verify_install()` before any submitted code runs.
 * A module that raises `DoctorError` means the upstream package is installed beside the fork, which
 * is the one state the worker must never execute in.
 */
export const PAPER_DOCTOR: Readonly<Record<DocumentFormat, string>> = {
  docx: "paper_docx_doctor",
  pptx: "paper_pptx_doctor",
  xlsx: "paper_xlsx_doctor",
};

/** The upstream module name each fork provides, as it appears in the receipt's module versions. */
export const PAPER_MODULE: Readonly<Record<DocumentFormat, string>> = {
  docx: "docx",
  pptx: "pptx",
  xlsx: "openpyxl",
};

export const FORMAT_MIME: Readonly<Record<DocumentFormat, string>> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const DOCUMENT_EXTENSIONS: Readonly<Record<DocumentFormat, string>> = {
  docx: ".docx",
  pptx: ".pptx",
  xlsx: ".xlsx",
};

export function isDocumentFormat(value: unknown): value is DocumentFormat {
  return typeof value === "string" && (DOCUMENT_FORMATS as readonly string[]).includes(value);
}

export function assertDocumentFormat(value: unknown): asserts value is DocumentFormat {
  if (!isDocumentFormat(value)) {
    throw new Error(`Unsupported document format ${JSON.stringify(value)}`);
  }
}

/** The format a file name declares, from its extension. `undefined` when it is not an Office file. */
export function formatFromName(name: string): DocumentFormat | undefined {
  const lower = name.toLowerCase();
  return DOCUMENT_FORMATS.find((format) => lower.endsWith(DOCUMENT_EXTENSIONS[format]));
}

export function mimeTypeFor(format: DocumentFormat): string {
  return FORMAT_MIME[format];
}
