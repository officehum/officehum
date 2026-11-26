/**
 * The words a memory record is made of, shared by `@officehum/memory` (which stores records) and the
 * eval format (which seeds and checks them): kinds, categories, statuses, the subject pattern and the
 * four tool names. One list, so a seeded record and a saved one can never disagree on a name. See
 * "Memory: what agents learn on the job" in docs/design/agent-package.md.
 */

/**
 * Who or what a record is about: `business`, `customer:<system>:<id>`, `vendor:<system>:<id>`,
 * `person:<id>`, `agent:<role>` or `topic:<slug>`. Records are stored one document per subject.
 */
export const SUBJECT_PATTERN =
  "^(?:business|(?:customer|vendor):[A-Za-z0-9._-]+:[A-Za-z0-9._-]+|person:[A-Za-z0-9._-]+|agent:[a-z0-9]+(?:-[a-z0-9]+)*|topic:[a-z0-9]+(?:-[a-z0-9]+)*)$";

export const KINDS = ["fact", "preference", "rule", "procedure"] as const;
export type Kind = (typeof KINDS)[number];

/** Categories only a person may set: payment and bank details, and who may authorize what. */
export const PROTECTED_CATEGORIES = ["payment_details", "authority"] as const;
export const CATEGORIES = [
  "general",
  "contact",
  "schedule",
  "payment_terms",
  ...PROTECTED_CATEGORIES,
] as const;
export type Category = (typeof CATEGORIES)[number];

export const STATUSES = ["active", "unverified", "proposed", "superseded", "retired"] as const;
export type Status = (typeof STATUSES)[number];

/** Where a record's content came from, as the host's code decided it. */
export const SOURCE_TYPES = ["person", "conversation", "document", "external"] as const;

/** The memory extension's tools, which an eval with memory runs for real rather than stubbing. */
export const MEMORY_TOOL_NAMES = [
  "memory_save",
  "memory_recall",
  "memory_forget",
  "memory_focus",
] as const;
