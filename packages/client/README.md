# @officehum/client

A small TypeScript client for an Office Hum gateway, for web UIs, ERP integrations, schedulers, the
CLI and remote offices. It works in Node 22 and in modern browsers: it uses the platform's own
`WebSocket`, `fetch` and Web Crypto and has one dependency, `@officehum/protocol`.

```ts
import { GatewayClient, makeRequestId } from "@officehum/client";

const client = await GatewayClient.connect({ url, token: () => getToken() });
const run = await client.submit({
  agent: "frontdesk",
  requestId: "acme:frontdesk:2026-10-08:3f9a",
  input: { kind: "message", text: "…" },
});
for await (const event of run.events()) { /* text_delta, tool_start, approval_requested, settled */ }
const settled = await run.settled();
await client.approve({ approvalId, decision: "approve" });
```

## Request ids

Every `submit` needs a `requestId`. The gateway runs a request id once per signed-in caller: the same
id again returns the stored request (`run.disposition === "existing"`) and its result, with no new
model calls or tool runs. Build ids from what the work is, so a retry from anywhere names the same
request:

```ts
const requestId = await makeRequestId("acme", "frontdesk", new Date(), JSON.stringify(ticket));
// "acme:frontdesk:2026-10-08:<first 16 hex digits of the SHA-256 of the content>"
```

## Connections and retries

- **Sign-in.** `token` is a string or a function. A function is asked again on every reconnect, so a
  short-lived token is refreshed. Over WebSocket the token goes in `hello`, which works in browsers.
- **Reconnecting.** When the socket drops, the client reconnects with backoff (250 ms doubling to
  10 s, configurable with `backoff`) and subscribes each unfinished run again after the last `seq` it
  saw. A run's events never repeat and never skip: `run.events()` dedupes by `seq`.
- **What it re-sends.** Only a `submit` or `subscribe`, with the same `requestId`: one that was waiting
  for its reply when the connection dropped, or one the gateway answered `busy` (its runtime was
  restarting), up to `retries` times (default 8). Any other command that was waiting fails with
  `busy`, and you decide whether to send it again.
- **Results.** `run.settled()` resolves with the `settled` event for done, failed and aborted runs
  alike; check `status`. It rejects only if the run cannot be followed (the client closed, or the
  gateway no longer knows the request).

## Errors

A refused command rejects with a `GatewayError` whose `code` is the protocol's error code
(`forbidden`, `not_found`, `unauthorized`, `busy`, …) and whose `problems` explain an
`invalid_message`:

```ts
try {
  await client.submit({ agent: "bookkeeper", requestId, input });
} catch (error) {
  if (isGatewayError(error, "forbidden")) showNotAllowed();
  else throw error;
}
```

## HTTP fallback

Where a WebSocket cannot go, `GatewayClient.connect({ url, token, transport: "http" })` submits with
`POST /v1/submit` and streams each run over Server-Sent Events, resuming with `Last-Event-ID`. The
gateway's HTTP API has no routes for `approve`, `abort`, `list_agents` or `get_state`; over HTTP those
throw and need the WebSocket transport.

## Other commands

`client.subscribe(requestId)` follows a request submitted earlier, `client.abort(requestId)` stops
one, `client.listAgents()` and `client.getState(agent?)` describe the office, `client.ping()` checks the
connection, and `client.close()` ends it.

The protocol itself is specified in [`docs/design/gateway-protocol.md`](../../docs/design/gateway-protocol.md).
