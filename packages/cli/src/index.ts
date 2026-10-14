#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { interruptCli, runCli } from "./cli.js";

const io = {
  output: (line: string) => console.log(line),
  error: (line: string) => console.error(line),
  readApproval: async (prompt: string) => {
    if (!stdin.isTTY) return undefined;
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      return await readline.question(prompt);
    } finally {
      readline.close();
    }
  },
};

let interrupted = false;
process.once("SIGINT", () => {
  interrupted = true;
  void interruptCli();
});
const code = await runCli(process.argv.slice(2), io);
process.exitCode = interrupted ? 130 : code;
