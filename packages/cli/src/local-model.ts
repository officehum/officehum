/**
 * The `local` provider: a model served on the operator's own machine behind an OpenAI-compatible
 * chat-completions endpoint (llama.cpp's `llama-server`, vLLM, Ollama's `/v1`), so a role
 * can be run and graded with no hosted model key. `--model local/<id>` names the model the server
 * serves; the endpoint comes from the environment, never from a file.
 *
 * Built with pi-ai's own `createProvider` and `openAICompletionsApi`, as `@officehum/provider-paper`
 * is: the model is a pi-ai provider like any other, and a failure at the endpoint reaches the role's
 * conversation as that provider's error. Nothing falls back to another provider.
 */

import { createProvider, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/** The provider name `--model local/<id>` selects. */
export const LOCAL_PROVIDER = "local";

/** The variables the local provider reads. Only the key is a secret, and it is optional. */
export const LOCAL_ENV = {
  baseUrl: "OFFICEHUM_LOCAL_BASE_URL",
  apiKey: "OFFICEHUM_LOCAL_API_KEY",
  contextWindow: "OFFICEHUM_LOCAL_CONTEXT_WINDOW",
} as const;

/** The context window assumed when the operator does not say: enough for a role's first prompt. */
export const DEFAULT_LOCAL_CONTEXT_WINDOW = 32_768;

/**
 * pi-ai's chat-completions client refuses to send a request with no key, and a server started without
 * one ignores whatever it is sent, so a keyless endpoint gets this placeholder.
 */
const PLACEHOLDER_KEY = "local";

/** The local provider serving `modelIds`, configured from `env`. Throws naming the variable to fix. */
export function localProvider(
  modelIds: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Provider<"openai-completions"> {
  const baseUrl = env[LOCAL_ENV.baseUrl]?.trim() ?? "";
  if (baseUrl === "") {
    throw new Error(
      `Set ${LOCAL_ENV.baseUrl} to your server's OpenAI-compatible base URL, e.g. http://localhost:8080/v1, before running against ${LOCAL_PROVIDER}.`,
    );
  }
  if (!/^https?:\/\/[^/\s]+/u.test(baseUrl)) {
    throw new Error(
      `${LOCAL_ENV.baseUrl} must be an http or https URL such as http://localhost:8080/v1 (got ${JSON.stringify(baseUrl)}).`,
    );
  }
  const window = env[LOCAL_ENV.contextWindow]?.trim();
  const contextWindow =
    window === undefined || window === "" ? DEFAULT_LOCAL_CONTEXT_WINDOW : Number(window);
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error(
      `${LOCAL_ENV.contextWindow} must be a whole number of tokens, e.g. 32768 (got ${JSON.stringify(window)}).`,
    );
  }
  const models = [...new Set(modelIds)].map(
    (id): Model<"openai-completions"> => ({
      id,
      name: `${id} (local)`,
      provider: LOCAL_PROVIDER,
      api: "openai-completions",
      baseUrl,
      // Thinking is the server's switch (see docs/local-models.md); pi-ai sends no reasoning field.
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: Math.min(8_192, contextWindow),
      // What llama-server, vLLM and Ollama accept: `system` rather than `developer`, no
      // `reasoning_effort`, no `store`, and the `max_tokens` name every one of them reads.
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStore: false,
        maxTokensField: "max_tokens",
      },
    }),
  );
  return createProvider({
    id: LOCAL_PROVIDER,
    name: "Local OpenAI-compatible server",
    baseUrl,
    auth: {
      apiKey: {
        name: "Local server key",
        resolve: async () => ({
          auth: { apiKey: env[LOCAL_ENV.apiKey]?.trim() || PLACEHOLDER_KEY },
          source: env[LOCAL_ENV.apiKey]?.trim() ? LOCAL_ENV.apiKey : "none needed",
        }),
      },
    },
    models,
    api: openAICompletionsApi(),
  });
}
