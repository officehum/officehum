/**
 * The company this role keeps the books for, read from the copy generated into its own package.
 *
 * `skills/company-handbook/references/facts.json` is written by `npm run sync-company` from
 * `company/default/company.json`; the same facts reach the model as prose in the handbook skill. The
 * suppliers, the supply catalogue with its unit costs, and the people and their titles come from here,
 * so a supplier bill is priced from the company's own catalogue and a hand-off names whoever holds the
 * title in this company, never a name written into the role.
 *
 * Only the parts of the record accounts payable reads are typed here. A host with its own company
 * passes `company` to the factory instead, and nothing in this file runs.
 */

import { loadCompanyFacts as loadFacts, personLabel } from "@officehum/sdk";

/** Where the generated facts live, from either `src/company.ts` or `dist/company.js`. */
export const COMPANY_FACTS_URL = new URL(
  "../skills/company-handbook/references/facts.json",
  import.meta.url,
);

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  /** Where they work: `office`, `maintenance` or `purchasing`, as the company record lists them. */
  readonly department: string;
  readonly email: string;
  readonly decides: readonly string[];
}

/** A supplier on file; `approved` is the company's own approved-supplier list. */
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
}

/** Everything the company records that accounts payable reads. */
export interface CompanyFacts {
  readonly people: readonly Person[];
  readonly suppliers: readonly Supplier[];
  readonly supplyCatalog: readonly SupplyItem[];
}

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
export const loadCompanyFacts = (): CompanyFacts => loadFacts<CompanyFacts>(COMPANY_FACTS_URL);

const CURRENCY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Integer cents as the money a person reads, never a recomputed amount. */
export function money(cents: number): string {
  return CURRENCY.format(cents / 100);
}

/**
 * The person who owns finance: whoever holds a title with "finance" in it. Payment details, payment
 * terms, a repayment plan and a major unmatched bank item all go to them. A small company gives the
 * job its own title, so it is found by the word, and the name comes from the company.
 */
export function financeLead(company: CompanyFacts): Person | undefined {
  return company.people.find((candidate) => /finance/i.test(candidate.title));
}

/**
 * The person who decides purchasing, who owns a new supplier: whoever the company record puts in the
 * `purchasing` department, so a retitled job still finds them.
 */
export function purchasingLead(company: CompanyFacts): Person | undefined {
  return company.people.find((candidate) => candidate.department === "purchasing");
}

export { personLabel };
