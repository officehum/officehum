# Runtime process (RASF-3104)

**Goal:** `officehum runtime --db FILE --office FILE` hosts one office's Pi Durable harness (every role,
one SQLite file) and speaks the Gateway Protocol on stdin/stdout, for the gateway (RASF-3105) to
supervise.

**Spec:** Linear RASF-3104, under RASF-3101. Protocol: `docs/design/gateway-protocol.md`.

## Files

| File | Responsibility |
| --- | --- |
| `packages/office/src/adapter/office.ts` | Two adapter additions: `listen(conversation, onEvent)` (attach to events, resolving once attached so nothing after it is missed; `watch` is rebuilt on it) and `resume()` (`Harness.resume`, for a host that opened paused). |
| `packages/office/src/roles/run-role.ts` | Export `answerText(conversation, settlement)`, extracted from the private `resultFor`, so the runtime reads an answer the same way `run` does. |
| `packages/office/src/runtime/office-file.ts` | `readOfficeFile(path)` (validated, every problem with its path; role dirs resolved against the file) and `loadOfficeRoles(file, options)`. |
| `packages/office/src/runtime/frame-writer.ts` | Queues frames to a writable without blocking the harness; honours backpressure. |
| `packages/office/src/runtime/runtime.ts` | `openRuntime(options)`: the office, its request index, command handling and events. `serveRuntime(runtime, input, output)`: the stdio loop. |
| `packages/office/src/fixtures/runtime-child.mjs` | The kill-and-restart child: an inline role with a safe and an unsafe tool, served over stdio. |
| `packages/cli/src/cli.ts`, `run.ts` | The `runtime` command; `runModels` refactored into a provider builder the runtime reuses for several roles. |
| `packages/protocol` doc | Fill in `get_state`/`list_agents` data and the runtime's scoped `requestId`. |

## Decisions

- **Scoped request ids.** The runtime keys a submission by `<principal.id, URI-encoded>/<requestId>`,
  so `a/b` + `c` and `a` + `b/c` cannot collide. `accepted` and every `event` carry the scoped id; the
  gateway rewrites it to the client's own. A durable session document maps each scoped id to its
  submission, conversation and agent, written after `submit`; a crash between the two is covered
  because Pi Durable's `submit` is itself idempotent per conversation, and a settled status on return
  reads as `existing`.
- **Disposition** comes from the admitted submission's status: `placed` → `started`, `queued` →
  `queued`, already settled → `existing`; a scoped id already in the index is `existing` with no call.
- **Conversations.** Each agent's default conversation is keyed `agent:<id>`; a `conversation` value
  names `agent:<id>:<conversation>`. A saved conversation keeps its model.
- **Events.** Each conversation has one listener attached before any submit. Tool and text events go
  to the conversation's oldest unsettled tracked request; `settled` comes from the submission itself
  (watch event or status check, once). `text_delta` is emitted: Pi Durable 1.3 exposes partial text
  in `message_update`. Events are kept in memory per request; after a restart only `settled` is
  replayed for a request that finished before it (documented; reconnect semantics are RASF-3106).
- **Subscription.** `submit` subscribes the connection to its request; `subscribe` replays recorded
  events after `afterSeq` and always the `settled` event, then streams.
- **Start-up** opens paused, installs roles, attaches listeners to every unsettled submission's
  conversation, then resumes, then sends `welcome`. `hello` is answered with `handshake` too.
- **Principal.** A command without one gets `unauthorized` before validation; with one it is validated
  as sent by the gateway.
- **Submits are serialized** so two frames with one request id cannot both start work.
- `approve` answers `not_found` until RASF-3108. `--demo` is passed to every role, as in `run`.

## Tests (first)

Runtime, in process with the scripted provider and an inline role: submit → accepted started → tool
events → settled done; same request id → accepted existing, no new model call, same settled; two
principals with one request id → two submissions; missing principal → unauthorized; bad frame,
invalid message, unknown agent, subscribe after settle, abort, list_agents/get_state, approve.
Child process: SIGKILL during the unsafe tool, restart, subscribe → settled done, unsafe tool ran once,
model saw an interrupted result. Office file: validation problems with paths. CLI: `runtime` answers
`hello` and `submit` over injected stdio.
