/**
 * Memory for one eval trial: what a scenario's `memory` block runs its role with.
 *
 * The bare harness installs the portable extension beside the role, as `@officehum/memory`'s README
 * shows a bare Pi Durable host doing it, and nothing of Office Hum's: the portability gate holds.
 * The save's source is read from the verified sender the runner already hands the role: a sender the
 * scenario says wrote from inside is a `person`, an outside one `external`, and with nobody named
 * every message is the bare harness's local user, the extension's own default. A host brings its own
 * memory (the office's is in the office) and seeds it with `seedScenarioRecords`.
 *
 * Seeded records are committed with `saveRecord` before the turn, as earlier work would have left
 * them; they never pass through `memory_save` or its guards, which is how a scenario plants a record.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension } from "@earendil-works/pi-durable";
import {
  LOCAL_USER_SOURCE,
  type MemoryRecord,
  type MemorySource,
  memoryExtension,
  readAllRecords,
  saveRecord,
} from "@officehum/memory";
import type { MemoryTrace, Scenario, SenderResolver, VerifiedSender } from "@officehum/sdk";
import type { Office } from "../adapter/index.js";
import type { LoadedRole } from "../roles/load-role.js";

const CTX = BACKGROUND_CONTEXT;

/** When seeded records say they were saved: a fixed date, a minute apart, in the order seeded. */
const SEEDED_AT = Date.parse("2026-01-01T09:00:00.000Z");

/** A trial's memory: the extension to select after the role's, and its state around the run. */
export interface EvalMemory {
  readonly extension: Extension;
  /** Writes the scenario's seeded records, then starts what follows them (the office's index). */
  start(): Promise<void>;
  /** Every stored record (and a host's own, like the office's review queue), before the harness closes. */
  snapshot(): Promise<MemoryTrace>;
  /** Stops what `start` started. Call before the harness closes. */
  stop(): Promise<void>;
}

/** Bare mode's memory: the portable extension, its source read from the trial's verified sender. */
export function bareEvalMemory(
  office: Office,
  role: LoadedRole,
  scenario: Scenario,
  sender: SenderResolver,
): EvalMemory {
  const scope = `agent:${role.manifest.id}`;
  return {
    extension: memoryExtension({
      role: role.manifest.id,
      sourceOf: async ({ conversationId }) =>
        bareSource(await sender({ conversationId, taskId: undefined })),
    }),
    start: () => seedScenarioRecords(office, scenario, role, scope),
    snapshot: async () => ({ records: await readAllRecords(office.harness, CTX) }),
    stop: async () => {},
  };
}

/** The source a bare harness gives a save, from the sender the scenario states. */
function bareSource(sender: VerifiedSender | undefined): MemorySource {
  if (sender === undefined) return LOCAL_USER_SOURCE;
  if (sender.origin === "external") {
    return { type: "external", ref: `${sender.channel}:${sender.contact}` };
  }
  return { type: "person", ref: sender.contact };
}

/** The scenario's seeded records as stored records, scoped where the trial's agent reads them. */
function seededRecords(scenario: Scenario, role: LoadedRole, scope: string): MemoryRecord[] {
  return (scenario.memory?.seed ?? []).map((record, index) => ({
    id: record.id,
    about: record.about,
    kind: record.kind,
    category: record.category,
    text: record.text,
    scope,
    source: record.source ?? { type: "person", ref: "seed" },
    status: record.status ?? "active",
    createdAt: new Date(SEEDED_AT + index * 60_000).toISOString(),
    createdBy: `agent:${role.manifest.id}`,
    ...(record.reviewAt === undefined ? {} : { reviewAt: record.reviewAt }),
  }));
}

/** Writes the scenario's seeded records into the trial's harness, under `scope`, before the turn. */
export async function seedScenarioRecords(
  office: Office,
  scenario: Scenario,
  role: LoadedRole,
  scope: string,
): Promise<void> {
  const records = seededRecords(scenario, role, scope);
  if (records.length === 0) return;
  await office.harness.commit(async (tx) => {
    // A seed is planted past the guards on purpose, a protected record as an owner would set it.
    for (const record of records) await saveRecord(tx, record, undefined, { owner: true });
  }, CTX);
}
