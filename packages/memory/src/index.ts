/**
 * @officehum/memory — a portable Pi Durable extension that lets an agent save, recall and retire
 * what it learns, stored in Pi Durable's own documents, with its guardrails in code. It works in a
 * bare Pi Durable harness; Office Hum layers search, visibility and review on top.
 *
 * See "Memory: what agents learn on the job" in docs/design/agent-package.md.
 */

export {
  MEMORY_EXTENSION_NAME,
  MEMORY_HYGIENE_SKILL,
  type MemoryOptions,
  memoryExtension,
  type ReviewItem,
  type SavedInput,
  type SearchInput,
  type SourceInput,
} from "./extension.js";
export { recordLine } from "./format.js";
export {
  CATEGORIES,
  type Category,
  KINDS,
  type Kind,
  MAX_TEXT,
  type MemoryRecord,
  MemoryRecordSchema,
  type MemorySource,
  MemorySourceSchema,
  normalSubject,
  PROTECTED_CATEGORIES,
  recordId,
  STATUSES,
  type Status,
  SUBJECT_PATTERN,
  SubjectSchema,
  statusFor,
} from "./record.js";
export { type ScanResult, scanText } from "./scan.js";
export {
  BUSINESS_TOKENS,
  FOCUS_TOKENS,
  MEMORY_SECTION_KEY,
  type MemorySectionContent,
  memorySection,
  memorySectionContent,
} from "./section.js";
export {
  ArchiveDoc,
  addFocus,
  type ConfirmOutcome,
  confirmRecord,
  FocusDoc,
  IndexDoc,
  isProtectedCategory,
  MAX_RECORDS,
  MemoryDoc,
  type MemoryIndex,
  type RetireOutcome,
  type ReviewDateOutcome,
  readAllRecords,
  retireRecord,
  type SaveOutcome,
  saveRecord,
  setFocus,
  setReviewDate,
  type Visible,
  type WriteAuthority,
} from "./storage.js";
export { LOCAL_USER_SOURCE, memoryTools } from "./tools.js";
export { type MemoryView, type ViewInput, visibleIn } from "./view.js";
