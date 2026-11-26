/**
 * The company this role works for, read from the copy generated into its own package.
 *
 * `skills/company-handbook/references/facts.json` is written by `npm run sync-company` from
 * `company/default/company.json`; the same facts reach the model as prose in the handbook skill. The
 * required training and each course's renewal period, the serious incident types, the safety officer,
 * the crews and the supply catalog all come from here, so there is no course, no renewal period and no
 * person's name anywhere in the code. The reporting deadlines are not company data: they are the
 * role's own manifest limits, so another jurisdiction changes them in an overlay.
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
export type Policies = Pick<CompanyPolicies, "safety" | "commitments">;
export type Tone = CompanyTone;
export type EscalationRule = CompanyEscalationRule;
export type GlossaryEntry = CompanyGlossaryEntry;
export type Crew = Pick<CompanyCrew, "id" | "name">;
export type SupplyItem = Pick<CompanySupplyItem, "id" | "name" | "unit">;

/**
 * One course the company requires. `renewalMonths` is how long a completion stays current;
 * `appliesTo` is `"all"` or the id of the one crew that needs it.
 */
export interface TrainingCourse {
  readonly id: string;
  readonly name: string;
  readonly renewalMonths: number;
  readonly appliesTo: string;
}

/** Who the safety officer is, the training the company requires, and the incidents it treats as serious. */
export interface SafetyPolicy {
  readonly officerId: string;
  readonly requiredTraining: readonly TrainingCourse[];
  readonly seriousIncidentTypes: readonly string[];
}

/** Everything the company records that this role reads. */
export type CompanyFacts = Pick<
  CompanyRecord,
  "hours" | "people" | "tone" | "escalation" | "glossary"
> & {
  readonly profile: Profile;
  readonly policies?: Policies;
  readonly crews?: readonly Crew[];
  readonly supplyCatalog?: readonly SupplyItem[];
  readonly safety?: SafetyPolicy;
};

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
// The default company has every section of role data, so what it loads is typed as complete.
export const loadCompanyFacts = (): Required<CompanyFacts> =>
  loadFacts<Required<CompanyFacts>>(COMPANY_FACTS_URL);

/**
 * The safety officer: incidents, training exceptions, recordability and regulator reports are theirs
 * to decide.
 */
export const safetyOfficer = (
  company: Pick<CompanyFacts, "people" | "safety">,
): Person | undefined => holder(company, "safety", company.safety?.officerId);

export { person };

/** "Name, Title", or the given title-free fallback when the company names nobody. */
export const personLabel = (who: Person | undefined, fallback = "a person"): string =>
  sharedPersonLabel(who, fallback);
