/** Runs in a worker thread and reports whether the network guard reached it. */

import net from "node:net";
import { parentPort } from "node:worker_threads";

const blocked = [];
try {
  await fetch("https://example.com/");
} catch (error) {
  blocked.push(String(error.message).includes("disabled") ? "fetch" : `fetch: ${error.message}`);
}
try {
  net.connect(443, "example.com");
} catch (error) {
  blocked.push(String(error.message).includes("disabled") ? "net" : `net: ${error.message}`);
}
parentPort.postMessage(blocked);
