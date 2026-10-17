/**
 * The SDK's fixtures are test-only, and this is that decision made executable (RASF-3308).
 *
 * They import the SDK by relative source path so the SDK's own tests exercise the SDK's **source**
 * rather than a build. That is exactly why a built CLI cannot load them: plain Node has no
 * `packages/sdk/src/index.js`, only the build's `dist/`. If someone changes the import form, these
 * tests fail and point at `packages/sdk/fixtures/README.md`, where the trade-off is written down.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const FIXTURES = ["sample-desk", "sample-stockroom"] as const;

function fixture(name: string): { entry: string } {
  const dir = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    main?: string;
  };
  return { entry: join(dir, manifest.main ?? "./src/index.ts") };
}

describe("the SDK fixtures are test-only", () => {
  for (const name of FIXTURES) {
    it(`${name} imports the SDK's source rather than its build output`, () => {
      const source = readFileSync(fixture(name).entry, "utf8");
      // The relative form is the decision, not an accident: it keeps the SDK's tests on source.
      expect(source).toContain('from "../../../src/index.js"');
      expect(source).not.toContain('from "@officehum/sdk"');
    });

    it(`${name} is not loadable by plain Node, which is why officehum run refuses it`, () => {
      const script = `await import(${JSON.stringify(pathToFileURL(fixture(name).entry).href)});`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      // The reason a host sees: the fixture's own source import, not its entry. That distinction is
      // what makes the CLI's error message actionable rather than a bare module-not-found.
      expect(`${result.stderr}${result.stdout}`).toMatch(/src[\\/]index\.js/);
    });
  }
});
