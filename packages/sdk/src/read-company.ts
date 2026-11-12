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

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { personById } from "./company.js";
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
    parameters: Type.Object(
      {
        section: Type.Union(
          names.map((name) => Type.Literal(name)),
          { description: "Which part of the record to read" },
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const section = args.section as Section;
      return { ...textResult(options.sections[section](options.company)), details: { section } };
    },
  });
}

const bullets = (rules: readonly string[]): string[] => rules.map((rule) => `- ${rule}`);

/** Who the company is, where it is, how to reach it and whom it serves. */
export function companyProfileText(company: {
  readonly profile: Pick<
    CompanyProfile,
    "legalName" | "tradingName" | "tagline" | "phone" | "email" | "serviceArea" | "clients"
  > & { readonly address: Omit<CompanyAddress, "country"> };
}): string {
  const { profile } = company;
  return [
    `${profile.legalName} — trading as ${profile.tradingName}. ${profile.tagline}`,
    `${profile.address.street}, ${profile.address.city}, ${profile.address.region} ${profile.address.postalCode}. Phone ${profile.phone}. Email ${profile.email}.`,
    `Service area: ${profile.serviceArea}`,
    `Clients: ${profile.clients}`,
  ].join("\n");
}

/** The office's hours and time zone, the crews' hours, the emergency line, closures and the note. */
export function companyHoursText(company: { readonly hours: CompanyHours }): string {
  const { hours } = company;
  return [
    `Office: ${hours.office} (${hours.timezone}).`,
    `Crews: ${hours.crews}.`,
    `Emergency line: ${hours.emergencyLine}.`,
    `Closed: ${hours.closedOn}.`,
    hours.note,
  ].join("\n");
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
    .map(
      (worker) =>
        `${worker.name} — ${worker.title}${contact === "email" ? ` — ${worker.email}` : ""} — decides: ${worker.decides.join("; ")}`,
    )
    .join("\n");
}

/** The safety rules and what is never promised. */
export function companyPoliciesText(company: {
  readonly policies: Pick<CompanyPolicies, "safety" | "commitments">;
}): string {
  return [
    "Safety:",
    ...bullets(company.policies.safety),
    "Never promised:",
    ...bullets(company.policies.commitments),
  ].join("\n");
}

/** The tone of voice: the summary, then what to always and never do. */
export function companyToneText(company: { readonly tone: CompanyTone }): string {
  return [
    company.tone.summary,
    "Always:",
    ...bullets(company.tone.always),
    "Never:",
    ...bullets(company.tone.never),
  ].join("\n");
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
  readonly glossary: readonly CompanyGlossaryEntry[];
}): string {
  return company.glossary.map((entry) => `${entry.term}: ${entry.meaning}`).join("\n");
}
