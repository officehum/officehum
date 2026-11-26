/**
 * `npm run sync-company` run for real: `node scripts/sync-company.ts`, as npm runs it, in a temporary
 * copy of the files it reads and writes.
 *
 * The drift tests in `company.test.ts` call `renderAll` under Vitest, which resolves a `.js` import to
 * its `.ts` source. Node's type stripping does not, so an import that works in the tests can still
 * break the command; only running the entry point under Node shows it. The copy keeps the command
 * from ever rewriting this repository's handbooks during a test.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const copy = mkdtempSync(join(tmpdir(), "officehum-sync-company-"));
afterAll(() => rmSync(copy, { recursive: true, force: true }));

/** The sync's inputs and outputs: its scripts, the SDK source they import, the company, each role. */
function copyTree(): void {
  const take = (path: string): void => {
    if (existsSync(join(root, path)))
      cpSync(join(root, path), join(copy, path), { recursive: true });
  };
  take("scripts");
  take("packages/sdk/src");
  take("company/default");
  for (const role of readdirSync(join(root, "agents"), { withFileTypes: true })) {
    if (!role.isDirectory()) continue;
    for (const file of ["officehum.json", "package.json", "skills/company-handbook"]) {
      take(`agents/${role.name}/${file}`);
    }
  }
}

const sync = (): string =>
  execFileSync(process.execPath, [join(copy, "scripts", "sync-company.ts")], {
    cwd: copy,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

describe("npm run sync-company", () => {
  copyTree();

  it("runs under Node and finds every generated file already up to date", () => {
    expect(sync()).toMatch(/^sync-company: \d+ generated files already up to date\.\n$/u);
  });

  it("rewrites a generated file that drifted", () => {
    const handbook = join(copy, "agents", "frontdesk", "skills", "company-handbook", "SKILL.md");
    writeFileSync(handbook, "edited by hand\n");
    expect(sync()).toContain(
      "sync-company: wrote agents/frontdesk/skills/company-handbook/SKILL.md",
    );
    expect(sync()).toMatch(/already up to date/u);
  });
});
