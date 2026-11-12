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

import {
  type CompanyAddress,
  type CompanyEscalationRule,
  type CompanyGlossaryEntry,
  type CompanyHours,
  type CompanyMarketing,
  type CompanyPolicies,
  type CompanyPriceBookItem,
  type CompanyProfile,
  type CompanyRecordPerson,
  type CompanyService,
  type CompanyTestimonial,
  type CompanyTone,
  loadCompanyFacts as loadFacts,
  personById as person,
  personLabel as sharedPersonLabel,
} from "@officehum/sdk";

// The lookups and the money format are the SDK's, shared by every role; re-exported under the names
// this package has always used.
export { money, personById as person } from "@officehum/sdk";

/** Where the generated facts live, from either `src/company.ts` or `dist/company.js`. */
export const COMPANY_FACTS_URL = new URL(
  "../skills/company-handbook/references/facts.json",
  import.meta.url,
);

export type Address = CompanyAddress;
export type Profile = Pick<
  CompanyProfile,
  | "legalName"
  | "tradingName"
  | "tagline"
  | "address"
  | "phone"
  | "email"
  | "serviceArea"
  | "clients"
>;
export type Hours = CompanyHours;
export type Person = Pick<CompanyRecordPerson, "id" | "name" | "title" | "email" | "decides">;
/** One service the company sells, and the price book lines that price it. */
export type Service = CompanyService;
export type PriceBookLine = CompanyPriceBookItem;
/** A customer's words the company holds on record, and may quote. */
export type Testimonial = CompanyTestimonial;
/**
 * What marketing may say. `approvedClaims` are the only results and facts it states without a
 * person; `approverId` is the person who approves a new claim and everything published. Both are
 * the company's own settings, kept in its data.
 */
export type Marketing = CompanyMarketing;
export type Policies = Pick<CompanyPolicies, "safety" | "commitments">;
export type Tone = CompanyTone;
export type EscalationRule = CompanyEscalationRule;
export type GlossaryEntry = CompanyGlossaryEntry;

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

/** What an offer may name after "off": one of the company's own services or price book lines. */
export function offerTerms(company: Pick<CompanyFacts, "services" | "priceBook">): string[] {
  return [
    ...company.services.map((service) => service.name),
    ...company.priceBook.map((line) => line.name),
  ];
}
