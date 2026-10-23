/**
 * The one evidence shape, for all three formats.
 *
 * Each format keeps its own native evidence — the Word diff and redline, the presentation's
 * before/after slide previews, the workbook's cells, dependencies and numeric checks — but a person
 * sees it through one shape. These tests pin that shape, that the deterministic checks actually
 * bite, and that a rubric can never approve.
 */

import { expect, it } from "vitest";
import type { PptxComparison, PptxSlidePreview } from "./pptx-operations.js";
import {
  reviewEvidence,
  reviewEvidenceFromPptx,
  reviewEvidenceFromWord,
  reviewEvidenceFromXlsx,
  withRubric,
} from "./review-evidence.js";
import type { WordComparison } from "./word-operations.js";
import type {
  XlsxComparison,
  XlsxNumericCheck,
  XlsxPreservation,
  XlsxRecalculation,
  XlsxReferenceCheck,
  XlsxReopened,
} from "./xlsx-operations.js";

const FROM = { versionId: "file_11111111111111111111111111", sha256: "1".repeat(64), size: 40 };
const TO = { versionId: "file_22222222222222222222222222", sha256: "2".repeat(64), size: 44 };
const FILE = "file_00000000000000000000000000";

function wordComparison(
  overrides: { identical?: boolean; semanticallyEmpty?: boolean } = {},
): WordComparison {
  const ref = (version: { versionId: string; sha256: string; size: number }) => ({
    fileId: FILE,
    versionId: version.versionId,
    name: "brief.docx",
    sha256: version.sha256,
    size: version.size,
  });
  return {
    operation: "compare",
    sources: { from: ref(FROM), to: ref(TO) },
    changeSet: {
      schema: "paper_word_change_set",
      version: 1,
      added: [],
      removed: [],
      changed: [
        {
          part: "word/document.xml",
          kind: "text",
          beforeSha256: FROM.sha256,
          afterSha256: TO.sha256,
          semanticChange: true,
        },
      ],
      byteIdenticalCount: 5,
      semanticallyEmpty: overrides.semanticallyEmpty ?? false,
    },
    diff: {
      schema: "paper_word_diff",
      version: 1,
      changedLineCount: 1,
      stories: [
        { story: "word/document.xml", diffLines: ["-old total", "+new total"], omittedLines: 0 },
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
          text: "new total",
          truncated: false,
        },
      ],
      total: 1,
      truncated: false,
      pendingChangedLineCount: 1,
      pendingLines: ["+new total"],
    },
    identical: overrides.identical ?? false,
  };
}

function slidePreview(title: string, body: string): PptxSlidePreview {
  return {
    position: 0,
    slideId: 2,
    part: "ppt/slides/slide1.xml",
    layoutName: "Title and Content",
    titleText: title,
    lines: [{ marker: "=", text: body, truncated: false, shape: "body", label: "Body" }],
    linesTruncated: false,
    notes: { present: false, text: null },
    media: [],
    overflow: {
      summary: { shapes: 1, overflowing: 0, compensated: 0, unresolved: 0 },
      items: [],
    },
  };
}

function pptxComparison(): PptxComparison {
  const ref = (version: { versionId: string; sha256: string; size: number }) => ({
    fileId: FILE,
    versionId: version.versionId,
    name: "deck.pptx",
    sha256: version.sha256,
    size: version.size,
  });
  return {
    operation: "compare",
    sources: { from: ref(FROM), to: ref(TO) },
    changeSet: {
      schema: "paper_pptx_change_set",
      version: 1,
      added: [],
      removed: [],
      changed: [
        {
          part: "ppt/slides/slide1.xml",
          kind: "text",
          change: "modified",
          detail: "body text replaced",
          beforeSha256: FROM.sha256,
          afterSha256: TO.sha256,
          semanticChange: true,
        },
      ],
      byteIdenticalCount: 12,
      partCountBefore: 14,
      partCountAfter: 14,
      semanticallyEmpty: false,
    },
    diff: {
      schema: "paper_pptx_diff",
      version: 1,
      detail: "every story",
      slidesAdded: [],
      slidesRemoved: [],
      slidesMoved: [],
      slideChanges: [{ slideId: 2, kind: "text" }],
      slideChangeTotal: 1,
      packageChanges: [],
      identical: false,
    },
    preview: {
      changed: [
        {
          slideId: 2,
          change: { slideId: 2, kind: "text" },
          before: slidePreview("Old title", "old body"),
          after: slidePreview("New title", "new body"),
        },
      ],
      changedTotal: 1,
      added: [],
      addedTotal: 0,
      removed: [],
      removedTotal: 0,
      moved: [],
      limit: 20,
      limitNote: "at most 20 changed slides",
    },
    identical: false,
    rendering: {
      bitmap: false,
      method: "structural",
      overflowMethod: "text-metric estimate",
      constants: { pointsPerInch: 72 },
      limits: ["no bitmap rendering in this workspace"],
      isolation: "subprocess",
    },
  };
}

function numericCheck(): XlsxNumericCheck {
  return {
    address: "Sheet1!B2",
    kind: "formula-result",
    before: 10,
    after: 12.5,
    exactBefore: "10",
    exactAfter: "12.5",
    delta: 2.5,
    deltaExact: "2.5",
    method: "decimal-string",
    note: null,
    sum: {
      function: "SUM",
      range: "Sheet1!A1:A3",
      adapterSum: 12.5,
      adapterSumExact: "12.5",
      cells: ["Sheet1!A1", "Sheet1!A2", "Sheet1!A3"],
      cellsTruncated: false,
      blankCells: 0,
      nonNumericCells: [],
      workbookCachedValue: 12.5,
      workbookCachedKnown: true,
      agrees: true,
      reason: null,
    },
  };
}

function xlsxPreservation(): XlsxPreservation {
  return {
    byteIdenticalCount: 3,
    byteIdentical: [],
    byteIdenticalTruncated: false,
    byteIdenticalHashed: 0,
    changedParts: ["xl/worksheets/sheet1.xml"],
    addedParts: [],
    removedParts: [],
    worksheetByteIdentical: [],
    chartByteIdentical: [],
    mediaByteIdentical: [],
    themeByteIdentical: [],
    styleByteIdentical: [],
    drawingByteIdentical: [],
    pivotByteIdentical: [],
    verbatimCopy: false,
  };
}

function xlsxReferenceCheck(clean: boolean): XlsxReferenceCheck {
  return {
    checkedReferences: 4,
    checkedSurfaces: 2,
    kinds: { sheet: 4 },
    broken: [],
    brokenTotal: clean ? 0 : 1,
    brokenTruncated: false,
    brokenKinds: [],
    unscannable: [],
    clean,
    scope: "workbook",
    partsScanned: 2,
  };
}

function xlsxRecalculation(): XlsxRecalculation {
  return {
    available: false,
    attempted: false,
    computed: false,
    engine: "none",
    engineInProcess: false,
    processSpawned: false,
    reason: "no recalculation engine runs in this workspace",
    unsupportedFunctions: [],
    unsupportedFunctionCount: 0,
    limits: ["values are the workbook's cached values"],
    limitsNote: "report the limit, never claim a calculation",
    workbookRequest: {},
  };
}

function xlsxReopened(): XlsxReopened {
  return {
    sheets: 1,
    cells: 8,
    formulas: 2,
    namedRanges: 0,
    styledCells: 1,
    tables: 0,
    charts: 0,
    chartParts: 0,
    parts: 5,
    referenceCheck: 4,
  };
}

function xlsxComparison(): XlsxComparison {
  const ref = (version: { versionId: string; sha256: string; size: number }) => ({
    fileId: FILE,
    versionId: version.versionId,
    name: "budget.xlsx",
    sha256: version.sha256,
    size: version.size,
  });
  return {
    operation: "compare",
    sources: { from: ref(FROM), to: ref(TO) },
    changeSet: {
      schema: "paper_xlsx_change_set",
      version: 1,
      added: [],
      removed: [],
      changed: [
        {
          part: "xl/worksheets/sheet1.xml",
          kind: "cells",
          detail: ["B2"],
          detailTotal: 1,
          beforeSha256: FROM.sha256,
          afterSha256: TO.sha256,
          semanticChange: true,
        },
      ],
      byteIdentical: [],
      byteIdenticalCount: 3,
      partCountBefore: 5,
      partCountAfter: 5,
      semanticallyEmpty: false,
    },
    preservation: xlsxPreservation(),
    diff: {
      measurement: "exact decimal strings",
      cells: [
        {
          address: "Sheet1!B2",
          before: 10,
          after: 12.5,
          beforeType: "number",
          afterType: "number",
          kind: "changed",
          shifted: false,
        },
      ],
      cellsTotal: 1,
      cellsTruncated: false,
      styleChanges: [],
      styleChangesTotal: 0,
      dependencies: [
        {
          formulaCell: "Sheet1!B3",
          reference: "Sheet1!B2",
          changedCell: "Sheet1!B2",
          sheet: "Sheet1",
          sameSheet: true,
        },
      ],
      dependenciesTotal: 1,
      numericChecks: [numericCheck()],
      numericChecksTotal: 1,
      numericChecksTruncated: false,
      identical: false,
    },
    referenceCheck: { from: xlsxReferenceCheck(true), to: xlsxReferenceCheck(true) },
    recalculation: xlsxRecalculation(),
    reopened: xlsxReopened(),
    warnings: [],
    identical: false,
  };
}

it("presents Word evidence through the one shape", () => {
  const evidence = reviewEvidenceFromWord(wordComparison());
  expect(evidence.format).toBe("docx");
  expect(evidence.schema).toMatch(/^officehum\.paper\.review-evidence$/u);
  expect(evidence.validation.deterministic).toBe(true);
  expect(evidence.sources).toEqual({
    from: { versionId: FROM.versionId, sha256: FROM.sha256 },
    to: { versionId: TO.versionId, sha256: TO.sha256 },
  });
  expect(evidence.changeSet.changed[0]?.part).toBe("word/document.xml");
  expect(evidence.diff.kind).toBe("word-text-diff");
  expect(evidence.preview.kind).toBe("word-redline");
  expect(evidence.validation.checks.every((entry) => entry.ok)).toBe(true);
  expect(evidence.limitations.join(" ")).toMatch(/no-rendering/u);
});

it("presents PowerPoint evidence with changed-slide previews and a stated bitmap limit", () => {
  const evidence = reviewEvidenceFromPptx(pptxComparison());
  expect(evidence.format).toBe("pptx");
  expect(evidence.preview.kind).toBe("pptx-changed-slides");
  const changed = evidence.preview.changed as readonly { before: unknown; after: unknown }[];
  expect(changed).toHaveLength(1);
  expect(
    evidence.validation.checks.find((entry) => entry.name === "bitmap-rendering-absent")?.ok,
  ).toBe(true);
  expect(evidence.limitations.join(" ")).toMatch(/bitmap is false/u);
});

it("presents Excel evidence with numeric checks and an explicit recalculation limit", () => {
  const evidence = reviewEvidenceFromXlsx(xlsxComparison());
  expect(evidence.format).toBe("xlsx");
  expect(evidence.diff.kind).toBe("xlsx-cell-diff");
  expect(evidence.validation.numeric).toHaveLength(1);
  expect(evidence.validation.numeric[0]).toMatchObject({
    name: "sum:Sheet1!B2",
    expected: "12.5",
    actual: "12.5",
    ok: true,
  });
  expect(
    evidence.validation.checks.find((entry) => entry.name === "recalculation-not-computed")?.ok,
  ).toBe(true);
  expect(evidence.limitations.join(" ")).toMatch(/no-recalculation/u);
});

it("dispatches on the format and is deterministic", () => {
  expect(reviewEvidence("docx", wordComparison()).format).toBe("docx");
  expect(reviewEvidence("pptx", pptxComparison()).format).toBe("pptx");
  expect(reviewEvidence("xlsx", xlsxComparison()).format).toBe("xlsx");
  // The same evidence twice is byte-for-byte the same evidence.
  expect(reviewEvidenceFromXlsx(xlsxComparison())).toEqual(
    reviewEvidenceFromXlsx(xlsxComparison()),
  );
  expect(JSON.stringify(reviewEvidenceFromWord(wordComparison()))).toBe(
    JSON.stringify(reviewEvidenceFromWord(wordComparison())),
  );
});

it("reports a deterministic check that does not hold, rather than smoothing it over", () => {
  // A change set that is not semantically empty while the comparison claims the versions are
  // identical is a contradiction the check must surface.
  const evidence = reviewEvidenceFromWord(
    wordComparison({ identical: true, semanticallyEmpty: false }),
  );
  const check = evidence.validation.checks.find(
    (entry) => entry.name === "change-set-matches-identical",
  );
  expect(check?.ok).toBe(false);
});

it("records a rubric as evidence only, and it can never approve", () => {
  const plain = reviewEvidenceFromWord(wordComparison());
  const scored = withRubric(plain, { score: 8, max: 10, notes: ["clear"] });
  expect(scored.validation.rubric).toEqual({
    score: 8,
    max: 10,
    notes: ["clear"],
    mayApprove: false,
  });
  // Attaching a rubric must not disturb the deterministic evidence.
  expect(scored.changeSet).toEqual(plain.changeSet);
  expect(scored.validation.checks).toEqual(plain.validation.checks);
});
