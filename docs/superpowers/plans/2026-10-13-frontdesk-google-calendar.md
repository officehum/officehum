# Front Desk Google Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. User selected GPT-5.6 Sol implementation with GPT-6.1 Sol design/review; autonomous execution is authorized, without a new approval pause.

**Goal:** Add an approved, recoverable Google Calendar backend to Front Desk while preserving its local demo.
**Architecture:** Portable REST/fake client, a host adapter, and immutable state/backend identity checked under solo ownership. Existing Front Desk UTC tool and approval contracts remain.
**Tech Stack:** Node >=22.19.0, TypeScript ESM, native fetch/crypto/SQLite, Temporal polyfill 0.5.1, Vitest; Pi Durable 1.0.2 unchanged.
**Spec:** `docs/superpowers/specs/2026-10-13-frontdesk-google-calendar-design.md`

## Global constraints

- Portable connector has no SDK/office/CLI dependency; only new runtime dependency is @js-temporal/polyfill exactly 0.5.1.
- CLI policy is UTC, 09:00–12:00 daily, 60-minute slots; standalone policy comes from its caller.
- Token callback reads environment; no credential output/storage, attendees, reminders, customer sends or live acceptance mutations.
- Preserve approvals/replay:safe, provider/model binding, ownership and legacy local behavior; reject backend changes before effects.
- No OAuth flows, new cancellation/rescheduling role tools, deployment or worktree cleanup.

## Review focus

1. Lost insert response/committed effect before checkpoint returns the same event on retry and records no second approval.
2. Offset-equivalent starts compare identically; invalid/ambiguous dates and durations fail before HTTP mutations.
3. Canceled/foreign/externally edited events cannot become successful booking retries or notification sends.
4. Legacy local and changed backend/calendar identities reject before submission/replay; missing identity never rebinds old state.
5. FreeBusy embedded errors/malformed payloads and event-list pages fail visibly, without secrets or fabricated availability.

### Task 1: Complete Google Calendar vertical slice

**Files:**
- Create `packages/google-calendar/package.json`, `tsconfig.json`, `src/index.ts`, `types.ts`, `schedule.ts`, `client.ts`, `fake.ts`, and focused `src/*.test.ts` (merge tiny units if clearer).
- Create `packages/office/src/google-calendar.ts` and `google-calendar.test.ts`; modify `solo.ts`, `solo.test.ts`, `index.ts`, `package.json` for adapter and guarded identity.
- Modify `packages/cli/src/cli.ts`, `cli.test.ts`, `packages/cli/package.json` for selection/composition/listing; keep terminal I/O semantics.
- Modify root `package.json`/`package-lock.json` for connector workspace/build order; update README and these plan checkboxes. Do not alter role contract/prompts unless a concrete compatibility test requires it.

**Interfaces:**
- Export CalendarClient/Slot/CalendarBooking, `createGoogleCalendar(options)` and `fakeCalendar(options)` with exact spec signatures.
- Host factory maps client freeSlots to UTC string[] and client book to existing `{id,start,customer}`. Local SQLite remains the approval store, separate from asynchronously listed remote bookings.
- openSolo gains optional connectorIdentity validated after acquireLock and before Harness.open. Keep old generic host callers working; immutable binding belongs to CLI composition, not role.
- CLI `--calendar local|google` on start/resume/bookings; explicit env calendar ID only initially, persisted backend/ID thereafter with mismatch validation.

- [x] **Step 1: Pin portable behavior with failing tests.** Add HTTP fixtures for freeBusy overlaps/adjacency/embedded errors; offset equivalence and DST; invalid date/time/duration/customer; paginated owned listing; initial GET404 + insert; insert commit followed by thrown transport + retry GET; 409 matching/mismatching fingerprints; tombstone/foreign/edited event rejection. Reschedule covers occupied/self/adjacent/recurring/all-day targets, calendar timezone differing from caller, malformed intervals, If-Match, lost PATCH response, request mismatch/superseded retry and receipt capacity; cancel covers requestId validation/204/404/410. Assert no attendees/default reminders and no secret/error-body leak. Use exact known fixture instants rather than assertions that duplicate production math.
- [x] **Step 2: Verify failure.** Run `npx vitest run packages/google-calendar/src`; expect missing connector exports/behavior, not unrelated existing failure. Implement shared validation/scheduling, REST client and fake to these tests. Normalize by Temporal.Instant, construct local working endpoints with reject disambiguation, add elapsed-minute durations. Canonical argument hash and deterministic event ID must be distinct purposes. Fail malformed provider responses before reporting success; bound network requests with a timeout.
- [x] **Step 3: Pin host/CLI behavior with failing tests.** Extend actual Harness recovery fixture to HTTP-backed Google adapter, pausing after insert before tool settlement; close/reopen and assert one event, original submission settled, one approval. Test legacy local + Google rejection, explicit backend/calendar mismatch, persisted selection without flags, missing Google token, malformed identity, remote listing with OPENAI_API_KEY absent, and rejected Google demo. Existing terminal EOF/deny/local tests remain acceptance coverage.
- [x] **Step 4: Implement composition and identity.** Add host adapter/export/dependency. Keep approvals in existing SQLite; generalize cliApprover input to the decision-store portion if needed. Under solo lock, validate/write versioned nonsecret identity; infer missing legacy metadata as local only when existing state is present. Resolve stored identity for resume/list; reject configured mismatch before new submissions or provider writes. Wire Google callback and async bookings, preserving live model preflight and persisted model reopen. Use transport injection/factory seams for tests instead of live credentials or customer events.
- [x] **Step 5: Verify targeted deliverable.** Run `npx vitest run packages/google-calendar/src packages/office/src/google-calendar.test.ts packages/office/src/solo.test.ts packages/cli/src/cli.test.ts`. Require all new/relevant cases green. Record actual failures and fix their cause before broadening checks.
- [x] **Step 6: Document/operator verification.** README shows local demo and Google start/resume/bookings usage; token/ID variable names with no values; externally obtained scopes for freeBusy and events; UTC policy; single-process/concurrent-writer and deletion-tombstone limits; no invitations and token-expiry recovery. Run `npm run check`, then built CLI demo twice, bookings, resume in a temporary state. Prove one persisted booking and no pending work. Review diff/secret scan before commit.
- [ ] **Step 7: Handoff review.** Commit focused implementation/docs, report exact checks and limitations to controller for GPT-6.1 Sol review, Linear update, push/PR/CI/merge. Do not start unrelated RASF graph work or live Google trials.
