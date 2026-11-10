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
import { fakeSalesDesk, type SalesDesk, SalesDeskError } from "./desk.js";
import { type SalesToolset, salesTools } from "./tools.js";

const company = loadCompanyFacts();

/** The clock every receipt in this file is dated against. */
const NOW = new Date("2026-11-01T09:00:00.000Z");

/** The durable identity one tool call runs under; only the ids matter to these tools. */
const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;

/** The manifest's default quote limit, as the role's resolved limits hand it to the tools. */
const LIMITS = { quote_limit_cents: 500000 };

const tools = (
  desk: SalesDesk | undefined,
  limits: Readonly<Record<string, number>> = LIMITS,
): SalesToolset => salesTools({ desk, company, limits: () => limits });

/** A desk on the demo pipeline with a fixed clock. */
const desk = (): SalesDesk => fakeSalesDesk({ now: () => NOW });

/** Six lobbies, each with a strip-and-wax and a carpet line that the book's minimum raises. */
const SIX_LOBBIES = Array.from({ length: 6 }, () => [
  { priceBookItemId: "floor-strip-wax-sqft", quantity: 300 },
  { priceBookItemId: "floor-carpet-sqft", quantity: 400 },
]).flat();

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

describe("get_quote", () => {
  it("getQuote returns the seeded Q-3047 with its lines", async () => {
    const quote = await desk().getQuote("Q-3047");
    expect(quote.leadId).toBe("L-211");
    expect(quote.issuedOn).toBe("2026-10-15");
    expect(quote.validUntil).toBe("2026-11-14");
    expect(quote.discountPercent).toBe(0);
    expect(quote.lines.length).toBeGreaterThan(0);
    const sum = quote.lines.reduce((total, line) => total + line.amountCents, 0);
    expect(quote.totalCents).toBe(sum);
    expect(quote.totalCents).toBeLessThanOrEqual(320000);
    // Every line is priced from the book, so the amounts match what create_quote would have made.
    for (const line of quote.lines) {
      const item = company.priceBook.find((candidate) => candidate.id === line.priceBookItemId);
      expect(item?.unitPriceCents).toBe(line.unitPriceCents);
    }
  });

  it("getQuote refuses an unknown id", async () => {
    await expect(desk().getQuote("Q-9999")).rejects.toThrow(SalesDeskError);
    await expect(desk().getQuote("Q-9999")).rejects.toThrow(/Q-9999/);
  });

  it("get_quote's output text lists each line", async () => {
    const result = await tools(desk()).getQuote.execute(
      { quoteId: "Q-3047" },
      call("call-q1"),
      BACKGROUND_CONTEXT,
    );
    const quote = await desk().getQuote("Q-3047");
    for (const line of quote.lines) {
      expect(text(result)).toContain(String(line.priceBookItemId));
      expect(text(result)).toContain(String(line.quantity));
      expect(text(result)).toContain(money(line.unitPriceCents));
      expect(text(result)).toContain(money(line.amountCents));
    }
    expect(text(result)).toContain(money(quote.totalCents));
    expect(details(result).found).toBe(true);
  });

  it("get_quote says plainly when there is no such quote", async () => {
    const result = await tools(desk()).getQuote.execute(
      { quoteId: "Q-9999" },
      call("call-q2"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Q-9999");
    expect((result as { isError?: boolean }).isError).toBe(true);
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
          { priceBookItemId: "clean-deep-sqft", quantity: 3200 },
          { priceBookItemId: "restroom-sanitise", quantity: 4 },
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
        lines: [{ priceBookItemId: "clean-deep-sqft", quantity: 3200 }],
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
    // A discount is a person's decision: the quote is saved, but it is not ready to send.
    expect(details(result).status).toBe("awaiting_approval");
    expect(text(result)).toContain("not ready to send");
    expect(text(result)).toContain("it carries a 10% discount");
    expect(text(result)).toContain(
      "Next: call request_quote_approval with quoteId Q-3051, which asks Marcus Oyelaran.",
    );
  });

  it("quotes a recurring month at 21.65 visits and leaves the minimums alone", async () => {
    const result = await tools(desk()).createQuote.execute(
      {
        leadId: "L-207",
        lines: [
          { priceBookItemId: "clean-office-visit", quantity: 21.65 },
          { priceBookItemId: "porter-hour", quantity: 40 },
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
    expect(details(result).status).toBe("awaiting_approval");
    expect(text(result)).toContain("it is above the $5,000.00 quote limit");
  });

  it("holds a quote that only the book's minimums take over the limit", async () => {
    const result = await tools(desk()).createQuote.execute(
      { leadId: "L-219", lines: SIX_LOBBIES },
      call("lobbies"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).status).toBe("awaiting_approval");
    expect(details(result).totalCents).toBe(525000);
    expect(text(result)).toContain("Saved quote Q-3051");
    expect(text(result)).toContain("it is above the $5,000.00 quote limit");
    expect(text(result)).not.toContain("Created draft quote");
  });

  it("reads the quote limit live, so an overlay moves the line without a rebuild", async () => {
    const limits: Record<string, number> = { quote_limit_cents: 500000 };
    const live = salesTools({ desk: desk(), company, limits: () => limits });
    const lines = [{ priceBookItemId: "porter-hour", quantity: 40 }];
    const under = await live.createQuote.execute(
      { leadId: "L-204", lines },
      call("l1"),
      BACKGROUND_CONTEXT,
    );
    expect(details(under).status).toBe("draft");
    limits.quote_limit_cents = 100000;
    const over = await live.createQuote.execute(
      { leadId: "L-204", lines },
      call("l2"),
      BACKGROUND_CONTEXT,
    );
    expect(details(over).status).toBe("awaiting_approval");
    expect(text(over)).toContain("it is above the $1,000.00 quote limit");
  });

  it("holds every quote when the role resolves no quote limit", async () => {
    const result = await tools(desk(), {}).createQuote.execute(
      { leadId: "L-204", lines: [{ priceBookItemId: "porter-hour", quantity: 1 }] },
      call("no-limit"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).status).toBe("awaiting_approval");
    expect(text(result)).toContain("no quote limit is set");
  });

  it("takes no price from the model: a line is an item, a quantity and a frequency, and nothing else", () => {
    const schema = tools(desk()).createQuote.parameters as unknown as {
      properties: {
        lines: {
          items: {
            properties: Record<string, Record<string, unknown>>;
            additionalProperties?: boolean;
            required?: string[];
          };
        };
      };
    };
    const line = schema.properties.lines.items;
    expect(Object.keys(line.properties).sort()).toEqual([
      "description",
      "priceBookItemId",
      "quantity",
      "visitsPerWeek",
    ]);
    expect(line.properties.visitsPerWeek).toMatchObject({ exclusiveMinimum: 0, maximum: 7 });
    expect(line.required).not.toContain("visitsPerWeek");
    expect(line.additionalProperties).toBe(false);
  });

  it("counts a recurring line from visitsPerWeek and shows the count on the receipt", async () => {
    const result = await tools(desk()).createQuote.execute(
      {
        leadId: "L-204",
        lines: [{ priceBookItemId: "clean-office-visit", quantity: 1, visitsPerWeek: 5 }],
      },
      call("recurring-1"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).status).toBe("draft");
    expect(details(result).lines).toEqual([
      expect.objectContaining({ quantity: 21.65, visitsPerWeek: 5, weeksPerMonth: 4.33 }),
    ]);
    expect(text(result)).toContain("5 visits a week × 4.33 weeks = 21.65 visits");
    expect(text(result)).toContain("$4,005.25");
  });

  it("shows the units on each visit when a recurring line has more than one", async () => {
    const one = desk();
    const made = await tools(one).createQuote.execute(
      {
        leadId: "L-207",
        lines: [{ priceBookItemId: "restroom-sanitise", quantity: 3, visitsPerWeek: 5 }],
      },
      call("restrooms"),
      BACKGROUND_CONTEXT,
    );
    expect(text(made)).toContain("3 per visit × 5 visits a week × 4.33 weeks = 64.95");
    const read = await tools(one).getQuote.execute(
      { quoteId: String(details(made).id) },
      call("read-restrooms"),
      BACKGROUND_CONTEXT,
    );
    expect(text(read)).toContain("3 per visit × 5 visits a week × 4.33 weeks = 64.95");
    expect(text(read)).toContain("64.95 × $65.00 = $4,221.75");
  });

  it("refuses visitsPerWeek on an item that is not priced per visit, saying what to do", async () => {
    const result = await tools(desk()).createQuote.execute(
      {
        leadId: "L-204",
        lines: [{ priceBookItemId: "clean-deep-sqft", quantity: 3000, visitsPerWeek: 1 }],
      },
      call("not-per-visit"),
      BACKGROUND_CONTEXT,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toContain("not per visit");
    expect(text(result)).toContain("Leave visitsPerWeek out");
  });

  it("refuses a lead that does not exist, naming what the pipeline holds", async () => {
    const result = await tools(desk()).createQuote.execute(
      {
        leadId: "L-999",
        lines: [{ priceBookItemId: "clean-office-visit", quantity: 1 }],
      },
      call("quote-5"),
      BACKGROUND_CONTEXT,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toContain('No lead has the id "L-999"');
    expect(text(result)).toContain("L-204 (Riverside Dental)");
  });

  it("states every line's price book item as required, so an off-book line never validates", () => {
    const schema = tools(desk()).createQuote.parameters as unknown as {
      properties: { lines: { items: { required?: string[] } } };
    };
    expect(schema.properties.lines.items.required).toContain("priceBookItemId");
  });

  it("refuses a line priced off the book, at the desk and through the tool, and a replay makes nothing", async () => {
    const one = desk();
    const offBook = {
      leadId: "L-204",
      lines: [{ description: "Window cleaning, our rate", quantity: 1 }],
    };
    // The desk refuses it whoever calls, so a host that skips the schema cannot price off the book.
    await expect(one.createQuote(offBook as never, { requestId: "direct-1" })).rejects.toThrow(
      SalesDeskError,
    );
    await expect(one.createQuote(offBook as never, { requestId: "direct-1" })).rejects.toThrow(
      "a person prices work the price book does not cover",
    );

    const first = await tools(one).createQuote.execute(
      offBook as never,
      call("off-book"),
      BACKGROUND_CONTEXT,
    );
    const replayed = await tools(one).createQuote.execute(
      offBook as never,
      call("off-book"),
      BACKGROUND_CONTEXT,
    );
    for (const result of [first, replayed]) {
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(text(result)).toContain("Line 1 has no price book item");
      expect(details(result).id).toBeNull();
    }
    // Nothing was made: the lead is where it was, and the next quote takes the first number.
    const [lead] = await one.listLeads({ query: "L-204" });
    expect(lead?.stage).toBe("new");
    const next = await tools(one).createQuote.execute(
      {
        leadId: "L-204",
        lines: [{ priceBookItemId: "porter-hour", quantity: 4 }],
      },
      call("after-off-book"),
      BACKGROUND_CONTEXT,
    );
    expect(details(next).id).toBe("Q-3051");
  });

  it("answers a retried call with the quote it already made", async () => {
    const one = desk();
    const first = await tools(one).createQuote.execute(
      {
        leadId: "L-204",
        lines: [{ priceBookItemId: "porter-hour", quantity: 4 }],
      },
      call("quote-6"),
      BACKGROUND_CONTEXT,
    );
    const again = await tools(one).createQuote.execute(
      {
        leadId: "L-204",
        lines: [{ priceBookItemId: "porter-hour", quantity: 4 }],
      },
      call("quote-6"),
      BACKGROUND_CONTEXT,
    );
    expect(details(again).id).toBe(details(first).id);
  });
});

describe("request_quote_approval", () => {
  /** A desk holding the six-lobby quote, saved awaiting approval as Q-3051. */
  async function waiting() {
    const one = desk();
    await tools(one).createQuote.execute(
      { leadId: "L-219", lines: SIX_LOBBIES },
      call("lobbies"),
      BACKGROUND_CONTEXT,
    );
    return one;
  }

  it("refuses without facts a person approved, and changes nothing", async () => {
    const one = await waiting();
    const result = await tools(one).requestQuoteApproval.execute(
      { quoteId: "Q-3051" },
      call("ask"),
      BACKGROUND_CONTEXT,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(details(result).code).toBe("not_approved");
    expect((await one.getQuote("Q-3051")).status).toBe("awaiting_approval");
  });

  it("makes the quote a draft ready to send with the facts the gate read", async () => {
    const one = await waiting();
    const set = tools(one);
    const facts = await set.quoteApprovalFacts({ quoteId: "Q-3051" }, BACKGROUND_CONTEXT, {
      conversationId: "conversation-1",
      taskId: "task-1",
    });
    expect(facts.summary).toContain("Harborview Property Management (L-219)");
    expect(facts.summary).toContain(
      "300 × Strip and re-wax resilient flooring at $0.95 = $600.00 (minimum applied)",
    );
    expect(facts.summary).toContain("(minimum applied)");
    expect(facts.summary).toContain("Total $5,250.00");
    expect(facts.summary).toContain("above the $5,000.00 quote limit");
    const result = await set.requestQuoteApproval.execute(
      { quoteId: "Q-3051", officehumApprovedFacts: facts.facts },
      call("ask"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Approved quote Q-3051");
    expect(text(result)).toContain("ready to send");
    expect(details(result).status).toBe("draft");
  });

  it("refuses when the quote changed after the person saw it", async () => {
    const one = await waiting();
    const result = await tools(one).requestQuoteApproval.execute(
      { quoteId: "Q-3051", officehumApprovedFacts: { id: "Q-3051", totalCents: 1 } },
      call("ask"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).code).toBe("quote_changed");
    expect(text(result)).toContain("get_quote");
    expect((await one.getQuote("Q-3051")).status).toBe("awaiting_approval");
  });

  it("asks nobody about a quote that does not wait for approval", async () => {
    const set = tools(desk());
    const identity = { conversationId: "c", taskId: "t" };
    await expect(
      set.quoteApprovalFacts({ quoteId: "Q-3047" }, BACKGROUND_CONTEXT, identity),
    ).rejects.toThrow("not waiting for a person's approval");
    await expect(
      set.quoteApprovalFacts({ quoteId: "Q-9999" }, BACKGROUND_CONTEXT, identity),
    ).rejects.toThrow('No quote has the id "Q-9999"');
  });

  it("says plainly in get_quote that a quote is waiting for a person", async () => {
    const result = await tools(desk()).getQuote.execute(
      { quoteId: "Q-3052" },
      call("g"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("awaiting a person's approval, not ready to send");
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

describe("update_lead_stage", () => {
  it("moves a lead with its reason recorded, and says so", async () => {
    const one = desk();
    const result = await tools(one).updateLeadStage.execute(
      { leadId: "L-215", stage: "qualified", reason: "Walkthrough done: 4,100 sq ft, nightly." },
      call("stage-1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Moved L-215 (Lloyd Center Pediatrics) from new to qualified");
    expect(text(result)).toContain("recorded on the lead as note A-1");
    expect(details(result)).toMatchObject({ leadId: "L-215", from: "new", stage: "qualified" });
    expect((await one.listLeads({ query: "L-215" }))[0]?.stage).toBe("qualified");
  });

  it("answers a retried call with the move it already made, and writes nothing twice", async () => {
    const one = desk();
    const args = { leadId: "L-211", stage: "lost", reason: "No answer in three weeks." };
    const first = await tools(one).updateLeadStage.execute(args, call("s"), BACKGROUND_CONTEXT);
    const again = await tools(one).updateLeadStage.execute(args, call("s"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    expect((again as { isError?: boolean }).isError).toBeUndefined();
  });

  it("refuses quoted while the quote waits for a person, and a closed deal, saying what next", async () => {
    const one = desk();
    const waiting = await tools(one).updateLeadStage.execute(
      { leadId: "L-219", stage: "quoted", reason: "Quoted the lobbies." },
      call("q"),
      BACKGROUND_CONTEXT,
    );
    expect((waiting as { isError?: boolean }).isError).toBe(true);
    expect(details(waiting).code).toBe("no_ready_quote");
    expect(text(waiting)).toContain("request_quote_approval");

    await one.updateLeadStage(
      { leadId: "L-211", stage: "lost", reason: "Quiet." },
      { requestId: "lost" },
    );
    const closed = await tools(one).updateLeadStage.execute(
      { leadId: "L-211", stage: "qualified", reason: "Back." },
      call("c"),
      BACKGROUND_CONTEXT,
    );
    expect(details(closed).code).toBe("closed");
    expect(text(closed)).toContain("a person reopens a closed deal");
  });
});

describe("record_quote_outcome", () => {
  it("marks a draft sent and says the cadence counts from that day", async () => {
    const one = desk();
    await tools(one).createQuote.execute(
      { leadId: "L-204", lines: [{ priceBookItemId: "clean-deep-sqft", quantity: 3200 }] },
      call("quote"),
      BACKGROUND_CONTEXT,
    );
    const result = await tools(one).recordQuoteOutcome.execute(
      { quoteId: "Q-3051", outcome: "sent" },
      call("sent"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(
      "Recorded Q-3051 for Riverside Dental (L-204) as sent on 2026-11-01",
    );
    expect(text(result)).toContain("schedule_follow_up");
    expect(details(result)).toMatchObject({ id: "Q-3051", status: "sent", sentOn: "2026-11-01" });
    const read = await tools(one).getQuote.execute(
      { quoteId: "Q-3051" },
      call("g"),
      BACKGROUND_CONTEXT,
    );
    expect(text(read)).toContain("sent on 2026-11-01");
  });

  it("records an acceptance and leaves the stage for update_lead_stage", async () => {
    const one = desk();
    const result = await tools(one).recordQuoteOutcome.execute(
      { quoteId: "Q-3047", outcome: "accepted", note: "Nina signed it." },
      call("accepted"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("as accepted on 2026-11-01");
    expect(text(result)).toContain("Next: update_lead_stage to won");
    expect((await one.listLeads({ query: "L-211" }))[0]?.stage).toBe("quoted");
  });

  it("refuses to mark a quote awaiting approval as sent, and says it still waits for a person", async () => {
    const one = desk();
    const result = await tools(one).recordQuoteOutcome.execute(
      { quoteId: "Q-3052", outcome: "sent" },
      call("x"),
      BACKGROUND_CONTEXT,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(details(result).code).toBe("awaiting_approval");
    expect(text(result)).toContain("still waits for a person");
    expect(text(result)).toContain("must not be told it was sent");
    expect((await one.getQuote("Q-3052")).status).toBe("awaiting_approval");
  });

  it("answers a retried call with the outcome it already recorded", async () => {
    const one = desk();
    const args = { quoteId: "Q-3047", outcome: "declined", on: "2026-10-30" };
    const first = await tools(one).recordQuoteOutcome.execute(args, call("d"), BACKGROUND_CONTEXT);
    const again = await tools(one).recordQuoteOutcome.execute(args, call("d"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    expect((again as { isError?: boolean }).isError).toBeUndefined();
  });
});

describe("schedule_follow_up", () => {
  it("schedules the next touch, shows it in list_leads, and names the one it replaced", async () => {
    const one = desk();
    const first = await tools(one).scheduleFollowUp.execute(
      { leadId: "L-207", on: "2026-11-04", what: "Call Marisol about the scope." },
      call("f1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(first)).toContain(
      "Scheduled the next touch on lead L-207 for 2026-11-04: Call Marisol about the scope.",
    );
    const listed = await tools(one).listLeads.execute(
      { query: "L-207" },
      call("l"),
      BACKGROUND_CONTEXT,
    );
    expect(text(listed)).toContain("next follow-up 2026-11-04: Call Marisol about the scope.");
    const second = await tools(one).scheduleFollowUp.execute(
      { leadId: "L-207", on: "2026-11-05", what: "Email the scope." },
      call("f2"),
      BACKGROUND_CONTEXT,
    );
    expect(text(second)).toContain(
      "It replaces the one due 2026-11-04: Call Marisol about the scope.",
    );
  });

  it("refuses a day before today", async () => {
    const result = await tools(desk()).scheduleFollowUp.execute(
      { leadId: "L-207", on: "2026-10-20", what: "Call." },
      call("f"),
      BACKGROUND_CONTEXT,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toContain("before today, 2026-11-01");
  });

  it("answers a retried call with the follow-up it already scheduled", async () => {
    const one = desk();
    const args = { leadId: "L-207", on: "2026-11-04", what: "Call." };
    const first = await tools(one).scheduleFollowUp.execute(args, call("r"), BACKGROUND_CONTEXT);
    const again = await tools(one).scheduleFollowUp.execute(args, call("r"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    expect(text(again)).not.toContain("replaces");
  });
});

describe("pipeline_report", () => {
  it("reads the desk's counts and values by stage and its quotes by status", async () => {
    const result = await tools(desk()).pipelineReport.execute({}, call("p"), BACKGROUND_CONTEXT);
    expect(text(result)).toContain("Pipeline on 2026-11-01:");
    expect(text(result)).toContain("new — 3 leads — $0.00 estimated a year (3 with no estimate)");
    expect(text(result)).toContain("qualified — 1 lead — $4,005.25 estimated a year");
    expect(text(result)).toContain("won — 0 leads");
    expect(text(result)).toContain("awaiting approval — 3 quotes — $13,756.75");
    expect(text(result)).toContain("sent — 1 quote — $3,135.00");
    expect(details(result).found).toBe(true);
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

  it("names the certificate owner from the escalation path, not from this package", async () => {
    const theirs = await tools(desk()).readCompany.execute(
      { section: "profile" },
      call("c"),
      BACKGROUND_CONTEXT,
    );
    expect(text(theirs)).toContain("Certificates come from Dana Whitfield.");

    const moved = {
      ...company,
      escalation: company.escalation.map((rule) =>
        rule.topic === "contract-terms" ? { ...rule, toPersonId: "priya-raman" } : rule,
      ),
    };
    const result = await salesTools({ desk: desk(), company: moved }).readCompany.execute(
      { section: "profile" },
      call("c"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Certificates come from Priya Raman.");
    expect(text(result)).not.toContain("Dana Whitfield");
  });

  it("gives the price book and the quote limit from the company record", async () => {
    const result = await tools(desk()).readCompany.execute(
      { section: "pricing" },
      call("c"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("clean-deep-sqft — Deep clean, first visit — $0.12 per sq ft");
    // The threshold is the desk's to apply (the manifest limit, which an overlay may change), and a
    // client is never told it, so the company record shows the model none to repeat.
    expect(text(result)).not.toContain("waits for a person");
    expect(text(result)).not.toContain("$5,000.00");
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
      "No sales desk is bound to this role, so nothing was read or written.",
    );
    // The company record needs no desk, so a role with no system of record can still answer about
    // the business.
    expect(
      text(await role.readCompany.execute({ section: "hours" }, call("c"), BACKGROUND_CONTEXT)),
    ).toContain("Emergency line");
  });
});
