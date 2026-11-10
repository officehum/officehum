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
 * - after the quote, a dash and a name ("— Name", "- a client", "— a Pearl District client"), a name
 *   on the next line ("Name, Company"), on the same line with no dash, or in brackets ("(Name,
 *   Company)"), or a speech verb with its speaker ("says Name", "Name said", "she said", "the
 *   practice manager told us");
 * - before the quote, in the same sentence, a speech verb or "according to" (`Name wrote: "…"`,
 *   `Here's what Name had to say:`), or a lead-in with a colon: a name (`Name, Company:`, `Client
 *   Name:`, `Name from Company:`) or a speaker by role ("From a client:", "A practice manager:").
 *
 * A name is a capitalised word or words, possibly in markdown emphasis ("**Name**"). Not a speaker:
 * - the company itself (its trading or legal name, or their first word), its own people, and a
 *   service or price book line named in full, since then the company is talking;
 * - a greeting ("Hi Name,", "Dear Office Managers,");
 * - a line made only of call-to-action, heading and audience words ("Learn More", "What We Do",
 *   "Property Managers,"); see `NOT_A_SPEAKER_WORDS`;
 * - a bullet followed by another list item;
 * - a line that is not a short name line: a place ("Seattle, WA") or a sentence ("Winter Specials,
 *   now on."). A name line is two to four capitalised words, then at most a ", tail" of six words,
 *   or of ten when it ends in a capitalised word ("…at Harbor Dental in Seattle").
 *
 * A first name alone on the next line is not read as a name: it cannot be told from a place or a
 * one-word heading. A dash followed by ordinary words ("— and we mean it", "— Ask us how"), and an
 * unattributed or short quoted phrase ("always on time"), is ordinary writing and is left alone.
 */

import type { CompanyFacts, Testimonial } from "./company.js";

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
const SPEECH = String.raw`(?:said|says|writes|wrote|adds|added|told\s+(?:us|me)|tells\s+us|(?:had|has)\s+to\s+say)`;
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
  // An unnamed speaker by role, whatever words describe them: "— a Pearl District client".
  {
    pattern: new RegExp(
      String.raw`${LEAD}\s*${DASH}\s*(?:[Aa]n?|[Tt]he|[Oo]ne\s+of\s+our)\s+(?:[\w'’-]+\s+){0,3}${ROLE}${NAME_END}`,
    ),
  },
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
  // A name and where they are from: "Morgan from Harbor Dental:".
  {
    pattern: new RegExp(
      String.raw`(?:^|[.!?]\s+|\n\s*)(?<who>${NAME})\s+(?:from|at|of)\s+(?<org>${WORD}(?:\s+${WORD}){0,3}):\s*$`,
    ),
  },
  // A speaker by role: "From a client:", "One of our clients:", "A practice manager:".
  {
    pattern: new RegExp(
      String.raw`(?:^|[.!?]\s+|\n\s*)(?:(?:[Ff]rom|[Ii]n\s+the\s+words\s+of)\s+${SOMEONE}|(?:[Aa]n?|[Tt]he|[Oo]ne\s+of\s+our)\s+(?:[a-z][\w-]*\s+){0,2}${ROLE}):\s*$`,
    ),
  },
];

/** Names that are the company talking, never a customer. */
export interface OwnNames {
  /** The trading and legal names. */
  readonly company?: readonly string[];
  /** The company's own people. */
  readonly people?: readonly string[];
  /** Services and price book lines. */
  readonly offerings?: readonly string[];
}

/** The own names the desk passes: the company's names, its people, its services and price lines. */
export function ownNames(company: CompanyFacts): OwnNames {
  return {
    company: [company.profile.tradingName, company.profile.legalName],
    people: company.people.map((person) => person.name),
    offerings: [
      ...company.services.map((service) => service.name),
      ...company.priceBook.map((line) => line.name),
    ],
  };
}

/**
 * Words of a call to action, a heading or an audience: a line made only of these, and of the company's
 * own name, is not a speaker ("Learn More", "Free Walkthrough", "What We Do", "Property Managers,",
 * "Team" and the company's name, "Spring Special"). Audiences are plural ("Office Managers"), so a client's title,
 * which is singular ("Office Manager, Harbor Dental"), still names a speaker. Keep this list short:
 * it holds the words such lines are made of, not whole phrases.
 */
const NOT_A_SPEAKER_WORDS = new Set(
  (
    "learn more free walkthrough what why how who we do our your us about meet join follow try " +
    "start get book call contact today now here see read team crew services special specials " +
    "spring summer autumn fall winter offer offers news update updates testimonials " +
    "property office building managers owners tenants clients customers"
  ).split(" "),
);

/** Role words that may open a lead-in before a name: "Client Morgan Ellis:". */
const ROLE_FIRST = new Set(["client", "customer", "tenant", "owner"]);

interface Own {
  readonly company: readonly string[];
  /** The first word of each company name: a dash and that word is the company. */
  readonly companyFirst: ReadonlySet<string>;
  readonly people: readonly string[];
  readonly offerings: readonly string[];
}

const lowered = (names: readonly string[] | undefined): string[] =>
  (names ?? []).map((name) => name.trim().toLowerCase()).filter((name) => name !== "");

function ownWords(own: OwnNames): Own {
  const company = lowered(own.company);
  return {
    company,
    companyFirst: new Set(company.map((name) => name.split(/\s+/)[0] ?? "")),
    people: lowered(own.people),
    offerings: lowered(own.offerings),
  };
}

const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((word) => word !== "");

/** Whether `who` is the company itself, one of its people, or one of its services, in full. */
function isOwn(who: string, own: Own): boolean {
  const lower = wordsOf(who).join(" ");
  if (lower === "") return false;
  // Only the company's own names exempt a speaker by their first word ("— Company"); a service
  // shares first words with clients' titles ("Office cleaning", "Office Manager").
  if (own.companyFirst.has(lower.split(" ")[0] ?? "")) return true;
  const prefixes = (names: readonly string[]) =>
    names.some((name) => name.startsWith(lower) || lower.startsWith(name));
  if (prefixes(own.company) || prefixes(own.people)) return true;
  return own.offerings.includes(lower);
}

/** Whether a rule's match names someone who could have said the quote. */
function isSpeaker(rule: Rule, match: RegExpExecArray, own: Own): boolean {
  const who = match.groups?.who?.trim();
  if (who === undefined) return true;
  if (isOwn(who, own)) return false;
  const org = match.groups?.org;
  if (org !== undefined && isOwn(org, own)) return false;
  const words = wordsOf(who);
  if (words.every((word) => NOT_A_SPEAKER_WORDS.has(word) || own.companyFirst.has(word))) {
    return false;
  }
  const tail = match.groups?.tail;
  if (rule.nameLine === true && tail !== undefined) {
    if (own.offerings.includes(wordsOf(`${who} ${tail}`).join(" "))) return false;
    // "Morgan Ellis, office manager at Harbor Dental in Seattle" names where they are; "Winter
    // Specials, now on." is a sentence: its last word is lowercase before the full stop.
    const last = tail.trim().split(/\s+/).at(-1) ?? "";
    const named = /^[*_]*[A-Z]/.test(last);
    if (/[.!?]$/.test(last) && !named) return false;
    if (tail.split(/\s+/).filter(Boolean).length > (named ? 10 : 6)) return false;
  }
  if (rule.leadIn === true && tail === undefined && words.length > 2) {
    if (!ROLE_FIRST.has(words[0] ?? "")) return false;
  }
  return true;
}

/** A dash that opens a line, followed by another list item, is a bullet, not an attribution. */
function isListItem(text: string, match: RegExpExecArray): boolean {
  if (!/\n[^\S\n]*[-–—~*•]/.test(match[0])) return false;
  const rest = text.slice(match.index + match[0].length);
  return /^(?:[^\n]*\n)?[^\S\n]*(?:[-–—*•]|\d+[.)])\s/.test(rest);
}

function attributed(rules: readonly Rule[], text: string, own: Own) {
  return rules.some((rule) => {
    const match = rule.pattern.exec(text);
    return match !== null && !isListItem(text, match) && isSpeaker(rule, match, own);
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
  own: OwnNames = {},
): string[] {
  const names = ownWords(own);
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
    if (!attributed(BEFORE, before, names) && !attributed(AFTER, after, names)) continue;
    if (!known.has(plain(passage))) found.push(passage);
  }
  return found;
}
