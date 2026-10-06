# Agent packages: portable Pi Durable roles

Status: accepted (2026-10-06) · Issue: RASF-3064 · Applies to every package under `agents/`

## Decision

Every Office Hum role (Front Desk, Bookkeeper, Office Manager, and every role after them) is a
**portable Pi Durable extension**: a free, MIT-licensed npm package that anyone can install into
**any** Pi Durable 1.0.x harness, with or without Office Hum.

Office Hum, the platform, is the **coordination and orchestration layer** on top of those roles:
the workboard, relay, workflow engine, channel and connector gateways, Studio, and an "office"
extension that it layers onto each role's conversation. Office Hum composes roles; it never
modifies them, and a role never depends on it.

```
Office Hum — coordination and orchestration
  workboard · relay · workflow engine · channel gateway · connector gateway · Studio
  "office" extension: board tools, delegate, team section, approval/budget/provenance hooks
        │ installs and composes, never modifies
        ▼
Role packages — portable Pi Durable extensions (MIT, on npm)
  @officehum/frontdesk · @officehum/bookkeeper · @officehum/office-manager · …
  role prompt sections · tools (replay declared) · approval gate · durable tasks · documents
        │ run on
        ▼
Pi Durable 1.0.x — any install
```

## The portability boundary

These rules are enforced by `validatePackage()` and by each role's CI:

1. **Authored directly on Pi Durable.** Roles use `defineExtension`, `defineTool`, `section`, `hook`,
   `defineDoc` and tasks from `@earendil-works/pi-durable`. There is no Office Hum wrapper around them.
2. **Pi Durable is a peer dependency.** `@earendil-works/pi-durable` and `@earendil-works/pi-ai` are
   `peerDependencies` (range `1.0.x`), never `dependencies`, so a role uses the host's single copy.
3. **No platform dependencies.** A role's `dependencies` may not include `@officehum/office`,
   `@officehum/cli`, or anything else that needs the Office to run. It may depend on
   `@officehum/sdk` (which itself depends only on Pi Durable, `typebox` and `semver`) and on
   portable app clients such as `@officehum/quickbooks`.
4. **Safe without Office Hum.** Gated actions are blocked unless the host supplies an approver, so
   a role installed on a bare harness can never, for example, issue a write-off on its own.
5. **Proven by a portability test.** Each role's eval suite must pass in a bare Pi Durable harness,
   and again with the office extension layered on. A role is not done until both pass.

Only *running* agents goes through the adapter in `@officehum/office`: opening the harness, storage,
`submit` with `requestId`, resume, the relay. *Authoring* agents does not.

## What a role package exports

The default export is a factory. It takes the app clients the role needs and an optional approver,
and returns a **role bundle**: plain Pi Durable objects.

```ts
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import bookkeeper from "@officehum/bookkeeper";
import { quickbooksClient } from "@officehum/quickbooks";

const role = bookkeeper({ quickbooks: quickbooksClient({ getAccessToken }) });

const registry = createRegistry();
for (const extension of role.extensions) registry.install(extension);

const harness = await Harness.open(storage, { models, registry }, context);
const root = await harness.root(context, { agent: role.agent });
```

```ts
interface RoleBundle {
  /** The role extension first (named after the manifest id), then one extension per skill. */
  extensions: Extension[];
  /** Recommended Pi Durable agent settings: model, thinking level, and the extensions to select. */
  agent: AgentChange;
}
```

How the spec's concepts map onto Pi Durable, with no Office Hum code involved:

| Concept | Pi Durable mechanism |
| --- | --- |
| Role prompt (identity, responsibilities, boundaries, house style) | `section()`s in the role extension, built with `roleSections()` |
| Customer instructions | The agent's native `instructions`, rendered after every extension section |
| Tools | `defineTool`, with `replay` always written out (`"safe"` or `"unsafe"`) |
| Skills | One small extension per skill, named `<role id>.<skill id>`, selected or removed per conversation |
| Approval gates | A `beforeTool` hook from `approvalGate()`; decisions kept in the task's memo |
| Long-running duties | Durable tasks with checkpoints |
| Working memory | `defineDoc` documents |
| Default model | The bundle's `agent.model`, read from the manifest's `defaultModel` |

Inside Office Hum the same bundle is used unchanged. The Office passes gateway-backed app clients and
an Inbox-backed approver, then selects `[...role.agent.extensions, officeExtension]` with the
customer's `instructions` and model.

## `officehum.json`

Each role ships an `officehum.json` next to its `package.json`. Pi Durable ignores it. Office Hum reads
it without running role code: for routing (`accepts`), Studio (tools as permissions, connectors,
skills), the Inbox (`approvals`) and release gates (`evals`).

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
  "skills": [
    { "id": "collections", "description": "Chase overdue invoices on a schedule", "enabledByDefault": true }
  ],
  "evals": "evals"
}
```

| Field | Rule |
| --- | --- |
| `schemaVersion` | `1`. Bumped only with a migration; the Office reads the previous version for one more release. |
| `id` | Kebab-case. The role extension's name and the board's assignee id. |
| `name`, `role` | Display name; one-line job description (≤ 120 characters). |
| `department` | `front-office`, `finance`, `operations`, `sales`, `marketing` or `people`. |
| `defaultModel` | `provider` and `modelId`, optional `thinkingLevel`. Customers can override it. |
| `tools[]` | `name` in `snake_case`, unique; `replay` is required, `"safe"` or `"unsafe"`; optional `skill` names the skill extension that provides it. Names the Office provides (`board_*`, `delegate`, `ask`) are reserved. |
| `connectors` | Kebab-case ids of the apps the customer must connect, e.g. `quickbooks`. |
| `approvals[]` | `id` (snake_case), `tool` (a declared tool), `description` (shown in the Inbox). Conditions such as "over a set amount" live in the role's code, keyed by `id`. |
| `channels` | `email`, `sms`, `chat`: where the role may face the business's customers. |
| `accepts[]` | Dotted ticket types (`invoice.create`) with a description shown to delegating agents. |
| `skills[]` | `id` (kebab-case), `description`, `enabledByDefault`. |
| `evals` | Directory of eval files, relative to the package root. |

Two spec fields moved out of the manifest so they cannot drift from what npm installs:

- `version` is the package's `package.json` version.
- `piDurable` is the package's `peerDependencies["@earendil-works/pi-durable"]` range. The Office
  refuses to load a role whose range does not include the release's exact Pi Durable version.

## Validation

All validators collect every problem rather than stopping at the first, and each problem has a
path and a plain message:

```
officehum.json › tools[1].replay: must be "safe" or "unsafe" (got "maybe")
officehum.json › approvals[0].tool: "issue_refund" is not a declared tool
package.json › dependencies: "@officehum/office" is not allowed; roles must run without Office Hum
role › bookkeeper.collections › send_reminder: replay is "unsafe" in code but "safe" in officehum.json
```

- `validateManifest(json)`: the schema above plus cross-field rules (duplicates, reserved names,
  approvals and skills referring to declared tools and skills).
- `validatePackage(dir)`: reads `package.json` and `officehum.json`; enforces the portability
  boundary (peer dependencies, forbidden dependencies, valid Pi Durable range) and checks the eval
  directory exists and its files validate.
- `checkAgent(bundle, manifest)`: checks the factory's output against the manifest. The role
  extension is named after `id`; each skill extension is named `<id>.<skill>`; each extension's tools
  match the manifest exactly, with `replay` written out and matching; no extension defines a section
  keyed `instructions` (Pi Durable reserves it for the customer layer).

## Evals

Evals check the role's judgment: given a situation, it takes the right actions, avoids the wrong
ones, and asks a human where it must. They run before every role release, on every Pi Durable
upgrade, and as a smoke test after each customer upgrade.

Each file in the `evals` directory holds scenarios:

```json
{
  "scenarios": [
    {
      "id": "invoices-completed-job",
      "description": "A completed job arrives; the bookkeeper reads the customer and creates one invoice",
      "severity": "normal",
      "tags": ["smoke"],
      "input": { "kind": "message", "text": "Job J-12 for Acme is done: 3 hours at $120." },
      "stubs": {
        "read_invoices": { "text": "No open invoices for Acme" },
        "create_invoice": { "text": "Created invoice 1042 for $360" }
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
- Every tool is stubbed in every eval, so evals never touch a real system. An unstubbed call fails
  the scenario. Stubs keep the tool's real name, description and parameters, using `wrapTool`.
- `approvals` scripts the human's decision for each approval id; an unscripted gated call is
  recorded and the run stops there.
- `expect.calls` must appear in that order, with other calls allowed in between; `args` matches
  only the fields listed. `notCalled`, `approvalsRequested` (exact set), `delegated` (ticket types,
  office extension only) and `reply.contains` / `reply.notContains` complete the checks.
- `severity: "critical"` scenarios must pass every trial; `normal` scenarios count toward the suite
  pass rate (default 90%). `trials` defaults to 3.
- Checks are fixed rules. Model-graded rubrics may be added later as a score that never blocks.

The SDK owns the format, its validation, the checks and the report. Running a scenario needs a
harness, so it goes through an `AgentRunner` interface:

```ts
interface AgentRunner {
  run(scenario: Scenario, trial: number): Promise<Trace>;
}
interface Trace {
  calls: { tool: string; args: Record<string, unknown> }[];
  approvalsRequested: string[];
  delegated: string[];
  reply?: string;
  turns: number;
  error?: string;
}
```

RASF-3064 ships `runEvals(suite, runner)` tested with a scripted runner. RASF-3065 adds the
Pi Durable runner (bare harness and with the office extension) and a scripted model provider for
deterministic CI.

## Out of scope for RASF-3064

- Running agents on Pi Durable, solo mode, crash and resume (RASF-3065).
- The office extension, board tools, relay (Office runtime milestone).
- Approval UI and channel caps (RASF-3073, RASF-3089); the QuickBooks client (its own issue).
- Publishing a JSON Schema file for editor autocomplete.
