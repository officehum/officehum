# Pi Durable adapter core implementation plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. One coherent task; RASF-3120.

**Goal:** Make `packages/office/src/adapter/` the only code in the repository that calls Pi Durable's
runtime APIs, behind a small typed surface (`openOffice`, `install`, `conversation`, `submit`,
`submission`, `configure`, `watch`, `close`), with contract tests that pin the behavior Office Hum
depends on — resume after restart, `requestId` idempotency, and replay classification.

**Architecture:** The adapter owns one `Harness` over one `Storage` and the registry the office
installs role bundles into. It exposes conversations, submissions and a typed event stream, and
nothing else. `solo.ts`, `inbound-session.ts` and `resend-replies.ts` keep their current behavior but
obtain the harness, conversations and submissions from the adapter instead of calling `Harness.open`,
`createSession` or `submit` themselves. Contract tests run on in-memory storage, plus a SQLite
close/reopen test, with a scripted model — no network, no real model.

**Tech Stack:** TypeScript 7, Node >= 22.19.0, Pi Durable 1.3.0 (pinned), `@earendil-works/chord`
contexts, Vitest. Storage entry points: `@earendil-works/pi-durable/storage/memory` and
`@earendil-works/pi-durable/storage/sqlite/node` (`openNodeSqliteStorage`).

**Spec:** `AGENTS.md` ("Pi Durable runtime calls stay in `@officehum/office`"), the Pi Durable 1.3.0
README and `dist/harness/types.d.ts`; epic RASF-3065.

## What Pi Durable 1.3.0 actually exposes (the surface this wraps)

| Adapter call | Pi Durable API it wraps |
| --- | --- |
| `openOffice({storage, models, settings})` | `Harness.open(storage, {models, registry, settings}, context)`, then `resume()` in the same call |
| `office.install(bundle)` | `createRegistry()` + `registry.install(extension)` per extension; Pi Durable accepts a registry that keeps changing |
| `office.conversation(key, {agent})` | `harness.conversation(id, context)` then `harness.createConversation({ownership: {kind: "ownerless"}, agent}, context)` when absent |
| `office.submit(conversation, {input, requestId})` | `Conversation.submit({type: "input", content, requestId, entry?}, context)` → `Submission` with `id`, `status()`, `wait()`, `abort()` |
| `office.submission(id)` | `harness.submission(id, context)` — the documented reacquire-after-reopen path |
| `office.configure(conversation, change)` | `Conversation.configure(AgentChange, context)` |
| `office.watch(conversation)` | `watchEvents(harness, conversationId, context)` → `AgentEventStream` of `AgentEvent`s |
| `office.close()` | `harness.close(context)` (Session close: seals admission, settles commits, closes storage) |

`office.watch` maps Pi Durable's event names onto the four kinds the issue names: `tool_execution_start`
→ `tool_start`, `tool_execution_end` → `tool_end`, `submission` (settled) → `settled`, `text_delta` →
`text`. Everything else is dropped. This is the one place where the issue's vocabulary differs from
1.3.0's, and the mapping is documented in the module.

## Global constraints

- The adapter is the only module allowed to import Pi Durable **runtime** APIs. Other files in
  `packages/office` (and other packages, and roles) may keep importing types and authoring helpers —
  `defineTool`, `defineRole`, `hook`, `defineDoc`, document tokens — which `AGENTS.md` explicitly
  permits for role packages.
- No behavior change in `solo.ts`, `inbound-session.ts`, `resend-replies.ts`: same call order, same
  error surfaces, same durable state. The migration is a substitution, not a redesign.
- Tests: no network, no real model, no real credentials. A scripted/fake provider only.
- Do not touch the Pi Durable pin (RASF-3237 owns upgrades); the adapter is written against 1.3.0.
- The issue text says to document what Pi Durable **1.0.2** exposes; the repository is on **1.3.0**
  (RASF-3237 landed before this issue), so the adapter and its docs describe 1.3.0.

## Review focus

1. The guard genuinely fails: adding a runtime import outside `src/adapter/` must break `npm run check`,
   and the allowed cases (types, `defineTool`, `hook`, `defineDoc`, roles) must not.
2. Same `requestId` twice yields one submission and one model call; a new `requestId` yields a new one.
3. Close and reopen on the same SQLite file: `resume()` continues the unfinished run and
   `submission(id)` finds it.
4. Replay classification is preserved: a `replay: "safe"` tool re-runs after a simulated crash; an
   `"unsafe"` one settles `interrupted` and does not run again.
5. `install(bundle)` + `conversation(...)` selects exactly that bundle's extensions — no other role's
   tools leak in, which is the trap section 9 of the brief calls out.

## File structure

| Path | Responsibility |
| --- | --- |
| `packages/office/src/adapter/index.ts` | Public surface: `openOffice`, `Office`, re-exported types |
| `packages/office/src/adapter/office.ts` | The wrapper itself, one function per wrapped Pi Durable API |
| `packages/office/src/adapter/watch.ts` | Event mapping (`AgentEvent` → `OfficeEvent`) |
| `packages/office/src/adapter/contract.test.ts` | The four contract behaviors, in-memory + SQLite reopen |
| `packages/office/src/adapter/imports.test.ts` | The guard: runtime imports only under `src/adapter/` |
| `packages/office/src/solo.ts` | Migrated to the adapter; behavior unchanged |
| `packages/office/src/inbound-session.ts` | Migrated to the adapter |
| `packages/office/src/resend-replies.ts` | Migrated to the adapter |
| `packages/office/src/index.ts` | Export the adapter surface |

### Task 1: Contract tests first, then the adapter

**Files:** Create the four files under `packages/office/src/adapter/`; modify the three call sites and
`index.ts`.

- [ ] Write `contract.test.ts` first against the intended surface and watch it fail: `requestId`
      idempotency (one submission, one model call), reopen-from-SQLite resume plus `submission(id)`,
      `replay: "safe"` re-running after a simulated crash and `replay: "unsafe"` settling
      `interrupted`, and per-bundle extension selection.
- [ ] Implement `adapter/office.ts` and `adapter/watch.ts` until the contract tests pass.
- [ ] Write `imports.test.ts`: scan non-test sources under `packages/` and `agents/`; fail on any
      import of a Pi Durable runtime symbol outside `packages/office/src/adapter/`. Keep an explicit
      allowlist of type-only and authoring imports so the rule is readable and does not drift.
- [ ] Migrate `solo.ts` to the adapter; run the full `solo.test.ts` suite (2,803 lines) and confirm it
      passes unchanged.
- [ ] Migrate `inbound-session.ts` and `resend-replies.ts`; run their suites unchanged.
- [ ] Export the adapter surface from `packages/office/src/index.ts`; confirm `packages/cli` and the
      role packages need no changes.
- [ ] `npm run check` until green; then the credential-free CLI demo to prove the operator path still
      settles `done`.
- [ ] Update `AGENTS.md`'s adapter note? **No** — that file is owner-review. Report it instead if the
      rule needs rewording.
- [ ] Report changed files, test and check results, the guard's allowlist decision, and anything left
      for follow-up (RASF-3121's scripted provider is the sibling issue and is not built here).