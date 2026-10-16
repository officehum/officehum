# Role loading and solo run implementation plan

> **For agentic workers:** RASF-3122 (epic RASF-3065, milestone M0). One coherent task.

**Goal:** `officehum run ROLE_DIR` runs one role package by itself in the terminal — load it from a
package directory, open an office on one SQLite file, chat, approve gated actions at the prompt, and
resume after a kill — with a crash-and-resume test that proves an unsafe tool is not run twice.

**Architecture:** Loading lives in `@officehum/office` because only that package may call Pi Durable's
runtime through the adapter, and because a role bundle is installed into an office. `loadRole` validates
the package (`validatePackage`), refuses an incompatible Pi Durable peer range, checks runtimes
(`checkRuntimes`), imports the package's default export, calls it with overlays, approver, an engine
built from the manifest and the caller's named app clients, then checks the bundle (`checkAgent`).
`openRoleRun` opens one office over one SQLite file with scheduling paused, installs the role, opens (or
reacquires) its conversation, and exposes `submit`, `resume`, `reload` and the manifest's operator
commands. The CLI's `run` command wraps it with a terminal approver, a `--clients` config reader, a
`--model` selector and a read-lines loop; `/reload`, `/commands` and `/NAME` are the loop's slash
commands.

**Tech Stack:** TypeScript 7, Node >= 22.19.0, Pi Durable 1.3.0, `node:sqlite`, Vitest. Tests use the
scripted provider; no test touches the network or a real model.

**Spec:** `docs/design/agent-package.md` (role bundle, overlays, engines, operator commands, clients);
`docs/superpowers/specs/2026-10-13-frontdesk-solo-design.md` (solo host, single-owner rule).

## Global constraints

- Pi Durable runtime imports stay inside `packages/office/src/adapter/` (enforced by `imports.test.ts`);
  `run-role.ts` imports only types and the `AssistantEntry` authoring helper, like `solo.ts`.
- Role packages stay portable: they never depend on `@officehum/office` or `@officehum/cli`. The SDK
  fixtures under `packages/sdk/fixtures/` gain only a peer-range correction (`1.0.x` → `1.3.x`, the
  repo's rule since Pi Durable moved to 1.3.0), which keeps them SDK test fixtures.
- Guardrails are code or manifest data. The `--clients` file may hold no credential: only `module` and
  `export` are accepted, and every factory reads its own configuration from the environment.
- Tool results use `output`, never `content`.
- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; 100 columns.

## File structure

| Path | Responsibility |
| --- | --- |
| `packages/office/src/roles/load-role.ts` | `loadRole`: validate, range-check, runtimes, import, build, `checkAgent` |
| `packages/office/src/roles/run-role.ts` | `openRoleRun`: one office over one SQLite file; submit, resume, reload, command |
| `packages/office/src/version.ts` | `PI_DURABLE_VERSION`, moved out of the barrel so submodules avoid an import cycle |
| `packages/office/src/adapter/office.ts` | `openOffice` gains `resume?: boolean` so the run path can see unsettled work |
| `packages/office/src/fixtures/role-run-child.mjs` | Child process the crash test kills mid-unsafe-tool |
| `packages/office/src/roles/load-role.test.ts` | Fixture loading; incompatible-range and runtime refusals |
| `packages/office/src/roles/run-role.test.ts` | Kill-and-resume: unsafe once, safe twice |
| `packages/cli/src/usage-error.ts` | `UsageError`, shared by the CLI and the run command |
| `packages/cli/src/run.ts` | Terminal approver, `--clients` reader, model selection, read-lines loop |
| `packages/cli/src/cli.ts`, `terminal-io.ts` | `run` dispatch; `readLine` alongside `readApproval` |
| `packages/cli/src/fixtures/clients*.{json,mjs}` | A credential-free client config for the CLI tests |
| `packages/cli/src/run.test.ts` | Terminal approver y/n; run path with the scripted provider |
| `packages/sdk/src/approvals.ts` | `isApprovalGate` marks with `Symbol.for` so it survives duplicate SDK copies |
| `README.md`, `docs/visualizations/*.html` | The `run` command surface |

## Task 1: loadRole

- [x] Move `PI_DURABLE_VERSION` to `version.ts` and re-export it; add `roles/load-role.ts`.
- [x] Tests: load sample-desk and sample-stockroom; refuse an incompatible peer range and a missing
      runtime; explain an unimportable entry point.
- [x] Correct the sample-stockroom fixture's stale `1.0.x` peer range to `1.3.x`.

## Task 2: the run session and the kill-and-resume test

- [x] Add `roles/run-role.ts`; add `resume?: boolean` to `openOffice` and open paused in the run path.
- [x] Child fixture with a safe and an unsafe tool; kill during the unsafe tool; assert unsafe ran once
      and safe ran twice on the same SQLite file.

## Task 3: the CLI command

- [x] Add `run.ts` (approver, `--clients`, models, loop), `usage-error.ts`, `run` dispatch in `cli.ts`,
      `readLine` in `terminal-io.ts`.
- [x] Tests: terminal approver y/n/EOF; the run command with the scripted provider (y runs the gated
      tool once, n blocks it); operator commands and `/reload`; the incompatible-range refusal; a
      credential-carrying `--clients` file refused.

## Decisions the issue left open

- `--clients` shape: name → `{ "module": …, "export"?: … }`; the exported factory is called with no
  arguments and reads configuration from the environment.
- `--model` defaults to the manifest `defaultModel`; only `paper` and `openai` are live providers, and a
  manifest default outside those needs an explicit `--model`.
- Default `--db` is `./.officehum/<role-id>.sqlite`; the manifest id comes from the validated package.
- Approval answers: only `y`/`yes` approve; `n`/`no`/empty/EOF/unrecognized all decline.
- `resume()` on the run command is driven by the CLI at startup; opening paused is what makes the
  unsettled set visible before it is re-run.
- The SDK fixture roles are TypeScript sources and load under the test runner, not the built CLI; a
  sealed role package (for example `agents/frontdesk`) is what `officehum run` loads from the terminal.