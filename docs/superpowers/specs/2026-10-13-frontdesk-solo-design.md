# Front Desk solo booking design

Date: 2026-10-13. Scope: one local vertical slice. Execution: autonomous implementation under the user's existing authorization; GPT-6.1 Sol plans/reviews and GPT-5.6 Sol implements. No separate review pause is required. The controller commits these documents.

## Intent and assumptions

Give business staff a runnable Front Desk that checks availability, asks an operator before booking, persists the resulting appointment, and resumes the same conversation after interruption. A credential-free demonstration must exercise the actual Pi Durable harness, tools, hooks, storage, and recovery path. A real model mode makes the role useful beyond the scripted demonstration.

Assumptions: the initial operator uses a local CLI; the initial calendar is local and synthetic; appointments occupy one fixed slot; times are explicitly UTC. There are no customer sends or external-calendar integrations. Office coordination, workboards, relay, cancellations, rescheduling, deployment, and generalized authentication are outside this slice.

## Chosen approach

Use a portable `@officehum/frontdesk` package built with the SDK's `defineRole`, hosted by a small generic solo adapter in `@officehum/office`. Persist the harness with Pi Durable's JSONL backend with `fsync: true`; persist local slots, bookings, and operator decisions with built-in Node SQLite. Use the upstream pi-ai faux provider for deterministic model messages, and the upstream OpenAI provider for live messages.

Two alternatives were considered: memory-only fixtures would not prove persistence; adding calendar OAuth and a board now would introduce independent integrations before the solo runtime exists. Separate calendar SQLite is intentional: it demonstrates connector-level idempotency across the gap between committing an external effect and committing a tool result.

## Exact constraints

- Node.js `>=22.19.0` (Pi Durable's actual floor); `.nvmrc` remains major `22`.
- Host Pi Durable stays pinned to `1.0.2`; role Pi Durable and pi-ai peers are `1.0.x`.
- The role depends on `@officehum/sdk`, never `@officehum/office` or `@officehum/cli`.
- No new third-party runtime dependency is needed beyond direct declarations for the installed Pi AI and Chord packages.
- Both tools declare `replay: "safe"`; booking is safe only because the calendar contract mandates atomic idempotency.
- Every booking requires approval through the existing SDK gate. With no approver, booking is blocked.
- Secrets come only from environment-based provider configuration; no values are printed or persisted.
- One process owns a harness directory at a time; reject an active second owner and recover a demonstrably stale local lock.
- Slot boundaries and stored appointment timestamps are UTC. The local inventory is 09:00, 10:00, and 11:00 on each valid requested date.

## Components and interfaces

### Portable role

`agents/frontdesk` contains the package, manifest, `AGENTS.md`, `APPEND_SYSTEM.md`, entry point, and eval scenarios. Keep context short and structural; scheduling facts come from the tool. Initially no skills are needed (`skills: []`). Manifest identity is `frontdesk`, department `front-office`, accepts `booking.request`, connectors `[]`, channels `["chat"]`, and approval `confirm_booking` applies unconditionally to `book_appointment`.

Export `Calendar`, `Booking`, `FrontDeskOptions`, and default `frontdesk(options): DefinedRole`:

```ts
interface Booking { readonly id: string; readonly start: string; readonly customer: string }
interface Calendar {
  freeSlots(date: string): Promise<string[]>;
  book(start: string, customer: string, idempotencyKey: string): Promise<Booking>;
}
interface FrontDeskOptions {
  readonly calendar: Calendar;
  readonly overlays?: readonly string[];
  readonly approve?: Approver;
}
```

`check_schedule({date})` returns the actual available UTC starts. `book_appointment({start,customer})` passes `${api.conversationId}:${api.taskId}:${api.callId}` as the idempotency key; the model cannot choose it. Return booking ID/start/customer as structured details and a concise text result. Validate actual calendar dates, exact UTC slot format, and nonempty bounded customer identifiers before effects. Do not accept a model's claim that a slot exists. The calendar performs the authoritative check at commit time.

### Local connector and approvals

`openLocalCalendar(file)` opens `node:sqlite` storage with prepared statements and explicit transactions, `busy_timeout`, and `synchronous=FULL`. Tables: `bookings(id PRIMARY KEY,start UNIQUE,customer,idempotency_key UNIQUE)` and `approval_decisions(key PRIMARY KEY,approved,by,note,request_json)`; no secrets. `freeSlots` computes the three inventory slots and subtracts persisted reservations. `book` first reads an existing key and checks that its original arguments match, then inserts a new booking atomically. A repeated key returns the same record; changed arguments reject; a second key for an occupied slot rejects. A failed booking never produces a success record.

The connector exposes `bookings()`, `decision(key)`, `recordDecision(key,request,decision)`, and `close()` to its host. Approval key is `${request.conversationId}:${request.taskId}:${request.callId}:${request.approvalId}`. `recordDecision` is first-write-wins and returns the persisted decision, which the approver returns to the SDK. The SDK also stores decisions in tool memos. This covers an operator answer committed before the SDK memo is committed. A paused request without a recorded answer asks again on reopen.

### Solo host adapter

`openSolo({directory,role,models,model?})` creates/install the role registry, opens `<directory>/harness` JSONL storage with fsync, and obtains the persisted root with `Harness.root`. The adapter takes a role bundle and models, so it does not import the Front Desk package. A supplied model overrides the role default; reopening must not accidentally reset an existing model or conversation. Return `{harness,root,submit,resume,close}`. `submit(content,requestId)` uses Pi's durable submission API; `resume()` calls `harness.resume()` and waits for the already-admitted pending submissions from `harness.inspect()` rather than submitting another user message. Results include submission ID, settlement, and assistant text. Always close in `finally`; interruption closes the harness while preserving unfinished work, never calls `root.abort()`.

Guard the directory with a lifetime `BEGIN IMMEDIATE` transaction in a separate ownership SQLite database. Inspect, replace, and remove the PID/token diagnostic marker only while holding that transaction; close the Harness before releasing ownership. A crash releases the kernel-managed database lock, after which a dead PID marker is stale. An active second owner, permissions failure, or malformed marker must fail visibly, and initialization failure must release both database ownership and its own marker. This is a single-machine ownership guard, not distributed locking.

### CLI

Preserve `--version`. Add these commands, with `--state <directory>` (default `.officehum/frontdesk`) and clear usage/error exit codes:

```text
officehum start --message "Book Demo Guest on 2030-01-15" --request-id booking-1 [--model gpt-6-sol] [--approval allow|deny]
officehum resume [--approval allow|deny]
officehum bookings
officehum demo [--approval allow|deny]
```

`start` submits to a new or existing root; require an explicit request ID so command retries are unambiguous. Without `--approval`, prompt the local operator for `allow`/`deny`, showing tool, arguments, and approval description. An EOF or Ctrl-C must leave pending work resumable, not infer consent. Explicit `--approval` is an operator decision for this local run; `demo` defaults to `allow` for its synthetic scenario and labels that choice in output. `bookings` reads SQLite directly and does not require model credentials.

Live `start` and live `resume` use `createModels()` and `openaiProvider()`; preflight a nonempty `OPENAI_API_KEY` and known `--model` before admitting work. Persist only the provider/model reference (already in Pi's root state); resolve it on reopen. Under directory ownership, reject demo/live mode reuse before admission and tell the operator to use a fresh `--state`; display the persisted model rather than the requested default. No OAuth, credential file, or SDK authentication redesign. `demo` uses provider `officehum-demo`, model `frontdesk-demo`, and a deterministic request (`2030-01-15`, `Demo Guest`). Its model factory derives the next response from the persisted transcript, not an in-memory response counter: check schedule, book the first available slot, then report the actual tool outcome. Repeating the demo request ID returns its original submission. Never label synthetic responses as live inference.

## Completion, recovery, and errors

Booking success means a persistent connector record exists and the tool returns that record's ID. Assistant wording alone is not evidence. The current SDK does not yet implement the four-layer/done-evidence manifest fields described in the design document; do not add unsupported fields or widen this task into an SDK rewrite.

Pi Durable's tool recovery does **not** rerun `beforeTool` after its execute intent was committed. Approval already passed and is memoized at that point. Both the persisted and currently installed replay policy must be `safe`. Using `unsafe` for this idempotent connector would lose successful recovery and return an interrupted-tool error instead.

Invalid dates, unknown slots, key reuse with changed arguments, occupied slots, active owners, and missing credentials fail visibly. Denied or missing approval produces no calendar mutation. Existing malformed storage is reported without silently resetting it. Live model/network failure is reported using Pi's settlement and does not fabricate a booking. Local listing remains available.

## Acceptance and verification

1. The real role passes `validatePackage` and `checkAgent` in a bare registry/harness.
2. The deterministic actual Harness books one slot, persists the transcript, then reopens with the same root and submission IDs.
3. Duplicate submission/request and duplicate booking keys create exactly one booking; changed key arguments reject; distinct competing requests cannot reserve the same slot.
4. Declined approval and omitted approver create zero bookings; a persisted decision is reused after reopen.
5. Stop after calendar commit but before tool settlement, reopen, and resume: exactly one booking and one persisted decision remain, and the original submission settles successfully.
6. Invalid input, EOF during approval, unknown CLI options, and missing live credentials have actionable failure behavior without mutation or false success.
7. `npm run check`, CLI demo, rerun demo, bookings, and resume pass on Node 22.19+; no live model call is required for acceptance.

Small repository hygiene: exclude `.claude/worktrees` with Biome's directory traversal exclusion `!!**/.claude/worktrees` so nested root configs are not discovered. Ignore `.officehum/` runtime state. Add the role to build/typecheck order before CLI and declare direct imported runtime packages explicitly. No worktree deletion.
