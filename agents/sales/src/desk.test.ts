/**
 * The desk's own rules for a quote: every price comes from the book, and the desk, not the model or
 * the manifest, decides whether a person must approve a quote, on the total it worked out itself.
 */

import { describe, expect, it } from "vitest";
import { fakeSalesDesk, quoteFacts, type SalesDesk, SalesDeskError } from "./desk.js";

const NOW = new Date("2026-11-01T09:00:00.000Z");
const LIMIT = 500000;

const desk = (): SalesDesk => fakeSalesDesk({ now: () => NOW });

/** Six lobbies, each with a strip-and-wax and a carpet line that the book's minimum raises. */
const SIX_LOBBIES = Array.from({ length: 6 }, () => [
  { priceBookItemId: "floor-strip-wax-sqft", quantity: 300 },
  { priceBookItemId: "floor-carpet-sqft", quantity: 400 },
]).flat();

describe("fakeSalesDesk quotes", () => {
  it("prices a line from the book: the caller names an item and a quantity, never a price", async () => {
    const quote = await desk().createQuote(
      { leadId: "L-204", lines: [{ priceBookItemId: "clean-deep-sqft", quantity: 5000 }] },
      { requestId: "price-1", quoteLimitCents: LIMIT },
    );
    expect(quote.lines[0]?.unitPriceCents).toBe(12);
    expect(quote.lines[0]?.amountCents).toBe(60000);
  });

  it("holds a quote over the limit for a person when only the minimums take it there", async () => {
    // Quantity times price is 6 × ($285.00 + $180.00) = $2,790.00; the minimums make it $5,250.00.
    const quote = await desk().createQuote(
      { leadId: "L-219", lines: SIX_LOBBIES },
      { requestId: "lobbies", quoteLimitCents: LIMIT },
    );
    expect(quote.lines.every((line) => line.minimumApplied)).toBe(true);
    expect(quote.totalCents).toBe(525000);
    expect(quote.status).toBe("awaiting_approval");
    expect(quote.approvalReasons).toEqual(["over_limit"]);
    expect(quote.quoteLimitCents).toBe(LIMIT);
  });

  it("holds any discount for a person, however small the quote", async () => {
    const quote = await desk().createQuote(
      {
        leadId: "L-204",
        lines: [{ priceBookItemId: "clean-deep-sqft", quantity: 3200 }],
        discountPercent: 5,
      },
      { requestId: "discount", quoteLimitCents: LIMIT },
    );
    expect(quote.status).toBe("awaiting_approval");
    expect(quote.approvalReasons).toEqual(["discount"]);
  });

  it("judges the limit on the total before any discount", async () => {
    // $5,685.25 before a 20% discount is $4,548.20 after it: still over the limit, because a
    // discount is a separate decision and must not carry a quote under the line it is held to.
    const quote = await desk().createQuote(
      {
        leadId: "L-207",
        lines: [
          { priceBookItemId: "clean-office-visit", quantity: 21.65 },
          { priceBookItemId: "porter-hour", quantity: 40 },
        ],
        discountPercent: 20,
      },
      { requestId: "both", quoteLimitCents: LIMIT },
    );
    expect(quote.totalCents).toBeLessThan(LIMIT);
    expect(quote.approvalReasons).toEqual(["discount", "over_limit"]);
  });

  it("makes a quote under the limit with no discount a draft ready to send", async () => {
    const one = desk();
    const quote = await one.createQuote(
      { leadId: "L-204", lines: [{ priceBookItemId: "clean-deep-sqft", quantity: 3200 }] },
      { requestId: "small", quoteLimitCents: LIMIT },
    );
    expect(quote.status).toBe("draft");
    expect(quote.approvalReasons).toEqual([]);
    expect((await one.listLeads({ query: "L-204" }))[0]?.stage).toBe("quoted");
  });

  it("holds every quote when no limit resolves, rather than guessing one", async () => {
    const quote = await desk().createQuote(
      { leadId: "L-204", lines: [{ priceBookItemId: "porter-hour", quantity: 1 }] },
      { requestId: "no-limit", quoteLimitCents: undefined },
    );
    expect(quote.status).toBe("awaiting_approval");
    expect(quote.approvalReasons).toEqual(["no_limit"]);
  });

  it("leaves the lead where it was while its quote waits", async () => {
    const one = desk();
    await one.createQuote(
      { leadId: "L-219", lines: SIX_LOBBIES },
      { requestId: "lobbies", quoteLimitCents: LIMIT },
    );
    expect((await one.listLeads({ query: "L-219" }))[0]?.stage).toBe("new");
  });
});

describe("fakeSalesDesk approveQuote", () => {
  async function waiting(one: SalesDesk) {
    return one.createQuote(
      { leadId: "L-219", lines: SIX_LOBBIES },
      { requestId: "lobbies", quoteLimitCents: LIMIT },
    );
  }

  it("makes the approved quote a draft ready to send, and moves the lead to quoted", async () => {
    const one = desk();
    const quote = await waiting(one);
    const approved = await one.approveQuote(
      { quoteId: quote.id, approved: quoteFacts(quote) },
      { requestId: "approve-1" },
    );
    expect(approved.status).toBe("draft");
    expect(approved.totalCents).toBe(525000);
    expect((await one.getQuote(quote.id)).status).toBe("draft");
    expect((await one.listLeads({ query: "L-219" }))[0]?.stage).toBe("quoted");
  });

  it("refuses facts that are not the quote as it stands", async () => {
    const one = desk();
    const quote = await waiting(one);
    const facts = { ...quoteFacts(quote), totalCents: 100 };
    const refused = one.approveQuote(
      { quoteId: quote.id, approved: facts },
      { requestId: "approve-2" },
    );
    await expect(refused).rejects.toThrow(SalesDeskError);
    await expect(
      one.approveQuote({ quoteId: quote.id, approved: facts }, { requestId: "approve-3" }),
    ).rejects.toMatchObject({ code: "quote_changed" });
    expect((await one.getQuote(quote.id)).status).toBe("awaiting_approval");
  });

  it("refuses a quote that is not waiting for approval", async () => {
    const one = desk();
    const ready = await one.getQuote("Q-3047");
    await expect(
      one.approveQuote({ quoteId: "Q-3047", approved: quoteFacts(ready) }, { requestId: "a" }),
    ).rejects.toMatchObject({ code: "not_awaiting_approval" });
    await expect(
      one.approveQuote({ quoteId: "Q-9999", approved: {} }, { requestId: "b" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("answers a retried approval with the quote it already approved", async () => {
    const one = desk();
    const quote = await waiting(one);
    const first = await one.approveQuote(
      { quoteId: quote.id, approved: quoteFacts(quote) },
      { requestId: "approve-once" },
    );
    const again = await one.approveQuote(
      { quoteId: quote.id, approved: quoteFacts(quote) },
      { requestId: "approve-once" },
    );
    expect(again).toEqual(first);
    // A new request for the same quote is a second approval of something already approved.
    await expect(
      one.approveQuote({ quoteId: quote.id, approved: quoteFacts(quote) }, { requestId: "other" }),
    ).rejects.toMatchObject({ code: "not_awaiting_approval" });
  });

  it("holds the evaluated quotes waiting for a person in the demonstration pipeline", async () => {
    const one = desk();
    for (const id of ["Q-3052", "Q-3053", "Q-3060"]) {
      expect((await one.getQuote(id)).status).toBe("awaiting_approval");
    }
    // A new quote never takes a number the desk already holds.
    const made = await one.createQuote(
      { leadId: "L-204", lines: [{ priceBookItemId: "porter-hour", quantity: 1 }] },
      { requestId: "n1", quoteLimitCents: LIMIT },
    );
    const next = await one.createQuote(
      { leadId: "L-204", lines: [{ priceBookItemId: "porter-hour", quantity: 2 }] },
      { requestId: "n2", quoteLimitCents: LIMIT },
    );
    expect([made.id, next.id]).toEqual(["Q-3051", "Q-3054"]);
  });
});

describe("fakeSalesDesk recurring lines", () => {
  /** One line of a quote for L-207, with the desk's own weeks in a month. */
  async function line(draft: Record<string, unknown>, requestId = "recurring") {
    const quote = await desk().createQuote(
      { leadId: "L-207", lines: [draft as never] },
      { requestId, quoteLimitCents: LIMIT },
    );
    return quote.lines[0];
  }

  it("counts five visits a week as 21.65 visits a month, from the company's weeks in a month", async () => {
    const counted = await line({
      priceBookItemId: "clean-office-visit",
      quantity: 1,
      visitsPerWeek: 5,
    });
    expect(counted?.quantity).toBe(21.65);
    expect(counted?.amountCents).toBe(400525);
    expect(counted?.recurring).toEqual({
      quantityPerVisit: 1,
      visitsPerWeek: 5,
      weeksPerMonth: 4.33,
    });
  });

  it("counts two visits a week as 8.66, not rounded to whole visits", async () => {
    const counted = await line({
      priceBookItemId: "clean-office-visit",
      quantity: 1,
      visitsPerWeek: 2,
    });
    expect(counted?.quantity).toBe(8.66);
    expect(counted?.amountCents).toBe(160210);
  });

  it("multiplies the units on each visit: three restrooms five times a week is 64.95", async () => {
    const counted = await line({
      priceBookItemId: "restroom-sanitise",
      quantity: 3,
      visitsPerWeek: 5,
    });
    expect(counted?.quantity).toBe(64.95);
    expect(counted?.amountCents).toBe(422175);
  });

  it("counts a month from the weeks the company sets, not a constant in the desk", async () => {
    const quote = await fakeSalesDesk({ now: () => NOW, weeksPerMonth: 4 }).createQuote(
      {
        leadId: "L-207",
        lines: [{ priceBookItemId: "clean-office-visit", quantity: 1, visitsPerWeek: 5 }],
      },
      { requestId: "four-weeks", quoteLimitCents: LIMIT },
    );
    expect(quote.lines[0]?.quantity).toBe(20);
  });

  it("applies the item's minimum after the visits are counted", async () => {
    // One deep-clean-sized minimum cannot be shown with a per-visit item, so a book with one proves it.
    const quote = await fakeSalesDesk({
      now: () => NOW,
      weeksPerMonth: 4.33,
      priceBook: [
        {
          id: "visit-with-minimum",
          name: "A visit with a minimum",
          category: "cleaning",
          unit: "visit",
          unitPriceCents: 1000,
          minimumCents: 50000,
          notes: "",
        },
      ],
    }).createQuote(
      {
        leadId: "L-207",
        lines: [{ priceBookItemId: "visit-with-minimum", quantity: 1, visitsPerWeek: 5 }],
      },
      { requestId: "minimum", quoteLimitCents: LIMIT },
    );
    expect(quote.lines[0]?.quantity).toBe(21.65);
    expect(quote.lines[0]?.minimumApplied).toBe(true);
    expect(quote.lines[0]?.amountCents).toBe(50000);
  });

  it("refuses visitsPerWeek on an item that is not priced per visit", async () => {
    await expect(
      line({ priceBookItemId: "clean-deep-sqft", quantity: 3000, visitsPerWeek: 5 }),
    ).rejects.toThrow(/Line 1 gives visitsPerWeek, but clean-deep-sqft is priced per sq ft/);
  });

  it("refuses a frequency that is not more than zero and at most seven a week", async () => {
    for (const visitsPerWeek of [0, -1, 8, Number.NaN]) {
      await expect(
        line({ priceBookItemId: "clean-office-visit", quantity: 1, visitsPerWeek }),
      ).rejects.toMatchObject({
        code: "invalid",
        message: expect.stringContaining("visitsPerWeek"),
      });
    }
  });

  it("leaves a line without visitsPerWeek exactly as it was", async () => {
    const plain = await line({ priceBookItemId: "clean-office-visit", quantity: 21.65 });
    expect(plain?.quantity).toBe(21.65);
    expect(plain?.amountCents).toBe(400525);
    expect(plain).not.toHaveProperty("recurring");
  });

  it("answers a replayed request with the same quote", async () => {
    const one = desk();
    const draft = {
      leadId: "L-207",
      lines: [{ priceBookItemId: "clean-office-visit", quantity: 1, visitsPerWeek: 5 }],
    };
    const first = await one.createQuote(draft, { requestId: "replay", quoteLimitCents: LIMIT });
    const again = await one.createQuote(draft, { requestId: "replay", quoteLimitCents: LIMIT });
    expect(again).toBe(first);
  });

  it("puts the frequency in the facts a person approves, so a changed one is not approved", async () => {
    const one = desk();
    const quote = await one.createQuote(
      {
        leadId: "L-207",
        lines: [{ priceBookItemId: "clean-office-visit", quantity: 1, visitsPerWeek: 5 }],
        discountPercent: 5,
      },
      { requestId: "facts", quoteLimitCents: LIMIT },
    );
    const facts = quoteFacts(quote) as { lines: { visitsPerWeek: number | null }[] };
    expect(facts.lines[0]?.visitsPerWeek).toBe(5);
    const changed = {
      ...facts,
      lines: facts.lines.map((entry) => ({ ...entry, visitsPerWeek: 4 })),
    };
    await expect(
      one.approveQuote({ quoteId: quote.id, approved: changed }, { requestId: "approve" }),
    ).rejects.toMatchObject({ code: "quote_changed" });
  });
});

describe("fakeSalesDesk updateLeadStage", () => {
  it("moves a lead with a reason, and records the reason on the lead", async () => {
    const one = desk();
    const moved = await one.updateLeadStage(
      { leadId: "L-215", stage: "qualified", reason: "Walked the clinic: 4,100 sq ft, nightly." },
      { requestId: "stage-1" },
    );
    expect(moved.from).toBe("new");
    expect(moved.lead.stage).toBe("qualified");
    expect(moved.activity.leadId).toBe("L-215");
    expect(moved.activity.summary).toContain("new to qualified");
    expect(moved.activity.summary).toContain("Walked the clinic");
    expect((await one.listLeads({ query: "L-215" }))[0]?.stage).toBe("qualified");
    expect((await one.listLeads({ query: "L-215" }))[0]?.lastActivityAt).toBe("2026-11-01");
  });

  it("answers a replayed request with the same move and writes nothing twice", async () => {
    const one = desk();
    const input = { leadId: "L-215", stage: "qualified" as const, reason: "Measured." };
    const first = await one.updateLeadStage(input, { requestId: "stage-replay" });
    const again = await one.updateLeadStage(input, { requestId: "stage-replay" });
    expect(again).toEqual(first);
    // A new request for the same move is a no-op, so it is refused rather than written again.
    await expect(one.updateLeadStage(input, { requestId: "stage-other" })).rejects.toMatchObject({
      code: "no_change",
    });
  });

  it("refuses an unknown lead, an unknown stage and a move with no reason", async () => {
    const one = desk();
    await expect(
      one.updateLeadStage({ leadId: "L-999", stage: "qualified", reason: "x" }, { requestId: "a" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      one.updateLeadStage(
        { leadId: "L-215", stage: "closed" as never, reason: "x" },
        { requestId: "b" },
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      one.updateLeadStage({ leadId: "L-215", stage: "qualified", reason: " " }, { requestId: "c" }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("refuses quoted while the lead's only quote waits for a person", async () => {
    const one = desk();
    // L-219's only quote, Q-3060, is awaiting approval: the lead is not quoted yet.
    await expect(
      one.updateLeadStage({ leadId: "L-219", stage: "quoted", reason: "x" }, { requestId: "q1" }),
    ).rejects.toMatchObject({ code: "no_ready_quote" });
    // L-204 has no quote at all.
    await expect(
      one.updateLeadStage({ leadId: "L-204", stage: "quoted", reason: "x" }, { requestId: "q2" }),
    ).rejects.toMatchObject({ code: "no_ready_quote" });
  });

  it("treats won and lost as final: a person reopens a closed deal", async () => {
    const one = desk();
    await one.updateLeadStage(
      { leadId: "L-211", stage: "lost", reason: "No answer in three weeks." },
      { requestId: "lost" },
    );
    const reopen = one.updateLeadStage(
      { leadId: "L-211", stage: "quoted", reason: "They came back." },
      { requestId: "reopen" },
    );
    await expect(reopen).rejects.toMatchObject({ code: "closed" });
    await expect(
      one.updateLeadStage({ leadId: "L-211", stage: "won", reason: "x" }, { requestId: "r2" }),
    ).rejects.toThrow("a person reopens");
  });
});

describe("fakeSalesDesk recordQuoteOutcome", () => {
  /** A desk with a fresh draft ready to send, Q-3051, for Riverside Dental. */
  async function ready() {
    const one = desk();
    await one.createQuote(
      { leadId: "L-204", lines: [{ priceBookItemId: "clean-deep-sqft", quantity: 3200 }] },
      { requestId: "ready", quoteLimitCents: LIMIT },
    );
    return one;
  }

  it("marks a draft sent, dated today by default, and then accepted on the date given", async () => {
    const one = await ready();
    const sent = await one.recordQuoteOutcome(
      { quoteId: "Q-3051", outcome: "sent" },
      { requestId: "sent" },
    );
    expect(sent.from).toBe("draft");
    expect(sent.quote.status).toBe("sent");
    expect(sent.quote.sentOn).toBe("2026-11-01");
    const accepted = await one.recordQuoteOutcome(
      { quoteId: "Q-3051", outcome: "accepted", on: "2026-11-01", note: "Signed by Dr. Nguyen." },
      { requestId: "accepted" },
    );
    expect(accepted.quote.status).toBe("accepted");
    expect(accepted.quote.acceptedOn).toBe("2026-11-01");
    expect(accepted.quote.sentOn).toBe("2026-11-01");
    expect(accepted.activity.summary).toContain("Signed by Dr. Nguyen.");
    expect((await one.getQuote("Q-3051")).status).toBe("accepted");
    // An accepted quote does not close the deal: the stage is moved by a person's decision.
    expect((await one.listLeads({ query: "L-204" }))[0]?.stage).toBe("quoted");
  });

  it("records a decline with its date", async () => {
    const one = desk();
    // Q-3047 went out on 2026-10-15 in the demonstration pipeline.
    expect((await one.getQuote("Q-3047")).sentOn).toBe("2026-10-15");
    const declined = await one.recordQuoteOutcome(
      { quoteId: "Q-3047", outcome: "declined", on: "2026-10-30" },
      { requestId: "declined" },
    );
    expect(declined.quote.status).toBe("declined");
    expect(declined.quote.declinedOn).toBe("2026-10-30");
  });

  it("never marks a quote awaiting approval as sent: it is not approved", async () => {
    const one = desk();
    await expect(
      one.recordQuoteOutcome({ quoteId: "Q-3052", outcome: "sent" }, { requestId: "x" }),
    ).rejects.toMatchObject({ code: "awaiting_approval" });
    await expect(
      one.recordQuoteOutcome({ quoteId: "Q-3052", outcome: "sent" }, { requestId: "y" }),
    ).rejects.toThrow("waits for a person");
    expect((await one.getQuote("Q-3052")).status).toBe("awaiting_approval");
  });

  it("refuses a step out of order, a date in the future and a date before the quote was sent", async () => {
    const one = await ready();
    await expect(
      one.recordQuoteOutcome({ quoteId: "Q-3051", outcome: "accepted" }, { requestId: "a" }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(
      one.recordQuoteOutcome(
        { quoteId: "Q-3051", outcome: "sent", on: "2026-11-02" },
        { requestId: "b" },
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      one.recordQuoteOutcome(
        { quoteId: "Q-3051", outcome: "sent", on: "2026-10-31" },
        { requestId: "c" },
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      one.recordQuoteOutcome(
        { quoteId: "Q-3051", outcome: "sent", on: "1 Nov" },
        { requestId: "d" },
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      one.recordQuoteOutcome({ quoteId: "Q-3047", outcome: "sent" }, { requestId: "e" }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(
      one.recordQuoteOutcome({ quoteId: "Q-9999", outcome: "sent" }, { requestId: "f" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("answers a replayed request with the same outcome and writes nothing twice", async () => {
    const one = await ready();
    const first = await one.recordQuoteOutcome(
      { quoteId: "Q-3051", outcome: "sent" },
      { requestId: "once" },
    );
    const again = await one.recordQuoteOutcome(
      { quoteId: "Q-3051", outcome: "sent" },
      { requestId: "once" },
    );
    expect(again).toEqual(first);
    expect((await one.getQuote("Q-3051")).status).toBe("sent");
  });
});

describe("fakeSalesDesk scheduleFollowUp", () => {
  it("schedules the next touch, shows it on the lead, and says which one it replaced", async () => {
    const one = desk();
    const first = await one.scheduleFollowUp(
      { leadId: "L-207", on: "2026-11-04", what: "Call Marisol about the scope." },
      { requestId: "f1" },
    );
    expect(first.replaced).toBeNull();
    expect(first.followUp).toEqual({ on: "2026-11-04", what: "Call Marisol about the scope." });
    expect((await one.listLeads({ query: "L-207" }))[0]?.nextFollowUp?.on).toBe("2026-11-04");
    const second = await one.scheduleFollowUp(
      { leadId: "L-207", on: "2026-11-01", what: "Email the scope." },
      { requestId: "f2" },
    );
    expect(second.replaced).toEqual(first.followUp);
    expect((await one.listLeads({ query: "L-207" }))[0]?.nextFollowUp?.what).toBe(
      "Email the scope.",
    );
  });

  it("refuses a day before today, a date it cannot read, no task and an unknown lead", async () => {
    const one = desk();
    for (const [input, code] of [
      [{ leadId: "L-207", on: "2026-10-31", what: "Call" }, "invalid"],
      [{ leadId: "L-207", on: "next week", what: "Call" }, "invalid"],
      [{ leadId: "L-207", on: "2026-11-05", what: " " }, "invalid"],
      [{ leadId: "L-999", on: "2026-11-05", what: "Call" }, "not_found"],
    ] as const) {
      await expect(one.scheduleFollowUp(input, { requestId: input.on })).rejects.toMatchObject({
        code,
      });
    }
    expect((await one.listLeads({ query: "L-207" }))[0]?.nextFollowUp).toBeNull();
  });

  it("answers a replayed request with the same follow-up and writes nothing twice", async () => {
    const one = desk();
    const input = { leadId: "L-207", on: "2026-11-04", what: "Call Marisol." };
    const first = await one.scheduleFollowUp(input, { requestId: "same" });
    const again = await one.scheduleFollowUp(input, { requestId: "same" });
    expect(again).toEqual(first);
    expect(again.replaced).toBeNull();
  });
});

describe("fakeSalesDesk pipelineReport", () => {
  it("counts the leads and their estimated value by stage, and the quotes by status", async () => {
    const report = await desk().pipelineReport();
    expect(report.asOf).toBe("2026-11-01");
    expect(report.stages).toEqual([
      { stage: "new", count: 3, valueCents: 0, unvalued: 3 },
      { stage: "qualified", count: 1, valueCents: 400525, unvalued: 0 },
      { stage: "quoted", count: 1, valueCents: 320000, unvalued: 0 },
      { stage: "won", count: 0, valueCents: 0, unvalued: 0 },
      { stage: "lost", count: 0, valueCents: 0, unvalued: 0 },
    ]);
    expect(report.quotes).toEqual([
      { status: "awaiting_approval", count: 3, totalCents: 568525 + 282150 + 525000 },
      { status: "draft", count: 0, totalCents: 0 },
      { status: "sent", count: 1, totalCents: 313500 },
      { status: "accepted", count: 0, totalCents: 0 },
      { status: "declined", count: 0, totalCents: 0 },
    ]);
  });

  it("follows the desk as it changes", async () => {
    const one = desk();
    await one.updateLeadStage(
      { leadId: "L-211", stage: "won", reason: "Signed." },
      { requestId: "won" },
    );
    const report = await one.pipelineReport();
    expect(report.stages.find((row) => row.stage === "won")).toEqual({
      stage: "won",
      count: 1,
      valueCents: 320000,
      unvalued: 0,
    });
  });
});
