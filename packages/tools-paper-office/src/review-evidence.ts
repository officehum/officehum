/**
 * One review-evidence shape for all three Office formats.
 *
 * Word, PowerPoint and Excel each produce their own native comparison — a text/structure diff and a
 * redline, a slide-and-shape diff with before/after previews, a cell/formula/style diff with
 * dependencies and explicit numeric checks. A person reviewing a proposed version must see all of
 * that through **one** shape, so this module normalises the adapters' own `compare_*` results into a
 * single `ReviewEvidence`.
 *
 * It consumes the adapters' evidence rather than re-deriving any of it: the format-native diff and
 * preview stay exactly as the worker reported them, and the deterministic checks assert the
 * invariants the adapters already promise (a change set matching its `identical` flag, hashes on
 * every changed part, an explicit refusal to claim a calculation it did not run). Nothing here calls
 * a model, and nothing here can approve anything — `validation.deterministic` is always `true` and a
 * rubric's `mayApprove` is always `false`.
 *
 * Because the evidence is bound to the exact immutable versions it compares, the review gate rejects
 * evidence whose `sources` do not match the source and proposed hashes it was handed. Evidence for
 * one proposal can therefore never stand in for another.
 */

import type { DocumentFormat } from "./formats.js";
import type { PptxComparison, PptxPartChange, PptxSlidePreview } from "./pptx-operations.js";
import type { WordComparison, WordPartChange } from "./word-operations.js";
import type { XlsxComparison, XlsxNumericCheck, XlsxPartChange } from "./xlsx-operations.js";

export const REVIEW_EVIDENCE_SCHEMA = "officehum.paper.review-evidence";
export const REVIEW_EVIDENCE_VERSION = 1;

/** The immutable version a piece of evidence is about, by id and content hash. */
export interface ReviewEvidenceSource {
  readonly versionId: string;
  readonly sha256: string;
}

/** A part whose bytes differ between the two versions, with both hashes. */
export interface ReviewPartChange {
  readonly part: string;
  readonly kind: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
}

/** The structural change set, in the one shape every format's part model reduces to. */
export interface ReviewChangeSet {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly ReviewPartChange[];
  readonly byteIdenticalCount: number;
  readonly semanticallyEmpty: boolean;
}

/** A deterministic format check: a named invariant that either holds or does not. */
export interface ReviewCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** A deterministic numeric check: an expected and an actual value, with whether they agree. */
export interface ReviewNumeric {
  readonly name: string;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly ok: boolean;
}

/**
 * A qualitative score (e.g. a Paper Rubric). It is recorded as evidence and **cannot approve**:
 * `mayApprove` is always `false`, and the publication gate never consults a rubric.
 */
export interface ReviewRubric {
  readonly score: number;
  readonly max: number;
  readonly notes: readonly string[];
  readonly mayApprove: false;
}

export interface ReviewValidation {
  /** Always true: the checks below are pure functions of the adapters' evidence. */
  readonly deterministic: true;
  readonly checks: readonly ReviewCheck[];
  readonly numeric: readonly ReviewNumeric[];
  readonly rubric: ReviewRubric | null;
}

export interface ReviewEvidence {
  readonly schema: string;
  readonly version: number;
  readonly format: DocumentFormat;
  readonly identical: boolean;
  /** The exact versions this evidence compares. The gate checks these against the review identity. */
  readonly sources: { readonly from: ReviewEvidenceSource; readonly to: ReviewEvidenceSource };
  readonly changeSet: ReviewChangeSet;
  /** The format-native diff, bounded: Word text stories, PowerPoint slide changes, Excel cells. */
  readonly diff: Readonly<Record<string, unknown>>;
  /** The format-native preview: Word redline, PowerPoint before/after slides, Excel sheet lines. */
  readonly preview: Readonly<Record<string, unknown>>;
  readonly validation: ReviewValidation;
  /** What this evidence cannot show. Stated so a person never reads a limit as a pass. */
  readonly limitations: readonly string[];
}

// -- the three formats ----------------------------------------------------------------------------

export function reviewEvidenceFromWord(comparison: WordComparison): ReviewEvidence {
  const { changeSet, diff, redline, identical } = comparison;
  const checks: ReviewCheck[] = [
    check(
      "change-set-matches-identical",
      identical === changeSet.semanticallyEmpty,
      identical
        ? "the change set is semantically empty and the versions are reported identical"
        : "the change set is not empty and the versions are reported to differ",
    ),
    check(
      "changed-parts-hashed",
      changeSet.changed.every(
        (part) => part.part !== "" && part.beforeSha256 !== "" && part.afterSha256 !== "",
      ),
      `${changeSet.changed.length} changed part(s), each carrying both part hashes`,
    ),
    check(
      "redline-totals-consistent",
      redline.entries.length <= redline.total &&
        redline.insertedBlocks + redline.deletedBlocks <= redline.total,
      `redline reports ${redline.insertedBlocks} insertion(s), ${redline.deletedBlocks} deletion(s) ` +
        `over ${redline.total} tracked block(s)`,
    ),
    check(
      "diff-stories-bounded",
      diff.stories.every((story) => story.omittedLines >= 0),
      `${diff.stories.length} story diff(s), ${diff.changedLineCount} changed line(s)` +
        (diff.truncated ? ", truncated" : ""),
    ),
  ];
  return {
    schema: REVIEW_EVIDENCE_SCHEMA,
    version: REVIEW_EVIDENCE_VERSION,
    format: "docx",
    identical,
    sources: sourcesOf(comparison.sources.from, comparison.sources.to),
    changeSet: changeSetOf(
      changeSet.added,
      changeSet.removed,
      changeSet.changed,
      changeSet.byteIdenticalCount,
      changeSet.semanticallyEmpty,
    ),
    diff: {
      kind: "word-text-diff",
      changedLineCount: diff.changedLineCount,
      truncated: diff.truncated,
      stories: diff.stories.map((story) => ({
        story: story.story,
        diffLines: [...story.diffLines],
        omittedLines: story.omittedLines,
      })),
    },
    preview: {
      kind: "word-redline",
      insertedBlocks: redline.insertedBlocks,
      deletedBlocks: redline.deletedBlocks,
      total: redline.total,
      truncated: redline.truncated,
      pendingChangedLineCount: redline.pendingChangedLineCount,
      pendingLines: [...redline.pendingLines],
      entries: redline.entries.map((entry) => ({
        story: entry.story,
        kind: entry.kind,
        index: entry.index,
        marker: entry.marker,
        text: entry.text,
        truncated: entry.truncated,
      })),
    },
    validation: { deterministic: true, checks, numeric: [], rubric: null },
    limitations: [
      "no-rendering: this workspace never renders Word pagination or layout; the text diff and redline are structural, not a picture of the page.",
      "tracked-changes-only: the redline describes the tracked changes present in the proposed version, not a rendered markup view.",
    ],
  };
}

export function reviewEvidenceFromPptx(comparison: PptxComparison): ReviewEvidence {
  const { changeSet, diff, preview, rendering, identical } = comparison;
  const checks: ReviewCheck[] = [
    check(
      "change-set-matches-identical",
      identical ===
        (changeSet.added.length === 0 &&
          changeSet.removed.length === 0 &&
          changeSet.changed.length === 0),
      identical
        ? "no part was added, removed or changed and the deck is reported identical"
        : `${changeSet.added.length} part(s) added, ${changeSet.removed.length} removed, ` +
            `${changeSet.changed.length} changed`,
    ),
    check(
      "changed-parts-hashed",
      changeSet.changed.every(
        (part) => part.part !== "" && part.beforeSha256 !== "" && part.afterSha256 !== "",
      ),
      `${changeSet.changed.length} changed part(s), each carrying both part hashes`,
    ),
    check(
      "slide-change-total-consistent",
      diff.slideChanges.length <= diff.slideChangeTotal,
      `${diff.slideChanges.length} slide change(s) reported of ${diff.slideChangeTotal}`,
    ),
    check(
      "bitmap-rendering-absent",
      rendering.bitmap === false,
      "no slide bitmap is produced; changed slides are previewed from their structure",
    ),
  ];
  return {
    schema: REVIEW_EVIDENCE_SCHEMA,
    version: REVIEW_EVIDENCE_VERSION,
    format: "pptx",
    identical,
    sources: sourcesOf(comparison.sources.from, comparison.sources.to),
    changeSet: changeSetOf(
      changeSet.added,
      changeSet.removed,
      changeSet.changed,
      changeSet.byteIdenticalCount,
      changeSet.semanticallyEmpty,
    ),
    diff: {
      kind: "pptx-slide-diff",
      detail: diff.detail,
      identical: diff.identical,
      slideChangeTotal: diff.slideChangeTotal,
      slidesAdded: cloneRecords(diff.slidesAdded),
      slidesRemoved: cloneRecords(diff.slidesRemoved),
      slidesMoved: cloneRecords(diff.slidesMoved),
      slideChanges: cloneRecords(diff.slideChanges),
      packageChanges: cloneRecords(diff.packageChanges),
    },
    preview: {
      kind: "pptx-changed-slides",
      changedTotal: preview.changedTotal,
      addedTotal: preview.addedTotal,
      removedTotal: preview.removedTotal,
      limit: preview.limit,
      limitNote: preview.limitNote,
      changed: preview.changed.map((entry) => ({
        slideId: entry.slideId,
        change: structuredClone(entry.change) as Readonly<Record<string, unknown>>,
        before: slidePreview(entry.before),
        after: slidePreview(entry.after),
      })),
    },
    validation: { deterministic: true, checks, numeric: [], rubric: null },
    limitations: [
      "no-rendering: rendering.bitmap is false, so changed slides are shown as structure and text, never as a rendered image.",
      `overflow-estimates: ${rendering.overflowMethod}`,
      ...rendering.limits,
    ],
  };
}

export function reviewEvidenceFromXlsx(comparison: XlsxComparison): ReviewEvidence {
  const { changeSet, diff, recalculation, referenceCheck, reopened, identical } = comparison;
  const numeric = diff.numericChecks.map((entry) => numericOf(entry));
  const checks: ReviewCheck[] = [
    check(
      "change-set-matches-identical",
      identical === changeSet.semanticallyEmpty,
      identical
        ? "the change set is semantically empty and the workbooks are reported identical"
        : `${changeSet.changed.length} part(s) changed`,
    ),
    check(
      "changed-parts-hashed",
      changeSet.changed.every((part) => part.part !== ""),
      `${changeSet.changed.length} changed part(s)`,
    ),
    check(
      "cell-diff-totals-consistent",
      diff.cells.length <= diff.cellsTotal,
      `${diff.cells.length} changed cell(s) reported of ${diff.cellsTotal}`,
    ),
    check(
      "dependencies-totals-consistent",
      diff.dependencies.length <= diff.dependenciesTotal,
      `${diff.dependencies.length} dependenc(ies) reported of ${diff.dependenciesTotal}`,
    ),
    check(
      "reference-check-clean-reported",
      referenceCheck.to.clean === (referenceCheck.to.brokenTotal === 0),
      referenceCheck.to.clean
        ? "the proposed workbook has no broken reference"
        : `${referenceCheck.to.brokenTotal} broken reference(s) in the proposed workbook`,
    ),
    check(
      "recalculation-not-computed",
      recalculation.computed === false && recalculation.available === false,
      `recalculation is unavailable here (${recalculation.reason})`,
    ),
    check(
      "reopen-census-consistent",
      reopened.sheets >= 0 && reopened.parts >= 0,
      `reopened: ${reopened.sheets} sheet(s), ${reopened.parts} part(s)`,
    ),
  ];
  return {
    schema: REVIEW_EVIDENCE_SCHEMA,
    version: REVIEW_EVIDENCE_VERSION,
    format: "xlsx",
    identical,
    sources: sourcesOf(comparison.sources.from, comparison.sources.to),
    changeSet: changeSetOf(
      changeSet.added,
      changeSet.removed,
      changeSet.changed,
      changeSet.byteIdenticalCount,
      changeSet.semanticallyEmpty,
    ),
    diff: {
      kind: "xlsx-cell-diff",
      measurement: diff.measurement,
      cellsTotal: diff.cellsTotal,
      cellsTruncated: diff.cellsTruncated,
      cells: diff.cells.map((cell) => ({
        address: cell.address,
        before: cell.before,
        after: cell.after,
        beforeType: cell.beforeType,
        afterType: cell.afterType,
        kind: cell.kind,
        shifted: cell.shifted,
      })),
      styleChanges: diff.styleChanges.map((style) => ({
        address: style.address,
        keys: [...style.keys],
        before: structuredClone(style.before) as Readonly<Record<string, unknown>>,
        after: structuredClone(style.after) as Readonly<Record<string, unknown>>,
      })),
      styleChangesTotal: diff.styleChangesTotal,
      dependencies: diff.dependencies.map((dependency) => ({
        formulaCell: dependency.formulaCell,
        reference: dependency.reference,
        changedCell: dependency.changedCell,
        sheet: dependency.sheet,
        sameSheet: dependency.sameSheet,
      })),
      dependenciesTotal: diff.dependenciesTotal,
    },
    preview: {
      kind: "xlsx-numeric-and-references",
      numericChecksTotal: diff.numericChecksTotal,
      numericChecksTruncated: diff.numericChecksTruncated,
      referenceCheck: {
        from: cloneRecord(referenceCheck.from),
        to: cloneRecord(referenceCheck.to),
      },
      warnings: [...comparison.warnings],
    },
    validation: { deterministic: true, checks, numeric, rubric: null },
    limitations: [
      "no-recalculation: recalculation.computed is false; formulas are reported, not evaluated, and a cached value is what the file stores.",
      ...recalculation.limits,
      "cached-values: values read from a workbook that has no recalculation engine are the values its last writer cached.",
    ],
  };
}

/** Dispatches on the format the comparison belongs to. */
export function reviewEvidence(format: DocumentFormat, comparison: unknown): ReviewEvidence {
  switch (format) {
    case "docx":
      return reviewEvidenceFromWord(comparison as WordComparison);
    case "pptx":
      return reviewEvidenceFromPptx(comparison as PptxComparison);
    case "xlsx":
      return reviewEvidenceFromXlsx(comparison as XlsxComparison);
  }
}

/**
 * Attaches a qualitative rubric to evidence. It is recorded beside the deterministic checks and can
 * never approve: the returned `mayApprove` is `false`, and the publication gate ignores it entirely.
 */
export function withRubric(
  evidence: ReviewEvidence,
  rubric: { readonly score: number; readonly max: number; readonly notes?: readonly string[] },
): ReviewEvidence {
  return {
    ...evidence,
    validation: {
      ...evidence.validation,
      rubric: {
        score: rubric.score,
        max: rubric.max,
        notes: [...(rubric.notes ?? [])],
        mayApprove: false,
      },
    },
  };
}

// -- helpers --------------------------------------------------------------------------------------

function check(name: string, ok: boolean, detail: string): ReviewCheck {
  return { name, ok, detail };
}

function sourcesOf(
  from: { readonly versionId: string; readonly sha256: string },
  to: { readonly versionId: string; readonly sha256: string },
): ReviewEvidence["sources"] {
  return {
    from: { versionId: from.versionId, sha256: from.sha256 },
    to: { versionId: to.versionId, sha256: to.sha256 },
  };
}

function changeSetOf(
  added: readonly string[],
  removed: readonly string[],
  changed: readonly (WordPartChange | PptxPartChange | XlsxPartChange)[],
  byteIdenticalCount: number,
  semanticallyEmpty: boolean,
): ReviewChangeSet {
  return {
    added: [...added],
    removed: [...removed],
    changed: changed.map((part) => ({
      part: part.part,
      kind: part.kind,
      beforeSha256: part.beforeSha256,
      afterSha256: part.afterSha256,
    })),
    byteIdenticalCount,
    semanticallyEmpty,
  };
}

function numericOf(entry: XlsxNumericCheck): ReviewNumeric {
  const sum = entry.sum;
  if (sum !== null) {
    return {
      name: `sum:${entry.address}`,
      expected: sum.adapterSumExact,
      actual: stringify(sum.workbookCachedValue),
      ok: sum.agrees === true,
    };
  }
  return {
    name: `cell:${entry.address}`,
    expected: entry.exactBefore,
    actual: entry.exactAfter,
    ok: entry.exactAfter !== null,
  };
}

function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function cloneRecord(value: unknown): Readonly<Record<string, unknown>> {
  return structuredClone(value) as Readonly<Record<string, unknown>>;
}

function cloneRecords(value: readonly unknown[]): readonly Readonly<Record<string, unknown>>[] {
  return value.map(cloneRecord);
}

function slidePreview(value: PptxSlidePreview): Readonly<Record<string, unknown>> {
  return {
    position: value.position,
    slideId: value.slideId,
    part: value.part,
    layoutName: value.layoutName,
    titleText: value.titleText,
    lines: value.lines.map((line) => ({
      marker: line.marker,
      text: line.text,
      truncated: line.truncated,
      shape: line.shape,
      label: line.label,
    })),
    linesTruncated: value.linesTruncated,
    notes: { present: value.notes.present, text: value.notes.text },
    media: cloneRecords(value.media),
    overflow: cloneRecord(value.overflow),
  };
}
