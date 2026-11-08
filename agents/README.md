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

## The company every role works for

`company/default/` at the root of the repository is the business the catalogue's roles work for:
Northwind Facilities, a fictitious commercial cleaning and facilities company in Portland, Oregon.
`company.json` holds the record a program reads (people, services, price book in integer cents,
policies, escalation, glossary); `handbook.md`, `policies.md` and `pricing.md` are written for an agent
to read.

A published role has to be self-contained, so the facts reach each role as generated copies inside it:

```
skills/company-handbook/SKILL.md                    the handbook, and the entry point
skills/company-handbook/references/pricing.md       every price and minimum
skills/company-handbook/references/policies.md      the rules and who decides
skills/company-handbook/references/facts.json       the same facts, for the role's own code
```

`npm run sync-company` writes them for every role folder here; `scripts/sync-company.ts` refuses a
company package that disagrees with itself, and `scripts/company.test.ts` regenerates the whole
catalogue in memory and fails when a copy has drifted. One source, many readers — the same rule as the
JSON Schema. Do not edit a generated copy.

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
| `bookkeeper` | `@officehum/bookkeeper` (the Accounting agent: invoicing, collections, supplier bills with `list_vendor_bills`, `record_vendor_bill` and `pay_vendor_bill` behind a person's approval, and `reconcile_summary` for the month-end close; the package keeps its name until RASF-3079) | Finance | Built (RASF-3127; accounts payable RASF-3070) |
| `office-manager` | `@officehum/office-manager` | Operations | Planned (RASF-3071) |
| `sales` | `@officehum/sales` (the template for the catalogue) | Sales | Built (RASF-3295) |
| `operations` | `@officehum/operations` | Operations | Built (RASF-3468) |
| `purchasing` | `@officehum/purchasing` | Operations (purchasing) | Built (RASF-3469) |
| `marketing` | `@officehum/marketing` | Marketing | Built (RASF-3470) |
| `support` | `@officehum/support` | Front office (customer support) | Built (RASF-3471) |
| `people-ops` | `@officehum/people-ops` | People | Built (RASF-3472) |

`frontdesk/`, `bookkeeper/`, `office-manager/`, `sales/`, `operations/`, `purchasing/`, `marketing/`,
`support/` and `people-ops/` exist today. The roster grows into a free catalog of roles for every department of a company (RASF-3293),
and `sales/` is the shape the rest of it is built to: a manifest, a system prompt, five tools behind
a fake-backed seam, skills, evals and a README a stranger can follow.
