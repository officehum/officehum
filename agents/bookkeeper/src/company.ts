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

import {
  type CompanyHours,
  type CompanyRecord,
  type CompanyRecordPerson,
  type CompanySupplier,
  type CompanySupplyItem,
  loadCompanyFacts as loadFacts,
  money,
  personLabel,
  purchasingLead,
} from "@officehum/sdk";

/** Where the generated facts live, from either `src/company.ts` or `dist/company.js`. */
export const COMPANY_FACTS_URL = new URL(
  "../skills/company-handbook/references/facts.json",
  import.meta.url,
);

export type Person = CompanyRecordPerson;

/** A supplier on file; `approved` is the company's own approved-supplier list. */
export type Supplier = CompanySupplier;

/** One stocked item, bought from its usual supplier at the unit cost the company records. */
export type SupplyItem = Omit<CompanySupplyItem, "reorderPoint" | "reorderQuantity">;

/** Everything the company records that accounts payable reads. */
export type CompanyFacts = Pick<CompanyRecord, "people" | "suppliers"> & {
  /** The time zone the company keeps its day in: "today" for a due date and the days overdue. */
  readonly hours: Pick<CompanyHours, "timezone">;
  readonly supplyCatalog: readonly SupplyItem[];
};

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
export const loadCompanyFacts = (): CompanyFacts => loadFacts<CompanyFacts>(COMPANY_FACTS_URL);

/**
 * The person who owns finance: whoever holds a title with "finance" in it. Payment details, payment
 * terms, a repayment plan and a major unmatched bank item all go to them. A small company gives the
 * job its own title, so it is found by the word, and the name comes from the company.
 */
export function financeLead(company: CompanyFacts): Person | undefined {
  return company.people.find((candidate) => /finance/i.test(candidate.title));
}

export { money, personLabel, purchasingLead };
