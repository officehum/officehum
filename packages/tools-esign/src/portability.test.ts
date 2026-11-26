/** The package boundary, as an executable rule: portable, no new libraries, no harness, no writer. */

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

describe("the e-signature pack's boundary", () => {
  it("depends on the SDK alone, with Pi Durable, pi-ai and pi-schema as peers at the pins", () => {
    expect(packageJson.dependencies).toEqual({ "@officehum/sdk": "0.0.0" });
    expect(packageJson.peerDependencies).toEqual({
      "@earendil-works/pi-ai": "1.6.x",
      "@earendil-works/pi-durable": "1.6.x",
      "@earendil-works/pi-schema": "1.6.x",
    });
  });

  it("never imports the office or the CLI, opens a harness, starts a process or writes a file", () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source, name).not.toMatch(/from "@officehum\/(office|cli)"/u);
      expect(source, name).not.toMatch(/Harness\.open|\.submit\(/u);
      expect(source, name).not.toMatch(
        /node:child_process|node:fs|node:http|node:net|fetch\(|writeFile|createWriteStream/u,
      );
    }
  });

  it("names no provider", () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source, name).not.toMatch(/docuseal|docusign|dropbox|hellosign|adobe sign/iu);
    }
  });
});
