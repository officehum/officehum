/**
 * The docs check, in the normal suite so it needs no CI change:
 *
 * - every relative link in `README.md` and `docs/**\/*.md` points at a file or folder that exists,
 *   and every `#anchor` names a heading in the Markdown file it points at (by GitHub's slugs), or an
 *   `id` in an HTML file;
 * - every `officehum …` command in a fenced block of `docs/quickstart.md` names a command the CLI's
 *   own usage lists, with only the flags that usage line lists for it.
 *
 * The usage is read from the built CLI (`node packages/cli/dist/index.js` with no arguments prints
 * it), so `npm run check` runs this after the build, as it runs every other suite.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** `README.md` and every Markdown file under `docs/`, as paths from the repository root. */
function documents(): string[] {
  const found = ["README.md"];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) found.push(path);
    }
  };
  walk("docs");
  return found.sort();
}

/** The lines of a Markdown file outside fenced code blocks, each with its 1-based line number. */
function proseLines(text: string): { line: string; number: number }[] {
  const lines: { line: string; number: number }[] = [];
  let fence: string | undefined;
  text.split("\n").forEach((line, index) => {
    const marker = /^\s*(```+|~~~+)/u.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      return;
    }
    if (fence === undefined) lines.push({ line, number: index + 1 });
  });
  return lines;
}

/** The link targets on one prose line: inline `[text](target)` and reference `[id]: target`. */
function linkTargets(line: string): string[] {
  // Inline code spans hold examples, not links.
  const prose = line.replace(/`[^`]*`/gu, "");
  const targets: string[] = [];
  for (const match of prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu)) {
    if (match[1] !== undefined) targets.push(match[1]);
  }
  const reference = /^\s*\[[^\]]+\]:\s+<?(\S+?)>?(?:\s|$)/u.exec(prose)?.[1];
  if (reference !== undefined) targets.push(reference);
  targets.push(...imageSources(prose));
  return targets;
}

/** The files an HTML image on one line shows: `<img src>` and each `<source srcset>`'s first URL. */
function imageSources(line: string): string[] {
  const sources: string[] = [];
  for (const match of line.matchAll(/<(?:img|source)\b[^>]*?\s(?:src|srcset)="([^"\s]+)/gu)) {
    if (match[1] !== undefined) sources.push(match[1]);
  }
  return sources;
}

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .replace(/<[^>]+>/gu, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/gu, "-");
}

/** Every anchor a Markdown file offers: its headings' slugs (numbered when repeated) and HTML ids. */
function markdownAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const { line } of proseLines(text)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line)?.[1];
    if (heading !== undefined) {
      const base = slug(heading);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const match of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/gu)) {
      if (match[1] !== undefined) anchors.add(match[1]);
    }
  }
  return anchors;
}

/** Why a link from `from` to `target` does not resolve, or undefined when it does. */
function brokenLink(from: string, target: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) return undefined; // https:, mailto: and the like
  const hash = target.indexOf("#");
  const pathPart = decodeURIComponent(hash === -1 ? target : target.slice(0, hash));
  const anchor = hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1));
  const file = pathPart === "" ? join(root, from) : resolve(root, dirname(from), pathPart);
  if (!existsSync(file)) return `${relative(root, file)} does not exist`;
  if (anchor === undefined || anchor === "") return undefined;
  if (statSync(file).isDirectory()) return `#${anchor} points into a folder`;
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".md")) {
    return markdownAnchors(text).has(anchor)
      ? undefined
      : `${relative(root, file)} has no heading for #${anchor}`;
  }
  if (file.endsWith(".html")) {
    return text.includes(`id="${anchor}"`)
      ? undefined
      : `${relative(root, file)} has no id="${anchor}"`;
  }
  return undefined;
}

describe("documentation links", () => {
  it("resolves every relative link and anchor in README.md and docs/", () => {
    const broken: string[] = [];
    for (const document of documents()) {
      const text = readFileSync(join(root, document), "utf8");
      for (const { line, number } of proseLines(text)) {
        for (const target of linkTargets(line)) {
          const problem = brokenLink(document, target);
          if (problem !== undefined) broken.push(`${document}:${number}: ${target}: ${problem}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("reads the images an HTML picture shows as links", () => {
    expect(
      linkTargets(
        '<source media="(prefers-color-scheme: dark)" srcset="docs/assets/a-dark.svg 2x">',
      ),
    ).toEqual(["docs/assets/a-dark.svg"]);
    expect(linkTargets('<img alt="A diagram" src="docs/assets/a-light.svg" width="560">')).toEqual([
      "docs/assets/a-light.svg",
    ]);
  });

  it("slugs headings as GitHub does", () => {
    expect(slug("`officehum.json`")).toBe("officehumjson");
    expect(slug("Engines: a role's deterministic core")).toBe("engines-a-roles-deterministic-core");
    expect(slug("2. What no overlay can lower (hard floors that stay code)")).toBe(
      "2-what-no-overlay-can-lower-hard-floors-that-stay-code",
    );
    expect(slug("Triggers (cron and events)")).toBe("triggers-cron-and-events");
  });
});

describe("the README's diagrams (docs/assets)", () => {
  const directory = join(root, "docs", "assets");
  const files = existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith(".svg"))
    : [];

  it("are small, self-contained SVGs with a title and a description", () => {
    // GitHub and npm show these as images: nothing is fetched, nothing runs, and a screen reader
    // has the title and description.
    const problems = files.flatMap((name) => {
      const text = readFileSync(join(directory, name), "utf8");
      return [
        text.length > 16_384 ? `${name} is ${text.length} bytes; keep a diagram under 16 KB` : "",
        /<title[\s>]/u.test(text) ? "" : `${name} has no <title>`,
        /<desc[\s>]/u.test(text) ? "" : `${name} has no <desc>`,
        /<(?:script|style|image|foreignObject)[\s>]/u.test(text)
          ? `${name} holds a script, style, raster image or foreign object`
          : "",
        /(?:href|src)="(?:https?:)?\/\//u.test(text) ? `${name} loads something from outside` : "",
      ].filter((problem) => problem !== "");
    });
    expect(problems).toEqual([]);
  });

  it("come in light and dark pairs", () => {
    const unpaired = files.filter((name) => {
      const pair = name.endsWith("-light.svg")
        ? name.replace(/-light\.svg$/u, "-dark.svg")
        : name.endsWith("-dark.svg")
          ? name.replace(/-dark\.svg$/u, "-light.svg")
          : undefined;
      return pair === undefined || !files.includes(pair);
    });
    expect(unpaired).toEqual([]);
  });
});

/** Splits a shell command line into words, honouring single and double quotes. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  for (const match of line.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/gu)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return words;
}

/**
 * Every `officehum …` command in the quickstart's shell blocks (```sh), as words after `officehum`.
 * Output blocks (```text) are what a command printed, not commands.
 */
function quickstartCommands(): { command: string; words: string[] }[] {
  const text = readFileSync(join(root, "docs", "quickstart.md"), "utf8");
  const commands: { command: string; words: string[] }[] = [];
  let fence: "shell" | "other" | undefined;
  let pending = "";
  for (const raw of text.split("\n")) {
    const opening = /^\s*```(\S*)/u.exec(raw);
    if (opening !== null) {
      if (fence === undefined) {
        fence = ["sh", "bash", "shell", "console"].includes(opening[1] ?? "") ? "shell" : "other";
      } else fence = undefined;
      pending = "";
      continue;
    }
    if (fence !== "shell") continue;
    const line = pending + raw.trim();
    if (line.endsWith("\\")) {
      pending = `${line.slice(0, -1)} `;
      continue;
    }
    pending = "";
    const words = shellWords(line.replace(/\s+#.*$/u, ""));
    const start = words[0] === "npx" ? 1 : 0;
    if (words[start] === "officehum")
      commands.push({ command: line, words: words.slice(start + 1) });
  }
  return commands;
}

/** The CLI's usage: one entry per `officehum …` line it prints, with its leading words and flags. */
function usageLines(): { words: string[]; flags: Set<string>; line: string }[] {
  const cli = join(root, "packages", "cli", "dist", "index.js");
  if (!existsSync(cli)) throw new Error(`${cli} is missing; run npm run build first.`);
  const run = spawnSync(process.execPath, [cli], { encoding: "utf8" });
  const printed = `${run.stdout}\n${run.stderr}`;
  return printed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("officehum "))
    .map((line) => {
      const words: string[] = [];
      for (const word of line.split(/\s+/u).slice(1)) {
        // The fixed words of a command end at its first placeholder, option or flag.
        if (!/^[a-z][a-z-]*$/u.test(word)) break;
        words.push(word);
      }
      return { words, flags: new Set(line.match(/--[a-z][a-z-]*/gu) ?? []), line };
    });
}

describe("quickstart commands", () => {
  it("finds the quickstart's commands", () => {
    expect(quickstartCommands().length).toBeGreaterThan(5);
  });

  it("uses only commands and flags the CLI's usage lists", () => {
    const usage = usageLines();
    expect(usage.length).toBeGreaterThan(5);
    const problems: string[] = [];
    for (const { command, words } of quickstartCommands()) {
      // The usage line with the longest run of fixed words this command starts with.
      const matches = usage
        .filter((entry) => entry.words.every((word, index) => words[index] === word))
        .filter((entry) => entry.words.length > 0 || words[0]?.startsWith("--") === true)
        .sort((left, right) => right.words.length - left.words.length);
      const best = matches[0];
      if (best === undefined) {
        problems.push(`${command}: no such command in the CLI's usage`);
        continue;
      }
      for (const flag of words.filter((word) => word.startsWith("--"))) {
        if (!best.flags.has(flag)) problems.push(`${command}: ${flag} is not in "${best.line}"`);
      }
    }
    expect(problems).toEqual([]);
  });
});
