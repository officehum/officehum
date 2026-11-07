/**
 * The company this role buys for, read from the copy generated into its own package.
 *
 * `skills/company-handbook/references/facts.json` is written by `npm run sync-company` from
 * `company/default/company.json`; the same facts reach the model as prose in the handbook skill. The
 * suppliers, the approved list, the supply catalogue with its unit costs and reorder points, and the
 * spending limit on a purchase order all come from here, so there is no money constant anywhere in the
 * code: a limit changes in the company package, is synced, and the desk enforces the new one.
 *
 * Only the parts of the record Purchasing reads are typed here. A host that has its own company passes
 * `company` to the factory instead, and nothing in this file runs.
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

/**
 * A supplier on file. `approved` is the company's own approved-supplier list, a setting it keeps in
 * its data, not a legal rule: the desk orders only from a supplier marked approved.
 */
export interface Supplier {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly approved: boolean;
  readonly leadTimeDays: number;
  readonly contactEmail: string;
}

/** One stocked item, bought from its usual supplier at the unit cost the company records. */
export interface SupplyItem {
  readonly id: string;
  readonly name: string;
  readonly supplierId: string;
  readonly unit: string;
  readonly unitCostCents: number;
  /** Reorder when the stock on hand plus on order falls to this. */
  readonly reorderPoint: number;
  /** How many to order when it does. */
  readonly reorderQuantity: number;
}

export interface ApprovalLimits {
  /** A purchase order whose total is above this needs a person's approval before it goes out. */
  readonly purchaseOrderOverCents: number;
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
  readonly policies: Policies;
  readonly tone: Tone;
  readonly escalation: readonly EscalationRule[];
  readonly glossary: readonly GlossaryEntry[];
  readonly approvalLimits: ApprovalLimits;
  readonly suppliers: readonly Supplier[];
  readonly supplyCatalog: readonly SupplyItem[];
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

/** One person by id, or `undefined` when nobody here has that id. */
export function person(company: CompanyFacts, id: string): Person | undefined {
  return company.people.find((candidate) => candidate.id === id);
}

/**
 * The person who decides purchasing: whoever holds the purchasing title. The sources call that person
 * the purchasing manager; a small company gives the job its own title, so it is found by the word in
 * the title, and the name comes from the company rather than from this package. An order over the
 * limit, a new supplier, a supplier contract, a claim and surplus stock all go to them.
 */
export function purchasingLead(company: CompanyFacts): Person | undefined {
  return company.people.find((candidate) => /purchasing/i.test(candidate.title));
}

/** "Name, Title", or the title-free fallback when the company names nobody. */
export function personLabel(lead: Person | undefined): string {
  return lead === undefined ? "the person who decides purchasing" : `${lead.name}, ${lead.title}`;
}
