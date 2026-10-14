# Front Desk reschedule and cancellation implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` for the already selected GPT-5.6 Sol implementation / GPT-6.1 Sol review split. One coherent code task; autonomous execution is authorized, with no additional review pauses.

**Goal:** Discover, move, and cancel managed appointments through approved durable role tools on both calendar backends.

**Architecture:** Extend the portable role Calendar contract, local SQLite lifecycle, and existing Google host adapter. A small shared operation journal binds keys and captures cancellation evidence; provider receipts/queue remain authoritative for pending network recovery.

**Tech Stack:** TypeScript, Node >=22.19.0 `node:sqlite`, Pi Durable 1.0.2, existing Google REST/fake client, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-13-frontdesk-reschedule-cancel-design.md` (read in full).

## Global constraints

- No contacts, outreach, customer sends, auth flows, payment features, live Google acceptance writes, or deployment.
- Keep the credential-free booking demo/defaults, portable role boundary, persisted connector identity, and UTC 09:00–12:00 hourly policy.
- All three writes require unconditional manifest approval; keys come only from conversation/task/call IDs; no mutation CLI bypass.
- Tests migrate temporary old-schema databases only; do not open real operator state. Backup and dry-run before the real schema rewrite.
- No new runtime dependency, model binding change, or wholesale closure of parent RASF-3130.

## Review focus

1. Unknown Google cancellation returning 404 must not become a false successful role result; a captured pending cancellation must recover 404/410/canceled tombstones.
2. A key reused across IDs/operations/arguments must reject even after reopen, failed calls, or parallel execution.
3. Interrupted move/cancel must reuse the original tool key and durable approval; old retries cannot undo subsequent state or resurrect canceled bookings.
4. Legacy SQLite including uncheckpointed WAL and approval JSON must survive migration unchanged; backup/drift/rollback failure must stop visibly.
5. Concurrent role moves and move/cancel must serialize the whole host operation, preserve no-send/ownership guards, and release the queue after rejection.

### Task 1: Complete approved appointment lifecycle

**Files:** Modify `agents/frontdesk/src/index.ts`, `officehum.json`, `AGENTS.md`, `APPEND_SYSTEM.md`, and `src/index.test.ts`; `packages/office/src/local-calendar.ts`, `google-calendar.ts`, `solo.ts`, `index.ts`, and their tests; `packages/cli/src/cli.ts` and `cli.test.ts`; `README.md`. Create `packages/office/src/calendar-store.ts` and `calendar-store.test.ts` for journal/migration responsibilities. Modify `packages/google-calendar/src/client.ts` and `client.test.ts` only for canceled-tombstone recovery if required. Keep existing booking demo implementation unchanged.

**Interfaces:** Produce portable `Cancellation`, `Calendar.listBookings/reschedule/cancel` and the three role tools exactly as specified. LocalCalendar/GoogleCalendarHost implement them while preserving `bookings()`, approval methods, and `close()`. `calendar-store.ts` receives the existing `DatabaseSync` and implements schema migration plus typed `operation/bindOperation/captureBooking/completeOperation/canceledBooking`; extend `DecisionStore` with the journal methods required by the Google host. Canonical argument JSON includes kind and normalized `{start,customer}` / `{id,start}` / `{id}`; stored result is `Booking|Cancellation` with runtime shape checks on read. Export host types needed by CLI without making the role depend on Office.

- [ ] Add failing role tests for listing and each new write with allowed/denied/missing approval; assert actual tool result details and zero effects when blocked. Validate manifest/package portability. Add an ambiguous-name context assertion and actual sorted listing IDs.
- [ ] Add local lifecycle/journal tests: ID/customer preserved on move, both slots updated, self-target succeeds, occupied/unknown/canceled moves reject, soft cancel frees slot, new key on known canceled ID is a no-op, replay returns original receipt, cross-kind/ID/argument keys reject, canceled/moved book retries and superseded moves never write. Reopen and assert history remains.
- [ ] Add legacy-schema fixtures with bookings plus allow/deny decisions and nontrivial request JSON. Keep WAL uncheckpointed for one case. Assert backup integrity, exact values/counts, new active uniqueness, slot reuse after cancel, idempotent second open, dry-run before source rewrite, source drift abort, rollback on injected migration failure, and malformed-schema rejection. Inspect only test paths.
- [ ] Add Google host tests for unknown/foreign/missing first-time cancellation with zero DELETE, snapshot persisted before DELETE, lost DELETE with 404/410/metadata-light canceled GET recovery, completed/new-key cancellation receipts, lost PATCH recovery, current-state verification on completed book/move retries, purged completed booking rejection, canonical `.000Z` keys, durable cross-ID/kind mismatch, queue recovery after rejection, and propagated failures with no false receipt.
- [ ] Run targeted tests to establish failures: `npx vitest run agents/frontdesk/src/index.test.ts packages/office/src/local-calendar.test.ts packages/office/src/calendar-store.test.ts packages/office/src/google-calendar.test.ts packages/google-calendar/src/client.test.ts`.
- [ ] Implement the contracts, unconditional gates, typed journal, transactional local lifecycle/migration, and Google host queue/mapping. Preserve provider move receipt/ETag/attendee/no-send safeguards; handle metadata-light canceled GET before ownership parsing only when no deletion follows. Update CLI host typing, exports, and durable-state predicate without adding direct mutation commands.
- [ ] Add actual `openSolo`/faux-model tests that discover a booking, check the move target, approve/move, discover again, approve/cancel, and verify structured outcomes and empty active listing. Reopen a pre-feature root with its old tool selection and verify new tools become available while conversation/model stay intact; add only a compatible root-tool refresh if required. On both backends interrupt each mutation after connector commit before tool settlement, close/reopen storage and host, resume the original submission, and assert one approval/effect plus the original submission ID. Add fake REST response-loss barriers before host receipt completion for PATCH/DELETE; test identity-free journal-only state cannot rebind Google.
- [ ] Add actual Harness parallel tests for two moves to one target (one wins), and move/cancel on one booking (serialized consistent outcome), including rejected mutation followed by a successful call. Assert approval count, final state/history, and REST write count. Extend CLI tests for ordinary approved lifecycle submissions and unchanged deny/EOF/backend/model checks.
- [ ] Run `npx vitest run agents/frontdesk/src/index.test.ts packages/office/src/calendar-store.test.ts packages/office/src/local-calendar.test.ts packages/office/src/google-calendar.test.ts packages/office/src/solo.test.ts packages/google-calendar/src/client.test.ts packages/cli/src/cli.test.ts`, then `npm run check`; fix failures within this slice.
- [ ] Update README with booking-ID discovery and ordinary `start --message` move/cancel examples, approval behavior, tombstone/journal/migration backup restore, and the external-writer limitation. Verify credential-free CLI demo/replay/bookings/resume using a fresh temporary state; rely on scripted Harness tests for lifecycle acceptance, no live APIs.
- [ ] Report changed files, checks, preview, and limitations to the controller for GPT-6.1 Sol review. The controller handles focused commits, push/PR/CI/merge and scoped Linear child; do not close the broader parent issue.
