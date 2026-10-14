import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  Harness,
  type HookRegistration,
  hook,
  type ToolHooks,
  ToolTask,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { Approver, RoleBundle } from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { contactTools } from "../../../agents/frontdesk/src/contacts.js";
import frontdesk, {
  type Calendar,
  ContactsDoc,
  MessagesDoc,
  type Messenger,
} from "../../../agents/frontdesk/src/index.js";
import { createGoogleCalendar } from "../../google-calendar/src/index.js";
import { openConsoleMessenger } from "./console-messenger.js";
import { createDemoModels } from "./demo-model.js";
import { createGoogleCalendarHost } from "./google-calendar.js";
import { openLocalCalendar } from "./local-calendar.js";
import { openSolo, readSoloDocument } from "./solo.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "officehum-solo-"));
  temps.push(directory);
  return directory;
};

function googleMutationFixture() {
  const events = new Map<string, Record<string, unknown>>();
  const writes = { posts: 0, patches: 0, deletes: 0 };
  const transport: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/freeBusy")) {
      const busy = [...events.values()].map((event) => ({
        start: (event.start as Record<string, unknown>).dateTime,
        end: (event.end as Record<string, unknown>).dateTime,
      }));
      return new Response(JSON.stringify({ calendars: { cal: { busy } } }), { status: 200 });
    }
    const eventPath = /\/events\/([^/]+)$/.exec(url.pathname);
    if (eventPath !== null) {
      const id = decodeURIComponent(eventPath[1] ?? "");
      const event = events.get(id);
      if (init.method === "PATCH") {
        if (event === undefined) return new Response(undefined, { status: 404 });
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const previousPrivate = (event.extendedProperties as Record<string, unknown>).private as
          | Record<string, unknown>
          | undefined;
        const nextPrivate = (body.extendedProperties as Record<string, unknown>).private as
          | Record<string, unknown>
          | undefined;
        const updated = {
          ...event,
          ...body,
          id,
          status: "confirmed",
          etag: `"etag-${writes.patches + 1}"`,
          extendedProperties: { private: { ...previousPrivate, ...nextPrivate } },
        };
        events.set(id, updated);
        writes.patches += 1;
        return new Response(JSON.stringify(updated), { status: 200 });
      }
      if (init.method === "DELETE") {
        events.delete(id);
        writes.deletes += 1;
        return new Response(undefined, { status: 204 });
      }
      return new Response(JSON.stringify(event ?? {}), {
        status: event === undefined ? 404 : 200,
      });
    }
    if (url.pathname.endsWith("/events") && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const event = { ...body, status: "confirmed", etag: `"etag-post-${writes.posts + 1}"` };
      events.set(String(body.id), event);
      writes.posts += 1;
      return new Response(JSON.stringify(event), { status: 200 });
    }
    if (url.pathname.endsWith("/events")) {
      return new Response(JSON.stringify({ items: [...events.values()] }), { status: 200 });
    }
    return new Response(JSON.stringify({ timeZone: "UTC" }), { status: 200 });
  };
  return { events, transport, writes };
}

type ChildResult =
  | { status: "opened"; pid: number; marker: { pid: number; token: string } }
  | { status: "error"; message: string };

function ownerChild(directory: string, side: string, forceRace = false): ChildProcess {
  return fork(fileURLToPath(new URL("fixtures/solo-owner-child.mjs", import.meta.url)), [], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: {
      ...process.env,
      OFFICEHUM_TEST_DIRECTORY: directory,
      OFFICEHUM_TEST_SIDE: side,
      ...(forceRace ? { OFFICEHUM_TEST_FORCE_STALE_RACE: "1" } : {}),
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

async function childResult(child: ChildProcess): Promise<ChildResult> {
  const [message] = (await once(child, "message")) as [ChildResult];
  return message;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
}

function scriptedModels() {
  const faux = fauxProvider({ provider: "solo-test", models: [{ id: "model" }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("check_schedule", { date: "2030-01-15" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      fauxToolCall("book_appointment", {
        start: "2030-01-15T09:00:00Z",
        customer: "Demo Guest",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Your appointment is booked."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: { provider: "solo-test", modelId: "model" } };
}

describe("openSolo", () => {
  it("persists immutable connector identity and rejects mismatches before opening the harness", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const role = frontdesk({ calendar });
    const runtime = createDemoModels();
    const google = {
      version: 1 as const,
      backend: "google" as const,
      calendarId: "calendar@example.test",
      timeZone: "UTC" as const,
      workingHours: { start: "09:00" as const, end: "12:00" as const },
      durationMinutes: 60 as const,
    };
    const solo = await openSolo({ directory, role, ...runtime, connectorIdentity: google });
    await solo.close();
    expect(JSON.parse(readFileSync(join(directory, "connector.json"), "utf8"))).toEqual(google);

    await expect(openSolo({ directory, role, ...createDemoModels() })).rejects.toThrow(
      /local.*google|google.*local/i,
    );
    await expect(
      openSolo({
        directory,
        role,
        ...createDemoModels(),
        connectorIdentity: { ...google, calendarId: "other@example.test" },
      }),
    ).rejects.toThrow(/identity|calendar/i);
    calendar.close();
  });

  it("treats identity-free legacy harness state as local and rejects Google binding", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const role = frontdesk({ calendar });
    const original = await openSolo({ directory, role, ...createDemoModels() });
    await original.close();
    unlinkSync(join(directory, "connector.json"));
    await expect(
      openSolo({
        directory,
        role,
        ...createDemoModels(),
        connectorIdentity: {
          version: 1,
          backend: "google",
          calendarId: "calendar@example.test",
          timeZone: "UTC",
          workingHours: { start: "09:00", end: "12:00" },
          durationMinutes: 60,
        },
      }),
    ).rejects.toThrow(/legacy|local/i);
    expect(JSON.parse(readFileSync(join(directory, "connector.json"), "utf8"))).toEqual({
      version: 1,
      backend: "local",
    });
    calendar.close();
  });

  it.each(["booking", "approval", "operation"] as const)(
    "treats identity-free durable local %s records as legacy state",
    async (record) => {
      const directory = temporary();
      const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
      if (record === "booking") {
        await calendar.book("2030-01-15T09:00:00Z", "Local Guest", "legacy-booking");
      } else if (record === "approval") {
        calendar.recordDecision(
          "legacy-decision",
          {
            approvalId: "confirm_booking",
            description: "Confirm booking",
            tool: "book_appointment",
            arguments: { start: "2030-01-15T09:00:00Z", customer: "Local Guest" },
            conversationId: "conversation",
            taskId: "task",
            callId: "call",
          },
          { approved: true, by: "test" },
        );
      } else {
        calendar.bindOperation(
          "pending-operation",
          "cancel",
          JSON.stringify({ kind: "cancel", id: "missing" }),
        );
      }
      await expect(
        openSolo({
          directory,
          role: frontdesk({ calendar }),
          ...createDemoModels(),
          connectorIdentity: {
            version: 1,
            backend: "google",
            calendarId: "calendar@example.test",
            timeZone: "UTC",
            workingHours: { start: "09:00", end: "12:00" },
            durationMinutes: 60,
          },
        }),
      ).rejects.toThrow(/legacy|local|identity/i);
      expect(JSON.parse(readFileSync(join(directory, "connector.json"), "utf8"))).toEqual({
        version: 1,
        backend: "local",
      });
      calendar.close();
    },
  );

  it("allows an empty preflight calendar database to bind to Google", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    calendar.close();
    const session = await openSolo({
      directory,
      role: frontdesk({ calendar }),
      ...createDemoModels(),
      connectorIdentity: {
        version: 1,
        backend: "google",
        calendarId: "calendar@example.test",
        timeZone: "UTC",
        workingHours: { start: "09:00", end: "12:00" },
        durationMinutes: 60,
      },
    });
    expect(JSON.parse(readFileSync(join(directory, "connector.json"), "utf8"))).toMatchObject({
      backend: "google",
    });
    await session.close();
  });

  it("rejects malformed connector metadata", async () => {
    const directory = temporary();
    writeFileSync(
      join(directory, "connector.json"),
      JSON.stringify({ version: 1, backend: "google", accessToken: "must-not-exist" }),
    );
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    await expect(
      openSolo({ directory, role: frontdesk({ calendar }), ...createDemoModels() }),
    ).rejects.toThrow(/malformed/i);
    calendar.close();
  });

  it("deduplicates submissions and preserves root and transcript across reopen", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const role = frontdesk({ calendar, approve: async () => ({ approved: true }) });
    const { models, model } = scriptedModels();
    const solo = await openSolo({ directory, role, models, model });
    const first = await solo.submit("Book Demo Guest on 2030-01-15", "booking-1");
    const rootId = solo.root.id;
    const again = await solo.submit("Book Demo Guest on 2030-01-15", "booking-1");
    expect(first.text).toContain("booked");
    expect(again.submissionId).toBe(first.submissionId);
    expect(calendar.bookings()).toHaveLength(1);
    await solo.close();

    const reopened = await openSolo({ directory, role, models });
    expect(reopened.root.id).toBe(rootId);
    expect(await reopened.harness.submission(first.submissionId, BACKGROUND_CONTEXT)).toBeDefined();
    expect(await reopened.resume()).toEqual([]);
    expect(calendar.bookings()).toHaveLength(1);
    await reopened.close();
    calendar.close();
  });

  it("refreshes lifecycle tools on an old root without replacing its model or conversation", async () => {
    const directory = temporary();
    const overlay = join(directory, "legacy-overlay");
    mkdirSync(overlay);
    writeFileSync(
      join(overlay, "settings.json"),
      JSON.stringify({ tools: ["-cancel_appointment", "-update_contact"] }),
    );
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const role = frontdesk({ calendar, overlays: [overlay] });
    const runtime = scriptedModels();
    const registry = createRegistry();
    for (const extension of role.extensions) registry.install(extension);
    const storage = await openNodeJsonlStorage(join(directory, "harness"), BACKGROUND_CONTEXT, {
      fsync: true,
    });
    const legacyHarness = await Harness.open(
      storage,
      { models: runtime.models, registry },
      BACKGROUND_CONTEXT,
    );
    const original = await legacyHarness.root(BACKGROUND_CONTEXT, { agent: role.agent });
    const registrations = role.extensions.flatMap((extension) => extension.tools ?? []);
    const oldTools = registrations.filter((tool) =>
      ["check_schedule", "book_appointment"].includes(tool.name),
    );
    await original.configure({ tools: oldTools }, BACKGROUND_CONTEXT);
    const originalAgent = await original.agent(BACKGROUND_CONTEXT);
    expect(originalAgent.tools.map(({ name }) => name).sort()).toEqual([
      "book_appointment",
      "check_schedule",
    ]);
    const rootId = original.id;
    const model = originalAgent.model;
    await legacyHarness.close(BACKGROUND_CONTEXT);

    const reopened = await openSolo({ directory, role, models: runtime.models });
    expect(reopened.root.id).toBe(rootId);
    expect((await reopened.root.agent(BACKGROUND_CONTEXT)).model).toEqual(model);
    expect((await reopened.root.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "check_schedule",
        "book_appointment",
        "list_bookings",
        "reschedule_appointment",
        "list_contacts",
        "create_contact",
      ]),
    );
    expect(
      (await reopened.root.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name),
    ).not.toEqual(expect.arrayContaining(["cancel_appointment", "update_contact"]));
    await reopened.close();
    calendar.close();
  });

  it("adds contact tools once to a known five-tool root and preserves explicit masks", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const role = frontdesk({ calendar });
    const runtime = createDemoModels();
    const registrations = role.extensions.flatMap((extension) => extension.tools ?? []);
    const preContact = registrations.filter((tool) =>
      [
        "check_schedule",
        "list_bookings",
        "book_appointment",
        "reschedule_appointment",
        "cancel_appointment",
      ].includes(tool.name),
    );
    const readSkill = registrations.find((tool) => tool.name === "read_skill");
    if (readSkill === undefined) throw new Error("missing read_skill tool");
    const registry = createRegistry();
    for (const extension of role.extensions) registry.install(extension);
    const storage = await openNodeJsonlStorage(join(directory, "harness"), BACKGROUND_CONTEXT, {
      fsync: true,
    });
    const legacyHarness = await Harness.open(
      storage,
      { models: runtime.models, registry },
      BACKGROUND_CONTEXT,
    );
    const root = await legacyHarness.root(BACKGROUND_CONTEXT, { agent: role.agent });
    await root.configure({ tools: [...preContact, readSkill] }, BACKGROUND_CONTEXT);
    await legacyHarness.close(BACKGROUND_CONTEXT);

    const migrated = await openSolo({ directory, role, ...runtime });
    expect((await migrated.root.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["list_contacts", "create_contact", "update_contact", "read_skill"]),
    );
    const update = registrations.find((tool) => tool.name === "update_contact");
    if (update === undefined) throw new Error("missing update_contact tool");
    await migrated.root.configure({ tools: { remove: [update] } }, BACKGROUND_CONTEXT);
    await migrated.close();

    const reopened = await openSolo({ directory, role, ...runtime });
    expect(
      (await reopened.root.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name),
    ).not.toContain("update_contact");
    await reopened.close();
    calendar.close();
  });

  it("adds send_message once to a recognized pre-messaging root and preserves its explicit mask", async () => {
    const directory = temporary();
    const overlay = join(directory, "overlay");
    mkdirSync(overlay);
    writeFileSync(
      join(overlay, "settings.json"),
      JSON.stringify({ tools: ["-cancel_appointment"] }),
    );
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const role = frontdesk({ calendar, overlays: [overlay] });
    const runtime = createDemoModels();
    const registrations = role.extensions.flatMap((extension) => extension.tools ?? []);
    const oldTools = registrations.filter(
      (tool) =>
        tool.name !== "send_message" &&
        tool.name !== "read_skill" &&
        tool.name !== "cancel_appointment",
    );
    const readSkill = registrations.find((tool) => tool.name === "read_skill");
    if (readSkill === undefined) throw new Error("missing read_skill tool");
    const registry = createRegistry();
    for (const extension of role.extensions) registry.install(extension);
    const storage = await openNodeJsonlStorage(join(directory, "harness"), BACKGROUND_CONTEXT, {
      fsync: true,
    });
    const legacyHarness = await Harness.open(
      storage,
      { models: runtime.models, registry },
      BACKGROUND_CONTEXT,
    );
    const root = await legacyHarness.root(BACKGROUND_CONTEXT, { agent: role.agent });
    await root.configure({ tools: [...oldTools, readSkill] }, BACKGROUND_CONTEXT);
    const rootId = root.id;
    const model = (await root.agent(BACKGROUND_CONTEXT)).model;
    await legacyHarness.close(BACKGROUND_CONTEXT);

    const migrated = await openSolo({ directory, role, ...runtime });
    const names = (await migrated.root.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name);
    expect(migrated.root.id).toBe(rootId);
    expect((await migrated.root.agent(BACKGROUND_CONTEXT)).model).toEqual(model);
    expect(names).toContain("send_message");
    expect(names).not.toContain("cancel_appointment");
    await migrated.close();

    const reopened = await openSolo({ directory, role, ...runtime });
    expect((await reopened.root.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name)).toEqual(
      names,
    );
    await reopened.close();
    calendar.close();
  });

  it("does not widen an unrelated partial explicit tool selection", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const role = frontdesk({ calendar });
    const runtime = createDemoModels();
    const registry = createRegistry();
    for (const extension of role.extensions) registry.install(extension);
    const storage = await openNodeJsonlStorage(join(directory, "harness"), BACKGROUND_CONTEXT, {
      fsync: true,
    });
    const legacyHarness = await Harness.open(
      storage,
      { models: runtime.models, registry },
      BACKGROUND_CONTEXT,
    );
    const root = await legacyHarness.root(BACKGROUND_CONTEXT, { agent: role.agent });
    const partial = role.extensions
      .flatMap((extension) => extension.tools ?? [])
      .filter((tool) => ["check_schedule", "read_skill"].includes(tool.name));
    await root.configure({ tools: partial }, BACKGROUND_CONTEXT);
    await legacyHarness.close(BACKGROUND_CONTEXT);

    const reopened = await openSolo({ directory, role, ...runtime });
    expect((await reopened.root.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name)).toEqual([
      "check_schedule",
      "read_skill",
    ]);
    await reopened.close();
    calendar.close();
  });

  it("reads an existing session document without creating or running a Harness", async () => {
    const absent = temporary();
    expect(await readSoloDocument(absent, ContactsDoc)).toBeUndefined();
    expect(existsSync(join(absent, "harness"))).toBe(false);

    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const solo = await openSolo({
      directory,
      role: frontdesk({ calendar }),
      ...createDemoModels(),
    });
    const create = contactTools().find((tool) => tool.name === "create_contact");
    if (create === undefined) throw new Error("missing create_contact tool");
    await create.execute(
      { name: "Read Only Guest", email: "guest@example.com" },
      {
        conversationId: 1,
        taskId: 1,
        callId: "seed-contact",
        commit: solo.harness.commit.bind(solo.harness),
        snapshot: solo.harness.snapshot.bind(solo.harness),
      } as never,
      BACKGROUND_CONTEXT,
    );
    await expect(readSoloDocument(directory, ContactsDoc)).rejects.toThrow(/owned|active/i);
    await solo.close();

    expect(await readSoloDocument(directory, ContactsDoc)).toMatchObject({
      contacts: [{ id: "contact-1", name: "Read Only Guest", revision: 1 }],
    });
    calendar.close();
  });

  it("keeps lifecycle tools disabled by a role overlay across fresh open and reopen", async () => {
    const directory = temporary();
    const overlay = join(directory, "overlay");
    mkdirSync(overlay);
    writeFileSync(
      join(overlay, "settings.json"),
      JSON.stringify({ tools: ["-cancel_appointment", "-reschedule_appointment"] }),
    );
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const role = frontdesk({ calendar, overlays: [overlay] });
    const runtime = createDemoModels();

    const opened = await openSolo({ directory, role, ...runtime });
    expect((await opened.root.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["cancel_appointment", "reschedule_appointment"]),
    );
    await opened.close();

    const reopened = await openSolo({ directory, role, ...runtime });
    expect(
      (await reopened.root.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name),
    ).not.toEqual(expect.arrayContaining(["cancel_appointment", "reschedule_appointment"]));
    await reopened.close();
    calendar.close();
  });

  it("preserves an explicit persisted lifecycle-tool removal across reopen", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const role = frontdesk({ calendar });
    const runtime = createDemoModels();
    const cancel = role.extensions
      .flatMap((extension) => extension.tools ?? [])
      .find((tool) => tool.name === "cancel_appointment");
    if (cancel === undefined) throw new Error("missing cancellation tool");

    const opened = await openSolo({ directory, role, ...runtime });
    await opened.root.configure({ tools: { remove: [cancel] } }, BACKGROUND_CONTEXT);
    await opened.close();

    const reopened = await openSolo({ directory, role, ...runtime });
    expect(
      (await reopened.root.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name),
    ).not.toContain("cancel_appointment");
    await reopened.close();
    calendar.close();
  });

  it("discovers, moves, rediscovers, and cancels a booking through the actual Harness", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const seeded = await calendar.book("2030-01-15T09:00:00Z", "Same Name", "seed");
    let approvals = 0;
    const faux = fauxProvider({ provider: "lifecycle-flow", models: [{ id: "model" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("list_bookings", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("check_schedule", { date: "2030-01-15" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("reschedule_appointment", {
          id: seeded.id,
          start: "2030-01-15T10:00:00Z",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("list_bookings", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("cancel_appointment", { id: seeded.id }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("list_bookings", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("The appointment was moved and canceled."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const solo = await openSolo({
      directory,
      role: frontdesk({
        calendar,
        approve: async () => {
          approvals += 1;
          return { approved: true, by: "test" };
        },
      }),
      models,
      model: { provider: "lifecycle-flow", modelId: "model" },
    });
    const result = await solo.submit("Move and then cancel Same Name", "lifecycle-flow");
    expect(result.settlement.status).toBe("done");
    expect(result.text).toContain("moved and canceled");
    expect(approvals).toBe(2);
    expect(await calendar.listBookings()).toEqual([]);
    expect(calendar.canceledBooking(seeded.id)).toEqual({
      id: seeded.id,
      status: "canceled",
      alreadyCanceled: false,
    });
    await solo.close();
    calendar.close();
  });

  it.each(["reschedule", "cancel"] as const)(
    "recovers a local %s committed before tool settlement with one approval and submission",
    async (kind) => {
      const directory = temporary();
      const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
      const seeded = await calendar.book("2030-01-15T09:00:00Z", "Guest", "seed");
      let approvals = 0;
      const approve: Approver = async () => {
        approvals += 1;
        return { approved: true, by: "test" };
      };
      const normalRole = frontdesk({ calendar, approve });
      let reached!: () => void;
      const barrier = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const pauseAfterEffect = hook(ToolTask, {
        afterTool: async (call, result, _api, context) => {
          if (call.name !== `${kind}_appointment`) return result;
          reached();
          await awaitWithContext(new Promise<never>(() => {}), context);
          return result;
        },
      });
      const [roleExtension, ...rest] = normalRole.extensions;
      if (roleExtension === undefined) throw new Error("missing role extension");
      const interrupted: RoleBundle = {
        extensions: [
          { ...roleExtension, hooks: [...(roleExtension.hooks ?? []), pauseAfterEffect] },
          ...rest,
        ],
        agent: normalRole.agent,
      };
      const firstFaux = fauxProvider({ provider: `recover-${kind}`, models: [{ id: "model" }] });
      firstFaux.setResponses([
        fauxAssistantMessage(
          fauxToolCall(
            `${kind}_appointment`,
            kind === "reschedule"
              ? { id: seeded.id, start: "2030-01-15T10:00:00Z" }
              : { id: seeded.id },
          ),
          { stopReason: "toolUse" },
        ),
      ]);
      const firstModels = createModels();
      firstModels.setProvider(firstFaux.provider);
      const solo = await openSolo({
        directory,
        role: interrupted,
        models: firstModels,
        model: { provider: `recover-${kind}`, modelId: "model" },
      });
      const pending = solo.submit(`please ${kind}`, `${kind}-request`);
      await barrier;
      const [submission] = (await solo.harness.inspect(BACKGROUND_CONTEXT)).submissions;
      expect(submission).toBeDefined();
      await solo.close();
      await expect(pending).rejects.toThrow();

      const resumedFaux = fauxProvider({ provider: `recover-${kind}`, models: [{ id: "model" }] });
      resumedFaux.setResponses([fauxAssistantMessage("Recovered the original request.")]);
      const resumedModels = createModels();
      resumedModels.setProvider(resumedFaux.provider);
      const reopened = await openSolo({ directory, role: normalRole, models: resumedModels });
      const [result] = await reopened.resume();
      expect(result?.submissionId).toBe(submission?.id);
      expect(result?.settlement.status).toBe("done");
      expect(approvals).toBe(1);
      expect(await calendar.listBookings()).toEqual(
        kind === "reschedule" ? [{ ...seeded, start: "2030-01-15T10:00:00Z" }] : [],
      );
      await reopened.close();
      calendar.close();
    },
  );

  it.each(["create", "update"] as const)(
    "recovers an approved contact %s committed before tool settlement exactly once",
    async (kind) => {
      const directory = temporary();
      const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
      let approvals = 0;
      const approve: Approver = async () => {
        approvals += 1;
        return { approved: true, by: "test" };
      };
      const normalRole = frontdesk({ calendar, approve });
      let reached!: () => void;
      const barrier = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const pauseAfterCommit = hook(ToolTask, {
        afterTool: async (call, result, _api, context) => {
          if (call.name !== `${kind}_contact`) return result;
          reached();
          await awaitWithContext(new Promise<never>(() => {}), context);
          return result;
        },
      });
      const [roleExtension, ...rest] = normalRole.extensions;
      if (roleExtension === undefined) throw new Error("missing role extension");
      const interrupted: RoleBundle = {
        extensions: [
          { ...roleExtension, hooks: [...(roleExtension.hooks ?? []), pauseAfterCommit] },
          ...rest,
        ],
        agent: normalRole.agent,
      };
      const provider = `recover-contact-${kind}`;
      const firstFaux = fauxProvider({ provider, models: [{ id: "model" }] });
      firstFaux.setResponses([
        fauxAssistantMessage(
          fauxToolCall(
            `${kind}_contact`,
            kind === "create"
              ? { name: "Recovered Guest", email: "guest@example.com" }
              : {
                  id: "contact-1",
                  expectedRevision: 1,
                  name: "Corrected Guest",
                },
          ),
          { stopReason: "toolUse" },
        ),
      ]);
      const firstModels = createModels();
      firstModels.setProvider(firstFaux.provider);
      const solo = await openSolo({
        directory,
        role: interrupted,
        models: firstModels,
        model: { provider, modelId: "model" },
      });
      if (kind === "update") {
        const create = contactTools().find((tool) => tool.name === "create_contact");
        if (create === undefined) throw new Error("missing create_contact tool");
        await create.execute(
          { name: "Original Guest", email: "guest@example.com" },
          {
            conversationId: 99,
            taskId: 99,
            callId: "seed",
            commit: solo.harness.commit.bind(solo.harness),
            snapshot: solo.harness.snapshot.bind(solo.harness),
          } as never,
          BACKGROUND_CONTEXT,
        );
      }
      const pending = solo.submit(`please ${kind} contact`, `contact-${kind}-request`);
      await barrier;
      const [submission] = (await solo.harness.inspect(BACKGROUND_CONTEXT)).submissions;
      const before = await solo.harness.snapshot(ContactsDoc, BACKGROUND_CONTEXT);
      expect(before?.contacts).toHaveLength(1);
      expect(before?.contacts[0]).toMatchObject({
        name: kind === "create" ? "Recovered Guest" : "Corrected Guest",
        revision: kind === "create" ? 1 : 2,
      });
      await solo.close();
      await expect(pending).rejects.toThrow();

      const resumedFaux = fauxProvider({ provider, models: [{ id: "model" }] });
      resumedFaux.setResponses([fauxAssistantMessage("Recovered the contact write.")]);
      const resumedModels = createModels();
      resumedModels.setProvider(resumedFaux.provider);
      const reopened = await openSolo({ directory, role: normalRole, models: resumedModels });
      const [result] = await reopened.resume();
      expect(result?.submissionId).toBe(submission?.id);
      expect(result?.settlement.status).toBe("done");
      expect(approvals).toBe(1);
      const after = await reopened.harness.snapshot(ContactsDoc, BACKGROUND_CONTEXT);
      expect(after?.contacts).toEqual(before?.contacts);
      expect(after?.operations).toHaveLength(kind === "create" ? 1 : 2);
      await reopened.close();
      calendar.close();
    },
  );

  it("recovers console persistence before message history with one effect and one approval", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const outbox = openConsoleMessenger(join(directory, "messages.sqlite"));
    const sendAbort = new AbortController();
    let reached!: () => void;
    const barrier = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let approvals = 0;
    const interruptedMessenger: Messenger = {
      identity: outbox.identity,
      async send(intent, options) {
        const receipt = await outbox.send(intent, options);
        reached();
        await new Promise<never>((_resolve, reject) => {
          sendAbort.signal.addEventListener("abort", () => reject(sendAbort.signal.reason), {
            once: true,
          });
        });
        return receipt;
      },
    };
    const role = frontdesk({
      calendar,
      messenger: interruptedMessenger,
      approve: async () => {
        approvals += 1;
        return { approved: true, by: "test" };
      },
    });
    const provider = "recover-message-outbox";
    const firstFaux = fauxProvider({ provider, models: [{ id: "model" }] });
    firstFaux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("send_message", {
          contactId: "contact-1",
          channel: "email",
          to: "guest@example.test",
          text: "Recover exactly once",
          messengerId: outbox.identity,
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    const firstModels = createModels();
    firstModels.setProvider(firstFaux.provider);
    const solo = await openSolo({
      directory,
      role,
      models: firstModels,
      model: { provider, modelId: "model" },
    });
    const create = contactTools().find((tool) => tool.name === "create_contact");
    if (create === undefined) throw new Error("missing create_contact");
    await create.execute(
      { name: "Guest", email: "guest@example.test" },
      {
        conversationId: 90,
        taskId: 90,
        callId: "seed",
        commit: solo.harness.commit.bind(solo.harness),
        snapshot: solo.harness.snapshot.bind(solo.harness),
      } as never,
      BACKGROUND_CONTEXT,
    );
    const pending = solo.submit("Send the message", "message-outbox-recovery");
    await barrier;
    const [submission] = (await solo.harness.inspect(BACKGROUND_CONTEXT)).submissions;
    expect(outbox.messages()).toHaveLength(1);
    expect(await solo.harness.snapshot(MessagesDoc, BACKGROUND_CONTEXT)).toBeUndefined();
    const closing = solo.close();
    sendAbort.abort(new Error("simulated lost Messenger response"));
    await closing;
    await pending.catch(() => {});
    outbox.close();

    const recoveredOutbox = openConsoleMessenger(join(directory, "messages.sqlite"));
    const normalRole = frontdesk({
      calendar,
      messenger: recoveredOutbox,
      approve: async () => {
        approvals += 1;
        return { approved: true, by: "test" };
      },
    });
    const resumedFaux = fauxProvider({ provider, models: [{ id: "model" }] });
    resumedFaux.setResponses([fauxAssistantMessage("Recovered the message record.")]);
    const resumedModels = createModels();
    resumedModels.setProvider(resumedFaux.provider);
    const reopened = await openSolo({ directory, role: normalRole, models: resumedModels });
    const [result] = await reopened.resume();
    expect(result?.submissionId).toBe(submission?.id);
    expect(result?.settlement.status).toBe("done");
    expect(approvals).toBe(1);
    expect(recoveredOutbox.messages()).toHaveLength(1);
    expect(
      (await reopened.harness.snapshot(MessagesDoc, BACKGROUND_CONTEXT))?.messages,
    ).toHaveLength(1);
    await reopened.close();
    recoveredOutbox.close();
    calendar.close();
  });

  it("does not execute an approved console intent after the Messenger identity changes", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const consoleMessenger = openConsoleMessenger(join(directory, "messages.sqlite"));
    let approvals = 0;
    const baseRole = frontdesk({
      calendar,
      messenger: consoleMessenger,
      approve: async () => {
        approvals += 1;
        return { approved: true, by: "test" };
      },
    });
    let reached!: () => void;
    const barrier = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const [roleExtension, ...otherExtensions] = baseRole.extensions;
    if (roleExtension === undefined) throw new Error("missing role extension");
    const interruptedTools = roleExtension.tools?.map((tool) =>
      tool.name !== "send_message"
        ? tool
        : {
            ...tool,
            execute: async (...args: Parameters<typeof tool.execute>) => {
              reached();
              await awaitWithContext(new Promise<never>(() => {}), args[2]);
              return tool.execute(...args);
            },
          },
    );
    const interruptedRole: RoleBundle = {
      extensions: [{ ...roleExtension, tools: interruptedTools }, ...otherExtensions],
      agent: baseRole.agent,
    };
    const provider = "recover-message-transport";
    const firstFaux = fauxProvider({ provider, models: [{ id: "model" }] });
    firstFaux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("send_message", {
          contactId: "contact-1",
          channel: "email",
          to: "guest@example.test",
          text: "Approved only for console",
          messengerId: consoleMessenger.identity,
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    const models = createModels();
    models.setProvider(firstFaux.provider);
    const solo = await openSolo({
      directory,
      role: interruptedRole,
      models,
      model: { provider, modelId: "model" },
    });
    const create = contactTools().find((tool) => tool.name === "create_contact");
    if (create === undefined) throw new Error("missing create_contact");
    await create.execute(
      { name: "Guest", email: "guest@example.test" },
      {
        conversationId: 90,
        taskId: 90,
        callId: "seed",
        commit: solo.harness.commit.bind(solo.harness),
        snapshot: solo.harness.snapshot.bind(solo.harness),
      } as never,
      BACKGROUND_CONTEXT,
    );
    const pending = solo.submit("Send the message", "message-transport-recovery");
    await barrier;
    const [submission] = (await solo.harness.inspect(BACKGROUND_CONTEXT)).submissions;
    expect(approvals).toBe(1);
    await solo.close();
    await pending.catch(() => {});
    consoleMessenger.close();

    const effects: unknown[] = [];
    const changedMessenger: Messenger = {
      identity: "real.transport.v1",
      async send(intent) {
        effects.push(intent);
        return { id: "unexpected", status: "accepted" };
      },
    };
    const resumedRole = frontdesk({
      calendar,
      messenger: changedMessenger,
      approve: async () => ({ approved: true }),
    });
    const resumedFaux = fauxProvider({ provider, models: [{ id: "model" }] });
    resumedFaux.setResponses([fauxAssistantMessage("The transport changed, so nothing was sent.")]);
    const resumedModels = createModels();
    resumedModels.setProvider(resumedFaux.provider);
    const reopened = await openSolo({ directory, role: resumedRole, models: resumedModels });
    const [result] = await reopened.resume();
    expect(result?.submissionId).toBe(submission?.id);
    expect(effects).toEqual([]);
    expect(await reopened.harness.snapshot(MessagesDoc, BACKGROUND_CONTEXT)).toBeUndefined();
    await reopened.close();
    calendar.close();
  });

  it("recovers a pinned message to the original destination after the contact is edited", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const sendAbort = new AbortController();
    let reached!: () => void;
    const barrier = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let approvals = 0;
    const interruptedMessenger: Messenger = {
      identity: "test.transport.v1",
      async send() {
        reached();
        await new Promise<never>((_resolve, reject) => {
          sendAbort.signal.addEventListener("abort", () => reject(sendAbort.signal.reason), {
            once: true,
          });
        });
        return { id: "unreachable", status: "accepted" };
      },
    };
    const provider = "recover-message-contact-edit";
    const role = frontdesk({
      calendar,
      messenger: interruptedMessenger,
      approve: async () => {
        approvals += 1;
        return { approved: true, by: "test" };
      },
    });
    const firstFaux = fauxProvider({ provider, models: [{ id: "model" }] });
    firstFaux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("send_message", {
          contactId: "contact-1",
          channel: "email",
          to: "old@example.test",
          text: "Pinned original text",
          messengerId: interruptedMessenger.identity,
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    const models = createModels();
    models.setProvider(firstFaux.provider);
    const solo = await openSolo({ directory, role, models, model: { provider, modelId: "model" } });
    const tools = contactTools();
    const create = tools.find((tool) => tool.name === "create_contact");
    const update = tools.find((tool) => tool.name === "update_contact");
    if (create === undefined || update === undefined) throw new Error("missing contact tools");
    const directApi = (callId: string) => ({
      conversationId: 91,
      taskId: 91,
      callId,
      commit: solo.harness.commit.bind(solo.harness),
      snapshot: solo.harness.snapshot.bind(solo.harness),
    });
    await create.execute(
      { name: "Guest", email: "old@example.test" },
      directApi("seed") as never,
      BACKGROUND_CONTEXT,
    );
    const pending = solo.submit("Send the message", "message-contact-edit-recovery");
    await barrier;
    await update.execute(
      { id: "contact-1", expectedRevision: 1, email: "new@example.test" },
      directApi("edit") as never,
      BACKGROUND_CONTEXT,
    );
    const [submission] = (await solo.harness.inspect(BACKGROUND_CONTEXT)).submissions;
    const closing = solo.close();
    sendAbort.abort(new Error("simulated interruption after intent pin"));
    await closing;
    await pending.catch(() => {});

    const effects: Array<{ to: string; channel: string; text: string }> = [];
    const recoveredMessenger: Messenger = {
      identity: "test.transport.v1",
      async send(intent) {
        effects.push({ ...intent });
        return { id: "accepted-original", status: "accepted" };
      },
    };
    const resumedRole = frontdesk({
      calendar,
      messenger: recoveredMessenger,
      approve: async () => {
        approvals += 1;
        return { approved: true, by: "test" };
      },
    });
    const resumedFaux = fauxProvider({ provider, models: [{ id: "model" }] });
    resumedFaux.setResponses([fauxAssistantMessage("Recovered the pinned message.")]);
    const resumedModels = createModels();
    resumedModels.setProvider(resumedFaux.provider);
    const reopened = await openSolo({ directory, role: resumedRole, models: resumedModels });
    const [result] = await reopened.resume();
    expect(result?.submissionId).toBe(submission?.id);
    expect(approvals).toBe(1);
    expect(effects).toEqual([
      { to: "old@example.test", channel: "email", text: "Pinned original text" },
    ]);
    expect(await reopened.harness.snapshot(ContactsDoc, BACKGROUND_CONTEXT)).toMatchObject({
      contacts: [{ email: "new@example.test", revision: 2 }],
    });
    expect(await reopened.harness.snapshot(MessagesDoc, BACKGROUND_CONTEXT)).toMatchObject({
      messages: [{ to: "old@example.test", contactRevision: 1, text: "Pinned original text" }],
    });
    await reopened.close();
    calendar.close();
  });

  it("keeps an interrupted first-contact decline after another conversation establishes history", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const effects: Array<{ to: string; text: string; requestId: string }> = [];
    const messenger: Messenger = {
      identity: "test.transport.v1",
      async send(intent, options) {
        effects.push({ to: intent.to, text: intent.text, requestId: options.requestId });
        return { id: `receipt-${options.requestId}`, status: "accepted" };
      },
    };
    let approvals = 0;
    const normalRole = frontdesk({
      calendar,
      messenger,
      approve: async () => {
        approvals += 1;
        return approvals === 1
          ? { approved: false, by: "operator", note: "declined original" }
          : { approved: true, by: "operator" };
      },
    });
    const [roleExtension, ...otherExtensions] = normalRole.extensions;
    if (roleExtension === undefined) throw new Error("missing role extension");
    const [gate, ...otherHooks] = roleExtension.hooks ?? [];
    if (gate === undefined) throw new Error("missing approval gate");
    const originalBefore = (gate as HookRegistration & { handlers: Pick<ToolHooks, "beforeTool"> })
      .handlers.beforeTool;
    let reached!: () => void;
    const barrier = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const pausedGate = {
      ...gate,
      handlers: {
        ...(gate as HookRegistration & { handlers: Pick<ToolHooks, "beforeTool"> }).handlers,
        beforeTool: async (...args: Parameters<ToolHooks["beforeTool"]>) => {
          const decision = await originalBefore(...args);
          if (args[0].name === "send_message" && decision?.block?.includes("declined")) {
            reached();
            await awaitWithContext(new Promise<never>(() => {}), args[2]);
          }
          return decision;
        },
      },
    } as HookRegistration;
    const interruptedRole: RoleBundle = {
      extensions: [{ ...roleExtension, hooks: [pausedGate, ...otherHooks] }, ...otherExtensions],
      agent: normalRole.agent,
    };
    const provider = "recover-message-decline";
    const firstFaux = fauxProvider({ provider, models: [{ id: "model" }] });
    const messageArgs = {
      contactId: "contact-1",
      channel: "email",
      to: "guest@example.test",
      text: "Same target",
      messengerId: messenger.identity,
    } as const;
    firstFaux.setResponses([
      fauxAssistantMessage(fauxToolCall("send_message", messageArgs), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("send_message", messageArgs), { stopReason: "toolUse" }),
      fauxAssistantMessage("Second conversation sent the message."),
    ]);
    const models = createModels();
    models.setProvider(firstFaux.provider);
    const solo = await openSolo({
      directory,
      role: interruptedRole,
      models,
      model: { provider, modelId: "model" },
    });
    const create = contactTools().find((tool) => tool.name === "create_contact");
    if (create === undefined) throw new Error("missing create_contact");
    await create.execute(
      { name: "Guest", email: "guest@example.test" },
      {
        conversationId: 90,
        taskId: 90,
        callId: "seed",
        commit: solo.harness.commit.bind(solo.harness),
        snapshot: solo.harness.snapshot.bind(solo.harness),
      } as never,
      BACKGROUND_CONTEXT,
    );
    const original = solo.submit("Send from the original conversation", "declined-original");
    await barrier;
    const [originalSubmission] = (await solo.harness.inspect(BACKGROUND_CONTEXT)).submissions;
    const other = await solo.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { ...normalRole.agent, model: { provider, modelId: "model" } },
      },
      BACKGROUND_CONTEXT,
    );
    const otherSubmission = await other.submit(
      { type: "input", content: "Send from the other conversation" },
      BACKGROUND_CONTEXT,
    );
    expect((await otherSubmission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(effects).toHaveLength(1);
    expect((await solo.harness.snapshot(MessagesDoc, BACKGROUND_CONTEXT))?.messages).toHaveLength(
      1,
    );
    await solo.close();
    await original.catch(() => {});

    const resumedFaux = fauxProvider({ provider, models: [{ id: "model" }] });
    resumedFaux.setResponses([fauxAssistantMessage("The original request remains declined.")]);
    const resumedModels = createModels();
    resumedModels.setProvider(resumedFaux.provider);
    const reopened = await openSolo({ directory, role: normalRole, models: resumedModels });
    const [result] = await reopened.resume();
    expect(result?.submissionId).toBe(originalSubmission?.id);
    expect(result?.settlement.status).toBe("done");
    expect(approvals).toBe(2);
    expect(effects).toHaveLength(1);
    expect(
      (await reopened.harness.snapshot(MessagesDoc, BACKGROUND_CONTEXT))?.messages,
    ).toHaveLength(1);
    await reopened.close();
    calendar.close();
  });

  it("returns committed message history after interruption before tool settlement without another effect", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const effects: string[] = [];
    const messenger: Messenger = {
      identity: "test.transport.v1",
      async send(_intent, options) {
        effects.push(options.requestId);
        return { id: `receipt-${options.requestId}`, status: "accepted" };
      },
    };
    let approvals = 0;
    const normalRole = frontdesk({
      calendar,
      messenger,
      approve: async () => {
        approvals += 1;
        return { approved: true, by: "test" };
      },
    });
    let reached!: () => void;
    const barrier = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const pauseAfterHistory = hook(ToolTask, {
      afterTool: async (call, result, _api, context) => {
        if (call.name !== "send_message") return result;
        reached();
        await awaitWithContext(new Promise<never>(() => {}), context);
        return result;
      },
    });
    const [roleExtension, ...otherExtensions] = normalRole.extensions;
    if (roleExtension === undefined) throw new Error("missing role extension");
    const interruptedRole: RoleBundle = {
      extensions: [
        { ...roleExtension, hooks: [...(roleExtension.hooks ?? []), pauseAfterHistory] },
        ...otherExtensions,
      ],
      agent: normalRole.agent,
    };
    const provider = "recover-message-history";
    const firstFaux = fauxProvider({ provider, models: [{ id: "model" }] });
    firstFaux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("send_message", {
          contactId: "contact-1",
          channel: "email",
          to: "guest@example.test",
          text: "Already committed",
          messengerId: messenger.identity,
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    const models = createModels();
    models.setProvider(firstFaux.provider);
    const solo = await openSolo({
      directory,
      role: interruptedRole,
      models,
      model: { provider, modelId: "model" },
    });
    const create = contactTools().find((tool) => tool.name === "create_contact");
    if (create === undefined) throw new Error("missing create_contact");
    await create.execute(
      { name: "Guest", email: "guest@example.test" },
      {
        conversationId: 90,
        taskId: 90,
        callId: "seed",
        commit: solo.harness.commit.bind(solo.harness),
        snapshot: solo.harness.snapshot.bind(solo.harness),
      } as never,
      BACKGROUND_CONTEXT,
    );
    const pending = solo.submit("Send", "message-history-recovery");
    await barrier;
    const [submission] = (await solo.harness.inspect(BACKGROUND_CONTEXT)).submissions;
    expect(effects).toHaveLength(1);
    expect((await solo.harness.snapshot(MessagesDoc, BACKGROUND_CONTEXT))?.messages).toHaveLength(
      1,
    );
    await solo.close();
    await pending.catch(() => {});

    const resumedFaux = fauxProvider({ provider, models: [{ id: "model" }] });
    resumedFaux.setResponses([fauxAssistantMessage("Recovered committed history.")]);
    const resumedModels = createModels();
    resumedModels.setProvider(resumedFaux.provider);
    const reopened = await openSolo({ directory, role: normalRole, models: resumedModels });
    const [result] = await reopened.resume();
    expect(result?.submissionId).toBe(submission?.id);
    expect(result?.settlement.status).toBe("done");
    expect(approvals).toBe(1);
    expect(effects).toHaveLength(1);
    expect(
      (await reopened.harness.snapshot(MessagesDoc, BACKGROUND_CONTEXT))?.messages,
    ).toHaveLength(1);
    await reopened.close();
    calendar.close();
  });

  it("rejects an active owner and recovers a stale lock", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const role = frontdesk({ calendar });
    const { models, model } = scriptedModels();
    const first = await openSolo({ directory, role, models, model });
    await expect(openSolo({ directory, role, models, model })).rejects.toThrow(/active/i);
    await first.close();

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "owner.lock"), JSON.stringify({ pid: 99999999, token: "stale" }));
    const recovered = await openSolo({ directory, role, models, model });
    await recovered.close();
    calendar.close();
  });

  it("serializes two real processes racing to reclaim one stale owner", async () => {
    const directory = temporary();
    writeFileSync(
      join(directory, "owner.lock"),
      JSON.stringify({ pid: 99_999_999, token: "stale" }),
    );
    const a = ownerChild(directory, "a", true);
    const b = ownerChild(directory, "b", true);
    const aResult = childResult(a);
    const bResult = childResult(b);
    const first = await Promise.race([aResult, bResult]);
    if (first.status === "error") {
      writeFileSync(join(directory, "a-ready"), "released");
      writeFileSync(join(directory, "b-stale-read"), "released");
    }
    const results = await Promise.all([aResult, bResult]);
    const opened = results.filter(
      (result): result is Extract<ChildResult, { status: "opened" }> => result.status === "opened",
    );
    expect(opened).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(directory, "owner.lock"), "utf8"))).toEqual(
      opened[0]?.marker,
    );
    if ((await aResult).status === "opened" && a.connected) a.send("close");
    if ((await bResult).status === "opened" && b.connected) b.send("close");
    await Promise.all([waitForExit(a), waitForExit(b)]);
  });

  it("releases process ownership after abrupt termination", async () => {
    const directory = temporary();
    const first = ownerChild(directory, "first");
    const firstResult = await childResult(first);
    expect(firstResult.status).toBe("opened");
    first.kill("SIGKILL");
    await once(first, "exit");

    const recovered = ownerChild(directory, "recovered");
    const recoveredResult = await childResult(recovered);
    expect(recoveredResult.status).toBe("opened");
    recovered.send?.("close");
    await once(recovered, "exit");
  });

  it("releases its lock when initialization fails", async () => {
    const directory = temporary();
    writeFileSync(join(directory, "harness"), "broken");
    const { models, model } = scriptedModels();
    const brokenRole = { extensions: [], agent: { model } } as RoleBundle;
    await expect(openSolo({ directory, role: brokenRole, models, model })).rejects.toThrow();
    rmSync(join(directory, "harness"), { recursive: true, force: true });
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const recovered = await openSolo({ directory, role: frontdesk({ calendar }), models, model });
    await recovered.close();
    calendar.close();
  });

  it("recovers an effect committed before the tool result without booking twice", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    let approvalKey: string | undefined;
    let approvalCount = 0;
    const approve: Approver = async (request) => {
      approvalCount += 1;
      approvalKey = `${request.conversationId}:${request.taskId}:${request.callId}:${request.approvalId}`;
      return calendar.recordDecision(approvalKey, request, { approved: true, by: "test" });
    };
    const normalRole = frontdesk({ calendar, approve });
    let reached!: () => void;
    const barrier = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const pauseAfterEffect = hook(ToolTask, {
      afterTool: async (call, result, _api, context) => {
        if (call.name !== "book_appointment") return result;
        reached();
        await awaitWithContext(new Promise<never>(() => {}), context);
        return result;
      },
    });
    const [roleExtension, ...otherExtensions] = normalRole.extensions;
    if (roleExtension === undefined) throw new Error("Front Desk role extension is missing");
    const interruptedRole: RoleBundle = {
      extensions: [
        {
          ...roleExtension,
          hooks: [...(roleExtension.hooks ?? []), pauseAfterEffect],
        },
        ...otherExtensions,
      ],
      agent: normalRole.agent,
    };
    const demo = createDemoModels();
    const solo = await openSolo({ directory, role: interruptedRole, ...demo });
    const pending = solo.submit("Book Demo Guest on 2030-01-15", "booking-crash");
    await barrier;
    const [before] = calendar.bookings();
    expect(before).toBeDefined();
    await solo.close();
    await expect(pending).rejects.toThrow();

    const reopenedDemo = createDemoModels();
    const reopened = await openSolo({ directory, role: normalRole, ...reopenedDemo });
    const [recovered] = await reopened.resume();
    expect(recovered?.settlement.status).toBe("done");
    expect(calendar.bookings()).toEqual([before]);
    expect(approvalCount).toBe(1);
    expect(approvalKey).toBeDefined();
    expect(calendar.decision(approvalKey ?? "")).toEqual({ approved: true, by: "test" });
    await reopened.close();
    calendar.close();
  });

  it("recovers a Google insert committed before tool settlement with one event and one approval", async () => {
    const directory = temporary();
    const decisions = openLocalCalendar(join(directory, "calendar.sqlite"));
    const events = new Map<string, Record<string, unknown>>();
    const transport: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/freeBusy"))
        return new Response(JSON.stringify({ calendars: { cal: { busy: [] } } }), { status: 200 });
      const eventPath = /\/events\/([^/]+)$/.exec(url.pathname);
      if (eventPath !== null) {
        const event = events.get(eventPath[1] ?? "");
        return new Response(JSON.stringify(event ?? { error: {} }), {
          status: event === undefined ? 404 : 200,
        });
      }
      if (url.pathname.endsWith("/events") && init.method === "POST") {
        const event = JSON.parse(String(init.body)) as Record<string, unknown>;
        events.set(String(event.id), { ...event, etag: '"etag"', status: "confirmed" });
        return new Response(JSON.stringify(events.get(String(event.id))), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [...events.values()] }), { status: 200 });
    };
    const portable = createGoogleCalendar({
      calendarId: "cal",
      getAccessToken: async () => "token",
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
      fetch: transport,
    });
    const calendar = createGoogleCalendarHost({ client: portable, decisions, durationMinutes: 60 });
    let approvals = 0;
    const approve: Approver = async (request) => {
      approvals += 1;
      const key = `${request.conversationId}:${request.taskId}:${request.callId}:${request.approvalId}`;
      return calendar.recordDecision(key, request, { approved: true, by: "test" });
    };
    const role = frontdesk({ calendar, approve });
    let reached!: () => void;
    const barrier = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const pauseAfterEffect = hook(ToolTask, {
      afterTool: async (call, result, _api, context) => {
        if (call.name !== "book_appointment") return result;
        reached();
        await awaitWithContext(new Promise<never>(() => {}), context);
        return result;
      },
    });
    const [roleExtension, ...rest] = role.extensions;
    if (roleExtension === undefined) throw new Error("missing role extension");
    const interrupted: RoleBundle = {
      extensions: [
        { ...roleExtension, hooks: [...(roleExtension.hooks ?? []), pauseAfterEffect] },
        ...rest,
      ],
      agent: role.agent,
    };
    const identity = {
      version: 1 as const,
      backend: "google" as const,
      calendarId: "cal",
      timeZone: "UTC" as const,
      workingHours: { start: "09:00" as const, end: "12:00" as const },
      durationMinutes: 60 as const,
    };
    const solo = await openSolo({
      directory,
      role: interrupted,
      ...createDemoModels(),
      connectorIdentity: identity,
    });
    const pending = solo.submit("Book Demo Guest on 2030-01-15", "google-crash");
    await barrier;
    expect(events.size).toBe(1);
    await solo.close();
    await expect(pending).rejects.toThrow();

    const reopened = await openSolo({
      directory,
      role,
      ...createDemoModels(),
      connectorIdentity: identity,
    });
    const [result] = await reopened.resume();
    expect(result?.settlement.status).toBe("done");
    expect(events.size).toBe(1);
    expect(approvals).toBe(1);
    await reopened.close();
    calendar.close();
  });

  it.each(["local", "google"] as const)(
    "recovers a %s booking between the calendar effect and contact link with pinned identity",
    async (backend) => {
      const directory = temporary();
      const decisions = openLocalCalendar(join(directory, "calendar.sqlite"));
      const googleFixture = googleMutationFixture();
      const identity = {
        version: 1 as const,
        backend: "google" as const,
        calendarId: "cal",
        timeZone: "UTC" as const,
        workingHours: { start: "09:00" as const, end: "12:00" as const },
        durationMinutes: 60 as const,
      };
      const calendar: Calendar =
        backend === "local"
          ? decisions
          : createGoogleCalendarHost({
              client: createGoogleCalendar({
                calendarId: "cal",
                getAccessToken: async () => "token",
                timeZone: "UTC",
                workingHours: { start: "09:00", end: "12:00" },
                durationMinutes: 60,
                fetch: googleFixture.transport,
              }),
              decisions,
              durationMinutes: 60,
            });
      let approvals = 0;
      const approve: Approver = async () => {
        approvals += 1;
        return { approved: true, by: "test" };
      };
      let reached!: () => void;
      const afterEffect = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let release!: () => void;
      const holdReturn = new Promise<void>((resolve) => {
        release = resolve;
      });
      const interruptedCalendar: Calendar = {
        freeSlots: calendar.freeSlots.bind(calendar),
        listBookings: calendar.listBookings.bind(calendar),
        reschedule: calendar.reschedule.bind(calendar),
        cancel: calendar.cancel.bind(calendar),
        async book(start, customer, key) {
          const booking = await calendar.book(start, customer, key);
          reached();
          await holdReturn;
          return booking;
        },
      };
      const provider = `contact-link-${backend}`;
      const firstFaux = fauxProvider({ provider, models: [{ id: "model" }] });
      firstFaux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("book_appointment", {
            start: "2030-01-15T09:00:00Z",
            customer: "Pinned Guest",
            contactId: "contact-1",
          }),
          { stopReason: "toolUse" },
        ),
      ]);
      const firstModels = createModels();
      firstModels.setProvider(firstFaux.provider);
      const solo = await openSolo({
        directory,
        role: frontdesk({ calendar: interruptedCalendar, approve }),
        models: firstModels,
        model: { provider, modelId: "model" },
        ...(backend === "google" ? { connectorIdentity: identity } : {}),
      });
      const [create, update] = ["create_contact", "update_contact"].map((name) => {
        const tool = contactTools().find((candidate) => candidate.name === name);
        if (tool === undefined) throw new Error(`missing ${name}`);
        return tool;
      });
      await create?.execute(
        { name: "Pinned Guest", email: "guest@example.com" },
        {
          conversationId: 77,
          taskId: 77,
          callId: "seed-contact",
          commit: solo.harness.commit.bind(solo.harness),
          snapshot: solo.harness.snapshot.bind(solo.harness),
        } as never,
        BACKGROUND_CONTEXT,
      );
      const pending = solo.submit("Book the pinned guest", `contact-link-${backend}`);
      await afterEffect;
      await update?.execute(
        { id: "contact-1", expectedRevision: 1, name: "Renamed Guest" },
        {
          conversationId: 88,
          taskId: 88,
          callId: "rename-contact",
          commit: solo.harness.commit.bind(solo.harness),
          snapshot: solo.harness.snapshot.bind(solo.harness),
        } as never,
        BACKGROUND_CONTEXT,
      );
      expect(await solo.harness.snapshot(ContactsDoc, BACKGROUND_CONTEXT)).toMatchObject({
        contacts: [{ name: "Renamed Guest", revision: 2, bookingIds: [] }],
        bookingLinks: [],
      });
      const [submission] = (await solo.harness.inspect(BACKGROUND_CONTEXT)).submissions;
      const closing = solo.close();
      release();
      await closing;
      await expect(pending).rejects.toThrow();

      const resumedFaux = fauxProvider({ provider, models: [{ id: "model" }] });
      resumedFaux.setResponses([fauxAssistantMessage("Recovered the linked booking.")]);
      const resumedModels = createModels();
      resumedModels.setProvider(resumedFaux.provider);
      const reopened = await openSolo({
        directory,
        role: frontdesk({ calendar, approve }),
        models: resumedModels,
        ...(backend === "google" ? { connectorIdentity: identity } : {}),
      });
      const [result] = await reopened.resume();
      expect(result?.submissionId).toBe(submission?.id);
      expect(result?.settlement.status).toBe("done");
      const bookings = await calendar.listBookings();
      expect(bookings).toHaveLength(1);
      expect(bookings[0]?.customer).toBe("Pinned Guest");
      expect(await reopened.harness.snapshot(ContactsDoc, BACKGROUND_CONTEXT)).toMatchObject({
        contacts: [
          {
            id: "contact-1",
            name: "Renamed Guest",
            revision: 2,
            bookingIds: [bookings[0]?.id],
          },
        ],
        bookingLinks: [{ contactId: "contact-1", bookingId: bookings[0]?.id }],
      });
      expect(approvals).toBe(1);
      if (backend === "google") expect(googleFixture.writes.posts).toBe(1);
      await reopened.close();
      decisions.close();
    },
  );

  it.each(["reschedule", "cancel"] as const)(
    "recovers a lost Google %s response through the actual Harness without a second write",
    async (kind) => {
      const directory = temporary();
      const decisions = openLocalCalendar(join(directory, "calendar.sqlite"));
      const identity = {
        version: 1 as const,
        backend: "google" as const,
        calendarId: "cal",
        timeZone: "UTC" as const,
        workingHours: { start: "09:00" as const, end: "12:00" as const },
        durationMinutes: 60 as const,
      };
      writeFileSync(join(directory, "connector.json"), `${JSON.stringify(identity)}\n`);
      const events = new Map<string, Record<string, unknown>>();
      let writes = 0;
      let loseResponse = true;
      const transport: typeof fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/freeBusy")) {
          const busy = [...events.values()].map((event) => ({
            start: (event.start as Record<string, unknown>).dateTime,
            end: (event.end as Record<string, unknown>).dateTime,
          }));
          return new Response(JSON.stringify({ calendars: { cal: { busy } } }), { status: 200 });
        }
        const eventPath = /\/events\/([^/]+)$/.exec(url.pathname);
        if (eventPath !== null) {
          const id = decodeURIComponent(eventPath[1] ?? "");
          const event = events.get(id);
          if (init.method === "PATCH") {
            if (event === undefined) return new Response(undefined, { status: 404 });
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            const privateBefore = (event.extendedProperties as Record<string, unknown>).private as
              | Record<string, unknown>
              | undefined;
            const privateAfter = (body.extendedProperties as Record<string, unknown>).private as
              | Record<string, unknown>
              | undefined;
            const updated = {
              ...event,
              ...body,
              id,
              status: "confirmed",
              etag: '"etag-moved"',
              extendedProperties: { private: { ...privateBefore, ...privateAfter } },
            };
            events.set(id, updated);
            writes += 1;
            if (loseResponse) {
              loseResponse = false;
              throw new Error("lost PATCH response");
            }
            return new Response(JSON.stringify(updated), { status: 200 });
          }
          if (init.method === "DELETE") {
            events.delete(id);
            writes += 1;
            if (loseResponse) {
              loseResponse = false;
              throw new Error("lost DELETE response");
            }
            return new Response(undefined, { status: 204 });
          }
          return new Response(JSON.stringify(event ?? {}), {
            status: event === undefined ? 404 : 200,
          });
        }
        if (url.pathname.endsWith("/events") && init.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          const event = { ...body, status: "confirmed", etag: '"etag-seed"' };
          events.set(String(body.id), event);
          return new Response(JSON.stringify(event), { status: 200 });
        }
        if (url.pathname.endsWith("/events")) {
          return new Response(JSON.stringify({ items: [...events.values()] }), { status: 200 });
        }
        return new Response(JSON.stringify({ timeZone: "UTC" }), { status: 200 });
      };
      const portable = createGoogleCalendar({
        calendarId: "cal",
        getAccessToken: async () => "token",
        timeZone: "UTC",
        workingHours: { start: "09:00", end: "12:00" },
        durationMinutes: 60,
        fetch: transport,
      });
      const calendar = createGoogleCalendarHost({
        client: portable,
        decisions,
        durationMinutes: 60,
      });
      const seeded = await calendar.book("2030-01-15T09:00:00Z", "Guest", "seed");
      let approvals = 0;
      const approve: Approver = async () => {
        approvals += 1;
        return { approved: true, by: "test" };
      };
      const normalRole = frontdesk({ calendar, approve });
      let reached!: () => void;
      const barrier = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const pauseAfterLostResponse = hook(ToolTask, {
        afterTool: async (call, result, _api, context) => {
          if (call.name !== `${kind}_appointment`) return result;
          reached();
          await awaitWithContext(new Promise<never>(() => {}), context);
          return result;
        },
      });
      const [roleExtension, ...rest] = normalRole.extensions;
      if (roleExtension === undefined) throw new Error("missing role extension");
      const interrupted: RoleBundle = {
        extensions: [
          {
            ...roleExtension,
            hooks: [...(roleExtension.hooks ?? []), pauseAfterLostResponse],
          },
          ...rest,
        ],
        agent: normalRole.agent,
      };
      const provider = `google-recover-${kind}`;
      const firstFaux = fauxProvider({ provider, models: [{ id: "model" }] });
      firstFaux.setResponses([
        fauxAssistantMessage(
          fauxToolCall(
            `${kind}_appointment`,
            kind === "reschedule"
              ? { id: seeded.id, start: "2030-01-15T10:00:00Z" }
              : { id: seeded.id },
          ),
          { stopReason: "toolUse" },
        ),
      ]);
      const firstModels = createModels();
      firstModels.setProvider(firstFaux.provider);
      const solo = await openSolo({
        directory,
        role: interrupted,
        models: firstModels,
        model: { provider, modelId: "model" },
        connectorIdentity: identity,
      });
      const pending = solo.submit(`please ${kind}`, `google-${kind}-request`);
      await barrier;
      const [submission] = (await solo.harness.inspect(BACKGROUND_CONTEXT)).submissions;
      expect(writes).toBe(1);
      await solo.close();
      await expect(pending).rejects.toThrow();

      const resumedFaux = fauxProvider({ provider, models: [{ id: "model" }] });
      resumedFaux.setResponses([fauxAssistantMessage("Recovered the original request.")]);
      const resumedModels = createModels();
      resumedModels.setProvider(resumedFaux.provider);
      const reopened = await openSolo({
        directory,
        role: normalRole,
        models: resumedModels,
        connectorIdentity: identity,
      });
      const [result] = await reopened.resume();
      expect(result?.submissionId).toBe(submission?.id);
      expect(result?.settlement.status).toBe("done");
      expect(approvals).toBe(1);
      expect(writes).toBe(1);
      expect(await calendar.listBookings()).toEqual(
        kind === "reschedule" ? [{ ...seeded, start: "2030-01-15T10:00:00Z" }] : [],
      );
      await reopened.close();
      calendar.close();
    },
  );

  it("serializes parallel Harness booking tools so one contested slot is written once", async () => {
    const directory = temporary();
    const decisions = openLocalCalendar(join(directory, "calendar.sqlite"));
    const events = new Map<string, Record<string, unknown>>();
    const order: string[] = [];
    const transport: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/freeBusy")) {
        const busy = [...events.values()].map((event) => ({
          start: (event.start as Record<string, unknown>).dateTime,
          end: (event.end as Record<string, unknown>).dateTime,
        }));
        order.push("availability");
        await new Promise<void>((resolve) => setImmediate(resolve));
        return new Response(JSON.stringify({ calendars: { cal: { busy } } }), { status: 200 });
      }
      if (url.pathname.endsWith("/events") && init.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const event = { ...body, status: "confirmed", etag: '"etag"' };
        events.set(String(body.id), event);
        order.push("insert");
        return new Response(JSON.stringify(event), { status: 200 });
      }
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const event = events.get(id);
      return new Response(JSON.stringify(event ?? {}), { status: event === undefined ? 404 : 200 });
    };
    const portable = createGoogleCalendar({
      calendarId: "cal",
      getAccessToken: async () => "token",
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
      fetch: transport,
    });
    const calendar = createGoogleCalendarHost({ client: portable, decisions, durationMinutes: 60 });
    const faux = fauxProvider({ provider: "parallel", models: [{ id: "model" }] });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "book_appointment",
            { start: "2030-01-15T09:00:00Z", customer: "A" },
            { id: "call-a" },
          ),
          fauxToolCall(
            "book_appointment",
            { start: "2030-01-15T09:00:00Z", customer: "B" },
            { id: "call-b" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Finished."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const solo = await openSolo({
      directory,
      role: frontdesk({ calendar, approve: async () => ({ approved: true, by: "test" }) }),
      models,
      model: { provider: "parallel", modelId: "model" },
      connectorIdentity: {
        version: 1,
        backend: "google",
        calendarId: "cal",
        timeZone: "UTC",
        workingHours: { start: "09:00", end: "12:00" },
        durationMinutes: 60,
      },
    });
    const result = await solo.submit("Book A and B in the same slot", "parallel-bookings");
    expect(result.settlement.status).toBe("done");
    expect(events).toHaveLength(1);
    expect(order).toEqual(["availability", "insert", "availability"]);
    await solo.close();
    calendar.close();
  });

  it("serializes two parallel Harness moves to one target and continues after the rejection", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const first = await calendar.book("2030-01-15T09:00:00Z", "A", "seed-a");
    const second = await calendar.book("2030-01-15T10:00:00Z", "B", "seed-b");
    let approvals = 0;
    const faux = fauxProvider({ provider: "parallel-moves", models: [{ id: "model" }] });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "reschedule_appointment",
            { id: first.id, start: "2030-01-15T11:00:00Z" },
            { id: "move-a" },
          ),
          fauxToolCall(
            "reschedule_appointment",
            { id: second.id, start: "2030-01-15T11:00:00Z" },
            { id: "move-b" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("cancel_appointment", { id: first.id }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Finished."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const solo = await openSolo({
      directory,
      role: frontdesk({
        calendar,
        approve: async () => {
          approvals += 1;
          return { approved: true, by: "test" };
        },
      }),
      models,
      model: { provider: "parallel-moves", modelId: "model" },
    });
    const result = await solo.submit("Move both, then cancel A", "parallel-moves");
    expect(result.settlement.status).toBe("done");
    expect(approvals).toBe(3);
    const active = await calendar.listBookings();
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(second.id);
    expect(["2030-01-15T10:00:00Z", "2030-01-15T11:00:00Z"]).toContain(active[0]?.start);
    expect(calendar.canceledBooking(first.id)).toBeDefined();
    await solo.close();
    calendar.close();
  });

  it("serializes a parallel Harness move and cancellation on one booking to a consistent tombstone", async () => {
    const directory = temporary();
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const seeded = await calendar.book("2030-01-15T09:00:00Z", "Guest", "seed");
    let approvals = 0;
    const faux = fauxProvider({ provider: "parallel-move-cancel", models: [{ id: "model" }] });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "reschedule_appointment",
            { id: seeded.id, start: "2030-01-15T10:00:00Z" },
            { id: "move" },
          ),
          fauxToolCall("cancel_appointment", { id: seeded.id }, { id: "cancel" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Finished."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const solo = await openSolo({
      directory,
      role: frontdesk({
        calendar,
        approve: async () => {
          approvals += 1;
          return { approved: true, by: "test" };
        },
      }),
      models,
      model: { provider: "parallel-move-cancel", modelId: "model" },
    });
    const result = await solo.submit("Move and cancel together", "parallel-move-cancel");
    expect(result.settlement.status).toBe("done");
    expect(approvals).toBe(2);
    expect(await calendar.listBookings()).toEqual([]);
    expect(calendar.canceledBooking(seeded.id)).toEqual({
      id: seeded.id,
      status: "canceled",
      alreadyCanceled: false,
    });
    await solo.close();
    calendar.close();
  });

  it("serializes parallel Google Harness moves and accepts a successful call after one rejects", async () => {
    const directory = temporary();
    const identity = {
      version: 1 as const,
      backend: "google" as const,
      calendarId: "cal",
      timeZone: "UTC" as const,
      workingHours: { start: "09:00" as const, end: "12:00" as const },
      durationMinutes: 60 as const,
    };
    writeFileSync(join(directory, "connector.json"), `${JSON.stringify(identity)}\n`);
    const decisions = openLocalCalendar(join(directory, "calendar.sqlite"));
    const rest = googleMutationFixture();
    const client = createGoogleCalendar({
      calendarId: "cal",
      getAccessToken: async () => "token",
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
      fetch: rest.transport,
    });
    const calendar = createGoogleCalendarHost({ client, decisions, durationMinutes: 60 });
    const first = await calendar.book("2030-01-15T09:00:00Z", "A", "seed-a");
    const second = await calendar.book("2030-01-15T10:00:00Z", "B", "seed-b");
    let approvals = 0;
    const faux = fauxProvider({ provider: "parallel-google-moves", models: [{ id: "model" }] });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "reschedule_appointment",
            { id: first.id, start: "2030-01-15T11:00:00Z" },
            { id: "move-a" },
          ),
          fauxToolCall(
            "reschedule_appointment",
            { id: second.id, start: "2030-01-15T11:00:00Z" },
            { id: "move-b" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("cancel_appointment", { id: first.id }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Finished."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const solo = await openSolo({
      directory,
      role: frontdesk({
        calendar,
        approve: async () => {
          approvals += 1;
          return { approved: true, by: "test" };
        },
      }),
      models,
      model: { provider: "parallel-google-moves", modelId: "model" },
      connectorIdentity: identity,
    });
    expect(
      (await solo.submit("Compete, then cancel A", "parallel-google-moves")).settlement.status,
    ).toBe("done");
    expect(approvals).toBe(3);
    expect(rest.writes).toEqual({ posts: 2, patches: 1, deletes: 1 });
    const active = await calendar.listBookings();
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(second.id);
    expect(["2030-01-15T10:00:00Z", "2030-01-15T11:00:00Z"]).toContain(active[0]?.start);
    await solo.close();
    calendar.close();
  });

  it("serializes a parallel Google Harness move and cancellation with one consistent final state", async () => {
    const directory = temporary();
    const identity = {
      version: 1 as const,
      backend: "google" as const,
      calendarId: "cal",
      timeZone: "UTC" as const,
      workingHours: { start: "09:00" as const, end: "12:00" as const },
      durationMinutes: 60 as const,
    };
    writeFileSync(join(directory, "connector.json"), `${JSON.stringify(identity)}\n`);
    const decisions = openLocalCalendar(join(directory, "calendar.sqlite"));
    const rest = googleMutationFixture();
    const client = createGoogleCalendar({
      calendarId: "cal",
      getAccessToken: async () => "token",
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
      fetch: rest.transport,
    });
    const calendar = createGoogleCalendarHost({ client, decisions, durationMinutes: 60 });
    const seeded = await calendar.book("2030-01-15T09:00:00Z", "Guest", "seed");
    let approvals = 0;
    const faux = fauxProvider({ provider: "parallel-google-cancel", models: [{ id: "model" }] });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "reschedule_appointment",
            { id: seeded.id, start: "2030-01-15T10:00:00Z" },
            { id: "move" },
          ),
          fauxToolCall("cancel_appointment", { id: seeded.id }, { id: "cancel" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Finished."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const solo = await openSolo({
      directory,
      role: frontdesk({
        calendar,
        approve: async () => {
          approvals += 1;
          return { approved: true, by: "test" };
        },
      }),
      models,
      model: { provider: "parallel-google-cancel", modelId: "model" },
      connectorIdentity: identity,
    });
    expect((await solo.submit("Move and cancel", "parallel-google-cancel")).settlement.status).toBe(
      "done",
    );
    expect(approvals).toBe(2);
    expect(rest.writes.posts).toBe(1);
    expect(rest.writes.deletes).toBe(1);
    expect(rest.writes.patches).toBeLessThanOrEqual(1);
    expect(await calendar.listBookings()).toEqual([]);
    await solo.close();
    calendar.close();
  });
});
