/**
 * `memoryExtension()`: the memory tools and the `memory` section as one Pi Durable extension. It
 * installs into any 1.6.x harness; the host decides where a save's content came from (`sourceOf`)
 * and who reviews what code refuses (`onReview`).
 *
 * ```ts
 * const memory = memoryExtension({ role: "bookkeeper" });
 * registry.install(memory);
 * const root = await harness.root(context, {
 *   agent: { ...role.agent, extensions: [...role.agent.extensions, memory] },
 * });
 * ```
 */

import { fileURLToPath } from "node:url";
import {
  type ConversationId,
  defineExtension,
  type Extension,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { guardToolResult } from "@officehum/sdk";
import type { Category, Kind, MemoryRecord, MemorySource } from "./record.js";
import type { ScanResult } from "./scan.js";
import { memorySection } from "./section.js";
import { memoryTools } from "./tools.js";
import type { MemoryView, ViewInput } from "./view.js";

type Context = Parameters<ToolExecutionApi["commit"]>[1];

export const MEMORY_EXTENSION_NAME = "officehum.memory";

/**
 * The `memory-hygiene` skill folder this package ships. Pass it to the role:
 * `defineRole({ …, extraSkills: [MEMORY_HYGIENE_SKILL] })`.
 */
export const MEMORY_HYGIENE_SKILL = fileURLToPath(
  new URL("../skills/memory-hygiene", import.meta.url),
);

/** The call `sourceOf` decides the source of. */
export interface SourceInput {
  readonly conversationId: ConversationId;
  readonly callId: string;
  /** The tool call's API, for reading the run's documents and transcript. */
  readonly api: ToolExecutionApi;
  readonly context: Context;
}

/** A save code refused because its category is protected; the host opens a review for an owner. */
export interface ReviewItem {
  /** The record id the save would have had; the same on a replay, so a host can deduplicate. */
  readonly key: string;
  readonly reason: string;
  readonly about: string;
  readonly kind: Kind;
  readonly category: Category;
  readonly text: string;
  readonly source: MemorySource;
  readonly conversationId: ConversationId;
  readonly callId: string;
}

/** A record `memory_save` just wrote, inside the commit that writes it. */
export interface SavedInput {
  /** The save's commit: what the host writes here commits with the record, or not at all. */
  readonly tx: Tx;
  readonly record: MemoryRecord;
  readonly conversationId: ConversationId;
  readonly callId: string;
}

/** What `memory_recall` asks a host's search for. */
export interface SearchInput {
  /** The query's words, lowercased; never empty. */
  readonly words: readonly string[];
  readonly subjects: readonly string[];
  /** The most ids worth returning. */
  readonly limit: number;
}

export interface MemoryOptions {
  /** The role using the extension. Records are created by `agent:<role>`. */
  readonly role: string;
  /**
   * The extension's name. A host that gives each agent its own instance (each with its own `role`
   * and view) names each one, since Pi Durable selects extensions by name. Omitted:
   * `MEMORY_EXTENSION_NAME`.
   */
  readonly name?: string;
  /**
   * The scope every save gets: `office`, `department:<id>` or `agent:<role>`. Code decides it; the
   * model never does. Omitted: `agent:<role>`.
   */
  readonly scope?: string;
  /**
   * Which records this conversation sees (recall, the section, forgetting and superseding alike).
   * Omitted, for a bare harness: every record.
   */
  readonly viewOf?: (input: ViewInput) => MemoryView | Promise<MemoryView>;
  /**
   * A host's search for `memory_recall` with keywords: the ids of records about `subjects` matching
   * any of `words`, best first. Recall still shows only the records the view allows and that are not
   * retired or superseded, in this order. Omitted: the extension's own keyword match.
   */
  readonly search?: (input: SearchInput) => Promise<readonly string[]>;
  /**
   * Where the content of a save came from, read from the run's provenance: a staff member's own
   * message is `person`; a customer email, SMS, web page or peer office is `external`. Omitted, for
   * a bare harness: every message is the local user's own, `{ type: "person", ref: "local-user" }`.
   */
  readonly sourceOf?: (input: SourceInput) => MemorySource | Promise<MemorySource>;
  /** Called for a protected-category save code refused. Omitted: the refusal only tells the model. */
  readonly onReview?: (item: ReviewItem) => void | Promise<void>;
  /**
   * Called inside the commit that writes a new record, so what the host writes (a review item for an
   * unverified or proposed record, say) commits with it. A replayed save finds its record and does
   * not call it again. Omitted: nothing more is written.
   */
  readonly onSaved?: (input: SavedInput) => void | Promise<void>;
  /** The clock records are dated by. Omitted: the system clock. */
  readonly now?: () => Date;
  /**
   * The scan `memory_save` runs on every text before anything is stored. Omitted: `scanText`, which
   * every host uses. It exists for the red-team suite's mutation pass alone, which replaces it with
   * a scan that finds nothing to prove the secret attack goes red without it; the office never
   * passes one, and no office file can.
   */
  readonly scan?: (text: string) => ScanResult;
}

export function memoryExtension(options: MemoryOptions): Extension {
  return defineExtension({
    name: options.name ?? MEMORY_EXTENSION_NAME,
    tools: memoryTools(options).map(guardToolResult),
    sections: [memorySection(options)],
  });
}
