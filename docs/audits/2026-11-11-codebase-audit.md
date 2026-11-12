# Codebase audit, 2026-11-11

A full read of the repository (every package, the nine roles, docs and config) for things that are
broken, inconsistent, inefficient or no longer needed. Part 1 lists what was fixed on branch
`claude/codebase-audit-cleanup-7881c1`. Part 2 lists what was found and left for a decision, most
important first. Items in part 2 were read in the code but, unless marked **reproduced**, not run.

## 1. Fixed

Each bug fix marked (test) has a regression test that failed before the fix.

**Bugs**

- **Gateway could be crashed before sign-in.** A WebSocket frame over 8 MB (or malformed) raised an
  unhandled `error` event that ended the gateway process for every client. `packages/gateway/src/server.ts` (test)
- **`officehum run` replayed stale answers.** The first line of a new session on an existing `--db`
  reused the request id of an earlier session's first line and printed its stored answer without
  running. Request ids now include a per-session id. `packages/cli/src/run.ts` (test)
- **Approval gate failed open on non-numeric arguments.** `""`, `[]` and `false` were read as 0, so a
  "more than $2,500 needs approval" condition did not hold. They now need approval.
  `packages/sdk/src/approvals.ts` (test)
- **Paper document gate missed external links.** `.rels` attributes in single quotes, with `>` in a
  value, or spelled with character references passed the external-relationship check; a DTD in a
  relationships part is now refused too. `packages/tools-paper-office/src/ooxml.ts` (test)
- **Excel edits could land on the wrong sheet.** `setRange`, `setStyle` and `clearCells` dropped a
  sheet prefix in `range` (`Notes!A3`) and wrote to the first sheet.
  `packages/tools-paper-office/python/xlsx_adapter.py` (test)
- **QuickBooks listings stopped at one page.** Invoice, payment and customer queries were not paged,
  so results past QuickBooks' default page were dropped before the overdue filter ran.
  `packages/quickbooks/src/client.ts` (test)
- **Operations: approved overtime followed its job.** Overtime approved for one crew and week became
  headroom for whichever crew the job was later assigned to; and `request_overtime` could move a
  recurring-contract visit off its crew, which `assign_crew` refuses. `agents/operations/src/desk.ts` (tests)
- **Board ticket detail showed the token ceiling as dollars** (10,000 tokens as `$100.00`).
  `packages/cli/src/board.ts` (test updated)
- **A ticket's waited answer was every assistant message concatenated**, not the last one.
  `packages/office/src/relay/wait-task.ts`
- **`reviewLedger.list()` threw a raw `SyntaxError` on one corrupt file**, which made
  `publish_document` throw instead of refuse. It now shares `read()`'s checks.
  `packages/tools-paper-office/src/review.ts`
- **Relay cached a failed conversation open forever.** `packages/office/src/relay/relay.ts`
- **Gateway config problems named the wrong rule** after an earlier invalid rule was dropped.
  `packages/gateway/src/config.ts`
- **Role factory:** a stub tool attached to a skill generated uncompilable code (unquoted kebab-case
  key) and a failing generated test; the tool `does` question had the wrong path; `done_engine` said
  "leave it blank" but refused a blank; the interview refused ticket types the parser accepts
  (`note.a`). `packages/role-factory/src/render.ts`, `questions.ts`
- **JSONL framing "copy" was a view** for Node `Buffer`s. `packages/protocol/src/framing.ts`
- **`@officehum/frontdesk` would publish without its skills** (`files` omitted `skills`).

**Docs that would mislead or fail**

- README: status line said the workboard, relay and team runtime "remain planned" (they are built);
  the Google Calendar example passed `--model gpt-6-sol` to the Paper provider and failed; the `eval`
  example pointed at a fixture that cannot run and a script file that does not exist; the packages
  table described a "workflow engine" and a "steer" command that do not exist and omitted two
  packages; `run` was documented as idempotent per line.
- `AGENTS.md` layout table listed 4 of 12 packages, placed the Paper provider in the CLI, and pointed
  `PI_DURABLE_VERSION` at the wrong file. **This file is held for your review**; it is its own commit.
- `docs/design/agent-package.md`: Memory and the Docker distribution now carry a "not built" note.
- CLI usage text: `eval --report` was missing; `listen --messenger` was shown as required.
- About 25 stale comments and README statements across the roles and packages (counts, file names,
  "lands in M2" notes for things that have landed), and a dead link in one plan.

**Removed or simplified**

- `docs/visualizations/officehum-built.html`: a second system guide frozen at 15 October that marked
  shipped features as planned. The owner's manual covers the same ground.
- `.gitignore`: 150 lines of generic Node boilerplate reduced to what this repo produces; added
  `.claude/worktrees/` and `.DS_Store`. Nothing tracked or untracked changed status.
- Dead code: `ROLE_SECTION_KEYS`, `asDocumentError`, an orphaned doc comment, an unreachable branch,
  a one-line wrapper, a duplicate `canonicalJson`, a duplicate `answerText`, a second hard-coded copy
  of the Paper library pins, private copies of the SDK's `isoDate` in six roles, pass-through
  `companyHead` wrappers, and several within-role duplicates.
- Four tests that could not fail now assert something (or lost the vacuous line).
- All seven lint warnings on `main`; `npm audit` high-severity advisory in dev-only `vite` (lockfile only).
- `@officehum/frontdesk` declared as a dev dependency of `@officehum/office`, whose tests import it.
- An O(receipts × events) integrity pass on every inbox open is now linear.

## 2. For your review

> **Update, 2026-11-12.** Most of this part has since been worked through on branch
> `claude/audit-part-2`; the decision for each item is in
> `docs/superpowers/plans/2026-11-11-audit-part-2.md`. Still open after that work:
>
> - **B7 was a wrong finding.** Front Desk's writing tools are correctly `replay: "safe"`: its
>   exactly-once design relies on an interrupted call being re-run. What is misleading is that the
>   docs and the sub-agent rules read "safe" as "does not write".
> - **D1, approval inbox.** With `officehum runtime --board`, a gated call inside ticket work is
>   recorded and blocked, and nothing can decide it. Needs a decision on which authority (board or
>   gateway) governs approvals for ticket work.
> - **A12.** Multi-output Paper commits check everything first and finish on replay, but are not
>   atomic against a concurrent edit; that needs a multi-file commit in the SDK's file store.
> - **A21.** Errors other than `busy` on the approval re-watch after a reconnect are still dropped.
> - **B8.** Operations approval facts are shown to the approver but not re-checked at the write.
> - **Left by decision:** B9, B13, C2 (its own PR), C4, C10, D2, D5, canonical JSON ordering (E2),
>   Python helper duplication (E3).

### A. Likely bugs that need a design decision

1. **Relay deadlocks on a nested wait.** `pollOnce` awaits a delegate's whole turn; if that turn
   dispatches with `wait: true`, the child's event sits behind the poller. The red-team case for it is
   skipped. Suggested: split admit from settle. `packages/office/src/relay/relay.ts:470,562`
2. **Relay recovery skips the guards.** A `pending` row is written before `runGuards`; after a crash,
   `recover()` delivers it without re-running budget and hop checks. `relay.ts:424-450,516-559`
3. **Spend ceilings in dollars never bind.** Each turn's cost is rounded to whole cents per component;
   at current prices a turn under about 33k input tokens costs $0.00. Needs a finer ledger unit
   (schema change). `packages/office/src/spend/prices.ts:79`
4. **Inbound email: terminal rejections answer 503.** Auto-replies and DMARC failures throw through
   the webhook and Resend retries each one, refetching every time. `packages/office/src/resend-adapter.ts:164`
5. **`/reload` can change a saved conversation's model** through an overlay, against the rule that a
   conversation keeps its model. `packages/office/src/roles/run-role.ts:133,162`
6. **Local board: any role can complete any open ticket**, including its own dispatch. The test that
   covers refusal writes `claimed` by hand. `packages/sdk/src/local-board.ts:318`
7. **A stale wait result is reused forever** after a timeout; `clearWait` is never called.
   `relay.ts:595`, `packages/office/src/board/relay-ledger.ts:221`
8. **Role factory generates unsatisfiable `declined-*` evals** (expects both "not called" and
   "approval requested" for the same tool), and can fail after writing files: strict mode turns the
   800-word warning into an error, and `--overlay` problems surface after the package is on disk.
   `packages/role-factory/src/render.ts:551`, `rules.ts:118`, `generate.ts:117`
9. **`agent_inbox` loses a role's own tickets past 100** (filters in JS after `LIMIT 100`).
   `packages/office/src/extension/index.ts:358`
10. **Gateway keeps every request a long-lived WebSocket ever made** (up to 2,000 events each);
    the runtime's `tracked` map likewise never evicts. `packages/gateway/src/router.ts:383`,
    `packages/office/src/runtime/runtime.ts:216`
11. **Scoped request ids can exceed the protocol's 256-character limit**, in which case the gateway
    rejects the runtime's own frame and the client never hears back. `packages/protocol/src/messages.ts:173`
12. **Paper lease expiry is checked before the replay ledger**, so a replay after expiry returns
    `lease-expired` instead of the committed receipt; multi-output commits are not atomic.
    `packages/tools-paper-office/src/local-document-service.ts:111,260`
13. **Excel `setStyle` replaces the whole font and alignment** (`{bold: true}` wipes size and colour)
    though the tool says only given fields apply. `xlsx_adapter.py`, `_apply_style`
14. **Word `addComment` with a block anchor crashes** with a bare `AttributeError`. `word_adapter.py:933`
15. **Excel reference checks give wrong answers** in several cases: capped lists are diffed (false
    refusals past 25 broken refs), any 1 to 3 letter name is taken as a column, named ranges such as
    `$B$13` are flagged broken, the sum check compares exact decimals with cached doubles.
    `xlsx_adapter.py:742-1031,1554-1605`
16. **Oversized document replies collapse to "everything omitted" with `ok: true`**; the trim lists
    name keys that are never at that level. `packages/tools-paper-office/src/{word,pptx,xlsx}-tools.ts`
17. **Support:** an unknown sender can escalate a real client's case (`tools.ts:797`); a proposed
    credit is reported as "with a person" when nobody was asked (`tools.ts:355`); a complaint past the
    re-clean window gets a refusal with the dates reversed (`desk.ts:954`).
18. **People Ops:** a declined time-off ask leaves a stale notice count (`desk.ts:1020`).
19. **Front Desk:** `reply_message` turns a `pending` approval into a permanent decline
    (`replies.ts:216`); an approved booking discount is recorded nowhere (`index.ts:92`).
20. **Bookkeeper:** a not-yet-due invoice reads "is -5 days overdue" (`tools.ts:770`).
21. **Client:** a failed second `watchApprovals` listener stays registered; a `busy` answer to the
    re-watch after reconnect is swallowed. `packages/client/src/websocket-transport.ts:311`
22. **`handToPerson` swallows every board error**, not only "already moved on". `relay.ts:478`

### B. Guardrails that are prose only, or weaker than stated

1. **Marketing claim, testimonial and unsubscribe checks run only inside the demo desk.** With a
   host desk the manifest's promises are unenforced. Suggested: run them in the tool layer.
2. **Bookkeeper takes "who recorded this bill" from a model-typed argument** and shows it to the
   approver as fact. Other roles resolve it from the verified sender.
3. **Purchasing reorder-point orders** need no sender and no quantity cap; `AGENTS.md` says otherwise
   and the README says it is deliberate.
4. **Support** forbids handling "damage" without a person, but only `safety` blocks closing.
5. **People Ops** `list_availability` and `list_candidates` answer any caller; the docs say a
   colleague lookup is refused.
6. **Bookkeeper reminders:** "one per invoice per stage" is not enforced; tests pin the permissive behaviour.
7. **Front Desk declares seven writing tools `replay: "safe"`.** Every other role marks idempotent
   writes `unsafe`; the docs say a safe tool carries no approval. Sub-agents may run "safe" tools.
8. **Operations** gated tools have no `approvalFacts` reader, so the approver sees raw ids.
9. **Completion evidence** in most manifests is true before any work happens (`list_stock {}`), and
   Front Desk's `booking.request` evidence can never be true. Nothing runs evidence yet.
10. **`run_document_python` cannot be withheld** from the Paper pack, while the worker is documented
    as "a bounded workspace, not a sandbox" until RASF-3111. Suggested: an `includePythonWorkspace` flag.
11. **Approval `amount` is never validated** in the manifest (unknown arg, `times` without `field`),
    and sub-agent tool rules live in `checkAgent`, so `validateManifest` accepts a sub-agent with an
    unsafe tool. `packages/sdk/src/manifest.ts:751`, `agent.ts:220`
12. **`people` table has no production writer**, so approvals are addressed to nobody and
    hand-to-person is unreachable outside tests.
13. **Board `assign` has no authorisation check** (no tool exposes it today).

### C. Docs and config

1. **Owner's manual is half-updated**: header at a commit 349 behind, sections that say the board,
   relay, Paper tools, SMS and remote approvals are not built, a progress section dated 15 October.
   `AGENTS.md` names it as orientation. Needs a status pass; I can do it as a follow-up.
2. **`.github/dependabot.yml` has two `npm` entries for the same directory**, which Dependabot
   rejects; no Dependabot commit appears in history. CI-adjacent, so yours to change: merge into one
   entry with two groups.
3. **About 100 test files are never typechecked** (office, cli, quickbooks, google-calendar,
   provider-paper and all nine roles exclude tests and have no `tsconfig.test.json`). A trial run
   found roughly 14 errors in cli, 43 in office, 31 in sales, 36 in frontdesk, 11 in provider-paper.
   The same change would remove 21 redundant `tsc` runs from `npm run check`.
4. **`docs/handoffs/`**: three of four briefs describe a state long past ("Workboard: not built"),
   yet `AGENTS.md` cites the folder for merge authority. Decide where standing authority lives.
5. **Gateway doc vs code:** the doc says a client-sent `principal` is refused and that
   `unsupported_version` closes the connection; the code strips the first and keeps the socket open.
6. **`docs/design/agent-package.md` "Context engineering"** describes hooks and fields
   (`context_recall`, amount masking, `toolGroups`, `modelTiers`) that only the schema knows.
7. **README `officehum run agents/frontdesk`** has no `--clients`, so every calendar tool would
   throw; `agents/sales/README.md` documents `npm install -g officehum`, which is not published.
8. **Dates are UTC while the company is in Pacific time**: after 16:00 local, "today" is tomorrow
   and notice periods are a day short. System-wide convention; needs a decision.
9. **Role dependency ranges differ**: two roles pin `@officehum/sdk` at `0.0.0`, seven use `*`.
10. **Limits come from two places**: Sales reads the manifest limit (overlay-adjustable); Purchasing
    and Support read the company record; `approvalLimits.quoteOverCents` is typed and never read.
11. Smaller mismatches: Paper tool descriptions vs adapters (PowerPoint `footer: ""`, default layout,
    "every changed slide" vs a cap of 8, Excel "refused before anything is written"); "sources hashed
    again after the run" is only true on success; the kill is of the process, not the group; the fake
    QuickBooks sorts customers and the real client does not; role-factory `spec.ts` re-declares a
    dozen manifest schemas that have drifted (no `amount`, no channel directions).

### D. Not wired, or possibly not needed

1. **Relay, office extension, SMS intake and approval inbox have no production caller.** No host
   calls `createRelay`, `officeExtension`, `openSmsIntake` or `openApprovalInbox`; the CLI never
   passes `twilio` to the listener. Wire them or stop exporting them until they are.
2. **`packages/sdk/src/card.ts`** (agent cards) has no consumer outside its test; six `contextPlan`
   fields are schema-only.
3. **`@officehum/channels`**: `InboundIntake` and the Twilio `accept` compatibility shims are used
   only by tests.
4. **Test-only modules ship in `@officehum/office`'s `dist`** (`fixtures/resend-fetch`,
   `testing/recording-role`, `evals/redteam`, `evals/prompt-cache`); kill-test fixtures load `dist`,
   so a single-file test run after an edit exercises stale code.
5. **Three one-shot Front Desk tool migrations** run on every `openSolo` at version 0.0.0.
6. **Unused exports** across the CLI, client and Paper packages (around 30 names, most re-exported
   from `tools-paper-office/src/index.ts` with no importer), dead Python helpers in the adapters, and
   `review.ts`'s fallback for a record shape that is never written.

### E. Duplication worth one shared home

1. Six roles copy `read_company` (60 to 90 lines each, already drifted), the `company.ts` types and
   loaders, `money`, `requireDesk` and date helpers. These belong in `@officehum/sdk`.
2. `packages/office`: validation helpers (`exact`, `controls`, `bounded`), `transact` seven times,
   bounded HTTP readers three times (one lacks the header checks), canonical JSON three times using
   `localeCompare` where the board's own comment forbids it for hashes (changing it needs a migration).
3. `tools-paper-office`: TS and Python helpers triplicated across Word, PowerPoint and Excel.
4. CLI: the inbound-runtime `createRole` body exists twice (about 55 lines).

### F. Inefficiencies (small at today's sizes)

- Waiting tickets commit a checkpoint every 250 ms for as long as they wait.
- The Paper adapters reopen and reparse the same package several times per call.
- `LocalVersionedState` re-validates the whole manifest on every read; an ancestor walk is quadratic.
- `officehum board` loads the whole event log to read one sequence number and up to 1,000 tickets to
  count them, on every draw.
- Google Calendar `listBookings` pages through every past event.
- The inbound inbox re-prepares its SQL statements on every call.
