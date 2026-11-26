/**
 * The safety desk: training currency worked out from completion dates and each course's renewal
 * period against the desk's clock, reporting deadlines worked out from the time the company was told
 * and the limits the tool hands it, and the refusals that keep the records honest — no future
 * completion, no medical detail on an incident, no name on a privacy case, no recordability or
 * regulator decision without facts a person approved.
 */

import { describe, expect, it } from "vitest";
import { type CompanyFacts, loadCompanyFacts } from "./company.js";
import {
  DEMO_NOW,
  demoWorkers,
  exceptionFacts,
  fakeSafetyDesk,
  incidentFacts,
  type SafetyDesk,
  SafetyDeskError,
} from "./desk.js";

const company = loadCompanyFacts();
const LIMITS = { fatalityHours: 8, severeInjuryHours: 24 };
const at = (iso: string) => () => new Date(iso);

/** The refusal a call made, or a failure when it made none. */
async function refusalOf(call: Promise<unknown>): Promise<SafetyDeskError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof SafetyDeskError) return error;
    throw error;
  }
  throw new Error("expected the desk to refuse");
}

async function stateOf(desk: SafetyDesk, person: string, courseId: string) {
  const [worker] = await desk.trainingStatus({ person });
  return worker?.courses.find((course) => course.courseId === courseId);
}

describe("training status", () => {
  it("works out current, due soon, overdue and never from the dates and the renewal period", async () => {
    const desk = fakeSafetyDesk();
    expect(await stateOf(desk, "Ben Hollis", "bloodborne-pathogens")).toMatchObject({
      lastCompleted: "2025-10-15",
      dueOn: "2026-10-15",
      state: "overdue",
    });
    expect(await stateOf(desk, "Carla Mendes", "hazard-communication")).toMatchObject({
      dueOn: "2026-12-05",
      state: "due-soon",
    });
    expect(await stateOf(desk, "Hector Ruiz", "lone-worker")).toMatchObject({
      lastCompleted: null,
      dueOn: null,
      state: "never",
    });
    expect(await stateOf(desk, "Ines Garza", "lockout-tagout")).toMatchObject({
      state: "overdue",
    });
    expect(await stateOf(desk, "Kofi Mensah", "lockout-tagout")).toMatchObject({
      state: "current",
    });
    // A course for one crew is not required of another crew.
    expect(await stateOf(desk, "Ana Lucero", "lockout-tagout")).toBeUndefined();
  });

  it("reads the clock: the same record is overdue a day after its due date", async () => {
    expect(await stateOf(fakeSafetyDesk(), "Ana Lucero", "hazard-communication")).toMatchObject({
      dueOn: "2027-03-10",
      state: "current",
    });
    expect(
      await stateOf(
        fakeSafetyDesk({ now: at("2027-03-11T18:00:00.000Z") }),
        "Ana Lucero",
        "hazard-communication",
      ),
    ).toMatchObject({ state: "overdue" });
  });

  it("takes each course's renewal period from the company", async () => {
    const shorter: CompanyFacts = {
      ...company,
      safety: {
        ...company.safety,
        requiredTraining: company.safety.requiredTraining.map((course) =>
          course.id === "hazard-communication" ? { ...course, renewalMonths: 6 } : course,
        ),
      },
    };
    expect(
      await stateOf(fakeSafetyDesk({ company: shorter }), "Ana Lucero", "hazard-communication"),
    ).toMatchObject({ dueOn: "2026-09-10", state: "overdue" });
  });

  it("lists everyone with a course that is not current", async () => {
    const overdue = await fakeSafetyDesk().trainingStatus({ state: "not-current" });
    expect(overdue.map((worker) => worker.name).sort()).toEqual([
      "Ben Hollis",
      "Grace Liu",
      "Hector Ruiz",
      "Ines Garza",
    ]);
    for (const worker of overdue) {
      for (const course of worker.courses) expect(["overdue", "never"]).toContain(course.state);
    }
  });

  it("holds names, crews and courses only: nothing personal beyond them", async () => {
    const [worker] = await fakeSafetyDesk().trainingStatus({ person: "Ben Hollis" });
    expect(Object.keys(worker ?? {}).sort()).toEqual(["courses", "crewId", "name", "workerId"]);
  });

  it("refuses an unknown person and an ambiguous one", async () => {
    expect((await refusalOf(fakeSafetyDesk().trainingStatus({ person: "Zed Nobody" }))).code).toBe(
      "not_found",
    );
    const twins = [...demoWorkers(), { id: "W-09", name: "Ben Ortiz", crewId: "cleaning-south" }];
    expect(
      (await refusalOf(fakeSafetyDesk({ workers: twins }).trainingStatus({ person: "Ben" }))).code,
    ).toBe("ambiguous");
  });
});

describe("recording a training completion", () => {
  const good = {
    person: "Ben Hollis",
    courseId: "bloodborne-pathogens",
    completedOn: "2026-11-20",
    trainer: "Lena Park, certified BBP instructor",
    contentSummary:
      "Exposure control plan, universal precautions, sharps, what to do after an exposure",
  };

  it("records the date, trainer and content, and the course is current again", async () => {
    const desk = fakeSafetyDesk();
    const receipt = await desk.recordTrainingCompletion(good, { requestId: "r1" });
    expect(receipt).toMatchObject({
      name: "Ben Hollis",
      courseId: "bloodborne-pathogens",
      completedOn: "2026-11-20",
      dueOn: "2027-11-20",
      trainer: good.trainer,
      contentSummary: good.contentSummary,
    });
    expect(await stateOf(desk, "Ben Hollis", "bloodborne-pathogens")).toMatchObject({
      state: "current",
      dueOn: "2027-11-20",
    });
  });

  it("writes once when the same call is replayed", async () => {
    const desk = fakeSafetyDesk();
    const first = await desk.recordTrainingCompletion(good, { requestId: "same" });
    const again = await desk.recordTrainingCompletion(good, { requestId: "same" });
    expect(again).toEqual(first);
    const next = await desk.recordTrainingCompletion(good, { requestId: "other" });
    expect(next.id).not.toBe(first.id);
  });

  it("refuses a future date, an unknown course, and an empty trainer or summary, all at once", async () => {
    const refused = await refusalOf(
      fakeSafetyDesk().recordTrainingCompletion(
        {
          ...good,
          courseId: "forklift",
          completedOn: "2026-11-24",
          trainer: " ",
          contentSummary: "",
        },
        { requestId: "bad" },
      ),
    );
    expect(refused.code).toBe("invalid");
    expect(refused.message).toContain('"forklift" is not a course the company requires');
    expect(refused.message).toContain("after today (2026-11-23)");
    expect(refused.message).toContain("trainer");
    expect(refused.message).toContain("summary");
  });

  it("refuses a course that does not apply to the person's crew, and a date that is not one", async () => {
    const desk = fakeSafetyDesk();
    expect(
      (
        await refusalOf(
          desk.recordTrainingCompletion(
            { ...good, person: "Ana Lucero", courseId: "lockout-tagout" },
            { requestId: "crew" },
          ),
        )
      ).code,
    ).toBe("invalid");
    expect(
      (
        await refusalOf(
          desk.recordTrainingCompletion({ ...good, completedOn: "20 Nov" }, { requestId: "date" }),
        )
      ).message,
    ).toContain("YYYY-MM-DD");
  });
});

describe("clearance", () => {
  it("clears a person only when every course the work needs is current", async () => {
    const desk = fakeSafetyDesk();
    const ines = await desk.clearanceCheck({ person: "Ines Garza" });
    expect(ines.cleared).toBe(false);
    expect(ines.notCurrent.map((course) => course.courseId)).toEqual(["lockout-tagout"]);
    expect((await desk.clearanceCheck({ person: "Kofi Mensah" })).cleared).toBe(true);
    expect((await desk.clearanceCheck({ person: "Ana Lucero" })).cleared).toBe(true);
    // Sent on another crew's work, she needs that crew's course too.
    const sent = await desk.clearanceCheck({ person: "Ana Lucero", work: "maintenance" });
    expect(sent.cleared).toBe(false);
    expect(sent.notCurrent).toMatchObject([{ courseId: "lockout-tagout", state: "never" }]);
  });

  it("refuses work that is not a crew", async () => {
    expect(
      (await refusalOf(fakeSafetyDesk().clearanceCheck({ person: "Ana Lucero", work: "roofing" })))
        .code,
    ).toBe("not_found");
  });
});

describe("training exceptions", () => {
  const job = "Boiler shutdown at Burnside Property Group on 24 November";
  const reason = "The refresher is booked for 1 December";

  async function facts(desk: SafetyDesk) {
    const [worker] = await desk.trainingStatus({ person: "Ines Garza" });
    const course = worker?.courses.find((entry) => entry.courseId === "lockout-tagout");
    if (worker === undefined || course === undefined) throw new Error("no demo record");
    return exceptionFacts(worker, course, job, reason);
  }

  it("records exactly the approved exception, once, and clearance shows it but still says no", async () => {
    const desk = fakeSafetyDesk();
    const approved = await facts(desk);
    const first = await desk.recordTrainingException({ approved }, { requestId: "ex" });
    expect(first).toMatchObject({ name: "Ines Garza", courseId: "lockout-tagout", job, reason });
    expect(await desk.recordTrainingException({ approved }, { requestId: "ex" })).toEqual(first);
    const clearance = await desk.clearanceCheck({ person: "Ines Garza" });
    expect(clearance.cleared).toBe(false);
    expect(clearance.exceptions.map((entry) => entry.id)).toEqual([first.id]);
  });

  it("refuses when the training changed after the person approved", async () => {
    const desk = fakeSafetyDesk();
    const approved = await facts(desk);
    await desk.recordTrainingCompletion(
      {
        person: "Ines Garza",
        courseId: "lockout-tagout",
        completedOn: "2026-11-22",
        trainer: "Site trainer",
        contentSummary: "Energy isolation and lock application",
      },
      { requestId: "done" },
    );
    expect(
      (await refusalOf(desk.recordTrainingException({ approved }, { requestId: "late" }))).code,
    ).toBe("facts_changed");
  });
});

describe("logging an incident", () => {
  const base = {
    occurredOn: "2026-11-23",
    site: "Gateway Accounting, NE Halsey Street",
    description: "Fell from a step stool while dusting a high shelf and was admitted to hospital",
  };

  it("states the reporting deadline from when the company was told, by the limit handed in", async () => {
    const desk = fakeSafetyDesk();
    const severe = await desk.logIncident(
      { ...base, type: "hospitalization", companyToldAt: "2026-11-23T07:55" },
      { requestId: "h", limits: LIMITS },
    );
    expect(severe).toMatchObject({
      serious: true,
      companyToldAt: "2026-11-23T15:55:00.000Z",
      deadlineHours: 24,
      reportDeadline: "2026-11-24T15:55:00.000Z",
      recordability: "undecided",
      regulatorReport: null,
    });
    expect(severe.handedTo?.name).toBe(
      company.people.find((p) => p.id === company.safety.officerId)?.name,
    );

    const fatal = await desk.logIncident(
      { ...base, type: "fatality", description: "A worker died after a fall" },
      { requestId: "f", limits: LIMITS },
    );
    // Told now, at the desk's clock.
    expect(fatal).toMatchObject({
      companyToldAt: DEMO_NOW,
      deadlineHours: 8,
      reportDeadline: "2026-11-24T01:00:00.000Z",
    });

    const other = await desk.logIncident(
      { ...base, type: "amputation", description: "Lost a fingertip in a door" },
      { requestId: "a", limits: { fatalityHours: 8, severeInjuryHours: 12 } },
    );
    expect(other).toMatchObject({ deadlineHours: 12, reportDeadline: "2026-11-24T05:00:00.000Z" });

    const unset = await desk.logIncident(
      { ...base, type: "loss-of-eye", description: "Eye struck by a splash" },
      { requestId: "u", limits: {} },
    );
    expect(unset).toMatchObject({ serious: true, deadlineHours: null, reportDeadline: null });
  });

  it("gives an ordinary incident no deadline and an undecided recordability; a near miss has none", async () => {
    const desk = fakeSafetyDesk();
    const cut = await desk.logIncident(
      { ...base, type: "injury", description: "Cut to the hand", person: "Ben Hollis" },
      { requestId: "c", limits: LIMITS },
    );
    expect(cut).toMatchObject({
      serious: false,
      reportDeadline: null,
      person: "Ben Hollis",
      recordability: "undecided",
      handedTo: null,
    });
    const near = await desk.logIncident(
      {
        ...base,
        type: "near-miss",
        description: "A visitor slipped on a wet floor but did not fall",
      },
      { requestId: "n", limits: LIMITS },
    );
    expect(near.recordability).toBe("not-applicable");
  });

  it("refuses an unknown type, a future date, a future report time and medical detail", async () => {
    const desk = fakeSafetyDesk();
    const unknown = await refusalOf(
      desk.logIncident({ ...base, type: "burglary" }, { requestId: "x1", limits: LIMITS }),
    );
    expect(unknown.code).toBe("invalid");
    expect(unknown.message).toContain("exposure-incident");
    expect(unknown.message).toContain("hospitalization");

    expect(
      (
        await refusalOf(
          desk.logIncident(
            { ...base, type: "injury", occurredOn: "2026-11-24" },
            { requestId: "x2", limits: LIMITS },
          ),
        )
      ).message,
    ).toContain("after today");
    expect(
      (
        await refusalOf(
          desk.logIncident(
            { ...base, type: "injury", companyToldAt: "2026-11-23T11:00" },
            { requestId: "x3", limits: LIMITS },
          ),
        )
      ).message,
    ).toContain("has not happened yet");

    for (const detail of [
      "Cut to the hand; the doctor's diagnosis was a torn tendon",
      "Back strain, prescribed painkillers",
      "Needlestick; awaiting blood test results",
      "Exposure; worried about hepatitis",
    ]) {
      const refused = await refusalOf(
        desk.logIncident(
          { ...base, type: "injury", description: detail },
          { requestId: detail, limits: LIMITS },
        ),
      );
      expect(refused.code, detail).toBe("medical_detail");
    }
  });

  it("keeps an exposure incident's name off every receipt and list, and out of its description", async () => {
    const desk = fakeSafetyDesk();
    const logged = await desk.logIncident(
      {
        ...base,
        type: "exposure-incident",
        description: "A needle in a restroom bin went through a glove while emptying it",
        person: "Grace Liu",
      },
      { requestId: "e", limits: LIMITS },
    );
    expect(logged).toMatchObject({ privacyCase: true, person: null });
    expect(logged.handedTo).not.toBeNull();
    const all = await desk.listIncidents({});
    expect(JSON.stringify(all)).not.toContain("Grace");
    expect(JSON.stringify(logged)).not.toContain("Grace");

    const named = await refusalOf(
      desk.logIncident(
        {
          ...base,
          type: "exposure-incident",
          description: "Grace was stuck by a needle in a bin",
          person: "Grace Liu",
        },
        { requestId: "e2", limits: LIMITS },
      ),
    );
    expect(named.code).toBe("invalid");
    expect(named.message).toContain("privacy case");
  });

  it("writes once when the same call is replayed", async () => {
    const desk = fakeSafetyDesk();
    const args = { ...base, type: "injury", description: "Cut to the hand" };
    const first = await desk.logIncident(args, { requestId: "same", limits: LIMITS });
    expect(await desk.logIncident(args, { requestId: "same", limits: LIMITS })).toEqual(first);
    expect((await desk.listIncidents({})).filter((entry) => entry.id === first.id)).toHaveLength(1);
  });
});

describe("decisions a person makes on an incident", () => {
  async function incident(desk: SafetyDesk, id: string) {
    const [found] = await desk.listIncidents({ id });
    if (found === undefined) throw new Error(`no ${id}`);
    return found;
  }

  it("records a recordability decision only with the approved facts, once", async () => {
    const desk = fakeSafetyDesk();
    const approved = incidentFacts(await incident(desk, "INC-402"));
    const decided = await desk.recordRecordability(
      { incidentId: "INC-402", approved },
      { requestId: "rec" },
    );
    expect(decided.recordability).toBe("recordable");
    expect(
      await desk.recordRecordability({ incidentId: "INC-402", approved }, { requestId: "rec" }),
    ).toEqual(decided);
    expect(
      (
        await refusalOf(
          desk.recordRecordability({ incidentId: "INC-402", approved }, { requestId: "again" }),
        )
      ).code,
    ).toBe("already_decided");
  });

  it("refuses a recordability decision on a near miss, and facts that are not the incident's", async () => {
    const desk = fakeSafetyDesk();
    const near = incidentFacts(await incident(desk, "INC-401"));
    expect(
      (
        await refusalOf(
          desk.recordRecordability({ incidentId: "INC-401", approved: near }, { requestId: "n" }),
        )
      ).code,
    ).toBe("not_applicable");
    const forged = { ...incidentFacts(await incident(desk, "INC-402")), type: "near-miss" };
    expect(
      (
        await refusalOf(
          desk.recordRecordability({ incidentId: "INC-402", approved: forged }, { requestId: "f" }),
        )
      ).code,
    ).toBe("facts_changed");
  });

  it("records an approved regulator report and files it nowhere, once", async () => {
    const desk = fakeSafetyDesk();
    const approved = incidentFacts(await incident(desk, "INC-405"));
    const reported = await desk.recordRegulatorReport(
      { incidentId: "INC-405", approved },
      { requestId: "rr" },
    );
    expect(reported.regulatorReport).toMatchObject({ submittedTo: null, approvedOn: "2026-11-23" });
    expect(
      await desk.recordRegulatorReport({ incidentId: "INC-405", approved }, { requestId: "rr" }),
    ).toEqual(reported);
    expect(
      (
        await refusalOf(
          desk.recordRegulatorReport({ incidentId: "INC-405", approved }, { requestId: "twice" }),
        )
      ).code,
    ).toBe("already_reported");
  });
});

describe("safety data sheets", () => {
  it("answers from the sheet for a catalog chemical, by id or by name", async () => {
    const desk = fakeSafetyDesk();
    const byId = await desk.safetyDataSheet("disinfectant");
    expect(byId.chemicalId).toBe("disinfectant");
    expect(byId.incompatible).toContain("bleach");
    expect((await desk.safetyDataSheet("Glass cleaner")).chemicalId).toBe("glass-cleaner");
  });

  it("refuses a chemical not on the catalog, and a catalog item it holds no sheet for", async () => {
    const desk = fakeSafetyDesk();
    expect((await refusalOf(desk.safetyDataSheet("drain opener"))).code).toBe("not_found");
    expect((await refusalOf(desk.safetyDataSheet("trash-liners"))).code).toBe("no_sheet");
  });

  it("holds a sheet only for items on the company's supply catalog", async () => {
    const ids = new Set(company.supplyCatalog.map((item) => item.id));
    for (const id of ["neutral-cleaner", "disinfectant", "glass-cleaner", "floor-finish"]) {
      expect(ids.has(id), id).toBe(true);
      expect((await fakeSafetyDesk().safetyDataSheet(id)).chemicalId).toBe(id);
    }
  });
});

describe("toolbox talks", () => {
  it("schedules a talk and records no training completion", async () => {
    const desk = fakeSafetyDesk();
    const before = await desk.trainingStatus({});
    const talk = await desk.scheduleToolboxTalk(
      { crewId: "cleaning-south", topic: "Ladder safety", date: "2026-11-26" },
      { requestId: "t" },
    );
    expect(talk).toMatchObject({
      crewId: "cleaning-south",
      date: "2026-11-26",
      topic: "Ladder safety",
    });
    expect(
      await desk.scheduleToolboxTalk(
        { crewId: "cleaning-south", topic: "Ladder safety", date: "2026-11-26" },
        { requestId: "t" },
      ),
    ).toEqual(talk);
    expect(await desk.trainingStatus({})).toEqual(before);
  });

  it("refuses a past date and a crew the company does not have", async () => {
    const desk = fakeSafetyDesk();
    expect(
      (
        await refusalOf(
          desk.scheduleToolboxTalk(
            { crewId: "cleaning-south", topic: "Ladders", date: "2026-11-20" },
            { requestId: "p" },
          ),
        )
      ).message,
    ).toContain("before today");
    expect(
      (
        await refusalOf(
          desk.scheduleToolboxTalk(
            { crewId: "night-crew", topic: "Ladders", date: "2026-11-26" },
            { requestId: "c" },
          ),
        )
      ).code,
    ).toBe("not_found");
  });
});
