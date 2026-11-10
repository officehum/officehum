/**
 * The demonstration pipeline the fake desk starts with: leads and the one quote already made. It is
 * demonstration data, not part of the company record, and lives apart from the desk so the desk's own
 * text (what the model reads) can be checked for company facts with no exception.
 */

import type { Lead, Quote, QuoteLine } from "./desk.js";

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
      nextFollowUp: null,
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
      nextFollowUp: null,
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
      nextFollowUp: null,
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
      nextFollowUp: null,
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
      nextFollowUp: null,
    },
  ];
}

/** The limit the demonstration quotes were judged against: the manifest's default. */
const DEMO_QUOTE_LIMIT_CENTS = 500000;

/** One demonstration line, priced the way `createQuote` prices it, minimum included. */
function demoLine(
  priceBookItemId: string,
  description: string,
  quantity: number,
  unitPriceCents: number,
  minimumCents: number | null = null,
): QuoteLine {
  const priced = Math.round(quantity * unitPriceCents);
  const minimumApplied = minimumCents !== null && priced < minimumCents;
  return {
    priceBookItemId,
    description,
    quantity,
    unitPriceCents,
    amountCents: minimumApplied ? minimumCents : priced,
    minimumApplied,
  };
}

/**
 * A demonstration quote with its totals worked out from its lines: ready to send, or awaiting approval
 * when it has reasons to, or sent on `sentOn` when one is given.
 */
function demoQuote(
  fields: Pick<Quote, "id" | "leadId" | "leadName" | "issuedOn" | "validUntil">,
  lines: readonly QuoteLine[],
  discountPercent: number,
  approvalReasons: Quote["approvalReasons"],
  sentOn: string | null = null,
): Quote {
  const subtotalCents = lines.reduce((total, line) => total + line.amountCents, 0);
  const discountCents = Math.round((subtotalCents * discountPercent) / 100);
  return {
    ...fields,
    status: approvalReasons.length > 0 ? "awaiting_approval" : sentOn === null ? "draft" : "sent",
    approvalReasons,
    quoteLimitCents: DEMO_QUOTE_LIMIT_CENTS,
    currency: "USD",
    lines,
    subtotalCents,
    discountPercent,
    discountCents,
    totalCents: subtotalCents - discountCents,
    notes: null,
    sentOn,
    acceptedOn: null,
    declinedOn: null,
  };
}

/**
 * The quotes the demo pipeline already holds. Q-3047 was sent to Bramble & Co on the day it was
 * issued, two and a half weeks before the demo date, and has had no answer: 12,000 sq ft of first-visit deep clean, 24 restroom sanitises and three HVAC filters. The
 * other three were made on the demo date and wait for a person, so an approval has a real quote to
 * read: Q-3052, Cascadia Legal's month of nightly cleaning and a move porter, above the quote limit;
 * Q-3053, Q-3047 again with the ten percent Bramble & Co asked for; and Q-3060, a strip-and-wax and a
 * carpet clean in each of Harborview's six lobbies, which only the book's minimums take over the
 * limit. Each line is a real price book item, so the amounts are what `createQuote` would make.
 */
export function demoQuotes(): readonly Quote[] {
  const bramble: QuoteLine[] = [
    demoLine("clean-deep-sqft", "Deep clean, first visit", 12000, 12),
    demoLine("restroom-sanitise", "Restroom sanitising", 24, 6500),
    demoLine("hvac-filter", "HVAC filter change", 3, 4500),
  ];
  const today = { issuedOn: "2026-11-01", validUntil: "2026-12-01" };
  const lobbies = Array.from({ length: 6 }, (_, index) => [
    demoLine("floor-strip-wax-sqft", `Building ${index + 1} lobby, strip and wax`, 300, 95, 60000),
    demoLine("floor-carpet-sqft", `Building ${index + 1} lobby, carpet clean`, 400, 45, 27500),
  ]).flat();
  return [
    demoQuote(
      {
        id: "Q-3047",
        leadId: "L-211",
        leadName: "Bramble & Co",
        issuedOn: "2026-10-15",
        validUntil: "2026-11-14",
      },
      bramble,
      0,
      [],
      "2026-10-15",
    ),
    demoQuote(
      { id: "Q-3052", leadId: "L-207", leadName: "Cascadia Legal Group", ...today },
      [
        demoLine(
          "clean-office-visit",
          "Office cleaning, one visit, up to 3,000 sq ft",
          21.65,
          18500,
        ),
        demoLine("porter-hour", "Day porter", 40, 4200),
      ],
      0,
      ["over_limit"],
    ),
    demoQuote({ id: "Q-3053", leadId: "L-211", leadName: "Bramble & Co", ...today }, bramble, 10, [
      "discount",
    ]),
    demoQuote(
      { id: "Q-3060", leadId: "L-219", leadName: "Harborview Property Management", ...today },
      lobbies,
      0,
      ["over_limit"],
    ),
  ];
}
