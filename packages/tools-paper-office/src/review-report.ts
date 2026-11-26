/**
 * The review surface's text: what a person reads before they decide.
 *
 * The review is only usable if a person can see the exact artifact identity — the file, the immutable
 * source version and hash, the proposed version and hash, and the format — beside the format-native
 * evidence and beside the limits of that evidence. This module renders that from the durable review
 * record and nothing else: it never consults a model, and it never turns a rubric into a
 * recommendation. The CLI prints exactly these lines.
 */

import type { ReviewRecord } from "./review.js";

/** The one-line identity, for a list. */
export function reviewSummaryLine(record: ReviewRecord): string {
  const { reviewId, proposal, decision, publication } = record;
  const state =
    publication !== null
      ? `published ${publication.receipt.published.versionId}`
      : decision === null
        ? "pending"
        : decision.verdict === "approved"
          ? `approved by ${decision.by}`
          : `denied by ${decision.by}`;
  return `${reviewId} ${proposal.identity.name} [${proposal.identity.format}] ${state}`;
}

/**
 * The full report. Identity first, then the evidence with its deterministic checks, then what the
 * evidence cannot show, then the decision and the publication if either exists.
 */
export function reviewReport(record: ReviewRecord): readonly string[] {
  const { reviewId, proposal, decision, publication } = record;
  const { identity, binding, evidence } = proposal;
  const lines: string[] = [];

  lines.push(`Review: ${reviewId}`);
  lines.push(`File: ${identity.name} (${identity.fileId}) [${identity.format}]`);
  lines.push(
    `Source version (immutable): ${identity.source.versionId} sha256 ${identity.source.sha256} ` +
      `${identity.source.size} bytes`,
  );
  lines.push(
    `Proposed version (immutable): ${identity.proposed.versionId} sha256 ${identity.proposed.sha256} ` +
      `${identity.proposed.size} bytes`,
  );
  lines.push(
    `Expected published pointer: ${proposal.expectedPublishedVersionId ?? "null (unpublished)"}`,
  );
  lines.push(`Evidence: ${evidence.schema} v${evidence.version} (${evidence.format})`);
  lines.push(
    `Native diff: ${evidence.changeSet.changed.length} part(s) changed, ` +
      `${evidence.changeSet.added.length} added, ${evidence.changeSet.removed.length} removed, ` +
      `${evidence.changeSet.byteIdenticalCount} byte-identical` +
      (evidence.changeSet.semanticallyEmpty ? " (semantically empty)" : ""),
  );

  const checks = evidence.validation.checks;
  const checksOk = checks.filter((entry) => entry.ok).length;
  lines.push(`Deterministic checks: ${checksOk}/${checks.length} hold [deterministic: yes]`);
  for (const entry of checks)
    lines.push(`  [${entry.ok ? "ok" : "FAIL"}] ${entry.name}: ${entry.detail}`);

  const numeric = evidence.validation.numeric;
  if (numeric.length > 0) {
    const numericOk = numeric.filter((entry) => entry.ok).length;
    lines.push(`Numeric checks: ${numericOk}/${numeric.length} agree`);
    for (const entry of numeric) {
      lines.push(
        `  [${entry.ok ? "ok" : "FAIL"}] ${entry.name}: expected ${entry.expected ?? "—"}, ` +
          `actual ${entry.actual ?? "—"}`,
      );
    }
  } else {
    lines.push("Numeric checks: none for this format's comparison");
  }

  if (evidence.validation.rubric !== null) {
    const rubric = evidence.validation.rubric;
    lines.push(
      `Qualitative rubric: ${rubric.score}/${rubric.max} — recorded as evidence only; ` +
        "a rubric cannot approve publication",
    );
  }

  lines.push("Limitations of this evidence:");
  for (const limitation of evidence.limitations) lines.push(`  - ${limitation}`);

  lines.push(`Diff digest: sha256 ${binding.diffSha256}`);
  lines.push(`Validation digest: sha256 ${binding.validationSha256}`);
  lines.push(
    decision === null
      ? "Decision: none yet — a person must approve before this can publish"
      : `Decision: ${decision.verdict} by ${decision.by} (approval ${decision.approvalId}) at ${decision.at}`,
  );
  lines.push(
    publication === null
      ? "Published: no"
      : `Published: operation ${publication.operationId}, ${publication.receipt.previous?.versionId ?? "unpublished"} -> ${publication.receipt.published.versionId}`,
  );
  return lines;
}
