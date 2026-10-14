import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { CliIo } from "./cli.js";

export type TerminalInterrupt = "eof" | "sigint";

export function terminalExitCode(code: number, interrupt: TerminalInterrupt | undefined): number {
  return interrupt === "sigint" ? 130 : code;
}

interface QuestionReader {
  question(prompt: string): Promise<string>;
  close(): void;
}

export interface TerminalIoOptions {
  readonly input: Readable & { readonly isTTY?: boolean };
  readonly output: Writable;
  readonly error: Writable;
  readonly onInterrupt: (kind: TerminalInterrupt) => void;
  readonly open?: (options: { input: Readable; output: Writable }) => QuestionReader;
}

function interruption(error: unknown): TerminalInterrupt | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.message === "Aborted with Ctrl+D") return "eof";
  if (error.message === "Aborted with Ctrl+C") return "sigint";
  return undefined;
}

export function createTerminalIo(options: TerminalIoOptions): CliIo {
  return {
    output: (line) => options.output.write(`${line}\n`),
    error: (line) => options.error.write(`${line}\n`),
    readApproval: async (prompt) => {
      if (!options.input.isTTY) return undefined;
      const reader = (options.open ?? createInterface)({
        input: options.input,
        output: options.output,
      });
      try {
        return await reader.question(prompt);
      } catch (error) {
        const kind = interruption(error);
        if (kind === undefined) throw error;
        options.onInterrupt(kind);
        return undefined;
      } finally {
        reader.close();
      }
    },
  };
}
