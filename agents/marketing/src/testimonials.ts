/**
 * What counts as an invented testimonial, in code.
 *
 * Marketing quotes a customer only word for word from the company's record. A model cannot be
 * trusted to notice that a plausible quote it wrote is made up, so the desk runs this check on every
 * draft: a quoted passage of six words or more that is attributed to someone and is not exactly a
 * quote on record is refused. It is not a claim a person can approve; the draft is not saved.
 *
 * Attributed means a dash and a name after the quote ("— Name"), a speech verb before or after it
 * ("says Name", "Name said", `Name wrote: "…"`), or "according to". An unattributed quoted phrase,
 * and a short one ("always on time"), is ordinary writing and is left alone.
 */

import type { Testimonial } from "./company.js";

/** A quoted passage this long, attributed to someone, has to be on record. */
export const TESTIMONIAL_MIN_WORDS = 6;

const QUOTED = /["“„«]([^"”“«»]+)["”»]/g;
const NAME = String.raw`[A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,3}`;
const SPEECH = String.raw`(?:said|says|writes|wrote|adds|added|told\s+us)`;
/** After the quote: a dash, or a speech verb, or a name and a speech verb. */
const AFTER = new RegExp(
  String.raw`^[\s,.]*(?:[—–~]|-{1,2}\s*\S|${SPEECH}\b|${NAME}\s+${SPEECH}\b)`,
);
/** Before the quote: a speech verb (with a name between), or "according to", then a colon or comma. */
const BEFORE = new RegExp(
  String.raw`(?:\b${SPEECH}\b|\baccording\s+to\b)[^"“„«]{0,60}[:,]?\s*$`,
  "i",
);

/** Case, quote style, spacing and closing punctuation inside the marks do not make a quote different. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,]+$/, "")
    .trim();
}

function words(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/**
 * Every quoted, attributed passage in `text` of {@link TESTIMONIAL_MIN_WORDS} words or more that is
 * not exactly the `quote` of a recorded testimonial, as written, in order.
 */
export function findUnrecordedTestimonials(
  text: string,
  recorded: readonly Pick<Testimonial, "quote">[],
): string[] {
  const known = new Set(recorded.map((entry) => plain(entry.quote)));
  const normal = text.normalize("NFKC");
  const found: string[] = [];
  for (const match of normal.matchAll(QUOTED)) {
    const passage = (match[1] ?? "").trim();
    if (words(passage) < TESTIMONIAL_MIN_WORDS) continue;
    const before = normal.slice(Math.max(0, match.index - 80), match.index);
    const after = normal.slice(match.index + match[0].length, match.index + match[0].length + 80);
    if (!BEFORE.test(before) && !AFTER.test(after)) continue;
    if (!known.has(plain(passage))) found.push(passage);
  }
  return found;
}
