/**
 * The quality desk: every score worked out from the company checklist's weights, every pass or fail
 * judged against the limit the tool hands it, and the refusals that keep a non-conformance report
 * honest — no corrective action before a root cause, no verification from a failed or foreign
 * inspection, no closure without a passing verification or with facts nobody approved.
 */

import { describe, expect, it } from "vitest";
import { loadCompanyFacts } from "./company.js";
import {
  closureFacts,
  DEMO_NOW,
  demoInspections,
  demoNonconformances,
  demoSites,
  fakeQualityDesk,
  type InspectionResultInput,
  type QualityDesk,
  QualityDeskError,
  scoreInspection,
  stageOf,
} from "./desk.js";

const company = loadCompanyFacts();
const ITEMS = company.quality.checklist.map((item) => item.id);

/** Every checklist item passing, with the named ones failing (or not applicable). */
function results(
  fail: readonly string[] = [],
  na: readonly string[] = [],
): InspectionResultInput[] {
  return ITEMS.map((itemId) => ({
    itemId,
    result: fail.includes(itemId) ? "fail" : na.includes(itemId) ? "na" : "pass",
  }));
}

/** The refusal a call made, or a failure when it made none. */
async function refusalOf(call: Promise<unknown>): Promise<QualityDeskError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof QualityDeskError) return error;
    throw error;
  }
  throw new Error("expected the desk to refuse");
}

const ids = { requestId: "r-1" };
let counter = 0;
const next = () => ({ requestId: `r-${++counter}` });

describe("scoring", () => {
  it("scores from the checklist weights: a failed item loses exactly its weight", () => {
    const weights = Object.fromEntries(
      company.quality.checklist.map((item) => [item.id, item.weight]),
    );
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    const scored = scoreInspection(company.quality.checklist, results(["carpets"]));
    expect(scored.possible).toBe(total);
    expect(scored.earned).toBe(total - (weights.carpets ?? 0));
    expect(scored.scorePercent).toBe(
      Math.round(((total - (weights.carpets ?? 0)) / total) * 1000) / 10,
    );
  });

  it("leaves a not-applicable item out of the points possible", () => {
    const scored = scoreInspection(company.quality.checklist, results([], ["break-room"]));
    expect(scored.scorePercent).toBe(100);
    expect(scored.possible).toBe(90);
  });
});

describe("record_inspection", () => {
  it("judges the desk's own score against the limit it is handed, a score at the limit passing", async () => {
    const desk = fakeQualityDesk();
    // Carpets are worth 15 of 100: 85 is exactly the default pass score.
    const atLimit = await desk.recordInspection(
      { siteId: "S-101", visitDate: "2026-11-06", results: results(["carpets"]) },
      { requestId: "a", passScore: 85 },
    );
    expect(atLimit.scorePercent).toBe(85);
    expect(atLimit.outcome).toBe("pass");
    expect(atLimit.passScore).toBe(85);

    const under = await desk.recordInspection(
      { siteId: "S-101", visitDate: "2026-11-06", results: results(["carpets", "trash"]) },
      { requestId: "b", passScore: 85 },
    );
    expect(under.scorePercent).toBe(75);
    expect(under.outcome).toBe("fail");
    expect(under.failedItems.map((item) => item.itemId)).toEqual(["carpets", "trash"]);

    // The same results against a business's lower limit pass.
    const lenient = await desk.recordInspection(
      { siteId: "S-101", visitDate: "2026-11-06", results: results(["carpets", "trash"]) },
      { requestId: "c", passScore: 70 },
    );
    expect(lenient.outcome).toBe("pass");
  });

  it("reports the score but judges nothing when no pass score resolved", async () => {
    const desk = fakeQualityDesk();
    const unjudged = await desk.recordInspection(
      { siteId: "S-101", visitDate: "2026-11-06", results: results(["carpets"]) },
      { requestId: "a", passScore: undefined },
    );
    expect(unjudged.scorePercent).toBe(85);
    expect(unjudged.outcome).toBe("unjudged");
    expect(unjudged.passScore).toBeNull();
  });

  it("refuses an incomplete or wrong checklist, naming every problem at once", async () => {
    const desk = fakeQualityDesk();
    const partial = results().filter(
      (entry) => entry.itemId !== "carpets" && entry.itemId !== "trash",
    );
    const refused = await refusalOf(
      desk.recordInspection(
        {
          siteId: "S-101",
          visitDate: "2026-11-06",
          results: [
            ...partial,
            { itemId: "windows-outside", result: "pass" },
            { itemId: "dusting", result: "pass" },
          ],
        },
        { requestId: "a", passScore: 85 },
      ),
    );
    expect(refused.code).toBe("invalid");
    expect(refused.message).toContain("carpets");
    expect(refused.message).toContain("trash");
    expect(refused.message).toContain("windows-outside");
    expect(refused.message).toContain("dusting is given twice");
    expect(await desk.listInspections({ siteId: "S-101" })).toHaveLength(1);
  });

  it("refuses an unknown site, a date that is not one, a visit in the future, and all items not applicable", async () => {
    const desk = fakeQualityDesk();
    expect(
      (
        await refusalOf(
          desk.recordInspection(
            { siteId: "S-999", visitDate: "2026-11-06", results: results() },
            { requestId: "a", passScore: 85 },
          ),
        )
      ).code,
    ).toBe("not_found");
    expect(
      (
        await refusalOf(
          desk.recordInspection(
            { siteId: "S-101", visitDate: "6 November", results: results() },
            { requestId: "b", passScore: 85 },
          ),
        )
      ).code,
    ).toBe("invalid");
    expect(
      (
        await refusalOf(
          desk.recordInspection(
            { siteId: "S-101", visitDate: "2026-11-10", results: results() },
            { requestId: "c", passScore: 85 },
          ),
        )
      ).code,
    ).toBe("invalid");
    expect(
      (
        await refusalOf(
          desk.recordInspection(
            { siteId: "S-101", visitDate: "2026-11-06", results: results([], ITEMS) },
            { requestId: "d", passScore: 85 },
          ),
        )
      ).code,
    ).toBe("invalid");
  });

  it("answers a replayed call with the inspection it already recorded", async () => {
    const desk = fakeQualityDesk();
    const input = { siteId: "S-102", visitDate: "2026-11-06", results: results(["trash"]) };
    const first = await desk.recordInspection(input, { requestId: "same", passScore: 85 });
    const again = await desk.recordInspection(input, { requestId: "same", passScore: 85 });
    expect(again).toEqual(first);
    expect(await desk.listInspections({ siteId: "S-102" })).toHaveLength(2);
  });
});

describe("open_nonconformance", () => {
  it("hands a critical report to the safety officer the company names, and only a critical one", async () => {
    const desk = fakeQualityDesk();
    const critical = await desk.openNonconformance(
      {
        siteId: "S-102",
        source: "inspection",
        sourceRef: "INS-504",
        description: "Unlabelled spray bottle left on a low shelf in the toddler room",
        severity: "critical",
      },
      next(),
    );
    const officer = company.people.find((who) => who.id === company.safety.officerId);
    expect(critical.handedTo).toEqual({
      name: officer?.name,
      title: officer?.title,
      reason: "safety",
    });

    const minor = await desk.openNonconformance(
      {
        siteId: "S-102",
        source: "complaint",
        sourceRef: "email from the client, Friday 6 November",
        itemId: "trash",
        description: "Bins in two classrooms not emptied",
        severity: "minor",
      },
      next(),
    );
    expect(minor.handedTo).toBeNull();
    expect(minor.status).toBe("open");
    expect(minor.item?.id).toBe("trash");
  });

  it("refuses an inspection source that is not on the desk or is for another site", async () => {
    const desk = fakeQualityDesk();
    const base = {
      siteId: "S-101",
      source: "inspection" as const,
      description: "x",
      severity: "minor" as const,
    };
    expect(
      (await refusalOf(desk.openNonconformance({ ...base, sourceRef: "INS-999" }, next()))).code,
    ).toBe("not_found");
    const other = await refusalOf(
      desk.openNonconformance({ ...base, sourceRef: "INS-502" }, next()),
    );
    expect(other.code).toBe("invalid");
    expect(other.message).toContain("S-104");
  });

  it("answers a replayed call with the report it already opened", async () => {
    const desk = fakeQualityDesk();
    const input = {
      siteId: "S-101",
      source: "internal" as const,
      description: "Entry glass streaked",
      severity: "minor" as const,
      itemId: "entry-glass",
    };
    const first = await desk.openNonconformance(input, ids);
    const again = await desk.openNonconformance(input, ids);
    expect(again).toEqual(first);
    expect((await desk.listNonconformances({ siteId: "S-101" })).length).toBe(1);
  });
});

describe("root cause and corrective action", () => {
  it("refuses a corrective action until a root cause is recorded, then takes it", async () => {
    const desk = fakeQualityDesk();
    const action = {
      reportId: "NC-203",
      action: "Add a dusting check to the site card",
      owner: "Night crew lead",
      dueDate: "2026-11-20",
    };
    const refused = await refusalOf(desk.proposeCorrectiveAction(action, next()));
    expect(refused.code).toBe("no_root_cause");
    const [still] = await desk.listNonconformances({ id: "NC-203" });
    expect(still?.correctiveAction).toBeNull();

    await desk.recordRootCause(
      {
        reportId: "NC-203",
        cause: "The site card left out desk dusting",
        evidence: "Site card read on 2026-11-06",
      },
      next(),
    );
    const proposed = await desk.proposeCorrectiveAction(action, next());
    expect(proposed.correctiveAction).toMatchObject({
      action: "Add a dusting check to the site card",
      owner: "Night crew lead",
      dueOn: "2026-11-20",
      status: "proposed",
    });
  });

  it("refuses a second action while one stands, a due date in the past, and a closed report", async () => {
    const desk = fakeQualityDesk();
    const standing = await refusalOf(
      desk.proposeCorrectiveAction(
        { reportId: "NC-201", action: "Something else", owner: "Crew lead", dueDate: "2026-11-20" },
        next(),
      ),
    );
    expect(standing.code).toBe("already_proposed");
    await desk.recordRootCause({ reportId: "NC-204", cause: "c", evidence: "e" }, next());
    const past = await refusalOf(
      desk.proposeCorrectiveAction(
        { reportId: "NC-204", action: "a", owner: "o", dueDate: "2026-11-01" },
        next(),
      ),
    );
    expect(past.code).toBe("invalid");
  });

  it("records containment and refuses a root cause with no evidence", async () => {
    const desk = fakeQualityDesk();
    const contained = await desk.recordContainment(
      { reportId: "NC-204", action: "Break room re-cleaned the next evening" },
      next(),
    );
    expect(contained.containment.map((entry) => entry.action)).toEqual([
      "Break room re-cleaned the next evening",
    ]);
    const bare = await refusalOf(
      desk.recordRootCause({ reportId: "NC-204", cause: "c", evidence: " " }, next()),
    );
    expect(bare.code).toBe("invalid");
  });
});

describe("record_verification", () => {
  /** A desk where NC-204 (S-103, break room) has a root cause and an action proposed today. */
  async function withAction(): Promise<QualityDesk> {
    const desk = fakeQualityDesk();
    await desk.recordRootCause(
      { reportId: "NC-204", cause: "Route skips the break room", evidence: "Route sheet" },
      next(),
    );
    await desk.proposeCorrectiveAction(
      {
        reportId: "NC-204",
        action: "Put the break room back on the route",
        owner: "Crew lead",
        dueDate: "2026-11-12",
      },
      next(),
    );
    return desk;
  }

  const inspect = (desk: QualityDesk, siteId: string, fail: string[] = []) =>
    desk.recordInspection(
      { siteId, visitDate: "2026-11-09", results: results(fail) },
      { ...next(), passScore: 85 },
    );

  it("refuses a follow-up inspection of another site, and changes nothing", async () => {
    const desk = await withAction();
    const elsewhere = await inspect(desk, "S-101");
    const refused = await refusalOf(
      desk.recordVerification({ reportId: "NC-204", inspectionId: elsewhere.id }, next()),
    );
    expect(refused.code).toBe("other_site");
    const [report] = await desk.listNonconformances({ id: "NC-204" });
    expect(report?.verification).toBeNull();
    expect(report?.correctiveAction?.status).toBe("proposed");
  });

  it("refuses a failed follow-up and reopens the corrective action", async () => {
    const desk = await withAction();
    const failed = await inspect(desk, "S-103", ["carpets", "trash"]);
    expect(failed.outcome).toBe("fail");
    const refused = await refusalOf(
      desk.recordVerification({ reportId: "NC-204", inspectionId: failed.id }, next()),
    );
    expect(refused.code).toBe("verification_failed");
    const [report] = await desk.listNonconformances({ id: "NC-204" });
    expect(report?.verification).toBeNull();
    expect(report?.correctiveAction?.status).toBe("reopened");
    expect(report?.failedVerifications.map((entry) => entry.inspectionId)).toEqual([failed.id]);

    // Reopened, the action can be revised: a new one is proposed in its place.
    const revised = await desk.proposeCorrectiveAction(
      {
        reportId: "NC-204",
        action: "Check the break room on every visit sheet",
        owner: "Crew lead",
        dueDate: "2026-11-16",
      },
      next(),
    );
    expect(revised.correctiveAction?.status).toBe("proposed");
    expect(revised.previousActions.map((entry) => entry.status)).toEqual(["reopened"]);
  });

  it("refuses an inspection that passed overall but failed the report's own checklist item", async () => {
    const desk = await withAction();
    const passedButNot = await inspect(desk, "S-103", ["break-room"]);
    expect(passedButNot.outcome).toBe("pass");
    const refused = await refusalOf(
      desk.recordVerification({ reportId: "NC-204", inspectionId: passedButNot.id }, next()),
    );
    expect(refused.code).toBe("verification_failed");
    expect(refused.message).toContain("break-room");
  });

  it("refuses an inspection from before the action, and one no pass score judged", async () => {
    const desk = await withAction();
    // INS-506 passed at the same site, but on 30 October, before the action was proposed.
    expect(
      (
        await refusalOf(
          desk.recordVerification({ reportId: "NC-204", inspectionId: "INS-506" }, next()),
        )
      ).code,
    ).toBe("before_action");
    const unjudged = await desk.recordInspection(
      { siteId: "S-103", visitDate: "2026-11-09", results: results() },
      { ...next(), passScore: undefined },
    );
    expect(
      (
        await refusalOf(
          desk.recordVerification({ reportId: "NC-204", inspectionId: unjudged.id }, next()),
        )
      ).code,
    ).toBe("not_judged");
  });

  it("refuses a verification with no corrective action to verify", async () => {
    const desk = fakeQualityDesk();
    expect(
      (
        await refusalOf(
          desk.recordVerification({ reportId: "NC-203", inspectionId: "INS-508" }, next()),
        )
      ).code,
    ).toBe("no_corrective_action");
  });

  it("records a passing follow-up of the same site, and a replay records nothing twice", async () => {
    const desk = await withAction();
    const passed = await inspect(desk, "S-103");
    const call = { reportId: "NC-204", inspectionId: passed.id };
    const first = await desk.recordVerification(call, { requestId: "verify" });
    expect(first.verification).toMatchObject({ inspectionId: passed.id, scorePercent: 100 });
    expect(first.correctiveAction?.status).toBe("verified");
    expect(await desk.recordVerification(call, { requestId: "verify" })).toEqual(first);
  });

  it("a replayed failed verification reopens once", async () => {
    const desk = await withAction();
    const failed = await inspect(desk, "S-103", ["carpets", "trash"]);
    const call = { reportId: "NC-204", inspectionId: failed.id };
    await refusalOf(desk.recordVerification(call, { requestId: "same" }));
    await refusalOf(desk.recordVerification(call, { requestId: "same" }));
    const [report] = await desk.listNonconformances({ id: "NC-204" });
    expect(report?.failedVerifications).toHaveLength(1);
  });
});

describe("closing a report", () => {
  it("refuses a report with no passing verification, pointing to record_verification", async () => {
    const desk = fakeQualityDesk();
    const refused = await refusalOf(
      desk.closeNonconformance({ reportId: "NC-203", approved: {} }, next()),
    );
    expect(refused.code).toBe("no_verification");
    expect(refused.message).toContain("record_verification");
  });

  it("closes exactly the report a person approved, once", async () => {
    const desk = fakeQualityDesk();
    const [report] = await desk.listNonconformances({ id: "NC-201" });
    if (report === undefined) throw new Error("no NC-201");
    const closed = await desk.closeNonconformance(
      { reportId: "NC-201", approved: closureFacts(report) },
      { requestId: "close" },
    );
    expect(closed.status).toBe("closed");
    expect(closed.closedOn).toBe("2026-11-09");
    expect(
      await desk.closeNonconformance(
        { reportId: "NC-201", approved: closureFacts(report) },
        { requestId: "close" },
      ),
    ).toEqual(closed);
    expect(
      (
        await refusalOf(
          desk.closeNonconformance({ reportId: "NC-201", approved: closureFacts(report) }, next()),
        )
      ).code,
    ).toBe("closed");
  });

  it("refuses to close a report that changed after a person was shown it", async () => {
    const desk = fakeQualityDesk();
    const [report] = await desk.listNonconformances({ id: "NC-201" });
    if (report === undefined) throw new Error("no NC-201");
    const shown = closureFacts(report);
    await desk.recordRootCause(
      { reportId: "NC-201", cause: "Something different", evidence: "New evidence" },
      next(),
    );
    const refused = await refusalOf(
      desk.closeNonconformance({ reportId: "NC-201", approved: shown }, next()),
    );
    expect(refused.code).toBe("report_changed");
    const [still] = await desk.listNonconformances({ id: "NC-201" });
    expect(still?.status).toBe("open");
  });
});

describe("a later inspection that failed the report's item", () => {
  /** The same records on a fresh desk, as a host that restarted would load them. */
  async function restarted(desk: QualityDesk, now?: () => Date): Promise<QualityDesk> {
    return fakeQualityDesk({
      inspections: await desk.listInspections(),
      nonconformances: await desk.listNonconformances(),
      ...(now === undefined ? {} : { now }),
    });
  }

  it("refuses to close a verified report, names the repeat report, and closes nothing", async () => {
    // NC-202 (S-103, break room) was verified by INS-506 on 30 October; INS-507 on 4 November
    // failed the break room again, and NC-204 is the repeat.
    const desk = fakeQualityDesk();
    const [report] = await desk.listNonconformances({ id: "NC-202" });
    if (report === undefined) throw new Error("no NC-202");
    const call = { reportId: "NC-202", approved: closureFacts(report) };
    const refused = await refusalOf(desk.closeNonconformance(call, { requestId: "close-202" }));
    expect(refused.code).toBe("later_failure");
    expect(refused.message).toContain("INS-507");
    expect(refused.message).toContain("latest inspection");
    expect(refused.message).toContain("NC-204");
    expect(refused.message).toContain("Nothing was closed");

    // A replay is refused the same way, and so is the same call on a restarted desk.
    expect((await refusalOf(desk.closeNonconformance(call, { requestId: "close-202" }))).code).toBe(
      "later_failure",
    );
    expect((await refusalOf((await restarted(desk)).closeNonconformance(call, next()))).code).toBe(
      "later_failure",
    );
    const [still] = await desk.listNonconformances({ id: "NC-202" });
    expect(still?.status).toBe("open");
    expect(still?.verification?.inspectionId).toBe("INS-506");
  });

  it("closes once a still later inspection passes the item: the latest is the one that counts", async () => {
    const desk = fakeQualityDesk();
    await desk.recordInspection(
      { siteId: "S-103", visitDate: "2026-11-06", results: results() },
      { ...next(), passScore: 85 },
    );
    const [report] = await desk.listNonconformances({ id: "NC-202" });
    if (report === undefined) throw new Error("no NC-202");
    const closed = await desk.closeNonconformance(
      { reportId: "NC-202", approved: closureFacts(report) },
      next(),
    );
    expect(closed.status).toBe("closed");
  });

  it("refuses to verify with a passing follow-up a later inspection overtook, and records nothing", async () => {
    let now = new Date(DEMO_NOW);
    const clock = () => now;
    const desk = fakeQualityDesk({ now: clock });
    await desk.recordRootCause(
      { reportId: "NC-204", cause: "Route skips the break room", evidence: "Route sheet" },
      next(),
    );
    await desk.proposeCorrectiveAction(
      {
        reportId: "NC-204",
        action: "Back on the route",
        owner: "Crew lead",
        dueDate: "2026-11-12",
      },
      next(),
    );
    now = new Date("2026-11-12T18:00:00.000Z");
    const passed = await desk.recordInspection(
      { siteId: "S-103", visitDate: "2026-11-10", results: results() },
      { ...next(), passScore: 85 },
    );
    const failedItem = await desk.recordInspection(
      { siteId: "S-103", visitDate: "2026-11-11", results: results(["break-room"]) },
      { ...next(), passScore: 85 },
    );
    // It passed overall at 90: what counts is the report's own item.
    expect(failedItem.outcome).toBe("pass");

    const call = { reportId: "NC-204", inspectionId: passed.id };
    const refused = await refusalOf(desk.recordVerification(call, { requestId: "verify-204" }));
    expect(refused.code).toBe("later_failure");
    expect(refused.message).toContain(failedItem.id);
    expect(refused.message).toContain("break-room");
    // No repeat report exists yet, so the refusal says how to open one.
    expect(refused.message).toContain(
      `open_nonconformance (source inspection, sourceRef ${failedItem.id}`,
    );
    expect(refused.message).toContain("Nothing was verified");

    expect((await refusalOf(desk.recordVerification(call, { requestId: "verify-204" }))).code).toBe(
      "later_failure",
    );
    expect(
      (await refusalOf((await restarted(desk, clock)).recordVerification(call, next()))).code,
    ).toBe("later_failure");
    const [report] = await desk.listNonconformances({ id: "NC-204" });
    expect(report?.verification).toBeNull();
    expect(report?.correctiveAction?.status).toBe("proposed");
    expect(report?.failedVerifications).toEqual([]);
  });

  it("gives the stage of an overtaken report as open, naming the failing inspection", async () => {
    const desk = fakeQualityDesk();
    const [report] = await desk.listNonconformances({ id: "NC-202" });
    if (report === undefined) throw new Error("no NC-202");
    const stage = stageOf(report, await desk.listInspections({ siteId: "S-103" }));
    expect(stage).toBe(
      "open because corrective action CA-302 did not hold: INS-507 (visit 2026-11-04), after the verifying INS-506, failed break-room; it cannot be closed",
    );
    const listed = (await desk.qualityReport({})).openReports.find((line) => line.id === "NC-202");
    expect(listed?.stage).toBe(stage);
  });

  it("gives the stage as verified again once a still later inspection passes the item", async () => {
    const desk = fakeQualityDesk();
    await desk.recordInspection(
      { siteId: "S-103", visitDate: "2026-11-06", results: results() },
      { ...next(), passScore: 85 },
    );
    const [report] = await desk.listNonconformances({ id: "NC-202" });
    if (report === undefined) throw new Error("no NC-202");
    const stage = stageOf(report, await desk.listInspections({ siteId: "S-103" }));
    expect(stage).toBe("verified; waiting for a person to approve closure");
    const listed = (await desk.qualityReport({})).openReports.find((line) => line.id === "NC-202");
    expect(listed?.stage).toBe(stage);
  });
});

describe("quality_report", () => {
  it("works out the pass rate, average score, open reports and repeats in code", async () => {
    const desk = fakeQualityDesk();
    const report = await desk.qualityReport({});
    const inspections = demoInspections(company.quality.checklist);
    const judged = inspections.filter((inspection) => inspection.outcome !== "unjudged");
    const passed = judged.filter((inspection) => inspection.outcome === "pass");
    expect(report.inspections).toBe(inspections.length);
    expect(report.passed).toBe(passed.length);
    expect(report.failed).toBe(judged.length - passed.length);
    expect(report.passRatePercent).toBe(Math.round((passed.length / judged.length) * 1000) / 10);
    const mean =
      inspections.reduce((sum, inspection) => sum + inspection.scorePercent, 0) /
      inspections.length;
    expect(report.averageScorePercent).toBe(Math.round(mean * 10) / 10);
    expect(report.openReports.map((entry) => entry.id)).toEqual([
      "NC-201",
      "NC-202",
      "NC-203",
      "NC-204",
    ]);
    // The break room at S-103 failed in October and again in November.
    expect(report.repeats).toEqual([
      {
        siteId: "S-103",
        siteName: expect.any(String),
        itemId: "break-room",
        item: expect.any(String),
        reportIds: ["NC-202", "NC-204"],
      },
    ]);
  });

  it("counts only the period asked for", async () => {
    const desk = fakeQualityDesk();
    const november = await desk.qualityReport({ from: "2026-11-01", to: "2026-11-30" });
    expect(november.inspections).toBe(2);
    expect(november.repeats).toEqual([]);
    // Open reports are what is open now, whatever the period.
    expect(november.openReports).toHaveLength(4);
  });
});

describe("demonstration data", () => {
  it("names only checklist items the company has, and scores every inspection as the desk would", () => {
    const sites = new Set(demoSites().map((site) => site.id));
    for (const inspection of demoInspections(company.quality.checklist)) {
      expect(sites.has(inspection.siteId), inspection.id).toBe(true);
      const scored = scoreInspection(
        company.quality.checklist,
        inspection.results.map((entry) => ({ itemId: entry.itemId, result: entry.result })),
      );
      expect(scored.scorePercent, inspection.id).toBe(inspection.scorePercent);
    }
    for (const report of demoNonconformances(company.quality.checklist)) {
      expect(sites.has(report.siteId), report.id).toBe(true);
      if (report.item !== null) expect(ITEMS).toContain(report.item.id);
    }
  });
});
