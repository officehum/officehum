/**
 * The company this role works for, read from the copy generated into its own package.
 *
 * `skills/company-handbook/references/facts.json` is written by `npm run sync-company` from
 * `company/default/company.json`; the same facts reach the model as prose in the handbook skill. The
 * pay schedule, the overtime threshold, the enrolment window, the benefit plans and every person a
 * matter goes to come from here, so there is no schedule constant and no name anywhere in the code: a
 * policy changes in the company package, is synced, and the desk works by the new one.
 *
 * Only the parts of the record Payroll reads are typed here. People carry an email and a phone in
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
  escalationOwner,
  holder,
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

export type StaffPolicies = Pick<CompanyStaffPolicies, "overtimeNeedsApproval" | "payQuestionsTo">;

export type Tone = CompanyTone;

export type EscalationRule = CompanyEscalationRule;

export type GlossaryEntry = CompanyGlossaryEntry;

/** A benefit plan the company offers. */
export interface BenefitPlanFact {
  readonly id: string;
  readonly name: string;
  /** `medical`, `dental`, `vision` or `retirement`. */
  readonly kind: string;
}

/** The company's payroll policy: how often it pays, when overtime starts, who approves. */
export interface PayrollPolicy {
  readonly frequency: "biweekly";
  /** The first day of one pay period, `YYYY-MM-DD`; every period and workweek is counted from it. */
  readonly periodStartsOn: string;
  /** Days from the last day of a period to its pay day. */
  readonly payDayOffsetDays: number;
  /** Hours in one workweek after which the rest is overtime. */
  readonly overtimeAfterWeeklyHours: number;
  /** Who approves every pay run, an enrolment exception and a correction to pay. */
  readonly approverId: string;
  /** Open enrolment, as month and day (`MM-DD`), every year. */
  readonly enrollmentWindow: { readonly opens: string; readonly closes: string };
  readonly benefitPlans: readonly BenefitPlanFact[];
}

/** Everything the company records that this role reads. */
export type CompanyFacts = Pick<CompanyRecord, "tone" | "escalation" | "glossary"> & {
  readonly profile: Profile;
  readonly hours: Hours;
  readonly people: readonly Person[];
  readonly crews?: readonly Crew[];
  readonly staffPolicies?: StaffPolicies;
  readonly payroll?: PayrollPolicy;
};

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
// The default company has every section of role data, so what it loads is typed as complete.
export const loadCompanyFacts = (): Required<CompanyFacts> =>
  loadFacts<Required<CompanyFacts>>(COMPANY_FACTS_URL);

/** The person who approves every pay run, an enrolment exception and a correction to pay. */
export function payrollApprover(
  company: Pick<CompanyFacts, "people" | "payroll">,
): Person | undefined {
  return holder(company, "pay-runs", company.payroll?.approverId);
}

/** The person who answers questions about a person's pay and decides a change to a pay rate. */
export function payOwner(
  company: Pick<CompanyFacts, "people" | "staffPolicies">,
): Person | undefined {
  return holder(company, "pay-questions", company.staffPolicies?.payQuestionsTo);
}

/**
 * The person who approves a crew's timesheets and authorises its overtime: the crew's own lead when it
 * has one, otherwise whoever the escalation path names for a crew's schedule.
 */
export function timesheetApprover(
  company: Pick<CompanyFacts, "people" | "crews" | "escalation">,
  crewId: string | null,
): Person | undefined {
  const crew = company.crews?.find((candidate) => candidate.id === crewId);
  const lead =
    crew?.leadPersonId === null || crew === undefined
      ? undefined
      : person(company, crew.leadPersonId);
  return lead ?? escalationOwner(company, "start-date");
}

export { escalationOwner, person, personLabel };
