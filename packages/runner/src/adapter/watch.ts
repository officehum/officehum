/**
 * Office Hum's view of one conversation's activity.
 *
 * Pi Durable 1.5 removed its agent event stream (`watchEvents`): a client renders the conversation's
 * state instead. Office Hum still consumes five things, so this module derives them from the two
 * observation points Pi Durable offers, and everything else is dropped here, so callers never match
 * on raw Pi Durable shapes. Add a kind when a caller needs it rather than widening the pattern at the
 * call site.
 *
 * - `viewEvents` compares two revisions of the conversation view (`Harness.observeConversation`):
 *   streamed text, and tool calls starting and ending, from `pi.live`.
 * - `submissionEvents` reads one stored submission record (`Harness.observeCommits`): an input
 *   placed in the transcript, or settled.
 *
 * Both follow what 1.3.0's `watchEvents` reported, event for event.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import type {
  ConversationView,
  EntryRecord,
  NestedToolSlot,
  SubmissionId,
  SubmissionRecord,
  ToolSlot,
} from "@earendil-works/pi-durable";

/** The event kinds Office Hum reacts to. */
export type OfficeEvent =
  | {
      readonly kind: "tool_start";
      readonly tool: string;
      readonly callId: string;
      readonly args: unknown;
    }
  | {
      readonly kind: "tool_end";
      readonly tool: string;
      readonly callId: string;
      readonly failed: boolean;
      /**
       * The call's Pi Durable tool task, when known: the board's hand-off ledger binds the tickets a
       * dispatch opened to it, so a request can say which tickets its turn opened.
       */
      readonly taskId?: number;
    }
  | {
      /** A submission's input entered the transcript: the run that follows is working on it. */
      readonly kind: "placed";
      readonly submissionId: SubmissionId;
      /** The host's request id the submission was made with, when it had one. */
      readonly requestId?: string;
    }
  | {
      readonly kind: "settled";
      readonly submissionId: SubmissionId;
      readonly status: string;
    }
  | { readonly kind: "text"; readonly delta: string };

/** Terminal submission statuses. A record with any other status is not a settlement. */
const TERMINAL = new Set(["done", "unanswered"]);

/** The parts of `pi.live` these events read; the view keeps it as a plain document. */
type Live = {
  readonly tools?: readonly ToolSlot[];
  readonly nestedTools?: readonly NestedToolSlot[];
};

type Op = readonly [string, ...unknown[]];

const PARTIAL_PATH = ["docs", "pi.live", "generation", "message", "content"];

function liveOf(view: ConversationView | undefined): Live {
  return (view?.docs["pi.live"] ?? {}) as Live;
}

/**
 * The arguments a model-issued call was made with, from the tool-calling answer in the view. Pi
 * Durable 1.6 keeps the arguments a call runs with (after repair) only in its task's checkpoint.
 */
function modelArguments(entries: readonly EntryRecord[], callId: string): unknown {
  for (const entry of entries.toReversed()) {
    const message = entry.model?.[0];
    if (message?.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall" && block.id === callId) return block.arguments;
    }
  }
  return {};
}

/**
 * A nested call's end says whether it failed, from its summary; a model-issued call's end never did
 * (1.3.0 reported only a nested call's result), so it stays `false`.
 */
function nestedFailed(slot: NestedToolSlot | undefined): boolean {
  return slot?.summary?.isError === true;
}

function startsWith(path: readonly unknown[], prefix: readonly unknown[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

/** The text appended to the streamed answer by `ops`, in order; thinking is never office output. */
function textDeltas(ops: readonly Op[]): OfficeEvent[] {
  const deltas: OfficeEvent[] = [];
  // A block written whole holds every later change to it in this batch, which 1.3.0 did not repeat.
  const whole = new Set<unknown>();
  for (const op of ops) {
    const path = op[1];
    if (!Array.isArray(path) || !startsWith(path, PARTIAL_PATH)) continue;
    const rest = path.slice(PARTIAL_PATH.length);
    if (rest.length === 0) continue;
    const index = rest[0];
    if (whole.has(index)) continue;
    if (op[0] === "a" && rest.length === 2 && rest[1] === "text") {
      deltas.push({ kind: "text", delta: op[2] as string });
    } else if (!(op[0] === "a" && (rest[1] === "thinking" || rest[1] === "arguments"))) {
      whole.add(index);
    }
  }
  return deltas;
}

/**
 * The events between two revisions of a conversation view: tool starts, then the streamed text, then
 * tool ends, the order 1.3.0's stream gave them within one commit. `ops` are the operations that
 * turned `before` into `after`.
 */
export function viewEvents(
  before: ConversationView | undefined,
  after: ConversationView,
  ops: readonly Op[],
): readonly OfficeEvent[] {
  const was = liveOf(before);
  const now = liveOf(after);
  const events: OfficeEvent[] = [];
  const slotsBefore = new Map((was.tools ?? []).map((slot) => [slot.callId, slot]));
  const slots = now.tools ?? [];
  const nestedBefore = new Map((was.nestedTools ?? []).map((slot) => [slot.taskId, slot]));
  const nested = now.nestedTools ?? [];

  for (const slot of slots) {
    if (slot.status !== "running" || slotsBefore.get(slot.callId)?.status === "running") continue;
    events.push({
      kind: "tool_start",
      tool: slot.name,
      callId: slot.callId,
      args: modelArguments(after.entries, slot.callId),
    });
  }
  for (const slot of nested) {
    if (slot.status !== "running" || nestedBefore.get(slot.taskId)?.status === "running") continue;
    events.push({
      kind: "tool_start",
      tool: slot.name,
      callId: slot.callId,
      args: slot.arguments as JsonValue,
    });
  }

  events.push(...textDeltas(ops));

  // Calls that end in this revision: a slot that becomes done, one created done (a call not offered),
  // or an unfinished one that disappears because its run ended. Nested calls first, children before
  // the calls that made them (the lists hold parents first), as 1.3.0 ordered them.
  const nestedNow = new Map(nested.map((slot) => [slot.taskId, slot]));
  for (const previous of [...nestedBefore.values()].reverse()) {
    if (previous.status === "done") continue;
    const slot = nestedNow.get(previous.taskId);
    if (slot === undefined || slot.status === "done") {
      const ended = slot ?? previous;
      events.push({
        kind: "tool_end",
        tool: ended.name,
        callId: ended.callId,
        failed: nestedFailed(ended),
        taskId: ended.taskId as number,
      });
    }
  }
  for (const slot of [...nested].reverse()) {
    if (slot.status === "done" && !nestedBefore.has(slot.taskId)) {
      events.push({
        kind: "tool_end",
        tool: slot.name,
        callId: slot.callId,
        failed: nestedFailed(slot),
        taskId: slot.taskId as number,
      });
    }
  }
  for (const previous of slotsBefore.values()) {
    if (previous.status === "done") continue;
    const slot = slots.find((candidate) => candidate.callId === previous.callId);
    if (slot === undefined || slot.status === "done") {
      const taskId = slot?.taskId ?? previous.taskId;
      events.push({
        kind: "tool_end",
        tool: previous.name,
        callId: previous.callId,
        failed: false,
        ...(taskId === undefined ? {} : { taskId: taskId as number }),
      });
    }
  }
  for (const slot of slots) {
    if (slot.status === "done" && !slotsBefore.has(slot.callId)) {
      events.push({
        kind: "tool_end",
        tool: slot.name,
        callId: slot.callId,
        failed: false,
        ...(slot.taskId === undefined ? {} : { taskId: slot.taskId as number }),
      });
    }
  }
  return events;
}

/**
 * One stored submission record as an event: `placed` when its input entered the transcript, `settled`
 * for the two terminal statuses, nothing otherwise.
 */
export function submissionEvents(record: SubmissionRecord): readonly OfficeEvent[] {
  // The record's status vocabulary is Pi Durable's, and its union is wide; read it defensively.
  const read = record as unknown as {
    readonly id: SubmissionId;
    readonly status?: unknown;
    readonly requestId?: unknown;
  };
  const status = typeof read.status === "string" ? read.status : "unknown";
  if (status === "placed") {
    return [
      {
        kind: "placed",
        submissionId: read.id,
        ...(typeof read.requestId === "string" ? { requestId: read.requestId } : {}),
      },
    ];
  }
  return TERMINAL.has(status) ? [{ kind: "settled", submissionId: read.id, status }] : [];
}
