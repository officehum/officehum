# Office Hum Gateway Protocol, version 1

The Gateway Protocol is how anything outside an office's runtime talks to its agents: the web UI, an
ERP, a scheduler, a staff member's client, and the gateway itself when it forwards a command to the
runtime. This document is the reference for clients in any language. `@officehum/protocol` is the
TypeScript implementation of these schemas and the framing codec; when the two disagree, fix one so
they agree again.

## Where it runs

One **gateway** process is an office's network edge (TLS, sign-in, sockets). It supervises one
**runtime** child process per office, which hosts every role in one Pi Durable harness. Clients speak
this protocol to the gateway; the gateway speaks the same protocol to the runtime over stdio, adding a
`principal` to every command it forwards. Transports are not part of this protocol.

```
client ──(Gateway Protocol)──▶ gateway ──(Gateway Protocol + principal)──▶ runtime
```

## Framing

- Each message is one JSON object, UTF-8, followed by LF (`0x0A`).
- **Only LF ends a message.** U+2028 and U+2029 may appear raw inside JSON strings, and a reader must
  not split on them. A lone CR does not end a message; a CR just before the LF is ignored.
- Blank lines are ignored.
- A line longer than **8 MiB** (8,388,608 bytes, not counting the LF) is refused with
  `error frame_too_large`, then skipped up to its LF. The connection stays open.
- A line that is not valid UTF-8 or JSON is refused with `error bad_frame`. The connection stays open.
- A stream that ends partway through a line gets `bad_frame` for that line.
- A reader fed text rather than bytes must not split a character between chunks; the TypeScript
  `LineDecoder` holds back half a character until the rest arrives.

## Handshake

The first message on a connection is the client's `hello`. The server answers `welcome` when it speaks
the requested version, or `error unsupported_version` for any other `version` value (and then closes
the connection).

```json
{"type":"hello","version":1,"client":"studio-web"}
{"type":"welcome","version":1,"serverId":"office-7f3a"}
```

```json
{"type":"hello","version":2,"client":"studio-web"}
{"type":"error","code":"unsupported_version","message":"This server speaks Gateway Protocol version 1; the client asked for version 2."}
```

`client` names the client software. It is a label, not an identity: identity comes from the
authenticated session. A WebSocket client that cannot send an `Authorization: Bearer` header on the
upgrade (a browser) signs in by putting its token in `hello`:

```json
{"type":"hello","version":1,"client":"studio-web","token":"eyJhbGciOiJFUzI1NiJ9..."}
```

The gateway reads the token and never forwards it. Until a connection has signed in, every command on
it gets `error unauthorized`.

## Commands

Every command carries an `id`, which must be unique on its connection. The server's reply carries the
same `id`. Identifiers (`id`, `requestId`, `agent`, `approvalId`, `conversation`) are non-empty
strings of at most 256 characters. A field not listed for a message is refused.

### `submit`

Gives an agent work. `requestId` makes the submission **exactly-once**: it is scoped to the
authenticated caller, and submitting the same `requestId` again returns the stored request
(`disposition: "existing"`) with no new model calls or tool runs.

`input` is either a message:

```json
{"type":"submit","id":"c1","agent":"front-desk","requestId":"r-001","input":{"kind":"message","text":"Hello"}}
```

or a ticket, whose `payload` is any JSON value the ticket type defines:

```json
{"type":"submit","id":"c2","agent":"front-desk","requestId":"r-002","input":{"kind":"ticket","type":"example.task","payload":{"note":"anything"}},"conversation":"conv-1"}
```

`conversation` continues an existing conversation; without it, the agent starts a new one.

Reply: `accepted`, where `disposition` is `started` (work began), `queued` (the agent is busy and
will start it later), or `existing` (this `requestId` was already submitted):

```json
{"type":"accepted","id":"c1","requestId":"r-001","disposition":"started"}
```

Progress then arrives as `event` messages for `r-001`. A repeated submit always ends with the
request's `settled` event once it has one, even on a connection that has already seen it, so a client
that retries gets the answer without having to remember it.

### `subscribe`

Streams a request's events. `afterSeq` resumes after the last event the client saw; without it the
server sends every event from the start. A client that reconnects uses this to catch up without gaps.
`data.settled` says whether the request has already settled, in which case its `settled` event
follows the result.

```json
{"type":"subscribe","id":"c3","requestId":"r-001","afterSeq":4}
{"type":"result","id":"c3","ok":true,"data":{"settled":false}}
```

### `get_state`

Asks for the state of the office, or of one agent with `agent`. `data.agents` lists each agent as
`list_agents` does, plus `status` (`busy` while any of its requests is unsettled, else `idle`) and
`openRequests`.

```json
{"type":"get_state","id":"c4","agent":"front-desk"}
{"type":"result","id":"c4","ok":true,"data":{"agents":[{"name":"front-desk","role":"Answers the front desk","model":"paper/ultramarine-1-flash","tools":[{"name":"check_schedule","replay":"safe"}],"status":"idle","openRequests":0}]}}
```

### `list_agents`

Lists the office's agents: each one's `name` (the role's id, which `submit` names as `agent`), what its
`role` is, the `model` its new conversations use (`provider/model`), and its `tools` with their replay
policy.

```json
{"type":"list_agents","id":"c5"}
{"type":"result","id":"c5","ok":true,"data":{"agents":[{"name":"front-desk","role":"Answers the front desk","model":"paper/ultramarine-1-flash","tools":[{"name":"check_schedule","replay":"safe"}]}]}}
```

### `abort`

Stops a request. Its stream ends with `settled` and `status: "aborted"`.

```json
{"type":"abort","id":"c6","requestId":"r-001"}
{"type":"result","id":"c6","ok":true}
```

### `approve`

Decides an action waiting on a person's approval (see `approval_requested`). `decision` is `approve`
or `decline`; `note` is optional. The approver is the authenticated caller, never a field in the
message, and the gateway enforces the caller's approval limit.

```json
{"type":"approve","id":"c7","approvalId":"a-9","decision":"decline","note":"Not this week"}
{"type":"result","id":"c7","ok":true}
```

### `ping`

Checks the connection.

```json
{"type":"ping","id":"c8"}
{"type":"result","id":"c8","ok":true}
```

## Replies

| Message | Fields | When |
| --- | --- | --- |
| `accepted` | `id`, `requestId`, `disposition` | A `submit` was taken. |
| `result` | `id`, `ok: true`, optional `data` | Any other command succeeded. |
| `error` | optional `id`, `code`, `message`, optional `problems` | A command failed, or a frame or message was refused. |

An `error` answering a command carries its `id`. An error about a frame that could not be read has
no `id`.

```json
{"type":"error","code":"bad_frame","message":"A line is not valid JSON."}
```

A message that fails validation gets `invalid_message`, with every problem listed, each with its
path. A path joins field names with `.` and array positions with `[n]` (`principal.roles[0]`); it is
for people reading the error, so a field name that itself contains `.` is not escaped. A value the
sender wrote is quoted back only up to 60 characters.

```json
{"type":"error","id":"c9","code":"invalid_message","message":"The message has 2 problems: agent: is required; input.text: is required","problems":[{"path":"agent","message":"is required"},{"path":"input.text","message":"is required"}]}
```

### Error codes

| Code | Meaning |
| --- | --- |
| `bad_frame` | A line is not valid UTF-8 or JSON, or the stream ended partway through a line. |
| `frame_too_large` | A line is longer than 8 MiB. |
| `unsupported_version` | The `hello` asked for a version this server does not speak. |
| `invalid_message` | The message does not match its schema; `problems` lists why. |
| `unknown_agent` | No agent by that name in this office. |
| `unauthorized` | The connection is not signed in. |
| `forbidden` | The caller may not do this (for example, an approval above their limit). |
| `not_found` | No such request, conversation or approval. |
| `conflict` | The command clashes with the current state (for example, an approval already decided). |
| `busy` | The server cannot take the command now; try again later. |
| `internal` | Something went wrong on the server. |

## Events

Events report a request's progress. `seq` starts at 1 and goes up by one for each event of a request,
so a client can resume with `subscribe` and `afterSeq`. Every request's stream ends with exactly one
`settled` event.

```json
{"type":"event","requestId":"r-001","seq":1,"event":{"kind":"text_delta","text":"Let me "}}
{"type":"event","requestId":"r-001","seq":2,"event":{"kind":"tool_start","toolCallId":"t-1","tool":"lookup"}}
{"type":"event","requestId":"r-001","seq":3,"event":{"kind":"tool_end","toolCallId":"t-1","tool":"lookup","ok":true}}
{"type":"event","requestId":"r-001","seq":4,"event":{"kind":"approval_requested","approvalId":"a-9","tool":"send_note","summary":"Send the note to the team"}}
{"type":"event","requestId":"r-001","seq":5,"event":{"kind":"approval_decided","approvalId":"a-9","decision":"approve","by":"user-7"}}
{"type":"event","requestId":"r-001","seq":6,"event":{"kind":"settled","status":"done","answer":"The note is sent."}}
```

| `kind` | Fields | Meaning |
| --- | --- | --- |
| `text_delta` | `text` | The next piece of the agent's reply. |
| `tool_start` | `toolCallId`, `tool` | The agent started a tool call. |
| `tool_end` | `toolCallId`, `tool`, `ok` | The tool call finished. |
| `approval_requested` | `approvalId`, `tool`, `summary` | An action waits on a person's approval. |
| `approval_decided` | `approvalId`, `decision`, optional `by` | The approval was decided. `by` is the approver's principal id; it is absent when the gate decided on its own, and a timeout always counts as `decline`. |
| `settled` | `status` (`done`, `failed` or `aborted`), optional `answer` | The request finished. |

## Principal (gateway to runtime only)

The gateway adds a `principal` to every command it forwards to the runtime, built from the
authenticated session:

```json
{"type":"approve","id":"g-41","approvalId":"a-9","decision":"approve","principal":{"id":"user-7","roles":["approver"],"approvalLimit":500}}
```

| Field | Meaning |
| --- | --- |
| `id` | The caller's identity. |
| `roles` | The caller's roles in this office. |
| `approvalLimit` | Optional: the most this caller may approve. |

**A client may never send `principal`.** The gateway refuses a client message that carries one with
`invalid_message`, and the runtime refuses a forwarded command without one. Approver identity always
comes from the session, never from a message the caller wrote.

## The runtime process

`officehum runtime --db FILE --office FILE` is the runtime: one office's Pi Durable harness, every role
in one SQLite file, speaking this protocol on stdin/stdout. The gateway starts and supervises it; a
developer can also run it directly and type frames at it. stdout carries frames only; logs go to
stderr. `docs/superpowers/plans/2026-11-10-runtime-process.md` records how it is built.

- **Start-up.** It opens the office, loads the roles the office file lists, attaches to the work a
  previous run left unsettled, resumes it, and sends `welcome` unprompted once it is ready. It also
  answers each `hello` with `welcome` or `unsupported_version`.
- **Commands** must carry a `principal`; one without gets `error unauthorized`.
- **Request ids are scoped by principal.** The runtime keys a submission by
  `<principal id, URI-encoded>/<request id>`, and `accepted` and every `event` carry that scoped id.
  Two principals can use the same request id without meeting; the gateway rewrites the scoped id back
  to the client's own. `subscribe` and `abort` take the client's request id and find only that
  principal's request.
- **Exactly once.** The scoped id is kept in a durable index beside the office, so the same request id
  again, even after a restart, gets `accepted` with `existing` and no new work. The index records
  the request's conversation before the work is admitted, so a retry after a crash goes back to the
  same conversation (whatever `conversation` it names), where the harness recognizes it.
- **Conversations are per principal.** Each principal has its own default conversation with each
  agent, and `conversation` names another of theirs. One person's transcript, queue and `abort` never
  reach another's. A request submitted while its conversation is busy is `queued`.
- **Events.** `submit` subscribes the connection to its request. Tool and text events belong to the
  request the harness placed in the run. Events are kept in memory: after a restart, a request that
  finished before it replays only its `settled` event, and a resumed request's events are numbered
  again from `seq` 1, so an `afterSeq` from before the restart can skip some of them; `settled` is
  always sent. `text_delta` is sent when the harness commits partial output (every 100 ms by default,
  so a short answer may arrive with none).
- **`abort`** stops the request's whole conversation, and so every request that principal queued in
  it.
- **Stopping.** The input ending, SIGINT or SIGTERM closes the office cleanly; unfinished work resumes
  on the next start. A killed runtime loses nothing either: Pi Durable resumes the run, and an unsafe
  tool that was interrupted is reported to the model as interrupted rather than run again.
- **stdout** is a pipe the gateway reads; the runtime writes to it without blocking, so a gateway that
  stops reading costs memory, not progress.
- **`approve`** answers `not_found` until remote approvals (RASF-3108); until then gated actions are
  refused.

The office file lists the roles, with paths relative to the file:

```json
{ "version": 1, "id": "office-7f3a", "roles": [{ "dir": "agents/sales", "overlays": ["overlays/sales"] }] }
```

## The gateway

`@officehum/gateway` (`officehum-gateway --config gateway.json`) is the office's network edge. It
starts the runtime as a child process, signs clients in, checks what they may do, forwards their
commands with their `principal`, and sends replies and events back. A runtime crash never closes a
client's connection: the gateway restarts the runtime (after 1 s, 2 s, 4 s … up to 30 s), answers
`busy` meanwhile, and carries on each running request's events once it is back.

| Route | What it does |
| --- | --- |
| `GET /v1/ws` | A WebSocket speaking this protocol, one JSON message per WebSocket message. |
| `POST /v1/submit` | The body is a `submit` without `type` or `id`; answers `202` with `accepted`. |
| `GET /v1/requests/:requestId` | `{ requestId, status: "running" \| "settled", result?, events }`. |
| `GET /v1/requests/:requestId/events` | The request's events as Server-Sent Events: `id` is the `seq`, `event` the kind, `data` the event message. Send `Last-Event-ID` to resume after it. The stream ends after `settled`. |
| `GET /healthz` | `200 { status: "ok", runtime: "up" }`, or `503` while the runtime is down. No sign-in. |

**Signing in.** Every route but `/healthz` needs a JWT: `Authorization: Bearer <token>` on HTTP and on
the WebSocket upgrade, or `hello.token` as a WebSocket's first frame. The token is verified with the
public key in `OFFICEHUM_GATEWAY_JWT_PUBLIC_KEY` (RSA → RS256, P-256 → ES256, Ed25519 → EdDSA). Its
`sub` becomes the principal's `id`, `roles` its roles and `approvalLimit` its limit. `exp` is
required, and `iss`/`aud` are checked when `gateway.json` names them. A WebSocket whose token expires
gets `unauthorized` until it sends `hello` with a fresh one. Optional mutual TLS (`tls.clientCa`)
adds a client-certificate check on top.

**Permissions** (`gateway.json`) deny by default. `submit` needs a rule naming one of the caller's
roles and the agent; `abort` a rule naming one of their roles; `approve` likewise, and the principal
forwarded carries the lower of the token's and the rule's limit. `subscribe`, `get_state`,
`list_agents` and `ping` need only a signed-in caller, since the runtime scopes requests to their
principal. Refused commands get `forbidden` (HTTP 403); a missing or bad token gets `unauthorized`
(401).

**Event numbers.** Clients see the gateway's `seq`, which only grows for a request, across runtime
restarts. The gateway drops events the current runtime has already sent it and forwards `settled`
once. A run resumed after a runtime restart does its unfinished steps again, so its `tool_start` for a
step that was interrupted can appear twice; an unsafe tool is not run again. The gateway keeps the
latest 2,000 events of a request in memory; a client resuming from further back than that gets the
kept ones, with a gap before them, and `settled`. Numbering and replay last as long as the gateway
process: after a gateway restart, `Last-Event-ID` from before it does not apply (RASF-3106).

**Restarts.** The gateway restarts the runtime after any exit it did not ask for, not only a failing
one, and answers `busy` meanwhile. If the restarted runtime no longer knows a request, its
subscribers get an `error` saying so.

**Sessions.** A WebSocket that has not signed in within 30 seconds is closed. When a connection's
token expires, its subscriptions stop and it gets `unauthorized` until it sends `hello` with a fresh
token; an event stream ends with an `error` event. `GET /v1/requests/:id` asks the runtime whether the
request has settled and, if so, waits for its `settled` event before answering.

**Audit log.** One JSON line per command on stderr, `{ "audit": { at, principal, action, agent?,
requestId?, outcome } }`, with no message bodies or tokens.

**Slow clients.** A WebSocket or event stream that stops reading is closed once it has 8 MiB unsent
(`clientBufferBytes`); nobody else waits for it, and the runtime's output is always read.

## Using the TypeScript package

```ts
import {
  LineDecoder,
  encode,
  handshake,
  invalidMessage,
  replyId,
  validateMessage,
} from "@officehum/protocol";

const decoder = new LineDecoder();
for (const frame of decoder.push(chunk)) {
  if (!frame.ok) {
    send(encode({ type: "error", code: frame.code, message: frame.message }));
    continue;
  }
  const checked = validateMessage(frame.value, "client");
  if (!checked.ok) {
    // replyId gives the message's id only when it is a valid one, so the error always validates.
    send(encode(invalidMessage(checked.problems, replyId(frame.value))));
    continue;
  }
  // checked.message is a typed ClientMessage
}
```

`validateMessage(json, from)` takes who sent the message: `"client"`, `"gateway"` (a command forwarded
to the runtime, which must carry `principal`), or `"server"` (`welcome`, replies and events).
