/**
 * One live extraction run against the owner's model: Paper's Ultramarine 1 Flash through
 * `@officehum/provider-paper`. Not a test; it calls the real API and costs money.
 *
 * With PAPERINSTRUMENTS_API_KEY exported in the environment (never typed on the command line):
 *
 *     npm run build
 *     node packages/tools-documents/scripts/live-extract.mjs \
 *       vendor_bill text-bill.pdf bill-wrong-total.pdf
 *
 * Arguments: the kind (`vendor_bill`, `receipt` or `customer_invoice`), then file names in
 * `fixtures/` (or paths). For each file it prints the status, every check with its result and
 * message, and the model call's tokens and cost as the provider reported them; a refusal prints its
 * code and message. The key is read by the provider from the environment at the point of use and is
 * never printed. Ultramarine 1 Flash reads text only, so scans and photos are refused
 * (`model-not-vision`); PDFs with a text layer are extracted.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { PAPER_MODEL_REF, paperProvider } from "@officehum/provider-paper";
import { EXTRACTION_KINDS, extractDocument } from "@officehum/tools-documents";

const MIME = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

const [kind, ...files] = process.argv.slice(2);
if (!EXTRACTION_KINDS.includes(kind) || files.length === 0) {
  console.error(`usage: live-extract.mjs <${EXTRACTION_KINDS.join("|")}> <file>...`);
  process.exit(2);
}
if ((process.env.PAPERINSTRUMENTS_API_KEY ?? "") === "") {
  console.error("Set PAPERINSTRUMENTS_API_KEY in the environment; the provider reads it there.");
  process.exit(2);
}

const models = createModels();
models.setProvider(paperProvider());
const extraction = { models, model: PAPER_MODEL_REF };
let failures = 0;

for (const file of files) {
  const path = existsSync(file) ? file : new URL(`../fixtures/${file}`, import.meta.url);
  const name = basename(String(file));
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  console.log(`\n== ${name} (${kind})`);
  const started = Date.now();
  try {
    const result = await extractDocument(
      { bytes: readFileSync(path), mimeType: MIME[extension] ?? "application/octet-stream", name },
      kind,
      extraction,
    );
    console.log(`status: ${result.status} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    for (const check of result.checks) {
      console.log(
        `  ${check.result === "pass" ? "pass" : "FAIL"}  ${check.name}: ${check.message}`,
      );
    }
    const { usage } = result;
    console.log(
      `usage: ${usage.input} in, ${usage.output} out, ${usage.totalTokens} total tokens; ` +
        `cost ${usage.cost.total.toFixed(6)} (${usage.cost.totalFromProvider === true ? "billed, from the provider" : "catalog estimate"})`,
    );
  } catch (error) {
    failures += 1;
    const code = typeof error?.code === "string" ? error.code : "error";
    console.log(
      `refused (${code}) after ${((Date.now() - started) / 1000).toFixed(1)} s: ${error?.message ?? error}`,
    );
  }
}
process.exitCode = failures === 0 ? 0 : 1;
