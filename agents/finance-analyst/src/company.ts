/**
 * The company this role analyses, read from the copy generated into its own package.
 *
 * `skills/company-handbook/references/facts.json` is written by `npm run sync-company` from
 * `company/default/company.json`; the same facts reach the model as prose in the handbook skill. The
 * budget (its fiscal year, its lines in integer cents and who approves it), the people a report may
 * be released to, and who keeps the books all come from here, so no budget figure and no person's
 * name is written into the code. The variance explanation limit is not company data: it is the
 * role's own manifest limit.
 *
 * Only the parts of the record this role reads are typed here. A host that has its own company passes
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
export type Policies = Pick<CompanyPolicies, "safety" | "commitments">;
export type Tone = CompanyTone;
export type EscalationRule = CompanyEscalationRule;
export type GlossaryEntry = CompanyGlossaryEntry;

/**
 * `revenue`: more than budgeted is favourable. `cost`: less than budgeted is favourable. The desk
 * decides favourable or unfavourable from this alone, never from the size of the number.
 */
export type LineKind = "revenue" | "cost";

/** One line of the budget: one monthly figure, in integer cents, for one kind of revenue or cost. */
export interface BudgetLine {
  readonly id: string;
  readonly name: string;
  readonly kind: LineKind;
  readonly monthlyCents: number;
}

/** The original budget, as the company approved it, and who approves it and every revision. */
export interface BudgetSettings {
  readonly fiscalYear: number;
  readonly approverId: string;
  readonly lines: readonly BudgetLine[];
}

/** Everything the company records that this role reads. */
export type CompanyFacts = Pick<
  CompanyRecord,
  "hours" | "people" | "tone" | "escalation" | "glossary" | "ticketRoutes"
> & {
  readonly profile: Profile;
  readonly policies?: Policies;
  readonly budget?: BudgetSettings;
};

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
// The default company has every section of role data, so what it loads is typed as complete.
export const loadCompanyFacts = (): Required<CompanyFacts> =>
  loadFacts<Required<CompanyFacts>>(COMPANY_FACTS_URL);

/** Who approves the budget, every revision to it, and the release of a financial report. */
export const budgetApprover = (
  company: Pick<CompanyFacts, "people" | "budget">,
): Person | undefined => holder(company, "budget", company.budget?.approverId);

/**
 * Who keeps the books: the person the company routes a management report to, the owner of the ledger
 * this role only reads. A ledger entry that looks wrong goes to them.
 */
export const booksKeeper = (
  company: Pick<CompanyFacts, "people" | "ticketRoutes">,
): Person | undefined => {
  const route = company.ticketRoutes.find((entry) => entry.type === "finance.report");
  return route === undefined ? undefined : person(company, route.toPersonId);
};

/**
 * The company person a recipient names: their id, full name or email, ignoring case and spacing.
 * Deliberately strict, so "the bank" or a first name shared with an outsider never matches anyone.
 */
export function personByRecipient(
  company: Pick<CompanyFacts, "people">,
  recipient: string,
): Person | undefined {
  const wanted = recipient.trim().replace(/\s+/g, " ").toLowerCase();
  if (wanted === "") return undefined;
  return company.people.find(
    (candidate) =>
      candidate.id.toLowerCase() === wanted ||
      candidate.name.toLowerCase() === wanted ||
      candidate.email?.toLowerCase() === wanted,
  );
}

export { money, person };

/** "Name, Title", or the given title-free fallback when the company names nobody. */
export const personLabel = (who: Person | undefined, fallback = "a person"): string =>
  sharedPersonLabel(who, fallback);
