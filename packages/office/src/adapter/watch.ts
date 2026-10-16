/**
 * Office Hum's view of Pi Durable's agent event stream.
 *
 * Pi Durable 1.3.0 emits 27 top-level event kinds (`AgentEvent` in `dist/harness/events.d.ts`) plus a
 * nested change list inside `message_update`. Office Hum consumes four things and everything else is
 * dropped here, so callers never match on raw Pi Durable event shapes. Add a kind when a caller needs
 * it rather than widening the pattern at the call site.
 */
import type {
  AgentEvent,
  NestedToolExecutionResult,
  SubmissionId,
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
    }
  | {
      readonly kind: "settled";
      readonly submissionId: SubmissionId;
      readonly status: string;
    }
  | { readonly kind: "text"; readonly delta: string };

/** Terminal submission statuses. A `submission` event with any other status is not a settlement. */
const TERMINAL = new Set(["done", "unanswered"]);

function toolFailed(result: NestedToolExecutionResult | undefined): boolean {
  return (result as unknown as { readonly isError?: boolean } | undefined)?.isError === true;
}

/**
 * Map one Pi Durable event onto zero or more Office Hum events.
 *
 * `text_delta` is kept and `thinking_delta` dropped: reasoning never becomes office output. A
 * `submission` event is reported as `settled` only for the two terminal statuses.
 */
export function officeEvents(event: AgentEvent): readonly OfficeEvent[] {
  switch (event.type) {
    case "tool_execution_start":
      return [
        { kind: "tool_start", tool: event.toolName, callId: event.toolCallId, args: event.args },
      ];
    case "tool_execution_end":
      return [
        {
          kind: "tool_end",
          tool: event.toolName,
          callId: event.toolCallId,
          failed: toolFailed(event.result),
        },
      ];
    case "message_update": {
      const deltas: OfficeEvent[] = [];
      for (const change of event.changes) {
        if (change.type === "text_delta") deltas.push({ kind: "text", delta: change.delta });
      }
      return deltas;
    }
    case "submission": {
      // The record's status vocabulary is Pi Durable's, and its union is wide; read it defensively.
      const record = event.record as unknown as {
        readonly id: SubmissionId;
        readonly status?: unknown;
      };
      const status = typeof record.status === "string" ? record.status : "unknown";
      return TERMINAL.has(status) ? [{ kind: "settled", submissionId: record.id, status }] : [];
    }
    default:
      return [];
  }
}
