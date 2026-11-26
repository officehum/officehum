/**
 * One block per tool, against `fakeSafetyDesk` and the company facts generated into this package,
 * through the registrations the factory builds and with the durable call identity Pi Durable hands to
 * `execute`. Every unsafe tool is replayed under the same call id here and must write once. No
 * network, no model.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { APPROVED_FACTS_ARG, type ApprovalCallIdentity, type HookContext } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { loadCompanyFacts, safetyOfficer } from "./company.js";
import { fakeSafetyDesk, type SafetyDesk } from "./desk.js";
import { type SafetyToolset, safetyTools } from "./tools.js";

const company = loadCompanyFacts();
const officer = safetyOfficer(company);
const LIMITS = () => ({ fatality_report_hours: 8, severe_injury_report_hours: 24 });

const call = (callId: string) =>
  ({ conversationId: "conversation-1", taskId: "task-1", callId }) as never;
const HOOK_CONTEXT = {} as HookContext;
const CALL_IDENTITY: ApprovalCallIdentity = { conversationId: "conversation-1", taskId: "task-1" };

const tools = (
  desk: SafetyDesk | undefined,
  limits: () => Readonly<Record<string, number>> = LIMITS,
): SafetyToolset => safetyTools({ desk, company, limits });

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

async function run(
  set: SafetyToolset,
  name: keyof SafetyToolset,
  args: Record<string, unknown>,
  callId: string = name,
) {
  const tool = set[name] as { execute: (a: never, c: never, x: never) => Promise<unknown> };
  return (await tool.execute(args as never, call(callId), BACKGROUND_CONTEXT as never)) as {
    output?: readonly unknown[];
  };
}

const hospital = {
  type: "hospitalization",
  occurredOn: "2026-11-23",
  site: "Gateway Accounting, NE Halsey Street",
  description: "Fell from a step stool and was admitted to hospital",
  person: "Kofi Mensah",
  companyToldAt: "2026-11-23T08:30",
};

describe("list_training_status", () => {
  it("answers due and overdue from the desk, with names and courses only", async () => {
    const result = await run(tools(fakeSafetyDesk()), "listTrainingStatus", {
      state: "not-current",
    });
    const said = text(result);
    expect(said).toContain("Ben Hollis");
    expect(said).toContain("bloodborne-pathogens");
    expect(said).toContain("OVERDUE since 2026-10-15");
    expect(said).toContain("NEVER COMPLETED");
    expect(said).not.toContain("Ana Lucero");
    const [first] = details(result).workers as Record<string, unknown>[];
    expect(Object.keys(first ?? {}).sort()).toEqual(["courses", "crewId", "name", "workerId"]);
  });
});

describe("record_training_completion", () => {
  const args = {
    person: "Ben Hollis",
    courseId: "bloodborne-pathogens",
    completedOn: "2026-11-20",
    trainer: "Lena Park",
    contentSummary: "Exposure control plan and sharps",
  };

  it("records the trainer and content, states the next due date, and writes once on replay", async () => {
    const desk = fakeSafetyDesk();
    const set = tools(desk);
    const first = await run(set, "recordTrainingCompletion", args, "same");
    expect(text(first)).toContain("next due 2027-11-20");
    expect(text(first)).toContain("Lena Park");
    const again = await run(set, "recordTrainingCompletion", args, "same");
    expect(details(again).id).toBe(details(first).id);
  });

  it("refuses a future date with the desk's reason", async () => {
    const result = await run(tools(fakeSafetyDesk()), "recordTrainingCompletion", {
      ...args,
      completedOn: "2026-12-01",
    });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("after today");
  });
});

describe("clearance_check", () => {
  it("says no for expired training and points to the exception route, without asking", async () => {
    const result = await run(tools(fakeSafetyDesk()), "clearanceCheck", { person: "Ines Garza" });
    expect(text(result)).toContain("NOT CLEARED");
    expect(text(result)).toContain("lockout-tagout");
    expect(text(result)).toContain("request_training_exception");
    expect(details(result).cleared).toBe(false);
  });

  it("clears someone whose training is all current", async () => {
    const result = await run(tools(fakeSafetyDesk()), "clearanceCheck", { person: "Kofi Mensah" });
    expect(text(result)).toContain("CLEARED");
    expect(details(result).cleared).toBe(true);
  });
});

describe("request_training_exception", () => {
  const args = {
    person: "Ines Garza",
    courseId: "lockout-tagout",
    job: "Boiler shutdown at Burnside on 24 November",
    reason: "Refresher booked for 1 December",
  };

  it("puts the course's state as the desk holds it to the person", async () => {
    const facts = await tools(fakeSafetyDesk()).exceptionApprovalFacts(
      args,
      HOOK_CONTEXT,
      CALL_IDENTITY,
    );
    expect(facts.summary).toContain("Ines Garza");
    expect(facts.summary).toContain("overdue");
    expect(facts.summary).toContain("2026-11-02");
    expect(facts.summary).toContain("does not make the training current");
    expect(facts.facts).toMatchObject({ courseId: "lockout-tagout", state: "overdue" });
  });

  it("asks nobody for a course that is current or not required of the person", async () => {
    const set = tools(fakeSafetyDesk());
    await expect(
      set.exceptionApprovalFacts({ ...args, person: "Kofi Mensah" }, HOOK_CONTEXT, CALL_IDENTITY),
    ).rejects.toThrow("is current");
    await expect(
      set.exceptionApprovalFacts({ ...args, person: "Ana Lucero" }, HOOK_CONTEXT, CALL_IDENTITY),
    ).rejects.toThrow("not required");
  });

  it("records nothing without approved facts, and records exactly the approved ones once", async () => {
    const desk = fakeSafetyDesk();
    const set = tools(desk);
    const bare = await run(set, "requestTrainingException", args);
    expect(isError(bare)).toBe(true);
    expect(details(bare).code).toBe("not_approved");
    expect((await desk.clearanceCheck({ person: "Ines Garza" })).exceptions).toEqual([]);

    const { facts } = await set.exceptionApprovalFacts(args, HOOK_CONTEXT, CALL_IDENTITY);
    const approved = { ...args, [APPROVED_FACTS_ARG]: facts };
    const first = await run(set, "requestTrainingException", approved, "same");
    expect(text(first)).toContain("Approved");
    expect(text(first)).toContain("still not current");
    await run(set, "requestTrainingException", approved, "same");
    expect((await desk.clearanceCheck({ person: "Ines Garza" })).exceptions).toHaveLength(1);
  });
});

describe("log_incident", () => {
  it("states the deadline in the company's time and points to the regulator report", async () => {
    const result = await run(tools(fakeSafetyDesk()), "logIncident", hospital);
    const said = text(result);
    expect(said).toContain("Logged INC-406");
    expect(said).toContain("2026-11-23 08:30");
    expect(said).toContain("2026-11-24 08:30");
    expect(said).toContain("24 hours");
    expect(said).toContain("request_regulator_report");
    expect(said).toContain("Recordability: undecided");
    expect(said).toContain(officer?.name ?? "no officer");
  });

  it("reads the limit at every call", async () => {
    let hours = 24;
    const set = tools(fakeSafetyDesk(), () => ({
      fatality_report_hours: 8,
      severe_injury_report_hours: hours,
    }));
    expect(text(await run(set, "logIncident", hospital, "a"))).toContain("2026-11-24 08:30");
    hours = 12;
    expect(text(await run(set, "logIncident", hospital, "b"))).toContain("2026-11-23 20:30");
    const unset = tools(fakeSafetyDesk(), () => ({}));
    const said = text(await run(unset, "logIncident", hospital, "c"));
    expect(said).toContain("No reporting deadline is set");
    expect(said).toContain("request_regulator_report");
  });

  it("writes once on replay", async () => {
    const desk = fakeSafetyDesk();
    const set = tools(desk);
    await run(set, "logIncident", hospital, "same");
    await run(set, "logIncident", hospital, "same");
    expect(await desk.listIncidents({ type: "hospitalization" })).toHaveLength(2);
  });

  it("keeps a privacy case's name out of the receipt", async () => {
    const result = await run(tools(fakeSafetyDesk()), "logIncident", {
      type: "exposure-incident",
      occurredOn: "2026-11-23",
      site: "Hawthorne Family Dental",
      description: "A needle in a bin went through a glove",
      person: "Grace Liu",
    });
    expect(text(result)).toContain("privacy case");
    expect(text(result)).toContain("confidential medical evaluation");
    expect(JSON.stringify(result)).not.toContain("Grace");
  });

  it("refuses medical detail and says how to describe it instead", async () => {
    const result = await run(tools(fakeSafetyDesk()), "logIncident", {
      ...hospital,
      description: "Fell; diagnosis was a fractured wrist",
    });
    expect(isError(result)).toBe(true);
    expect(details(result).code).toBe("medical_detail");
    expect(text(result)).toContain("general kind of injury");
  });
});

describe("list_incidents", () => {
  it("withholds a privacy case's name and holds no medical detail", async () => {
    const result = await run(tools(fakeSafetyDesk()), "listIncidents", {});
    const said = text(result);
    expect(said).toContain("INC-403");
    expect(said).toContain("privacy case, name withheld");
    expect(JSON.stringify(result)).not.toContain("Grace");
    expect(said).toContain("Ben Hollis");
  });
});

describe("request_recordability_decision", () => {
  it("puts the incident to a person and refuses a near miss before anyone is asked", async () => {
    const set = tools(fakeSafetyDesk());
    const facts = await set.recordabilityApprovalFacts(
      { incidentId: "INC-402" },
      HOOK_CONTEXT,
      CALL_IDENTITY,
    );
    expect(facts.summary).toContain("INC-402");
    expect(facts.summary).toContain("recordable");
    await expect(
      set.recordabilityApprovalFacts({ incidentId: "INC-401" }, HOOK_CONTEXT, CALL_IDENTITY),
    ).rejects.toThrow("nothing to record");
    // The privacy case is decided on without its name.
    const privacy = await set.recordabilityApprovalFacts(
      { incidentId: "INC-403" },
      HOOK_CONTEXT,
      CALL_IDENTITY,
    );
    expect(JSON.stringify(privacy)).not.toContain("Grace");
  });

  it("records nothing without approved facts, and once with them", async () => {
    const desk = fakeSafetyDesk();
    const set = tools(desk);
    const bare = await run(set, "requestRecordabilityDecision", { incidentId: "INC-402" });
    expect(details(bare).code).toBe("not_approved");
    expect((await desk.listIncidents({ id: "INC-402" }))[0]?.recordability).toBe("undecided");
    const { facts } = await set.recordabilityApprovalFacts(
      { incidentId: "INC-402" },
      HOOK_CONTEXT,
      CALL_IDENTITY,
    );
    const args = { incidentId: "INC-402", [APPROVED_FACTS_ARG]: facts };
    expect(text(await run(set, "requestRecordabilityDecision", args, "same"))).toContain(
      "A person decided INC-402 is recordable",
    );
    expect(isError(await run(set, "requestRecordabilityDecision", args, "same"))).toBe(false);
  });
});

describe("request_regulator_report", () => {
  it("shows the person the deadline and contact, and says nothing is filed", async () => {
    const desk = fakeSafetyDesk();
    const set = tools(desk);
    const facts = await set.regulatorApprovalFacts(
      { incidentId: "INC-405" },
      HOOK_CONTEXT,
      CALL_IDENTITY,
    );
    expect(facts.summary).toContain("2026-11-24 07:55");
    expect(facts.summary).toContain(officer?.name ?? "no officer");
    expect(facts.summary).toContain(company.profile.phone);

    const bare = await run(set, "requestRegulatorReport", { incidentId: "INC-405" });
    expect(details(bare).code).toBe("not_approved");

    const args = { incidentId: "INC-405", [APPROVED_FACTS_ARG]: facts.facts };
    const first = await run(set, "requestRegulatorReport", args, "same");
    expect(text(first)).toContain("Nothing was sent to any regulator");
    expect(details(await run(set, "requestRegulatorReport", args, "same"))).toEqual(details(first));
    await expect(
      set.regulatorApprovalFacts({ incidentId: "INC-405" }, HOOK_CONTEXT, CALL_IDENTITY),
    ).rejects.toThrow("already");
  });
});

describe("get_safety_data_sheet", () => {
  it("answers from the sheet and says it is not a risk assessment", async () => {
    const result = await run(tools(fakeSafetyDesk()), "getSafetyDataSheet", {
      chemical: "disinfectant",
    });
    const said = text(result);
    expect(said).toContain("Danger");
    expect(said).toContain("bleach");
    expect(said).toContain("not a risk assessment");
    expect(said).toContain(officer?.name ?? "no officer");
  });

  it("refuses a chemical not on the catalog", async () => {
    const result = await run(tools(fakeSafetyDesk()), "getSafetyDataSheet", {
      chemical: "oven cleaner",
    });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("disinfectant");
  });
});

describe("schedule_toolbox_talk", () => {
  it("schedules a talk, says it is not training, and writes once", async () => {
    const desk = fakeSafetyDesk();
    const set = tools(desk);
    const before = await desk.trainingStatus({ crewId: "cleaning-south" });
    const args = { crewId: "cleaning-south", topic: "Ladder safety", date: "2026-11-26" };
    const first = await run(set, "scheduleToolboxTalk", args, "same");
    expect(text(first)).toContain("not recorded as anyone's training");
    expect(details(await run(set, "scheduleToolboxTalk", args, "same")).id).toBe(details(first).id);
    expect(await desk.trainingStatus({ crewId: "cleaning-south" })).toEqual(before);
  });
});

describe("read_company", () => {
  it("states the reporting deadlines the role enforces, from its limits", async () => {
    const said = text(
      await run(
        tools(undefined, () => ({ fatality_report_hours: 4, severe_injury_report_hours: 12 })),
        "readCompany",
        {
          section: "safety",
        },
      ),
    );
    expect(said).toContain("within 4 hours");
    expect(said).toContain("within 12 hours");
    expect(said).toContain("lockout-tagout");
    expect(said).toContain(officer?.name ?? "no officer");
  });
});

describe("with no desk bound", () => {
  it("refuses and says how to bind one", async () => {
    await expect(run(tools(undefined), "listIncidents", {})).rejects.toThrow(
      "No safety desk is bound",
    );
  });
});
