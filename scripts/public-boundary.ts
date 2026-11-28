/**
 * The public boundary: what this repository may hold. It holds the free agents and what they need to
 * be installed, run one at a time and tested, and nothing else.
 *
 * The guard is an allow-list, so it names nothing outside the tree. `boundaryProblems(root)` lists
 * every breach under `root`: a top-level entry that is not a published one, a dependency on or an
 * import of an `@officehum/*` package that is not a workspace in the tree, and a relative import that
 * reaches outside the published top-level entries. A new workspace passes as soon as it is in the
 * tree, with no list to edit.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * The top-level entries the public tree may hold: what the export publishes, then what a working
 * clone adds (version control, installed dependencies, build and test output, local runtime data
 * and environment files, which `.gitignore` keeps out of commits).
 */
const TOP_LEVEL = new Set([
  ".changeset",
  ".github",
  ".gitignore",
  ".nvmrc",
  "AGENTS.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "agents",
  "biome.json",
  "company",
  "docs",
  "package-lock.json",
  "package.json",
  "packages",
  "scripts",
  "tsconfig.base.json",
  "vitest.config.ts",
  // A working clone's own.
  ".DS_Store",
  ".env",
  ".git",
  ".officehum",
  "coverage",
  "dist",
  "node_modules",
]);

/** Directories no check reads: dependencies, build output and version control. */
const SKIPPED = new Set(["node_modules", "dist", ".git", "coverage", ".worker"]);

const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function files(root: string, directory = root): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...files(root, path));
    else found.push(path);
  }
  return found;
}

const readJson = (file: string) =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

/** The module specifiers a source file imports or re-exports, from the start of a statement. */
export function specifiers(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /^\s*(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/gmu,
    /^\s*import\s*["']([^"']+)["']/gmu,
    /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) if (match[1] !== undefined) found.push(match[1]);
  }
  return found;
}

/** The `@officehum/*` package a specifier names (`@officehum/sdk/engines` is `@officehum/sdk`). */
export const officehumPackage = (specifier: string): string | undefined =>
  /^@officehum\/[^/]+/u.exec(specifier)?.[0];

/** One package a workspace depends on, or one module a source file imports. */
export interface Reference {
  /** The file, by path from the root. */
  readonly at: string;
  /** The dependency field that names it, or `imports`. */
  readonly how: (typeof DEPENDENCY_FIELDS)[number] | "imports";
  readonly specifier: string;
  /** For a relative import, the path it resolves to from the root (`../x` when it leaves the root). */
  readonly target?: string;
}

/** Every dependency every `package.json` names and every module every source file imports. */
export function references(root: string): Reference[] {
  const found: Reference[] = [];
  for (const file of files(root)) {
    const at = relative(root, file).split(sep).join("/");
    if (file.endsWith("package.json") && statSync(file).isFile()) {
      const pkg = readJson(file);
      for (const how of DEPENDENCY_FIELDS) {
        for (const specifier of Object.keys((pkg[how] ?? {}) as Record<string, string>)) {
          found.push({ at, how, specifier });
        }
      }
    } else if (SOURCE.test(file)) {
      for (const specifier of specifiers(readFileSync(file, "utf8"))) {
        const target = specifier.startsWith(".")
          ? relative(root, resolve(dirname(file), specifier))
              .split(sep)
              .join("/")
          : undefined;
        found.push({ at, how: "imports", specifier, ...(target === undefined ? {} : { target }) });
      }
    }
  }
  return found;
}

/** The names of the workspace packages in the tree, from the root `package.json`'s `workspaces`. */
function workspaceNames(root: string): Set<string> {
  const names = new Set<string>();
  const rootPackage = join(root, "package.json");
  if (!existsSync(rootPackage)) return names;
  const globs = (readJson(rootPackage).workspaces ?? []) as string[];
  for (const glob of globs) {
    // npm workspaces here are a directory or `<directory>/*`.
    const parent = glob.endsWith("/*") ? join(root, glob.slice(0, -2)) : undefined;
    const directories =
      parent === undefined
        ? [join(root, glob)]
        : existsSync(parent)
          ? readdirSync(parent).map((entry) => join(parent, entry))
          : [];
    for (const directory of directories) {
      const pkg = join(directory, "package.json");
      if (!existsSync(pkg)) continue;
      const { name } = readJson(pkg);
      if (typeof name === "string") names.add(name);
    }
  }
  return names;
}

/** Every breach of the public boundary under `root`, one line each, by path from `root`. */
export function boundaryProblems(root: string): string[] {
  const problems: string[] = [];
  for (const name of readdirSync(root)) {
    if (!TOP_LEVEL.has(name)) problems.push(`${name}: not a top-level entry the public tree holds`);
  }
  const workspaces = workspaceNames(root);
  for (const { at, how, specifier, target } of references(root)) {
    const name = officehumPackage(specifier);
    if (name !== undefined && !workspaces.has(name)) {
      problems.push(
        how === "imports"
          ? `${at}: imports ${specifier}, which is not a workspace here`
          : `${at}: ${how} names ${specifier}, which is not a workspace here`,
      );
    } else if (target !== undefined && !TOP_LEVEL.has(target.split("/")[0] ?? "")) {
      problems.push(`${at}: imports ${specifier}, outside the public tree`);
    }
  }
  return problems.sort();
}
