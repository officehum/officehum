/**
 * The IT Help Desk role's fifteen tools.
 *
 * `list_tickets`, `list_my_access`, `list_assets` and `read_company` only read. Who is asking comes
 * from the host's verified sender (`SenderResolver`), never from an argument or the message, and the
 * desk answers only a colleague writing from inside the office. `list_my_access` and
 * `send_password_reset` act on the sender's own account alone: a `person` argument exists only so
 * the desk can refuse someone else's account in code rather than leave it to the model.
 *
 * The ticket, asset and security writes need no approval: they are internal records. The four
 * account changes (`request_sign_in_method_change`, `request_access`, `request_account_setup`,
 * `request_account_disable`) carry `officehum.json`'s approval on every call, evaluated by the SDK's
 * gate before the tool runs. Each has a facts reader that reads what the person approves from the
 * desk, so a group with administrator rights, someone else's account or an unknown sender is refused
 * before anyone is asked; on a yes the gate hands those facts to the tool, and the desk refuses when
 * the record no longer equals them.
 *
 * No tool prints a password, a link, a one-time code or a contact detail: the desk returns none, and
 * the company sections print names and titles only.
 */

import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { bool, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import {
  APPROVED_FACTS_ARG,
  type ApprovalFactsReader,
  approvedFacts,
  approvedFactsParameter,
  companyData,
  companyEscalationText,
  companyGlossaryText,
  companyHeadline,
  companyHoursText,
  companyPeopleText,
  companyToneText,
  deskRefusal,
  readCompanyTool,
  refusal,
  requestId,
  requireDesk,
  type SenderResolver,
  textResult,
} from "@officehum/sdk";
import {
  type CompanyFacts,
  itApprover,
  personLabel,
  purchasingDecider,
  systemOwner,
} from "./company.js";
import {
  type Account,
  ASSET_STATUSES,
  type Asset,
  type AssetStatus,
  CATEGORIES,
  CONCERN_KINDS,
  type ConcernKind,
  type DeskRefusal,
  IMPACTS,
  type Impact,
  type ItDesk,
  ItDeskError,
  type NamedPerson,
  TICKET_STATUSES,
  type Ticket,
  type TicketStatus,
} from "./desk.js";

export interface ItHelpdeskToolDependencies {
  readonly desk: ItDesk | undefined;
  readonly company: CompanyFacts;
  /** The host's verified sender of each call's work. Omitted: every sender is unknown. */
  readonly sender?: SenderResolver;
}

export interface ItHelpdeskToolset {
  readonly listTickets: ToolRegistration;
  readonly logTicket: ToolRegistration;
  readonly escalateTicket: ToolRegistration;
  readonly resolveTicket: ToolRegistration;
  readonly listMyAccess: ToolRegistration;
  readonly sendPasswordReset: ToolRegistration;
  readonly requestSignInMethodChange: ToolRegistration;
  readonly requestAccess: ToolRegistration;
  readonly requestAccountSetup: ToolRegistration;
  readonly requestAccountDisable: ToolRegistration;
  readonly listAssets: ToolRegistration;
  readonly assignAsset: ToolRegistration;
  readonly returnAsset: ToolRegistration;
  readonly reportSecurityConcern: ToolRegistration;
  readonly readCompany: ToolRegistration;
  /** The four approvals' facts, read from the desk before anyone is asked. */
  readonly signInChangeFacts: ApprovalFactsReader;
  readonly accessFacts: ApprovalFactsReader;
  readonly setupFacts: ApprovalFactsReader;
  readonly disableFacts: ApprovalFactsReader;
}

export type CompanySection =
  | "profile"
  | "hours"
  | "people"
  | "it"
  | "tone"
  | "escalation"
  | "glossary";

const literals = <T extends string>(values: readonly T[], description: string) =>
  union(
    values.map((value) => lit(value)),
    { description },
  );

const OWN_ACCOUNT =
  "Leave it out: the desk knows who sent the message and acts on their own account. Only if the sender asks about another person's account, give that person's name as they wrote it; the desk refuses it";
const PERSON = "The person's full name as given, or a first name or surname alone";
const TICKET_ID = str({ description: "The ticket's number, e.g. T-1001" });
const TAG = str({ description: "The asset's tag, e.g. LT-204" });
const SYSTEM_ID = str({
  description: "The system's id from read_company (it), e.g. email",
});

const words = (value: string): string => value.replaceAll("_", " ");
const IMPACT_WORDS: Readonly<Record<Impact, string>> = {
  one_person_can_work: "one person, who can still work",
  one_person_blocked: "one person, who cannot work",
  several_people: "several people",
  everyone: "everyone, or a whole system",
};

/** "Name, Title" for a person a receipt names. */
const label = (who: NamedPerson): string =>
  who.title === "" ? who.name : `${who.name}, ${who.title}`;

/**
 * The next step for every refusal the desk can give, keyed by its code and never by its message. A
 * `Record` over the whole union, so a new code does not compile until it has a hint.
 */
export function HINTS(company: CompanyFacts): Record<DeskRefusal, string> {
  const approver = personLabel(itApprover(company), "the person who decides IT");
  return {
    unknown_sender: ` Next: say plainly that nothing was read, sent or changed, because account matters are handled only for staff writing from inside the office; they can ask ${approver} directly. Share nothing about any account.`,
    not_staff: ` Next: say plainly that nothing was read, sent or changed, because account matters are handled only for staff writing from inside the office; ${approver} decides IT. Share nothing about any account.`,
    someone_else:
      " Next: say plainly in your first sentence that each person asks about their own account themselves, so nothing was done for someone else's account; access for another person goes through request_access, which a person decides. Say nothing about the other account.",
    not_found: " Check the name, number or tag and try once, or ask for it.",
    ambiguous: " Ask which one, by full name.",
    invalid: " Fix what it says and try once, or ask for what is missing.",
    privileged: ` Next: say plainly in your first sentence that the help desk does not do this, and that ${approver} decides it; do not retry or reword the call to get round it.`,
    no_access:
      " Next: tell them; if they need that system, request_access asks a person for the access.",
    disabled: ` Next: tell them the account is disabled; ${approver} decides whether it comes back.`,
    already_member: " Tell them they already have it; nothing needs asking.",
    already_disabled: " Tell them it is already disabled; nothing needs asking.",
    exists: " Tell them the account already exists; more access goes through request_access.",
    changed:
      " Next: say nothing was changed because the record changed after it was put to a person; read it again before asking again.",
    closed: " Tell them the ticket is closed; a new problem gets its own with log_ticket.",
    assigned:
      " Next: if it really came back, record that with return_asset first; otherwise assign one in stock from list_assets.",
    retired: " Assign one in stock instead, from list_assets.",
    not_assigned: " Tell them it is already back in stock; nothing needs recording.",
  };
}

function ticketText(ticket: Ticket): string {
  const lines = [
    `${ticket.id} — reported by ${ticket.reporterName} on ${ticket.openedOn} — ${ticket.category} — ${IMPACT_WORDS[ticket.impact]} — priority ${ticket.priority} — ${words(ticket.status)} — ${ticket.description}`,
  ];
  if (ticket.escalatedTo !== null) {
    lines.push(`  escalated to ${label(ticket.escalatedTo)}: ${ticket.escalationNotes ?? ""}`);
  }
  if (ticket.resolution !== null) {
    lines.push(
      `  fix: ${ticket.resolution.outcome} (${ticket.resolution.on}) — ${ticket.resolution.reporterConfirmed ? "confirmed by the reporter" : "waiting for the reporter to confirm it works"}`,
    );
  }
  return lines.join("\n");
}

function accountText(account: Account): string {
  const groups =
    account.groups.length === 0
      ? "none"
      : account.groups
          .map(
            (group) =>
              `${group.name} (${group.systemName})${group.privileged ? " — administrator rights" : ""}`,
          )
          .join("; ");
  return `Account for ${account.name} (the sender): ${account.status}; multi-factor sign-in ${account.mfaEnrolled ? "enrolled" : "not enrolled yet"}. Groups: ${groups}. This is the sender's own account only.`;
}

function assetLine(asset: Asset): string {
  const where =
    asset.status === "assigned"
      ? `with ${asset.assignedToName ?? ""} since ${asset.since ?? ""}`
      : words(asset.status);
  return `${asset.tag} — ${asset.description} (${asset.kind}) — ${where}${asset.note === null ? "" : ` — ${asset.note}`}`;
}

/** A desk record as JSON details: a fresh copy, which is what a tool result's details take. */
function json(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/** Who decides IT, the systems and owners, the groups and which carry administrator rights. */
function itText(company: CompanyFacts): string {
  const approver = personLabel(itApprover(company), "the person who decides IT");
  return [
    `Access, administrator rights, leavers' data and security: ${approver}.`,
    `Purchases of software and equipment: ${personLabel(purchasingDecider(company), "purchasing")}.`,
    "Systems (id: name — owner, who assigns access to it):",
    ...companyData(company, "it").systems.map(
      (system) =>
        `- ${system.id}: ${system.name} — owner ${personLabel(systemOwner(company, system.id), approver)}`,
    ),
    "Access groups (id: name (system)):",
    ...companyData(company, "it").accessGroups.map(
      (group) =>
        `- ${group.id}: ${group.name} (${group.systemId})${group.privileged ? " — administrator rights: never granted or reset by the help desk" : ""}`,
    ),
  ].join("\n");
}

/** Each section `read_company` answers for. Names and titles only: never a phone or an email. */
const COMPANY_SECTIONS: Readonly<Record<CompanySection, (company: CompanyFacts) => string>> = {
  profile: (company) => companyHeadline(company.profile),
  hours: companyHoursText,
  people: (company) => companyPeopleText(company, "none"),
  it: itText,
  tone: companyToneText,
  escalation: companyEscalationText,
  glossary: companyGlossaryText,
};

/**
 * Builds the fifteen tools over one desk and one company. Every one is plain Pi Durable: they install
 * into any harness, and a harness with no desk builds the same tools and refuses at the point of use.
 */
export function itHelpdeskTools(dependencies: ItHelpdeskToolDependencies): ItHelpdeskToolset {
  const { company } = dependencies;
  const hints = HINTS(company);
  const approver = personLabel(itApprover(company), "the person who decides IT");
  const desk = () => requireDesk(dependencies.desk, "IT");

  /** Who this call's work came from, as the host verified it; `undefined` when nobody is known. */
  const from = (api: { readonly conversationId: unknown; readonly taskId: unknown }) =>
    dependencies.sender?.({ conversationId: api.conversationId, taskId: api.taskId }) ??
    Promise.resolve(undefined);

  /** A desk refusal as the model reads it, with the next step its code names. */
  const refused = (error: unknown, extra: Record<string, unknown>) => {
    if (!(error instanceof ItDeskError)) throw error;
    return deskRefusal(`${error.message}${hints[error.code]}`, error.code, extra);
  };

  /** A facts reader's refusal: nobody is asked, and the model reads why with its next step. */
  const readerRefusal = (error: unknown): never => {
    if (!(error instanceof ItDeskError)) throw error;
    const nobody = error.message.includes("Nothing was put to a person")
      ? ""
      : " Nothing was put to a person.";
    throw new Error(`${error.message}${nobody}${hints[error.code]}`);
  };

  /** The refusal for a gated call with no approved facts: nothing happens without the gate's yes. */
  const notApproved = (what: string, extra: Record<string, unknown>) =>
    refusal(
      `${what}: this call carries no facts a person approved. It happens only after the approval gate has put it to a person and they said yes. Next: tell the person it needs a person's approval and nothing was done.`,
      { code: "not_approved", ...extra },
    );

  const personArg = (args: Readonly<Record<string, unknown>>) =>
    typeof args.person === "string" && args.person.trim() !== "" ? { person: args.person } : {};

  const listTickets = defineTool({
    name: "list_tickets",
    description:
      "List IT tickets, or one by its number or status: who reported it and when, the category, impact and the priority the desk set, what is wrong, where it stands, who it is escalated to and the fix. Only for staff asking from inside the office.",
    parameters: obj({
      ticketId: opt(TICKET_ID),
      status: opt(literals(TICKET_STATUSES, "Only tickets in this state")),
    }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const found = await desk().listTickets({
          from: await from(api),
          ...(args.ticketId === undefined ? {} : { ticketId: args.ticketId }),
          ...(args.status === undefined ? {} : { status: args.status as TicketStatus }),
        });
        return {
          ...textResult(
            found.length === 0
              ? "No ticket matches that."
              : [`Tickets (${found.length}):`, ...found.map(ticketText)].join("\n"),
          ),
          details: { found: found.length > 0, tickets: found.map(json) },
        };
      } catch (error) {
        return refused(error, { found: false });
      }
    },
  });

  const logTicket = defineTool({
    name: "log_ticket",
    description:
      "Log an IT ticket for the sender: the category, the impact and what is wrong, in their words. You give no priority: the desk sets it from the category and impact. An internal ticket: nothing is sent, granted or changed.",
    parameters: obj({
      category: literals(CATEGORIES, "What it is about"),
      impact: literals(
        IMPACTS,
        "How many people it stops: one_person_can_work (one person, who can still work), one_person_blocked (one person, who cannot work), several_people, or everyone (the whole company, or a whole system down)",
      ),
      description: str({ description: "What is wrong, in the sender's words" }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const ticket = await desk().logTicket(
          {
            from: await from(api),
            category: args.category,
            impact: args.impact as Impact,
            description: args.description,
          },
          { requestId: requestId("ticket", api) },
        );
        return {
          ...textResult(
            `Logged ${ticket.id} for ${ticket.reporterName}: ${ticket.category}, ${IMPACT_WORDS[ticket.impact]}, priority ${ticket.priority} (set by the desk from the category and impact). ${ticket.description}. An internal ticket: nothing has been sent, changed or granted.`,
          ),
          details: json(ticket),
        };
      } catch (error) {
        return refused(error, {});
      }
    },
  });

  const escalateTicket = defineTool({
    name: "escalate_ticket",
    description:
      "Escalate an open ticket the first line cannot resolve, with notes on what was found and tried: to the owner of the system it concerns when you give its id, otherwise to the person who decides IT. The receipt says who has it.",
    parameters: obj({
      ticketId: TICKET_ID,
      systemId: opt(SYSTEM_ID),
      notes: str({
        description: "What the next level needs: what was found, what was tried",
      }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const ticket = await desk().escalateTicket(
          {
            from: await from(api),
            ticketId: args.ticketId,
            ...(args.systemId === undefined ? {} : { systemId: args.systemId }),
            notes: args.notes,
          },
          { requestId: requestId("escalate", api) },
        );
        const to = ticket.escalatedTo === null ? approver : label(ticket.escalatedTo);
        return {
          ...textResult(
            `Escalated ${ticket.id} to ${to}, with the notes: ${ticket.escalationNotes ?? ""}. It is with them now. This records the hand-over; it changes no account and grants nothing.`,
          ),
          details: json(ticket),
        };
      } catch (error) {
        return refused(error, { ticketId: args.ticketId });
      }
    },
  });

  const resolveTicket = defineTool({
    name: "resolve_ticket",
    description:
      "Record how a ticket was fixed and whether the person who reported it confirmed it works. reporterConfirmed true closes it; false keeps it waiting for their confirmation. Never set it true on your own judgement.",
    parameters: obj({
      ticketId: TICKET_ID,
      outcome: str({ description: "What was done to fix it" }),
      reporterConfirmed: bool({
        description: "Whether the person who reported it said the fix works",
      }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const ticket = await desk().resolveTicket(
          {
            from: await from(api),
            ticketId: args.ticketId,
            outcome: args.outcome,
            reporterConfirmed: args.reporterConfirmed,
          },
          { requestId: requestId("resolve", api) },
        );
        const outcome = ticket.resolution?.outcome ?? args.outcome;
        return {
          ...textResult(
            ticket.status === "closed"
              ? `Closed ${ticket.id}: ${outcome}, confirmed by ${ticket.reporterName}.`
              : `Recorded the fix on ${ticket.id}: ${outcome}. It waits for ${ticket.reporterName} to confirm it works; it stays open until they do.`,
          ),
          details: json(ticket),
        };
      } catch (error) {
        return refused(error, { ticketId: args.ticketId });
      }
    },
  });

  const listMyAccess = defineTool({
    name: "list_my_access",
    description:
      "The sender's own account: whether it is active, multi-factor sign-in, and the access groups and systems it holds. Never anyone else's: the desk refuses another person's account and an unknown sender.",
    parameters: obj({ person: opt(str({ description: OWN_ACCOUNT })) }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const account = await desk().myAccess({ from: await from(api), ...personArg(args) });
        return { ...textResult(accountText(account)), details: json(account) };
      } catch (error) {
        return refused(error, {});
      }
    },
  });

  const sendPasswordReset = defineTool({
    name: "send_password_reset",
    description:
      "Send a password reset link for one system to the address on file for the sender's own account, and a notice to them that a reset was asked for. Nothing secret is shown. The desk refuses another person's account, an account with administrator rights, and an unknown sender.",
    parameters: obj({
      systemId: SYSTEM_ID,
      person: opt(str({ description: OWN_ACCOUNT })),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const receipt = await desk().passwordReset(
          { from: await from(api), systemId: args.systemId, ...personArg(args) },
          { requestId: requestId("reset", api) },
        );
        return {
          ...textResult(
            `Sent a password reset link for ${receipt.systemName} to the address on file for ${receipt.name}'s account (${receipt.id}), and a notice to ${receipt.noticeTo} that a reset was asked for, so a reset they did not ask for is noticed. The link goes only to that address. Nothing secret is shown here: no password, link or code.`,
          ),
          details: json(receipt),
        };
      } catch (error) {
        return refused(error, { systemId: args.systemId });
      }
    },
  });

  const signInChangeFacts: ApprovalFactsReader = async (args, _context, call) => {
    try {
      const facts = await desk().signInChangeFacts({
        from: await from(call),
        reason: String(args.reason ?? ""),
        ...personArg(args),
      });
      return {
        summary: `Change the sign-in method on ${String(facts.name)}'s own account, as they asked from inside the office. Reason: ${String(facts.reason)}`,
        facts,
      };
    } catch (error) {
      return readerRefusal(error);
    }
  };

  const requestSignInMethodChange = defineTool({
    name: "request_sign_in_method_change",
    description:
      "Ask a person to approve a change to the sender's own sign-in method: moving an authenticator to a new phone, or replacing a lost one, with the reason. Every call waits for a person; it is never done on the asker's say-so, and no code is ever shown.",
    parameters: obj({
      reason: str({ description: "Why it needs changing, in the sender's words" }),
      person: opt(str({ description: OWN_ACCOUNT })),
      // Pi Durable re-validates the arguments the gate returns, so the gate's key is declared.
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const approved = approvedFacts(args);
      if (approved === undefined) return notApproved("No sign-in method was changed", {});
      try {
        const change = await desk().changeSignInMethod(
          { from: await from(api), reason: args.reason, ...personArg(args), approved },
          { requestId: requestId("sign-in", api) },
        );
        return {
          ...textResult(
            `Approved: the sign-in method change on ${change.name}'s account is recorded as ${change.id} (reason: ${change.reason}). IT makes the change with them in person, and a notice goes to them. No code or password is shown or sent here.`,
          ),
          details: json(change),
        };
      } catch (error) {
        return refused(error, {});
      }
    },
  });

  const accessInput = (args: Readonly<Record<string, unknown>>) => ({
    person: String(args.person ?? ""),
    groupId: String(args.groupId ?? ""),
    reason: String(args.reason ?? ""),
  });

  const accessFacts: ApprovalFactsReader = async (args, _context, call) => {
    try {
      const facts = await desk().accessFacts({ from: await from(call), ...accessInput(args) });
      return {
        summary: `Add ${String(facts.name)} to ${String(facts.groupName)} (${String(facts.systemName)}, owned by ${String(facts.owner)}). Reason: ${String(facts.reason)}`,
        facts,
      };
    } catch (error) {
      return readerRefusal(error);
    }
  };

  const requestAccess = defineTool({
    name: "request_access",
    description:
      "Ask a person to approve adding someone to an access group, with the reason. Every call waits for a person. A group with administrator rights is refused outright and nobody is asked: say who decides it.",
    parameters: obj({
      person: str({ description: `Who needs the access. ${PERSON}` }),
      groupId: str({ description: "The group's id from read_company (it)" }),
      reason: str({ description: "Why they need it" }),
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return notApproved("Nothing was granted", { person: args.person, groupId: args.groupId });
      }
      try {
        const grant = await desk().grantAccess(
          { from: await from(api), ...accessInput(args), approved },
          { requestId: requestId("access", api) },
        );
        return {
          ...textResult(
            `Approved and granted: ${grant.name} now has ${grant.groupName} (${grant.systemName}), ${grant.id}, on ${grant.on}.`,
          ),
          details: json(grant),
        };
      } catch (error) {
        return refused(error, { person: args.person, groupId: args.groupId });
      }
    },
  });

  const setupInput = (args: Readonly<Record<string, unknown>>) => ({
    name: String(args.name ?? ""),
    job: String(args.job ?? ""),
    startDate: String(args.startDate ?? ""),
  });

  const setupFacts: ApprovalFactsReader = async (args, _context, call) => {
    try {
      const facts = await desk().setupFacts({ from: await from(call), ...setupInput(args) });
      const groups = (facts.groups as readonly string[]).join(" and ");
      return {
        summary: `Set up an account for ${String(facts.name)} (${String(facts.job)}), starting ${String(facts.startDate)}, with ${groups}`,
        facts,
      };
    } catch (error) {
      return readerRefusal(error);
    }
  };

  const requestAccountSetup = defineTool({
    name: "request_account_setup",
    description:
      "Ask a person to approve setting up the account for a new joiner: their full name, job and start date. Every call waits for a person; once approved, the desk creates the account with the standard staff groups. More access goes through request_access.",
    parameters: obj({
      name: str({ description: "The joiner's full name" }),
      job: str({ description: "Their job" }),
      startDate: str({ description: "Their first day, as YYYY-MM-DD" }),
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const approved = approvedFacts(args);
      if (approved === undefined) return notApproved("No account was set up", { name: args.name });
      try {
        const account = await desk().setupAccount(
          { from: await from(api), ...setupInput(args), approved },
          { requestId: requestId("setup", api) },
        );
        const groups = account.groups.map((group) => group.name).join(" and ");
        return {
          ...textResult(
            `Approved and set up: an account for ${account.name} (${account.title}), starting ${account.startDate ?? ""}, with ${groups}. Their sign-in details reach them by a secure route on their first day, never by email, and multi-factor sign-in is enrolled with them then. More access goes through request_access, and equipment through assign_asset.`,
          ),
          details: json(account),
        };
      } catch (error) {
        return refused(error, { name: args.name });
      }
    },
  });

  const disableInput = (args: Readonly<Record<string, unknown>>) => ({
    person: String(args.person ?? ""),
    reason: String(args.reason ?? ""),
  });

  const disableFacts: ApprovalFactsReader = async (args, _context, call) => {
    try {
      const facts = await desk().disableFacts({ from: await from(call), ...disableInput(args) });
      return {
        summary: `Stop ${String(facts.name)}'s account from signing in. It holds: ${(facts.groups as readonly string[]).join(", ")}. Reason: ${String(facts.reason)}`,
        facts,
      };
    } catch (error) {
      return readerRefusal(error);
    }
  };

  const requestAccountDisable = defineTool({
    name: "request_account_disable",
    description:
      "Ask a person to approve stopping a leaver's account from signing in, with the reason. Every call waits for a person; once approved, the desk disables the account and lists the equipment to collect. Nothing is deleted.",
    parameters: obj({
      person: str({ description: `Whose account. ${PERSON}` }),
      reason: str({ description: "Why: for a leaver, their last day" }),
      [APPROVED_FACTS_ARG]: approvedFactsParameter(),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return notApproved("No account was disabled", { person: args.person });
      }
      try {
        const result = await desk().disableAccount(
          { from: await from(api), ...disableInput(args), approved },
          { requestId: requestId("disable", api) },
        );
        const collect =
          result.assetsToCollect.length === 0
            ? "none on the register"
            : result.assetsToCollect
                .map((asset) => `${asset.tag} (${asset.description})`)
                .join(", ");
        return {
          ...textResult(
            `Approved and disabled: ${result.account.name}'s account no longer signs in. Equipment to collect: ${collect}. Nothing has been deleted: who takes over the mailbox and files is for ${approver} to decide.`,
          ),
          details: json(result),
        };
      } catch (error) {
        return refused(error, { person: args.person });
      }
    },
  });

  const listAssets = defineTool({
    name: "list_assets",
    description:
      "List the IT equipment on the asset register, by person, tag or status (assigned, in_stock, retired): what each is, who has it and since when. Only for staff asking from inside the office.",
    parameters: obj({
      person: opt(str({ description: `Whose equipment. ${PERSON}` })),
      tag: opt(TAG),
      status: opt(literals(ASSET_STATUSES, "Only assets in this state")),
    }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const found = await desk().listAssets({
          from: await from(api),
          ...personArg(args),
          ...(args.tag === undefined ? {} : { tag: args.tag }),
          ...(args.status === undefined ? {} : { status: args.status as AssetStatus }),
        });
        return {
          ...textResult(
            found.length === 0
              ? "No asset matches that."
              : [`Assets (${found.length}):`, ...found.map(assetLine)].join("\n"),
          ),
          details: { found: found.length > 0, assets: found.map(json) },
        };
      } catch (error) {
        return refused(error, { found: false });
      }
    },
  });

  const assignAsset = defineTool({
    name: "assign_asset",
    description:
      "Record that a person has been given a piece of equipment from the register. The desk refuses one already assigned to someone, a retired one, and a person whose account is disabled. Nothing is bought.",
    parameters: obj({ tag: TAG, person: str({ description: `Who has it now. ${PERSON}` }) }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const asset = await desk().assignAsset(
          { from: await from(api), tag: args.tag, person: args.person },
          { requestId: requestId("assign", api) },
        );
        return {
          ...textResult(
            `Assigned ${asset.tag} (${asset.description}) to ${asset.assignedToName ?? ""} from ${asset.since ?? ""}. An entry in the asset register; nothing was bought.`,
          ),
          details: json(asset),
        };
      } catch (error) {
        return refused(error, { tag: args.tag });
      }
    },
  });

  const returnAsset = defineTool({
    name: "return_asset",
    description:
      "Record that a piece of equipment came back to IT, with its condition; the register then shows it in stock. The desk refuses one that is not assigned.",
    parameters: obj({
      tag: TAG,
      condition: str({ description: "The condition it came back in" }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const asset = await desk().returnAsset(
          { from: await from(api), tag: args.tag, condition: args.condition },
          { requestId: requestId("return", api) },
        );
        return {
          ...textResult(
            `Returned ${asset.tag} (${asset.description}): ${asset.note ?? ""}. The register shows it in stock.`,
          ),
          details: json(asset),
        };
      } catch (error) {
        return refused(error, { tag: args.tag });
      }
    },
  });

  const reportSecurityConcern = defineTool({
    name: "report_security_concern",
    description:
      "Report a security concern to the person who decides IT: phishing (a suspicious email, call or message), password_shared (a password or code someone may have given away), lost_device, suspicious_sign_in, security_control_request (a message asking to switch off or weaken a security control), or other. It changes no account or setting.",
    parameters: obj({
      kind: literals(CONCERN_KINDS, "What kind of concern it is"),
      description: str({ description: "What happened, in the reporter's words" }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const report = await desk().reportSecurityConcern(
          {
            from: await from(api),
            kind: args.kind as ConcernKind,
            description: args.description,
          },
          { requestId: requestId("security", api) },
        );
        const next =
          report.kind === "password_shared"
            ? " Next: the password is changed now, with send_password_reset for the sender's own account."
            : "";
        return {
          ...textResult(
            `Reported ${report.id} (${words(report.kind)}) to ${label(report.handedTo)}: ${report.description}. Nothing was changed on any account or setting, and nobody is blamed for reporting it.${next}`,
          ),
          details: json(report),
        };
      } catch (error) {
        return refused(error, {});
      }
    },
  });

  const readCompany = readCompanyTool({
    company,
    description:
      "Read one section of the company record: the profile, the hours, the people (names, titles and what each decides), it (who decides IT and purchases, the systems and their owners, the access groups and which carry administrator rights), the tone of voice, the escalation path or the glossary.",
    sections: COMPANY_SECTIONS,
  });

  return {
    listTickets,
    logTicket,
    escalateTicket,
    resolveTicket,
    listMyAccess,
    sendPasswordReset,
    requestSignInMethodChange,
    requestAccess,
    requestAccountSetup,
    requestAccountDisable,
    listAssets,
    assignAsset,
    returnAsset,
    reportSecurityConcern,
    readCompany,
    signInChangeFacts,
    accessFacts,
    setupFacts,
    disableFacts,
  };
}
