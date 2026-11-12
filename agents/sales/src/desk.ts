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
 *
 * After that a quote moves only forward, and only as somebody records it: a draft is `sent`, and a
 * sent quote is `accepted` or `declined`, each with its date. A lead's stage moves the same way,
 * explicitly and with a reason, and `won` and `lost` are final here: a person reopens a closed deal.
 * The desk also counts the pipeline (`pipelineReport`), so a review's figures come from code.
 */

import { addDays, localDate, parseDate, sameFacts } from "@officehum/sdk";
import type { PriceBookItem } from "./company.js";
import { loadCompanyFacts, money } from "./company.js";
import { demoLeads, demoQuotes } from "./demo.js";

/**
 * The demonstration date: the day the demo pipeline's newest quotes were made. The fake desk and a
 * role on it read this clock unless a host or a test passes another, so the demo data stays coherent.
 */
export const DEMO_NOW = "2026-11-01T17:00:00.000Z";

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
  /** The next touch somebody scheduled on the lead, or `null` when none is. */
  nextFollowUp: FollowUp | null;
}

/** One scheduled touch on a lead: the day it is due and what it is. */
export interface FollowUp {
  /** `YYYY-MM-DD`. */
  readonly on: string;
  readonly what: string;
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
 * it; `draft` is ready to send, because it needed no approval or a person gave it; `sent` went to the
 * client; `accepted` and `declined` are the client's answer.
 */
export type QuoteStatus = "awaiting_approval" | "draft" | "sent" | "accepted" | "declined";

/** Every quote status, in the order a quote moves through them. */
export const QUOTE_STATUSES: readonly QuoteStatus[] = [
  "awaiting_approval",
  "draft",
  "sent",
  "accepted",
  "declined",
];

/** What can be recorded about a quote once it is ready to send. */
export type QuoteOutcome = "sent" | "accepted" | "declined";

/** Every outcome, in the order they happen. */
export const QUOTE_OUTCOMES: readonly QuoteOutcome[] = ["sent", "accepted", "declined"];

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
  /** `YYYY-MM-DD` the quote went to the client, or `null` while it has not. */
  readonly sentOn: string | null;
  /** `YYYY-MM-DD` the client accepted it, or `null`. */
  readonly acceptedOn: string | null;
  /** `YYYY-MM-DD` the client declined it, or `null`. */
  readonly declinedOn: string | null;
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

/** A stage change as the caller asks for it: the lead, where it goes, and why. */
export interface StageChange {
  readonly leadId: string;
  readonly stage: LeadStage;
  readonly reason: string;
}

/** A stage change as the desk made it: the lead after it, where it came from, and the recorded reason. */
export interface StageMove {
  readonly lead: Lead;
  readonly from: LeadStage;
  readonly activity: Activity;
}

/** An outcome as the caller records it: the quote, what happened, and optionally when and a note. */
export interface QuoteOutcomeDraft {
  readonly quoteId: string;
  readonly outcome: QuoteOutcome;
  /** `YYYY-MM-DD` it happened; today on the desk's clock when omitted. */
  readonly on?: string;
  readonly note?: string;
}

/** An outcome as the desk recorded it: the quote after it, its status before, and the note on the lead. */
export interface QuoteOutcomeRecord {
  readonly quote: Quote;
  readonly from: QuoteStatus;
  readonly activity: Activity;
}

/** A follow-up as the caller schedules it. */
export interface FollowUpDraft {
  readonly leadId: string;
  readonly on: string;
  readonly what: string;
}

/** A follow-up as the desk scheduled it, and the open one it replaced, if any. */
export interface ScheduledFollowUp {
  readonly leadId: string;
  readonly followUp: FollowUp;
  readonly replaced: FollowUp | null;
}

/** One stage of the pipeline, counted by the desk. */
export interface PipelineStageSummary {
  readonly stage: LeadStage;
  readonly count: number;
  /** The leads' estimated yearly value, in integer cents; leads with no estimate add nothing. */
  readonly valueCents: number;
  /** How many of the leads have no estimated value, so a total is never read as complete. */
  readonly unvalued: number;
}

/** The quotes in one status, counted by the desk. */
export interface PipelineQuoteSummary {
  readonly status: QuoteStatus;
  readonly count: number;
  readonly totalCents: number;
}

/** The pipeline as the desk counts it: every stage and every quote status, in order, zeros included. */
export interface PipelineReport {
  /** `YYYY-MM-DD` on the desk's clock. */
  readonly asOf: string;
  readonly stages: readonly PipelineStageSummary[];
  readonly quotes: readonly PipelineQuoteSummary[];
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
   * with the company's `quoting.weeksPerMonth`, and records that count in `recurring`. A host desk
   * must hold every quote for approval when `quoteLimitCents` is `undefined`, never treat a missing
   * limit as no limit.
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
  /**
   * Moves a lead to another stage and records the reason as an activity on it. A host desk must
   * refuse a move to the stage it is in (`no_change`), to `quoted` when no quote of the lead is ready
   * to send or beyond (`no_ready_quote`), and out of `won` or `lost` (`closed`): a person reopens a
   * closed deal.
   */
  updateLeadStage(change: StageChange, options: { readonly requestId: string }): Promise<StageMove>;
  /**
   * Records what happened to a quote: a draft `sent`, a sent quote `accepted` or `declined`, with the
   * date. A host desk must refuse `sent` on a quote awaiting approval (`awaiting_approval`), any other
   * step out of order (`invalid_transition`), and a date in the future or before the step before it.
   * It changes no lead's stage.
   */
  recordQuoteOutcome(
    outcome: QuoteOutcomeDraft,
    options: { readonly requestId: string },
  ): Promise<QuoteOutcomeRecord>;
  /**
   * Schedules the next touch on a lead, replacing the open one if there is one. A host desk must
   * refuse a day before today.
   */
  scheduleFollowUp(
    draft: FollowUpDraft,
    options: { readonly requestId: string },
  ): Promise<ScheduledFollowUp>;
  /** Counts the pipeline: leads and their estimated value by stage, quotes and totals by status. */
  pipelineReport(): Promise<PipelineReport>;
}

/** Why the desk refused, so a tool can say what to do next without parsing the message. */
export type SalesDeskRefusal =
  | "invalid"
  | "not_found"
  | "not_awaiting_approval"
  | "quote_changed"
  | "no_change"
  | "no_ready_quote"
  | "closed"
  | "awaiting_approval"
  | "invalid_transition";

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
  /** The clock, so a receipt's dates are reproducible in a test; `DEMO_NOW` when omitted. */
  readonly now?: () => Date;
  /**
   * The IANA time zone the desk reads "today" in, for a quote's dates, an outcome and a follow-up;
   * the company's own (`hours.timezone`) when omitted.
   */
  readonly timeZone?: string;
}

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

/** A `YYYY-MM-DD` the caller gave, checked to be a real day, or a refusal saying what was wrong. */
function calendarDay(value: string, what: string): string {
  const day = value.trim();
  if (parseDate(day) === undefined) {
    throw new SalesDeskError(
      `${what} must be a day written YYYY-MM-DD; ${JSON.stringify(value)} is not.`,
    );
  }
  return day;
}

/** The stages a lead is never moved out of by this desk: a person reopens a closed deal. */
const CLOSED_STAGES: readonly LeadStage[] = ["won", "lost"];

/** The quote statuses that make a lead quoted: ready to send, or beyond. */
const READY_STATUSES: readonly QuoteStatus[] = ["draft", "sent", "accepted"];

/** The status each outcome may be recorded from. */
const OUTCOME_FROM: Record<QuoteOutcome, QuoteStatus> = {
  sent: "draft",
  accepted: "sent",
  declined: "sent",
};

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
  const clock = options.now ?? (() => new Date(DEMO_NOW));
  const timeZone = options.timeZone ?? loadCompanyFacts().hours.timezone;
  /** Today as `YYYY-MM-DD`, the company's own day: the only date form a receipt carries. */
  const today = (): string => localDate(clock(), timeZone);
  const leads: Lead[] = (options.leads ?? demoLeads()).map((lead) => ({ ...lead }));
  const quoteByRequest = new Map<string, Quote>();
  const quotesById = new Map<string, Quote>((options.quotes ?? demoQuotes()).map((q) => [q.id, q]));
  const approvalByRequest = new Map<string, Quote>();
  const activityByRequest = new Map<string, Activity>();
  const stageByRequest = new Map<string, StageMove>();
  const outcomeByRequest = new Map<string, QuoteOutcomeRecord>();
  const followUpByRequest = new Map<string, ScheduledFollowUp>();
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

  /** Records an activity on a lead and moves its last activity to today. */
  const recordActivity = (lead: Lead, kind: ActivityKind, summary: string): Activity => {
    activityNumber += 1;
    lead.lastActivityAt = today();
    return { id: `A-${activityNumber}`, leadId: lead.id, kind, summary, at: clock().toISOString() };
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
      const issuedOn = today();
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
        issuedOn,
        validUntil: addDays(issuedOn, validForDays),
        notes: draft.notes ?? null,
        sentOn: null,
        acceptedOn: null,
        declinedOn: null,
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
          `${quote.id} is not waiting for approval: it is ${quote.status === "draft" ? "a draft ready to send" : quote.status}. An approval applies once; a new or changed quote is made with create_quote.`,
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
      const activity = recordActivity(lead, entry.kind, summary);
      activityByRequest.set(requestId, activity);
      return activity;
    },

    async updateLeadStage(change, { requestId }): Promise<StageMove> {
      // A retried call is answered with the move it already made, not refused as a no-op.
      const prior = stageByRequest.get(requestId);
      if (prior !== undefined) return prior;
      const lead = findLead(change.leadId);
      if (!LEAD_STAGES.includes(change.stage)) {
        throw new SalesDeskError(
          `A lead's stage is one of ${LEAD_STAGES.join(", ")}; ${JSON.stringify(change.stage)} is not.`,
        );
      }
      const reason = change.reason.trim();
      if (reason === "") {
        throw new SalesDeskError("A stage change needs a reason: what was learned or decided.");
      }
      const from = lead.stage;
      if (from === change.stage) {
        throw new SalesDeskError(
          `${lead.id} (${lead.company}) is already ${from}. Nothing was changed.`,
          "no_change",
        );
      }
      if (CLOSED_STAGES.includes(from)) {
        throw new SalesDeskError(
          `${lead.id} (${lead.company}) is closed as ${from}, and a person reopens a closed deal. Nothing was changed.`,
          "closed",
        );
      }
      if (change.stage === "quoted") {
        const ready = [...quotesById.values()].some(
          (quote) => quote.leadId === lead.id && READY_STATUSES.includes(quote.status),
        );
        if (!ready) {
          throw new SalesDeskError(
            `${lead.id} (${lead.company}) has no quote ready to send, so it is not quoted. A quote awaiting a person's approval does not count. Nothing was changed.`,
            "no_ready_quote",
          );
        }
      }
      lead.stage = change.stage;
      const activity = recordActivity(
        lead,
        "note",
        `Stage moved from ${from} to ${change.stage}: ${reason}`,
      );
      const move: StageMove = { lead: { ...lead }, from, activity };
      stageByRequest.set(requestId, move);
      return move;
    },

    async recordQuoteOutcome(input, { requestId }): Promise<QuoteOutcomeRecord> {
      const prior = outcomeByRequest.get(requestId);
      if (prior !== undefined) return prior;
      const quote = findQuote(input.quoteId);
      if (!QUOTE_OUTCOMES.includes(input.outcome)) {
        throw new SalesDeskError(
          `A quote's outcome is one of ${QUOTE_OUTCOMES.join(", ")}; ${JSON.stringify(input.outcome)} is not.`,
        );
      }
      if (quote.status === "awaiting_approval") {
        throw new SalesDeskError(
          `${quote.id} is awaiting a person's approval: it is not approved, so it is not ready to send and nothing about it can be recorded as ${input.outcome}. It still waits for a person.`,
          "awaiting_approval",
        );
      }
      const from = quote.status;
      if (from !== OUTCOME_FROM[input.outcome]) {
        throw new SalesDeskError(
          `${quote.id} is ${from}, and only a ${OUTCOME_FROM[input.outcome]} quote can be marked ${input.outcome}. Nothing was changed.`,
          "invalid_transition",
        );
      }
      const now = today();
      const on = input.on === undefined ? now : calendarDay(input.on, "The outcome's date");
      if (on > now) {
        throw new SalesDeskError(
          `${on} is after today, ${now}: record an outcome once it has happened.`,
        );
      }
      const earliest = input.outcome === "sent" ? quote.issuedOn : (quote.sentOn ?? quote.issuedOn);
      if (on < earliest) {
        throw new SalesDeskError(
          `${on} is before ${earliest}, when ${quote.id} was ${input.outcome === "sent" ? "issued" : "sent"}.`,
        );
      }
      const updated: Quote = {
        ...quote,
        status: input.outcome,
        ...(input.outcome === "sent" ? { sentOn: on } : {}),
        ...(input.outcome === "accepted" ? { acceptedOn: on } : {}),
        ...(input.outcome === "declined" ? { declinedOn: on } : {}),
      };
      quotesById.set(updated.id, updated);
      const note = input.note?.trim() ?? "";
      const activity = recordActivity(
        findLead(quote.leadId),
        "note",
        `Quote ${quote.id} ${input.outcome} on ${on}.${note === "" ? "" : ` ${note}`}`,
      );
      const record: QuoteOutcomeRecord = { quote: updated, from, activity };
      outcomeByRequest.set(requestId, record);
      return record;
    },

    async scheduleFollowUp(draft, { requestId }): Promise<ScheduledFollowUp> {
      const prior = followUpByRequest.get(requestId);
      if (prior !== undefined) return prior;
      const lead = findLead(draft.leadId);
      const on = calendarDay(draft.on, "A follow-up's day");
      const now = today();
      if (on < now) {
        throw new SalesDeskError(
          `${on} is before today, ${now}: a follow-up is scheduled for today or later.`,
        );
      }
      const what = draft.what.trim();
      if (what === "") throw new SalesDeskError("A follow-up needs to say what the touch is.");
      const followUp: FollowUp = { on, what };
      const scheduled: ScheduledFollowUp = {
        leadId: lead.id,
        followUp,
        replaced: lead.nextFollowUp,
      };
      lead.nextFollowUp = followUp;
      followUpByRequest.set(requestId, scheduled);
      return scheduled;
    },

    async pipelineReport(): Promise<PipelineReport> {
      const quotes = [...quotesById.values()];
      return {
        asOf: today(),
        stages: LEAD_STAGES.map((stage) => {
          const inStage = leads.filter((lead) => lead.stage === stage);
          return {
            stage,
            count: inStage.length,
            valueCents: inStage.reduce((total, lead) => total + (lead.estimatedValueCents ?? 0), 0),
            unvalued: inStage.filter((lead) => lead.estimatedValueCents === null).length,
          };
        }),
        quotes: QUOTE_STATUSES.map((status) => {
          const inStatus = quotes.filter((quote) => quote.status === status);
          return {
            status,
            count: inStatus.length,
            totalCents: inStatus.reduce((total, quote) => total + quote.totalCents, 0),
          };
        }),
      };
    },
  };
}
