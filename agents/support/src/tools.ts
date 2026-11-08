/**
 * The Customer Support role's eight tools.
 *
 * `find_client`, `list_cases` and `read_company` only read. `log_case`, `book_reclean`,
 * `escalate_case` and `resolve_case` write through the desk with no approval: the desk numbers a case,
 * checks the re-clean window and the kind of complaint a re-clean puts right, picks the person a case
 * goes to from the company record (never the person a complaint is about), and refuses to close a case
 * that still waits for something. `offer_credit` waits for a person on every call; its approval is
 * `officehum.json`'s, evaluated by the SDK's gate before the tool runs. Its arguments carry the client
 * and the credit exactly as the desk worked them out, so the person sees what they approve, and the
 * desk refuses a grant for anything else.
 *
 * Every amount a tool speaks comes back from the desk, every name from the company record, and every
 * next step from a refusal's code.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { type CompanyFacts, escalationOwner, money, person, personLabel } from "./company.js";
import {
  CASE_CATEGORIES,
  type CaseCategory,
  type CaseKind,
  type CreditQuote,
  type DeskRefusal,
  ESCALATION_REASONS,
  type EscalationReason,
  type Invoice,
  type SupportCase,
  type SupportDesk,
  SupportDeskError,
} from "./desk.js";

/** What the tools need: the desk, and the company whose clients it serves. */
export interface SupportToolDependencies {
  readonly desk: SupportDesk | undefined;
  readonly company: CompanyFacts;
}

/** The eight tools, named, so the factory places each one where the manifest declares it. */
export interface SupportToolset {
  readonly findClient: ToolRegistration;
  readonly listCases: ToolRegistration;
  readonly logCase: ToolRegistration;
  readonly bookReclean: ToolRegistration;
  readonly offerCredit: ToolRegistration;
  readonly escalateCase: ToolRegistration;
  readonly resolveCase: ToolRegistration;
  readonly readCompany: ToolRegistration;
}

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

const SECTIONS: readonly CompanySection[] = [
  "profile",
  "hours",
  "people",
  "support",
  "policies",
  "tone",
  "escalation",
  "glossary",
];

const KINDS: readonly CaseKind[] = ["complaint", "question"];

const CASE_ID = Type.String({ description: "The case number, e.g. C-301" });

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The desk, or a refusal: a host with no desk gets no read and no write. */
function requireDesk(dependencies: SupportToolDependencies): SupportDesk {
  if (dependencies.desk === undefined) {
    throw new Error("No support desk is configured for this role.");
  }
  return dependencies.desk;
}

function textResult(value: string) {
  return { output: [{ type: "text" as const, text: value }] };
}

function refusal<TDetails extends JsonObject>(value: string, details: TDetails) {
  return { ...textResult(value), isError: true, details };
}

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

/** The exact offer_credit call that asks for the desk's credit. */
function creditCall(quote: CreditQuote): string {
  return `offer_credit with caseId ${quote.caseId}, client ${JSON.stringify(quote.client)}, invoiceId ${quote.invoiceId}, line ${quote.line}, creditCents ${quote.creditCents}`;
}

/** The company record as one section reads: prose the model can answer with. */
function companySection(company: CompanyFacts, section: CompanySection): string {
  const refunds = company.policies.refunds;
  switch (section) {
    case "profile": {
      const { profile } = company;
      return [
        `${profile.legalName} — trading as ${profile.tradingName}. ${profile.tagline}`,
        `${profile.address.street}, ${profile.address.city}, ${profile.address.region} ${profile.address.postalCode}. Phone ${profile.phone}. Email ${profile.email}.`,
        `Service area: ${profile.serviceArea}`,
        `Clients: ${profile.clients}`,
      ].join("\n");
    }
    case "hours": {
      const { hours } = company;
      return [
        `Office: ${hours.office} (${hours.timezone}).`,
        `Crews: ${hours.crews}.`,
        `Emergencies: ${hours.emergencyLine}.`,
        `Closed: ${hours.closedOn}. ${hours.note}`,
      ].join("\n");
    }
    case "people":
      return company.people
        .map(
          (worker) =>
            `${worker.name} — ${worker.title} — ${worker.email} — decides: ${worker.decides.join("; ")}`,
        )
        .join("\n");
    case "support":
      return [
        refunds.summary,
        `Complaints about a visit, and how a service failure is put right: ${personLabel(person(company, refunds.complaintOwner))}.`,
        `Credit notes: ${personLabel(person(company, refunds.creditNeeds))}. Every credit waits for their approval. A credit is never more than the invoice line it is on, and is normally ${money(refunds.serviceRecoveryCreditCents)}.`,
        `Money back (a refund): ${personLabel(person(company, refunds.refundNeeds))}. Nobody else agrees a refund.`,
        `Safety, injury, damage or a break-in: ${personLabel(escalationOwner(company, "safety-incident"))}.`,
        `A re-clean is a return visit at no charge, booked within ${refunds.recleanWindowDays} business days of the complaint.`,
      ].join("\n");
    case "policies":
      return [
        "Putting things right:",
        `- ${refunds.summary}`,
        "Safety:",
        ...company.policies.safety.map((rule) => `- ${rule}`),
        "Client data:",
        ...company.policies.dataHandling.map((rule) => `- ${rule}`),
        "Never promised:",
        ...company.policies.commitments.map((rule) => `- ${rule}`),
      ].join("\n");
    case "tone":
      return [
        company.tone.summary,
        "Always:",
        ...company.tone.always.map((rule) => `- ${rule}`),
        "Never:",
        ...company.tone.never.map((rule) => `- ${rule}`),
      ].join("\n");
    case "escalation":
      return company.escalation
        .map((rule) => {
          const owner = person(company, rule.toPersonId);
          return `${rule.topic} — ${owner === undefined ? rule.toPersonId : personLabel(owner)} — ${rule.when}`;
        })
        .join("\n");
    case "glossary":
      return company.glossary.map((entry) => `${entry.term}: ${entry.meaning}`).join("\n");
  }
}

/**
 * Builds the eight tools over one desk and one company. Every one is plain Pi Durable: they install
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

  /** The durable call identity, so a retried call is answered with what it already did. */
  const requestId = (
    kind: string,
    api: { conversationId: unknown; taskId: unknown; callId: string },
  ) => `${kind}:${String(api.conversationId)}:${String(api.taskId)}:${api.callId}`;

  /** A desk refusal as the model reads it, with the next step chosen from its code. */
  const refused = (error: unknown, extra: { readonly caseId?: string } & JsonObject) => {
    if (!(error instanceof SupportDeskError)) throw error;
    // The next step comes from the refusal's code, never from reading its message.
    const caseId = error.caseId ?? extra.caseId ?? "the case";
    const next: Partial<Record<DeskRefusal, string>> = {
      not_escalated: ` Next: call escalate_case with caseId ${caseId} and reason safety, which hands it to ${safetyOwner}.`,
      credit_waiting: ` A credit on ${caseId} is already with ${creditOwner}: tell the client it waits for them, and do not ask again. Leave the case open.`,
      reclean_pending:
        " Next: leave it open until the re-clean is done, and tell the client its date.",
      escalated: " Next: tell the client who has the case; it is theirs to close.",
      outside_window: ` Next: offer a date inside the window, or call escalate_case with reason unresolved, which hands it to ${complaintOwner}.`,
      not_reclean: ` Next: a re-clean is not the remedy here. For a billing complaint, offer_credit asks ${creditOwner}; for safety, damage or anything else, call escalate_case.`,
      credit_changed:
        error.quote === undefined
          ? ""
          : ` Next: if the client still wants it, call ${creditCall(error.quote)}.`,
      already_credited:
        " Tell the client what was credited; nothing more can be offered on this case.",
      already_booked: " Tell the client the date already booked.",
      already_escalated: " Tell the client who already has it.",
      wrong_client: " Next: use a line of the case's own client's invoice, from list_cases.",
    };
    return refusal<JsonObject>(`${error.message}${next[error.code] ?? ""}`, {
      ...extra,
      code: error.code,
      ...(error.quote === undefined ? {} : plain(error.quote)),
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
        : entry.credit.status === "waiting"
          ? `${money(entry.credit.creditCents)} on ${entry.credit.invoiceId} line ${entry.credit.line}, waiting for ${creditOwner} (already asked: do not call offer_credit for this case)`
          : `credit note ${entry.credit.creditNoteId ?? ""}, ${money(entry.credit.creditCents)} on ${entry.credit.invoiceId} line ${entry.credit.line}`;
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
      `${entry.id} — ${entry.clientName} (${entry.clientId}) — ${entry.kind}, ${words(entry.category)} — ${entry.status} — priority ${entry.priority} — opened ${entry.openedOn} by ${entry.reportedBy} (${entry.source}) — first response due ${entry.firstResponseDue}`,
      `  ${entry.summary}`,
      `  re-clean: ${reclean} — credit: ${credit} — escalated: ${escalated}`,
      ...(entry.status === "closed"
        ? [`  closed ${entry.closedOn ?? ""} — outcome: ${entry.outcome ?? ""}`]
        : []),
    ].join("\n");
  };

  /** A client's invoice lines with the desk's credit, and the call that asks for it per open complaint. */
  const invoiceText = (invoices: readonly Invoice[], eligible: readonly SupportCase[]): string[] =>
    invoices.flatMap((invoice) => [
      `Invoice ${invoice.id} (${invoice.period}, issued ${invoice.issuedOn}) — ${invoice.clientName} — total ${money(invoice.totalCents)}:`,
      ...invoice.lines.flatMap((line) => [
        `${invoice.id} line ${line.line} — ${line.name} — ${line.quantity.toLocaleString("en-US")} × ${line.unit} at ${money(line.unitPriceCents)} = ${money(line.lineTotalCents)} — credit if a person approves: ${money(line.creditCents)}`,
        ...eligible.map(
          (entry) =>
            `  To ask for it: ${creditCall({ caseId: entry.id, client: entry.clientName, invoiceId: invoice.id, line: line.line, creditCents: line.creditCents })}.`,
        ),
      ]),
    ]);

  const findClient = defineTool({
    name: "find_client",
    description:
      "Find a client by all or part of its name, its contact's name, an email, a contract number or words from its site. Returns its id, contact, site, contract and how many of its cases are open.",
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
    execute: async (args) => {
      const desk = requireDesk(dependencies);
      const clients = await desk.findClient(args.query);
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
      "List cases: a client's, one by number, or all open or closed. Each case gives what it is about, its status and priority, its re-clean, credit and escalation. For a client with an open complaint and no credit yet, it lists the client's invoice lines with the credit the desk works out for each, and the exact offer_credit call that asks a person for it.",
    parameters: Type.Object(
      {
        clientId: Type.Optional(
          Type.String({ description: "The client's id from find_client, e.g. CL-101" }),
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
    execute: async (args) => {
      const desk = requireDesk(dependencies);
      const cases = await desk.listCases({
        ...(args.clientId === undefined ? {} : { clientId: args.clientId }),
        ...(args.caseId === undefined ? {} : { caseId: args.caseId }),
        ...(args.status === undefined ? {} : { status: args.status as "open" | "closed" }),
      });
      if (cases.length === 0) {
        return refusal<JsonObject>(
          "No case matches that. Check the case number, or find the client with find_client.",
          { found: false, cases: [], invoices: [] },
        );
      }
      // A credit can be asked for on an open complaint that has none yet.
      const eligible = cases.filter(
        (entry) => entry.kind === "complaint" && entry.status !== "closed" && entry.credit === null,
      );
      const clientIds = [...new Set(eligible.map((entry) => entry.clientId))];
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
      "Log what a client raised as a case: a complaint (something went wrong) or a question, its category, a summary in the client's own terms, who raised it and the message it came from. The desk numbers it and sets its priority. An internal record: it sends nothing to the client.",
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
        reportedBy: Type.String({ minLength: 1, description: "Who raised it" }),
        source: Type.String({
          minLength: 1,
          description: "The message it came from: its channel, sender and when",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const entry = await desk.logCase(
          {
            clientId: args.clientId,
            kind: args.kind as CaseKind,
            category: args.category as CaseCategory,
            summary: args.summary,
            reportedBy: args.reportedBy,
            source: args.source,
          },
          { requestId: requestId("log", api) },
        );
        // The step follows from the category the desk recorded, never from the summary's words.
        const next =
          entry.category === "safety"
            ? ` Next: a safety complaint goes to a person now: call escalate_case with caseId ${entry.id} and reason safety, which hands it to ${safetyOwner}.`
            : "";
        return {
          ...textResult(
            `Logged ${entry.id} for ${entry.clientName}: ${entry.kind}, ${words(entry.category)}, priority ${entry.priority}. First response due ${entry.firstResponseDue}. This is an internal record: nothing has been sent to the client.${next}`,
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
      const desk = requireDesk(dependencies);
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

  const offerCredit = defineTool({
    name: "offer_credit",
    description: `Ask a person (${creditOwner}) to approve a credit note on one invoice line for one complaint. Give the case, the client, the invoice, the line and the credit exactly as list_cases gave them: you never choose an amount, the desk works it out. Every call waits for a person; once approved, the desk issues exactly that credit, and refuses if the client or amount is not its own. A credit is not money back.`,
    parameters: Type.Object(
      {
        caseId: CASE_ID,
        client: Type.String({
          minLength: 1,
          description: "The client's name exactly as list_cases gave it",
        }),
        invoiceId: Type.String({
          description: "The invoice number from list_cases, e.g. INV-2041",
        }),
        line: Type.Integer({ minimum: 1, description: "The invoice line number from list_cases" }),
        creditCents: Type.Integer({
          minimum: 1,
          description: "The credit in cents exactly as list_cases worked it out, e.g. 15000",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const note = await desk.issueCredit(
          {
            caseId: args.caseId,
            client: args.client,
            invoiceId: args.invoiceId,
            line: args.line,
            creditCents: args.creditCents,
          },
          { requestId: requestId("credit", api) },
        );
        return {
          ...textResult(
            `Approved and issued: credit note ${note.id} for ${money(note.creditCents)} on ${note.invoiceId} line ${note.line} (${note.lineName}), ${note.clientName}, case ${note.caseId}. It is a credit on the invoice, not money back.`,
          ),
          details: plain(note),
        };
      } catch (error) {
        return refused(error, { caseId: args.caseId });
      }
    },
  });

  const escalateCase = defineTool({
    name: "escalate_case",
    description:
      "Hand a case to a person. You never choose who: the desk picks who from the company record by the reason: safety (injury, hazard, damage, near miss), refund (money back), billing (an invoice dispute), legal (a claim, insurance, contract terms), data (a client's data or security), staff (a complaint about a member of staff: say who in about), or unresolved (anything you cannot put right). A complaint is never handed to the person it is about. It sends nothing to the client.",
    parameters: Type.Object(
      {
        caseId: CASE_ID,
        reason: Type.Union(
          ESCALATION_REASONS.map((reason) => Type.Literal(reason)),
          { description: "Why it goes to a person" },
        ),
        note: Type.String({ minLength: 1, description: "What the person needs to know" }),
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
      const desk = requireDesk(dependencies);
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
          ? ` The complaint is about ${receipt.about ?? "them"}, so it went to ${named} instead.`
          : "";
        // What to tell the client follows from the reason the desk recorded.
        const tell =
          receipt.reason === "refund"
            ? ` Tell the client plainly that ${named} will decide; promise no money.`
            : ` Tell the client that ${named} has it.`;
        return {
          ...textResult(
            `Handed ${receipt.caseId} (${receipt.clientName}) to ${owner}, for ${receipt.reason}. Note: ${receipt.note.replace(/[.\s]+$/, "")}.${redirected} This is an internal hand-off: nothing has been sent to the client.${tell}`,
          ),
          details: plain(receipt),
        };
      } catch (error) {
        return refused(error, { caseId: args.caseId });
      }
    },
  });

  const resolveCase = defineTool({
    name: "resolve_case",
    description:
      "Close a case with its outcome: what was done and what the client said. The desk refuses a case with a credit waiting for a person, a re-clean not yet done, a safety complaint not handed to a person, or a case already handed to someone.",
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
      const desk = requireDesk(dependencies);
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

  const readCompany = defineTool({
    name: "read_company",
    description:
      "Read one section of the company record: the profile, the hours, the people and what each decides, support (who decides complaints, credits and money back, and the re-clean window), the policies, the tone of voice, the escalation path or the glossary.",
    parameters: Type.Object(
      {
        section: Type.Union(
          SECTIONS.map((section) => Type.Literal(section)),
          { description: "Which part of the record to read" },
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const section = args.section as CompanySection;
      return { ...textResult(companySection(company, section)), details: { section } };
    },
  });

  return {
    findClient,
    listCases,
    logCase,
    bookReclean,
    offerCredit,
    escalateCase,
    resolveCase,
    readCompany,
  };
}
