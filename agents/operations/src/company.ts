/**
 * The company this role works for, read from the copy generated into its own package.
 *
 * `skills/company-handbook/references/facts.json` is written by `npm run sync-company` from
 * `company/default/company.json`; the same facts reach the model as prose in the handbook skill. The
 * crews and their weekly hours caps come from here, so there is no hours constant anywhere in the
 * code: a cap changes in the company package, is synced, and the desk enforces the new one.
 *
 * Only the parts of the record Operations reads are typed here. A host that has its own company passes
 * `company` to the factory instead, and nothing in this file runs.
 */

import {
  type CompanyAddress,
  type CompanyCrew,
  type CompanyEscalationRule,
  type CompanyGlossaryEntry,
  type CompanyHours,
  type CompanyPolicies,
  type CompanyProfile,
  type CompanyRecord,
  type CompanyRecordPerson,
  type CompanyService,
  type CompanyStaffPolicies,
  type CompanyTone,
  escalationRule,
  loadCompanyFacts as loadFacts,
  personById as person,
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

export type Person = Pick<CompanyRecordPerson, "id" | "name" | "title" | "email" | "decides">;

export type Service = Omit<CompanyService, "priceBookIds">;

/** One crew, with the crew-hours it may work in a week before the rest is overtime. */
export type Crew = CompanyCrew;

export type StaffPolicies = Pick<
  CompanyStaffPolicies,
  "timeOffNoticeDays" | "overtimeNeedsApproval" | "payQuestionsTo" | "disciplineTo"
>;

export type Policies = Pick<CompanyPolicies, "safety" | "commitments">;

export type Tone = CompanyTone;

export type EscalationRule = CompanyEscalationRule;

export type GlossaryEntry = CompanyGlossaryEntry;

/** Everything the company records that this role reads. */
export type CompanyFacts = Pick<
  CompanyRecord,
  "hours" | "tone" | "escalation" | "glossary" | "crews"
> & {
  readonly profile: Profile;
  readonly people: readonly Person[];
  readonly services: readonly Service[];
  readonly policies: Policies;
  readonly staffPolicies: StaffPolicies;
};

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
export const loadCompanyFacts = (): CompanyFacts => loadFacts<CompanyFacts>(COMPANY_FACTS_URL);

export { escalationRule, person };

/**
 * The person who owns the schedule: whoever the escalation path names for a start date, a crew or a
 * change to the schedule. Overtime, contract moves and call-outs go to them, by name and title, and
 * the name comes from the company rather than from this package.
 */
export function scheduleOwner(company: CompanyFacts): Person | undefined {
  return person(company, escalationRule(company, "start-date")?.toPersonId ?? "");
}

/** "Name, Title", or the title-free fallback when the company names nobody. */
export const personLabel = (who: Person | undefined): string =>
  sharedPersonLabel(who, "the person who owns the schedule");
