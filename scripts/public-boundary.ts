/**
 * The public boundary: what the public repository must never hold. The office (its
 * runtime, gateway, Studio, website and hosted pieces) lives in a private repository; this tree holds
 * the free agents and what they need to be installed, run one at a time and tested.
 *
 * `boundaryProblems(root)` lists every breach under `root`: a private path present, a workspace that
 * depends on a private package, or a source file that imports one or reaches into a private path. The
 * public tree's own test runs it on the repository; the private repository runs it on each export.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Packages that are the office's, by name. */
export const PRIVATE_PACKAGES = [
  "@officehum/office",
  "@officehum/office-cli",
  "@officehum/gateway",
  "@officehum/protocol",
  "@officehum/client",
  "@officehum/channels",
  "@officehum/connectors",
  "@officehum/connectors-composio",
  "@officehum/configurator",
  "@officehum/studio",
  "@officehum/site",
] as const;

/** Paths that are the office's; none may exist in the public tree. */
export const PRIVATE_PATHS = [
  "packages/office",
  "packages/office-cli",
  "packages/gateway",
  "packages/protocol",
  "packages/client",
  "packages/channels",
  "packages/connectors",
  "packages/connectors-composio",
  "agents/configurator",
  "apps",
  "deploy",
  "evals",
  "docs/office",
  "docs/handoffs",
  "docs/superpowers",
  "docs/drafts",
  "docs/research",
  "docs/audits",
  "docs/visualizations",
  "docs/design/spikes",
  "scripts/public-export",
] as const;

/** Directories no check reads: dependencies, build output and version control. */
const SKIPPED = new Set(["node_modules", "dist", ".git", "coverage", ".worker"]);

const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u;

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** A private package named exactly, so `@officehum/office-manager` is not `@officehum/office`. */
const privateName = new RegExp(`^(?:${PRIVATE_PACKAGES.map(escaped).join("|")})(?:/.*)?$`, "u");

/** Whether a path from the root is a private path or inside one. */
const isPrivatePath = (path: string) =>
  PRIVATE_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

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

/** Every breach of the public boundary under `root`, one line each, by path from `root`. */
export function boundaryProblems(root: string): string[] {
  const problems: string[] = [];
  for (const path of PRIVATE_PATHS) {
    if (existsSync(join(root, path)))
      problems.push(`${path}: a private path is in the public tree`);
  }
  for (const file of files(root)) {
    const at = relative(root, file);
    if (file.endsWith("package.json") && statSync(file).isFile()) {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const deps = (pkg[field] ?? {}) as Record<string, string>;
        for (const name of Object.keys(deps)) {
          if (privateName.test(name)) problems.push(`${at}: ${field} names ${name}`);
        }
      }
      if (typeof pkg.name === "string" && privateName.test(pkg.name)) {
        problems.push(`${at}: the package is ${pkg.name}, which is private`);
      }
      continue;
    }
    if (!SOURCE.test(file)) continue;
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      if (privateName.test(specifier)) problems.push(`${at}: imports ${specifier}`);
      else if (
        specifier.startsWith(".") &&
        isPrivatePath(
          relative(root, resolve(dirname(file), specifier))
            .split(sep)
            .join("/"),
        )
      ) {
        problems.push(`${at}: imports ${specifier}, a private path`);
      }
    }
  }
  return problems.sort();
}
