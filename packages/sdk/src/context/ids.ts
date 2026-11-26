/**
 * The ids a tool result carries, and the figures beside them, read by code so the relevance filter
 * and the compaction check never depend on a model noticing them.
 *
 * An id is an engine finding id (an engine tool's `details.findings`), or a string in a JSON field
 * named `id` or ending in `Id` or `_id` (record, file, ticket and approval ids). Free text is not
 * scanned: a pattern guess would keep or list things that are not ids.
 */

import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";

/** What a tool result carries: its ids, and for each id the figures recorded beside it. */
export interface ResultFacts {
  readonly ids: readonly string[];
  /** Id → figures such as `quantity 120`, from the numeric fields of the object the id names. */
  readonly figures: ReadonlyMap<string, readonly string[]>;
}

const ID_KEY = /^(id|.+Id|.+_id)$/;

/** A string worth treating as an id: no whitespace, and long enough not to match everywhere. */
function idLike(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 200 && !/\s/.test(value);
}

/** The text of a tool result's content blocks. */
export function resultText(message: ToolResultMessage): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text !== "")
    .join("\n");
}

/** Parses a block of text as JSON: the whole text, or from its first `{` or `[` to the matching end. */
function parseJson(text: string): unknown {
  const attempts = [text];
  const start = text.search(/[{[]/);
  if (start > 0) attempts.push(text.slice(start));
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start >= 0 && end > start) attempts.push(text.slice(start, end + 1));
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // Try the next, narrower slice.
    }
  }
  return undefined;
}

/** The ids and figures of one tool result, in the order they first appear. */
export function resultFacts(message: ToolResultMessage): ResultFacts {
  const ids: string[] = [];
  const figures = new Map<string, string[]>();
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };

  const details = message.details as { findings?: unknown } | undefined;
  if (details !== null && typeof details === "object" && Array.isArray(details.findings)) {
    for (const finding of details.findings) if (idLike(finding)) add(finding);
  }

  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const [key, field] of Object.entries(record)) {
      if (ID_KEY.test(key) && idLike(field)) add(field);
    }
    const own = record.id;
    if (idLike(own)) {
      const numbers = Object.entries(record)
        .filter(([key, field]) => !ID_KEY.test(key) && typeof field === "number")
        .map(([key, field]) => `${key} ${String(field)}`);
      if (numbers.length > 0) figures.set(own, [...(figures.get(own) ?? []), ...numbers]);
    }
    for (const field of Object.values(record)) walk(field);
  };
  for (const block of message.content) {
    if (block.type === "text") walk(parseJson(block.text));
  }
  return { ids, figures };
}

/** The text a message shows the model, for finding citations: tool calls count by their arguments. */
export function messageText(message: Message): string {
  switch (message.role) {
    case "system":
      return "";
    case "user":
      return typeof message.content === "string"
        ? message.content
        : message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    case "assistant":
      return message.content
        .map((block) =>
          block.type === "text"
            ? block.text
            : block.type === "toolCall"
              ? JSON.stringify(block.arguments)
              : "",
        )
        .join("\n");
    case "toolResult":
      return resultText(message);
  }
}

/** Tokens as the SDK counts them everywhere: characters ÷ 4, rounded up. */
export function tokensOf(text: string): number {
  return Math.ceil(text.length / 4);
}
