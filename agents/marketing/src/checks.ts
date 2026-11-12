/**
 * The checks every draft passes, whatever desk holds it.
 *
 * A desk is the host's system of record: it stores drafts and publishes them. What Marketing
 * promises is not left to it. `checkedDesk` wraps the desk the host supplies, and the tools reach
 * the desk only through it:
 *
 * - a draft is checked for result claims against the company's approved list (`claims.ts`); the desk
 *   is handed the claims to hold, and the draft is refused, whatever the desk made of them;
 * - a quoted, attributed passage that is not a testimonial on record (`testimonials.ts`) is refused
 *   before anything is saved, and again before a claim is approved or a draft published;
 * - a campaign email is handed to the desk with the unsubscribe line and the postal address already
 *   on it, so the model cannot leave them out;
 * - a draft is published only when it still passes: every result claim in it is approved or was
 *   granted for it, and an email still ends with its footer. A desk that calls an unchecked draft
 *   ready does not get it published.
 *
 * A refusal is a `MarketingDeskError` with a code, the same as the desk's own, and the tools turn the
 * code into the next step a person can take.
 */

import { findResultClaims, type ResultClaim } from "./claims.js";
import { type CompanyFacts, offerTerms } from "./company.js";
import {
  type Audience,
  campaignFooter,
  type Draft,
  type DraftFilter,
  emailText,
  type MarketingDesk,
  MarketingDeskError,
  type PostChannel,
  type Publication,
  quoteClaims,
  unknownAudience,
} from "./desk.js";
import { findUnrecordedTestimonials, ownNames } from "./testimonials.js";

/** A desk as the tools use it: the model's words in, and every check run on the way to the desk. */
export interface CheckedMarketingDesk {
  listDrafts(filter?: DraftFilter): Promise<readonly Draft[]>;
  listAudiences(): Promise<readonly Audience[]>;
  /** Saves a post. Throws `unrecorded_testimonial` (nothing saved) or `unapproved_claim` (held). */
  draftPost(
    input: { readonly channel: PostChannel; readonly text: string },
    options: { readonly requestId: string },
  ): Promise<Draft>;
  /** Saves an email with its footer. Throws as `draftPost` does, and `not_found` for the audience. */
  draftCampaignEmail(
    input: { readonly subject: string; readonly body: string; readonly audienceId: string },
    options: { readonly requestId: string },
  ): Promise<Draft>;
  approveClaim: MarketingDesk["approveClaim"];
  publish: MarketingDesk["publish"];
}

/** What the model wrote, which is what is checked: a post's text, or an email's subject and body. */
function written(draft: { readonly subject: string | null; readonly text: string }): string {
  return draft.subject === null ? draft.text : `${draft.subject}\n${draft.text}`;
}

/** Wraps a desk so that every draft is checked on its way in and again on its way out. */
export function checkedDesk(desk: MarketingDesk, company: CompanyFacts): CheckedMarketingDesk {
  const terms = offerTerms(company);
  const own = ownNames(company);

  /**
   * Refuses quoted, attributed passages that are not a testimonial on the company's record. The
   * footer is never checked, and saving, approving and publishing check the same text, so a draft
   * that saved cleanly is not refused later for words the role added. `outcome` says what did not
   * happen at this step: "Nothing was approved."
   */
  const refuseInventedQuotes = (text: string, outcome: string): void => {
    const passages = findUnrecordedTestimonials(text, company.marketing.testimonials ?? [], own);
    if (passages.length === 0) return;
    throw new MarketingDeskError(
      "unrecorded_testimonial",
      `Refused: ${passages.map((passage) => `"${passage}"`).join("; ")} ${passages.length === 1 ? "is a quote" : "are quotes"} attributed to someone, and ${passages.length === 1 ? "it is" : "they are"} not a testimonial on the company's record. ${outcome} A customer is quoted only word for word from the record, and no one can approve a quote that is not on it.`,
    );
  };

  /** Result claims not on the approved list, nor among those a person granted for this draft. */
  // An offer may name one of the company's own services or price book lines after "off".
  const unapprovedClaims = (text: string, granted: readonly string[] = []): ResultClaim[] =>
    findResultClaims(text, [...company.marketing.approvedClaims, ...granted], terms);

  /** The refusal for a draft the desk now holds with claims waiting for a person. */
  const refuseHeld = (draft: Draft, claims: readonly ResultClaim[]): void => {
    if (claims.length === 0) return;
    throw new MarketingDeskError(
      "unapproved_claim",
      `Refused: ${quoteClaims(claims)} ${claims.length === 1 ? "states a result that is" : "state results that are"} not on the company's approved list. The draft is held as ${draft.id}, not ready to publish, and nothing was published.`,
      { draftId: draft.id, claims, finalText: draft.finalText },
    );
  };

  const one = async (draftId: string): Promise<Draft | undefined> =>
    (await desk.listDrafts({ id: draftId }))[0];

  return {
    listDrafts: (filter) => desk.listDrafts(filter),
    listAudiences: () => desk.listAudiences(),

    async draftPost(input, options): Promise<Draft> {
      const text = input.text.trim();
      refuseInventedQuotes(text, "Nothing was saved and nothing was published.");
      const heldClaims = unapprovedClaims(text);
      const draft = await desk.draftPost({ channel: input.channel, text, heldClaims }, options);
      refuseHeld(draft, heldClaims);
      return draft;
    },

    async draftCampaignEmail(input, options): Promise<Draft> {
      const subject = input.subject.trim();
      const body = input.body.trim();
      const audiences = await desk.listAudiences();
      const audience = audiences.find((entry) => entry.id === input.audienceId.trim());
      if (audience === undefined) throw unknownAudience(input.audienceId, audiences);
      const checked = written({ subject, text: body });
      refuseInventedQuotes(checked, "Nothing was saved and nothing was published.");
      const heldClaims = unapprovedClaims(checked);
      const draft = await desk.draftCampaignEmail(
        {
          subject,
          body,
          audienceId: audience.id,
          // The footer is the role's: whatever the body says, the email carries it.
          finalText: emailText(subject, body, campaignFooter(company, audience)),
          heldClaims,
        },
        options,
      );
      refuseHeld(draft, heldClaims);
      return draft;
    },

    async approveClaim(input, options): Promise<Draft> {
      const draft = await one(input.draftId);
      // A quote that is not on record is not a claim: no approval makes it publishable. A draft the
      // desk does not hold, or one with nothing held, is the desk's to refuse (or to replay).
      if (draft !== undefined && draft.heldClaims.length > 0) {
        refuseInventedQuotes(written(draft), "Nothing was approved.");
      }
      return desk.approveClaim(input, options);
    },

    async publish(input, options): Promise<Publication> {
      const draft = await one(input.draftId);
      // Only a draft the desk calls ready is checked here: an unknown, held or published one is the
      // desk's to refuse, and a replayed publication the desk's to answer again.
      if (draft !== undefined && draft.status === "draft") {
        refuseInventedQuotes(written(draft), "Nothing was published.");
        const claims = unapprovedClaims(written(draft), draft.grantedClaims);
        if (claims.length > 0) {
          throw new MarketingDeskError(
            "invalid",
            `${draft.id} states ${quoteClaims(claims)}, which ${claims.length === 1 ? "is" : "are"} not on the company's approved list and which no person approved for this draft. Nothing was published. Draft it again with draft_post or draft_campaign_email, which checks the claim and holds the draft for a person's approval.`,
            { draftId: draft.id, claims },
          );
        }
        if (draft.kind === "email") {
          const audiences = await desk.listAudiences();
          const audience = audiences.find((entry) => entry.id === draft.audienceId);
          if (
            audience === undefined ||
            !draft.finalText.endsWith(`\n\n${campaignFooter(company, audience)}`)
          ) {
            throw new MarketingDeskError(
              "invalid",
              `${draft.id} is a campaign email that does not end with the unsubscribe line and postal address for ${audience === undefined ? "an audience list on file" : `the ${audience.name} list`}. Nothing was published. Draft it again with draft_campaign_email, which adds them.`,
              { draftId: draft.id },
            );
          }
        }
      }
      return desk.publish(input, options);
    },
  };
}
