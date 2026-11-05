/**
 * The Sales / Account Manager's six tools.
 *
 * `list_leads`, `get_quote`, `search_price_book` and `read_company` only read; `create_quote` and `log_activity`
 * write through the desk. No tool decides an approval: the discount and the quote limit are
 * `officehum.json`'s, evaluated by the SDK's gate before the tool runs, which is why this file has no
 * threshold in it at all.
 *
 * The desk is whoever the host binds — `fakeSalesDesk` in a test, an eval or a first run — and every
 * figure a tool speaks comes back from it or from the company record. A tool that cannot reach its
 * desk refuses clearly rather than pretending, the way the Bookkeeper's tools do with no QuickBooks
 * connection.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { type CompanyFacts, money, person, priceText, searchPriceBook } from "./company.js";
import {
  ACTIVITY_KINDS,
  type ActivityKind,
  LEAD_STAGES,
  type Lead,
  type LeadStage,
  type Quote,
  type SalesDesk,
  SalesDeskError,
} from "./desk.js";

/** What the tools need: the desk, and the company they quote for. */
export interface SalesToolDependencies {
  readonly desk: SalesDesk | undefined;
  readonly company: CompanyFacts;
}

/** The six tools, named, so the factory places each one where the manifest declares it. */
export interface SalesToolset {
  readonly listLeads: ToolRegistration;
  readonly getQuote: ToolRegistration;
  readonly searchPriceBook: ToolRegistration;
  readonly createQuote: ToolRegistration;
  readonly logActivity: ToolRegistration;
  readonly readCompany: ToolRegistration;
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

/** The one result shape every tool reports, so a UI reads the same fields either way. */
function textResult(value: string) {
  return { output: [{ type: "text" as const, text: value }] };
}

/** A refusal the model reads, with the same details shape a success carries. */
function refusal<TDetails extends Record<string, unknown>>(value: string, details: TDetails) {
  return { ...textResult(value), isError: true, details };
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

/** A quote read back, line by line, so a re-quote can start from its quantities. */
function quoteDetail(quote: Quote): string {
  const discount =
    quote.discountPercent === 0
      ? "no discount"
      : `discount ${quote.discountPercent}% (${money(quote.discountCents)})`;
  return [
    `Quote ${quote.id} for ${quote.leadName} (${quote.leadId}), ${quote.status}, issued ${quote.issuedOn}, valid until ${quote.validUntil}:`,
    ...quote.lines.map(
      (line) =>
        `- ${line.priceBookItemId ?? "no price book item"} — ${line.description} — ${line.quantity} × ${money(line.unitPriceCents)} = ${money(line.amountCents)}${line.minimumApplied ? " (minimum applied)" : ""}`,
    ),
    `Subtotal ${money(quote.subtotalCents)}, ${discount}, total ${money(quote.totalCents)}.`,
    ...(quote.notes === null ? [] : [`Notes: ${quote.notes}`]),
  ].join("\n");
}

/** The receipt for a quote: what it says, and every minimum that changed a line's price. */
function quoteReceipt(quote: Quote): string {
  const count = quote.lines.length === 1 ? "1 line" : `${quote.lines.length} lines`;
  const discount =
    quote.discountPercent === 0
      ? "no discount"
      : `discount ${quote.discountPercent}% (${money(quote.discountCents)})`;
  const minimums = quote.lines
    .filter((line) => line.minimumApplied)
    .map(
      (line) =>
        `The price book's minimum set the ${line.description} line to ${money(line.amountCents)}.`,
    );
  return [
    `Created draft quote ${quote.id} for ${quote.leadName} (${quote.leadId}): ${count}, subtotal ${money(quote.subtotalCents)}, ${discount}, total ${money(quote.totalCents)}, valid until ${quote.validUntil}.`,
    ...minimums,
  ].join(" ");
}

/** The company record as one section reads: prose the model can answer a client with. */
function companySection(company: CompanyFacts, section: CompanySection): string {
  switch (section) {
    case "profile": {
      const { profile } = company;
      return [
        `${profile.legalName} — trading as ${profile.tradingName}. ${profile.tagline}`,
        `Founded ${profile.founded}. ${profile.headcount} people: ${profile.field.cleaningCrews} cleaning crews of ${profile.field.cleanersPerCrew}, ${profile.field.maintenanceTechnicians} maintenance technicians, ${profile.field.office} in the office.`,
        `${profile.address.street}, ${profile.address.city}, ${profile.address.region} ${profile.address.postalCode}, ${profile.address.country}.`,
        `Phone ${profile.phone}. Email ${profile.email}. Web ${profile.website}. ${profile.registration}.`,
        `Service area: ${profile.serviceArea}`,
        `Insurance: ${profile.insurance.map((cover) => `${cover.kind} ${money(cover.limitCents)}`).join("; ")}. Certificates come from Dana Whitfield.`,
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
        `A quote whose lines come to more than ${money(company.approvalLimits.quoteOverCents)} waits for a person.`,
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
      "Create a draft quote for a lead from price book lines. The desk works out each line amount, any minimum and the total, and a quote with a discount, or one whose lines come to more than the business's quote limit, raises an approval for a person before it is created.",
    parameters: Type.Object(
      {
        leadId: Type.String({ description: "The lead's id from list_leads, e.g. L-204" }),
        lines: Type.Array(
          Type.Object(
            {
              priceBookItemId: Type.Optional(
                Type.String({
                  description:
                    "The price book item the line is priced from, from search_price_book; its price and minimum then apply",
                }),
              ),
              description: Type.Optional(
                Type.String({
                  description: "What the line says; the item's name when it is left out",
                }),
              ),
              quantity: Type.Number({
                description:
                  "How many units: a measured square footage, a count of restrooms, panes, units or visits, or a number of hours",
              }),
              unitPriceCents: Type.Integer({
                description:
                  "The unit price in whole cents, exactly as the price book states it for that item",
              }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, description: "One line per service, each priced from the price book" },
        ),
        discountPercent: Type.Optional(
          Type.Number({
            minimum: 0,
            maximum: 100,
            description:
              "A discount as a percentage of the subtotal. Every discount waits for a person; leave it out when none was agreed",
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
          // rather than a second draft of the same quote.
          { requestId: `quote:${String(api.conversationId)}:${String(api.taskId)}:${api.callId}` },
        );
        return { ...textResult(quoteReceipt(quote)), details: quoteDetails(quote) };
      } catch (error) {
        if (!(error instanceof SalesDeskError)) throw error;
        return refusal(error.message, { id: null, leadId: args.leadId });
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
            requestId: `activity:${String(api.conversationId)}:${String(api.taskId)}:${api.callId}`,
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
    logActivity,
    readCompany,
  };
}
