/**
 * PDF reading runs in its own worker thread. The parsers behind the worker boundary are
 * swapped for test doubles in `fixtures/workers/`: one that spins, one that eats its heap, one that
 * is slow. The ordinary fixtures go through the real worker and must read and render exactly as
 * pdf.js does in process on the same machine; their text, metadata and page sizes must also match
 * what `main` recorded (`fixtures/pdf-readings.json`).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extractText, getDocumentProxy, renderPageAsImage } from "unpdf";
import { describe, expect, it, vi } from "vitest";
import { createPdfPool, renderPdfPages } from "./pdf.js";
import type { PdfJob } from "./pdf-worker.js";
import { readDocument } from "./read-document.js";
import {
  DEFAULT_READING_LIMITS,
  type DocumentReading,
  lowerReadingLimits,
  MAX_CONCURRENT_PDF_READS,
  MAX_PDF_MEMORY_MB,
  ReadingError,
  type ReadingLimits,
} from "./reading.js";
import { FIXTURES, fixture } from "./test-helpers.js";

const WORKERS = new URL("workers/", FIXTURES);

function pool(script: string) {
  return createPdfPool(new URL(script, WORKERS));
}

function job(extra: Record<string, unknown> = {}): PdfJob {
  return { op: "read", bytes: new Uint8Array(8), maxPages: 500, ...extra } as PdfJob;
}

function limits(overrides: Partial<ReadingLimits>): ReadingLimits {
  return { ...DEFAULT_READING_LIMITS, ...overrides };
}

/**
 * What every machine agrees on, recorded on `main` before the move: the reading (text, page count,
 * metadata) and each rendered page's size in pixels. Rendered pixels themselves depend on the
 * platform's font rasterising, so those are compared with pdf.js run in process on this machine.
 */
interface Recorded {
  readonly reading: DocumentReading;
  /** Width and height of each page rendered at scale 2. */
  readonly pixels: readonly (readonly [number, number])[];
}

const recorded = JSON.parse(readFileSync(new URL("pdf-readings.json", FIXTURES), "utf8")) as Record<
  string,
  Recorded
>;

/** `main`'s in-process reader, kept here as the reference the worker must match on this machine. */
async function readInProcess(
  bytes: Uint8Array,
): Promise<{ reading: DocumentReading; images: Uint8Array[] }> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = text.map((pageText, index) => {
      const clean = pageText.trim();
      return { number: index + 1, text: clean, hasText: clean !== "" };
    });
    const info = (await pdf.getMetadata().catch(() => undefined))?.info as
      | Record<string, unknown>
      | undefined;
    const metadata: Record<string, string | number | boolean | null> = { pages: pages.length };
    for (const key of ["Title", "Author", "Subject", "Creator", "Producer", "CreationDate"]) {
      const value = info?.[key];
      if (typeof value === "string" && value.trim() !== "") metadata[key.toLowerCase()] = value;
    }
    const images: Uint8Array[] = [];
    for (const page of pages) {
      const png = await renderPageAsImage(pdf, page.number, {
        canvasImport: () => import("@napi-rs/canvas"),
        scale: 2,
      });
      images.push(new Uint8Array(png));
    }
    const reading: DocumentReading = {
      kind: "pdf",
      pages,
      tables: [],
      metadata,
      hasTextLayer: pages.every((page) => page.hasText),
    };
    return { reading, images };
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(png: Uint8Array): [number, number] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

describe("ordinary PDFs read exactly as they do in process", () => {
  for (const [name, before] of Object.entries(recorded)) {
    it(`${name}: the same reading and the same rendered pages`, async () => {
      const bytes = fixture(name);
      const reference = await readInProcess(bytes);
      const reading = await readDocument(bytes, "application/pdf", { name });
      expect(reading).toEqual(reference.reading);
      expect(reading).toEqual(before.reading);

      const pages = (reading.pages ?? []).map((page) => page.number);
      const images = await renderPdfPages(bytes, name, pages);
      expect(images.map(sha256)).toEqual(reference.images.map(sha256));
      expect(images.map(pngSize)).toEqual(before.pixels);
      // The caller keeps its bytes: the worker gets a copy.
      expect(bytes).toEqual(fixture(name));
    });
  }
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("a parser that never finishes", () => {
  // The limit's clock is controlled, so the machine's speed cannot decide the result: fake time
  // stands still until a real timer has fired and the ordinary read has finished, and only then
  // moves past the stuck read's limit. A parser spinning on this thread instead of its own would
  // block both, and the test would never get that far.
  it("is abandoned at the limit while another read and an unrelated timer are served", async () => {
    const spinning = pool("spin.mjs");
    const order: string[] = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const started = Date.now();
      // Caught at once, so its refusal is never an unhandled rejection while the clock moves.
      const stuck = spinning
        .run(job(), limits({ timeoutMs: 600 }), "stuck.pdf")
        .finally(() => order.push("stuck"))
        .catch((error: unknown) => error);
      const ordinary = readDocument(fixture("vendor-bill.pdf"), "application/pdf").finally(() =>
        order.push("ordinary"),
      );
      // setInterval stays real: an unrelated timer is served while the parser spins.
      let ticker: NodeJS.Timeout | undefined;
      await new Promise<void>((resolve) => {
        ticker = setInterval(resolve, 20);
      });
      clearInterval(ticker);

      expect((await ordinary).pages?.[2]?.text).toContain("Total due: 420.00 EUR");
      expect(order).toEqual(["ordinary"]);
      await vi.advanceTimersByTimeAsync(600);
      const refused = await stuck;
      expect(refused).toBeInstanceOf(ReadingError);
      expect(refused).toMatchObject({
        code: "timeout",
        message:
          "reading stuck.pdf took longer than 0.6 s, the limit per file. The file may be damaged " +
          "or unusually complex.",
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(600);
      expect(order).toEqual(["ordinary", "stuck"]);
    } finally {
      vi.useRealTimers();
    }
    // The terminated thread is gone: the pool is idle only after the thread's `exit`, which Node
    // emits once the thread has stopped and its resources are released. If it never goes, the
    // test's own time limit fails it.
    await spinning.idle();
  });
});

describe("a parser over the memory limit", () => {
  it("ends that read only, with the plain refusal, and the process reads on", async () => {
    const hog = pool("hog.mjs");
    const refused = await hog
      .run(job(), limits({ pdfMemoryMb: 16, timeoutMs: 20_000 }), "hog.pdf")
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ReadingError);
    expect(refused).toMatchObject({
      code: "malformed",
      message: "hog.pdf is not a readable PDF (out of memory). Ask for an undamaged copy.",
    });
    await hog.idle();
    const reading = await readDocument(fixture("vendor-bill.pdf"), "application/pdf");
    expect(reading.metadata.pages).toBe(3);
  });
});

describe("a parser that crashes", () => {
  it("is refused with the plain refusal", async () => {
    const refused = await pool("crash.mjs")
      .run(job(), DEFAULT_READING_LIMITS, "broken.pdf")
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: "malformed",
      message: "broken.pdf is not a readable PDF (the reader stopped). Ask for an undamaged copy.",
    });
  });
});

describe("a reader that cannot start", () => {
  it("is refused and gives its slot back", async () => {
    const missing = pool("no-such-worker.mjs");
    const capped = limits({ pdfConcurrentReads: 1 });
    for (const name of ["first.pdf", "second.pdf"]) {
      await expect(missing.run(job(), capped, name)).rejects.toMatchObject({ code: "malformed" });
    }
    await missing.idle();
  });
});

describe("the concurrency cap", () => {
  function times(answer: unknown): { started: number; finished: number } {
    const { text } = answer as { text: string[] };
    return JSON.parse(text[0] ?? "{}") as { started: number; finished: number };
  }

  it("queues reads over the cap and serves them as slots free", async () => {
    const slow = pool("slow.mjs");
    const reads = [1, 2, 3].map(() =>
      slow.run(job({ delayMs: 400 }), DEFAULT_READING_LIMITS, "slow.pdf"),
    );
    const [first, second, third] = (await Promise.all(reads)).map(times);
    if (first === undefined || second === undefined || third === undefined) throw new Error();
    // The first two ran side by side; the third waited for one of them.
    expect(second.started).toBeLessThan(first.finished);
    expect(third.started).toBeGreaterThanOrEqual(Math.min(first.finished, second.finished));
  });

  it("is lowered by a host, never raised", async () => {
    const slow = pool("slow.mjs");
    const one = await Promise.all(
      [1, 2].map(() =>
        slow.run(job({ delayMs: 200 }), limits({ pdfConcurrentReads: 1 }), "slow.pdf"),
      ),
    );
    const [a, b] = one.map(times);
    expect(b?.started).toBeGreaterThanOrEqual(a?.finished ?? Infinity);

    const raised = await Promise.all(
      [1, 2, 3].map(() =>
        slow.run(job({ delayMs: 300 }), limits({ pdfConcurrentReads: 50 }), "slow.pdf"),
      ),
    );
    const [x, y, z] = raised.map(times);
    expect(z?.started).toBeGreaterThanOrEqual(Math.min(x?.finished ?? 0, y?.finished ?? 0));
  });

  it("refuses a queued read whose time runs out before a slot frees, and never starts it", async () => {
    const slow = pool("slow.mjs");
    const capped = limits({ pdfConcurrentReads: 1 });
    const running = slow.run(job({ delayMs: 600 }), capped, "first.pdf");
    const queued = slow.run(job({ delayMs: 10 }), { ...capped, timeoutMs: 150 }, "second.pdf");
    await expect(queued).rejects.toMatchObject({ code: "timeout" });
    await expect(running).resolves.toMatchObject({ ok: true });
  });
});

describe("limits", () => {
  it("name their defaults and only ever go down", () => {
    expect(DEFAULT_READING_LIMITS).toMatchObject({
      pdfMemoryMb: MAX_PDF_MEMORY_MB,
      pdfConcurrentReads: MAX_CONCURRENT_PDF_READS,
    });
    expect(
      lowerReadingLimits({ maxBytes: 1, maxPages: 1e9, timeoutMs: 1e9, pdfMemoryMb: 64 }),
    ).toEqual({
      maxBytes: 1,
      maxPages: DEFAULT_READING_LIMITS.maxPages,
      timeoutMs: DEFAULT_READING_LIMITS.timeoutMs,
      pdfMemoryMb: 64,
      pdfConcurrentReads: MAX_CONCURRENT_PDF_READS,
    });
  });
});
