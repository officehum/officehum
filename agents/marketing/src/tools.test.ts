/**
 * One block per tool, against `fakeMarketingDesk` and the company facts generated into this package,
 * through the registrations the factory builds and with the durable call identity Pi Durable hands to
 * `execute`. Every unsafe tool is replayed under the same call id here, at the tool level, and must
 * write once. No network, no model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import {
  loadCompanyFacts,
  marketingApprover,
  money,
  personLabel,
  postalAddress,
} from "./company.js";
import {
  DEMO_NOW,
  type Draft,
  fakeMarketingDesk,
  type MarketingDesk,
  MarketingDeskError,
} from "./desk.js";
import { type MarketingToolset, marketingTools } from "./tools.js";

const company = loadCompanyFacts();
const approver = personLabel(marketingApprover(company));

/** The durable identity one tool call runs under; only the ids matter to these tools. */
const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;

const tools = (desk: MarketingDesk | undefined): MarketingToolset =>
  marketingTools({ desk, company });

const desk = (): MarketingDesk => fakeMarketingDesk({ now: () => new Date(DEMO_NOW) });

function text(result: { output?: readonly unknown[] }): string {
  return (result.output ?? [])
    .map((block) => (block as { type?: string; text?: string }).text ?? "")
    .join("\n");
}

function details(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

const CLAIM = "Our nightly clean cuts sick days 30%.";
const POST = `Winter is hard on offices. ${CLAIM} Ask us for a walkthrough.`;
const EMAIL = {
  subject: "Winter floor care",
  body: "Wet weather is hard on entrance floors. Reply and we will book a time.",
  audienceId: "current-clients",
};

async function draft(marketing: MarketingDesk, id: string): Promise<Draft> {
  const [found] = await marketing.listDrafts({ id });
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
}

describe("read_services", () => {
  it("lists every service with its price book lines, priced from the company", async () => {
    const result = await tools(desk()).readServices.execute({}, call("s"), BACKGROUND_CONTEXT);
    const porter = company.priceBook.find((line) => line.id === "porter-hour");
    expect(text(result)).toContain(`Services (${company.services.length})`);
    for (const service of company.services) expect(text(result)).toContain(service.name);
    expect(text(result)).toContain(`${money(porter?.unitPriceCents ?? 0)} per hour`);
    expect(details(result).found).toBe(true);
  });
});

describe("draft_post", () => {
  it("saves a draft, says nothing is published, and gives the full text to approve", async () => {
    const result = await tools(desk()).draftPost.execute(
      { channel: "facebook", text: "Day porters on site during business hours." },
      call("c1"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("Saved D-104 as a draft (facebook post). Nothing is published");
    expect(text(result)).toContain(approver);
    expect(text(result)).toContain("<text>\nDay porters on site during business hours.\n</text>");
  });

  it("refuses a result claim, naming the phrase, the held draft and request_claim_approval", async () => {
    const result = await tools(desk()).draftPost.execute(
      { channel: "linkedin", text: POST },
      call("c2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain(`"${CLAIM}" (the phrase "30%")`);
    expect(text(result)).toContain(
      `call request_claim_approval with draftId D-104, the claim exactly as quoted and draftText exactly as below, which asks ${approver}.`,
    );
    expect(text(result)).toContain(`<text>\n${POST}\n</text>`);
    expect(details(result)).toMatchObject({
      code: "unapproved_claim",
      draftId: "D-104",
      claims: [{ claim: CLAIM, phrase: "30%" }],
    });
  });

  it("chooses the next step from the refusal's code, not from its wording", async () => {
    // A host desk whose messages say nothing about the tools still gets the right next step.
    const quiet: MarketingDesk = {
      ...desk(),
      draftPost: async () => {
        throw new MarketingDeskError("unapproved_claim", "No.", {
          draftId: "X-9",
          claims: [{ claim: "Greener.", phrase: "Greener" }],
          finalText: "Greener.",
        });
      },
    };
    const result = await tools(quiet).draftPost.execute(
      { channel: "linkedin", text: "Greener." },
      call("c3"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("call request_claim_approval with draftId X-9");
    const other: MarketingDesk = {
      ...desk(),
      draftPost: async () => {
        throw new MarketingDeskError("invalid", "Tests prove request_claim_approval is needed.");
      },
    };
    const plain = await tools(other).draftPost.execute(
      { channel: "linkedin", text: "x" },
      call("c4"),
      BACKGROUND_CONTEXT,
    );
    expect(text(plain)).not.toContain("Next:");
  });

  it("saves one draft when the same call is replayed, and one held draft for a replayed refusal", async () => {
    const marketing = desk();
    const args = { channel: "facebook", text: "Day porters on site during business hours." };
    const first = await tools(marketing).draftPost.execute(args, call("same"), BACKGROUND_CONTEXT);
    const again = await tools(marketing).draftPost.execute(args, call("same"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    const held = { channel: "linkedin", text: POST };
    const refused = await tools(marketing).draftPost.execute(held, call("h"), BACKGROUND_CONTEXT);
    const refusedAgain = await tools(marketing).draftPost.execute(
      held,
      call("h"),
      BACKGROUND_CONTEXT,
    );
    expect(text(refusedAgain)).toBe(text(refused));
    expect(await marketing.listDrafts()).toHaveLength(5);
  });
});

describe("draft_campaign_email", () => {
  it("saves the email with the unsubscribe line and postal address the desk adds", async () => {
    const result = await tools(desk()).draftCampaignEmail.execute(
      EMAIL,
      call("e1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(
      "Saved D-104 as a draft (email to current-clients, channel email)",
    );
    expect(text(result)).toContain("To unsubscribe, reply UNSUBSCRIBE");
    expect(text(result)).toContain(postalAddress(company));
  });

  it("refuses an unknown audience, naming the ones there are", async () => {
    const result = await tools(desk()).draftCampaignEmail.execute(
      { ...EMAIL, audienceId: "everyone" },
      call("e2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("prospects");
  });

  it("saves one email when the same call is replayed", async () => {
    const marketing = desk();
    const first = await tools(marketing).draftCampaignEmail.execute(
      EMAIL,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    const again = await tools(marketing).draftCampaignEmail.execute(
      EMAIL,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    expect(text(again)).toBe(text(first));
    expect(await marketing.listDrafts()).toHaveLength(4);
  });
});

describe("request_claim_approval", () => {
  async function held(): Promise<MarketingDesk> {
    const marketing = desk();
    await tools(marketing).draftPost.execute(
      { channel: "linkedin", text: POST },
      call("setup"),
      BACKGROUND_CONTEXT,
    );
    return marketing;
  }

  it("records the grant for that draft only, publishes nothing, and replays without granting twice", async () => {
    const marketing = await held();
    const args = { draftId: "D-104", claim: CLAIM, draftText: POST };
    const first = await tools(marketing).requestClaimApproval.execute(
      args,
      call("g"),
      BACKGROUND_CONTEXT,
    );
    expect(text(first)).toContain(
      `Approved: "${CLAIM}" may be used in D-104, and in no other draft.`,
    );
    expect(text(first)).toContain("Nothing was published");
    const again = await tools(marketing).requestClaimApproval.execute(
      args,
      call("g"),
      BACKGROUND_CONTEXT,
    );
    expect(text(again)).toBe(text(first));
    expect((await draft(marketing, "D-104")).grantedClaims).toEqual([CLAIM]);
    expect((await draft(marketing, "D-104")).status).toBe("draft");
  });

  it("approves nothing when the draft text is not the draft's, and gives the text it holds", async () => {
    const marketing = await held();
    const result = await tools(marketing).requestClaimApproval.execute(
      { draftId: "D-104", claim: CLAIM, draftText: "Something else." },
      call("x"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("draft_changed");
    expect(text(result)).toContain(`<text>\n${POST}\n</text>`);
    expect((await draft(marketing, "D-104")).status).toBe("held");
  });
});

describe("publish", () => {
  it("publishes a ready draft on the demonstration backend, once, however often it is replayed", async () => {
    const marketing = desk();
    const ready = await draft(marketing, "D-102");
    const args = { draftId: "D-102", channel: "linkedin", text: ready.finalText };
    const first = await tools(marketing).publish.execute(args, call("p"), BACKGROUND_CONTEXT);
    expect(text(first)).toContain("Published PUB-2: D-102 on linkedin");
    expect(text(first)).toContain("demonstration backend");
    const again = await tools(marketing).publish.execute(args, call("p"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    expect((await draft(marketing, "D-102")).publicationId).toBe("PUB-2");
    const twice = await tools(marketing).publish.execute(args, call("p2"), BACKGROUND_CONTEXT);
    expect(details(twice).code).toBe("already_published");
  });

  it("publishes nothing for a changed text or a held draft, and says what to do", async () => {
    const marketing = desk();
    const changed = await tools(marketing).publish.execute(
      { draftId: "D-102", channel: "linkedin", text: "A different post." },
      call("c"),
      BACKGROUND_CONTEXT,
    );
    expect(details(changed).code).toBe("draft_changed");
    expect(text(changed)).toContain("give the text exactly as the desk holds it");
    await tools(marketing).draftPost.execute(
      { channel: "linkedin", text: POST },
      call("h"),
      BACKGROUND_CONTEXT,
    );
    const notReady = await tools(marketing).publish.execute(
      { draftId: "D-104", channel: "linkedin", text: POST },
      call("n"),
      BACKGROUND_CONTEXT,
    );
    expect(details(notReady).code).toBe("not_ready");
    expect(text(notReady)).toContain("request_claim_approval");
    expect((await draft(marketing, "D-102")).status).toBe("draft");
  });
});

describe("list_drafts", () => {
  it("lists each draft with its status and full text, and the audiences", async () => {
    const result = await tools(desk()).listDrafts.execute({}, call("l"), BACKGROUND_CONTEXT);
    expect(text(result)).toContain("Drafts (3):");
    expect(text(result)).toContain("D-101 — linkedin post — published 2026-11-02");
    expect(text(result)).toContain("D-102 — linkedin post — draft, ready to publish");
    expect(text(result)).toContain("D-103 — email to current-clients, channel email — draft");
    expect(text(result)).toContain("Audiences for a campaign email: current-clients");
    expect(details(result).found).toBe(true);
  });

  it("says plainly when no draft matches", async () => {
    const result = await tools(desk()).listDrafts.execute(
      { draftId: "D-999" },
      call("l"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).found).toBe(false);
  });
});

describe("read_company", () => {
  it("reads the approved claims word for word, says there are no testimonials, and names the approver", async () => {
    const result = await tools(desk()).readCompany.execute(
      { section: "marketing" },
      call("m"),
      BACKGROUND_CONTEXT,
    );
    for (const claim of company.marketing.approvedClaims) expect(text(result)).toContain(claim);
    expect(text(result)).toContain("Testimonials on file: none");
    expect(text(result)).toContain(approver);
  });

  it("quotes testimonials only when the company holds them", async () => {
    const withQuote = marketingTools({
      desk: desk(),
      company: {
        ...company,
        marketing: {
          ...company.marketing,
          testimonials: [{ quote: "Always on time.", by: "A client" }],
        },
      },
    });
    const result = await withQuote.readCompany.execute(
      { section: "marketing" },
      call("m"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain('- "Always on time." — A client');
  });

  it("reads the tone of voice the handbook sets", async () => {
    const result = await tools(desk()).readCompany.execute(
      { section: "tone" },
      call("t"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(company.tone.summary);
  });
});

describe("with no desk", () => {
  it("refuses at the point of use", async () => {
    await expect(
      tools(undefined).listDrafts.execute({}, call("n"), BACKGROUND_CONTEXT),
    ).rejects.toThrow("No marketing desk is configured");
  });
});
