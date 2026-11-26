/**
 * OCR with the network shut, for `src/ocr.test.ts`. Run as
 * `node --import ./no-network.mjs ocr-child.mjs <mode> [image]`:
 *
 *   probe  starts a worker thread and prints which network doors were shut in it
 *   ocr    reads the image with the package's compiled `ocrImages` and prints the text
 *
 * It loads the compiled module because this is a plain `node` process; `npm run check` builds first.
 */

import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

const [mode, image] = process.argv.slice(2);

if (mode === "probe") {
  const worker = new Worker(new URL("./probe-worker.mjs", import.meta.url));
  worker.once("message", (blocked) => {
    process.stdout.write(JSON.stringify({ blocked }));
    void worker.terminate();
  });
} else {
  const { ocrImages } = await import(new URL("../../dist/ocr.js", import.meta.url).href);
  const [page] = await ocrImages([new Uint8Array(readFileSync(image))]);
  process.stdout.write(JSON.stringify({ text: page.text }));
}
