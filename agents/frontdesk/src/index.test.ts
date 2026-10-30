import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import {
  type AgentManifest,
  checkAgent,
  checkFourLayers,
  conditionsHold,
  formatReport,
  runEvals,
  validatePackage,
} from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { piDurableRunner } from "../../../packages/office/src/evals/pi-durable-runner.js";
import { openLocalCalendar } from "../../../packages/office/src/local-calendar.js";
import {
  type ScriptedScript,
  scriptedProvider,
} from "../../../packages/office/src/testing/scripted-model.js";
import manifest from "../officehum.json" with { type: "json" };
import frontdesk, { ContactsDoc } from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const tempCalendar = () => {
  const directory = mkdtempSync(join(tmpdir(), "officehum-frontdesk-"));
  temps.push(directory);
  return openLocalCalendar(join(directory, "calendar.sqlite"));
};

async function attemptBooking(approve?: () => Promise<{ approved: boolean }>) {
  const calendar = tempCalendar();
  const role = frontdesk({ calendar, ...(approve === undefined ? {} : { approve }) });
  const faux = fauxProvider({ provider: "frontdesk-test", models: [{ id: "model" }] });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("book_appointment", {
        start: "2030-01-15T09:00:00Z",
        customer: "Demo Guest",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Finished"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  for (const extension of role.extensions) registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { ...role.agent, model: { provider: "frontdesk-test", modelId: "model" } },
  });
  const submission = await root.submit({ type: "input", content: "Book it" }, BACKGROUND_CONTEXT);
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  if (settled.status === "done" && settled.type === "input") {
    await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
  }
  await harness.close(BACKGROUND_CONTEXT);
  return calendar;
}

async function attemptLifecycle(
  name: "list_bookings" | "reschedule_appointment" | "cancel_appointment",
  args:
    | Record<string, string>
    | ((bookings: { first: { id: string }; second: { id: string } }) => Record<string, string>),
  approve?: () => Promise<{ approved: boolean }>,
) {
  const calendar = tempCalendar();
  const first = await calendar.book("2030-01-15T10:00:00Z", "Same Name", "seed-1");
  const second = await calendar.book("2030-01-15T09:00:00Z", "Same Name", "seed-2");
  const callArgs = typeof args === "function" ? args({ first, second }) : args;
  const role = frontdesk({ calendar, ...(approve === undefined ? {} : { approve }) });
  const faux = fauxProvider({ provider: "frontdesk-lifecycle-test", models: [{ id: "model" }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(name, callArgs), { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  for (const extension of role.extensions) registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { ...role.agent, model: { provider: "frontdesk-lifecycle-test", modelId: "model" } },
  });
  const submission = await root.submit({ type: "input", content: "Manage it" }, BACKGROUND_CONTEXT);
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  const view = await root.context(BACKGROUND_CONTEXT);
  const toolResult = [...view.messages].reverse().find((message) => message.role === "toolResult");
  await harness.close(BACKGROUND_CONTEXT);
  return { calendar, first, second, settled, toolResult };
}

/** Book through the real Harness with an optional discount, recording every approval the desk asks for. */
async function attemptDiscountBooking(
  discountPercent: number | undefined,
  decide: (approvalId: string) => boolean,
) {
  const approvals: string[] = [];
  const calendar = tempCalendar();
  const role = frontdesk({
    calendar,
    approve: async (request) => {
      approvals.push(request.approvalId);
      return { approved: decide(request.approvalId) };
    },
  });
  const faux = fauxProvider({ provider: "frontdesk-discount-test", models: [{ id: "model" }] });
  const args = {
    start: "2030-01-15T09:00:00Z",
    customer: "Demo Guest",
    ...(discountPercent === undefined ? {} : { discountPercent }),
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("book_appointment", args), { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  for (const extension of role.extensions) registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { ...role.agent, model: { provider: "frontdesk-discount-test", modelId: "model" } },
  });
  const submission = await root.submit({ type: "input", content: "Book it" }, BACKGROUND_CONTEXT);
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  if (settled.status === "done" && settled.type === "input") {
    await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
  }
  await harness.close(BACKGROUND_CONTEXT);
  return { calendar, approvals };
}

describe("frontdesk role", () => {
  it("defaults the portable role to Paper with maximum thinking", () => {
    const calendar = tempCalendar();
    expect(frontdesk({ calendar }).agent).toMatchObject({
      model: { provider: "paper", modelId: "ultramarine-1-flash" },
      thinkingLevel: "max",
    });
    calendar.close();
  });

  it("persists the Paper model and thinking level through a bare Harness reopen", async () => {
    const calendar = tempCalendar();
    const role = frontdesk({ calendar });
    const provider = fauxProvider({ provider: "paper", models: [{ id: "ultramarine-1-flash" }] });
    const models = createModels();
    models.setProvider(provider.provider);
    const directory = mkdtempSync(join(tmpdir(), "officehum-frontdesk-harness-"));
    temps.push(directory);
    const registry = createRegistry();
    for (const extension of role.extensions) registry.install(extension);
    const storage = await openNodeJsonlStorage(join(directory, "harness"), BACKGROUND_CONTEXT);
    const first = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
    const created = await first.root(BACKGROUND_CONTEXT, { agent: role.agent });
    expect(await created.agent(BACKGROUND_CONTEXT)).toMatchObject({
      model: { provider: "paper", modelId: "ultramarine-1-flash" },
      thinkingLevel: "max",
    });
    await first.close(BACKGROUND_CONTEXT);
    const reopenedStorage = await openNodeJsonlStorage(
      join(directory, "harness"),
      BACKGROUND_CONTEXT,
    );
    const reopened = await Harness.open(reopenedStorage, { models, registry }, BACKGROUND_CONTEXT);
    const recovered = await reopened.root(BACKGROUND_CONTEXT, { agent: role.agent });
    expect(await recovered.agent(BACKGROUND_CONTEXT)).toMatchObject({
      model: { provider: "paper", modelId: "ultramarine-1-flash" },
      thinkingLevel: "max",
    });
    await reopened.close(BACKGROUND_CONTEXT);
    calendar.close();
  });

  it("is a valid portable package and role", async () => {
    const packageDirectory = new URL("..", import.meta.url);
    expect((await validatePackage(packageDirectory.pathname)).ok).toBe(true);
    const calendar = tempCalendar();
    expect((await checkAgent(frontdesk({ calendar }), manifest)).ok).toBe(true);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies).not.toHaveProperty("@officehum/office");
    expect(pkg.dependencies).not.toHaveProperty("@officehum/cli");
    calendar.close();
  });

  it("does not book without an approver", async () => {
    const calendar = await attemptBooking();
    expect(calendar.bookings()).toEqual([]);
    calendar.close();
  });

  it("does not book when approval is declined", async () => {
    const calendar = await attemptBooking(async () => ({ approved: false }));
    expect(calendar.bookings()).toEqual([]);
    calendar.close();
  });

  it("creates an approved contact and links an approved booking through the actual Harness", async () => {
    const calendar = tempCalendar();
    const approvals: string[] = [];
    const role = frontdesk({
      calendar,
      approve: async (request) => {
        approvals.push(request.approvalId);
        return { approved: true };
      },
    });
    const faux = fauxProvider({ provider: "frontdesk-contact-test", models: [{ id: "model" }] });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("create_contact", {
          name: "Guest",
          email: "GUEST@example.com",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("book_appointment", {
          start: "2030-01-15T09:00:00Z",
          customer: "Guest",
          contactId: "contact-1",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Finished"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    for (const extension of role.extensions) registry.install(extension);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      BACKGROUND_CONTEXT,
    );
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { ...role.agent, model: { provider: "frontdesk-contact-test", modelId: "model" } },
    });

    const submission = await root.submit(
      { type: "input", content: "Create Guest and book the 09:00 slot" },
      BACKGROUND_CONTEXT,
    );
    expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    const bookings = calendar.bookings();
    expect(bookings).toHaveLength(1);
    expect(await harness.snapshot(ContactsDoc, BACKGROUND_CONTEXT)).toMatchObject({
      contacts: [
        {
          id: "contact-1",
          name: "Guest",
          email: "guest@example.com",
          revision: 1,
          bookingIds: [bookings[0]?.id],
        },
      ],
      bookingLinks: [
        {
          contactId: "contact-1",
          bookingId: bookings[0]?.id,
        },
      ],
    });
    expect(approvals).toEqual(["confirm_contact_creation", "confirm_booking"]);
    await harness.close(BACKGROUND_CONTEXT);
    calendar.close();
  });

  it("keeps contact state unchanged when actual Harness approvals are missing or denied", async () => {
    const missingCalendar = tempCalendar();
    const missingRole = frontdesk({ calendar: missingCalendar });
    const missingFaux = fauxProvider({
      provider: "contact-missing-approval",
      models: [{ id: "model" }],
    });
    missingFaux.setResponses([
      fauxAssistantMessage(fauxToolCall("create_contact", { name: "Blocked Guest" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Creation was blocked."),
    ]);
    const missingModels = createModels();
    missingModels.setProvider(missingFaux.provider);
    const missingRegistry = createRegistry();
    for (const extension of missingRole.extensions) missingRegistry.install(extension);
    const missingHarness = await Harness.open(
      new MemoryStorage(),
      { models: missingModels, registry: missingRegistry },
      BACKGROUND_CONTEXT,
    );
    const missingRoot = await missingHarness.root(BACKGROUND_CONTEXT, {
      agent: {
        ...missingRole.agent,
        model: { provider: "contact-missing-approval", modelId: "model" },
      },
    });
    const missingSubmission = await missingRoot.submit(
      { type: "input", content: "Create Blocked Guest" },
      BACKGROUND_CONTEXT,
    );
    await missingSubmission.wait(BACKGROUND_CONTEXT);
    expect(await missingHarness.snapshot(ContactsDoc, BACKGROUND_CONTEXT)).toBeUndefined();
    await missingHarness.close(BACKGROUND_CONTEXT);
    missingCalendar.close();

    const deniedCalendar = tempCalendar();
    const decisions: string[] = [];
    const deniedRole = frontdesk({
      calendar: deniedCalendar,
      approve: async (request) => {
        decisions.push(request.approvalId);
        return { approved: request.approvalId === "confirm_contact_creation" };
      },
    });
    const deniedFaux = fauxProvider({
      provider: "contact-denied-update",
      models: [{ id: "model" }],
    });
    deniedFaux.setResponses([
      fauxAssistantMessage(fauxToolCall("create_contact", { name: "Original Guest" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("update_contact", {
          id: "contact-1",
          expectedRevision: 1,
          name: "Denied Correction",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Update was blocked."),
    ]);
    const deniedModels = createModels();
    deniedModels.setProvider(deniedFaux.provider);
    const deniedRegistry = createRegistry();
    for (const extension of deniedRole.extensions) deniedRegistry.install(extension);
    const deniedHarness = await Harness.open(
      new MemoryStorage(),
      { models: deniedModels, registry: deniedRegistry },
      BACKGROUND_CONTEXT,
    );
    const deniedRoot = await deniedHarness.root(BACKGROUND_CONTEXT, {
      agent: {
        ...deniedRole.agent,
        model: { provider: "contact-denied-update", modelId: "model" },
      },
    });
    const deniedSubmission = await deniedRoot.submit(
      { type: "input", content: "Create then update a guest" },
      BACKGROUND_CONTEXT,
    );
    await deniedSubmission.wait(BACKGROUND_CONTEXT);
    expect(await deniedHarness.snapshot(ContactsDoc, BACKGROUND_CONTEXT)).toMatchObject({
      contacts: [{ name: "Original Guest", revision: 1 }],
      operations: [{ kind: "create" }],
    });
    expect(decisions).toEqual(["confirm_contact_creation", "confirm_contact_update"]);
    await deniedHarness.close(BACKGROUND_CONTEXT);
    deniedCalendar.close();

    for (const scenario of [
      { kind: "create" as const, approval: "denied" as const },
      { kind: "update" as const, approval: "missing" as const },
    ]) {
      const calendar = tempCalendar();
      const role = frontdesk({
        calendar,
        ...(scenario.approval === "denied" ? { approve: async () => ({ approved: false }) } : {}),
      });
      const provider = `contact-${scenario.kind}-${scenario.approval}`;
      const faux = fauxProvider({ provider, models: [{ id: "model" }] });
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall(
            `${scenario.kind}_contact`,
            scenario.kind === "create"
              ? { name: "Denied Guest" }
              : { id: "contact-1", expectedRevision: 1, name: "Missing Approval" },
          ),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Blocked."),
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      const registry = createRegistry();
      for (const extension of role.extensions) registry.install(extension);
      const harness = await Harness.open(
        new MemoryStorage(),
        { models, registry },
        BACKGROUND_CONTEXT,
      );
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: { ...role.agent, model: { provider, modelId: "model" } },
      });
      if (scenario.kind === "update") {
        const seed = role.extensions
          .flatMap((extension) => extension.tools ?? [])
          .find((tool) => tool.name === "create_contact");
        if (seed === undefined) throw new Error("missing create_contact tool");
        await seed.execute(
          { name: "Seed Guest" },
          {
            conversationId: 90,
            taskId: 90,
            callId: "seed",
            commit: harness.commit.bind(harness),
            snapshot: harness.snapshot.bind(harness),
          } as never,
          BACKGROUND_CONTEXT,
        );
      }
      const before = await harness.snapshot(ContactsDoc, BACKGROUND_CONTEXT);
      const submission = await root.submit(
        { type: "input", content: "Attempt blocked contact write" },
        BACKGROUND_CONTEXT,
      );
      await submission.wait(BACKGROUND_CONTEXT);
      expect(await harness.snapshot(ContactsDoc, BACKGROUND_CONTEXT)).toEqual(before);
      await harness.close(BACKGROUND_CONTEXT);
      calendar.close();
    }
  });

  it("lists active bookings in start/id order with readable IDs and structured details", async () => {
    const attempt = await attemptLifecycle("list_bookings", {});
    expect(attempt.settled.status).toBe("done");
    expect(attempt.toolResult?.content).toEqual([
      {
        type: "text",
        text: `Bookings:\n${attempt.second.id} — 2030-01-15T09:00:00Z — Same Name\n${attempt.first.id} — 2030-01-15T10:00:00Z — Same Name`,
      },
    ]);
    expect(attempt.toolResult).toMatchObject({
      details: { bookings: [attempt.second, attempt.first] },
    });
    attempt.calendar.close();
  });

  it("returns output, not content, so the SDK tool-result guard passes on Front Desk", async () => {
    const calendar = tempCalendar();
    await calendar.book("2030-01-15T09:00:00Z", "Guest", "seed");
    const role = frontdesk({ calendar });
    const tools = role.extensions.flatMap((extension) => extension.tools ?? []);
    const list = tools.find((tool) => tool.name === "list_bookings");
    if (list === undefined) throw new Error("missing list_bookings");
    // `defineRole` wraps every tool; a result still using `content` would throw through the guard.
    const result = await list.execute({}, {
      conversationId: 1,
      taskId: 1,
      callId: "call",
    } as never);
    expect(result).not.toHaveProperty("content");
    expect(result.output?.[0]).toMatchObject({ type: "text" });
    calendar.close();
  });

  it.each([
    ["reschedule_appointment", undefined],
    ["reschedule_appointment", async () => ({ approved: false })],
    ["cancel_appointment", undefined],
    ["cancel_appointment", async () => ({ approved: false })],
  ] as const)(
    "blocks %s with zero effects when approval is absent or denied",
    async (name, approve) => {
      const attempt = await attemptLifecycle(
        name,
        ({ first }) =>
          name === "reschedule_appointment"
            ? { id: first.id, start: "2030-01-15T11:00:00Z" }
            : { id: first.id },
        approve,
      );
      expect(await attempt.calendar.listBookings()).toEqual([attempt.second, attempt.first]);
      attempt.calendar.close();
    },
  );

  it("moves and cancels approved appointments using the durable call identity", async () => {
    const moved = await attemptLifecycle(
      "reschedule_appointment",
      ({ first }) => ({ id: first.id, start: "2030-01-15T11:00:00Z" }),
      async () => ({ approved: true }),
    );
    expect(await moved.calendar.listBookings()).toEqual([
      moved.second,
      { ...moved.first, start: "2030-01-15T11:00:00Z" },
    ]);
    moved.calendar.close();

    const canceled = await attemptLifecycle(
      "cancel_appointment",
      ({ first }) => ({ id: first.id }),
      async () => ({ approved: true }),
    );
    expect(await canceled.calendar.listBookings()).toEqual([canceled.second]);
    canceled.calendar.close();

    const calendar = tempCalendar();
    const original = await calendar.book("2030-01-15T09:00:00Z", "Guest", "seed");
    const role = frontdesk({ calendar, approve: async () => ({ approved: true }) });
    const registrations = role.extensions.flatMap((extension) => extension.tools ?? []);
    const reschedule = registrations.find((tool) => tool.name === "reschedule_appointment");
    const cancel = registrations.find((tool) => tool.name === "cancel_appointment");
    if (reschedule === undefined || cancel === undefined)
      throw new Error("lifecycle tools missing");
    const api = { conversationId: 7, taskId: 8, callId: "call" };
    const movedResult = await reschedule.execute(
      { id: original.id, start: "2030-01-15T10:00:00.000Z" },
      api as never,
    );
    expect(movedResult).toMatchObject({
      details: { id: original.id, start: "2030-01-15T10:00:00Z", customer: "Guest" },
    });
    expect(calendar.operation("7:8:call")).toMatchObject({ kind: "reschedule" });
    const canceledResult = await cancel.execute({ id: original.id }, {
      conversationId: 7,
      taskId: 9,
      callId: "cancel",
    } as never);
    expect(canceledResult).toMatchObject({
      output: [{ type: "text", text: `Canceled ${original.id}` }],
      details: { id: original.id, status: "canceled", alreadyCanceled: false },
    });
    expect(calendar.operation("7:9:cancel")).toMatchObject({ kind: "cancel" });
    calendar.close();
  });
});

describe("frontdesk discount gate", () => {
  const environment = (limits: Readonly<Record<string, number>>) => ({ read: {}, limits }) as never;

  it("reads the discount rate from the manifest's named limit", () => {
    const calendar = tempCalendar();
    expect(frontdesk({ calendar }).current().limits).toEqual({ booking_discount_percent: 0 });
    calendar.close();
  });

  it("lets an overlay change the discount rate without touching the package", () => {
    const calendar = tempCalendar();
    const overlay = mkdtempSync(join(tmpdir(), "officehum-frontdesk-limit-"));
    temps.push(overlay);
    writeFileSync(
      join(overlay, "settings.json"),
      JSON.stringify({ limits: { booking_discount_percent: 15 } }),
    );
    expect(frontdesk({ calendar, overlays: [overlay] }).current().limits).toEqual({
      booking_discount_percent: 15,
    });
    calendar.close();
  });

  it("declares the inbound reply approval, and leaves raising it to the reply tool", () => {
    const declared = (manifest as AgentManifest).approvals.find(
      (approval) => approval.id === "confirm_inbound_reply",
    );
    // Visible: this is what puts it on the agent card and in the Inbox list.
    expect(declared?.tool).toBe("reply_message");
    expect(declared?.description).toMatch(/authenticated inbound sender/);
    // Not gated by the manifest: the tool raises this approval with the destination the receipt
    // authenticated, and the host binds one decision per call, so a second ask would be refused.
    expect(declared?.when).toBeUndefined();
  });

  it("declares the discount gate as data: present, and above the resolved limit", () => {
    const declared = (manifest as AgentManifest).approvals.find(
      (approval) => approval.id === "discount_booking",
    )?.when;
    expect(declared).toEqual([
      { arg: "discountPercent", op: "present" },
      { arg: "discountPercent", op: "gt", value: { limit: "booking_discount_percent" } },
    ]);

    const when = declared ?? [];
    // No discount at all: "present" is false, so nothing waits. This is the case a bare comparison used
    // to gate on every call, which is why the gate is data now instead of a hand-written condition.
    expect(conditionsHold(when, {}, { booking_discount_percent: 0 })).toBe(false);
    expect(conditionsHold(when, { discountPercent: 0 }, { booking_discount_percent: 0 })).toBe(
      false,
    );
    expect(conditionsHold(when, { discountPercent: 20 }, { booking_discount_percent: 0 })).toBe(
      true,
    );
    expect(conditionsHold(when, { discountPercent: 20 }, { booking_discount_percent: 25 })).toBe(
      false,
    );
    expect(conditionsHold(when, { discountPercent: 30 }, { booking_discount_percent: 25 })).toBe(
      true,
    );
    // A limit that did not resolve still waits for a person rather than passing silently.
    expect(conditionsHold(when, { discountPercent: 20 }, {})).toBe(true);
  });

  it("waits for a person when a booking carries a discount over the limit", async () => {
    const attempt = await attemptDiscountBooking(20, () => true);
    expect(attempt.approvals).toEqual(["confirm_booking", "discount_booking"]);
    expect(attempt.calendar.bookings()).toHaveLength(1);
    attempt.calendar.close();
  });

  it("does not book a discounted appointment when the discount is declined", async () => {
    const attempt = await attemptDiscountBooking(20, (id) => id !== "discount_booking");
    expect(attempt.approvals).toEqual(["confirm_booking", "discount_booking"]);
    expect(attempt.calendar.bookings()).toEqual([]);
    attempt.calendar.close();
  });

  it("never asks the discount gate for a booking without a discount", async () => {
    const attempt = await attemptDiscountBooking(undefined, () => true);
    expect(attempt.approvals).toEqual(["confirm_booking"]);
    expect(attempt.calendar.bookings()).toHaveLength(1);
    attempt.calendar.close();
  });
});

/**
 * The turns `--model scripted` plays back, read from the checked-in script file beside `evals/`.
 * That is the same file `officehum eval --model scripted` reads by default, so the turns for a
 * scenario live in one place.
 */
const scriptFile = fileURLToPath(new URL("../evals.smoke.json", import.meta.url));
const scriptedTurns = JSON.parse(readFileSync(scriptFile, "utf8")) as Readonly<
  Record<string, ScriptedScript>
>;

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
/** The JSON import's inferred type is widened; the checks want the SDK's manifest type. */
const roleManifest = manifest as unknown as AgentManifest;

describe("frontdesk brief contract (RASF-3129)", () => {
  it("validates strictly as a package under agents/, with each brief scenario against the manifest", async () => {
    const validated = await validatePackage(packageDirectory);
    expect(validated.issues).toEqual([]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const scenarioIds = Object.values(validated.value.suites).flatMap((suite) =>
      suite.scenarios.map((scenario) => scenario.id),
    );
    expect(scenarioIds).toEqual([
      "books-requested-free-slot",
      "refuses-taken-slot-offers-alternatives",
      "discount-request-waits-for-approval",
      "injected-instruction-cancels-nothing",
      "first-outreach-waits-for-approval",
      // Not one of the brief's six situations either: it pins the caution a booking request with a
      // reachable-at-nothing customer must show — check the diary, ask for an email or phone, book
      // nothing — so a later prompt change cannot quietly delete it.
      "asks-for-contact-details-when-missing",
      "billing-question-handed-off",
      // Not one of the brief's six situations: it restores coverage the old booking.json had for a
      // day with no slots at all, where the desk must not offer or promise anything.
      "no-slots-that-day",
    ]);

    const calendar = tempCalendar();
    const agent = await checkAgent(frontdesk({ calendar }), roleManifest);
    expect(agent.ok).toBe(true);
    expect(agent.issues).toEqual([]);
    calendar.close();

    // One source of truth: the test reads the file `officehum eval --model scripted` reads, and it
    // must hold turns for exactly these scenarios — a new scenario with no script fails here, and
    // a stale id in the file fails here, rather than the scenario being skipped.
    expect(Object.keys(scriptedTurns).sort()).toEqual([...scenarioIds].sort());
  });

  it("declares the discount rate as a named limit gated by its own approval", () => {
    expect(roleManifest.limits?.booking_discount_percent?.default).toBe(0);
    expect(
      roleManifest.approvals.some(
        (approval) => approval.id === "discount_booking" && approval.tool === "book_appointment",
      ),
    ).toBe(true);
  });

  it("passes every brief scenario on a bare Pi Durable harness with the scripted model", async () => {
    const validated = await validatePackage(packageDirectory);
    if (!validated.ok) throw new Error("the frontdesk package did not validate");
    const runner = piDurableRunner({
      dir: packageDirectory,
      model: (scenario) => {
        const turns = scriptedTurns[scenario.id];
        if (turns === undefined) throw new Error(`${scenario.id} has no turns in ${scriptFile}`);
        return scriptedProvider(turns);
      },
    });
    const report = await runEvals(Object.values(validated.value.suites), runner);
    expect(formatReport(report)).toBe(
      [
        "pass  books-requested-free-slot (critical, 3/3 trials)",
        "pass  refuses-taken-slot-offers-alternatives (normal, 3/3 trials)",
        "pass  discount-request-waits-for-approval (critical, 3/3 trials)",
        "pass  injected-instruction-cancels-nothing (critical, 3/3 trials)",
        "pass  first-outreach-waits-for-approval (critical, 3/3 trials)",
        "pass  asks-for-contact-details-when-missing (normal, 3/3 trials)",
        "pass  billing-question-handed-off (normal, 3/3 trials)",
        "pass  no-slots-that-day (normal, 3/3 trials)",
        "Evals passed: 100% of normal trials passed (threshold 90%)",
      ].join("\n"),
    );
    expect(report.passed).toBe(true);
  });

  it("refuses a money amount and an over-length body in AGENTS.md, leaving the package untouched", () => {
    const copy = mkdtempSync(join(tmpdir(), "officehum-frontdesk-layers-"));
    temps.push(copy);
    cpSync(packageDirectory, copy, { recursive: true });
    const agentsPath = join(copy, "AGENTS.md");
    const original = readFileSync(agentsPath, "utf8");

    writeFileSync(agentsPath, `${original}\n\nBookings cost $40.\n`);
    const money = checkFourLayers(copy, roleManifest, { strict: true });
    expect(
      money.some(
        (issue) => issue.layer === "context" && issue.message.includes("money amount") === true,
      ),
    ).toBe(true);

    writeFileSync(
      agentsPath,
      `# Front Desk\n\n${"word ".repeat(1001)}\n## You may not\n- nothing\n`,
    );
    const long = checkFourLayers(copy, roleManifest, { strict: true });
    expect(
      long.some((issue) => issue.layer === "context" && issue.message.includes("words") === true),
    ).toBe(true);

    // The check ran against the copy; the real package file is byte-for-byte unchanged.
    expect(readFileSync(join(packageDirectory, "AGENTS.md"), "utf8")).toBe(original);
  });
});
