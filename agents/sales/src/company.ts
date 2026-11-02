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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Where the generated facts live, from either `src/company.ts` or `dist/company.js`. */
export const COMPANY_FACTS_URL = new URL(
  "../skills/company-handbook/references/facts.json",
  import.meta.url,
);

export interface Address {
  readonly street: string;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly country: string;
}

export interface Insurance {
  readonly kind: string;
  readonly limitCents: number;
}

export interface Field {
  readonly cleaningCrews: number;
  readonly cleanersPerCrew: number;
  readonly maintenanceTechnicians: number;
  readonly office: number;
}

export interface Profile {
  readonly legalName: string;
  readonly tradingName: string;
  readonly tagline: string;
  readonly founded: number;
  readonly headcount: number;
  readonly field: Field;
  readonly address: Address;
  readonly phone: string;
  readonly email: string;
  readonly website: string;
  readonly registration: string;
  readonly serviceArea: string;
  readonly insurance: readonly Insurance[];
  readonly clients: string;
}

export interface Hours {
  readonly timezone: string;
  readonly office: string;
  readonly crews: string;
  readonly emergencyLine: string;
  readonly closedOn: string;
  readonly note: string;
}

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly department: string;
  readonly email: string;
  readonly phone: string;
  readonly decides: readonly string[];
}

export interface Service {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly priceBookIds: readonly string[];
  readonly leadTimeDays: number;
}

/** One line of the price book: the only place a price in this role comes from. */
export interface PriceBookItem {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly unit: string;
  /** The unit price in integer cents, never a float. */
  readonly unitPriceCents: number;
  /** The least a line of this item may come to, in integer cents, or `null` for none. */
  readonly minimumCents: number | null;
  readonly notes: string;
}

export interface RefundPolicy {
  readonly summary: string;
  readonly recleanWindowDays: number;
  readonly serviceRecoveryCreditCents: number;
  readonly creditNeeds: string;
  readonly refundNeeds: string;
  readonly complaintOwner: string;
}

export interface DiscountLadderStep {
  readonly commitmentMonths: number;
  readonly percent: number;
}

export interface DiscountPolicy {
  readonly summary: string;
  readonly approver: string;
  readonly ownerApprover: string;
  readonly ownerAbovePercent: number;
  readonly ladder: readonly DiscountLadderStep[];
}

export interface Policies {
  readonly refunds: RefundPolicy;
  readonly discounts: DiscountPolicy;
  readonly safety: readonly string[];
  readonly dataHandling: readonly string[];
  readonly commitments: readonly string[];
}

export interface Tone {
  readonly summary: string;
  readonly always: readonly string[];
  readonly never: readonly string[];
}

export interface EscalationRule {
  /** What a request is about, e.g. `discount-request`. */
  readonly topic: string;
  /** The person who decides it, by `people[].id`. */
  readonly toPersonId: string;
  readonly when: string;
}

export interface GlossaryEntry {
  readonly term: string;
  readonly meaning: string;
}

/** Everything the company records, as this role reads it. */
export interface CompanyFacts {
  readonly profile: Profile;
  readonly hours: Hours;
  readonly people: readonly Person[];
  readonly services: readonly Service[];
  readonly priceBook: readonly PriceBookItem[];
  readonly policies: Policies;
  readonly tone: Tone;
  readonly escalation: readonly EscalationRule[];
  readonly glossary: readonly GlossaryEntry[];
  readonly approvalLimits: { readonly quoteOverCents: number };
}

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
export function loadCompanyFacts(): CompanyFacts {
  const path = fileURLToPath(COMPANY_FACTS_URL);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(COMPANY_FACTS_URL, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `${path} could not be read: ${error instanceof Error ? error.message : String(error)}. ` +
        "It is generated: run `npm run sync-company` in the repository this package came from.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must hold a JSON object.`);
  }
  return parsed as CompanyFacts;
}

const CURRENCY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Integer cents as the money a person reads, never a recomputed amount. */
export function money(cents: number): string {
  return CURRENCY.format(cents / 100);
}

/** One price book item by id, or `undefined` when the book has no such line. */
export function priceBookItem(company: CompanyFacts, id: string): PriceBookItem | undefined {
  return company.priceBook.find((item) => item.id === id);
}

/** One person by id, or `undefined` when nobody here has that id. */
export function person(company: CompanyFacts, id: string): Person | undefined {
  return company.people.find((candidate) => candidate.id === id);
}

/** The escalation rule for a request, or `undefined` when the company has not named one. */
export function escalationRule(company: CompanyFacts, topic: string): EscalationRule | undefined {
  return company.escalation.find((rule) => rule.topic === topic);
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
