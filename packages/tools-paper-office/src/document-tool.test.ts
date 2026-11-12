/**
 * The reply bound the typed tools share: a body that does not fit is trimmed in a fixed order, at the
 * level each field really lives at, and a body that still does not fit is not passed off as a success.
 */

import { describe, expect, it } from "vitest";
import { boundedReply, type ReplyTrim } from "./document-tool.js";

interface Result {
  readonly operation: string;
  readonly lines: readonly string[];
  readonly evidence: string;
  readonly kept: string;
}

const trim: ReplyTrim<Result> = {
  maxText: 600,
  reductions: [{ omits: ["the lines"], apply: (result) => ({ ...result, lines: [] }) }],
  resultKeys: ["evidence"],
};

function compose(result: Result): Record<string, unknown> {
  return { ok: true, result, wrote: [{ fileId: "file" }], worker: "w".repeat(80), notes: [] };
}

const small: Result = { operation: "edit", lines: ["a"], evidence: "e", kept: "k" };

describe("the bounded reply", () => {
  it("returns a body that fits untouched", () => {
    const reply = boundedReply(compose, small, trim);
    expect(reply?.truncated).toBe(false);
    expect(JSON.parse(reply?.text ?? "{}")).toEqual(compose(small));
  });

  it("applies the reductions first and names what they left out", () => {
    const reply = boundedReply(compose, { ...small, lines: Array(60).fill("line of text") }, trim);
    const body = JSON.parse(reply?.text ?? "{}") as Record<string, unknown>;
    expect(reply?.truncated).toBe(true);
    expect(body.omitted).toEqual(["the lines"]);
    expect(body.result).toEqual({ ...small, lines: [] });
    expect(body.worker).toBeDefined();
  });

  it("drops a field of the result from the result, where it lives", () => {
    const reply = boundedReply(compose, { ...small, evidence: "e".repeat(700) }, trim);
    const body = JSON.parse(reply?.text ?? "{}") as Record<string, unknown>;
    expect(body.result).toEqual({ operation: "edit", lines: [], kept: "k" });
    expect(body.omitted).toEqual(["the lines", "result.evidence"]);
    // Nothing beside the result had to go: the oversized field was found and dropped.
    expect(body.worker).toBeDefined();
    expect(body.wrote).toBeDefined();
    expect(body.truncated).toBe(true);
  });

  it("then drops the receipt fields beside the result, and says so", () => {
    const cramped = { ...trim, maxText: 260 };
    const reply = boundedReply(compose, { ...small, kept: "k".repeat(60) }, cramped);
    const body = JSON.parse(reply?.text ?? "{}") as Record<string, unknown>;
    expect(body.omitted).toEqual(["the lines", "result.evidence", "notes", "worker"]);
    expect(body.wrote).toBeDefined();
  });

  it("answers nothing when what must stay does not fit, so the caller can refuse", () => {
    expect(boundedReply(compose, { ...small, kept: "k".repeat(700) }, trim)).toBeUndefined();
  });
});
