/**
 * Shuts every network door in the thread that loads it: `fetch`, `http`, `https`, `net`, `tls` and
 * DNS. Preloaded with `node --import`, which Node also runs in every worker thread the process starts,
 * so it covers tesseract.js's worker as well as the main thread (`probe-worker.mjs` proves that).
 *
 * Each attempt is written to stderr as `NETWORK ATTEMPT` before it throws, so a caller that swallows
 * the error still leaves evidence.
 */

import dns from "node:dns";
import { writeSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

function refuse(what) {
  return () => {
    writeSync(2, `NETWORK ATTEMPT ${what}\n`);
    throw new Error(`network access is disabled in this test (${what})`);
  };
}

globalThis.fetch = refuse("fetch");
for (const [name, module] of [
  ["http", http],
  ["https", https],
]) {
  module.request = refuse(`${name}.request`);
  module.get = refuse(`${name}.get`);
}
net.connect = refuse("net.connect");
net.createConnection = refuse("net.createConnection");
net.Socket.prototype.connect = refuse("net.Socket.connect");
tls.connect = refuse("tls.connect");
dns.lookup = refuse("dns.lookup");
dns.promises.lookup = refuse("dns.promises.lookup");
