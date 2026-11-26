/**
 * The pattern scan `memory_save` runs on every text before anything is stored. It is a guardrail in
 * code, not a prompt rule: a secret is always refused, and payment details force the protected
 * `payment_details` category whatever the model chose, which blocks the classic "please update our
 * bank details" fraud (docs/design/agent-package.md, "Memory").
 *
 * Numbers are confirmed by their check digits (IBAN mod 97, the ABA checksum, Luhn), so an order
 * number or a ticket id of the same length is not mistaken for one.
 */

/** What the scan found: a reason for each, phrased to finish "the text contains …". */
export interface ScanResult {
  /** The text holds a secret; it is never saved. */
  readonly secret?: string;
  /** The text holds payment details; the category becomes `payment_details`. */
  readonly paymentDetails?: string;
}

const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [
    // Stripe, Anthropic/OpenAI, AWS access key ids, GitHub and Slack tokens.
    /\b(?:[spr]k_(?:live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,})/,
    "an API key",
  ],
  [
    /\b(?:password|passwd|passcode|pwd|api[_ -]?key|secret|token)\b\s*(?:is|:|=)\s*\S{4,}/i,
    "a password or labelled secret",
  ],
];

const BANK_NOUN =
  "(?:bank|banking|wire|remittance|payment)\\s+(?:details|info|information|account|instructions)";
const CHANGED_BANK_DETAILS = [
  new RegExp(
    `\\b(?:new|changed|updated|different|change\\s+(?:of|to)|update\\s+(?:of|to))\\s+(?:(?:our|their|the|its|his|her)\\s+)?${BANK_NOUN}\\b`,
    "i",
  ),
  new RegExp(
    `\\b${BANK_NOUN}\\s+(?:(?:have|has)\\s+)?(?:changed|been\\s+(?:changed|updated)|updated)\\b`,
    "i",
  ),
];

/** Scans `text` for secrets and payment details. */
export function scanText(text: string): ScanResult {
  const secret = SECRET_PATTERNS.find(([pattern]) => pattern.test(text))?.[1];
  const paymentDetails = findPaymentDetails(text);
  return {
    ...(secret === undefined ? {} : { secret }),
    ...(paymentDetails === undefined ? {} : { paymentDetails }),
  };
}

function findPaymentDetails(text: string): string | undefined {
  for (const match of text.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g)) {
    if (validIban(match[0])) return "an IBAN";
  }
  for (const match of text.matchAll(/(?<![\d-])\d{9}(?![\d-])/g)) {
    if (validRouting(match[0])) return "an ABA routing number";
  }
  // 12 to 19 digits, optionally grouped by single spaces or dashes, as cards and accounts are written.
  for (const match of text.matchAll(/(?<![\d-])\d(?:[ -]?\d){11,18}(?![\d-])/g)) {
    if (luhn(match[0].replace(/\D/g, ""))) return "a card or account number";
  }
  if (CHANGED_BANK_DETAILS.some((pattern) => pattern.test(text))) {
    return "wording about changed bank or wire details";
  }
  return undefined;
}

/** ISO 13616: move the first four characters to the end, letters to numbers, mod 97 is 1. */
function validIban(candidate: string): boolean {
  const iban = candidate.replace(/ /g, "");
  if (iban.length < 15 || iban.length > 34) return false;
  const digits = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, (letter) =>
    String(letter.charCodeAt(0) - 55),
  );
  let remainder = 0;
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

/** The ABA checksum: 3, 7 and 1 weights over the nine digits sum to a multiple of 10. */
function validRouting(digits: string): boolean {
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = [...digits].reduce(
    (total, digit, index) => total + Number(digit) * (weights[index] ?? 0),
    0,
  );
  return sum % 10 === 0 && Number(digits) !== 0;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}
