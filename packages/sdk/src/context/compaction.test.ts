import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import {
  idPreservingCompaction,
  KEPT_HEADING,
  rangeFacts,
  SUMMARY_INSTRUCTIONS,
  withKeptIds,
} from "./compaction.js";

function result(id: string, body: unknown): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "stock_levels",
    content: [{ type: "text", text: JSON.stringify(body) }],
    isError: false,
    timestamp: 0,
  };
}

const range: Message[] = [
  { role: "user", content: "How many bolts?", timestamp: 0 },
  result("c1", { findings: [{ id: "stock:BOLT-10", quantity: 120 }], approvalId: "approval-7" }),
];

describe("withKeptIds", () => {
  it("appends every id the summary dropped, with its figures", () => {
    expect(withKeptIds("We counted bolts.", rangeFacts(range))).toBe(
      `We counted bolts.\n\n${KEPT_HEADING}\n- approval-7\n- stock:BOLT-10: quantity 120`,
    );
  });

  it("leaves a summary that keeps every id alone", () => {
    const summary = "stock:BOLT-10 shows 120 bolts; approval-7 is pending.";
    expect(withKeptIds(summary, rangeFacts(range))).toBe(summary);
  });

  it("carries an earlier summary's kept list into the next compaction", () => {
    const earlier: Message = {
      role: "user",
      content: `Earlier work.\n\n${KEPT_HEADING}\n- stock:NUT-10: quantity 80\n- T-12`,
      timestamp: 0,
    };
    expect(withKeptIds("Short.", rangeFacts([earlier, ...range]))).toBe(
      `Short.\n\n${KEPT_HEADING}\n- stock:NUT-10: quantity 80\n- T-12\n- approval-7\n- stock:BOLT-10: quantity 120`,
    );
  });
});

/** The hook's handler with a stand-in HookApi: a scripted model, memos in a map, no agent doc. */
function harnessless(answer: string) {
  const faux = fauxProvider({
    provider: "scripted",
    api: "scripted",
    models: [{ id: "scripted-1" }],
  });
  const asked: Message[][] = [];
  faux.setResponses([
    (request) => {
      asked.push(request.messages as Message[]);
      return fauxAssistantMessage(answer);
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const memos = new Map<string, unknown>();
  const api = {
    taskId: 1,
    conversationId: 1,
    models,
    snapshot: async () => undefined,
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length === 1) return memos.get(name);
      if (!memos.has(name)) memos.set(name, rest[0]);
      return memos.get(name);
    },
  };
  const registration = idPreservingCompaction({
    fallbackModel: () => ({ provider: "scripted", modelId: "scripted-1" }),
  });
  const handlers = registration.handlers as {
    beforeCompact: (compaction: unknown, api: unknown, context: unknown) => Promise<unknown>;
  };
  const compact = (messages: readonly Message[]) =>
    handlers.beforeCompact({ reason: "threshold", entries: [], messages, firstKept: 1 }, api, {});
  return { compact, asked, memos };
}

describe("idPreservingCompaction", () => {
  it("asks the model with the keep-ids instructions and appends the ids it dropped", async () => {
    const { compact, asked } = harnessless("The user asked about bolts.");
    expect(await compact(range)).toEqual({
      summary: `The user asked about bolts.\n\n${KEPT_HEADING}\n- approval-7\n- stock:BOLT-10: quantity 120`,
    });
    expect(asked).toHaveLength(1);
    expect(JSON.stringify(asked[0])).toContain(SUMMARY_INSTRUCTIONS.split("\n")[1]);
  });

  it("reuses the memoised summary instead of asking again, as after a restart", async () => {
    const { compact, asked } = harnessless("The user asked about bolts.");
    const first = await compact(range);
    expect(await compact(range)).toEqual(first);
    expect(asked).toHaveLength(1);
  });

  it("leaves a range without ids to Pi Durable's own summary", async () => {
    const { compact, asked } = harnessless("unused");
    expect(await compact([{ role: "user", content: "Hello", timestamp: 0 }])).toBeUndefined();
    expect(asked).toHaveLength(0);
  });
});
