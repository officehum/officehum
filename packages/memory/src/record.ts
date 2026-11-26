/**
 * A memory record and the rules code applies to it. The model chooses the subject, kind, category
 * and text; code sets the id, scope, source, status and author, so nothing the model claims about
 * where a fact came from changes how far it is trusted (docs/design/agent-package.md, "Memory").
 */

import { createHash } from "node:crypto";
import { arr, nullable, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import {
  CATEGORIES,
  type Category,
  KINDS,
  type Kind,
  PROTECTED_CATEGORIES,
  SOURCE_TYPES,
  STATUSES,
  type Status,
  SUBJECT_PATTERN,
} from "@officehum/sdk";

/** The longest text one record holds: one fact, not a document. */
export const MAX_TEXT = 500;

// The vocabulary is the SDK's, so the eval format checks a seeded record with the same words.
export {
  CATEGORIES,
  type Category,
  KINDS,
  type Kind,
  PROTECTED_CATEGORIES,
  STATUSES,
  type Status,
  SUBJECT_PATTERN,
};

export const SubjectSchema = str({
  pattern: SUBJECT_PATTERN,
  description:
    "Who or what it is about: business, customer:<system>:<id>, vendor:<system>:<id>, person:<id>, agent:<role> or topic:<slug>. The id is the whole id the connected system gives, unchanged: customer-42 is customer:quickbooks:customer-42",
});

/**
 * A subject as records are filed under it: a customer's or vendor's system in lower case, so
 * `customer:QuickBooks:42` and `customer:quickbooks:42` are one subject. The id after it is the
 * connected system's own and is kept as given; every other subject is unchanged.
 */
export function normalSubject(about: string): string {
  const match = /^(customer|vendor):([^:]+):(.+)$/.exec(about);
  if (match === null) return about;
  const [, kind, system, id] = match;
  return `${kind}:${(system ?? "").toLowerCase()}:${id}`;
}

export const MemorySourceSchema = obj(
  {
    type: oneOf([...SOURCE_TYPES]),
    /** What it came from, e.g. a person's id, a conversation id or a message id. */
    ref: str(),
    /** Who passed it on, when that is not `ref`. */
    by: opt(str()),
  },
  { open: true },
);
export type MemorySource = Static<typeof MemorySourceSchema>;

export const MemoryRecordSchema = obj(
  {
    /** `mem_` plus 26 characters derived from the saving conversation and tool call. */
    id: str(),
    about: str(),
    kind: oneOf([...KINDS]),
    category: oneOf([...CATEGORIES]),
    text: str({ maxLength: MAX_TEXT }),
    /** `office`, `department:<id>` or `agent:<role>`. */
    scope: str(),
    source: MemorySourceSchema,
    status: oneOf([...STATUSES]),
    /** The id of the record this one corrects. */
    supersedes: opt(str()),
    createdAt: str(),
    /** The agent that saved it, `agent:<role>`. */
    createdBy: str(),
    /** When a temporary fact should be checked again, as YYYY-MM-DD. */
    reviewAt: opt(str()),
    /**
     * Each review date a person set or cleared after the record was saved, oldest first:
     * the date (`null` for cleared), who set it and when.
     */
    reviewDates: opt(arr(obj({ reviewAt: nullable(str()), by: str(), at: str() }))),
    confirmedBy: opt(str()),
    /** When a person confirmed it (ISO 8601), set with `confirmedBy`. */
    confirmedAt: opt(str()),
    /** Why it was retired, from `memory_forget`. */
    retiredReason: opt(str()),
  },
  { open: true },
);
export type MemoryRecord = Static<typeof MemoryRecordSchema>;

/**
 * The status a new record gets, and why: outside content stays unverified until a person confirms
 * it; a rule or procedure changes how an agent behaves, so it is only proposed until approved.
 */
export function statusFor(
  kind: Kind,
  source: MemorySource,
): { readonly status: Status; readonly reason: string } {
  if (source.type === "external") {
    return {
      status: "unverified",
      reason: "it came from an outside source, so it stays unconfirmed until a person confirms it",
    };
  }
  if (kind === "rule" || kind === "procedure") {
    return {
      status: "proposed",
      reason: `a ${kind} changes how agents work, so it applies only once a person has approved it`,
    };
  }
  return { status: "active", reason: "it came from inside the business" };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The record id for a save: `mem_` and 26 Crockford base32 characters (ULID's alphabet and length)
 * of a hash of the conversation and tool call. Not time-ordered like a ULID; deterministic, so a
 * replayed `memory_save` finds the record it already wrote instead of writing a second one.
 */
export function recordId(conversationId: string, callId: string): string {
  const hash = createHash("sha256").update(`${conversationId}\u0000${callId}`).digest();
  let bits = 0;
  let value = 0;
  let id = "";
  for (const byte of hash) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && id.length < 26) {
      bits -= 5;
      id += CROCKFORD[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
    if (id.length === 26) break;
  }
  return `mem_${id}`;
}
