# @officehum/provider-paper

Registers Paper Instruments' **Ultramarine 1 Flash** as a `pi-ai` provider, so the model a role
package names as its `defaultModel` (`paper/ultramarine-1-flash`) resolves in a bare Pi Durable
install, with no Office Hum platform package loaded.

## Register it

```ts
import { createModels } from "@earendil-works/pi-ai/models";
import { PAPER_MODEL_REF, paperProvider } from "@officehum/provider-paper";

const models = createModels();
models.setProvider(paperProvider());
```

Then configure the conversation with `PAPER_MODEL_REF` (`{ provider: "paper", modelId:
"ultramarine-1-flash" }`). A role manifest's `defaultModel` names the same pair, plus a
`thinkingLevel`; `max` is the value Front Desk ships with.

## Credentials

Set `PAPERINSTRUMENTS_API_KEY` in the process environment. The provider reads it through pi-ai's
environment auth at the point of use; the package never logs, returns or stores the key, and a
missing key fails the request rather than falling back to another provider.

## Behavior

- Endpoint `https://api.paperinstruments.com/v1`, OpenAI-compatible chat completions, `reasoning`
  on, 131,072-token context, 32,768 output tokens, `max_completion_tokens`, no `developer` role.
- Thinking levels map to `low`, `high` and `max`; the others are unsupported and reported as such.
- Prompt caching: each request carries an `x-session-id` header, Paper's sticky-session hint, set
  to the caller's `sessionId`. Pi Durable passes one random id per conversation, the same on every
  request, retry and resume of it, so the repeated system prompt and tools are likelier to be read
  from Paper's cache ($0.03 rather than $0.15 per million input tokens). Caching stays best effort on
  Paper's side; a caller with no `sessionId` sends no header.
- The stream is guarded: a finished SSE response that ends without `data: [DONE]` is an error, so a
  truncated answer never reaches the model as a completed one.

## Dependencies

`@earendil-works/pi-ai` `1.6.x` is a peer dependency. This package depends on no Office Hum package,
which is what lets it, and any role that names its model, run outside Office Hum.

## Install

Not published to npm yet. In a clone of this repository, `npm ci && npm run build` builds it and
workspaces import it by name. For another project, pack it (`npm pack -w @officehum/provider-paper`)
and install the tarball beside `@earendil-works/pi-ai@1.6.0`, as
[Build a role](../../docs/build-a-role.md#use-a-role-in-your-own-harness) shows for a role.