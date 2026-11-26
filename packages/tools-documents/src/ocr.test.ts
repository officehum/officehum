import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ocrImages, TESSDATA_DIR } from "./ocr.js";
import { fixture } from "./test-helpers.js";

const run = promisify(execFile);
const offline = new URL("../fixtures/offline/", import.meta.url);
const compiled = new URL("../dist/ocr.js", import.meta.url);

describe("ocrImages", () => {
  it("reads a skewed phone photo of a receipt, line by line, with the bundled English data", async () => {
    const [page] = await ocrImages([fixture("receipt-photo.jpg")]);
    const lines = page?.lines.map((line) => line.text) ?? [];
    expect(lines).toContain("TOTAL EUR 10.20");
    expect(lines).toContain("Subtotal 8.50");
    expect(page?.text).toContain("R-5521");
    expect(page?.confidence).toBeGreaterThan(50);
    for (const line of page?.lines ?? []) {
      expect(line.text).toBe(line.text.trim());
      expect(line.text).not.toBe("");
    }
  });

  it("reads several images with one engine, in order", async () => {
    const pages = await ocrImages([fixture("handwritten-note.png"), fixture("receipt-photo.jpg")]);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.text).toContain("gate");
    expect(pages[1]?.text).toContain("CAFE");
  });

  it("refuses bytes that are not an image it can read", async () => {
    await expect(ocrImages([new TextEncoder().encode("not an image")])).rejects.toMatchObject({
      code: "malformed",
    });
  });

  it("points at the committed data, not a download", () => {
    expect(existsSync(`${TESSDATA_DIR}/eng.traineddata.gz`)).toBe(true);
  });
});

describe("OCR with the network shut", () => {
  const node = (args: string[]) =>
    run(
      process.execPath,
      ["--import", fileURLToPath(new URL("no-network.mjs", offline)), ...args],
      {
        cwd: fileURLToPath(offline),
      },
    );

  it("the guard reaches worker threads", async () => {
    const { stdout } = await node([fileURLToPath(new URL("ocr-child.mjs", offline)), "probe"]);
    expect(JSON.parse(stdout)).toEqual({ blocked: ["fetch", "net"] });
  });

  it("reads an image without touching the network", async () => {
    expect(existsSync(compiled), "build the package first (npm run build)").toBe(true);
    const { stdout, stderr } = await node([
      fileURLToPath(new URL("ocr-child.mjs", offline)),
      "ocr",
      fileURLToPath(new URL("../fixtures/receipt-photo.jpg", import.meta.url)),
    ]);
    expect(stderr).not.toContain("NETWORK ATTEMPT");
    expect((JSON.parse(stdout) as { text: string }).text).toContain("TOTAL EUR 10.20");
  });
});
