/**
 * The company this role markets, read from the copy generated into its own package.
 *
 * `skills/company-handbook/references/facts.json` is written by `npm run sync-company` from
 * `company/default/company.json`; the same facts reach the model as prose in the handbook skill. The
 * services and their prices, the claims marketing may make, any testimonials on file, the postal
 * address a campaign email carries and the person who approves what is published all come from here,
 * so no company fact is kept in the code.
 *
 * Only the parts of the record Marketing reads are typed here. A host that has its own company passes
 * `company` to the factory instead, and nothing in this file runs.
 */

import { loadCompanyFacts as loadFacts, personLabel as sharedPersonLabel } from "@officehum/sdk";

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

export interface Profile {
  readonly legalName: string;
  readonly tradingName: string;
  readonly tagline: string;
  readonly address: Address;
  readonly phone: string;
  readonly email: string;
  readonly serviceArea: string;
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
  readonly email: string;
  readonly decides: readonly string[];
}

/** One service the company sells, and the price book lines that price it. */
export interface Service {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly priceBookIds: readonly string[];
  readonly leadTimeDays: number;
}

export interface PriceBookLine {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly unit: string;
  readonly unitPriceCents: number;
  readonly minimumCents: number | null;
  readonly notes: string;
}

/** A customer's words the company holds on record, and may quote. */
export interface Testimonial {
  readonly quote: string;
  readonly by: string;
}

/**
 * What marketing may say. `approvedClaims` are the only results and facts it states without a
 * person; `approverId` is the person who approves a new claim and everything published. Both are
 * the company's own settings, kept in its data.
 */
export interface Marketing {
  readonly approverId: string;
  readonly approvedClaims: readonly string[];
  /** Absent or empty: the company holds no testimonial, and none is quoted. */
  readonly testimonials?: readonly Testimonial[];
}

export interface Policies {
  readonly safety: readonly string[];
  readonly commitments: readonly string[];
}

export interface Tone {
  readonly summary: string;
  readonly always: readonly string[];
  readonly never: readonly string[];
}

export interface EscalationRule {
  readonly topic: string;
  readonly toPersonId: string;
  readonly when: string;
}

export interface GlossaryEntry {
  readonly term: string;
  readonly meaning: string;
}

/** Everything the company records that this role reads. */
export interface CompanyFacts {
  readonly profile: Profile;
  readonly hours: Hours;
  readonly people: readonly Person[];
  readonly services: readonly Service[];
  readonly priceBook: readonly PriceBookLine[];
  readonly policies: Policies;
  readonly tone: Tone;
  readonly escalation: readonly EscalationRule[];
  readonly glossary: readonly GlossaryEntry[];
  readonly marketing: Marketing;
}

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
export const loadCompanyFacts = (): CompanyFacts => loadFacts<CompanyFacts>(COMPANY_FACTS_URL);

const CURRENCY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Integer cents as the money a person reads, never a recomputed amount. */
export function money(cents: number): string {
  return CURRENCY.format(cents / 100);
}

/** One person by id, or `undefined` when nobody here has that id. */
export function person(company: CompanyFacts, id: string): Person | undefined {
  return company.people.find((candidate) => candidate.id === id);
}

/**
 * The person who approves what marketing publishes and any claim not on the approved list: the one
 * the company's `marketing.approverId` names. Every `publish` and `request_claim_approval` asks them.
 */
export function marketingApprover(company: CompanyFacts): Person | undefined {
  return person(company, company.marketing.approverId);
}

/** "Name, Title", or the title-free fallback when the company names nobody. */
export const personLabel = (who: Person | undefined): string =>
  sharedPersonLabel(who, "the person who approves marketing");

/** The company's postal address on one line, as a campaign email carries it. */
export function postalAddress(company: CompanyFacts): string {
  const { legalName, address } = company.profile;
  return `${legalName}, ${address.street}, ${address.city}, ${address.region} ${address.postalCode}, ${address.country}`;
}
