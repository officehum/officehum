/**
 * What counts as an invented testimonial, in code.
 *
 * Marketing quotes a customer only word for word from the company's record. A model cannot be
 * trusted to notice that a plausible quote it wrote is made up, so the desk runs this check on every
 * draft: a quoted passage of six words or more that is attributed to someone and is not exactly a
 * quote on record is refused. It is not a claim a person can approve; the draft is not saved.
 *
 * Quoted means double quotes (straight or curly) or single quotes (straight or curly). A straight
 * mark pairs only at a word boundary, so an inch mark ("12\" mats") or an apostrophe ("clients'")
 * does not open a quote.
 *
 * Attributed means one of:
 * - after the quote, a dash and a name ("— Name", "- a client"), a name on the next line ("Name,
 *   Company"), a name in brackets ("(Name, Company)"), or a speech verb with its speaker ("says
 *   Name", "Name said", "she said", "the practice manager told us");
 * - before the quote, in the same sentence, a speech verb or "according to" (`Name wrote: "…"`), or
 *   a name leading in with a colon (`Name, Company: "…"`).
 *
 * A name is a capitalised word or words. A dash followed by ordinary words ("— and we mean it",
 * "— Ask us how"), and an unattributed or short quoted phrase ("always on time"), is ordinary
 * writing and is left alone.
 */

import type { Testimonial } from "./company.js";

/** A quoted passage this long, attributed to someone, has to be on record. */
export const TESTIMONIAL_MIN_WORDS = 6;

/** Each alternative captures the passage in its own group. */
const QUOTED = new RegExp(
  [
    // Double: a straight mark opens and closes only at a word boundary.
    String.raw`(?:(?<!\w)"|[“„«])([^"”“«»]+)(?:"(?!\w)|[”»])`,
    // Single: an apostrophe inside a word ("don't") is part of the passage, not its end.
    String.raw`(?<![\w'‘’])['‘]((?:[^'‘’\n]|['’](?=\w))+)['’](?!\w)`,
  ].join("|"),
  "g",
);

/** Capitalised words that open a sentence or a sign-off, not a person's name. */
const NOT_A_NAME = String.raw`(?!(?:The|Our|Your|We|You|Ask|Book|Call|Email|Contact|Thanks|Thank|Best|Regards|Cheers|Kind|Warm|Sincerely|Here|Note|Remember|See|Read|Find|Get|Visit)\b)`;
const NAME = String.raw`${NOT_A_NAME}[A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,3}`;
/** An unnamed speaker: "a client", "the practice manager". */
const SOMEONE = String.raw`(?:[Aa]n?|[Tt]he|[Oo]ne\s+of\s+our)\s+[a-z][\w-]*(?:\s+[a-z][\w-]*){0,2}`;
/** Where a name or a speaker ends: a comma, a bracket, a full stop, the line or the text. */
const NAME_END = String.raw`\s*(?:[,.)\]]|\n|$)`;
const SPEECH = String.raw`(?:said|says|writes|wrote|adds|added|told\s+(?:us|me)|tells\s+us)`;
/** A lowercase speaker before a speech verb: a pronoun, or a determiner and up to three words. */
const SPEAKER = String.raw`(?:[Ss]he|[Hh]e|[Tt]hey|(?:[Aa]n?|[Tt]he|[Oo]ur|[Oo]ne\s+of\s+our|[Aa]nother|[Tt]heir)(?:\s+[\w'’-]+){1,3})`;

/** After the quote. */
const AFTER = new RegExp(
  `^[^\\S\\n]*[,.!?]?(?:${[
    // A dash, then a name or an unnamed speaker. A name of two capitalised words, or one followed by
    // where they are from, needs nothing after it: "— Morgan Ellis of Harbor Dental".
    String.raw`\s*(?:[—–~]|-{1,2})\s*(?:(?:${NAME}|${SOMEONE})${NAME_END}|${NOT_A_NAME}[A-Z][\w'’.-]*\s+(?:[A-Z]|(?:of|from|at)\s))`,
    // A name alone on the next line.
    String.raw`[^\S\n]*\n\s*${NAME}${NAME_END}`,
    // A name in brackets.
    String.raw`\s*[([]\s*(?:${NAME}|${SOMEONE})\s*[,)\]]`,
    // A speech verb, then or after its speaker.
    String.raw`\s*${SPEECH}\b`,
    String.raw`\s*(?:${NAME}|${SPEAKER})\s+${SPEECH}\b`,
  ].join("|")})`,
);

/** A sentence break before the quote ends the search; "Dr. Lee" is not a break. */
const NO_BREAK = String.raw`(?:(?<!\b(?:Dr|Mr|Mrs|Ms|St))[.!?](?=\s)|["“„«])`;
/** Before the quote, in the same sentence. */
const BEFORE = new RegExp(
  [
    // A speech verb or "according to", then up to 60 characters within the sentence.
    String.raw`(?:\b${SPEECH}\b|\b[Aa]ccording\s+to\b)(?:(?!${NO_BREAK})[^\n]){0,60}$`,
    // A name leading in with a colon: "Name:" or "Name, Company:" at the start of a sentence or line.
    String.raw`(?:^|[.!?]\s+|\n\s*)${NAME}(?:,(?:(?!\b(?:is|are|was|were)\b)[^:"“\n.]){1,60})?:\s*$`,
  ].join("|"),
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
    const passage = (match[1] ?? match[2] ?? "").trim();
    if (words(passage) < TESTIMONIAL_MIN_WORDS) continue;
    const end = match.index + match[0].length;
    // A cut-off start is not the start of a sentence, so the lead-in rule cannot match there.
    const cut = match.index > 80 ? "\u0000" : "";
    const before = cut + normal.slice(Math.max(0, match.index - 80), match.index);
    const after = normal.slice(end, end + 80);
    if (!BEFORE.test(before) && !AFTER.test(after)) continue;
    if (!known.has(plain(passage))) found.push(passage);
  }
  return found;
}
