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
 * - after the quote, a dash and a name or title ("— Name", "— Office Manager at Harbor Dental",
 *   "— Tenants, Lloyd Tower", "- a client", "— our client at Harbor Dental"), a review site ("–
 *   Google review"), "That's from Name", a name on the next line ("Name, Company", "Title at
 *   Company"), on the same line with no dash, or in brackets ("(Name, Company)"), or a speech verb
 *   with its speaker ("says Name", "notes Name", "explains Name", "recalled Name", "Name said",
 *   "she said"); also a lowercase title after a dash, then the company ("— office manager at Harbor
 *   Dental");
 * - before the quote, in the same sentence, a speech verb or "according to" (`Name wrote: "…"`,
 *   `Here's what Name had to say:`, `One customer put it best:`, but not "we put it"), a named
 *   speaker and "explained:", "commented:" or "recalled:", "Hear it
 *   from Name", or a lead-in with a colon: a name (`Name, Company:`, `Client Name:`, `Name from
 *   Company:`, `Name (Company):`), a client feature (`Client spotlight, Company:`) or a speaker by
 *   role ("From a client:", "A practice manager:").
 *
 * A name is a capitalised word or words, possibly in markdown emphasis ("**Name**"). Not a speaker:
 * - the company itself (its trading or legal name, or their first word), its own people by their
 *   full name (never a first name or an initial a customer may share), and a service or price book
 *   line named in full, since then the company is talking;
 * - a greeting ("Hi Name,", "Dear Office Managers,");
 * - a bullet followed by another list item.
 *
 * A dash is an explicit signature: after one, only the company is not a speaker ("— Team
 * Acme"). A line with no dash (the next line, the same line, a lead-in) is also not a speaker
 * when it reads as the company's own writing rather than a name. Names are nouns for people, so:
 * - a line made only of heading, call-to-action and audience words, the company's first name word
 *   and its services ("Learn More", "What We Do", "Property Managers,", "Day Porter Service"); see
 *   `NOT_A_SPEAKER_WORDS`;
 * - a bare capitalised line after the quote (no dash, no ", tail", no "at Company") of more than two
 *   words, unless it is a first name, initial and last name ("Jordan M. Pike"): a heading such as
 *   "Commercial Cleaning Experts". A bare three-word name ("Jordan Allen Pike") is therefore missed,
 *   an accepted cost; two-word headings ("Spring Checklist") are still read as names (fail-safe);
 * - a line after the quote that opens with a question word or an imperative ("How It Works",
 *   "Schedule Yours Today"), or ends in a place word ("Denver Metro Area"); see `HEADING_FIRST`
 *   and `PLACE_LAST`;
 * - a lead-in label whose head (last) word names a piece of writing ("Crew Motto:", "Subject:");
 *   see `LABEL_HEAD`;
 * - a line that is not a short name line: a place ("Seattle, WA") or a sentence ("Winter Specials,
 *   now on."). A name line is two to four capitalised words, then at most a ", tail" of six words,
 *   or of ten when it ends in a capitalised word ("…at Harbor Dental in Seattle").
 * These are word classes (question words, imperatives, place nouns, kinds of writing), not lists of
 * phrases: a new heading is covered by its first or last word.
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
const SPEECH = String.raw`(?:said|says|writes|wrote|adds|added|told\s+(?:us|me)|tells\s+us|(?:had|has)\s+to\s+say|put\s+it)`;
/**
 * Verbs that are speech only after a quote: before one, "notes", "shares" and "reports" are nouns,
 * and "our report explains" is a document talking.
 */
const SPEECH_AFTER = `(?:${SPEECH}|notes|noted|shares|shared|explains|explained|comments|commented|recalls|recalled|reports|reported|admits|admitted)`;
/** Speech verbs that lead in with a colon after a named speaker: "Name explained:". */
const SPEECH_COLON = "(?:explained|commented|recalled)";
/** The company speaking for itself: "We put it simply:" is not a customer. */
const NOT_US = String.raw`(?<!\b(?:[Ww]e|I|[Yy]ou)\s+)`;
/** Where a client's title or name says where they work: "Office Manager at Harbor Dental". */
const ORG = String.raw`(?<org>${WORD}(?:[^\S\n]+${WORD}){0,3})`;
/** A lowercase speaker before a speech verb: a pronoun, or a determiner and up to three words. */
const SPEAKER = String.raw`(?:[Ss]he|[Hh]e|[Tt]hey|(?:[Aa]n?|[Tt]he|[Oo]ur|[Oo]ne\s+of\s+our|[Aa]nother|[Tt]heir)(?:\s+[\w'’-]+){1,3})`;
const DASH = "(?:[—–~]|-{1,2})";
/** Markdown emphasis a model may put around a name: "**Morgan Ellis**". */
const MARK = String.raw`(?:\*{1,2}|_{1,2})?`;
/** A speaker by role, leading in with a colon: "A practice manager:", "One of our clients:". */
const ROLE =
  "(?:client|customer|manager|director|owner|tenant|administrator|coordinator|partner)s?";
/** A person by role, for verbs a document can also take: "the practice manager", not "the report". */
const BY_ROLE = String.raw`(?:[Aa]n?|[Tt]he|[Oo]ur|[Tt]heir|[Aa]nother|[Oo]ne\s+of\s+our)\s+(?:[\w'’-]+\s+){0,2}${ROLE}`;
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
  /** For a dash attribution: an explicit signature, so only the company itself is not a speaker. */
  readonly dash?: boolean;
}

/** After the quote. */
const AFTER: readonly Rule[] = [
  // A dash, then a name or an unnamed speaker.
  {
    pattern: new RegExp(String.raw`${LEAD}\s*${DASH}\s*${MARK}(?<who>${NAME})${MARK}${NAME_END}`),
    dash: true,
  },
  { pattern: new RegExp(String.raw`${LEAD}\s*${DASH}\s*${SOMEONE}${NAME_END}`) },
  // An unnamed speaker by role, whatever words describe them and wherever they are: "— a Pearl
  // District client", "— our client at Harbor Dental".
  {
    pattern: new RegExp(
      String.raw`${LEAD}\s*${DASH}\s*(?:[Aa]n?|[Tt]he|[Oo]ur|[Oo]ne\s+of\s+our)\s+(?:[\w'’-]+\s+){0,3}${ROLE}(?:\s+(?:at|from|of|in)\s+[^\n,.]{1,40})?${NAME_END}`,
    ),
  },
  // A lowercase title, with or without "a"/"our", then the client's company: "— facilities manager,
  // Lloyd Tower", "— office manager at Harbor Dental". A sentence after a dash ("— and we mean it,
  // every night") does not end in a capitalised company.
  {
    pattern: new RegExp(
      String.raw`${LEAD}\s*${DASH}\s*(?:(?:[Aa]n?|[Oo]ur)\s+)?(?!(?:and|but|or|so|that|this|which|we|you|it|as|plus|then)\b)[a-z][\w'’-]*(?:\s+[a-z][\w'’-]*){0,2}(?:,|\s+(?:at|of|from))\s+${ORG}`,
    ),
  },
  // A whole name or title and where they are from: "— Office Manager at Harbor Dental".
  {
    pattern: new RegExp(
      String.raw`${LEAD}\s*${DASH}\s*${MARK}(?<who>${NAME})${MARK}\s+(?:of|from|at)\s+${ORG}`,
    ),
    dash: true,
  },
  // Two or more capitalised words need nothing after them: "— Morgan Ellis Our floors are next",
  // "— Property Managers across Denver".
  {
    pattern: new RegExp(
      String.raw`${LEAD}\s*${DASH}\s*${MARK}(?<who>${NOT_A_NAME}${WORD}(?:\s+${WORD}){1,3})`,
    ),
    dash: true,
  },
  // A review site, after a dash or in brackets: "– Google review", "(5-star Yelp review)".
  {
    pattern: new RegExp(
      String.raw`${LEAD}\s*(?:${DASH}|[([])\s*(?:[Aa]\s+|[Vv]ia\s+)?(?:[A-Z0-9][\w'’.-]*\s+){1,2}[Rr]eview(?:er)?\b`,
    ),
  },
  // "That's from Morgan at Harbor Dental."
  {
    pattern: new RegExp(
      String.raw`${LEAD}\s*(?:[Tt]hat(?:'|’|\s+i)s|[Tt]his\s+is)\s+from\s+(?:${MARK}(?<who>${NAME})|${SOMEONE})`,
    ),
  },
  // A name alone on the next line: two to four capitalised words, then at most a short ", Company"
  // or "at Company".
  {
    pattern: new RegExp(
      String.raw`${LEAD}[^\S\n]*\n\s*${MARK}(?<who>${FULL_NAME})${MARK}(?:,[^\S\n]*(?<tail>[^\n]*?)|[^\S\n]+(?:of|from|at)[^\S\n]+${ORG})?[^\S\n]*(?:\n|$)`,
    ),
    nameLine: true,
  },
  // The same, on the quote's own line with no dash: "\"…\" Morgan Ellis, Harbor Dental".
  {
    pattern: new RegExp(
      String.raw`${LEAD}[^\S\n]+${MARK}(?<who>${FULL_NAME})${MARK}(?:,[^\S\n]*(?<tail>[^\n]*?)|[^\S\n]+(?:of|from|at)[^\S\n]+${ORG})?[^\S\n]*(?:\n|$)`,
    ),
    nameLine: true,
  },
  // A name in brackets.
  { pattern: new RegExp(String.raw`^\s*[([]\s*(?<who>${NAME})\s*[,)\]]`) },
  { pattern: new RegExp(String.raw`^\s*[([]\s*${SOMEONE}\s*[,)\]]`) },
  // A speech verb, then or after its speaker.
  { pattern: new RegExp(String.raw`${LEAD}\s*${SPEECH_AFTER}\b`) },
  { pattern: new RegExp(String.raw`${LEAD}\s*(?<who>${NAME})\s+${SPEECH_AFTER}\b`) },
  { pattern: new RegExp(String.raw`${LEAD}\s*${SPEAKER}\s+${SPEECH}\b`) },
  // The wider verbs need a person: "the practice manager recalled", not "our report explains".
  {
    pattern: new RegExp(
      String.raw`${LEAD}\s*(?:[Ss]he|[Hh]e|[Tt]hey|${BY_ROLE})\s+${SPEECH_AFTER}\b`,
    ),
  },
];

/** A sentence break before the quote ends the search; "Dr. Lee" is not a break. */
const NO_BREAK = String.raw`(?:(?<!\b(?:Dr|Mr|Mrs|Ms|St))[.!?](?=\s)|["“„«])`;
/** Before the quote, in the same sentence. */
const BEFORE: readonly Rule[] = [
  // A speech verb or "according to", then up to 60 characters within the sentence.
  {
    pattern: new RegExp(
      String.raw`(?:${NOT_US}\b${SPEECH}\b|\b[Aa]ccording\s+to\b)(?:(?!${NO_BREAK})[^\n]){0,60}$`,
    ),
  },
  // A name leading in with a colon: "Name:" or "Name, Company:" at the start of a sentence or line.
  {
    pattern: new RegExp(
      String.raw`(?:^|[.!?]\s+|\n\s*)(?<who>${NAME})(?<tail>,(?:(?!\b(?:is|are|was|were)\b)[^:"“\n.]){1,60})?:\s*$`,
    ),
    leadIn: true,
  },
  // A named speaker and a speech verb, leading in with a colon: "Morgan Ellis explained:".
  {
    pattern: new RegExp(
      String.raw`(?:^|[.!?]\s+|\n\s*)(?:(?<who>${NAME})|${BY_ROLE})\s+${SPEECH_COLON}:\s*$`,
    ),
  },
  // A name and where they are from: "Morgan from Harbor Dental:", "Morgan Ellis (Harbor Dental):".
  {
    pattern: new RegExp(
      String.raw`(?:^|[.!?]\s+|\n\s*)(?<who>${NAME})\s+(?:from|at|of)\s+(?<org>${WORD}(?:\s+${WORD}){0,3}):\s*$`,
    ),
  },
  {
    pattern: new RegExp(
      String.raw`(?:^|[.!?]\s+|\n\s*)(?<who>${NAME})\s*\((?<org>[^()\n]{1,60})\):\s*$`,
    ),
  },
  // "Hear it from Morgan at Harbor Dental:", "Hear from a client:".
  {
    pattern: new RegExp(
      String.raw`\b[Hh]ear\s+(?:it\s+)?from\s+(?:(?<who>${NAME})|${SOMEONE})(?:(?!${NO_BREAK})[^\n]){0,60}$`,
    ),
  },
  // A client feature naming the client: "Client spotlight, Harbor Dental:".
  {
    pattern: new RegExp(
      String.raw`(?:^|[.!?]\s+|\n\s*)(?:[Cc]lient|[Cc]ustomer|[Tt]enant)s?(?:\s+[a-z][\w-]*){1,2},\s*${ORG}:\s*$`,
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
 * Words of a call to action, a heading or an audience: a line with no dash made only of these, the
 * company's first name word and its services is not a speaker ("Learn More", "Free Walkthrough",
 * "What We Do", "Property Managers,", "Spring Special"). After a dash the line must also name the
 * company ("— Team Acme"), so "— Tenants, Lloyd Tower" still names a speaker. Keep this list
 * short: it holds the words such lines are made of, not whole phrases.
 */
const NOT_A_SPEAKER_WORDS = new Set(
  (
    "learn more free walkthrough what why how who we do our your us about meet join follow try " +
    "start get book call contact today now here see read team crew service services special specials " +
    "spring summer autumn fall winter offer offers news update updates testimonials " +
    "property office building managers owners tenants clients customers"
  ).split(" "),
);

/**
 * Lines after a quote that are headings, not names. A person's name is a noun, so a title-case line
 * opening with a question word or an imperative ("How It Works", "Schedule Yours Today") is a
 * heading. Only for a line with no dash: "— Ask Morgan" is not a signature anyway (see NOT_A_NAME).
 */
const HEADING_FIRST = new Set(
  (
    "how what why who when where which schedule book call contact request get try start learn see " +
    "read find visit claim save discover explore ask email message sign subscribe register order " +
    "reserve grab"
  ).split(" "),
);

/** A first name, a middle initial and a last name: "Jordan M. Pike". */
const INITIAL_NAME = /^[*_]*[A-Z][\w'’-]+\s+[A-Z]\.\s+[A-Z][\w'’-]+[*_]*$/;

/** The last word of a place line: "Denver Metro Area", "Clark County", "Pearl District". */
const PLACE_LAST = new Set(
  "area metro county region district valley city downtown neighborhood neighbourhood".split(" "),
);

/**
 * The head of a label leading in with a colon: in English the last word of a compound names the
 * thing, and these name a piece of writing, not a person ("Crew Motto:", "Subject:").
 */
const LABEL_HEAD = new Set(
  (
    "motto subject slogan tagline promise pledge rule rules headline title tip note reminder update " +
    "mission question answer fact creed mantra"
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
  if (own.company.some((name) => name.startsWith(lower) || lower.startsWith(name))) return true;
  // A person only by their full name: a customer may share a first name or an initial with staff.
  return own.people.includes(lower) || own.offerings.includes(lower);
}

/** `words` with every service or price line named in full taken out: "Day Porter Service". */
function withoutOfferings(words: readonly string[], own: Own): string[] {
  let line = ` ${words.join(" ")} `;
  for (const offering of own.offerings) {
    const name = wordsOf(offering).join(" ");
    if (name !== "") line = line.split(` ${name} `).join(" ");
  }
  return line.split(" ").filter((word) => word !== "");
}

/** Whether a rule's match names someone who could have said the quote. */
function isSpeaker(rule: Rule, match: RegExpExecArray, own: Own): boolean {
  const who = match.groups?.who?.trim();
  if (who === undefined) return true;
  if (isOwn(who, own)) return false;
  const org = match.groups?.org;
  if (org !== undefined && isOwn(org, own)) return false;
  const tail = match.groups?.tail;
  const words = wordsOf(who);
  // Words the company's own lines are made of: headings, its first name word and its services.
  const left = withoutOfferings(words, own);
  const plain = left.every((word) => NOT_A_SPEAKER_WORDS.has(word) || own.companyFirst.has(word));
  if (rule.dash === true) {
    // A dash is an explicit signature, so heading words alone do not clear it: "— Office Manager at
    // Harbor Dental", "— Tenants, Lloyd Tower". Only a line that also names the company does.
    if (plain && words.some((word) => own.companyFirst.has(word))) return false;
  } else if (rule.nameLine === true || rule.leadIn === true) {
    if (plain) return false;
    if (rule.nameLine === true && tail === undefined && org === undefined) {
      if (HEADING_FIRST.has(words[0] ?? "") || PLACE_LAST.has(words.at(-1) ?? "")) return false;
      // A bare line with nothing after it is a name only as two words ("Morgan Ellis") or a first
      // name, an initial and a last name ("Jordan M. Pike"). Longer title-case lines are headings
      // ("Commercial Cleaning Experts"). Accepted cost: a bare three-word name with no initial
      // ("Jordan Allen Pike") is not caught.
      if (words.length !== 2 && !INITIAL_NAME.test(who)) return false;
    }
    if (rule.leadIn === true && tail === undefined && LABEL_HEAD.has(words.at(-1) ?? "")) {
      return false;
    }
  }
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
