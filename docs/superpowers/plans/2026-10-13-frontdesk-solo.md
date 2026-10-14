# Front Desk Solo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan as one vertical slice; the controller delegates the code task to GPT-5.6 Sol and performs a final GPT-6.1 Sol review. Steps use checkbox (`- [ ]`) syntax for tracking. The user has already authorized autonomous execution; do not insert a new approval pause.

**Goal:** Ship a runnable portable Front Desk booking role with real durable solo hosting, local idempotent calendar, operator approvals, deterministic demo, and optional live OpenAI inference.

**Architecture:** The CLI composes `@officehum/frontdesk` with a local SQLite calendar and an injected approver. A generic Office adapter installs the role into Pi Durable and persists its root/transcript/tasks with fsynced JSONL. The upstream faux provider drives deterministic acceptance; `openaiProvider()` supplies live model inference using environment auth.

**Tech Stack:** TypeScript ESM, Pi Durable and Pi AI 1.0.2, Chord contexts, Node SQLite, Vitest, existing SDK role/approval APIs.

**Spec:** `docs/superpowers/specs/2026-10-13-frontdesk-solo-design.md`

## Global Constraints

- Node.js `>=22.19.0` (Pi Durable's actual floor); `.nvmrc` remains major `22`.
- Host Pi Durable stays pinned to `1.0.2`; role Pi Durable and pi-ai peers are `1.0.x`.
- The role depends on `@officehum/sdk`, never `@officehum/office` or `@officehum/cli`.
- No new third-party runtime dependency is needed beyond direct declarations for the installed Pi AI and Chord packages.
- Both tools declare `replay: "safe"`; booking is safe only because the calendar contract mandates atomic idempotency.
- Every booking requires approval through the existing SDK gate. With no approver, booking is blocked.
- Secrets come only from environment-based provider configuration; no values are printed or persisted.
- One process owns a harness directory at a time; reject an active second owner and recover a demonstrably stale local lock.
- Slot boundaries and stored appointment timestamps are UTC. The local inventory is 09:00, 10:00, and 11:00 on each valid requested date.

## Review Focus

- A booking key retried with changed start/customer must reject instead of returning an unrelated success.
- A valid-looking but nonexistent date or off-inventory timestamp must fail before mutation.
- Approval EOF/interruption must leave pending work; absent input never means approval.
- Lifetime SQLite ownership must serialize stale-marker reclamation across processes; crash and initialization failure release ownership.
- Demo/live mode mismatch must fail before input admission and preserve the existing root.
- Reopening a pending booking after its effect committed must settle the original request without another effect or another recorded decision.

---

### Task 1: Complete Front Desk vertical slice

**Files:**

- Create: `agents/frontdesk/package.json`, `agents/frontdesk/tsconfig.json`, `agents/frontdesk/officehum.json`, `agents/frontdesk/AGENTS.md`, `agents/frontdesk/APPEND_SYSTEM.md`, `agents/frontdesk/evals/booking.json`, `agents/frontdesk/src/index.ts`, `agents/frontdesk/src/index.test.ts`.
- Create: `packages/office/src/local-calendar.ts`, `packages/office/src/local-calendar.test.ts`, `packages/office/src/solo.ts`, `packages/office/src/solo.test.ts`, `packages/office/src/demo-model.ts`.
- Modify: `packages/office/src/index.ts`, `packages/office/package.json`, `packages/cli/src/index.ts`, `packages/cli/package.json`; create `packages/cli/src/cli.ts`, `packages/cli/src/cli.test.ts` to make parsing/I/O testable without import-time execution.
- Modify: root `package.json`, `package-lock.json`, `biome.json`, `.gitignore`, `README.md`.
- Add a small crash-test fixture only if needed; keep fault injection in tests, never a public CLI switch.

**Interfaces:**

- Role produces `Calendar`, `Booking`, `FrontDeskOptions`, and `frontdesk(options): DefinedRole`, exactly as the spec defines.
- Calendar produces `openLocalCalendar(file): LocalCalendar`; methods `freeSlots(date)`, `book(start,customer,idempotencyKey)`, `bookings(): Booking[]`, `decision(key): ApprovalDecision | undefined`, `recordDecision(key,request,decision): ApprovalDecision`, `close(): void`. Async calendar methods conform to the role contract; operator views may be synchronous SQLite reads.
- Adapter produces `openSolo({directory,role,models,model?}): Promise<SoloSession>`, where `role: RoleBundle`, `models: Models`, `model?: ModelRef`, and `SoloSession` exposes actual `harness: Harness`, `root: Conversation`, plus `submit(content:string,requestId:string)`, `resume()`, `close()`. Submit/resume return IDs, Pi settlements, and extracted assistant text; define/export the precise result type once and reuse it in CLI/tests.
- Demo produces `createDemoModels(): {models: Models; model: ModelRef}` using a stable `officehum-demo/frontdesk-demo` provider and transcript-driven response factory.
- CLI produces `runCli(args:string[], io: CliIo): Promise<number>` with injected output/error/read-approval so EOF and allow/deny are testable. The executable calls it, sets exit code, and owns SIGINT cleanup.

- [ ] **Step 1: Pin booking and approval behavior with failing tests.** Use temp SQLite paths. These assertions are the required core (put setup/cleanup around them):

```ts
const calendar = openLocalCalendar(join(tmp, "calendar.sqlite"));
const start = "2030-01-15T09:00:00Z";
const first = await calendar.book(start, "Demo Guest", "operation-1");
expect(await calendar.book(start, "Demo Guest", "operation-1")).toEqual(first);
await expect(calendar.book(start, "Other Guest", "operation-1")).rejects.toThrow();
await expect(calendar.book(start, "Other Guest", "operation-2")).rejects.toThrow();
expect(calendar.bookings()).toEqual([first]);
calendar.close();
const reopened = openLocalCalendar(join(tmp, "calendar.sqlite"));
expect(reopened.bookings()).toEqual([first]);
expect(await reopened.freeSlots("2030-01-15")).not.toContain(start);
await expect(reopened.freeSlots("2030-02-30")).rejects.toThrow();
await expect(reopened.book("2030-01-15T09:30:00Z", "Demo Guest", "bad")).rejects.toThrow();
```

Add concurrent distinct-key reservations for one slot (`Promise.allSettled`, exactly one fulfilled), empty/overlong customer, empty key, and first-write-wins approval tests. In a bare actual Harness, script a booking call with `fauxToolCall`; check no approver and denied approver each leave `bookings()` empty. Verify `validatePackage` and `checkAgent` succeed, and the role package declares no Office/CLI dependency.

- [ ] **Step 2: Run these tests and confirm meaningful failure.** Run `npx vitest run agents/frontdesk/src/index.test.ts packages/office/src/local-calendar.test.ts`; initially imports fail because the deliverable does not exist. As implementation fills in, require assertion failures for uncovered contract behavior rather than accepting configuration failures as the final red test.

- [ ] **Step 3: Implement the role and local connector.** Copy existing workspace package/tsconfig patterns; package role files for npm with `files: ["dist", "officehum.json", "AGENTS.md", "APPEND_SYSTEM.md", "evals"]`. Export compiled ESM/types and add `engines.node`. Manifest has the exact identities/tools/unconditional approval in the spec, `skills: []`, and three meaningful eval scenarios: successful booking, declined booking, occupied slot. Use the SDK's actual schema, not unsupported done/noApproval fields.

Role construction follows this verified API pattern:

```ts
const book = defineTool({
  name: "book_appointment",
  description: "Reserve an available UTC slot after operator approval.",
  parameters: Type.Object({ start: Type.String(), customer: Type.String() }),
  replay: "safe",
  execute: async (args, api) => {
    const key = `${api.conversationId}:${api.taskId}:${api.callId}`;
    const booking = await options.calendar.book(args.start, args.customer, key);
    return { content: [{ type: "text", text: `Booked ${booking.id} at ${booking.start}` }], details: { ...booking } };
  },
});
return defineRole({ packageDir, manifest, tools: [checkSchedule, book],
  ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
  ...(options.approve === undefined ? {} : { approve: options.approve }) });
```

Use `new DatabaseSync(file)` from `node:sqlite`; create parent directories. Transaction reads the idempotency key first, compares arguments, then inserts a UUID booking with `UNIQUE(start)` and `UNIQUE(idempotency_key)`, commits, and rolls back on error. Strict date validation uses a regex and roundtrip UTC date; slot parsing must match the exact generated inventory. Use prepared SQL bindings. Store approvals with `INSERT ... ON CONFLICT DO NOTHING`, then read/return the winning row. Never overwrite a previous decision.

- [ ] **Step 4: Pin real persistence/recovery with failing harness tests.** Construct the bare role registry with `createRegistry` and install `role.extensions`. Use `fauxProvider` (upstream `@earendil-works/pi-ai/providers/faux`) and `createModels` rather than mocking `Harness`. Script schedule, booking, and final answer; then assert:

```ts
const first = await solo.submit("Book Demo Guest on 2030-01-15", "booking-1");
const rootId = solo.root.id;
const again = await solo.submit("Book Demo Guest on 2030-01-15", "booking-1");
expect(again.submissionId).toBe(first.submissionId);
expect(calendar.bookings()).toHaveLength(1);
await solo.close();
const reopened = await openSolo({ directory, role, models });
expect(reopened.root.id).toBe(rootId);
expect(await reopened.harness.submission(first.submissionId, BACKGROUND_CONTEXT)).toBeDefined();
expect(calendar.bookings()).toHaveLength(1);
await reopened.close();
```

Add recovery after effect-before-result: install a test-only `hook(ToolTask,{afterTool})` in the role extension (selected by the role agent). When the booking tool finishes, signal a barrier, then `awaitWithContext(new Promise(() => {}), context)` using the hook context. Close the harness at that barrier, rebuild the same role without the hook, reopen, and `resume()`. Assert one booking, same booking ID, original submission done, and one recorded approval. The hook runs after the SQLite effect and before the tool result entry. If graceful close cannot retain that execute checkpoint, use a SIGKILL child-process fixture; never replace this assertion with close-after-completion. Test active/stale locks, initialization failure cleanup, and no extra resume input.

- [ ] **Step 5: Implement the host and demo using actual APIs.** Add direct dependencies `@earendil-works/chord: "1.0.2"`, `@earendil-works/pi-ai: "1.0.2"` to importing host workspaces; do not rely on transitive hoisting. Keep Pi Durable's existing pin. Core setup:

```ts
const context = BACKGROUND_CONTEXT;
const registry = createRegistry();
for (const extension of role.extensions) registry.install(extension);
const storage = await openNodeJsonlStorage(join(directory, "harness"), context, { fsync: true });
const harness = await Harness.open(storage, { models, registry }, context);
const root = await harness.root(context, { agent: role.agent }); // applies agent only when creating the root
const submission = await root.submit({ type: "input", content, requestId }, context);
const settled = await submission.wait(context);
if (settled.status === "done" && settled.type === "input") {
  const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
  // Extract text blocks from entry.model; never invent a success on unanswered/error settlement.
}
```

`Harness.inspect()` provides unsettled submissions. Reacquire each via `harness.submission(id,context)`, call `resume()`, and await their settlement. Do not reset the root. Hold a `BEGIN IMMEDIATE` transaction in a separate ownership SQLite database for the session lifetime; perform PID/token marker checks and cleanup only while holding it, close the Harness before release, and rely on kernel lock release after process death. Wrap all acquired resources in failure/finally cleanup.

Demo registration uses `fauxProvider({provider:"officehum-demo",models:[{id:"frontdesk-demo"}]})`, `createModels()`, and `models.setProvider(faux.provider)`. Set three identical transcript-driven response factories with `faux.setResponses`; each looks at latest user/tool-result messages to choose schedule, booking, or final actual outcome. Tool-use messages use `fauxAssistantMessage(fauxToolCall(name,args),{stopReason:"toolUse"})`. Reopening reconstructs progress from transcript, never `callCount`. Denial, empty availability, or tool error produces truthful final text.

- [ ] **Step 6: Pin CLI behavior with failing tests and implement its composition.** Test `--version`, bad command/options, required request ID, synthetic demo allow/deny, bookings without credentials, missing live key before submission, approval EOF, and resume preservation. Use injected I/O; actual harness integration must remain in the acceptance suite.

Live model setup checks nonempty `process.env.OPENAI_API_KEY`, creates models, installs `openaiProvider()`, then checks `models.getModel("openai",modelId)`. A missing key or unknown model raises an actionable error before admitting input; never print the key.

Default live model is `gpt-6-sol`, verified against the installed catalog; allow `--model` to select another known catalog model. CLI imports role plus host adapter/calendar/demo. Under ownership, inspect the persisted root model before admission, reject demo/live mismatch with a fresh-state instruction, and label the persisted model. Resume selects its runtime from that model. Approver first returns `calendar.decision(key)` if present, otherwise consumes explicit allow/deny or interactive exact tokens, records the decision, and returns the stored winner. The real readline adapter translates Ctrl-D/Ctrl-C into cancellation so the pending submission survives; unexpected I/O errors still surface. SIGINT cleanup calls harness close, not abort. `bookings` opens only the calendar and prints its actual records. Output includes synthetic/live mode, submission ID, and outcome.

- [ ] **Step 7: Integrate build, lint, runtime hygiene, and user docs.** Add `@officehum/frontdesk` to root build/typecheck after SDK and before CLI. Add it to CLI dependencies. Run `npm install --package-lock-only` to capture workspace/direct dependency changes, then `npm install` or `npm ci` as appropriate to refresh workspace links. Add `!!**/.claude/worktrees` to Biome `files.includes` to stop nested configuration discovery; do not delete worktrees or modify their configs. Ignore `.officehum/`. README provides exact demo/live/start/resume/bookings commands, UTC semantics, mandatory booking approval, state layout, stale/active lock behavior, and env-only credential setup without embedding a key.

- [ ] **Step 8: Run focused tests, all required checks, and CLI acceptance.** Run `npx vitest run agents/frontdesk/src/index.test.ts packages/office/src/local-calendar.test.ts packages/office/src/solo.test.ts packages/cli/src/cli.test.ts`, then `npm run check`. Expected: all tests/checks pass and nested worktree lint failure disappears. Run compiled CLI in a fresh temporary state directory:

Run `node packages/cli/dist/index.js demo --state <fresh-temp-dir> --approval allow` twice, then `bookings --state <same-dir>` and `resume --state <same-dir>`.

Expected: first demo records one booking, second reuses the submission/booking, listing contains one record, resume reports no pending work. Use a newly generated temporary directory rather than a reused hardcoded path when actually executing acceptance. Repeat denied demo in another directory and require zero bookings. Missing-key live mode must exit nonzero before adding any input. Live model acceptance is optional and must not expose credentials or spend on a model without session authorization.

- [ ] **Step 9: Return a reviewable diff to the controller.** Report exact tests/results, interface changes, any runtime limitations, and the diff summary. Do not commit/merge or remove branches/worktrees from the code worker; the controller owns final review, focused commit, and authorized integration. Mark completed plan checkboxes with real evidence.

## Verified upstream pointers and implementation traps

- Import `BACKGROUND_CONTEXT`/`awaitWithContext` from `@earendil-works/chord/context`, not an invented Pi context class.
- `openNodeJsonlStorage(directory,context,{fsync:true})` requires its context; `harness.resume()` is synchronous; every wait/commit/open/close otherwise takes context.
- SDK `Approver` receives request plus HookContext, and only the execute callback has `api.callId`. Guarded decisions must be durable before returning them.
- Recovery skips the already-completed approval hook after execute intent; stable idempotency must live at the connector boundary.
- `exactOptionalPropertyTypes` is on. Omit absent optional properties (or use SDK types that explicitly allow `undefined`) instead of passing naked `undefined` to newly defined interfaces.
- Role package root resolves from `src/index.ts` and compiled `dist/index.js` via `new URL("..",import.meta.url)`; manifests/resources must ship beside dist.
- Pi registry/extensions are not persisted code. Reinstall the same named role extensions before reopening pending work.
- The current SDK is narrower than aspirational four-layer/evidence documentation. Keep the manifest schema valid and prove completion from persisted records.
