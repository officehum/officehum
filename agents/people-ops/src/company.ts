/**
 * The company this role works for, read from the copy generated into its own package.
 *
 * `skills/company-handbook/references/facts.json` is written by `npm run sync-company` from
 * `company/default/company.json`; the same facts reach the model as prose in the handbook skill. The
 * notice period, the crews and every person a matter goes to come from here, so there is no notice
 * constant and no name anywhere in the code: a policy changes in the company package, is synced, and
 * the desk routes by the new one.
 *
 * Only the parts of the record People Ops reads are typed here. People carry an email and a phone in
 * the record, and this role deliberately types neither: no tool can print what it cannot read.
 */

import {
  type CompanyCrew,
  type CompanyEscalationRule,
  type CompanyGlossaryEntry,
  type CompanyHours,
  type CompanyProfile,
  type CompanyRecord,
  type CompanyRecordPerson,
  type CompanyStaffPolicies,
  type CompanyTone,
  companyHead,
  escalationOwner,
  findPeople,
  loadCompanyFacts as loadFacts,
  personById as person,
  personLabel,
} from "@officehum/sdk";

/** Where the generated facts live, from either `src/company.ts` or `dist/company.js`. */
export const COMPANY_FACTS_URL = new URL(
  "../skills/company-handbook/references/facts.json",
  import.meta.url,
);

export type Profile = Pick<CompanyProfile, "legalName" | "tradingName" | "tagline" | "serviceArea">;

export type Hours = Omit<CompanyHours, "emergencyLine">;

/**
 * A colleague as this role reads them: a name, a title and what they decide. The record's email,
 * phone and department are deliberately left untyped, so no tool here can print them.
 */
export type Person = Omit<CompanyRecordPerson, "email" | "phone" | "department">;

export type Crew = Omit<CompanyCrew, "weeklyHoursCap">;

export type StaffPolicies = Omit<CompanyStaffPolicies, "overtimeNeedsApproval">;

export type Tone = CompanyTone;

export type EscalationRule = CompanyEscalationRule;

export type GlossaryEntry = CompanyGlossaryEntry;

/** Everything the company records that this role reads. */
export type CompanyFacts = Pick<CompanyRecord, "tone" | "escalation" | "glossary"> & {
  readonly profile: Profile;
  readonly hours: Hours;
  readonly people: readonly Person[];
  readonly crews: readonly Crew[];
  readonly staffPolicies: StaffPolicies;
};

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
export const loadCompanyFacts = (): CompanyFacts => loadFacts<CompanyFacts>(COMPANY_FACTS_URL);

/**
 * The person who decides hiring and ordinary time off: whoever the escalation path names for a
 * person's job, hours or leave.
 */
export function peopleOwner(
  company: Pick<CompanyFacts, "people" | "escalation">,
): Person | undefined {
  return escalationOwner(company, "hiring-and-onboarding");
}

// `companyHead` is the SDK's one rule for the person at the top of the company: a head title first,
// a bare director only when nobody holds one. A complaint about the person who would normally take
// it goes there.
export { companyHead, escalationOwner, findPeople, person, personLabel };
