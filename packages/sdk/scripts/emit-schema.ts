/**
 * Writes `schema/officehum.schema.json` — the editor-facing JSON Schema for `officehum.json`.
 *
 * The build runs this (`npm run build -w @officehum/sdk`), after `tsc`, so the published file is
 * emitted from the same `ManifestSchema` the build just compiled and cannot drift from it. It reads
 * the built module rather than the source because this file is TypeScript run by Node's type
 * stripping, which does not rewrite `./x.js` specifiers to `x.ts`.
 *
 * The file is deliberately not hand-editable: `schema.test.ts` regenerates it in memory and fails on
 * any difference.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestSchemaJson, SCHEMA_DIRECTORY, SCHEMA_FILE } from "../dist/schema.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const target = join(packageDir, SCHEMA_DIRECTORY, SCHEMA_FILE);

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, manifestSchemaJson());

console.log(`emitted ${SCHEMA_DIRECTORY}/${SCHEMA_FILE}`);
