/**
 * The desk: the system of record this role reads leads from and writes quotes and notes to.
 *
 * A host binds its own — a CRM, a sales database, a spreadsheet with an API — and the role never
 * knows the difference. `fakeSalesDesk` is what ships with the package: an in-memory pipeline of five
 * leads, the company's own price book, and quote arithmetic that rounds in integer cents, so a test,
 * an eval or a first run needs no network and no credential.
 *
 * The desk owns the arithmetic. A quote's line amount, a minimum, a discount and a total are worked
 * out here and returned in the receipt, never by the model and never by the tool: the same rule as
 * the Bookkeeper's invoices, for the same reason.
 */

import type { PriceBookItem } from "./company.js";
import { loadCompanyFacts, money } from "./company.js";

/** Where a lead is in the pipeline. */
export type LeadStage = "new" | "qualified" | "quoted" | "won" | "lost";

/** Every stage, in pipeline order. */
export const LEAD_STAGES: readonly LeadStage[] = ["new", "qualified", "quoted", "won", "lost"];

/** One lead: a building somebody might clean, and what has happened with it so far. */
export interface Lead {
  id: string;
  company: string;
  contactName: string;
  email: string;
  phone: string | null;
  /** The site, in the client's own terms: size, floors and address. */
  site: string;
  stage: LeadStage;
  source: string;
  /** What the lead is thought to be worth in a year, in integer cents, or `null` when unknown. */
  estimatedValueCents: number | null;
  /** The account manager who owns it, by name. */
  owner: string;
  /** `YYYY-MM-DD`: the day of the last recorded activity. */
  lastActivityAt: string;
  notes: string;
}

/** How a lead is filtered. Both are optional; neither is a wildcard. */
export interface LeadFilter {
  readonly stage?: LeadStage;
  /** All or part of the company, contact or site. */
  readonly query?: string;
}

/** One line of a quote as the caller asks for it. */
export interface QuoteLineDraft {
  /**
   * The price book item the line is priced from; the desk applies its price and its minimum. Required:
   * a line the book does not cover is priced by a person, never by the caller.
   */
  readonly priceBookItemId: string;
  /** What the line says; the item's name when it is omitted. */
  readonly description?: string;
  /** How many units, which may be fractional for hours and months. */
  readonly quantity: number;
  /** The unit price in integer cents, which must be the book's own for a priced item. */
  readonly unitPriceCents: number;
}

/** A quote as the caller asks for it. */
export interface QuoteDraft {
  readonly leadId: string;
  readonly lines: readonly QuoteLineDraft[];
  readonly discountPercent?: number;
  readonly validForDays?: number;
  readonly notes?: string;
}

/** One line of a quote as the desk worked it out. */
export interface QuoteLine {
  readonly priceBookItemId: string | null;
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  /** The line's amount in integer cents: quantity times unit price, or the item's minimum. */
  readonly amountCents: number;
  /** True when the item's minimum raised this line above what the quantity came to. */
  readonly minimumApplied: boolean;
}

/** A quote once the desk has priced it. */
export interface Quote {
  readonly id: string;
  readonly leadId: string;
  readonly leadName: string;
  readonly status: "draft";
  readonly currency: "USD";
  readonly lines: readonly QuoteLine[];
  readonly subtotalCents: number;
  readonly discountPercent: number;
  readonly discountCents: number;
  readonly totalCents: number;
  readonly issuedOn: string;
  readonly validUntil: string;
  readonly notes: string | null;
}

/** What happened on a lead, as it is recorded. */
export type ActivityKind = "call" | "email" | "meeting" | "note";

/** The activity kinds a note may be. */
export const ACTIVITY_KINDS: readonly ActivityKind[] = ["call", "email", "meeting", "note"];

/** One activity to record. */
export interface ActivityDraft {
  readonly leadId: string;
  readonly kind: ActivityKind;
  readonly summary: string;
}

/** One recorded activity. */
export interface Activity {
  readonly id: string;
  readonly leadId: string;
  readonly kind: ActivityKind;
  readonly summary: string;
  readonly at: string;
}

/** What the role needs from whatever system holds its leads and quotes. */
export interface SalesDesk {
  listLeads(filter?: LeadFilter): Promise<readonly Lead[]>;
  /** One quote by its id, or a `SalesDeskError` naming the id when there is none. */
  getQuote(id: string): Promise<Quote>;
  createQuote(draft: QuoteDraft, options: { readonly requestId: string }): Promise<Quote>;
  logActivity(entry: ActivityDraft, options: { readonly requestId: string }): Promise<Activity>;
}

/** A refusal the model reads: a lead that does not exist, a price that is not the book's. */
export class SalesDeskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesDeskError";
  }
}

export interface FakeSalesDeskOptions {
  /** The pipeline; the demo one when omitted. */
  readonly leads?: readonly Lead[];
  /** The quotes already made; the demo one when omitted. */
  readonly quotes?: readonly Quote[];
  /** The price book quotes are validated against; the company's own when omitted. */
  readonly priceBook?: readonly PriceBookItem[];
  /** The clock, so a receipt's dates are reproducible in a test. */
  readonly now?: () => Date;
}

/**
 * The five leads the package ships with, dated so they stay plausible: an enquiry from last week, one
 * that has been quoted and gone quiet, and one that arrived yesterday. They are demonstration data,
 * not part of the company record, and a host that binds a real desk never sees them.
 */
export function demoLeads(): readonly Lead[] {
  return [
    {
      id: "L-204",
      company: "Riverside Dental",
      contactName: "Dr. Alice Nguyen",
      email: "alice@riversidedental.example",
      phone: "+1 503 555 0171",
      site: "3,200 sq ft suite, 1414 SE Hawthorne Boulevard, Portland",
      stage: "new",
      source: "referral from Harborview Property Management",
      estimatedValueCents: null,
      owner: "Marcus Oyelaran",
      lastActivityAt: "2026-10-28",
      notes:
        "Moving into the second suite in January and wants the first deep clean done before the chairs go in.",
    },
    {
      id: "L-207",
      company: "Cascadia Legal Group",
      contactName: "Marisol Vega",
      email: "marisol@cascadialegal.example",
      phone: "+1 503 555 0172",
      site: "2,800 sq ft over two floors, 1211 SW Fifth Avenue, Portland",
      stage: "qualified",
      source: "website enquiry",
      estimatedValueCents: 400525,
      owner: "Marcus Oyelaran",
      lastActivityAt: "2026-10-22",
      notes:
        "Weekday nights, five nights a week. Wants the scope in writing before the quote goes to her partner.",
    },
    {
      id: "L-211",
      company: "Bramble & Co",
      contactName: "Nina Alvarez",
      email: "nina@brambleandco.example",
      phone: null,
      site: "three bakery sites, kitchens and front of house, Pearl District",
      stage: "quoted",
      source: "walk-in",
      estimatedValueCents: 320000,
      owner: "Marcus Oyelaran",
      lastActivityAt: "2026-10-15",
      notes: "Quote Q-3047 went out three weeks ago and nobody has answered it.",
    },
    {
      id: "L-215",
      company: "Lloyd Center Pediatrics",
      contactName: "Dr. Peter Osei",
      email: "peter@lloydcenterpeds.example",
      phone: "+1 503 555 0173",
      site: "4,100 sq ft clinic, 1800 NE Lloyd Boulevard, Portland",
      stage: "new",
      source: "phone call to the office",
      estimatedValueCents: null,
      owner: "Marcus Oyelaran",
      lastActivityAt: "2026-10-30",
      notes: "Asked about nightly cleaning and restroom supplies. No walkthrough booked yet.",
    },
    {
      id: "L-219",
      company: "Harborview Property Management",
      contactName: "Grace Lin",
      email: "grace@harborviewpm.example",
      phone: "+1 503 555 0174",
      site: "six buildings, about 40,000 sq ft in total, downtown and the Central Eastside",
      stage: "new",
      source: "referral from Cascadia Legal Group",
      estimatedValueCents: null,
      owner: "Marcus Oyelaran",
      lastActivityAt: "2026-10-31",
      notes: "Wants one contract across six buildings. A committee decides, and they meet monthly.",
    },
  ];
}

/**
 * The one quote the demo pipeline already holds: Q-3047, sent to Bramble & Co three weeks before the
 * demo date. Each line is a real price book item, so the amounts are what `createQuote` would make:
 * 12,000 sq ft of first-visit deep clean, 24 restroom sanitises, and three HVAC filters.
 */
export function demoQuotes(): readonly Quote[] {
  const lines: QuoteLine[] = [
    {
      priceBookItemId: "clean-deep-sqft",
      description: "Deep clean, first visit",
      quantity: 12000,
      unitPriceCents: 12,
      amountCents: 144000,
      minimumApplied: false,
    },
    {
      priceBookItemId: "restroom-sanitise",
      description: "Restroom sanitising",
      quantity: 24,
      unitPriceCents: 6500,
      amountCents: 156000,
      minimumApplied: false,
    },
    {
      priceBookItemId: "hvac-filter",
      description: "HVAC filter change",
      quantity: 3,
      unitPriceCents: 4500,
      amountCents: 13500,
      minimumApplied: false,
    },
  ];
  const subtotalCents = lines.reduce((total, line) => total + line.amountCents, 0);
  return [
    {
      id: "Q-3047",
      leadId: "L-211",
      leadName: "Bramble & Co",
      status: "draft",
      currency: "USD",
      lines,
      subtotalCents,
      discountPercent: 0,
      discountCents: 0,
      totalCents: subtotalCents,
      issuedOn: "2026-10-15",
      validUntil: "2026-11-14",
      notes: null,
    },
  ];
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of a date, in UTC: the only date form a receipt carries. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Whether a name or a word appears in a lead's company, contact or site. */
function matches(lead: Lead, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return true;
  return (
    lead.company.toLowerCase().includes(wanted) ||
    lead.contactName.toLowerCase().includes(wanted) ||
    lead.site.toLowerCase().includes(wanted) ||
    lead.id.toLowerCase() === wanted
  );
}

/** An in-memory desk: the demo pipeline, the company's price book, and nothing that leaves the process. */
export function fakeSalesDesk(options: FakeSalesDeskOptions = {}): SalesDesk {
  const priceBook = options.priceBook ?? loadCompanyFacts().priceBook;
  const clock = options.now ?? (() => new Date());
  const leads: Lead[] = (options.leads ?? demoLeads()).map((lead) => ({ ...lead }));
  const quoteByRequest = new Map<string, Quote>();
  const quotesById = new Map<string, Quote>((options.quotes ?? demoQuotes()).map((q) => [q.id, q]));
  const activityByRequest = new Map<string, Activity>();
  let quoteNumber = 3050;
  let activityNumber = 0;

  const findLead = (id: string): Lead => {
    const lead = leads.find((candidate) => candidate.id === id.trim());
    if (lead === undefined) {
      const known = leads.map((candidate) => `${candidate.id} (${candidate.company})`).join(", ");
      throw new SalesDeskError(
        `No lead has the id ${JSON.stringify(id)}. The pipeline holds: ${known}.`,
      );
    }
    return lead;
  };

  const priceLine = (line: QuoteLineDraft, where: string): QuoteLine => {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      throw new SalesDeskError(`${where} needs a quantity greater than zero.`);
    }
    if (!Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents < 0) {
      throw new SalesDeskError(`${where} needs a unit price in whole cents.`);
    }
    // Checked here as well as in the tool's schema, so no caller can price a line off the book.
    if (typeof line.priceBookItemId !== "string" || line.priceBookItemId.trim() === "") {
      throw new SalesDeskError(
        `${where} has no price book item, and a person prices work the price book does not cover. Find the item with search_price_book, or tell the client a person will price it.`,
      );
    }
    const item = priceBook.find((candidate) => candidate.id === line.priceBookItemId);
    if (item === undefined) {
      throw new SalesDeskError(
        `${where} names ${JSON.stringify(line.priceBookItemId)}, which is not in the price book. A person prices work the book does not cover.`,
      );
    }
    if (item.unitPriceCents !== line.unitPriceCents) {
      throw new SalesDeskError(
        `The price book prices ${item.name} at ${money(item.unitPriceCents)} per ${item.unit}; ${where} says ${money(line.unitPriceCents)}. Quote the book's price.`,
      );
    }
    const priced = Math.round(line.quantity * line.unitPriceCents);
    const minimum = item.minimumCents;
    const applies = minimum !== null && priced < minimum;
    return {
      priceBookItemId: item.id,
      description: line.description ?? item.name,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      amountCents: applies ? minimum : priced,
      minimumApplied: applies,
    };
  };

  return {
    async listLeads(filter: LeadFilter = {}): Promise<readonly Lead[]> {
      return leads
        .filter((lead) => filter.stage === undefined || lead.stage === filter.stage)
        .filter((lead) => filter.query === undefined || matches(lead, filter.query))
        .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))
        .map((lead) => ({ ...lead }));
    },

    async getQuote(id: string): Promise<Quote> {
      const quote = quotesById.get(id.trim());
      if (quote === undefined) {
        const known = [...quotesById.keys()].join(", ");
        throw new SalesDeskError(
          `No quote has the id ${JSON.stringify(id)}. The desk holds: ${known === "" ? "no quotes" : known}.`,
        );
      }
      return quote;
    },

    async createQuote(
      draft: QuoteDraft,
      { requestId }: { readonly requestId: string },
    ): Promise<Quote> {
      // A retried call is answered with the quote it already made: a quote is one event, however many
      // times a task is replayed.
      const prior = quoteByRequest.get(requestId);
      if (prior !== undefined) return prior;

      const lead = findLead(draft.leadId);
      if (draft.lines.length === 0) {
        throw new SalesDeskError("A quote needs at least one line.");
      }
      const lines = draft.lines.map((line, index) => priceLine(line, `Line ${index + 1}`));
      const subtotalCents = lines.reduce((total, line) => total + line.amountCents, 0);
      const discountPercent = draft.discountPercent ?? 0;
      if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
        throw new SalesDeskError("A discount is a percentage from zero to one hundred.");
      }
      if (discountPercent > 0 && subtotalCents === 0) {
        throw new SalesDeskError("There is nothing on this quote to discount.");
      }
      const discountCents = Math.round((subtotalCents * discountPercent) / 100);
      const now = clock();
      const validForDays = draft.validForDays ?? 30;
      if (!Number.isSafeInteger(validForDays) || validForDays <= 0) {
        throw new SalesDeskError("validForDays must be a whole number of days greater than zero.");
      }
      quoteNumber += 1;
      const quote: Quote = {
        id: `Q-${quoteNumber}`,
        leadId: lead.id,
        leadName: lead.company,
        status: "draft",
        currency: "USD",
        lines,
        subtotalCents,
        discountPercent,
        discountCents,
        totalCents: subtotalCents - discountCents,
        issuedOn: isoDate(now),
        validUntil: isoDate(new Date(now.getTime() + validForDays * DAY_MS)),
        notes: draft.notes ?? null,
      };
      quoteByRequest.set(requestId, quote);
      quotesById.set(quote.id, quote);
      lead.stage = "quoted";
      lead.lastActivityAt = quote.issuedOn;
      lead.estimatedValueCents ??= quote.totalCents;
      return quote;
    },

    async logActivity(
      entry: ActivityDraft,
      { requestId }: { readonly requestId: string },
    ): Promise<Activity> {
      const prior = activityByRequest.get(requestId);
      if (prior !== undefined) return prior;
      const lead = findLead(entry.leadId);
      const summary = entry.summary.trim();
      if (summary === "") throw new SalesDeskError("An activity needs a summary of what happened.");
      if (!ACTIVITY_KINDS.includes(entry.kind)) {
        throw new SalesDeskError(
          `An activity is one of ${ACTIVITY_KINDS.join(", ")}; ${JSON.stringify(entry.kind)} is not.`,
        );
      }
      activityNumber += 1;
      const at = clock().toISOString();
      const activity: Activity = {
        id: `A-${activityNumber}`,
        leadId: lead.id,
        kind: entry.kind,
        summary,
        at,
      };
      activityByRequest.set(requestId, activity);
      lead.lastActivityAt = at.slice(0, 10);
      return activity;
    },
  };
}
