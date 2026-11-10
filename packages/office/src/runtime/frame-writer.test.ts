import { PassThrough, Writable } from "node:stream";
import { LineDecoder } from "@officehum/protocol";
import { describe, expect, it } from "vitest";
import { FrameWriter } from "./frame-writer.js";

function frames(stream: PassThrough): unknown[] {
  const decoder = new LineDecoder();
  const out: unknown[] = [];
  stream.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) out.push(frame.ok ? frame.value : frame);
  });
  return out;
}

describe("FrameWriter", () => {
  it("writes every frame queued in one tick, after a pump that finished at once", async () => {
    const output = new PassThrough();
    const received = frames(output);
    const writer = new FrameWriter(output, () => {});
    writer.write({ n: 1 });
    // The first pump wrote everything without waiting; these must not be stranded behind it.
    writer.write({ n: 2 });
    writer.write({ n: 3 });
    await writer.flush();
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("waits for drain instead of blocking, and keeps order", async () => {
    const chunks: string[] = [];
    let release: () => void = () => {};
    const slow = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        release = callback;
      },
    });
    const writer = new FrameWriter(slow, () => {});
    writer.write({ n: 1 });
    writer.write({ n: 2 });
    expect(chunks).toEqual(['{"n":1}\n']);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await writer.flush();
    expect(chunks.join("")).toBe('{"n":1}\n{"n":2}\n');
  });

  it("stops waiting when the stream closes without draining, and bounds the final flush", async () => {
    const log: string[] = [];
    const stalled = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {
        // Never calls back: the reader stopped.
      },
    });
    const writer = new FrameWriter(stalled, (line) => log.push(line));
    writer.write({ n: 1 });
    writer.write({ n: 2 });
    expect(await writer.flush(20)).toBe(false);
    expect(log.at(-1)).toContain("Gave up waiting");
    stalled.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    await writer.flush();
    expect(log.some((line) => line.includes("the output closed"))).toBe(true);
  });

  it("reports a broken stream once and drops the rest", async () => {
    const log: string[] = [];
    const broken = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("EPIPE"));
      },
    });
    const writer = new FrameWriter(broken, (line) => log.push(line));
    writer.write({ n: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    writer.write({ n: 2 });
    await writer.flush();
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("EPIPE");
  });
});
