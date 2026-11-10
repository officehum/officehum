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
 * - before the quote, in the same sentence, a speech verb or "according to" (`Name wrote: "…"`), a
 *   name leading in with a colon (`Name, Company: "…"`), or a speaker by role ("From a client:",
 *   "A practice manager:").
 *
 * A name on its own line or after the quote on the same line may be in markdown emphasis
 * ("**Name**").
 *
 * A name is a capitalised word or words. Not a speaker: the company's own names and its services
 * (a slogan signed with the company's name is the company talking), a greeting ("Hi Name,", "Dear
 * Office Managers,"), and a line that is not a short name line: a place ("Seattle, WA"), a heading
 * or a list of services. A name alone on the next line is two to four capitalised words that end the line, with
 * at most a short ", Company". A dash followed by ordinary words ("— and we mean it", "— Ask us how"),
 * and an unattributed or short quoted phrase ("always on time"), is ordinary writing and is left
 * alone.
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

/** Capitalised words that open a sentence, a greeting or a sign-off, not a person's name. */
const NOT_A_NAME = String.raw`(?!(?:The|Our|Your|We|You|Ask|Book|Call|Email|Contact|Thanks|Thank|Best|Regards|Cheers|Kind|Warm|Sincerely|Here|Note|Remember|See|Read|Find|Get|Visit|Hi|Hello|Hey|Dear|Happy|Good|Welcome)\b)`;
const WORD = String.raw`[A-Z][\w'’.-]*`;
const NAME = String.raw`${NOT_A_NAME}${WORD}(?:\s+${WORD}){0,3}`;
/** A name of two to four capitalised words on one line: "Morgan Ellis". */
const FULL_NAME = String.raw`${NOT_A_NAME}${WORD}(?:[^\S\n]+${WORD}){1,3}`;
/** An unnamed speaker: "a client", "the practice manager". */
const SOMEONE = String.raw`(?:[Aa]n?|[Tt]he|[Oo]ne\s+of\s+our)\s+[a-z][\w-]*(?:\s+[a-z][\w-]*){0,2}`;
/** Where a name or a speaker ends: a comma, a bracket, a full stop, the line or the text. */
const NAME_END = String.raw`\s*(?:[,.)\]]|\n|$)`;
const SPEECH = String.raw`(?:said|says|writes|wrote|adds|added|told\s+(?:us|me)|tells\s+us)`;
/** A lowercase speaker before a speech verb: a pronoun, or a determiner and up to three words. */
const SPEAKER = String.raw`(?:[Ss]he|[Hh]e|[Tt]hey|(?:[Aa]n?|[Tt]he|[Oo]ur|[Oo]ne\s+of\s+our|[Aa]nother|[Tt]heir)(?:\s+[\w'’-]+){1,3})`;
const DASH = "(?:[—–~]|-{1,2})";
/** Markdown emphasis a model may put around a name: "**Morgan Ellis**". */
const MARK = String.raw`(?:\*{1,2}|_{1,2})?`;
/** A speaker by role, leading in with a colon: "A practice manager:", "One of our clients:". */
const ROLE =
  "(?:client|customer|manager|director|owner|tenant|administrator|coordinator|partner)s?";
/** What may sit between the closing mark and an attribution on the same line. */
const LEAD = String.raw`^[^\S\n]*[,.!?]?`;

/**
 * One way a quote is attributed. `who`, when the rule names someone, is checked by {@link isSpeaker}:
 * the company's own names, greetings, places and headings are not speakers.
 */
interface Rule {
  readonly pattern: RegExp;
  /** For a name alone on its line: what follows it after a comma must be short and end the line. */
  readonly nameLine?: boolean;
  /** For a lead-in with no comma part: a heading ("New Year Promise:") is longer than a name. */
  readonly leadIn?: boolean;
}

/** After the quote. */
const AFTER: readonly Rule[] = [
  // A dash, then a name or an unnamed speaker.
  { pattern: new RegExp(String.raw`${LEAD}\s*${DASH}\s*${MARK}(?<who>${NAME})${MARK}${NAME_END}`) },
  { pattern: new RegExp(String.raw`${LEAD}\s*${DASH}\s*${SOMEONE}${NAME_END}`) },
  // A name of two capitalised words, or one followed by where they are from, needs nothing after it:
  // "— Morgan Ellis of Harbor Dental".
  {
    pattern: new RegExp(
      String.raw`${LEAD}\s*${DASH}\s*(?<who>${NOT_A_NAME}${WORD})\s+(?:[A-Z]|(?:of|from|at)\s)`,
    ),
  },
  // A name alone on the next line: two to four capitalised words, then at most a short ", Company".
  {
    pattern: new RegExp(
      String.raw`${LEAD}[^\S\n]*\n\s*${MARK}(?<who>${FULL_NAME})${MARK}(?:,[^\S\n]*(?<tail>[^\n]*?))?[^\S\n]*(?:\n|$)`,
    ),
    nameLine: true,
  },
  // The same, on the quote's own line with no dash: "\"…\" Morgan Ellis, Harbor Dental".
  {
    pattern: new RegExp(
      String.raw`${LEAD}[^\S\n]+${MARK}(?<who>${FULL_NAME})${MARK}(?:,[^\S\n]*(?<tail>[^\n]*?))?[^\S\n]*(?:\n|$)`,
    ),
    nameLine: true,
  },
  // A name in brackets.
  { pattern: new RegExp(String.raw`^\s*[([]\s*(?<who>${NAME})\s*[,)\]]`) },
  { pattern: new RegExp(String.raw`^\s*[([]\s*${SOMEONE}\s*[,)\]]`) },
  // A speech verb, then or after its speaker.
  { pattern: new RegExp(String.raw`${LEAD}\s*${SPEECH}\b`) },
  { pattern: new RegExp(String.raw`${LEAD}\s*(?<who>${NAME})\s+${SPEECH}\b`) },
  { pattern: new RegExp(String.raw`${LEAD}\s*${SPEAKER}\s+${SPEECH}\b`) },
];

/** A sentence break before the quote ends the search; "Dr. Lee" is not a break. */
const NO_BREAK = String.raw`(?:(?<!\b(?:Dr|Mr|Mrs|Ms|St))[.!?](?=\s)|["“„«])`;
/** Before the quote, in the same sentence. */
const BEFORE: readonly Rule[] = [
  // A speech verb or "according to", then up to 60 characters within the sentence.
  {
    pattern: new RegExp(
      String.raw`(?:\b${SPEECH}\b|\b[Aa]ccording\s+to\b)(?:(?!${NO_BREAK})[^\n]){0,60}$`,
    ),
  },
  // A name leading in with a colon: "Name:" or "Name, Company:" at the start of a sentence or line.
  {
    pattern: new RegExp(
      String.raw`(?:^|[.!?]\s+|\n\s*)(?<who>${NAME})(?<tail>,(?:(?!\b(?:is|are|was|were)\b)[^:"“\n.]){1,60})?:\s*$`,
    ),
    leadIn: true,
  },
  // A speaker by role: "From a client:", "One of our clients:", "A practice manager:".
  {
    pattern: new RegExp(
      String.raw`(?:^|[.!?]\s+|\n\s*)(?:(?:[Ff]rom|[Ii]n\s+the\s+words\s+of)\s+${SOMEONE}|(?:[Aa]n?|[Tt]he|[Oo]ne\s+of\s+our)\s+(?:[a-z][\w-]*\s+){0,2}${ROLE}):\s*$`,
    ),
  },
];

/** The first word, lowercased, of each of the company's own names. */
function ownWords(own: readonly string[]): {
  readonly names: readonly string[];
  readonly first: ReadonlySet<string>;
} {
  const names = own.map((name) => name.trim().toLowerCase()).filter((name) => name !== "");
  return { names, first: new Set(names.map((name) => name.split(/\s+/)[0] ?? "")) };
}

/** Whether a rule's match names someone who could have said the quote. */
function isSpeaker(rule: Rule, match: RegExpExecArray, own: ReturnType<typeof ownWords>): boolean {
  const who = match.groups?.who?.trim();
  if (who === undefined) return true;
  const lower = who.toLowerCase().replace(/[.,]+$/, "");
  // The company's own name or one of its services is the company talking, not a customer.
  if (own.first.has(lower.split(/\s+/)[0] ?? "")) return false;
  if (own.names.some((name) => name.startsWith(lower) || lower.startsWith(name))) return false;
  const tail = match.groups?.tail;
  if (rule.nameLine === true && tail !== undefined) {
    // "Morgan Ellis, Harbor Dental" ends its line; "Winter Specials, now on." is a sentence.
    if (/[.!?]$/.test(tail) || tail.split(/\s+/).filter(Boolean).length > 6) return false;
  }
  if (rule.leadIn === true && tail === undefined && who.split(/\s+/).length > 2) return false;
  return true;
}

function attributed(rules: readonly Rule[], text: string, own: ReturnType<typeof ownWords>) {
  return rules.some((rule) => {
    const match = rule.pattern.exec(text);
    return match !== null && isSpeaker(rule, match, own);
  });
}

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
 * not exactly the `quote` of a recorded testimonial, as written, in order. `ownNames` are the
 * company's own names (trading and legal name, services, price book lines): a quote signed with one
 * of them is the company talking, not a customer.
 */
export function findUnrecordedTestimonials(
  text: string,
  recorded: readonly Pick<Testimonial, "quote">[],
  ownNames: readonly string[] = [],
): string[] {
  const own = ownWords(ownNames);
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
    if (!attributed(BEFORE, before, own) && !attributed(AFTER, after, own)) continue;
    if (!known.has(plain(passage))) found.push(passage);
  }
  return found;
}
