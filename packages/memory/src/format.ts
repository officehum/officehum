/**
 * How records read to the model, in `memory_recall` results and in the `memory` section alike. What
 * an agent remembered may have come from outside the business, so it is framed as data, never as
 * instructions, with the SDK's frame for outside text.
 */

import { frameOutsideOutput } from "@officehum/sdk";
import type { MemoryRecord } from "./record.js";

/** One record as a line: unconfirmed and proposed ones say so first. */
export function recordLine(record: MemoryRecord): string {
  const label =
    record.status === "unverified"
      ? "Unconfirmed: "
      : record.status === "proposed"
        ? "Proposed, not yet approved: "
        : "";
  const review = record.reviewAt === undefined ? "" : `; review ${record.reviewAt}`;
  return `- ${label}${record.text} (${record.about}; ${record.kind}, ${record.category}; saved ${record.createdAt.slice(0, 10)}${review}; ${record.id})`;
}

/** `text` inside the frame for information that is not an instruction. `label` names the reader. */
export function framedRecords(label: string, text: string): string {
  const [framed] = frameOutsideOutput(
    {
      tool: label,
      origin: "what agents in this office remembered while working (the memory extension)",
      tag: "memory-records",
    },
    [{ type: "text", text }],
  );
  return framed?.type === "text" ? framed.text : text;
}

/** Newest first. */
export function newestFirst(a: MemoryRecord, b: MemoryRecord): number {
  return b.createdAt.localeCompare(a.createdAt);
}
