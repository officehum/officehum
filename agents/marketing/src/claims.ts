/**
 * What counts as a result claim, in code.
 *
 * Marketing states results and facts only from the company's approved list; anything else needs a
 * person. A model cannot be trusted to notice its own claims, so the desk runs this detector on every
 * draft and refuses one that holds a claim not on the list. It is deliberately simple and
 * deterministic — a handful of patterns, applied one sentence at a time — so a refusal is explainable
 * and a test can pin both directions:
 *
 * - **Percentages and numeric results**: "cuts sick days 30%", "2x cleaner", "3 times faster",
 *   "twice as clean", and a result verb followed closely by a number ("cuts complaints by 50",
 *   "saves you $400").
 * - **Proof**: "tests prove", "studies show", "proven", "clinically", "scientifically", "lab-tested".
 * - **Broad environmental terms**: "eco-friendly", "non-toxic", "green", "sustainable" and the like,
 *   which are hard, if not impossible, to back up unqualified.
 *
 * **Not result claims**: an offer written as "20% off" or "15 percent discount", and a price ("$99",
 * "from $185 a visit"). Offers and prices come from the price book; the detector leaves them alone.
 * A year ("for 2026") is not a numeric result either. What the detector does not try to read —
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

const PERCENT = String.raw`\d+(?:[.,]\d+)?\s*(?:%|percent\b|per\s?cent\b)`;
const COMPARATIVE = String.raw`(?:cleaner|faster|better|healthier|safer|fresher|longer|cheaper|more|less|fewer)`;
const RESULT_VERB = String.raw`(?:cuts?|reduces?|reduced|lowers|lowered|boosts?|boosted|increases?|increased|improves?|improved|halves|halved|slashes|slashed|saves|saved|doubles|doubled|triples|tripled|eliminates|kills|removes)`;

/** An offer: a percentage taken off a price. Masked before the numeric rules run. */
const OFFER = new RegExp(String.raw`\b${PERCENT}\s+(?:off|discount)\b`, "gi");

/** A four-digit year is a date, not a result. */
const YEAR = /^(?:19|20)\d{2}$/;

/** The rules, in the order a sentence is tried: the first one that matches names the phrase. */
const RULES: readonly RegExp[] = [
  new RegExp(String.raw`\b${PERCENT}`, "gi"),
  new RegExp(String.raw`\b\d+(?:\.\d+)?\s?[x×]\s+${COMPARATIVE}\b`, "gi"),
  new RegExp(String.raw`\b(?:\d+|two|three|four|five|ten)\s+times\s+${COMPARATIVE}\b`, "gi"),
  /\btwice\s+as\s+\w+/gi,
  // A result verb, up to four words, then a number that is not a year.
  new RegExp(
    String.raw`\b${RESULT_VERB}\b(?:\s+[^\s\d$][^\s]*){0,4}?\s+\$?(\d+(?:[.,]\d+)*)`,
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
function claimPhrase(sentence: string): string | undefined {
  // Masking keeps offsets, so a phrase is always cut from the sentence as written.
  const masked = sentence.replace(OFFER, (offer) => " ".repeat(offer.length));
  for (const rule of RULES) {
    for (const match of masked.matchAll(rule)) {
      const number = match[1];
      if (number !== undefined && YEAR.test(number)) continue;
      return sentence.slice(match.index, match.index + match[0].length);
    }
  }
  return undefined;
}

/**
 * Every result claim in `text` that is not approved, one per sentence, in order. `approved` holds the
 * company's approved claims and any claim a person approved for this one draft.
 */
export function findResultClaims(text: string, approved: readonly string[]): ResultClaim[] {
  const allowed = new Set(approved.map(normalizeClaim));
  const found: ResultClaim[] = [];
  for (const sentence of sentences(text)) {
    if (allowed.has(normalizeClaim(sentence))) continue;
    const phrase = claimPhrase(sentence);
    if (phrase !== undefined) found.push({ claim: sentence, phrase });
  }
  return found;
}
