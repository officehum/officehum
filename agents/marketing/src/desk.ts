/**
 * The desk: the marketing system this role saves drafts to and publishes from.
 *
 * A host binds its own — a social scheduler, an email platform, a CMS — and the role never knows the
 * difference. `fakeMarketingDesk` is what ships with the package: the demonstration backend, holding
 * drafts and publications in memory and sending nothing anywhere, so a test, an eval or a first run
 * needs no network and no credential.
 *
 * A desk is a record: it stores what it is handed and publishes what it holds. The checks on what a
 * draft says are not a desk's. The tools reach every desk through `checkedDesk` (`checks.ts`), which
 * finds the result claims a draft must be held for, refuses an invented testimonial, and puts the
 * unsubscribe line and the postal address on every campaign email, so a host desk gets the same
 * rules as this one. What a desk does own: it holds a draft with the claims it was handed until a
 * person approves them, records the claims a person approved against that one draft only, and grants
 * or publishes a draft only when it still equals what the person approved, as the approval gate read
 * it from this desk. A refusal carries a code, and the tools turn the code into the next step a
 * person can take.
 */

import { localDate, sameFacts } from "@officehum/sdk";
import { findResultClaims, type ResultClaim } from "./claims.js";
import {
  type CompanyFacts,
  loadCompanyFacts,
  money,
  offerTerms,
  postalAddress,
} from "./company.js";

/** Where a post goes. A campaign email's channel is `email`. */
export type PostChannel = "linkedin" | "facebook" | "instagram" | "website";
export const POST_CHANNELS: readonly PostChannel[] = [
  "linkedin",
  "facebook",
  "instagram",
  "website",
];
export type Channel = PostChannel | "email";

/**
 * `held`: saved, but it states a claim not on the approved list; it publishes only once a person has
 * approved each held claim. `draft`: saved and ready; publishing it still asks a person.
 * `published`: out, on the demonstration backend or the host's.
 */
export type DraftStatus = "held" | "draft" | "published";

/** A list a campaign email goes to: people who agreed to hear from the company. */
export interface Audience {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface Draft {
  readonly id: string;
  readonly kind: "post" | "email";
  readonly channel: Channel;
  readonly audienceId: string | null;
  readonly subject: string | null;
  /** The post's text or the email's body, as written. */
  readonly text: string;
  /**
   * Exactly what would be published: the post's text, or the email's subject, body and the footer the
   * desk adds. A publish approval names this text, and the desk publishes nothing else.
   */
  readonly finalText: string;
  readonly status: DraftStatus;
  /** Claims waiting for a person's approval. */
  readonly heldClaims: readonly ResultClaim[];
  /** Claims a person approved for this draft, and only this draft. */
  readonly grantedClaims: readonly string[];
  /** `YYYY-MM-DD`. */
  readonly createdOn: string;
  readonly publishedOn: string | null;
  readonly publicationId: string | null;
}

/** A draft as it went out. */
export interface Publication {
  readonly id: string;
  readonly draftId: string;
  readonly channel: Channel;
  readonly text: string;
  readonly publishedAt: string;
  /** `demo`: recorded by the demonstration desk and posted nowhere. A host desk says its own. */
  readonly backend: string;
}

export interface DraftFilter {
  /** A draft id such as D-102. */
  readonly id?: string;
  readonly status?: DraftStatus;
}

/**
 * The facts a person approves when granting a held draft's claims: the draft's channel and full text,
 * and each held claim with its phrase, as the desk recorded them when it refused the draft.
 */
export function heldDraftFacts(draft: Draft): Record<string, unknown> {
  return {
    id: draft.id,
    kind: draft.kind,
    channel: draft.channel,
    audienceId: draft.audienceId,
    finalText: draft.finalText,
    heldClaims: draft.heldClaims.map((entry) => ({ claim: entry.claim, phrase: entry.phrase })),
  };
}

/**
 * The facts a person approves when publishing a draft: its channel and audience, the full text
 * exactly as it would go out (an email's unsubscribe line and postal address included), and the
 * claims a person already approved for it.
 */
export function readyDraftFacts(draft: Draft): Record<string, unknown> {
  return {
    id: draft.id,
    kind: draft.kind,
    channel: draft.channel,
    audienceId: draft.audienceId,
    finalText: draft.finalText,
    grantedClaims: [...draft.grantedClaims],
  };
}

/**
 * What the role needs from whatever system holds its drafts and publishes them. The role checks a
 * draft before the desk sees it (`checks.ts`); the desk stores what it is handed.
 */
export interface MarketingDesk {
  listDrafts(filter?: DraftFilter): Promise<readonly Draft[]>;
  listAudiences(): Promise<readonly Audience[]>;
  /**
   * Saves a post. `heldClaims` are the result claims the role found that nobody has approved: with
   * any, the desk saves the draft as `held` with them; with none, as a ready `draft`.
   */
  draftPost(
    input: {
      readonly channel: PostChannel;
      readonly text: string;
      readonly heldClaims: readonly ResultClaim[];
    },
    options: { readonly requestId: string },
  ): Promise<Draft>;
  /**
   * Saves an email draft for an audience the desk listed. `finalText` is the email exactly as it
   * would go out: the subject, the body, and the unsubscribe line and postal address the role added.
   * The desk stores it as the draft's `finalText` and publishes nothing else. `heldClaims` as for
   * `draftPost`.
   */
  draftCampaignEmail(
    input: {
      readonly subject: string;
      readonly body: string;
      readonly audienceId: string;
      readonly finalText: string;
      readonly heldClaims: readonly ResultClaim[];
    },
    options: { readonly requestId: string },
  ): Promise<Draft>;
  /**
   * Records a held draft's claims as approved for that draft only. Called only once a person approved
   * them, with the facts the approval gate read from this desk and showed them (`heldDraftFacts`). A
   * host desk must refuse with `draft_changed` when the draft no longer equals `approved`.
   */
  approveClaim(
    input: { readonly draftId: string; readonly approved: Readonly<Record<string, unknown>> },
    options: { readonly requestId: string },
  ): Promise<Draft>;
  /**
   * Publishes one ready draft, exactly as held. Called only once a person approved it, with the facts
   * they were shown (`readyDraftFacts`). A host desk must refuse with `draft_changed` when the draft
   * no longer equals `approved`, so a grant never publishes anything the person was not shown.
   */
  publish(
    input: { readonly draftId: string; readonly approved: Readonly<Record<string, unknown>> },
    options: { readonly requestId: string },
  ): Promise<Publication>;
}

/** Why the desk refused, so a tool can say what to do next without parsing the message. */
export type DeskRefusal =
  | "not_found"
  | "invalid"
  | "unapproved_claim"
  | "unrecorded_testimonial"
  | "claim_not_held"
  | "draft_changed"
  | "not_ready"
  | "already_published";

/**
 * A refusal the model reads: an unapproved claim, a changed draft, an unknown audience. A desk throws
 * it for what it owns, and the role's checks (`checks.ts`) for what they own.
 */
export class MarketingDeskError extends Error {
  readonly code: DeskRefusal;
  /** For `unapproved_claim`: the held draft the text was saved as. */
  readonly draftId: string | undefined;
  /** For `unapproved_claim` and `not_ready`: the claims waiting for a person. */
  readonly claims: readonly ResultClaim[] | undefined;
  /** For `unapproved_claim` and `draft_changed`: the draft's text exactly as the desk holds it. */
  readonly finalText: string | undefined;

  constructor(
    code: DeskRefusal,
    message: string,
    extra: {
      readonly draftId?: string;
      readonly claims?: readonly ResultClaim[];
      readonly finalText?: string;
    } = {},
  ) {
    super(message);
    this.name = "MarketingDeskError";
    this.code = code;
    this.draftId = extra.draftId;
    this.claims = extra.claims;
    this.finalText = extra.finalText;
  }
}

/** Monday 9 November 2026, in the morning on the US west coast. */
export const DEMO_NOW = "2026-11-09T17:00:00.000Z";

/** The demonstration lists: people who agreed to hear from the company. */
export function demoAudiences(): readonly Audience[] {
  return [
    {
      id: "current-clients",
      name: "current clients",
      description: "Contracted clients who asked for news and offers",
    },
    {
      id: "prospects",
      name: "prospects",
      description: "People who asked for a quote and agreed to hear from us",
    },
  ];
}

/**
 * The lines every campaign email ends with: how to unsubscribe, and the company's postal address.
 * They come from the company record, the role adds them before the desk saves the email
 * (`checks.ts`), and the model never writes them.
 */
export function campaignFooter(company: Pick<CompanyFacts, "profile">, audience: Audience): string {
  return [
    "—",
    `You are receiving this because you are on the ${company.profile.tradingName} ${audience.name} list. To unsubscribe, reply UNSUBSCRIBE and you will be taken off the list.`,
    postalAddress(company as CompanyFacts),
  ].join("\n");
}

/** A campaign email exactly as it goes out: the subject, the body, then the footer. */
export function emailText(subject: string, body: string, footer: string): string {
  return `Subject: ${subject}\n\n${body}\n\n${footer}`;
}

/** The refusal for an audience list that is not on the desk, naming the ones that are. */
export function unknownAudience(
  audienceId: string,
  audiences: readonly Audience[],
): MarketingDeskError {
  return new MarketingDeskError(
    "not_found",
    `No audience is ${JSON.stringify(audienceId)}. The audiences are: ${audiences.map((entry) => `${entry.id} (${entry.description})`).join(", ")}.`,
  );
}

/**
 * The demonstration drafts on Monday 9 November 2026, built from the company's own record: a
 * published post that states an approved claim, a ready post about the day porter at the price book's
 * rate, a ready campaign email about floor care at the price book's rates, and two posts held this
 * morning for their claims: D-104 on Facebook for "2x cleaner" and D-105 on LinkedIn for "30%". Their
 * held claims are what the claim check finds in them for this company, not a list.
 *
 * The held posts are seeded because eval scenarios name them: as for every role's demonstration data,
 * the desk holds the records the scenarios' stubbed tools refer to, so the approval gate reads the
 * same draft from the desk that the scenario's stubbed refusal tells the model about.
 */
export function demoDrafts(company: CompanyFacts): readonly Draft[] {
  const line = (id: string) => {
    const found = company.priceBook.find((entry) => entry.id === id);
    if (found === undefined)
      throw new Error(`The demonstration drafts price ${id}, not in the price book.`);
    return found;
  };
  const porter = line("porter-hour");
  const carpet = line("floor-carpet-sqft");
  const wax = line("floor-strip-wax-sqft");
  const claim = company.marketing.approvedClaims[0] ?? "";
  const audience = demoAudiences()[0] as Audience;
  const published = `${claim} This month our crews start winter floor care: carpet extraction, and strip and re-wax for entrances that take the wet weather.`;
  const porterPost = `Need someone on site during business hours? A day porter looks after a lobby, a lunch room or a restroom round, at ${money(porter.unitPriceCents)} an ${porter.unit}. Ask us for a walkthrough.`;
  const subject = "Winter floor care, booked before the rain";
  const body = `Wet weather is hard on entrance floors. Carpet extraction is ${money(carpet.unitPriceCents)} per ${carpet.unit}, and strip and re-wax is ${money(wax.unitPriceCents)} per ${wax.unit}. Reply to this email and we will book a time that suits your building.`;
  const base = { heldClaims: [], grantedClaims: [], audienceId: null, subject: null } as const;
  /** A post held this morning for its claims, or a ready draft if the company approved them. */
  const checked = (id: string, channel: PostChannel, text: string): Draft => {
    const heldClaims = findResultClaims(
      text,
      company.marketing.approvedClaims,
      offerTerms(company),
    );
    return {
      ...base,
      id,
      kind: "post",
      channel,
      text,
      finalText: text,
      status: heldClaims.length === 0 ? "draft" : "held",
      heldClaims,
      createdOn: "2026-11-09",
      publishedOn: null,
      publicationId: null,
    };
  };
  return [
    {
      ...base,
      id: "D-101",
      kind: "post",
      channel: "linkedin",
      text: published,
      finalText: published,
      status: "published",
      createdOn: "2026-10-30",
      publishedOn: "2026-11-02",
      publicationId: "PUB-1",
    },
    {
      ...base,
      id: "D-102",
      kind: "post",
      channel: "linkedin",
      text: porterPost,
      finalText: porterPost,
      status: "draft",
      createdOn: "2026-11-06",
      publishedOn: null,
      publicationId: null,
    },
    {
      ...base,
      id: "D-103",
      kind: "email",
      channel: "email",
      audienceId: audience.id,
      subject,
      text: body,
      finalText: emailText(subject, body, campaignFooter(company, audience)),
      status: "draft",
      createdOn: "2026-11-06",
      publishedOn: null,
      publicationId: null,
    },
    checked(
      "D-104",
      "facebook",
      "Our floor care leaves floors 2x cleaner. Ask us for a walkthrough.",
    ),
    checked(
      "D-105",
      "linkedin",
      "Our nightly cleaning cuts sick days 30%. Ask us for a walkthrough.",
    ),
  ];
}

/** Held claims as a person reads them: each claim with the phrase that states it. */
export function quoteClaims(claims: readonly ResultClaim[]): string {
  return claims.map((entry) => `"${entry.claim}" (the phrase "${entry.phrase}")`).join("; ");
}

type DraftState = { -readonly [K in keyof Draft]: Draft[K] };

export interface FakeMarketingDeskOptions {
  /** The company whose prices, address and time zone the desk uses; its own when omitted. */
  readonly company?: CompanyFacts;
  /** Existing drafts; the demonstration ones when omitted. */
  readonly drafts?: readonly Draft[];
  /** The lists an email can go to; the demonstration ones when omitted. */
  readonly audiences?: readonly Audience[];
  /** The clock. Omitted: Monday 9 November 2026. */
  readonly now?: () => Date;
}

/** An in-memory desk: the demonstration backend, which publishes nothing anywhere. */
export function fakeMarketingDesk(options: FakeMarketingDeskOptions = {}): MarketingDesk {
  const company = options.company ?? loadCompanyFacts();
  const clock = options.now ?? (() => new Date(DEMO_NOW));
  const audiences = options.audiences ?? demoAudiences();
  const drafts: DraftState[] = (options.drafts ?? demoDrafts(company)).map((draft) => ({
    ...draft,
    heldClaims: [...draft.heldClaims],
    grantedClaims: [...draft.grantedClaims],
  }));
  // Every write is remembered by its request id, so a replayed call is answered with what it already
  // did and never writes twice.
  const created = new Map<string, Draft>();
  const grants = new Map<string, Draft>();
  const published = new Map<string, Publication>();

  const snapshot = (draft: DraftState): Draft => ({
    ...draft,
    heldClaims: draft.heldClaims.map((entry) => ({ ...entry })),
    grantedClaims: [...draft.grantedClaims],
  });

  const nextDraftId = (): string =>
    `D-${Math.max(100, ...drafts.map((draft) => Number(draft.id.replace(/\D/g, "")))) + 1}`;

  const nextPublicationId = (): string => {
    const ids = drafts
      .map((draft) => draft.publicationId)
      .filter((id): id is string => id !== null)
      .map((id) => Number(id.replace(/\D/g, "")));
    return `PUB-${Math.max(0, ...ids) + 1}`;
  };

  const findDraft = (id: string): DraftState => {
    const draft = drafts.find(
      (candidate) => candidate.id.toLowerCase() === id.trim().toLowerCase(),
    );
    if (draft === undefined) {
      throw new MarketingDeskError(
        "not_found",
        `No draft has the id ${JSON.stringify(id)}. Find it with list_drafts.`,
      );
    }
    return draft;
  };

  /** Saves a new draft: held with the claims the role found unapproved, ready with none. */
  const save = (
    requestId: string,
    draft: Omit<
      DraftState,
      "id" | "status" | "grantedClaims" | "createdOn" | "publishedOn" | "publicationId"
    >,
  ): Draft => {
    const state: DraftState = {
      ...draft,
      id: nextDraftId(),
      status: draft.heldClaims.length === 0 ? "draft" : "held",
      grantedClaims: [],
      // The company's own day: its late afternoon is not yet tomorrow.
      createdOn: localDate(clock(), company.hours.timezone),
      publishedOn: null,
      publicationId: null,
    };
    drafts.push(state);
    const saved = snapshot(state);
    created.set(requestId, saved);
    return saved;
  };

  return {
    async listDrafts(filter: DraftFilter = {}): Promise<readonly Draft[]> {
      return drafts
        .filter(
          (draft) =>
            filter.id === undefined || draft.id.toLowerCase() === filter.id.trim().toLowerCase(),
        )
        .filter((draft) => filter.status === undefined || draft.status === filter.status)
        .map(snapshot);
    },

    async listAudiences(): Promise<readonly Audience[]> {
      return audiences.map((audience) => ({ ...audience }));
    },

    async draftPost(input, { requestId }): Promise<Draft> {
      const prior = created.get(requestId);
      if (prior !== undefined) return prior;
      if (!POST_CHANNELS.includes(input.channel)) {
        throw new MarketingDeskError(
          "invalid",
          `${JSON.stringify(input.channel)} is not a post channel. The channels are: ${POST_CHANNELS.join(", ")}.`,
        );
      }
      const text = input.text.trim();
      if (text === "") throw new MarketingDeskError("invalid", "A post needs text.");
      return save(requestId, {
        kind: "post",
        channel: input.channel,
        audienceId: null,
        subject: null,
        text,
        finalText: text,
        heldClaims: input.heldClaims.map((entry) => ({ ...entry })),
      });
    },

    async draftCampaignEmail(input, { requestId }): Promise<Draft> {
      const prior = created.get(requestId);
      if (prior !== undefined) return prior;
      const subject = input.subject.trim();
      const body = input.body.trim();
      if (subject === "" || body === "") {
        throw new MarketingDeskError("invalid", "A campaign email needs a subject and a body.");
      }
      const audience = audiences.find((entry) => entry.id === input.audienceId.trim());
      if (audience === undefined) throw unknownAudience(input.audienceId, audiences);
      return save(requestId, {
        kind: "email",
        channel: "email",
        audienceId: audience.id,
        subject,
        text: body,
        finalText: input.finalText,
        heldClaims: input.heldClaims.map((entry) => ({ ...entry })),
      });
    },

    async approveClaim(input, { requestId }): Promise<Draft> {
      const prior = grants.get(requestId);
      if (prior !== undefined) return prior;
      const draft = findDraft(input.draftId);
      if (draft.heldClaims.length === 0) {
        throw new MarketingDeskError(
          "claim_not_held",
          `${draft.id} has no claim waiting for approval: it is ${draft.status}. Nothing was approved.`,
        );
      }
      // The person approved these claims in this text; anything else is not what they were shown.
      if (!sameFacts(input.approved, heldDraftFacts(snapshot(draft)))) {
        throw new MarketingDeskError(
          "draft_changed",
          `${draft.id} is not what the person approved: it changed after its facts were read. Nothing was approved. ${draft.id} is for ${draft.channel}, holds ${quoteClaims(draft.heldClaims)}, and reads:\n${draft.finalText}`,
          { draftId: draft.id, finalText: draft.finalText },
        );
      }
      draft.grantedClaims = [
        ...draft.grantedClaims,
        ...draft.heldClaims.map((entry) => entry.claim),
      ];
      draft.heldClaims = [];
      draft.status = "draft";
      const result = snapshot(draft);
      grants.set(requestId, result);
      return result;
    },

    async publish(input, { requestId }): Promise<Publication> {
      const prior = published.get(requestId);
      if (prior !== undefined) return prior;
      const draft = findDraft(input.draftId);
      if (draft.status === "published") {
        throw new MarketingDeskError(
          "already_published",
          `${draft.id} was already published on ${draft.publishedOn ?? "an earlier day"} (${draft.publicationId ?? "no record"}). Nothing was published again.`,
        );
      }
      if (draft.status === "held") {
        throw new MarketingDeskError(
          "not_ready",
          `${draft.id} is held: ${quoteClaims(draft.heldClaims)} still needs a person's approval. Nothing was published.`,
          { draftId: draft.id, claims: draft.heldClaims },
        );
      }
      // The person approved the draft as the gate read it. Publish only if it still is that draft.
      if (!sameFacts(input.approved, readyDraftFacts(snapshot(draft)))) {
        throw new MarketingDeskError(
          "draft_changed",
          `${draft.id} is not what the person approved: it changed after its facts were read, so the approval does not cover it. Nothing was published. ${draft.id} is for ${draft.channel} and reads:\n${draft.finalText}`,
          { draftId: draft.id, finalText: draft.finalText },
        );
      }
      const now = clock();
      draft.status = "published";
      draft.publishedOn = localDate(now, company.hours.timezone);
      draft.publicationId = nextPublicationId();
      const publication: Publication = {
        id: draft.publicationId,
        draftId: draft.id,
        channel: draft.channel,
        text: draft.finalText,
        publishedAt: now.toISOString(),
        backend: "demo",
      };
      published.set(requestId, publication);
      return publication;
    },
  };
}
