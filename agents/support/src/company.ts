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
  findPeople,
  loadCompanyFacts as loadFacts,
  personLabel,
  companyHead as sdkCompanyHead,
} from "@officehum/sdk";

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
  /** Other names colleagues use for them ("DW"); a complaint naming one is kept away from them. */
  readonly aliases?: readonly string[];
  readonly decides: readonly string[];
}

/** One price book line: invoice lines are priced from these, never from a figure in a message. */
export interface PriceBookItem {
  readonly id: string;
  readonly name: string;
  readonly unit: string;
  /** The unit price in integer cents. */
  readonly unitPriceCents: number;
  /** The least a line of this item comes to, in integer cents, or `null` for none. */
  readonly minimumCents: number | null;
}

/** How a service failure is put right, and who decides which remedy. */
export interface RefundPolicy {
  readonly summary: string;
  /** A re-clean is booked within this many business days of the complaint. */
  readonly recleanWindowDays: number;
  /** The usual credit for a service failure: a credit never comes to more than this or the line. */
  readonly serviceRecoveryCreditCents: number;
  /** The person id who approves a credit note. */
  readonly creditNeeds: string;
  /** The person id who decides money back. */
  readonly refundNeeds: string;
  /** The person id who owns complaints about a visit. */
  readonly complaintOwner: string;
}

export interface Policies {
  readonly refunds: RefundPolicy;
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
  readonly priceBook: readonly PriceBookItem[];
  readonly policies: Policies;
  readonly tone: Tone;
  readonly escalation: readonly EscalationRule[];
  readonly glossary: readonly GlossaryEntry[];
}

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
export const loadCompanyFacts = (): CompanyFacts => loadFacts<CompanyFacts>(COMPANY_FACTS_URL);

const CURRENCY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Integer cents as the money a person reads, never a recomputed amount. */
export function money(cents: number): string {
  return CURRENCY.format(cents / 100);
}

/** One person by id, or `undefined` when nobody here has that id. */
export function person(company: Pick<CompanyFacts, "people">, id: string): Person | undefined {
  return company.people.find((candidate) => candidate.id === id);
}

/** The person whose escalation topic this is, or `undefined` when the record has no such topic. */
export function escalationOwner(
  company: Pick<CompanyFacts, "people" | "escalation">,
  topic: string,
): Person | undefined {
  const rule = company.escalation.find((candidate) => candidate.topic === topic);
  return rule === undefined ? undefined : person(company, rule.toPersonId);
}

/**
 * The person at the top of the company, by the SDK's one rule: a head title first, a bare director
 * only when nobody holds one. A complaint about the person who would normally take it goes here.
 */
export function companyHead(company: Pick<CompanyFacts, "people">): Person | undefined {
  return sdkCompanyHead(company);
}

export { findPeople, personLabel };
