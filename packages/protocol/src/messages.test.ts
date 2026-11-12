import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  type ErrorMessage,
  type EventMessage,
  handshake,
  invalidMessage,
  type Message,
  PROTOCOL_VERSION,
  replyId,
  scopedRequestId,
  validateMessage,
} from "./messages.js";

const principal = { id: "user-7", roles: ["approver"], approvalLimit: 500 };

/** One valid example of every command a client sends. */
const COMMANDS = [
  {
    type: "submit",
    id: "c1",
    agent: "front-desk",
    requestId: "r1",
    input: { kind: "message", text: "Hello" },
  },
  {
    type: "submit",
    id: "c2",
    agent: "front-desk",
    requestId: "r2",
    input: { kind: "ticket", type: "example.task", payload: { note: "anything" } },
    conversation: "conv-1",
  },
  { type: "subscribe", id: "c3", requestId: "r1" },
  { type: "subscribe", id: "c4", requestId: "r1", afterSeq: 3 },
  { type: "get_state", id: "c5" },
  { type: "get_state", id: "c6", agent: "front-desk" },
  { type: "list_agents", id: "c7" },
  { type: "abort", id: "c8", requestId: "r1" },
  { type: "approve", id: "c9", approvalId: "a1", decision: "approve" },
  { type: "approve", id: "c10", approvalId: "a1", decision: "decline", note: "Not this week" },
  { type: "ping", id: "c11" },
] as const;

/** One valid example of every message the gateway or runtime sends. */
const SERVER_MESSAGES = [
  { type: "welcome", version: 1, serverId: "office-1" },
  { type: "accepted", id: "c1", requestId: "r1", disposition: "started" },
  { type: "accepted", id: "c1", requestId: "r1", disposition: "queued" },
  { type: "accepted", id: "c1", requestId: "r1", disposition: "existing" },
  { type: "result", id: "c11", ok: true },
  { type: "result", id: "c7", ok: true, data: { agents: ["front-desk"] } },
  { type: "error", code: "bad_frame", message: "Line 1 is not valid JSON." },
  {
    type: "error",
    id: "c1",
    code: "invalid_message",
    message: "The message has 1 problem.",
    problems: [{ path: "agent", message: "is required" }],
  },
  { type: "event", requestId: "r1", seq: 1, event: { kind: "text_delta", text: "Hel" } },
  {
    type: "event",
    requestId: "r1",
    seq: 2,
    event: { kind: "tool_start", toolCallId: "t1", tool: "lookup" },
  },
  {
    type: "event",
    requestId: "r1",
    seq: 3,
    event: { kind: "tool_end", toolCallId: "t1", tool: "lookup", ok: true },
  },
  {
    type: "event",
    requestId: "r1",
    seq: 4,
    event: { kind: "approval_requested", approvalId: "a1", tool: "send", summary: "Send the note" },
  },
  {
    type: "event",
    requestId: "r1",
    seq: 5,
    event: { kind: "approval_decided", approvalId: "a1", decision: "approve", by: "user-7" },
  },
  {
    type: "event",
    requestId: "r1",
    seq: 6,
    event: { kind: "approval_decided", approvalId: "a2", decision: "decline" },
  },
  {
    type: "event",
    requestId: "r1",
    seq: 7,
    event: { kind: "settled", status: "done", answer: "Done." },
  },
  { type: "event", requestId: "r2", seq: 1, event: { kind: "settled", status: "failed" } },
  { type: "event", requestId: "r3", seq: 1, event: { kind: "settled", status: "aborted" } },
] as const;

function problems(json: unknown, from: "client" | "gateway" | "server") {
  const result = validateMessage(json, from);
  return result.ok ? [] : result.problems;
}

describe("validateMessage", () => {
  it.each(COMMANDS)("accepts the client command $type ($id)", (command) => {
    const result = validateMessage(command, "client");
    expect(result).toEqual({ ok: true, message: command });
  });

  it("accepts a hello from a client, with or without a sign-in token", () => {
    expect(problems({ type: "hello", version: 1, client: "web" }, "client")).toEqual([]);
    expect(problems({ type: "hello", version: 1, client: "web", token: "abc" }, "client")).toEqual(
      [],
    );
    expect(problems({ type: "hello", version: 1, client: "web", token: "" }, "client")).toEqual([
      { path: "token", message: "must not be empty" },
    ]);
  });

  it.each(SERVER_MESSAGES)("accepts the server message $type", (message) => {
    expect(problems(message, "server")).toEqual([]);
  });

  it.each(COMMANDS)("accepts $type ($id) forwarded by the gateway with a principal", (command) => {
    expect(problems({ ...command, principal }, "gateway")).toEqual([]);
  });

  it("refuses a principal sent by a client", () => {
    expect(problems({ type: "ping", id: "c1", principal }, "client")).toEqual([
      {
        path: "principal",
        message: "is added only by the gateway; a client may never send it",
      },
    ]);
  });

  it("requires a principal on a command the gateway forwards", () => {
    expect(problems({ type: "ping", id: "c1" }, "gateway")).toEqual([
      { path: "principal", message: "is required on a command the gateway forwards" },
    ]);
  });

  it("checks the principal's shape", () => {
    expect(
      problems({ type: "ping", id: "c1", principal: { id: "", roles: "x" } }, "gateway"),
    ).toEqual([
      { path: "principal.id", message: "must not be empty" },
      { path: "principal.roles", message: 'must be an array (got "x")' },
    ]);
  });

  it("takes watch_approvals from a client and approval messages from a server", () => {
    expect(problems({ type: "watch_approvals", id: "w1" }, "client")).toEqual([]);
    const approval = {
      approvalId: "t1:c1:large_invoice",
      agent: "bookkeeper",
      tool: "create_invoice",
      summary: "Confirm a large invoice",
      status: "approved",
      requestedAt: "2026-11-11T10:00:00.000Z",
      expiresAt: "2026-11-11T14:00:00.000Z",
      amount: 3_499,
      by: "maya",
      decidedAt: "2026-11-11T10:05:00.000Z",
    };
    expect(problems({ type: "approval", approval }, "server")).toEqual([]);
    expect(
      problems({ type: "approval", approval: { ...approval, status: "maybe" } }, "server"),
    ).not.toEqual([]);
    expect(
      problems(
        {
          type: "event",
          requestId: "r1",
          seq: 1,
          event: {
            kind: "approval_requested",
            approvalId: "a1",
            tool: "create_invoice",
            summary: "s",
            agent: "bookkeeper",
            expiresAt: "2026-11-11T14:00:00.000Z",
          },
        },
        "server",
      ),
    ).toEqual([]);
  });

  it("refuses an unknown type, naming the types the sender may use", () => {
    expect(problems({ type: "shout", id: "c1" }, "client")).toEqual([
      {
        path: "type",
        message:
          'must be one of "hello", "submit", "subscribe", "get_state", "list_agents", "abort", "approve", "watch_approvals", "ping" (got "shout")',
      },
    ]);
  });

  it("does not mistake an inherited property name for a type or kind", () => {
    expect(problems({ type: "toString", id: "c1" }, "client")[0]?.path).toBe("type");
    expect(
      problems(
        { type: "submit", id: "c1", agent: "a", requestId: "r", input: { kind: "constructor" } },
        "client",
      )[0]?.path,
    ).toBe("input.kind");
  });

  it("refuses a server message sent by a client", () => {
    expect(problems({ type: "welcome", version: 1, serverId: "x" }, "client")[0]?.path).toBe(
      "type",
    );
  });

  it("refuses a message that is not an object", () => {
    expect(problems([1], "client")).toEqual([{ path: "", message: "must be an object (got [1])" }]);
  });

  it("refuses a command with no id", () => {
    expect(problems({ type: "list_agents" }, "client")).toEqual([
      { path: "id", message: "is required" },
    ]);
  });

  it("reports every problem at once, each with its path", () => {
    expect(
      problems(
        { type: "submit", id: "c1", requestId: 4, input: { kind: "message" }, extra: true },
        "client",
      ),
    ).toEqual([
      { path: "agent", message: "is required" },
      { path: "extra", message: "is not a known field" },
      { path: "requestId", message: "must be a string (got 4)" },
      { path: "input.text", message: "is required" },
    ]);
  });

  it("refuses an unknown input kind and event kind", () => {
    expect(
      problems(
        { type: "submit", id: "c1", agent: "a", requestId: "r", input: { kind: "fax" } },
        "client",
      ),
    ).toEqual([{ path: "input.kind", message: 'must be one of "message", "ticket" (got "fax")' }]);
    expect(
      problems({ type: "event", requestId: "r", seq: 1, event: { kind: "noise" } }, "server")[0],
    ).toEqual({
      path: "event.kind",
      message:
        'must be one of "text_delta", "tool_start", "tool_end", "approval_requested", "approval_decided", "settled" (got "noise")',
    });
  });

  it("checks enums, numbers and error codes", () => {
    expect(
      problems({ type: "approve", id: "c1", approvalId: "a", decision: "maybe" }, "client"),
    ).toEqual([{ path: "decision", message: 'must be one of "approve", "decline" (got "maybe")' }]);
    expect(
      problems({ type: "subscribe", id: "c1", requestId: "r", afterSeq: -1 }, "client"),
    ).toEqual([{ path: "afterSeq", message: "must be at least 0 (got -1)" }]);
    expect(problems({ type: "error", code: "oops", message: "x" }, "server")[0]?.path).toBe("code");
  });
});

describe("types", () => {
  it("narrows an event message on its kind", () => {
    const message: EventMessage = {
      type: "event",
      requestId: "r1",
      seq: 1,
      event: { kind: "settled", status: "done", answer: "Done." },
    };
    const answer = message.event.kind === "settled" ? message.event.answer : undefined;
    expect(answer).toBe("Done.");
  });
});

describe("quoting a sender's values", () => {
  it("cuts a long value short, so the error stays small", () => {
    const [problem] = problems({ type: "x".repeat(10_000), id: "c1" }, "client");
    expect(problem?.message.length).toBeLessThan(300);
    expect(problem?.message).toContain('(got "xxxxxxxx');
    expect(problem?.message).toContain("…)");
  });
});

describe("replyId", () => {
  it("returns the message's id only when it is a valid one", () => {
    expect(replyId({ id: "c1" })).toBe("c1");
    expect(replyId({ id: "" })).toBeUndefined();
    expect(replyId({ id: "x".repeat(257) })).toBeUndefined();
    expect(replyId({ id: 7 })).toBeUndefined();
    expect(replyId(null)).toBeUndefined();
    expect(replyId([1])).toBeUndefined();
  });
});

describe("invalidMessage", () => {
  it("builds the invalid_message error listing every problem", () => {
    const result = validateMessage({ type: "submit", id: "c9" }, "client");
    if (result.ok) throw new Error("expected problems");
    const error: ErrorMessage = invalidMessage(result.problems, "c9");
    expect(error).toEqual({
      type: "error",
      id: "c9",
      code: "invalid_message",
      message:
        "The message has 3 problems: agent: is required; requestId: is required; input: is required",
      problems: result.problems,
    });
    expect(problems(error, "server")).toEqual([]);
  });

  it("leaves the id out when the message had none", () => {
    expect(invalidMessage([{ path: "", message: "must be an object (got 1)" }])).toEqual({
      type: "error",
      code: "invalid_message",
      message: "The message has 1 problem: must be an object (got 1)",
      problems: [{ path: "", message: "must be an object (got 1)" }],
    });
  });
});

describe("scopedRequestId", () => {
  it("scopes a request id to its principal, so a slash in an id cannot make two collide", () => {
    expect(scopedRequestId({ id: "ada" }, "r1")).toBe("ada/r1");
    expect(scopedRequestId({ id: "a/b" }, "c")).not.toBe(scopedRequestId({ id: "a" }, "b/c"));
  });

  it("stays within the id limit for the longest ids, the same way every time", () => {
    // 256 characters each, and every one of the principal's grows when URI-encoded.
    const principal = { id: "é".repeat(256) };
    const requestId = "r".repeat(256);
    const scoped = scopedRequestId(principal, requestId);
    expect(scoped.length).toBeLessThanOrEqual(256);
    expect(scopedRequestId(principal, requestId)).toBe(scoped);
    // Still one key per principal and request, and never a key a short pair could have.
    expect(scopedRequestId(principal, `${"r".repeat(255)}s`)).not.toBe(scoped);
    expect(scopedRequestId({ id: "e".repeat(256) }, requestId)).not.toBe(scoped);
    expect(scoped).not.toContain("/");
    // The runtime's own frames carrying it validate.
    expect(
      validateMessage(
        { type: "accepted", id: "g1", requestId: scoped, disposition: "started" },
        "server",
      ).ok,
    ).toBe(true);
    // An id that fits is left as it is, right up to the limit.
    const fits = scopedRequestId({ id: "a".repeat(127) }, "r".repeat(128));
    expect(fits).toBe(`${"a".repeat(127)}/${"r".repeat(128)}`);
    expect(fits).toHaveLength(256);
  });
});

describe("handshake", () => {
  it("welcomes version 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(handshake({ type: "hello", version: 1, client: "web" }, "office-1")).toEqual({
      type: "welcome",
      version: 1,
      serverId: "office-1",
    });
  });

  it.each([0, 2.5, "2", null])("refuses version %j with unsupported_version", (version) => {
    const hello = { type: "hello", version, client: "web" };
    const checked = validateMessage(hello, "client");
    if (!checked.ok || checked.message.type !== "hello") throw new Error("expected a hello");
    expect(handshake(checked.message, "office-1")).toMatchObject({ code: "unsupported_version" });
  });

  it("refuses version 2 with unsupported_version", () => {
    const hello = { type: "hello", version: 2, client: "web" } as const;
    expect(problems(hello, "client")).toEqual([]);
    const reply: Message = handshake(hello, "office-1");
    expect(reply).toEqual({
      type: "error",
      code: "unsupported_version",
      message: "This server speaks Gateway Protocol version 1; the client asked for version 2.",
    });
  });
});

it("lists every error code from the spec", () => {
  expect(ERROR_CODES).toEqual([
    "bad_frame",
    "frame_too_large",
    "unsupported_version",
    "invalid_message",
    "unknown_agent",
    "unauthorized",
    "forbidden",
    "not_found",
    "conflict",
    "busy",
    "internal",
  ]);
});
