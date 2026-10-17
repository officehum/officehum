# Agents

Each folder here is one Office Hum role, published free as `@officehum/<role>`.

Every role is a **portable Pi Durable agent**: an MIT package that installs into any Pi Durable 1.3.x
harness, with or without Office Hum. Office Hum composes, coordinates and configures roles; it never
modifies them, and a role never depends on it.

A role is mostly files Pi users already know:

```
AGENTS.md            the role: who it is, what it does, how it works, house style
APPEND_SYSTEM.md     rules appended to the end of the system prompt
skills/<name>/       Agent Skills format: SKILL.md plus optional reference files
officehum.json       tools (each safe or unsafe to rerun), approvals, connectors, accepts with completion evidence, skills, evals
src/index.ts         the tools, then defineRole(...)
evals/               scenarios with expected outcomes
```

Install one into your own Pi Durable harness:

```ts
import bookkeeper from "@officehum/bookkeeper";

const role = bookkeeper({ quickbooks, overlays: ["./my-bookkeeper"] });
for (const extension of role.extensions) registry.install(extension);
const root = await harness.root(context, { agent: role.agent });
```

Customize a role without changing it with an **overlay**: a directory with your own `AGENTS.md`
additions, `APPEND_SYSTEM.md`, skills and `settings.json` (model; skills and tools on or off).

Rules, enforced by `@officehum/sdk` (`validatePackage`, `checkAgent`, `checkFourLayers`,
`resolveRoleFiles`):

- Pi Durable and pi-ai are peer dependencies (`1.3.x`); no dependency on `@officehum/office` or `@officehum/cli`.
- Every tool states `replay` explicitly and matches the manifest.
- Every **unsafe** tool states exactly one approval decision: an approval in `approvals`, or a
  `noApproval` note (at most 300 characters) saying why it needs none. Never both, never neither; a
  safe tool states neither. The rule holds whichever way the role was written.
- Every accepted ticket type declares `done` completion evidence, which the **host** runs, never the
  model: an engine check that returns findings, a declared **safe** tool whose result reports
  `found`, a file the result attaches, or `{ "person": true }`. All entries must pass.
  `{ticket.id}` and `{ticket.data.<path>}` are the only interpolation.
- Gated actions are blocked unless the host supplies an approver.
- Overlays can switch tools off but never add them; overlay skills hold instructions only.
- The four layers stay apart, checked by `checkFourLayers`: context under 1,000 words with a
  "You may not" section and no amounts, percentages or thresholds; references only in
  `skills/<id>/references/`; no `data/`, `work/` or `deliverables/` folder; no generic shell or file
  tool; and completion evidence on every accepted type. Strict (every issue an error) for a role
  under `agents/` and for generated roles; elsewhere context, knowledge and workflow issues are
  warnings and wisdom issues stay errors.
- The eval suite passes in a bare Pi Durable harness.

See [docs/design/agent-package.md](../docs/design/agent-package.md). For a minimal working role, see
[packages/sdk/fixtures/sample-desk](../packages/sdk/fixtures/sample-desk).

First roles, in milestone M1:

| Folder | Package | Department | Status |
| --- | --- | --- | --- |
| `frontdesk` | `@officehum/frontdesk` | Front office | Built (solo) |
| `bookkeeper` | `@officehum/bookkeeper` (reference agent for accounting) | Finance | Planned (RASF-3070) |
| `office-manager` | `@officehum/office-manager` | Operations | Planned (RASF-3071) |

Only `frontdesk/` exists today. The roster grows into a free catalog of roles for every department
of a company (RASF-3293), starting with a Sales agent (RASF-3295).
