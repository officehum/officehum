/**
 * The public boundary, as a test: this repository holds the free agents and what they need, and
 * nothing else. It fails on a top-level entry the public tree does not hold, a dependency on or an
 * import of an `@officehum/*` package that is not a workspace here, or a relative import that leaves
 * the public tree (`./public-boundary.ts`).
 *
 * The private repository is a superset of this one and keeps more beside these files, so there the
 * test checks each export instead (its exporter lives in `scripts/public-export/`, which only the
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

  it("finds a stray top-level entry, a package outside the workspaces, and nothing else", () => {
    const root = tree({
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "private-area/index.html": "<html></html>",
      "packages/x/package.json": JSON.stringify({
        name: "@officehum/x",
        dependencies: { "@officehum/not-here": "0.0.0", "@officehum/x-helper": "0.0.0" },
      }),
      "packages/x-helper/package.json": JSON.stringify({ name: "@officehum/x-helper" }),
      "packages/x/src/a.ts": [
        'import { open } from "@officehum/elsewhere/server";',
        'import { helper } from "@officehum/x-helper/sub";',
        'import { load } from "../../x-helper/src/load.js";',
        'export { y } from "../../../private-area/y.js";',
        'import { z } from "../../../../outside/z.js";',
        // Split, so this file's own text holds no import of a package outside the tree.
        `const later = await im${"port"}("@officehum/later");`,
        '// import { y } from "@officehum/not-here"; is prose',
        'const text = `from "@officehum/not-here"`;',
      ].join("\n"),
    });
    expect(boundaryProblems(root)).toEqual([
      "packages/x/package.json: dependencies names @officehum/not-here, which is not a workspace here",
      "packages/x/src/a.ts: imports ../../../../outside/z.js, outside the public tree",
      "packages/x/src/a.ts: imports ../../../private-area/y.js, outside the public tree",
      "packages/x/src/a.ts: imports @officehum/elsewhere/server, which is not a workspace here",
      "packages/x/src/a.ts: imports @officehum/later, which is not a workspace here",
      "private-area: not a top-level entry the public tree holds",
    ]);
  });

  it("passes a new workspace with no list to edit", () => {
    const files = {
      "package.json": JSON.stringify({ workspaces: ["packages/*", "agents/*"] }),
      "agents/x/package.json": JSON.stringify({
        name: "@officehum/x",
        dependencies: { "@officehum/brand-new": "0.0.0" },
      }),
      "agents/x/src/a.ts": 'import { y } from "@officehum/brand-new";',
    };
    expect(boundaryProblems(tree(files))).toHaveLength(2);
    const root = tree({
      ...files,
      "packages/brand-new/package.json": JSON.stringify({ name: "@officehum/brand-new" }),
    });
    expect(boundaryProblems(root)).toEqual([]);
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
