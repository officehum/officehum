/**
 * The context patterns on a bare Pi Durable harness, with the Sample Stockroom and a scripted model:
 * a 40-round session against the role's prompt budget, `context_recall`, a kill inside a request
 * followed by a restart, compaction that keeps ids, and a role without a context plan sending exactly
 * what it sent before. Nothing touches the network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  CompactionEntry,
  type Conversation,
  createRegistry,
  Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import stockroomManifest from "../../fixtures/sample-stockroom/officehum.json" with {
  type: "json",
};
import { packageDir } from "../../fixtures/sample-stockroom/src/index.js";
import { type Engine, stubEngine } from "../engine.js";
import type { DefinedRole } from "../role.js";
import { defineRole } from "../role.js";
import { KEPT_HEADING, SUMMARY_INSTRUCTIONS } from "./compaction.js";
import { messageText, tokensOf } from "./ids.js";

const context = BACKGROUND_CONTEXT;
const BUDGET = stockroomManifest.contextPlan.promptBudgetTokens;
const ROUNDS = 40;
/** Rounds whose answer cites one of the round's finding ids. */
const CITED = new Set([5]);
const FINDINGS = 12;
/** The stockroom's history filter for these tests: two recent rounds, cited ids kept. */
const HISTORY_FILTER = { keepRecentRounds: 2, keepCitedIds: true, maxToolResultTokens: 200 };

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A count's finding id: unique per round, so citing one keeps exactly that round's result. */
const findingId = (round: number, sku: number) =>
  `count-R${round}:SKU-${String(sku).padStart(2, "0")}`;

/** An engine whose `levels` answers a large, round-specific count: `--sku R<round>`. */
function countingEngine(): Engine {
  return stubEngine({
    levels: (args) => {
      const round = Number(String(args[args.indexOf("--sku") + 1]).slice(1));
      return {
        findings: Array.from({ length: FINDINGS }, (_, index) => ({
          id: findingId(round, index + 1),
          description: `SKU-${index + 1} on hand in the count of round ${round}`,
          quantity: 100 + index + 1,
        })),
      };
    },
  });
}

/** The request's size as the SDK counts it: every message's text, characters ÷ 4. */
function requestTokens(messages: readonly Message[]): number {
  const text = messages
    .map((message) =>
      message.role === "system"
        ? [
            typeof message.content === "string" ? message.content : "",
            ...Object.values(message.sections ?? {}),
            JSON.stringify(message.toolsAdded ?? []),
          ].join("\n")
        : message.role === "assistant"
          ? message.content
              .map((block) =>
                block.type === "toolCall" ? `${block.name}:${JSON.stringify(block.arguments)}` : "",
              )
              .join("\n") + messageText(message)
          : messageText(message),
    )
    .join("\n\n");
  return tokensOf(text);
}
/** A request as the model received it, without the times and durations that differ between runs. */
/** A request as the model received it, with timestamps removed so two runs compare equal. */
function comparable(messages: readonly Message[]): unknown {
  return JSON.parse(
    JSON.stringify(messages, (key, value) =>
      key === "timestamp" || key === "usage" || key === "responseId" || key === "durationMs"
        ? undefined
        : typeof value === "string"
          ? value.replace(/result from \S+ omitted/g, "result from <time> omitted")
          : value,
    ),
  );
}

interface Recorder {
  readonly requests: Message[][];
  readonly summaries: Message[][];
  /** Set to a request number (1-based) to hold that request until the harness aborts it. */
  holdAt?: number;
  held?: () => void;
}

/** The scripted model of every test here. Deterministic: tool call ids name their round. */
function script(messages: readonly Message[], summaryText: string): AssistantMessage {
  const [first] = messages;
  if (first?.role === "system" && String(first.content).includes(SUMMARY_INSTRUCTIONS)) {
    return fauxAssistantMessage(summaryText);
  }
  const last = messages.at(-1);
  if (last?.role === "user") {
    const text = messageText(last);
    if (text.startsWith("Recall")) {
      return fauxAssistantMessage(
        [fauxToolCall("context_recall", { id: "call-1" }, { id: "call-recall" })],
        { stopReason: "toolUse" },
      );
    }
    const round = Number(/Round (\d+)/.exec(text)?.[1]);
    return fauxAssistantMessage(
      [fauxToolCall("stock_levels", { sku: `R${round}` }, { id: `call-${round}` })],
      { stopReason: "toolUse" },
    );
  }
  if (last?.role === "toolResult") {
    if (last.toolName === "context_recall")
      return fauxAssistantMessage("Here is that count again.");
    const round = Number(last.toolCallId.slice("call-".length));
    return fauxAssistantMessage(
      CITED.has(round)
        ? `SKU-03 has 103 units in this count (${findingId(round, 3)}).`
        : "Counted; nothing needs attention.",
    );
  }
  return fauxAssistantMessage("I am not sure what to do.");
}

function scriptedModels(recorder: Recorder, summaryText = "We counted stock.") {
  const faux = fauxProvider({
    provider: "scripted",
    api: "scripted",
    models: [{ id: "scripted-1", contextWindow: 1_000_000 }],
  });
  const respond: FauxResponseFactory = async (request, options, _state, model) => {
    faux.appendResponses([respond]);
    const messages = structuredClone(request.messages) as Message[];
    const first = messages[0];
    const isSummary =
      first?.role === "system" && String(first.content).includes(SUMMARY_INSTRUCTIONS);
    if (isSummary) recorder.summaries.push(messages);
    else {
      recorder.requests.push(messages);
      if (recorder.holdAt === recorder.requests.length) {
        recorder.held?.();
        await new Promise<never>((_, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
    }
    return { ...script(messages, summaryText), provider: model.provider, model: model.id };
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

/** The stockroom with its context plan, or with the patterns off (no history filter). */
/**
 * The Sample Stockroom's package and manifest, with a history filter added for "on" (and the
 * `context_recall` declaration it requires), as shipped for "off" (its plan masks amounts but filters
 * nothing), and with no context plan at all for "no-plan".
 */
function stockroom(patterns: "on" | "off" | "no-plan", engine: Engine): DefinedRole {
  const { contextPlan, ...rest } = structuredClone(stockroomManifest);
  const manifest =
    patterns === "on"
      ? {
          ...rest,
          tools: [...rest.tools, { name: "context_recall", replay: "safe" }],
          contextPlan: { ...contextPlan, historyFilter: HISTORY_FILTER },
        }
      : patterns === "off"
        ? { ...rest, contextPlan }
        : rest;
  return defineRole({ packageDir, manifest, engine });
}

interface Session {
  readonly harness: Harness;
  readonly root: Conversation;
}

/** Keeps only the last round or so verbatim, so a manual compaction has a range to summarize. */
const COMPACT_EARLY = { compaction: { keepRecentTokens: 600 } };

async function open(
  storage: Storage,
  role: DefinedRole,
  recorder: Recorder,
  settings?: typeof COMPACT_EARLY,
): Promise<Session> {
  const registry = createRegistry();
  for (const extension of role.extensions) registry.install(extension);
  const harness = await Harness.open(
    storage,
    { models: scriptedModels(recorder), registry, ...(settings === undefined ? {} : { settings }) },
    context,
  );
  const root = await harness.root(context, {
    agent: { ...role.agent, model: { provider: "scripted", modelId: "scripted-1" } },
  });
  harness.resume();
  return { harness, root };
}

async function say(session: Session, text: string): Promise<void> {
  const submission = await session.root.submit({ type: "input", content: text }, context);
  const settled = await submission.wait(context);
  expect(settled.status).toBe("done");
}

/** Runs rounds `from`..`to` of the session. */
async function rounds(session: Session, from: number, to: number): Promise<void> {
  for (let round = from; round <= to; round++) {
    await say(session, `Round ${round}: how many units are on hand at R${round}?`);
  }
}

function newRecorder(): Recorder {
  return { requests: [], summaries: [] };
}

function toolResult(messages: readonly Message[], callId: string) {
  const found = messages.find(
    (message) => message.role === "toolResult" && message.toolCallId === callId,
  );
  if (found?.role !== "toolResult") throw new Error(`no result for ${callId}`);
  return found;
}

describe("a long Sample Stockroom session", () => {
  it("stays within the prompt budget with the patterns on, and exceeds it with them off", async () => {
    const sizes: Record<string, number[]> = {};
    for (const patterns of ["on", "off"] as const) {
      const recorder = newRecorder();
      const session = await open(
        new MemoryStorage(),
        stockroom(patterns, countingEngine()),
        recorder,
      );
      try {
        await rounds(session, 1, ROUNDS);
      } finally {
        await session.harness.close(context);
      }
      expect(recorder.requests).toHaveLength(ROUNDS * 2);
      sizes[patterns] = recorder.requests.map(requestTokens);
    }
    const on = Math.max(...(sizes.on ?? []));
    const off = Math.max(...(sizes.off ?? []));
    console.info(`40 rounds, budget ${BUDGET}: largest request ${on} tokens on, ${off} off`);
    expect(on).toBeLessThanOrEqual(BUDGET);
    expect(off).toBeGreaterThan(BUDGET);
  });

  it("keeps a result whose finding id is cited later, stubs the rest, and recalls a stub verbatim", async () => {
    const recorder = newRecorder();
    const session = await open(new MemoryStorage(), stockroom("on", countingEngine()), recorder);
    try {
      await rounds(session, 1, ROUNDS);
      await say(session, "Recall the first count in full.");
    } finally {
      await session.harness.close(context);
    }
    const last = recorder.requests.at(-1) ?? [];
    const firstSeen = toolResult(recorder.requests[1] ?? [], "call-1");

    // Round 1 is old and never cited: a stub that keeps its ids and names the call to recall it.
    const stub = messageText(toolResult(last, "call-1"));
    expect(stub).toMatch(
      /^\[context: stock_levels result from \d{4}-\d\d-\d\dT[\d:.]+Z omitted \(ids: count-R1:SKU-01, count-R1:SKU-02, count-R1:SKU-03, count-R1:SKU-04, count-R1:SKU-05 and 7 more\)\. Call context_recall\("call-1"\) to see it again\.\]$/,
    );
    // Round 5's answer cited one of its findings, so it stays whole.
    expect(messageText(toolResult(last, "call-5"))).toContain(findingId(5, 12));
    // The recall returns exactly what round 1's tool returned.
    expect(toolResult(last, "call-recall").content).toEqual(firstSeen.content);
    expect(messageText(firstSeen)).toContain(findingId(1, 12));
    expect(Math.max(...recorder.requests.map(requestTokens))).toBeLessThanOrEqual(BUDGET);
  });
});

describe("a kill inside a request, then a restart", () => {
  it("makes the same filter decisions, so the model sees identical requests", async () => {
    // The reference: an uninterrupted run.
    const reference = newRecorder();
    const plain = await open(new MemoryStorage(), stockroom("on", countingEngine()), reference);
    try {
      await rounds(plain, 1, 8);
    } finally {
      await plain.harness.close(context);
    }

    // The same run on SQLite, killed while the model holds request 13 (round 7's first request,
    // where results 1-4 are stubbed and result 5 is kept), then reopened.
    const directory = mkdtempSync(join(tmpdir(), "officehum-context-"));
    temps.push(directory);
    const path = join(directory, "harness.sqlite");
    const before = newRecorder();
    before.holdAt = 13;
    const first = await open(
      await openNodeSqliteStorage(path),
      stockroom("on", countingEngine()),
      before,
    );
    const held = new Promise<void>((resolve) => {
      before.held = resolve;
    });
    await rounds(first, 1, 6);
    const pending = first.root.submit(
      { type: "input", content: "Round 7: how many units are on hand at R7?" },
      context,
    );
    await held;
    await first.harness.close(context);
    await pending.catch(() => undefined);

    const after = newRecorder();
    const second = await open(
      await openNodeSqliteStorage(path),
      stockroom("on", countingEngine()),
      after,
    );
    try {
      await second.root.waitForIdle(context);
      await rounds(second, 8, 8);
    } finally {
      await second.harness.close(context);
    }

    // The resent request is the one the model was holding, byte for byte, and the whole run matches
    // the uninterrupted one.
    expect(after.requests[0]).toEqual(before.requests[12]);
    const resumed = [...before.requests.slice(0, 12), ...after.requests];
    expect(resumed.map(comparable)).toEqual(reference.requests.map(comparable));
    expect(messageText(toolResult(after.requests[0] ?? [], "call-1"))).toMatch(/^\[context: /);
    expect(messageText(toolResult(after.requests[0] ?? [], "call-5"))).toContain(findingId(5, 12));
  });
});

describe("compaction during a session", () => {
  it("keeps every id of the compacted range, appending those the summary dropped", async () => {
    const recorder = newRecorder();
    const session = await open(
      new MemoryStorage(),
      stockroom("on", countingEngine()),
      recorder,
      COMPACT_EARLY,
    );
    try {
      await rounds(session, 1, 6);
      const task = await session.root.compact(undefined, context);
      await session.harness.waitForTask(task, context);
      await rounds(session, 7, 7);
    } finally {
      await session.harness.close(context);
    }
    // The summarizer was asked once, with the instructions to keep ids, and answered without any.
    expect(recorder.summaries).toHaveLength(1);
    const after = recorder.requests.at(-1) ?? [];
    const summary = after.find(
      (message) => message.role === "user" && messageText(message).includes(KEPT_HEADING),
    );
    if (summary === undefined) throw new Error("no compaction summary in the request");
    const text = messageText(summary);
    expect(text).toContain("We counted stock.");
    // Every finding of the summarized rounds survives, with its figure.
    expect(text).toContain(`- ${findingId(1, 1)}: quantity 101`);
    expect(text).toContain(`- ${findingId(1, 12)}: quantity 112`);
  });

  it("is written to the transcript as a compaction entry holding the kept list", async () => {
    const recorder = newRecorder();
    const session = await open(
      new MemoryStorage(),
      stockroom("on", countingEngine()),
      recorder,
      COMPACT_EARLY,
    );
    try {
      await rounds(session, 1, 4);
      const task = await session.root.compact(undefined, context);
      await session.harness.waitForTask(task, context);
      await session.root.waitForIdle(context);
      const page = await session.root.entries({}, 200, undefined, context);
      const compaction = page.items.find((entry) => CompactionEntry.is(entry));
      const summary = compaction?.model?.[0];
      expect(summary === undefined ? "" : messageText(summary)).toContain(KEPT_HEADING);
    } finally {
      await session.harness.close(context);
    }
  });
});

describe("a role without a context plan", () => {
  it("sends the model exactly what it sent before the patterns existed", async () => {
    const engine = countingEngine();
    const role = stockroom("no-plan", engine);
    // No pattern is installed: the role extension carries only the approval gate and read_skill.
    const [extension] = role.extensions;
    expect(extension?.hooks).toHaveLength(1);
    expect(extension?.tools?.map((tool) => tool.name)).toEqual([
      "stock_levels",
      "stock_adjust",
      "read_skill",
    ]);
    const without = newRecorder();
    const session = await open(new MemoryStorage(), role, without);
    try {
      await rounds(session, 1, 6);
    } finally {
      await session.harness.close(context);
    }
    // Every older result reaches the model whole, as it always did.
    const last = without.requests.at(-1) ?? [];
    expect(messageText(toolResult(last, "call-1"))).toContain(findingId(1, 12));
    expect(JSON.stringify(last)).not.toContain("[context:");
  });
});
