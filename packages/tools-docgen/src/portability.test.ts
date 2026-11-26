/** The package boundary, as an executable rule: portable, no new libraries, one process, no writer. */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  files?: string[];
};
const sources = Object.fromEntries(
  readdirSync(new URL("src/", root))
    .filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "test-helpers.ts",
    )
    .map((name) => [name, readFileSync(new URL(`src/${name}`, root), "utf8")]),
);
const templates = Object.fromEntries(
  readdirSync(new URL("templates/", root))
    .filter((name) => name.endsWith(".typ"))
    .map((name) => [name, readFileSync(new URL(`templates/${name}`, root), "utf8")]),
);

describe("the generation pack's boundary", () => {
  it("depends on the SDK, the Paper Office pack and TypeBox, which the SDK already pins", () => {
    expect(packageJson.dependencies).toEqual({
      "@officehum/sdk": "0.0.0",
      "@officehum/tools-paper-office": "0.0.0",
      typebox: "1.4.6",
    });
    expect(packageJson.peerDependencies?.["@earendil-works/pi-durable"]).toBe("1.6.x");
    expect(packageJson.files).toContain("templates");
  });

  it("starts a process and writes files only in the Typst runner, and never opens a harness", () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source).not.toContain(`from "@officehum/office"`);
      expect(source).not.toMatch(/Harness\.open/u);
      if (name === "typst.ts") continue;
      expect(source, name).not.toMatch(
        /node:child_process|writeFile|appendFile|createWriteStream|mkdir|unlink/u,
      );
    }
  });

  it("ships templates that read only their own directory and fetch nothing", () => {
    for (const [name, source] of Object.entries(templates)) {
      expect(source, name).not.toMatch(
        /https?:|@preview|@local|read\(|csv\(|yaml\(|toml\(|xml\(|cbor\(/u,
      );
      const reads = [...source.matchAll(/(?:json|import|include|image)\(?\s*"([^"]+)"/gu)].map(
        (match) => match[1],
      );
      for (const path of reads)
        expect(["data.json", "brand.json", "_officehum.typ"], `${name}: ${path}`).toContain(path);
    }
  });
});
