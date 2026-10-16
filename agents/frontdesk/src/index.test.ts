import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { checkAgent, validatePackage } from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalCalendar } from "../../../packages/office/src/local-calendar.js";
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
    expect(checkAgent(frontdesk({ calendar }), manifest).ok).toBe(true);
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
