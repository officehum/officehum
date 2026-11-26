/**
 * The company this role keeps stock for, read from the copy generated into its own package.
 *
 * `skills/company-handbook/references/facts.json` is written by `npm run sync-company` from
 * `company/default/company.json`; the same facts reach the model as prose in the handbook skill. The
 * stock locations, the supply catalogue with its unit costs and reorder points, the crews stock is
 * issued to, who owns the counts and who approves a write-off all come from here, so no item, cost or
 * person is written into the code. The adjustment limit is the role's own manifest limit, not a
 * company fact.
 *
 * Only the parts of the record this role reads are typed here. A host that has its own company passes
 * `company` to the factory instead, and nothing in this file runs.
 */

import {
  type CompanyCrew,
  type CompanyEscalationRule,
  type CompanyGlossaryEntry,
  type CompanyHours,
  type CompanyPolicies,
  type CompanyProfile,
  type CompanyRecord,
  type CompanyRecordPerson,
  type CompanySupplyItem,
  type CompanyTone,
  holder,
  loadCompanyFacts as loadFacts,
  money,
  personById as person,
  personLabel as sharedPersonLabel,
} from "@officehum/sdk";

/** Where the generated facts live, from either `src/company.ts` or `dist/company.js`. */
export const COMPANY_FACTS_URL = new URL(
  "../skills/company-handbook/references/facts.json",
  import.meta.url,
);

export type Profile = Pick<
  CompanyProfile,
  "legalName" | "tradingName" | "tagline" | "address" | "phone" | "email"
>;
export type Hours = CompanyHours;
export type Person = CompanyRecordPerson;
/** One stocked item, with the unit cost the company records and its reorder point. */
export type SupplyItem = CompanySupplyItem;
/** A crew stock is issued to. */
export type Crew = CompanyCrew;
export type Policies = Pick<CompanyPolicies, "safety" | "commitments">;
export type Tone = CompanyTone;
export type EscalationRule = CompanyEscalationRule;
export type GlossaryEntry = CompanyGlossaryEntry;

/** A place stock is kept: the storeroom, or a vehicle. */
export interface StockLocation {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

/** The company's stock settings: where stock is kept, who owns the counts, who approves a write-off. */
export interface InventorySettings {
  readonly locations: readonly StockLocation[];
  /** The person on the company record who owns the counts and decides an adjustment. */
  readonly countsOwnerId: string;
  /** The person on the company record who approves a write-off. */
  readonly writeOffApproverId: string;
}

/** Everything the company records that this role reads. */
export type CompanyFacts = Pick<
  CompanyRecord,
  "hours" | "people" | "tone" | "escalation" | "glossary" | "supplyCatalog" | "crews"
> & {
  readonly profile: Profile;
  readonly policies?: Policies;
  readonly inventory?: InventorySettings;
};

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
// The default company has every section of role data, so what it loads is typed as complete.
export const loadCompanyFacts = (): Required<CompanyFacts> =>
  loadFacts<Required<CompanyFacts>>(COMPANY_FACTS_URL);

/** The person who owns the counts: an adjustment over the limit and a suspected loss go to them. */
export const countsOwner = (company: Pick<CompanyFacts, "people" | "inventory">) =>
  holder(company, "purchasing", company.inventory?.countsOwnerId);

/** The person who approves a write-off. */
export const writeOffApprover = (company: Pick<CompanyFacts, "people" | "inventory">) =>
  holder(company, "stock-write-offs", company.inventory?.writeOffApproverId);

export { money, person };

/** "Name, Title", or a title-free fallback when the company names nobody. */
export const personLabel = (who: Person | undefined, fallback = "the person who owns the counts") =>
  sharedPersonLabel(who, fallback);
