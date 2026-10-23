/**
 * Producing review evidence from the adapters, through the injected `DocumentService`.
 *
 * The evidence a person reviews must come from the format adapters themselves — the Word text diff
 * and redline, the presentation's changed-slide previews and shape/media diff, the workbook's
 * changed cells, formulas and styles with their dependencies and numeric checks. This module runs
 * each format's own `compare_*` program through the same service the typed tools use, so a review is
 * derived from the immutable source and proposed versions and nothing else. It writes nothing: a
 * comparison is read-only, and a refusal leaves the sources byte-identical.
 */

import type { DocumentService } from "./document-service.js";
import { DocumentError } from "./errors.js";
import type { DocumentFormat } from "./formats.js";
import { type DocumentLease, findLeasedInput, type LeasedInput } from "./lease.js";
import { parsePptxResult, pptxProgram, pptxResultRef } from "./pptx-operations.js";
import type { ReviewResult } from "./review.js";
import type { ReviewEvidence } from "./review-evidence.js";
import {
  reviewEvidenceFromPptx,
  reviewEvidenceFromWord,
  reviewEvidenceFromXlsx,
} from "./review-evidence.js";
import { messageOf } from "./validate.js";
import { parseWordResult, wordProgram, wordResultRef } from "./word-operations.js";
import { parseXlsxResult, xlsxProgram, xlsxResultRef } from "./xlsx-operations.js";

export interface ReviewCompareRequest {
  /** Stable across a crash and its replay: derived by the host, never by a model. */
  readonly operationId: string;
  readonly taskId: string;
  /**
   * The task's lease. It must grant **both** the source and the proposed version. The worker stages
   * each input under its lease name, so the two versions of one file cannot share a name:
   * `reviewLeaseInputs` derives a distinct staged name for the proposal.
   */
  readonly lease: DocumentLease;
  readonly sourceVersionId: string;
  readonly proposedVersionId: string;
  readonly format: DocumentFormat;
}

/**
 * The two lease entries a review compare needs. The worker stages an input under its lease name and
 * refuses two inputs with one name, so a proposed version of the same file is staged under a name
 * derived from its version id. Both versions stay read-only: a comparison writes nothing.
 */
export function reviewLeaseInputs(
  source: LeasedInput,
  proposed: LeasedInput,
): readonly [LeasedInput, LeasedInput] {
  if (source.versionId === proposed.versionId) {
    throw new DocumentError("invalid-request", "a review cannot compare a version with itself");
  }
  if (source.format !== proposed.format) {
    throw new DocumentError("invalid-request", "a review cannot compare two different formats");
  }
  return [source, { ...proposed, name: stagedName(proposed) }];
}

function stagedName(input: LeasedInput): string {
  const dot = input.name.lastIndexOf(".");
  const base = dot === -1 ? input.name : input.name.slice(0, dot);
  const extension = dot === -1 ? "" : input.name.slice(dot);
  return `${base}.${input.versionId.slice(-8)}${extension}`;
}

/** Runs the format's own comparison and normalises its result into the one evidence shape. */
export async function reviewEvidenceFromService(
  service: DocumentService,
  request: ReviewCompareRequest,
): Promise<ReviewResult<ReviewEvidence>> {
  try {
    const from = refArgument(requireLeased(request.lease, request.sourceVersionId, "source"));
    const to = refArgument(requireLeased(request.lease, request.proposedVersionId, "proposed"));
    const args = { from, to };

    switch (request.format) {
      case "docx": {
        const program = wordProgram("compare", args, request.lease);
        return await compare(service, request, program, (result) => {
          const parsed = parseWordResult("compare", result, program.sources.map(wordResultRef));
          return parsed.operation === "compare" ? reviewEvidenceFromWord(parsed) : null;
        });
      }
      case "pptx": {
        const program = pptxProgram("compare", args, request.lease);
        return await compare(service, request, program, (result) => {
          const parsed = parsePptxResult("compare", result, program.sources.map(pptxResultRef));
          return parsed.operation === "compare" ? reviewEvidenceFromPptx(parsed) : null;
        });
      }
      case "xlsx": {
        const program = xlsxProgram("compare", args, request.lease);
        return await compare(service, request, program, (result) => {
          const parsed = parseXlsxResult("compare", result, program.sources.map(xlsxResultRef));
          return parsed.operation === "compare" ? reviewEvidenceFromXlsx(parsed) : null;
        });
      }
    }
  } catch (error) {
    return failure(error);
  }
}

async function compare(
  service: DocumentService,
  request: ReviewCompareRequest,
  program: { readonly code: string; readonly arguments: Readonly<Record<string, unknown>> },
  build: (result: unknown) => ReviewEvidence | null,
): Promise<ReviewResult<ReviewEvidence>> {
  const outcome = await service.runDocumentPython({
    operationId: request.operationId,
    taskId: request.taskId,
    lease: request.lease,
    code: program.code,
    arguments: program.arguments,
  });
  if (outcome.kind === "refused") {
    return { ok: false, code: outcome.code, message: outcome.message };
  }
  const evidence = build(outcome.receipt.result);
  if (evidence === null) {
    return {
      ok: false,
      code: "output-invalid",
      message: "the comparison returned a different operation than compare",
    };
  }
  return { ok: true, value: evidence };
}

function requireLeased(lease: DocumentLease, versionId: string, what: string): LeasedInput {
  const leased = findLeasedInput(lease, versionId);
  if (leased === undefined) {
    throw new DocumentError(
      "ungranted-input",
      `the ${what} version ${versionId} is not granted by this task's lease`,
    );
  }
  return leased;
}

function refArgument(leased: LeasedInput): Record<string, unknown> {
  return {
    fileId: leased.fileId,
    versionId: leased.versionId,
    name: leased.name,
    sha256: leased.sha256,
    size: leased.size,
  };
}

function failure(error: unknown): ReviewResult<never> {
  if (error instanceof DocumentError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return { ok: false, code: "invalid-request", message: messageOf(error) };
}
