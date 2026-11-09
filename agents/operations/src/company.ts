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

import { loadCompanyFacts as loadFacts, personLabel as sharedPersonLabel } from "@officehum/sdk";

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

export interface Service {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly leadTimeDays: number;
}

/** One crew as the schedule sees it. `members` is a headcount, not a list of people. */
export interface Crew {
  readonly id: string;
  readonly name: string;
  /** The person who leads it, by `people[].id`, or `null` when a cleaner leads it. */
  readonly leadPersonId: string | null;
  readonly members: number;
  /** Crew-hours the crew may work in one week before the rest is overtime. */
  readonly weeklyHoursCap: number;
}

export interface StaffPolicies {
  readonly timeOffNoticeDays: number;
  /** Whether overtime needs a person's approval before it is worked. */
  readonly overtimeNeedsApproval: boolean;
  readonly payQuestionsTo: string;
  readonly disciplineTo: string;
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
  /** What a request is about, e.g. `start-date`. */
  readonly topic: string;
  /** The person who decides it, by `people[].id`. */
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
  readonly services: readonly Service[];
  readonly policies: Policies;
  readonly tone: Tone;
  readonly escalation: readonly EscalationRule[];
  readonly glossary: readonly GlossaryEntry[];
  readonly crews: readonly Crew[];
  readonly staffPolicies: StaffPolicies;
}

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
export const loadCompanyFacts = (): CompanyFacts => loadFacts<CompanyFacts>(COMPANY_FACTS_URL);

/** One person by id, or `undefined` when nobody here has that id. */
export function person(company: CompanyFacts, id: string): Person | undefined {
  return company.people.find((candidate) => candidate.id === id);
}

/** The escalation rule for a request, or `undefined` when the company has not named one. */
export function escalationRule(company: CompanyFacts, topic: string): EscalationRule | undefined {
  return company.escalation.find((rule) => rule.topic === topic);
}

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
