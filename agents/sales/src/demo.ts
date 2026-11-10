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
