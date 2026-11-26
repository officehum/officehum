/**
 * The licence scan: every third-party package a workspace needs in production must carry
 * a licence on the allowlist below, and `THIRD_PARTY_NOTICES.md` lists them all.
 *
 * It reads `package-lock.json` only (npm records each package's `license` there), so the result is
 * the same on every machine and platform, including the optional native packages npm skips
 * installing. A lockfile entry with no licence falls back to the installed `package.json`
 * (`license`, or the old `licenses` array); a package with neither is a finding.
 *
 * "Production" means a workspace's `dependencies`, `optionalDependencies` and `peerDependencies`,
 * followed transitively the way Node resolves them. Development dependencies are not shipped and are
 * not scanned. `scripts/licences.test.ts` runs the scan in the normal suite, so it gates every pull
 * request through the existing `check` job.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Licences any package may use. Anything else (GPL, AGPL, LGPL, SSPL, Elastic, BUSL, CC-BY-NC, an
 * unknown or missing licence) is a finding. Widening this list is the owner's decision.
 */
export const allowedLicences: readonly string[] = [
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  // MIT without the attribution requirement, so strictly more permissive than MIT.
  "MIT-0",
  "Python-2.0",
  "Unlicense",
];

/**
 * MPL-2.0 is allowed only for these packages, which Office Hum uses unmodified (MPL-2.0 is
 * file-level copyleft: it binds changes to its own files, so using them as published is fine).
 * `@resvg/resvg-js` loads one of its platform builds as an optional dependency, so each is named.
 */
export const mplPackages: readonly string[] = [
  "@resvg/resvg-js",
  "@resvg/resvg-js-android-arm-eabi",
  "@resvg/resvg-js-android-arm64",
  "@resvg/resvg-js-darwin-arm64",
  "@resvg/resvg-js-darwin-x64",
  "@resvg/resvg-js-linux-arm-gnueabihf",
  "@resvg/resvg-js-linux-arm64-gnu",
  "@resvg/resvg-js-linux-arm64-musl",
  "@resvg/resvg-js-linux-x64-gnu",
  "@resvg/resvg-js-linux-x64-musl",
  "@resvg/resvg-js-win32-arm64-msvc",
  "@resvg/resvg-js-win32-ia32-msvc",
  "@resvg/resvg-js-win32-x64-msvc",
];

/** Third-party material committed to the repository, which a lockfile scan cannot see. */
export const bundledFiles: readonly { what: string; path: string; licence: string }[] = [
  {
    what: "Tesseract's English OCR model (`4.0.0_best_int`), from `@tesseract.js-data/eng` 1.0.0",
    path: "packages/tools-documents/tessdata/eng.traineddata.gz",
    licence: "Apache-2.0",
  },
];

/**
 * The Paper document worker's Python packages, exactly as `packages/tools-paper-office/requirements.lock`
 * pins them (a test holds the two together). Each licence is the one the package declares in its
 * installed metadata (`License-Expression`, otherwise `License`), read from a worker provisioned from
 * that lock; none is guessed. They are not on the npm allowlist above, which covers npm packages only.
 */
export const workerPackages: readonly { name: string; version: string; licence: string }[] = [
  { name: "et-xmlfile", version: "2.0.0", licence: "MIT" },
  { name: "lxml", version: "6.1.3", licence: "BSD-3-Clause" },
  { name: "paper-docx", version: "0.2.0", licence: "MIT" },
  { name: "paper-pptx", version: "0.2.0", licence: "MIT" },
  { name: "paper-xlsx", version: "0.2.1", licence: "MIT" },
  { name: "pillow", version: "13.0.0", licence: "MIT-CMU" },
  { name: "typing-extensions", version: "4.16.0", licence: "PSF-2.0" },
  { name: "xlsxwriter", version: "3.3.0", licence: "BSD-2-Clause" },
];

/** Scans the repository at `root`: its lockfile, with each workspace's `private` flag. */
export function scanRepository(root: string): ScanResult {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as Lockfile;
  const workspaces = Object.keys(lock.packages)
    .filter((path) => path !== "" && !path.includes("node_modules/"))
    .map((path): Workspace => {
      const manifest = readJson(join(root, path, "package.json")) ?? {};
      return {
        path,
        name: typeof manifest.name === "string" ? manifest.name : path,
        private: manifest.private === true,
      };
    });
  return scanLockfile(lock, {
    workspaces,
    readPackageJson: (path) => readJson(join(root, path, "package.json")),
  });
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** The parts of a `package-lock.json` (version 3) entry the scan reads. */
export interface LockEntry {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
  link?: boolean;
  resolved?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

export interface Lockfile {
  packages: Record<string, LockEntry>;
}

export interface Workspace {
  /** The workspace folder, as the lockfile keys it (`packages/sdk`). */
  path: string;
  name: string;
  /** Private workspaces are never published, so their dependencies are not distributed. */
  private: boolean;
}

export interface ScannedPackage {
  name: string;
  version: string;
  /** The SPDX expression as declared, or `undefined` when the package declares none. */
  licence: string | undefined;
  /** The workspaces whose production closure includes this package, sorted. */
  usedBy: string[];
  /** True when at least one published (non-private) workspace needs it. */
  published: boolean;
  /** Why the licence is not acceptable, or `undefined` when it is. */
  problem: string | undefined;
}

export interface ScanResult {
  packages: ScannedPackage[];
  /** The packages with a `problem`, in the same order. */
  findings: ScannedPackage[];
  /** Dependencies a workspace or package names that the lockfile has no entry for. */
  unresolved: string[];
}

export interface ScanOptions {
  workspaces: readonly Workspace[];
  /** Reads an installed package's `package.json` by its lockfile path, if it is installed. */
  readPackageJson?: (path: string) => Record<string, unknown> | undefined;
}

/** Runs the scan over a lockfile. Never throws on bad licence data: it reports it. */
export function scanLockfile(lock: Lockfile, options: ScanOptions): ScanResult {
  const workspacePaths = new Set(options.workspaces.map((workspace) => workspace.path));
  const found = new Map<string, { entry: LockEntry; path: string; usedBy: Set<string> }>();
  const unresolved = new Set<string>();

  for (const workspace of options.workspaces) {
    const seen = new Set<string>();
    const queue = [workspace.path];
    while (queue.length > 0) {
      const from = queue.shift() as string;
      if (seen.has(from)) continue;
      seen.add(from);
      const entry = lock.packages[from];
      if (entry === undefined) continue;
      for (const [dependency, optional] of productionDependencies(entry)) {
        let path = resolveDependency(lock, from, dependency);
        if (path === undefined) {
          if (!optional) unresolved.add(`${dependency} (needed by ${nameOf(lock, from)})`);
          continue;
        }
        const resolved = lock.packages[path] as LockEntry;
        if (resolved.link === true && resolved.resolved !== undefined) path = resolved.resolved;
        // Another workspace is Office Hum's own code; its dependencies are walked from here too.
        if (!workspacePaths.has(path)) {
          const target = lock.packages[path] as LockEntry;
          const key = `${nameOf(lock, path)}@${target.version ?? "unknown"}`;
          const record = found.get(key) ?? { entry: target, path, usedBy: new Set<string>() };
          record.usedBy.add(workspace.name);
          found.set(key, record);
        }
        queue.push(path);
      }
    }
  }

  const publishedNames = new Set(
    options.workspaces.filter((workspace) => !workspace.private).map((workspace) => workspace.name),
  );
  const packages = [...found.values()]
    .map(({ entry, path, usedBy }): ScannedPackage => {
      const name = nameOf(lock, path);
      const licence =
        declaredLicence(entry) ?? declaredLicence(options.readPackageJson?.(path) ?? {});
      return {
        name,
        version: entry.version ?? "unknown",
        licence,
        usedBy: [...usedBy].sort(compare),
        published: [...usedBy].some((workspace) => publishedNames.has(workspace)),
        problem: licenceProblem(name, licence),
      };
    })
    .sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version));

  return {
    packages,
    findings: packages.filter((pkg) => pkg.problem !== undefined),
    unresolved: [...unresolved].sort(compare),
  };
}

/** A package's production dependencies, each with whether it may be absent. */
function productionDependencies(entry: LockEntry): [string, boolean][] {
  const dependencies: [string, boolean][] = [];
  for (const name of Object.keys(entry.dependencies ?? {})) dependencies.push([name, false]);
  for (const name of Object.keys(entry.optionalDependencies ?? {})) dependencies.push([name, true]);
  for (const name of Object.keys(entry.peerDependencies ?? {})) {
    dependencies.push([name, entry.peerDependenciesMeta?.[name]?.optional === true]);
  }
  return dependencies;
}

/** Node's lookup: `<from>/node_modules/<name>`, then each enclosing `node_modules` up to the root. */
export function resolveDependency(lock: Lockfile, from: string, name: string): string | undefined {
  let base = from;
  for (;;) {
    const candidate = base === "" ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (lock.packages[candidate] !== undefined) return candidate;
    if (base === "") return undefined;
    const nested = base.lastIndexOf("/node_modules/");
    base = nested >= 0 ? base.slice(0, nested) : "";
  }
}

function nameOf(lock: Lockfile, path: string): string {
  const declared = lock.packages[path]?.name;
  if (declared !== undefined) return declared;
  const marker = path.lastIndexOf("node_modules/");
  return marker >= 0 ? path.slice(marker + "node_modules/".length) : path;
}

/**
 * The licence a manifest declares, as one SPDX expression. The old `licenses` array (and the old
 * `{ type }` object form) is read as a choice between its entries, which is how packages used it.
 */
export function declaredLicence(manifest: {
  license?: unknown;
  licenses?: unknown;
}): string | undefined {
  const single = licenceName(manifest.license);
  if (single !== undefined) return single;
  if (Array.isArray(manifest.licenses)) {
    const names = manifest.licenses.map(licenceName).filter((name) => name !== undefined);
    if (names.length === 1) return names[0];
    if (names.length > 1) return `(${names.join(" OR ")})`;
  }
  return undefined;
}

function licenceName(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "object" && value !== null && "type" in value) {
    const type = (value as { type: unknown }).type;
    if (typeof type === "string" && type.trim() !== "") return type.trim();
  }
  return undefined;
}

/** Why a package's licence is not acceptable, or `undefined` when it is. */
export function licenceProblem(name: string, licence: string | undefined): string | undefined {
  if (licence === undefined) return "declares no licence";
  let expression: Expression;
  try {
    expression = parseSpdx(licence);
  } catch (error) {
    return `licence "${licence}" is not a valid SPDX expression (${(error as Error).message})`;
  }
  if (satisfies(expression, name)) return undefined;
  if (mentions(expression, "MPL-2.0")) {
    return `licence "${licence}" includes MPL-2.0, which is allowed only for the packages named in scripts/licences.ts`;
  }
  return `licence "${licence}" is not on the allowlist`;
}

type Expression =
  | { kind: "licence"; id: string; exception: string | undefined }
  | { kind: "and" | "or"; left: Expression; right: Expression };

function satisfies(expression: Expression, name: string): boolean {
  switch (expression.kind) {
    case "or":
      return satisfies(expression.left, name) || satisfies(expression.right, name);
    case "and":
      return satisfies(expression.left, name) && satisfies(expression.right, name);
    case "licence":
      // A `WITH` exception changes the terms; none is on the allowlist, so it needs a person.
      if (expression.exception !== undefined) return false;
      if (expression.id === "MPL-2.0") return mplPackages.includes(name);
      return allowedLicences.includes(expression.id);
  }
}

function mentions(expression: Expression, id: string): boolean {
  if (expression.kind === "licence") return expression.id === id;
  return mentions(expression.left, id) || mentions(expression.right, id);
}

/** Parses an SPDX licence expression: `OR` binds looser than `AND`, parentheses group. */
export function parseSpdx(text: string): Expression {
  const tokens = text.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;
  const peek = (): string | undefined => tokens[position];
  const keyword = (token: string | undefined, word: string): boolean =>
    token !== undefined && token.toUpperCase() === word;

  const parseOr = (): Expression => {
    let left = parseAnd();
    while (keyword(peek(), "OR")) {
      position++;
      left = { kind: "or", left, right: parseAnd() };
    }
    return left;
  };
  const parseAnd = (): Expression => {
    let left = parseAtom();
    while (keyword(peek(), "AND")) {
      position++;
      left = { kind: "and", left, right: parseAtom() };
    }
    return left;
  };
  const parseAtom = (): Expression => {
    const token = tokens[position++];
    if (token === undefined) throw new Error("it ends too early");
    if (token === "(") {
      const inner = parseOr();
      if (tokens[position++] !== ")") throw new Error("a parenthesis is not closed");
      return inner;
    }
    if (token === ")" || ["AND", "OR", "WITH"].includes(token.toUpperCase())) {
      throw new Error(`"${token}" is out of place`);
    }
    let exception: string | undefined;
    if (keyword(peek(), "WITH")) {
      position++;
      exception = tokens[position++];
      if (exception === undefined) throw new Error("WITH names no exception");
    }
    return { kind: "licence", id: token, exception };
  };

  const expression = parseOr();
  if (position < tokens.length) throw new Error(`unexpected "${tokens[position]}"`);
  return expression;
}

/** `THIRD_PARTY_NOTICES.md`: deterministic, sorted by licence and then by package. */
export function renderNotices(result: ScanResult): string {
  const byLicence = new Map<string, ScannedPackage[]>();
  for (const pkg of result.packages) {
    const licence = pkg.licence ?? "No licence declared";
    byLicence.set(licence, [...(byLicence.get(licence) ?? []), pkg]);
  }
  const licences = [...byLicence.keys()].sort(compare);
  // Only a tree with private workspaces has a package marked `no`; elsewhere the sentence is noise.
  const unpublished = result.packages.some((pkg) => !pkg.published);

  const lines = [
    "# Third-party notices",
    "",
    "Generated by `npm run licences` from `package-lock.json` and `scripts/licences.ts`. Do not edit it",
    "by hand: `scripts/licences.test.ts` fails when it is out of date.",
    "",
    "These are the third-party npm packages Office Hum's workspaces need in production (their",
    "dependencies, optional dependencies and peer dependencies, followed transitively). npm installs",
    "them from the registry; none is copied into this repository, and each package carries its own",
    "licence text. Development-only tools are not listed. **Published** is `yes` when a published",
    unpublished
      ? "workspace needs the package, and `no` when only a private one (an app that is not published) does."
      : "workspace needs the package.",
    "",
    "Third-party material that is not an npm package (a committed data file, and the Python packages",
    "the Paper document worker installs) is listed at the end.",
    "",
    `${result.packages.length} packages.`,
    "",
    "## Summary",
    "",
    "| Licence | Packages |",
    "| --- | --- |",
    ...licences.map((licence) => `| ${licence} | ${(byLicence.get(licence) ?? []).length} |`),
    "",
  ];

  if (result.findings.length > 0) {
    lines.push(
      "## Not on the allowlist",
      "",
      "| Package | Version | Problem |",
      "| --- | --- | --- |",
    );
    for (const pkg of result.findings) {
      lines.push(`| ${pkg.name} | ${pkg.version} | ${pkg.problem} |`);
    }
    lines.push("");
  }

  for (const licence of licences) {
    lines.push(`## ${licence}`, "", "| Package | Version | Published |", "| --- | --- | --- |");
    for (const pkg of byLicence.get(licence) ?? []) {
      lines.push(`| ${pkg.name} | ${pkg.version} | ${pkg.published ? "yes" : "no"} |`);
    }
    lines.push("");
  }

  lines.push(
    "## Committed third-party files",
    "",
    "Each sits in the repository beside its licence text.",
    "",
    "| File | What it is | Licence |",
    "| --- | --- | --- |",
    ...bundledFiles.map((file) => `| \`${file.path}\` | ${file.what} | ${file.licence} |`),
    "",
    "## The Paper document worker's Python packages",
    "",
    "`packages/tools-paper-office/requirements.lock` pins them and",
    "`packages/tools-paper-office/scripts/provision-worker.sh` installs them from PyPI into the worker's",
    "own interpreter; none is copied into this repository. Each licence is the one the package declares",
    "in its installed metadata, read from a worker provisioned from that lock.",
    "",
    "| Package | Version | Licence |",
    "| --- | --- | --- |",
    ...workerPackages.map((pkg) => `| ${pkg.name} | ${pkg.version} | ${pkg.licence} |`),
    "",
  );
  return lines.join("\n");
}

/** `name==version` for each package a pip lock pins, in its order. */
export function lockedPythonPackages(lock: string): { name: string; version: string }[] {
  return [...lock.matchAll(/^([A-Za-z0-9._-]+)==([^\s\\]+)/gmu)].map((match) => ({
    name: (match[1] as string).toLowerCase(),
    version: match[2] as string,
  }));
}

/** Plain code-point order, so the notices do not depend on the machine's locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
