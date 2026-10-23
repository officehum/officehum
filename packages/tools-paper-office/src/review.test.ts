/**
 * The review and publication gate, against the real FileStore and a real durable ledger.
 *
 * These tests are the contract: an existing file's published pointer moves only behind a person's
 * approval bound to the exact hashes, and every refusal is asserted by reading the pointer back
 * rather than by the error code alone. The important one is that an approval made for one proposal
 * cannot publish a different proposal with the same file and different bytes.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localVersionedFileStore,
  type PublishReceipt,
  type VersionedFileRef,
  type VersionedFileStore,
} from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  publicationGate,
  type ReviewArtifact,
  type ReviewIdentity,
  type ReviewRecord,
  reviewIdFor,
  reviewLedger,
} from "./review.js";
import { type ReviewEvidence, reviewEvidenceFromWord, withRubric } from "./review-evidence.js";
import type { WordComparison } from "./word-operations.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CONTEXT = {
  taskId: "task:review",
  policyVersion: "policy:1",
  worker: { image: "paper-worker:python-3.13.17", libraries: { "paper-docx": "0.2.0" } },
  argumentsSha256: "a".repeat(64),
};

/** A tiny but ZIP-signature-carrying docx body. The gate compares hashes, never parses the bytes. */
function docxBytes(marker: string): Uint8Array {
  return Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(marker)]);
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "officehum-review-"));
  dirs.push(root);
  const store = localVersionedFileStore(join(root, "files"));
  const ledger = reviewLedger(join(root, "reviews"));
  const gate = publicationGate({
    store,
    ledger,
    now: () => new Date("2026-10-23T12:00:00.000Z"),
  });
  return { root, store, ledger, gate };
}

interface Proposal {
  readonly fileId: string;
  readonly name: string;
  readonly source: VersionedFileRef;
  readonly proposed: VersionedFileRef;
}

/** A file with one published version and one proposed edit of it, all through the FileStore. */
async function fileWithProposal(
  store: VersionedFileStore,
  first: string,
  second: string,
): Promise<Proposal> {
  const created = await store.create({
    operationId: "create:1",
    bytes: docxBytes(first),
    name: "report.docx",
    mimeType: DOCX_MIME,
    metadata: { createdBy: "role:test", source: "generated" },
    context: CONTEXT,
  });
  await store.publish({
    operationId: "seed:publish",
    fileId: created.output.id,
    expectedPublishedVersionId: null,
    versionId: created.output.versionId,
    approvalId: "seed",
  });
  const edited = await store.putVersion({
    operationId: "edit:1",
    fileId: created.output.id,
    sourceVersionId: created.output.versionId,
    bytes: docxBytes(second),
    name: "report.docx",
    mimeType: DOCX_MIME,
    metadata: { createdBy: "role:test", source: "derived" },
    context: CONTEXT,
  });
  return {
    fileId: created.output.id,
    name: "report.docx",
    source: created.output,
    proposed: edited.output,
  };
}

function artifact(ref: VersionedFileRef, format: ReviewArtifact["format"]): ReviewArtifact {
  return {
    fileId: ref.id,
    versionId: ref.versionId,
    name: ref.name,
    format,
    sha256: ref.sha256,
    size: ref.size,
  };
}

function identityOf(proposal: Proposal): ReviewIdentity {
  return {
    fileId: proposal.fileId,
    name: proposal.name,
    format: "docx",
    source: artifact(proposal.source, "docx"),
    proposed: artifact(proposal.proposed, "docx"),
  };
}

/** A Word comparison whose one changed line carries the proposal's own text. */
function wordEvidence(proposal: Proposal, changedText: string): ReviewEvidence {
  const ref = (versionId: string, sha256: string, size: number) => ({
    fileId: proposal.fileId,
    versionId,
    name: proposal.name,
    sha256,
    size,
  });
  const comparison: WordComparison = {
    operation: "compare",
    sources: {
      from: ref(proposal.source.versionId, proposal.source.sha256, proposal.source.size),
      to: ref(proposal.proposed.versionId, proposal.proposed.sha256, proposal.proposed.size),
    },
    changeSet: {
      schema: "paper_word_change_set",
      version: 1,
      added: [],
      removed: [],
      changed: [
        {
          part: "word/document.xml",
          kind: "text",
          beforeSha256: proposal.source.sha256,
          afterSha256: proposal.proposed.sha256,
          semanticChange: true,
        },
      ],
      byteIdenticalCount: 3,
      semanticallyEmpty: false,
    },
    diff: {
      schema: "paper_word_diff",
      version: 1,
      changedLineCount: 1,
      stories: [
        {
          story: "word/document.xml",
          diffLines: ["-old total", `+${changedText}`],
          omittedLines: 0,
        },
      ],
      truncated: false,
    },
    redline: {
      schema: "paper_word_redline",
      version: 1,
      insertedBlocks: 1,
      deletedBlocks: 0,
      entries: [
        {
          story: "word/document.xml",
          kind: "insert",
          index: 0,
          marker: "+",
          text: changedText,
          truncated: false,
        },
      ],
      total: 1,
      truncated: false,
      pendingChangedLineCount: 1,
      pendingLines: [`+${changedText}`],
    },
    identical: false,
  };
  return reviewEvidenceFromWord(comparison);
}

async function publishedPointer(store: VersionedFileStore, fileId: string): Promise<string | null> {
  return (await store.getPublished(fileId))?.versionId ?? null;
}

describe("the publication gate", () => {
  it("publishes an approved review and records the previous and published refs", async () => {
    const { store, gate } = await workspace();
    const proposal = await fileWithProposal(store, "v1", "v2-edited");
    const identity = identityOf(proposal);
    const opened = await gate.open({ identity, evidence: wordEvidence(proposal, "a new total") });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // Nothing publishes before a person decides.
    const early = await gate.publish({
      reviewId: opened.value.reviewId,
      operationId: "publish:1",
    });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.code).toBe("not-approved");
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.source.versionId);

    const decided = await gate.decide({
      reviewId: opened.value.reviewId,
      verdict: "approved",
      by: "azmat",
      approvalId: "approval:3285",
    });
    expect(decided.ok).toBe(true);

    const published = await gate.publish({
      reviewId: opened.value.reviewId,
      operationId: "publish:1",
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.value.receipt.previous?.versionId).toBe(proposal.source.versionId);
    expect(published.value.receipt.published.versionId).toBe(proposal.proposed.versionId);
    expect(published.value.receipt.approvalId).toBe("approval:3285");
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.proposed.versionId);
  });

  it("never publishes a denied review and leaves the pointer where it was", async () => {
    const { store, gate } = await workspace();
    const proposal = await fileWithProposal(store, "v1", "v2-edited");
    const opened = await gate.open({
      identity: identityOf(proposal),
      evidence: wordEvidence(proposal, "a new total"),
    });
    if (!opened.ok) throw new Error("open refused");

    await gate.decide({
      reviewId: opened.value.reviewId,
      verdict: "denied",
      by: "azmat",
      approvalId: "approval:no",
    });
    const refused = await gate.publish({
      reviewId: opened.value.reviewId,
      operationId: "publish:1",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("denied");
    // Assert by reading the pointer back: a denial never moves it.
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.source.versionId);
  });

  it("leaves the pointer unchanged when no decision exists at all", async () => {
    const { store, gate } = await workspace();
    const proposal = await fileWithProposal(store, "v1", "v2-edited");
    const opened = await gate.open({
      identity: identityOf(proposal),
      evidence: wordEvidence(proposal, "a new total"),
    });
    if (!opened.ok) throw new Error("open refused");
    const refused = await gate.publish({
      reviewId: opened.value.reviewId,
      operationId: "publish:1",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("not-approved");
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.source.versionId);
  });

  it("resumes the same pending review across a restart instead of re-opening or auto-approving", async () => {
    const { root, store, gate } = await workspace();
    const proposal = await fileWithProposal(store, "v1", "v2-edited");
    const identity = identityOf(proposal);
    const evidence = wordEvidence(proposal, "a new total");
    const first = await gate.open({ identity, evidence });
    if (!first.ok) throw new Error("open refused");

    // A restart: a fresh gate and a fresh ledger over the same directory.
    const reopened = publicationGate({
      store: localVersionedFileStore(join(root, "files")),
      ledger: reviewLedger(join(root, "reviews")),
    });
    const second = await reopened.open({ identity, evidence });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.reviewId).toBe(first.value.reviewId);
    expect(second.value.createdAt).toBe(first.value.createdAt);

    // The pending review is still pending: not auto-approved, and still unpublishable.
    const record = await reopened.get(first.value.reviewId);
    expect(record.ok).toBe(true);
    if (record.ok) expect(record.value.decision).toBeNull();
    const refused = await reopened.publish({
      reviewId: first.value.reviewId,
      operationId: "publish:1",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("not-approved");
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.source.versionId);
  });

  it("an approval for proposal A cannot publish proposal B, even for the same file", async () => {
    const { root, store, gate } = await workspace();
    const proposal = await fileWithProposal(store, "v1", "v2-edited");

    // Proposal A: publish the first edit. A person approves it and it publishes.
    const openedA = await gate.open({
      identity: identityOf(proposal),
      evidence: wordEvidence(proposal, "total A"),
    });
    if (!openedA.ok) throw new Error("open A refused");
    await gate.decide({
      reviewId: openedA.value.reviewId,
      verdict: "approved",
      by: "azmat",
      approvalId: "approval:A",
    });
    const publishedA = await gate.publish({
      reviewId: openedA.value.reviewId,
      operationId: "publish:A",
    });
    if (!publishedA.ok) throw new Error("publish A refused");
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.proposed.versionId);

    // Proposal B: a later edit of the same file — same file, different bytes.
    const secondEdit = await store.putVersion({
      operationId: "edit:2",
      fileId: proposal.fileId,
      sourceVersionId: proposal.proposed.versionId,
      bytes: docxBytes("v3-later"),
      name: "report.docx",
      mimeType: DOCX_MIME,
      metadata: { createdBy: "role:test", source: "derived" },
      context: CONTEXT,
    });
    const proposalB: Proposal = {
      ...proposal,
      source: proposal.proposed,
      proposed: secondEdit.output,
    };
    expect(proposalB.proposed.sha256).not.toBe(proposal.proposed.sha256);

    const openedB = await gate.open({
      identity: identityOf(proposalB),
      evidence: wordEvidence(proposalB, "total B"),
    });
    if (!openedB.ok) throw new Error("open B refused");
    expect(openedB.value.reviewId).not.toBe(openedA.value.reviewId);
    expect(openedB.value.binding.proposedSha256).not.toBe(openedA.value.binding.proposedSha256);

    // A's approval names neither B's review nor B's hashes.
    expect((await gate.get(openedB.value.reviewId)).ok).toBe(true);
    const crossApproval = await gate.publish({
      reviewId: openedB.value.reviewId,
      operationId: "publish:B",
      approvalId: "approval:A",
    });
    expect(crossApproval.ok).toBe(false);
    if (!crossApproval.ok) expect(crossApproval.code).toBe("not-approved");
    // Assert by reading the pointer back: B did not move it.
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.proposed.versionId);

    // A decision whose binding is A's, mis-stored under B's review, is a mismatch, not an approval.
    const recordB = await gate.get(openedB.value.reviewId);
    if (!recordB.ok) throw new Error("no B record");
    const forged: ReviewRecord = {
      ...recordB.value,
      decision: {
        kind: "decision",
        reviewId: openedB.value.reviewId,
        verdict: "approved",
        by: "azmat",
        approvalId: "approval:A",
        at: "2026-10-23T12:00:00.000Z",
        binding: openedA.value.binding,
      },
    };
    const ledger = reviewLedger(join(root, "reviews"));
    await ledger.write(forged);
    const forgedPublish = await publicationGate({ store, ledger }).publish({
      reviewId: openedB.value.reviewId,
      operationId: "publish:B",
    });
    expect(forgedPublish.ok).toBe(false);
    if (!forgedPublish.ok) expect(forgedPublish.code).toBe("approval-mismatch");
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.proposed.versionId);

    // A's own approval still resolves to A's publication, and only that.
    const replayA = await gate.publish({
      reviewId: openedA.value.reviewId,
      operationId: "publish:A",
    });
    expect(replayA.ok).toBe(true);
    if (replayA.ok)
      expect(replayA.value.receipt.published.versionId).toBe(proposal.proposed.versionId);
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.proposed.versionId);
  });

  it("does not publish a second time when its receipt was lost, and replay is idempotent", async () => {
    const { root, store, gate } = await workspace();
    const proposal = await fileWithProposal(store, "v1", "v2-edited");
    const opened = await gate.open({
      identity: identityOf(proposal),
      evidence: wordEvidence(proposal, "a new total"),
    });
    if (!opened.ok) throw new Error("open refused");
    await gate.decide({
      reviewId: opened.value.reviewId,
      verdict: "approved",
      by: "azmat",
      approvalId: "approval:1",
    });
    const first = await gate.publish({
      reviewId: opened.value.reviewId,
      operationId: "publish:1",
    });
    if (!first.ok) throw new Error("first publish refused");
    const pointerAfterFirst = await publishedPointer(store, proposal.fileId);

    // Simulate a lost ledger receipt: the record loses its publication, but the FileStore keeps its
    // own operation lookup. A re-run must adopt that receipt, not move the pointer again.
    const ledger = reviewLedger(join(root, "reviews"));
    const stored = await ledger.read(opened.value.reviewId);
    if (stored === undefined) throw new Error("record vanished");
    await ledger.write({ ...stored, publication: null });

    const replay = await publicationGate({ store, ledger }).publish({
      reviewId: opened.value.reviewId,
      operationId: "publish:1",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.operationId).toBe("publish:1");
    expect(replay.value.receipt.published.versionId).toBe(first.value.receipt.published.versionId);
    expect(await publishedPointer(store, proposal.fileId)).toBe(pointerAfterFirst);

    // A second publish of the already-published review reads the recorded publication and does
    // nothing at all.
    const again = await gate.publish({ reviewId: opened.value.reviewId, operationId: "publish:2" });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.operationId).toBe("publish:1");
    expect(await publishedPointer(store, proposal.fileId)).toBe(pointerAfterFirst);
  });

  it("refuses a stale approval whose published pointer moved and leaves the newer version published", async () => {
    const { store, gate } = await workspace();
    const proposal = await fileWithProposal(store, "v1", "v2-edited");
    const opened = await gate.open({
      identity: identityOf(proposal),
      evidence: wordEvidence(proposal, "a new total"),
    });
    if (!opened.ok) throw new Error("open refused");
    await gate.decide({
      reviewId: opened.value.reviewId,
      verdict: "approved",
      by: "azmat",
      approvalId: "approval:1",
    });

    // A concurrent publish moves the pointer to exactly this proposal's version, under another
    // operation. The head does not move, so only the FileStore compare-and-swap can catch it.
    await store.publish({
      operationId: "other:publish",
      fileId: proposal.fileId,
      expectedPublishedVersionId: proposal.source.versionId,
      versionId: proposal.proposed.versionId,
      approvalId: "someone-else",
    });
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.proposed.versionId);

    const stale = await gate.publish({ reviewId: opened.value.reviewId, operationId: "publish:1" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("version-conflict");
    // The pointer is still the version the other publish made, never rewound by our refusal.
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.proposed.versionId);
  });

  it("refuses a proposal a newer edit superseded, and leaves the pointer unchanged", async () => {
    const { store, gate } = await workspace();
    const proposal = await fileWithProposal(store, "v1", "v2-edited");
    const opened = await gate.open({
      identity: identityOf(proposal),
      evidence: wordEvidence(proposal, "a new total"),
    });
    if (!opened.ok) throw new Error("open refused");
    await gate.decide({
      reviewId: opened.value.reviewId,
      verdict: "approved",
      by: "azmat",
      approvalId: "approval:1",
    });

    // A concurrent edit advances the head past the reviewed proposal.
    await store.putVersion({
      operationId: "edit:2",
      fileId: proposal.fileId,
      sourceVersionId: proposal.proposed.versionId,
      bytes: docxBytes("v3-newer"),
      name: "report.docx",
      mimeType: DOCX_MIME,
      metadata: { createdBy: "role:test", source: "derived" },
      context: CONTEXT,
    });

    const superseded = await gate.publish({
      reviewId: opened.value.reviewId,
      operationId: "publish:1",
    });
    expect(superseded.ok).toBe(false);
    if (!superseded.ok) expect(superseded.code).toBe("stale-review");
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.source.versionId);
  });

  it("never treats a rubric as consent, and rejects evidence about other versions", async () => {
    const { store, gate } = await workspace();
    const proposal = await fileWithProposal(store, "v1", "v2-edited");
    const evidence = withRubric(wordEvidence(proposal, "a new total"), {
      score: 9,
      max: 10,
      notes: ["reads well"],
    });
    expect(evidence.validation.rubric?.mayApprove).toBe(false);

    const opened = await gate.open({ identity: identityOf(proposal), evidence });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // A rubric on the evidence changes nothing: no decision exists, so nothing publishes.
    const refused = await gate.publish({
      reviewId: opened.value.reviewId,
      operationId: "publish:1",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("not-approved");
    expect(await publishedPointer(store, proposal.fileId)).toBe(proposal.source.versionId);

    // Evidence that compares some other version proves nothing about this proposal.
    const foreign = wordEvidence(proposal, "a new total");
    const tampered: ReviewEvidence = {
      ...foreign,
      sources: { ...foreign.sources, to: { ...foreign.sources.to, sha256: "b".repeat(64) } },
    };
    const rejected = await gate.open({ identity: identityOf(proposal), evidence: tampered });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("source-integrity");
  });

  it("a new file is a draft: creating one publishes nothing and needs no review", async () => {
    const { store, gate } = await workspace();
    const created = await store.create({
      operationId: "create:only",
      bytes: docxBytes("brand new"),
      name: "new.docx",
      mimeType: DOCX_MIME,
      metadata: { createdBy: "role:test", source: "generated" },
      context: CONTEXT,
    });
    expect(await publishedPointer(store, created.output.id)).toBeNull();

    // A proposal must name a source other than itself; a draft has no such source to review.
    const selfReview = await gate.open({
      identity: {
        fileId: created.output.id,
        name: "new.docx",
        format: "docx",
        source: artifact(created.output, "docx"),
        proposed: artifact(created.output, "docx"),
      },
      evidence: wordEvidence(
        {
          fileId: created.output.id,
          name: "new.docx",
          source: created.output,
          proposed: created.output,
        },
        "n/a",
      ),
    });
    expect(selfReview.ok).toBe(false);
    if (!selfReview.ok) expect(selfReview.code).toBe("invalid-request");
  });

  it("derives the review id from the binding, so identical evidence reopens one review", async () => {
    const { store, gate } = await workspace();
    const proposal = await fileWithProposal(store, "v1", "v2-edited");
    const identity = identityOf(proposal);
    const evidence = wordEvidence(proposal, "a new total");
    const one = await gate.open({ identity, evidence });
    if (!one.ok) throw new Error("open refused");
    const two = await gate.open({ identity, evidence });
    if (!two.ok) throw new Error("open refused");
    expect(two.value.reviewId).toBe(one.value.reviewId);
    expect(one.value.reviewId).toBe(reviewIdFor(one.value.binding));
    // The binding seals the diff and the validation, so it is not just the version ids.
    expect(one.value.binding.diffSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(one.value.binding.validationSha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});

// -- the bare-harness portability proof ----------------------------------------------------------

/**
 * The review surface is generic: it needs only `getVersion`, `getPublished`, `getHead`,
 * `lookupOperation` and `publish` from whatever store a harness injects. This in-memory store has no
 * Office Hum host behind it and still runs the whole approve-and-publish path.
 */
interface BareStore {
  seed(
    name: string,
    sourceSha: string,
    proposedSha: string,
  ): Promise<{
    fileId: string;
    source: VersionedFileRef;
    proposed: VersionedFileRef;
  }>;
  getVersion(
    fileId: string,
    versionId: string,
  ): Promise<{ ref: VersionedFileRef; bytes: Uint8Array } | undefined>;
  getPublished(fileId: string): Promise<VersionedFileRef | undefined>;
  getHead(fileId: string): Promise<VersionedFileRef | undefined>;
  lookupOperation(operationId: string): Promise<PublishReceipt | undefined>;
  publish(input: {
    operationId: string;
    fileId: string;
    expectedPublishedVersionId: string | null;
    versionId: string;
    approvalId: string;
  }): Promise<PublishReceipt>;
}

function bareStore(): BareStore {
  interface BareVersion {
    readonly fileId: string;
    readonly versionId: string;
    readonly name: string;
    readonly sha256: string;
    readonly size: number;
    readonly sourceVersionId: string | null;
  }
  const files = new Map<
    string,
    { head: string; published: string | null; versions: Map<string, BareVersion> }
  >();
  const operations = new Map<string, PublishReceipt>();

  const refOf = (version: BareVersion): VersionedFileRef => ({
    id: version.fileId,
    name: version.name,
    mimeType: DOCX_MIME,
    size: version.size,
    sha256: version.sha256,
    createdAt: "2026-10-23T12:00:00.000Z",
    metadata: { createdBy: "bare", source: "generated" },
    versionId: version.versionId,
    sourceVersionId: version.sourceVersionId,
    operationId: null,
    context: null,
  });

  const store = {
    async seed(name: string, sourceSha: string, proposedSha: string) {
      const fileId = "file_00000000000000000000000000";
      const source: BareVersion = {
        fileId,
        versionId: "file_11111111111111111111111111",
        name,
        sha256: sourceSha,
        size: 4,
        sourceVersionId: null,
      };
      const proposed: BareVersion = {
        fileId,
        versionId: "file_22222222222222222222222222",
        name,
        sha256: proposedSha,
        size: 4,
        sourceVersionId: source.versionId,
      };
      files.set(fileId, {
        head: proposed.versionId,
        published: source.versionId,
        versions: new Map([
          [source.versionId, source],
          [proposed.versionId, proposed],
        ]),
      });
      return { fileId, source: refOf(source), proposed: refOf(proposed) };
    },
    async getVersion(fileId: string, versionId: string) {
      const version = files.get(fileId)?.versions.get(versionId);
      return version === undefined ? undefined : { ref: refOf(version), bytes: new Uint8Array(0) };
    },
    async getPublished(fileId: string) {
      const file = files.get(fileId);
      if (file?.published == null) return undefined;
      const version = file.versions.get(file.published);
      return version === undefined ? undefined : refOf(version);
    },
    async getHead(fileId: string) {
      const file = files.get(fileId);
      if (file === undefined) return undefined;
      const version = file.versions.get(file.head);
      return version === undefined ? undefined : refOf(version);
    },
    async lookupOperation(operationId: string) {
      return operations.get(operationId);
    },
    async publish(input: {
      operationId: string;
      fileId: string;
      expectedPublishedVersionId: string | null;
      versionId: string;
      approvalId: string;
    }) {
      const existing = operations.get(input.operationId);
      if (existing !== undefined) return existing;
      const file = files.get(input.fileId);
      const version = file?.versions.get(input.versionId);
      if (file === undefined || version === undefined) throw new Error("NOT_FOUND");
      if (file.published !== input.expectedPublishedVersionId) throw new Error("VERSION_CONFLICT");
      const previous = file.published === null ? null : (file.versions.get(file.published) ?? null);
      const receipt: PublishReceipt = {
        kind: "publish",
        operationId: input.operationId,
        intentSha256: "c".repeat(64),
        approvalId: input.approvalId,
        previous: previous === null ? null : refOf(previous),
        published: refOf(version),
      };
      file.published = version.versionId;
      operations.set(input.operationId, receipt);
      return receipt;
    },
  };
  return store;
}

describe("the bare-harness portability of the review surface", () => {
  it("runs open, decide and publish against a store with no Office Hum host", async () => {
    const bare = bareStore();
    const root = await mkdtemp(join(tmpdir(), "officehum-review-bare-"));
    dirs.push(root);
    const seeded = await bare.seed("memo.docx", "d".repeat(64), "e".repeat(64));
    const gate = publicationGate({
      store: bare as unknown as VersionedFileStore,
      ledger: reviewLedger(join(root, "reviews")),
    });
    const identity: ReviewIdentity = {
      fileId: seeded.fileId,
      name: "memo.docx",
      format: "docx",
      source: artifact(seeded.source, "docx"),
      proposed: artifact(seeded.proposed, "docx"),
    };
    const evidence = reviewEvidenceFromWord({
      operation: "compare",
      sources: {
        from: {
          fileId: seeded.fileId,
          versionId: seeded.source.versionId,
          name: "memo.docx",
          sha256: seeded.source.sha256,
          size: seeded.source.size,
        },
        to: {
          fileId: seeded.fileId,
          versionId: seeded.proposed.versionId,
          name: "memo.docx",
          sha256: seeded.proposed.sha256,
          size: seeded.proposed.size,
        },
      },
      changeSet: {
        schema: "paper_word_change_set",
        version: 1,
        added: [],
        removed: [],
        changed: [
          {
            part: "word/document.xml",
            kind: "text",
            beforeSha256: seeded.source.sha256,
            afterSha256: seeded.proposed.sha256,
            semanticChange: true,
          },
        ],
        byteIdenticalCount: 1,
        semanticallyEmpty: false,
      },
      diff: {
        schema: "paper_word_diff",
        version: 1,
        changedLineCount: 1,
        stories: [{ story: "word/document.xml", diffLines: ["-a", "+b"], omittedLines: 0 }],
        truncated: false,
      },
      redline: {
        schema: "paper_word_redline",
        version: 1,
        insertedBlocks: 1,
        deletedBlocks: 0,
        entries: [
          {
            story: "word/document.xml",
            kind: "insert",
            index: 0,
            marker: "+",
            text: "b",
            truncated: false,
          },
        ],
        total: 1,
        truncated: false,
        pendingChangedLineCount: 1,
        pendingLines: ["+b"],
      },
      identical: false,
    });
    const opened = await gate.open({ identity, evidence });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await gate.decide({
      reviewId: opened.value.reviewId,
      verdict: "approved",
      by: "bare-operator",
      approvalId: "bare:1",
    });
    const published = await gate.publish({
      reviewId: opened.value.reviewId,
      operationId: "bare:publish:1",
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.value.receipt.published.versionId).toBe(seeded.proposed.versionId);
    expect((await bare.getPublished(seeded.fileId))?.versionId).toBe(seeded.proposed.versionId);
  });
});
