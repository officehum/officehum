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
- The stream is guarded: a finished SSE response that ends without `data: [DONE]` is an error, so a
  truncated answer never reaches the model as a completed one.

## Dependencies

`@earendil-works/pi-ai` `1.3.x` is a peer dependency. This package depends on no Office Hum package,
which is what lets it, and any role that names its model, run outside Office Hum.