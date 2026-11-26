/**
 * One block per tool, against `fakeQualityDesk` and the company facts generated into this package,
 * through the registrations the factory builds and with the durable call identity Pi Durable hands to
 * `execute`. Every unsafe tool is replayed under the same call id here and must write once. No
 * network, no model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { APPROVED_FACTS_ARG, type ApprovalCallIdentity, type HookContext } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import {
  creditDecider,
  loadCompanyFacts,
  personLabel,
  qualityOwner,
  safetyOfficer,
} from "./company.js";
import { fakeQualityDesk, type QualityDesk } from "./desk.js";
import { type QualityToolset, qualityTools } from "./tools.js";

const company = loadCompanyFacts();
const ITEMS = company.quality.checklist.map((item) => item.id);
const LIMITS = () => ({ inspection_pass_score: 85 });

const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;
const HOOK_CONTEXT = {} as HookContext;
const CALL_IDENTITY: ApprovalCallIdentity = { conversationId: "conversation-1", taskId: "task-1" };

const tools = (
  desk: QualityDesk | undefined,
  limits: () => Readonly<Record<string, number>> = LIMITS,
): QualityToolset => qualityTools({ desk, company, limits });

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

const results = (fail: readonly string[] = []) =>
  ITEMS.map((itemId) => ({ itemId, result: fail.includes(itemId) ? "fail" : "pass" }));

async function run(
  set: QualityToolset,
  name: keyof QualityToolset,
  args: Record<string, unknown>,
  callId: string = name,
) {
  const tool = set[name] as { execute: (a: never, c: never, x: never) => Promise<unknown> };
  return (await tool.execute(args as never, call(callId), BACKGROUND_CONTEXT as never)) as {
    output?: readonly unknown[];
  };
}

describe("record_inspection", () => {
  it("takes no score from the model: only each item's result", () => {
    const schema = tools(fakeQualityDesk()).recordInspection.parameters as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "notes",
      "results",
      "siteId",
      "visitDate",
    ]);
  });

  it("states the desk's score and judges it against the limit read at this call", async () => {
    const desk = fakeQualityDesk();
    let limit = 85;
    const set = tools(desk, () => ({ inspection_pass_score: limit }));
    const failed = await run(set, "recordInspection", {
      siteId: "S-101",
      visitDate: "2026-11-06",
      results: results(["carpets", "trash"]),
    });
    expect(text(failed)).toContain("Recorded INS-509");
    expect(text(failed)).toContain("Score 75 out of 100");
    expect(text(failed)).toContain("FAIL against the pass score of 85");
    expect(text(failed)).toContain("Next: open a non-conformance report");

    // A business that lowers its pass score is judged by the new one on the next call.
    limit = 70;
    const passed = await run(
      set,
      "recordInspection",
      { siteId: "S-101", visitDate: "2026-11-06", results: results(["carpets", "trash"]) },
      "second",
    );
    expect(text(passed)).toContain("PASS against the pass score of 70");
  });

  it("gives the score and says it cannot judge pass or fail when no pass score resolves", async () => {
    const result = await run(
      tools(fakeQualityDesk(), () => ({})),
      "recordInspection",
      {
        siteId: "S-101",
        visitDate: "2026-11-06",
        results: results(["carpets"]),
      },
    );
    expect(text(result)).toContain("Score 85 out of 100");
    expect(text(result)).toContain(
      "No pass score is set for this role, so the desk cannot say whether it passed",
    );
    expect(details(result).outcome).toBe("unjudged");
  });

  it("writes once when replayed under the same call id", async () => {
    const desk = fakeQualityDesk();
    const set = tools(desk);
    const args = { siteId: "S-102", visitDate: "2026-11-06", results: results() };
    await run(set, "recordInspection", args, "same");
    await run(set, "recordInspection", args, "same");
    expect(await desk.listInspections({ siteId: "S-102" })).toHaveLength(2);
  });

  it("refuses an incomplete checklist, naming what is missing", async () => {
    const result = await run(tools(fakeQualityDesk()), "recordInspection", {
      siteId: "S-101",
      visitDate: "2026-11-06",
      results: results().slice(1),
    });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("entry-glass");
    expect(details(result).code).toBe("invalid");
  });
});

describe("open_nonconformance", () => {
  it("hands a critical report to the safety officer and says who has it", async () => {
    const desk = fakeQualityDesk();
    const set = tools(desk);
    const args = {
      siteId: "S-102",
      source: "inspection",
      sourceRef: "INS-504",
      description: "Unlabelled bleach spray bottle on a low shelf in the toddler room",
      severity: "critical",
    };
    const result = await run(set, "openNonconformance", args, "hazard");
    const officer = personLabel(safetyOfficer(company));
    expect(text(result)).toContain("Opened NC-205");
    expect(text(result)).toContain(`Handed to ${officer}, the safety officer`);
    await run(set, "openNonconformance", args, "hazard");
    expect(await desk.listNonconformances({ siteId: "S-102" })).toHaveLength(1);
  });

  it("opens a minor report with no hand-off", async () => {
    const result = await run(tools(fakeQualityDesk()), "openNonconformance", {
      siteId: "S-101",
      source: "internal",
      itemId: "entry-glass",
      description: "Entry glass streaked",
      severity: "minor",
    });
    expect(text(result)).toContain("Opened NC-205");
    expect(text(result)).not.toContain("safety officer");
    expect(text(result)).toContain("Next: record_containment");
  });
});

describe("root cause and corrective action", () => {
  it("refuses a corrective action before a root cause, naming record_root_cause", async () => {
    const desk = fakeQualityDesk();
    const set = tools(desk);
    const refused = await run(set, "proposeCorrectiveAction", {
      reportId: "NC-203",
      action: "Retrain the crew on dusting",
      owner: "Crew lead",
      dueDate: "2026-11-20",
    });
    expect(isError(refused)).toBe(true);
    expect(details(refused).code).toBe("no_root_cause");
    expect(text(refused)).toContain(
      "Next: record the cause and its evidence with record_root_cause",
    );

    const cause = await run(set, "recordRootCause", {
      reportId: "NC-203",
      cause: "The site card has no dusting line for the shelves",
      evidence: "Site card read on 2026-11-06",
    });
    expect(text(cause)).toContain("Recorded the root cause of NC-203");
    const proposed = await run(
      set,
      "proposeCorrectiveAction",
      {
        reportId: "NC-203",
        action: "Add shelves to the site card",
        owner: "Crew lead",
        dueDate: "2026-11-20",
      },
      "again",
    );
    expect(text(proposed)).toContain("Proposed corrective action CA-303 on NC-203");
  });

  it("records containment once when replayed", async () => {
    const desk = fakeQualityDesk();
    const set = tools(desk);
    const args = { reportId: "NC-204", action: "Break room cleaned the next evening" };
    await run(set, "recordContainment", args, "same");
    const again = await run(set, "recordContainment", args, "same");
    expect(text(again)).toContain("Recorded containment on NC-204");
    const [report] = await desk.listNonconformances({ id: "NC-204" });
    expect(report?.containment).toHaveLength(1);
  });
});

describe("record_verification", () => {
  async function withAction() {
    const desk = fakeQualityDesk();
    const set = tools(desk);
    await run(set, "recordRootCause", { reportId: "NC-204", cause: "c", evidence: "e" }, "cause");
    await run(
      set,
      "proposeCorrectiveAction",
      { reportId: "NC-204", action: "Route fix", owner: "Crew lead", dueDate: "2026-11-12" },
      "action",
    );
    return { desk, set };
  }

  it("refuses a failed follow-up, says the action is reopened and what comes next", async () => {
    const { desk, set } = await withAction();
    await run(
      set,
      "recordInspection",
      { siteId: "S-103", visitDate: "2026-11-09", results: results(["carpets", "trash"]) },
      "follow-up",
    );
    const refused = await run(set, "recordVerification", {
      reportId: "NC-204",
      inspectionId: "INS-509",
    });
    expect(isError(refused)).toBe(true);
    expect(details(refused).code).toBe("verification_failed");
    expect(text(refused)).toContain("is reopened");
    expect(text(refused)).toContain("propose_corrective_action");
    const [report] = await desk.listNonconformances({ id: "NC-204" });
    expect(report?.correctiveAction?.status).toBe("reopened");
  });

  it("refuses another site's inspection", async () => {
    const { set } = await withAction();
    const refused = await run(set, "recordVerification", {
      reportId: "NC-204",
      inspectionId: "INS-501",
    });
    expect(details(refused).code).toBe("other_site");
  });

  it("records a passing follow-up and points to request_closure", async () => {
    const { set } = await withAction();
    await run(
      set,
      "recordInspection",
      { siteId: "S-103", visitDate: "2026-11-09", results: results() },
      "f",
    );
    const verified = await run(set, "recordVerification", {
      reportId: "NC-204",
      inspectionId: "INS-509",
    });
    expect(text(verified)).toContain("Verified NC-204 with INS-509");
    expect(text(verified)).toContain("Next: request_closure");
  });
});

describe("request_closure", () => {
  it("asks nobody about a report with no passing verification, pointing to record_verification", async () => {
    const set = tools(fakeQualityDesk());
    await expect(
      set.closureApprovalFacts({ reportId: "NC-203" }, HOOK_CONTEXT, CALL_IDENTITY),
    ).rejects.toThrow(/record_verification/);

    // A report with its cause and action recorded but no follow-up yet is refused the same way.
    await run(set, "recordRootCause", { reportId: "NC-204", cause: "c", evidence: "e" }, "cause");
    await run(
      set,
      "proposeCorrectiveAction",
      { reportId: "NC-204", action: "Route fix", owner: "Crew lead", dueDate: "2026-11-12" },
      "action",
    );
    await expect(
      set.closureApprovalFacts({ reportId: "NC-204" }, HOOK_CONTEXT, CALL_IDENTITY),
    ).rejects.toThrow(/no passing follow-up inspection recorded/);
  });

  it("asks nobody about a report a later failed inspection of its item overtook", async () => {
    const set = tools(fakeQualityDesk());
    await expect(
      set.closureApprovalFacts({ reportId: "NC-202" }, HOOK_CONTEXT, CALL_IDENTITY),
    ).rejects.toThrow(/INS-507.*latest inspection.*NC-204.*Nothing was put to a person/s);
  });

  it("shows the person the report as the desk holds it", async () => {
    const set = tools(fakeQualityDesk());
    const { summary } = await set.closureApprovalFacts(
      { reportId: "NC-201" },
      HOOK_CONTEXT,
      CALL_IDENTITY,
    );
    expect(summary).toContain("Close NC-201");
    expect(summary).toContain("Root cause:");
    expect(summary).toContain("Verified by INS-505");
  });

  it("closes nothing without approved facts, and closes the approved report once", async () => {
    const desk = fakeQualityDesk();
    const set = tools(desk);
    const bare = await run(set, "requestClosure", { reportId: "NC-201" }, "bare");
    expect(isError(bare)).toBe(true);
    expect(details(bare).code).toBe("not_approved");

    const { facts } = await set.closureApprovalFacts(
      { reportId: "NC-201" },
      HOOK_CONTEXT,
      CALL_IDENTITY,
    );
    const args = { reportId: "NC-201", [APPROVED_FACTS_ARG]: facts };
    const closed = await run(set, "requestClosure", args, "close");
    expect(text(closed)).toContain("Approved and closed: NC-201");
    const again = await run(set, "requestClosure", args, "close");
    expect(text(again)).toContain("Approved and closed: NC-201");
    const [report] = await desk.listNonconformances({ id: "NC-201" });
    expect(report?.status).toBe("closed");
  });
});

describe("reading", () => {
  it("quality_report gives the desk's figures, open reports and repeats", async () => {
    const result = await run(tools(fakeQualityDesk()), "qualityReport", {});
    expect(text(result)).toContain("8 inspections, 8 judged: 5 passed, 3 failed — pass rate 62.5%");
    expect(text(result)).toContain("Open reports (4)");
    expect(text(result)).toContain("Repeat non-conformances (1)");
    expect(text(result)).toContain("NC-202, NC-204");
  });

  it("list_inspections names the sites and each inspection's score", async () => {
    const result = await run(tools(fakeQualityDesk()), "listInspections", { siteId: "S-104" });
    expect(text(result)).toContain("INS-502");
    expect(text(result)).toContain("score 80");
    expect(text(result)).toContain("S-101");
  });

  it("list_nonconformances says what a report waits for", async () => {
    const result = await run(tools(fakeQualityDesk()), "listNonconformances", {
      reportId: "NC-203",
    });
    expect(text(result)).toContain("waiting for a root cause");
  });

  it("list_nonconformances and quality_report give an overtaken report as open, naming the failing inspection", async () => {
    const set = tools(fakeQualityDesk());
    const listed = text(await run(set, "listNonconformances", { reportId: "NC-202" }));
    expect(listed).toContain("open because corrective action CA-302 did not hold: INS-507");
    expect(listed).not.toContain("waiting for a person to approve closure");
    const summary = text(await run(set, "qualityReport", {}));
    expect(summary).toContain(
      "NC-202 — Sellwood Law Partners, SE 13th Avenue — minor — open because corrective action CA-302 did not hold: INS-507",
    );
    // NC-201 is verified with nothing after it, so it still waits for a person.
    expect(summary).toContain(
      "NC-201 — Burnside Property Group, W Burnside Street — major — verified; waiting for a person to approve closure",
    );
  });

  it("read_company states the owner, the checklist weights, the safety officer and the pass score in force", async () => {
    const result = await run(
      tools(fakeQualityDesk(), () => ({ inspection_pass_score: 90 })),
      "readCompany",
      {
        section: "quality",
      },
    );
    expect(text(result)).toContain(personLabel(qualityOwner(company)));
    expect(text(result)).toContain(personLabel(safetyOfficer(company)));
    expect(text(result)).toContain(personLabel(creditDecider(company)));
    expect(text(result)).toContain("An inspection passes at a score of 90 or more");
    expect(text(result)).toContain(
      "carpets — Floors: Carpets vacuumed, edges and corners included — weight 15",
    );
  });

  it("refuses to read or write with no desk bound", async () => {
    const set = tools(undefined);
    await expect(run(set, "listInspections", {})).rejects.toThrow("No quality desk is bound");
  });
});
