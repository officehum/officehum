# Architecture

How the agents are put together, what they promise across a crash or a restart, and which guardrails
are code rather than prompt text. The detail is in [`docs/design/`](design/).

## The packages

```
your code, officehum run, officehum eval ──▶ @officehum/runner ──▶ role package ──▶ Pi Durable
                                              (harness adapter)     (agents/*)       (harness, SQLite)
                                                                      │
                                                                      ├─ @officehum/sdk (manifest, guardrails, evals)
                                                                      ├─ tool packs, app clients
                                                                      └─ @officehum/memory
```

| Package | What it does |
| --- | --- |
| [`@officehum/sdk`](../packages/sdk/README.md) | The role package contract: `officehum.json` and its validators, `defineRole`, the approval gate, overlays, engines, the eval format and grader, and the local board roles on one harness hand work over. It opens no harness. |
| [`agents/*`](../agents/README.md) | The fifteen roles. Each is a Pi Durable agent with Pi Durable as a peer dependency, and runs in any Pi Durable 1.6 harness. |
| [`@officehum/runner`](../packages/runner/README.md) | Runs one role package: the harness adapter (the only code that opens a Pi Durable `Harness`), role loading and checks, one-role runs over a SQLite file, the bare eval runner, the scripted model and the eval judge. |
| [`@officehum/cli`](../packages/cli/README.md) | `officehum`: `run`, `eval`, `judge-check`, `verify-role` and `review`, on the runner. |
| [`@officehum/memory`](../packages/memory/README.md) | A portable memory extension: what an agent learns on the job, saved, recalled and retired in Pi Durable documents, with its guardrails in code. |
| Tool packs | [`tools-paper-office`](../packages/tools-paper-office/README.md), [`tools-documents`](../packages/tools-documents/README.md), [`tools-docgen`](../packages/tools-docgen/README.md), [`tools-data`](../packages/tools-data/README.md) and [`tools-esign`](../packages/tools-esign/README.md): document work, reading, generation, data questions and e-signature, which a role declares and a host supplies. |
| App clients | [`google-calendar`](../packages/google-calendar/README.md) and [`quickbooks`](../packages/quickbooks/README.md): portable clients with fakes, which a host builds and hands to a role. |
| [`@officehum/provider-paper`](../packages/provider-paper/README.md) | The Paper Instruments model provider for pi-ai. |
| [`@officehum/role-factory`](../packages/role-factory/README.md) | `ROLE_SPEC.md` and `officehum-role`: interview a person, generate a role package. |

A role never imports a host. It reaches the outside only through what the host hands it: the app
clients (calendar, QuickBooks, a desk), the approver, the verified sender, the clock and any tool packs.
That is why a role's evals run in a bare Pi Durable harness, and why the same role package runs in
your own harness and in `officehum run`.

## What survives a restart

Pi Durable commits a conversation's progress to SQLite as it goes. `officehum run` keeps one SQLite file
per role (`.officehum/<role>.sqlite`) and, when it starts, resumes the work a previous run left
unsettled.

| | After a crash or restart |
| --- | --- |
| Conversations | Resume where they stopped. A model request the crash cut off is retried. |
| A tool call that was running | A tool declared `replay: "safe"` runs again (it reads, or it is idempotent). A tool declared `replay: "unsafe"` is never run a second time: the model gets an `interrupted` result instead. So an unsafe tool runs at most once, and a write that must happen exactly once is a safe tool with its own idempotency key. |
| A submission | Exactly once by its request id: the same line typed again in `officehum run` is a new submission, and an unfinished one is resumed, not repeated. |
| An approval | An approval covers one call with exactly the arguments the approver saw. A value the approver enters reaches the tool exactly once, across replay and restart ([approver-values.md](design/approver-values.md)). |

## Guardrails are code

- **Every tool says whether it may run twice** (`replay`), in code and in `officehum.json`, and the two
  must match.
- **Approvals are hooks, not instructions.** A gated call waits for the host's approver; with no
  approver, a gated action is refused. A role's limits are manifest data an overlay can raise or lower,
  and a run under overlays names every safeguard they lower.
- **Numbers come from code.** Figures come from engines, connected systems or tools, never from model
  arithmetic; the eval suites check that a reply's figures are the ones a tool returned.
- **Who is asking is the host's to say.** A role reads its sender from what the host verified, never
  from a tool argument or message text, and refuses customer data to a sender it cannot verify.
- **No shell or file-writing tools in roles.** The only exception is the bounded Paper document
  workspace (`tools-paper-office`), which is a bounded workspace, not a sandbox.
- **The portability gate.** `officehum eval` installs nothing but the role on a fresh harness, so a role
  that depends on anything else fails its own suite.

## Where to read more

- [agent-package.md](design/agent-package.md): the role package contract, field by field.
- [overlay-rules.md](design/overlay-rules.md): what a business may change in a role, and how a lowered
  safeguard is shown.
- [tool-sources.md](design/tool-sources.md): MCP servers and CLIs as a role's tools.
- [role-spec.md](design/role-spec.md): the Role Factory's spec.
- [file-store.md](design/file-store.md) and [approver-values.md](design/approver-values.md).
