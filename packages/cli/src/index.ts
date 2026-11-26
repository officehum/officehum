#!/usr/bin/env node
import { stderr, stdin, stdout } from "node:process";
import { interruptCli, runCli } from "./cli.js";
import { createTerminalIo, type TerminalInterrupt, terminalExitCode } from "./terminal-io.js";

let terminalInterrupt: TerminalInterrupt | undefined;
const io = createTerminalIo({
  input: stdin,
  output: stdout,
  error: stderr,
  onInterrupt: (kind) => {
    terminalInterrupt = kind;
  },
});
process.once("SIGINT", () => {
  terminalInterrupt = "sigint";
  void interruptCli();
});
const code = await runCli(process.argv.slice(2), io);
process.exitCode = terminalExitCode(code, terminalInterrupt);
