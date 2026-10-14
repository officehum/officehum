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
});
