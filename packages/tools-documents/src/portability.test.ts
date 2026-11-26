/** The package boundary, as an executable rule: portable, two new libraries, no shell or writer. */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  files?: string[];
};
const sources = readdirSync(new URL("src/", root))
  .filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "test-helpers.ts",
  )
  .map((name) => readFileSync(new URL(`src/${name}`, root), "utf8"));
const reader = readFileSync(new URL("python/office_reader.py", root), "utf8");

describe("the reading pack's boundary", () => {
  it("depends on the SDK, the Paper Office pack and exactly four pinned libraries", () => {
    expect(packageJson.dependencies).toEqual({
      "@napi-rs/canvas": "1.1.0",
      "@officehum/sdk": "0.0.0",
      "@officehum/tools-paper-office": "0.0.0",
      "postal-mime": "4.2.0",
      "tesseract.js": "7.0.0",
      unpdf: "1.9.1",
    });
    expect(packageJson.peerDependencies?.["@earendil-works/pi-durable"]).toBe("1.6.x");
    expect(packageJson.peerDependencies?.["@earendil-works/pi-ai"]).toBe("1.6.x");
    expect(packageJson.files).toContain("python");
    expect(packageJson.files).toContain("tessdata");
  });

  it("ships its OCR data and never asks tesseract.js to download or cache it", () => {
    const ocr = readFileSync(new URL("src/ocr.ts", root), "utf8");
    expect(ocr).toContain("langPath");
    expect(ocr).toContain('cacheMethod: "none"');
    expect(ocr).not.toMatch(/https?:\/\//u);
  });

  it("never opens a harness, spawns a process or writes a file itself", () => {
    for (const source of sources) {
      expect(source).not.toMatch(
        /Harness\.open|node:child_process|writeFile|appendFile|createWriteStream|mkdir|unlink/u,
      );
      expect(source).not.toContain(`from "@officehum/office"`);
    }
  });

  it("reads Office files only through the worker's workspace API, with no path from a caller", () => {
    expect(reader).toContain("documents.open_input");
    expect(reader).not.toContain("declare_output");
    expect(reader).not.toContain("write_output");
    expect(reader).not.toMatch(/import (os|subprocess|socket|urllib)/u);
  });
});
