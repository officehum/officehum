/**
 * The templates a document can be rendered from: the six built-ins this package ships in
 * `templates/`, and a business's own from its overlay (`templates/<name>.typ` with
 * `<name>.schema.json`, read by the SDK's `resolveRoleFiles`). An overlay template with a built-in's
 * name replaces it.
 *
 * A built-in renders PDF from its Typst source, and Word and Excel from a layout in code
 * (`layouts.ts`). An overlay template is Typst only, so it renders PDF only.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ResolvedTemplate } from "@officehum/sdk";

export const TEMPLATE_FORMATS = ["pdf", "docx", "xlsx"] as const;
export type TemplateFormat = (typeof TEMPLATE_FORMATS)[number];

export const BUILTIN_TEMPLATES = [
  "letter",
  "memo",
  "report",
  "quote",
  "customer-statement",
  "meeting-notes",
] as const;
export type BuiltinTemplateName = (typeof BUILTIN_TEMPLATES)[number];

/** Which formats each built-in renders. Prose has no spreadsheet; the rest have all three. */
const BUILTIN_FORMATS: Readonly<Record<BuiltinTemplateName, readonly TemplateFormat[]>> = {
  letter: ["pdf", "docx"],
  memo: ["pdf", "docx"],
  report: ["pdf", "docx", "xlsx"],
  quote: ["pdf", "docx", "xlsx"],
  "customer-statement": ["pdf", "docx", "xlsx"],
  "meeting-notes": ["pdf", "docx"],
};

/**
 * Bumped when a built-in's Word or Excel layout changes, so the version a generated file records
 * changes with what produced it. The Typst source and schema are hashed directly.
 */
const LAYOUT_VERSION = "1";

/** The helper library every compile directory holds; overlay templates may import it too. */
export const HELPER_FILE = "_officehum.typ";

export interface DocumentTemplate {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly schema: Readonly<Record<string, unknown>>;
  /** The Typst source. */
  readonly source: string;
  readonly origin: "builtin" | "overlay";
  /** `sha256:` and the first 16 hex digits of a hash of everything that renders it. */
  readonly version: string;
  readonly formats: readonly TemplateFormat[];
}

const TEMPLATE_DIR = new URL("../templates/", import.meta.url);

let helper: string | undefined;

/** The helper library's source. */
export function helperSource(): string {
  helper ??= readFileSync(new URL(HELPER_FILE, TEMPLATE_DIR), "utf8");
  return helper;
}

let builtins: readonly DocumentTemplate[] | undefined;

export function builtinTemplates(): readonly DocumentTemplate[] {
  builtins ??= BUILTIN_TEMPLATES.map((name) => {
    const source = readFileSync(new URL(`${name}.typ`, TEMPLATE_DIR), "utf8");
    const schema = JSON.parse(
      readFileSync(new URL(`${name}.schema.json`, TEMPLATE_DIR), "utf8"),
    ) as Record<string, unknown>;
    return describe(name, source, schema, "builtin", BUILTIN_FORMATS[name], LAYOUT_VERSION);
  });
  return builtins;
}

export function overlayTemplate(template: ResolvedTemplate): DocumentTemplate {
  return describe(template.name, template.source, template.schema, "overlay", ["pdf"], null);
}

/** Every template by name: the built-ins, with the overlay's own added or replacing them. */
export function templateCatalog(
  overlays: readonly ResolvedTemplate[],
): ReadonlyMap<string, DocumentTemplate> {
  const catalog = new Map(builtinTemplates().map((template) => [template.name, template]));
  for (const template of overlays) catalog.set(template.name, overlayTemplate(template));
  return new Map([...catalog].sort(([left], [right]) => left.localeCompare(right)));
}

export function isBuiltin(template: DocumentTemplate): template is DocumentTemplate & {
  readonly name: BuiltinTemplateName;
} {
  return template.origin === "builtin";
}

function describe(
  name: string,
  source: string,
  schema: Readonly<Record<string, unknown>>,
  origin: DocumentTemplate["origin"],
  formats: readonly TemplateFormat[],
  layout: string | null,
): DocumentTemplate {
  const digest = createHash("sha256")
    .update(JSON.stringify({ source, schema, helper: helperSource(), layout }))
    .digest("hex");
  return {
    name,
    title: typeof schema.title === "string" ? schema.title : name,
    description: typeof schema.description === "string" ? schema.description : "",
    schema,
    source,
    origin,
    version: `sha256:${digest.slice(0, 16)}`,
    formats,
  };
}
