# Agent packages: portable Pi Durable roles

Status: accepted (2026-10-07) · Issue: RASF-3064 · Applies to every package under `agents/`

## Decision

Every Office Hum role (Front Desk, Bookkeeper, Office Manager, and every department role after them)
is a **portable Pi Durable agent**: a free, MIT-licensed package, on npm and GitHub, that anyone can
install into **any** Pi Durable 1.0.x harness, with or without Office Hum. Roles are part of Office
Hum's free offering.

A role is mostly **files Pi users already know**: `AGENTS.md`, `APPEND_SYSTEM.md` and `skills/`, plus
an `officehum.json` manifest and a thin Pi Durable entry point for its tools. Roles generated from an
interview and the department roles Office Hum supplies have exactly this shape.

Office Hum, the platform, is the **coordination, orchestration and configuration layer** on top of
those roles. It runs them together (workboard, relay, workflows, gateways) and lets each business
configure them in plain language, without ever modifying a role package. A role never depends on it.

```
Office Hum — coordination, orchestration, configuration
  workboard · relay · workflow engine · channel and connector gateways · Studio
  "office" extension: board tools, delegate, team section, approval/budget/provenance hooks
  per-customer overlays: AGENTS.md, APPEND_SYSTEM.md, skills, settings (edited in Studio)
        │ installs, composes and configures; never modifies
        ▼
Role packages — portable Pi Durable agents (MIT, on npm and GitHub)
  AGENTS.md · APPEND_SYSTEM.md · skills/ · officehum.json · tools · approval gate · evals
        │ run on
        ▼
Pi Durable 1.0.x — any install
```

## The portability boundary

Enforced by `validatePackage()` and `checkAgent()` in `@officehum/sdk`, and by each role's CI:

1. **Built on Pi Durable.** Tools, hooks and tasks use `defineTool`, `hook` and Pi Durable tasks
   directly. `defineRole` returns plain Pi Durable extensions and agent settings.
2. **Pi Durable and pi-ai are peer dependencies** (range `1.0.x`), never `dependencies`, so a role
   uses the host's single copy.
3. **No platform dependencies.** A role may not depend on `@officehum/office`, `@officehum/cli` or
   anything else that needs the Office. It may depend on `@officehum/sdk` (which depends only on
   Pi Durable, pi-ai, `typebox`, `semver` and `yaml`) and on portable app clients such as
   `@officehum/quickbooks`.
4. **Safe without Office Hum.** Gated actions are blocked unless the host supplies an approver.
5. **Guardrails live in code, not prompt text.** Approval gates, budgets and provenance are hooks.
   No edit to `AGENTS.md`, `APPEND_SYSTEM.md` or a skill can switch them off.
6. **Proven by a portability test.** A role's evals pass in a bare Pi Durable harness, and again with
   the office extension layered on.

Only *running* agents goes through the adapter in `@officehum/office` (harness, storage, `submit`
with `requestId`, resume, relay). *Building* them does not.

## Package layout

```
@officehum/bookkeeper/
  package.json          peerDependencies: Pi Durable and pi-ai 1.0.x
  officehum.json        Office Hum metadata: tools, approvals, accepts, connectors, skills, evals
  AGENTS.md             the role: who it is, what it does, how it works, house style
  APPEND_SYSTEM.md      rules appended to the end of the system prompt (boundaries)
  skills/
    collections/
      SKILL.md          Agent Skills format: name, description, instructions
      references/       optional files the skill points to
  src/index.ts          the entry point: tools, approval conditions, defineRole
  evals/                scenarios with expected outcomes
```

The files follow Pi's conventions: `AGENTS.md` and `APPEND_SYSTEM.md` as in Pi's agent directory,
and skills in the [Agent Skills format](https://agentskills.io/specification). Pi Durable itself does
not load these files (Pi's coding agent does), so `defineRole` brings them to Pi Durable:

| File | How the agent sees it |
| --- | --- |
| `AGENTS.md` | The `agents_md` prompt section |
| `skills/*/SKILL.md` | The `skills` section lists each enabled skill's name and description; the agent loads the instructions (and reference files) on demand with the safe `read_skill` tool, as Pi does |
| `APPEND_SYSTEM.md` | The `append_system` section, last of the role's sections |
| Tools | `defineTool` with `replay` written out; a skill's tools live in a `<role>.<skill>` extension selected only while the skill is on |
| Approvals | `approvalGate()` in the role extension; decisions kept in the tool task's memo |

A role gets no shell or file-editing tools. Pi Durable's own `instructions` stay free for the host's
per-conversation notes.

## The entry point

```ts
import { fileURLToPath } from "node:url";
import { defineRole, type Approver } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };

export default function bookkeeper(options: {
  quickbooks: QuickBooks;
  overlays?: string[];
  approve?: Approver;
}) {
  return defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    overlays: options.overlays,
    approve: options.approve,
    tools: [readInvoices(options.quickbooks), createInvoice(options.quickbooks)],
    skillTools: { collections: [sendReminder(options.quickbooks)] },
    when: { large_invoice: (args) => invoiceTotal(args) > 5000 },
  });
}
```

Installing it on any Pi Durable harness:

```ts
const role = bookkeeper({ quickbooks, overlays: ["./my-bookkeeper"] });
for (const extension of role.extensions) registry.install(extension);
const harness = await Harness.open(storage, { models, registry }, context);
const root = await harness.root(context, { agent: role.agent });
```

## Overlays: configuring a role without changing it

An overlay is a directory with the package's layout. Overlays sit on the package the way Pi's project
`.pi/` sits on its agent directory, lowest first:

| File | In the package | In an overlay | When both exist |
| --- | --- | --- | --- |
| `AGENTS.md` | Required: the role | The business's additions | Combined, package first |
| `AGENTS.override.md` | Not allowed | Optional | Replaces every `AGENTS.md` below it |
| `APPEND_SYSTEM.md` | Optional | Optional | The top-most one wins (Pi's rule) |
| `skills/<name>/` | Bundled skills | New or edited skills | Merged by name; the higher layer wins |
| `settings.json` | Not allowed (defaults are in `officehum.json`) | Model; skills and tools on or off | Applied in order; later overlays win |

An overlay's `settings.json` uses Pi's setting names and its `+name` / `-name` edit lists:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-5-5",
  "defaultThinkingLevel": "high",
  "skills": ["+vip-customers", "-collections"],
  "tools": ["-send_reminder"]
}
```

Rules:

- Overlays can switch tools **off**, never add them. New tools arrive only in a package release.
- Overlay skills hold **instructions and reference files only** (`.md`, `.txt`, `.csv`, `.json`), never
  scripts. Code arrives only in packages, which agencies and developers can publish.
- A replaced skill keeps its on/off state; a new skill starts on.
- Prompt text and skills update **live**: `role.reload()` re-reads the files and the agent sees the
  change on its next request. A changed model, or skills and tools switched on or off, apply when the
  host next configures the conversation with `role.agent`. A broken edit is reported and the last
  good files stay in use.

Anyone can use overlays: a Pi Durable user writes the files by hand and passes the directory.

## What Office Hum adds: configuration

Office Hum keeps one overlay per agent per business, on the customer's own server, with version
history. Configuring an agent means editing its overlay; upgrading a role replaces only the package,
so a business's configuration is never overwritten.

- **Studio** edits `AGENTS.md` (or replaces it with `AGENTS.override.md`, with a warning), edits
  `APPEND_SYSTEM.md`, adds and edits skills (the spec's playbooks), switches skills and tools on or off,
  and picks the model. When a role upgrade changes a file the business overrides, Studio shows the
  difference.
- **Plain-language configuration.** The officehum.com portal takes requests like "chase overdue
  invoices weekly, not daily" and hands them to a configurator agent on the customer's server. It
  drafts the overlay change, validates it with `resolveRoleFiles`, shows the person a diff, and
  applies it once approved, so keys and data stay on that server. It enables tools and extensions
  only from a catalog of vetted packages and connectors; it does not write code.
- **The office extension** adds hand-offs, approvals through the Inbox and Teams, budgets and
  provenance when roles work together.

## Engines: a role's deterministic core

Many roles must never produce a number themselves: every figure comes from code. A role does this
with an **engine**, a command-line program (Python, for example) that the role's tools call. The
engine is passed into the role like any app client: the real program in production, `stubEngine` in
tests and evals.

```json
{
  "runtimes": [{ "name": "python3", "version": ">=3.10" }],
  "engine": { "command": ["python3", "engine/engine.py"] },
  "tools": [
    {
      "name": "stock_adjust",
      "replay": "unsafe",
      "description": "Record a stock adjustment.",
      "engine": ["adjust"],
      "parameters": {
        "sku": { "type": "string", "description": "The SKU", "required": true },
        "quantity": { "type": "integer", "description": "Units added or removed", "required": true }
      },
      "guidelines": ["Cite the finding id for every quantity you state."]
    }
  ],
  "approvals": [
    {
      "id": "large_decrease",
      "tool": "stock_adjust",
      "description": "Removing more than 10 units",
      "when": [{ "arg": "quantity", "op": "lt", "value": -10 }]
    }
  ],
  "commands": [{ "name": "stock-board", "description": "Stock on hand", "engine": ["levels"] }]
}
```

- **Runtimes.** The engine's program must be declared in `runtimes`, so every host knows to provide it.
  `checkRuntimes(manifest)` runs each program's `--version` and checks the range before a host loads
  the role.
- **Engine tools are data.** A tool with `engine` has no code: `defineRole({ engine })` builds it from
  its description, guidelines and parameters, with the declared `replay`. A call becomes
  `<command> <subcommand…> --name value…` (underscores become hyphens; a boolean is a bare flag).
- **The contract.** The engine prints one JSON object: `{ "ok": true, "data": …, "findings": [{ "id": … }],
  "caveats": [] }` or `{ "ok": false, "error": "…" }`. Findings carry the ids the role cites. Results
  over 9,000 characters are cut down to their findings.
- **No mutable files in the package.** The engine reads input from `OFFICEHUM_DATA_DIR` and keeps its
  records in `OFFICEHUM_WORK_DIR`, both the host's. Each call carries `OFFICEHUM_IDEMPOTENCY_KEY` (stable
  per tool call), so a repeated write is applied once.
- **No secrets.** The engine sees only `PATH`, `HOME`, `LANG` and what the host passes explicitly; model
  keys and connector tokens never reach it.
- **Guardrails from data.** An approval's `when` conditions (`gt`, `gte`, `lt`, `lte`, `eq`, `ne`, `in`
  over the call's arguments) decide which calls wait for a person. They fail safe: a condition on a
  missing or unreadable argument counts as met. A condition written in code takes precedence.
- **Operator commands** are engine views with no model involved: `runOperatorCommand(manifest, engine,
  name)`. Studio and Teams show them in Office Hum; other hosts show them their own way.

A role's generator (the Role Factory, RASF-3096) writes these fields from the interview, so generated
roles carry almost no code.

## Memory: what agents learn on the job

Agents remember what they pick up while working, for example "Acme's AP contact is Jane; she prefers
email" or "Smith & Co is on a payment plan until March". Memory is not company knowledge search
(documents the business hands over) and it is not a skill: skills are fixed instruction files, while
memory needs storage, tools, a prompt section and hooks. It is an **extension**, `@officehum/memory`
(RASF-3222), with a companion skill, `memory-hygiene`, that teaches what is worth remembering.

**Storage is Pi Durable's own.** Records live in session-scoped documents
(`defineDocFamily({ scope: "session" })`, one document per subject), committed atomically with the
transcript. The extension works in a bare Pi Durable harness with no extra database. Every agent in an
office harness shares the same memory, and rewinding or forking a conversation does not lose it.
Office Hum adds a search index, review queues and a Studio page on top.

A record has a subject (`business`, `customer:<system>:<id>`, `vendor:…`, `person:<id>`,
`agent:<role>`, `topic:<slug>`), a kind (`fact`, `preference`, `rule`, `procedure`), a category, its
text, a scope (`office` by default, or a department or one agent), its source and a status (`active`,
`unverified`, `proposed`, `superseded`, `retired`).

| Layer | Example | Becomes | Who approves |
| --- | --- | --- | --- |
| Memory | "Acme's AP contact is Jane" | a record | nobody when the source is internal; outside sources stay `unverified` until a person confirms |
| Rule | "Don't chase Smith & Co until March" | an overlay `AGENTS.md` addition under `## Learned rules` | owner or manager, through the overlay approval |
| Procedure | "How we onboard a new client" | an overlay skill (instructions only) | owner or manager, through the overlay approval |

Learning is free at the bottom layer; anything that changes how an agent behaves goes through the
overlay draft, diff, approval and undo described above.

**Guardrails, enforced in code:**

- **The source comes from code.** The host's `sourceOf` reads the run's provenance: a staff member's own
  message is `person`; anything from a customer email, SMS, web page or peer office is `external`. What
  the model claims about a source is ignored.
- **Outside content never becomes trusted memory.** It is saved as an `unverified` claim and shown in the
  prompt as "Unconfirmed:".
- **Protected categories are set only by a person.** Payment and bank details, approval limits,
  permissions and who may authorize things (`payment_details`, `authority`). A save from any other
  source is refused and opens a review item; a pattern scan (IBANs, routing and card numbers, "our bank
  details changed") forces the category. This blocks the classic "please update our bank details" fraud.
- **Memory never grants authority.** It is rendered as information, not instructions, like other
  outside content; approvals, limits and permissions come only from manifests, overlays and the
  office's people records.
- **No secrets.** Text that looks like a key, password or card number is refused.
- **History is kept.** A correction supersedes the old record; temporary facts carry a review date;
  people can see, correct and permanently delete what agents remember about them.

The prompt section is capped (about 600 tokens of business-wide records plus about 800 for the
subjects of the current ticket), so memory never crowds out the role's own instructions; anything
else is found with `memory_recall`.

## The open-source distribution

All role packages also ship as a free Docker setup that anyone can run and modify: one container
running every role on Pi Durable, with each agent's overlay directory mounted from the host so
`AGENTS.md`, skills and settings are edited as ordinary files.

## `officehum.json`

Office Hum reads it without running role code: for routing (`accepts`), Studio (tools as permissions,
connectors, skills), the Inbox (`approvals`) and release gates (`evals`). Pi Durable ignores it.

```json
{
  "schemaVersion": 1,
  "id": "bookkeeper",
  "name": "Bookkeeper",
  "department": "finance",
  "role": "Invoices completed jobs, chases overdue payments, answers billing questions",
  "defaultModel": { "provider": "anthropic", "modelId": "claude-sonnet-5-5" },
  "tools": [
    { "name": "read_invoices", "replay": "safe" },
    { "name": "create_invoice", "replay": "unsafe" },
    { "name": "send_reminder", "replay": "unsafe", "skill": "collections" }
  ],
  "connectors": ["quickbooks"],
  "approvals": [
    { "id": "large_invoice", "tool": "create_invoice", "description": "Invoices over the set amount" }
  ],
  "channels": ["email"],
  "accepts": [
    { "type": "invoice.create", "description": "Invoice a completed job" },
    { "type": "invoice.question", "description": "Answer a billing question" }
  ],
  "skills": [{ "id": "collections", "enabledByDefault": true }],
  "evals": "evals"
}
```

| Field | Rule |
| --- | --- |
| `schemaVersion` | `1`. Bumped only with a migration; the Office reads the previous version for one more release. |
| `id` | Kebab-case. The role extension's name and the board's assignee id. |
| `name`, `role` | Display name; one-line job description (≤ 120 characters). |
| `department` | `front-office`, `finance`, `operations`, `sales`, `marketing` or `people`. |
| `defaultModel` | `provider` and `modelId`, optional `thinkingLevel`. Overlays can change it. |
| `runtimes[]` | Programs the host must provide: `name` and a version range, e.g. `python3` `>=3.10`. |
| `engine` | `command` run from the package root, e.g. `["python3", "engine/engine.py"]`. Its program must be a declared runtime. |
| `tools[]` | `name` in `snake_case`, unique; `replay` required, `"safe"` or `"unsafe"`; optional `skill` puts the tool in that skill's extension. Engine tools add `engine` (the subcommand), `description`, `parameters` and `guidelines`. `read_skill` (the SDK's), `board_*`, `delegate` and `ask` (the Office's) are reserved. |
| `commands[]` | Operator views: `name`, `description`, and the `engine` subcommand they run. |
| `connectors` | Kebab-case ids of the apps the business must connect, e.g. `quickbooks`. |
| `approvals[]` | `id` (snake_case), `tool` (a declared tool), `description` (shown in the Inbox), optional `when` conditions over the tool's arguments. Conditions too complex to declare go in the entry point's `when`, keyed by `id`. |
| `channels` | `email`, `sms`, `chat`: where the role may face the business's customers. |
| `accepts[]` | Dotted ticket types (`invoice.create`) with a description shown to delegating agents. |
| `skills[]` | `id` (the folder under `skills/`) and `enabledByDefault`. The name and description come from `SKILL.md`, so they cannot drift. Every bundled skill folder must be listed. |
| `evals` | Directory of eval files, relative to the package root. |

`version` is the package's `package.json` version, and the supported Pi Durable range is its peer
dependency, so neither can drift from what npm installs. The Office refuses to load a role whose range
excludes the release's exact Pi Durable version.

## Validation

Every validator reports all problems at once, each with a path and a plain message:

```
officehum.json › tools[1].replay: must be one of "safe", "unsafe" (got "maybe")
skills/collections/SKILL.md › name: must match its folder name "collections" (got "Collections")
overlay acme/settings.json › tools[0]: "issue_refund" is not a tool of this role; overlays can switch tools off, not add them
package.json › dependencies.@officehum/office: is not allowed; a role must run on any Pi Durable install without Office Hum
role › bookkeeper › create_invoice: replay is "safe" in code but "unsafe" in officehum.json
```

- `validateManifest(json)`: the schema plus cross-field rules (duplicates, reserved names, references).
- `resolveRoleFiles({ packageDir, manifest, overlays })`: the role's files and every overlay. Office
  Hum validates a draft overlay with it before applying an edit.
- `validatePackage(dir)`: `package.json` against the portability boundary, `officehum.json`, the
  role's files, and every eval file.
- `checkAgent(bundle, manifest)`: the entry point's output, with no overlays, against the manifest.
- `defineRole` validates the manifest and files itself and throws `RoleFilesError` on problems.

## Evals

Evals check the role's judgment: given a situation, it takes the right actions, avoids the wrong
ones, and asks a person where it must. They run before every role release, on every Pi Durable
upgrade, and as a smoke test after each customer upgrade.

Each file in the `evals` directory holds scenarios:

```json
{
  "scenarios": [
    {
      "id": "invoices-completed-job",
      "description": "A completed job arrives; the bookkeeper creates one invoice",
      "severity": "normal",
      "tags": ["smoke"],
      "input": { "kind": "message", "text": "Job J-12 for Acme is done: 3 hours at $120." },
      "stubs": {
        "read_invoices": { "text": "No open invoices for Acme" },
        "create_invoice": { "text": "Created invoice 1042 for $360" },
        "send_reminder": { "text": "Sent" }
      },
      "approvals": {},
      "expect": {
        "calls": [{ "tool": "create_invoice", "args": { "jobId": "J-12" } }],
        "notCalled": ["send_reminder"],
        "approvalsRequested": [],
        "reply": { "contains": ["1042"] }
      },
      "trials": 3,
      "limits": { "maxTurns": 8 }
    }
  ]
}
```

- `input` is a `message` (text, optional `channel` and `from`) or a `ticket` (`type` from `accepts`,
  `payload`, optional `provenance: "external"`). Ticket inputs need the office extension.
- Every declared tool is stubbed in every scenario, so evals never touch a real system. Stubs keep the
  tool's real name, description and parameters, using `wrapTool`. `read_skill` runs for real: it only
  reads the role's own files.
- `approvals` scripts the person's decision for each approval id.
- `expect.calls` must appear in that order, with other calls allowed in between; `args` matches only
  the fields listed. `notCalled`, `approvalsRequested` (exact set), `delegated` (office extension only)
  and `reply.contains` / `reply.notContains` (case-insensitive) complete the checks.
- `critical` scenarios must pass every trial; `normal` scenarios count toward the suite pass rate
  (default 90%). `trials` defaults to 3. Checks are fixed rules; model-graded rubrics may come later as
  a score that never blocks.

The SDK owns the format, its validation, the grading and the report. Running a scenario needs a
harness, so it goes through an `AgentRunner`; RASF-3064 tests it with a scripted runner, and
RASF-3065 adds the Pi Durable runner (bare harness, later with the office extension) and a scripted
model provider for deterministic CI.

## Out of scope for RASF-3064

- Running agents on Pi Durable, solo mode, crash and resume (RASF-3065).
- The office extension, board tools, relay (M2 · Office runtime).
- Studio, the configurator agent and the Docker distribution (their own epics).
- Approval UI and channel caps (RASF-3073, RASF-3089); the QuickBooks client (RASF-3091).
