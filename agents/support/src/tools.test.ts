/**
 * One block per tool, against `fakeSupportDesk` and the company facts generated into this package,
 * through the registrations the factory builds and with the durable call identity Pi Durable hands to
 * `execute`. Every unsafe tool is replayed under the same call id here, at the tool level, and must
 * write once. Every next step is chosen from a refusal's code, never from its wording. No network, no
 * model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import {
  companyHead,
  escalationOwner,
  loadCompanyFacts,
  money,
  person,
  personLabel,
} from "./company.js";
import { DEMO_NOW, fakeSupportDesk, type SupportDesk, SupportDeskError } from "./desk.js";
import { type SupportToolset, supportTools } from "./tools.js";

const company = loadCompanyFacts();
const refunds = company.policies.refunds;
const creditOwner = personLabel(person(company, refunds.creditNeeds));
const refundOwner = personLabel(person(company, refunds.refundNeeds));
const complaintOwner = personLabel(person(company, refunds.complaintOwner));
const safetyOwner = personLabel(escalationOwner(company, "safety-incident"));
/** "Name (Title)", as a hand-off receipt names who has the case. */
const named = (who: ReturnType<typeof person>) => `${who?.name} (${who?.title})`;

/** The durable identity one tool call runs under; only the ids matter to these tools. */
const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;

const tools = (desk: SupportDesk | undefined): SupportToolset => supportTools({ desk, company });

const desk = (): SupportDesk => fakeSupportDesk({ now: () => new Date(DEMO_NOW) });

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

const CREDIT = {
  caseId: "C-301",
  client: "Hawthorne Family Dental",
  invoiceId: "INV-2041",
  line: 1,
  creditCents: refunds.serviceRecoveryCreditCents,
};

const SAFETY = {
  clientId: "CL-102",
  kind: "complaint",
  category: "safety",
  summary: "An unlabelled bottle of bleach was left on a low shelf in the toddler room.",
  reportedBy: "Megan Shaw",
  source: "email from Megan Shaw, Monday 9 November",
};

/** A desk whose every write refuses with one code and a message that names no tool. */
function quiet(
  code: SupportDeskError["code"],
  extra: ConstructorParameters<typeof SupportDeskError>[2] = {},
): SupportDesk {
  const refuse = async (): Promise<never> => {
    throw new SupportDeskError(code, "Refused.", extra);
  };
  return {
    ...desk(),
    logCase: refuse,
    bookReclean: refuse,
    issueCredit: refuse,
    escalateCase: refuse,
    resolveCase: refuse,
  };
}

describe("find_client", () => {
  it("finds a client with its contact, site, contract and open cases", async () => {
    const result = await tools(desk()).findClient.execute(
      { query: "Hawthorne" },
      call("a1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(
      "CL-101 — Hawthorne Family Dental — contact Grace Liu (grace@hawthornefamilydental.example) — 2,400 sq ft dental suite on SE Hawthorne Boulevard — contract CT-301 — 1 case open",
    );
    expect(details(result).found).toBe(true);
  });

  it("says plainly when no client matches", async () => {
    const result = await tools(desk()).findClient.execute(
      { query: "Acme Widgets" },
      call("a2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).found).toBe(false);
  });
});

describe("list_cases", () => {
  it("lists a client's cases with re-clean, credit and escalation, and the credit for each invoice line", async () => {
    const result = await tools(desk()).listCases.execute(
      { clientId: "CL-101" },
      call("b1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(
      "C-301 — Hawthorne Family Dental (CL-101) — complaint, quality — open — priority high — opened 2026-11-06 by Grace Liu",
    );
    expect(text(result)).toContain("re-clean: none — credit: none — escalated: no");
    expect(text(result)).toContain(
      "INV-2041 line 1 — Office cleaning, one visit, up to 3,000 sq ft — 22 × visit at $185.00 = $4,070.00 — credit if a person approves: $150.00",
    );
    expect(text(result)).toContain(
      'To ask for it: offer_credit with caseId C-301, client "Hawthorne Family Dental", invoiceId INV-2041, line 1, creditCents 15000.',
    );
    expect(details(result).found).toBe(true);
  });

  it("shows a credit waiting for a person and a re-clean not yet done, and offers no second credit", async () => {
    const result = await tools(desk()).listCases.execute(
      { status: "open" },
      call("b2"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(
      `credit: $150.00 on INV-2044 line 1, waiting for ${creditOwner}`,
    );
    expect(text(result)).toContain("re-clean: booked for 2026-11-10, not done yet");
    expect(text(result)).not.toContain("offer_credit with caseId C-304");
  });

  it("lists every case with no filter, and refuses a case that does not exist", async () => {
    const all = await tools(desk()).listCases.execute({}, call("b3"), BACKGROUND_CONTEXT);
    expect(text(all)).toContain("Cases (6)");
    const missing = await tools(desk()).listCases.execute(
      { caseId: "C-42" },
      call("b4"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(missing)).toBe(true);
    expect(details(missing).found).toBe(false);
  });
});

describe("log_case", () => {
  it("logs a case once on replay, and points a safety complaint at escalate_case from its category", async () => {
    const support = desk();
    const first = await tools(support).logCase.execute(SAFETY, call("same"), BACKGROUND_CONTEXT);
    const again = await tools(support).logCase.execute(SAFETY, call("same"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    expect(text(first)).toContain(
      "Logged C-306 for Little Acorns Childcare: complaint, safety, priority urgent",
    );
    expect(text(first)).toContain(
      `Next: a safety complaint goes to a person now: call escalate_case with caseId C-306 and reason safety, which hands it to ${safetyOwner}.`,
    );
    expect(details(first)).toMatchObject({ id: "C-306", category: "safety" });
    expect(await support.listCases({ clientId: "CL-102" })).toHaveLength(2);
  });

  it("treats a different call as a different write: the replay key is the durable call identity", async () => {
    const support = desk();
    await tools(support).logCase.execute(SAFETY, call("one"), BACKGROUND_CONTEXT);
    const second = await tools(support).logCase.execute(SAFETY, call("two"), BACKGROUND_CONTEXT);
    expect(text(second)).toContain("Logged C-307");
    const other = { conversationId: "conversation-2", taskId: "task-1", callId: "one" } as never;
    const third = await tools(support).logCase.execute(SAFETY, other, BACKGROUND_CONTEXT);
    expect(text(third)).toContain("Logged C-308");
  });

  it("gives no escalation step for a question", async () => {
    const result = await tools(desk()).logCase.execute(
      { ...SAFETY, kind: "question", category: "other", summary: "Do you clean on holidays?" },
      call("c2"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain("Logged C-306");
    expect(text(result)).not.toContain("escalate_case");
  });

  it("refuses an unknown client", async () => {
    const result = await tools(desk()).logCase.execute(
      { ...SAFETY, clientId: "CL-999" },
      call("c3"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("not_found");
  });
});

describe("book_reclean", () => {
  it("books a re-clean once on replay, with the weekday", async () => {
    const support = desk();
    const args = { caseId: "C-301", date: "2026-11-11" };
    const first = await tools(support).bookReclean.execute(args, call("same"), BACKGROUND_CONTEXT);
    const again = await tools(support).bookReclean.execute(args, call("same"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    expect(text(first)).toContain(
      "Booked a re-clean for C-301 (Hawthorne Family Dental) on Wednesday 2026-11-11",
    );
    expect(text(first)).toContain("no charge");
    expect((await support.listCases({ caseId: "C-301" }))[0]?.reclean?.date).toBe("2026-11-11");
  });

  it("refuses a date outside the window and points to the complaint owner", async () => {
    const result = await tools(desk()).bookReclean.execute(
      { caseId: "C-301", date: "2026-11-20" },
      call("d2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("outside_window");
    expect(text(result)).toContain(
      `Next: offer a date inside the window, or call escalate_case with reason unresolved, which hands it to ${complaintOwner}.`,
    );
  });

  it("refuses a case a re-clean does not put right, naming the other remedies", async () => {
    const result = await tools(desk()).bookReclean.execute(
      { caseId: "C-304", date: "2026-11-11" },
      call("d3"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).code).toBe("not_reclean");
    expect(text(result)).toContain("offer_credit");
    expect(text(result)).toContain("escalate_case");
  });
});

describe("offer_credit", () => {
  it("issues the desk's credit once on replay, saying it was approved", async () => {
    const support = desk();
    const first = await tools(support).offerCredit.execute(
      CREDIT,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    const again = await tools(support).offerCredit.execute(
      CREDIT,
      call("same"),
      BACKGROUND_CONTEXT,
    );
    expect(text(again)).toBe(text(first));
    expect(isError(first)).toBe(false);
    expect(text(first)).toContain(
      "Approved and issued: credit note CN-501 for $150.00 on INV-2041 line 1 (Office cleaning, one visit, up to 3,000 sq ft), Hawthorne Family Dental, case C-301.",
    );
    expect(text(first)).toContain("It is a credit on the invoice, not money back.");
    expect((await support.listCases({ caseId: "C-301" }))[0]?.credit?.status).toBe("issued");
  });

  it("issues nothing for an amount that is not the desk's, and gives the desk's figures to ask again", async () => {
    const support = desk();
    const result = await tools(support).offerCredit.execute(
      { ...CREDIT, creditCents: 40700 },
      call("e2"),
      BACKGROUND_CONTEXT,
    );
    expect(isError(result)).toBe(true);
    expect(details(result)).toMatchObject({ code: "credit_changed", creditCents: 15000 });
    expect(text(result)).toContain(
      'Next: if the client still wants it, call offer_credit with caseId C-301, client "Hawthorne Family Dental", invoiceId INV-2041, line 1, creditCents 15000.',
    );
    expect((await support.listCases({ caseId: "C-301" }))[0]?.credit).toBeNull();
  });

  it("says a credit already waiting is with the person who approves credits, and not to ask again", async () => {
    const result = await tools(desk()).offerCredit.execute(
      { ...CREDIT, caseId: "C-304", client: "Burnside Property Group", invoiceId: "INV-2044" },
      call("e3"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).code).toBe("credit_waiting");
    expect(text(result)).toContain(
      `A credit on C-304 is already with ${creditOwner}: tell the client it waits for them, and do not ask again.`,
    );
  });
});

describe("escalate_case", () => {
  it("hands a refund to the person who decides money back, once on replay, promising nothing", async () => {
    const support = desk();
    const args = { caseId: "C-301", reason: "refund", note: "Wants October back." };
    const first = await tools(support).escalateCase.execute(args, call("same"), BACKGROUND_CONTEXT);
    const again = await tools(support).escalateCase.execute(args, call("same"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    expect(text(first)).toContain(
      `Handed C-301 (Hawthorne Family Dental) to ${refundOwner}, for refund.`,
    );
    expect(text(first)).toContain(
      `Tell the client plainly that ${named(person(company, refunds.refundNeeds))} will decide; promise no money.`,
    );
    expect(text(first)).toContain("nothing has been sent to the client");
    expect((await support.listCases({ caseId: "C-301" }))[0]?.escalations).toHaveLength(1);
  });

  it("says when a complaint about someone went to another person", async () => {
    const owner = person(company, refunds.complaintOwner);
    const head = personLabel(companyHead(company));
    const headNamed = named(companyHead(company));
    const result = await tools(desk()).escalateCase.execute(
      { caseId: "C-303", reason: "staff", note: "Rude on the phone.", about: owner?.name },
      call("f2"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(`to ${head}, for staff`);
    expect(text(result)).toContain(
      `The complaint is about ${owner?.name}, so it went to ${headNamed} instead.`,
    );
    expect(details(result)).toMatchObject({ redirected: true });
  });

  it("gives a safety escalation's owner", async () => {
    const result = await tools(desk()).escalateCase.execute(
      { caseId: "C-301", reason: "safety", note: "Chemical left out." },
      call("f3"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(`to ${safetyOwner}, for safety`);
  });
});

describe("resolve_case", () => {
  it("closes a case with its outcome once on replay", async () => {
    const support = desk();
    const args = { caseId: "C-302", outcome: "Re-clean done; the director confirmed the carpet." };
    const first = await tools(support).resolveCase.execute(args, call("same"), BACKGROUND_CONTEXT);
    const again = await tools(support).resolveCase.execute(args, call("same"), BACKGROUND_CONTEXT);
    expect(text(again)).toBe(text(first));
    expect(text(first)).toContain("Closed C-302 (Little Acorns Childcare) on 2026-11-09. Outcome:");
    expect((await support.listCases({ caseId: "C-302" }))[0]?.status).toBe("closed");
  });

  it("refuses a case with a credit waiting or a re-clean not done, naming what it waits for", async () => {
    const waiting = await tools(desk()).resolveCase.execute(
      { caseId: "C-304", outcome: "Done." },
      call("g2"),
      BACKGROUND_CONTEXT,
    );
    expect(details(waiting).code).toBe("credit_waiting");
    expect(text(waiting)).toContain(creditOwner);
    const pending = await tools(desk()).resolveCase.execute(
      { caseId: "C-305", outcome: "Done." },
      call("g3"),
      BACKGROUND_CONTEXT,
    );
    expect(details(pending).code).toBe("reclean_pending");
    expect(text(pending)).toContain("Next: leave it open until the re-clean is done");
  });

  it("points an unescalated safety case at escalate_case", async () => {
    const support = desk();
    const logged = await support.logCase(
      { ...SAFETY, kind: "complaint", category: "safety" },
      { requestId: "log" },
    );
    const result = await tools(support).resolveCase.execute(
      { caseId: logged.id, outcome: "Spoke to the crew." },
      call("g4"),
      BACKGROUND_CONTEXT,
    );
    expect(details(result).code).toBe("not_escalated");
    expect(text(result)).toContain(
      `Next: call escalate_case with caseId ${logged.id} and reason safety, which hands it to ${safetyOwner}.`,
    );
  });
});

describe("next steps come from the refusal's code, not its wording", () => {
  it("names the step for each code even when the desk's message names no tool", async () => {
    const cases: [
      SupportDeskError["code"],
      keyof SupportToolset,
      Record<string, unknown>,
      string,
    ][] = [
      [
        "not_escalated",
        "resolveCase",
        { caseId: "C-9", outcome: "x" },
        "escalate_case with caseId C-9 and reason safety",
      ],
      ["credit_waiting", "resolveCase", { caseId: "C-9", outcome: "x" }, creditOwner],
      [
        "reclean_pending",
        "resolveCase",
        { caseId: "C-9", outcome: "x" },
        "until the re-clean is done",
      ],
      [
        "outside_window",
        "bookReclean",
        { caseId: "C-9", date: "2026-11-11" },
        "escalate_case with reason unresolved",
      ],
      ["not_reclean", "bookReclean", { caseId: "C-9", date: "2026-11-11" }, "offer_credit"],
    ];
    for (const [code, tool, args, step] of cases) {
      const result = await tools(quiet(code, { caseId: "C-9" }))[tool].execute(
        args as never,
        call(`q-${code}`),
        BACKGROUND_CONTEXT,
      );
      expect(text(result), code).toContain(step);
      expect(details(result).code).toBe(code);
    }
    const changed = await tools(
      quiet("credit_changed", {
        quote: { caseId: "C-9", client: "X Co", invoiceId: "INV-9", line: 2, creditCents: 7 },
      }),
    ).offerCredit.execute(CREDIT, call("q-changed"), BACKGROUND_CONTEXT);
    expect(text(changed)).toContain(
      'offer_credit with caseId C-9, client "X Co", invoiceId INV-9, line 2, creditCents 7',
    );
  });
});

describe("read_company", () => {
  it("reads who decides complaints, credits and money back, the re-clean window and the usual credit", async () => {
    const result = await tools(desk()).readCompany.execute(
      { section: "support" },
      call("h1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(result)).toContain(complaintOwner);
    expect(text(result)).toContain(creditOwner);
    expect(text(result)).toContain(refundOwner);
    expect(text(result)).toContain(`${refunds.recleanWindowDays} business days`);
    expect(text(result)).toContain(money(refunds.serviceRecoveryCreditCents));
  });

  it("reads the people and who decides what", async () => {
    const result = await tools(desk()).readCompany.execute(
      { section: "people" },
      call("h2"),
      BACKGROUND_CONTEXT,
    );
    for (const worker of company.people) expect(text(result)).toContain(worker.name);
  });
});

describe("with no desk", () => {
  it("refuses at the point of use", async () => {
    await expect(
      tools(undefined).listCases.execute({}, call("i1"), BACKGROUND_CONTEXT),
    ).rejects.toThrow("No support desk is configured");
  });
});
