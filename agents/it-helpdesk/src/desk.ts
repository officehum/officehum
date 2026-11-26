/**
 * The desk: the help desk system, directory and asset register this role reads and writes.
 *
 * A host binds its own (help desk software, its directory, an asset register) and the role never
 * knows the difference. `fakeItDesk` is what ships with the package: the company's people as
 * accounts with demonstration group memberships, three open tickets and an asset register, in
 * memory, so a test, an eval or a first run needs no network and no credential.
 *
 * Identity is the desk's, never the model's. Every staff call carries the host's verified sender, and
 * the desk answers only a colleague on the company record writing from inside the office. An account
 * tool (`myAccess`, `passwordReset`, the sign-in change) acts only on the sender's own account and
 * refuses any other person named. The desk also holds the rules a person relies on: the priority
 * comes from the category and impact, a group with administrator rights is never put to a person, a
 * privileged account is never reset here, an assigned asset is not assigned twice, and every gated
 * write compares the facts a person approved with the record as it stands. A refusal carries a code,
 * and the tools turn the code into the next step.
 *
 * Nothing secret is ever returned: a reset goes to the address on file, which no receipt carries,
 * and no method returns a password, a link or a one-time code.
 */

import {
  colleague,
  companyData,
  localDate,
  parseDate,
  sameFacts,
  type VerifiedSender,
} from "@officehum/sdk";
import {
  type AccessGroup,
  type CompanyFacts,
  itApprover,
  loadCompanyFacts,
  type Person,
  personLabel,
  systemOwner,
} from "./company.js";

/** What a ticket is about. */
export type Category =
  | "hardware"
  | "software"
  | "account"
  | "email"
  | "network"
  | "printing"
  | "phone"
  | "security"
  | "other";
export const CATEGORIES: readonly Category[] = [
  "hardware",
  "software",
  "account",
  "email",
  "network",
  "printing",
  "phone",
  "security",
  "other",
];

/** How many people it stops, and whether they can still work. */
export type Impact = "one_person_can_work" | "one_person_blocked" | "several_people" | "everyone";
export const IMPACTS: readonly Impact[] = [
  "one_person_can_work",
  "one_person_blocked",
  "several_people",
  "everyone",
];

export type Priority = "urgent" | "high" | "medium" | "low";

export type TicketStatus = "open" | "escalated" | "awaiting_confirmation" | "closed";
export const TICKET_STATUSES: readonly TicketStatus[] = [
  "open",
  "escalated",
  "awaiting_confirmation",
  "closed",
];

/** A person as a receipt names them: name and title, never a contact. */
export interface NamedPerson {
  readonly name: string;
  readonly title: string;
}

export interface Resolution {
  readonly outcome: string;
  readonly reporterConfirmed: boolean;
  readonly on: string;
}

export interface Ticket {
  readonly id: string;
  readonly reporterId: string;
  readonly reporterName: string;
  readonly category: Category;
  readonly impact: Impact;
  readonly priority: Priority;
  readonly description: string;
  readonly status: TicketStatus;
  readonly openedOn: string;
  readonly escalatedTo: NamedPerson | null;
  readonly escalationNotes: string | null;
  readonly resolution: Resolution | null;
}

/** One group an account holds, with its system. */
export interface GroupView {
  readonly id: string;
  readonly name: string;
  readonly systemId: string;
  readonly systemName: string;
  readonly privileged: boolean;
}

export type AccountStatus = "active" | "disabled";

export interface Account {
  readonly personId: string;
  readonly name: string;
  readonly title: string;
  readonly status: AccountStatus;
  readonly mfaEnrolled: boolean;
  readonly groups: readonly GroupView[];
  /** A joiner's first day; `null` for an account that was already running. */
  readonly startDate: string | null;
}

export interface ResetReceipt {
  readonly id: string;
  readonly name: string;
  readonly systemId: string;
  readonly systemName: string;
  /** Who was told a reset was asked for: the account holder. */
  readonly noticeTo: string;
  readonly on: string;
}

export interface SignInChange {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
  readonly on: string;
}

export interface AccessGrant {
  readonly id: string;
  readonly name: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly systemName: string;
  readonly on: string;
}

export interface Disabled {
  readonly account: Account;
  /** The equipment the register shows with the leaver, to collect. */
  readonly assetsToCollect: readonly Asset[];
}

export type AssetStatus = "assigned" | "in_stock" | "retired";
export const ASSET_STATUSES: readonly AssetStatus[] = ["assigned", "in_stock", "retired"];

export interface Asset {
  readonly tag: string;
  readonly kind: string;
  readonly description: string;
  readonly status: AssetStatus;
  readonly assignedToId: string | null;
  readonly assignedToName: string | null;
  readonly since: string | null;
  readonly note: string | null;
}

export type ConcernKind =
  | "phishing"
  | "password_shared"
  | "lost_device"
  | "suspicious_sign_in"
  | "security_control_request"
  | "other";
export const CONCERN_KINDS: readonly ConcernKind[] = [
  "phishing",
  "password_shared",
  "lost_device",
  "suspicious_sign_in",
  "security_control_request",
  "other",
];

export interface SecurityReport {
  readonly id: string;
  readonly kind: ConcernKind;
  readonly description: string;
  readonly reportedBy: string;
  readonly handedTo: NamedPerson;
  readonly on: string;
}

/** Who is asking, as the host verified it. `undefined` when nobody is known. */
interface From {
  readonly from: VerifiedSender | undefined;
}
interface Write {
  readonly requestId: string;
}
interface Approved {
  readonly approved: Readonly<Record<string, unknown>>;
}

export interface SignInChangeInput extends From {
  readonly person?: string;
  readonly reason: string;
}
export interface AccessInput extends From {
  readonly person: string;
  readonly groupId: string;
  readonly reason: string;
}
export interface SetupInput extends From {
  readonly name: string;
  readonly job: string;
  readonly startDate: string;
}
export interface DisableInput extends From {
  readonly person: string;
  readonly reason: string;
}

/** The help desk system a host binds. Every write carries a request id, so a replay writes nothing. */
export interface ItDesk {
  listTickets(
    input: From & { readonly ticketId?: string; readonly status?: TicketStatus },
  ): Promise<readonly Ticket[]>;
  logTicket(
    input: From & {
      readonly category: Category;
      readonly impact: Impact;
      readonly description: string;
    },
    options: Write,
  ): Promise<Ticket>;
  escalateTicket(
    input: From & { readonly ticketId: string; readonly systemId?: string; readonly notes: string },
    options: Write,
  ): Promise<Ticket>;
  resolveTicket(
    input: From & {
      readonly ticketId: string;
      readonly outcome: string;
      readonly reporterConfirmed: boolean;
    },
    options: Write,
  ): Promise<Ticket>;
  /** The sender's own account; `person`, when given, must be the sender. */
  myAccess(input: From & { readonly person?: string }): Promise<Account>;
  /** Sends a reset link to the address on file for the sender's own account, and a notice to them. */
  passwordReset(
    input: From & { readonly person?: string; readonly systemId: string },
    options: Write,
  ): Promise<ResetReceipt>;
  /** Every reset sent, for the host's audit and the tests. */
  resetsSent(): Promise<readonly ResetReceipt[]>;
  signInChangeFacts(input: SignInChangeInput): Promise<Record<string, unknown>>;
  changeSignInMethod(input: SignInChangeInput & Approved, options: Write): Promise<SignInChange>;
  accessFacts(input: AccessInput): Promise<Record<string, unknown>>;
  grantAccess(input: AccessInput & Approved, options: Write): Promise<AccessGrant>;
  setupFacts(input: SetupInput): Promise<Record<string, unknown>>;
  setupAccount(input: SetupInput & Approved, options: Write): Promise<Account>;
  disableFacts(input: DisableInput): Promise<Record<string, unknown>>;
  disableAccount(input: DisableInput & Approved, options: Write): Promise<Disabled>;
  listAssets(
    input: From & {
      readonly person?: string;
      readonly tag?: string;
      readonly status?: AssetStatus;
    },
  ): Promise<readonly Asset[]>;
  assignAsset(
    input: From & { readonly tag: string; readonly person: string },
    options: Write,
  ): Promise<Asset>;
  returnAsset(
    input: From & { readonly tag: string; readonly condition: string },
    options: Write,
  ): Promise<Asset>;
  /** Anyone may report a concern; an unverified sender is recorded as such. */
  reportSecurityConcern(
    input: From & { readonly kind: ConcernKind; readonly description: string },
    options: Write,
  ): Promise<SecurityReport>;
}

/** Why the desk refused, so a tool can say what to do next without parsing the message. */
export type DeskRefusal =
  | "unknown_sender"
  | "not_staff"
  | "someone_else"
  | "not_found"
  | "ambiguous"
  | "invalid"
  | "privileged"
  | "no_access"
  | "disabled"
  | "already_member"
  | "already_disabled"
  | "exists"
  | "changed"
  | "closed"
  | "assigned"
  | "retired"
  | "not_assigned";

export class ItDeskError extends Error {
  readonly code: DeskRefusal;

  constructor(code: DeskRefusal, message: string) {
    super(message);
    this.name = "ItDeskError";
    this.code = code;
  }
}

/** Monday 9 November 2026, at the start of the office day on the US west coast. */
export const DEMO_NOW = "2026-11-09T16:00:00.000Z";

const BASE_PRIORITY: Readonly<Record<Impact, Priority>> = {
  one_person_can_work: "low",
  one_person_blocked: "medium",
  several_people: "high",
  everyone: "urgent",
};

/**
 * The priority, from how many people a ticket stops and whether they can still work. A security
 * ticket is never below high: its consequences reach past the people it stops.
 */
export function priorityFor(category: Category, impact: Impact): Priority {
  const base = BASE_PRIORITY[impact];
  if (category === "security" && (base === "low" || base === "medium")) return "high";
  return base;
}

/** The groups every member of staff holds, and a joiner gets: email and the shared files. */
const STAFF_GROUPS = ["staff-email", "shared-files"];

/**
 * The demonstration group memberships: everyone holds the staff groups, office staff the office
 * scheduling group and field staff the field app, a system's owner every ordinary group on it, and
 * the people who run email and payroll their administrator groups. Ids the company does not hold
 * are dropped, so another company's record still builds.
 */
export function demoMemberships(
  company: Pick<CompanyFacts, "people" | "it">,
): ReadonlyMap<string, readonly string[]> {
  const groups = companyData(company, "it").accessGroups;
  const known = new Set(groups.map((group) => group.id));
  const memberships = new Map<string, readonly string[]>();
  for (const worker of company.people) {
    const held = new Set<string>(STAFF_GROUPS);
    held.add(worker.department === "office" ? "scheduling-office" : "scheduling-field");
    for (const system of companyData(company, "it").systems) {
      if (system.ownerId !== worker.id) continue;
      for (const group of groups) {
        if (group.systemId !== system.id) continue;
        // The payroll owner runs payroll, so holds its administrator group; email's is the
        // approver's alone.
        if (!group.privileged || system.id === "payroll") held.add(group.id);
      }
    }
    if (worker.id === companyData(company, "it").approverId) {
      for (const group of groups)
        if (group.privileged && group.systemId === "email") held.add(group.id);
    }
    memberships.set(
      worker.id,
      [...held].filter((id) => known.has(id)),
    );
  }
  return memberships;
}

/** The person at a position in the record, for demonstration data that names nobody in code. */
const at = (company: Pick<CompanyFacts, "people">, index: number): Person | undefined =>
  company.people[index] ?? company.people[company.people.length - 1];

/** Three tickets on the demonstration morning: two open, one waiting for its reporter. */
export function demoTickets(company: Pick<CompanyFacts, "people">): readonly Ticket[] {
  const ticket = (
    id: string,
    reporter: Person | undefined,
    category: Category,
    impact: Impact,
    description: string,
    openedOn: string,
    resolution: Resolution | null = null,
  ): Ticket => ({
    id,
    reporterId: reporter?.id ?? "",
    reporterName: reporter?.name ?? "",
    category,
    impact,
    priority: priorityFor(category, impact),
    description,
    status: resolution === null ? "open" : "awaiting_confirmation",
    openedOn,
    escalatedTo: null,
    escalationNotes: null,
    resolution,
  });
  return [
    ticket(
      "T-1001",
      at(company, 2),
      "printing",
      "several_people",
      "The office printer jams on every second page",
      "2026-11-05",
    ),
    ticket(
      "T-1002",
      at(company, 4),
      "software",
      "one_person_blocked",
      "The accounting software asks to update, then closes before it opens",
      "2026-11-06",
    ),
    ticket(
      "T-1003",
      at(company, 8),
      "email",
      "one_person_can_work",
      "Calendar invitations arrive twice",
      "2026-11-04",
      {
        outcome: "Removed a duplicate calendar subscription",
        reporterConfirmed: false,
        on: "2026-11-06",
      },
    ),
  ];
}

/** The asset register: laptops, phones and a monitor, some with people, some in stock, one retired. */
export function demoAssets(company: Pick<CompanyFacts, "people">): readonly Asset[] {
  const asset = (
    tag: string,
    kind: string,
    description: string,
    holder: Person | undefined | "stock" | "retired",
    since: string | null = null,
  ): Asset => ({
    tag,
    kind,
    description,
    status: holder === "stock" ? "in_stock" : holder === "retired" ? "retired" : "assigned",
    assignedToId: typeof holder === "object" ? holder.id : null,
    assignedToName: typeof holder === "object" ? holder.name : null,
    since: typeof holder === "object" ? since : null,
    note: holder === "retired" ? "Retired 2026-09-30: battery failed; data erased" : null,
  });
  return [
    asset("LT-201", "laptop", "14-inch laptop", at(company, 0), "2025-03-03"),
    asset("LT-202", "laptop", "14-inch laptop", at(company, 2), "2025-03-03"),
    asset("LT-203", "laptop", "13-inch laptop", at(company, 8), "2026-01-12"),
    asset("LT-204", "laptop", "14-inch laptop", "stock"),
    asset("LT-205", "laptop", "13-inch laptop", "retired"),
    asset("PH-301", "phone", "Work phone", at(company, 5), "2025-06-02"),
    asset("PH-302", "phone", "Work phone", "stock"),
    asset("MN-401", "monitor", "24-inch monitor", at(company, 4), "2025-03-03"),
  ];
}

/** The demonstration desk's options: the company, demonstration records, a clock. */
export interface FakeItDeskOptions {
  readonly company?: Pick<CompanyFacts, "hours" | "people" | "it">;
  readonly tickets?: readonly Ticket[];
  readonly assets?: readonly Asset[];
  /** The clock. Omitted: Monday 9 November 2026, the demonstration morning. */
  readonly now?: () => Date;
}

interface AccountState {
  personId: string;
  name: string;
  title: string;
  status: AccountStatus;
  mfaEnrolled: boolean;
  groups: string[];
  startDate: string | null;
}

/** An in-memory desk: the company's people as accounts, demonstration tickets and assets. */
export function fakeItDesk(options: FakeItDeskOptions = {}): ItDesk {
  const company = options.company ?? loadCompanyFacts();
  const clock = options.now ?? (() => new Date(DEMO_NOW));
  const today = (): string => localDate(clock(), company.hours.timezone);
  const memberships = demoMemberships(company);
  const accounts: AccountState[] = company.people.map((worker) => ({
    personId: worker.id,
    name: worker.name,
    title: worker.title,
    status: "active",
    mfaEnrolled: true,
    groups: [...(memberships.get(worker.id) ?? [])],
    startDate: null,
  }));
  const tickets: Ticket[] = [...(options.tickets ?? demoTickets(company))];
  const assets: Asset[] = [...(options.assets ?? demoAssets(company))];
  const resets: ResetReceipt[] = [];
  const counters = { reset: 0, signIn: 0, grant: 0, security: 0 };
  // Every write is remembered by its request id, so a replayed call is answered with what it already
  // did and never sends, grants or records twice.
  const done = new Map<string, unknown>();
  const approver = itApprover(company);
  const approverLabel = personLabel(approver, "the person who decides IT");

  const once = async <T>(requestId: string, write: () => T): Promise<T> => {
    if (done.has(requestId)) return done.get(requestId) as T;
    const result = write();
    done.set(requestId, result);
    return result;
  };

  const groupOf = (id: string): AccessGroup | undefined =>
    companyData(company, "it").accessGroups.find((group) => group.id === id.trim().toLowerCase());
  const systemName = (id: string): string =>
    companyData(company, "it").systems.find((system) => system.id === id)?.name ?? id;
  const view = (account: AccountState): Account => ({
    ...account,
    groups: account.groups.flatMap((id) => {
      const group = groupOf(id);
      return group === undefined ? [] : [{ ...group, systemName: systemName(group.systemId) }];
    }),
  });
  const named = (person: Person | undefined): NamedPerson =>
    person === undefined
      ? { name: approverLabel, title: "" }
      : { name: person.name, title: person.title };

  /** The sender's own account, or the refusal for a sender nobody verified or who is not staff. */
  const sender = (from: VerifiedSender | undefined, what: string): AccountState => {
    if (from === undefined) {
      throw new ItDeskError(
        "unknown_sender",
        `Nobody verified who sent this, so ${what}. Nothing was read, sent or changed.`,
      );
    }
    const worker = colleague(company, from);
    const account =
      worker === undefined ? undefined : accounts.find((entry) => entry.personId === worker.id);
    if (account === undefined) {
      throw new ItDeskError(
        "not_staff",
        `The sender is not a member of staff writing from inside the office, so ${what}. Nothing was read, sent or changed.`,
      );
    }
    return account;
  };

  /** Whether a name the model passed is the sender: by id, full name, or one part of their name. */
  const isSelf = (account: AccountState, name: string | undefined): boolean => {
    const wanted = (name ?? "").trim().toLowerCase();
    if (wanted === "") return true;
    const full = account.name.toLowerCase();
    return wanted === account.personId || wanted === full || full.split(" ").includes(wanted);
  };

  /**
   * The sender's own account for an account tool. Anyone else named is refused, whether or not they
   * exist, so the refusal says nothing about another person's account.
   */
  const ownAccount = (input: From & { readonly person?: string }, what: string): AccountState => {
    const account = sender(input.from, what);
    if (!isSelf(account, input.person)) {
      throw new ItDeskError(
        "someone_else",
        `That is someone else's account, and only the account's own holder can ask about it or have it changed, so ${what}. Nothing was sent or changed, and nothing about that account is shared.`,
      );
    }
    return account;
  };

  /** An account by id, full name or a unique part of a name. */
  const findAccount = (name: string): AccountState => {
    const wanted = name.trim().toLowerCase();
    const exact = accounts.filter(
      (entry) => entry.personId === wanted || entry.name.toLowerCase() === wanted,
    );
    const matches =
      exact.length > 0
        ? exact
        : accounts.filter((entry) => entry.name.toLowerCase().split(" ").includes(wanted));
    const [first, second] = matches;
    if (first === undefined) {
      throw new ItDeskError(
        "not_found",
        `No account belongs to ${JSON.stringify(name)}. Check the name with the person asking; a new joiner's account is set up with request_account_setup.`,
      );
    }
    if (second !== undefined) {
      throw new ItDeskError(
        "ambiguous",
        `More than one account matches ${JSON.stringify(name)}: ${matches.map((entry) => entry.name).join(", ")}. Ask which one, by full name.`,
      );
    }
    return first;
  };

  const required = (value: string | undefined, what: string): string => {
    const text = (value ?? "").trim();
    if (text === "") throw new ItDeskError("invalid", `Say ${what}; it may not be empty.`);
    return text;
  };

  const findTicket = (id: string): number => {
    const index = tickets.findIndex(
      (ticket) => ticket.id.toLowerCase() === id.trim().toLowerCase(),
    );
    if (index < 0) {
      throw new ItDeskError(
        "not_found",
        `No ticket has the number ${JSON.stringify(id)}. Find it with list_tickets.`,
      );
    }
    return index;
  };
  const openTicket = (id: string): [number, Ticket] => {
    const index = findTicket(id);
    const ticket = tickets[index] as Ticket;
    if (ticket.status === "closed") {
      throw new ItDeskError(
        "closed",
        `${ticket.id} is closed; nothing more is recorded on it. A new problem gets its own ticket with log_ticket.`,
      );
    }
    return [index, ticket];
  };

  const findAsset = (tag: string): number => {
    const index = assets.findIndex((asset) => asset.tag.toLowerCase() === tag.trim().toLowerCase());
    if (index < 0) {
      throw new ItDeskError(
        "not_found",
        `No asset has the tag ${JSON.stringify(tag)}. Find it with list_assets.`,
      );
    }
    return index;
  };

  const notDisabled = (account: AccountState, what: string): void => {
    if (account.status === "disabled") {
      throw new ItDeskError(
        "disabled",
        `${account.name}'s account is disabled, so ${what}. Nothing was changed.`,
      );
    }
  };

  const changed = (what: string): ItDeskError =>
    new ItDeskError(
      "changed",
      `This is not what the person approved: ${what} changed after its facts were read. Nothing was changed.`,
    );

  const signInFacts = (input: SignInChangeInput): Record<string, unknown> => {
    const account = ownAccount(input, "no sign-in method is changed for it");
    notDisabled(account, "its sign-in method is not changed");
    return {
      personId: account.personId,
      name: account.name,
      reason: required(input.reason, "why the sign-in method needs changing"),
    };
  };

  const accessFactsOf = (input: AccessInput): Record<string, unknown> => {
    sender(input.from, "no access is put to a person");
    const group = groupOf(input.groupId);
    if (group === undefined) {
      throw new ItDeskError(
        "not_found",
        `No access group has the id ${JSON.stringify(input.groupId)}. The groups are listed in read_company (it). Nothing was put to a person.`,
      );
    }
    if (group.privileged) {
      throw new ItDeskError(
        "privileged",
        `${group.name} carries administrator rights. The help desk never grants those or puts them to an approval: ${approverLabel} decides administrator rights directly. Nothing was put to a person and nothing was granted.`,
      );
    }
    const account = findAccount(input.person);
    notDisabled(account, "no access is granted to it");
    if (account.groups.includes(group.id)) {
      throw new ItDeskError(
        "already_member",
        `${account.name} already has ${group.name}. Nothing was put to a person.`,
      );
    }
    return {
      personId: account.personId,
      name: account.name,
      groupId: group.id,
      groupName: group.name,
      systemName: systemName(group.systemId),
      owner: personLabel(systemOwner(company, group.systemId), approverLabel),
      reason: required(input.reason, "why they need it"),
    };
  };

  const setupFactsOf = (input: SetupInput): Record<string, unknown> => {
    sender(input.from, "no account is put to a person");
    const name = required(input.name, "the joiner's full name");
    if (accounts.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
      throw new ItDeskError(
        "exists",
        `An account for ${name} already exists. Nothing was put to a person; access to more systems goes through request_access.`,
      );
    }
    if (parseDate(input.startDate) === undefined) {
      throw new ItDeskError(
        "invalid",
        `${JSON.stringify(input.startDate)} is not a start date: give it as YYYY-MM-DD.`,
      );
    }
    const groups = STAFF_GROUPS.flatMap((id) => {
      const group = groupOf(id);
      return group === undefined ? [] : [group.name];
    });
    return {
      name,
      job: required(input.job, "the joiner's job"),
      startDate: input.startDate,
      groups,
    };
  };

  const disableFactsOf = (input: DisableInput): Record<string, unknown> => {
    sender(input.from, "no account is put to a person");
    const account = findAccount(input.person);
    if (account.status === "disabled") {
      throw new ItDeskError(
        "already_disabled",
        `${account.name}'s account is already disabled. Nothing was put to a person.`,
      );
    }
    return {
      personId: account.personId,
      name: account.name,
      groups: view(account).groups.map((group) => group.name),
      reason: required(input.reason, "why the account is to be disabled"),
    };
  };

  const copyTicket = (ticket: Ticket): Ticket => ({
    ...ticket,
    escalatedTo: ticket.escalatedTo === null ? null : { ...ticket.escalatedTo },
    resolution: ticket.resolution === null ? null : { ...ticket.resolution },
  });

  return {
    async listTickets(input) {
      sender(input.from, "no ticket is listed for them");
      return tickets
        .filter(
          (ticket) =>
            input.ticketId === undefined ||
            ticket.id.toLowerCase() === input.ticketId.trim().toLowerCase(),
        )
        .filter((ticket) => input.status === undefined || ticket.status === input.status)
        .map(copyTicket);
    },

    async logTicket(input, { requestId }) {
      if (done.has(requestId)) return done.get(requestId) as Ticket;
      const reporter = sender(input.from, "no ticket is logged for them");
      const description = required(input.description, "what is wrong");
      return once(requestId, () => {
        const highest = Math.max(1003, ...tickets.map((ticket) => Number(ticket.id.slice(2)) || 0));
        const ticket: Ticket = {
          id: `T-${highest + 1}`,
          reporterId: reporter.personId,
          reporterName: reporter.name,
          category: input.category,
          impact: input.impact,
          priority: priorityFor(input.category, input.impact),
          description,
          status: "open",
          openedOn: today(),
          escalatedTo: null,
          escalationNotes: null,
          resolution: null,
        };
        tickets.push(ticket);
        return copyTicket(ticket);
      });
    },

    async escalateTicket(input, { requestId }) {
      if (done.has(requestId)) return done.get(requestId) as Ticket;
      sender(input.from, "no ticket is escalated for them");
      const [index, ticket] = openTicket(input.ticketId);
      const notes = required(input.notes, "what the next level needs: what was found and tried");
      let to = approver;
      if (input.systemId !== undefined) {
        if (!companyData(company, "it").systems.some((system) => system.id === input.systemId)) {
          throw new ItDeskError(
            "not_found",
            `No system has the id ${JSON.stringify(input.systemId)}. The systems are listed in read_company (it).`,
          );
        }
        to = systemOwner(company, input.systemId) ?? approver;
      }
      return once(requestId, () => {
        const next: Ticket = {
          ...ticket,
          status: "escalated",
          escalatedTo: named(to),
          escalationNotes: notes,
        };
        tickets[index] = next;
        return copyTicket(next);
      });
    },

    async resolveTicket(input, { requestId }) {
      if (done.has(requestId)) return done.get(requestId) as Ticket;
      sender(input.from, "no ticket is resolved for them");
      const [index, ticket] = openTicket(input.ticketId);
      const outcome = required(input.outcome, "how it was resolved");
      return once(requestId, () => {
        const next: Ticket = {
          ...ticket,
          status: input.reporterConfirmed ? "closed" : "awaiting_confirmation",
          resolution: { outcome, reporterConfirmed: input.reporterConfirmed, on: today() },
        };
        tickets[index] = next;
        return copyTicket(next);
      });
    },

    async myAccess(input) {
      return view(ownAccount(input, "no account details are given"));
    },

    async passwordReset(input, { requestId }) {
      if (done.has(requestId)) return done.get(requestId) as ResetReceipt;
      const account = ownAccount(input, "no reset was sent for it");
      const system = companyData(company, "it").systems.find(
        (entry) => entry.id === input.systemId.trim().toLowerCase(),
      );
      if (system === undefined) {
        throw new ItDeskError(
          "not_found",
          `No system has the id ${JSON.stringify(input.systemId)}. The systems are listed in read_company (it). Nothing was sent.`,
        );
      }
      notDisabled(account, "no reset goes to it");
      const held = view(account).groups;
      if (held.some((group) => group.privileged)) {
        throw new ItDeskError(
          "privileged",
          `${account.name}'s account holds administrator rights, and the help desk does not reset a privileged account: ${approverLabel} decides how it is reset, in person. Nothing was sent.`,
        );
      }
      if (!held.some((group) => group.systemId === system.id)) {
        throw new ItDeskError(
          "no_access",
          `${account.name}'s account has no access to ${system.name}, so there is no password there to reset. Nothing was sent; access to it goes through request_access.`,
        );
      }
      return once(requestId, () => {
        counters.reset += 1;
        const receipt: ResetReceipt = {
          id: `RST-${counters.reset}`,
          name: account.name,
          systemId: system.id,
          systemName: system.name,
          noticeTo: account.name,
          on: today(),
        };
        resets.push(receipt);
        return { ...receipt };
      });
    },

    async resetsSent() {
      return resets.map((receipt) => ({ ...receipt }));
    },

    async signInChangeFacts(input) {
      return signInFacts(input);
    },

    async changeSignInMethod(input, { requestId }) {
      if (done.has(requestId)) return done.get(requestId) as SignInChange;
      const facts = signInFacts(input);
      if (!sameFacts(input.approved, facts)) throw changed("the account or the reason");
      return once(requestId, () => {
        counters.signIn += 1;
        return {
          id: `SIG-${counters.signIn}`,
          name: String(facts.name),
          reason: String(facts.reason),
          on: today(),
        };
      });
    },

    async accessFacts(input) {
      return accessFactsOf(input);
    },

    async grantAccess(input, { requestId }) {
      if (done.has(requestId)) return done.get(requestId) as AccessGrant;
      const facts = accessFactsOf(input);
      if (!sameFacts(input.approved, facts)) throw changed("the person, the group or the reason");
      return once(requestId, () => {
        const account = findAccount(String(facts.personId));
        account.groups.push(String(facts.groupId));
        counters.grant += 1;
        return {
          id: `ACC-${counters.grant}`,
          name: account.name,
          groupId: String(facts.groupId),
          groupName: String(facts.groupName),
          systemName: String(facts.systemName),
          on: today(),
        };
      });
    },

    async setupFacts(input) {
      return setupFactsOf(input);
    },

    async setupAccount(input, { requestId }) {
      if (done.has(requestId)) return done.get(requestId) as Account;
      const facts = setupFactsOf(input);
      if (!sameFacts(input.approved, facts)) throw changed("the joiner's details");
      return once(requestId, () => {
        const name = String(facts.name);
        const account: AccountState = {
          personId: `joiner-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          name,
          title: String(facts.job),
          status: "active",
          // Enrolment happens with the joiner on their first day; until then it is a gap to close.
          mfaEnrolled: false,
          groups: STAFF_GROUPS.filter((id) => groupOf(id) !== undefined),
          startDate: String(facts.startDate),
        };
        accounts.push(account);
        return view(account);
      });
    },

    async disableFacts(input) {
      return disableFactsOf(input);
    },

    async disableAccount(input, { requestId }) {
      if (done.has(requestId)) return done.get(requestId) as Disabled;
      const facts = disableFactsOf(input);
      if (!sameFacts(input.approved, facts)) throw changed("the account or the reason");
      return once(requestId, () => {
        const account = findAccount(String(facts.personId));
        account.status = "disabled";
        return {
          account: view(account),
          assetsToCollect: assets
            .filter((asset) => asset.assignedToId === account.personId)
            .map((asset) => ({ ...asset })),
        };
      });
    },

    async listAssets(input) {
      sender(input.from, "no asset is listed for them");
      const holder = input.person === undefined ? undefined : findAccount(input.person);
      return assets
        .filter((asset) => holder === undefined || asset.assignedToId === holder.personId)
        .filter(
          (asset) =>
            input.tag === undefined || asset.tag.toLowerCase() === input.tag.trim().toLowerCase(),
        )
        .filter((asset) => input.status === undefined || asset.status === input.status)
        .map((asset) => ({ ...asset }));
    },

    async assignAsset(input, { requestId }) {
      if (done.has(requestId)) return done.get(requestId) as Asset;
      sender(input.from, "nothing is assigned for them");
      const index = findAsset(input.tag);
      const asset = assets[index] as Asset;
      if (asset.status === "assigned") {
        throw new ItDeskError(
          "assigned",
          `${asset.tag} is already assigned to ${asset.assignedToName ?? "someone"} (since ${asset.since ?? "an earlier day"}). Nothing was changed; it comes back first with return_asset, or another one in stock is assigned instead.`,
        );
      }
      if (asset.status === "retired") {
        throw new ItDeskError(
          "retired",
          `${asset.tag} is retired and is not assigned again. Nothing was changed; list_assets shows what is in stock.`,
        );
      }
      const account = findAccount(input.person);
      notDisabled(account, "no equipment is assigned to them");
      return once(requestId, () => {
        const next: Asset = {
          ...asset,
          status: "assigned",
          assignedToId: account.personId,
          assignedToName: account.name,
          since: today(),
          note: null,
        };
        assets[index] = next;
        return { ...next };
      });
    },

    async returnAsset(input, { requestId }) {
      if (done.has(requestId)) return done.get(requestId) as Asset;
      sender(input.from, "nothing is recorded as returned for them");
      const index = findAsset(input.tag);
      const asset = assets[index] as Asset;
      if (asset.status !== "assigned") {
        throw new ItDeskError(
          "not_assigned",
          `${asset.tag} is not assigned to anyone (it is ${asset.status.replace("_", " ")}), so there is nothing to return. Nothing was changed.`,
        );
      }
      const condition = required(input.condition, "the condition it came back in");
      return once(requestId, () => {
        const next: Asset = {
          ...asset,
          status: "in_stock",
          assignedToId: null,
          assignedToName: null,
          since: null,
          note: `Returned ${today()} by ${asset.assignedToName ?? "its holder"}: ${condition}`,
        };
        assets[index] = next;
        return { ...next };
      });
    },

    async reportSecurityConcern(input, { requestId }) {
      if (done.has(requestId)) return done.get(requestId) as SecurityReport;
      const description = required(input.description, "what happened");
      const worker = colleague(company, input.from);
      return once(requestId, () => {
        counters.security += 1;
        return {
          id: `SEC-${counters.security}`,
          kind: input.kind,
          description,
          reportedBy: worker?.name ?? "an unverified sender",
          handedTo: named(approver),
          on: today(),
        };
      });
    },
  };
}
