/**
 * `read_company`: the tool a role reads its company record with, one section at a time, and the
 * texts of the sections that read the same in every role.
 *
 * A role lists the sections it answers for and how each reads. The shared texts below cover the
 * record's common parts; a section only one role has (Purchasing's suppliers, Marketing's approved
 * claims) is that role's own function, and a role that must say less than a shared text does passes
 * its own for that section too.
 *
 * ```ts
 * const readCompany = readCompanyTool({
 *   company,
 *   description: "Read one section of the company record: …",
 *   sections: {
 *     profile: companyProfileText,
 *     hours: companyHoursText,
 *     people: (record) => companyPeopleText(record, "email"),
 *     crews: crewsText, // the role's own
 *     tone: companyToneText,
 *   },
 * });
 * ```
 */

import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { lit, obj, union } from "@earendil-works/pi-schema";
import { personById } from "./company.js";
import { companyData } from "./company-data.js";
import type {
  CompanyAddress,
  CompanyEscalationRule,
  CompanyGlossaryEntry,
  CompanyHours,
  CompanyPolicies,
  CompanyProfile,
  CompanyRecordPerson,
  CompanyTone,
} from "./company-record.js";
import { textResult } from "./tool-result.js";

export interface ReadCompanyOptions<Company, Section extends string> {
  /** The record the tool reads: the role's own facts, or the host's company. */
  readonly company: Company;
  /** What the model reads about the tool; it names the sections this role answers for. */
  readonly description: string;
  /** Each section the tool answers for and how it reads, in the order the model is offered them. */
  readonly sections: Readonly<Record<Section, (company: Company) => string>>;
}

/** The safe `read_company` tool: one section of the company record, as text. */
export function readCompanyTool<Company, Section extends string>(
  options: ReadCompanyOptions<Company, Section>,
): ToolRegistration {
  const names = Object.keys(options.sections) as Section[];
  return defineTool({
    name: "read_company",
    description: options.description,
    parameters: obj({
      section: union(
        names.map((name) => lit(name)),
        { description: "Which part of the record to read" },
      ),
    }),
    replay: "safe",
    execute: async (args) => {
      const section = args.section as Section;
      return { ...textResult(options.sections[section](options.company)), details: { section } };
    },
  });
}

const bullets = (rules: readonly string[]): string[] => rules.map((rule) => `- ${rule}`);

/**
 * The lines a company has: a line built from a field the company does not record is `undefined`
 * and left out. The default company records every field, so its text is every line, as it was; an
 * office's own record holds who it is and how to reach it, and none of the rest.
 */
export function presentLines(lines: readonly (string | undefined)[]): string {
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

/** "Legal name — trading as Name. Tagline", the tagline only when the company has one. */
export function companyHeadline(
  profile: Pick<CompanyProfile, "legalName" | "tradingName" | "tagline">,
): string {
  const head = `${profile.legalName} — trading as ${profile.tradingName}.`;
  return profile.tagline === undefined ? head : `${head} ${profile.tagline}`;
}

/** An address as one line: the record's own words, or "street, city, region postcode". */
export function companyAddressText(address: CompanyAddress | string, country = false): string {
  if (typeof address === "string") return address;
  const line = `${address.street}, ${address.city}, ${address.region} ${address.postalCode}`;
  return country ? `${line}, ${address.country}` : line;
}

/** "Address. Phone …. Email ….", from the parts the company has; `undefined` with none. */
export function companyContactLine(
  profile: Pick<CompanyProfile, "address" | "phone" | "email">,
): string | undefined {
  const parts = [
    profile.address === undefined ? undefined : companyAddressText(profile.address),
    profile.phone === undefined ? undefined : `Phone ${profile.phone}`,
    profile.email === undefined ? undefined : `Email ${profile.email}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : `${parts.join(". ")}.`;
}

/** "Closed: …." when the company records its closures. */
export function companyClosedLine(hours: Pick<CompanyHours, "closedOn">): string | undefined {
  return hours.closedOn === undefined ? undefined : `Closed: ${hours.closedOn}.`;
}

/** Who the company is, where it is, how to reach it and whom it serves. */
export function companyProfileText(company: {
  readonly profile: Pick<
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
}): string {
  const { profile } = company;
  return presentLines([
    companyHeadline(profile),
    companyContactLine(profile),
    profile.serviceArea === undefined ? undefined : `Service area: ${profile.serviceArea}`,
    profile.clients === undefined ? undefined : `Clients: ${profile.clients}`,
  ]);
}

/** The office's hours and time zone, the crews' hours, the emergency line, closures and the note. */
export function companyHoursText(company: { readonly hours: CompanyHours }): string {
  const { hours } = company;
  return presentLines([
    `Office: ${hours.office} (${hours.timezone}).`,
    hours.crews === undefined ? undefined : `Crews: ${hours.crews}.`,
    hours.emergencyLine === undefined ? undefined : `Emergency line: ${hours.emergencyLine}.`,
    companyClosedLine(hours),
    hours.note,
  ]);
}

/**
 * The people and what each decides: who to hand something to. `contact` says whether a line carries
 * the person's email. It is always stated, never inferred from the record, because a role that must
 * not show contact details still reads a record that holds them.
 */
export function companyPeopleText(
  company: {
    readonly people: readonly Pick<CompanyRecordPerson, "name" | "title" | "decides">[];
  },
  contact: "none",
): string;
export function companyPeopleText(
  company: {
    readonly people: readonly Pick<CompanyRecordPerson, "name" | "title" | "decides" | "email">[];
  },
  contact: "email",
): string;
export function companyPeopleText(
  company: {
    readonly people: readonly (Pick<CompanyRecordPerson, "name" | "title" | "decides"> & {
      readonly email?: string;
    })[];
  },
  contact: "email" | "none",
): string {
  return company.people
    .map((worker) =>
      [
        worker.name,
        worker.title.trim() === "" ? undefined : worker.title,
        contact === "email" ? worker.email : undefined,
        worker.decides.length === 0 ? undefined : `decides: ${worker.decides.join("; ")}`,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" — "),
    )
    .join("\n");
}

/** The safety rules and what is never promised. */
export function companyPoliciesText(company: {
  readonly policies?: Pick<CompanyPolicies, "safety" | "commitments">;
}): string {
  const policies = companyData(company, "policies");
  return [
    "Safety:",
    ...bullets(policies.safety),
    "Never promised:",
    ...bullets(policies.commitments),
  ].join("\n");
}

/** The tone of voice: the summary, then what to always and never do. */
export function companyToneText(company: { readonly tone?: CompanyTone }): string {
  const tone = companyData(company, "tone");
  return [tone.summary, "Always:", ...bullets(tone.always), "Never:", ...bullets(tone.never)].join(
    "\n",
  );
}

/**
 * The escalation path: each topic, who decides it by name and title, and when. A rule that names
 * someone the record does not hold keeps the id, so the gap is visible instead of a made-up person.
 */
export function companyEscalationText(company: {
  readonly people: readonly Pick<CompanyRecordPerson, "id" | "name" | "title">[];
  readonly escalation: readonly CompanyEscalationRule[];
}): string {
  return company.escalation
    .map((rule) => {
      const owner = personById(company, rule.toPersonId);
      return `${rule.topic} — ${owner === undefined ? rule.toPersonId : `${owner.name}, ${owner.title}`} — ${rule.when}`;
    })
    .join("\n");
}

/** The company's own words and what each means. */
export function companyGlossaryText(company: {
  readonly glossary?: readonly CompanyGlossaryEntry[];
}): string {
  return companyData(company, "glossary")
    .map((entry) => `${entry.term}: ${entry.meaning}`)
    .join("\n");
}
