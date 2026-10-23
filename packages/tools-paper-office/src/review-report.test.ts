/**
 * The text a person reads. It must show the exact artifact identity, the evidence, and the limits of
 * that evidence — a limit presented as a pass is how a review stops being a review.
 */

import { expect, it } from "vitest";
import { type ReviewRecord, reviewBindingOf, reviewIdFor } from "./review.js";
import type { ReviewEvidence } from "./review-evidence.js";
import { REVIEW_EVIDENCE_SCHEMA, REVIEW_EVIDENCE_VERSION } from "./review-evidence.js";
import { reviewReport, reviewSummaryLine } from "./review-report.js";

const FROM = { versionId: "file_11111111111111111111111111", sha256: "1".repeat(64), size: 40 };
const TO = { versionId: "file_22222222222222222222222222", sha256: "2".repeat(64), size: 44 };
const FILE = "file_00000000000000000000000000";

const evidence: ReviewEvidence = {
  schema: REVIEW_EVIDENCE_SCHEMA,
  version: REVIEW_EVIDENCE_VERSION,
  format: "xlsx",
  identical: false,
  sources: {
    from: { versionId: FROM.versionId, sha256: FROM.sha256 },
    to: { versionId: TO.versionId, sha256: TO.sha256 },
  },
  changeSet: {
    added: [],
    removed: [],
    changed: [
      {
        part: "xl/worksheets/sheet1.xml",
        kind: "cells",
        beforeSha256: FROM.sha256,
        afterSha256: TO.sha256,
      },
    ],
    byteIdenticalCount: 3,
    semanticallyEmpty: false,
  },
  diff: { kind: "xlsx-cell-diff" },
  preview: { kind: "xlsx-numeric-and-references" },
  validation: {
    deterministic: true,
    checks: [
      { name: "recalculation-not-computed", ok: true, detail: "recalculation is unavailable here" },
    ],
    numeric: [{ name: "sum:Sheet1!B2", expected: "12.5", actual: "12.5", ok: true }],
    rubric: null,
  },
  limitations: ["no-recalculation: formulas are reported, not evaluated"],
};

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  const identity = {
    fileId: FILE,
    name: "budget.xlsx",
    format: "xlsx" as const,
    source: { fileId: FILE, ...FROM, name: "budget.xlsx", format: "xlsx" as const },
    proposed: { fileId: FILE, ...TO, name: "budget.xlsx", format: "xlsx" as const },
  };
  const binding = reviewBindingOf(identity, evidence);
  const reviewId = reviewIdFor(binding);
  return {
    reviewId,
    proposal: {
      kind: "proposal",
      schema: "officehum.paper.review",
      version: 1,
      reviewId,
      identity,
      binding,
      expectedPublishedVersionId: FROM.versionId,
      evidence,
      createdAt: "2026-10-23T12:00:00.000Z",
    },
    decision: null,
    publication: null,
    ...overrides,
  };
}

it("shows the exact artifact identity, both hashes, and the stated limits", () => {
  const lines = reviewReport(record()).join("\n");
  expect(lines).toContain("budget.xlsx (file_00000000000000000000000000) [xlsx]");
  expect(lines).toContain(`Source version (immutable): ${FROM.versionId} sha256 ${FROM.sha256}`);
  expect(lines).toContain(`Proposed version (immutable): ${TO.versionId} sha256 ${TO.sha256}`);
  expect(lines).toContain(`Expected published pointer: ${FROM.versionId}`);
  expect(lines).toContain("Deterministic checks: 1/1 hold [deterministic: yes]");
  expect(lines).toContain("Numeric checks: 1/1 agree");
  expect(lines).toContain("no-recalculation");
  expect(lines).toContain("Decision: none yet");
  expect(lines).toContain("Published: no");
});

it("reports the decision and the publication when they exist", () => {
  const base = record();
  const decided = record({
    decision: {
      kind: "decision",
      reviewId: base.reviewId,
      verdict: "approved",
      by: "azmat",
      approvalId: "approval:1",
      at: "2026-10-23T12:05:00.000Z",
      binding: base.proposal.binding,
    },
    publication: {
      kind: "published",
      reviewId: base.reviewId,
      operationId: "publish:1",
      receipt: {
        kind: "publish",
        operationId: "publish:1",
        intentSha256: "3".repeat(64),
        approvalId: "approval:1",
        previous: null,
        published: {
          id: FILE,
          versionId: TO.versionId,
          name: "budget.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: TO.size,
          sha256: TO.sha256,
          createdAt: "2026-10-23T12:00:00.000Z",
          metadata: { createdBy: "role:test", source: "derived" },
          sourceVersionId: FROM.versionId,
          operationId: "edit:1",
          context: null,
        },
      },
      at: "2026-10-23T12:06:00.000Z",
    },
  });
  const lines = reviewReport(decided).join("\n");
  expect(lines).toContain("Decision: approved by azmat (approval approval:1)");
  expect(lines).toContain(`Published: operation publish:1, unpublished -> ${TO.versionId}`);
  expect(reviewSummaryLine(decided)).toContain("published");
  expect(reviewSummaryLine(record())).toContain("pending");
});
