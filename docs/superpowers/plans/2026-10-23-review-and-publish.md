# Review, approval and publication (RASF-3285) Implementation Plan

> **For agentic workers:** this is a short executor plan, not a full subagent brief. Read the spec
> sections named below before changing code.

**Goal:** require a person to review the *exact proposed version* before an agent's edit to an
existing Word, PowerPoint or Excel business file becomes the published version. One evidence shape
for all three formats, an approval bound to file/source/proposal hashes plus the diff and the
validation evidence, and a `publish_document` path that uses the FileStore compare-and-swap.

**Architecture:** the FileStore already does the compare-and-swap
(`packages/sdk/src/files.ts` `publish`, `local-versioned-files.ts`). The SDK deliberately does not
verify approvals, so this issue adds the missing half as a **format-generic review surface** inside
the portable pack `@officehum/tools-paper-office`: one `ReviewEvidence` shape built from the three
adapters' existing `compare_*` results, a durable review ledger keyed by the proposed hashes, and a
publication gate that verifies an approval is bound to exactly the reviewed version before it calls
`VersionedFileStore.publish`. The CLI grows a `review` command that shows the exact artifact
identity, the evidence and the stated limits, and records a person's decision.

**Spec:** `docs/superpowers/specs/2026-10-14-paper-instruments-integration-design.md` ("Format
validation and review", "Durable operation and file lifecycle", step 6 and the acceptance gate for
"Review and quality").

**Tech Stack:** Node >=22.19.0; TypeScript 7 strict; Pi Durable / pi-ai 1.3.x; Vitest; the pinned
Python 3.13 worker for the interpreter-backed evidence test only.

## Global Constraints

- The review surface is generic: it depends on `@officehum/sdk` (the `VersionedFileStore` contract)
  and the adapters' result types, never on `@officehum/office` or the CLI. The same surface runs in a
  bare Pi Durable harness with a fake store.
- The approval identity is the hashes. An approval made for one proposal must not publish another:
  the decision carries the full `ReviewBinding` and the gate compares it by value.
- No existing-file pointer moves without a valid exact-hash approval. Every refusal is asserted by
  reading the published pointer back, not just by the error code.
- A denied or missing decision never publishes. A rubric may add evidence and can never approve.
- Deterministic: no model call decides anything. Format validation and numeric checks are pure
  functions of the adapters' evidence.

## File Structure and Responsibilities

| Path | Responsibility |
| --- | --- |
| `packages/tools-paper-office/src/review-evidence.ts` | The one `ReviewEvidence` shape, built from the Word/PowerPoint/Excel `compare_*` results |
| `packages/tools-paper-office/src/review.ts` | Identity, hash-bound binding, durable `ReviewLedger`, and the `publicationGate` |
| `packages/tools-paper-office/src/review-service.ts` | Runs the format compare through the injected `DocumentService` to produce evidence |
| `packages/tools-paper-office/src/publish-tool.ts` | `publish_document`: the agent asks, the host's gate decides |
| `packages/tools-paper-office/src/review-report.ts` | The CLI/UI text report: artifact identity, evidence, and stated limits |
| `packages/cli/src/cli.ts` | The `review` command: `list`, `show`, `decide`, `publish` |
| `docs/design/file-store.md` | Note that RASF-3285 lands the host approval verification |

## Tasks

1. `review-evidence.ts` with the three `reviewEvidenceFrom*` builders and their tests.
2. `review.ts`: binding, ledger, gate, and the refusal tests (approve, deny, restart, stale,
   concurrent, replay, A-cannot-publish-B, pointer-unchanged, rubric).
3. `review-service.ts` + the interpreter-backed evidence test (skips visibly with no interpreter).
4. `review-report.ts` + its test.
5. CLI `review` command + tests.
6. Wire the exports, the CLI dependency and the docs; `npx biome check --write`, `npm run check`.

## Verification

- `npm run check` from the worktree root with the interpreter unset and with
  `OFFICEHUM_PAPER_PYTHON=<venv>/bin/python`.
- Report both `Tests N passed` lines, the test-file count, `git rev-parse HEAD` and every skip.