# Front Desk messaging and first-contact approval design

Date: 2026-10-13. Architectural slice; autonomous execution authorized. GPT-6.1 Sol designs/reviews; GPT-5.6 Sol implements. Scoped Linear child RASF-3257 belongs to RASF-3130 and relates to RASF-3124/3255; the broader parents stay open.

## Intent and scope

Operators request messages to exact saved contacts. The first successful outreach to each contact/channel/destination/transport needs approval; subsequent messages to that same target proceed without another first-contact approval. Creation, correction, booking, an approval alone, and a failed send never establish messaging history. Changing destination, channel, contact identity, or transport requires fresh approval. This is application workflow history, not a claim about regulatory consent.

Build the portable role capability and a durable console outbox injected by the solo CLI. No real customer delivery, provider integration, OAuth/auth, inbound parsing, proactive outreach, new dependencies, named approval limits, discount booking, payments, deletion, deployment, or existing calendar/schema changes. Preserve local/Google calendar behavior, old `frontdesk({calendar})` calls, model/conversation identity, pending work, overlays and bare-Harness portability.

Use explicit destination and transport arguments, rather than resolving a mutable contact after approval. A pre-gate preparation framework would expand the SDK unnecessarily; unconditional approvals would defeat known-target follow-ups. A minimal async document-reading predicate plus durable applicability snapshots provides the selected boundary.

## Portable contracts

Export these Front Desk contracts and `MessagesDoc` from `src/index.ts`; the role never imports Office or CLI:

```ts
type MessageChannel = 'email' | 'sms';
type MessageIntent = {to:string; channel:MessageChannel; text:string};
type DeliveryReceipt = {id:string; status:'recorded'|'accepted'};
interface Messenger {
  readonly identity: string;
  send(intent:MessageIntent, options:{requestId:string}):Promise<DeliveryReceipt>;
}
```

`FrontDeskOptions.messenger?: Messenger` is optional. Its stable identity identifies the transport/tenant namespace, changes whenever that delivery authority changes, and appears in the tool description. `send_message({contactId,channel,to,text,messengerId})` requires all five fields and rejects undeclared properties. Missing Messenger fails without effects. `messengerId` must exactly equal the injected identity; an old console-approved call cannot resume against a real transport. Transport identity is included in approval arguments, intent memos, history and receipts.

Use exact existing contact IDs. Require `to` already canonical: lowercase validated email or canonical international phone, equal to the chosen contact's current field before the first execution intent is pinned. Do not infer names/IDs, guess phone prefixes or silently rewrite the approved destination. Bound IDs/transport identity to 200 characters; reject blanks, outer whitespace and control characters. Text is preserved byte-for-byte, 1–4000 characters, nonblank; allow line breaks/tab, reject other C0/C1 controls. Approval displays the exact identity, destination, channel and text supplied. These fields are data and cannot grant approval or mark a target known.

The injected adapter must atomically bind `requestId` to the complete `{to,channel,text}` intent, return the same successful receipt for matching retries, reject changed intent under the same key, and prevent duplicate effects during concurrency/response loss. It must recover or reconcile uncertain outcomes before retrying an effect; adapters unable to do this cannot support this replay-safe tool. `recorded` means synthetic outbox persistence only; `accepted` means the external transport accepted the message, not verified customer delivery. No unsupported delivery claim appears in tool results or CLI copy.

## SDK condition and approval snapshot

Export `ApprovalConditionContext = {readonly read:DocumentReader}` and `ApprovalCondition = (args:ToolArguments, environment:ApprovalConditionContext, context:HookContext) => boolean|Promise<boolean>`. Use this type in `ApprovalGateOptions.when` and `DefineRoleOptions.when`. Existing one-argument synchronous predicates remain assignable; existing static manifest conditions keep their comparison semantics and precedence. Supply only bound `snapshot`/`snapshotAsOf` methods, not mutation APIs, to `read`. No named-limits field or manifest change is introduced.

For each matching approval, canonicalize the JSON arguments with recursively sorted object keys and persist a first-writer-wins applicability memo containing `{tool,argsJson,required}` before asking or bypassing approval. Predicate throws/rejections or nonboolean results mean `required:true`; active cancellation must propagate rather than becoming an approval request. Bind and validate the memo on every replay. Both true and false are immutable for that call even if durable history changes afterward. Existing decision memos take precedence over recalculation: a legacy stored decision without applicability still applies, especially a decline. Preserve existing decision memo keys and formats. New mismatched tool/arguments reject rather than reuse a decision. No approver blocks required calls; decline remains decline; approver failures are not saved as approval.

Manifest approval `first_contact` gates `send_message`. Its async predicate uses committed snapshots of ContactsDoc and MessagesDoc. It requires approval unless a successful receipt exists for the exact `{messengerId,contactId,channel,to}`; missing/unreadable state fails safe. The tool itself authoritatively validates contact, destination, text and transport. Two concurrent first sends may each need approval; this is safe. Known-target sends need no approver, including after restart, but must still pass execution validation.

## Execution, history and recovery

Define lazy session document `frontdesk.messages`, version 1, initial `{messages:[]}`. Each successful record stores `{key,argsJson,messengerId,contactId,contactRevision,contactName,to,channel,text,delivery}` as detached JSON-safe values. The key derives only from `${api.conversationId}:${api.taskId}:${api.callId}`. History is retained without eviction; no ContactsDoc version change or mutable consent flag is needed. Console history is valid only in its own transport namespace and never establishes real delivery history.

Execute in this order: validate configured transport and canonical arguments; return a matching historical role receipt if already committed; otherwise load `frontdesk.message-intent` task memo. For a new intent, snapshot and validate the exact contact/destination, then save the complete record except delivery with first-writer-wins `api.memo`. Validate existing memos against the full arguments and transport. Invoke `messenger.send({to,channel,text},{requestId:key})` using only the pinned intent. Validate its receipt, then `api.commit(async tx => tx.doc(MessagesDoc), context)` to atomically compare/insert the successful record. A conflicting record rejects. Do not retain draft document references outside the commit callback.

The initial contact-validation snapshot is the selection point: an already changed destination causes mismatch rejection and no send. A later edit cannot redirect the explicit approved target, including an edit between snapshot and memo creation. Once pinned, an in-flight send/retry continues to the originally approved destination/text/transport even after contact edits. Profile/name revisions are historical metadata, not replay preconditions. The explicit immutable call arguments protect the approval-to-intent gap. An interrupted false applicability decision cannot be widened to another target because the argument binding is immutable.

Failure/denial leaves no success history. Interruption after adapter persistence but before role commit reruns the same adapter key, obtains its original receipt and completes history once. Interruption after role commit returns that historical receipt without another adapter call. A receipt reports the saved contact snapshot and exact intent with `replayed:boolean`; text says “Recorded in console outbox; no customer delivery” or “Accepted by transport”, and labels replays historical. Never claim the whole send succeeded when the history commit failed; the outbox may already contain the pinned message and recovery uses the original submission.

## Demo host and compatibility

Add Office `openConsoleMessenger(path)` with fixed identity `officehum.console.v1`, structurally implementing Messenger without importing Front Desk. It exposes `send`, `messages()` for tests/inspection, and `close`. Store request key, complete intent and successful recorded receipt in a separate `messages.sqlite` table with a unique key, atomic SQLite transaction, WAL and synchronous FULL. Concurrent same-key calls return one stable receipt/row; changed intent rejects. Validate persisted rows and stored fixed identity, rejecting corrupt/mismatched storage. No network or provider request occurs. Role commits and adapter transactions never remain open across an external asynchronous send.

The CLI always injects this console host on start/demo/resume for either calendar backend, closes it on every path, and prints “Messaging: console outbox; no customer delivery.” It has no real transport selector or mutation bypass. Synthetic demo booking behavior remains compatible; document a `start --message` example using a synthetic saved contact and ordinary approval. Read-only messages CLI is deferred. A new one-time send-tool migration runs after existing lifecycle/contact migrations, upgrading recognized older Front Desk explicit selections while preserving current overlay removals, persisted masks, unrelated selections, root/model and pending submissions.

## Acceptance and self-review

Use actual MemoryStorage Harness and fsynced JSONL solo tests. Cover approved/denied/missing approval, creation/booking without messaging history, known-target follow-ups, changed address/channel/contact/transport, same-name contacts, exact text, invalid arguments, missing Messenger, thrown/rejected/nonboolean async conditions, existing synchronous/static behavior, changed-call binding and legacy decisions. Pause a declined first-contact call before tool settlement, establish successful history in another conversation, then close/reopen/resume the original submission and assert its decline still blocks.

Interrupt after approval but before execute and reopen with another transport: no send. Interrupt after memo, edit the contact, and recover the original destination. Interrupt after console persistence before role commit, and after role commit before settlement; assert one row/history record/decision, stable full receipt and original submission ID. Test parallel sends and same-key adapter retries against real transactions, with differing intent rejected. Exercise local and fake Google calendar injection; assert no actual external Messenger or customer call. Verify old selections/removal masks, pending work/model preservation, `validatePackage`, `checkAgent` and all repository checks. The single implementation task covers every requirement; no unresolved placeholders or deferred safety boundary remains.
