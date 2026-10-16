# Office Hum build brief for Hermes Agent

Date: 2026-10-15. Written for the coding agent that takes over building Office Hum (Hermes Agent
with a strong coding model). The owner hands you this file; read it in full before your first change.
`AGENTS.md` at the repository root holds the standing rules and wins if anything here conflicts with
it.

## 1. Your mission

Build Office Hum, an open-source multi-agent office for medium-sized companies, by working through the
Linear project `officehum` (team Riseandshinefutures, key `RASF`) milestone by milestone. Each Linear
issue is a complete brief: Goal, Context, Build, Rules, Tests, Done when, Out of scope. Your job is to
turn issues into merged pull requests that pass the required `check` job, keep Linear accurate, and
stop for the owner at the gates listed in section 8.

Office Hum has three parts, and you must keep them apart:

- **Role packages** (`agents/*`): free, MIT, portable Pi Durable agents, one per job in a department
  (Front Desk, Bookkeeper, Office Manager, Sales, and a growing catalog). Anyone can install one into
  their own Pi Durable harness without Office Hum.
- **Office Hum, the host** (`packages/office`, `packages/cli`, later Studio and the gateway): runs the
  roles, coordinates them through a workboard and relay, asks people for approvals, and configures
  roles per business through overlays. It never edits a role package.
- **Suppliers**: Pi Durable is the only agent harness. Paper Instruments supplies the default model
  (Ultramarine 1 Flash, through a pi-ai provider) and the Word, PowerPoint and Excel Python libraries
  (in a bounded worker, planned).

## 2. What you may do, and when to stop

The owner authorizes the following for this repository and Linear project:

- Create branches and worktrees, commit, push, and open pull requests.
- **Merge your own pull requests once the required `check` passes**, except the files listed under
  "Owner review" below.
- Move Linear issues you work on to In Progress and Done, link their PRs, comment with results, and
  file follow-up issues in the same ticket format (backlog, no assignee, same project and milestone
  unless stated).

Owner review (open the PR, then stop and ask; do not merge):

- `AGENTS.md`, `CLAUDE.md`, `.github/workflows/*`, branch protection, dependency pins of Pi Durable,
  pi-ai or Chord, and any agent permission or credential configuration.

Stop and ask the owner when:

- You reach a milestone gate (section 8).
- An issue is blocked by a `Human task`, or you would need to make a product decision the issue does
  not settle (a new public API shape, a storage schema that other milestones depend on, a third-party
  service, a licence).
- `check` fails twice in a row for the same reason after your fixes, or `main` goes red.
- Anything under "Safety" in `AGENTS.md`: live payment providers, real customer sends, data or
  infrastructure deletion, deploys, money movement.

Never work on issues labelled `Human task` or `Deferred`. Never do M4 or M5 work until the owner says
so.

## 3. Get oriented (reading order)

Read these before your first issue. Budget time for it; the rules in them are enforced by tests.

1. `AGENTS.md`: layout, commands, hard rules, PR conventions, safety. Your standing instructions.
2. `README.md`: what runs today (the Front Desk solo CLI) and how to try it.
3. `docs/visualizations/officehum-owners-manual.html`: open it in a browser or read the HTML. It
   explains the stack, the boundaries, the roles, models, documents, how several roles are meant to
   work together, and what is built versus planned. Sections 02, 04 and 07 matter most.
4. `docs/design/agent-package.md`: the role package contract (files, `officehum.json`, `defineRole`,
   overlays, four layers, engines, memory, context engineering). Most M1 and M2 issues build pieces of
   this document.
5. `docs/superpowers/specs/2026-10-14-paper-instruments-integration-design.md` and
   `docs/design/file-store.md`: the Paper model, the Paper Office document design, and the file store.
6. `docs/research/2026-10-15-pi-durable-agent-communication.md`: what Pi Durable does and does not
   provide for agents talking to each other, how others build it, and recommendations for the relay.
   Required before any M2 issue.
7. Pi Durable itself: `node_modules/@earendil-works/pi-durable/README.md` (version 1.3.0) and its
   `CHANGELOG.md` entries for 1.1.0 to 1.3.0. The normative spec is
   <https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md>; grep it for the
   section you need rather than reading all 5,000 lines.
8. Linear: the project description and its six milestones (each has an exit test), then the epic of
   whatever you are about to build.

Then look at the code that exists: `agents/frontdesk/` (the one working role),
`packages/sdk/src/role.ts` (`defineRole`), `packages/sdk/src/approvals.ts` (the approval gate),
`packages/office/src/solo.ts` and `inbound-session.ts` (how the host drives Pi Durable today), and
`packages/cli/src/cli.ts`.

## 4. The system as it stands

| Part | State on `main` |
| --- | --- |
| Front Desk role | Built: contacts, messages, bookings, reschedule, cancel, approved email replies |
| SDK | Built: manifest, `defineRole`, overlays, approval gate (async conditions), engines, evals runner core, immutable and versioned file stores |
| Host | Solo mode only: one role per process and state folder; calendar, console and Resend messaging, signed inbound email, single-owner lock |
| Models | Paper `ultramarine-1-flash` default, OpenAI override; provider lives in `packages/cli` |
| Pi Durable | 1.3.0, pinned exactly; role peers `1.3.x` |
| Workboard, relay, office extension, gateway | Not built (M2) |
| Bookkeeper, Office Manager, Sales | Not built (M1; Sales is an epic outside the milestones) |
| Paper Office tools and worker | Not built (M3); libraries not installed anywhere yet |
| Studio, hosting, channels beyond email | Not built (M4) |

The target runtime: one office is one process with **one Pi Durable harness over one SQLite store**.
Every role is installed as extensions in one registry. Each unit of work (a customer thread, a ticket)
is its own conversation, configured with that role's agent settings (`role.agent` selects exactly the
role's own extensions). Conversations run concurrently; only commits are serialized. Roles never call
each other: they post tickets of a declared type to the workboard, and the relay delivers each ticket
once to the role whose manifest `accepts` that type.

## 5. Pi Durable essentials for this codebase (1.3.0)

- **Tool results use `output`, not `content`** (renamed in 1.2.0). TypeScript does not always catch a
  leftover `content` (when `details` or `isError` is also set), and the model then silently receives
  an empty result. RASF-3303 adds a guard; until it lands, check every tool you write.
- **Idempotency:** `submit` with the same `requestId` on the same conversation returns the original
  submission. Admission is durable. Side effects inside tools still need their own idempotency key.
- **Inputs can carry data:** since 1.2.0 an input submission takes `entry: { kind, data }`. Use it for
  relayed tickets (ticket id, event id, sending role, provenance, hop count). Kinds must not start with
  `pi.`.
- **Replay:** a tool declared `replay: "safe"` reruns after a crash; `"unsafe"` gives the model an
  interrupted error instead. Approval decisions are task memos and survive restarts.
- **Busy conversations** queue new input in their inbox as a follow-up (next run) or a steer (joins the
  current run). An input aborted by Esc, reset or a model failure settles as unanswered; resubmitting
  the same `requestId` returns that dead submission.
- **Subagents** are task-owned child conversations (README examples 22 and 23). Use them inside a role
  (RASF-3235), not between roles.
- **One process owns a store.** No cross-process locking, and watches only fire in the owning process.
  Studio and the CLI board must talk to the running runtime, not open the SQLite file.
- **`api.models`** (1.1.0) gives tools and hooks the harness models; prefer it over passing a `Models`
  instance in.
- All runtime calls into Pi Durable go through `@officehum/office`. Role packages only author
  extensions, tools, hooks and documents.

## 6. Check your environment first

Run these in your worktree before your first issue and report anything that fails:

```sh
node --version            # 22.19 or later (CI uses .nvmrc)
python3 --version         # engine-backed role tests run python3
npm ci
npm run check             # must pass on a clean main
npm run build
node packages/cli/dist/index.js demo --state "$(mktemp -d)/demo" --approval allow
```

Credentials come only from the environment. You should have a GitHub token limited to
`officehum/officehum` and Linear access for the `officehum` project. You need no model provider keys:
tests use scripted and fake providers, never real models. Never write a credential to a file, a log or
a command line.

## 7. How to work one issue

1. Pick the next issue from section 8. Read it, its parent epic and anything in its "blocked by" list.
   Skip and report if a blocker is open or a `Human task`.
2. Move it to In Progress in Linear.
3. Create a worktree and branch from the latest `main`: the issue's Linear branch name, or
   `hermes/rasf-<number>-<slug>`.
4. Read the design docs the issue names. If the change touches more than five files or creates a new
   package, write a short plan first at `docs/superpowers/plans/<date>-<slug>.md` (see the existing
   plans for the format) and commit it with the work.
5. Write the failing tests first, then the code. Follow the nearest existing package's patterns.
6. Run `npm run check` until it passes. For a change in a role, also run its evals.
7. Open the PR: title ends with the issue id; body lists what was built, tests added, the `check`
   result, decisions you made and anything left for follow-up.
8. When the required `check` passes, merge (unless the PR touches an owner-review file). Confirm
   `main` stays green.
9. In Linear: mark the issue Done, link the PR, comment with a three-line summary, and file follow-ups
   for anything you left out, in the same ticket format.
10. Update user-facing docs in the same PR when behavior changes (`README.md`, the relevant design doc,
    and the owner's manual's built-versus-planned tables when a planned part becomes built).

## 8. What to build, in order

Work top to bottom. Within a wave, respect each epic's listed order and its "blocked by" relations.
The milestone exit tests come from Linear and are the gates.

### Wave 0: trial ticket

- **RASF-3297** Portable Paper provider package (`@officehum/provider-paper`). Small, well specified,
  touches the CLI, a new package and tests. It shows the owner how you work. Linear carries this
  ticket in milestone `M1 · First agents`: the waves here order the work, they are not milestones,
  and there is no Wave 0 milestone.
- **Gate:** stop after merging it and post a short note for the owner (what you did, how long it took,
  anything that surprised you). Continue only when the owner says so.

### Wave 1: finish M0 · Foundations

Exit test: an agent package runs in solo mode.

1. **RASF-3120** Adapter core: one wrapper over Pi Durable's runtime API, with contract tests.
   Move the direct `Harness` use in `packages/office` behind it.
2. **RASF-3121** Scripted model provider for deterministic tests and CI evals (reuse
   `packages/office/src/demo-model.ts` where it fits).
3. **RASF-3122** Role loading and solo mode (`officehum run`), with the kill-and-resume test.
4. **RASF-3123** Eval runner (`officehum eval`) and the bare-harness portability run.
5. **RASF-3303** Pi Durable 1.3 follow-ups: tool-result shape guard, prompt-cache check in the eval
   runner, harness models in tools.

Then close the M0 epic **RASF-3065**. **Gate:** report the exit test result to the owner.

### Wave 2: M1 · First agents

Exit test: each role's eval suite passes in a bare Pi Durable harness with no Office Hum platform
packages loaded.

1. SDK first: **RASF-3124** (finish named per-business approval limits), **RASF-3229** (four-layer
   checks and completion evidence), **RASF-3233** (agent cards, dispatches, `mayNot`, `contextPlan`).
2. Front Desk to the package contract: **RASF-3129** (spec and evals), then finish **RASF-3130**.
3. Bookkeeper: **RASF-3091** (QuickBooks Online client, portable, fake first), **RASF-3126**,
   **RASF-3127**, **RASF-3128**.
4. Office Manager: **RASF-3131**, **RASF-3132**.
5. Role Factory, if the owner wants generated roles in M1: **RASF-3098**, **RASF-3099**,
   **RASF-3100** (ask first).

**Gate:** report the exit test result and the state of each role.

### Wave 3: M2 · Office runtime

Exit test: a Front Desk to Bookkeeper `invoice.create` hand-off survives a process crash with no loss
or duplicate, and every role's evals pass with the office extension layered on.

Before starting, reread `docs/research/2026-10-15-pi-durable-agent-communication.md`. Its
recommendations apply directly: one conversation per ticket per role, the workboard as the dedup
ledger, a failed delivery becomes a new event rather than a retried `requestId`, provenance carried in
`entry: { kind, data }`, approvals and hop limits in host code, per-role concurrency limits in the
relay. `packages/office/src/inbound-session.ts` already implements the conversation-per-sender,
stable-`requestId` pattern the relay should reuse.

1. **RASF-3066** Workboard tables and events (the issue leaves open whether the board shares the
   harness SQLite file; decide with the owner before building).
2. **RASF-3067** Relay with `requestId` delivery.
3. **RASF-3133** Office extension assembly, **RASF-3109** `agent_dispatch`, `agent_inbox`,
   `agent_reply`, **RASF-3236** office directory and agent cards.
4. **RASF-3234** Durable context patterns, **RASF-3235** declared sub-agents.
5. **RASF-3103**, **RASF-3104**, **RASF-3105**, **RASF-3106**, **RASF-3107**: protocol, runtime
   process, gateway, exactly-once suite, client.
6. **RASF-3134** CLI board, **RASF-3156** overlay store, **RASF-3189** agent bundle image,
   **RASF-3095** open-source Docker distribution.

Skip the AgentRun spike (RASF-3274 to 3279) and the tool-sources epic (RASF-3113) unless the owner
schedules them. **Gate:** report the exit test result. M3 begins only when the owner says so.

### Later waves (do not start without the owner)

M3 adds workflows, the approvals Inbox, budgets and provenance, memory, the office file store and the
Paper Office tools (RASF-3283 worker first, then the Word, PowerPoint and Excel adapters RASF-3300,
3284, 3301, then review RASF-3285 and acceptance RASF-3286). M4 is the hosted alpha and the model
marketplace (RASF-3296 to 3299). The department role catalog (RASF-3293) and the Sales agent
(RASF-3295) wait on the owner's role map (RASF-3294, a Human task).

## 9. Known traps

- `content` versus `output` in tool results (section 5).
- `packages/office/src/index.ts` still says the workboard lands in M1; it is M2. Fix stale comments
  like this when you touch the file.
- Biome ignores paths under `.claude/worktrees`. If your worktree lives there, `npm run lint` checks
  nothing; run `npx biome check <changed files>` too, and rely on CI.
- Pi Durable example 23 on upstream `main` still returns `content`; do not copy it as is.
- `agents/README.md` and design docs describe planned roles and packages that do not exist yet. Treat
  Linear and the owner's manual as the source of truth for what is built.
- A conversation created without an extension selection gets every installed extension, including
  other roles' tools. Always create or configure a role's conversations with `role.agent`, which
  selects exactly that role's extensions. With that in place, tool names can repeat across roles (for
  example `send_message`).
- Tests must never call a real model or the network. Live checks are opt-in, documented in the PR, and
  run by the owner.

## 10. Reporting

- Per issue: the PR body and a short Linear comment.
- Per milestone gate: a Linear project status update (what shipped with PR links, exit test result,
  risks, what is next), then stop for the owner.
- When blocked: say exactly what blocks you, what you tried, and the decision you need, in one
  message.
