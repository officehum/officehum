/**
 * @officehum/tools-documents — the portable document reading pack.
 *
 * Agents read the documents a business runs on (vendor bills, contracts, price lists, forwarded
 * emails) as text and tables, with page, section and sheet references they can cite. PDF, CSV and
 * email are read in process; Word and Excel through the Paper Office worker with the task's lease.
 * Bills, receipts and invoices (PDF, JPEG, PNG) are read by OCR where they have no text, and their
 * fields are extracted by the host's model and checked by code.
 *
 * It depends on Pi Durable and pi-ai (peers), the SDK and `@officehum/tools-paper-office`, never on
 * a host, so the same pack runs in a bare Pi Durable harness. See README.md.
 */

export {
  type CheckInput,
  checkExtraction,
  type ExtractionCheck,
  textHasAmount,
  toCents,
} from "./checks.js";
export { columnLetters, decodeText, detectDelimiter, markdownTable, parseCsv } from "./csv.js";
export {
  type AttachmentSink,
  type StoreAttachmentsOptions,
  storeAttachments,
} from "./email.js";
export {
  EXTRACTION_KINDS,
  type ExtractedLineItem,
  type ExtractedTaxLine,
  type Extraction,
  type ExtractionKind,
  type ExtractionModel,
  extractDocument,
  MODEL_TIMEOUT_MS,
  modelTimeout,
  type Sourced,
  type ValueSource,
} from "./extract.js";
export { htmlToText } from "./html.js";
export { type OcrLine, type OcrPage, ocrImages, TESSDATA_DIR } from "./ocr.js";
export { OFFICE_READER_CODE, type ReadOfficeOptions, readOfficeDocument } from "./office.js";
export { type ReadDocumentOptions, readDocument } from "./read-document.js";
export {
  type CellType,
  type ColumnType,
  checkSize,
  DEFAULT_READING_LIMITS,
  DOCUMENT_KINDS,
  DOCUMENT_MIME,
  type DocumentKind,
  type DocumentReading,
  documentKindOf,
  lowerReadingLimits,
  MAX_CONCURRENT_PDF_READS,
  MAX_PDF_MEMORY_MB,
  READING_ERROR_CODES,
  type ReadingAttachment,
  type ReadingCell,
  type ReadingColumn,
  ReadingError,
  type ReadingErrorCode,
  type ReadingLimits,
  type ReadingPage,
  type ReadingSection,
  type ReadingSheet,
  type ReadingTable,
} from "./reading.js";
export {
  DEFAULT_MAX_CHARS,
  type DocumentUnit,
  documentUnits,
  MAX_MAX_CHARS,
  parsePages,
  type RenderedRead,
  type RenderReadOptions,
  renderOutline,
  renderRead,
  type SearchMatch,
  searchDocument,
} from "./render.js";
export {
  hasPagesWithoutText,
  MAX_SCAN_PAGES,
  SCAN_FORMATS,
  type ScanFile,
  type ScanFormat,
  type ScanLine,
  type ScannedDocument,
  type ScannedPage,
  type ScanOptions,
  scanDocument,
  scanFormatOf,
} from "./scan.js";
export {
  DOCUMENT_EXTRACT,
  DOCUMENT_OUTLINE,
  DOCUMENT_READ,
  DOCUMENT_SEARCH,
  DOCUMENTS_PACK_ID,
  type DocumentReadingPack,
  type DocumentReadingPackOptions,
  documentReadingPack,
  type ReadableFiles,
} from "./tools.js";
