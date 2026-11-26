import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { HistoryFilterDeclaration } from "../manifest.js";
import { resultFacts } from "./ids.js";
import { type FilterDecision, filterMessages, stubText } from "./relevance-filter.js";

const PLAN: HistoryFilterDeclaration = {
  keepRecentRounds: 1,
  keepCitedIds: true,
  maxToolResultTokens: 20,
};
const BIG = "x".repeat(200);

function user(text: string): Message {
  return { role: "user", content: text, timestamp: 0 };
}

function call(id: string, text = ""): AssistantMessage {
  return {
    role: "assistant",
    content: [
      ...(text === "" ? [] : [{ type: "text" as const, text }]),
      { type: "toolCall", id, name: "lookup", arguments: {} },
    ],
    api: "scripted",
    provider: "scripted",
    model: "scripted-1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
}

function result(id: string, body: unknown, details?: unknown): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "lookup",
    content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
    ...(details === undefined ? {} : { details: details as never }),
    isError: false,
    timestamp: Date.UTC(2026, 10, 23, 9, 30),
  };
}

const system: Message = { role: "system", content: "You are a stockroom.", timestamp: 0 };

/** Three rounds: an old big result with record ids, an old small one, then the current round. */
function transcript(laterText = ""): Message[] {
  return [
    system,
    user("Count stock."),
    call("c1"),
    result("c1", { records: [{ recordId: "REC-100", note: BIG }] }),
    call("c2"),
    result("c2", "ok"),
    call("c3", laterText),
    result("c3", BIG),
  ];
}

const textOf = (message: Message | undefined) =>
  message?.role === "toolResult" && message.content[0]?.type === "text"
    ? message.content[0].text
    : "";

describe("resultFacts", () => {
  it("reads engine finding ids from details and id fields from JSON, with their figures", () => {
    const facts = resultFacts(
      result(
        "c1",
        {
          findings: [{ id: "stock:BOLT-10", quantity: 120 }],
          ticketId: "T-77",
          lines: [{ file_id: "file-9", amountCents: 500 }],
        },
        { findings: ["stock:BOLT-10", "stock:NUT-10"] },
      ),
    );
    expect(facts.ids).toEqual(["stock:BOLT-10", "stock:NUT-10", "T-77", "file-9"]);
    expect(facts.figures.get("stock:BOLT-10")).toEqual(["quantity 120"]);
  });

  it("finds no ids in free text", () => {
    expect(resultFacts(result("c1", "Booked A1 for Mrs Lee at 10:00.")).ids).toEqual([]);
  });
});

describe("filterMessages", () => {
  it("stubs an older large result, keeping its ids and the call id to recall it", async () => {
    const messages = transcript();
    const projected = await filterMessages(messages, PLAN);
    expect(textOf(projected?.[3])).toBe(
      '[context: lookup result from 2026-11-23T09:30:00.000Z omitted (ids: REC-100). Call context_recall("c1") to see it again.]',
    );
    // The stub keeps everything but the content, so the provider still pairs it with its call.
    expect(projected?.[3]).toMatchObject({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "lookup",
    });
    // Small results, the recent round and the system message are untouched; the input is not edited.
    expect(projected?.[5]).toBe(messages[5]);
    expect(projected?.[7]).toBe(messages[7]);
    expect(projected?.[0]).toBe(messages[0]);
    expect(textOf(messages[3])).toContain(BIG);
  });

  it("keeps an older result whose id a later message or the latest request cites", async () => {
    expect(await filterMessages(transcript("Updating REC-100 now."), PLAN)).toBeUndefined();
    const asked = [...transcript(), user("What did REC-100 say?")];
    expect(await filterMessages(asked, PLAN)).toBeUndefined();
  });

  it("does not count a later tool result repeating an id as a citation", async () => {
    const messages = [...transcript(), call("c4"), result("c4", "REC-100")];
    expect(textOf((await filterMessages(messages, PLAN))?.[3])).toMatch(/^\[context: /);
  });

  it("stubs cited results too when keepCitedIds is false", async () => {
    const projected = await filterMessages(transcript("Updating REC-100 now."), {
      ...PLAN,
      keepCitedIds: false,
    });
    expect(textOf(projected?.[3])).toMatch(/^\[context: /);
  });

  it("keeps the last keepRecentRounds whole, and none with zero", async () => {
    expect(await filterMessages(transcript(), { ...PLAN, keepRecentRounds: 3 })).toBeUndefined();
    const none = await filterMessages(transcript(), { ...PLAN, keepRecentRounds: 0 });
    expect(textOf(none?.[3])).toMatch(/^\[context: /);
    expect(textOf(none?.[7])).toMatch(/^\[context: /);
  });

  it("lists at most five ids in a stub", () => {
    const ids = Array.from({ length: 8 }, (_, index) => `ID-${index}`);
    expect(stubText(result("c9", ""), ids)).toContain(
      "(ids: ID-0, ID-1, ID-2, ID-3, ID-4 and 3 more)",
    );
  });

  it("follows a decision already stored for a call id", async () => {
    const stored = new Map<string, FilterDecision>([["c1", "keep"]]);
    const decide = async (callId: string, candidate: FilterDecision) => {
      const known = stored.get(callId);
      if (known !== undefined) return known;
      stored.set(callId, candidate);
      return candidate;
    };
    expect(await filterMessages(transcript(), PLAN, decide)).toBeUndefined();
    stored.clear();
    expect(textOf((await filterMessages(transcript(), PLAN, decide))?.[3])).toMatch(/^\[context: /);
    expect(stored.get("c1")).toBe("stub");
  });
});
