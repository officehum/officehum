/**
 * The company this role works for, read from the copy generated into its own package.
 *
 * `skills/company-handbook/references/facts.json` is written by `npm run sync-company` from
 * `company/default/company.json`; the same facts reach the model as prose in the handbook skill. A
 * role here quotes only what this record holds, so there is no price constant anywhere in the code:
 * a price changes in the company package, is synced, and every role speaks the new one.
 *
 * A host that has its own company passes `company` to the factory instead, and nothing in this file
 * runs. The file is read rather than imported because it sits outside `src` — a published role ships
 * `dist` and `skills` side by side, and this path is the one thing that must survive that layout.
 */

import {
  type CompanyAddress,
  type CompanyDiscountLadderStep,
  type CompanyDiscountPolicy,
  type CompanyEscalationRule,
  type CompanyFieldStaff,
  type CompanyGlossaryEntry,
  type CompanyHours,
  type CompanyInsurance,
  type CompanyPolicies,
  type CompanyPriceBookItem,
  type CompanyProfile,
  type CompanyQuoting,
  type CompanyRecord,
  type CompanyRecordPerson,
  type CompanyRefundPolicy,
  type CompanyService,
  type CompanyTone,
  escalationRule,
  loadCompanyFacts as loadFacts,
  money,
  personById as person,
} from "@officehum/sdk";

/** Where the generated facts live, from either `src/company.ts` or `dist/company.js`. */
export const COMPANY_FACTS_URL = new URL(
  "../skills/company-handbook/references/facts.json",
  import.meta.url,
);

export type Address = CompanyAddress;
export type Insurance = CompanyInsurance;
export type Field = CompanyFieldStaff;
export type Profile = CompanyProfile;
export type Hours = CompanyHours;
export type Person = CompanyRecordPerson;
export type Service = CompanyService;
/** One line of the price book: the only place a price in this role comes from. */
export type PriceBookItem = CompanyPriceBookItem;
/** How the company counts a quote, where that is a rule of its own rather than a price. */
export type Quoting = CompanyQuoting;
export type RefundPolicy = CompanyRefundPolicy;
export type DiscountLadderStep = CompanyDiscountLadderStep;
export type DiscountPolicy = CompanyDiscountPolicy;
export type Policies = CompanyPolicies;
export type Tone = CompanyTone;
export type EscalationRule = CompanyEscalationRule;
export type GlossaryEntry = CompanyGlossaryEntry;

/** Everything the company records, as this role reads it. */
export type CompanyFacts = Pick<
  CompanyRecord,
  | "profile"
  | "hours"
  | "people"
  | "services"
  | "priceBook"
  | "quoting"
  | "policies"
  | "tone"
  | "escalation"
  | "glossary"
>;

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
export const loadCompanyFacts = (): CompanyFacts => loadFacts<CompanyFacts>(COMPANY_FACTS_URL);

export { escalationRule, money, person };

/** One price book item by id, or `undefined` when the book has no such line. */
export function priceBookItem(company: CompanyFacts, id: string): PriceBookItem | undefined {
  return company.priceBook.find((item) => item.id === id);
}

/** A price and its minimum, in one phrase: what a client sees beside a line. */
export function priceText(item: PriceBookItem): string {
  const minimum = item.minimumCents === null ? "" : `, minimum ${money(item.minimumCents)}`;
  return `${money(item.unitPriceCents)} per ${item.unit}${minimum}`;
}

/** Words too common to say what a client is asking for. */
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "our",
  "with",
  "about",
  "much",
  "cost",
  "costs",
  "price",
  "prices",
  "priced",
  "how",
  "does",
  "what",
  "per",
  "you",
  "your",
  "can",
  "could",
  "would",
  "need",
  "needs",
  "want",
  "give",
  "charge",
  "there",
  "from",
  "this",
  "that",
  "have",
  "get",
  "are",
  "was",
]);

/** The words in a search: lower case, no punctuation, nothing shorter than three letters. */
export function searchWords(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

/**
 * The price book items a client's words point at, best match first. Every word of the query that
 * appears in an item's name, id, category, unit or notes scores it, so "deep clean for a dentist"
 * finds the deep clean and not the carpet extraction, and a query that matches nothing returns
 * nothing rather than the nearest thing.
 */
export function searchPriceBook(company: CompanyFacts, query: string): readonly PriceBookItem[] {
  const words = searchWords(query);
  if (words.length === 0) return [];
  return company.priceBook
    .map((item) => {
      const haystack =
        `${item.id} ${item.name} ${item.category} ${item.unit} ${item.notes}`.toLowerCase();
      const score = words.filter((word) => haystack.includes(word)).length;
      return { item, score };
    })
    .filter((scored) => scored.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.item.category.localeCompare(right.item.category) ||
        left.item.name.localeCompare(right.item.name),
    )
    .map((scored) => scored.item);
}
