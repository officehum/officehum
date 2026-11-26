/**
 * The PDF parser's own thread. pdf.js (through `unpdf`) runs here, never on the host's event loop, so
 * a crafted file that spins or swallows memory takes this thread down and nothing else: the host
 * (`pdf.ts`) terminates it at the time limit, and `resourceLimits` ends it at the memory limit.
 *
 * One job per thread: the host starts a thread for a read, takes the one answer it posts and
 * terminates it. The job arrives as `workerData`, so nothing of an earlier document is ever in scope.
 *
 * This file imports nothing from the package: under the tests Node runs it from `src/` by stripping
 * its types, which needs every relative import to name a `.ts` file, while `dist/` needs `.js`.
 * Messages are built by the host from the structured answer, so their wording lives in one place.
 */

import { parentPort, workerData } from "node:worker_threads";
import { extractText, getDocumentProxy, renderPageAsImage } from "unpdf";

export type PdfJob =
  | { readonly op: "read"; readonly bytes: Uint8Array; readonly maxPages: number }
  | { readonly op: "render"; readonly bytes: Uint8Array; readonly pages: readonly number[] };

export type PdfAnswer =
  | {
      readonly ok: true;
      readonly op: "read";
      /** Each page's text as pdf.js extracted it, untrimmed. */
      readonly text: readonly string[];
      /** The document information dictionary's string entries the reading keeps. */
      readonly info: Readonly<Record<string, string>>;
    }
  | { readonly ok: true; readonly op: "render"; readonly images: readonly Uint8Array[] }
  | { readonly ok: false; readonly failure: "malformed"; readonly errorName: string }
  | { readonly ok: false; readonly failure: "too-many-pages"; readonly pages: number };

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

const INFO_KEYS = ["Title", "Author", "Subject", "Creator", "Producer", "CreationDate"];

async function run(job: PdfJob): Promise<PdfAnswer> {
  let pdf: PdfDocument;
  try {
    pdf = await getDocumentProxy(job.bytes);
  } catch (error) {
    return { ok: false, failure: "malformed", errorName: nameOf(error) };
  }
  try {
    if (job.op === "render") {
      const images: Uint8Array[] = [];
      for (const page of job.pages) {
        // Scale 2 puts an A4 page at about 1190 by 1684 pixels, enough for Tesseract to read 10 pt type.
        const png = await renderPageAsImage(pdf, page, {
          canvasImport: () => import("@napi-rs/canvas"),
          scale: 2,
        });
        images.push(new Uint8Array(png));
      }
      return { ok: true, op: "render", images };
    }
    if (pdf.numPages > job.maxPages) {
      return { ok: false, failure: "too-many-pages", pages: pdf.numPages };
    }
    const { text } = await extractText(pdf, { mergePages: false });
    const raw = (await pdf.getMetadata().catch(() => undefined))?.info as
      | Record<string, unknown>
      | undefined;
    const info: Record<string, string> = {};
    for (const key of INFO_KEYS) {
      const value = raw?.[key];
      if (typeof value === "string") info[key] = value;
    }
    return { ok: true, op: "read", text, info };
  } catch (error) {
    return { ok: false, failure: "malformed", errorName: nameOf(error) };
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

const answer = await run(workerData as PdfJob);
const transfer =
  answer.ok && answer.op === "render" ? answer.images.map((image) => image.buffer) : [];
parentPort?.postMessage(answer, transfer as ArrayBuffer[]);
