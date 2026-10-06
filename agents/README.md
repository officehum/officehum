# Agents

Each folder here is one Office Hum role, published free as `@officehum/<role>`.

Every role is a **portable Pi Durable extension**: an MIT npm package that installs into any
Pi Durable 1.0.x harness, with or without Office Hum. Office Hum composes roles as its
coordination layer; it never modifies them, and a role never depends on it.

A role package contains:

- an `officehum.json` manifest: tools (each marked safe or unsafe to rerun), connectors, approvals,
  channels, accepted ticket types, skills, and where its evals live;
- a default export: a factory that takes the app clients the role needs (and, optionally, an
  approver) and returns its Pi Durable extensions plus recommended agent settings;
- an eval suite, run before every release.

```ts
import bookkeeper from "@officehum/bookkeeper";

const role = bookkeeper({ quickbooks });
for (const extension of role.extensions) registry.install(extension);
const root = await harness.root(context, { agent: role.agent });
```

The rules, enforced by `@officehum/sdk` (`validatePackage`, `checkAgent`):

- Pi Durable and pi-ai are peer dependencies (`1.0.x`); no dependency on `@officehum/office` or `@officehum/cli`.
- Every tool states `replay` explicitly, and matches the manifest.
- Gated actions are blocked unless the host supplies an approver.
- The eval suite passes in a bare Pi Durable harness.

See [docs/design/agent-package.md](../docs/design/agent-package.md). For a minimal working role, see
[packages/sdk/fixtures/sample-desk](../packages/sdk/fixtures/sample-desk).

First roles, in milestone M1:

| Folder | Package | Department |
| --- | --- | --- |
| `bookkeeper` | `@officehum/bookkeeper` (reference agent) | Finance |
| `frontdesk` | `@officehum/frontdesk` | Front office |
| `office-manager` | `@officehum/office-manager` | Operations |
