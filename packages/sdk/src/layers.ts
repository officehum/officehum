/**
 * The four-layer check: **context and knowledge inform the agent; wisdom and workflow control it.**
 * Every issue it reports is tagged with its layer and its severity, so a role can be judged the same
 * way whether a person wrote it or the Role Factory generated it. See "Four layers" in
 * docs/design/agent-package.md.
 *
 * Strict mode (a role under `agents/`, or a generated package; `validatePackage` decides) makes every
 * issue an error. Otherwise context, knowledge and workflow issues are warnings, while wisdom issues
 * stay errors: a shell tool in a role is never a matter of taste.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type FourLayer, type Issue, show } from "./issues.js";
import { type AgentManifest, MANIFEST_FILE } from "./manifest.js";
import { ROLE_FILES } from "./resources.js";
import { SKILL_FILE } from "./skills.js";

/**
 * Pi Durable's own coding tools plus the generic names a role must never register, and what each is.
 * A role works through its declared tools and reads its references with `read_skill`; nothing in it
 * grants a shell or the package's (or the host's) file system.
 */
export const GENERIC_TOOLS: Readonly<Record<string, string>> = {
  bash: "shell tool",
  powershell: "shell tool",
  read: "file-reading tool",
  write: "file-writing tool",
  edit: "file-writing tool",
};

/** AGENTS.md budget: 1,000 words is the limit, 800 is where it starts crowding out the work. */
export const AGENTS_WORDS_MAX = 1000;
export const AGENTS_WORDS_WARN = 800;

/** Folders a role package never holds: input and output live in the host's own directories. */
export const HOST_FOLDERS = ["data", "work", "deliverables"] as const;

/** Numbers belong in a gate the code reads, never in the context the model reads every turn. */
const THRESHOLDS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  // Money and percentages come first, so a number is reported once, as itself rather than as the
  // wording around it.
  { pattern: /\$\s?\d[\d,]*(?:\.\d+)?/g, what: "a money amount" },
  { pattern: /\d+(?:\.\d+)?\s?(?:%|percent(?:age)?)/gi, what: "a percentage" },
  { pattern: /\blimit of\b/gi, what: "a threshold" },
  {
    pattern:
      /\b(?:up to|no more than|more than|at most|at least|fewer than|greater than|less than|over|under|exceeds?)\s+\$?\d[\d,]*/gi,
    what: "a threshold",
  },
];

/** Where a threshold belongs, said the same way wherever one is found in context. */
const NUMBER_HOME =
  'a number belongs in an approval "when", an overlay limit, or a skill reference, never in the context the model reads every turn';

export interface CheckFourLayersOptions {
  /** Every issue an error, for the free department roles and for Role Factory output. */
  readonly strict?: boolean;
}

type AddIssue = (layer: FourLayer, source: string, path: string, message: string) => void;

/**
 * Checks a role package against the four layers and reports every issue with its layer and severity.
 * The manifest is the caller's parsed `officehum.json`; the files are read from `packageDir`.
 */
export function checkFourLayers(
  packageDir: string,
  manifest: AgentManifest,
  options: CheckFourLayersOptions = {},
): readonly Issue[] {
  const strict = options.strict ?? false;
  const issues: Issue[] = [];
  const add: AddIssue = (layer, source, path, message) =>
    issues.push({ source, path, message, layer, severity: severityFor(layer, strict) });

  contextIssues(packageDir, add);
  knowledgeIssues(packageDir, add);
  wisdomIssues(manifest, add);
  workflowIssues(manifest, add);
  return issues;
}

function severityFor(layer: FourLayer, strict: boolean): "error" | "warning" {
  return strict || layer === "wisdom" ? "error" : "warning";
}

/** Context: the word budget, no numbers or thresholds, and a "You may not" section. */
function contextIssues(packageDir: string, add: AddIssue): void {
  const agents = readText(join(packageDir, ROLE_FILES.agents));
  if (agents !== undefined) {
    const words = countWords(agents);
    if (words > AGENTS_WORDS_MAX) {
      add(
        "context",
        ROLE_FILES.agents,
        "",
        `is ${words} words; keep AGENTS.md under ${AGENTS_WORDS_MAX} words and move the detail into a skill or one of its reference files`,
      );
    } else if (words > AGENTS_WORDS_WARN) {
      add(
        "context",
        ROLE_FILES.agents,
        "",
        `is ${words} words; AGENTS.md reads best under ${AGENTS_WORDS_WARN}, so move the detail into a skill or one of its reference files`,
      );
    }
    if (!/^#{1,6}[ \t]*you may not\b/im.test(agents)) {
      add(
        "context",
        ROLE_FILES.agents,
        "",
        'has no "You may not" section; add a heading like "## You may not" saying what this role never does',
      );
    }
  }

  // APPEND_SYSTEM.md is optional; when it is there it is context too.
  for (const file of [ROLE_FILES.agents, ROLE_FILES.appendSystem]) {
    const text = readText(join(packageDir, file));
    if (text === undefined) continue;
    for (const match of thresholdMatches(text)) {
      add("context", file, "", `states ${show(match.text)} (${match.what}); ${NUMBER_HOME}`);
    }
  }
}

/** One number found in a context file: where it is, the text itself, and what kind of number it is. */
type NumberFound = { readonly index: number; readonly text: string; readonly what: string };

/**
 * Every amount, percentage and threshold wording in a context file, once each. Money and percentages
 * are matched first, so "invoices over $2,500" is reported as `$2,500`, not as the wording around it.
 */
function thresholdMatches(text: string): NumberFound[] {
  const taken: { readonly start: number; readonly end: number }[] = [];
  const matches: NumberFound[] = [];
  for (const { pattern, what } of THRESHOLDS) {
    // matchAll clones the pattern, so these shared `g` regexes keep no state between files.
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (taken.some((range) => start < range.end && range.start < end)) continue;
      taken.push({ start, end });
      matches.push({ index: start, text: match[0], what });
    }
  }
  matches.sort((left, right) => left.index - right.index);
  return matches;
}

/** Knowledge: reference files only inside `skills/<id>/references/`, and no host folders. */
function knowledgeIssues(packageDir: string, add: AddIssue): void {
  for (const folder of HOST_FOLDERS) {
    if (!isDirectory(join(packageDir, folder))) continue;
    add(
      "knowledge",
      folder,
      "",
      "is not a role file; a package holds instructions and references, and the engine reads the host's OFFICEHUM_DATA_DIR and OFFICEHUM_WORK_DIR at run time",
    );
  }

  for (const path of listFiles(join(packageDir, ROLE_FILES.skills))) {
    const [skill, second] = path.split("/");
    if (second === SKILL_FILE) continue;
    if (second === "references") continue;
    add(
      "knowledge",
      `${ROLE_FILES.skills}/${path}`,
      "",
      second === undefined
        ? `is not a skill; a skill is a folder holding ${SKILL_FILE}, with what the agent reads on demand in its references/ folder`
        : `is outside references/; move it to skills/${skill}/references/ so the agent loads it with read_skill`,
    );
  }
}

/**
 * Wisdom: the role's tool list, which is exactly what `checkAgent` holds the role bundle to, so a
 * generic shell or file tool shows up here whichever way the tool was written.
 */
function wisdomIssues(manifest: AgentManifest, add: AddIssue): void {
  manifest.tools.forEach((tool, index) => {
    const what = GENERIC_TOOLS[tool.name];
    if (what === undefined) return;
    add(
      "wisdom",
      MANIFEST_FILE,
      `tools[${index}].name`,
      `${show(tool.name)} is a generic ${what}; a role registers no shell or file tool, so work through the role's declared tools (read_skill reads its references)`,
    );
  });
}

/** Workflow: nobody talks a status into existence, so every accepted type declares its evidence. */
function workflowIssues(manifest: AgentManifest, add: AddIssue): void {
  manifest.accepts.forEach((accept, index) => {
    if (accept.done !== undefined && accept.done.length > 0) return;
    add(
      "workflow",
      MANIFEST_FILE,
      `accepts[${index}].done`,
      `is required for ${show(accept.type)}: a ticket is done only when its evidence checks out — an engine check, a safe tool with expect "found", a file, or { "person": true }`,
    );
  });
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** Every file under a directory, as `/`-joined paths relative to it; skips dependencies and dot dirs. */
function listFiles(dir: string, prefix = ""): string[] {
  if (!isDirectory(join(dir, prefix))) return [];
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? listFiles(dir, path) : [path];
  });
}
