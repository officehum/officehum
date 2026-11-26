/**
 * The `memory` prompt section: the pinned business-wide records, then the active and unverified
 * records about the conversation's focus subjects, each part newest first and capped, so memory never
 * crowds out the role's own instructions. Anything else is found with `memory_recall`. The section is
 * framed as information, not instructions, and is omitted when there is nothing to show.
 *
 * It changes as records are saved, so it belongs after the role's stable sections: a host selects
 * the memory extension after the role's.
 *
 * `memorySectionContent` is the one place the content is built, for a focus and a view, so a host
 * showing a person what an agent's prompt would hold (Office Hum's `preview_memory_section`) shows
 * exactly what the section renders.
 */

import {
  type DocumentReader,
  type PromptSection,
  section,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { tokensOf } from "@officehum/sdk";
import type { MemoryOptions } from "./extension.js";
import { framedRecords, newestFirst, recordLine } from "./format.js";
import type { MemoryRecord } from "./record.js";
import { readFocus, readIndex, readRecords } from "./storage.js";
import { type MemoryView, visibleIn } from "./view.js";

type Context = Parameters<ToolExecutionApi["commit"]>[1];

/** About 600 tokens of business-wide records. */
export const BUSINESS_TOKENS = 600;
/** About 800 tokens of records about the focus subjects. */
export const FOCUS_TOKENS = 800;

export const MEMORY_SECTION_KEY = "memory";

const SHOWN = new Set<string>(["active", "unverified"]);

/** What the section holds: its text (undefined when there is nothing to show) and those records. */
export interface MemorySectionContent {
  readonly text: string | undefined;
  /** The records the text shows, in its order: business-wide first, then the focus subjects'. */
  readonly records: readonly MemoryRecord[];
}

/** The section, showing only what the host's `viewOf` lets this conversation see. */
export function memorySection(options: Pick<MemoryOptions, "viewOf"> = {}): PromptSection {
  return section(MEMORY_SECTION_KEY, async (input, context) => {
    const view = await options.viewOf?.({
      conversationId: input.conversationId,
      read: input.read,
      context,
    });
    const focus = await readFocus(input.read, input.conversationId, context);
    return (await memorySectionContent({ read: input.read, focus, view, context })).text;
  });
}

/** The section's content for a conversation about `focus` that may see what `view` allows. */
export async function memorySectionContent(input: {
  readonly read: DocumentReader;
  /** The subjects the conversation is about. */
  readonly focus: readonly string[];
  /** What the conversation may see; undefined in a bare harness, which sees every record. */
  readonly view: MemoryView | undefined;
  readonly context: Context;
}): Promise<MemorySectionContent> {
  const { read, view, context } = input;
  const shown = (record: MemoryRecord) => SHOWN.has(record.status) && visibleIn(view, record);
  const index = await readIndex(read, context);
  const pinned = new Set(index.pinned);
  const business = (await readRecords(read, "business", context)).filter(
    (record) => pinned.has(record.id) && shown(record),
  );
  const focus: MemoryRecord[] = [];
  for (const about of input.focus) {
    if (about === "business") continue;
    focus.push(...(await readRecords(read, about, context)).filter(shown));
  }
  const parts = [
    capped("Business-wide:", business, BUSINESS_TOKENS),
    capped("About this conversation's subjects:", focus, FOCUS_TOKENS),
  ].filter((part) => part !== undefined);
  if (parts.length === 0) return { text: undefined, records: [] };
  return {
    text: framedRecords("the memory section", parts.map((part) => part.text).join("\n\n")),
    records: parts.flatMap((part) => part.records),
  };
}

/** A heading and the newest records whose lines fit in `tokens`; undefined when there are none. */
function capped(
  heading: string,
  records: readonly MemoryRecord[],
  tokens: number,
): { readonly text: string; readonly records: readonly MemoryRecord[] } | undefined {
  if (records.length === 0) return undefined;
  const lines: string[] = [];
  const kept: MemoryRecord[] = [];
  let used = 0;
  for (const record of [...records].sort(newestFirst)) {
    const line = recordLine(record);
    used += tokensOf(line);
    if (used > tokens) break;
    lines.push(line);
    kept.push(record);
  }
  const left = records.length - lines.length;
  if (left > 0) lines.push(`(${left} older not shown; find them with memory_recall.)`);
  return { text: [heading, ...lines].join("\n"), records: kept };
}
