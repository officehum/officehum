/**
 * OCR: tesseract.js (Tesseract compiled to WebAssembly, run in a worker thread) with the English
 * LSTM data this package ships in `tessdata/`. Nothing is downloaded and nothing is written:
 * `langPath` is the bundled folder, given as a plain path (tesseract.js fetches anything that looks
 * like a URL, `file:` included), and `cacheMethod: "none"` stops it caching the data to disk.
 */

import { fileURLToPath } from "node:url";
import Tesseract from "tesseract.js";
import { ReadingError } from "./reading.js";

/** The folder holding `eng.traineddata.gz`, beside `src/` and `dist/` alike. */
export const TESSDATA_DIR = fileURLToPath(new URL("../tessdata", import.meta.url));

export interface OcrLine {
  readonly text: string;
  /** Tesseract's confidence in the line, 0 to 100. */
  readonly confidence: number;
}

export interface OcrPage {
  readonly text: string;
  readonly lines: readonly OcrLine[];
  /** Tesseract's mean confidence over the page, 0 to 100. */
  readonly confidence: number;
}

/**
 * Reads each image (JPEG or PNG bytes) with one engine, in order. Pages are turned upright first
 * (`rotateAuto`), so a photo taken at a slant reads line by line. Lines come back trimmed, with empty
 * ones dropped.
 */
export async function ocrImages(images: readonly Uint8Array[]): Promise<OcrPage[]> {
  const worker = await Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY, {
    langPath: TESSDATA_DIR,
    gzip: true,
    cacheMethod: "none",
    // The failed job's promise is rejected either way; without a handler tesseract.js also throws
    // the error from its message listener, where nothing can catch it.
    errorHandler: () => undefined,
  });
  // Tesseract's own diagnostics ("Estimating resolution as ...") go nowhere rather than to stdout.
  await worker.setParameters({ debug_file: "/dev/null" });
  try {
    const pages: OcrPage[] = [];
    for (const [index, image] of images.entries()) {
      let result: Tesseract.RecognizeResult;
      try {
        result = await worker.recognize(
          Buffer.from(image),
          { rotateAuto: true },
          { text: true, blocks: true },
        );
      } catch (error) {
        throw new ReadingError(
          "malformed",
          `image ${index + 1} could not be read as a picture (${describe(error)}). Send a JPEG or PNG.`,
        );
      }
      const lines = (result.data.blocks ?? []).flatMap((block) =>
        block.paragraphs.flatMap((paragraph) =>
          paragraph.lines.flatMap((line) => {
            const text = line.text.trim();
            return text === "" ? [] : [{ text, confidence: Math.round(line.confidence) }];
          }),
        ),
      );
      pages.push({
        text: lines.map((line) => line.text).join("\n"),
        lines,
        confidence: Math.round(result.data.confidence),
      });
    }
    return pages;
  } finally {
    await worker.terminate();
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}
