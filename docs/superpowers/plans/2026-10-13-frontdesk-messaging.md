# Front Desk messaging implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for the selected GPT-5.6 Sol implementation / GPT-6.1 Sol review split. One coherent code task; autonomous execution is authorized without routine approval pauses.

**Goal:** Add portable messages with immutable first-contact approvals and a durable console outbox, without contacting customers.

**Architecture:** Explicit contact/destination/transport/text arguments bind approval to the effect. SDK predicates read durable history and persist applicability; Front Desk pins intent and successful receipts; the console adapter deduplicates effects across response loss.

**Tech Stack:** TypeScript, Node >=22.19.0, Pi Durable 1.0.2, SQLite, Vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-13-frontdesk-messaging-design.md` (read in full).

## Global constraints

- Preserve local/Google calendars, old `frontdesk({calendar})` calls, root/model/conversation identity, pending work, overlays and portable packaging.
- No real customer delivery, provider integration, OAuth/auth, inbound parsing, proactive outreach, named limits, discounts, payments, deletion, deployment or calendar/schema changes.
- Transport identity is explicit in tool arguments and all durable messaging state; console history never authorizes a real transport.
- Keys derive only from conversation/task/call identity. Approval alone and adapter failure never create successful history.
- Controller handles Linear RASF-3257, commits, PR, CI and merge; RASF-3130/3124 remain open for their remaining scope. Use synthetic temporary state only.

## Review focus

1. A declined interrupted call must remain blocked after another conversation establishes target history.
2. A transport switch after approval must not turn console authorization into a real send.
3. Contact changes after intent pinning must not redirect a retry or erase its original receipt.
4. Adapter persistence before a lost response/history commit must recover one effect, even with concurrent retries.
5. Current overlay removals, persisted masks and custom selections must not be reset by the send-tool migration.

### Task 1: Complete portable approved messaging and the console host

**Files:** Create `agents/frontdesk/src/messaging.ts`, `messaging.test.ts`, `packages/office/src/console-messenger.ts`, `console-messenger.test.ts`. Modify `agents/frontdesk/src/index.ts`, `index.test.ts`, `officehum.json`, `AGENTS.md`, `APPEND_SYSTEM.md`; `packages/sdk/src/approvals.ts`, `approvals.test.ts`, `role.ts`, `role.test.ts`, `index.ts`; `packages/office/src/solo.ts`, `solo.test.ts`, `index.ts`; `packages/cli/src/cli.ts`, `cli.test.ts`; `README.md`, `docs/design/agent-package.md`. Existing ContactsDoc and calendar modules stay unchanged.

**Interfaces:** SDK exports ApprovalCondition/ApprovalConditionContext exactly as the spec states. Front Desk exports MessageChannel, MessageIntent, DeliveryReceipt, Messenger and MessagesDoc; optional `FrontDeskOptions.messenger`. `messaging.ts` exports `messagingTools(messenger?:Messenger):ToolRegistration[]` and `firstContactCondition:ApprovalCondition`. Office exports `openConsoleMessenger(path:string):ConsoleMessenger` with `identity`, `send`, `messages():ConsoleMessage[]`, `close():void`; ConsoleMessage is `{requestId:string,intent:MessageIntent,delivery:DeliveryReceipt}` with structurally identical Office-owned types. Tool arguments and document/memo records follow the spec verbatim.

- [ ] Add SDK failing tests for async document predicates through an actual MemoryStorage Harness, one-argument sync predicates, static comparisons/precedence, missing approver, throws/rejections/nonboolean results and cancellation. Add memo replay tests: persist true/false applicability, mutate document history, and verify unchanged outcome; preserve legacy approved/denied decision formats and block differing arguments under the same call identity. Assert the reader offers only bound snapshot/snapshotAsOf methods. Run `npx vitest run packages/sdk/src/approvals.test.ts packages/sdk/src/role.test.ts` and confirm the new behavior fails before implementation.
- [ ] Implement typed async conditions and durable applicability in approvalGate/defineRole. Use the existing `officehum.approval.${call.id}.${approval.id}` decision key; use a separate `officehum.approval-intent.${call.id}.${approval.id}` applicability key. Read/bind existing state before recalculation; preserve a prior decision even without an applicability memo. First-writer-wins requiredness must settle before approve/bypass; canonicalize recursive JSON argument order and reject different tool/args. Predicate errors mean required=true except active cancellation. Wire SDK exports and update tests that assert all memo values to distinguish the new applicability record from unchanged decision records.

```ts
export type ApprovalConditionContext = {readonly read:DocumentReader};
export type ApprovalCondition = (
  args:ToolArguments, environment:ApprovalConditionContext, context:HookContext,
) => boolean | Promise<boolean>;
// HookApi is a DocumentReader in installed Pi Durable 1.0.2.
// Preserve method binding when constructing the read-only environment.
const read = {snapshot:api.snapshot.bind(api), snapshotAsOf:api.snapshotAsOf.bind(api)};
```

- [ ] Add actual role Harness failing tests using `fauxProvider`, `createModels`, `createRegistry`, `Harness.open(new MemoryStorage(),{models,registry},BACKGROUND_CONTEXT)`, and existing contact seeding patterns. Supply synthetic Messenger identity `test.transport.v1`; model calls `send_message` with `{contactId:'contact-1',channel:'email',to:'guest@example.test',text:'Appointment confirmed.\nThank you.',messengerId:'test.transport.v1'}`. Assert the approver sees these exact fields, `first_contact` applies once, follow-up with a new call ID proceeds without an approver, and MessagesDoc contains the exact intent/receipt. Creation/bookings alone and changed address/channel/contact/transport require fresh approval. Denied/missing approval, unknown/same-name mistaken ID, blank/control/oversized text, noncanonical target, undeclared properties, missing Messenger and destination mismatch cause no adapter effect/history. Run `npx vitest run agents/frontdesk/src/messaging.test.ts agents/frontdesk/src/index.test.ts` to confirm failures.
- [ ] Implement messagingTools and firstContactCondition around lazy session MessagesDoc. Register `send_message` as replay-safe with five required explicit fields, advertise injected identity in its description, add manifest `first_contact` approval and wire the predicate into defineRole. Export the portable contracts. Canonical IDs/target/text validate before effects; schema validation never silently transforms approved arguments. Condition snapshots successful tuple history using only `{read}`; absent/malformed state cannot bypass first approval.

```ts
const key = `${api.conversationId}:${api.taskId}:${api.callId}`;
// Validate messenger identity/full args; replay committed receipt before current profile checks.
type MessageIntentMemo = {
  key:string; argsJson:string; messengerId:string; contactId:string;
  contactRevision:number; contactName:string; to:string; channel:MessageChannel; text:string;
};
const argsJson = JSON.stringify({contactId:args.contactId, channel:args.channel,
  to:args.to, text:args.text, messengerId:args.messengerId});
let pinned = await api.memo<MessageIntentMemo>('frontdesk.message-intent', context);
if (pinned === undefined) {
  const contact = (await api.snapshot(ContactsDoc, context))?.contacts
    .find(({id}) => id === args.contactId);
  if (contact === undefined || (args.channel === 'email' ? contact.email : contact.phone) !== args.to)
    throw new Error('Contact destination mismatch. List current contacts before retrying.');
  pinned = await api.memo('frontdesk.message-intent', {key, argsJson,
    messengerId:args.messengerId, contactId:contact.id, contactRevision:contact.revision,
    contactName:contact.name, to:args.to, channel:args.channel, text:args.text}, context);
}
// Compare pinned.argsJson/messengerId with this call before invoking the adapter.
const delivery = await messenger.send(
  {to:pinned.to, channel:pinned.channel, text:pinned.text}, {requestId:key},
);
// Validate delivery, then compare/insert one detached success record inside api.commit.
```

- [ ] Implement first-contact eligibility from successful `{messengerId,contactId,channel,to}` records only. Persist full contact metadata/intent/delivery; preserve original text and request key. Validate current contact destination at the initial snapshot before creating the first intent memo; later edits cannot redirect the explicit target, and recovery after a saved memo always uses that old target. Matching committed records return historical receipts without adapter calls. Changed arguments/transport under the same key fail closed. Return explicit recorded-versus-accepted copy and `replayed`; receipt/history commit failure cannot be described as completed. Never hold a role commit or adapter transaction across an external asynchronous effect.
- [ ] Add console adapter transaction tests before implementing it: two adapter instances with the same temporary SQLite file concurrently send the same key/intent and obtain one identical recorded receipt/row; different intent rejects; reopen returns the stable receipt; malformed row/fixed identity rejects. Implement separate SQLite `messages.sqlite` storage with unique request key, complete intent, stable ID/receipt and fixed `officehum.console.v1` identity. Use BEGIN IMMEDIATE, WAL, synchronous FULL and bound parameters; expose messages()/close() without any network or Front Desk dependency. Run `npx vitest run packages/office/src/console-messenger.test.ts agents/frontdesk/src/messaging.test.ts`.
- [ ] Add JSONL recovery tests in solo.test.ts using existing cancellation-aware barriers. Pi 1.0.2 settles beforeTool blocks directly without afterTool: for declined first contact, wrap the actual gate registration's public `handlers.beforeTool`, await its persisted-decline block, then pause before returning that block. Use another Harness conversation to approve/send the same tuple, close/reopen/resume the original submission ID, and assert it stays declined. For approval-before-execute, wrap the actual registered tool's execute with a cancellation-aware barrier, close/reopen with a different Messenger identity, and assert no effect. For intent-before-send, wrap Messenger.send to signal a barrier before effect, edit contact via another conversation, close/reopen/resume and assert original destination/text. For outbox-before-history, wrap send to persist its actual receipt then wait before returning; recover one row and one MessagesDoc record. For history-before-settlement, use `hook(ToolTask,{afterTool})` barrier and assert zero further adapter calls. Every case asserts one durable decision, original submission ID, exact saved intent and truthful receipt status; do not substitute repeated direct helper calls for actual recovery.
- [ ] Test concurrent first-contact tool calls (both may need approval), independent follow-ups, same-key role/adapter retries, and changed-key intent rejection with real transactions. Cover session sharing/fork behavior and bare-Harness `validatePackage`/`checkAgent` portability. Exercise local and existing fake Google calendar hosts with the same console Messenger injection; calendar functionality remains green and no live Google/Messenger/customer request occurs.
- [ ] Extend solo's one-time migration after lifecycle/contact migrations with a conversation marker `officehum.frontdesk.message-tools-migration` and recognized prior Front Desk selections. Add send_message only when permitted; preserve overlay removals/persisted masks and unrelated selections. Test old two/five/eight tool roots, repeat opens, disabled send tool, custom subsets, model/conversation identity and pending submission preservation. Object removal masks follow current registry defaults without erasing masks.
- [ ] Inject/open the console Messenger in both CLI start/demo and resume paths for both calendar backends; close it on success/error/interrupt and advertise `Messaging: console outbox; no customer delivery.` Test injection, reopen recovery, missing/corrupt console identity, and unchanged synthetic booking demo. Do not add a real transport selector or messages mutation command. Update role instructions, README synthetic start-message examples, and SDK docs for async reader predicates/applicability/error behavior; explicitly defer named limits/provider delivery and explain pinned old-target retries.
- [ ] Run focused tests above, then `npm run check`; fix failures and rerun affected checks. Review the entire diff for accidental customer/provider writes, new dependencies, leaked credentials, unsupported delivery claims, transport/approval race gaps and unintentional overlay migration changes. Report exact checks and scoped remaining parent work to the controller; controller creates/merges the PR on green and updates Linear.
