/**
 * The desk: the system of record this role reads leads from and writes quotes and notes to.
 *
 * A host binds its own — a CRM, a sales database, a spreadsheet with an API — and the role never
 * knows the difference. `fakeSalesDesk` is what ships with the package: an in-memory pipeline of five
 * leads, the company's own price book, and quote arithmetic that rounds in integer cents, so a test,
 * an eval or a first run needs no network and no credential.
 *
 * The desk owns the arithmetic. A quote's unit prices, line amounts, minimums, discount and total are
 * worked out here and returned in the receipt, never by the model and never by the tool: the same
 * rule as the Bookkeeper's invoices, for the same reason. The caller names price book items and
 * quantities only, and for a recurring per-visit line how many visits a week: the desk counts the
 * visits in a month from the company's weeks in a month.
 *
 * The desk also decides whether a person must approve a quote, on the total it worked out itself, so
 * a minimum that raises a line counts towards the limit. A quote with a discount, or over the limit,
 * is saved awaiting approval and becomes a draft ready to send only through `approveQuote`, with the
 * facts a person was shown (`quoteFacts`): the same two steps as Purchasing's draft orders.
 */

import { sameFacts } from "@officehum/sdk";
import type { PriceBookItem } from "./company.js";
import { loadCompanyFacts, money } from "./company.js";
import { demoLeads, demoQuotes } from "./demo.js";

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
  /**
   * How many units, which may be fractional for hours and months. The book sets the price. With
   * `visitsPerWeek`, the units on each visit: restrooms per visit, or 1 for a whole-site visit.
   */
  readonly quantity: number;
  /**
   * For a recurring line priced per visit: how many visits a week, more than zero and at most seven.
   * The desk then bills `quantity × visitsPerWeek × weeksPerMonth`, so nobody counts a month by hand.
   */
  readonly visitsPerWeek?: number;
}

/** A quote as the caller asks for it. */
export interface QuoteDraft {
  readonly leadId: string;
  readonly lines: readonly QuoteLineDraft[];
  readonly discountPercent?: number;
  readonly validForDays?: number;
  readonly notes?: string;
}

/** How the desk counted a recurring line's units for a month, so the receipt can show the count. */
export interface RecurringCount {
  /** The units on each visit, as the caller gave them in `quantity`. */
  readonly quantityPerVisit: number;
  readonly visitsPerWeek: number;
  /** The company's weeks in a month when the line was priced. */
  readonly weeksPerMonth: number;
}

/** One line of a quote as the desk worked it out. */
export interface QuoteLine {
  readonly priceBookItemId: string | null;
  readonly description: string;
  /** The units billed: for a recurring line, the month's count the desk worked out. */
  readonly quantity: number;
  /** How a recurring line's quantity was counted; absent on a one-off line. */
  readonly recurring?: RecurringCount;
  readonly unitPriceCents: number;
  /** The line's amount in integer cents: quantity times unit price, or the item's minimum. */
  readonly amountCents: number;
  /** True when the item's minimum raised this line above what the quantity came to. */
  readonly minimumApplied: boolean;
}

/**
 * Where a quote stands: `awaiting_approval` is saved but not ready to send until a person approves
 * it; `draft` is ready to send, because it needed no approval or a person gave it.
 */
export type QuoteStatus = "draft" | "awaiting_approval";

/**
 * Why a quote needed a person: a discount, a total over the limit, or no limit the desk could read
 * (so it holds the quote rather than guessing one).
 */
export type QuoteApprovalReason = "discount" | "over_limit" | "no_limit";

/** A quote once the desk has priced it. */
export interface Quote {
  readonly id: string;
  readonly leadId: string;
  readonly leadName: string;
  readonly status: QuoteStatus;
  /** Why a person had to approve it, in the order discount, limit; empty when nobody had to. */
  readonly approvalReasons: readonly QuoteApprovalReason[];
  /** The quote limit the desk judged it against when it was made, or `null` when none resolved. */
  readonly quoteLimitCents: number | null;
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
  /**
   * Prices a quote from the book and saves it: a `draft` ready to send, or `awaiting_approval` when it
   * carries a discount or its subtotal is above `quoteLimitCents`. A line with `visitsPerWeek` must
   * name an item priced per visit; a host desk bills it `quantity × visitsPerWeek × weeksPerMonth`,
   * with the company's `quoting.weeksPerMonth`, and records that count in `recurring`. A host desk must hold every quote
   * for approval when `quoteLimitCents` is `undefined`, never treat a missing limit as no limit.
   */
  createQuote(
    draft: QuoteDraft,
    options: { readonly requestId: string; readonly quoteLimitCents: number | undefined },
  ): Promise<Quote>;
  /**
   * Makes a quote that awaits approval a draft ready to send. Called only once a person approved it,
   * with the facts the approval gate read from this desk and showed them (`quoteFacts`). A host desk
   * must refuse with `quote_changed` when the quote no longer equals `approved`, and with
   * `not_awaiting_approval` when it is not waiting for one.
   */
  approveQuote(
    input: { readonly quoteId: string; readonly approved: Readonly<Record<string, unknown>> },
    options: { readonly requestId: string },
  ): Promise<Quote>;
  logActivity(entry: ActivityDraft, options: { readonly requestId: string }): Promise<Activity>;
}

/** Why the desk refused, so a tool can say what to do next without parsing the message. */
export type SalesDeskRefusal = "invalid" | "not_found" | "not_awaiting_approval" | "quote_changed";

/** A refusal the model reads: a lead that does not exist, an item that is not in the book. */
export class SalesDeskError extends Error {
  readonly code: SalesDeskRefusal;

  constructor(message: string, code: SalesDeskRefusal = "invalid") {
    super(message);
    this.name = "SalesDeskError";
    this.code = code;
  }
}

/**
 * The facts a person approves on a quote: its lead, each line's item, visits a week, quantity and
 * amount, the discount and the total. Its status is left out on purpose: approving is what changes it.
 */
export function quoteFacts(quote: Quote): Record<string, unknown> {
  return {
    id: quote.id,
    leadId: quote.leadId,
    lines: quote.lines.map((line) => ({
      priceBookItemId: line.priceBookItemId,
      visitsPerWeek: line.recurring?.visitsPerWeek ?? null,
      quantity: line.quantity,
      amountCents: line.amountCents,
    })),
    discountPercent: quote.discountPercent,
    totalCents: quote.totalCents,
  };
}

export interface FakeSalesDeskOptions {
  /** The pipeline; the demo one when omitted. */
  readonly leads?: readonly Lead[];
  /** The quotes already made; the demo one when omitted. */
  readonly quotes?: readonly Quote[];
  /** The price book quotes are validated against; the company's own when omitted. */
  readonly priceBook?: readonly PriceBookItem[];
  /** The weeks in a month a recurring line is counted with; the company's own when omitted. */
  readonly weeksPerMonth?: number;
  /** The clock, so a receipt's dates are reproducible in a test. */
  readonly now?: () => Date;
}

const DAY_MS = 86_400_000;

/** The most visits a week a recurring line may ask for: one a day. */
const MAX_VISITS_PER_WEEK = 7;

/** Whether an item is priced per visit, by its unit: "visit", "restroom per visit". */
function perVisit(item: PriceBookItem): boolean {
  return /\bvisit\b/i.test(item.unit);
}

/**
 * A month's units for a recurring line, to the hundredth: the handbook's count is not rounded to whole
 * visits. Rounded half up in hundredths after the multiplication, through `toFixed`'s shortest decimal
 * so a float such as 64.94999… still reads as the 64.95 a person works out.
 */
function monthlyQuantity(count: RecurringCount): number {
  const exact = count.quantityPerVisit * count.visitsPerWeek * count.weeksPerMonth;
  return Math.round(Number((exact * 100).toPrecision(12))) / 100;
}

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
  const weeksPerMonth = options.weeksPerMonth ?? loadCompanyFacts().quoting.weeksPerMonth;
  const clock = options.now ?? (() => new Date());
  const leads: Lead[] = (options.leads ?? demoLeads()).map((lead) => ({ ...lead }));
  const quoteByRequest = new Map<string, Quote>();
  const quotesById = new Map<string, Quote>((options.quotes ?? demoQuotes()).map((q) => [q.id, q]));
  const approvalByRequest = new Map<string, Quote>();
  const activityByRequest = new Map<string, Activity>();
  let quoteNumber = 3050;
  /** The next quote number the desk does not already hold. */
  const nextQuoteId = (): string => {
    do quoteNumber += 1;
    while (quotesById.has(`Q-${quoteNumber}`));
    return `Q-${quoteNumber}`;
  };
  let activityNumber = 0;

  const findLead = (id: string): Lead => {
    const lead = leads.find((candidate) => candidate.id === id.trim());
    if (lead === undefined) {
      const known = leads.map((candidate) => `${candidate.id} (${candidate.company})`).join(", ");
      throw new SalesDeskError(
        `No lead has the id ${JSON.stringify(id)}. The pipeline holds: ${known}.`,
        "not_found",
      );
    }
    return lead;
  };

  const findQuote = (id: string): Quote => {
    const quote = quotesById.get(id.trim());
    if (quote === undefined) {
      const known = [...quotesById.keys()].join(", ");
      throw new SalesDeskError(
        `No quote has the id ${JSON.stringify(id)}. The desk holds: ${known === "" ? "no quotes" : known}.`,
        "not_found",
      );
    }
    return quote;
  };

  /** A lead is quoted once a quote is ready to send, not while one waits for a person. */
  const markQuoted = (lead: Lead, quote: Quote): void => {
    lead.stage = "quoted";
    lead.estimatedValueCents ??= quote.totalCents;
  };

  const priceLine = (line: QuoteLineDraft, where: string): QuoteLine => {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      throw new SalesDeskError(`${where} needs a quantity greater than zero.`);
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
    let recurring: RecurringCount | undefined;
    if (line.visitsPerWeek !== undefined) {
      const visits = line.visitsPerWeek;
      if (!Number.isFinite(visits) || visits <= 0 || visits > MAX_VISITS_PER_WEEK) {
        throw new SalesDeskError(
          `${where} gives visitsPerWeek ${String(visits)}; it must be more than zero and at most ${MAX_VISITS_PER_WEEK} visits a week.`,
        );
      }
      if (!perVisit(item)) {
        throw new SalesDeskError(
          `${where} gives visitsPerWeek, but ${item.id} is priced per ${item.unit}, not per visit. Leave visitsPerWeek out and give the quantity of ${item.unit} itself, or choose an item priced per visit.`,
        );
      }
      recurring = { quantityPerVisit: line.quantity, visitsPerWeek: visits, weeksPerMonth };
    }
    // The minimum is judged on the month's count, so a recurring line is held to it as a whole.
    const quantity = recurring === undefined ? line.quantity : monthlyQuantity(recurring);
    const priced = Math.round(quantity * item.unitPriceCents);
    const minimum = item.minimumCents;
    const applies = minimum !== null && priced < minimum;
    return {
      priceBookItemId: item.id,
      description: line.description ?? item.name,
      quantity,
      ...(recurring === undefined ? {} : { recurring }),
      unitPriceCents: item.unitPriceCents,
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
      return findQuote(id);
    },

    async createQuote(
      draft: QuoteDraft,
      {
        requestId,
        quoteLimitCents,
      }: { readonly requestId: string; readonly quoteLimitCents: number | undefined },
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
      // The limit is judged on the subtotal, after minimums and before any discount: a discount is a
      // decision of its own, and a quote must not slip under the limit by carrying one.
      const limit =
        quoteLimitCents !== undefined && Number.isFinite(quoteLimitCents) ? quoteLimitCents : null;
      const approvalReasons: QuoteApprovalReason[] = [
        ...(discountPercent > 0 ? (["discount"] as const) : []),
        ...(limit === null
          ? (["no_limit"] as const)
          : subtotalCents > limit
            ? (["over_limit"] as const)
            : []),
      ];
      const quote: Quote = {
        id: nextQuoteId(),
        leadId: lead.id,
        leadName: lead.company,
        status: approvalReasons.length === 0 ? "draft" : "awaiting_approval",
        approvalReasons,
        quoteLimitCents: limit,
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
      lead.lastActivityAt = quote.issuedOn;
      if (quote.status === "draft") markQuoted(lead, quote);
      return quote;
    },

    async approveQuote(input, { requestId }): Promise<Quote> {
      const prior = approvalByRequest.get(requestId);
      if (prior !== undefined) return prior;

      const quote = findQuote(input.quoteId);
      if (quote.status !== "awaiting_approval") {
        throw new SalesDeskError(
          `${quote.id} is not waiting for approval: it is a draft ready to send. An approval applies once; a new or changed quote is made with create_quote.`,
          "not_awaiting_approval",
        );
      }
      // The person approved the quote as the gate read it; anything else is not what they approved.
      if (!sameFacts(input.approved, quoteFacts(quote))) {
        throw new SalesDeskError(
          `${quote.id} is not what the person approved: it changed after its facts were read. It now stands at ${quote.lines.length} lines, total ${money(quote.totalCents)}. Nothing was approved.`,
          "quote_changed",
        );
      }
      const approved: Quote = { ...quote, status: "draft" };
      quotesById.set(approved.id, approved);
      approvalByRequest.set(requestId, approved);
      markQuoted(findLead(approved.leadId), approved);
      return approved;
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
