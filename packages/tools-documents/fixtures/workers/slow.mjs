/**
 * A parser that takes `delayMs` (from the job) and answers with one page saying when it started and
 * finished, so a test can see which reads ran at the same time.
 */

import { parentPort, workerData } from "node:worker_threads";

const started = Date.now();
await new Promise((resolve) => setTimeout(resolve, workerData.delayMs ?? 200));
parentPort.postMessage({
  ok: true,
  op: "read",
  text: [JSON.stringify({ started, finished: Date.now() })],
  info: {},
});
