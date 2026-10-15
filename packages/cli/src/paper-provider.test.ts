import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAPER_MODEL_REF, paperProvider } from "./paper-provider.js";

const encoder = new TextEncoder();

function sseResponse(chunks: string[], status = 200, contentType = "text/event-stream") {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status, headers: { "content-type": contentType } },
  );
}

function event(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

const usage = {
  prompt_tokens: 10,
  prompt_tokens_details: { cached_tokens: 3 },
  completion_tokens: 5,
  completion_tokens_details: { reasoning_tokens: 2 },
};

function completedToolCall() {
  return sseResponse([
    event({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "ultramarine-1-flash",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "check_schedule", arguments: '{"date":"2030-01-15"}' } }] }, finish_reason: null }],
    }),
    event({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    event({ choices: [], usage }),
    "data: [DO",
    "NE]\n\n",
  ]);
}

async function streamResult(
  models: ReturnType<typeof createModels>,
  fetch: typeof globalThis.fetch,
  reasoning: "low" | "high" | "max" = "max",
) {
  const model = models.getModel("paper", PAPER_MODEL_REF.modelId)!;
  const events: string[] = [];
  const stream = models.streamSimple(
    model,
    {
      systemPrompt: "Follow instructions.",
      messages: [{ role: "user", content: "Check my schedule." }],
      tools: [{
        name: "check_schedule",
        description: "Check a schedule for one date.",
        parameters: Type.Object({ date: Type.String() }),
      }],
    },
    { reasoning, apiKey: "test-only-placeholder", fetch },
  );
  for await (const item of stream) events.push(item.type);
  return { answer: await stream.result(), events };
}

describe("Paper Instruments Ultramarine provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the supported chat contract and normalizes tool usage and cost", async () => {
    const models = createModels();
    models.setProvider(paperProvider());
    let requestUrl: URL | undefined;
    let requestHeaders: Headers | undefined;
    let requestBody: Record<string, any> | undefined;
    const fakeFetch: typeof fetch = async (input, init) => {
      requestUrl = new URL(String(input));
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body));
      return completedToolCall();
    };
    const model = models.getModel("paper", "ultramarine-1-flash");
    expect(model).toMatchObject({
      api: "openai-completions", provider: "paper",
      baseUrl: "https://api.paperinstruments.com/v1",
      reasoning: true, input: ["text"], maxTokens: 32_768,
      cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0.15 },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
    });
    expect(model?.thinkingLevelMap).toEqual({
      off: null, minimal: null, low: "low", medium: null,
      high: "high", xhigh: null, max: "max",
    });
    expect(getSupportedThinkingLevels(model!)).toEqual(["low", "high", "max"]);

    const { answer } = await streamResult(models, fakeFetch);

    expect(requestUrl?.pathname).toBe("/v1/chat/completions");
    expect(requestHeaders?.has("authorization")).toBe(true);
    expect(requestBody.messages[0].role).toBe("system");
    expect(requestBody.messages.some((message: { role: string }) => message.role === "developer")).toBe(false);
    expect(requestBody.reasoning_effort).toBe("max");
    expect(requestBody.stream_options).toEqual({ include_usage: true });
    expect(requestBody.max_completion_tokens).toBe(32_768);
    expect(requestBody).not.toHaveProperty("max_tokens");
    expect(requestBody).not.toHaveProperty("store");
    expect(requestBody.tools[0]).toMatchObject({
      type: "function",
      function: {
        name: "check_schedule",
        description: "Check a schedule for one date.",
        parameters: { type: "object", properties: { date: { type: "string" } } },
      },
    });
    expect(answer.stopReason).toBe("toolUse");
    expect(answer.content).toContainEqual(expect.objectContaining({
      type: "toolCall", name: "check_schedule", arguments: { date: "2030-01-15" },
    }));
    expect(answer.usage).toMatchObject({ input: 7, cacheRead: 3, output: 5, reasoning: 2, totalTokens: 15 });
    expect(answer.usage.cost.input).toBeCloseTo(0.00000105, 14);
    expect(answer.usage.cost.output).toBeCloseTo(0.0000025, 14);
    expect(answer.usage.cost.cacheRead).toBeCloseTo(0.00000009, 14);
    expect(answer.usage.cost.cacheWrite).toBe(0);
    expect(answer.usage.cost.total).toBeCloseTo(0.00000364, 14);
  });

  it.each([
    ["low", "low"],
    ["high", "high"],
  ] as const)("sends %s reasoning effort", async (level, expected) => {
    const models = createModels();
    models.setProvider(paperProvider());
    let body: Record<string, any> | undefined;
    const fakeFetch: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return sseResponse([event({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] }), event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), event({ choices: [], usage }), "data: [DONE]\n\n"]);
    };
    await streamResult(models, fakeFetch, level);
    expect(body?.reasoning_effort).toBe(expected);
  });

  it("fails a finished response whose SSE stream omits the complete DONE sentinel", async () => {
    const models = createModels();
    models.setProvider(paperProvider());
    const fakeFetch: typeof fetch = async () => sseResponse([
      event({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] }),
      event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    ]);
    const { answer, events } = await streamResult(models, fakeFetch);
    expect(answer.stopReason).toBe("error");
    expect(events).not.toContain("done");
  });

  it("keeps partial tool JSON non-executable when the provider ends at the token limit", async () => {
    const models = createModels();
    models.setProvider(paperProvider());
    const fakeFetch: typeof fetch = async () => sseResponse([
      event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "check_schedule", arguments: '{"date":"2030-' } }] }, finish_reason: null }] }),
      event({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
      "data: [DONE]\n\n",
    ]);
    const { answer } = await streamResult(models, fakeFetch);
    expect(answer.stopReason).toBe("length");
  });

  it("preserves a non-SSE provider error response", async () => {
    const models = createModels();
    models.setProvider(paperProvider());
    const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ error: { message: "provider unavailable" } }), {
      status: 503, headers: { "content-type": "application/json" },
    });
    const { answer, events } = await streamResult(models, fakeFetch);
    expect(answer.stopReason).toBe("error");
    expect(answer.errorMessage).toContain("provider unavailable");
    expect(events).not.toContain("done");
  });

  it("aborts an active SSE response without reporting a completed answer", async () => {
    const models = createModels();
    models.setProvider(paperProvider());
    const controller = new AbortController();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fakeFetch: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      async start(streamController) {
        streamController.enqueue(encoder.encode(event({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })));
        await pending;
        streamController.close();
      },
      cancel() { release(); },
    }), { headers: { "content-type": "text/event-stream" } });
    const model = models.getModel("paper", PAPER_MODEL_REF.modelId)!;
    const stream = models.streamSimple(model, { messages: [{ role: "user", content: "Check" }] }, {
      apiKey: "test-only-placeholder", fetch: fakeFetch, signal: controller.signal,
    });
    const events: string[] = [];
    const reading = (async () => { for await (const item of stream) events.push(item.type); })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    release();
    await reading;
    const answer = await stream.result();
    expect(answer.stopReason).toBe("aborted");
    expect(events).not.toContain("done");
  });

  it("executes complete provider tool calls through the actual Harness", async () => {
    const models = createModels();
    models.setProvider(paperProvider());
    const toolCalls = { count: 0 };
    const tool = defineTool({
      name: "check_schedule",
      description: "Check a schedule for one date.",
      parameters: Type.Object({ date: Type.String() }),
      replay: "safe",
      execute: async ({ date }) => {
        toolCalls.count += 1;
        return { content: [{ type: "text", text: `Schedule checked for ${date}.` }] };
      },
    });
    const extension = defineExtension({ name: "paper-test", tools: [tool] });
    const registry = createRegistry();
    registry.install(extension);
    const storage = new MemoryStorage();
    const previousKey = process.env.PAPERINSTRUMENTS_API_KEY;
    process.env.PAPERINSTRUMENTS_API_KEY = "test-only-placeholder";
    let response = 0;
    vi.stubGlobal("fetch", async () => response++ === 0
      ? completedToolCall()
      : sseResponse([event({ choices: [{ index: 0, delta: { content: "Your schedule is clear." }, finish_reason: null }] }), event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), event({ choices: [], usage }), "data: [DONE]\n\n"]));
    try {
      const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
      try {
        const root = await harness.root(BACKGROUND_CONTEXT, {
          agent: { model: PAPER_MODEL_REF, thinkingLevel: "max", extensions: [extension] },
        });
        const submission = await root.submit({ type: "input", content: "Check my schedule for 2030-01-15." }, BACKGROUND_CONTEXT);
        const settled = await submission.wait(BACKGROUND_CONTEXT);
        expect(settled.status).toBe("done");
        expect(toolCalls.count).toBe(1);
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
      }
    } finally {
      if (previousKey === undefined) delete process.env.PAPERINSTRUMENTS_API_KEY;
      else process.env.PAPERINSTRUMENTS_API_KEY = previousKey;
      await storage.close(BACKGROUND_CONTEXT);
    }
  });

  it("does not execute a partial tool call from a length-limited Harness response", async () => {
    const models = createModels();
    models.setProvider(paperProvider());
    const toolCalls = { count: 0 };
    const tool = defineTool({
      name: "check_schedule", description: "Check a schedule for one date.",
      parameters: Type.Object({ date: Type.String() }), replay: "safe",
      execute: async () => { toolCalls.count += 1; return { content: [{ type: "text", text: "checked" }] }; },
    });
    const extension = defineExtension({ name: "paper-length-test", tools: [tool] });
    const registry = createRegistry();
    registry.install(extension);
    const storage = new MemoryStorage();
    const previousKey = process.env.PAPERINSTRUMENTS_API_KEY;
    process.env.PAPERINSTRUMENTS_API_KEY = "test-only-placeholder";
    let response = 0;
    vi.stubGlobal("fetch", async () => response++ === 0
      ? sseResponse([
          event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-partial", type: "function", function: { name: "check_schedule", arguments: '{"date":"2030-' } }] }, finish_reason: null }] }),
          event({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
          "data: [DONE]\n\n",
        ])
      : sseResponse([event({ choices: [{ index: 0, delta: { content: "I could not finish the schedule check." }, finish_reason: null }] }), event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), event({ choices: [], usage }), "data: [DONE]\n\n"]));
    try {
      const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
      try {
        const root = await harness.root(BACKGROUND_CONTEXT, {
          agent: { model: PAPER_MODEL_REF, thinkingLevel: "max", extensions: [extension] },
        });
        const submission = await root.submit({ type: "input", content: "Check my schedule." }, BACKGROUND_CONTEXT);
        expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
        expect(toolCalls.count).toBe(0);
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
      }
    } finally {
      if (previousKey === undefined) delete process.env.PAPERINSTRUMENTS_API_KEY;
      else process.env.PAPERINSTRUMENTS_API_KEY = previousKey;
      await storage.close(BACKGROUND_CONTEXT);
    }
  });

  it("aborts a partial tool response without execution and resumes after Harness recovery", async () => {
    const models = createModels();
    models.setProvider(paperProvider());
    const toolCalls = { count: 0 };
    const tool = defineTool({
      name: "check_schedule", description: "Check a schedule for one date.",
      parameters: Type.Object({ date: Type.String() }), replay: "safe",
      execute: async () => { toolCalls.count += 1; return { content: [{ type: "text", text: "checked" }] }; },
    });
    const extension = defineExtension({ name: "paper-recovery-test", tools: [tool] });
    const registry = createRegistry();
    registry.install(extension);
    const memoryStorage = new MemoryStorage();
    const storage = new Proxy(memoryStorage, {
      get(target, property, receiver) {
        if (property === "close") return async () => {};
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const previousKey = process.env.PAPERINSTRUMENTS_API_KEY;
    process.env.PAPERINSTRUMENTS_API_KEY = "test-only-placeholder";
    let releasePartial!: () => void;
    let reachedPartial!: () => void;
    const partialReached = new Promise<void>((resolve) => { reachedPartial = resolve; });
    const stopPartial = new Promise<void>((resolve) => { releasePartial = resolve; });
    let calls = 0;
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        requestSignal = init?.signal ?? undefined;
        requestSignal?.addEventListener("abort", releasePartial, { once: true });
        return new Response(new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-recover", type: "function", function: { name: "check_schedule", arguments: '{"date":"2030-' } }] }, finish_reason: null }]})));
            reachedPartial();
            await stopPartial;
            controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      if (calls === 2) return completedToolCall();
      return sseResponse([event({ choices: [{ index: 0, delta: { content: "The schedule is clear." }, finish_reason: null }] }), event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), event({ choices: [], usage }), "data: [DONE]\n\n"]);
    });
    let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
    try {
      harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: PAPER_MODEL_REF, thinkingLevel: "max", extensions: [extension] },
      });
      const submission = await root.submit({ type: "input", content: "Check my schedule for 2030-01-15." }, BACKGROUND_CONTEXT);
      await partialReached;
      expect(toolCalls.count).toBe(0);
      await root.abort(BACKGROUND_CONTEXT);
      expect(requestSignal?.aborted).toBe(true);
      expect(await submission.wait(BACKGROUND_CONTEXT)).toMatchObject({ status: "unanswered", reason: "aborted" });
      expect(toolCalls.count).toBe(0);
      await harness.close(BACKGROUND_CONTEXT);
      harness = undefined;

      harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
      harness.resume();
      const recovered = await harness.root(BACKGROUND_CONTEXT);
      const agent = await recovered.agent(BACKGROUND_CONTEXT);
      expect(agent.model).toEqual({ provider: "paper", modelId: "ultramarine-1-flash" });
      expect(agent.thinkingLevel).toBe("max");
      const recoveredSubmission = await recovered.submit({ type: "input", content: "Check my schedule for 2030-01-15." }, BACKGROUND_CONTEXT);
      expect((await recoveredSubmission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      expect(toolCalls.count).toBe(1);
    } finally {
      releasePartial();
      await harness?.close(BACKGROUND_CONTEXT);
      if (previousKey === undefined) delete process.env.PAPERINSTRUMENTS_API_KEY;
      else process.env.PAPERINSTRUMENTS_API_KEY = previousKey;
      await memoryStorage.close(BACKGROUND_CONTEXT);
    }
  });
});
