/**
 * Where memory lives: Pi Durable's own documents, committed atomically with the transcript, so the
 * extension needs no database of its own and a bare harness keeps it across restarts.
 *
 * - `officehum.memory`: a session-scoped family, one document per subject, holding that subject's
 *   records that are not superseded (at most `MAX_RECORDS`). Session scope is what keeps memory when
 *   a conversation is rewound or forked: it is not part of any conversation's history.
 * - `officehum.memory.archive`: the same family shape for superseded records, which move out of the
 *   subject's document in the commit that supersedes them.
 * - `officehum.memory.index`: a session singleton with each subject's record count and last update,
 *   and the pinned record ids the prompt section shows business-wide.
 * - `officehum.memory.focus`: a latest-only conversation document with the subjects the conversation
 *   is about; a fork starts with its parent's focus.
 *
 * Reads outside a commit go through a `DocumentReader` (a tool's `api` or a section's `input.read`)
 * and treat an absent document as empty. Writes are functions of a commit's `tx`.
 */

import {
  type DocumentReader,
  defineDoc,
  defineDocFamily,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { type MemoryRecord, PROTECTED_CATEGORIES } from "./record.js";

type Context = Parameters<ToolExecutionApi["commit"]>[1];

/** The most records one subject keeps that are not superseded. */
export const MAX_RECORDS = 200;

type Records = { records: MemoryRecord[] };

export const MemoryDoc = defineDocFamily<Records, null>({
  kind: "officehum.memory",
  version: 1,
  checkpointWhen: () => false,
  scope: "session",
  family: true,
  initial: () => ({ records: [] }),
});

export const ArchiveDoc = defineDocFamily<Records, null>({
  kind: "officehum.memory.archive",
  version: 1,
  checkpointWhen: () => false,
  scope: "session",
  family: true,
  initial: () => ({ records: [] }),
});

export type MemoryIndex = {
  subjects: Record<string, { count: number; updatedAt: string }>;
  pinned: string[];
};

export const IndexDoc = defineDoc<MemoryIndex>({
  kind: "officehum.memory.index",
  version: 1,
  checkpointWhen: () => false,
  scope: "session",
  initial: () => ({ subjects: {}, pinned: [] }),
});

export const FocusDoc = defineDoc<{ subjects: string[] }>({
  kind: "officehum.memory.focus",
  version: 1,
  checkpointWhen: () => false,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ subjects: [] }),
});

/** A subject's current (not superseded) records, oldest first. */
export async function readRecords(
  read: DocumentReader,
  about: string,
  context: Context,
): Promise<readonly MemoryRecord[]> {
  return (await read.snapshot(MemoryDoc, about, context))?.records ?? [];
}

export async function readIndex(read: DocumentReader, context: Context): Promise<MemoryIndex> {
  return (await read.snapshot(IndexDoc, context)) ?? { subjects: {}, pinned: [] };
}

export async function readFocus(
  read: DocumentReader,
  conversationId: Parameters<Tx["conversation"]>[0],
  context: Context,
): Promise<readonly string[]> {
  return (await read.snapshot(FocusDoc, conversationId, context))?.subjects ?? [];
}

export type SaveOutcome =
  | {
      readonly kind: "saved" | "existing";
      readonly record: MemoryRecord;
      /**
       * True when the record names a confirmed record it will replace only once a person approves
       * it: the confirmed record stays current until then.
       */
      readonly pending?: true;
    }
  | { readonly kind: "refused"; readonly message: string };

/** Which records a write may touch: those the caller can see. Omitted: every record. */
export type Visible = (record: MemoryRecord) => boolean;

const everyRecord: Visible = () => true;

/** Who is writing, beyond what they may see. */
export interface WriteAuthority {
  /**
   * True only on an owner's own path: the host's protected form, or an owner deciding a record.
   * Then a protected-category record (`payment_details`, `authority`) may be written, superseded,
   * retired or confirmed. Omitted, as on every agent tool: each is refused.
   */
  readonly owner?: boolean;
}

/** Whether a category is one only an owner sets. */
export function isProtectedCategory(category: string): boolean {
  return (PROTECTED_CATEGORIES as readonly string[]).includes(category);
}

/** The refusal for a protected category written by anyone but an owner. */
function ownerOnlyMessage(category: string): string {
  return `${category} is set only by an owner, in the protected form, never by an agent's save.`;
}

/** The refusal for changing a protected record someone else set. */
function protectedRecordMessage(record: MemoryRecord): string {
  return `${record.id} is ${record.category}, which only an owner can change, in the protected form.`;
}

/**
 * Adds `record` to its subject in one commit. A record with the same id already there is returned
 * as it is, so a replayed save writes once. Superseding marks the old record `superseded` and moves
 * it to the archive in the same commit; only a record `visible` allows can be superseded. An active
 * record is superseded at once only by a record stored active; a proposed record that names it waits
 * for approval (`confirmRecord`), and an unverified one is refused. A protected-category record is
 * written, or superseded, only on an owner's path (`authority.owner`). Pinned: business records that
 * are active or unverified. Everything is checked before anything changes, so a refusal commits
 * nothing.
 */
export async function saveRecord(
  tx: Tx,
  record: MemoryRecord,
  visible: Visible = everyRecord,
  authority: WriteAuthority = {},
): Promise<SaveOutcome> {
  const doc = await tx.doc(MemoryDoc, record.about, null);
  const existing = doc.records.find((candidate) => candidate.id === record.id);
  if (existing !== undefined) {
    // A replay says what holds now: a proposal still waiting on the confirmed record it names.
    const waiting =
      existing.status === "proposed" &&
      doc.records.some(
        (candidate) => candidate.id === existing.supersedes && candidate.status === "active",
      );
    return waiting
      ? { kind: "existing", record: plain(existing), pending: true }
      : { kind: "existing", record: plain(existing) };
  }

  if (authority.owner !== true && isProtectedCategory(record.category)) {
    return { kind: "refused", message: ownerOnlyMessage(record.category) };
  }
  const replaced =
    record.supersedes === undefined
      ? -1
      : doc.records.findIndex(
          (candidate) => candidate.id === record.supersedes && visible(plain(candidate)),
        );
  if (record.supersedes !== undefined && replaced === -1) {
    return {
      kind: "refused",
      message: `${record.supersedes} is not a current record about ${record.about}, so it cannot be superseded. Recall the subject to find the record to correct.`,
    };
  }
  // Nothing unapproved ever hides a confirmed record. An unverified claim cannot replace
  // one at all. A proposed record may name it, but the replacement waits: the confirmed record keeps
  // applying until a person approves the proposal, which `confirmRecord` swaps in one write.
  const target = replaced === -1 ? undefined : doc.records[replaced];
  if (target !== undefined && authority.owner !== true && isProtectedCategory(target.category)) {
    return { kind: "refused", message: protectedRecordMessage(target) };
  }
  if (target?.status === "active" && record.status === "unverified") {
    return {
      kind: "refused",
      message: `${target.id} is confirmed, and this record would be ${record.status}, so it cannot replace it; a person must correct or confirm the record. Save it without supersedes to keep it as an unconfirmed note beside the confirmed one.`,
    };
  }
  const pending = target?.status === "active" && record.status === "proposed";
  const superseding = replaced !== -1 && !pending;
  if (doc.records.length - (superseding ? 1 : 0) >= MAX_RECORDS) {
    return {
      kind: "refused",
      message: `${record.about} already holds ${MAX_RECORDS} records. Supersede an outdated one, or forget one that no longer matters, before saving another.`,
    };
  }

  const index = await tx.doc(IndexDoc);
  if (superseding) await archive(tx, doc, replaced, index);
  doc.records.push(record);
  index.subjects[record.about] = { count: doc.records.length, updatedAt: record.createdAt };
  if (
    record.about === "business" &&
    (record.status === "active" || record.status === "unverified")
  ) {
    index.pinned.push(record.id);
  }
  return pending ? { kind: "saved", record, pending: true } : { kind: "saved", record };
}

/** Moves the record at `at` to its subject's archive as `superseded`, and unpins it. */
async function archive(
  tx: Tx,
  doc: { records: MemoryRecord[] },
  at: number,
  index: MemoryIndex,
): Promise<void> {
  const [old] = doc.records.splice(at, 1);
  if (old === undefined) return;
  (await tx.doc(ArchiveDoc, old.about, null)).records.push({ ...plain(old), status: "superseded" });
  unpin(index, old.id);
  index.subjects[old.about] = {
    count: doc.records.length,
    updatedAt: index.subjects[old.about]?.updatedAt ?? old.createdAt,
  };
}

export type RetireOutcome =
  | { readonly kind: "retired" | "already"; readonly record: MemoryRecord }
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Marks a record `retired` with the reason; it stays stored. Retiring twice changes nothing. A record
 * `visible` does not allow is missing, as one that does not exist is. A protected-category record is
 * retired only on an owner's path (`authority.owner`).
 */
export async function retireRecord(
  tx: Tx,
  id: string,
  reason: string,
  at: string,
  visible: Visible = everyRecord,
  authority: WriteAuthority = {},
): Promise<RetireOutcome> {
  const found = await locate(tx, id, visible);
  if (found === undefined) return { kind: "missing" };
  const { record, index } = found;
  if (record.status === "retired") return { kind: "already", record: plain(record) };
  if (authority.owner !== true && isProtectedCategory(record.category)) {
    return { kind: "refused", message: protectedRecordMessage(record) };
  }
  record.status = "retired";
  record.retiredReason = reason;
  unpin(index, id);
  touch(index, record.about, at);
  return { kind: "retired", record: plain(record) };
}

export type ConfirmOutcome =
  | { readonly kind: "confirmed" | "already"; readonly record: MemoryRecord }
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly message: string };

/**
 * A person confirms an unverified claim or a proposed rule or procedure: it becomes `active`, with
 * who confirmed it and when. Confirming an active record changes nothing. A confirmed rule or
 * procedure is still only information in the prompt; it becomes an instruction when a person promotes
 * it into an agent's overlay (an Office Hum host's step). A retired or superseded record is history,
 * so it is refused. Confirming a protected-category record, or a proposal that would replace one,
 * takes an owner's path (`authority.owner`).
 */
export async function confirmRecord(
  tx: Tx,
  id: string,
  by: string,
  at: string,
  visible: Visible = everyRecord,
  authority: WriteAuthority = {},
): Promise<ConfirmOutcome> {
  const found = await locate(tx, id, visible);
  if (found === undefined) return { kind: "missing" };
  const { record, index, doc } = found;
  if (record.status === "active") return { kind: "already", record: plain(record) };
  if (record.status !== "unverified" && record.status !== "proposed") {
    return {
      kind: "refused",
      message: `${id} is ${record.status}, so there is nothing to confirm.`,
    };
  }
  // A proposal's pending replacement takes effect on confirming: the record it names, if still
  // current, becomes `superseded`.
  const replaced =
    record.supersedes === undefined
      ? -1
      : doc.records.findIndex(
          (candidate) => candidate.id === record.supersedes && candidate.status !== "retired",
        );
  const target = replaced === -1 ? undefined : doc.records[replaced];
  if (authority.owner !== true) {
    if (isProtectedCategory(record.category)) {
      return { kind: "refused", message: protectedRecordMessage(record) };
    }
    if (target !== undefined && isProtectedCategory(target.category)) {
      return {
        kind: "refused",
        message: `Confirming ${id} would replace ${target.id}, which is ${target.category}; only an owner can change that, in the protected form.`,
      };
    }
  }
  record.status = "active";
  record.confirmedBy = by;
  record.confirmedAt = at;
  if (replaced !== -1) await archive(tx, doc, replaced, index);
  if (record.about === "business" && !index.pinned.includes(id)) index.pinned.push(id);
  touch(index, record.about, at);
  return { kind: "confirmed", record: plain(record) };
}

export type ReviewDateOutcome =
  | { readonly kind: "set" | "already"; readonly record: MemoryRecord }
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly message: string };

/**
 * A person sets (or, with `null`, clears) when a record should be checked again. The
 * change is kept on the record (`reviewDates`), so its history shows who moved the date and when;
 * setting the date it already has changes nothing, so a repeated request writes once. A date in the
 * past is allowed: it marks the record due. A retired or superseded record is history, so it is
 * refused; a record `visible` does not allow is missing. The caller checks the date's form.
 */
export async function setReviewDate(
  tx: Tx,
  id: string,
  reviewAt: string | null,
  by: string,
  at: string,
  visible: Visible = everyRecord,
): Promise<ReviewDateOutcome> {
  const found = await locate(tx, id, visible);
  if (found === undefined) return { kind: "missing" };
  const { record, index } = found;
  if (record.status === "retired" || record.status === "superseded") {
    return {
      kind: "refused",
      message: `${id} is ${record.status}, so it has no review date to set.`,
    };
  }
  if ((record.reviewAt ?? null) === reviewAt) return { kind: "already", record: plain(record) };
  if (reviewAt === null) delete record.reviewAt;
  else record.reviewAt = reviewAt;
  record.reviewDates = [...(record.reviewDates ?? []), { reviewAt, by, at }];
  touch(index, record.about, at);
  return { kind: "set", record: plain(record) };
}

/**
 * Every stored record, current and superseded, as a list a host can filter: the subjects the index
 * names, each subject's current records, then its archive.
 */
export async function readAllRecords(
  read: DocumentReader,
  context: Context,
): Promise<readonly MemoryRecord[]> {
  const records: MemoryRecord[] = [];
  for (const about of Object.keys((await readIndex(read, context)).subjects)) {
    records.push(...(await readRecords(read, about, context)));
    records.push(...((await read.snapshot(ArchiveDoc, about, context))?.records ?? []));
  }
  return records;
}

/** A current record by id, inside a commit, with the index it was found through. */
async function locate(
  tx: Tx,
  id: string,
  visible: Visible,
): Promise<
  | {
      readonly record: MemoryRecord;
      readonly index: MemoryIndex;
      readonly doc: { records: MemoryRecord[] };
    }
  | undefined
> {
  const index = await tx.doc(IndexDoc);
  for (const about of Object.keys(index.subjects)) {
    const doc = await tx.doc(MemoryDoc, about, null);
    const record = doc.records.find((candidate) => candidate.id === id);
    if (record === undefined) continue;
    return visible(plain(record)) ? { record, index, doc } : undefined;
  }
  return undefined;
}

function touch(index: MemoryIndex, about: string, at: string): void {
  const subject = index.subjects[about];
  if (subject !== undefined) subject.updatedAt = at;
}

/** Sets the subjects a conversation is about. */
export async function setFocus(
  tx: Tx,
  conversationId: Parameters<Tx["conversation"]>[0],
  subjects: readonly string[],
): Promise<void> {
  (await tx.doc(FocusDoc, conversationId)).subjects = [...new Set(subjects)];
}

/**
 * Adds subjects to a conversation's focus, keeping those already there: a host focusing a
 * conversation on its work does not undo what the agent focused on itself.
 */
export async function addFocus(
  tx: Tx,
  conversationId: Parameters<Tx["conversation"]>[0],
  subjects: readonly string[],
): Promise<void> {
  const focus = await tx.doc(FocusDoc, conversationId);
  for (const subject of subjects) {
    if (!focus.subjects.includes(subject)) focus.subjects.push(subject);
  }
}

function unpin(index: MemoryIndex, id: string): void {
  const at = index.pinned.indexOf(id);
  if (at !== -1) index.pinned.splice(at, 1);
}

/** A detached copy of a record read from a commit's draft. */
function plain(record: MemoryRecord): MemoryRecord {
  return JSON.parse(JSON.stringify(record)) as MemoryRecord;
}
