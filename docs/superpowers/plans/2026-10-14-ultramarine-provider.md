# Ultramarine provider and new-root default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute Task 1, review and commit it, then execute Task 2 on that commit.

**Goal:** Make Ultramarine 1 Flash the default for new Office Hum role conversations while saved conversations resume with their exact provider, model, and thinking level.

**Architecture:** Register a guarded Paper Chat Completions provider in the CLI host. Keep provider/model identity paired through start, listen, and both resume paths. The Front Desk manifest supplies the new-root thinking default. Verify the actual `pi-ai` transport and a bare Pi Durable Harness with fake HTTP streams.

**Tech Stack:** Node >=22.19.0; TypeScript 7; Pi Durable and `pi-ai` 1.0.2; Vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-paper-instruments-integration-design.md`. This plan covers its provider gate. FileStore, Python worker, Office adapters, and publication have separate plans and issues.

## Global Constraints

- Provider ID `paper`; model ID `ultramarine-1-flash`; base URL `https://api.paperinstruments.com/v1`; key name `PAPERINSTRUMENTS_API_KEY`.
- Send `system`, never `developer`. Send only `low`, `high`, or `max` reasoning effort; default `max`. Disabled thinking is unsupported. Use Paper's [Chat Completions contract](https://docs.paperinstruments.com/docs/ultramarine/chat-completions) as the wire reference.
- Published prices as of 2026-10-14 are $0.15/M input, $0.03/M cached input, and $0.50/M output ([Paper pricing](https://www.paperinstruments.com/ultramarine)). Recheck before coding. Use $0.15/M for the required `cacheWrite` field until a distinct rate is published. Use a conservative 131,072-token local context cap until the serving limit is confirmed, and 32,768 maximum completion tokens.
- Advertise text input in this slice. A later image-input contract test must establish support before the model metadata advertises images.
- Credentials stay in the host. Never pass a real key to a role, worker, log, fixture, or committed file; fake tests use an in-memory placeholder.
- Saved Pi Durable roots retain provider, model, and thinking level. A failed Paper call never switches to OpenAI. Explicit OpenAI selection remains available for a new root.
- Leave the Pi Durable 1.1 upgrade in RASF-3237 separate; rerun these tests after that upgrade.

## Review Focus

1. Pre-change OpenAI state with thinking `off` resumes on OpenAI with its saved model, in both normal and inbound routes; Task 2 seeds and checks both.
2. The Paper request has a `system` message and supported reasoning effort, and provider failures do not settle work as successful; Task 1 inspects actual `streamSimple` requests and Harness results.
3. A stream with `finish_reason` but no `data: [DONE]` fails; a `length` finish with partial tool arguments executes no tool; Task 1 tests these as distinct cases.
4. A missing Paper key or invalid provider/model pair fails before a new Harness root or submission is persisted; Task 2 checks state and injection calls.
5. Cached input and reasoning usage is counted once. After an explicit abort, the active submission settles `unanswered`/`aborted`, and the same conversation reopens with Paper/max for a new submission; Task 1 checks both. Crash/replay acceptance remains in RASF-3286.

## File Structure and Responsibilities

| Path | Responsibility |
| --- | --- |
| `packages/cli/src/paper-provider.ts` | Paper model, host auth, guarded SSE fetch, and Chat Completions adapter |
| `packages/cli/src/paper-provider.test.ts` | Fake HTTP wire contract and real bare Harness stream/reopen tests |
| `packages/cli/package.json`, `package-lock.json` | Direct test-only Pi Durable dependency for the bare Harness test |
| `packages/cli/src/cli.ts` | Paired selection, registration, saved-state matching, and both resume routes |
| `packages/cli/src/cli.test.ts` | Defaults, overrides, old states, invalid pairs, missing key, and state reuse |
| `agents/frontdesk/officehum.json` | New-root Paper model and `thinkingLevel: max` |
| `agents/frontdesk/src/index.test.ts` | Manifest default and portable bare-Harness behavior with fake models |
| `README.md` | Key name, model selection, demo behavior, and resume semantics |

## Task interface preflight

| Boundary | Exact contract | Review gate |
| --- | --- | --- |
| Task 1 internal | Export `PAPER_MODEL_REF` and `paperProvider(): Provider<'openai-completions'>`. Wrap both `ProviderStreams.stream` and `streamSimple` with the same guarded fetch. No CLI or role imports. | Actual `models.streamSimple` fake HTTP assertions and a bare Harness using this provider pass. Missing `[DONE]` after a valid finish reason is an error. |
| Task 2 internal | `CliDependencies.createLiveModels(ref: ModelRef)` receives the complete pair. `liveModels(ref, dependencies)` validates before injection and returns a runtime whose `model` and registered model match `ref`. Start/listen use paired selection; both resumes use saved `agent.model`. | Default, override, old-state, inbound, thinking, invalid-pair, and state-mismatch assertions pass. |
| Task 1 → Task 2 | Task 2 imports only `paperProvider()` and `PAPER_MODEL_REF`. The latter is `ModelRef`-compatible: `{ provider: 'paper', modelId: 'ultramarine-1-flash' }`. Task 2 registers this provider and looks up that pair. | Task 2 typechecks against committed Task 1; no duplicate Paper metadata or host provider dependency in the role. |

### Task 1: Register Paper as a tested `pi-ai` provider

**Files:** Create `packages/cli/src/paper-provider.ts` and `packages/cli/src/paper-provider.test.ts`; add `@earendil-works/pi-durable: 1.0.2` as a dev dependency in `packages/cli/package.json` and `package-lock.json` for the bare Harness test.

**Interfaces:** Import `createProvider`, `envApiKeyAuth`, `Model`, `Provider`, and `ProviderStreams` from `@earendil-works/pi-ai`; import `openAICompletionsApi` from `@earendil-works/pi-ai/api/openai-completions.lazy`. Export `paperProvider(): Provider<'openai-completions'>` and `PAPER_MODEL_REF` as above. Preserve a caller-supplied `fetch` so tests can use fake HTTP without inspecting environment credentials.

- [ ] **Step 1: Write failing metadata and wire tests.** Register `paperProvider()` in `createModels()`. Call `models.streamSimple(model, context, { reasoning: 'max', apiKey: 'test-only-placeholder', fetch })`: Pi Durable uses `streamSimple`, which maps `reasoning` to `reasoning_effort`. The fake fetch captures URL, Authorization presence, and JSON. Its SSE has a tool-call delta, `finish_reason: "tool_calls"`, a usage chunk, and `data: [DONE]`. Assert:

```ts
expect(model).toMatchObject({
  api: 'openai-completions', provider: 'paper',
  baseUrl: 'https://api.paperinstruments.com/v1',
  reasoning: true, input: ['text'], maxTokens: 32_768,
  cost: { input: 0.15, output: 0.50, cacheRead: 0.03, cacheWrite: 0.15 },
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
});
expect(model?.thinkingLevelMap).toEqual({
  off: null, minimal: null, low: 'low', medium: null,
  high: 'high', xhigh: null, max: 'max',
});
expect(requestUrl.pathname).toBe('/v1/chat/completions');
expect(requestBody.messages[0].role).toBe('system');
expect(requestBody.messages.some((message: { role: string }) => message.role === 'developer')).toBe(false);
expect(requestBody.reasoning_effort).toBe('max');
expect(requestBody.stream_options).toEqual({ include_usage: true });
expect(answer.stopReason).toBe('toolUse');
expect(answer.content).toContainEqual(expect.objectContaining({
  type: 'toolCall', name: 'check_schedule', arguments: { date: '2030-01-15' },
}));
expect(answer.usage).toMatchObject({ input: 7, cacheRead: 3, output: 5, reasoning: 2, totalTokens: 15 });
```

Use `prompt_tokens: 10`, `prompt_tokens_details.cached_tokens: 3`, `completion_tokens: 5`, and `completion_tokens_details.reasoning_tokens: 2`; assert cost is calculated from these normalized values, with reasoning included in output. Assert `low` and `high` request payloads and `getSupportedThinkingLevels(model)` equals `['low', 'high', 'max']`. Assert `max_completion_tokens` is present, `max_tokens` and `store` are absent, and the tool is serialized as `type: 'function'` with `name`, `description`, and JSON Schema `parameters`. These are supported by Paper's published Chat Completions contract.

- [ ] **Step 2: Write failing stream-failure tests.** Supply (a) a valid `finish_reason: "tool_calls"` without `[DONE]`, (b) partial JSON arguments with `finish_reason: "length"` and `[DONE]`, (c) an HTTP/provider error, and (d) abort during SSE. For (a), (c), and (d), assert terminal `stopReason` is `error` or `aborted` and there is no `done` event. For (b), assert terminal `stopReason` is `length`, never `toolUse`; a partial call in `content` alone is not an executable call. Keep (a) separate from missing `finish_reason`: `pi-ai` 1.0.2 checks the latter but not `[DONE]`.

- [ ] **Step 3: Write a failing bare Harness integration test in `paper-provider.test.ts`.** Register the actual `paperProvider()` in `createModels()`, install a minimal `defineTool` named `check_schedule`, and open Pi Durable `Harness` on `MemoryStorage`. Temporarily set `PAPERINSTRUMENTS_API_KEY` to a test-only placeholder and `vi.stubGlobal('fetch', fakeFetch)`; restore both in `finally`. Feed fake HTTP SSE: response one requests that tool, response two finishes the answer. Assert one tool execution and a settled answer. Feed `finish_reason: "length"` with partial tool JSON in another run and assert zero tool executions. In an explicit-abort scenario, call `root.abort(BACKGROUND_CONTEXT)` after a partial tool delta; assert the original submission settles `{ status: 'unanswered', reason: 'aborted' }` and the tool has not run. Close and reopen the Harness on the same storage, assert the same conversation still reports `paper/ultramarine-1-flash` and `thinkingLevel: 'max'`, then submit a **new** input and assert it completes with one tool execution. Do not replay the explicitly aborted submission. Crash/replay of an unfinished operation is a distinct RASF-3286 acceptance gate. This test stays in the CLI package so the portable role never imports the host provider.

- [ ] **Step 4: Run the targeted tests to verify red.**

```sh
npx vitest run packages/cli/src/paper-provider.test.ts
```

Expected: the provider import and missing-`[DONE]` assertion fail before implementation.

- [ ] **Step 5: Implement the model, provider, and sentinel guard.** Use the model declaration below. `paperChatApi()` wraps the installed `openAICompletionsApi()` `stream` and `streamSimple`; each call replaces `options.fetch` with a fetch that delegates to `options.fetch ?? globalThis.fetch`. For a successful `text/event-stream` response, wrap `response.body` in a `ReadableStream` that forwards bytes immediately. Decode across byte boundaries, recognize only a complete SSE `data: [DONE]` line, and error the stream at upstream EOF if none appeared. Propagate upstream errors and cancel the upstream reader if the consumer cancels. Pass non-SSE error responses through untouched. `pi-ai` 1.0.2 accepts a valid `finish_reason` even without `[DONE]`, so the guard must affect the transport, not just a post-hoc result assertion.

```ts
function paperChatApi(): ProviderStreams {
  const base = openAICompletionsApi();
  const withGuard = <T extends { fetch?: typeof fetch }>(options: T | undefined): T => ({
    ...options,
    fetch: guardedPaperFetch(options?.fetch ?? globalThis.fetch),
  }) as T;
  return {
    stream: (model, context, options) => base.stream(model, context, withGuard(options)),
    streamSimple: (model, context, options) => base.streamSimple(model, context, withGuard(options)),
  };
}
```

`guardedPaperFetch` must implement the response-body check described above for both paths. Keep its byte stream live: buffering the entire response would break tool-call streaming and abort behavior.

```ts
export const PAPER_MODEL_REF = {
  provider: 'paper', modelId: 'ultramarine-1-flash',
} as const;

const model: Model<'openai-completions'> = {
  id: PAPER_MODEL_REF.modelId, name: 'Ultramarine 1 Flash',
  provider: PAPER_MODEL_REF.provider, api: 'openai-completions',
  baseUrl: 'https://api.paperinstruments.com/v1',
  reasoning: true, input: ['text'],
  cost: { input: 0.15, output: 0.50, cacheRead: 0.03, cacheWrite: 0.15 },
  contextWindow: 131_072, maxTokens: 32_768,
  thinkingLevelMap: {
    off: null, minimal: null, low: 'low', medium: null,
    high: 'high', xhigh: null, max: 'max',
  },
  compat: {
    supportsDeveloperRole: false, supportsReasoningEffort: true,
    supportsUsageInStreaming: true, supportsFinishReason: true,
    supportsStore: false, maxTokensField: 'max_completion_tokens',
  },
};

export function paperProvider(): Provider<'openai-completions'> {
  return createProvider({
    id: 'paper', name: 'Paper Instruments',
    baseUrl: 'https://api.paperinstruments.com/v1',
    auth: { apiKey: envApiKeyAuth('Paper Instruments API key', ['PAPERINSTRUMENTS_API_KEY']) },
    models: [model], api: paperChatApi(),
  });
}
```

Make `paperChatApi` return `ProviderStreams`; do not import a non-exported `pi-ai` internal path or patch `node_modules`. Paper's published contract allows `max_completion_tokens` and `stream_options: { include_usage: true }`, and rejects `store`; assert those choices on the fake wire. Do not add `x-session-id`: Pi Durable supplies a session ID, but the Paper affinity-header contract has not been verified.

- [ ] **Step 6: Run tests and typecheck.**

```sh
npx vitest run packages/cli/src/paper-provider.test.ts
npm run typecheck -w @officehum/cli
```

Expected: both pass, including fake HTTP and Harness reopen after explicit abort. Inspect captured requests and terminal stop reasons; metadata-only success is insufficient.

- [ ] **Step 7: Commit Task 1.**

```sh
git add packages/cli/src/paper-provider.ts packages/cli/src/paper-provider.test.ts packages/cli/package.json package-lock.json
git commit -m "feat: register guarded Ultramarine provider"
```

### Task 2: Default new roots to Paper and preserve saved model identity

**Files:** Modify `packages/cli/src/cli.ts`, `packages/cli/src/cli.test.ts`, `agents/frontdesk/officehum.json`, `agents/frontdesk/src/index.test.ts`, and `README.md`.

**Interfaces:** Consume `paperProvider()` and `PAPER_MODEL_REF` from Task 1. Produce `--provider paper|openai` on `start` and `listen`, paired `--model ID`, and `liveModels(ref: ModelRef, dependencies)` that selects and validates the exact pair. Normal and inbound `resume` use saved `agent.model` and thinking level. Demo remains keyless.

- [ ] **Step 1: Update existing fixtures and write failing CLI tests.** In `cli.test.ts`, add explicit `--provider openai` to existing tests whose fake `createLiveModels` returns OpenAI and whose purpose is unrelated to the new default. Change `createLiveState()` to seed an OpenAI root with `thinkingLevel: 'off'`, rather than inheriting the changed manifest's `max`: call `await solo.root.configure({ thinkingLevel: 'off' }, BACKGROUND_CONTEXT)` before closing the fixture. Do the same on a seeded inbound OpenAI root with saved `gpt-6.1-sol`. Assert fresh `start` and `listen` pass `{ provider: 'paper', modelId: 'ultramarine-1-flash' }` to the injected factory; `--provider openai` alone selects `gpt-6-sol`; `--provider openai --model gpt-6.1-sol` selects that pair in either option order. Assert both resumes pass the saved OpenAI pair to the factory, retain `off`, and show the OpenAI label. Seed a Paper root with `max` and assert Paper resume and label.

```ts
expect(selectedRefs).toEqual([{ provider: 'openai', modelId: 'gpt-6.1-sol' }]);
expect((await reopened.root.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe('off');
expect(capture.output.join('\n')).toContain('Mode: live OpenAI (gpt-6.1-sol)');
```

Test a missing Paper key without injection: fresh `start` fails with no Harness root/submission persisted and no OpenAI fallback. Test `--provider paper --model gpt-6-sol`, an unknown provider, empty or unknown model IDs, and an injected runtime whose `model` differs from the requested pair; each fails before submission. On existing state, `start` and `listen` may proceed only when the requested pair matches the saved pair; provider or model mismatch fails before admitting input or inbound processing. `resume` with a saved agent missing `model` fails visibly rather than using the new default.

- [ ] **Step 2: Write failing role and bare-Harness tests in `index.test.ts`.** Assert `frontdesk({ calendar }).agent` resolves to Paper/max by value, without importing the CLI provider into the portable role. Register a fake `paper/ultramarine-1-flash` model in a bare Harness, create a root from that role, reopen it, and assert its persisted pair and `max`. Task 1's Harness test checks the real Paper transport.

- [ ] **Step 3: Run targeted tests to verify red.**

```sh
npx vitest run packages/cli/src/cli.test.ts agents/frontdesk/src/index.test.ts
```

Expected: the new default, pair selection, and saved-state assertions fail against the current CLI and manifest.

- [ ] **Step 4: Implement paired selection and saved-state policy.** Parse `--provider` only for `start` and `listen`; track whether `--model` was supplied, then resolve the model after all options so order cannot change it. Paper defaults to `ultramarine-1-flash`, OpenAI to `gpt-6-sol`; `resume` has no model-selection flags. New roots pass the selected pair to `openSolo` or `openInboundRuntime`. On existing roots, `start` and `listen` compare saved provider **and** model ID against the requested pair before admitting work. Both resume routes require saved `agent.model`, select that exact pair, and preserve the stored thinking level. Never fall back to `parsed.model` on resume. Keep demo/OpenAI labels and add `live Paper (ultramarine-1-flash)`.

Validate the requested provider before injection, then verify the injected runtime's `model` and registered catalog entry. Production checks credentials and catalog after registration:

```ts
function liveModels(ref: ModelRef, dependencies: CliDependencies) {
  if (ref.provider !== 'paper' && ref.provider !== 'openai') {
    throw new Error(`Unsupported live provider: ${ref.provider}`);
  }
  if (!ref.modelId.trim() || (ref.provider === 'paper' && ref.modelId !== PAPER_MODEL_REF.modelId)) {
    throw new Error(`Unknown ${ref.provider} model: ${ref.modelId}`);
  }
  const injected = dependencies.createLiveModels?.(ref);
  if (injected !== undefined) {
    if (injected.model.provider !== ref.provider || injected.model.modelId !== ref.modelId ||
        injected.models.getModel(ref.provider, ref.modelId) === undefined) {
      throw new Error('Injected live model does not match the requested provider/model.');
    }
    return injected;
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

Set `agents/frontdesk/officehum.json` `defaultModel` to `{ "provider": "paper", "modelId": "ultramarine-1-flash", "thinkingLevel": "max" }`. Preserve SDK overlay behavior and role portability; do not put provider registration or credentials in `@officehum/frontdesk`. Update `README.md` with the Paper key, defaults, `--provider openai` override, keyless demo, and saved provider/model/thinking resume rule. Do not suggest project-file keys or real-account tests.

- [ ] **Step 5: Run targeted and whole-repo checks.**

```sh
npx vitest run packages/cli/src/paper-provider.test.ts packages/cli/src/cli.test.ts agents/frontdesk/src/index.test.ts
npm run check
git diff --check
```

Expected: all pass. Inspect old-state and inbound assertions, bare Harness recovery, and missing-key state. Fake-stream success does not claim a live Paper call.

- [ ] **Step 6: Commit Task 2.**

```sh
git add packages/cli/src/cli.ts packages/cli/src/cli.test.ts agents/frontdesk/officehum.json agents/frontdesk/src/index.test.ts README.md
git commit -m "feat: default new Office Hum roots to Ultramarine"
```

## Completion and Next Slice

The provider slice is complete when both commits are reviewed, fake transport and bare Harness cover tool execution, usage, `[DONE]` truncation, explicit abort settling unanswered without tool execution, and a new submission on the same reopened Paper/max conversation; `npm run check` passes; and pre-change OpenAI roots resume on OpenAI with saved thinking. Crash/replay of unfinished work remains an acceptance gate in RASF-3286. A live smoke test requires an operator-supplied Paper key and funded account; it does not replace local acceptance. The next plan covers immutable FileStore operations and the document worker, followed by format adapters and review/publish.
