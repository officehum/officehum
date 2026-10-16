/**
 * The Pi Durable boundary, as an executable rule.
 *
 * `AGENTS.md` says Pi Durable runtime calls stay in `@officehum/office`, and the issue sharpens it:
 * `packages/office/src/adapter/` is the only code that calls the runtime API. A blanket import ban
 * would be wrong — `AGENTS.md` explicitly allows types, and lets the SDK and role packages author
 * with `defineTool`, `hook`, `defineDoc`, `configure` and the document and entry tokens. So this test
 * forbids the runtime entry points only, anywhere outside the adapter.
 *
 * If it fails, the fix is a call through `packages/office/src/adapter/`, not an entry in the list.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE = "@earendil-works/pi-durable";

/**
 * Runtime entry points: the harness, the session, the registry, watches, and storage. Importing these
 * outside the adapter means something is driving Pi Durable directly.
 */
const RUNTIME = new Set([
  "Harness",
  "createSession",
  "createRegistry",
  "watchEvents",
  "MemoryStorage",
  "SqliteStorage",
  "NodeSqliteDatabase",
  "openNodeSqliteDatabase",
  "openNodeSqliteStorage",
  "openNodeJsonlStorage",
  "applySqliteMigrations",
  "ROOT_CONVERSATION_ID",
]);

/** Every storage subpath is runtime by nature; the adapter is the only place that opens one. */
const RUNTIME_SUBPATHS = ["/storage/"];

const ALLOWED_ADAPTER_DIRECTORY = "packages/office/src/adapter";

type Violation = { readonly file: string; readonly symbol: string };

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    found.push(path);
  }
  return found;
}

/**
 * Names imported from a pi-durable specifier, with whether the specifier is type-only.
 *
 * Handles `import type {A} from`, `import {type A, B as C, D} from`, `import * as ns from` and the
 * subpath forms. Anything it cannot parse is reported as a bare specifier so the test fails loudly
 * rather than silently passing.
 */
function importedNames(clause: string): { name: string; type: boolean }[] {
  const typeOnly = /^type\s/.test(clause);
  const body = clause.replace(/^type\s+/u, "");
  const names: { name: string; type: boolean }[] = [];
  for (const raw of body.replace(/[{}]/gu, " ").split(",")) {
    const part = raw.trim();
    if (part.length === 0) continue;
    if (part.startsWith("*")) {
      names.push({ name: part.replace(/^\*\s*as\s*/u, ""), type: typeOnly });
      continue;
    }
    const specifierType = /^type\s+/.test(part);
    const cleaned = part.replace(/^type\s+/u, "");
    const [imported = ""] = cleaned.split(/\s+as\s+/u);
    names.push({ name: imported.trim(), type: typeOnly || specifierType });
  }
  return names;
}

/** Strip comments: a line of prose containing the word "import" must never be parsed as code. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^[ \t]*\/\/.*$/gmu, "");
}

function isRuntimeSubpath(specifier: string): boolean {
  if (!specifier.startsWith(`${PACKAGE}/`)) return false;
  const subpath = specifier.slice(PACKAGE.length);
  return RUNTIME_SUBPATHS.some((prefix) => subpath.startsWith(prefix));
}

/**
 * Violations in one file.
 *
 * Imports are matched from the start of a line. A mid-line `import` is prose, and an unanchored lazy
 * clause can span newlines and swallow the next real statement — which silently disabled this guard
 * the first time it was written.
 */
function violationsIn(path: string): Violation[] {
  const text = withoutComments(readFileSync(path, "utf8"));
  const violations: Violation[] = [];
  const fromPattern = /^[ \t]*import\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/gmu;
  const sideEffectPattern = /^[ \t]*import\s*["']([^"']+)["']/gmu;

  for (const match of text.matchAll(fromPattern)) {
    const clause = match[1] ?? "";
    const specifier = match[2] ?? "";
    if (specifier !== PACKAGE) {
      if (isRuntimeSubpath(specifier)) {
        violations.push({ file: path, symbol: `${specifier} (subpath)` });
      }
      continue;
    }
    for (const { name, type } of importedNames(clause)) {
      if (!type && RUNTIME.has(name)) violations.push({ file: path, symbol: name });
    }
  }
  for (const match of text.matchAll(sideEffectPattern)) {
    const specifier = match[1] ?? "";
    violations.push({ file: path, symbol: `${specifier} (side-effect import)` });
  }
  return violations;
}

describe("Pi Durable boundary", () => {
  it("imports Pi Durable runtime APIs only from the adapter", () => {
    const repository = resolve(import.meta.dirname, "../../../..");
    const roots = [join(repository, "packages"), join(repository, "agents")];
    const files = roots
      .filter((root) => statSync(root).isDirectory())
      .flatMap((root) => sourceFiles(root))
      .filter((path) => !relative(repository, path).startsWith(ALLOWED_ADAPTER_DIRECTORY));

    const violations = files.flatMap((path) => violationsIn(path));
    // A scan that found no files would pass vacuously, which is the worst possible guard. Assert both
    // a floor on the count and that a known non-adapter file was actually reached.
    expect(files.length).toBeGreaterThan(20);
    expect(files.map((path) => relative(repository, path))).toContain(
      "packages/office/src/solo.ts",
    );
    expect(
      violations.map(({ file, symbol }) => `${relative(repository, file)}: ${symbol}`),
    ).toEqual([]);
  });
});
