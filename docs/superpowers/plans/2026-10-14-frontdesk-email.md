# Front Desk Outbound Resend Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The operator selected GPT-6.1 Sol for design/review and GPT-5.6 Sol for implementation; preserve that execution method and autonomous scope.

**Goal:** Explicitly selected Resend email works through the existing Front Desk message tool, with durable receipts and safe recovery after uncertain outcomes.

**Architecture:** A native-fetch/SQLite adapter in Office implements the portable Messenger interface. Separate immutable messaging metadata binds the host to console or an operator-declared Resend account, sender and fixed subject. A hosted-role factory initializes and closes messaging under Solo ownership; uncertain sends retry only within a conservative provider window.

**Tech Stack:** Existing TypeScript ESM workspaces, Node >=22.19.0, `node:sqlite`, native fetch, `node:crypto`, Vitest, Pi Durable 1.0.2; no new dependencies/workspaces.

**Spec:** `docs/superpowers/specs/2026-10-14-frontdesk-email-design.md`.

## Global Constraints

- Preserve `send_message({contactId,channel,to,text,messengerId})`, its frozen approval applicability and pinned intent; no subject argument or portable SDK change.
- Console is the default; demo always console; environment credential presence cannot enable live messaging.
- Initial live binding requires `--messenger resend`, `RESEND_ACCOUNT_ID`, `RESEND_FROM_EMAIL`, `RESEND_SUBJECT`; credentials come only from `RESEND_API_KEY` callbacks, never files/arguments/logs.
- Fixed production URL is `https://api.resend.com/emails`, redirects rejected, request deadline 30 seconds including body, response limit 64 KiB.
- Account namespace 1–100 exact/control-free characters; sender canonical lowercase mailbox <=254; subject exact/nonblank/control-free <=200; body exact/nonblank <=4000 with tab/CR/LF allowed; request ID exact/control-free <=500.
- Provider retry cutoff is first attempt +23 hours; no pending POST at/after cutoff or on clock regression; accepted receipts replay indefinitely.
- No SQLite/Harness transaction across network I/O; validate/persist complete intent and transport; no new provider key after uncertainty.
- No actual customer send, account/DNS/OAuth changes, inbound/threading/SMS/HTML/attachments/payment/deployment work or actual state-data migration.

## Review Focus

- Fresh state directories can reuse durable call counters: persisted random ledger namespaces must separate provider keys.
- Missing messenger metadata on existing console/pending state must never upgrade its authority to Resend.
- Close/model mismatch/failed Harness open must clean the hosted adapter before ownership releases.
- A slow response body must obey the same deadline/size bound as header retrieval, and provider errors must not expose response/token text.
- Time regression or a late credential callback must not extend the saved first-attempt retry window.

---

### Task 1: Implement the durable email host and guarded CLI integration

This is one coherent deliverable. The ledger, immutable authority and CLI lifetime must be reviewed together because omitting any one can turn recovery into duplicate or misdirected live email.

**Files:**
- Create: `packages/office/src/resend-messenger.ts`, `packages/office/src/resend-messenger.test.ts` (REST/ledger adapter and tests), `packages/office/src/fixtures/resend-fetch.ts` (shared fake REST fixture).
- Create: `packages/office/src/messenger-identity.ts`, `packages/office/src/messenger-identity.test.ts` (strict identity parsing/binding helpers and tests).
- Modify: `packages/office/src/solo.ts`, `packages/office/src/solo.test.ts` (factory lifetime/locked binding and actual JSONL recovery).
- Modify: `packages/office/src/index.ts` (public types/constructors/read helper).
- Modify: `packages/cli/src/cli.ts`, `packages/cli/src/cli.test.ts` (selector/config/headers and lifecycle tests).
- Modify: `agents/frontdesk/src/messaging.test.ts` (transport-history isolation); retain existing production role/tool/SDK code.
- Modify: `README.md` (setup, truthful receipt semantics and bounded recovery).

**Interfaces:**
- Consumes existing `Messenger.send(intent,{requestId})`, `RoleBundle`, `openSolo`, `ContactsDoc`, `MessagesDoc`, `createGoogleCalendarHost`, `CliDependencies` and faux model/Harness fixtures.
- Produces `openResendMessenger(path,options):ResendMessenger`, `ResendMessengerOptions`, `ResendMessenger.close():Promise<void>`, `MessengerIdentity`, `readMessengerIdentity(directory):MessengerIdentity|undefined`, and `HostedSoloRole`.
- `OpenSoloOptions` accepts existing static `role`, or mutually exclusive `createRole:()=>HostedSoloRole|Promise<HostedSoloRole>` with required `messengerIdentity`. `HostedSoloRole={role:RoleBundle;close:()=>void|Promise<void>}`. Static callers can optionally supply messaging identity; absent identity preserves portable callers' existing behavior.
- `CliDependencies` adds `openResendMessenger?:(path:string,options:ResendMessengerOptions)=>ResendMessenger` for fixture injection; production defaults to the Office export.

- [ ] **Step 1: Pin the HTTP/ledger contract with failing tests.** Add a fake fetch provider backed by a map of idempotency key to canonical payload, timestamp and UUID receipt. Count attempted POSTs and new acceptances separately. For a saved matching key before its simulated 24-hour expiry return its original ID; mismatched payload returns 409 `invalid_idempotent_request`; a held request returns 409 `concurrent_idempotent_requests`. A one-shot lost-response mode saves acceptance and then throws. Keep the test API key an obvious synthetic string and assert it never appears in public errors/SQLite metadata. Begin with:

```ts
const options = {accountId:'test-account', fromEmail:'desk@example.test',
  subject:'Front Desk', getApiKey:async()=> 'synthetic-resend-key',
  fetch:fixture.fetch, now:()=>fixture.now};
const send = {to:'guest@example.test', channel:'email' as const, text:'Exact body\n'};
const host = openResendMessenger(path, options);
const first = await host.send(send, {requestId:'1:1:send'});
await host.close();
fixture.now += 30 * 24 * 60 * 60 * 1000;
const reopened = openResendMessenger(path, {...options,
  getApiKey:async()=> {throw new Error('credential must not be read');}});
expect(await reopened.send(send, {requestId:'1:1:send'})).toEqual(first);
expect(fixture.acceptances).toBe(1);
expect(fixture.posts).toBe(1);
await reopened.close();
```

Run `npx vitest run packages/office/src/resend-messenger.test.ts`; confirm failure comes from missing adapter behavior. Include different intent under one key, unsupported SMS, changed account/from/subject, two fresh ledger paths using the same request ID, same-key concurrent calls, empty/malformed success, 401/403/422/429/5xx and both 409 names. Add a response stream that stalls after headers and one that exceeds 64 KiB, plus an exception/error body containing the synthetic key/body: all public errors stay static and deadline/size enforcement aborts the request.

- [ ] **Step 2: Implement validated authority and ledger.** Build exact identity parsing/canonicalization; use SHA-256 over ordered identity JSON for `officehum.resend.v1:<digest>`. Add strict SQLite metadata with the authority JSON and a random UUID namespace; reject unknown/malformed metadata and rows on reopen. Bind request IDs to canonical payload JSON and saved provider key. Use unique keys, short `BEGIN IMMEDIATE` transactions, WAL and synchronous FULL. Accepted row reads precede credential/timestamp reads. Pending insertion stores timestamps once and never changes the first attempt. The central key calculation is:

```ts
const providerKey = `officehum.email.v1/${createHash('sha256')
  .update(JSON.stringify([identity, ledgerNamespace, requestId])).digest('hex')}`;
const payloadJson = JSON.stringify({from:fromEmail, to:[intent.to], subject, text:intent.text});
```

Use type/length/control validation before `.trim()` or property access. Save exact body/destination, not just hashes. Reopening a ledger with different options fails before fetch. Return detached receipts. In a receipt commit, compare a concurrent accepted receipt before overwriting; reject contradictory IDs.

- [ ] **Step 3: Implement bounded fetch, uncertainty and shutdown; finish adapter tests.** Queue complete operations, not just their SQL blocks. Validate existing intent before callback/network. Read the key per outbound attempt; reject blank/control-containing credentials with static messages. Save `firstAttemptAt` immediately before initial POST; on retry enforce saved first time plus23h and persisted `lastObservedAt`. Recheck after callback and immediately before dispatch. Use one abort deadline through response-body consumption and reject redirects. Parse bounded JSON, ignore raw provider error text, distinguish known 409 names with fixed copy, and retain pending rows on every failure. Do not add automatic retries. Close marks the host closed, aborts its current controller, prevents queued dispatch, waits for the queue and closes SQLite.

```ts
const cutoff = saved.firstAttemptAt + 23 * 60 * 60 * 1000;
if (!Number.isSafeInteger(now) || now < saved.lastObservedAt || now >= cutoff)
  throw new Error('Email outcome is uncertain; automatic retry is blocked. Inspect Resend before a new authorized submission.');
// Persist lastObservedAt and COMMIT before POST. Send only saved payload/key.
// A fetch/body/commit error leaves the original pending operation unchanged.
```

Test acceptance followed by lost response and reopen inside the window: two POSTs, one acceptance, stable receipt. At exactly23h, at24h, after multiple failed attempts, after clock regression, and after a delayed credential callback crossing the cutoff: zero further POSTs. Accepted rows remain readable years later without credentials. Test pending corrupt/negative/unsafe timestamp, duplicate metadata, changed payload and provider key; never repair/rebind uncertain state. Test two adapter instances sharing one ledger use the same payload/key and accept one receipt; an in-flight 409 can be retried later with the original key. Run the focused adapter suite to green.

- [ ] **Step 4: Test and implement identity binding under Solo ownership.** Add `messenger.json` strict read/bind helpers and the spec's legacy/fresh classification. Identity-free Harness or successful console/calendar history means console; empty preflight databases remain eligible for explicit live selection. An email ledger without messaging metadata always rejects. Validate desired versus saved/legacy authority before writing a new file using `wx`/0600; mismatch must leave files byte-identical. Add tests for exact/extra keys, control-containing account/sender/subject, backend/account/from/subject mismatch, missing identity and persisted state classification.

Extend `openSolo`'s option type with the mutually exclusive async-capable factory. After acquiring ownership, validate/bind selected calendar and messaging authorities before awaiting the factory or opening the Harness. Use the resulting role throughout registry/tool-migration setup. Initiate Harness shutdown and hosted cleanup together on every failure/session close; await both with `Promise.allSettled`, preserve a cleanup error, and release the lock only after both settle. Preserve static role behavior and all existing migrations/masks. The intended opening order is:

```ts
const lock = acquireLock(options.directory);
// Read/validate/bind both identities here, under the guard.
// Only then call createRole; capture {role,close} for owned cleanup.
// Then registry -> storage -> Harness.open -> persisted root checks.
// On every failure/close: start Harness close and hosted close together;
// await both, then finally lock.release(), preserving a shutdown error.
```

Use a spy factory to assert zero calls on metadata mismatch or an active second owner. Make factory close deliberately wait: while it waits, a second real owner must still reject. Factory success followed by failed Harness/root setup calls cleanup exactly once. Factory failure cleans its own opened resource before throwing. Existing static-role roots/model/tool-selection tests remain green. Run `npx vitest run packages/office/src/messenger-identity.test.ts packages/office/src/solo.test.ts`.

- [ ] **Step 5: Prove actual Harness recovery with the Resend fixture.** Extend the existing console lost-response patterns in `solo.test.ts`; use cancellation-aware barriers and `fauxProvider`, actual `openSolo` JSONL storage, real Messenger, actual `send_message` and persisted approval decisions. Test both local and fake Google calendar hosts. For provider response loss, the fake accepts then pauses/throws before adapter acceptance; pause actual tool settlement, close/reopen, and resume the inspected original submission. Assert exactly one provider acceptance, original key/payload, one first-contact decision, saved contact revision/destination/text and one `MessagesDoc` success. Reopen inside the window obtains a receipt; expire the pending row in the clock fixture and assert no POST or successful message history. Preserve provider outcomes across adapter reopen.

Also pause after adapter acceptance but before role history, then after role history before tool settlement. These recover without another POST, retain the submission ID and truthful `accepted` status, and commit history only once. Keep old-contact pin/declined-applicability/changed-identity recovery tests. In `messaging.test.ts`, seed successful console history and ask the same contact/destination through Resend identity: it still requires first-contact approval. A denied Resend first contact yields zero fixture POSTs. Tests verify acceptance without claiming delivery. Run the adapter/solo/messaging suites together.

- [ ] **Step 6: Integrate explicit CLI selection and resource lifetime.** Parse `--messenger console|resend` for start/resume/demo, rejecting demo Resend and flags on read-only commands. Resolve saved nonsecret configuration read-only, require explicit initial Resend selection, reject mismatches, and infer existing binding on resume. Empty `RESEND_*` values do not silently override saved values; defined invalid/differing values reject. Missing live key produces a static message and never console fallback. Build the Messenger only inside `createRole`, return its cleanup, and type host messenger structurally rather than as `ConsoleMessenger`. Resume's probe and live reopen each use a fresh guarded factory; never reuse an already closed host. On factory failures before returning, close its host locally. Preserve calendar cleanup and `activeSession` behavior.

```ts
createRole: async () => {
  const messenger = identity.backend === 'console'
    ? openConsoleMessenger(join(parsed.state,'messages.sqlite'))
    : openResendMessenger(join(parsed.state,'email.sqlite'), {
        accountId:identity.accountId, fromEmail:identity.fromEmail, subject:identity.subject,
        getApiKey:async()=>requireResendApiKey(),
      });
  try {
    return {role:frontdesk({calendar,approve,messenger}), close:()=>messenger.close()};
  } catch (error) {
    await messenger.close();
    throw error;
  }
}
```

Await this async factory under ownership and never discard its close promise. Capture the returned role and cleanup exactly once per open; a later model/mode mismatch calls session close, which owns both Harness and Messenger shutdown.

Tests inject faux models and the REST fixture through `CliDependencies`. Cover default console with Resend env set, explicit live binding/visible account-from-subject-identity, saved inference, credential callback reread, backend/config changes, malformed/missing metadata, legacy console/pending state, empty preflight state, demo/live mismatch, interrupt/failed model setup cleanup and no provider calls for denied first contact. `contacts` and `bookings` work without email configuration and never construct an email host. Run `npx vitest run packages/cli/src/cli.test.ts`.

- [ ] **Step 7: Update public docs and review the entire safety boundary.** Export the new host/identity/factory types from Office. Rewrite README's current console-only statement to describe default console and explicit Resend setup, fixed subject visibility, stable operator account namespace, accepted-versus-delivered wording, first-contact identity separation, fresh-state transport changes, finite retry cutoff/clock assumption and operator investigation of expired uncertainty. Show nonsecret environment values and say to populate `RESEND_API_KEY` through the shell/approved secret store; do not include real tokens or run a sample send. Explain `email.sqlite` and `messenger.json` retention and that deleting/copying state cannot provide a global duplicate guarantee. Keep inbound/threading/SMS/provider setup and wider Linear parents explicitly deferred. Inspect source/diff for credential printing, raw exception causes, redirected auth, default live activation, network under transactions and effects after ownership release.

- [ ] **Step 8: Verify and hand off focused integration.** Run `npx vitest run packages/office/src/resend-messenger.test.ts packages/office/src/messenger-identity.test.ts packages/office/src/solo.test.ts packages/cli/src/cli.test.ts agents/frontdesk/src/messaging.test.ts`, then `npm run check`. Fix failures and rerun affected checks. Self-review spec coverage and all five Review Focus cases; report exact results, limitations and nonsecret activation requirements. Controller performs fresh whole-branch review, creates/pushes the focused PR, fixes CI and merges only on green; update the focused Linear child while leaving broader inbound/threading/account/SMS issues open. Make small focused commits for the coherent task; no live email verification is required or authorized by this plan.
