/**
 * The Sales / Account Manager's eleven tools.
 *
 * `list_leads`, `get_quote`, `search_price_book`, `pipeline_report` and `read_company` only read;
 * `create_quote`, `request_quote_approval`, `log_activity`, `update_lead_stage`,
 * `record_quote_outcome` and `schedule_follow_up` write through the desk. The model names price book items
 * and quantities only, and how many visits a week for a recurring line: the desk counts the month,
 * prices every line and works out the total, and decides on that total
 * whether a quote waits for a person. The quote limit is the role's resolved `quote_limit_cents`,
 * read at every call so an overlay applies without a rebuild. A quote that waits is approved through
 * `request_quote_approval`, whose `quote_approval` gate reads what the person approves from the desk
 * (`quoteApprovalFacts`), not from the model's arguments. A stage, a quote's outcome and a follow-up
 * are moved only by the desk, which refuses a step out of order, and `pipeline_report`'s figures are
 * the desk's own counts.
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
  QUOTE_OUTCOMES,
  type Quote,
  type QuoteApprovalReason,
  type QuoteOutcome,
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

/** The eleven tools, named, so the factory places each one where the manifest declares it. */
export interface SalesToolset {
  readonly listLeads: ToolRegistration;
  readonly getQuote: ToolRegistration;
  readonly searchPriceBook: ToolRegistration;
  readonly createQuote: ToolRegistration;
  readonly requestQuoteApproval: ToolRegistration;
  readonly logActivity: ToolRegistration;
  readonly updateLeadStage: ToolRegistration;
  readonly recordQuoteOutcome: ToolRegistration;
  readonly scheduleFollowUp: ToolRegistration;
  readonly pipelineReport: ToolRegistration;
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
    throw new Error(
      "No sales desk is bound to this role, so nothing was read or written. The host passes its system of record as `desk`, or sets `demo` to run on the demonstration data.",
    );
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
    nextFollowUp:
      lead.nextFollowUp === null
        ? null
        : { on: lead.nextFollowUp.on, what: lead.nextFollowUp.what },
  };
}

/**
 * One lead as the model reads it. The note is on the same line on purpose: a lead's history is the
 * thing that makes the next message right, and a list that hides it makes the model ask again.
 */
function leadLine(lead: Lead): string {
  const worth =
    lead.estimatedValueCents === null ? "" : ` — worth ${money(lead.estimatedValueCents)} a year`;
  const next =
    lead.nextFollowUp === null
      ? ""
      : ` — next follow-up ${lead.nextFollowUp.on}: ${lead.nextFollowUp.what}`;
  return `${lead.id} — ${lead.company} — ${lead.stage} — ${lead.contactName} — ${lead.site}${worth} — last activity ${lead.lastActivityAt}${next} — ${lead.notes}`;
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
    sentOn: quote.sentOn,
    acceptedOn: quote.acceptedOn,
    declinedOn: quote.declinedOn,
    lines: quote.lines.map((line) => ({
      priceBookItemId: line.priceBookItemId,
      description: line.description,
      quantity: line.quantity,
      ...(line.recurring === undefined
        ? {}
        : {
            quantityPerVisit: line.recurring.quantityPerVisit,
            visitsPerWeek: line.recurring.visitsPerWeek,
            weeksPerMonth: line.recurring.weeksPerMonth,
          }),
      unitPriceCents: line.unitPriceCents,
      amountCents: line.amountCents,
      minimumApplied: line.minimumApplied,
    })),
  };
}

/** Where a quote stands, in words the model can repeat to a person without overstating it. */
function statusText(quote: Quote): string {
  switch (quote.status) {
    case "awaiting_approval":
      return "awaiting a person's approval, not ready to send";
    case "draft":
      return "draft, ready to send";
    case "sent":
      return `sent on ${quote.sentOn ?? "an unrecorded day"}, no answer recorded`;
    case "accepted":
      return `sent on ${quote.sentOn ?? "an unrecorded day"}, accepted on ${quote.acceptedOn ?? "an unrecorded day"}`;
    case "declined":
      return `sent on ${quote.sentOn ?? "an unrecorded day"}, declined on ${quote.declinedOn ?? "an unrecorded day"}`;
  }
}

/** A count with its noun: "1 lead", "3 leads". */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * How the desk counted a recurring line, as the model quotes it: "5 visits a week × 4.33 weeks =
 * 21.65 visits", or "3 per visit × 5 visits a week × 4.33 weeks = 64.95" when each visit has several
 * units. Empty for a one-off line.
 */
function countText(line: Quote["lines"][number]): string {
  const count = line.recurring;
  if (count === undefined) return "";
  const visits = `${count.visitsPerWeek} ${count.visitsPerWeek === 1 ? "visit" : "visits"} a week × ${count.weeksPerMonth} weeks`;
  return count.quantityPerVisit === 1
    ? `${visits} = ${line.quantity} visits`
    : `${count.quantityPerVisit} per visit × ${visits} = ${line.quantity}`;
}

/** A recurring line's count as a lead-in to its price arithmetic, or nothing for a one-off line. */
function countPrefix(line: Quote["lines"][number]): string {
  return line.recurring === undefined ? "" : `${countText(line)}; `;
}

/** One line as a person reads it: any count, quantity, item, unit price and amount, and any minimum. */
function lineText(line: Quote["lines"][number]): string {
  return `${countPrefix(line)}${line.quantity} × ${line.description} at ${money(line.unitPriceCents)} = ${money(line.amountCents)}${line.minimumApplied ? " (minimum applied)" : ""}`;
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
        `- ${line.priceBookItemId ?? "no price book item"} — ${line.description} — ${countPrefix(line)}${line.quantity} × ${money(line.unitPriceCents)} = ${money(line.amountCents)}${line.minimumApplied ? " (minimum applied)" : ""}`,
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

/**
 * The receipt for a quote ready to send: what it says, the month's count of every recurring line, and
 * every minimum that changed a line.
 */
function quoteReceipt(quote: Quote, verb: string): string {
  const counts = quote.lines
    .filter((line) => line.recurring !== undefined)
    .map((line) => `The desk counted the ${line.description} line as ${countText(line)}.`);
  const minimums = quote.lines
    .filter((line) => line.minimumApplied)
    .map(
      (line) =>
        `The price book's minimum set the ${line.description} line to ${money(line.amountCents)}.`,
    );
  return [`${verb} ${totalsText(quote)}`, "It is ready to send.", ...counts, ...minimums].join(" ");
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
 * Builds the eleven tools over one desk and one company. Every one is plain Pi Durable: they install
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
      "Create a quote for a lead from price book items and quantities. You give no prices and no counts: the desk prices each line from the price book, counts a recurring line's visits in a month from visitsPerWeek, applies any minimum and works out the total. A quote under the business's quote limit with no discount is a draft ready to send. A quote with a discount, or whose total is above the limit, is saved awaiting a person's approval and is not ready to send: then call request_quote_approval with its quoteId.",
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
                  "How many units: a measured square footage, a count of restrooms, panes, units or visits, or a number of hours. With visitsPerWeek, the units on each visit: restrooms per visit, or 1 for a whole-site visit. The price comes from the book",
              }),
              visitsPerWeek: Type.Optional(
                Type.Number({
                  exclusiveMinimum: 0,
                  maximum: 7,
                  description:
                    "For a recurring contract on an item priced per visit: how many visits a week, e.g. 5 for five nights a week. The desk counts the visits in a month and shows the count on the receipt; leave it out for a one-off line",
                }),
              ),
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
        `${quote.id} is not waiting for a person's approval: it is ${statusText(quote)}. Nothing was put to a person. Next: a new or changed quote is made with create_quote.`,
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

  const updateLeadStage = defineTool({
    name: "update_lead_stage",
    description:
      "Move a lead to another pipeline stage — new, qualified, quoted, won or lost — with the reason, which is recorded on the lead. Use it when a lead is qualified, when a quote of it is ready to send, and to close a deal as won or lost once the outcome is known. An internal record: nothing is sent to the client. Won and lost are final here; a person reopens a closed deal.",
    parameters: Type.Object(
      {
        leadId: Type.String({ description: "The lead's id from list_leads, e.g. L-204" }),
        stage: Type.Union(
          LEAD_STAGES.map((stage) => Type.Literal(stage)),
          { description: "The stage the lead moves to" },
        ),
        reason: Type.String({
          description:
            "Why, in the words the next person needs: what was learned or decided, and for a lost deal why it was lost",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const move = await desk.updateLeadStage(
          { leadId: args.leadId, stage: args.stage as LeadStage, reason: args.reason },
          { requestId: requestId("stage", api) },
        );
        const closed =
          move.lead.stage === "won" || move.lead.stage === "lost"
            ? " The deal is closed; a person reopens it if the client's circumstances change."
            : "";
        return {
          ...textResult(
            `Moved ${move.lead.id} (${move.lead.company}) from ${move.from} to ${move.lead.stage}. The reason is recorded on the lead as note ${move.activity.id}: ${move.activity.summary}${closed}`,
          ),
          details: {
            leadId: move.lead.id,
            from: move.from,
            stage: move.lead.stage,
            activityId: move.activity.id,
          },
        };
      } catch (error) {
        if (!(error instanceof SalesDeskError)) throw error;
        const next: Partial<Record<string, string>> = {
          no_ready_quote:
            " Next: a quote is ready to send once create_quote makes a draft, or once a person approves a waiting one through request_quote_approval.",
          closed: " Next: tell the person the deal is closed, and that a person reopens it.",
        };
        return deskRefusal(`${error.message}${next[error.code] ?? ""}`, error.code, {
          leadId: args.leadId,
        });
      }
    },
  });

  /** What follows an outcome: the next tool, never a stage moved on the model's behalf. */
  const outcomeNext: Record<QuoteOutcome, (quote: Quote) => string> = {
    sent: (quote) =>
      `Next: the follow-up cadence counts from ${quote.sentOn ?? quote.issuedOn}; schedule the first touch with schedule_follow_up.`,
    accepted: () =>
      "Next: update_lead_stage to won if the deal is closed. The lead's stage was not changed.",
    declined: () =>
      "Next: update_lead_stage to lost, with the reason, if the deal is over. The lead's stage was not changed.",
  };

  const recordQuoteOutcome = defineTool({
    name: "record_quote_outcome",
    description:
      "Record what happened to a quote: a draft ready to send was sent to the client, or a sent quote was accepted or declined, with the day it happened (today when left out). Use it once it has happened, so a follow-up counts from the day the quote went out. A quote awaiting a person's approval is not ready to send and is never marked sent. An internal record: this tool sends nothing to the client, and it does not change the lead's stage.",
    parameters: Type.Object(
      {
        quoteId: Type.String({ description: "The quote's id, e.g. Q-3047" }),
        outcome: Type.Union(
          QUOTE_OUTCOMES.map((outcome) => Type.Literal(outcome)),
          { description: "sent, accepted or declined" },
        ),
        on: Type.Optional(
          Type.String({
            description: "The day it happened, YYYY-MM-DD; today when left out. Never a future day",
          }),
        ),
        note: Type.Optional(
          Type.String({
            description:
              "Anything the next person needs: who accepted, or why they declined, in their words",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      const outcome = args.outcome as QuoteOutcome;
      try {
        const record = await desk.recordQuoteOutcome(
          {
            quoteId: args.quoteId,
            outcome,
            ...(args.on === undefined ? {} : { on: args.on }),
            ...(args.note === undefined ? {} : { note: args.note }),
          },
          { requestId: requestId("quote-outcome", api) },
        );
        const { quote } = record;
        const day = { sent: quote.sentOn, accepted: quote.acceptedOn, declined: quote.declinedOn }[
          outcome
        ];
        return {
          ...textResult(
            `Recorded ${quote.id} for ${quote.leadName} (${quote.leadId}) as ${outcome} on ${day ?? "an unrecorded day"}, total ${money(quote.totalCents)}. It was ${record.from === "draft" ? "a draft ready to send" : record.from}; it is now ${statusText(quote)}. Noted on the lead as ${record.activity.id}. ${outcomeNext[outcome](quote)}`,
          ),
          details: { ...quoteDetails(quote), from: record.from, activityId: record.activity.id },
        };
      } catch (error) {
        if (!(error instanceof SalesDeskError)) throw error;
        const next: Partial<Record<string, string>> = {
          awaiting_approval:
            " Next: tell the person the quote still waits for a person's approval, so it is not ready to send and the client must not be told it was sent. If nobody has been asked yet, ask with request_quote_approval.",
          invalid_transition: " Next: read the quote with get_quote to see where it stands.",
        };
        return deskRefusal(`${error.message}${next[error.code] ?? ""}`, error.code, {
          quoteId: args.quoteId,
        });
      }
    },
  });

  const scheduleFollowUp = defineTool({
    name: "schedule_follow_up",
    description:
      "Schedule the next touch on a lead for a day, so the cadence is kept by the desk and not only in notes: what the touch is and when it is due. A lead has one open follow-up; scheduling another replaces it, and the result says which. An internal task: nothing is sent to the client.",
    parameters: Type.Object(
      {
        leadId: Type.String({ description: "The lead's id from list_leads, e.g. L-204" }),
        on: Type.String({ description: "The day the touch is due, YYYY-MM-DD; today or later" }),
        what: Type.String({
          description:
            "The touch and what it adds, e.g. 'Call Marisol: is anything in the scope still open?'",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const scheduled = await desk.scheduleFollowUp(
          { leadId: args.leadId, on: args.on, what: args.what },
          { requestId: requestId("follow-up", api) },
        );
        const replaced =
          scheduled.replaced === null
            ? ""
            : ` It replaces the one due ${scheduled.replaced.on}: ${scheduled.replaced.what}`;
        return {
          ...textResult(
            `Scheduled the next touch on lead ${scheduled.leadId} for ${scheduled.followUp.on}: ${scheduled.followUp.what}${replaced}`,
          ),
          details: {
            leadId: scheduled.leadId,
            on: scheduled.followUp.on,
            what: scheduled.followUp.what,
            replaced:
              scheduled.replaced === null
                ? null
                : { on: scheduled.replaced.on, what: scheduled.replaced.what },
          },
        };
      } catch (error) {
        if (!(error instanceof SalesDeskError)) throw error;
        return deskRefusal(error.message, error.code, { leadId: args.leadId });
      }
    },
  });

  const pipelineReport = defineTool({
    name: "pipeline_report",
    description:
      "Count the pipeline: how many leads are in each stage and their estimated yearly value, and how many quotes are in each status with their totals, as the desk counts them. Use it for a pipeline review instead of adding up list_leads yourself.",
    parameters: Type.Object({}, { additionalProperties: false }),
    replay: "safe",
    execute: async () => {
      const desk = requireDesk(dependencies);
      const report = await desk.pipelineReport();
      const leads = report.stages.reduce((total, row) => total + row.count, 0);
      return {
        ...textResult(
          [
            `Pipeline on ${report.asOf}:`,
            ...report.stages.map((row) =>
              row.count === 0
                ? `- ${row.stage} — 0 leads`
                : `- ${row.stage} — ${counted(row.count, "lead")} — ${money(row.valueCents)} estimated a year${row.unvalued === 0 ? "" : ` (${row.unvalued} with no estimate)`}`,
            ),
            "Quotes:",
            ...report.quotes.map(
              (row) =>
                `- ${row.status.replace("_", " ")} — ${counted(row.count, "quote")} — ${money(row.totalCents)}`,
            ),
          ].join("\n"),
        ),
        details: {
          found: leads > 0,
          asOf: report.asOf,
          stages: report.stages.map((row) => ({ ...row })),
          quotes: report.quotes.map((row) => ({ ...row })),
        },
      };
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
    updateLeadStage,
    recordQuoteOutcome,
    scheduleFollowUp,
    pipelineReport,
    readCompany,
    quoteApprovalFacts,
  };
}
