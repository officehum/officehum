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
  heldDraftFacts,
  type MarketingDesk,
  MarketingDeskError,
  readyDraftFacts,
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

/** The demonstration desk's held Facebook post, and the claim it waits on. */
const FLOOR_CLAIM = "Our floor care leaves floors 2x cleaner.";
const FLOOR_POST = `${FLOOR_CLAIM} Ask us for a walkthrough.`;

/** A grant of one draft's held claims, carrying them as a person approved them. */
async function approvedClaims(marketing: MarketingDesk, draftId = "D-104") {
  const [draft] = await marketing.listDrafts({ id: draftId });
  if (draft === undefined) throw new Error(`no ${draftId} on the desk`);
  return { draftId, approved: heldDraftFacts(draft) };
}

/** A publication of one draft, carrying it as a person approved it. */
async function approvedPublication(marketing: MarketingDesk, draftId = "D-102") {
  const [draft] = await marketing.listDrafts({ id: draftId });
  if (draft === undefined) throw new Error(`no ${draftId} on the desk`);
  return { draftId, approved: readyDraftFacts(draft) };
}

describe("fakeMarketingDesk: demonstration data", () => {
  it("holds one published post, two drafts and two held posts, built from the company's own facts", async () => {
    const drafts = await desk().listDrafts();
    expect(drafts.map((draft) => [draft.id, draft.channel, draft.status])).toEqual([
      ["D-101", "linkedin", "published"],
      ["D-102", "linkedin", "draft"],
      ["D-103", "email", "draft"],
      ["D-104", "facebook", "held"],
      ["D-105", "linkedin", "held"],
    ]);
    expect(drafts[4]).toMatchObject({
      finalText: "Our nightly cleaning cuts sick days 30%. Ask us for a walkthrough.",
      heldClaims: [{ claim: "Our nightly cleaning cuts sick days 30%.", phrase: "30%" }],
    });
    expect(drafts[3]).toMatchObject({
      finalText: FLOOR_POST,
      heldClaims: [{ claim: FLOOR_CLAIM, phrase: "2x cleaner" }],
    });
    const porter = company.priceBook.find((line) => line.id === "porter-hour");
    expect(drafts[1]?.finalText).toContain(money(porter?.unitPriceCents ?? 0));
    expect(drafts[0]?.finalText).toContain(company.marketing.approvedClaims[0]);
    expect(drafts[0]?.publicationId).toBe("PUB-1");
  });

  it("passes its own claim check: only the held demonstration draft holds an unapproved claim, and it says which", async () => {
    const { findResultClaims } = await import("./claims.js");
    for (const draft of demoDrafts(company)) {
      expect(findResultClaims(draft.text, company.marketing.approvedClaims), draft.id).toEqual(
        draft.heldClaims,
      );
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
      id: "D-106",
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

  it("reads an offer on one of the company's own services as an offer, and a result dressed as one as a result", async () => {
    const service = company.services[0]?.name ?? "";
    const marketing = desk();
    const offer = await marketing.draftPost(
      { channel: "linkedin", text: `25% off ${service} cover this month.` },
      { requestId: "offer" },
    );
    expect(offer.status).toBe("draft");
    const dressed = await refusal(
      marketing.draftPost(
        { channel: "linkedin", text: "Takes 30% off your sick days." },
        { requestId: "dressed" },
      ),
    );
    expect(dressed.claims?.[0]?.phrase).toBe("30%");
  });

  describe("testimonials", () => {
    const invented =
      '"Northwind cut our sick days and the lobby has never looked this good." — Morgan Ellis';
    const recorded = company.marketing.testimonials?.[0];

    it("holds a testimonial on record for the tests below", () => {
      expect(recorded?.quote.split(/\s+/).length).toBeGreaterThanOrEqual(6);
    });

    it("refuses an invented testimonial, saves no draft, and gives no claim a person could approve", async () => {
      const marketing = desk();
      const error = await refusal(
        marketing.draftPost(
          { channel: "linkedin", text: `Hear it from a client. ${invented}` },
          { requestId: "t1" },
        ),
      );
      expect(error.code).toBe("unrecorded_testimonial");
      expect(error.draftId).toBeUndefined();
      expect(error.claims).toBeUndefined();
      expect(error.message).toContain("Northwind cut our sick days");
      expect(error.message).toContain("nothing was published");
      // The same call replayed is the same refusal, and no draft was saved.
      expect(
        (
          await refusal(
            marketing.draftPost({ channel: "linkedin", text: invented }, { requestId: "t1" }),
          )
        ).code,
      ).toBe("unrecorded_testimonial");
      expect(await marketing.listDrafts({ id: "D-106" })).toEqual([]);
      // With nothing held, a person is never asked to approve it.
      expect(
        (
          await refusal(
            marketing.approveClaim({ draftId: "D-106", approved: {} }, { requestId: "g" }),
          )
        ).code,
      ).toBe("not_found");
      // The refusal is for the quote even when the same text states a result claim.
      const both = await refusal(
        marketing.draftPost(
          { channel: "facebook", text: `${invented} Our floors are 2x cleaner.` },
          { requestId: "t2" },
        ),
      );
      expect(both.code).toBe("unrecorded_testimonial");
      expect(await marketing.listDrafts({ id: "D-106" })).toEqual([]);
      // An invented quote in a campaign email is refused the same way.
      const email = await refusal(
        marketing.draftCampaignEmail(
          { subject: "Kind words", body: invented, audienceId: "prospects" },
          { requestId: "t3" },
        ),
      );
      expect(email.code).toBe("unrecorded_testimonial");
    });

    it("never lets a held draft carrying an invented testimonial be approved or published", async () => {
      const [seed] = demoDrafts(company);
      if (seed === undefined) throw new Error("no demonstration draft");
      const text = `${invented} Our floors are 2x cleaner.`;
      const marketing = fakeMarketingDesk({
        now: () => new Date(DEMO_NOW),
        drafts: [
          {
            ...seed,
            id: "D-300",
            status: "held",
            text,
            finalText: text,
            heldClaims: [{ claim: "Our floors are 2x cleaner.", phrase: "2x cleaner" }],
          },
        ],
      });
      const grant = await approvedClaims(marketing, "D-300");
      expect((await refusal(marketing.approveClaim(grant, { requestId: "g" }))).code).toBe(
        "unrecorded_testimonial",
      );
      const [after] = await marketing.listDrafts({ id: "D-300" });
      expect(after?.status).toBe("held");
    });

    it("says what was refused at each step: nothing approved, nothing published, not 'nothing saved'", async () => {
      const [seed] = demoDrafts(company);
      if (seed === undefined) throw new Error("no demonstration draft");
      const held = `${invented} Our floors are 2x cleaner.`;
      const marketing = fakeMarketingDesk({
        now: () => new Date(DEMO_NOW),
        drafts: [
          {
            ...seed,
            id: "D-300",
            status: "held",
            text: held,
            finalText: held,
            heldClaims: [{ claim: "Our floors are 2x cleaner.", phrase: "2x cleaner" }],
          },
          { ...seed, id: "D-301", status: "draft", text: invented, finalText: invented },
        ],
      });
      const grant = await refusal(
        marketing.approveClaim(await approvedClaims(marketing, "D-300"), { requestId: "g" }),
      );
      expect(grant.message).toContain("Nothing was approved");
      expect(grant.message).not.toContain("Nothing was saved");
      const out = await refusal(
        marketing.publish(await approvedPublication(marketing, "D-301"), { requestId: "p" }),
      );
      expect(out.code).toBe("unrecorded_testimonial");
      expect(out.message).toContain("Nothing was published");
      expect(out.message).not.toContain("Nothing was saved");
    });

    it("saves and publishes an email whose body ends with a quoted slogan: the footer is not an attribution", async () => {
      const marketing = desk();
      const body =
        'Winter floor care is booked now. Our promise is simple: "clean offices make for happy teams every day"';
      const draft = await marketing.draftCampaignEmail(
        { subject: "Winter floor care", body, audienceId: "current-clients" },
        { requestId: "e1" },
      );
      expect(draft.status).toBe("draft");
      const published = await marketing.publish(await approvedPublication(marketing, draft.id), {
        requestId: "p1",
      });
      expect(published.draftId).toBe(draft.id);
    });

    it("saves an email whose quoted subject is followed by a greeting, and a post signed by the company", async () => {
      const marketing = desk();
      const email = await marketing.draftCampaignEmail(
        {
          subject: '"Clean offices make for happy teams every single day"',
          body: "Hi Dana,\nWinter floor care is booked now. Reply to book a time.",
          audienceId: "current-clients",
        },
        { requestId: "e3" },
      );
      expect(email.status).toBe("draft");
      const post = await marketing.draftPost(
        {
          channel: "linkedin",
          text: `"Clean offices make for happy teams every single day" — ${company.profile.tradingName}`,
        },
        { requestId: "s2" },
      );
      expect(post.status).toBe("draft");
    });

    it("leaves a quoted slogan followed by a dash and ordinary words alone", async () => {
      const draft = await desk().draftPost(
        {
          channel: "linkedin",
          text: 'Our motto is "clean offices make for happy teams every day" — and we mean it.',
        },
        { requestId: "s1" },
      );
      expect(draft.status).toBe("draft");
    });

    it("checks the same text for quotes when saving, approving and publishing", async () => {
      // An email's subject and body are what the model wrote; the desk's footer is not checked for
      // quotes at any step, so a draft that saved cleanly cannot be refused later for its footer.
      const marketing = desk();
      const body = 'Ask about "the seven-day fresh start for your whole office"';
      const draft = await marketing.draftCampaignEmail(
        { subject: "A fresh start", body, audienceId: "prospects" },
        { requestId: "e2" },
      );
      await expect(
        marketing.publish(await approvedPublication(marketing, draft.id), { requestId: "p2" }),
      ).resolves.toMatchObject({ draftId: draft.id });
    });

    it("accepts a testimonial on record, word for word, and still holds a result claim in it", async () => {
      if (recorded === undefined) throw new Error("the company records no testimonial");
      const marketing = desk();
      const draft = await marketing.draftPost(
        { channel: "linkedin", text: `"${recorded.quote}" — ${recorded.attribution}` },
        { requestId: "r1" },
      );
      expect(draft.status).toBe("draft");
      const mixed = await refusal(
        marketing.draftPost(
          {
            channel: "linkedin",
            text: `"${recorded.quote} Our floors are 2x cleaner." — ${recorded.attribution}`,
          },
          { requestId: "r2" },
        ),
      );
      expect(mixed.code).toBe("unrecorded_testimonial");
    });
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
    expect(error.draftId).toBe("D-106");
    expect(error.claims).toEqual([{ claim: CLAIM, phrase: "30%" }]);
    expect(error.message).toContain('"30%"');
    expect(error.message).toContain(CLAIM);
    expect(error.finalText).toBe(POST);
    const [held] = await marketing.listDrafts({ id: "D-106" });
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
    expect(await marketing.listDrafts()).toHaveLength(5);
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
    expect(await marketing.listDrafts()).toHaveLength(7);
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
  it("approves the held draft as the desk recorded it at refusal: its text and its held phrases", async () => {
    const [draft] = await desk().listDrafts({ id: "D-104" });
    if (draft === undefined) throw new Error("no D-104");
    expect(heldDraftFacts(draft)).toEqual({
      id: "D-104",
      kind: "post",
      channel: "facebook",
      audienceId: null,
      finalText: FLOOR_POST,
      heldClaims: [{ claim: FLOOR_CLAIM, phrase: "2x cleaner" }],
    });
  });

  it("grants the held claims for that draft, which becomes a draft ready to publish", async () => {
    const marketing = desk();
    const grant = await approvedClaims(marketing);
    const draft = await marketing.approveClaim(grant, { requestId: "g1" });
    expect(draft).toMatchObject({ status: "draft", heldClaims: [], grantedClaims: [FLOOR_CLAIM] });
    // A replay changes nothing.
    expect(await marketing.approveClaim(grant, { requestId: "g1" })).toEqual(draft);
    // A second request for the same draft has nothing left to grant.
    expect((await refusal(marketing.approveClaim(grant, { requestId: "g2" }))).code).toBe(
      "claim_not_held",
    );
  });

  it("does not let a grant cover the same claim in another draft", async () => {
    const marketing = desk();
    await marketing.approveClaim(await approvedClaims(marketing), { requestId: "g1" });
    const again = await refusal(
      marketing.draftPost({ channel: "linkedin", text: FLOOR_POST }, { requestId: "second" }),
    );
    expect(again.code).toBe("unapproved_claim");
    expect(again.draftId).toBe("D-106");
  });

  it("refuses facts that are not the held draft as it stands, as changed, granting nothing", async () => {
    for (const changed of [
      { finalText: `${FLOOR_POST} Book now.` },
      { heldClaims: [{ claim: "Our floor care leaves floors 3x cleaner.", phrase: "3x cleaner" }] },
      { channel: "linkedin" },
    ]) {
      const marketing = desk();
      const grant = await approvedClaims(marketing);
      const error = await refusal(
        marketing.approveClaim(
          { ...grant, approved: { ...grant.approved, ...changed } },
          { requestId: "y" },
        ),
      );
      expect(error.code, JSON.stringify(changed)).toBe("draft_changed");
      expect(error.finalText).toBe(FLOOR_POST);
      expect(error.message).toContain("Nothing was approved.");
      const [still] = await marketing.listDrafts({ id: "D-104" });
      expect(still?.status).toBe("held");
    }
  });

  it("refuses a draft with nothing held, and an unknown draft", async () => {
    const marketing = desk();
    const grant = await approvedClaims(marketing);
    expect(
      (await refusal(marketing.approveClaim({ ...grant, draftId: "D-102" }, { requestId: "z" })))
        .code,
    ).toBe("claim_not_held");
    expect(
      (await refusal(marketing.approveClaim({ ...grant, draftId: "D-999" }, { requestId: "w" })))
        .code,
    ).toBe("not_found");
  });

  it("grants every held claim a person was shown at once", async () => {
    const marketing = desk();
    const text = "Our floors are 2x cleaner. We use only non-toxic products.";
    await refusal(marketing.draftPost({ channel: "website", text }, { requestId: "two" }));
    const grant = await approvedClaims(marketing, "D-106");
    expect((grant.approved.heldClaims as unknown[]).length).toBe(2);
    const draft = await marketing.approveClaim(grant, { requestId: "a" });
    expect(draft).toMatchObject({
      status: "draft",
      grantedClaims: ["Our floors are 2x cleaner.", "We use only non-toxic products."],
    });
  });
});

describe("fakeMarketingDesk: publishing", () => {
  async function d102(marketing: MarketingDesk) {
    const [draft] = await marketing.listDrafts({ id: "D-102" });
    if (draft === undefined) throw new Error("no D-102");
    return draft;
  }

  it("approves a ready draft's channel and full text, footer included", async () => {
    const marketing = desk();
    const [email] = await marketing.listDrafts({ id: "D-103" });
    if (email === undefined) throw new Error("no D-103");
    const facts = readyDraftFacts(email);
    expect(facts).toEqual({
      id: "D-103",
      kind: "email",
      channel: "email",
      audienceId: "current-clients",
      finalText: email.finalText,
      grantedClaims: [],
    });
    expect(String(facts.finalText)).toContain(postalAddress(company));
    expect(String(facts.finalText).toLowerCase()).toContain("reply unsubscribe");
  });

  it("publishes a ready draft exactly as the desk holds it, once", async () => {
    const marketing = desk();
    const draft = await d102(marketing);
    const grant = await approvedPublication(marketing);
    const published = await marketing.publish(grant, { requestId: "p1" });
    expect(published).toMatchObject({
      id: "PUB-2",
      draftId: "D-102",
      channel: "linkedin",
      text: draft.finalText,
      backend: "demo",
    });
    expect(await marketing.publish(grant, { requestId: "p1" })).toEqual(published);
    expect((await d102(marketing)).status).toBe("published");
    const twice = await refusal(marketing.publish(grant, { requestId: "p2" }));
    expect(twice.code).toBe("already_published");
  });

  it("refuses facts that are not the draft as it stands, as changed, publishing nothing", async () => {
    for (const changed of [
      { finalText: "Day porters, call now." },
      { channel: "facebook" },
      { grantedClaims: ["Our floor care leaves floors 2x cleaner."] },
    ]) {
      const marketing = desk();
      const grant = await approvedPublication(marketing);
      const error = await refusal(
        marketing.publish(
          { ...grant, approved: { ...grant.approved, ...changed } },
          { requestId: "c" },
        ),
      );
      expect(error.code, JSON.stringify(changed)).toBe("draft_changed");
      expect(error.finalText).toBe((await d102(marketing)).finalText);
      expect(error.message).toContain("Nothing was published.");
      expect((await d102(marketing)).status).toBe("draft");
    }
  });

  it("refuses a held draft until its claims are approved, and an unknown draft", async () => {
    const marketing = desk();
    const grant = await approvedPublication(marketing, "D-104");
    const notReady = await refusal(marketing.publish(grant, { requestId: "p" }));
    expect(notReady.code).toBe("not_ready");
    expect(notReady.message).toContain(FLOOR_CLAIM);
    const missing = await refusal(
      marketing.publish({ ...grant, draftId: "D-999" }, { requestId: "q" }),
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
