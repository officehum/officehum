/**
 * The company this role works for, read from the copy generated into its own package.
 *
 * `skills/company-handbook/references/facts.json` is written by `npm run sync-company` from
 * `company/default/company.json`; the same facts reach the model as prose in the handbook skill. The
 * inspection checklist and its weights, who owns quality, who the safety officer is, and who decides
 * credits and staff matters all come from here, so there is no weight, no score and no person's name
 * anywhere in the code. The pass score is not company data: it is the role's own manifest limit.
 *
 * Only the parts of the record Quality reads are typed here. A host that has its own company passes
 * `company` to the factory instead, and nothing in this file runs.
 */

import {
  type CompanyEscalationRule,
  type CompanyGlossaryEntry,
  type CompanyHours,
  type CompanyPolicies,
  type CompanyProfile,
  type CompanyRecord,
  type CompanyRecordPerson,
  type CompanyRefundPolicy,
  type CompanyStaffPolicies,
  type CompanyTone,
  holder,
  loadCompanyFacts as loadFacts,
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
export type Policies = Pick<CompanyPolicies, "safety" | "commitments"> & {
  readonly refunds: Pick<CompanyRefundPolicy, "creditNeeds" | "refundNeeds">;
};
export type Tone = CompanyTone;
export type EscalationRule = CompanyEscalationRule;
export type GlossaryEntry = CompanyGlossaryEntry;

/**
 * One line of the inspection checklist. `weight` is how many points the item is worth: the more
 * important the item, the more it counts, and the desk scores an inspection from these alone.
 */
export interface ChecklistItem {
  readonly id: string;
  readonly area: string;
  readonly item: string;
  readonly weight: number;
}

/** Who owns quality, and the checklist every site is inspected against. */
export interface QualityPolicy {
  readonly ownerId: string;
  readonly checklist: readonly ChecklistItem[];
}

/** The part of the safety record this role reads: who a hazard goes to. */
export interface SafetyPolicy {
  readonly officerId: string;
}

/** Everything the company records that this role reads. */
export type CompanyFacts = Pick<
  CompanyRecord,
  "hours" | "people" | "tone" | "escalation" | "glossary"
> & {
  readonly profile: Profile;
  readonly policies?: Policies;
  readonly staffPolicies?: Pick<CompanyStaffPolicies, "disciplineTo">;
  readonly quality?: QualityPolicy;
  readonly safety?: SafetyPolicy;
};

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
// The default company has every section of role data, so what it loads is typed as complete.
export const loadCompanyFacts = (): Required<CompanyFacts> =>
  loadFacts<Required<CompanyFacts>>(COMPANY_FACTS_URL);

/** The person who owns quality: closes reports, decides on non-conforming work and the checklist. */
export const qualityOwner = (
  company: Pick<CompanyFacts, "people" | "quality">,
): Person | undefined => holder(company, "quality", company.quality?.ownerId);

/** The safety officer: a hazard found on an inspection goes to them. */
export const safetyOfficer = (
  company: Pick<CompanyFacts, "people" | "safety">,
): Person | undefined => holder(company, "safety", company.safety?.officerId);

/** Who decides a credit for a client. */
export const creditDecider = (
  company: Pick<CompanyFacts, "people" | "policies">,
): Person | undefined => holder(company, "billing", company.policies?.refunds?.creditNeeds);

/** Who decides discipline. */
export const disciplineDecider = (
  company: Pick<CompanyFacts, "people" | "staffPolicies">,
): Person | undefined => holder(company, "discipline", company.staffPolicies?.disciplineTo);

export { person };

/** "Name, Title", or the given title-free fallback when the company names nobody. */
export const personLabel = (who: Person | undefined, fallback = "a person"): string =>
  sharedPersonLabel(who, fallback);
