#!/usr/bin/env node
/**
 * The `officehum-role` binary: arguments in, exit code out. All of its logic is in `command.ts`, so the
 * command can be run from a test without a process behind it.
 */

import { stderr, stdout } from "node:process";
import { runCli } from "./command.js";

process.exitCode = runCli(process.argv.slice(2), {
  out: (line) => stdout.write(`${line}\n`),
  err: (line) => stderr.write(`${line}\n`),
});
