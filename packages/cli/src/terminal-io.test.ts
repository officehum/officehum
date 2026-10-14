import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createTerminalIo, terminalExitCode } from "./terminal-io.js";

function terminal() {
  return Object.assign(new PassThrough(), { isTTY: true });
}

describe("terminal approval input", () => {
  it("treats non-terminal input as EOF without opening readline", async () => {
    const stream = new PassThrough();
    const io = createTerminalIo({
      input: stream,
      output: stream,
      error: stream,
      onInterrupt: () => {},
      open: () => {
        throw new Error("readline should not open for piped input");
      },
    });
    await expect(io.readApproval("Approve? ")).resolves.toBeUndefined();
  });

  it.each([
    ["Aborted with Ctrl+D", "eof"],
    ["Aborted with Ctrl+C", "sigint"],
  ] as const)("translates %s into %s interruption", async (message, expected) => {
    const interruptions: string[] = [];
    let closed = false;
    const stream = terminal();
    const io = createTerminalIo({
      input: stream,
      output: stream,
      error: stream,
      onInterrupt: (kind) => interruptions.push(kind),
      open: () => ({
        question: async () => {
          throw new Error(message);
        },
        close: () => {
          closed = true;
        },
      }),
    });
    await expect(io.readApproval("Approve? ")).resolves.toBeUndefined();
    expect(interruptions).toEqual([expected]);
    expect(terminalExitCode(1, expected)).toBe(expected === "sigint" ? 130 : 1);
    expect(closed).toBe(true);
  });

  it("does not hide unrelated terminal I/O errors", async () => {
    const stream = terminal();
    const io = createTerminalIo({
      input: stream,
      output: stream,
      error: stream,
      onInterrupt: () => {},
      open: () => ({
        question: async () => {
          throw new Error("EIO: terminal disconnected unexpectedly");
        },
        close: () => {},
      }),
    });
    await expect(io.readApproval("Approve? ")).rejects.toThrow("EIO");
  });
});
