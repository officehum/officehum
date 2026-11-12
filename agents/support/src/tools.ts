/**
 * The Customer Support role's ten tools.
 *
 * `find_client`, `list_cases` and `read_company` only read. `log_case`, `book_reclean`,
 * `propose_credit`, `withdraw_credit`, `escalate_case` and `resolve_case` write through the desk with
 * no approval: the desk numbers a case, checks the re-clean window and the kind of complaint a
 * re-clean puts right, works out a proposed credit and records it as pending, picks the person a case
 * goes to from the company record (never anyone the case names), and refuses to close a case that
 * still waits for something, a pending credit included. `offer_credit` names only a proposal and
 * waits for a person on every call: its approval is `officehum.json`'s, and the SDK's gate reads the
 * proposal's facts from the desk (`creditFacts`), shows them to the person and hands them to the tool
 * on a yes, so the desk issues only the credit the person saw.
 *
 * Who is asking comes from the host's verified sender, never from an argument or the message: a
 * colleague on the company record may read any client's cases, a client's contact only their own,
 * and anyone else no case data at all. A client's case is handed to a person only for that client's
 * contact or a colleague; an unknown sender hands on only a case on no client's account.
 *
 * Proposing a credit asks nobody. The desk records the ask when the gate reads the proposal's facts,
 * and `list_cases` says a person has a credit only from then on.
 *
 * Every amount a tool speaks comes back from the desk, every name from the company record, and every
 * next step from a refusal's code.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  APPROVED_FACTS_ARG,
  type ApprovalFactsReader,
  approvedFacts,
  approvedFactsParameter,
  colleague,
  companyEscalationText,
  companyGlossaryText,
  companyPeopleText,
  companyProfileText,
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
  escalationOwner,
  money,
  type Person,
  person,
  personLabel,
} from "./company.js";
import {
  CASE_CATEGORIES,
  type CaseCategory,
  type CaseKind,
  type Credit,
  creditApprovalFacts,
  type DeskRefusal,
  ESCALATION_REASONS,
  type EscalationReason,
  type Invoice,
  type SupportCase,
  type SupportDesk,
  SupportDeskError,
} from "./desk.js";

/** What the tools need: the desk, the company whose clients it serves, and who is asking. */
export interface SupportToolDependencies {
  readonly desk: SupportDesk | undefined;
  readonly company: CompanyFacts;
  /** The host's verified sender of each call's work. Omitted: every sender is unknown. */
  readonly sender?: SenderResolver;
}

/** The ten tools, named, so the factory places each one where the manifest declares it. */
export interface SupportToolset {
  readonly findClient: ToolRegistration;
  readonly listCases: ToolRegistration;
  readonly logCase: ToolRegistration;
  readonly bookReclean: ToolRegistration;
  readonly proposeCredit: ToolRegistration;
  readonly offerCredit: ToolRegistration;
  readonly withdrawCredit: ToolRegistration;
  readonly escalateCase: ToolRegistration;
  readonly resolveCase: ToolRegistration;
  readonly readCompany: ToolRegistration;
  /**
   * The `any_credit` approval's facts: the proposal as the desk holds it, read before anyone is
   * asked. A proposal that is not on the desk, or not pending, has nothing to approve.
   */
  readonly creditFacts: ApprovalFactsReader;
}

/**
 * Who a call's work came from, as far as the case desk is concerned: a colleague on the company
 * record (an internal sender), a client whose contact on the desk is the sender's address, or
 * nobody this role may give case data to.
 */
type Asker =
  | { readonly kind: "colleague"; readonly person: Person }
  | {
      readonly kind: "client";
      readonly clientId: string;
      readonly clientName: string;
      /** The client's contact on the desk: who a case from this sender was raised by. */
      readonly contactName: string;
    }
  | { readonly kind: "unknown" };

/** The company section `read_company` can answer for. */
export type CompanySection =
  | "profile"
  | "hours"
  | "people"
  | "support"
  | "policies"
  | "tone"
  | "escalation"
  | "glossary";

const KINDS: readonly CaseKind[] = ["complaint", "question"];

/** Who raised a case, as recorded when nobody verified the sender. */
const UNVERIFIED_REPORTER = "an unverified sender";

const CASE_ID = Type.String({ description: "The case number, e.g. C-301" });

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A desk record as plain JSON for a result's details. */
function plain(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/** A list of desk records as plain JSON for a result's details. */
function plainList(values: readonly object[]): JsonObject[] {
  return values.map(plain);
}

function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00.000Z`).getUTCDay()] ?? "";
}

function words(value: string): string {
  return value.replace("_", " ");
}

/** A credit proposal in one line: its id, amount, client and invoice line. */
function creditLine(credit: Credit): string {
  return `${credit.id}: ${money(credit.creditCents)} to ${credit.client} on ${credit.invoiceId} line ${credit.line} (${credit.lineName}), case ${credit.caseId}`;
}

/** The crews' hours and the emergency line, as a client is told them. */
function hoursText(company: CompanyFacts): string {
  const { hours } = company;
  return [
    `Office: ${hours.office} (${hours.timezone}).`,
    `Crews: ${hours.crews}.`,
    `Emergencies: ${hours.emergencyLine}.`,
    `Closed: ${hours.closedOn}. ${hours.note}`,
  ].join("\n");
}

/** Who decides complaints, credits, money back and safety, and the re-clean window. */
function supportText(company: CompanyFacts): string {
  const refunds = company.policies.refunds;
  return [
    refunds.summary,
    `Complaints about a visit, and how a service failure is put right: ${personLabel(person(company, refunds.complaintOwner))}.`,
    `Credit notes: ${personLabel(person(company, refunds.creditNeeds))}. Every credit waits for their approval. A credit is never more than the invoice line it is on, and is normally ${money(refunds.serviceRecoveryCreditCents)}.`,
    `Money back (a refund): ${personLabel(person(company, refunds.refundNeeds))}. Nobody else agrees a refund.`,
    `Safety, injury, damage or a break-in: ${personLabel(escalationOwner(company, "safety-incident"))}.`,
    `A re-clean is a return visit at no charge, booked within ${refunds.recleanWindowDays} business days of the complaint.`,
  ].join("\n");
}

/** Putting things right, safety, client data and what is never promised. */
function policiesText(company: CompanyFacts): string {
  return [
    "Putting things right:",
    `- ${company.policies.refunds.summary}`,
    "Safety:",
    ...company.policies.safety.map((rule) => `- ${rule}`),
    "Client data:",
    ...company.policies.dataHandling.map((rule) => `- ${rule}`),
    "Never promised:",
    ...company.policies.commitments.map((rule) => `- ${rule}`),
  ].join("\n");
}

/** Each section `read_company` answers for and how it reads, in the order the model is offered them. */
const COMPANY_SECTIONS: Readonly<Record<CompanySection, (company: CompanyFacts) => string>> = {
  profile: companyProfileText,
  hours: hoursText,
  people: (company) => companyPeopleText(company, "email"),
  support: supportText,
  policies: policiesText,
  tone: companyToneText,
  escalation: companyEscalationText,
  glossary: companyGlossaryText,
};

/**
 * Builds the ten tools over one desk and one company. Every one is plain Pi Durable: they install
 * into any harness, and a harness with no desk builds the same tools and refuses at the point of use.
 */
export function supportTools(dependencies: SupportToolDependencies): SupportToolset {
  const { company } = dependencies;
  const refunds = company.policies.refunds;
  const creditOwner = personLabel(
    person(company, refunds.creditNeeds),
    "the person who approves credits",
  );
  const complaintOwner = personLabel(
    person(company, refunds.complaintOwner),
    "the person who owns complaints",
  );
  const safetyOwner = personLabel(
    escalationOwner(company, "safety-incident"),
    "the person who handles safety",
  );

  /** Who this call's work came from: a colleague, a client on the desk, or nobody known. */
  const asker = async (
    desk: SupportDesk,
    api: { readonly conversationId: unknown; readonly taskId: unknown },
  ): Promise<Asker> => {
    const sender = await dependencies.sender?.({
      conversationId: api.conversationId,
      taskId: api.taskId,
    });
    if (sender === undefined) return { kind: "unknown" };
    // Only an internal sender is a colleague: an outside contact spelling a colleague's address is not.
    const person = colleague(company, sender);
    if (person !== undefined) return { kind: "colleague", person };
    // A client is whoever's contact address on the desk the verified sender is, whole and ignoring
    // case. An internal ticket carrying a client's address (an office trial) is that client too.
    const contact = sender.contact.trim().toLowerCase();
    if (contact === "") return { kind: "unknown" };
    const client = (await desk.findClient(contact)).find(
      (candidate) => candidate.email.toLowerCase() === contact,
    );
    return client === undefined
      ? { kind: "unknown" }
      : {
          kind: "client",
          clientId: client.id,
          clientName: client.name,
          contactName: client.contact,
        };
  };

  /** What an unknown sender is told instead of any case data. */
  const unknownSender = (extra: JsonObject) =>
    refusal(
      "No case data goes to this sender: they are not a client contact on the desk or a colleague on the company record. Share nothing about any case or client. Next: log what they raised with log_case, and tell them it is recorded and a person will look at it.",
      { ...extra, code: "unknown_sender" },
    );

  /** A refusal when this sender may not act on the case, or `undefined` when they may. */
  const outOfReach = async (desk: SupportDesk, who: Asker, caseId: string) => {
    if (who.kind === "colleague") return undefined;
    if (who.kind === "unknown") return unknownSender({ caseId });
    const [entry] = await desk.listCases({ caseId });
    if (entry !== undefined && entry.clientId === who.clientId) return undefined;
    // Another client's case is answered exactly like one that does not exist.
    return refusal(
      `No case ${JSON.stringify(caseId)} is on ${who.clientName}'s account. Find their cases with list_cases. Nothing was written.`,
      { caseId, code: "not_found" },
    );
  };

  /** A desk refusal as the model reads it, with the next step chosen from its code. */
  const refused = (error: unknown, extra: { readonly caseId?: string } & JsonObject) => {
    if (!(error instanceof SupportDeskError)) throw error;
    // The next step comes from the refusal's code, never from reading its message.
    const caseId = error.caseId ?? extra.caseId ?? "the case";
    const creditId = error.creditId ?? "the credit";
    const next: Record<DeskRefusal, string> = {
      not_escalated: ` Next: call escalate_case with caseId ${caseId} and reason safety, which hands it to ${safetyOwner}.`,
      credit_pending: ` ${creditId} on ${caseId} is proposed and not issued: if an approval in this conversation returned a decision, say that decision (record a decline with withdraw_credit); otherwise read the case with list_cases, which says whether ${creditOwner} has been asked. Do not propose another. Leave the case open.`,
      note_names_owner:
        " Next: if the complaint is about them, call escalate_case again with them in about. Otherwise call again with a note that addresses no one. Never drop a name the client used.",
      duplicate_credit: ` ${creditId} is that credit: tell the client where it stands, and do not propose it again.`,
      reclean_pending:
        " Next: leave it open until the re-clean is done, and tell the client its date.",
      escalated: " Next: tell the client who has the case; it is theirs to close.",
      no_one:
        " Next: leave the case open. Tell the client it is recorded and nobody has it yet, and that they can raise it directly with a manager they trust; name no one it is about.",
      outside_window: ` Next: offer a date inside the window, or call escalate_case with reason unresolved, which hands it to ${complaintOwner}.`,
      not_reclean: ` Next: a re-clean is not the remedy here. For a billing complaint, only if the client asks for a credit, propose_credit records one for ${creditOwner}; for safety, damage or anything else, call escalate_case.`,
      credit_changed: ` Next: tell the client the credit was not issued, because it changed after it was put to a person. Read the case again with list_cases before anything else.`,
      already_credited:
        " Tell the client what was credited; nothing more can be offered on this case.",
      already_booked: " Tell the client the date already booked.",
      already_escalated: " Tell the client who already has it.",
      wrong_client: " Next: use a line of the case's own client's invoice, from list_cases.",
      no_account: ` Next: call escalate_case with caseId ${caseId} and reason unresolved, which hands it to ${complaintOwner} to find out who sent it.`,
      // The desk's own message already says what to do for these.
      not_found: "",
      invalid: "",
      closed: "",
      not_a_complaint: "",
    };
    return deskRefusal(`${error.message}${next[error.code]}`, error.code, {
      ...extra,
      ...(error.creditId === undefined ? {} : { creditId: error.creditId }),
    });
  };

  const caseText = (entry: SupportCase): string => {
    const reclean =
      entry.reclean === null
        ? "none"
        : entry.reclean.done
          ? `done on ${entry.reclean.date}`
          : `booked for ${entry.reclean.date}, not done yet`;
    const credit =
      entry.credit === null
        ? "none"
        : entry.credit.status === "issued"
          ? `credit note ${entry.credit.creditNoteId ?? ""}, ${money(entry.credit.creditCents)} on ${entry.credit.invoiceId} line ${entry.credit.line}`
          : // Proposing a credit asks nobody: a person "has it" only once the desk records the ask.
            entry.credit.askedOn === null
            ? `${entry.credit.id}, ${money(entry.credit.creditCents)} on ${entry.credit.invoiceId} line ${entry.credit.line}, proposed and not issued; nobody has been asked yet. Next: call offer_credit with creditId ${entry.credit.id}, which asks ${creditOwner}. Do not call propose_credit for this case.`
            : `${entry.credit.id}, ${money(entry.credit.creditCents)} on ${entry.credit.invoiceId} line ${entry.credit.line}, proposed and put to ${creditOwner}; not issued. If an approval in this conversation returned a decision, say that decision; otherwise say ${creditOwner} has it. Do not call propose_credit or offer_credit for this case.`;
    const escalated =
      entry.escalations.length === 0
        ? "no"
        : entry.escalations
            .map(
              (escalation) =>
                `to ${escalation.toName}, ${escalation.toTitle}, for ${escalation.reason} on ${escalation.on}`,
            )
            .join("; ");
    return [
      `${entry.id} — ${entry.clientId === null ? entry.clientName : `${entry.clientName} (${entry.clientId})`} — ${entry.kind}, ${words(entry.category)} — ${entry.status} — priority ${entry.priority} — opened ${entry.openedOn} by ${entry.reportedBy} (${entry.source}) — first response due ${entry.firstResponseDue}`,
      `  ${entry.summary}`,
      `  re-clean: ${reclean} — credit: ${credit} — escalated: ${escalated}`,
      ...(entry.status === "closed"
        ? [`  closed ${entry.closedOn ?? ""} — outcome: ${entry.outcome ?? ""}`]
        : []),
    ].join("\n");
  };

  /** A client's invoice lines with the desk's credit, and the call that proposes it per open complaint. */
  const invoiceText = (invoices: readonly Invoice[], eligible: readonly SupportCase[]): string[] =>
    invoices.flatMap((invoice) => [
      `Invoice ${invoice.id} (${invoice.period}, issued ${invoice.issuedOn}) — ${invoice.clientName} — total ${money(invoice.totalCents)}:`,
      ...invoice.lines.flatMap((line) => [
        `${invoice.id} line ${line.line} — ${line.name} — ${line.quantity.toLocaleString("en-US")} × ${line.unit} at ${money(line.unitPriceCents)} = ${money(line.lineTotalCents)} — credit if a person approves: ${money(line.creditCents)}`,
        ...eligible.map(
          (entry) =>
            `  Only if the client asks for a credit on ${entry.id}: propose_credit with caseId ${entry.id}, invoiceId ${invoice.id}, line ${line.line}.`,
        ),
      ]),
    ]);

  const findClient = defineTool({
    name: "find_client",
    description:
      "Find a client by all or part of its name, its contact's name, an email, a contract number or words from its site. Returns its id, contact, site, contract and how many of its cases are open. A client's contact finds only their own client; a sender the desk does not know finds none.",
    parameters: Type.Object(
      {
        query: Type.String({
          minLength: 1,
          description: "e.g. Hawthorne Family Dental, a contact's name, or CT-301",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "support");
      // A client's contact sees only its own record, an unknown sender none, a colleague any.
      const who = await asker(desk, api);
      if (who.kind === "unknown") return unknownSender({ found: false, clients: [] });
      const clients = (await desk.findClient(args.query)).filter(
        (client) => who.kind === "colleague" || client.id === who.clientId,
      );
      const details: JsonObject = { found: clients.length > 0, clients: plainList(clients) };
      if (clients.length === 0) {
        return refusal(
          `No client matches ${JSON.stringify(args.query)}. Ask for the name on the contract or the site's address.`,
          details,
        );
      }
      return {
        ...textResult(
          [
            `Clients (${clients.length}):`,
            ...clients.map(
              (client) =>
                `${client.id} — ${client.name} — contact ${client.contact} (${client.email}) — ${client.site} — contract ${client.contractId ?? "none"} — ${client.openCases} ${client.openCases === 1 ? "case" : "cases"} open`,
            ),
          ].join("\n"),
        ),
        details,
      };
    },
  });

  const listCases = defineTool({
    name: "list_cases",
    description:
      "List cases: one by number, or all open or closed. A client's contact sees only their own client's cases, found from who sent the message; a colleague on the company record may name any client; anyone else gets no case data. Each case gives what it is about, its status and priority, its re-clean, credit and escalation. For an open complaint with no credit yet, it lists the client's invoice lines with the credit the desk works out for each, and the exact propose_credit call that records one.",
    parameters: Type.Object(
      {
        clientId: Type.Optional(
          Type.String({
            description:
              "Only for a colleague asking: the client's id from find_client, e.g. CL-101. A client's own cases are found from who sent the message",
          }),
        ),
        caseId: Type.Optional(CASE_ID),
        status: Type.Optional(
          Type.Union([Type.Literal("open"), Type.Literal("closed")], {
            description: "open: everything not closed",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "support");
      const who = await asker(desk, api);
      if (who.kind === "unknown") return unknownSender({ found: false, cases: [], invoices: [] });
      // A client reads only its own cases, whatever client the arguments name.
      const clientId = who.kind === "client" ? who.clientId : args.clientId;
      const cases = await desk.listCases({
        ...(clientId === undefined ? {} : { clientId }),
        ...(args.caseId === undefined ? {} : { caseId: args.caseId }),
        ...(args.status === undefined ? {} : { status: args.status as "open" | "closed" }),
      });
      if (cases.length === 0) {
        return refusal<JsonObject>(
          "No case matches that. Check the case number, or find the client with find_client.",
          { found: false, cases: [], invoices: [] },
        );
      }
      // A credit can be asked for on an open complaint on a client's account that has none yet.
      const eligible = cases.filter(
        (entry) => entry.kind === "complaint" && entry.status !== "closed" && entry.credit === null,
      );
      const clientIds = [
        ...new Set(eligible.flatMap((entry) => (entry.clientId === null ? [] : [entry.clientId]))),
      ];
      const invoiceLines: string[] = [];
      const invoices: Invoice[] = [];
      for (const clientId of clientIds) {
        const own = await desk.listInvoices(clientId);
        invoices.push(...own);
        invoiceLines.push(
          ...invoiceText(
            own,
            eligible.filter((entry) => entry.clientId === clientId),
          ),
        );
      }
      return {
        ...textResult(
          [
            `Cases (${cases.length}):`,
            ...cases.map(caseText),
            ...(invoiceLines.length === 0
              ? []
              : ["Invoice lines, with the credit the desk works out for each:", ...invoiceLines]),
          ].join("\n"),
        ),
        details: { found: true, cases: plainList(cases), invoices: plainList(invoices) },
      };
    },
  });

  const logCase = defineTool({
    name: "log_case",
    description:
      "Log what a client raised as a case: a complaint (something went wrong) or a question, its category, a summary in the client's own terms and the message it came from. Who raised it is recorded from the verified sender. The desk numbers it and sets its priority. An internal record: it sends nothing to the client.",
    parameters: Type.Object(
      {
        clientId: Type.String({ description: "The client's id from find_client, e.g. CL-101" }),
        kind: Type.Union(
          KINDS.map((kind) => Type.Literal(kind)),
          { description: "complaint or question" },
        ),
        category: Type.Union(
          CASE_CATEGORIES.map((category) => Type.Literal(category)),
          {
            description:
              "quality (work done badly), missed_visit, damage, safety (injury, hazard, near miss), billing, staff (about a person), or other",
          },
        ),
        summary: Type.String({ minLength: 1, description: "What the client raised, briefly" }),
        source: Type.String({
          minLength: 1,
          description: "The message it came from: its channel, sender and when",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "support");
      try {
        // A client logs on its own account, whatever client the call names. Nobody verified an
        // unknown sender, so their case goes on no client's account: an unverified complaint never
        // lands on a real client's account. Who raised it always comes from the verified sender,
        // never from the model: the client's contact on the desk, or the colleague on record.
        const who = await asker(desk, api);
        const unknown = who.kind === "unknown";
        const entry = await desk.logCase(
          {
            clientId: who.kind === "client" ? who.clientId : unknown ? null : args.clientId,
            kind: args.kind as CaseKind,
            category: args.category as CaseCategory,
            summary: args.summary,
            reportedBy:
              who.kind === "client"
                ? who.contactName
                : who.kind === "colleague"
                  ? who.person.name
                  : UNVERIFIED_REPORTER,
            source: args.source,
          },
          { requestId: requestId("log", api) },
        );
        // The step follows from the category the desk recorded, never from the summary's words.
        const next =
          entry.category === "safety"
            ? ` Next: a safety complaint goes to a person now: call escalate_case with caseId ${entry.id} and reason safety, which hands it to ${safetyOwner}.`
            : entry.category === "staff"
              ? ` Next: a complaint about a member of staff goes to a person: call escalate_case with caseId ${entry.id}, reason staff and about naming who it is about; the desk keeps it away from them.`
              : "";
        return {
          ...textResult(
            `Logged ${entry.id}${unknown ? "" : ` for ${entry.clientName}`}: ${entry.kind}, ${words(entry.category)}, priority ${entry.priority}. First response due ${entry.firstResponseDue}. This is an internal record: nothing has been sent to the client.${next}`,
          ),
          details: plain(entry),
        };
      } catch (error) {
        return refused(error, { clientId: args.clientId });
      }
    },
  });

  const bookReclean = defineTool({
    name: "book_reclean",
    description:
      "Book a re-clean, a return visit at no charge, for a complaint that a visit fell short (quality or a missed visit), on a date as YYYY-MM-DD. The desk refuses any other kind of case, a date in the past or outside the re-clean window, and a second re-clean on the same case.",
    parameters: Type.Object(
      {
        caseId: CASE_ID,
        date: Type.String({ description: "The re-clean's date, YYYY-MM-DD, e.g. 2026-11-11" }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "support");
      const blocked = await outOfReach(desk, await asker(desk, api), args.caseId);
      if (blocked !== undefined) return blocked;
      try {
        const entry = await desk.bookReclean(
          { caseId: args.caseId, date: args.date },
          { requestId: requestId("reclean", api) },
        );
        const date = entry.reclean?.date ?? args.date;
        return {
          ...textResult(
            `Booked a re-clean for ${entry.id} (${entry.clientName}) on ${weekday(date)} ${date}, at no charge: a return visit to put right the work that fell short. The case stays open until the re-clean is done.`,
          ),
          details: plain(entry),
        };
      } catch (error) {
        return refused(error, { caseId: args.caseId });
      }
    },
  });

  const proposeCredit = defineTool({
    name: "propose_credit",
    description: `Record a proposed credit note on one invoice line for one open complaint, for a person (${creditOwner}) to decide. Give the case, the invoice and the line from list_cases: the desk works out the client and the amount, and you never choose one. It issues nothing: then call offer_credit with the creditId it gives, which asks the person. The desk refuses a second credit on a case. A credit is not money back.`,
    parameters: Type.Object(
      {
        caseId: CASE_ID,
        invoiceId: Type.String({
          description: "The invoice number from list_cases, e.g. INV-2041",
        }),
        line: Type.Integer({ minimum: 1, description: "The invoice line number from list_cases" }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "support");
      const blocked = await outOfReach(desk, await asker(desk, api), args.caseId);
      if (blocked !== undefined) return blocked;
      try {
        const credit = await desk.proposeCredit(
          { caseId: args.caseId, invoiceId: args.invoiceId, line: args.line },
          { requestId: requestId("propose-credit", api) },
        );
        return {
          ...textResult(
            `Proposed credit ${creditLine(credit)}, worked out by the desk. Nothing is issued: a person decides it. Next: call offer_credit with creditId ${credit.id}, which asks ${creditOwner}. If they decline, record it with withdraw_credit for ${credit.id}, reason declined.`,
          ),
          details: plain(credit),
        };
      } catch (error) {
        return refused(error, { caseId: args.caseId });
      }
    },
  });

  /** What a sender is told for a proposal that does not exist, or is not theirs to see. */
  const noSuchCredit = (creditId: string) =>
    `No credit proposal has the id ${JSON.stringify(creditId)}. Nothing was put to a person and nothing was credited. Next: record the credit with propose_credit, which gives its id.`;

  /** The proposal, when this call's sender may see it: a colleague any, a client only its own. */
  const reachableCredit = async (
    desk: SupportDesk,
    creditId: string,
    call: { readonly conversationId: unknown; readonly taskId: unknown },
  ): Promise<Credit | undefined> => {
    const [credit] = await desk.listCredits({ creditId });
    if (credit === undefined) return undefined;
    const who = await asker(desk, call);
    if (who.kind === "colleague") return credit;
    return who.kind === "client" && who.clientId === credit.clientId ? credit : undefined;
  };

  const creditFacts: ApprovalFactsReader = async (args, _context, call) => {
    const desk = requireDesk(dependencies.desk, "support");
    const creditId = String(args.creditId);
    // Another client's proposal reads exactly like one that does not exist, before anyone is asked.
    const credit = await reachableCredit(desk, creditId, call);
    if (credit === undefined) throw new Error(noSuchCredit(creditId));
    if (credit.status === "issued") {
      throw new Error(
        `${credit.id} was already issued as credit note ${credit.creditNoteId ?? ""}. Nothing was put to a person and nothing more was credited. Tell the client what was credited.`,
      );
    }
    if (credit.status === "withdrawn") {
      throw new Error(
        `${credit.id} was withdrawn (${credit.withdrawnReason ?? "no reason recorded"}), so there is nothing to approve. Nothing was put to a person and nothing was credited.`,
      );
    }
    // The gate asks the person next, so the desk records the ask here: from now on list_cases says
    // they have it, in this conversation and any other.
    await desk.markCreditAsked(credit.id);
    return {
      summary: `Issue credit ${creditLine(credit)}, worked out by the desk`,
      facts: creditApprovalFacts(credit),
    };
  };

  const offerCredit = defineTool({
    name: "offer_credit",
    description: `Ask a person (${creditOwner}) to approve one proposed credit, named by the creditId propose_credit gave. The desk reads the proposal (client, case, invoice line and amount) and shows it to the person; every call waits for a person. Once approved, the desk issues exactly that credit, and refuses if the proposal changed since the person saw it. If the person declines, tell the client it was declined and record the decline with withdraw_credit (reason: declined). A credit is not money back.`,
    parameters: Type.Object(
      {
        creditId: Type.String({
          description: "The proposal's id from propose_credit, e.g. CR-401",
        }),
        // Pi Durable re-validates the arguments the gate returns, so the gate's key is declared.
        [APPROVED_FACTS_ARG]: approvedFactsParameter(),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "support");
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return refusal(
          `Nothing was credited: this call for ${args.creditId} carries no facts a person approved. A credit is issued only after the approval gate has put the proposal to a person and they said yes. Next: tell the client a credit needs a person's approval and nothing was issued.`,
          { code: "not_approved", creditId: args.creditId },
        );
      }
      // Checked again at the point of writing: a grant never issues a credit out of the sender's reach.
      if ((await reachableCredit(desk, args.creditId, api)) === undefined) {
        return refusal(noSuchCredit(args.creditId), { code: "not_found", creditId: args.creditId });
      }
      try {
        const note = await desk.issueCredit(
          { creditId: args.creditId, approved },
          { requestId: requestId("credit", api) },
        );
        return {
          ...textResult(
            `Approved and issued: credit note ${note.id} for ${money(note.creditCents)} on ${note.invoiceId} line ${note.line} (${note.lineName}), ${note.clientName}, case ${note.caseId}. It is a credit on the invoice, not money back.`,
          ),
          details: plain(note),
        };
      } catch (error) {
        return refused(error, { creditId: args.creditId });
      }
    },
  });

  const withdrawCredit = defineTool({
    name: "withdraw_credit",
    description:
      "Record that a proposed credit will not be issued, and why: a person declined it, or the client no longer wants it. Only for a credit still waiting for a decision; an issued credit stays. It issues nothing and sends nothing to the client.",
    parameters: Type.Object(
      {
        creditId: Type.String({ description: "The proposal's id, e.g. CR-401" }),
        reason: Type.String({ minLength: 1, description: "Why it will not be issued" }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "support");
      // A proposal out of the sender's reach reads exactly like one that does not exist: no case
      // id, client or state, so ids cannot be probed.
      if ((await reachableCredit(desk, args.creditId, api)) === undefined) {
        return refusal(
          `No credit proposal has the id ${JSON.stringify(args.creditId)}. Nothing was withdrawn. Next: find the case's credit with list_cases.`,
          { code: "not_found", creditId: args.creditId },
        );
      }
      try {
        const withdrawn = await desk.withdrawCredit(
          { creditId: args.creditId, reason: args.reason },
          { requestId: requestId("withdraw-credit", api) },
        );
        return {
          ...textResult(
            `Withdrew credit ${creditLine(withdrawn)}: it will not be issued. Reason: ${(withdrawn.withdrawnReason ?? "").replace(/[.\s]+$/, "")}. This is an internal record: nothing has been sent to the client.`,
          ),
          details: plain(withdrawn),
        };
      } catch (error) {
        return refused(error, { creditId: args.creditId });
      }
    },
  });

  const escalateCase = defineTool({
    name: "escalate_case",
    description:
      "Hand a case to a person. You never choose who: the desk picks who from the company record by the reason: safety (injury, hazard, damage, near miss), refund (money back), billing (an invoice dispute), legal (a claim, insurance, contract terms), data (a client's data or security), staff (a complaint about a member of staff: say who in about), or unresolved (anything you cannot put right). A case is never handed to anyone named in it, its note or who it is about. A client's case is handed on only for that client's own contact or a colleague. It sends nothing to the client.",
    parameters: Type.Object(
      {
        caseId: CASE_ID,
        reason: Type.Union(
          ESCALATION_REASONS.map((reason) => Type.Literal(reason)),
          { description: "Why it goes to a person" },
        ),
        note: Type.String({
          minLength: 1,
          description:
            "What the person needs to know: what happened, in the client's terms. Do not address it to anyone; the desk picks who gets it, and never anyone the note names",
        }),
        about: Type.Optional(
          Type.String({
            description:
              "Only for reason staff or safety: the person the complaint is about, by name or title. Never the person you want the case to go to; the desk picks that.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "support");
      const who = await asker(desk, api);
      const generic =
        "Next: tell them it is recorded and a person will look at it. Share nothing about the case or who has it.";
      // A client may hand on only its own case. An unknown sender may hand on only a case on no
      // client's account, which is where their own are logged: a client's case needs a sender
      // matched to that client. They learn nothing about the case either way, not even that it exists.
      const notHandedOn = () =>
        refusal(`It was not handed on from here. ${generic}`, {
          caseId: args.caseId,
          code: "unknown_sender",
        });
      if (who.kind === "unknown") {
        const [entry] = await desk.listCases({ caseId: args.caseId });
        if (entry !== undefined && entry.clientId !== null) return notHandedOn();
      } else {
        const blocked = await outOfReach(desk, who, args.caseId);
        if (blocked !== undefined) return blocked;
      }
      try {
        const receipt = await desk.escalateCase(
          {
            caseId: args.caseId,
            reason: args.reason as EscalationReason,
            note: args.note,
            ...(args.about === undefined ? {} : { about: args.about }),
          },
          { requestId: requestId("escalate", api) },
        );
        const owner = `${receipt.toName}, ${receipt.toTitle}`;
        const named = `${receipt.toName} (${receipt.toTitle})`;
        const redirected = receipt.redirected
          ? ` The case names the person it would normally go to, so it went to ${named} instead: never say it is with anyone it names.`
          : "";
        if (who.kind === "unknown") {
          return {
            ...textResult(
              `Handed on: a person will look at it. This is an internal hand-off: nothing has been sent to the sender. ${generic}`,
            ),
            details: { caseId: receipt.caseId, reason: receipt.reason },
          };
        }
        const client = ` (${receipt.clientName})`;
        // What to tell the client follows from the reason the desk recorded.
        const tell =
          receipt.reason === "refund"
            ? ` Tell the client plainly that ${named} will decide; promise no money.`
            : ` Tell the client that ${named} has it.`;
        return {
          ...textResult(
            `Handed ${receipt.caseId}${client} to ${owner}, for ${receipt.reason}. Note: ${receipt.note.replace(/[.\s]+$/, "")}.${redirected} This is an internal hand-off: nothing has been sent to the client.${tell}`,
          ),
          details: plain(receipt),
        };
      } catch (error) {
        // An unknown sender learns nothing about the case from a refusal either, not even that the
        // case exists.
        if (who.kind === "unknown" && error instanceof SupportDeskError) return notHandedOn();
        return refused(error, { caseId: args.caseId });
      }
    },
  });

  const resolveCase = defineTool({
    name: "resolve_case",
    description:
      "Close a case with its outcome: what was done and what the client said. The desk refuses a case with a credit proposal not yet issued or withdrawn, a re-clean not yet done, a safety or damage complaint not handed to a person, or a case already handed to someone.",
    parameters: Type.Object(
      {
        caseId: CASE_ID,
        outcome: Type.String({
          minLength: 1,
          description: "What was done to resolve it, and what the client said",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies.desk, "support");
      const blocked = await outOfReach(desk, await asker(desk, api), args.caseId);
      if (blocked !== undefined) return blocked;
      try {
        const entry = await desk.resolveCase(
          { caseId: args.caseId, outcome: args.outcome },
          { requestId: requestId("resolve", api) },
        );
        return {
          ...textResult(
            `Closed ${entry.id} (${entry.clientName}) on ${entry.closedOn ?? ""}. Outcome: ${entry.outcome ?? ""}`,
          ),
          details: plain(entry),
        };
      } catch (error) {
        return refused(error, { caseId: args.caseId });
      }
    },
  });

  const readCompany = readCompanyTool({
    company,
    description:
      "Read one section of the company record: the profile, the hours, the people and what each decides, support (who decides complaints, credits and money back, and the re-clean window), the policies, the tone of voice, the escalation path or the glossary.",
    sections: COMPANY_SECTIONS,
  });

  return {
    findClient,
    listCases,
    logCase,
    bookReclean,
    proposeCredit,
    offerCredit,
    withdrawCredit,
    escalateCase,
    resolveCase,
    readCompany,
    creditFacts,
  };
}
