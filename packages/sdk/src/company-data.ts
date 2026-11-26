/**
 * Role data a company may not have.
 *
 * The default company every catalog role ships has all of it: a price book, a supply catalogue,
 * crews, a payroll policy and so on. An office's own company record holds who it is, its hours and
 * who is responsible for what, and none of these: until an office gives a role its data, a tool that
 * needs a section refuses, saying plainly what is missing, and never answers from anything else.
 *
 * `companyData(company, section)` returns the section or throws `CompanyDataMissing`. The SDK's tool
 * wrapper (`guardToolResult` in `./tool-result.ts`, applied to every role tool by `defineRole`) turns
 * that into one plain refusal, `companyDataRefusal`, so no role writes its own. Nothing here runs while a section is
 * there, so a role on the default company reads exactly what it always has.
 */

/** Each section of role data, and the words a person reads for it. */
export const COMPANY_DATA_SECTIONS = {
  priceBook: "price book",
  services: "list of services",
  quoting: "quoting rules",
  policies: "policies",
  tone: "tone of voice",
  glossary: "glossary",
  suppliers: "supplier list",
  supplyCatalog: "supply catalogue",
  crews: "crews",
  staffPolicies: "staff policies",
  payroll: "payroll policy",
  inventory: "stock locations",
  quality: "quality checklist",
  safety: "safety programme",
  it: "list of systems and access groups",
  budget: "budget",
  marketing: "approved marketing claims",
} as const;

export type CompanyDataSection = keyof typeof COMPANY_DATA_SECTIONS;

/** What a role is told when the office has not given it a section. */
export function missingCompanyDataText(section: CompanyDataSection): string {
  return (
    `This office has not given me its ${COMPANY_DATA_SECTIONS[section]}, so I cannot do this from it. ` +
    "Tell the person who asked that it is missing and that the owner can add it. Do not use a figure, " +
    "a name or a rule from anywhere else in its place."
  );
}

/** Thrown when a tool needs a section of role data the company does not have. */
export class CompanyDataMissing extends Error {
  readonly section: CompanyDataSection;
  constructor(section: CompanyDataSection) {
    super(missingCompanyDataText(section));
    this.name = "CompanyDataMissing";
    this.section = section;
  }
}

/** The section, or `CompanyDataMissing` when the company does not have it. */
export function companyData<
  Company extends { readonly [K in Section]?: unknown },
  Section extends CompanyDataSection,
>(company: Company, section: Section): NonNullable<Company[Section]> {
  const value = company[section];
  if (value === undefined || value === null) throw new CompanyDataMissing(section);
  return value as NonNullable<Company[Section]>;
}
