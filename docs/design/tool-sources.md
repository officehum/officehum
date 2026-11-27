# Tool sources: MCP servers and service CLIs

Status: accepted, 2026-11-23. MCP tools and CLI tools are built in the SDK, a host supervises MCP
servers, and the Role Factory generates both. Tool packs are described in section 9; a role spec
cannot name one yet.

Read [agent-package.md](agent-package.md) first, in particular "Engines" and "`officehum.json`".

## Decision

A role's tools come from four sources. All four obey one set of rules, and the model cannot tell
them apart.

| Source | Declared in | Runs as | Built |
| --- | --- | --- | --- |
| Code | the role's entry point, with `defineTool` | the role's own code | yes |
| Engine | `engine` and a tool's `engine` | a child process the role owns | yes |
| Service CLI | `clis` and a tool's `cli` | a child process, one per call | yes |
| MCP server | `mcpServers` and a tool's `mcp` | a long-lived child process the host supervises | yes |

## 1. The shared rules

These hold for every tool, whatever its source. A new source adds nothing to this list.

1. **Declared by name.** A tool exists for the model only if `officehum.json` lists it under
   `tools`. A tool a server or a CLI offers but the manifest does not list is never shown.
2. **Explicit `replay`.** `"safe"` or `"unsafe"`, in the manifest. A tool that is safe to re-run and
   still changes something states `"writes": true`.
3. **One approval decision for every tool that writes:** an entry in `approvals`, or a `noApproval`
   note. `when` conditions work on its declared parameters.
4. **Checked by `checkAgent`**, like any other tool: the declaration, the approval decision, the
   four layers.
5. **The manifest carries the description and the parameters.** See section 2.
6. **Its output is untrusted data.** The SDK wraps what an MCP server or a CLI returns as the
   output of an outside program, never as instructions (section 8).
7. **The model-facing name is the manifest's `name`.** The server's or the CLI's own name for the
   action stays inside the declaration.

## 2. MCP: the manifest shape

```json
{
  "runtimes": [{ "name": "node", "version": ">=22" }],
  "mcpServers": {
    "tickets": {
      "transport": "stdio",
      "command": ["npx", "-y", "@vendor/tickets-mcp@1.4.2"],
      "env": ["TICKETS_TOKEN"]
    }
  },
  "tools": [
    {
      "name": "create_ticket",
      "replay": "unsafe",
      "description": "Open a ticket in the tracker for a problem a client reported.",
      "mcp": { "server": "tickets", "tool": "create_ticket", "idempotencyArg": "request_id" },
      "parameters": {
        "title": { "type": "string", "description": "One line naming the problem", "required": true },
        "body": { "type": "string", "description": "What the client said, in their words" }
      }
    }
  ]
}
```

- `mcpServers.<id>` names one server. `transport` is `"stdio"` or `"http"`.
  - `stdio`: `command` is an argv array, never a shell string. `env` lists the **names** of the
    variables the server needs. The host supplies the values; the manifest never holds one.
  - `http`: `url`, and `auth: { "connector": "<id>" }`. The shape is accepted by the validator and
    refused at start by a host that cannot route the call through its own outbound controls, with a
    message that says so.
- A tool's `mcp` names the server and the server's own tool. `idempotencyArg` is optional
  (section 7).

**Changed from the proposal: descriptions and parameters are not taken from the server.** The epic
proposed reading them from `listTools` unless the manifest overrides them. A tool's description and
parameter descriptions go straight into the model's context on every turn. Text that a third party's
server supplies at start-up would then reach the model unreviewed and could change between runs,
which breaks rule 6 and the stable-prompt rule in agent-package.md. So the manifest must state
`description` and `parameters` for an MCP tool, as it does for an engine tool, and the server's
`listTools` is used only to check them (section 5). The Role Factory reads `listTools`
once, at generation time, to propose a first draft a person reviews.

A manifest parameter maps to the server tool's argument of the same name. The SDK sends only the
declared parameters.

## 3. Service CLIs: the manifest shape

```json
{
  "runtimes": [{ "name": "gh", "version": ">=2.60" }],
  "clis": { "gh": { "command": ["gh"], "env": ["GH_TOKEN"] } },
  "tools": [
    {
      "name": "list_pull_requests",
      "replay": "safe",
      "description": "List the open pull requests of one repository.",
      "cli": {
        "use": "gh",
        "args": ["pr", "list", "--repo", "{repo}", "--json", "number,title"],
        "output": "json"
      },
      "parameters": {
        "repo": { "type": "string", "description": "owner/name", "required": true }
      }
    }
  ]
}
```

- `clis.<id>.command` is the program and any fixed leading arguments. `env` lists variable names.
- A tool's `cli.args` is appended. `{name}` is a placeholder for a declared parameter.
- **A placeholder is a whole argv element.** `"{repo}"` is allowed; `"--repo={repo}"` and
  `"{owner}/{name}"` are refused by the validator. A value is passed as one argument, never split
  and never through a shell.
- **A string value that starts with `-` is refused at call time**, so a parameter cannot become a
  flag. `integer` and `number` parameters are exempt: their values are checked as numbers first.
- An optional parameter that was not given drops its placeholder and, when the element before it is
  a flag (starts with `--`), that flag too.
- `output` is `"json"` or `"text"`. With `"json"`, output that does not parse is an error result.
- A non-zero exit is an error result carrying the exit code and the first 4,000 characters of
  stderr. The call has a timeout (60 seconds unless the tool states `timeoutSeconds`).
- The process runs with no standard input, in an empty temporary directory, with an environment of
  `PATH` plus the variables the `clis` entry names.
- **Added while building:** an element of `command` that starts with `./` names a file
  in the role package and is resolved against the package root, because the process runs in an
  empty temporary directory; such an element may not contain `..`. This is how a role ships a small
  wrapper script of its own. A parameter may not be called `callId`, the SDK's placeholder.

## 4. Pinning and runtimes

- A program a tool source runs is declared in `runtimes` with a version range: `node` for an `npx`
  server, `python3` for a `uvx` one, the CLI's own program for a CLI. `checkRuntimes` already
  verifies them.
- A `stdio` server started through `npx` or `uvx` must name its package with an exact version
  (`@vendor/tickets-mcp@1.4.2`). The validator refuses a bare name, a range or a tag. A server that
  is not pinned is a different program every time the cache expires.
- A CLI is pinned by its `runtimes` range and by what the host has installed.

## 5. Drift

Before a role with MCP tools goes live, and again whenever its server restarts, the host calls
`listTools` and compares it with the manifest (`checkMcpDrift`):

| What it finds | Result |
| --- | --- |
| A declared tool the server no longer offers | the role does not go live; the reason names the tool |
| A declared parameter the server's schema does not have | the role does not go live |
| A parameter the server requires that the manifest does not declare | the role does not go live |
| A declared parameter whose type differs from the server's | the role does not go live |
| A tool the server offers that the manifest does not declare | hidden from the model, reported once in the log and in `get_state` |

A role that is not live says why in `get_state`; its other tools are not offered either, because a
role with a missing tool would improvise.

MCP tool annotations (`readOnlyHint` and the like) are the server's opinion. They are never used to
set `replay` or to skip an approval.

## 6. Who starts what

A role stays portable: it does not start a server. Its factory takes the MCP clients it needs the
way it takes any app client.

```ts
import stockroom from "@example/stockroom";
const role = stockroom({ mcp: { tickets: client } }); // an McpClient the caller connected
```

- **In a bare Pi Durable harness** the embedder connects a client and passes it in. With no client
  for a declared server, that server's tools are installed and each call returns "not connected",
  the same answer a role gives for any unconfigured capability. The role still loads.
- **In a host that runs servers for its roles**, the host starts and supervises them, and starts a
  server only when its own configuration enables it for that role.

  Nothing a role's manifest says can start a program on its own. That is principle 2 of the vision
  document: capabilities are off until the customer turns them on.
- One server process serves every role in the office whose declaration of it is identical. The
  runtime health-checks it with `ping`, restarts it with backoff, re-runs the drift check after a
  restart, and closes it with the office.
- **Added while building:** a stdio server runs in an empty working directory of its
  own, and an element of its `command` that starts with `./` names a file in the role package,
  resolved against the package root and never containing `..`, as for CLIs (section 3). Without
  this, a relative path would mean whichever package happened to start a shared process. Identical
  means the same command once resolved and the same variable names. A role that is not live is
  refused new work by the runtime and has every tool call blocked by a guard hook, so a run that
  reaches it through a relay ticket or a restart cannot act with a missing tool. After repeated
  failures in a row (default five) a server is left stopped until the runtime restarts.

## 7. Durability

- An MCP or CLI tool is `"unsafe"` unless a person has reviewed it as read-only and declared it
  `"safe"`. An unsafe call that was interrupted is not run again by Pi Durable; the role is told
  and decides with a person, as for any unsafe tool.
- Where the server or the CLI accepts an idempotency key, the tool names the argument:
  `"idempotencyArg": "request_id"` (MCP) or a `{callId}` placeholder in `cli.args`. The SDK fills
  it with the Pi Durable tool call's id, which is the same on a retry. A tool with a key may then be
  declared `"safe"` with `"writes": true`.

## 8. Secrets, network and what is not yet contained

- Credentials reach a server or a CLI only as environment variables the manifest names and the
  host supplies. A value is never in a manifest, an overlay, a log line or a tool result. The child
  does not inherit the host's environment (`inheritEnv: false`); it gets `PATH` and the named
  variables.
- **Output is data.** The SDK returns an MCP or CLI result inside a fixed frame that says which
  program produced it and that it is not an instruction, and never merges it into a system section.
  An approval's facts are read from the role's own records, never from such output.
- **Not contained yet, said plainly:** until the runtime sandbox exists a stdio server
  or a CLI runs as a child of its host with the host's access to the machine and the network.
  Enabling a tool source is therefore a decision to trust that program. The README says so beside the
  instructions.

## 9. Tool packs

A tool pack is a small portable package whose `officehum.json` has `"kind": "toolpack"`: one MCP
server or one CLI and its reviewed tools, with descriptions, `replay` and approval decisions already
set. Office Hum's vetted catalog is a list of tool packs. Enabling a pack for an agent installs the
package and selects its extension; no overlay is edited to add a tool.

## 10. What the SDK and the host gain

| Piece | Where |
| --- | --- |
| `mcpServers`, a tool's `mcp`, their validation and the published schema | `packages/sdk/src/manifest.ts` |
| `mcpTools(manifest, clients)`, `checkMcpDrift(manifest, client)`, `stubMcp(tools)` | `packages/sdk/src/mcp.ts` |
| `clis`, a tool's `cli`, `cliTools(manifest)` on the engine runner | `packages/sdk/src/cli-tools.ts` |
| Start, health-check, restart, share and drift-check servers | the host |
| The spec's tool `source`, the interview step, generated declarations | `packages/role-factory` |

`stubMcp` builds an `McpClient` over pi-mcp's in-memory transport, so tests and evals use the real
client code with no process and no network.

## 11. The dependency

`@earendil-works/pi-mcp`, pinned exactly at `1.6.0`, the release that matches the pinned Pi Durable.
It is MIT, has one dependency (`cross-spawn`) and none on other Pi packages. It is an **optional
peer** of `@officehum/sdk`: a role with no MCP tools never loads it, and the SDK imports it lazily.
This adds a dependency; it does not change the Pi Durable or pi-ai pins.

## 12. The spike

A spike script, run on 2026-11-23 against `@earendil-works/pi-mcp`
1.3.0 with its in-memory transport and a hand-written server:

```
server: fake-tickets 1.4.2
protocol: 2025-11-25
tool: create_ticket | fields: name,description,inputSchema | schema: object
tool: list_tickets | fields: name,description,inputSchema | schema: object
callTool: {"content":[{"type":"text","text":"ok: create_ticket"}],"isError":false}
toLlmContent: [{"type":"text","text":"ok: create_ticket"}]
unknown tool isError: true
state after close: closed
```

Confirmed: `McpClient` (`connect`, `listTools`, `callTool`, `close`, `connectionState`),
`StdioTransport` (`command`, `args`, `env`, `inheritEnv`), `toLlmContent`, and
`createInMemoryTransportPair` from `@earendil-works/pi-mcp/testing`. A tool failure comes back as
`isError: true` in the result, not as a thrown error.

**Not run:** the spike was also meant to run against a public stdio server. That mode (`--stdio CMD ARG...`) has not been
exercised against a third-party server; it is in the script for a person to run. The stdio transport itself is therefore confirmed
from its type declarations and README only.
