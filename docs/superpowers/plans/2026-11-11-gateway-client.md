# `@officehum/client` plan (RASF-3107)

**Goal:** a small TypeScript client for the Gateway Protocol that web UIs, integrations, schedulers,
the CLI and remote offices use to connect, submit, stream, re-submit safely and approve.

**Spec:** `docs/design/gateway-protocol.md` (messages, routes, sign-in, event numbering).

## Shape

`packages/client` (MIT), depending only on `@officehum/protocol`. It uses the platform's own
`WebSocket`, `fetch`, `TextDecoder` and Web Crypto, so the same build runs in Node 22 and in modern
browsers. Its `tsconfig.json` compiles with the DOM library and no Node types, so a stray `node:`
import fails the build.

| File | Responsibility |
| --- | --- |
| `errors.ts` | `GatewayError` (typed `code: ErrorCode`, `problems`), `isGatewayError(error, code?)`. |
| `request-id.ts` | `makeRequestId(org, role, date, content)` → `org:role:YYYY-MM-DD:<16 hex of SHA-256>`. |
| `backoff.ts` | The reconnect and retry delay: 250 ms doubling to 10 s, with jitter. |
| `run.ts` | `Run`: one request's events, deduplicated by `seq`; `events()` and `settled()`. |
| `transport.ts` | The `Transport` interface the client drives. |
| `websocket-transport.ts` | One socket; `hello` with the token; reconnects with backoff and re-subscribes each unsettled run with `afterSeq`. |
| `http-transport.ts` | The fallback: `POST /v1/submit`, events over SSE with `Last-Event-ID`. |
| `client.ts` | `GatewayClient`: `connect`, `submit`, `subscribe`, `approve`, `abort`, `listAgents`, `getState`, `ping`, `close`. |

## Rules

- `requestId` is required on `submit`. The client re-sends a command by itself only when it is a
  `submit` (or `subscribe`) with the same `requestId`: after a reconnect, or after `busy`. Any other
  command that loses its connection fails with `busy` and the caller decides.
- A `settled` event is always taken, whatever its `seq` (a restarted gateway numbers from 1 again);
  any other event is taken only if its `seq` is above the last one seen.
- No public type has a `principal`.
- The HTTP transport supports `submit` and following a request; the gateway has no HTTP route for the
  other commands, so they fail with a message naming the WebSocket transport.

## Tests

Against an in-process fake gateway (`src/fixtures/fake-gateway.ts`, `ws` + `node:http`):
submit → events → settled; a drop mid-stream → reconnect → no gap, no duplicate; `forbidden` as a
typed error; `makeRequestId` stability; a submit re-sent after `busy`; a token refreshed on reconnect;
the HTTP transport's submit and SSE resume. One gateway end-to-end test drives the real gateway with
this client.
