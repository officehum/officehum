/**
 * Compaction that keeps ids. When Pi Durable compacts a conversation, this `beforeCompact` hook makes
 * the summary itself: it asks the conversation's model for one that keeps every id and every figure
 * with its finding id, then checks the answer in code and appends any id it dropped, with the figures
 * recorded beside it, under "Ids and figures kept". Later turns can still cite what the summarized
 * range found.
 *
 * The ids are read by code from the range's tool results (see `ids.ts`) and from the kept list of an
 * earlier summary at the head of the range, so a second compaction keeps the first one's ids. The
 * summary is memoised in the compaction task, so a restart reuses it instead of asking again. A range
 * with no ids is left to Pi Durable's own summary.
 */

import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  CompactionTask,
  type HookRegistration,
  hook,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { messageText, type ResultFacts, resultFacts, resultText } from "./ids.js";

/** The heading of the list of ids a summary must keep. */
export const KEPT_HEADING = "Ids and figures kept:";

/** What the summarizer is told. */
export const SUMMARY_INSTRUCTIONS = [
  "You summarize the earlier part of a work conversation so the agent can continue without it.",
  "Keep every id exactly as written: engine finding ids, record ids, file ids, ticket ids and approval ids.",
  "Keep every amount and quantity together with the finding id it came from; never round, total or restate a figure without its id.",
  "Keep decisions, open questions and what was promised. Leave out greetings and repetition.",
].join("\n");

const MEMO = "context-compaction-summary";

export interface IdPreservingCompactionOptions {
  /** The model to summarize with when the conversation's agent names none: the role's default. */
  readonly fallbackModel: () => ModelRef & { readonly thinkingLevel?: ModelThinkingLevel };
}

/** Ids and figures from the range: its tool results, then any earlier kept list. */
export function rangeFacts(messages: readonly Message[]): ResultFacts {
  const ids: string[] = [];
  const figures = new Map<string, string[]>();
  const merge = (id: string, more: readonly string[]) => {
    if (!ids.includes(id)) ids.push(id);
    if (more.length > 0) figures.set(id, [...(figures.get(id) ?? []), ...more]);
  };
  for (const message of messages) {
    if (message.role === "toolResult") {
      const facts = resultFacts(message);
      for (const id of facts.ids) merge(id, facts.figures.get(id) ?? []);
    } else if (message.role === "user") {
      for (const [id, figure] of keptList(messageText(message))) merge(id, figure ? [figure] : []);
    }
  }
  return { ids, figures };
}

/** The `- id: figures` lines under an earlier summary's kept heading. */
function keptList(text: string): [string, string][] {
  const at = text.indexOf(KEPT_HEADING);
  if (at === -1) return [];
  const out: [string, string][] = [];
  for (const line of text.slice(at + KEPT_HEADING.length).split("\n")) {
    const match = /^- (\S+?)(?:: (.*))?$/.exec(line.trim());
    if (match?.[1] !== undefined) out.push([match[1], match[2] ?? ""]);
  }
  return out;
}

/** `summary`, with every id it does not contain appended under the kept heading. */
export function withKeptIds(summary: string, facts: ResultFacts): string {
  const missing = facts.ids.filter((id) => !summary.includes(id));
  if (missing.length === 0) return summary;
  const lines = missing.map((id) => {
    const figures = facts.figures.get(id) ?? [];
    return figures.length === 0 ? `- ${id}` : `- ${id}: ${figures.join(", ")}`;
  });
  return `${summary}\n\n${KEPT_HEADING}\n${lines.join("\n")}`;
}

/** The range as a transcript to summarize, so the model reads it instead of continuing it. */
function transcript(messages: readonly Message[]): string {
  return messages
    .flatMap((message) => {
      if (message.role === "user") return [`User: ${messageText(message)}`];
      if (message.role === "toolResult") {
        return [`Result of ${message.toolName}: ${resultText(message)}`];
      }
      if (message.role !== "assistant") return [];
      return message.content.flatMap((block) =>
        block.type === "text"
          ? [`Assistant: ${block.text}`]
          : block.type === "toolCall"
            ? [`Assistant called ${block.name}(${JSON.stringify(block.arguments)})`]
            : [],
      );
    })
    .join("\n\n");
}

/** The id-preserving compaction hook for the role's extension. */
export function idPreservingCompaction(options: IdPreservingCompactionOptions): HookRegistration {
  return hook(CompactionTask, {
    beforeCompact: async (compaction, api, context) => {
      const stored = await api.memo<string>(MEMO, context);
      if (stored !== undefined) return { summary: stored };
      const facts = rangeFacts(compaction.messages);
      if (facts.ids.length === 0) return undefined;

      const agent = await api.snapshot(AgentDoc, api.conversationId, context);
      const ref = agent?.model ?? options.fallbackModel();
      const model = api.models.getModel(ref.provider, ref.modelId);
      if (model === undefined) {
        throw new Error(
          `Cannot summarize for compaction: the model ${ref.provider}/${ref.modelId} is not in the harness's models. Add its provider to the harness, or set the conversation's model.`,
        );
      }
      const request = [
        transcript(compaction.messages),
        ...(compaction.instructions === undefined
          ? []
          : [`Also follow these instructions: ${compaction.instructions}`]),
      ].join("\n\n");
      const answer = await api.models.completeSimple(model, {
        systemPrompt: SUMMARY_INSTRUCTIONS,
        messages: [{ role: "user", content: request, timestamp: Date.now() }],
      });
      if (answer.stopReason === "error" || answer.stopReason === "aborted") {
        throw new Error(
          `Cannot summarize for compaction: ${ref.provider}/${ref.modelId} answered with ${answer.stopReason}${answer.errorMessage === undefined ? "" : `: ${answer.errorMessage}`}`,
        );
      }
      const text = answer.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
        .trim();
      return { summary: await api.memo(MEMO, withKeptIds(text, facts), context) };
    },
  });
}
