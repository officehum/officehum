/** Helpers shared by the SDK's tests. Not exported from the package. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLE_DIR = fileURLToPath(new URL("../fixtures/sample-desk", import.meta.url));
export const ACME_OVERLAY = fileURLToPath(new URL("../fixtures/overlays/acme", import.meta.url));

const temps: string[] = [];

/** Writes files (path → content) into a new temporary directory named `name` and returns its path. */
export function tempDir(name: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "officehum-sdk-"));
  temps.push(root);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** Removes every directory `tempDir` made. Call from `afterEach`. */
export function removeTempDirs(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A SKILL.md with the given frontmatter lines and body. */
export function skillFile(frontmatter: string, body = "Do the work."): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}
