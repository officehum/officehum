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

import {
  type CompanyAddress,
  type CompanyApprovalLimits,
  type CompanyEscalationRule,
  type CompanyGlossaryEntry,
  type CompanyHours,
  type CompanyPolicies,
  type CompanyProfile,
  type CompanyRecord,
  type CompanyRecordPerson,
  type CompanySupplier,
  type CompanySupplyItem,
  type CompanyTone,
  loadCompanyFacts as loadFacts,
  money,
  personById as person,
  purchasingLead,
  personLabel as sharedPersonLabel,
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
export type Person = CompanyRecordPerson;
/**
 * A supplier on file. `approved` is the company's own approved-supplier list, a setting it keeps in
 * its data, not a legal rule: the desk orders only from a supplier marked approved.
 */
export type Supplier = CompanySupplier;
/** One stocked item, bought from its usual supplier at the unit cost the company records. */
export type SupplyItem = CompanySupplyItem;
export type ApprovalLimits = CompanyApprovalLimits;
export type Policies = Pick<CompanyPolicies, "safety" | "commitments">;
export type Tone = CompanyTone;
export type EscalationRule = CompanyEscalationRule;
export type GlossaryEntry = CompanyGlossaryEntry;

/** Everything the company records that this role reads. */
export type CompanyFacts = Pick<
  CompanyRecord,
  | "hours"
  | "people"
  | "tone"
  | "escalation"
  | "glossary"
  | "approvalLimits"
  | "suppliers"
  | "supplyCatalog"
> & {
  readonly profile: Profile;
  readonly policies: Policies;
};

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
export const loadCompanyFacts = (): CompanyFacts => loadFacts<CompanyFacts>(COMPANY_FACTS_URL);

/**
 * `purchasingLead` is the person who decides purchasing: whoever the company record puts in the
 * `purchasing` department. The sources call that person the purchasing manager; a small company gives
 * the job its own title, so the record's department says who it is, not a word in the title, and the
 * name comes from the company rather than from this package. An order over the limit, a new supplier,
 * a supplier contract, a claim and surplus stock all go to them.
 */
export { money, person, purchasingLead };

/** "Name, Title", or the title-free fallback when the company names nobody. */
export const personLabel = (who: Person | undefined): string =>
  sharedPersonLabel(who, "the person who decides purchasing");
