/**
 * The company this role works for, read from the copy generated into its own package.
 *
 * `skills/company-handbook/references/facts.json` is written by `npm run sync-company` from
 * `company/default/company.json`; the same facts reach the model as prose in the handbook skill. Who
 * decides IT, the systems and their owners, and which access groups carry administrator rights all
 * come from here, so there is no person's name and no group anywhere in the code.
 *
 * Only the parts of the record the IT Help Desk reads are typed here. A host that has its own company
 * passes `company` to the factory instead, and nothing in this file runs.
 */

import {
  type CompanyEscalationRule,
  type CompanyGlossaryEntry,
  type CompanyHours,
  type CompanyProfile,
  type CompanyRecord,
  type CompanyRecordPerson,
  type CompanyTone,
  holder,
  loadCompanyFacts as loadFacts,
  personById as person,
  purchasingLead,
  personLabel as sharedPersonLabel,
} from "@officehum/sdk";

/** Where the generated facts live, from either `src/company.ts` or `dist/company.js`. */
export const COMPANY_FACTS_URL = new URL(
  "../skills/company-handbook/references/facts.json",
  import.meta.url,
);

export type Profile = Pick<CompanyProfile, "legalName" | "tradingName" | "tagline">;
export type Hours = CompanyHours;
/** A person on the record. Their email is the address on file a reset link goes to; it is never printed. */
export type Person = CompanyRecordPerson;
export type Tone = CompanyTone;
export type EscalationRule = CompanyEscalationRule;
export type GlossaryEntry = CompanyGlossaryEntry;

/** One system the company runs, and the person who owns it and assigns access to it. */
export interface ItSystem {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
}

/**
 * One access group: access is granted to a group, never to a person directly. `privileged` marks a
 * group that carries administrator rights, which the help desk never grants and never resets.
 */
export interface AccessGroup {
  readonly id: string;
  readonly name: string;
  readonly systemId: string;
  readonly privileged: boolean;
}

/** Who decides IT, the systems and the access groups. */
export interface ItPolicy {
  readonly approverId: string;
  readonly systems: readonly ItSystem[];
  readonly accessGroups: readonly AccessGroup[];
}

/** Everything the company records that this role reads. */
export type CompanyFacts = Pick<
  CompanyRecord,
  "hours" | "people" | "tone" | "escalation" | "glossary"
> & {
  readonly profile: Profile;
  readonly it?: ItPolicy;
};

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
// The default company has every section of role data, so what it loads is typed as complete.
export const loadCompanyFacts = (): Required<CompanyFacts> =>
  loadFacts<Required<CompanyFacts>>(COMPANY_FACTS_URL);

/** The person who decides IT: access, administrator rights, leavers' data and security matters. */
export const itApprover = (company: Pick<CompanyFacts, "people" | "it">): Person | undefined =>
  holder(company, "it-access", company.it?.approverId);

/** The person who owns a system, or `undefined` for a system the record does not hold. */
export const systemOwner = (
  company: Pick<CompanyFacts, "people" | "it">,
  systemId: string,
): Person | undefined => {
  const system = company.it?.systems.find((entry) => entry.id === systemId);
  return system === undefined ? undefined : person(company, system.ownerId);
};

/** Who decides purchases of equipment: whoever the record puts in purchasing. */
export const purchasingDecider = (company: Pick<CompanyFacts, "people">): Person | undefined =>
  purchasingLead(company);

export { person };

/** "Name, Title", or the given title-free fallback when the company names nobody. */
export const personLabel = (who: Person | undefined, fallback = "a person"): string =>
  sharedPersonLabel(who, fallback);
