/**
 * The company this role answers for, read from the copy generated into its own package.
 *
 * `skills/company-handbook/references/facts.json` is written by `npm run sync-company` from
 * `company/default/company.json`; the same facts reach the model as prose in the handbook skill. The
 * price book that invoice lines are priced from, the re-clean window, the usual service-recovery
 * credit, and who decides complaints, credits and money back all come from here, so there is no
 * money constant and no person's name anywhere in the code.
 *
 * Only the parts of the record Customer Support reads are typed here. A host that has its own company
 * passes `company` to the factory instead, and nothing in this file runs.
 */

import {
  type CompanyAddress,
  type CompanyEscalationRule,
  type CompanyGlossaryEntry,
  type CompanyHours,
  type CompanyPolicies,
  type CompanyPriceBookItem,
  type CompanyProfile,
  type CompanyRecord,
  type CompanyRecordPerson,
  type CompanyRefundPolicy,
  type CompanyTone,
  companyHead,
  escalationOwner,
  findPeople,
  loadCompanyFacts as loadFacts,
  money,
  personById as person,
  personLabel,
} from "@officehum/sdk";

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

/** A colleague as this role reads them; a complaint naming one (or an alias) is kept away from them. */
export type Person = Omit<CompanyRecordPerson, "department" | "phone">;

/** One price book line: invoice lines are priced from these, never from a figure in a message. */
export type PriceBookItem = Omit<CompanyPriceBookItem, "category" | "notes">;

/** How a service failure is put right, and who decides which remedy. */
export type RefundPolicy = CompanyRefundPolicy;

export type Policies = Omit<CompanyPolicies, "discounts">;

export type Tone = CompanyTone;

export type EscalationRule = CompanyEscalationRule;

export type GlossaryEntry = CompanyGlossaryEntry;

/** Everything the company records that this role reads. */
export type CompanyFacts = Pick<CompanyRecord, "hours" | "tone" | "escalation" | "glossary"> & {
  readonly profile: Profile;
  readonly people: readonly Person[];
  readonly priceBook: readonly PriceBookItem[];
  readonly policies: Policies;
};

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
export const loadCompanyFacts = (): CompanyFacts => loadFacts<CompanyFacts>(COMPANY_FACTS_URL);

// `companyHead` is the SDK's one rule for the person at the top of the company: a head title first,
// a bare director only when nobody holds one. A complaint about the person who would normally take
// it goes there.
export { companyHead, escalationOwner, findPeople, money, person, personLabel };
