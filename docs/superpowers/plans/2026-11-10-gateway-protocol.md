# Gateway Protocol v1 package (RASF-3103)

**Goal:** `@officehum/protocol` defines the Office Hum Gateway Protocol v1 as code: a JSONL framing
codec, TypeBox message schemas with a validator that reports every problem with a path, the version
handshake, and a prose spec in `docs/design/gateway-protocol.md`. No transport code.

**Spec:** Linear RASF-3103, under epic RASF-3101 (one gateway, one runtime process per office, our own
JSONL protocol).

## Files

| File | Responsibility |
| --- | --- |
| `packages/protocol/package.json`, `tsconfig.json` | New workspace package, MIT, depends only on `typebox` (the SDK's pinned version). |
| `packages/protocol/src/framing.ts` | `encode(message)`, `LineDecoder` (splits only on LF, buffers partial lines and split UTF-8 across chunks, refuses a line over 8 MiB with `frame_too_large`, unparseable JSON is `bad_frame`). |
| `packages/protocol/src/messages.ts` | Schemas and types for every message, `ERROR_CODES`, `validateMessage(json, from)`, `invalidMessage(...)`, `handshake(hello, serverId)`. |
| `packages/protocol/src/index.ts` | Exports. |
| `docs/design/gateway-protocol.md` | The protocol in prose, every message with an example. |
| Root `package.json` | Add the package to `build` and `typecheck`. |

## Decisions

- `validateMessage(json, from)` takes who sent the message: `"client"` (commands; `principal` is
  refused), `"gateway"` (the same commands forwarded to the runtime; `principal` is required), or
  `"server"` (welcome, replies, events). The issue writes `validateMessage(json)`; the origin is what
  lets one validator refuse a client-sent `principal` and require it on forwarded commands.
- Schemas are dispatched on `type` (and on `kind` for submit input and events) before TypeBox checks
  the chosen shape, so a problem is reported against the one shape the sender meant, not every
  branch of a union.
- A `hello` with any positive integer `version` is a valid message; `handshake` answers `welcome` for
  1 and `error unsupported_version` otherwise, so a newer client learns the version is wrong rather
  than that its message is malformed.
- `error` carries an optional `problems: [{ path, message }]`, which is how `invalid_message` lists
  the problems.
- Command-specific result bodies (`get_state`, `list_agents`) are `result.data`, left open here; the
  runtime issue (RASF-3104) defines them.

## Tests (written first)

- Framing: one message per line; U+2028, U+2029 and `\r` in a string survive a round trip unsplit; a
  line split across 3 chunks (including mid UTF-8 character) reassembles; an oversize line yields
  `frame_too_large` and the decoder recovers at the next line; bad JSON is `bad_frame`.
- Messages: each message type validates; an unknown type, a missing `id`, a client-sent `principal`,
  and a forwarded command without one are refused with path-and-message problems; a server message
  sent by a client is refused.
- Handshake accepts version 1 and refuses 2 with `unsupported_version`.
