# Ultramarine provider and new-root default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ultramarine 1 Flash the default model for new Office Hum role conversations while old conversations resume with their exact provider/model.

**Architecture:** Register Paper as a custom `pi-ai` Chat Completions provider in the host, and keep the provider/model pair intact through CLI start, listen, and resume. Role manifests set the new-root default and max thinking level. Transport, selection, and recovery tests use fake streams and local state; no live Paper request is part of implementation acceptance.

**Tech Stack:** Node >=22.19.0; TypeScript 7; Pi Durable and `pi-ai` 1.0.2 currently pinned; Vitest; `createProvider`, `envApiKeyAuth`, `openAICompletionsApi`.

**Spec:** `docs/superpowers/specs/2026-10-14-paper-instruments-integration-design.md`. This plan covers its provider delivery gate only. FileStore, Python worker, Office adapters, and publication are separate plans and Linear issues.

## Global Constraints

- Paper provider ID is `paper`; model ID is `ultramarine-1-flash`; base URL is `https://api.paperinstruments.com/v1`; key env name is `PAPERINSTRUMENTS_API_KEY`.
- Send `system`, never `developer`; use only `low`, `high`, or `max` reasoning effort, default `max`; disabled thinking is unsupported. Paper's [Chat Completions contract](https://docs.paperinstruments.com/docs/ultramarine/chat-completions) is the transport reference.
- Model prices as published on 2026-10-14 are $0.15/M input, $0.03/M cached input, and $0.50/M output tokens ([Paper pricing](https://www.paperinstruments.com/ultramarine)). Record them in model metadata and verify again before implementation; do not use zero-cost metadata. Use a conservative 131,072-token local context cap until the serving limit is confirmed; maximum completion is 32,768 tokens.
- The host owns credentials. Do not pass a key to a role tool, document worker, log, test fixture, or committed file.
- Existing Pi Durable roots retain the stored provider/model and thinking setting. Never silently fall back to OpenAI when Paper fails. Explicit OpenAI selection remains available for a new root.
- Keep the Pi Durable 1.1 upgrade in RASF-3237 as a separate change; this plan must pass on the current 1.0.2 pins and be rechecked after upgrade.

## Review Focus

1. Existing OpenAI state resumed after the default changes must use OpenAI and its stored model; add a reopen test in Task 2.
2. Paper's rejected `developer` role or unsupported effort must never leave a pending task in an apparently successful state; inspect serialized request and error in Task 1.
3. A stream ending after a partial function argument or without `[DONE]` must not execute a tool; add a truncated-stream test in Task 1.
4. Missing Paper credentials must fail before opening a new live conversation; add a CLI test in Task 2.
5. Cached, reasoning, and output usage must be accounted once on a complete stream, and interruption must retain resumable work; add a usage/abort test in Task 1 and a resume test in Task 2.

---

## File Structure and Responsibilities

| Path | Responsibility |
| --- | --- |
| `packages/cli/src/paper-provider.ts` | Paper model declaration, auth, and OpenAI-compatible stream adapter settings; no CLI parsing or role imports |
| `packages/cli/src/paper-provider.test.ts` | Fake-fetch request/stream contract, reasoning, tools, usage, truncation, and abort tests |
| `packages/cli/src/cli.ts` | Parse explicit provider/model for new roots; register provider; recover saved provider/model on both resume paths |
| `packages/cli/src/cli.test.ts` | New default, explicit override, missing key, and old-state resume tests |
| `agents/frontdesk/officehum.json` | New-root default `paper/ultramarine-1-flash` with `thinkingLevel: max` |
| `agents/frontdesk/src/index.test.ts` | Manifest default and bare-harness compatibility without Paper credentials |
| `README.md` | Model selection, key name, demo behavior, and resume semantics |

### Task 1: Register Paper as a tested `pi-ai` provider

**Files:** Create `packages/cli/src/paper-provider.ts` and `packages/cli/src/paper-provider.test.ts`.

**Interfaces:** Consumes `createProvider`, `envApiKeyAuth`, `openAICompletionsApi`, and `Model<'openai-completions'>` from installed `pi-ai`. Produces `paperProvider(): Provider<'openai-completions'>` and `PAPER_MODEL_REF = { provider: 'paper', modelId: 'ultramarine-1-flash' } as const`. `cli.ts` registers this provider in its `Models` collection.

- [ ] **Step 1: Write the failing provider metadata and wire tests.** Use a fake fetch that captures URL, Authorization presence, JSON body, and SSE response. Pass a test-only `apiKey` through `models.complete` so tests never inspect environment credentials. The core assertions are:

```ts
const models = createModels();
models.setProvider(paperProvider());
const model = models.getModel('paper', 'ultramarine-1-flash');
expect(model).toMatchObject({
  api: 'openai-completions',
  baseUrl: 'https://api.paperinstruments.com/v1',
  reasoning: true,
  maxTokens: 32_768,
  cost: { input: 0.15, output: 0.50, cacheRead: 0.03 },
  compat: { supportsDeveloperRole: false },
});
expect(model?.thinkingLevelMap).toMatchObject({
  off: null, minimal: null, low: 'low', medium: null,
  high: 'high', xhigh: null, max: 'max',
});
// Complete one fake stream with a system prompt and max effort; assert the
// POST path, system role, no developer role, reasoning_effort: 'max', one
// complete tool call, and final usage including cached/reasoning tokens.
```

Add fake SSE cases for an incomplete JSON tool call ending in `finish_reason: "length"`, a stream without `[DONE]`, an API error event, and an aborted request. Assert none yields an executable complete tool call. Keep fake key values test-only and out of snapshots/logs.

- [ ] **Step 2: Run the targeted test to verify red.**

```sh
npx vitest run packages/cli/src/paper-provider.test.ts
```

Expected: provider import or asserted behavior fails because the module does not exist.

- [ ] **Step 3: Implement the smallest provider factory.** Use the installed API types and add only compatibility flags justified by the fake-fetch contract. The model declaration is:

```ts
export const PAPER_MODEL_REF = {
  provider: 'paper', modelId: 'ultramarine-1-flash',
} as const;

const model: Model<'openai-completions'> = {
  id: PAPER_MODEL_REF.modelId,
  name: 'Ultramarine 1 Flash',
  provider: PAPER_MODEL_REF.provider,
  api: 'openai-completions',
  baseUrl: 'https://api.paperinstruments.com/v1',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0.15, output: 0.50, cacheRead: 0.03, cacheWrite: 0.15 },
  contextWindow: 131_072,
  maxTokens: 32_768,
  thinkingLevelMap: {
    off: null, minimal: null, low: 'low', medium: null,
    high: 'high', xhigh: null, max: 'max',
  },
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
};

export function paperProvider() {
  return createProvider({
    id: 'paper', name: 'Paper Instruments',
    baseUrl: 'https://api.paperinstruments.com/v1',
    auth: { apiKey: envApiKeyAuth('Paper Instruments API key', ['PAPERINSTRUMENTS_API_KEY']) },
    models: [model],
    api: openAICompletionsApi(),
  });
}
```

If the installed API serializes an unsupported field, adjust its `compat` or a narrow provider-stream wrapper and pin the behavior in the test; do not patch `node_modules` or skip the contract. Do not add `x-session-id` until a stable Pi Durable conversation ID is available in this adapter; the provider supports it, but caching is optional.

- [ ] **Step 4: Run the provider tests and typecheck.**

```sh
npx vitest run packages/cli/src/paper-provider.test.ts
npm run typecheck -w @officehum/cli
```

Expected: both pass. Inspect the captured request and usage assertions; a green metadata-only test is insufficient.

- [ ] **Step 5: Commit the provider and contract tests.**

```sh
git add packages/cli/src/paper-provider.ts packages/cli/src/paper-provider.test.ts
git commit -m "feat: register Ultramarine provider with stream contract tests"
```

### Task 2: Make new roots default to Paper and preserve saved model identity

**Files:** Modify `packages/cli/src/cli.ts`, `packages/cli/src/cli.test.ts`, `agents/frontdesk/officehum.json`, `agents/frontdesk/src/index.test.ts`, and `README.md`.

**Interfaces:** Consumes `paperProvider()` and `PAPER_MODEL_REF` from Task 1. Produces CLI `--provider paper|openai` on `start`/`listen`, paired `--model ID`, and `liveModels(ref: ModelRef, dependencies)` that selects a registered provider by `ref.provider` and model by `(ref.provider, ref.modelId)`. Both normal and inbound `resume` use the stored `agent.model` pair, never only `modelId`. The existing synthetic demo path is unchanged.

- [ ] **Step 1: Write failing CLI and role tests.** In `cli.test.ts`, assert fresh `start` and `listen` select `paper/ultramarine-1-flash` through an injected fake `createLiveModels`; explicit `--provider openai --model gpt-6-sol` selects OpenAI. Create pre-change OpenAI state with the existing `createLiveState()` fixture, then call `resume` and assert the injected factory receives `{provider:'openai', modelId:'gpt-6.1-sol'}`. Repeat through an inbound state fixture so both resume branches are covered. Without `PAPERINSTRUMENTS_API_KEY`, a fresh Paper start fails before a Harness root or submission is persisted. In `index.test.ts`, assert the role's resolved agent model and thinking level are Paper/max in a bare Harness using fake models.

```ts
expect(frontdesk({ calendar: fakeCalendar() }).agent).toMatchObject({
  model: { provider: 'paper', modelId: 'ultramarine-1-flash' },
  thinkingLevel: 'max',
});
// Resume spy receives the full saved ModelRef, not just 'gpt-6.1-sol'.
expect(selectedRefs).toEqual([{ provider: 'openai', modelId: 'gpt-6.1-sol' }]);
```

Preserve the existing regression asserting a live OpenAI state still reports `Mode: live OpenAI (gpt-6.1-sol)`; add a Paper label assertion. Test invalid provider/model pairs and failure with no silent fallback.

- [ ] **Step 2: Run the targeted tests to verify red.**

```sh
npx vitest run packages/cli/src/cli.test.ts agents/frontdesk/src/index.test.ts
```

Expected: new default/selection assertions fail against the current OpenAI-only CLI and manifest.

- [ ] **Step 3: Implement paired selection.** Change `Parsed` to carry `provider: 'paper'|'openai'` (default `paper`) and `model` (default `ultramarine-1-flash`). Permit `--provider` only for new live `start` and `listen`; `--model` remains paired to it. Change `CliDependencies.createLiveModels` to accept a `ModelRef`. `liveModels(ref, dependencies)` first uses the injected factory, otherwise checks the credential for `ref.provider`, registers the matching provider, obtains `models.getModel(ref.provider, ref.modelId)`, and returns that exact ref. Reject unknown combinations with a clear error. In every resume branch, pass `agent.model` unchanged and use the manifest default only if a genuinely new root has no persisted agent. Update `modelLabel` for Paper; retain the old OpenAI and demo labels. Put `{ "provider":"paper", "modelId":"ultramarine-1-flash", "thinkingLevel":"max" }` in `agents/frontdesk/officehum.json`.

The selection must keep the pair together, including in the dependency seam used by tests:

```ts
type LiveProvider = 'paper' | 'openai';
type LiveRef = ModelRef & { provider: LiveProvider };

function selectedNewRootModel(parsed: Parsed): LiveRef {
  return { provider: parsed.provider, modelId: parsed.model };
}

function liveModels(ref: ModelRef, dependencies: CliDependencies) {
  const injected = dependencies.createLiveModels?.(ref);
  if (injected !== undefined) return injected;
  if (ref.provider !== 'paper' && ref.provider !== 'openai') {
    throw new Error(`Unsupported live provider: ${ref.provider}`);
  }
  const keyName = ref.provider === 'paper' ? 'PAPERINSTRUMENTS_API_KEY' : 'OPENAI_API_KEY';
  if (!process.env[keyName]?.trim()) throw new Error(`Set ${keyName} before live start/resume.`);
  const models = createModels();
  models.setProvider(ref.provider === 'paper' ? paperProvider() : openaiProvider());
  if (models.getModel(ref.provider, ref.modelId) === undefined) {
    throw new Error(`Unknown ${ref.provider} model: ${ref.modelId}`);
  }
  return { models, model: ref };
}
```

At parsing time, `--provider openai` with no `--model` resolves to the existing `gpt-6-sol` OpenAI default; `--provider paper` with no `--model` resolves to `ultramarine-1-flash`. Track whether `--model` was supplied so option order cannot change the selected ID. Saved roots ignore these new-root defaults.

`README.md` must show the Paper key name, `start`/`listen` default, an explicit OpenAI override, the keyless demo, and the rule that resume keeps the saved provider/model. It must not suggest placing a key in project files or using a real account during tests.

- [ ] **Step 4: Run targeted and whole-repo verification.**

```sh
npx vitest run packages/cli/src/paper-provider.test.ts packages/cli/src/cli.test.ts agents/frontdesk/src/index.test.ts
npm run check
git diff --check
```

Expected: all pass. If 1.0.2's adapter drops or alters provider identity on resume, fix that boundary with a focused regression test before declaring the task done. Do not claim a live Paper call was verified by fake streams.

- [ ] **Step 5: Commit the default and resume changes.**

```sh
git add packages/cli/src/cli.ts packages/cli/src/cli.test.ts agents/frontdesk/officehum.json agents/frontdesk/src/index.test.ts README.md
git commit -m "feat: default new Office Hum roots to Ultramarine"
```

## Completion and Next Slice

The provider slice is complete when both commits are reviewed, the fake transport covers streaming/tool/usage/abort behavior, `npm run check` passes, and a pre-change OpenAI root resumes on OpenAI. A real API smoke test may be performed only with an operator-supplied Paper key and a funded account; it is not a substitute for the local acceptance suite. The next implementation plan covers immutable FileStore operations and the document worker, followed by format adapters and review/publish.
