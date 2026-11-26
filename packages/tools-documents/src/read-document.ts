/**
 * `readDocument(bytes, mimeType)`: PDF, CSV and email, read in process from bytes, under the size,
 * page and time limits. Word and Excel are not read from bytes: the Paper worker reads only leased,
 * immutable versions, so they go through `readOfficeDocument` with the task's lease.
 */

import { readCsv } from "./csv.js";
import { type AttachmentSink, readEmail } from "./email.js";
import { readPdf } from "./pdf.js";
import {
  checkSize,
  DEFAULT_READING_LIMITS,
  type DocumentReading,
  documentKindOf,
  ReadingError,
  type ReadingLimits,
  withinTime,
} from "./reading.js";

export interface ReadDocumentOptions {
  /** The file's name, for messages and as a CSV's sheet name. */
  readonly name?: string;
  /** A limit left out keeps its default. */
  readonly limits?: Partial<ReadingLimits>;
  /** Where an email's attachments go. Without one they are listed, not saved. */
  readonly attachments?: AttachmentSink;
}

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export async function readDocument(
  bytes: Uint8Array,
  mimeType: string,
  options: ReadDocumentOptions = {},
): Promise<DocumentReading> {
  const name = options.name ?? "the document";
  const limits: ReadingLimits = { ...DEFAULT_READING_LIMITS, ...options.limits };
  const kind = documentKindOf(mimeType, options.name);
  if (kind === "docx" || kind === "xlsx") {
    throw new ReadingError(
      "unsupported-format",
      `${name} is a Word or Excel file: those are read through the task's document lease with ` +
        "readOfficeDocument, not from bytes.",
    );
  }
  if (kind === undefined) {
    const pptx = mimeType === PPTX_MIME || options.name?.toLowerCase().endsWith(".pptx") === true;
    throw new ReadingError(
      "unsupported-format",
      pptx
        ? `${name} is a PowerPoint file, which this pack does not read.`
        : `${name} is ${mimeType}; this pack reads PDF, Word, Excel, CSV and email (.eml) files.`,
    );
  }
  checkSize(bytes.byteLength, limits, name);
  return withinTime(
    async () => {
      switch (kind) {
        case "pdf":
          return readPdf(bytes, name, limits);
        case "csv":
          return readCsv(bytes, options.name ?? "data.csv");
        case "eml":
          return readEmail(bytes, name, options.attachments);
      }
    },
    limits,
    name,
  );
}
