/**
 * A copy of a role package whose factory records the options it was called with, so a test can
 * assert what a host handed the role (`loadRole`'s reserved options, the eval runner's sender)
 * without the role having to expose them.
 *
 * The copy keeps the original package's files, so it validates exactly as the original does; only
 * its entry point changes, to a wrapper that imports the original entry by absolute URL — the
 * original's own relative imports still resolve from where it lives — records the options and
 * returns what the original factory returns.
 */

import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** A recording copy: its directory (the caller removes it) and the options its factory last saw. */
export interface RecordingRole {
  readonly dir: string;
  options(): Readonly<Record<string, unknown>> | undefined;
}

const RECORDINGS = Symbol.for("officehum.testing.recordingRole");

type Recordings = Map<string, Readonly<Record<string, unknown>>>;

function recordings(): Recordings {
  const holder = globalThis as { [RECORDINGS]?: Recordings };
  holder[RECORDINGS] ??= new Map();
  return holder[RECORDINGS];
}

/** Copies the package at `source` into a temporary directory with a recording entry point. */
export async function recordingRole(source: string): Promise<RecordingRole> {
  const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as {
    main?: unknown;
  };
  if (typeof pkg.main !== "string") {
    throw new Error(`${source}/package.json has no "main"; recordingRole wraps a "main" entry.`);
  }
  const original = pathToFileURL(resolve(source, pkg.main)).href;

  const dir = await mkdtemp(join(tmpdir(), "officehum-recording-role-"));
  await cp(source, dir, { recursive: true });
  const entry = "src/recording-entry.ts";
  await writeFile(
    join(dir, entry),
    [
      `import factory from ${JSON.stringify(original)};`,
      "export default function recording(options: Record<string, unknown>) {",
      '  const recordings = (globalThis as any)[Symbol.for("officehum.testing.recordingRole")];',
      `  recordings?.set(${JSON.stringify(dir)}, options);`,
      "  return factory(options as never);",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(join(dir, "package.json"), JSON.stringify({ ...pkg, main: `./${entry}` }));
  recordings();
  return { dir, options: () => recordings().get(dir) };
}
