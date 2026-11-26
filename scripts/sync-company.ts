/**
 * `npm run sync-company`: writes the company package into every role under `agents/`.
 *
 * It is one command and no flags on purpose. The copies are generated, so there is nothing to
 * choose: run it after editing `company/default/`, commit what it wrote, and the drift test in
 * `scripts/company.test.ts` will keep the next person honest.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncCompany } from "./company.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { written, unchanged } = syncCompany(root);

if (written.length === 0) {
  console.log(`sync-company: ${unchanged.length} generated files already up to date.`);
} else {
  for (const path of written) console.log(`sync-company: wrote ${join(".", path)}`);
  console.log(
    `sync-company: ${written.length} written, ${unchanged.length} already up to date. Commit them with the company change.`,
  );
}
