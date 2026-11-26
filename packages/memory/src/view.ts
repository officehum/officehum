/**
 * What one conversation may see of memory. The host decides it in code from the run's provenance
 * (`MemoryOptions.viewOf`); nothing the model passes changes it. A bare harness has no view, and
 * sees every record.
 */

import type { ConversationId, DocumentReader, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { MemoryRecord } from "./record.js";

type Context = Parameters<ToolExecutionApi["commit"]>[1];

/** The conversation whose view of memory `viewOf` decides. */
export interface ViewInput {
  readonly conversationId: ConversationId;
  /** Committed document reads: the tool call's API, or the section's `input.read`. */
  readonly read: DocumentReader;
  readonly context: Context;
}

/**
 * What one conversation may see of memory, decided by the host's code from the run's provenance,
 * never from a tool argument. A record is visible when its scope is listed and its subject may be
 * used here.
 */
export interface MemoryView {
  /** The scopes whose records this conversation sees, e.g. `office`, `department:finance`. */
  readonly scopes: readonly string[];
  /** Whether records about `about` may be used in this conversation (person records, say). */
  readonly uses: (about: string) => boolean;
}

/** Whether `record` is visible in `view`; with no view (a bare harness), every record is. */
export function visibleIn(view: MemoryView | undefined, record: MemoryRecord): boolean {
  return view === undefined || (view.scopes.includes(record.scope) && view.uses(record.about));
}
