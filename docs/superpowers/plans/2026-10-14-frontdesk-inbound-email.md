# Front Desk inbound email implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. The operator selected GPT-6.1 Sol for design/review and GPT-5.6 Sol for product/test code. Execute one coherent implementation task with GPT-5.6 Sol, then one fresh GPT-6.1 Sol combined spec/code/security review. Routine design approval pauses are overridden by explicit autonomous execution; actual customer sends and provider changes remain outside this implementation.

**Goal:** Provide a runnable local signed Resend receiving listener with durable customer conversations and operator-enabled scoped threaded replies.

**Architecture:** Native HTTP verifies raw Svix payloads and durably acknowledges inbox rows before work. A bounded worker fetches immutable email content and submits it to a stable conversation in the same fsynced Harness/session. A separate portable reply tool resolves its recipient/thread entirely from the receipt and uses an independent durable reply ledger without touching existing outbound operations.

**Tech Stack:** Node >=22.19.0, TypeScript, native HTTP/crypto/fetch/SQLite, Pi Durable 1.0.2, html-to-text 10.0.1, Vitest/fauxProvider.

**Spec:** `docs/superpowers/specs/2026-10-14-frontdesk-inbound-email-design.md` — read the complete spec before implementation; it resolves limits, states, trust, compatibility and crash gaps.

## Global constraints

- No live credentials, provider/customer sends, DNS/webhook/provider setup, deployment, state migration or destructive cleanup.
- Work on `codex/frontdesk-inbound-email`; root owns Linear/commits/PR/CI/merge unless assigned otherwise. Scoped issue RASF-3264; broader RASF-3160/3161 stay open.
- First-time authenticated senders receive/reply without a contact write. Contacts/calendar remain one shared session; customer tools expose only check_schedule and reply_message.
- DMARC provider-computed pass, same From/Reply-To, bound receiving address, bounded safe thread headers and loop checks are required before customer authority.
- Ack only after raw verified event/full identity binding has durable SQLite FULL commit. No model/GET/approval waits in webhook response.
- Fixed loopback POST `/webhooks/resend`, fixed Resend GET/POST URLs, no redirects, encoded validated UUIDs, bounded streamed reads/deadlines and safe errors.
- Raw request 256 KiB/10 seconds; receiving response 1 MiB/30 seconds; HTML/text 256 KiB; model text 16,000 characters; reply text 1–4000; reply subject <=200; References <=50 tokens/8192 characters.
- Preserve all existing email.sqlite/messenger.json payloads, keys, namespaces, pending/accepted receipts, approval memos, generic message history and tool-removal selections. Additive new inbound.sqlite only.
- Reply operation uses the same saved payload/key forever, has a 23-hour pending retry cutoff and regression checks; accepted replay never contacts provider. One distinct reply operation per inbound receipt.
- Exact generated reply and trusted route/thread must be displayed terminal safely before interactive approval; explicit --approval allow/deny is operator input. Declined decisions cannot reset on resume.

## Review focus

1. A fast faux model calls reply before the worker records admission: verify the actual Harness submission/envelope and allow once; merely prepared receipt stays unauthorized (Steps 5/6).
2. Two active customers request simultaneous approval: serialize prompts and bind each response/decision to its exact pinned target/text; email words cannot answer (Steps 6/8).
3. Customer changes contact email or sends different topics: preserve old operation destinations and RFC thread parents; never merge histories or copy other topic references (Steps 5/7).
4. Shutdown during slow request body/provider body/cancel reader: abort/drain owned work before releasing the directory guard; restart retains uncertain operations (Steps 3/7/8).
5. Queued admission is canceled without an entry or a stale duplicate request ID has different content: reconcile only provable identity, never re-create or silently accept altered payload (Steps 5/9).

---

## File structure and responsibilities

Create focused units:

| Path | Responsibility |
| --- | --- |
| `packages/office/src/resend-inbound.ts` | Protocol verification, receiving shape validation, HTTP fetch and safe normalization; no Harness or role import |
| `packages/office/src/resend-inbox.ts` | New inbox metadata/schema, raw event/email dedupe, immutable prepared/admission snapshots, receipt/reply reservation persistence |
| `packages/office/src/inbound-session.ts` | Office-owned route/conversation docs, atomic conversation creation, exact Harness admission reconciliation, customer allowlist hook and bounded worker |
| `packages/office/src/resend-replies.ts` | Trusted prepare/send adapter, full reply ledger, provider idempotency and shutdown queue |
| `packages/office/src/resend-listener.ts` | Native loopback HTTP server, bounded raw intake, static acknowledgements/errors, owned readers/lifecycle |
| `agents/frontdesk/src/replies.ts` | Portable ReplyMessenger/ReplyTarget/RepliesDoc, narrow reply tool, pinned intent/approval/history |
| `packages/office/src/fixtures/resend-inbound.ts` | Synthetic receiving metadata/content, signed raw fixtures and fake REST including outbound loss/TTL |
| `packages/office/src/fixtures/inbound-office.ts` | Test-only real fsynced Harness host builder, deterministic faux model and barriers |
| matching `*.test.ts` for each unit | Protocol, storage, role, admission, send/recovery and HTTP tests |

Modify:

- `agents/frontdesk/src/index.ts`: optional reply transport/approveReply wiring and portable exports; existing Messenger contract remains unchanged.
- `agents/frontdesk/officehum.json`: declare reply_message replay safe, with only receiptId/text model arguments; no generic manifest approval over untrusted routing. Approval is enforced inside the reply tool after trusted pinning.
- `agents/frontdesk/AGENTS.md`: explain narrow customer input/reply semantics and truthful receipt behavior; preserve operator contact/calendar policy.
- `packages/office/src/solo.ts`: expose/use existing ownership guard for read-only inbox inspection without duplicating locks; retain static factory/lifecycle/migration semantics. Keep provider-specific route docs/worker in their focused file.
- `packages/office/src/index.ts`: export new host APIs/types and read-only inbox helper.
- `packages/cli/src/cli.ts` and `packages/cli/src/cli.test.ts`: listen/inbox, safe approvals, worker attachment and resume integration under existing locked role factory, cleanup abstraction.
- `packages/cli/src/index.ts`: only if signal wiring needs a generalized active cleanup; preserve exit codes.
- `packages/office/package.json`, compatible type-dev-dependency location and `package-lock.json`: pinned parser + types.
- `README.md`: runnable setup/listen/inbox/resume, explicit authority/allow flag, supported customer actions, recovery and live acceptance limitations.
- Existing manifest/tool-count expectations only where new optional tool registration legitimately changes them; retain meaningful old assertions.

Do not edit existing outbound ledger schema or wire payload. Prefer shared small internal bounded-fetch helpers only if they preserve old tests and bytes exactly; avoid broad refactoring of the proven adapter.

### Task 1: Ship the complete local inbound-to-reply flow

**Consumes:** `openSolo`, its locked `createRole` lifecycle, `SoloSession.harness/root`, existing calendar `DecisionStore` for operator-root approvals, new bound inbox reply approval store, `ContactsDoc`, role bundle/Approver API, native Resend outbound semantics, real Pi Durable public APIs below.

**Produces:** CLI listen/inbox/resume plus portable reply tool and new durable inbox/route/reply state. Public shapes to implement are:

```ts
// Office, new state authority; all values validated and ordered before identity hashing.
type InboundAuthority = {
  version:1; messengerId:string; accountId:string; fromEmail:string; inboundEmail:string;
};
type InboxSummary = {
  emailId:string; state:'received'|'prepared'|'admitted'|'settled'|'blocked';
  reason:string|null; conversationId:number|null; submissionId:number|null;
};
type NormalizedInboundEmail = {
  emailId:string; from:string; to:string[]; subject:string; messageId:string;
  inReplyTo:string|null; references:string[]; text:string; truncated:boolean;
  attachments:{id:string;filename:string|null;contentType:string;size:number}[];
};
type SignedWebhookHeaders = {id:string;timestamp:string;signature:string};
type ReceiveResult = {status:200|202|204; emailId?:string};
type ResendInboundOptions = {
  authority:InboundAuthority; getApiKey:()=>Promise<string>;
  getWebhookSecrets:()=>Promise<readonly string[]>; fetch?:typeof fetch; now?:()=>number;
};
interface ResendInbox {
  readonly authority:InboundAuthority;
  readonly namespace:string;
  accept(raw:Uint8Array, headers:SignedWebhookHeaders):Promise<ReceiveResult>;
  summaries():InboxSummary[];
  close():Promise<void>;
}
function openResendInbox(path:string, options:ResendInboundOptions):ResendInbox;
// The concrete Inbox additionally offers typed internal receipt/transaction methods used by worker/replies.
interface InboundSession {
  tick():Promise<void>; // one pass, at most 20 receipts; no per-submission wait
  reconcile():Promise<void>; // bind existing admissions/settlements before new work
  close():Promise<void>;
}
function openInboundSession(options:{
  solo:SoloSession; inbox:ResendInbox; customerAgent:AgentChange;
}):InboundSession;
function createResendReplyMessenger(options:{
  inbox:ResendInbox; getHarness:()=>Harness|undefined;
  getApiKey:()=>Promise<string>; fetch?:typeof fetch; now?:()=>number;
}):ReplyMessenger & {close():Promise<void>};
interface ResendListener {readonly address:string;close():Promise<void>}
function openResendListener(options:{inbox:ResendInbox;port:number}):Promise<ResendListener>;
function readInboundInbox(directory:string):Promise<InboxSummary[]>;
```

The portable `ReplyTarget/ReplyMessenger` signatures are defined verbatim in the spec. `frontdesk` adds optional `{replyMessenger?:ReplyMessenger, approveReply?:Approver}`; ordinary callers need neither. `repliesTools(replyMessenger?,approveReply?)` returns reply_message registration. Role `RepliesDoc` is session-scoped v1 and stores `{key,argsJson,target,text,delivery}`; it does not extend MessagesDoc or its authorization history. Use type-safe internal methods rather than exposing arbitrary SQL updates to the model. The fixture-only `openTestInboundOffice` defined below supplies reopen/force-barrier control; production does not expose crash switches.

- [ ] **Step 1: Pin dependency and test fixture contracts; write the initial failing acceptance test.**

Verify published parser/type package metadata, then install only into the proper workspace:

```sh
npm view html-to-text@10.0.1 version engines --json
npm view @types/html-to-text version --json
npm install --save-exact html-to-text@10.0.1 -w @officehum/office
# Pin the registry-confirmed compatible @types/html-to-text version as a dev dependency.
```

Root already verified html-to-text10.0.1 exists and requires Node >=20.19.0; it has no built-in types. Do not install a guessed nonexistent types version. Read the package's official README for compile/selectors/limits. Converter configuration:

```ts
const options = {
  wordwrap:false,
  limits:{maxInputLength:262144,maxDepth:40,maxChildNodes:1000,
    ellipsis:'[content omitted by parser limits]'},
  selectors:[
    ...['script','style','iframe','object','embed','form','img','head','blockquote',
      'div.gmail_quote','div.yahoo_quoted'].map(selector=>({selector,format:'skip'})),
    {selector:'a',options:{ignoreHref:true}},
  ],
};
```

Reject byte/character input overflow before calling converter; apply final text cap and marker-derived truncated flag. No HTML regex pre-parser or fetchable links in model text.

Define test fixture `SyntheticInbound` as `{event:Record<string,unknown>, received:Record<string,unknown>}` with fixed UUIDs, safe From/To, DMARC pass, Reply-To same sender, Message-ID and text. Define `signedFixture(event,eventId,now,secret)` returning `{raw:Uint8Array,headers:SignedWebhookHeaders}` using native HMAC with a **synthetic** `whsec_` key from Buffer bytes. `InboundRestFixture` wraps existing ResendFetchFixture for POST behavior and adds only fixed GET receiving endpoints; record GET count and saved POST payloads/acceptances, reject all unexpected URLs. It supplies mutable synthetic clock and barriers already patterned by `loseResponseUntilAbort`.

`openTestInboundOffice({directory?,fixture,approval:'allow'|'deny'|'interactive',responses?,barrier?})` creates real temporary calendar, locked openSolo hosted factory, inbox, reply transport, role and fake models; attaches InboundSession after openSolo returns, exposes `{solo,inbox,session,fixture,close,reopen}`. `reopen` preserves directory/fixture and constructs fresh models/resources. Barriers are implemented by test wrappers around existing admission/transport/history public methods or registry hooks, not product crash flags. Helpers can be defined locally first and moved into the fixture file once the test works.

The first acceptance assertion must fail because the new host/tool does not exist:

```ts
it('receives a first-time customer and sends one pinned threaded reply', async()=>{
  const office = await openTestInboundOffice({fixture:new InboundRestFixture(),approval:'allow'});
  const mail = office.fixture.message({from:'guest@example.test',text:'Is 2030-01-15 available?'});
  const signed = office.fixture.sign(mail.event,'msg_first');
  expect((await office.inbox.accept(signed.raw,signed.headers)).status).toBe(202);
  await office.session.tick();
  await office.solo.harness.waitForIdle(BACKGROUND_CONTEXT);
  expect(office.fixture.acceptances).toBe(1);
  const payload = office.fixture.sentPayloads[0];
  expect(payload.to).toEqual(['guest@example.test']);
  expect(payload.reply_to).toBe('desk@example.test');
  expect(payload.headers['In-Reply-To']).toBe('<first@example.test>');
  expect(payload.headers.References).toBe('<first@example.test>');
  expect((await office.solo.harness.snapshot(ContactsDoc,BACKGROUND_CONTEXT))?.contacts??[]).toEqual([]);
  await office.close();
});
```

Fixture `.message(partial)` generates/stores receiving/event pairs; `.sign(event,id)` uses fixture clock/secret; `.sentPayloads` is parsed saved POST payloads from existing fake adapter. Faux responses call check_schedule then reply_message with generated UUID and exact text, then yield; follow the existing `fauxProvider/createModels` patterns in solo/messaging tests. Run this focused test and record the expected missing-symbol failure before product implementation.

- [ ] **Step 2: Implement protocol verification/normalization with failing negative fixtures first.**

Write table tests whose mutations produce zero inbox rows, GETs and model calls:

```ts
it.each(['bad-secret','changed-raw','stale','future','bad-base64','missing-header',
  'duplicate-header','oversized-raw','bad-uuid','conflicting-message-id'])(
  'fails closed for %s', async mutation=>{
    const fixture = new InboundRestFixture();
    const signed = fixture.sign(fixture.message({}).event,'msg_negative');
    const changed = fixture.mutateSigned(signed,mutation);
    await expect(fixture.acceptChanged(changed)).rejects.toThrow();
    expect(fixture.receiptCount).toBe(0);
    expect(fixture.gets).toBe(0);
  });
```

Use focused unit helpers to avoid routing mutation names through production. Also prove correct previous key/current key/multiple signatures, strict UTF-8 bytes, exact signed raw body and both tolerance endpoints. Reject duplicate raw HTTP headers in listener tests (Headers objects alone collapse duplicates). Normalize provider metadata/body using the exact limits/auth/thread/loop rules in spec. Test top-level `reply_to` empty, equal/different/multiple and header disagreement; forged auth headers never override server authentication. Test deep/child-limit HTML marked truncated, entities decoded, scripts/styles/quoted history/images omitted, asset URLs never fetched, empty-after-trim blocked, body/control limits and all listed loop markers. Existing check_schedule returns slots only, no customer PII; no added calendar-read scope is needed.

Run `npx vitest run packages/office/src/resend-inbound.test.ts`, verify intended failures, implement, rerun to green. Do not parse MIME raw downloads or reuse parser output as authorization.

- [ ] **Step 3: Implement durable inbox plus the real HTTP acknowledgement path.**

Implement exact new metadata/tables/receipt columns from spec, WAL/FULL/busy timeout/0600 filesystem creation and validation on reopen. Transactions bind event raw bytes + complete canonical event, email ID and initial receipt. Same event/different raw or same email/different canonical payload rejects; another event/same email/same payload records it and returns 200. Persist fetched canonical content excluding raw/download URLs and normalized data in distinct immutable columns, never mutating them into route state. Schema corruption/authority mismatch fails before effects. Internal accessors must copy objects rather than exposing mutable persisted state.

Write an HTTP integration test opening native loopback server on a test-only ephemeral port (`openResendListener` library may accept port 0 for tests; CLI never does). Send an actual signed raw POST while model/approval/provider GET is held at a barrier. Expect 202 and the fsynced row before releasing the barrier; repeat expects 200. Invalid paths/method/type/duplicate raw headers/timeouts/oversize return static error and zero durable effects. Force SQLite write failure: response 503, no accepted receipt/model. No listener-start implicit worker; CLI orchestrates tick. Intake uses short synchronous SQL independent of tick/send queues. Hold first receiving GET unresolved, POST a second signed event, and require 202 plus durable receipt before releasing GET; repeat with a held approval to prove queue independence.

Lifecycle assertion:

```ts
await listener.close();
await expect(fetch(listener.address+'/webhooks/resend', {method:'POST',body:raw})).rejects.toThrow();
expect(inbox.summaries()).toHaveLength(1); // durable intake survives server close
```

Track/abort sockets/readers, ensure blocked stream cancellation cannot prevent closing forever, close server before hosted inbox resources, and await all cleanup even after one error. Signal all worker/transport aborts first, then join listener readers, worker/settlement watchers and reply queue, and only then close shared inbox SQLite and independent outbound adapter. Harness shutdown stays concurrent with hosted cancellation; ownership releases after both complete. Run protocol/store/listener targeted tests to green before admission work.

- [ ] **Step 4: Add the portable reply contract/tool and exact in-tool approval.**

Declare ReplyTarget/ReplyMessenger/RepliesDoc in replies.ts and register reply_message. Parameters are only receiptId and text with additionalProperties false, replay safe. Execute: validate args/identity, find same-key successful historical row first, compare args, return old result; otherwise load/create exact intent memo using trusted `prepare(receiptId,String(api.conversationId))`, compare all target/text args; load/create full-bound decision after trusted pin; deny/no approver/malformed decision produces no send; send pinned intent; validate delivery receipt; commit same-key history once and return truthful accepted/recorded historical details. Separate RepliesDoc means generic firstContactCondition remains unchanged.

Approval callback takes fixed ID/description plus String(api IDs)/call ID and pinned route/thread/text arguments. Decision memo includes argsJson; compare before every replay. Use first-write-wins `api.memo` for decisions, preserve false, retain by/note with bounded safe shape. Host callback uses a new strict reply_approvals table in inbound.sqlite to cover the human-decision-before-tool-memo gap. Existing DecisionStore.decision(key) ignores saved request_json and recordDecision uses unchecked first-write-wins; do not assume they bind reply intent. New inbox `readReplyDecision(key,request)` and `recordReplyDecision(key,request,decision)` canonicalize/compare the complete trusted request at read and record, rejecting mismatch and preserving first decision. Leave existing root approval rows/schema and behavior unchanged. Do not add a generic manifest gate that would ask about arbitrary model args before receipt validation.

Portable unit tests use a fake ReplyMessenger whose prepare rejects wrong conversation/receipt and records complete send intent. Prove unconfigured reply/no approval/false/malformed answer/changed args/changed identity/bad target controls/cross-conversation all have no send and no history; successful replay avoids callback/transport and returns original target/text. Unit test existing generic firstContactCondition after a reply success still requires first-contact approval.

Run `npx vitest run agents/frontdesk/src/replies.test.ts agents/frontdesk/src/messaging.test.ts` to green. Preserve the ordinary role/default tools and operator AGENTS instructions; document this runtime slice does not enable customer booking mutations.

- [ ] **Step 5: Implement atomic route creation, exact admission reconciliation and bounded worker.**

Read installed pi-durable public types rather than inventing APIs:

```ts
// Atomic route + conversation creation, table reads occur before table writes.
await solo.harness.commit(async tx=>{
  const contacts = await tx.doc(ContactsDoc);
  const routes = await tx.doc(InboundRoutesDoc);
  // Resolve existing sender/contact route and conflicts before creation.
  const conversation = await tx.createConversation({ownership:{kind:'ownerless'}});
  await configure(tx,conversation.id,customerAgent);
  const mode = await tx.doc(InboundConversationDoc,conversation.id);
  mode.authorityId = authorityId;
  mode.senders = [canonicalFrom];
  routes.routes.push({authorityId,sender:canonicalFrom,conversationId:conversation.id,
    contactId:exactContact?.id??null,contactRevision:exactContact?.revision??null});
},BACKGROUND_CONTEXT);
// After committing the pinned inbox route/request/envelope:
const existing = await solo.harness.commit(async tx => {
  const record = await tx.submissionByRequest(conversation.id,requestId);
  // In this same commit validate record via tx.entry or matching tx.doc(InboxDoc,id).
  return record;
},BACKGROUND_CONTEXT);
// Validate existing type/conversation + UserEntry model content or queued InboxDoc item exactly.
const admitted = existing ?? await conversation.submit(
  {type:'input',content:envelope,requestId,whenBusy:'steer'},BACKGROUND_CONTEXT);
```

The real code handles existing routes without creation, contact aliases/conflicts, correct branded IDs, and saved result types. `tx.doc(ContactsDoc)` may initialize an absent empty framework document; this is permitted. No customer Contact record is created/updated, and no contact operation history is fabricated. Route/doc creation must be one atomic commit; never two databases or createConversation followed by a later route doc. Test route commit interruption then restart produces one customer conversation. Do not configure existing customer agent/masks on reopen. Fresh customer tools are the permitted intersection `check_schedule`/`reply_message`; retain removal masks. Add host extension allowlist hook and inbound-aware approver that refuses all other customer tools before showing an approval prompt. Operator-root hook reads marker absence and preserves all old behavior.

Worker one tick visits <=20 eligible receipts, retries each GET once, pins exact route/request/envelope and submits without waiting for settlement. Canonical request ID uses saved inbox UUID namespace. Existing queued records verify mode:'steer' and exact InboxDoc content by submission ID; placed/done/unanswered-entry records verify exactly one UserMessage content. Unanswered-no-entry with no saved admission ID becomes `submission_binding_unknown`, never recreated. Type/content/conversation mismatch becomes `submission_binding_conflict`. Receipt settlement watchers are independent and save static-safe results; no raw final customer model text in CLI logs.

Write failing fsynced tests for first-time sender, repeated address, two distinct senders/conversation isolation, existing contact/email change aliases, no inferred merge, unknown contact later linked, existing sender-to-other-contact conflict. Hold first faux generation/tool to receive second email and assert real queued mode steer and eventual single admission. Crash after submit before inbox update and queued/placed settlement transitions must recover original submission, not duplicate it. Alter pinned envelope/existing request content deliberately: worker blocks before reuse.

Run `npx vitest run packages/office/src/inbound-session.test.ts` and confirm all storage is actual fsynced JSONL, not MemoryStorage for recovery claims.

- [ ] **Step 6: Close the fast reply/admission race and secure approval concurrency.**

Trusted `prepare` looks up the pinned immutable receipt/conversation; if still prepared, find and exactly validate real Harness submission through harness.commit/tx.submissionByRequest as Step 5, then persist admission proof before returning ReplyTarget. No submission returns a static error, no prompt, no send. This shares one validation function with worker reconciliation so semantics cannot drift. Lookup and exact UserEntry/InboxDoc checks occur in one Harness commit using Tx methods, never a nonexistent Harness.submissionByRequest call.

Attachment ordering: createRole creates callbacks over `let attachedHarness:Harness|undefined`; Harness.open1.0.2 remains dispatch-paused. After openSolo returns, assign `attachedHarness=solo.harness`, create InboundSession, reconcile, then allow tick/submit/resume/waitForIdle. Probe keeps a separate unbound resolver and never requests progress. No progress call occurs in role creation/root configuration. Unbound callbacks fail closed. Test restored-pending early reply to prove it only executes after the active resolver is attached.

Fast model regression: wrap inbox's admission-update write with a barrier, let `conversation.submit` schedule faux reply immediately, and prove reply prepares/sends once before the worker's blocked update is released. Same prepared receipt with no submission must fail. Cross-conversation guessed receipt must never prompt.

Serialize all terminal operator approval interactions with one shared CLI promise queue used by both existing root cliApprover and the new inbound reply approver. Each queued prompt checks shutdown/context and uses the pinned exact request fields, JSON escaping all displayed values. Persist the inbound decision once in new inbox reply_approvals; both read and record compare full canonical request snapshot and conflicting same-key reuse rejects. Existing root DecisionStore retains historical behavior/rows. Add bound approval methods to ResendInbox's internal typed API, storing ApprovalRequest/ApprovalDecision imports from SDK; no change to old calendar database schemas is needed. Two customers both call reply; respond deny then allow and assert the first receipt has no POST, second has one to its own sender. Resume with allow does not overwrite saved deny. Interruption/EOF while waiting records no consent, preserves pending memo/tool.

Host wrapper refuses non-reply inbound calls before passing to existing root cliApprover, and host hook blocks ungated disallowed customer calls. Test fake model sends generic send_message/create_contact/book_appointment/list_contacts/list_bookings despite tool mask: zero prompts, zero customer/contact/calendar/outbound effects. check_schedule returns only slots, then reply can describe availability without unrelated contact/booking data.

- [ ] **Step 7: Implement separate durable reply provider ledger and loss recovery.**

New reply table lives in inbound.sqlite, uses exact intent/payload, globally separated key prefix and inbox namespace. Atomically reserve `receipt.reply_request_id` plus pending operation before POST; a different request ID for same receipt fails even after failure/expiry. Old email.sqlite is not opened through a changed schema. Implement pinned payload exactly from spec, including reply_to and only server-owned In-Reply-To/References/Auto-Submitted/X-Auto-Response-Suppress headers. No sent-email GET enrichment or made-up RFC Message-ID.

Use existing resend-messenger.ts as semantic reference: serialize whole validation/ledger/credential/time/network/receipt operation; accepted replay first; key reuse full payload check; no-reset first/last clocks and exact 23-hour cutoff; bounded fetch/read deadline; abort active request/drain queue; never retain raw provider failure causes. Split shared helpers only if old byte-level tests prove no change. Role history commit happens only after durable adapter acceptance.

Fake-provider assertions:

```ts
fixture.loseNextResponse = true;
await expect(transport.send(intent,{requestId:'1:2:reply'})).rejects.toThrow();
expect(fixture.acceptances).toBe(1);
await transport.close();
const recovered = createResendReplyMessenger(reopenOptions);
await recovered.send(intent,{requestId:'1:2:reply'});
expect(fixture.posts).toBe(2);
expect(fixture.acceptances).toBe(1);
expect(fixture.requests[1].key).toBe(fixture.requests[0].key);
expect(fixture.requests[1].payload).toBe(fixture.requests[0].payload);
```

Test changed destination/subject/headers/text/key authority rejected before credential/POST; receipt one-operation cap; fresh namespaces separated; accepted replay decades later credential-free; pending exact 23-hour cutoff/clock regression zero POST; recheck after delayed credential; 409 same-key conflicts; malformed/oversized/slow/redirect/closed response; callback rotation; no safe-error leakage. Save full References chain per parent, preserving case, fallback single In-Reply-To, no unrelated topic chain leakage.

- [ ] **Step 8: Integrate runnable CLI listen/inbox/resume under ownership.**

Parse listen model/calendar/messenger/state/port/approval, and inbox state only; reject demo live inference, console listener and unsupported flags. Validate current signing key nonsecret presence without outputting it; optional previous key. Select Resend/inbound nonsecret authority from saved state or explicit first configuration; mismatches reject before opening effects. Open inbox/reply adapter inside existing locked createRole factory. After openSolo returns, attach host getHarness callback/worker, immediately reconcile/tick, then open listener and run 5-second bounded worker ticks until active cleanup is requested. A bound listener is the process's owned active operation, no spawned server thread or shell tunnel.

Resume's existing two-phase model probe must neither schedule inbound work nor read/fetch/reply before actual saved model selection. It may register trusted reply tools/inbox resources under guard, but only active selected runtime attaches/ticks/resumes worker. Reconcile before starting fresh intake; existing pending root tools/decisions remain replayable. Read-only inbox uses existing guard helper and never creates live metadata/resources. Preserve contacts/bookings credential-free inspection.

README example (placeholder identifiers, no real secret values):

```sh
npm run build
node packages/cli/dist/index.js listen --state .officehum/frontdesk-resend --messenger resend --port 8787
node packages/cli/dist/index.js inbox --state .officehum/frontdesk-resend
node packages/cli/dist/index.js resume --state .officehum/frontdesk-resend
```

Document required nonsecret configuration and secret env variable **names**, separate local public HTTPS forwarding/manual provider webhook setup prerequisite, bind path, interactive review, explicit `--approval allow` scoped runtime and default limit to availability/reply. No implementation tool changes provider setup or starts a tunnel. Explain block reason codes, pending send TTL investigation, one reply receipt cap, preserve state files and live human acceptance outstanding.

CLI test dependency injection uses fake REST/model builders (same established pattern as existing CliDependencies), actual native local listener and temporary state. Verify acknowledgement while prompt held, first-customer reply payload, resume existing signed intake without listener, read-only sanitized blocked inbox, malformed/config/legacy/console failures, duplicate listener/owner attempts, factory/port-bind/model selection cleanup, SIGINT draining/body/fetch abort, exact terminal-safe prompt and no copied email consent. No wait for every customer result in a long-lived listener. Runtime error reporting never prints untrusted provider/SQLite raw content.

- [ ] **Step 9: Verify real interrupted Harness recovery and existing-state compatibility.**

Use actual fsynced reopen barriers at these boundaries: route commit; fetched prepared commit; queued/placed Harness admission before inbox update; bound inbox human decision store before tool memo; provider acceptance before ledger receipt; adapter receipt before RepliesDoc; RepliesDoc before tool settlement. For each assert original request/conversation/submission/target/text/headers/decision, one successful history and one provider acceptance; accepted replay does no POST. Expired uncertain replay does no POST/no role success. Denied replay never reprompts or sends. This exercises real durable task/tool invocations, not a manually repeated adapter-only send.

Seed an existing Resend outbound state with both accepted/pending email_operations rows and explicit removed-tool selection. Snapshot rows/payload/key/namespace/messenger.json before and after adding inbox/listen/resume. They must be identical; generic send_message first-contact/history tests still pass. Seed console, legacy pending/declined approvals and old migration docs: console cannot listen, normal resume preserves tools/masks/decisions. Use local calendar and one fake Google host recovery case so provider/calendar/shared session authority is preserved.

Also test unanswered-no-entry cancellation, unknown/conflicting existing submission envelope, newly created contact linking conflicts, multiple subjects in same conversation, parser structural limits and closed reader cancellation. These pin the Review Focus lines above rather than leaving them for final reviewer discovery.

- [ ] **Step 10: Run checks, inspect diff, finish documentation and hand off one fresh review.**

```sh
npx vitest run packages/office/src/resend-inbound.test.ts packages/office/src/resend-inbox.test.ts packages/office/src/inbound-session.test.ts packages/office/src/resend-replies.test.ts packages/office/src/resend-listener.test.ts agents/frontdesk/src/replies.test.ts packages/cli/src/cli.test.ts
npm run check
git diff --check
git diff --stat
```

Read the full diff for accidental credentials/customer content, changed outbound schema/payload, duplicate locks, unconstrained URLs, silent retargeting, early ACK, erased pending decisions, broad customer tools and fake-only recovery assertions. Update spec/plan checkboxes with any justified implementation choice; no placeholders remain. Root requests one fresh GPT-6.1 Sol combined design/spec/code/security review, fixes actionable findings with GPT-5.6 Sol, reruns affected checks, then handles commit/PR/CI/merge under standing authorization. Do not claim live send/receive verified and do not close the broader issues.

## Plan self-review

All spec sections map to Task 1: Steps 1–3 own provider/raw/HTTP/parser/schema; Steps 4/6 own portable pinning/approval/security; Step 5 owns routes/admission/steering; Step 7 owns durable send/threading/TTL; Step 8 owns runnable lifecycle/resume/docs; Step 9 owns fsynced crash/compatibility regressions; Step 10 owns final verification/review. The five Review Focus conditions have explicit tests. Stable interfaces distinguish inbox intake from worker admission and role reply transport. No live provider operation, migration, hosted gateway, sent-ID enrichment or unapproved state cleanup is implicit.
