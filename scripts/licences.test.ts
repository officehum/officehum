/**
 * The licence scan, in the normal suite so it runs on every pull request through the
 * existing `check` job: the real tree's findings, the scanner's rules on a small fixture tree, and a
 * drift check that `THIRD_PARTY_NOTICES.md` matches the lockfile.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bundledFiles,
  declaredLicence,
  type Lockfile,
  licenceProblem,
  lockedPythonPackages,
  renderNotices,
  scanLockfile,
  scanRepository,
  workerPackages,
} from "./licences.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe("the repository", () => {
  const result = scanRepository(root);

  it("needs only allowlisted licences in production", () => {
    expect(result.unresolved).toEqual([]);
    expect(result.findings.map((pkg) => `${pkg.name}@${pkg.version}: ${pkg.problem}`)).toEqual([]);
  });

  it("keeps THIRD_PARTY_NOTICES.md in step with the lockfile", () => {
    expect(
      readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
      "THIRD_PARTY_NOTICES.md is out of date with package-lock.json: run `npm run licences` and commit the regenerated THIRD_PARTY_NOTICES.md",
    ).toBe(renderNotices(result));
  });

  it("names every Python package the Paper worker pins, at the pinned version", () => {
    const lock = readFileSync(
      join(root, "packages", "tools-paper-office", "requirements.lock"),
      "utf8",
    );
    expect(
      workerPackages.map(({ name, version }) => ({ name, version })),
      "requirements.lock changed: update workerPackages in scripts/licences.ts, reading each licence from the provisioned worker's metadata",
    ).toEqual(lockedPythonPackages(lock));
  });

  it("names each committed third-party file, which exists", () => {
    for (const file of bundledFiles) {
      expect(existsSync(join(root, file.path)), file.path).toBe(true);
    }
  });
});

/**
 * A small tree: workspace `packages/app` (published) and `private/site` (private). `app` depends on
 * `good` (MIT), `dual` (an SPDX OR), `bad` (GPL-3.0-only), `bare` (no licence anywhere), `legacy`
 * (no licence in the lockfile, an old `licenses` array in its package.json), and the workspace
 * `@fixture/lib` through a link. `lib` depends on `copyleft`, which has its own nested `good` at
 * another version. `site` depends on `good` and on an optional dependency the lockfile lacks.
 */
const fixture: Lockfile = {
  packages: {
    "": { name: "fixture" },
    "packages/app": {
      name: "@fixture/app",
      dependencies: {
        good: "^1",
        dual: "^1",
        bad: "^1",
        bare: "^1",
        legacy: "^1",
        "@fixture/lib": "*",
      },
      devDependencies: { tooling: "^1" },
    } as Lockfile["packages"][string],
    "packages/lib": { name: "@fixture/lib", dependencies: { copyleft: "^1" } },
    "private/site": {
      name: "@fixture/site",
      dependencies: { good: "^1" },
      optionalDependencies: { "native-thing": "^1" },
    },
    "node_modules/@fixture/lib": { resolved: "packages/lib", link: true },
    "node_modules/good": { version: "1.0.0", license: "MIT" },
    "node_modules/dual": { version: "1.2.0", license: "(GPL-2.0-only OR MIT)" },
    "node_modules/bad": { version: "3.0.0", license: "GPL-3.0-only", dependencies: { good: "^1" } },
    "node_modules/bare": { version: "0.1.0" },
    "node_modules/legacy": { version: "2.0.0" },
    "node_modules/copyleft": {
      version: "1.0.0",
      license: "AGPL-3.0-or-later",
      dependencies: { good: "^2" },
    },
    "node_modules/copyleft/node_modules/good": { version: "2.0.0", license: "ISC" },
    "node_modules/tooling": { version: "1.0.0", license: "GPL-3.0-only" },
  },
};

const scanFixture = () =>
  scanLockfile(fixture, {
    workspaces: [
      { path: "packages/app", name: "@fixture/app", private: false },
      { path: "packages/lib", name: "@fixture/lib", private: false },
      { path: "private/site", name: "@fixture/site", private: true },
    ],
    readPackageJson: (path) =>
      path === "node_modules/legacy"
        ? { licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }
        : undefined,
  });

describe("scanLockfile on a fixture tree", () => {
  it("follows production dependencies through links and nesting, and skips dev dependencies", () => {
    const result = scanFixture();
    expect(result.packages.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      "bad@3.0.0",
      "bare@0.1.0",
      "copyleft@1.0.0",
      "dual@1.2.0",
      "good@1.0.0",
      "good@2.0.0",
      "legacy@2.0.0",
    ]);
    const good = result.packages.find((pkg) => pkg.name === "good" && pkg.version === "1.0.0");
    expect(good?.usedBy).toEqual(["@fixture/app", "@fixture/site"]);
    // An optional dependency missing from the lockfile (another platform's build) is not an error.
    expect(result.unresolved).toEqual([]);
  });

  it("fails a disallowed licence and a missing one, and passes an OR with one allowed side", () => {
    const findings = Object.fromEntries(
      scanFixture().findings.map((pkg) => [pkg.name, pkg.problem]),
    );
    expect(findings).toEqual({
      bad: 'licence "GPL-3.0-only" is not on the allowlist',
      bare: "declares no licence",
      copyleft: 'licence "AGPL-3.0-or-later" is not on the allowlist',
    });
  });

  it("reads an old licenses array from the installed package.json when the lockfile has none", () => {
    const legacy = scanFixture().packages.find((pkg) => pkg.name === "legacy");
    expect(legacy?.licence).toBe("(MIT OR Apache-2.0)");
    expect(legacy?.problem).toBeUndefined();
  });

  it("reports a required dependency the lockfile lacks", () => {
    const broken: Lockfile = {
      packages: { "packages/app": { name: "@fixture/app", dependencies: { gone: "^1" } } },
    };
    const result = scanLockfile(broken, {
      workspaces: [{ path: "packages/app", name: "@fixture/app", private: false }],
    });
    expect(result.unresolved).toEqual(["gone (needed by @fixture/app)"]);
  });

  it("renders the same notices whatever order the lockfile lists packages in", () => {
    const reversed: Lockfile = {
      packages: Object.fromEntries(Object.entries(fixture.packages).reverse()),
    };
    const workspaces = [
      { path: "private/site", name: "@fixture/site", private: true },
      { path: "packages/lib", name: "@fixture/lib", private: false },
      { path: "packages/app", name: "@fixture/app", private: false },
    ];
    expect(renderNotices(scanLockfile(reversed, { workspaces }))).toBe(
      renderNotices(scanLockfile(fixture, { workspaces: [...workspaces].reverse() })),
    );
  });
});

describe("licence rules", () => {
  it("applies SPDX precedence: AND binds tighter than OR", () => {
    expect(licenceProblem("x", "MIT OR GPL-3.0-only AND Apache-2.0")).toBeUndefined();
    expect(licenceProblem("x", "(MIT OR GPL-3.0-only) AND Apache-2.0")).toBeUndefined();
    expect(licenceProblem("x", "MIT AND GPL-3.0-only")).toBe(
      'licence "MIT AND GPL-3.0-only" is not on the allowlist',
    );
    // Operators are case-insensitive in SPDX; identifiers are matched exactly.
    expect(licenceProblem("x", "mit or Apache-2.0")).toBeUndefined();
    expect(licenceProblem("x", "mit")).toBe('licence "mit" is not on the allowlist');
  });

  it("allows MPL-2.0 only for the named packages", () => {
    expect(licenceProblem("@resvg/resvg-js", "MPL-2.0")).toBeUndefined();
    expect(licenceProblem("@resvg/resvg-js-linux-x64-gnu", "MPL-2.0")).toBeUndefined();
    expect(licenceProblem("lightningcss", "MPL-2.0")).toMatch(
      /allowed only for the packages named/,
    );
  });

  it("fails exceptions, unknown identifiers and broken expressions", () => {
    expect(licenceProblem("x", "Apache-2.0 WITH LLVM-exception")).toMatch(/not on the allowlist/);
    expect(licenceProblem("x", "SEE LICENSE IN LICENSE.md")).toMatch(/not a valid SPDX expression/);
    expect(licenceProblem("x", "SSPL-1.0")).toMatch(/not on the allowlist/);
    expect(licenceProblem("x", "(MIT")).toMatch(/not a valid SPDX expression/);
  });

  it("reads the string, object and array forms of a manifest's licence", () => {
    expect(declaredLicence({ license: " MIT " })).toBe("MIT");
    expect(declaredLicence({ license: { type: "ISC" } })).toBe("ISC");
    expect(declaredLicence({ licenses: ["BSD-2-Clause"] })).toBe("BSD-2-Clause");
    expect(declaredLicence({ license: "" })).toBeUndefined();
    expect(declaredLicence({})).toBeUndefined();
  });
});
