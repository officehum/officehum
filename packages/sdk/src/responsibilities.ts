/**
 * The things a role hands to a person, as one fixed vocabulary.
 *
 * A role that names "the person who owns billing" or hands a pay run to whoever signs them off is
 * asking who holds a responsibility. The list is code, not data: it is exactly what the catalog roles
 * look people up for, so a company record, a role's manifest (`company.responsibilities`) and the
 * office's checks all speak the same ids.
 *
 * `responsible(company, id)` answers the question for either kind of company:
 *
 * - **An office's own record** carries a `responsibilities` map, from id to person id. The map is the
 *   whole answer: a responsibility it leaves out has nobody, whatever anyone's title says.
 * - **A record without one** (the default company every catalog role ships, and any record written
 *   the same way) is read from the fields the roles have always read: an escalation topic, an
 *   approver id, a department, and for `head` and `billing` the person's title.
 */

/** A title that heads the company: managing director, owner, president or chief executive. */
export const HEAD_TITLE = /^\s*(managing director|owner|president|chief executive)\b/i;
/** A director's title, which heads the company only when nobody holds a head title. */
const DIRECTOR_TITLE = /\bdirector\b/i;
/** A title that owns billing: one with "finance" in it, as a small company titles the job. */
const FINANCE_TITLE = /finance/i;

/** Each responsibility, and the plain words a role and a person read for it. */
export const RESPONSIBILITIES = [
  { id: "head", words: "running the business" },
  { id: "contract-terms", words: "contract terms" },
  { id: "money-back", words: "refunds" },
  { id: "discounts", words: "discounts and quotes above the limit" },
  { id: "complaints", words: "complaints about the service" },
  { id: "billing", words: "billing" },
  { id: "pay-runs", words: "pay runs" },
  { id: "pay-questions", words: "questions about pay and benefits" },
  { id: "scheduling", words: "start dates and the schedule" },
  { id: "safety", words: "safety" },
  { id: "quality", words: "quality" },
  { id: "purchasing", words: "purchasing" },
  { id: "stock-write-offs", words: "stock write-offs" },
  { id: "hiring", words: "hiring and onboarding" },
  { id: "people-matters", words: "protected leave and employee relations" },
  { id: "discipline", words: "conduct and discipline" },
  { id: "it-access", words: "system access" },
  { id: "data-and-security", words: "data and security" },
  { id: "marketing", words: "what marketing publishes" },
  { id: "budget", words: "the budget" },
] as const;

export type Responsibility = (typeof RESPONSIBILITIES)[number]["id"];

export const RESPONSIBILITY_IDS: readonly Responsibility[] = RESPONSIBILITIES.map(
  (entry) => entry.id,
);

/** The plain words for a responsibility: "the person who owns <words>". */
export function responsibilityWords(id: Responsibility): string {
  return RESPONSIBILITIES.find((entry) => entry.id === id)?.words ?? id;
}

/** The least of a person `responsible` reads. */
export interface ResponsiblePerson {
  readonly id: string;
  readonly title: string;
  readonly department?: string;
}

/**
 * What `responsible` reads from a company. Every section is optional: a record that lacks one has
 * nobody for the responsibilities read from it.
 */
export interface ResponsibilitySource<P extends ResponsiblePerson> {
  readonly people: readonly P[];
  /** An office's own record: responsibility id to person id. When present it is the only source. */
  readonly responsibilities?: Readonly<Partial<Record<Responsibility, string>>>;
  readonly escalation?: readonly { readonly topic: string; readonly toPersonId: string }[];
  readonly staffPolicies?: {
    readonly payQuestionsTo?: string;
    readonly disciplineTo?: string;
    readonly protectedLeaveTo?: string;
    readonly employeeRelationsTo?: string;
  };
  readonly payroll?: { readonly approverId?: string };
  readonly inventory?: { readonly writeOffApproverId?: string };
  readonly quality?: { readonly ownerId?: string };
  readonly safety?: { readonly officerId?: string };
  readonly it?: { readonly approverId?: string };
  readonly marketing?: { readonly approverId?: string };
  readonly budget?: { readonly approverId?: string };
  readonly policies?: {
    readonly discounts?: { readonly approver?: string };
    readonly refunds?: { readonly refundNeeds?: string; readonly complaintOwner?: string };
  };
}

/**
 * Who a role hands a responsibility to, when it has always read that person from a field of its own
 * data (`recorded`, such as the budget's approver id). On an office's own record, which carries a
 * responsibilities map and no role data, the person who holds it there. On a record without a map
 * (the default company), exactly the person `recorded` names, so nothing a role says changes.
 */
export function holder<P extends ResponsiblePerson>(
  company: Pick<ResponsibilitySource<P>, "people" | "responsibilities">,
  id: Responsibility,
  recorded: string | undefined,
): P | undefined {
  if (company.responsibilities !== undefined) {
    return responsible({ people: company.people, responsibilities: company.responsibilities }, id);
  }
  return recorded === undefined
    ? undefined
    : company.people.find((person) => person.id === recorded);
}

/**
 * The person who holds a responsibility, or `undefined` when nobody does: the map says nobody, the
 * record has no such field, or it names someone who is not on it.
 */
export function responsible<P extends ResponsiblePerson>(
  company: ResponsibilitySource<P>,
  id: Responsibility,
): P | undefined {
  const byId = (personId: string | undefined): P | undefined =>
    personId === undefined ? undefined : company.people.find((person) => person.id === personId);
  if (company.responsibilities !== undefined) return byId(company.responsibilities[id]);
  const topic = (name: string): string | undefined =>
    company.escalation?.find((rule) => rule.topic === name)?.toPersonId;
  const titled = (pattern: RegExp): P | undefined =>
    company.people.find((person) => pattern.test(person.title));
  switch (id) {
    case "head":
      return titled(HEAD_TITLE) ?? titled(DIRECTOR_TITLE);
    case "billing":
      return titled(FINANCE_TITLE);
    case "purchasing":
      return company.people.find((person) => person.department === "purchasing");
    case "contract-terms":
      return byId(topic("contract-terms"));
    case "money-back":
      return byId(topic("money-back") ?? company.policies?.refunds?.refundNeeds);
    case "discounts":
      return byId(company.policies?.discounts?.approver ?? topic("discount-request"));
    case "complaints":
      return byId(topic("complaint-about-a-visit") ?? company.policies?.refunds?.complaintOwner);
    case "pay-runs":
      return byId(company.payroll?.approverId);
    case "pay-questions":
      return byId(company.staffPolicies?.payQuestionsTo);
    case "scheduling":
      return byId(topic("start-date"));
    case "safety":
      return byId(company.safety?.officerId ?? topic("safety-incident"));
    case "quality":
      return byId(company.quality?.ownerId);
    case "stock-write-offs":
      return byId(company.inventory?.writeOffApproverId);
    case "hiring":
      return byId(topic("hiring-and-onboarding"));
    case "people-matters":
      return byId(
        company.staffPolicies?.protectedLeaveTo ?? company.staffPolicies?.employeeRelationsTo,
      );
    case "discipline":
      return byId(company.staffPolicies?.disciplineTo);
    case "it-access":
      return byId(company.it?.approverId);
    case "data-and-security":
      return byId(topic("data-and-security"));
    case "marketing":
      return byId(company.marketing?.approverId);
    case "budget":
      return byId(company.budget?.approverId);
  }
}
