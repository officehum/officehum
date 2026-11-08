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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Where the generated facts live, from either `src/company.ts` or `dist/company.js`. */
export const COMPANY_FACTS_URL = new URL(
  "../skills/company-handbook/references/facts.json",
  import.meta.url,
);

export interface Profile {
  readonly legalName: string;
  readonly tradingName: string;
  readonly tagline: string;
  readonly serviceArea: string;
}

export interface Hours {
  readonly timezone: string;
  readonly office: string;
  readonly crews: string;
  readonly closedOn: string;
  readonly note: string;
}

/** A person on the company record, without their contact details. */
export interface Person {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly decides: readonly string[];
}

/** One crew. `members` is a headcount: the crew members themselves are not on the company record. */
export interface Crew {
  readonly id: string;
  readonly name: string;
  readonly leadPersonId: string | null;
  readonly members: number;
}

export interface StaffPolicies {
  /** How many days ahead time off is asked for. */
  readonly timeOffNoticeDays: number;
  readonly payQuestionsTo: string;
  /** Discipline, and so termination. */
  readonly disciplineTo: string;
  /** Leave the law may protect, and accommodation requests: whatever the notice. */
  readonly protectedLeaveTo: string;
  /** Complaints about harassment or how someone is treated at work. */
  readonly employeeRelationsTo: string;
}

export interface Tone {
  readonly summary: string;
  readonly always: readonly string[];
  readonly never: readonly string[];
}

export interface EscalationRule {
  readonly topic: string;
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
  readonly tone: Tone;
  readonly escalation: readonly EscalationRule[];
  readonly glossary: readonly GlossaryEntry[];
  readonly crews: readonly Crew[];
  readonly staffPolicies: StaffPolicies;
}

/** The company facts generated into this package. Throws when the copy is missing or is not JSON. */
export function loadCompanyFacts(): CompanyFacts {
  const path = fileURLToPath(COMPANY_FACTS_URL);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(COMPANY_FACTS_URL, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `${path} could not be read: ${error instanceof Error ? error.message : String(error)}. ` +
        "It is generated: run `npm run sync-company` in the repository this package came from.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must hold a JSON object.`);
  }
  return parsed as CompanyFacts;
}

/** One person by id, or `undefined` when nobody here has that id. */
export function person(company: Pick<CompanyFacts, "people">, id: string): Person | undefined {
  return company.people.find((candidate) => candidate.id === id);
}

/** "Name (Title)", or the fallback when the company names nobody. */
export function personLabel(who: Person | undefined, fallback = "a person"): string {
  return who === undefined ? fallback : `${who.name} (${who.title})`;
}

/** The person whose escalation topic this is, or `undefined` when the record has no such topic. */
export function escalationOwner(
  company: Pick<CompanyFacts, "people" | "escalation">,
  topic: string,
): Person | undefined {
  const rule = company.escalation.find((candidate) => candidate.topic === topic);
  return rule === undefined ? undefined : person(company, rule.toPersonId);
}

/**
 * The person who decides hiring and ordinary time off: whoever the escalation path names for a
 * person's job, hours or leave.
 */
export function peopleOwner(
  company: Pick<CompanyFacts, "people" | "escalation">,
): Person | undefined {
  return escalationOwner(company, "hiring-and-onboarding");
}

/**
 * The person at the top of the company: whoever holds a director's or owner's title. A complaint about
 * the person who would normally take it goes here instead.
 */
export function companyHead(company: Pick<CompanyFacts, "people">): Person | undefined {
  return company.people.find((candidate) =>
    /\b(managing director|director|owner|president|chief executive)\b/i.test(candidate.title),
  );
}

/**
 * Every person the company record names, by id, full name, title, surname or first name, each matched
 * as whole words anywhere in the text, ignoring case: how a colleague refers to someone ("the people
 * ops person", a surname, a first name). A word that only contains a name does not match. Empty when
 * the words name nobody on the record, such as a crew member the record does not list. Used to keep a
 * complaint away from the people it names, so matching eagerly only ever sends it to someone else.
 */
export function findPeople(
  company: Pick<CompanyFacts, "people">,
  words: string,
): readonly Person[] {
  const wanted = words.trim().toLowerCase();
  if (wanted === "") return [];
  const has = (phrase: string): boolean => {
    const escaped = phrase
      .trim()
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return escaped !== "" && new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(wanted);
  };
  return company.people.filter((candidate) => {
    const parts = candidate.name.split(" ");
    return (
      candidate.id.toLowerCase() === wanted ||
      has(candidate.name) ||
      has(candidate.title) ||
      parts.some((part) => has(part))
    );
  });
}
