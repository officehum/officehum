/**
 * PDF through `unpdf` (pdf.js): text per page. Table detection by layout is out of scope, so a
 * table in a PDF arrives as its page's text. A page with no text at all is reported, because it is
 * almost always a scan: `renderPdfPages` turns it into a picture for OCR (`scan.ts`).
 *
 * pdf.js never runs on the caller's event loop. Each read starts a worker thread
 * (`pdf-worker.ts`) with a heap limit, under a cap on reads at once, and terminates it at the time
 * limit. A crafted file that spins or swallows memory ends its own read with the plain refusal; the
 * runtime, its timers and every other read carry on.
 */

import { Worker } from "node:worker_threads";
import type { PdfAnswer, PdfJob } from "./pdf-worker.js";
import {
  type DocumentReading,
  lowerReadingLimits,
  ReadingError,
  type ReadingLimits,
  timeoutError,
} from "./reading.js";

/**
 * The worker beside this module: `dist/pdf-worker.js` when built. The tests run this module from
 * `src/pdf.ts`, and Node then runs `src/pdf-worker.ts` itself by stripping its types.
 */
const WORKER_SCRIPT = new URL(
  import.meta.url.endsWith(".ts") ? "./pdf-worker.ts" : "./pdf-worker.js",
  import.meta.url,
);

/** The refusal for a PDF pdf.js could not read, or whose reader stopped before answering. */
function unreadable(name: string, reason: string): ReadingError {
  return new ReadingError(
    "malformed",
    `${name} is not a readable PDF (${reason}). Ask for an undamaged copy.`,
  );
}

export interface PdfPool {
  /**
   * Runs `job` in a new worker thread once fewer than `limits.pdfConcurrentReads` are running. Time
   * spent waiting counts against `limits.timeoutMs`. Refuses with `timeout` when the time runs out
   * (the thread is terminated) and with `malformed` when the thread runs out of heap or stops.
   */
  run(job: PdfJob, limits: ReadingLimits, name: string): Promise<PdfAnswer>;
  /** Settles once no thread of this pool is running and none is waiting. */
  idle(): Promise<void>;
}

/** A pool over one worker script. The package keeps one for the process; tests make their own. */
export function createPdfPool(script: URL): PdfPool {
  let running = 0;
  const waiting: { readonly cap: number; readonly start: () => void }[] = [];
  let idlers: (() => void)[] = [];

  const admit = (): void => {
    for (let next = waiting[0]; next !== undefined && running < next.cap; next = waiting[0]) {
      waiting.shift();
      running += 1;
      next.start();
    }
    if (running === 0 && waiting.length === 0) {
      for (const resolve of idlers) resolve();
      idlers = [];
    }
  };

  const start = (
    job: PdfJob,
    limits: ReadingLimits,
    name: string,
    deadline: number,
    resolve: (answer: PdfAnswer) => void,
    reject: (error: ReadingError) => void,
  ): void => {
    let worker: Worker;
    try {
      worker = new Worker(script, {
        workerData: job,
        resourceLimits: { maxOldGenerationSizeMb: limits.pdfMemoryMb },
      });
    } catch {
      // No thread started (no memory for one, or the script is missing): free the slot it held.
      reject(unreadable(name, "the reader could not start"));
      running -= 1;
      queueMicrotask(admit);
      return;
    }
    let settled = false;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
      void worker.terminate().catch(() => undefined);
    };
    const timer = setTimeout(
      () => settle(() => reject(timeoutError(name, limits))),
      Math.max(0, deadline - Date.now()),
    );
    worker.once("message", (answer: PdfAnswer) => settle(() => resolve(answer)));
    worker.once("error", (error: Error & { code?: string }) =>
      settle(() =>
        reject(
          unreadable(
            name,
            error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "out of memory" : "the reader stopped",
          ),
        ),
      ),
    );
    // The slot is free only once the thread is gone, so the cap counts live threads.
    worker.once("exit", () => {
      settle(() => reject(unreadable(name, "the reader stopped")));
      running -= 1;
      admit();
    });
  };

  return {
    run(job, given, name) {
      const limits = lowerReadingLimits(given);
      const deadline = Date.now() + limits.timeoutMs;
      return new Promise<PdfAnswer>((resolve, reject) => {
        const entry = {
          cap: limits.pdfConcurrentReads,
          start: () => {
            clearTimeout(expiry);
            start(job, limits, name, deadline, resolve, reject);
          },
        };
        // A read still queued when its time runs out is refused and never started.
        const expiry = setTimeout(() => {
          const at = waiting.indexOf(entry);
          if (at === -1) return;
          waiting.splice(at, 1);
          reject(timeoutError(name, limits));
          admit();
        }, limits.timeoutMs);
        waiting.push(entry);
        admit();
      });
    },
    idle() {
      if (running === 0 && waiting.length === 0) return Promise.resolve();
      return new Promise((resolve) => idlers.push(resolve));
    },
  };
}

const pool = createPdfPool(WORKER_SCRIPT);

async function runPdf(job: PdfJob, limits: ReadingLimits, name: string): Promise<PdfAnswer> {
  const answer = await pool.run(job, limits, name);
  if (answer.ok) return answer;
  if (answer.failure === "too-many-pages") {
    throw new ReadingError(
      "too-many-pages",
      `${name} has ${answer.pages} pages, over the ${limits.maxPages} a document may have. ` +
        "Ask for the pages that matter as a separate file.",
    );
  }
  throw unreadable(name, answer.errorName);
}

/**
 * Renders the given pages (numbered from 1) to PNG, for OCR and for a model that reads images. Scale 2
 * puts an A4 page at about 1190 by 1684 pixels, enough for Tesseract to read 10 pt type.
 */
export async function renderPdfPages(
  bytes: Uint8Array,
  name: string,
  pageNumbers: readonly number[],
  limits: Partial<ReadingLimits> = {},
): Promise<Uint8Array[]> {
  const answer = await runPdf(
    { op: "render", bytes, pages: [...pageNumbers] },
    lowerReadingLimits(limits),
    name,
  );
  return answer.ok && answer.op === "render" ? [...answer.images] : [];
}

export async function readPdf(
  bytes: Uint8Array,
  name: string,
  limits: ReadingLimits,
): Promise<DocumentReading> {
  const answer = await runPdf({ op: "read", bytes, maxPages: limits.maxPages }, limits, name);
  if (!answer.ok || answer.op !== "read") throw unreadable(name, "the reader stopped");
  const pages = answer.text.map((pageText, index) => {
    const clean = pageText.trim();
    return { number: index + 1, text: clean, hasText: clean !== "" };
  });
  const metadata: Record<string, string | number | boolean | null> = { pages: pages.length };
  for (const [key, value] of Object.entries(answer.info)) {
    if (value.trim() !== "") metadata[key.toLowerCase()] = value;
  }
  return {
    kind: "pdf",
    pages,
    tables: [],
    metadata,
    hasTextLayer: pages.every((page) => page.hasText),
  };
}
