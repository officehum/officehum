# Portable Paper provider package implementation plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. One coherent task; RASF-3297.

**Goal:** Move the Paper Instruments provider out of the CLI into `@officehum/provider-paper`, so a role's
`defaultModel` (`paper/ultramarine-1-flash`) resolves in a bare Pi Durable install that has no Office Hum
platform package, and the CLI keeps behaving exactly as it does today.

**Architecture:** A new workspace `packages/provider-paper` holds the provider implementation, its wire
tests and a public entry. `@earendil-works/pi-ai` is its only runtime dependency, as a peer, matching the
portable role packages. The CLI imports the package instead of a local file, so the operator path and
every saved conversation keep the same provider identity, model metadata and guarded stream behavior.

**Tech Stack:** TypeScript 7, Node >= 22.19.0, `@earendil-works/pi-ai` 1.3.0 (peer `1.3.x`), Pi Durable
1.3.0 (tests only), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-paper-instruments-integration-design.md` (provider gateway),
following `docs/superpowers/plans/2026-10-14-ultramarine-provider.md`.

## Global constraints

- Provider id `paper`, model id `ultramarine-1-flash`, base URL `https://api.paperinstruments.com/v1`, key
  name `PAPERINSTRUMENTS_API_KEY`. None of these change.
- Behavior is unchanged: `system` not `developer`, reasoning mapped to `low`/`high`/`max`, 32,768 output
  tokens, `max_completion_tokens` and never `max_tokens`, and a finished SSE stream without
  `data: [DONE]` is an error.
- The package never depends on `@officehum/office` or `@officehum/cli`; `pi-ai` is its only runtime
  dependency and it stays a peer at `1.3.x`, as `AGENTS.md` requires. The issue text's `1.0.x` peer is
  stale.
- Do not touch the Pi Durable or `pi-ai` version pins (RASF-3237 owns upgrades).
- Tests use a fake fetch and an in-memory key placeholder; no network, no real credential.

## Review focus

1. The provider source and its wire tests move byte-identically; the migrated tests pass with no edit.
2. The CLI registers the same provider object graph through the package entry, and `start`, `listen`,
   `resume` and the demo are unchanged in behavior.
3. The new package declares no Office Hum runtime dependency, and a test fails if one is added.
4. The guarded stream contract still holds from the new location: missing `[DONE]`, partial tool
   arguments at the token limit, provider error passthrough and abort are all still covered.
5. Workspace wiring builds in dependency order (provider before CLI) and the committed lockfile
   installs cleanly with `npm ci`.

## File structure

| Path | Responsibility |
| --- | --- |
| `packages/provider-paper/src/paper-provider.ts` | Provider moved from `packages/cli/src` unchanged |
| `packages/provider-paper/src/index.ts` | Public entry: `paperProvider`, `PAPER_MODEL_REF` |
| `packages/provider-paper/src/paper-provider.test.ts` | Wire and bare-Harness tests, moved unchanged |
| `packages/provider-paper/src/portability.test.ts` | Entry surface, dependency isolation, bare registry stream |
| `packages/provider-paper/README.md` | Registration example, credential and behavior notes |
| `packages/provider-paper/package.json`, `tsconfig.json` | Portable workspace with a `pi-ai` peer |
| `packages/cli/src/cli.ts`, `packages/cli/package.json` | Import and depend on the package |
| `package.json`, `package-lock.json` | Workspace build and typecheck order |
| `README.md`, `docs/design/agent-package.md`, `docs/visualizations/*.html`, `docs/handoffs/*` | Where the provider lives |

### Task 1: Ship the portable provider package

**Files:** Create `packages/provider-paper/*`; move both CLI provider files; modify `packages/cli/src/cli.ts`,
`packages/cli/package.json`, root `package.json` and `package-lock.json`; update the four documents above.

**Interfaces:** `packages/provider-paper/src/index.ts` re-exports `PAPER_MODEL_REF` and
`paperProvider(): Provider<"openai-completions">` from `./paper-provider.js`. The CLI keeps importing both
names, from the package instead of a relative path.

- [ ] Move `packages/cli/src/paper-provider.ts` and `paper-provider.test.ts` with `git mv`; confirm the
      content hashes match so the move is byte-identical.
- [ ] Add the package manifest (peer `@earendil-works/pi-ai` `1.3.x`; `chord`, `pi-ai` and `pi-durable`
      `1.3.0` as test-only dev dependencies), the `tsconfig.json` inherited from `tsconfig.base.json`, and
      the `src/index.ts` entry.
- [ ] Write the failing portability test first: the exported surface, no `@officehum/*` runtime
      dependency, and a scripted tool call streamed through a bare `createModels()` registry with a fake
      fetch.
- [ ] Repoint `packages/cli/src/cli.ts` at `@officehum/provider-paper`, add the dependency, and put the
      package ahead of the CLI in the root `build` and `typecheck` scripts.
- [ ] Run `npm install` to wire the workspace and update the lockfile, then `npm run check` until green.
- [ ] Verify the operator path end to end: build, run the credential-free demo, and confirm
      `--provider paper` still rejects a missing `PAPERINSTRUMENTS_API_KEY` before start.
- [ ] Update `README.md`, `docs/design/agent-package.md`, both visualizations and the brief's state table
      to name `packages/provider-paper`.
- [ ] Report the changed files, the test and check results, and any decision left open for the owner.