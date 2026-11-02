/**
 * One test per tool, against `fakeSalesDesk` and the company facts generated into this package, so
 * every path runs on the same arithmetic a real run would: integer cents, the book's prices, the
 * book's minimums. No network, no model.
 *
 * The tools are exercised where the model calls them: through the registrations the factory builds,
 * with the durable call identity Pi Durable hands to `execute`.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { loadCompanyFacts, money, priceText, searchPriceBook, searchWords } from "./company.js";
import { fakeSalesDesk, type SalesDesk } from "./desk.js";
import { type SalesToolset, salesTools } from "./tools.js";

const company = loadCompanyFacts();

/** The clock every receipt in this file is dated against. */
const NOW = new Date("2026-11-01T09:00:00.000Z");

/** The durable identity one tool call runs under; only the ids matter to these tools. */
const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;

const tools = (desk: SalesDesk | undefined): SalesToolset => salesTools({ desk, company });

/** A desk on the demo pipeline with a fixed clock. */
const desk = (): SalesDesk => fakeSalesDesk({ now: () => NOW });

/** The one text block a result carries, as the model reads it. */
function text(result: { output?: readonly unknown[] }): string {
  return (result.output ?? [])
    .map((block) => (block as { type?: string; text?: string }).text ?? "")
    .join("\n");
}

/** The details of a result, as a UI reads them. */
function details(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

describe("list_leads", () => {
  it("lists the pipeline, newest activity first", async () => {
    const result = await tools(desk()).listLeads.execute({}, call("call-1"), BACKGROUND_CONTEXT);
    expect(text(result)).toContain("Leads (5):");
    expect(text(result)).toContain("Harborview Property Management");
    // The lead's own note travels with it: the next message depends on what already happened.
    expect(text(result)).toContain("Quote Q-3047 went out three weeks ago");
    expect(details(result).found).toBe(true);
    const leads = details(result).leads as { id: string }[];
    expect(leads[0]?.id).toBe("L-219");
  });

  it("filters by stage and by a search on the company", async () => {
    const qualified = await tools(desk()).listLeads.execute(
      { stage: "qualified" },
      call("call-2"),
      BACKGROUND_CONTEXT,
    );
    const ids = (details(qualified).leads as { id: string }[]).map((lead) => lead.id);
    expect(ids).toEqual(["L-207"]);

    const found = await tools(desk()).listLeads.execute(
      { query: "riverside" },
      call("call-3"),
      BACKGROUND_CONTEXT,
    );
    expect((details(found).leads as { id: string }[]).map((lead) => lead.id)).toEqual(["L-204"]);
  });

  it("says so plainly when nothing matches", async () => {
    const result = await tools(desk()).listLeads.execute(
      { query: "Nobody Ltd" },
      call("call-4"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("No lead matches that");
    expect(details(result).found).toBe(false);
  });
});

describe("search_price_book", () => {
  it("finds the deep clean from a client's words", async () => {
    const result = await tools(desk()).searchPriceBook.execute(
      { query: "deep clean" },
      call("c"),
      BACKGROUND_CONTEXT,
    );
    const items = details(result).items as { id: string }[];
    expect(items[0]?.id).toBe("clean-deep-sqft");
    expect(text(result)).toContain("minimum $450.00");
  });

  it("finds the recurring visit price from 'nightly office cleaning'", async () => {
    const result = await tools(desk()).searchPriceBook.execute(
      { query: "nightly office cleaning" },
      call("c"),
      BACKGROUND_CONTEXT,
    );
    const ids = (details(result).items as { id: string }[]).map((item) => item.id);
    expect(ids).toContain("clean-office-visit");
    expect(ids).toContain("clean-office-sqft");
  });

  it("refuses rather than guessing when the book has no line", async () => {
    const result = await tools(desk()).searchPriceBook.execute(
      { query: "helicopter" },
      call("c"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).found).toBe(false);
    expect(text(result)).toContain("priced by a person");
  });

  it("drops the words that say nothing", () => {
    expect(searchWords("How much does it cost for a deep clean?")).toEqual(["deep", "clean"]);
    expect(searchPriceBook(company, "the and for")).toEqual([]);
  });
});

describe("create_quote", () => {
  it("prices a first deep clean and applies the book's minimum, in the desk's arithmetic", async () => {
    const result = await tools(desk()).createQuote.execute(
      {
        leadId: "L-204",
        lines: [
          { priceBookItemId: "clean-deep-sqft", quantity: 3200, unitPriceCents: 12 },
          { priceBookItemId: "restroom-sanitise", quantity: 4, unitPriceCents: 6500 },
        ],
        notes: "First deep clean before the chairs go in.",
      },
      call("quote-1"),
      BACKGROUND_CONTEXT,
    );
    const quote = details(result) as {
      id: string;
      subtotalCents: number;
      totalCents: number;
      discountPercent: number;
      issuedOn: string;
      validUntil: string;
      lines: { amountCents: number; minimumApplied: boolean }[];
    };
    expect(quote.id).toBe("Q-3051");
    // 3,200 sq ft is under the deep-clean minimum, so the line is the minimum; 4 restrooms are not.
    expect(quote.lines[0]?.amountCents).toBe(45000);
    expect(quote.lines[0]?.minimumApplied).toBe(true);
    expect(quote.lines[1]?.amountCents).toBe(26000);
    expect(quote.subtotalCents).toBe(71000);
    expect(quote.discountPercent).toBe(0);
    expect(quote.issuedOn).toBe("2026-11-01");
    expect(quote.validUntil).toBe("2026-12-01");
    expect(text(result)).toContain("total $710.00");
    expect(text(result)).toContain("minimum set the Deep clean, first visit line to $450.00");
  });

  it("takes a discount the desk was given and works the total out in cents", async () => {
    const result = await tools(desk()).createQuote.execute(
      {
        leadId: "L-204",
        lines: [{ priceBookItemId: "clean-deep-sqft", quantity: 3200, unitPriceCents: 12 }],
        discountPercent: 10,
      },
      call("quote-2"),
      BACKGROUND_CONTEXT,
    );
    const quote = details(result) as {
      subtotalCents: number;
      discountCents: number;
      totalCents: number;
    };
    expect(quote.subtotalCents).toBe(45000);
    expect(quote.discountCents).toBe(4500);
    expect(quote.totalCents).toBe(40500);
    expect(text(result)).toContain("discount 10% ($45.00)");
  });

  it("quotes a recurring month at 21.65 visits and leaves the minimums alone", async () => {
    const result = await tools(desk()).createQuote.execute(
      {
        leadId: "L-207",
        lines: [
          { priceBookItemId: "clean-office-visit", quantity: 21.65, unitPriceCents: 18500 },
          { priceBookItemId: "porter-hour", quantity: 40, unitPriceCents: 4200 },
        ],
      },
      call("quote-3"),
      BACKGROUND_CONTEXT,
    );
    const quote = details(result) as {
      subtotalCents: number;
      lines: { minimumApplied: boolean }[];
    };
    expect(quote.subtotalCents).toBe(568525);
    expect(quote.lines.every((line) => !line.minimumApplied)).toBe(true);
    expect(text(result)).toContain("$5,685.25");
  });

  it("refuses a price that is not the book's, and says what the book says", async () => {
    const result = await tools(desk()).createQuote.execute(
      {
        leadId: "L-204",
        lines: [{ priceBookItemId: "clean-deep-sqft", quantity: 3200, unitPriceCents: 15 }],
      },
      call("quote-4"),
      BACKGROUND_CONTEXT,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toContain(
      "The price book prices Deep clean, first visit at $0.12 per sq ft",
    );
    expect(text(result)).toContain("Quote the book's price");
  });

  it("refuses a lead that does not exist, naming what the pipeline holds", async () => {
    const result = await tools(desk()).createQuote.execute(
      { leadId: "L-999", lines: [{ description: "Cleaning", quantity: 1, unitPriceCents: 18500 }] },
      call("quote-5"),
      BACKGROUND_CONTEXT,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toContain('No lead has the id "L-999"');
    expect(text(result)).toContain("L-204 (Riverside Dental)");
  });

  it("answers a retried call with the quote it already made", async () => {
    const one = desk();
    const first = await tools(one).createQuote.execute(
      {
        leadId: "L-204",
        lines: [{ priceBookItemId: "porter-hour", quantity: 4, unitPriceCents: 4200 }],
      },
      call("quote-6"),
      BACKGROUND_CONTEXT,
    );
    const again = await tools(one).createQuote.execute(
      {
        leadId: "L-204",
        lines: [{ priceBookItemId: "porter-hour", quantity: 4, unitPriceCents: 4200 }],
      },
      call("quote-6"),
      BACKGROUND_CONTEXT,
    );
    expect(details(again).id).toBe(details(first).id);
  });
});

describe("log_activity", () => {
  it("records what happened and moves the lead's last activity", async () => {
    const one = desk();
    const result = await tools(one).logActivity.execute(
      {
        leadId: "L-204",
        kind: "call",
        summary:
          "Spoke to Dr. Nguyen; the suite is measured at 3,200 sq ft. Deep clean before January.",
      },
      call("activity-1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Recorded call A-1 on lead L-204");
    const leads = await one.listLeads({ query: "L-204" });
    expect(leads[0]?.lastActivityAt).toBe("2026-11-01");
  });

  it("refuses a lead that does not exist", async () => {
    const result = await tools(desk()).logActivity.execute(
      { leadId: "L-999", kind: "note", summary: "Nothing" },
      call("activity-2"),
      BACKGROUND_CONTEXT,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toContain('No lead has the id "L-999"');
  });
});

describe("read_company", () => {
  it("answers for the profile, the people and the escalation path", async () => {
    const role = tools(desk());
    const profile = await role.readCompany.execute(
      { section: "profile" },
      call("c"),
      BACKGROUND_CONTEXT,
    );
    expect(text(profile)).toContain("Northwind Facilities Ltd.");
    expect(text(profile)).toContain("General liability $2,000,000.00");

    const people = await role.readCompany.execute(
      { section: "people" },
      call("c"),
      BACKGROUND_CONTEXT,
    );
    expect(text(people)).toContain(
      "Marcus Oyelaran — Sales Manager — marcus@northwindfacilities.com",
    );

    const escalation = await role.readCompany.execute(
      { section: "escalation" },
      call("c"),
      BACKGROUND_CONTEXT,
    );
    expect(text(escalation)).toContain("discount-request — Marcus Oyelaran");
  });

  it("gives the price book and the quote limit from the company record", async () => {
    const result = await tools(desk()).readCompany.execute(
      { section: "pricing" },
      call("c"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("clean-deep-sqft — Deep clean, first visit — $0.12 per sq ft");
    expect(text(result)).toContain("$5,000.00 waits for a person");
  });

  it("gives the policies, with the people who decide them named", async () => {
    const result = await tools(desk()).readCompany.execute(
      { section: "policies" },
      call("c"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Money back: Dana Whitfield");
    expect(text(result)).toContain("Credits: Eileen Hart");
  });
});

describe("the company facts", () => {
  it("formats cents as money, and a price with its minimum", () => {
    expect(money(18500)).toBe("$185.00");
    expect(money(7)).toBe("$0.07");
    const deep = company.priceBook.find((item) => item.id === "clean-deep-sqft");
    expect(deep === undefined ? "" : priceText(deep)).toBe("$0.12 per sq ft, minimum $450.00");
  });

  it("keeps the quote limit the manifest declares", () => {
    expect(company.approvalLimits.quoteOverCents).toBe(500000);
  });
});

describe("with no desk", () => {
  it("refuses rather than pretending", async () => {
    const role = tools(undefined);
    await expect(role.listLeads.execute({}, call("c"), BACKGROUND_CONTEXT)).rejects.toThrow(
      "No sales desk is configured",
    );
    // The company record needs no desk, so a role with no system of record can still answer about
    // the business.
    expect(
      text(await role.readCompany.execute({ section: "hours" }, call("c"), BACKGROUND_CONTEXT)),
    ).toContain("Emergency line");
  });
});
