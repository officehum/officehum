# @officehum/sdk

What a role package is written with: the `officehum.json` schema and its validators, `defineRole`,
the approval gate, overlays, engines, the eval format and runner, the local board, and the file store
contracts. It is portable: its only peers are Pi Durable, pi-ai, pi-schema and pi-mcp, and it never
depends on a host, so a role built on it runs in any Pi Durable 1.6.x harness.

## Install

Not published to npm yet. In a clone of this repository, `npm ci && npm run build` builds it, and
workspaces (every role under `agents/`) import it by name. For another project, pack it
(`npm pack -w @officehum/sdk`) and install the tarball beside `@earendil-works/pi-durable`,
`pi-ai`, `pi-schema` and `pi-mcp` at 1.6.0; [Build a role](../../docs/build-a-role.md#use-a-role-in-your-own-harness)
shows the commands.

## A minimal role

```ts
import { fileURLToPath } from "node:url";
import { type DefinedRole, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };

export default function myRole({ overlays }: { overlays?: readonly string[] } = {}): DefinedRole {
  return defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    ...(overlays === undefined ? {} : { overlays }),
  });
}
```

`defineRole` reads `AGENTS.md`, `APPEND_SYSTEM.md` and `skills/` from `packageDir`, applies the
overlays, and returns `extensions` to install in a registry and `agent` to configure a conversation
with. Check a package before you ship it:

```ts
import { formatIssue, validatePackage } from "@officehum/sdk";

const result = await validatePackage("agents/my-role");
for (const issue of result.issues) console.log(formatIssue(issue));
```

`packages/sdk/fixtures/sample-desk` is the smallest complete role with a tool and an approval; it is a
test fixture, imported by source path, so `officehum run` cannot load it
([why](fixtures/README.md)).

## Docs

- [Build a role](../../docs/build-a-role.md): the guide.
- [agent-package.md](../../docs/design/agent-package.md): the full contract, including every
  `officehum.json` field, completion evidence and the eval format.
- [overlay-rules.md](../../docs/design/overlay-rules.md): what counts as lowering a safeguard.
- The JSON Schema for `officehum.json`: [`schema/officehum.schema.json`](schema/officehum.schema.json).
