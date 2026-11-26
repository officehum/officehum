import type { ConversationView, SubmissionRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { submissionEvents, viewEvents } from "./watch.js";

const submission = (record: Record<string, unknown>) => record as unknown as SubmissionRecord;

/** A view whose `pi.live` and entries are the given ones. */
const view = (live: Record<string, unknown>, entries: readonly unknown[] = []) =>
  ({ conversation: { id: 1 }, entries, docs: { "pi.live": live } }) as unknown as ConversationView;

const slot = (status: string, extra: Record<string, unknown> = {}) => ({
  callId: "call-1",
  name: "lookup",
  status,
  ...extra,
});

describe("submissionEvents", () => {
  it("reports a placed submission with the request id it was made with", () => {
    expect(submissionEvents(submission({ id: 7, status: "placed", requestId: "evt-1" }))).toEqual([
      { kind: "placed", submissionId: 7, requestId: "evt-1" },
    ]);
    expect(submissionEvents(submission({ id: 8, status: "placed" }))).toEqual([
      { kind: "placed", submissionId: 8 },
    ]);
  });

  it("reports the two terminal statuses as settled and nothing else", () => {
    expect(submissionEvents(submission({ id: 9, status: "done" }))).toEqual([
      { kind: "settled", submissionId: 9, status: "done" },
    ]);
    expect(submissionEvents(submission({ id: 9, status: "unanswered" }))).toEqual([
      { kind: "settled", submissionId: 9, status: "unanswered" },
    ]);
    expect(submissionEvents(submission({ id: 9, status: "queued" }))).toEqual([]);
  });
});

describe("viewEvents", () => {
  it("reports the text appended to the streamed answer, not its thinking", () => {
    const ops = [
      ["a", ["docs", "pi.live", "generation", "message", "content", 0, "thinking"], "hmm"],
      ["a", ["docs", "pi.live", "generation", "message", "content", 1, "text"], "Hel"],
      ["a", ["docs", "pi.live", "generation", "message", "content", 1, "text"], "lo"],
    ] as const;
    expect(viewEvents(view({}), view({}), ops)).toEqual([
      { kind: "text", delta: "Hel" },
      { kind: "text", delta: "lo" },
    ]);
  });

  it("reports a call once when it starts running, with the arguments the model gave it", () => {
    const answer = {
      id: 3,
      model: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { q: "x" } }],
        },
      ],
    };
    const pending = view({ tools: [slot("pending")] }, [answer]);
    const running = view({ tools: [slot("running")] }, [answer]);
    expect(viewEvents(pending, running, [])).toEqual([
      { kind: "tool_start", tool: "lookup", callId: "call-1", args: { q: "x" } },
    ]);
    expect(viewEvents(running, running, [])).toEqual([]);
  });

  it("reports a call's end when its slot is done or its run ended", () => {
    const running = view({ tools: [slot("running")] });
    expect(viewEvents(running, view({ tools: [slot("done", { entry: 4 })] }), [])).toEqual([
      { kind: "tool_end", tool: "lookup", callId: "call-1", failed: false },
    ]);
    expect(viewEvents(running, view({}), [])).toEqual([
      { kind: "tool_end", tool: "lookup", callId: "call-1", failed: false },
    ]);
  });

  it("reports whether a nested call failed, children before their parents", () => {
    const nested = (taskId: number, status: string, isError?: boolean) => ({
      callId: `call-1/${taskId}`,
      name: `inner-${taskId}`,
      status,
      parentCallId: "call-1",
      parentTaskId: 1,
      taskId,
      arguments: {},
      ...(isError === undefined ? {} : { summary: { isError } }),
    });
    const before = view({ nestedTools: [nested(2, "running"), nested(3, "running")] });
    const after = view({ nestedTools: [nested(2, "done", false), nested(3, "done", true)] });
    expect(viewEvents(before, after, [])).toEqual([
      { kind: "tool_end", tool: "inner-3", callId: "call-1/3", failed: true, taskId: 3 },
      { kind: "tool_end", tool: "inner-2", callId: "call-1/2", failed: false, taskId: 2 },
    ]);
  });

  it("names the ended call's tool task when the view knows it", () => {
    const running = view({ tools: [slot("running", { taskId: 12 })] });
    expect(
      viewEvents(running, view({ tools: [slot("done", { taskId: 12, entry: 4 })] }), []),
    ).toEqual([{ kind: "tool_end", tool: "lookup", callId: "call-1", failed: false, taskId: 12 }]);
    expect(viewEvents(running, view({}), [])).toEqual([
      { kind: "tool_end", tool: "lookup", callId: "call-1", failed: false, taskId: 12 },
    ]);
  });
});
