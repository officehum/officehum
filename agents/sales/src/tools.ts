/**
 * The Sales / Account Manager's seven tools.
 *
 * `list_leads`, `get_quote`, `search_price_book` and `read_company` only read; `create_quote`,
 * `request_quote_approval` and `log_activity` write through the desk. The model names price book items
 * and quantities only: the desk prices every line and works out the total, and decides on that total
 * whether a quote waits for a person. The quote limit is the role's resolved `quote_limit_cents`,
 * read at every call so an overlay applies without a rebuild. A quote that waits is approved through
 * `request_quote_approval`, whose `quote_approval` gate reads what the person approves from the desk
 * (`quoteApprovalFacts`), not from the model's arguments.
 *
 * The desk is whoever the host binds — `fakeSalesDesk` in a test, an eval or a first run — and every
 * figure a tool speaks comes back from it or from the company record. A tool that cannot reach its
 * desk refuses clearly rather than pretending, the way the Bookkeeper's tools do with no QuickBooks
 * connection.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  APPROVED_FACTS_ARG,
  type ApprovalFactsReader,
  approvedFacts,
  approvedFactsParameter,
  deskRefusal,
  refusal,
  requestId,
  textResult,
} from "@officehum/sdk";
import {
  type CompanyFacts,
  escalationRule,
  money,
  person,
  priceText,
  searchPriceBook,
} from "./company.js";
import {
  ACTIVITY_KINDS,
  type ActivityKind,
  LEAD_STAGES,
  type Lead,
  type LeadStage,
  type Quote,
  type QuoteApprovalReason,
  quoteFacts,
  type SalesDesk,
  SalesDeskError,
} from "./desk.js";

/** The limit, in the role's manifest, above which a quote waits for a person. */
const QUOTE_LIMIT = "quote_limit_cents";

/** What the tools need: the desk, the company they quote for, and the role's resolved limits. */
export interface SalesToolDependencies {
  readonly desk: SalesDesk | undefined;
  readonly company: CompanyFacts;
  /**
   * The role's resolved limits, read at every call: the manifest's defaults with the business's
   * overlay applied. With no `quote_limit_cents` in them, every quote waits for a person.
   */
  readonly limits: () => Readonly<Record<string, number>>;
}

/** The seven tools, named, so the factory places each one where the manifest declares it. */
export interface SalesToolset {
  readonly listLeads: ToolRegistration;
  readonly getQuote: ToolRegistration;
  readonly searchPriceBook: ToolRegistration;
  readonly createQuote: ToolRegistration;
  readonly requestQuoteApproval: ToolRegistration;
  readonly logActivity: ToolRegistration;
  readonly readCompany: ToolRegistration;
  /** The `quote_approval` approval's facts: the quote as the desk holds it. */
  readonly quoteApprovalFacts: ApprovalFactsReader;
}

/** The company section `read_company` can answer for. */
export type CompanySection =
  | "profile"
  | "hours"
  | "people"
  | "services"
  | "pricing"
  | "policies"
  | "tone"
  | "escalation"
  | "glossary";

const SECTIONS: readonly CompanySection[] = [
  "profile",
  "hours",
  "people",
  "services",
  "pricing",
  "policies",
  "tone",
  "escalation",
  "glossary",
];

/** The desk, or a refusal: a host with no desk gets no read and no write. */
function requireDesk(dependencies: SalesToolDependencies): SalesDesk {
  if (dependencies.desk === undefined) {
    throw new Error("No sales desk is configured for this role.");
  }
  return dependencies.desk;
}

/** A lead as a UI reads it, amounts in integer cents and nothing optional. */
function leadDetails(lead: Lead) {
  return {
    id: lead.id,
    company: lead.company,
    contactName: lead.contactName,
    email: lead.email,
    site: lead.site,
    stage: lead.stage,
    source: lead.source,
    estimatedValueCents: lead.estimatedValueCents,
    owner: lead.owner,
    lastActivityAt: lead.lastActivityAt,
    notes: lead.notes,
  };
}

/**
 * One lead as the model reads it. The note is on the same line on purpose: a lead's history is the
 * thing that makes the next message right, and a list that hides it makes the model ask again.
 */
function leadLine(lead: Lead): string {
  const worth =
    lead.estimatedValueCents === null ? "" : ` — worth ${money(lead.estimatedValueCents)} a year`;
  return `${lead.id} — ${lead.company} — ${lead.stage} — ${lead.contactName} — ${lead.site}${worth} — last activity ${lead.lastActivityAt} — ${lead.notes}`;
}

/** A quote as a UI reads it. */
function quoteDetails(quote: Quote) {
  return {
    id: quote.id,
    leadId: quote.leadId,
    status: quote.status,
    subtotalCents: quote.subtotalCents,
    discountPercent: quote.discountPercent,
    discountCents: quote.discountCents,
    totalCents: quote.totalCents,
    currency: quote.currency,
    issuedOn: quote.issuedOn,
    validUntil: quote.validUntil,
    lines: quote.lines.map((line) => ({
      priceBookItemId: line.priceBookItemId,
      description: line.description,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      amountCents: line.amountCents,
      minimumApplied: line.minimumApplied,
    })),
  };
}

/** Where a quote stands, in words the model can repeat to a person without overstating it. */
function statusText(quote: Quote): string {
  return quote.status === "awaiting_approval"
    ? "awaiting a person's approval, not ready to send"
    : "draft, ready to send";
}

/** One line as a person reads it: quantity, item, unit price and amount, and any minimum. */
function lineText(line: Quote["lines"][number]): string {
  return `${line.quantity} × ${line.description} at ${money(line.unitPriceCents)} = ${money(line.amountCents)}${line.minimumApplied ? " (minimum applied)" : ""}`;
}

/** Why a quote waits, as one clause: "it carries a 10% discount and it is above the $5,000.00 quote limit". */
function reasonsText(quote: Quote): string {
  const said: Record<QuoteApprovalReason, string> = {
    discount: `it carries a ${quote.discountPercent}% discount`,
    over_limit: `it is above the ${money(quote.quoteLimitCents ?? 0)} quote limit`,
    no_limit: "no quote limit is set for this role, so every quote waits",
  };
  return quote.approvalReasons.map((reason) => said[reason]).join(" and ");
}

/** A quote read back, line by line, so a re-quote can start from its quantities. */
function quoteDetail(quote: Quote): string {
  const discount =
    quote.discountPercent === 0
      ? "no discount"
      : `discount ${quote.discountPercent}% (${money(quote.discountCents)})`;
  return [
    `Quote ${quote.id} for ${quote.leadName} (${quote.leadId}), ${statusText(quote)}, issued ${quote.issuedOn}, valid until ${quote.validUntil}:`,
    ...quote.lines.map(
      (line) =>
        `- ${line.priceBookItemId ?? "no price book item"} — ${line.description} — ${line.quantity} × ${money(line.unitPriceCents)} = ${money(line.amountCents)}${line.minimumApplied ? " (minimum applied)" : ""}`,
    ),
    `Subtotal ${money(quote.subtotalCents)}, ${discount}, total ${money(quote.totalCents)}.`,
    ...(quote.notes === null ? [] : [`Notes: ${quote.notes}`]),
  ].join("\n");
}

/** A quote's totals in one sentence: its lines, subtotal, discount, total and validity. */
function totalsText(quote: Quote): string {
  const count = quote.lines.length === 1 ? "1 line" : `${quote.lines.length} lines`;
  const discount =
    quote.discountPercent === 0
      ? "no discount"
      : `discount ${quote.discountPercent}% (${money(quote.discountCents)})`;
  return `${quote.id} for ${quote.leadName} (${quote.leadId}): ${count}, subtotal ${money(quote.subtotalCents)}, ${discount}, total ${money(quote.totalCents)}, valid until ${quote.validUntil}.`;
}

/** The receipt for a quote ready to send: what it says, and every minimum that changed a line. */
function quoteReceipt(quote: Quote, verb: string): string {
  const minimums = quote.lines
    .filter((line) => line.minimumApplied)
    .map(
      (line) =>
        `The price book's minimum set the ${line.description} line to ${money(line.amountCents)}.`,
    );
  return [`${verb} ${totalsText(quote)}`, "It is ready to send.", ...minimums].join(" ");
}

/** The company record as one section reads: prose the model can answer a client with. */
function companySection(company: CompanyFacts, section: CompanySection): string {
  switch (section) {
    case "profile": {
      const { profile } = company;
      // Certificates sit with contract terms (insurance above ours is one): whoever the company's
      // escalation path names for them, never a name fixed in this package.
      const certificates = person(
        company,
        escalationRule(company, "contract-terms")?.toPersonId ?? "",
      );
      return [
        `${profile.legalName} — trading as ${profile.tradingName}. ${profile.tagline}`,
        `Founded ${profile.founded}. ${profile.headcount} people: ${profile.field.cleaningCrews} cleaning crews of ${profile.field.cleanersPerCrew}, ${profile.field.maintenanceTechnicians} maintenance technicians, ${profile.field.office} in the office.`,
        `${profile.address.street}, ${profile.address.city}, ${profile.address.region} ${profile.address.postalCode}, ${profile.address.country}.`,
        `Phone ${profile.phone}. Email ${profile.email}. Web ${profile.website}. ${profile.registration}.`,
        `Service area: ${profile.serviceArea}`,
        `Insurance: ${profile.insurance.map((cover) => `${cover.kind} ${money(cover.limitCents)}`).join("; ")}.${certificates === undefined ? "" : ` Certificates come from ${certificates.name}.`}`,
        `Clients: ${profile.clients}`,
      ].join("\n");
    }
    case "hours": {
      const { hours } = company;
      return [
        `Office: ${hours.office} (${hours.timezone}).`,
        `Crews: ${hours.crews}.`,
        `Emergency line: ${hours.emergencyLine}.`,
        `Closed: ${hours.closedOn}.`,
        hours.note,
      ].join("\n");
    }
    case "people":
      return company.people
        .map(
          (worker) =>
            `${worker.name} — ${worker.title} — ${worker.email} — decides: ${worker.decides.join("; ")}`,
        )
        .join("\n");
    case "services":
      return company.services
        .map(
          (service) =>
            `${service.name} — ${service.summary} Price book: ${service.priceBookIds.join(", ")}. Lead time about ${service.leadTimeDays} days.`,
        )
        .join("\n\n");
    case "pricing":
      return [
        "The price book, in integer cents behind these figures:",
        ...company.priceBook.map(
          (item) => `${item.id} — ${item.name} — ${priceText(item)} — ${item.category}`,
        ),
      ].join("\n");
    case "policies": {
      const { refunds, discounts } = company.policies;
      const ladder = discounts.ladder
        .map((step) => `${step.commitmentMonths} months: ${step.percent}%`)
        .join(", ");
      return [
        `Complaints and refunds: ${refunds.summary}`,
        `A re-clean is booked within ${refunds.recleanWindowDays} business days. A service-recovery credit is normally ${money(refunds.serviceRecoveryCreditCents)}. Credits: ${person(company, refunds.creditNeeds)?.name ?? refunds.creditNeeds}. Money back: ${person(company, refunds.refundNeeds)?.name ?? refunds.refundNeeds}. Complaints: ${person(company, refunds.complaintOwner)?.name ?? refunds.complaintOwner}.`,
        `Discounts: ${discounts.summary} Approver: ${person(company, discounts.approver)?.name ?? discounts.approver}. Above ${discounts.ownerAbovePercent}%: ${person(company, discounts.ownerApprover)?.name ?? discounts.ownerApprover}. Ladder: ${ladder}.`,
        "Safety:",
        ...company.policies.safety.map((rule) => `- ${rule}`),
        "Data handling:",
        ...company.policies.dataHandling.map((rule) => `- ${rule}`),
        "Never promised:",
        ...company.policies.commitments.map((rule) => `- ${rule}`),
      ].join("\n");
    }
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
          return `${rule.topic} — ${owner?.name ?? rule.toPersonId} (${owner?.email ?? "no email"}) — ${rule.when}`;
        })
        .join("\n");
    case "glossary":
      return company.glossary.map((entry) => `${entry.term}: ${entry.meaning}`).join("\n");
  }
}

/**
 * Builds the six tools over one desk and one company. Every one is plain Pi Durable: they install
 * into any harness, and a bare harness with no desk builds the same tools and refuses at the point of
 * use rather than reaching for a system it does not have.
 */
export function salesTools(dependencies: SalesToolDependencies): SalesToolset {
  const { company } = dependencies;

  /**
   * Who a waiting quote's approval asks, from the company record: the discount approver for a
   * discount, and whoever the escalation path names for a quote over the limit. Never a fixed name.
   */
  const approversOf = (reasons: readonly QuoteApprovalReason[]): string => {
    const ids = reasons.map((reason) =>
      reason === "discount"
        ? company.policies.discounts.approver
        : (escalationRule(company, "quote-over-limit")?.toPersonId ?? ""),
    );
    const names = [...new Set(ids)].map((id) => person(company, id)?.name).filter(Boolean);
    return names.length === 0 ? "the person who approves quotes" : names.join(" and ");
  };

  /** What create_quote says about a quote that waits: saved, not ready, why, and the next call. */
  const awaitingReceipt = (quote: Quote): string =>
    [
      `Saved quote ${quote.id} for ${quote.leadName} (${quote.leadId}), awaiting a person's approval: it is not ready to send, and the client must not be told it is.`,
      ...quote.lines.map((line) => `- ${lineText(line)}`),
      `Quote ${totalsText(quote)}`,
      `It waits because ${reasonsText(quote)}.`,
      `Next: call request_quote_approval with quoteId ${quote.id}, which asks ${approversOf(quote.approvalReasons)}.`,
    ].join("\n");

  const listLeads = defineTool({
    name: "list_leads",
    description:
      "List the leads in the pipeline, optionally filtered by stage or by a search on the company, contact or site. Returns each lead's id, company, contact, stage, site and when it was last touched.",
    parameters: Type.Object(
      {
        stage: Type.Optional(
          Type.Union(
            LEAD_STAGES.map((stage) => Type.Literal(stage)),
            { description: "Only leads in this stage" },
          ),
        ),
        query: Type.Optional(
          Type.String({
            description:
              "All or part of the company, contact name or site, or a lead id such as L-204",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const desk = requireDesk(dependencies);
      const filter = {
        ...(args.stage === undefined ? {} : { stage: args.stage as LeadStage }),
        ...(args.query === undefined ? {} : { query: args.query }),
      };
      const leads = await desk.listLeads(filter);
      const details = { found: leads.length > 0, leads: leads.map(leadDetails) };
      if (leads.length === 0) {
        return refusal(
          "No lead matches that. Try another spelling, a part of the company name, or no filter to see the whole pipeline.",
          details,
        );
      }
      return {
        ...textResult([`Leads (${leads.length}):`, ...leads.map(leadLine)].join("\n")),
        details,
      };
    },
  });

  const getQuoteTool = defineTool({
    name: "get_quote",
    description:
      "Read one quote by its id: its lead, lines, subtotal, discount, total and validity. Use it to re-quote an existing quote, for example with a discount, instead of guessing its quantities.",
    parameters: Type.Object(
      { quoteId: Type.String({ description: "The quote's id, e.g. Q-3047" }) },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const desk = requireDesk(dependencies);
      try {
        const quote = await desk.getQuote(args.quoteId);
        return {
          ...textResult(quoteDetail(quote)),
          details: { found: true, ...quoteDetails(quote) },
        };
      } catch (error) {
        if (!(error instanceof SalesDeskError)) throw error;
        return refusal(error.message, { found: false, id: args.quoteId });
      }
    },
  });

  const searchPriceBookTool = defineTool({
    name: "search_price_book",
    description:
      "Search the company's price book, by the words a client would use, for the item a quote line is built from. Returns each match's id, unit, price and any minimum.",
    parameters: Type.Object(
      {
        query: Type.String({
          description:
            'What the client is asking for, e.g. "deep clean" or "nightly office cleaning"',
        }),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const items = searchPriceBook(company, args.query);
      const details = {
        found: items.length > 0,
        items: items.map((item) => ({
          id: item.id,
          name: item.name,
          unit: item.unit,
          unitPriceCents: item.unitPriceCents,
          minimumCents: item.minimumCents,
          category: item.category,
        })),
      };
      if (items.length === 0) {
        return refusal(
          `The price book has no line matching ${JSON.stringify(args.query)}. A job the book does not cover is priced by a person: say so, and do not estimate it.`,
          details,
        );
      }
      return {
        ...textResult(
          [
            `Price book matches for ${JSON.stringify(args.query)}:`,
            ...items.map(
              (item) => `${item.id} — ${item.name} — ${priceText(item)} — ${item.notes}`,
            ),
          ].join("\n"),
        ),
        details,
      };
    },
  });

  const createQuote = defineTool({
    name: "create_quote",
    description:
      "Create a quote for a lead from price book items and quantities. You give no prices: the desk prices each line from the price book, applies any minimum and works out the total. A quote under the business's quote limit with no discount is a draft ready to send. A quote with a discount, or whose total is above the limit, is saved awaiting a person's approval and is not ready to send: then call request_quote_approval with its quoteId.",
    parameters: Type.Object(
      {
        leadId: Type.String({ description: "The lead's id from list_leads, e.g. L-204" }),
        lines: Type.Array(
          Type.Object(
            {
              priceBookItemId: Type.String({
                description:
                  "The price book item the line is priced from, from search_price_book; its price and minimum then apply. Every line needs one: work the book does not cover is priced by a person",
              }),
              description: Type.Optional(
                Type.String({
                  description: "What the line says; the item's name when it is left out",
                }),
              ),
              quantity: Type.Number({
                description:
                  "How many units: a measured square footage, a count of restrooms, panes, units or visits, or a number of hours. The price comes from the book",
              }),
            },
            { additionalProperties: false },
          ),
          {
            minItems: 1,
            description: "One line per service: an item and a quantity, priced by the desk",
          },
        ),
        discountPercent: Type.Optional(
          Type.Number({
            minimum: 0,
            maximum: 100,
            description:
              "A discount as a percentage of the subtotal. Every discount waits for a person's approval; leave it out when none was asked for",
          }),
        ),
        validForDays: Type.Optional(
          Type.Integer({ minimum: 1, description: "How many days the quote holds, e.g. 30" }),
        ),
        notes: Type.Optional(
          Type.String({ description: "Anything the client should read beside the lines" }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const quote = await desk.createQuote(
          {
            leadId: args.leadId,
            lines: args.lines,
            ...(args.discountPercent === undefined
              ? {}
              : { discountPercent: args.discountPercent }),
            ...(args.validForDays === undefined ? {} : { validForDays: args.validForDays }),
            ...(args.notes === undefined ? {} : { notes: args.notes }),
          },
          // The durable call identity, so a retried call is answered with the quote it already made
          // rather than a second draft of the same quote. The limit is read now, so an overlay's
          // value is the one the desk judges against.
          {
            requestId: requestId("quote", api),
            quoteLimitCents: dependencies.limits()[QUOTE_LIMIT],
          },
        );
        const receipt =
          quote.status === "awaiting_approval"
            ? awaitingReceipt(quote)
            : quoteReceipt(quote, "Created draft quote");
        return { ...textResult(receipt), details: quoteDetails(quote) };
      } catch (error) {
        if (!(error instanceof SalesDeskError)) throw error;
        return refusal(error.message, { id: null, leadId: args.leadId });
      }
    },
  });

  /**
   * The `quote_approval` approval's facts: the quote as the desk holds it, read before anyone is
   * asked. A quote that is not on the desk, or does not wait for approval, has nothing to approve, so
   * it throws and the gate asks nobody.
   */
  const quoteApprovalFacts: ApprovalFactsReader = async (args) => {
    const desk = requireDesk(dependencies);
    const quoteId = String(args.quoteId);
    const quote = await desk.getQuote(quoteId);
    if (quote.status !== "awaiting_approval") {
      throw new Error(
        `${quote.id} is not waiting for a person's approval: it is a draft ready to send. Nothing was put to a person. Next: a new or changed quote is made with create_quote.`,
      );
    }
    const discount = quote.discountPercent === 0 ? "" : `, less ${quote.discountPercent}% discount`;
    return {
      summary: `Approve quote ${quote.id} for ${quote.leadName} (${quote.leadId}): ${quote.lines.map(lineText).join("; ")}. Subtotal ${money(quote.subtotalCents)}${discount}. Total ${money(quote.totalCents)}. It needs a person because ${reasonsText(quote)}`,
      facts: quoteFacts(quote),
    };
  };

  const requestQuoteApproval = defineTool({
    name: "request_quote_approval",
    description:
      "Ask a person to approve one quote that create_quote saved awaiting approval, named by its quoteId. The desk reads the quote's lead, lines, discount and total and shows them to the person; every call waits for a person. Once approved, the quote is a draft ready to send; the desk refuses if it changed since the person saw it.",
    parameters: Type.Object(
      {
        quoteId: Type.String({ description: "The quote's id from create_quote, e.g. Q-3052" }),
        // Pi Durable re-validates the arguments the gate returns, so the gate's key is declared.
        [APPROVED_FACTS_ARG]: approvedFactsParameter(),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      const approved = approvedFacts(args);
      if (approved === undefined) {
        return refusal(
          `Nothing was approved: this call for ${args.quoteId} carries no facts a person approved. A quote is approved only after the approval gate has put it to a person and they said yes. Next: tell the person the quote waits for a person's approval and is not ready to send.`,
          { code: "not_approved", quoteId: args.quoteId },
        );
      }
      try {
        const quote = await desk.approveQuote(
          { quoteId: args.quoteId, approved },
          { requestId: requestId("quote-approval", api) },
        );
        return {
          ...textResult(quoteReceipt(quote, "Approved quote")),
          details: quoteDetails(quote),
        };
      } catch (error) {
        if (!(error instanceof SalesDeskError)) throw error;
        const next =
          error.code === "quote_changed"
            ? " Next: tell the person the quote changed after it was put to a person, so it was not approved; read it again with get_quote before anything else."
            : "";
        return deskRefusal(`${error.message}${next}`, error.code, { quoteId: args.quoteId });
      }
    },
  });

  const logActivity = defineTool({
    name: "log_activity",
    description:
      "Record what happened on a lead — a call, an email, a meeting or a note — with what was decided and what happens next. An internal note: nothing is sent to the client, and it needs no approval.",
    parameters: Type.Object(
      {
        leadId: Type.String({ description: "The lead's id from list_leads, e.g. L-204" }),
        kind: Type.Union(
          ACTIVITY_KINDS.map((kind) => Type.Literal(kind)),
          { description: "What kind of contact this was" },
        ),
        summary: Type.String({
          description:
            "What happened, in the words the next person needs: who was spoken to, what was decided, what comes next",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const activity = await desk.logActivity(
          { leadId: args.leadId, kind: args.kind as ActivityKind, summary: args.summary },
          {
            requestId: requestId("activity", api),
          },
        );
        return {
          ...textResult(
            `Recorded ${activity.kind} ${activity.id} on lead ${activity.leadId} at ${activity.at}: ${activity.summary}`,
          ),
          details: { ...activity },
        };
      } catch (error) {
        if (!(error instanceof SalesDeskError)) throw error;
        return refusal(error.message, { id: null, leadId: args.leadId });
      }
    },
  });

  const readCompany = defineTool({
    name: "read_company",
    description:
      "Read one section of the company record: the profile and contact details, the hours, the people and what each decides, the services, the price book, the policies, the tone of voice, the escalation path or the glossary. Use it to answer a question about the business instead of guessing.",
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
      return {
        ...textResult(companySection(company, section)),
        details: { section },
      };
    },
  });

  return {
    listLeads,
    getQuote: getQuoteTool,
    searchPriceBook: searchPriceBookTool,
    createQuote,
    requestQuoteApproval,
    logActivity,
    readCompany,
    quoteApprovalFacts,
  };
}
