/**
 * The relevance filter: each request sees older tool results that no longer matter as one-line stubs,
 * while the transcript in storage stays whole.
 *
 * It runs in Pi Durable's `beforeRequest` hook, whose result is used for that request only, so
 * nothing is edited. The hook sees model messages, not entry records, so a result is named by its
 * tool call id, which `context_recall` takes to bring it back.
 *
 * Rounds are tool rounds: an assistant message that calls tools, with its results. The last
 * `keepRecentRounds` stay whole. An older result stays whole when it is small, or when one of its ids
 * is cited by a later user or assistant message, or by the latest user message (with
 * `keepCitedIds`); otherwise it is stubbed. Each decision is memoised per tool call id, so a request
 * resent after a restart makes the same one.
 */

import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  defineTool,
  GenerationTask,
  type HookRegistration,
  hook,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { CONTEXT_RECALL_TOOL, type HistoryFilterDeclaration } from "../manifest.js";
import { messageText, resultFacts, resultText, tokensOf } from "./ids.js";

/** How many ids a stub lists before it says how many more there are; recall shows the rest. */
const STUB_IDS = 5;

/** What the filter does with an older result. */
export type FilterDecision = "keep" | "stub";

/**
 * Settles a decision for a tool call id: returns the decision already made for it, or records and
 * returns `candidate`. The hook backs it with `HookApi.memo`; tests pass their own.
 */
export type DecisionStore = (callId: string, candidate: FilterDecision) => Promise<FilterDecision>;

/** The stub that stands in for an omitted result. */
export function stubText(message: ToolResultMessage, ids: readonly string[]): string {
  const listed =
    ids.length === 0
      ? "none"
      : ids.length <= STUB_IDS
        ? ids.join(", ")
        : `${ids.slice(0, STUB_IDS).join(", ")} and ${ids.length - STUB_IDS} more`;
  const time = new Date(message.timestamp).toISOString();
  return `[context: ${message.toolName} result from ${time} omitted (ids: ${listed}). Call ${CONTEXT_RECALL_TOOL}("${message.toolCallId}") to see it again.]`;
}

/**
 * The messages one request sees under `plan`, or `undefined` when nothing changes. Deterministic:
 * the same messages and the same stored decisions always give the same projection.
 */
export async function filterMessages(
  messages: readonly Message[],
  plan: HistoryFilterDeclaration,
  decide: DecisionStore = async (_callId, candidate) => candidate,
): Promise<Message[] | undefined> {
  const rounds = messages.flatMap((message, index) =>
    message.role === "assistant" && message.content.some((block) => block.type === "toolCall")
      ? [index]
      : [],
  );
  if (rounds.length <= plan.keepRecentRounds) return undefined;
  // Everything from the first kept round on is recent; with no rounds kept, nothing is.
  const recentFrom =
    plan.keepRecentRounds === 0
      ? messages.length
      : (rounds[rounds.length - plan.keepRecentRounds] ?? messages.length);

  // Citations are what the model or the user wrote; a later tool result repeating an id (a recall,
  // say) is not one.
  const texts = messages.map((message) =>
    message.role === "user" || message.role === "assistant" ? messageText(message) : "",
  );
  const latestUser = messages.findLastIndex((message) => message.role === "user");
  const goal = latestUser === -1 ? "" : (texts[latestUser] ?? "");

  let changed = false;
  const projected = [...messages];
  for (let index = 0; index < recentFrom; index++) {
    const message = messages[index];
    if (message?.role !== "toolResult") continue;
    if (tokensOf(resultText(message)) <= plan.maxToolResultTokens) continue;
    const facts = resultFacts(message);
    const later = texts.slice(index + 1).join("\n");
    const cited =
      plan.keepCitedIds && facts.ids.some((id) => later.includes(id) || goal.includes(id));
    const decision = await decide(message.toolCallId, cited ? "keep" : "stub");
    if (decision === "keep") continue;
    projected[index] = {
      ...message,
      content: [{ type: "text", text: stubText(message, facts.ids) }],
    };
    changed = true;
  }
  return changed ? projected : undefined;
}

/** The relevance filter as a Pi Durable hook for the role's extension. */
export function contextFilter(plan: HistoryFilterDeclaration): HookRegistration {
  return hook(GenerationTask, {
    beforeRequest: async (request, api, context) => {
      const messages = await filterMessages(request.messages, plan, (callId, candidate) =>
        api.memo<FilterDecision>(`context-filter:${callId}`, candidate, context),
      );
      return messages === undefined ? undefined : { messages };
    },
  });
}

/** `context_recall`: an earlier tool result, read back from the transcript. Reads only. */
export function contextRecallTool(): ToolRegistration {
  return defineTool({
    name: CONTEXT_RECALL_TOOL,
    description:
      "Show an earlier tool result again, in full. Use it when a [context: …] note says a result was omitted and you need what it said.",
    parameters: obj(
      {
        id: str({ description: 'The id the note gives, as in context_recall("…")' }),
      },
      { open: true },
    ),
    replay: "safe",
    execute: async (args, api, context) => {
      const found = await api.commit(async (tx) => {
        let cursor: Parameters<typeof tx.scanEntries>[2];
        do {
          const page = await tx.scanEntries({ conversationId: api.conversationId }, 200, cursor);
          for (const entry of page.items) {
            const message = entry.model?.[0];
            if (message?.role === "toolResult" && message.toolCallId === args.id) return message;
          }
          cursor = page.next;
        } while (cursor !== undefined);
        return undefined;
      }, context);
      if (found === undefined) {
        return {
          isError: true,
          output: [
            {
              type: "text",
              text: `There is no earlier tool result with the id "${args.id}". Use the id a [context: …] note gives.`,
            },
          ],
        };
      }
      return { output: found.content };
    },
  }) as unknown as ToolRegistration;
}
