/**
 * `role.md` is a role's researched description of its job: what the function is, what it does, the
 * terms, workflows and principles it follows. Every list item ends with claim markers such as `[C3]`,
 * and `role.sources.json` backs each claim with a source and a passage quoted from it. The offline
 * check (`checkRoleMd`) runs in CI; the online one (`verifyRoleOnline`) re-fetches each source and is
 * run by hand, because pages change and CI must not depend on the network.
 */

import type { Issue } from "./issues.js";

export const ROLE_MD_FILE = "role.md";
export const ROLE_SOURCES_FILE = "role.sources.json";

/** The `##` headings `role.md` must have, in this order. */
export const ROLE_MD_SECTIONS = [
  "Function",
  "Responsibilities and actions",
  "Terminology",
  "Workflows",
  "Principles",
  "Systems",
  "Decisions that go to a manager",
  "Measures",
  "Sources",
] as const;

export const SOURCE_KINDS = [
  "professional-body",
  "standard",
  "government",
  "textbook",
  "vendor-docs",
  "other",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** A claim's passage must fit this many characters, so a quote stays a quote and not a copy. */
const MAX_PASSAGE = 400;

export interface RoleSources {
  schema: 1;
  role: string;
  researchedOn: string;
  sources: { id: string; url: string; title: string; kind: SourceKind; fetchedOn: string }[];
  claims: { id: string; sources: { source: string; passage: string }[] }[];
}

const MARKER_GROUP = /\[(C\d+(?:\s*,\s*C\d+)*)\]/g;
const TRAILING_MARKERS = /(?:\s*\[C\d+(?:\s*,\s*C\d+)*\])+\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const SOURCE_ITEM = /^\[(S\d+)\]\s+(.*?)\s+—\s+(\S+)\s*$/;

/** Checks `role.md` against `role.sources.json` without the network; reports every problem. */
export function checkRoleMd(markdown: string, sources: RoleSources): Issue[] {
  const issues: Issue[] = [];
  const md = (path: string, message: string) =>
    issues.push({ source: ROLE_MD_FILE, path, message });
  const json = (path: string, message: string) =>
    issues.push({ source: ROLE_SOURCES_FILE, path, message });

  // A file of the wrong shape would crash the checks below, so say so first.
  const shape = sourcesShapeIssues(sources);
  if (shape.length > 0) return shape;

  const sourceIds = new Set(sources.sources.map((source) => source.id));
  const claimIds = new Set(sources.claims.map((claim) => claim.id));

  const duplicates = (kind: string, key: string, ids: string[]) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id))
        json(`${key}[${index}].id`, `${kind} id ${id} is used twice; ids must be unique`);
      seen.add(id);
    });
  };
  duplicates(
    "source",
    "sources",
    sources.sources.map((source) => source.id),
  );
  duplicates(
    "claim",
    "claims",
    sources.claims.map((claim) => claim.id),
  );

  // The role.sources.json rules: claims have sources, sources exist, passages are short quotes.
  sources.claims.forEach((claim, claimIndex) => {
    if (claim.sources.length === 0) {
      json(
        `claims[${claimIndex}].sources`,
        `claim ${claim.id} has no source; give it at least one { "source", "passage" } or remove the claim`,
      );
    }
    claim.sources.forEach((entry, entryIndex) => {
      const at = `claims[${claimIndex}].sources[${entryIndex}]`;
      if (!sourceIds.has(entry.source)) {
        json(
          `${at}.source`,
          `"${entry.source}" is not a source in ${ROLE_SOURCES_FILE}; use one of its ids or add the source`,
        );
      }
      if (entry.passage.length < 1 || entry.passage.length > MAX_PASSAGE) {
        json(
          `${at}.passage`,
          `passage must be 1 to ${MAX_PASSAGE} characters (got ${entry.passage.length}); quote the supporting sentence only`,
        );
      }
    });
  });

  // Rule 6: every source is cited by at least one claim.
  const cited = new Set(sources.claims.flatMap((claim) => claim.sources.map((e) => e.source)));
  sources.sources.forEach((source, index) => {
    if (!cited.has(source.id)) {
      json(
        `sources[${index}]`,
        `source ${source.id} is not cited by any claim; cite it from a claim or remove it`,
      );
    }
  });

  // Sections, in order.
  const rows = markdown.split(/\r?\n/);
  const found: { name: string; line: number }[] = [];
  rows.forEach((row, index) => {
    const heading = /^##\s+(.*?)\s*$/.exec(row);
    const name = heading?.[1];
    if (name !== undefined && (ROLE_MD_SECTIONS as readonly string[]).includes(name)) {
      found.push({ name, line: index + 1 });
    }
  });
  let highest = -1;
  const seenSections = new Set<string>();
  for (const { name, line } of found) {
    if (seenSections.has(name)) {
      md(`line ${line}`, `section "${name}" appears twice; keep one "## ${name}" heading`);
    }
    seenSections.add(name);
    const position = ROLE_MD_SECTIONS.indexOf(name as (typeof ROLE_MD_SECTIONS)[number]);
    if (position < highest) {
      md(
        `line ${line}`,
        `section "${name}" is out of order; the sections run ${ROLE_MD_SECTIONS.join(", ")}`,
      );
    }
    highest = Math.max(highest, position);
  }
  for (const name of ROLE_MD_SECTIONS) {
    if (!found.some((entry) => entry.name === name)) {
      md("", `section "${name}" is missing; add a "## ${name}" heading in the order above`);
    }
  }

  // List items, section by section.
  let section: string | undefined;
  const listed: { id: string; title: string; url: string; line: number }[] = [];
  rows.forEach((row, index) => {
    const line = index + 1;
    const heading = /^##\s+(.*?)\s*$/.exec(row);
    if (heading !== null) {
      section = heading[1];
      return;
    }
    if (section === undefined || !(ROLE_MD_SECTIONS as readonly string[]).includes(section)) return;
    const item = LIST_ITEM.exec(row)?.[1];
    if (item === undefined) return;
    if (section === "Sources") {
      const match = SOURCE_ITEM.exec(item);
      if (match === null) {
        md(
          `Sources › line ${line}`,
          "a source line must look like `- [S1] Title — URL`; fix the line",
        );
        return;
      }
      listed.push({ id: match[1] ?? "", title: match[2] ?? "", url: match[3] ?? "", line });
      return;
    }
    const where = `${section} › line ${line}`;
    if (!TRAILING_MARKERS.test(item)) {
      md(where, "list item has no claim marker at its end; add one such as [C1] or cite it");
    }
    for (const group of item.matchAll(MARKER_GROUP)) {
      for (const id of (group[1] ?? "").split(",").map((part) => part.trim())) {
        if (!claimIds.has(id)) {
          md(where, `claim marker "${id}" is not a claim in ${ROLE_SOURCES_FILE}; add the claim`);
        }
      }
    }
  });

  // Rule 5: the Sources section lists exactly the sources in role.sources.json.
  const byId = new Map(sources.sources.map((source) => [source.id, source]));
  for (const entry of listed) {
    const source = byId.get(entry.id);
    if (source === undefined) {
      md(
        `Sources › line ${entry.line}`,
        `${entry.id} is not in ${ROLE_SOURCES_FILE}; remove the line or add the source`,
      );
    } else if (source.title !== entry.title || source.url !== entry.url) {
      md(
        `Sources › line ${entry.line}`,
        `${entry.id} differs from ${ROLE_SOURCES_FILE} (expected "${source.title} — ${source.url}")`,
      );
    }
  }
  for (const source of sources.sources) {
    if (!listed.some((entry) => entry.id === source.id)) {
      md(
        "Sources",
        `${source.id} is in ${ROLE_SOURCES_FILE} but not listed; add "- [${source.id}] ${source.title} — ${source.url}"`,
      );
    }
  }
  return issues;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks that `role.sources.json` has the shape the other checks rely on, reporting every element
 * that does not instead of throwing. An empty result means `checkRoleMd` and `verifyRoleOnline` can
 * read the file safely.
 */
export function sourcesShapeIssues(value: unknown): Issue[] {
  const issues: Issue[] = [];
  const bad = (path: string, message: string) =>
    issues.push({ source: ROLE_SOURCES_FILE, path, message });
  if (!isRecord(value)) {
    bad("", 'must be a JSON object with "sources" and "claims" arrays');
    return issues;
  }
  for (const key of ["sources", "claims"]) {
    if (!Array.isArray(value[key])) bad(key, `must be an array; add "${key}": []`);
  }
  if (Array.isArray(value.sources)) {
    value.sources.forEach((source: unknown, index) => {
      if (!isRecord(source)) {
        bad(`sources[${index}]`, "must be an object");
        return;
      }
      for (const key of ["id", "url", "title"]) {
        if (typeof source[key] !== "string" || source[key] === "") {
          bad(`sources[${index}].${key}`, "must be a non-empty string");
        }
      }
      if (!(SOURCE_KINDS as readonly unknown[]).includes(source.kind)) {
        bad(`sources[${index}].kind`, `must be one of ${SOURCE_KINDS.join(", ")}`);
      }
    });
  }
  if (Array.isArray(value.claims)) {
    value.claims.forEach((claim: unknown, index) => {
      if (!isRecord(claim)) {
        bad(`claims[${index}]`, "must be an object");
        return;
      }
      if (typeof claim.id !== "string" || claim.id === "") {
        bad(`claims[${index}].id`, "must be a non-empty string");
      }
      if (!Array.isArray(claim.sources)) {
        bad(`claims[${index}].sources`, "must be an array of { source, passage }");
        return;
      }
      claim.sources.forEach((entry: unknown, entryIndex) => {
        const at = `claims[${index}].sources[${entryIndex}]`;
        if (!isRecord(entry)) {
          bad(at, "must be an object with source and passage");
          return;
        }
        if (typeof entry.source !== "string") bad(`${at}.source`, "must be a source id string");
        if (typeof entry.passage !== "string") bad(`${at}.passage`, "must be a string");
      });
    });
  }
  return issues;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  ndash: "-",
  mdash: "-",
  hellip: "...",
};

/** Folds typographic quotes and dashes to ASCII so a passage matches however the page spells them. */
function asciiPunctuation(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const BLOCK_TAGS =
  "address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul";

/**
 * Reduces a fetched page to comparable text: script and style contents are dropped, block-level
 * tags become spaces and inline tags vanish (so a sentence split by `<em>` stays whole), entities
 * are decoded, and typographic punctuation is folded to ASCII. Plain text passes through unchanged
 * apart from that folding.
 */
export function htmlToText(html: string): string {
  const withoutCode = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const spaced = withoutCode
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), " ")
    .replace(/<\/?[a-z][^>]*>/gi, "");
  return asciiPunctuation(decodeEntities(spaced));
}

const normalise = (text: string) =>
  asciiPunctuation(decodeEntities(text)).replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Fetches each source once and reports every claim whose passage is not in its source's text, after
 * whitespace and case are normalised. A page that cannot be fetched is reported for each passage
 * that depended on it.
 */
export async function verifyRoleOnline(
  sources: RoleSources,
  fetchText: (url: string) => Promise<string>,
): Promise<Issue[]> {
  const shape = sourcesShapeIssues(sources);
  if (shape.length > 0) return shape;
  const issues: Issue[] = [];
  const pages = new Map<string, { text: string } | { error: string }>();
  for (const source of sources.sources) {
    try {
      pages.set(source.id, { text: normalise(htmlToText(await fetchText(source.url))) });
    } catch (error) {
      pages.set(source.id, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  const urls = new Map(sources.sources.map((source) => [source.id, source.url]));
  sources.claims.forEach((claim, claimIndex) => {
    claim.sources.forEach((entry, entryIndex) => {
      const page = pages.get(entry.source);
      const url = urls.get(entry.source) ?? entry.source;
      const path = `claims[${claimIndex}].sources[${entryIndex}]`;
      if (page === undefined) return; // an unknown source id is the offline check's finding
      if ("error" in page) {
        issues.push({
          source: ROLE_SOURCES_FILE,
          path,
          message: `claim ${claim.id}: could not fetch ${url} (${page.error}); check the URL`,
        });
      } else if (!page.text.includes(normalise(entry.passage))) {
        issues.push({
          source: ROLE_SOURCES_FILE,
          path,
          message: `claim ${claim.id}: passage not found at ${url}; re-read the source and fix the passage or the claim`,
        });
      }
    });
  });
  return issues;
}
