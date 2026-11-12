/**
 * One block per tool, against `fakeMarketingDesk` and the company facts generated into this package,
 * through the registrations the factory builds and with the durable call identity Pi Durable hands to
 * `execute`. Every unsafe tool is replayed under the same call id here, at the tool level, and must
 * write once. No network, no model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { APPROVED_FACTS_ARG, type ApprovalCallIdentity, type HookContext } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import {
  loadCompanyFacts,
  marketingApprover,
  money,
  personLabel,
  postalAddress,
} from "./company.js";
import {
  type Audience,
  campaignFooter,
  DEMO_NOW,
  type Draft,
  demoAudiences,
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

/** The demonstration desk's held Facebook post, and the claim it waits on. */
const FLOOR_CLAIM = "Our floor care leaves floors 2x cleaner.";
const FLOOR_POST = `${FLOOR_CLAIM} Ask us for a walkthrough.`;

const HOOK_CONTEXT = {} as HookContext;
/** The gate passes every facts reader the conversation and task of the call it is deciding. */
const CALL_IDENTITY: ApprovalCallIdentity = { conversationId: "conversation-1", taskId: "task-1" };

/**
 * A gated call as the approval gate hands it to the tool after a yes: the draft's id and the facts
 * the gate read from the desk and showed the person.
 */
async function approvedCall(
  reader: MarketingToolset["claimApprovalFacts"],
  draftId: string,
): Promise<Record<string, unknown>> {
  const { facts } = await reader({ draftId }, HOOK_CONTEXT, CALL_IDENTITY);
  return { draftId, [APPROVED_FACTS_ARG]: facts };
}

/** A tool's parameter names, leaving out the key only the approval gate sets. */
function named(tool: { parameters: unknown }) {
  const schema = tool.parameters as {
    properties: Record<string, { description?: string }>;
    required?: string[];
    additionalProperties?: boolean;
  };
  return {
    keys: Object.keys(schema.properties).filter((key) => key !== APPROVED_FACTS_ARG),
    schema,
  };
}

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
    expect(text(result)).toContain("Saved D-106 as a draft (facebook post). Nothing is published");
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
      `call request_claim_approval with draftId D-106, which asks ${approver} and shows them the draft as the desk holds it.`,
    );
    expect(text(result)).toContain(`<text>\n${POST}\n</text>`);
    expect(details(result)).toMatchObject({
      code: "unapproved_claim",
      draftId: "D-106",
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
    expect(await marketing.listDrafts()).toHaveLength(7);
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
      "Saved D-106 as a draft (email to current-clients, channel email)",
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
    expect(await marketing.listDrafts()).toHaveLength(6);
  });
});

describe("request_claim_approval", () => {
  it("request_claim_approval takes only draftId", () => {
    const { keys, schema } = named(tools(desk()).requestClaimApproval);
    // The model names the held draft; its text and held phrases are read from the desk by the gate.
    expect(keys).toEqual(["draftId"]);
    expect(schema.required).toEqual(["draftId"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties[APPROVED_FACTS_ARG]?.description).toBe(
      "set by the approval gate; never supply it",
    );
  });

  it("the approval shows the held draft's text and phrases, read from the desk", async () => {
    const read = await tools(desk()).claimApprovalFacts(
      { draftId: "D-104" },
      HOOK_CONTEXT,
      CALL_IDENTITY,
    );
    expect(read.summary).toBe(
      `Approve for D-104 only: "${FLOOR_CLAIM}" (the phrase "2x cleaner"), in this facebook post:\n${FLOOR_POST}`,
    );
    expect(read.facts).toMatchObject({
      id: "D-104",
      channel: "facebook",
      finalText: FLOOR_POST,
      heldClaims: [{ claim: FLOOR_CLAIM, phrase: "2x cleaner" }],
    });
  });

  it("the approval refuses, asking nobody, a draft not on the desk or with nothing held", async () => {
    const set = tools(desk());
    await expect(
      set.claimApprovalFacts({ draftId: "D-42" }, HOOK_CONTEXT, CALL_IDENTITY),
    ).rejects.toThrow(
      'No draft has the id "D-42". Nothing was put to a person and nothing was approved. Next: find the draft with list_drafts.',
    );
    await expect(
      set.claimApprovalFacts({ draftId: "D-102" }, HOOK_CONTEXT, CALL_IDENTITY),
    ).rejects.toThrow(
      "D-102 has no claim waiting for approval: it is draft. Nothing was put to a person and nothing was approved.",
    );
  });

  it("records the grant for that draft only and publishes nothing", async () => {
    const marketing = desk();
    const set = tools(marketing);
    const first = await set.requestClaimApproval.execute(
      await approvedCall(set.claimApprovalFacts, "D-104"),
      call("g"),
      BACKGROUND_CONTEXT,
    );
    expect(text(first)).toContain(
      `Approved: "${FLOOR_CLAIM}" may be used in D-104, and in no other draft.`,
    );
    expect(text(first)).toContain("Nothing was published");
    expect((await draft(marketing, "D-104")).grantedClaims).toEqual([FLOOR_CLAIM]);
    expect((await draft(marketing, "D-104")).status).toBe("draft");
  });

  it("refuses without approved facts", async () => {
    const marketing = desk();
    const result = await tools(marketing).requestClaimApproval.execute(
      { draftId: "D-104" },
      call("bare"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result)).toMatchObject({ code: "not_approved", draftId: "D-104" });
    expect(text(result)).toContain("Nothing was approved");
    expect((await draft(marketing, "D-104")).status).toBe("held");
  });

  it("refuses when the draft changed after the facts were read, and gives the text it holds", async () => {
    // A host system that lets a held draft be edited: the person saw it before the edit.
    const marketing = desk();
    const earlier = { ...(await draft(marketing, "D-104")), finalText: "An earlier wording." };
    const edited: MarketingDesk = {
      ...marketing,
      listDrafts: async (filter) =>
        filter?.id === "D-104" ? [earlier] : marketing.listDrafts(filter),
    };
    const shown = await approvedCall(tools(edited).claimApprovalFacts, "D-104");
    const result = await tools(marketing).requestClaimApproval.execute(
      shown,
      call("x"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("draft_changed");
    expect(text(result)).toContain("Nothing was approved.");
    expect(text(result)).toContain(`<text>\n${FLOOR_POST}\n</text>`);
    expect((await draft(marketing, "D-104")).status).toBe("held");
  });

  it("a replayed request_claim_approval call writes once", async () => {
    const marketing = desk();
    const set = tools(marketing);
    const args = await approvedCall(set.claimApprovalFacts, "D-104");
    const first = await set.requestClaimApproval.execute(args, call("g"), BACKGROUND_CONTEXT);
    const again = await tools(marketing).requestClaimApproval.execute(
      args,
      call("g"),
      BACKGROUND_CONTEXT,
    );
    expect(text(again)).toBe(text(first));
    expect((await draft(marketing, "D-104")).grantedClaims).toEqual([FLOOR_CLAIM]);
    const second = await set.requestClaimApproval.execute(args, call("g2"), BACKGROUND_CONTEXT);
    expect(details(second).code).toBe("claim_not_held");
  });
});

describe("publish", () => {
  it("publish takes only draftId", () => {
    const { keys, schema } = named(tools(desk()).publish);
    // The model names the draft; its channel and full text are read from the desk by the gate.
    expect(keys).toEqual(["draftId"]);
    expect(schema.required).toEqual(["draftId"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("the approval shows the draft's channel and full text, footer included, read from the desk", async () => {
    const marketing = desk();
    const set = tools(marketing);
    const post = await set.publishApprovalFacts({ draftId: "D-102" }, HOOK_CONTEXT, CALL_IDENTITY);
    const porter = await draft(marketing, "D-102");
    expect(post.summary).toBe(`Publish D-102 on linkedin, exactly as below:\n${porter.finalText}`);
    expect(post.facts).toMatchObject({ id: "D-102", channel: "linkedin" });
    const email = await set.publishApprovalFacts({ draftId: "D-103" }, HOOK_CONTEXT, CALL_IDENTITY);
    const winter = await draft(marketing, "D-103");
    expect(email.summary).toBe(
      `Send D-103 by email to the current clients list (Contracted clients who asked for news and offers), exactly as below, with the unsubscribe line and postal address the desk added:\n${winter.finalText}`,
    );
    expect(email.summary).toContain(postalAddress(company));
  });

  it("says plainly when an email's audience is not on file, rather than naming a list", async () => {
    const marketing = desk();
    const orphan = { ...(await draft(marketing, "D-103")), audienceId: null };
    const edited: MarketingDesk = {
      ...marketing,
      listDrafts: async (filter) =>
        filter?.id === "D-103" ? [orphan] : marketing.listDrafts(filter),
    };
    const read = await tools(edited).publishApprovalFacts(
      { draftId: "D-103" },
      HOOK_CONTEXT,
      CALL_IDENTITY,
    );
    expect(read.summary.split("\n")[0]).toBe(
      "Send D-103 by email with no audience list on file, exactly as below, with the unsubscribe line and postal address the desk added:",
    );
  });

  it("the approval refuses, asking nobody, a held, published or unknown draft", async () => {
    const set = tools(desk());
    await expect(
      set.publishApprovalFacts({ draftId: "D-104" }, HOOK_CONTEXT, CALL_IDENTITY),
    ).rejects.toThrow(
      `D-104 is held: "${FLOOR_CLAIM}" (the phrase "2x cleaner") still needs a person's approval. Nothing was put to a person and nothing was published. Next: each held claim needs request_claim_approval first, which asks ${approver}; or draft it again without the claim.`,
    );
    await expect(
      set.publishApprovalFacts({ draftId: "D-101" }, HOOK_CONTEXT, CALL_IDENTITY),
    ).rejects.toThrow(
      "D-101 was already published on 2026-11-02 (PUB-1). Nothing was put to a person and nothing was published again.",
    );
    await expect(
      set.publishApprovalFacts({ draftId: "D-42" }, HOOK_CONTEXT, CALL_IDENTITY),
    ).rejects.toThrow(
      'No draft has the id "D-42". Nothing was put to a person and nothing was published.',
    );
  });

  it("publishes a ready draft on the demonstration backend", async () => {
    const marketing = desk();
    const set = tools(marketing);
    const first = await set.publish.execute(
      await approvedCall(set.publishApprovalFacts, "D-102"),
      call("p"),
      BACKGROUND_CONTEXT,
    );
    expect(text(first)).toContain("Published PUB-2: D-102 on linkedin");
    expect(text(first)).toContain("demonstration backend");
    expect((await draft(marketing, "D-102")).publicationId).toBe("PUB-2");
  });

  it("refuses without approved facts", async () => {
    const marketing = desk();
    const result = await tools(marketing).publish.execute(
      { draftId: "D-102" },
      call("bare"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result)).toMatchObject({ code: "not_approved", draftId: "D-102" });
    expect(text(result)).toContain("Nothing was published");
    expect((await draft(marketing, "D-102")).status).toBe("draft");
  });

  it("refuses when the draft changed after the facts were read", async () => {
    const marketing = desk();
    const earlier = { ...(await draft(marketing, "D-102")), finalText: "An earlier wording." };
    const edited: MarketingDesk = {
      ...marketing,
      listDrafts: async (filter) =>
        filter?.id === "D-102" ? [earlier] : marketing.listDrafts(filter),
    };
    const shown = await approvedCall(tools(edited).publishApprovalFacts, "D-102");
    const result = await tools(marketing).publish.execute(shown, call("c"), BACKGROUND_CONTEXT);
    expect(details(result).code).toBe("draft_changed");
    expect(text(result)).toContain("Nothing was published.");
    expect(text(result)).toContain("list_drafts");
    expect((await draft(marketing, "D-102")).status).toBe("draft");
  });

  it("a replayed publish call writes once", async () => {
    const marketing = desk();
    const set = tools(marketing);
    const args = await approvedCall(set.publishApprovalFacts, "D-102");
    const first = await set.publish.execute(args, call("p"), BACKGROUND_CONTEXT);
    const again = await tools(marketing).publish.execute(args, call("p"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    const twice = await set.publish.execute(args, call("p2"), BACKGROUND_CONTEXT);
    expect(details(twice).code).toBe("already_published");
  });
});

describe("list_drafts", () => {
  it("lists each draft with its status and full text, and the audiences", async () => {
    const result = await tools(desk()).listDrafts.execute({}, call("l"), BACKGROUND_CONTEXT);
    expect(text(result)).toContain("Drafts (5):");
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
  it("reads the approved claims and the recorded testimonials word for word, and names the approver", async () => {
    const result = await tools(desk()).readCompany.execute(
      { section: "marketing" },
      call("m"),
      BACKGROUND_CONTEXT,
    );
    for (const claim of company.marketing.approvedClaims) expect(text(result)).toContain(claim);
    for (const entry of company.marketing.testimonials ?? []) {
      expect(text(result)).toContain(`- "${entry.quote}" — ${entry.attribution}`);
    }
    expect(text(result)).toContain(approver);
  });

  it("says there are no testimonials when the company records none", async () => {
    const bare = marketingTools({
      desk: desk(),
      company: { ...company, marketing: { ...company.marketing, testimonials: [] } },
    });
    const result = await bare.readCompany.execute(
      { section: "marketing" },
      call("m"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Testimonials on file: none");
  });

  it("quotes testimonials only when the company holds them", async () => {
    const withQuote = marketingTools({
      desk: desk(),
      company: {
        ...company,
        marketing: {
          ...company.marketing,
          testimonials: [{ quote: "Always on time.", attribution: "A client" }],
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
    ).rejects.toThrow("No marketing desk is bound to this role, so nothing was read or written.");
  });
});

/**
 * A host desk that checks nothing: it saves whatever it is handed as a ready draft, whatever claims
 * it was told are held, and publishes whatever it holds. The role's promises (no unapproved result
 * claim, no invented testimonial, an unsubscribe line on every email) must hold on it too, so they
 * are the tool layer's, not a desk's.
 */
function permissiveDesk(seed: readonly Draft[] = []) {
  const drafts: Draft[] = [...seed];
  const calls: string[] = [];
  const audiences: readonly Audience[] = demoAudiences();
  const save = (draft: Pick<Draft, "kind" | "channel" | "audienceId" | "subject" | "text">) => {
    const saved: Draft = {
      ...draft,
      id: `H-${drafts.length + 1}`,
      finalText: draft.text,
      status: "draft",
      heldClaims: [],
      grantedClaims: [],
      createdOn: "2026-11-09",
      publishedOn: null,
      publicationId: null,
    };
    drafts.push(saved);
    return saved;
  };
  const marketing: MarketingDesk = {
    listDrafts: async (filter = {}) =>
      drafts.filter((entry) => filter.id === undefined || entry.id === filter.id),
    listAudiences: async () => audiences,
    draftPost: async (input) => {
      calls.push("draftPost");
      return save({
        kind: "post",
        channel: input.channel,
        audienceId: null,
        subject: null,
        text: input.text,
      });
    },
    draftCampaignEmail: async (input) => {
      calls.push("draftCampaignEmail");
      const saved = save({
        kind: "email",
        channel: "email",
        audienceId: input.audienceId,
        subject: input.subject,
        text: input.body,
      });
      const withFooter = { ...saved, finalText: input.finalText };
      drafts[drafts.length - 1] = withFooter;
      return withFooter;
    },
    approveClaim: async (input) => {
      calls.push("approveClaim");
      return draft(marketing, input.draftId);
    },
    publish: async (input) => {
      calls.push("publish");
      const found = await draft(marketing, input.draftId);
      return {
        id: "HPUB-1",
        draftId: found.id,
        channel: found.channel,
        text: found.finalText,
        publishedAt: DEMO_NOW,
        backend: "host",
      };
    },
  };
  return { marketing, calls };
}

/** A draft as a careless host desk might hold it: ready to publish, whatever it says. */
function hostDraft(overrides: Partial<Draft>): Draft {
  return {
    id: "H-1",
    kind: "post",
    channel: "linkedin",
    audienceId: null,
    subject: null,
    text: "",
    finalText: "",
    status: "draft",
    heldClaims: [],
    grantedClaims: [],
    createdOn: "2026-11-09",
    publishedOn: null,
    publicationId: null,
    ...overrides,
  };
}

describe("with a host desk that checks nothing, the tools still refuse", () => {
  const INVENTED =
    '"Northwind cut our sick days and the lobby has never looked this good." — Morgan Ellis';

  it("draft_post refuses a result claim and hands the desk the held claims", async () => {
    const { marketing } = permissiveDesk();
    const held: unknown[] = [];
    const recording: MarketingDesk = {
      ...marketing,
      draftPost: async (input, options) => {
        held.push(input.heldClaims);
        return marketing.draftPost(input, options);
      },
    };
    const result = await tools(recording).draftPost.execute(
      { channel: "linkedin", text: POST },
      call("h1"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result)).toMatchObject({
      code: "unapproved_claim",
      claims: [{ claim: CLAIM, phrase: "30%" }],
    });
    expect(text(result)).toContain(`"${CLAIM}" (the phrase "30%")`);
    expect(held).toEqual([[{ claim: CLAIM, phrase: "30%" }]]);
  });

  it("draft_post and draft_campaign_email refuse an invented testimonial and save nothing", async () => {
    const { marketing, calls } = permissiveDesk();
    const post = await tools(marketing).draftPost.execute(
      { channel: "linkedin", text: `Hear it from a client. ${INVENTED}` },
      call("h2"),
      BACKGROUND_CONTEXT,
    );
    expect(details(post).code).toBe("unrecorded_testimonial");
    const email = await tools(marketing).draftCampaignEmail.execute(
      { ...EMAIL, body: INVENTED },
      call("h3"),
      BACKGROUND_CONTEXT,
    );
    expect(details(email).code).toBe("unrecorded_testimonial");
    expect(calls).toEqual([]);
    expect(await marketing.listDrafts()).toEqual([]);
  });

  it("draft_campaign_email hands the desk the email with the unsubscribe line and postal address", async () => {
    const { marketing } = permissiveDesk();
    const result = await tools(marketing).draftCampaignEmail.execute(
      EMAIL,
      call("h4"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    const [saved] = await marketing.listDrafts();
    const audience = demoAudiences().find((entry) => entry.id === EMAIL.audienceId) as Audience;
    expect(saved?.finalText).toBe(
      `Subject: ${EMAIL.subject}\n\n${EMAIL.body}\n\n${campaignFooter(company, audience)}`,
    );
    expect(saved?.finalText).toContain(postalAddress(company));
  });

  it("publish refuses a draft the desk calls ready that states a claim nobody approved", async () => {
    const { marketing, calls } = permissiveDesk([hostDraft({ text: POST, finalText: POST })]);
    const set = tools(marketing);
    const result = await set.publish.execute(
      await approvedCall(set.publishApprovalFacts, "H-1"),
      call("h5"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain(`"${CLAIM}" (the phrase "30%")`);
    expect(text(result)).toContain("Nothing was published.");
    expect(calls).toEqual([]);
  });

  it("publish lets through a claim a person approved for that draft", async () => {
    const { marketing, calls } = permissiveDesk([
      hostDraft({ text: POST, finalText: POST, grantedClaims: [CLAIM] }),
    ]);
    const set = tools(marketing);
    const result = await set.publish.execute(
      await approvedCall(set.publishApprovalFacts, "H-1"),
      call("h6"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(false);
    expect(calls).toEqual(["publish"]);
  });

  it("publish refuses a campaign email that lost its unsubscribe line and postal address", async () => {
    const bare = `Subject: ${EMAIL.subject}\n\n${EMAIL.body}`;
    const { marketing, calls } = permissiveDesk([
      hostDraft({
        kind: "email",
        channel: "email",
        audienceId: EMAIL.audienceId,
        subject: EMAIL.subject,
        text: EMAIL.body,
        finalText: bare,
      }),
    ]);
    const set = tools(marketing);
    const result = await set.publish.execute(
      await approvedCall(set.publishApprovalFacts, "H-1"),
      call("h7"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("unsubscribe line and postal address");
    expect(text(result)).toContain("Nothing was published.");
    expect(calls).toEqual([]);
  });

  it("request_claim_approval and publish refuse a draft that quotes an invented testimonial", async () => {
    const quoted = `${INVENTED} Our floors are 2x cleaner.`;
    const { marketing, calls } = permissiveDesk([
      hostDraft({
        status: "held",
        text: quoted,
        finalText: quoted,
        heldClaims: [{ claim: "Our floors are 2x cleaner.", phrase: "2x cleaner" }],
      }),
      hostDraft({ id: "H-2", text: INVENTED, finalText: INVENTED }),
    ]);
    const set = tools(marketing);
    const grant = await set.requestClaimApproval.execute(
      await approvedCall(set.claimApprovalFacts, "H-1"),
      call("h8"),
      BACKGROUND_CONTEXT,
    );
    expect(details(grant).code).toBe("unrecorded_testimonial");
    expect(text(grant)).toContain("Nothing was approved.");
    const out = await set.publish.execute(
      await approvedCall(set.publishApprovalFacts, "H-2"),
      call("h9"),
      BACKGROUND_CONTEXT,
    );
    expect(details(out).code).toBe("unrecorded_testimonial");
    expect(text(out)).toContain("Nothing was published.");
    expect(calls).toEqual([]);
  });
});
