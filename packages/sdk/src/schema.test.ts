/**
 * `schema/officehum.schema.json` is the editor-facing JSON Schema for `officehum.json`, generated from
 * `ManifestSchema` by `scripts/emit-schema.ts`. These tests are what keeps it generated: the first one
 * regenerates the document in memory and compares it with the committed file, so hand-editing the
 * file — or changing the manifest's TypeBox definitions without rebuilding — fails here.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MANIFEST_FILE } from "./manifest.js";
import {
  manifestSchemaDocument,
  manifestSchemaJson,
  SCHEMA_DIALECT,
  SCHEMA_ID,
  SCHEMA_TITLE,
} from "./schema.js";

const SDK_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_DIR = fileURLToPath(new URL("../../../", import.meta.url));
const COMMITTED = join(SDK_DIR, "schema", "officehum.schema.json");
const DOCS = join(REPO_DIR, "docs", "design", "agent-package.md");

const BUILD_HINT =
  "it is generated from ManifestSchema; run `npm run build -w @officehum/sdk` (do not hand-edit it)";

/** A parsed manifest, read only for the two fields these tests are about. */
interface Manifest {
  $schema?: string;
  id?: string;
}

const readManifest = (file: string): Manifest => JSON.parse(readFileSync(file, "utf8")) as Manifest;

/** The schema node at a dotted path, so a test says which field it means and nothing else. */
function node(document: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as Record<string, unknown>)[key];
  }, document);
}

/**
 * The example manifest in the design doc: the first JSON fence under the `officehum.json` heading.
 * Read rather than copied, so the doc's example is held to the same path-resolution rule a manifest in
 * a role package is.
 */
function docExample(): Manifest {
  const docs = readFileSync(DOCS, "utf8");
  const heading = docs.indexOf("## `officehum.json`");
  if (heading < 0) throw new Error(`${DOCS} has no \`officehum.json\` section`);
  const open = docs.indexOf("```json\n", heading);
  const close = open < 0 ? -1 : docs.indexOf("\n```", open);
  if (open < 0 || close < 0) throw new Error(`${DOCS} has no manifest example under that heading`);
  return JSON.parse(docs.slice(open + "```json\n".length, close)) as Manifest;
}

/** Folders with nothing to find in them: installed packages and build output. */
const SKIP = new Set(["node_modules", "dist", "coverage"]);

/** Every `officehum.json` in the repository — role packages, SDK fixtures, the factory's fixture. */
function manifestsUnder(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...manifestsUnder(path));
    else if (entry.name === MANIFEST_FILE) found.push(path);
  }
  return found;
}

const MANIFESTS = manifestsUnder(REPO_DIR).sort();

describe("the published manifest schema", () => {
  it("declares the dialect it is written in, an id and a title", () => {
    const document = manifestSchemaDocument();
    expect(document.$schema).toBe(SCHEMA_DIALECT);
    expect(document.$id).toBe(SCHEMA_ID);
    expect(document.title).toBe(SCHEMA_TITLE);
  });

  it("is exactly what the build emits, so the file cannot drift from ManifestSchema", () => {
    expect(
      readFileSync(COMMITTED, "utf8"),
      `schema/officehum.schema.json is stale: ${BUILD_HINT}`,
    ).toBe(manifestSchemaJson());
  });

  it("carries limits, tools[].noApproval and accepts[].done, the fields RASF-3229 added", () => {
    const document = manifestSchemaDocument();
    // A limit is a named amount the business sets: a description and a default, and nothing else. A
    // map of names, so its shape is the schema's pattern property.
    const limits = node(document, "properties.limits") as {
      patternProperties?: Record<string, { required?: string[]; additionalProperties?: boolean }>;
    };
    const amount = Object.values(limits.patternProperties ?? {})[0];
    expect(amount?.required).toEqual(["description", "default"]);
    expect(amount?.additionalProperties).toBe(false);
    expect(node(document, "properties.tools.items.properties.noApproval.type")).toBe("string");
    expect(node(document, "properties.tools.items.properties.noApproval.maxLength")).toBe(300);
    // Completion evidence is one of the four shapes the host can run, `done` is a list of them.
    expect(node(document, "properties.accepts.items.properties.done.type")).toBe("array");
    expect(node(document, "properties.accepts.items.properties.done.items.anyOf")).toHaveLength(4);
  });

  it("is in the files the package publishes", () => {
    // A schema the tarball leaves out is not published: an editor that installs @officehum/sdk gets
    // nothing to point `$schema` at.
    const pkg = JSON.parse(readFileSync(join(SDK_DIR, "package.json"), "utf8")) as {
      files?: string[];
    };
    expect(pkg.files).toContain("schema");
  });
});

describe("every role manifest points its editor at the schema", () => {
  it("finds the manifests to check", () => {
    // A scan that silently found nothing would pass every test below.
    expect(MANIFESTS.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of MANIFESTS) {
    it(`${relative(REPO_DIR, file)} declares a $schema that resolves`, () => {
      const declared = readManifest(file).$schema;
      expect(declared, `${relative(REPO_DIR, file)} declares no $schema`).toBeTypeOf("string");
      const target = resolve(dirname(file), String(declared));
      expect(
        existsSync(target),
        `$schema ${String(declared)} does not resolve from ${relative(REPO_DIR, file)}`,
      ).toBe(true);
      // It points at the published schema, not at some other file that happens to exist.
      expect(readFileSync(target, "utf8")).toBe(manifestSchemaJson());
    });
  }

  it("the design doc's example declares one too", () => {
    const example = docExample();
    const declared = example.$schema;
    expect(declared, "the example manifest in the design doc declares no $schema").toBeTypeOf(
      "string",
    );
    // The example is a role package's manifest, so it sits at agents/<id>/officehum.json; the path
    // it declares has to resolve from there, or an editor opening that package gets no completion.
    const from = join(REPO_DIR, "agents", String(example.id));
    expect(
      existsSync(resolve(from, String(declared))),
      `$schema ${String(declared)} does not resolve from agents/${String(example.id)}/officehum.json`,
    ).toBe(true);
  });
});
