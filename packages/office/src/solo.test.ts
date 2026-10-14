import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createDemoModels } from "./demo-model.js";
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
});
