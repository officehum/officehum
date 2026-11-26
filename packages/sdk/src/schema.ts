/**
 * The editor-facing JSON Schema for `officehum.json`.
 *
 * `ManifestSchema` is already JSON Schema in structure, so the published document is that structure
 * with the three keywords an editor needs to fetch and name it: `$schema`, `$id` and `title`. Nothing
 * here restates a field — the manifest's own definitions are the only source, and `schema.test.ts`
 * fails when the committed file and this module disagree, so the file cannot drift.
 *
 * The document is structural by design. `validateManifest` adds rules a JSON Schema cannot express —
 * unique tool names, reserved names, and the approval decision every unsafe tool states — and those
 * stay in code, where they report a path and a plain message.
 */

import { ManifestSchema } from "./manifest.js";

/** The directory, under the package root, that the built manifest schema is published in. */
export const SCHEMA_DIRECTORY = "schema";

/** The published schema's file name. */
export const SCHEMA_FILE = "officehum.schema.json";

/** The JSON Schema dialect the document declares: the one TypeBox's output is written in. */
export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * A stable name for the document. A URN rather than a URL because the schema is published in the
 * npm package, cited from a manifest by relative path, and has no separately hosted home to point at.
 */
export const SCHEMA_ID = "urn:officehum:schema:officehum.json:v1";

/** What the document is, for a tool that shows a title rather than a path. */
export const SCHEMA_TITLE = "Office Hum role manifest (officehum.json)";

/**
 * The document as data: the manifest's schema, with the three identifying keywords in front. Key
 * order is the manifest's own definition order, so the emitted file is byte-identical every build.
 */
export function manifestSchemaDocument(): Record<string, unknown> {
  return { $schema: SCHEMA_DIALECT, $id: SCHEMA_ID, title: SCHEMA_TITLE, ...ManifestSchema };
}

/** The document as the published file's text: two-space JSON, sorted order as defined, trailing `\n`. */
export function manifestSchemaJson(): string {
  return `${JSON.stringify(manifestSchemaDocument(), null, 2)}\n`;
}
