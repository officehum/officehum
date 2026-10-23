/**
 * @officehum/tools-paper-office — the portable Paper Office document pack.
 *
 * It gives a Pi Durable task a **task-leased Python 3.13 document workspace**: a `DocumentService` a
 * host injects, an isolated worker pinned to `paper-docx`, `paper-pptx` and `paper-xlsx`, and the
 * `run_document_python` tool. A tool call reaches only what its lease grants — immutable input version
 * IDs with their hashes, and the output formats it may produce — and every call binds a stable
 * operation ID, the code and argument hashes, the source hashes, the policy version and the library
 * versions into one receipt. A replayed call returns the same receipt; a refusal or a timeout leaves
 * the sources untouched; a committed output is immutable.
 *
 * It depends on Pi Durable, pi-ai and `@officehum/sdk` (for the FileStore contract), never on
 * `@officehum/office`, so the same pack runs in a bare harness with a fake service.
 *
 * See docs/superpowers/specs/2026-10-14-paper-instruments-integration-design.md, and README.md for
 * what is enforced in process and what still needs the container profile (RASF-3111).
 */

export {
  type DocumentRunCommitted,
  type DocumentRunOutcome,
  type DocumentRunRefused,
  type DocumentRunRequest,
  type DocumentService,
  isCommitted,
  isRefused,
} from "./document-service.js";
export {
  DOCUMENT_REFUSAL_CODES,
  DocumentError,
  type DocumentRefusalCode,
  isDocumentRefusalCode,
  refusal,
  refusalCodeFromWorker,
} from "./errors.js";
export {
  assertDocumentFormat,
  DOCUMENT_EXTENSIONS,
  DOCUMENT_FORMATS,
  type DocumentFormat,
  FORMAT_MIME,
  formatFromName,
  isDocumentFormat,
  mimeTypeFor,
  PAPER_DOCTOR,
  PAPER_LIBRARY,
  PAPER_LIBRARY_PINS,
  PAPER_MODULE,
} from "./formats.js";
export {
  DEFAULT_LIMITS,
  type DocumentLease,
  findLeasedInput,
  isLeaseExpired,
  type LeasedInput,
  MAX_LEASED_INPUTS,
  permitsFormat,
  type ResourceLimits,
  validateLease,
  validateLimits,
} from "./lease.js";
export {
  type LocalDocumentServiceOptions,
  localDocumentService,
} from "./local-document-service.js";
export { inspectOfficePackage, type PackageInspection } from "./ooxml.js";
export {
  codeSha256,
  intentForRun,
  intentSha256,
  type OperationIntent,
  operationIdForCall,
  outputOperationId,
  POLICY_VERSION,
  validateWorkerIdentity,
  type WorkerIdentity,
  workerImage,
} from "./operation.js";
export {
  type DeclaredOutput,
  defaultWorkerScript,
  PAPER_INTERPRETER_VARIABLE,
  type PaperWorker,
  type PaperWorkerEvidence,
  type PaperWorkerInput,
  type PaperWorkerOutcome,
  type PaperWorkerRequest,
  resolvePaperInterpreter,
  type SubprocessPaperWorkerOptions,
  subprocessPaperWorker,
  workerEnvironment,
} from "./paper-worker.js";
export {
  type LeaseLookup,
  PAPER_OFFICE_PACK_ID,
  type PaperOfficeToolPack,
  type PaperOfficeToolPackOptions,
  paperOfficeToolPack,
  RUN_DOCUMENT_PYTHON,
} from "./run-document-python.js";
export {
  type DocumentRunReceipt,
  type LineageEntry,
  type PlannedOutput,
  type RunLedger,
  type RunPlan,
  type RunRecord,
  runLedger,
} from "./run-ledger.js";
export {
  assertWordBlock,
  assertWordFileRef,
  assertWordStep,
  COMPARE_DOCUMENT,
  CREATE_DOCUMENT,
  DEFAULT_WORD_PAGE,
  EDIT_DOCUMENT,
  INSPECT_DOCUMENT,
  isWordInput,
  MAX_WORD_BLOCKS,
  MAX_WORD_PAGE,
  MAX_WORD_STEPS,
  PREVIEW_DOCUMENT,
  parseWordResult,
  READ_DOCUMENT,
  resolveWordOutput,
  resolveWordRef,
  STEP_OPTIONAL,
  STEP_REQUIRED,
  WORD_FORMAT,
  WORD_OPERATIONS,
  WORD_READ_SECTIONS,
  WORD_TOOL_NAMES,
  type WordAddCommentStep,
  type WordAnchor,
  type WordBlockAnchor,
  type WordBlockItem,
  type WordChangeRecord,
  type WordChangeSet,
  type WordCommentItem,
  type WordComparison,
  type WordCounts,
  type WordCreateBlock,
  type WordDeleteCommentStep,
  type WordDeleteParagraphsStep,
  type WordDeleteRowStep,
  type WordDiff,
  type WordDraft,
  type WordEdit,
  type WordEditStep,
  type WordFileRef,
  type WordInsertRowStep,
  type WordInsertSectionStep,
  type WordInspectDocument,
  type WordInspection,
  type WordItem,
  type WordOperation,
  type WordPage,
  type WordPartChange,
  type WordPreview,
  type WordPreviewItem,
  type WordProgram,
  type WordProposal,
  type WordProtection,
  type WordReading,
  type WordReadSection,
  type WordRedline,
  type WordRedlineEntry,
  type WordReplaceParagraphsStep,
  type WordReplaceTextStep,
  type WordReplyCommentStep,
  type WordResolveCommentStep,
  type WordResult,
  type WordRevisionItem,
  type WordRevisionStep,
  type WordSourceEvidence,
  type WordTableShape,
  type WordUpdateCellStep,
  wordInstruction,
  wordProgram,
  wordResultRef,
} from "./word-operations.js";
export {
  WORD_TOOL_REGISTRATIONS,
  type WordToolOptions,
  wordTools,
} from "./word-tools.js";
