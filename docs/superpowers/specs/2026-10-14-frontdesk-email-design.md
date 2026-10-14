# Front Desk outbound Resend email design

Date: 2026-10-14. Architectural slice; autonomous execution authorized. GPT-6.1 Sol designs/reviews and GPT-5.6 Sol implements. Resend is the operator's selected email provider. Scoped Linear child RASF-3261 implements the outbound email portion of RASF-3161, related to RASF-3130/3257 and the provider-choice work in RASF-3159; inbound email, threaded conversations, account provisioning and SMS remain open.

## Intent, alternatives and scope

The operator can explicitly bind a fresh Front Desk state directory to Resend and send exact plain-text messages through the existing saved-contact tool. Recovery preserves the approved destination, body, sender, subject and transport authority. Console remains the default, and the credential-free demo remains synthetic. A receipt means transport acceptance, never confirmed delivery.

Choose a small host adapter in `@officehum/office` using native fetch and SQLite. A new provider workspace would add packaging without an additional consumer; the vendor SDK would add a dependency while leaving durable recovery to us. Extending the portable role with provider fields would expose host configuration to the model and widen the existing tool contract. Keep `send_message` and the Messenger interface unchanged.

No inbound processing, threading, HTML, CC/BCC, attachments, scheduling, webhooks, DNS/account/mailbox changes, OAuth, payment changes, deployment or actual customer sends are part of implementation or verification. Existing local/Google calendars, contact revisions, overlays, pending submissions and approval snapshots retain their behavior. Tests use fake REST and models; no live credentials are necessary. Customer sends remain subject to the owner's explicit-authorization policy.

## Contracts and configuration

The adapter structurally implements the existing portable contract without importing Front Desk:

```ts
interface Messenger {
  readonly identity: string;
  send(intent: {to:string; channel:'email'|'sms'; text:string},
    options: {requestId:string}): Promise<{id:string; status:'recorded'|'accepted'}>;
}
type ResendMessengerOptions = {
  accountId:string; fromEmail:string; subject:string;
  getApiKey:()=>Promise<string>;
  fetch?:typeof globalThis.fetch;
  now?:()=>number;
};
interface ResendMessenger extends Messenger { close():Promise<void> }
function openResendMessenger(path:string, options:ResendMessengerOptions):ResendMessenger;
```

Native fetch targets only `https://api.resend.com/emails`; redirects are rejected. The fetch/clock options exist for testing, not CLI configuration. There is no configurable API origin. Every actual attempt reads its credential through `getApiKey`; accepted replays need neither a token nor a network call. Credentials are never persisted, hashed into identities, logged, included in error causes, or accepted in command arguments.

CLI adds `--messenger console|resend` to `start` and `resume`; `demo` may explicitly select console and rejects Resend. `contacts` and `bookings` do not open or bind any Messenger and do not require its credential/configuration. Mere presence of Resend environment variables cannot select live transport.

Initial Resend binding requires `RESEND_ACCOUNT_ID`, `RESEND_FROM_EMAIL` and `RESEND_SUBJECT`. `RESEND_ACCOUNT_ID` is a stable, operator-declared nonsecret authority namespace, not an automatically verified vendor account ID. Key rotation is supported only within that same Resend account. The host cannot detect a key from another account: the operator must preserve this invariant. `RESEND_API_KEY` is read only from the environment callback when sending. Require a key preflight for live start/resume, without displaying its value; direct accepted adapter replays still work without one.

Account namespace is exact, 1–100 characters, no outer whitespace or C0/C1 controls. Sender is a bare lowercase canonical mailbox, 1–254 characters, matching the role's email validation; display-name syntax is excluded. Subject is exact, nonblank, 1–200 characters, no outer whitespace or C0/C1 controls. It is fixed for this state and included in every payload. Destination is a canonical lowercase mailbox matching existing validation; body is exact, nonblank, 1–4000 characters with only tab/newline/carriage-return controls allowed. Reject SMS before creating a ledger operation or making a request. Request IDs are exact, 1–500 characters, with no outer whitespace or controls.

CLI displays the selected transport, declared account namespace, sender, fixed subject and Messenger identity before submitting/resuming work. Show fixed subject in the operator setup instructions so plain-text tool approval has visible configuration context. The role's explicit `messengerId` still binds the call's authority; its existing identity checks, pinned intent, applicability memo, successful history and first-contact rules remain authoritative. Console history cannot authorize Resend because the identity differs.

## Persisted transport authority and ownership

Add strict `messenger.json` metadata, separate from the existing calendar connector:

```ts
type MessengerIdentity =
  | {version:1; backend:'console'}
  | {version:1; backend:'resend'; accountId:string; fromEmail:string; subject:string};
```

Parse exact keys/types and validate every field. Console retains `officehum.console.v1`. Resend's identity is `officehum.resend.v1:` plus a SHA-256 hex digest of canonical `{version,backend,accountId,fromEmail,subject}`; it fits the role's 200-character bound. The credential is excluded. Both `messenger.json` and the SQLite ledger metadata must agree with this authority.

On an existing binding, omitted `--messenger` infers the saved backend. Omitted Resend configuration uses saved nonsecret values; any supplied differing value rejects. Explicit backend, account, sender or subject changes reject and require a fresh state directory. Resume cannot fall back to console because a key is missing. Demo against live state rejects. Never rewrite a mismatched or malformed identity.

An identity-free state with a Harness, successful console rows, or durable calendar booking/approval/operation records is legacy console. Reject live binding before writing transport metadata. An empty calendar preflight database and console metadata with zero message rows do not alone establish historical work. An unexpected `email.sqlite` without `messenger.json` fails closed: do not guess a live authority or overwrite that ledger. No state schema/data migration is required; an eligible legacy console state gains only its explicit console identity under ownership. Existing console rows and session documents are preserved.

Extend `openSolo` with an optional hosted-role construction path:

```ts
type HostedSoloRole = {role:RoleBundle; close:()=>void|Promise<void>};
// Existing {role,...} calls stay valid. Factory callers supply messengerIdentity.
type RoleSource =
  | {role:RoleBundle; createRole?:never; messengerIdentity?:MessengerIdentity}
  | {role?:never; createRole:()=>HostedSoloRole|Promise<HostedSoloRole>;
     messengerIdentity:MessengerIdentity};
```

After acquiring the existing `ownership.sqlite` guard, `openSolo` re-reads and validates/binds both authorities, then awaits `createRole`, then opens the Harness. A stale preflight selection cannot bypass this locked check. CLI creates the Messenger only inside that factory; no adapter is opened on identity mismatch. A factory that throws awaits cleanup of resources it opened before returning. Once returned, `openSolo` owns its cleanup on every failure/close path, including model-mode mismatch. Initiate Harness shutdown and hosted cleanup together, await both even if either fails, then release ownership; adapter close aborts active fetches, rejects queued work, drains the queue, and then closes its database. Preserve the existing static-role path for portable/test callers.

The same lock protects start and both phases of resume. Read-only contact inspection retains its existing lock but does not create Messenger metadata. Read-only calendar inspection does not initialize messaging. Adapter construction and metadata reads perform no network request.

## Ledger, payload and provider keys

Add `email.sqlite`, with WAL, synchronous FULL, busy timeout and bound SQL parameters. Metadata contains the exact transport authority and a random UUID ledger namespace generated once. The namespace separates fresh states whose durable call counters could otherwise produce identical request IDs; copied/restored ledgers retain it. Validate metadata and every existing operation on open; unknown schema/extra metadata, inconsistent intent, state or receipt fails closed.

Each operation binds a unique request ID to the complete stable payload `{from,to:[to],subject,text}`, exact intent, provider key, first-attempt timestamp, last-observed timestamp, and either pending state or accepted `{id,status:'accepted'}`. Use ordered canonical JSON, not a hash-only intent comparison. Provider key is `officehum.email.v1/` plus SHA-256 of JSON `[messengerIdentity,ledgerNamespace,requestId]`; it is below 256 characters, stable across reopen, and independent of changed message arguments. A reused request ID with changed payload rejects before credential/network access. No operation is deleted or given a new key after a failure.

Serialize each complete send operation through one adapter queue, including validation, ledger lookup, credential retrieval, timestamp checks, HTTP attempt and acceptance persistence. SQL transactions remain short and end before network awaits. Concurrent same-key calls to independent adapters sharing the ledger use the same provider key/payload; the provider handles in-flight conflicts, while atomic insert/receipt checks protect local state. The host's state-directory guard prevents two CLI owners. No claim covers independently operated ledgers, copied states beyond the provider window, provider writers, or changing the declared account's actual credential authority.

Send algorithm:

1. Validate input, find the operation, and compare the full bound payload. An accepted row returns its saved receipt forever, without credential access, timestamp changes or POST.
2. Read/validate the credential. Persist a new pending operation immediately before its first outbound attempt, with `firstAttemptAt=now` and `lastObservedAt=now`. Existing pending rows retain their original first-attempt time and key.
3. Before any pending attempt, reject nonfinite/unsafe timestamps, `now < lastObservedAt`, or `now >= firstAttemptAt + 23 hours`. Update last-observed time durably, commit, and recheck the cutoff/regression immediately before dispatch after any asynchronous credential wait. Clock-regressed rows stay blocked until trustworthy time catches up; do not reset timestamps. The operator should restore correct system time, retain the pending ledger, and retry the same submission only if the original conservative window still permits it. Expired uncertain rows require provider investigation; changing timestamps cannot make them safe.
4. POST exactly the saved payload with bearer auth, JSON content type, and saved `Idempotency-Key`. Apply a 30-second deadline across headers and bounded response-body reading, not just fetch connection establishment. Abort on close. Never hold a SQLite or Harness transaction across the request.
5. A valid success containing a bounded opaque nonblank/control-free ID becomes an accepted row in a short transaction. If acceptance was concurrently saved, compare IDs and return the same receipt; conflicting IDs fail closed. Return only after durable acceptance commit. On HTTP/network/timeout/malformed-response/commit failure, retain pending data and report a safe failure, never success history.

Resend documents [24-hour key retention and conflict behavior](https://resend.com/docs/dashboard/emails/idempotency-keys): identical requests reuse a result, changed payloads return `invalid_idempotent_request`, and in-flight duplicates return `concurrent_idempotent_requests`. The 23-hour cutoff leaves one hour for request latency and clock uncertainty. This assumes a trustworthy local clock; persisted regression checks cannot detect arbitrary unnoticed cross-process clock manipulation. Once the conservative window expires, an uncertain email cannot be safely recreated automatically. Tell the operator to inspect the provider before deciding on a separately authorized new submission; do not change the key or erase the pending row.

## HTTP behavior and truthful recovery

Use the documented [send-email endpoint](https://resend.com/docs/api-reference/emails/send-email), plain `text` body and one recipient. Consume at most 64 KiB of response data; reject an oversized/invalid response. Parse only the success ID or known error name; never print raw provider response text, token, request headers, payload body or raw exception/cause. Errors use static messages and numeric HTTP status. Differentiate retryable `concurrent_idempotent_requests` from binding conflict `invalid_idempotent_request`; neither triggers an internal retry loop or a new key. 401/403/422/429/5xx and network/timeout failures remain safe pending operations and may be retried through the original call only within its window. A 409 payload conflict needs investigation, never automatic rebinding.

If Resend accepted a POST but its response was lost, the pending ledger survives. An actual Harness reopen/resume invokes the original adapter key and retrieves the provider receipt within the window. If adapter acceptance was committed before role history, recovery returns it locally and commits history once. If role history was committed before tool settlement, recovery returns the historical role receipt without calling the adapter. Expired unknown outcomes produce no POST, no successful message history and no delivered claim; previously accepted local receipts work after expiry. A later contact edit cannot redirect the pinned old destination.

## Acceptance and self-review

Use native Request/Response fake REST fixtures that emulate key retention, identical/different payloads, concurrent 409, provider acceptance followed by response loss, status errors, malformed and bounded bodies, timeout/abort, credential rotation and a controllable clock. Assertions count provider acceptances separately from POST attempts. Test same-key reuse, changed intent/config rejection, fresh-ledger key separation, persisted corruption, SMS rejection, no secret/raw-body leakage, pending expiry at the exact cutoff, clock regression and accepted replay years later.

Actual fsynced JSONL Harness tests interrupt at provider acceptance before adapter receipt, adapter receipt before history, and history before settlement. Reopen the same submission with local and fake Google calendar hosts; assert original submission/decision/intent/destination, one provider acceptance and one successful history row. Expired response-loss recovery asserts zero additional POSTs. Preserve existing first-contact refusal and old-contact pin tests; explicitly prove console history does not establish Resend history.

CLI tests cover fresh/default console, explicit live selection, saved live inference, missing key, config/backend mismatch, demo isolation, malformed/deleted metadata, legacy/pending console state, empty preflight compatibility, ownership races and factory cleanup. Contacts/bookings stay free of email credentials or requests. Run targeted tests and `npm run check`. No live provider calls or customer sends are needed to accept this slice. All requirements map to the single coherent implementation task; no approval or authority boundary is deferred.
