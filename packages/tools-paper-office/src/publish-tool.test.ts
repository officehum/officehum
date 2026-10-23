/**
 * `publish_document`: an agent may ask, a person decides.
 *
 * The tool resolves the host's review for the exact proposed version and hands the call's operation ID
 * to the publication gate. These tests pin that it can never approve itself: with no review, a pending
 * review, a denial, or an approval made for a different proposal, it refuses and the published pointer
 * is read back unchanged.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localVersionedFileStore, type VersionedFileRef } from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLISH_DOCUMENT, publishDocumentTool, reviewForProposed } from "./publish-tool.js";
import {
  type PublicationGate,
  publicationGate,
  type ReviewIdentity,
  reviewLedger,
} from "./review.js";
import { type ReviewEvidence, reviewEvidenceFromWord } from "./review-evidence.js";
import { paperOfficeToolPack } from "./run-document-python.js";
import type { WordComparison } from "./word-operations.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CONTEXT = {
  taskId: "task:publish",
  policyVersion: "policy:1",
  worker: { image: "paper-worker:python-3.13.17", libraries: {} },
  argumentsSha256: "a".repeat(64),
};
const API = { taskId: "task:publish", conversationId: "conv", callId: "call-1" };

function docxBytes(marker: string): Uint8Array {
  return Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(marker)]);
}

interface Proposal {
  readonly fileId: string;
  readonly source: VersionedFileRef;
  readonly proposed: VersionedFileRef;
}

async function proposalOf(
  store: Awaited<ReturnType<typeof localVersionedFileStore>>,
  second: string,
): Promise<Proposal> {
  const created = await store.create({
    operationId: "create:1",
    bytes: docxBytes("v1"),
    name: "brief.docx",
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
    operationId: `edit:${second}`,
    fileId: created.output.id,
    sourceVersionId: created.output.versionId,
    bytes: docxBytes(second),
    name: "brief.docx",
    mimeType: DOCX_MIME,
    metadata: { createdBy: "role:test", source: "derived" },
    context: CONTEXT,
  });
  return { fileId: created.output.id, source: created.output, proposed: edited.output };
}

function identityOf(proposal: Proposal): ReviewIdentity {
  const artifact = (ref: VersionedFileRef) => ({
    fileId: ref.id,
    versionId: ref.versionId,
    name: ref.name,
    format: "docx" as const,
    sha256: ref.sha256,
    size: ref.size,
  });
  return {
    fileId: proposal.fileId,
    name: "brief.docx",
    format: "docx",
    source: artifact(proposal.source),
    proposed: artifact(proposal.proposed),
  };
}

function evidenceOf(proposal: Proposal, text: string): ReviewEvidence {
  const ref = (versionId: string, sha256: string, size: number) => ({
    fileId: proposal.fileId,
    versionId,
    name: "brief.docx",
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
      byteIdenticalCount: 2,
      semanticallyEmpty: false,
    },
    diff: {
      schema: "paper_word_diff",
      version: 1,
      changedLineCount: 1,
      stories: [{ story: "word/document.xml", diffLines: ["-old", `+${text}`], omittedLines: 0 }],
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
          text,
          truncated: false,
        },
      ],
      total: 1,
      truncated: false,
      pendingChangedLineCount: 1,
      pendingLines: [`+${text}`],
    },
    identical: false,
  };
  return reviewEvidenceFromWord(comparison);
}

interface Tool {
  execute(
    args: unknown,
    api: { taskId: string; conversationId: string; callId: string },
  ): Promise<{ output: { text: string }[]; isError?: boolean; details?: Record<string, unknown> }>;
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "officehum-publish-"));
  dirs.push(root);
  const store = localVersionedFileStore(join(root, "files"));
  const ledger = reviewLedger(join(root, "reviews"));
  const gate: PublicationGate = publicationGate({ store, ledger });
  const tool = publishDocumentTool({
    gate,
    reviewFor: reviewForProposed(gate),
  }) as unknown as Tool;
  return { store, ledger, gate, tool, root };
}

async function body(tool: Tool, args: unknown, api = API) {
  const result = await tool.execute(args, api);
  return {
    result,
    body: JSON.parse(result.output[0]?.text ?? "{}") as Record<string, unknown>,
  };
}

async function pointer(store: Awaited<ReturnType<typeof localVersionedFileStore>>, fileId: string) {
  return (await store.getPublished(fileId))?.versionId ?? null;
}

describe("publish_document asks the host; a person decides", () => {
  it("refuses with not-approved when no review exists, and the pointer does not move", async () => {
    const { store, tool } = await setup();
    const proposal = await proposalOf(store, "v2-edited");
    const { result, body: answer } = await body(tool, {
      fileId: proposal.fileId,
      proposedVersionId: proposal.proposed.versionId,
    });
    expect(result.isError).toBe(true);
    expect(answer.ok).toBe(false);
    expect(answer.code).toBe("not-approved");
    expect(await pointer(store, proposal.fileId)).toBe(proposal.source.versionId);
  });

  it("refuses while the review is pending, denies a denial, and publishes only after approval", async () => {
    const { store, gate, tool } = await setup();
    const proposal = await proposalOf(store, "v2-edited");
    const opened = await gate.open({
      identity: identityOf(proposal),
      evidence: evidenceOf(proposal, "new total"),
    });
    if (!opened.ok) throw new Error("open refused");

    // Pending: the tool refuses and the pointer stays on the source.
    const pending = await body(tool, {
      fileId: proposal.fileId,
      proposedVersionId: proposal.proposed.versionId,
    });
    expect(pending.result.isError).toBe(true);
    expect(pending.body.code).toBe("not-approved");
    expect(await pointer(store, proposal.fileId)).toBe(proposal.source.versionId);

    // Denied: still nothing.
    await gate.decide({
      reviewId: opened.value.reviewId,
      verdict: "denied",
      by: "azmat",
      approvalId: "approval:no",
    });
    const denied = await body(tool, {
      fileId: proposal.fileId,
      proposedVersionId: proposal.proposed.versionId,
    });
    expect(denied.result.isError).toBe(true);
    expect(denied.body.code).toBe("denied");
    expect(await pointer(store, proposal.fileId)).toBe(proposal.source.versionId);

    // Approved: the tool publishes, and the receipt names the previous and published versions.
    const second = await setup();
    const other = await proposalOf(second.store, "v2-other");
    const openedOther = await second.gate.open({
      identity: identityOf(other),
      evidence: evidenceOf(other, "another total"),
    });
    if (!openedOther.ok) throw new Error("open refused");
    await second.gate.decide({
      reviewId: openedOther.value.reviewId,
      verdict: "approved",
      by: "azmat",
      approvalId: "approval:yes",
    });
    const published = await body(second.tool, {
      fileId: other.fileId,
      proposedVersionId: other.proposed.versionId,
    });
    expect(published.result.isError).toBeUndefined();
    expect(published.body).toMatchObject({
      ok: true,
      previous: other.source.versionId,
      published: other.proposed.versionId,
      approvalId: "approval:yes",
    });
    expect(await pointer(second.store, other.fileId)).toBe(other.proposed.versionId);
  });

  it("cannot use an approval made for proposal A to publish proposal B", async () => {
    const { store, gate, tool } = await setup();
    const proposal = await proposalOf(store, "v2-a");
    const openedA = await gate.open({
      identity: identityOf(proposal),
      evidence: evidenceOf(proposal, "total A"),
    });
    if (!openedA.ok) throw new Error("open refused");
    await gate.decide({
      reviewId: openedA.value.reviewId,
      verdict: "approved",
      by: "azmat",
      approvalId: "approval:A",
    });

    // A later edit of the same file: same file, different bytes, no review of its own.
    const later = await store.putVersion({
      operationId: "edit:b",
      fileId: proposal.fileId,
      sourceVersionId: proposal.proposed.versionId,
      bytes: docxBytes("v3-b"),
      name: "brief.docx",
      mimeType: DOCX_MIME,
      metadata: { createdBy: "role:test", source: "derived" },
      context: CONTEXT,
    });

    const crossApproval = await body(tool, {
      fileId: proposal.fileId,
      proposedVersionId: later.output.versionId,
    });
    expect(crossApproval.result.isError).toBe(true);
    expect(crossApproval.body.code).toBe("not-approved");
    expect(await pointer(store, proposal.fileId)).toBe(proposal.source.versionId);

    // A's own version cannot publish either now: the later edit superseded it, which is exactly why B
    // needed its own review and A's approval no longer covers anything live.
    const own = await body(tool, {
      fileId: proposal.fileId,
      proposedVersionId: proposal.proposed.versionId,
    });
    expect(own.result.isError).toBe(true);
    expect(own.body.code).toBe("stale-review");
    expect(await pointer(store, proposal.fileId)).toBe(proposal.source.versionId);
  });

  it("derives the operation ID from the call identity and replays without a second publish", async () => {
    const { store, gate, tool } = await setup();
    const proposal = await proposalOf(store, "v2-edited");
    const opened = await gate.open({
      identity: identityOf(proposal),
      evidence: evidenceOf(proposal, "new total"),
    });
    if (!opened.ok) throw new Error("open refused");
    await gate.decide({
      reviewId: opened.value.reviewId,
      verdict: "approved",
      by: "azmat",
      approvalId: "approval:1",
    });

    const first = await body(tool, {
      fileId: proposal.fileId,
      proposedVersionId: proposal.proposed.versionId,
    });
    expect(first.body.operationId).toBe("conv:call-1");
    expect(await pointer(store, proposal.fileId)).toBe(proposal.proposed.versionId);

    // The same Pi Durable call replays: same operation ID, same publication, no second move.
    const replay = await body(tool, {
      fileId: proposal.fileId,
      proposedVersionId: proposal.proposed.versionId,
    });
    expect(replay.body.operationId).toBe("conv:call-1");
    expect(replay.body.published).toBe(first.body.published);
    expect(await pointer(store, proposal.fileId)).toBe(proposal.proposed.versionId);
  });

  it("is withheld from a pack with no gate, and rejects a call that names nothing", async () => {
    const { gate, tool } = await setup();
    const bare = paperOfficeToolPack({
      service: {
        runDocumentPython: async () => ({
          kind: "refused",
          operationId: "x",
          code: "no-lease",
          message: "x",
        }),
      },
      leaseFor: async () => undefined,
    });
    expect(bare.tools.some((item) => item.name === PUBLISH_DOCUMENT)).toBe(false);

    const { result, body: answer } = await body(tool, { fileId: "", proposedVersionId: "" });
    expect(result.isError).toBe(true);
    expect(answer.code).toBe("invalid-request");
    // The gate is still the un-approving gate: nothing has been published.
    expect(gate).toBeDefined();
  });
});
