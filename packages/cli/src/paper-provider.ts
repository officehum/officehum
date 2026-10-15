import {
  createProvider,
  envApiKeyAuth,
  type Model,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const PAPER_MODEL_REF = {
  provider: "paper",
  modelId: "ultramarine-1-flash",
} as const;

const model: Model<"openai-completions"> = {
  id: PAPER_MODEL_REF.modelId,
  name: "Ultramarine 1 Flash",
  provider: PAPER_MODEL_REF.provider,
  api: "openai-completions",
  baseUrl: "https://api.paperinstruments.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0.15 },
  contextWindow: 131_072,
  maxTokens: 32_768,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: true,
    supportsFinishReason: true,
    supportsStore: false,
    maxTokensField: "max_completion_tokens",
  },
};

function paperChatApi(): ProviderStreams {
  const base = openAICompletionsApi();
  const withGuard = <T extends { fetch?: typeof fetch }>(options: T | undefined): T =>
    ({
      ...options,
      fetch: guardedPaperFetch(options?.fetch ?? globalThis.fetch),
    }) as T;
  return {
    stream: (selectedModel, context, options) =>
      base.stream(selectedModel, context, withGuard(options)),
    streamSimple: (selectedModel, context, options) =>
      base.streamSimple(selectedModel, context, withGuard(options)),
  };
}

function guardedPaperFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (!response.ok || contentType !== "text/event-stream") return response;

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let line = "";
    let sawDone = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } =
            reader === undefined ? { done: true, value: undefined } : await reader.read();
          if (done) {
            line += decoder.decode();
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (line === "data: [DONE]") sawDone = true;
            if (!sawDone) {
              controller.error(new Error("Paper stream ended before data: [DONE]"));
              return;
            }
            controller.close();
            return;
          }

          const text = decoder.decode(value, { stream: true });
          const lines = (line + text).split("\n");
          line = lines.pop() ?? "";
          for (const completeLine of lines) {
            const normalized = completeLine.endsWith("\r")
              ? completeLine.slice(0, -1)
              : completeLine;
            if (normalized === "data: [DONE]") sawDone = true;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader?.cancel(reason);
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

export function paperProvider(): Provider<"openai-completions"> {
  return createProvider({
    id: "paper",
    name: "Paper Instruments",
    baseUrl: "https://api.paperinstruments.com/v1",
    auth: { apiKey: envApiKeyAuth("Paper Instruments API key", ["PAPERINSTRUMENTS_API_KEY"]) },
    models: [model],
    api: paperChatApi(),
  });
}
