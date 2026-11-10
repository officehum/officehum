import { describe, expect, it } from "vitest";
import { encode, type Frame, LineDecoder, MAX_FRAME_BYTES } from "./framing.js";

const bytes = (text: string) => new TextEncoder().encode(text);

function values(frames: readonly Frame[]): unknown[] {
  return frames.map((frame) => (frame.ok ? frame.value : frame));
}

describe("encode", () => {
  it("writes one message per line", () => {
    const line = encode({ type: "ping", id: "1" });
    expect(line).toBe('{"type":"ping","id":"1"}\n');
    expect(line.indexOf("\n")).toBe(line.length - 1);
  });
});

describe("LineDecoder", () => {
  it("decodes several messages from one chunk", () => {
    const decoder = new LineDecoder();
    const frames = decoder.push(encode({ n: 1 }) + encode({ n: 2 }));
    expect(values(frames)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("keeps U+2028, U+2029 and CR inside a string on one line", () => {
    const text = "a b c\rd";
    const decoder = new LineDecoder();
    const frames = decoder.push(encode({ text }));
    expect(values(frames)).toEqual([{ text }]);
  });

  it("does not split on a raw U+2028, U+2029 or a lone CR between messages", () => {
    const decoder = new LineDecoder();
    // Raw separators outside a string are JSON whitespace only for CR; the point is that none of
    // them ends a frame, so the line is parsed whole.
    const frames = decoder.push('{"a":1}\r\n{"b":"x y"}\n');
    expect(values(frames)).toEqual([{ a: 1 }, { b: "x y" }]);
  });

  it("reassembles a line split across three chunks, including mid-character", () => {
    const message = { text: "café ☕ done" };
    const encoded = bytes(encode(message));
    // Split inside the three-byte ☕ so the decoder must carry partial UTF-8 across chunks.
    const cup = encoded.indexOf(0xe2);
    const decoder = new LineDecoder();
    expect(decoder.push(encoded.slice(0, 5))).toEqual([]);
    expect(decoder.push(encoded.slice(5, cup + 1))).toEqual([]);
    expect(values(decoder.push(encoded.slice(cup + 1)))).toEqual([message]);
  });

  it("joins a character split between two string chunks", () => {
    const line = encode({ text: "😀" });
    const half = line.indexOf("😀") + 1;
    const decoder = new LineDecoder();
    expect(decoder.push(line.slice(0, half))).toEqual([]);
    expect(values(decoder.push(line.slice(half)))).toEqual([{ text: "😀" }]);
    const cut = new LineDecoder();
    cut.push(line.slice(0, half));
    expect(cut.end()).toEqual([
      { ok: false, code: "bad_frame", message: expect.stringContaining("ended") },
    ]);
  });

  it("refuses a line over the limit with frame_too_large and recovers at the next line", () => {
    const decoder = new LineDecoder({ maxFrameBytes: 16 });
    const frames = [
      ...decoder.push('{"text":"0123456'),
      ...decoder.push('789abcdef"}\n{"ok":1}\n'),
    ];
    expect(frames).toEqual([
      { ok: false, code: "frame_too_large", message: expect.stringContaining("16 bytes") },
      { ok: true, value: { ok: 1 } },
    ]);
  });

  it("refuses a line over 8 MiB by default", () => {
    const decoder = new LineDecoder();
    const frames = decoder.push(`"${"x".repeat(MAX_FRAME_BYTES)}"\n`);
    expect(frames).toEqual([
      { ok: false, code: "frame_too_large", message: expect.stringContaining("8388608 bytes") },
    ]);
  });

  it("reports a line that is not JSON as bad_frame and keeps going", () => {
    const decoder = new LineDecoder();
    const frames = decoder.push('not json\n{"ok":1}\n');
    expect(frames).toEqual([
      { ok: false, code: "bad_frame", message: expect.stringContaining("not valid JSON") },
      { ok: true, value: { ok: 1 } },
    ]);
  });

  it("skips blank lines", () => {
    const decoder = new LineDecoder();
    expect(values(decoder.push('\n\r\n{"ok":1}\n'))).toEqual([{ ok: 1 }]);
  });

  it("reports an unterminated last line at end as bad_frame", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"ok":1}')).toEqual([]);
    expect(decoder.end()).toEqual([
      { ok: false, code: "bad_frame", message: expect.stringContaining("ended") },
    ]);
    expect(new LineDecoder().end()).toEqual([]);
  });
});
