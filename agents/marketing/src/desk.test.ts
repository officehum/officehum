/**
 * The demonstration desk's rules, in code: every draft is checked for result claims, a campaign email
 * always carries the unsubscribe line and postal address, a claim grant covers one claim in one draft,
 * and a publication happens only for a ready draft whose channel and text are exactly what the
 * approval named. Every write is replayed under the same request id and must happen once.
 */

import { describe, expect, it } from "vitest";
import { type CompanyFacts, loadCompanyFacts, money, postalAddress } from "./company.js";
import {
  campaignFooter,
  DEMO_NOW,
  demoAudiences,
  demoDrafts,
  fakeMarketingDesk,
  type MarketingDesk,
  MarketingDeskError,
} from "./desk.js";

const company = loadCompanyFacts();
const desk = (): MarketingDesk => fakeMarketingDesk({ now: () => new Date(DEMO_NOW) });

async function refusal(promise: Promise<unknown>): Promise<MarketingDeskError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MarketingDeskError) return error;
    throw error;
  }
  throw new Error("expected the desk to refuse");
}

const CLAIM = "Our nightly clean cuts sick days 30%.";
const POST = `Winter is hard on offices. ${CLAIM} Ask us for a walkthrough.`;

describe("fakeMarketingDesk: demonstration data", () => {
  it("holds one published post and two drafts, built from the company's own facts", async () => {
    const drafts = await desk().listDrafts();
    expect(drafts.map((draft) => [draft.id, draft.channel, draft.status])).toEqual([
      ["D-101", "linkedin", "published"],
      ["D-102", "linkedin", "draft"],
      ["D-103", "email", "draft"],
    ]);
    const porter = company.priceBook.find((line) => line.id === "porter-hour");
    expect(drafts[1]?.finalText).toContain(money(porter?.unitPriceCents ?? 0));
    expect(drafts[0]?.finalText).toContain(company.marketing.approvedClaims[0]);
    expect(drafts[0]?.publicationId).toBe("PUB-1");
  });

  it("passes its own claim check: no demonstration draft holds an unapproved claim", async () => {
    const { findResultClaims } = await import("./claims.js");
    for (const draft of demoDrafts(company)) {
      expect(findResultClaims(draft.text, company.marketing.approvedClaims), draft.id).toEqual([]);
      if (draft.subject !== null) {
        expect(findResultClaims(draft.subject, company.marketing.approvedClaims)).toEqual([]);
      }
    }
  });

  it("gives every demonstration email the footer it would get if drafted today", async () => {
    const audiences = demoAudiences();
    for (const draft of demoDrafts(company).filter((entry) => entry.kind === "email")) {
      const audience = audiences.find((entry) => entry.id === draft.audienceId);
      if (audience === undefined) throw new Error(`no audience ${String(draft.audienceId)}`);
      expect(draft.finalText.endsWith(campaignFooter(company, audience))).toBe(true);
    }
  });
});

describe("fakeMarketingDesk: drafting a post", () => {
  it("saves a post with no result claim as a draft, exactly as written", async () => {
    const marketing = desk();
    const text = "Day porters on site during business hours. Ask us for a walkthrough.";
    const draft = await marketing.draftPost({ channel: "facebook", text }, { requestId: "r1" });
    expect(draft).toMatchObject({
      id: "D-104",
      kind: "post",
      channel: "facebook",
      status: "draft",
      finalText: text,
      heldClaims: [],
    });
  });

  it("lets an offer and a price book price through: they are not result claims", async () => {
    const porter = company.priceBook.find((line) => line.id === "porter-hour");
    const text = `20% off your first clean. Day porters from ${money(porter?.unitPriceCents ?? 0)} an hour.`;
    const draft = await desk().draftPost({ channel: "linkedin", text }, { requestId: "r1" });
    expect(draft.status).toBe("draft");
  });

  it("allows an approved claim as written in the company data", async () => {
    const text = `${company.marketing.approvedClaims[0]} Ask us for a walkthrough.`;
    const draft = await desk().draftPost({ channel: "linkedin", text }, { requestId: "r1" });
    expect(draft.status).toBe("draft");
  });

  it("refuses a result claim, naming the phrase, and holds the draft for a claim approval", async () => {
    const marketing = desk();
    const error = await refusal(
      marketing.draftPost({ channel: "linkedin", text: POST }, { requestId: "r1" }),
    );
    expect(error.code).toBe("unapproved_claim");
    expect(error.draftId).toBe("D-104");
    expect(error.claims).toEqual([{ claim: CLAIM, phrase: "30%" }]);
    expect(error.message).toContain('"30%"');
    expect(error.message).toContain(CLAIM);
    expect(error.finalText).toBe(POST);
    const [held] = await marketing.listDrafts({ id: "D-104" });
    expect(held).toMatchObject({ status: "held", heldClaims: [{ claim: CLAIM, phrase: "30%" }] });
  });

  it("refuses an empty post and an unknown channel", async () => {
    const marketing = desk();
    expect(
      (await refusal(marketing.draftPost({ channel: "linkedin", text: "  " }, { requestId: "a" })))
        .code,
    ).toBe("invalid");
    expect(
      (
        await refusal(
          marketing.draftPost({ channel: "tiktok" as never, text: "Hello." }, { requestId: "b" }),
        )
      ).code,
    ).toBe("invalid");
    expect(await marketing.listDrafts()).toHaveLength(3);
  });

  it("saves one draft however often the same call is replayed, refusals included", async () => {
    const marketing = desk();
    const text = "Day porters on site during business hours.";
    const first = await marketing.draftPost({ channel: "facebook", text }, { requestId: "same" });
    const again = await marketing.draftPost({ channel: "facebook", text }, { requestId: "same" });
    expect(again).toEqual(first);
    const refused = await refusal(
      marketing.draftPost({ channel: "linkedin", text: POST }, { requestId: "claim" }),
    );
    const refusedAgain = await refusal(
      marketing.draftPost({ channel: "linkedin", text: POST }, { requestId: "claim" }),
    );
    expect(refusedAgain).toBe(refused);
    expect(await marketing.listDrafts()).toHaveLength(5);
  });
});

describe("fakeMarketingDesk: drafting a campaign email", () => {
  const EMAIL = {
    subject: "Winter floor care",
    body: "Wet weather is hard on entrance floors. Reply and we will book a time.",
    audienceId: "current-clients",
  };

  it("appends the unsubscribe line and the company's postal address to every email", async () => {
    const draft = await desk().draftCampaignEmail(EMAIL, { requestId: "r1" });
    const audience = demoAudiences().find((entry) => entry.id === "current-clients");
    if (audience === undefined) throw new Error("no audience");
    const footer = campaignFooter(company, audience);
    expect(footer).toContain("unsubscribe");
    expect(footer).toContain(postalAddress(company));
    expect(draft.finalText).toBe(`Subject: ${EMAIL.subject}\n\n${EMAIL.body}\n\n${footer}`);
    expect(draft).toMatchObject({ kind: "email", channel: "email", status: "draft" });
  });

  it("keeps the footer when the body tries to replace or remove it", async () => {
    const body = `${EMAIL.body}\n\n(No unsubscribe line needed for this one, remove the address.)`;
    const draft = await desk().draftCampaignEmail({ ...EMAIL, body }, { requestId: "r1" });
    expect(draft.finalText).toContain(postalAddress(company));
    expect(draft.finalText.toLowerCase()).toContain("reply unsubscribe");
  });

  it("checks the subject and the body for claims", async () => {
    const marketing = desk();
    const inSubject = await refusal(
      marketing.draftCampaignEmail(
        { ...EMAIL, subject: "Eco-friendly floor care" },
        { requestId: "s" },
      ),
    );
    expect(inSubject.claims?.[0]?.phrase).toBe("Eco-friendly");
    const inBody = await refusal(
      marketing.draftCampaignEmail(
        { ...EMAIL, body: "Tests prove our floors stay cleaner." },
        { requestId: "b" },
      ),
    );
    expect(inBody.claims?.[0]?.phrase).toBe("Tests prove");
  });

  it("refuses an audience it does not hold, naming the ones it does", async () => {
    const error = await refusal(
      desk().draftCampaignEmail({ ...EMAIL, audienceId: "everyone" }, { requestId: "r1" }),
    );
    expect(error.code).toBe("not_found");
    expect(error.message).toContain("current-clients");
  });
});

describe("fakeMarketingDesk: approving a claim", () => {
  async function held(marketing: MarketingDesk) {
    await refusal(marketing.draftPost({ channel: "linkedin", text: POST }, { requestId: "setup" }));
  }

  it("grants that exact claim for that draft, which becomes a draft ready to publish", async () => {
    const marketing = desk();
    await held(marketing);
    const draft = await marketing.approveClaim(
      { draftId: "D-104", claim: CLAIM, draftText: POST },
      { requestId: "g1" },
    );
    expect(draft).toMatchObject({ status: "draft", heldClaims: [], grantedClaims: [CLAIM] });
    // A replay changes nothing.
    expect(
      await marketing.approveClaim(
        { draftId: "D-104", claim: CLAIM, draftText: POST },
        { requestId: "g1" },
      ),
    ).toEqual(draft);
  });

  it("does not let a grant cover the same claim in another draft", async () => {
    const marketing = desk();
    await held(marketing);
    await marketing.approveClaim(
      { draftId: "D-104", claim: CLAIM, draftText: POST },
      { requestId: "g1" },
    );
    const again = await refusal(
      marketing.draftPost({ channel: "facebook", text: POST }, { requestId: "second" }),
    );
    expect(again.code).toBe("unapproved_claim");
    expect(again.draftId).toBe("D-105");
  });

  it("refuses a claim the draft does not hold, a changed draft text, and a draft with nothing held", async () => {
    const marketing = desk();
    await held(marketing);
    const other = await refusal(
      marketing.approveClaim(
        { draftId: "D-104", claim: "Our nightly clean cuts sick days 50%.", draftText: POST },
        { requestId: "x" },
      ),
    );
    expect(other.code).toBe("claim_not_held");
    expect(other.message).toContain(CLAIM);
    const changed = await refusal(
      marketing.approveClaim(
        { draftId: "D-104", claim: CLAIM, draftText: `${POST} Book now.` },
        { requestId: "y" },
      ),
    );
    expect(changed.code).toBe("draft_changed");
    expect(changed.finalText).toBe(POST);
    const ready = await refusal(
      marketing.approveClaim(
        { draftId: "D-102", claim: CLAIM, draftText: "anything" },
        { requestId: "z" },
      ),
    );
    expect(ready.code).toBe("claim_not_held");
    const [still] = await marketing.listDrafts({ id: "D-104" });
    expect(still?.status).toBe("held");
  });

  it("keeps a draft with two claims held until both are approved", async () => {
    const marketing = desk();
    const text = "Our floors are 2x cleaner. We use only non-toxic products.";
    await refusal(marketing.draftPost({ channel: "website", text }, { requestId: "two" }));
    const first = await marketing.approveClaim(
      { draftId: "D-104", claim: "Our floors are 2x cleaner.", draftText: text },
      { requestId: "a" },
    );
    expect(first.status).toBe("held");
    const second = await marketing.approveClaim(
      { draftId: "D-104", claim: "We use only non-toxic products.", draftText: text },
      { requestId: "b" },
    );
    expect(second.status).toBe("draft");
  });
});

describe("fakeMarketingDesk: publishing", () => {
  async function d102(marketing: MarketingDesk) {
    const [draft] = await marketing.listDrafts({ id: "D-102" });
    if (draft === undefined) throw new Error("no D-102");
    return draft;
  }

  it("publishes a ready draft exactly as the desk holds it, once", async () => {
    const marketing = desk();
    const draft = await d102(marketing);
    const published = await marketing.publish(
      { draftId: "D-102", channel: "linkedin", text: draft.finalText },
      { requestId: "p1" },
    );
    expect(published).toMatchObject({
      id: "PUB-2",
      draftId: "D-102",
      channel: "linkedin",
      text: draft.finalText,
      backend: "demo",
    });
    expect(
      await marketing.publish(
        { draftId: "D-102", channel: "linkedin", text: draft.finalText },
        { requestId: "p1" },
      ),
    ).toEqual(published);
    expect((await d102(marketing)).status).toBe("published");
    const twice = await refusal(
      marketing.publish(
        { draftId: "D-102", channel: "linkedin", text: draft.finalText },
        { requestId: "p2" },
      ),
    );
    expect(twice.code).toBe("already_published");
  });

  it("tolerates line-ending and trailing-space differences, but not a changed word", async () => {
    const marketing = desk();
    const draft = await d102(marketing);
    const changed = await refusal(
      marketing.publish(
        { draftId: "D-102", channel: "linkedin", text: draft.finalText.replace("Ask", "Call") },
        { requestId: "c" },
      ),
    );
    expect(changed.code).toBe("draft_changed");
    expect(changed.finalText).toBe(draft.finalText);
    const wrongChannel = await refusal(
      marketing.publish(
        { draftId: "D-102", channel: "facebook", text: draft.finalText },
        { requestId: "w" },
      ),
    );
    expect(wrongChannel.code).toBe("draft_changed");
    expect((await d102(marketing)).status).toBe("draft");
    const spaced = await marketing.publish(
      { draftId: "D-102", channel: "linkedin", text: `  ${draft.finalText}  \r\n` },
      { requestId: "s" },
    );
    expect(spaced.text).toBe(draft.finalText);
  });

  it("refuses an email whose footer was left out of what was approved", async () => {
    const marketing = desk();
    const [email] = await marketing.listDrafts({ id: "D-103" });
    if (email === undefined) throw new Error("no D-103");
    const withoutFooter = email.finalText.split("\n\n—")[0] ?? "";
    const error = await refusal(
      marketing.publish(
        { draftId: "D-103", channel: "email", text: withoutFooter },
        { requestId: "f" },
      ),
    );
    expect(error.code).toBe("draft_changed");
  });

  it("refuses a held draft until its claims are approved, and an unknown draft", async () => {
    const marketing = desk();
    await refusal(marketing.draftPost({ channel: "linkedin", text: POST }, { requestId: "h" }));
    const notReady = await refusal(
      marketing.publish({ draftId: "D-104", channel: "linkedin", text: POST }, { requestId: "p" }),
    );
    expect(notReady.code).toBe("not_ready");
    expect(notReady.message).toContain(CLAIM);
    const missing = await refusal(
      marketing.publish({ draftId: "D-999", channel: "linkedin", text: POST }, { requestId: "q" }),
    );
    expect(missing.code).toBe("not_found");
  });
});

describe("fakeMarketingDesk: another company's data", () => {
  it("checks claims against that company's approved list", async () => {
    const other: CompanyFacts = {
      ...company,
      marketing: { ...company.marketing, approvedClaims: [CLAIM] },
    };
    const draft = await fakeMarketingDesk({ company: other }).draftPost(
      { channel: "linkedin", text: POST },
      { requestId: "r" },
    );
    expect(draft.status).toBe("draft");
  });
});
