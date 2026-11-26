/**
 * Scanning: a bill, a receipt or an invoice as numbered lines per page, each page saying where its
 * lines came from. A PDF page with a text layer keeps its own text; a page without one (a scan) is
 * rendered to PNG and read by OCR, as is a JPEG or PNG photo. The picture travels with its lines, so
 * a model that reads images can see what OCR read.
 *
 * HEIC is refused: the libraries that could convert it decode HEIC (HEVC) only with codecs left out
 * of their prebuilt binaries, so the honest answer is to ask for a JPEG.
 */

import { ocrImages } from "./ocr.js";
import { readPdf, renderPdfPages } from "./pdf.js";
import {
  checkSize,
  DEFAULT_READING_LIMITS,
  ReadingError,
  type ReadingLimits,
  withinTime,
} from "./reading.js";

export const SCAN_FORMATS = ["pdf", "jpeg", "png", "heic"] as const;

export type ScanFormat = (typeof SCAN_FORMATS)[number];

/** Bills, receipts and invoices are short; OCR takes about a second a page. */
export const MAX_SCAN_PAGES = 10;

const MIME: Readonly<Record<string, ScanFormat>> = {
  "application/pdf": "pdf",
  "application/x-pdf": "pdf",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/pjpeg": "jpeg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heic",
  "image/heic-sequence": "heic",
  "image/heif-sequence": "heic",
};

const EXTENSIONS: Readonly<Record<string, ScanFormat>> = {
  ".pdf": "pdf",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".png": "png",
  ".heic": "heic",
  ".heif": "heic",
};

/** The format a MIME type names, falling back to the file name's extension; `undefined` if neither. */
export function scanFormatOf(mimeType: string, name?: string): ScanFormat | undefined {
  const byMime = MIME[mimeType.split(";")[0]?.trim().toLowerCase() ?? ""];
  if (byMime !== undefined) return byMime;
  const lower = name?.toLowerCase() ?? "";
  const extension = Object.keys(EXTENSIONS).find((ending) => lower.endsWith(ending));
  return extension === undefined ? undefined : EXTENSIONS[extension];
}

export interface ScanFile {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  /** The file's name, for messages and as a fallback for its format. */
  readonly name?: string;
}

export interface ScanLine {
  /** From 1, within its page: what a citation `page, line` points at. */
  readonly number: number;
  readonly text: string;
  /** OCR's confidence in the line, 0 to 100; `null` for a line from a text layer. */
  readonly confidence: number | null;
}

export interface ScannedPage {
  readonly number: number;
  readonly source: "text-layer" | "ocr";
  readonly lines: readonly ScanLine[];
  /** OCR's mean confidence over the page; `null` for a text layer. */
  readonly confidence: number | null;
  /** The picture OCR read: the rendered page or the photo itself. Absent for a text layer. */
  readonly image?: { readonly data: Uint8Array; readonly mimeType: "image/png" | "image/jpeg" };
}

export interface ScannedDocument {
  readonly format: Exclude<ScanFormat, "heic">;
  readonly pages: readonly ScannedPage[];
}

export interface ScanOptions {
  /** Lower limits than the defaults; pages are also capped at `MAX_SCAN_PAGES`. */
  readonly limits?: Partial<ReadingLimits>;
}

function scanLimits(options: ScanOptions): ReadingLimits {
  const given: ReadingLimits = { ...DEFAULT_READING_LIMITS, ...options.limits };
  return { ...given, maxPages: Math.min(given.maxPages, MAX_SCAN_PAGES) };
}

/**
 * Whether scanning `file` needs OCR: a photo always does, a PDF when a page has no text layer. Cheap
 * (a PDF's text is read, nothing is rendered), so a caller can refuse before the slow part. A format
 * `scanDocument` refuses answers `false`, and `scanDocument` then says why.
 */
export async function hasPagesWithoutText(
  file: ScanFile,
  options: ScanOptions = {},
): Promise<boolean> {
  const format = scanFormatOf(file.mimeType, file.name);
  if (format === "jpeg" || format === "png") return true;
  if (format !== "pdf") return false;
  const name = file.name ?? "the document";
  const limits = scanLimits(options);
  checkSize(file.bytes.byteLength, limits, name);
  const reading = await withinTime(() => readPdf(file.bytes, name, limits), limits, name);
  return !reading.hasTextLayer;
}

export async function scanDocument(
  file: ScanFile,
  options: ScanOptions = {},
): Promise<ScannedDocument> {
  const name = file.name ?? "the document";
  const limits = scanLimits(options);
  const format = scanFormatOf(file.mimeType, file.name);
  if (format === "heic") {
    throw new ReadingError(
      "unsupported-format",
      `${name} is a HEIC photo, which this pack cannot read: HEIC needs a decoder the bundled ` +
        "image libraries do not include. Send it as a JPEG (on an iPhone, share it as JPEG or set " +
        "Camera, Formats to Most Compatible).",
    );
  }
  if (format === undefined) {
    throw new ReadingError(
      "unsupported-format",
      `${name} is ${file.mimeType}; extraction reads PDF files and JPEG or PNG pictures.`,
    );
  }
  checkSize(file.bytes.byteLength, limits, name);
  return withinTime(
    async () => (format === "pdf" ? scanPdf(file.bytes, name, limits) : scanImage(file, format)),
    limits,
    name,
  );
}

async function scanImage(file: ScanFile, format: "jpeg" | "png"): Promise<ScannedDocument> {
  const [page] = await ocrImages([file.bytes]);
  return {
    format,
    pages: [
      ocrPage(1, page?.lines ?? [], page?.confidence ?? 0, {
        data: file.bytes,
        mimeType: format === "png" ? "image/png" : "image/jpeg",
      }),
    ],
  };
}

async function scanPdf(
  bytes: Uint8Array,
  name: string,
  limits: ReadingLimits,
): Promise<ScannedDocument> {
  const reading = await readPdf(bytes, name, limits);
  const pages = reading.pages ?? [];
  const scanned = pages.filter((page) => !page.hasText).map((page) => page.number);
  const images = scanned.length === 0 ? [] : await renderPdfPages(bytes, name, scanned, limits);
  const read = images.length === 0 ? [] : await ocrImages(images);
  return {
    format: "pdf",
    pages: pages.map((page) => {
      const index = scanned.indexOf(page.number);
      if (index === -1) {
        const lines = page.text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
          .map((text, at) => ({ number: at + 1, text, confidence: null }));
        return { number: page.number, source: "text-layer", lines, confidence: null };
      }
      const ocr = read[index];
      return ocrPage(page.number, ocr?.lines ?? [], ocr?.confidence ?? 0, {
        data: images[index] ?? new Uint8Array(),
        mimeType: "image/png",
      });
    }),
  };
}

function ocrPage(
  number: number,
  lines: readonly { readonly text: string; readonly confidence: number }[],
  confidence: number,
  image: NonNullable<ScannedPage["image"]>,
): ScannedPage {
  return {
    number,
    source: "ocr",
    lines: lines.map((line, at) => ({ number: at + 1, ...line })),
    confidence,
    image,
  };
}
