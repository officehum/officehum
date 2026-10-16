# Pi Durable 1.3.0 upgrade follow-ups implementation plan

> **For agentic workers:** RASF-3303 (milestone M0). One coherent task.

**Goal:** Close the three gaps the Pi Durable 1.3.0 upgrade PR left: a tool-result shape guard the SDK
owns, a prompt-cache check in the eval runner, and the `api.models` migration where a design threaded
a `Models` instance into a tool or hook only because of the old pin.

**Architecture:** The shape guard is a `defineRole`-time wrapper (`guardToolResult`) that replaces each
tool's `execute`, so it is installed wherever `defineRole` is used and a third-party role gets it
without knowing it exists. The prompt-cache check is a pure function over recorded scripted requests
(`promptCacheFailures`) plus a test that drives a three-turn scripted conversation for every role in
`agents/*` through the Pi Durable eval runner. The `api.models` migration is a search: no tool or hook
in the tree takes a `Models` instance yet, so nothing changes.

**Tech Stack:** TypeScript 7, Node >= 22.19.0, Pi Durable 1.3.0, Vitest. Tests use the scripted
provider; no test touches the network or a real model.

**Spec:** `docs/design/agent-package.md` (role bundle, `defineRole`, evals, durable context patterns);
`AGENTS.md` (tool results use `output`; guardrails are code, not prompt text).

## Global constraints

- Pi Durable runtime imports stay inside `packages/office/src/adapter/` (enforced by `imports.test.ts`);
  `wrapTool`, `defineTool`, `hook` and types are authoring surface and allowed anywhere.
- Role packages stay portable: no dependency on `@officehum/office` or `@officehum/cli`.
- Tool results use `output`, never `content`.
- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; 100 columns.

## File structure

| Path | Responsibility |
| --- | --- |
| `packages/sdk/src/tool-result.ts` | `guardToolResultShape` and `guardToolResult`; the SDK-owned check |
| `packages/sdk/src/role.ts` | `defineRole` wraps every tool it returns with `guardToolResult` |
| `packages/sdk/src/index.ts` | Export the guard |
| `packages/sdk/src/tool-result.test.ts` | Fixture tool returning `{ content, details }` fails; a good tool passes |
| `packages/office/src/evals/prompt-cache.ts` | `promptCacheFailures`: byte-identical, leading, three requests |
| `packages/office/src/evals/prompt-cache.test.ts` | Runs the check for every role in `agents/*`; negative cases |
| `agents/frontdesk/src/index.test.ts` | Front Desk returns `output`, so the guard passes on a real role |

## Task 1: the tool-result shape guard (Part 1)

- [x] Add `guardToolResultShape(tool, result)`; it throws when the result has an own `content` field.
- [x] Add `guardToolResult(tool)`; `defineRole` maps it over its role, skill and engine tools.
- [x] Test: a fixture tool returning `{ content, details }` fails, naming the tool and `output`; a good
      tool passes; a result without `output` and a nested `details.content` do not throw.

## Task 2: the prompt-cache check (Part 2)

- [x] Add `promptCacheFailures(requests)`; it checks the system message leads, the replayed system
      prompt is byte-identical, and the stable sections are unchanged, across at least three requests.
- [x] Test: run a three-turn scripted conversation for every role in `agents/*` via `piDurableRunner`;
      positive and negative cases.

## Task 3: `api.models` in tools (Part 3)

- [x] Search for a `Models` instance passed into a tool or hook. None exists yet (the image generator,
      document extraction, sub-agents and compaction summaries are later milestones). No change.

## Decisions the issue left open

- Part 1 option: the `defineRole`-time wrapper, because it is the primary mechanism the issue asked for
  — the SDK owns the check and a third-party role gets it automatically, with no per-role wiring.
- The guard throws (a loud failure the harness turns into an error tool result) rather than returning an
  error result, so a leftover `content` is never mistaken for a successful empty result.
- The bad-shape fixture tool is defined inline in the SDK test rather than added to `sample-desk` or
  `sample-stockroom`: a declared tool would ripple through those fixtures' manifests and eval stubs.
- The check runs all roles under `agents/*` and supplies no app clients; a role factory that needed one
  at construction would surface here as a failure. Front Desk does not.
- The prompt-cache check reads only what a role already renders, so it does not pre-empt RASF-3234,
  which decides which sections are relevant.