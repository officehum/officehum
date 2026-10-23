# Paper document worker (RASF-3283) Implementation Plan

> **For agentic workers:** this is a short executor plan, not a full subagent brief. Read the spec
> sections named below before changing code.

**Goal:** a task-leased Paper Instruments document worker: `DocumentService` plus an isolated Python
3.13 workspace pinned to `paper-docx==0.2.0`, `paper-pptx==0.2.0`, `paper-xlsx==0.2.1`, exposed as
the portable tool pack `@officehum/tools-paper-office` through `run_document_python`.

**Architecture:** one portable package holds the `DocumentService` interface, the tool pack, a
local service backed by the SDK's `VersionedFileStore` (`packages/sdk/src/local-versioned-files.ts`),
an operation ledger for run receipts, an OOXML package inspector (pure Node, `node:zlib`), and a
Python worker run as a subprocess with a scrubbed environment, rlimits and a lease-scoped staging
directory. The worker executes submitted Python against a workspace API and reopens every declared
output with the pinned library. The pack never imports `@officehum/office`.

**Spec:** `docs/superpowers/specs/2026-10-14-paper-instruments-integration-design.md`
("Component boundary", "Agent-facing contract", "Durable operation and file lifecycle",
"Format validation and review", "Failure, security, and compatibility rules").

**Tech Stack:** Node >=22.19.0; TypeScript 7 strict; Pi Durable / pi-ai 1.3.x; Vitest; Python 3.13
with the three Paper forks and their `paper_*_doctor` sentinels.

## Global Constraints

- Package name from the spec: `@officehum/tools-paper-office`. No dependency on `@officehum/office`
  or the CLI. `@earendil-works/pi-durable` and `@earendil-works/pi-ai` are peers.
- A lease grants input version IDs and their hashes, permitted output formats, a read/write scope
  and a resource budget. Nothing else is reachable. Inputs are read-only; staging is writable.
- Every receipt binds the operation ID, code hash, argument hash, source hashes, policy version and
  library versions. A replay returns the same committed receipt. A refusal or timeout leaves the
  sources untouched. Outputs are immortal: a new call produces a new version, never an edit.
- The interpreter comes from `OFFICEHUM_PAPER_PYTHON` or an explicit option. Tests that need a real
  interpreter skip visibly when none is configured. No network in a test run.
- Python-level guards are honest about their limit: the container profile (RASF-3111, Backlog) is
  still the boundary for filesystem and egress enforcement.

## File Structure and Responsibilities

| Path | Responsibility |
| --- | --- |
| `packages/tools-paper-office/src/formats.ts` | The three formats, their MIME types and pins |
| `packages/tools-paper-office/src/errors.ts` | The typed refusal codes every outcome uses |
| `packages/tools-paper-office/src/validate.ts` | Shared strict validation for untrusted shapes |
| `packages/tools-paper-office/src/lease.ts` | Lease and limit model, strict validation, expiry |
| `packages/tools-paper-office/src/operation.ts` | Operation identity and the canonical intent hash |
| `packages/tools-paper-office/src/ooxml.ts` | OOXML package inspection: archive safety, entry names, macros, macro/executable payloads, external relationships |
| `packages/tools-paper-office/src/paper-worker.ts` | `PaperWorker` interface, subprocess worker, staged inputs/outputs, Node-side limits |
| `packages/tools-paper-office/src/run-ledger.ts` | Atomic, validated ledger of run plans and receipts |
| `packages/tools-paper-office/src/local-document-service.ts` | FileStore-backed service: validation, commit, lineage, replay |
| `packages/tools-paper-office/src/run-document-python.ts` | `run_document_python` tool and the tool pack |
| `packages/tools-paper-office/python/worker.py` | The worker: env/network/process guards, rlimits, sentinels, output collection, reopen |
| `packages/tools-paper-office/python/officehum_documents.py` | The task-scoped workspace API imported by submitted code |
| `packages/tools-paper-office/requirements.lock` | Frozen install set |
| `packages/tools-paper-office/scripts/provision-worker.sh` | One-shot `uv` provisioning of the worker environment |
| `packages/tools-paper-office/src/test-helpers.ts` | ZIP writer, fake service/worker, interpreter discovery for tests |

## Tasks

1. `formats.ts`, `lease.ts`, `operation.ts` and their tests.
2. `ooxml.ts` with the ZIP reader, and its refusal tests (no interpreter needed).
3. `paper-worker.ts` + `python/worker.py` + `python/officehum_workspace.py`, then the sandbox tests.
4. `run-ledger.ts` + `local-document-service.ts`, then crash/replay/lineage tests with a fake worker.
5. `run-document-python.ts`, `index.ts`, `README.md`, portability test.
6. `fixtures.test.ts`: all three libraries through the real worker, bare-harness and tool-pack paths.
7. Wire the package into the root `build`/`typecheck` lists, refresh the lockfile, `npm run check`.

## Verification

- `npm run check` from the worktree root.
- `OFFICEHUM_PAPER_PYTHON=<venv>/bin/python npm test -w @officehum/tools-paper-office` runs the
  interpreter-backed refusal, sandbox and fixture tests.
- Report the final `Tests N passed` line, the test-file count, `git rev-parse HEAD` and every skip.