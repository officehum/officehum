# Paper Instruments integration: next-session handoff

Date: 2026-10-14. Repository: `officehum`. Session branch: `codex/paper-instruments-design`. Product implementation has not started.

## User intent and approved design

The user wants Paper Instruments woven into Office Hum across Word, PowerPoint, and Excel, while Office Hum remains built on Pi Durable. They approved the written architecture in `docs/superpowers/specs/2026-10-14-paper-instruments-integration-design.md` with these choices:

- Ultramarine 1 Flash is the default model for new role conversations.
- Every role may receive both typed Paper Office tools and a restricted Python document workspace, subject to a task-scoped file lease.
- Pi Durable remains the only agent harness and approval/recovery authority. The Paper Python worker executes document operations but has no agent loop.
- New files may become drafts automatically. An edit to an existing business file is an immutable proposal and needs human review of the exact version before conditional publication.
- The pack remains portable to a bare Pi Durable harness, with Office Hum injecting `DocumentService`, FileStore, sandbox, and review policy.

The user said “go” after reviewing the spec. That approved moving into planning and Linear reconciliation. They have **not** reviewed or approved the first implementation plan or selected an execution method. Their latest instruction is to close this session and leave implementation for the next session.

## Artifacts and Git state

- Architecture spec: `docs/superpowers/specs/2026-10-14-paper-instruments-integration-design.md`.
- First detailed implementation slice: `docs/superpowers/plans/2026-10-14-ultramarine-provider.md`. It covers the Paper `pi-ai` provider, new-root default, explicit OpenAI override, and exact saved-provider resume on current Pi Durable/pi-ai 1.0.2.
- Branch commits before this handoff: `01b9803` (spec), `feb3fc8` (provider plan), `ae5d10f` (Linear cross-references). The branch is local and three commits ahead of `origin/main`; there is no PR and no push from this session.
- This checkout at `~/officehum` is the primary Git worktree, so it cannot be archived or removed as a managed feature worktree. The other listed worktree under `.claude/worktrees/` is unrelated and must be left untouched. Preserve this branch until the next agent has landed or otherwise safeguarded the docs.

## Linear reconciliation completed

The Office Hum project’s RASF-3199 epic now summarizes the approved design. Existing issues RASF-3201 (reading), RASF-3203 (generation), RASF-3204 (spreadsheet/data), RASF-3192/3193 (FileStore), RASF-3118 (catalog), RASF-3237 (separate Pi Durable/pi-ai upgrade), and RASF-3175 (model keys) were amended. PDF, CSV, Typst, DuckDB, and unrelated connector scope was preserved. All remain in Backlog.

New RASF-3199 children, also in Backlog:

1. RASF-3282 — Ultramarine provider and default.
2. RASF-3283 — restricted Paper Python worker and task workspace; blocked by FileStore and sandbox foundations.
3. RASF-3284 — PowerPoint adapter.
4. RASF-3285 — exact-version review, preview, and publication.
5. RASF-3286 — all-format portability and crash-recovery acceptance.

Linear had only `Bug`, `Improvement`, and `Feature` issue labels available. New issues received `Feature`; no new taxonomy labels were created. Existing labels, status, project, and ownership were preserved.

## Next agent instructions

1. Read the spec and the provider plan in full; inspect the current branch and Linear RASF-3282 before changing code.
2. Ask the user to review the **provider plan** and choose native or subagent-driven execution. The prior “go” approved the spec, not this later plan. The writing-plans skill requires this review/method gate before implementation. Native was recommended because the provider slice is only two tightly coupled tasks.
3. After approval, implement RASF-3282 with the plan’s test-first steps. Verify Paper’s current API contract/pricing before coding, use fake streams and no live key for local acceptance, and prove old OpenAI roots resume on OpenAI. Keep RASF-3237’s 1.1.x upgrade separate.
4. Write separate detailed implementation plans for FileStore/worker, format adapters, and review/publish as those slices become active. Maintain the dependencies and all-format gate in RASF-3286. Do not treat Feather as a second harness.
5. Run the relevant targeted tests and `npm run check` before claiming implementation done. No product tests ran in this design session; documentation checks passed.

Do not remove the unrelated worktree or delete the unpushed design branch during closeout. No credentials were written, and no live Paper request was made.
