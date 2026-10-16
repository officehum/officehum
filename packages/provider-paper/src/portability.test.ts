import { readFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAPER_MODEL_REF, paperProvider } from "./index.js";

const encoder = new TextEncoder();

function event(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** One scripted tool call and a complete DONE sentinel, as a bare pi-ai registry would receive it. */
function scriptedToolCall() {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            event({
              id: "chatcmpl-portability",
              object: "chat.completion.chunk",
              created: 1,
              model: PAPER_MODEL_REF.modelId,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-1",
                        type: "function",
                        function: { name: "check_schedule", arguments: '{"date":"2030-01-15"}' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
          ),
        );
        controller.enqueue(
          encoder.encode(
            event({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("portable Paper provider package", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exports the model reference that role manifests name as their default", () => {
    expect(PAPER_MODEL_REF).toEqual({ provider: "paper", modelId: "ultramarine-1-flash" });
    expect(typeof paperProvider).toBe("function");
  });

  it("depends on pi-ai only, never on an Office Hum platform package", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const runtime = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) });
    expect(runtime.filter((name) => name.startsWith("@officehum/"))).toEqual([]);
    expect(runtime).toEqual(["@earendil-works/pi-ai"]);
  });

  it("registers in a bare registry and streams a scripted tool call through a fake fetch", async () => {
    const models = createModels();
    models.setProvider(paperProvider());
    const model = models.getModel(PAPER_MODEL_REF.provider, PAPER_MODEL_REF.modelId);
    if (model === undefined) throw new Error("The package did not register its model.");

    const requests: URL[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      requests.push(new URL(String(input)));
      return scriptedToolCall();
    };
    const stream = models.streamSimple(
      model,
      {
        systemPrompt: "Follow instructions.",
        messages: [{ role: "user", content: "Check my schedule.", timestamp: 0 }],
        tools: [
          {
            name: "check_schedule",
            description: "Check a schedule for one date.",
            parameters: Type.Object({ date: Type.String() }),
          },
        ],
      },
      { reasoning: "max", apiKey: "unit-test", fetch: fakeFetch },
    );
    const events: string[] = [];
    for await (const item of stream) events.push(item.type);
    const answer = await stream.result();

    expect(requests[0]?.pathname).toBe("/v1/chat/completions");
    expect(answer.stopReason).toBe("toolUse");
    expect(answer.content).toContainEqual(
      expect.objectContaining({
        type: "toolCall",
        name: "check_schedule",
        arguments: { date: "2030-01-15" },
      }),
    );
    expect(events).toContain("done");
  });
});
