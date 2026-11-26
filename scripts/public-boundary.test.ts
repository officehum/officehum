/**
 * The public boundary, as a test: this repository holds the free agents and what they
 * need, and none of the office. It fails on a private path present, a workspace depending on a private
 * package, or a source file importing one (`./public-boundary.ts`).
 *
 * The private repository is a superset of this one and keeps the office beside these files, so there
 * the test checks each export instead (its exporter lives in `scripts/public-export/`, which only the
 * private repository has); here it checks the tree itself.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { boundaryProblems, specifiers } from "./public-boundary.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PRIVATE_SUPERSET = existsSync(join(ROOT, "scripts", "public-export"));

const temps: string[] = [];
afterAll(() => {
  for (const directory of temps) rmSync(directory, { recursive: true, force: true });
});

/** A small tree with `files` written into it. */
function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "officehum-boundary-"));
  temps.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("the public boundary", () => {
  it.skipIf(PRIVATE_SUPERSET)("holds in this repository", () => {
    expect(boundaryProblems(ROOT)).toEqual([]);
  });

  it("finds a private path, a private dependency and a private import, and nothing else", () => {
    const root = tree({
      "apps/studio/index.html": "<html></html>",
      "packages/x/package.json": JSON.stringify({
        name: "@officehum/x",
        dependencies: { "@officehum/office": "0.0.0", "@officehum/office-manager": "0.0.0" },
      }),
      "packages/x/src/a.ts": [
        'import { openOffice } from "@officehum/gateway/server";',
        'import { loadRole } from "../../runner/src/roles/load-role.js";',
        'export { x } from "../../office/src/x.js";',
        // Split, so this file's own text holds no import of a private package.
        `const studio = await im${"port"}("@officehum/studio");`,
        '// import { y } from "@officehum/office"; is prose',
        'const text = `from "@officehum/office"`;',
      ].join("\n"),
    });
    expect(boundaryProblems(root)).toEqual([
      "apps: a private path is in the public tree",
      "packages/x/package.json: dependencies names @officehum/office",
      "packages/x/src/a.ts: imports ../../office/src/x.js, a private path",
      "packages/x/src/a.ts: imports @officehum/gateway/server",
      "packages/x/src/a.ts: imports @officehum/studio",
    ]);
  });

  it("reads static, side-effect and dynamic imports from the start of a statement", () => {
    expect(
      specifiers(
        [
          'import a from "one";',
          "import {",
          "  b,",
          '} from "two";',
          'import "three";',
          'export * from "four";',
          'await import("five");',
          'const prose = "import x from six";',
        ].join("\n"),
      ),
    ).toEqual(["one", "two", "four", "three", "five"]);
  });
});
