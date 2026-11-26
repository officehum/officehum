#!/usr/bin/env node
/**
 * The `officehum-role` binary: arguments in, exit code out. All of its logic is in `command.ts`, so the
 * commands can be run from a test without a process behind it — including `interview`, which asks
 * through the terminal built here and passed in as the io it is.
 */

import { stderr, stdout } from "node:process";
import { runOfficehumRole } from "./command.js";
import { terminalIO } from "./interview.js";

process.exitCode = await runOfficehumRole(
  process.argv.slice(2),
  {
    out: (line) => stdout.write(`${line}\n`),
    err: (line) => stderr.write(`${line}\n`),
  },
  terminalIO,
);
