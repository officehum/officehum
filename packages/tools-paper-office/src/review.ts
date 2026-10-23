/**
 * The version-bound review and publication gate.
 *
 * The SDK's `VersionedFileStore.publish` already does the compare-and-swap: it moves the published
 * pointer only when the caller's `expectedPublishedVersionId` is the pointer it holds, a mismatch is
 * `VERSION_CONFLICT`, and replaying the same operation returns its receipt without a second move. It
 * deliberately does **not** verify approvals — its design doc says the host must verify that real
 * approval is bound to the file, the source version and the proposed version hashes.
 *
 * This module is that verification, and the review record behind it. A person reviews one proposal:
 *
 * - **One identity, one binding.** The review names the file, the immutable source version and hash,
 *   and the proposed version and hash, and seals them with the hash of the format-native diff and the
 *   hash of the deterministic validation. The `reviewId` *is* that binding, so an approval made for
 *   one proposal can never publish a different one — different bytes produce a different binding,
 *   a different review ID, and therefore no approval at all.
 * - **Durable and restart-safe.** The review is written to a ledger before any decision. A restart
 *   while a review is pending reopens the same pending review: it is neither re-created nor
 *   auto-approved.
 * - **A denial leaves nothing behind.** A missing or denied decision, a mismatched approval, a
 *   superseded edit or a moved published pointer are all refusals that return before the FileStore is
 *   asked to publish, so the published pointer is exactly where it was.
 * - **A rubric cannot approve.** Qualitative evidence may be attached to the review, but the decision
 *   this gate reads is a person's, bound to the exact hashes.
 *
 * The store is the byte and version authority; this gate is the workflow authority. They are joined
 * by the FileStore operation ID, not by a shared transaction.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FileStoreError, type PublishReceipt, type VersionedFileStore } from "@officehum/sdk";
import type { DocumentRefusalCode } from "./errors.js";
import { DocumentError, refusal } from "./errors.js";
import { type DocumentFormat, isDocumentFormat } from "./formats.js";
import type { ReviewEvidence } from "./review-evidence.js";
import { REVIEW_EVIDENCE_SCHEMA, REVIEW_EVIDENCE_VERSION } from "./review-evidence.js";
import {
  assertFileId,
  assertHash,
  assertLabel,
  assertSize,
  isNotFound,
  isRecord,
  messageOf,
  record,
} from "./validate.js";

export const REVIEW_SCHEMA = "officehum.paper.review";
export const REVIEW_SCHEMA_VERSION = 1;

/** One immutable version, named exactly as the FileStore holds it. */
export interface ReviewArtifact {
  readonly fileId: string;
  readonly versionId: string;
  readonly name: string;
  readonly format: DocumentFormat;
  readonly sha256: string;
  readonly size: number;
}

/** The exact artifact identity a person is shown: the file, the source, and the proposal. */
export interface ReviewIdentity {
  readonly fileId: string;
  readonly name: string;
  readonly format: DocumentFormat;
  /** The immutable version the proposal edits. */
  readonly source: ReviewArtifact;
  /** The immutable version the proposal would publish. */
  readonly proposed: ReviewArtifact;
}

/**
 * The hashes an approval is bound to. This is the approval's identity: the file, both versions with
 * their hashes, and the hash of the diff and of the deterministic validation. Two proposals that
 * differ in any byte of the document or any line of evidence have different bindings.
 */
export interface ReviewBinding {
  readonly fileId: string;
  readonly sourceVersionId: string;
  readonly sourceSha256: string;
  readonly proposedVersionId: string;
  readonly proposedSha256: string;
  readonly diffSha256: string;
  readonly validationSha256: string;
}

export type ReviewVerdict = "approved" | "denied";

/** The pending review: identity, binding and evidence, durable before anyone decides. */
export interface ReviewProposal {
  readonly kind: "proposal";
  readonly schema: string;
  readonly version: number;
  readonly reviewId: string;
  readonly identity: ReviewIdentity;
  readonly binding: ReviewBinding;
  /** The published pointer the person saw, which the FileStore compare-and-swap then checks. */
  readonly expectedPublishedVersionId: string | null;
  readonly evidence: ReviewEvidence;
  readonly createdAt: string;
}

/** A person's decision, bound to exactly the proposal's binding. */
export interface ReviewDecision {
  readonly kind: "decision";
  readonly reviewId: string;
  readonly verdict: ReviewVerdict;
  readonly by: string;
  readonly approvalId: string;
  readonly at: string;
  readonly binding: ReviewBinding;
}

/** The one publication a review may perform. */
export interface ReviewPublication {
  readonly kind: "published";
  readonly reviewId: string;
  readonly operationId: string;
  readonly receipt: PublishReceipt;
  readonly at: string;
}

/** One review's whole durable state: its proposal, its decision, and its publication if any. */
export interface ReviewRecord {
  readonly reviewId: string;
  readonly proposal: ReviewProposal;
  readonly decision: ReviewDecision | null;
  readonly publication: ReviewPublication | null;
}

/** Whether an approval covers a proposal: the decision's binding must be the proposal's binding. */
export function approvalCovers(decision: ReviewDecision, proposal: ReviewProposal): boolean {
  return decision.reviewId === proposal.reviewId && sameBinding(decision.binding, proposal.binding);
}

/** Value equality over every hashed field of a binding. */
export function sameBinding(left: ReviewBinding, right: ReviewBinding): boolean {
  return (
    left.fileId === right.fileId &&
    left.sourceVersionId === right.sourceVersionId &&
    left.sourceSha256 === right.sourceSha256 &&
    left.proposedVersionId === right.proposedVersionId &&
    left.proposedSha256 === right.proposedSha256 &&
    left.diffSha256 === right.diffSha256 &&
    left.validationSha256 === right.validationSha256
  );
}

/** Seals an identity and its evidence into the binding an approval is bound to. */
export function reviewBindingOf(identity: ReviewIdentity, evidence: ReviewEvidence): ReviewBinding {
  return {
    fileId: identity.fileId,
    sourceVersionId: identity.source.versionId,
    sourceSha256: identity.source.sha256,
    proposedVersionId: identity.proposed.versionId,
    proposedSha256: identity.proposed.sha256,
    // The diff hash covers the whole native evidence; the validation hash covers the deterministic
    // checks and numeric results only, so attaching a qualitative rubric never changes a binding.
    diffSha256: sha256(
      canonicalJson({
        changeSet: evidence.changeSet,
        diff: evidence.diff,
        preview: evidence.preview,
      }),
    ),
    validationSha256: sha256(
      canonicalJson({ checks: evidence.validation.checks, numeric: evidence.validation.numeric }),
    ),
  };
}

/** The stable review ID a binding names. The ID is the binding, so it cannot be chosen freely. */
export function reviewIdFor(binding: ReviewBinding): string {
  return `rev_${sha256(canonicalJson(binding)).slice(0, 32)}`;
}

// -- the ledger ----------------------------------------------------------------------------------

export interface ReviewLedger {
  read(reviewId: string): Promise<ReviewRecord | undefined>;
  list(): Promise<readonly ReviewRecord[]>;
  write(record: ReviewRecord): Promise<void>;
}

/** A durable, restart-safe review ledger: one file per review, written by exclusive create + rename. */
export function reviewLedger(dir: string): ReviewLedger {
  const root = resolve(dir);
  const reviewsDir = join(root, "reviews");

  return {
    async read(reviewId) {
      const path = join(reviewsDir, `${digest(reviewId)}.json`);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(path);
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw refusal(
          "ledger-integrity",
          `the review ledger could not be read: ${messageOf(error)}`,
        );
      }
      if (info.isSymbolicLink() || !info.isFile()) {
        throw refusal("ledger-integrity", "a review ledger entry is not a regular file");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch (error) {
        throw refusal("ledger-integrity", `a review ledger entry is corrupt: ${messageOf(error)}`);
      }
      return validateRecord(parsed);
    },
    async list() {
      let names: string[];
      try {
        names = await readdir(reviewsDir);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw refusal(
          "ledger-integrity",
          `the review ledger could not be listed: ${messageOf(error)}`,
        );
      }
      const records: ReviewRecord[] = [];
      for (const name of names.sort()) {
        if (!name.endsWith(".json")) continue;
        const parsed = JSON.parse(await readFile(join(reviewsDir, name), "utf8")) as unknown;
        records.push(validateRecord(parsed));
      }
      return records;
    },
    async write(value) {
      await mkdir(reviewsDir, { recursive: true, mode: 0o700 });
      const temp = join(reviewsDir, `.pending-${randomBytes(12).toString("hex")}`);
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(value), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temp, join(reviewsDir, `${digest(value.reviewId)}.json`));
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw refusal(
          "ledger-integrity",
          `a review ledger entry could not be written: ${messageOf(error)}`,
        );
      }
    },
  };
}

// -- the gate ------------------------------------------------------------------------------------

export type ReviewResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: DocumentRefusalCode; readonly message: string };

export interface OpenReviewInput {
  readonly identity: ReviewIdentity;
  readonly evidence: ReviewEvidence;
}

export interface PublishReviewInput {
  readonly reviewId: string;
  /** Stable across a crash and its replay, derived from the Pi Durable call identity. */
  readonly operationId: string;
  /** The approval the caller claims. A different one than the review recorded is a mismatch. */
  readonly approvalId?: string;
}

export interface PublicationGateOptions {
  readonly store: VersionedFileStore;
  readonly ledger: ReviewLedger;
  readonly now?: () => Date;
}

export interface PublicationGate {
  /** Records a pending review from exact source and proposed hashes. Idempotent and restart-safe. */
  open(input: OpenReviewInput): Promise<ReviewResult<ReviewProposal>>;
  /** Records a person's decision, bound to the proposal's binding. First write wins. */
  decide(input: {
    readonly reviewId: string;
    readonly verdict: ReviewVerdict;
    readonly by: string;
    readonly approvalId: string;
  }): Promise<ReviewResult<ReviewDecision>>;
  /** Publishes an approved proposal through the FileStore compare-and-swap. Replay is idempotent. */
  publish(input: PublishReviewInput): Promise<ReviewResult<ReviewPublication>>;
  get(reviewId: string): Promise<ReviewResult<ReviewRecord>>;
  list(): Promise<readonly ReviewRecord[]>;
}

export function publicationGate(options: PublicationGateOptions): PublicationGate {
  const now = options.now ?? (() => new Date());

  async function open(input: OpenReviewInput): Promise<ReviewResult<ReviewProposal>> {
    try {
      const identity = validateIdentity(input.identity);
      const evidence = validateEvidence(input.evidence, identity);
      const binding = reviewBindingOf(identity, evidence);
      const reviewId = reviewIdFor(binding);

      const existing = await options.ledger.read(reviewId);
      if (existing !== undefined) return ok(existing.proposal);

      await requireVersion(identity.fileId, identity.source, "source version");
      const proposed = await requireVersion(identity.fileId, identity.proposed, "proposed version");
      if (proposed.sourceVersionId !== identity.source.versionId) {
        throw refusal(
          "source-integrity",
          "the proposed version does not descend from the source version this review names",
        );
      }
      const published = await options.store.getPublished(identity.fileId);
      const proposal: ReviewProposal = {
        kind: "proposal",
        schema: REVIEW_SCHEMA,
        version: REVIEW_SCHEMA_VERSION,
        reviewId,
        identity,
        binding,
        expectedPublishedVersionId: published?.versionId ?? null,
        evidence,
        createdAt: now().toISOString(),
      };
      await options.ledger.write({ reviewId, proposal, decision: null, publication: null });
      return ok(proposal);
    } catch (error) {
      return refusalOf(error);
    }
  }

  async function decide(input: {
    readonly reviewId: string;
    readonly verdict: ReviewVerdict;
    readonly by: string;
    readonly approvalId: string;
  }): Promise<ReviewResult<ReviewDecision>> {
    try {
      assertLabel(input.reviewId, "a review id");
      if (input.verdict !== "approved" && input.verdict !== "denied") {
        throw refusal("invalid-request", "a verdict must be approved or denied");
      }
      assertLabel(input.by, "a reviewer name");
      assertLabel(input.approvalId, "an approval id");
      const current = await options.ledger.read(input.reviewId);
      if (current === undefined) throw refusal("not-found", "no such review");
      // First write wins: a decision written before a crash stands, so a replay cannot overturn it.
      if (current.decision !== null) return ok(current.decision);
      const decision: ReviewDecision = {
        kind: "decision",
        reviewId: current.reviewId,
        verdict: input.verdict,
        by: input.by,
        approvalId: input.approvalId,
        at: now().toISOString(),
        binding: current.proposal.binding,
      };
      await options.ledger.write({ ...current, decision });
      return ok(decision);
    } catch (error) {
      return refusalOf(error);
    }
  }

  async function publish(input: PublishReviewInput): Promise<ReviewResult<ReviewPublication>> {
    try {
      assertLabel(input.reviewId, "a review id");
      assertLabel(input.operationId, "a publish operation id");
      if (input.approvalId !== undefined) assertLabel(input.approvalId, "an approval id");

      const current = await options.ledger.read(input.reviewId);
      if (current === undefined) throw refusal("not-found", "no such review");
      if (current.publication !== null) return ok(current.publication);

      const decision = current.decision;
      if (decision === null) {
        throw refusal(
          "not-approved",
          "no person has decided this review, so the proposed version was not published",
        );
      }
      if (decision.verdict !== "approved") {
        throw refusal("denied", "a person declined this proposal, so it was not published");
      }
      if (input.approvalId !== undefined && input.approvalId !== decision.approvalId) {
        throw refusal(
          "approval-mismatch",
          "the named approval is not the one this review recorded, so it cannot publish it",
        );
      }
      if (!approvalCovers(decision, current.proposal)) {
        throw refusal(
          "approval-mismatch",
          "the approval is bound to different hashes than this proposal, so it cannot publish it",
        );
      }

      const { binding } = current.proposal;
      // The proposed version must still hash to what the person approved.
      const stored = await options.store.getVersion(binding.fileId, binding.proposedVersionId);
      if (stored === undefined) {
        throw refusal("not-found", "the proposed version is no longer in the file store");
      }
      if (stored.ref.sha256 !== binding.proposedSha256) {
        throw refusal(
          "source-integrity",
          "the proposed version's bytes no longer match the review",
        );
      }
      // A newer edit supersedes this proposal: publishing it would resurrect an outdated draft.
      const head = await options.store.getHead(binding.fileId);
      if (head === undefined || head.versionId !== binding.proposedVersionId) {
        throw refusal(
          "stale-review",
          "a newer edit supersedes this proposal, so it needs a new proposal and review",
        );
      }

      // A receipt from an earlier attempt at this exact operation is adopted, not repeated.
      const prior = await options.store.lookupOperation(input.operationId);
      if (prior !== undefined) {
        if (
          prior.kind !== "publish" ||
          prior.published.versionId !== binding.proposedVersionId ||
          prior.approvalId !== decision.approvalId
        ) {
          throw refusal(
            "operation-collision",
            "this publish operation already committed a different version or approval",
          );
        }
        const publication: ReviewPublication = {
          kind: "published",
          reviewId: current.reviewId,
          operationId: input.operationId,
          receipt: prior,
          at: now().toISOString(),
        };
        await options.ledger.write({ ...current, publication });
        return ok(publication);
      }

      let receipt: PublishReceipt;
      try {
        receipt = await options.store.publish({
          operationId: input.operationId,
          fileId: binding.fileId,
          expectedPublishedVersionId: current.proposal.expectedPublishedVersionId,
          versionId: binding.proposedVersionId,
          approvalId: decision.approvalId,
        });
      } catch (error) {
        if (error instanceof FileStoreError) {
          if (error.code === "VERSION_CONFLICT") {
            throw refusal(
              "version-conflict",
              "the published version moved after this review, so it needs a new proposal and review",
            );
          }
          if (error.code === "OPERATION_COLLISION") {
            throw refusal(
              "operation-collision",
              "this publish operation id has a different intent",
            );
          }
          if (error.code === "NOT_FOUND") {
            throw refusal("not-found", "the proposed version is no longer in the file store");
          }
          throw refusal("store-error", messageOf(error));
        }
        throw error;
      }
      const publication: ReviewPublication = {
        kind: "published",
        reviewId: current.reviewId,
        operationId: input.operationId,
        receipt,
        at: now().toISOString(),
      };
      await options.ledger.write({ ...current, publication });
      return ok(publication);
    } catch (error) {
      return refusalOf(error);
    }
  }

  async function get(reviewId: string): Promise<ReviewResult<ReviewRecord>> {
    try {
      assertLabel(reviewId, "a review id");
      const found = await options.ledger.read(reviewId);
      if (found === undefined) throw refusal("not-found", "no such review");
      return ok(found);
    } catch (error) {
      return refusalOf(error);
    }
  }

  return { open, decide, publish, get, list: () => options.ledger.list() };

  async function requireVersion(
    fileId: string,
    artifact: ReviewArtifact,
    what: string,
  ): Promise<{ readonly versionId: string; readonly sourceVersionId: string | null }> {
    const stored = await options.store.getVersion(fileId, artifact.versionId);
    if (stored === undefined) throw refusal("not-found", `the ${what} is not in the file store`);
    if (stored.ref.sha256 !== artifact.sha256 || stored.ref.size !== artifact.size) {
      throw refusal("source-integrity", `the ${what} does not match the hash this review names`);
    }
    return { versionId: stored.ref.versionId, sourceVersionId: stored.ref.sourceVersionId };
  }
}

// -- validation ----------------------------------------------------------------------------------

function validateIdentity(value: ReviewIdentity): ReviewIdentity {
  const raw = record(value, "a review identity must be an object");
  assertFileId(raw.fileId, "a review file id");
  const format = raw.format;
  if (!isDocumentFormat(format))
    throw refusal("invalid-request", "a review names an unknown format");
  const name = raw.name;
  if (typeof name !== "string" || name === "") {
    throw refusal("invalid-request", "a review needs a file name");
  }
  const source = validateArtifact(raw.source, "the source version");
  const proposed = validateArtifact(raw.proposed, "the proposed version");
  if (source.fileId !== raw.fileId || proposed.fileId !== raw.fileId) {
    throw refusal("invalid-request", "a review's source and proposal must be the same file");
  }
  if (source.format !== format || proposed.format !== format) {
    throw refusal("invalid-request", "a review's versions must match the review's format");
  }
  if (source.versionId === proposed.versionId) {
    throw refusal("invalid-request", "a proposal must name a version other than its source");
  }
  return { fileId: raw.fileId, name, format, source, proposed };
}

function validateArtifact(value: unknown, what: string): ReviewArtifact {
  const raw = record(value, `${what} must be an object`);
  assertFileId(raw.fileId, `${what} file id`);
  assertFileId(raw.versionId, `${what} version id`);
  assertHash(raw.sha256, `${what} hash`);
  assertSize(raw.size, `${what} size`);
  const format = raw.format;
  if (!isDocumentFormat(format))
    throw refusal("invalid-request", `${what} names an unknown format`);
  const name = raw.name;
  if (typeof name !== "string" || name === "") {
    throw refusal("invalid-request", `${what} needs a name`);
  }
  return {
    fileId: raw.fileId,
    versionId: raw.versionId,
    name,
    format,
    sha256: raw.sha256,
    size: raw.size,
  };
}

/** Evidence must be about exactly the versions the identity names, or it proves nothing. */
function validateEvidence(value: ReviewEvidence, identity: ReviewIdentity): ReviewEvidence {
  const raw = record(value, "review evidence must be an object");
  if (raw.schema !== REVIEW_EVIDENCE_SCHEMA || raw.version !== REVIEW_EVIDENCE_VERSION) {
    throw refusal("invalid-request", "review evidence has an unknown schema or version");
  }
  if (raw.format !== identity.format) {
    throw refusal("invalid-request", "review evidence is for a different format than the review");
  }
  const sources = record(raw.sources, "review evidence names no sources");
  const from = record(sources.from, "review evidence names no source");
  const to = record(sources.to, "review evidence names no proposal");
  if (from.versionId !== identity.source.versionId || from.sha256 !== identity.source.sha256) {
    throw refusal("source-integrity", "review evidence compares a different source version");
  }
  if (to.versionId !== identity.proposed.versionId || to.sha256 !== identity.proposed.sha256) {
    throw refusal("source-integrity", "review evidence compares a different proposed version");
  }
  if (!isRecord(raw.validation) || raw.validation.deterministic !== true) {
    throw refusal("invalid-request", "review evidence carries no deterministic validation");
  }
  return value;
}

function validateRecord(value: unknown): ReviewRecord {
  const raw = record(value, "a review ledger entry must be an object", "ledger-integrity");
  const reviewId = raw.reviewId;
  assertLabel(reviewId, "a ledger review id", "ledger-integrity");
  const proposalRaw = record(raw.proposal, "a review record has no proposal", "ledger-integrity");
  const proposal: ReviewProposal = {
    kind: "proposal",
    schema: REVIEW_SCHEMA,
    version: REVIEW_SCHEMA_VERSION,
    reviewId,
    identity: validateIdentity(proposalRaw.identity as ReviewIdentity),
    binding: validateBinding(proposalRaw.binding),
    expectedPublishedVersionId:
      proposalRaw.expectedPublishedVersionId === null
        ? null
        : assertFileIdValue(
            proposalRaw.expectedPublishedVersionId,
            "an expected published version",
          ),
    evidence: proposalRaw.evidence as ReviewEvidence,
    createdAt: assertTimestamp(proposalRaw.createdAt),
  };
  const decision =
    raw.decision === null ? null : validateDecision(raw.decision, reviewId, proposal.binding);
  const publication =
    raw.publication === null || raw.publication === undefined
      ? null
      : validatePublication(raw.publication, reviewId);
  return { reviewId, proposal, decision, publication };
}

function validateBinding(value: unknown): ReviewBinding {
  const raw = record(value, "a review binding must be an object", "ledger-integrity");
  assertFileId(raw.fileId, "a binding file id", "ledger-integrity");
  assertFileId(raw.sourceVersionId, "a binding source version", "ledger-integrity");
  assertHash(raw.sourceSha256, "a binding source hash", "ledger-integrity");
  assertFileId(raw.proposedVersionId, "a binding proposed version", "ledger-integrity");
  assertHash(raw.proposedSha256, "a binding proposed hash", "ledger-integrity");
  assertHash(raw.diffSha256, "a binding diff hash", "ledger-integrity");
  assertHash(raw.validationSha256, "a binding validation hash", "ledger-integrity");
  return {
    fileId: raw.fileId,
    sourceVersionId: raw.sourceVersionId,
    sourceSha256: raw.sourceSha256,
    proposedVersionId: raw.proposedVersionId,
    proposedSha256: raw.proposedSha256,
    diffSha256: raw.diffSha256,
    validationSha256: raw.validationSha256,
  };
}

function validateDecision(
  value: unknown,
  reviewId: string,
  binding: ReviewBinding,
): ReviewDecision {
  const raw = record(value, "a review decision must be an object", "ledger-integrity");
  if (raw.verdict !== "approved" && raw.verdict !== "denied") {
    throw refusal("ledger-integrity", "a review decision has an unknown verdict");
  }
  assertLabel(raw.by, "a decision reviewer", "ledger-integrity");
  assertLabel(raw.approvalId, "a decision approval id", "ledger-integrity");
  return {
    kind: "decision",
    reviewId,
    verdict: raw.verdict,
    by: raw.by,
    approvalId: raw.approvalId,
    at: assertTimestamp(raw.at),
    binding: raw.binding === undefined ? binding : validateBinding(raw.binding),
  };
}

function validatePublication(value: unknown, reviewId: string): ReviewPublication {
  const raw = record(value, "a review publication must be an object", "ledger-integrity");
  assertLabel(raw.operationId, "a publication operation", "ledger-integrity");
  const receipt = record(
    raw.receipt,
    "a publication receipt must be an object",
    "ledger-integrity",
  );
  if (receipt.kind !== "publish") {
    throw refusal("ledger-integrity", "a publication receipt is not a publish receipt");
  }
  return {
    kind: "published",
    reviewId,
    operationId: raw.operationId,
    receipt: raw.receipt as unknown as PublishReceipt,
    at: assertTimestamp(raw.at),
  };
}

function assertFileIdValue(value: unknown, what: string): string {
  assertFileId(value, what, "ledger-integrity");
  return value;
}

function assertTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw refusal("ledger-integrity", "a review record has no timestamp");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw refusal("ledger-integrity", "a review record has an unusable timestamp");
  }
  return value;
}

// -- helpers --------------------------------------------------------------------------------------

function ok<T>(value: T): ReviewResult<T> {
  return { ok: true, value };
}

function refusalOf(error: unknown): ReviewResult<never> {
  if (error instanceof DocumentError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return { ok: false, code: "invalid-request", message: messageOf(error) };
}

function canonicalJson(value: unknown): string {
  const canonical = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonical);
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(canonical(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
