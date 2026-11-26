/** The package boundary, as an executable rule: portable, the gated libraries only, no shell. */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const sources = Object.fromEntries(
  readdirSync(new URL("src/", root))
    .filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "test-helpers.ts",
    )
    .map((name) => [name, readFileSync(new URL(`src/${name}`, root), "utf8")]),
);

describe("the data pack's boundary", () => {
  it("depends on the SDK, the two document packs and the four libraries the gate passed, pinned", () => {
    expect(packageJson.dependencies).toEqual({
      "@duckdb/node-api": "2.0.0-r.1",
      "@officehum/sdk": "0.0.0",
      "@officehum/tools-documents": "0.0.0",
      "@officehum/tools-paper-office": "0.0.0",
      "@resvg/resvg-js": "2.6.2",
      vega: "6.4.0",
      "vega-lite": "6.5.0",
    });
    expect(packageJson.peerDependencies?.["@earendil-works/pi-durable"]).toBe("1.6.x");
    expect(packageJson.peerDependencies?.["@earendil-works/pi-ai"]).toBe("1.6.x");
  });

  it("never opens a harness or spawns a process, and writes files only in the sandbox", () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source, name).not.toContain(`from "@officehum/office"`);
      expect(source, name).not.toMatch(/Harness\.open|node:child_process/u);
      if (name === "sandbox.ts") continue;
      expect(source, name).not.toMatch(/writeFile|appendFile|createWriteStream|mkdir|unlink/u);
    }
  });

  it("locks the database down after loading and never lets it fetch an extension", () => {
    const sandbox = sources["sandbox.ts"] ?? "";
    expect(sandbox).toContain("SET enable_external_access = false");
    expect(sandbox).toContain("SET lock_configuration = true");
    expect(sandbox).toContain('autoinstall_known_extensions: "false"');
    expect(sandbox).toContain('autoload_known_extensions: "false"');
  });

  it("defines its tools from a light entry that loads the engine only when a tool runs", () => {
    // What `@officehum/tools-data/pack` loads: values only, since a type import is erased.
    const light: Readonly<Record<string, readonly string[]>> = {
      "pack.ts": [
        "@earendil-works/pi-durable",
        "@officehum/tools-paper-office",
        "./definitions.js",
        "./errors.js",
      ],
      "definitions.ts": ["@earendil-works/pi-schema"],
      "errors.ts": [],
    };
    for (const [name, allowed] of Object.entries(light)) {
      const imports = [
        ...(sources[name] ?? "").matchAll(/^import\s+(?!type\s)[^;]*?\sfrom\s+"([^"]+)"/gms),
      ].map((match) => match[1]);
      expect(imports, name).toEqual(allowed);
    }
    expect(sources["pack.ts"]).toContain('await import("./engine.js")');
    expect(
      (packageJson as { exports?: Record<string, { import?: string }> }).exports?.["./pack"],
    ).toEqual({ types: "./dist/pack.d.ts", import: "./dist/pack.js" });
  });

  it("gives Vega a loader that loads nothing", () => {
    const chart = sources["chart.ts"] ?? "";
    expect(chart).toContain("closed.load = refuse");
    expect(chart).not.toMatch(/https?:\/\//u);
  });
});
