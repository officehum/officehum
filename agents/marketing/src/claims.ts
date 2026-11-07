/**
 * What counts as a result claim, in code.
 *
 * Marketing states results and facts only from the company's approved list; anything else needs a
 * person. A model cannot be trusted to notice its own claims, so the desk runs this detector on every
 * draft and refuses one that holds a claim not on the list. It is deliberately simple and
 * deterministic — a handful of patterns, applied one sentence at a time — so a refusal is explainable
 * and a test can pin both directions:
 *
 * - **Percentages and numeric results**, in digits or words: "cuts sick days 30%", "thirty
 *   percent", "2x cleaner", "3 times faster", "twice as clean", "half of", "in half", and a result verb followed closely by a number ("cuts complaints by 50",
 *   "saves you $400").
 * - **Proof**: "tests prove", "studies show", "proven", "clinically", "scientifically", "lab-tested".
 * - **Broad environmental terms**: "eco-friendly", "non-toxic", "green", "sustainable" and the like,
 *   which are hard, if not impossible, to back up unqualified.
 *
 * **Not result claims**: an offer on a price — "20% off your first clean", "twenty percent off a
 * deep clean", "10% discount on your next visit", or "N% off" at the end of a sentence — and a price
 * ("$99", "from $185 a visit"). An offer is read as one only when what follows "off" or "discount" is
 * a price word or one of the company's service names: "30% off your sick days" is a result. A year
 * ("for 2026") is not a numeric result either, but "$2000" is money. What the detector does not try to read —
 * "saves you money" with no figure, a superlative, a promise — is left to the instructions and to the
 * person who approves every publication.
 *
 * A sentence that is exactly one of the approved claims, ignoring case, spacing and the closing
 * punctuation, is not refused; nor is one a person approved for this draft.
 */

/** One claim the desk refuses: the sentence it sits in, and the phrase that makes it a claim. */
export interface ResultClaim {
  /** The whole sentence, exactly as written, so the person approving it reads it in context. */
  readonly claim: string;
  /** The words that make it a result claim, exactly as written. */
  readonly phrase: string;
}

const UNITS = "one|two|three|four|five|six|seven|eight|nine";
const TEENS = "ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen";
const TENS = "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";
/** A number in digits or in words, up to a hundred: "30", "99.9", "thirty", "ninety-nine". */
const NUMBER = String.raw`(?:\d+(?:[.,]\d+)?|(?:a\s+|one\s+)?hundred|(?:${TENS})(?:[- ](?:${UNITS}))?|${TEENS}|${UNITS})`;
const PERCENT = String.raw`${NUMBER}\s*(?:%|percent\b|per[\s-]?cent\b|pc\b)`;
const COMPARATIVE = String.raw`(?:cleaner|faster|better|healthier|safer|fresher|longer|cheaper|more|less|fewer)`;
const RESULT_VERB = String.raw`(?:cuts?|reduces?|reduced|lowers|lowered|boosts?|boosted|increases?|increased|improves?|improved|halves?|halved|slash(?:es|ed)?|saves|saved|doubles?|doubled|triples?|tripled|eliminates|kills|removes|drops|dropped|fell|falls)`;

/**
 * Words that make "N% off" an offer on a price: what the company sells is a clean, a visit, a
 * service. "30% off your sick days" is not an offer, it is a result, and is not masked.
 */
const PRICE_WORDS = [
  "clean",
  "cleans",
  "cleaning",
  "visit",
  "visits",
  "service",
  "services",
  "quote",
  "price",
  "prices",
  "booking",
  "order",
  "contract",
  "invoice",
  "bill",
  "site",
  "sites",
  "hour",
  "hours",
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * An offer: a percentage taken off a price. It is masked before the rules run only when "off" or
 * "discount" ends the sentence, or is followed, after an optional determiner and up to two words, by a
 * price word or one of the company's own service names.
 */
function offerPattern(terms: readonly string[]): RegExp {
  const targets = [
    ...PRICE_WORDS,
    ...terms
      .map((term) => escapeRegExp(term.trim()).replace(/\s+/g, "\\s+"))
      .filter((term) => term !== ""),
  ].join("|");
  return new RegExp(
    String.raw`\b${PERCENT}\s+(?:off|discount)(?=\s*(?:[.!?]|$)|\s+(?:(?:on|for|of|from)\s+)?(?:(?:your|our|the|a|an|any|every|each)\s+)?(?:[\w-]+\s+){0,2}?(?:${targets})\b)`,
    "gi",
  );
}

/** A four-digit year is a date, not a result; a dollar amount that looks like one is not a year. */
const YEAR = /^(?:19|20)\d{2}$/;

/** The rules, in the order a sentence is tried: the first one that matches names the phrase. */
const RULES: readonly RegExp[] = [
  new RegExp(String.raw`\b${PERCENT}`, "gi"),
  new RegExp(String.raw`\b\d+(?:\.\d+)?\s?[x×]\s+${COMPARATIVE}\b`, "gi"),
  new RegExp(String.raw`\b(?:\d+|two|three|four|five|ten)\s+times\s+${COMPARATIVE}\b`, "gi"),
  /\btwice\s+as\s+\w+/gi,
  /\bhalf\s+(?:of|as)\b|\bin\s+half\b/gi,
  // A result verb, up to six words, then a number that is not a year.
  new RegExp(
    String.raw`\b${RESULT_VERB}\b(?:\s+[^\s\d$][^\s]*){0,6}?\s+(?<dollar>\$?)(?<number>\d+(?:[.,]\d+)*)`,
    "gi",
  ),
  /\b(?:tests?|studies|study|research|trials?)\s+(?:prove[sdn]?|show[sn]?|showed|confirm(?:s|ed)?)\b/gi,
  /\bproven\b/gi,
  /\b(?:clinically|scientifically)\b/gi,
  /\blab[- ]tested\b/gi,
  /\b(?:eco[- ]?friendly|non[- ]?toxic|green|environmentally[- ](?:friendly|safe|preferable)|earth[- ]friendly|planet[- ]friendly|chemical[- ]free|sustainable|biodegradable|all[- ]natural|carbon[- ]neutral)\b/gi,
];

/** Case, spacing and closing punctuation do not make a claim a different claim. */
export function normalizeClaim(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
}

/** Sentences, split at line breaks and after `.`, `!` or `?` followed by a space. */
function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

/** The first phrase in one sentence that makes it a result claim, or `undefined`. */
function claimPhrase(sentence: string, offer: RegExp): string | undefined {
  // Fullwidth digits and signs read as the ASCII ones they are. Masking keeps offsets, so a phrase is
  // cut from the normalised sentence as the rules saw it.
  const normal = sentence.normalize("NFKC");
  const masked = normal.replace(offer, (found) => " ".repeat(found.length));
  for (const rule of RULES) {
    for (const match of masked.matchAll(rule)) {
      const { dollar, number } = match.groups ?? {};
      if (number !== undefined && dollar === "" && YEAR.test(number)) continue;
      return normal.slice(match.index, match.index + match[0].length);
    }
  }
  return undefined;
}

/**
 * Every result claim in `text` that is not approved, one per sentence, in order. `approved` holds the
 * company's approved claims and any claim a person approved for this one draft. `offerTerms` are the
 * company's own service names, which an offer may name after "off" or "discount".
 */
export function findResultClaims(
  text: string,
  approved: readonly string[],
  offerTerms: readonly string[] = [],
): ResultClaim[] {
  const allowed = new Set(approved.map(normalizeClaim));
  const offer = offerPattern(offerTerms);
  const found: ResultClaim[] = [];
  for (const sentence of sentences(text)) {
    if (allowed.has(normalizeClaim(sentence))) continue;
    const phrase = claimPhrase(sentence, offer);
    if (phrase !== undefined) found.push({ claim: sentence, phrase });
  }
  return found;
}
