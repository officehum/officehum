/**
 * The Marketing role's seven tools.
 *
 * `read_services`, `list_drafts` and `read_company` only read. `draft_post` and
 * `draft_campaign_email` save drafts through the desk with no approval: nothing goes out, the desk
 * checks every claim and holds a draft that states one not on the approved list, and it adds the
 * unsubscribe line and postal address to every email. `request_claim_approval` and `publish` wait for
 * a person on every call; their approvals are `officehum.json`'s, evaluated by the SDK's gate before
 * the tool runs. Each one's arguments carry the full text the person is approving, as the desk gave
 * it, and the desk refuses a grant whose text is not the draft's, so a person never approves one
 * thing and gets another.
 *
 * Every price a tool speaks comes from the price book, every claim rule from the desk, and every name
 * from the company record.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import { type CompanyFacts, marketingApprover, money, person, personLabel } from "./company.js";
import {
  type Channel,
  type DeskRefusal,
  type Draft,
  type DraftStatus,
  type MarketingDesk,
  MarketingDeskError,
  POST_CHANNELS,
  type PostChannel,
  type Publication,
} from "./desk.js";

/** What the tools need: the desk, and the company being marketed. */
export interface MarketingToolDependencies {
  readonly desk: MarketingDesk | undefined;
  readonly company: CompanyFacts;
}

/** The seven tools, named, so the factory places each one where the manifest declares it. */
export interface MarketingToolset {
  readonly readServices: ToolRegistration;
  readonly draftPost: ToolRegistration;
  readonly draftCampaignEmail: ToolRegistration;
  readonly requestClaimApproval: ToolRegistration;
  readonly publish: ToolRegistration;
  readonly listDrafts: ToolRegistration;
  readonly readCompany: ToolRegistration;
}

/** The company section `read_company` can answer for. */
export type CompanySection =
  | "profile"
  | "hours"
  | "people"
  | "marketing"
  | "policies"
  | "tone"
  | "escalation"
  | "glossary";

const SECTIONS: readonly CompanySection[] = [
  "profile",
  "hours",
  "people",
  "marketing",
  "policies",
  "tone",
  "escalation",
  "glossary",
];

const STATUSES: readonly DraftStatus[] = ["held", "draft", "published"];
const CHANNELS: readonly Channel[] = [...POST_CHANNELS, "email"];

/** The desk, or a refusal: a host with no desk gets no read and no write. */
function requireDesk(dependencies: MarketingToolDependencies): MarketingDesk {
  if (dependencies.desk === undefined) {
    throw new Error("No marketing desk is configured for this role.");
  }
  return dependencies.desk;
}

function textResult(value: string) {
  return { output: [{ type: "text" as const, text: value }] };
}

function refusal<TDetails extends JsonObject>(value: string, details: TDetails) {
  return { ...textResult(value), isError: true, details };
}

/** A draft's full text between markers, so it can be copied exactly into an approval. */
function block(text: string): string {
  return `<text>\n${text}\n</text>`;
}

function where(draft: Draft): string {
  return draft.kind === "email"
    ? `email to ${draft.audienceId ?? "no audience"}, channel email`
    : `${draft.channel} post`;
}

function draftText(draft: Draft): string {
  const status =
    draft.status === "published"
      ? `published ${draft.publishedOn ?? ""} (${draft.publicationId ?? "no record"})`
      : draft.status === "held"
        ? `held: ${draft.heldClaims.map((entry) => `"${entry.claim}" (the phrase "${entry.phrase}")`).join("; ")} waiting for a person's approval`
        : "draft, ready to publish with a person's approval";
  const granted =
    draft.grantedClaims.length === 0
      ? ""
      : `\nClaims a person approved for this draft only: ${draft.grantedClaims.map((claim) => `"${claim}"`).join("; ")}`;
  return `${draft.id} — ${where(draft)} — ${status} — created ${draft.createdOn}${granted}\n${block(draft.finalText)}`;
}

function details(draft: Draft): JsonObject {
  return {
    ...draft,
    heldClaims: draft.heldClaims.map((entry) => ({ ...entry })),
    grantedClaims: [...draft.grantedClaims],
  };
}

/** The company record as one section reads: prose the model can answer with. */
function companySection(company: CompanyFacts, section: CompanySection): string {
  switch (section) {
    case "profile": {
      const { profile } = company;
      return [
        `${profile.legalName} — trading as ${profile.tradingName}. ${profile.tagline}`,
        `${profile.address.street}, ${profile.address.city}, ${profile.address.region} ${profile.address.postalCode}. Phone ${profile.phone}. Email ${profile.email}.`,
        `Service area: ${profile.serviceArea}`,
        `Clients: ${profile.clients}`,
      ].join("\n");
    }
    case "hours": {
      const { hours } = company;
      return [`Office: ${hours.office} (${hours.timezone}).`, `Closed: ${hours.closedOn}.`].join(
        "\n",
      );
    }
    case "people":
      return company.people
        .map(
          (worker) =>
            `${worker.name} — ${worker.title} — ${worker.email} — decides: ${worker.decides.join("; ")}`,
        )
        .join("\n");
    case "marketing": {
      const testimonials = company.marketing.testimonials ?? [];
      return [
        "Approved claims, the only results and facts marketing states without a person's approval, word for word:",
        ...company.marketing.approvedClaims.map((claim) => `- ${claim}`),
        testimonials.length === 0
          ? "Testimonials on file: none. There is no customer quote to use, and none is written or invented."
          : "Testimonials on file, quoted only word for word:",
        ...testimonials.map((entry) => `- "${entry.quote}" — ${entry.by}`),
        `Who approves every publication and any claim not on the list: ${personLabel(marketingApprover(company))}.`,
      ].join("\n");
    }
    case "policies":
      return [
        "Safety:",
        ...company.policies.safety.map((rule) => `- ${rule}`),
        "Never promised:",
        ...company.policies.commitments.map((rule) => `- ${rule}`),
      ].join("\n");
    case "tone":
      return [
        company.tone.summary,
        "Always:",
        ...company.tone.always.map((rule) => `- ${rule}`),
        "Never:",
        ...company.tone.never.map((rule) => `- ${rule}`),
      ].join("\n");
    case "escalation":
      return company.escalation
        .map((rule) => {
          const owner = person(company, rule.toPersonId);
          return `${rule.topic} — ${owner?.name ?? rule.toPersonId}${owner === undefined ? "" : `, ${owner.title}`} — ${rule.when}`;
        })
        .join("\n");
    case "glossary":
      return company.glossary.map((entry) => `${entry.term}: ${entry.meaning}`).join("\n");
  }
}

function servicesText(company: CompanyFacts): string {
  return [
    `Services (${company.services.length}), with their price book lines:`,
    ...company.services.flatMap((service) => [
      `${service.name} [${service.id}] — ${service.summary}`,
      ...service.priceBookIds.map((id) => {
        const line = company.priceBook.find((entry) => entry.id === id);
        if (line === undefined) return `  - ${id}: not in the price book`;
        const minimum = line.minimumCents === null ? "" : `, minimum ${money(line.minimumCents)}`;
        return `  - ${line.name}: ${money(line.unitPriceCents)} per ${line.unit}${minimum}`;
      }),
    ]),
  ].join("\n");
}

/**
 * Builds the seven tools over one desk and one company. Every one is plain Pi Durable: they install
 * into any harness, and a harness with no desk builds the same tools and refuses at the point of use.
 */
export function marketingTools(dependencies: MarketingToolDependencies): MarketingToolset {
  const { company } = dependencies;
  const approver = personLabel(marketingApprover(company));

  /** The durable call identity, so a retried call is answered with what it already did. */
  const requestId = (
    kind: string,
    api: { conversationId: unknown; taskId: unknown; callId: string },
  ) => `${kind}:${String(api.conversationId)}:${String(api.taskId)}:${api.callId}`;

  /** A desk refusal as the model reads it, with the next step that a person can take. */
  const refused = (error: unknown, extra: JsonObject) => {
    if (!(error instanceof MarketingDeskError)) throw error;
    // The next step comes from the refusal's code, never from reading its message.
    const draftId = error.draftId === undefined ? "" : ` with draftId ${error.draftId}`;
    const text = error.finalText === undefined ? "" : `\n${block(error.finalText)}`;
    const next: Record<DeskRefusal, string> = {
      unapproved_claim: ` Next: tell the person who asked which claim was refused and why. Take the claim out and draft again, or, if they have said they want to keep it (ask them first if they have not), call request_claim_approval${draftId}, the claim exactly as quoted and draftText exactly as below, which asks ${approver}. Never publish it as it is.${text}`,
      not_ready: ` Next: each held claim needs request_claim_approval first, which asks ${approver}; or draft it again without the claim.`,
      draft_changed: ` Next: give the text exactly as the desk holds it, below.${text}`,
      // The desk's own message already says what to do for these.
      not_found: "",
      invalid: "",
      claim_not_held: "",
      already_published: "",
    };
    return refusal<JsonObject>(`${error.message}${next[error.code]}`, {
      code: error.code,
      ...(error.draftId === undefined ? {} : { draftId: error.draftId }),
      ...(error.claims === undefined
        ? {}
        : { claims: error.claims.map((entry) => ({ ...entry })) }),
      ...extra,
    });
  };

  const saved = (draft: Draft) => ({
    ...textResult(
      `Saved ${draft.id} as a draft (${where(draft)}). Nothing is published: publishing it asks ${approver}.\n${draftText(draft)}`,
    ),
    details: details(draft),
  });

  const readServices = defineTool({
    name: "read_services",
    description:
      "Read the company's service catalogue: each service, what it covers, and its price book lines with their prices and minimums. Every service and price in a draft comes from here.",
    parameters: Type.Object({}, { additionalProperties: false }),
    replay: "safe",
    execute: async () => ({
      ...textResult(servicesText(company)),
      details: { found: company.services.length > 0, services: company.services.length },
    }),
  });

  const draftPost = defineTool({
    name: "draft_post",
    description:
      "Save a social or website post as a draft for one channel. It publishes nothing. The desk checks every sentence: a result claim (a percentage or numeric result, a proof such as 'tests prove', or a broad green term such as 'eco-friendly') that is not on the company's approved list is refused, naming the phrase, and the draft is held. An offer on a price ('20% off your first clean') and price book prices are fine; '30% off your sick days' is a result.",
    parameters: Type.Object(
      {
        channel: Type.Union(
          POST_CHANNELS.map((channel) => Type.Literal(channel)),
          { description: "Where the post goes" },
        ),
        text: Type.String({ minLength: 1, description: "The post's full text" }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const draft = await desk.draftPost(
          { channel: args.channel as PostChannel, text: args.text },
          { requestId: requestId("post", api) },
        );
        return saved(draft);
      } catch (error) {
        return refused(error, { channel: args.channel });
      }
    },
  });

  const draftCampaignEmail = defineTool({
    name: "draft_campaign_email",
    description:
      "Save a campaign email to one audience list as a draft. It sends nothing. The desk adds the unsubscribe line and the company's postal address to every email; do not write them. It checks the subject and body for result claims as draft_post does. The audiences are listed by list_drafts.",
    parameters: Type.Object(
      {
        subject: Type.String({
          minLength: 1,
          description: "The subject line, true to the content",
        }),
        body: Type.String({ minLength: 1, description: "The email's body, without a footer" }),
        audienceId: Type.String({
          description: "The audience list's id from list_drafts, e.g. current-clients",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const draft = await desk.draftCampaignEmail(
          { subject: args.subject, body: args.body, audienceId: args.audienceId },
          { requestId: requestId("email", api) },
        );
        return saved(draft);
      } catch (error) {
        return refused(error, { audienceId: args.audienceId });
      }
    },
  });

  const requestClaimApproval = defineTool({
    name: "request_claim_approval",
    description:
      "Ask a person to approve one claim the desk refused, with the held draft it came from: the draft's id, the claim exactly as the refusal quoted it, and the draft's full text exactly as the desk gave it, so the person reads it in context. Every call waits for a person. A grant covers that exact claim in that draft only; it publishes nothing.",
    parameters: Type.Object(
      {
        draftId: Type.String({ description: "The held draft's id from the refusal, e.g. D-104" }),
        claim: Type.String({
          minLength: 1,
          description: "The claim's sentence exactly as the refusal quoted it",
        }),
        draftText: Type.String({
          minLength: 1,
          description:
            "The draft's full text exactly as the desk gave it, between <text> and </text>",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const draft = await desk.approveClaim(
          { draftId: args.draftId, claim: args.claim, draftText: args.draftText },
          { requestId: requestId("claim", api) },
        );
        const next =
          draft.status === "draft"
            ? `${draft.id} is now a draft ready to publish; publishing it still asks ${approver}.`
            : `${draft.id} is still held for its other claims.`;
        return {
          ...textResult(
            `Approved: "${args.claim}" may be used in ${draft.id}, and in no other draft. Nothing was published. ${next}\n${draftText(draft)}`,
          ),
          details: details(draft),
        };
      } catch (error) {
        return refused(error, { draftId: args.draftId });
      }
    },
  });

  const publish = defineTool({
    name: "publish",
    description:
      "Publish one saved draft on its channel. Give the draft's id, its channel and its full text exactly as list_drafts or the drafting tool gave it (between <text> and </text>), so the person approving sees exactly what goes out. Every call waits for a person. The desk publishes only if the channel and text are the draft's as it holds it; a held draft is refused.",
    parameters: Type.Object(
      {
        draftId: Type.String({ description: "The draft's id, e.g. D-102" }),
        channel: Type.Union(
          CHANNELS.map((channel) => Type.Literal(channel)),
          { description: "The draft's channel, as the desk gave it" },
        ),
        text: Type.String({
          minLength: 1,
          description:
            "The draft's full text exactly as the desk gave it, between <text> and </text>",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    execute: async (args, api) => {
      const desk = requireDesk(dependencies);
      try {
        const publication: Publication = await desk.publish(
          { draftId: args.draftId, channel: args.channel as Channel, text: args.text },
          { requestId: requestId("publish", api) },
        );
        const backend =
          publication.backend === "demo"
            ? " This is the demonstration backend: it is recorded here and posted nowhere else."
            : "";
        return {
          ...textResult(
            `Published ${publication.id}: ${publication.draftId} on ${publication.channel}, ${publication.publishedAt}.${backend}`,
          ),
          details: { ...publication },
        };
      } catch (error) {
        return refused(error, { draftId: args.draftId });
      }
    },
  });

  const listDrafts = defineTool({
    name: "list_drafts",
    description:
      "List drafts and published items, or one by id: channel or audience, status (held, draft, published), the full text exactly as it would be published, and any claim waiting for approval. Also lists the audiences a campaign email can go to.",
    parameters: Type.Object(
      {
        draftId: Type.Optional(Type.String({ description: "A draft id, e.g. D-102" })),
        status: Type.Optional(
          Type.Union(
            STATUSES.map((status) => Type.Literal(status)),
            { description: "Only drafts with this status" },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const desk = requireDesk(dependencies);
      const drafts = await desk.listDrafts({
        ...(args.draftId === undefined ? {} : { id: args.draftId }),
        ...(args.status === undefined ? {} : { status: args.status as DraftStatus }),
      });
      const audiences = await desk.listAudiences();
      const list = {
        found: drafts.length > 0,
        drafts: drafts.map(details),
        audiences: audiences.map((audience) => ({ ...audience })),
      };
      const audienceText = `Audiences for a campaign email: ${audiences.map((audience) => `${audience.id} (${audience.description})`).join(", ")}.`;
      if (drafts.length === 0) {
        return refusal(
          `No draft matches that. Try the id on the draft, or fewer filters.\n${audienceText}`,
          list,
        );
      }
      return {
        ...textResult(
          [`Drafts (${drafts.length}):`, ...drafts.map(draftText), audienceText].join("\n"),
        ),
        details: list,
      };
    },
  });

  const readCompany = defineTool({
    name: "read_company",
    description:
      "Read one section of the company record: the profile, the office hours, the people and what each decides, marketing (the approved claims, any testimonials on file, and who approves), the policies, the tone of voice and brand rules, the escalation path or the glossary.",
    parameters: Type.Object(
      {
        section: Type.Union(
          SECTIONS.map((section) => Type.Literal(section)),
          { description: "Which part of the record to read" },
        ),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args) => {
      const section = args.section as CompanySection;
      return { ...textResult(companySection(company, section)), details: { section } };
    },
  });

  return {
    readServices,
    draftPost,
    draftCampaignEmail,
    requestClaimApproval,
    publish,
    listDrafts,
    readCompany,
  };
}
