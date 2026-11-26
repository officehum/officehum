/**
 * The overlay check against a fake `typst`: an overlay's templates are compiled with sample data
 * from their schemas, a failure comes back as the store's problem shape with the compiler's
 * message, and a missing Typst refuses rather than waving templates through. The real compiler's
 * version of the broken-template case is in `typst-real.test.ts`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentManifest, resolveRoleFiles } from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { overlayTemplateValidator } from "./overlay.js";
import {
  FIXTURE_DIR,
  FIXTURE_MANIFEST,
  fakeTypst,
  removeTempDirs,
  tempDir,
} from "./test-helpers.js";

afterEach(removeTempDirs);

const schema = JSON.stringify({
  type: "object",
  required: ["title"],
  properties: { title: { type: "string" } },
});

/** An overlay named `acme` holding `templates`, resolved the way the store resolves a draft. */
function resolved(templates: Record<string, string>, lower: Record<string, string> = {}) {
  const dirs = [
    ["base", lower],
    ["acme", templates],
  ] as const;
  const overlays = dirs.map(([name, files]) => {
    const dir = join(tempDir(), name);
    mkdirSync(join(dir, "templates"), { recursive: true });
    for (const [file, content] of Object.entries(files))
      writeFileSync(join(dir, "templates", file), content);
    return dir;
  });
  const result = resolveRoleFiles({
    packageDir: FIXTURE_DIR,
    manifest: FIXTURE_MANIFEST as AgentManifest,
    overlays,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return { layer: "overlay acme", resolved: result.value };
}

describe("overlayTemplateValidator", () => {
  it("accepts a template that compiles with sample data from its schema", () => {
    const typst = fakeTypst();
    const check = overlayTemplateValidator({ typst: typst.binary });
    expect(
      check(resolved({ "price-list.typ": "= Prices", "price-list.schema.json": schema })),
    ).toEqual([]);
    const [run] = typst.runs();
    expect(JSON.parse(run?.files["data.json"] ?? "")).toEqual({ title: "Sample" });
    expect(Object.keys(run?.files ?? {}).sort()).toEqual([
      "_officehum.typ",
      "brand.json",
      "data.json",
      "price-list.typ",
    ]);
  });

  it("rejects a template that does not compile, with the compiler's message", () => {
    const check = overlayTemplateValidator({ typst: fakeTypst().binary });
    expect(check(resolved({ "quote.typ": "FAKE_ERROR", "quote.schema.json": schema }))).toEqual([
      {
        source: "overlay acme/templates/quote.typ",
        path: "",
        message:
          "does not compile with sample data from its schema: quote.typ:2:5: error: unknown variable: nope",
      },
    ]);
  });

  it("checks only the owned overlay's templates, not the read-only layers below it", () => {
    const typst = fakeTypst();
    const check = overlayTemplateValidator({ typst: typst.binary });
    expect(check(resolved({}, { "old.typ": "FAKE_ERROR", "old.schema.json": schema }))).toEqual([]);
    expect(typst.runs()).toEqual([]);
  });

  it("refuses a template it cannot check because Typst is missing", () => {
    const check = overlayTemplateValidator({ typst: join(tempDir(), "typst") });
    const [problem] = check(resolved({ "quote.typ": "= Quote", "quote.schema.json": schema }));
    expect(problem?.source).toBe("overlay acme/templates/quote.typ");
    expect(problem?.message).toMatch(
      /^cannot be checked, so it is not accepted: .* does not run as Typst; install Typst 0\.13\.1/u,
    );
  });

  it("refuses a schema whose own sample data does not match it", () => {
    const check = overlayTemplateValidator({ typst: fakeTypst().binary });
    const bad = JSON.stringify({
      type: "object",
      examples: [{ title: 1 }],
      properties: { title: { type: "string" } },
    });
    const [problem] = check(resolved({ "quote.typ": "= Quote", "quote.schema.json": bad }));
    expect(problem?.message).toMatch(/data\.title must be string/u);
  });
});
