/**
 * `npm run licences`: scans every workspace's production dependencies against the licence
 * allowlist in `scripts/licences.ts` and rewrites `THIRD_PARTY_NOTICES.md`.
 *
 * Run it after changing dependencies and commit the notices with the lockfile; the test in
 * `scripts/licences.test.ts` fails if they drift. It exits non-zero when any package's licence is
 * not on the allowlist, naming each one and the workspaces that need it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderNotices, scanRepository } from "./licences.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const result = scanRepository(root);
const notices = join(root, "THIRD_PARTY_NOTICES.md");
const text = renderNotices(result);
let previous = "";
try {
  previous = readFileSync(notices, "utf8");
} catch {
  // First run: there is nothing to compare with.
}
if (text !== previous) writeFileSync(notices, text);
console.log(
  `licences: ${result.packages.length} production packages; THIRD_PARTY_NOTICES.md ${text === previous ? "already up to date" : "written"}.`,
);

for (const dependency of result.unresolved) {
  console.error(`licences: not in package-lock.json: ${dependency}. Run npm install.`);
}
for (const pkg of result.findings) {
  console.error(
    `licences: ${pkg.name}@${pkg.version} ${pkg.problem} (needed by ${pkg.usedBy.join(", ")}).`,
  );
}
if (result.findings.length > 0 || result.unresolved.length > 0) {
  console.error(
    "licences: replace the dependency, or ask the owner whether its licence may join the allowlist.",
  );
  process.exitCode = 1;
}
