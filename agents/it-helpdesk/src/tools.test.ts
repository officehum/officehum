/**
 * One block per tool, against `fakeItDesk` and the company facts generated into this package, through
 * the registrations the factory builds and with the durable call identity Pi Durable hands to
 * `execute`. No network, no model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { APPROVED_FACTS_ARG, type VerifiedSender } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { itApprover, loadCompanyFacts, personLabel } from "./company.js";
import { DEMO_NOW, type DeskRefusal, fakeItDesk, type ItDesk } from "./desk.js";
import { HINTS, type ItHelpdeskToolset, itHelpdeskTools } from "./tools.js";

const company = loadCompanyFacts();
const approver = personLabel(itApprover(company));

const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;
const staff = (id: string): VerifiedSender => ({
  origin: "internal",
  channel: "chat",
  contact: id,
});
const NOAH = staff("noah-kim");
const PRIYA = staff("priya-raman");
const DANA = staff("dana-whitfield");

/** The tools, asked by `sender`; `null` is a host that knows nobody. */
const tools = (desk: ItDesk | undefined, sender: VerifiedSender | null = NOAH): ItHelpdeskToolset =>
  itHelpdeskTools({ desk, company, sender: async () => sender ?? undefined });
const desk = (): ItDesk => fakeItDesk({ company, now: () => new Date(DEMO_NOW) });

async function run(tool: ToolRegistration, args: Record<string, unknown>, callId = "c1") {
  return tool.execute(args as never, call(callId), BACKGROUND_CONTEXT);
}
function text(result: { output?: readonly unknown[] }): string {
  return (result.output ?? []).map((block) => (block as { text?: string }).text ?? "").join("\n");
}
function details(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}
function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}
const identity = { conversationId: "conversation-1", taskId: "task-1" };

/** Every contact detail on the company record, which no tool may ever print. */
const CONTACTS = (company.people as unknown as { email: string; phone: string }[]).flatMap(
  (worker) => [worker.email, worker.phone],
);

describe("refusal hints", () => {
  it("has a next step for every refusal code the desk can give", () => {
    const codes: DeskRefusal[] = [
      "unknown_sender",
      "not_staff",
      "someone_else",
      "not_found",
      "ambiguous",
      "invalid",
      "privileged",
      "no_access",
      "disabled",
      "already_member",
      "already_disabled",
      "exists",
      "changed",
      "closed",
      "assigned",
      "retired",
      "not_assigned",
    ];
    const hints = HINTS(company);
    expect(Object.keys(hints).sort()).toEqual([...codes].sort());
    for (const code of codes) expect(hints[code].trim().length, code).toBeGreaterThan(10);
    expect(hints.privileged).toContain(approver);
  });
});

describe("list_my_access", () => {
  it("gives the sender their own groups and no contact detail", async () => {
    const result = await run(tools(desk()).listMyAccess, {});
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("Noah Kim (the sender)");
    expect(text(result)).toContain("Staff email");
    for (const contact of CONTACTS) expect(text(result)).not.toContain(contact);
  });

  it("refuses someone else's account and an unknown sender, sharing nothing", async () => {
    const other = await run(tools(desk()).listMyAccess, { person: "Priya Raman" });
    expect(details(other)).toMatchObject({ code: "someone_else" });
    expect(text(other)).not.toContain("Scheduling");
    const nobody = await run(tools(desk(), null).listMyAccess, {});
    expect(details(nobody)).toMatchObject({ code: "unknown_sender" });
    expect(text(nobody)).toContain("Nothing was read, sent or changed");
  });
});

describe("send_password_reset", () => {
  it("sends to the address on file with a notice, prints no address or secret, and replays once", async () => {
    const it = desk();
    const toolset = tools(it);
    const result = await run(toolset.sendPasswordReset, { systemId: "email" }, "reset");
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("the address on file");
    expect(text(result)).toContain("notice");
    expect(text(result)).toContain("Nothing secret");
    for (const contact of CONTACTS) expect(text(result)).not.toContain(contact);
    const again = await run(toolset.sendPasswordReset, { systemId: "email" }, "reset");
    expect(text(again)).toBe(text(result));
    expect(await it.resetsSent()).toHaveLength(1);
  });

  it("refuses someone else's account and a privileged one, naming who decides", async () => {
    const other = await run(tools(desk()).sendPasswordReset, {
      systemId: "email",
      person: "Diego Ramirez",
    });
    expect(details(other)).toMatchObject({ code: "someone_else" });
    expect(text(other)).toContain("someone else's account");
    const admin = await run(tools(desk(), DANA).sendPasswordReset, { systemId: "email" });
    expect(details(admin)).toMatchObject({ code: "privileged" });
    expect(text(admin)).toContain(approver);
  });
});

describe("log_ticket, escalate_ticket and resolve_ticket", () => {
  it("takes no priority: the desk sets it from the category and impact", async () => {
    const toolset = tools(desk());
    const properties = (toolset.logTicket.parameters as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties).sort()).toEqual(["category", "description", "impact"]);
    const result = await run(toolset.logTicket, {
      category: "security",
      impact: "one_person_can_work",
      description: "Odd sign-in alert",
    });
    expect(text(result)).toContain("Logged T-1004");
    expect(text(result)).toContain("priority high");
    expect(details(result)).toMatchObject({ priority: "high", reporterName: "Noah Kim" });
  });

  it("escalates to the system owner and says who has it", async () => {
    const result = await run(tools(desk()).escalateTicket, {
      ticketId: "T-1002",
      systemId: "accounting",
      notes: "Reinstalled; still closes",
    });
    expect(text(result)).toContain("Escalated T-1002 to Eileen Hart, Finance and Billing");
  });

  it("closes a confirmed fix and keeps an unconfirmed one waiting for the reporter", async () => {
    const it = desk();
    const waiting = await run(
      tools(it).resolveTicket,
      { ticketId: "T-1001", outcome: "Cleared the jam", reporterConfirmed: false },
      "r1",
    );
    expect(text(waiting)).toContain("waits for");
    expect(text(waiting)).not.toContain("Closed");
    const closed = await run(
      tools(it).resolveTicket,
      { ticketId: "T-1001", outcome: "Cleared the jam", reporterConfirmed: true },
      "r2",
    );
    expect(text(closed)).toContain("Closed T-1001");
    const again = await run(
      tools(it).resolveTicket,
      { ticketId: "T-1001", outcome: "x", reporterConfirmed: true },
      "r3",
    );
    expect(details(again)).toMatchObject({ code: "closed" });
  });
});

describe("request_access", () => {
  it("is refused before anyone is asked for a privileged group, naming who decides", async () => {
    const toolset = tools(desk(), PRIYA);
    await expect(
      toolset.accessFacts(
        { person: "Priya Raman", groupId: "email-admins", reason: "x" },
        BACKGROUND_CONTEXT,
        identity,
      ),
    ).rejects.toThrow(approver);
  });

  it("shows the person deciding the group, its system and owner", async () => {
    const facts = await tools(desk(), PRIYA).accessFacts(
      { person: "Noah Kim", groupId: "accounting-billing", reason: "Covering invoices" },
      BACKGROUND_CONTEXT,
      identity,
    );
    expect(facts.summary).toBe(
      "Add Noah Kim to Accounting, billing (Accounting, owned by Eileen Hart, Finance and Billing). Reason: Covering invoices",
    );
  });

  it("grants nothing without approved facts, and exactly the approved grant with them", async () => {
    const it = desk();
    const toolset = tools(it, PRIYA);
    const args = { person: "Noah Kim", groupId: "accounting-billing", reason: "Covering invoices" };
    const bare = await run(toolset.requestAccess, args);
    expect(details(bare)).toMatchObject({ code: "not_approved" });
    expect(text(bare)).toContain("Nothing was granted");
    const facts = await toolset.accessFacts(args, BACKGROUND_CONTEXT, identity);
    const granted = await run(
      toolset.requestAccess,
      { ...args, [APPROVED_FACTS_ARG]: facts.facts },
      "g",
    );
    expect(text(granted)).toContain("Approved and granted: Noah Kim now has Accounting, billing");
    const own = await it.myAccess({ from: NOAH });
    expect(own.groups.map((group) => group.id)).toContain("accounting-billing");
  });
});

describe("request_sign_in_method_change", () => {
  it("reads the sender's own account, refuses another's, and changes nothing unapproved", async () => {
    const toolset = tools(desk());
    const facts = await toolset.signInChangeFacts(
      { reason: "New phone" },
      BACKGROUND_CONTEXT,
      identity,
    );
    expect(facts.summary).toContain("Noah Kim");
    await expect(
      toolset.signInChangeFacts(
        { reason: "New phone", person: "Priya Raman" },
        BACKGROUND_CONTEXT,
        identity,
      ),
    ).rejects.toThrow("someone else's account");
    const bare = await run(toolset.requestSignInMethodChange, { reason: "New phone" });
    expect(details(bare)).toMatchObject({ code: "not_approved" });
    const done = await run(
      toolset.requestSignInMethodChange,
      { reason: "New phone", [APPROVED_FACTS_ARG]: facts.facts },
      "s",
    );
    expect(text(done)).toContain("Approved");
    expect(text(done)).toContain("in person");
    expect(text(done)).not.toMatch(/\b\d{6}\b/);
  });
});

describe("request_account_setup and request_account_disable", () => {
  it("sets up a joiner only once approved, with no password in the receipt", async () => {
    const toolset = tools(desk(), PRIYA);
    const args = { name: "Lena Brooks", job: "Office assistant", startDate: "2026-11-16" };
    expect(details(await run(toolset.requestAccountSetup, args))).toMatchObject({
      code: "not_approved",
    });
    const facts = await toolset.setupFacts(args, BACKGROUND_CONTEXT, identity);
    expect(facts.summary).toContain("Lena Brooks");
    const done = await run(
      toolset.requestAccountSetup,
      { ...args, [APPROVED_FACTS_ARG]: facts.facts },
      "j",
    );
    expect(text(done)).toContain("Approved and set up: an account for Lena Brooks");
    expect(text(done)).toContain("never by email");
  });

  it("disables a leaver only once approved, and lists the equipment to collect", async () => {
    const toolset = tools(desk(), PRIYA);
    const args = { person: "Noah Kim", reason: "Last day Friday" };
    expect(details(await run(toolset.requestAccountDisable, args))).toMatchObject({
      code: "not_approved",
    });
    const facts = await toolset.disableFacts(args, BACKGROUND_CONTEXT, identity);
    const done = await run(
      toolset.requestAccountDisable,
      { ...args, [APPROVED_FACTS_ARG]: facts.facts },
      "d",
    );
    expect(text(done)).toContain("Approved and disabled: Noah Kim's account");
    expect(text(done)).toContain("LT-203");
    expect(text(done)).toContain(approver);
  });
});

describe("assets", () => {
  it("refuses an asset already assigned and points to return_asset", async () => {
    const result = await run(tools(desk(), PRIYA).assignAsset, {
      tag: "LT-201",
      person: "Noah Kim",
    });
    expect(details(result)).toMatchObject({ code: "assigned" });
    expect(text(result)).toContain("return_asset");
  });

  it("assigns, returns and lists", async () => {
    const toolset = tools(desk(), PRIYA);
    const given = await run(toolset.assignAsset, { tag: "LT-204", person: "Noah Kim" }, "a");
    expect(text(given)).toContain("Assigned LT-204 (14-inch laptop) to Noah Kim");
    const back = await run(toolset.returnAsset, { tag: "LT-204", condition: "Good" }, "b");
    expect(text(back)).toContain("Returned LT-204");
    const listed = await run(toolset.listAssets, { status: "in_stock" }, "c");
    expect(text(listed)).toContain("LT-204");
  });

  // `it.onboarding`'s completion check (officehum.json): the board runs list_assets with only the
  // joiner's name from the ticket, so it must find nothing before the work and the equipment after.
  it("finds nothing for a joiner before onboarding, and their equipment once it is assigned", async () => {
    const it = desk();
    const toolset = tools(it, PRIYA);
    const check = { person: "Lena Brooks" };
    expect(details(await run(toolset.listAssets, check, "before"))).toMatchObject({ found: false });

    const setup = { name: "Lena Brooks", job: "Office assistant", startDate: "2026-11-16" };
    const facts = await toolset.setupFacts(setup, BACKGROUND_CONTEXT, identity);
    await run(toolset.requestAccountSetup, { ...setup, [APPROVED_FACTS_ARG]: facts.facts }, "j");
    expect(details(await run(toolset.listAssets, check, "account"))).toMatchObject({
      found: false,
    });

    await run(toolset.assignAsset, { tag: "LT-204", person: "Lena Brooks" }, "a");
    const after = details(await run(toolset.listAssets, check, "after"));
    expect(after).toMatchObject({ found: true, assets: [{ tag: "LT-204" }] });
  });
});

describe("report_security_concern", () => {
  it("hands the report to the person who decides IT and blames nobody", async () => {
    const result = await run(tools(desk()).reportSecurityConcern, {
      kind: "phishing",
      description: "Email asking to confirm a password",
    });
    expect(text(result)).toContain(`Reported SEC-1 (phishing) to ${approver}`);
    expect(text(result)).toContain("Nothing was changed");
  });
});

describe("read_company", () => {
  it("names who decides IT, each system's owner and which groups carry administrator rights, with no contacts", async () => {
    const it = await run(tools(undefined).readCompany, { section: "it" });
    expect(text(it)).toContain(
      `Access, administrator rights, leavers' data and security: ${approver}`,
    );
    expect(text(it)).toContain("Email administrators (email) — administrator rights");
    expect(text(it)).toContain("Accounting — owner Eileen Hart, Finance and Billing");
    const people = await run(tools(undefined).readCompany, { section: "people" });
    for (const contact of CONTACTS) {
      expect(text(it)).not.toContain(contact);
      expect(text(people)).not.toContain(contact);
    }
  });
});

describe("no desk bound", () => {
  it("refuses every desk tool and says how to bind one", async () => {
    await expect(run(tools(undefined).listTickets, {})).rejects.toThrow("No IT desk is bound");
  });
});
