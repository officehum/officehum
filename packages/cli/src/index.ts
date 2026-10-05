#!/usr/bin/env node
/**
 * @officehum/cli — M0 scaffold. Commands (start, board, watch, steer) land in RASF-3068.
 */
import { PI_DURABLE_VERSION } from "@officehum/office";

const [command] = process.argv.slice(2);

if (command === "--version" || command === "-v") {
  console.log(`officehum 0.0.0 (Pi Durable ${PI_DURABLE_VERSION})`);
} else {
  console.log("officehum: nothing to run yet. Commands arrive in milestone M1.");
}
