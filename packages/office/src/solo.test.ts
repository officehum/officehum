import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
import { hook, ToolTask } from "@earendil-works/pi-durable";
import type { Approver, RoleBundle } from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import frontdesk from "../../../agents/frontdesk/src/index.js";
import { createGoogleCalendar } from "../../google-calendar/src/index.js";
import { createDemoModels } from "./demo-model.js";
import { createGoogleCalendarHost } from "./google-calendar.js";
import { openLocalCalendar } from "./local-calendar.js";
import { openSolo } from "./solo.js";

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
    const calendar = openLocalCalendar(join(directory, "calendar.sqlite"));
    const role = frontdesk({ calendar });
    const runtime = scriptedModels();
    const original = await openSolo({ directory, role, ...runtime });
    const registrations = role.extensions.flatMap((extension) => extension.tools ?? []);
    const oldTools = registrations.filter((tool) =>
      ["check_schedule", "book_appointment"].includes(tool.name),
    );
    await original.root.configure({ tools: oldTools }, BACKGROUND_CONTEXT);
    const originalAgent = await original.root.agent(BACKGROUND_CONTEXT);
    expect(originalAgent.tools.map(({ name }) => name).sort()).toEqual([
      "book_appointment",
      "check_schedule",
    ]);
    const rootId = original.root.id;
    const model = originalAgent.model;
    await original.close();

    const reopened = await openSolo({ directory, role, models: runtime.models });
    expect(reopened.root.id).toBe(rootId);
    expect((await reopened.root.agent(BACKGROUND_CONTEXT)).model).toEqual(model);
    expect((await reopened.root.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "check_schedule",
        "book_appointment",
        "list_bookings",
        "reschedule_appointment",
        "cancel_appointment",
      ]),
    );
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
