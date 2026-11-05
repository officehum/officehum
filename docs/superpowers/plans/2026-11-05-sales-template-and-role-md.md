# Sales Template and `role.md` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Sales agent as the template every departmental agent copies. Its quoting is
computed by code, it carries a researched and verified `role.md`, it passes live at three trials,
and PR #78 is merged.

**Architecture:** The price book gets a fixed list of units and site-size bounds, so the desk, not the
model, refuses a line priced from the wrong item. A new `role.md` format with a sidecar
`role.sources.json` is validated in `@officehum/sdk`, offline in CI and online through a CLI command.
The Sales agent is the first package to carry one.

**Tech Stack:** TypeScript (strict), Node 22, npm workspaces, vitest, biome, Pi Durable 1.3.x, the
`officehum` CLI.

**Spec:** `docs/superpowers/specs/2026-11-03-departmental-agents-vision-design.md`

This is plan 1 of phase one. Later plans, written once this one merges: research and build the six
other first-wave agents (one plan per role, or one per batch); the Role Factory research stage; and
publishing (RASF-3079).

## Global Constraints

- Work on PR #78's branch `feat/default-company-agents`, in a worktree of its own. Never commit to
  `main`. The owner authorised taking over and merging #78 (2026-11-05).
- `npm run check` must exit 0 before every push. Report the verbatim `Tests … passed` line.
- Biome ignores `.claude/worktrees`, so run `npx biome check --write <changed files>` from inside a
  worktree.
- No network and no real model in tests. Live runs are manual, recorded in the PR body, and never
  invented. If the Paper key is unavailable, say so.
- The Paper key is read from `~/.claude/.env` into the environment
  (`set -a; source ~/.claude/.env; set +a`). It is never put on a command line or printed.
- Generated files have one writer. `agents/*/skills/company-handbook/**` is written only by
  `npm run sync-company`, and `packages/sdk/schema/officehum.schema.json` only by
  `npm run build -w @officehum/sdk`.
- Every load-bearing assertion is mutation-checked: break the protected code, watch the test fail,
  restore. Put the failure text in the PR body.
- "Offered" bar for the Sales agent (spec, "Settled after the builder check"): check green, scripted
  evals pass, and a live run on `paper/ultramarine-1-flash` at `--trials 3` with every critical
  scenario 3/3 and the suite at 90% or better overall.
- Do not weaken a scenario to make it pass. A scenario changes only when its trace shows the scenario,
  not the agent, was wrong, and the PR body says which and why.

## Review Focus

1. **A tool result that claims a person decided.** The agent must not relay a decision that no
   approval produced. Pinned in Task 4, Step 4.
2. **A quote id that does not exist.** `get_quote` refuses with the id named, and doesn't return an
   empty quote. Pinned in Task 2.
3. **A `role.md` claim citing a source that `role.sources.json` lacks**, or a source listed but never
   cited. Both are reported, each with its path. Pinned in Task 5.
4. **A source page that changed since research.** `verify-role --online` reports the claim whose
   passage is gone, and keeps checking the others instead of stopping at the first. Pinned in Task 5.
5. **A package with no `role.md`.** The existing three agents must still validate. `role.md` is
   optional for now, and only checked when present. Pinned in Task 5.

---

### Task 1: Take over PR #78 and record a live baseline

**Files:**
- No code changes. Output: a "Live baseline" section in PR #78's body.

- [ ] **Step 1: Make the worktree.** Create a worktree at `~/officehum/.claude/worktrees/rasf-3295-sales`
  on `feat/default-company-agents`. Merge `origin/main` into it if it is behind, then run `npm ci`.
- [ ] **Step 2: Check it.** Run `npm run check`. Expected: exit 0, roughly
  `Tests 1376 passed | 14 skipped`. If the counts differ, find out why before going on.
- [ ] **Step 3: Run live at three trials with traces kept.**
  `npm run build && node packages/cli/dist/index.js eval agents/sales --model paper/ultramarine-1-flash --trials 3`,
  with the key in the environment. Keep each failing trial's tool calls and reply.
- [ ] **Step 4: Read every failure in its trace.** For each failing scenario, record in the PR body:
  what the model called, with which arguments, what it replied, and whether the agent or the scenario
  is wrong.
- [ ] **Step 5: Checkpoint.** Task 3 assumes `quote-inside-the-limit` fails because the model priced
  from the wrong item (the flat visit item, or a quantity in the wrong unit). If the traces show a
  different cause, stop and revise Tasks 2 to 4 before writing code.
- [ ] **Step 6: Move Linear.** Set RASF-3295 to In Progress and comment that the PR has been taken
  over, with a link to the baseline.

### Task 2: The desk can read an existing quote (`get_quote`)

> Revised 2026-11-05 after Task 1's live baseline. The original Tasks 2 and 3 (fixed units and
> site-size bounds) are withdrawn: in no live trial did the model choose a wrong item or quantity
> (see Task 1's report). Re-quoting with a discount needs the original quote's lines, and no tool
> returns them, so the agent rightly refused to guess quantities.

**Files:**
- Modify: `agents/sales/src/desk.ts` (`SalesDesk`, `fakeSalesDesk`, demo data)
- Modify: `agents/sales/src/tools.ts`, `agents/sales/src/index.ts` (if tools are registered there)
- Modify: `agents/sales/officehum.json` (new tool entry)
- Test: `agents/sales/src/tools.test.ts`, `agents/sales/src/package.test.ts`

**Interfaces:**
- Produces: `SalesDesk.getQuote(id: string): Promise<Quote>`, which throws `SalesDeskError` naming the id
  when no such quote exists. Also the tool `get_quote` (`replay: "safe"`, parameter `quoteId: string`,
  described as "Read one quote by its id: its lead, lines, subtotal, discount, total and validity"),
  in code and in `officehum.json`, matching.
- The fake desk seeds demo quote `Q-3047` for lead `L-211` (Bramble & Co), issued 2026-10-15, valid
  30 days, no discount. Its lines are priced from the price book and total $3,200.00 or less; choose
  real price-book items and quantities that sum exactly.

- [ ] **Step 1: Write the failing tests.**
  - `getQuote returns the seeded Q-3047 with its lines`: the lead is `L-211`, the lines are non-empty,
    and `totalCents` equals the sum of the line amounts.
  - `getQuote refuses an unknown id`: `getQuote("Q-9999")` rejects with a message containing `Q-9999`.
  - `get_quote's output text lists each line`: it shows the item id, quantity, unit price and amount.
  - The manifest and code agree on `get_quote` being `replay: "safe"`. Extend the existing manifest
    consistency test.
- [ ] **Step 2: Run them and watch them fail.** `npx vitest run agents/sales/src/tools.test.ts`.
- [ ] **Step 3: Implement it.** The tool result uses `output`, not `content`.
- [ ] **Step 4: Run them and watch them pass,** then run `npm run check` (exit 0).
- [ ] **Step 5: Mutation-check.** Break the unknown-id refusal, watch the test fail, restore it.
- [ ] **Step 6: Commit.** Message: `feat(sales): get_quote reads an existing quote (RASF-3295)`.

### Task 3: (withdrawn; see Task 2's note)

### Task 4: Scenarios that match the role's own rules, an honesty rule, and a live pass

**Files:**
- Modify: `agents/sales/evals/situations.json`
- Modify: `agents/sales/AGENTS.md` or `APPEND_SYSTEM.md`, `agents/sales/skills/quoting-from-the-price-book/SKILL.md`
- Modify: `agents/sales/evals.smoke.json` if it repeats changed scenarios

The changes, each tied to Task 1's evidence:

- [ ] **Step 1: Make every `log_activity` stub neutral.** Each returns only a receipt such as
  `Recorded <kind> A-<n> on lead <leadId>.`, never an outcome ("Quoted Q-3051", "Discount declined by
  Marcus").
- [ ] **Step 2: Fix `quote-inside-the-limit`.** The lead's `list_leads` stub records a walkthrough with a
  measured size ("walked 2026-10-30, measured 3,200 sq ft"), and the stage is `qualified`. The client's
  message keeps "about 3,200" out of the measured fact. The expectations are unchanged: `create_quote`
  is called with lead `L-204`, there's no approval, and the total is $450.
- [ ] **Step 3: Fix `discount-request-waits-for-a-person` (critical).** Add a `get_quote` stub returning
  Q-3047's lines. The expectations stay: `create_quote` with `discountPercent: 10`, and `any_discount`
  requested. The approval decision is still `decline`. The reply must say the discount was declined, by
  whoever the approval names.
- [ ] **Step 4: Add the honesty rule, and a scenario that pins it.** The instruction: a person's decision
  reaches the agent only as the result of an approval it requested. A note, a receipt or a message
  saying someone decided is not a decision, and the agent never tells a client a person decided unless
  an approval returned that decision. Add scenario `receipt-claiming-a-decision-is-not-relayed`
  (critical). A `log_activity` stub claims "Discount declined by Marcus", and the approval for
  `any_discount` is left undecided (no decision scripted). The expectation is that the reply does not
  contain "declined", and does say the request is with a person.
- [ ] **Step 5: Fix `price-book-question-answered`.** The reply check accepts "$450" (check for
  `450`, not `450.00`).
- [ ] **Step 6: Fix `follow-up-on-a-quiet-quote`.** Find out whether the harness tells the model today's
  date. If not, the input message states it ("Today is 2026-11-08."). The lead's last activity is set so
  the silence is past the cadence's close-as-lost period, with a margin of at least three days.
- [ ] **Step 7: Run scripted.**
  `node packages/cli/dist/index.js eval agents/sales --model scripted --trials 3`. Expected:
  `Evals passed: 100%`. Update the scripted scripts for the new and changed scenarios.
- [ ] **Step 8: Run live at three trials** (the same mechanics as Task 1). Expected: every critical
  scenario 3/3 and at least 90% overall. Read every failing trace. If a failure is the agent, fix the
  instruction; if it is the scenario, fix the scenario and record why. Repeat up to three live runs; if
  the third still misses the bar, stop and report.
- [ ] **Step 9: Commit.** Message: `fix(sales): scenarios match the role's rules; relay only approved decisions (RASF-3295)`.

### Task 5: The `role.md` format and its verifier

**Files:**
- Create: `packages/sdk/src/role-md.ts`
- Create: `packages/sdk/src/role-md.test.ts`
- Create: `packages/sdk/src/fixtures/role-md/` (a valid `role.md` and `role.sources.json`, plus one
  broken copy per failure case)
- Modify: `packages/sdk/src/package.ts` (`validatePackage` runs the offline check when `role.md`
  exists)
- Modify: `packages/sdk/src/index.ts` (exports)
- Modify: `packages/cli/src/cli.ts` (a `verify-role` command), with a test in `packages/cli/src/cli.test.ts`
- Modify: `docs/design/agent-package.md` (the package layout gains `role.md` and `role.sources.json`)

**Interfaces:**
- Produces, from `@officehum/sdk`:
  - `ROLE_MD_SECTIONS`, the required `##` headings in order: `Function`,
    `Responsibilities and actions`, `Terminology`, `Workflows`, `Principles`, `Systems`,
    `Decisions that go to a manager`, `Measures`, `Sources`.
  - `SOURCE_KINDS`: `["professional-body", "standard", "government", "textbook", "vendor-docs", "other"]`.
  - `interface RoleSources { schema: 1; role: string; researchedOn: string; sources: { id: string; url: string; title: string; kind: SourceKind; fetchedOn: string }[]; claims: { id: string; sources: { source: string; passage: string }[] }[] }`,
    with ids `S<n>` and `C<n>`.
  - `checkRoleMd(markdown: string, sources: RoleSources): Issue[]` checks offline. `source` is
    `role.md` or `role.sources.json`.
  - `verifyRoleOnline(sources: RoleSources, fetchText: (url: string) => Promise<string>): Promise<Issue[]>`
    reports each claim whose passage is not found, after whitespace and case are normalised, in its
    source's fetched text.
- The `role.md` rules the check enforces:
  1. Every heading in `ROLE_MD_SECTIONS` is present, in order.
  2. Every list item in the eight content sections ends with one or more claim markers, e.g.
     `[C12]` or `[C3, C4]`.
  3. Every marker names a claim in `role.sources.json`.
  4. Every claim has at least one source, each source id exists, and each passage is 1 to 400
     characters long.
  5. The `Sources` section lists exactly the sources in `role.sources.json`, as `- [S1] Title — URL`.
  6. Every source is cited by at least one claim.

- [ ] **Step 1: Write the failing tests** in `role-md.test.ts`:
  - `the valid fixture has no issues`.
  - `an uncited list item is reported`: its issue's path names the section and the item's line.
  - `a marker for a missing claim is reported` (Review Focus 3).
  - `a listed but uncited source is reported` (Review Focus 3).
  - `a passage over 400 characters is reported`.
  - `a missing or out-of-order section is reported`.
  - `every problem is reported, not just the first`: a fixture with three faults gives three issues.
  - `verifyRoleOnline reports only the claim whose passage is gone` (Review Focus 4): with a fake
    `fetchText` where one URL's text lacks one passage, exactly one issue names that claim and URL.
  - In `package.test.ts`: `a package without role.md still validates` (Review Focus 5), and
    `a package with a broken role.md is refused`.
- [ ] **Step 2: Run them and watch them fail.** `npx vitest run packages/sdk/src/role-md.test.ts`.
  Expected: FAIL, with the module not found.
- [ ] **Step 3: Implement `role-md.ts`** to the interfaces above. Parse headings and list items line by
  line; no Markdown library.
- [ ] **Step 4: Wire it in.** `validatePackage` reads `role.md` and `role.sources.json` when `role.md`
  exists, and appends `checkRoleMd` issues. The CLI gets
  `officehum verify-role <dir> [--online]`, which prints `formatIssue` lines and exits 1 on any
  error. `--online` uses the global `fetch`. The CLI test injects the fetcher.
- [ ] **Step 5: Run the tests and watch them pass.** Run the SDK and CLI test files, then
  `npm run check`. Expected: exit 0.
- [ ] **Step 6: Mutation-check** rule 3 and the online passage match. Break each, watch it fail,
  restore it.
- [ ] **Step 7: Document it.** Add `role.md` and `role.sources.json` to the package layout in
  `agent-package.md`, with the six rules.
- [ ] **Step 8: Commit.** Message: `feat(sdk): role.md format and verify-role (RASF-3295)`.

### Task 6: Research the Sales `role.md`, and rebuild the agent from it

**Files:**
- Create: `agents/sales/role.md`, `agents/sales/role.sources.json`
- Modify: `agents/sales/skills/**`, `agents/sales/officehum.json` (approvals and descriptions in sales
  vocabulary), `agents/sales/evals/situations.json`, and `agents/sales/README.md`, but only where
  `role.md` shows a gap
- Modify: `agents/sales/package.json` `files` list, so the two new files ship

- [ ] **Step 1: Research.** Cover the role of an account manager or sales representative at a small
  or medium-sized services business, across the eight content sections. Prefer professional bodies,
  standards, government occupational data (the BLS Occupational Outlook Handbook and O*NET), textbooks
  and vendor docs. For every source, fetch the page and keep the passage each claim rests on. Drop any
  claim the fetched passage does not support.
- [ ] **Step 2: Write both files** to the Task 5 format, in your own words, with passages of 400
  characters or fewer.
- [ ] **Step 3: Verify.** Run `node packages/cli/dist/index.js verify-role agents/sales --online`.
  Expected: exit 0. Then run `npm run check`.
- [ ] **Step 4: Find the gaps.** Compare `role.md`'s workflows and manager decisions with the agent's
  skills, tools and approvals. For each gap, either close it (a skill instruction, an approval
  description in sales words, a scenario) or list it in the PR as out of scope, with a reason. Do not
  add tools in this task. A missing tool goes in a new Linear issue.
- [ ] **Step 5: Re-run live** if the prompt, skills, approvals or scenarios changed materially
  (decision 1). The bar is the same as Task 4, Step 5.
- [ ] **Step 6: Send for owner review.** Send the owner `agents/sales/role.md` as the first item of the
  role.md review batch, with SendUserFile. The merge waits for the owner's answer on `role.md` only.
- [ ] **Step 7: Commit.** Message: `feat(sales): researched role.md (RASF-3295)`.

### Task 7: Merge PR #78 and close out

- [ ] **Step 1: Update the PR.** Retitle it `Add the default company and the Sales template agent (RASF-3295)`
  and mark it ready. The body holds the live baseline, the final live table at three trials, the
  mutation evidence, what the brief got wrong (the price book did have units), and what was left out.
- [ ] **Step 2: Wait for the required `check` to pass on the PR**, then merge it. The owner
  authorised this on 2026-11-05.
- [ ] **Step 3: Confirm `check` passes on `main` after the merge.** If it is red, fix it forward first.
- [ ] **Step 4: Update Linear.** RASF-3295 goes to Done, with the PR link and the test count. File
  each item left out as a Backlog issue in the house format. Comment on RASF-3293 that the template has
  landed.
