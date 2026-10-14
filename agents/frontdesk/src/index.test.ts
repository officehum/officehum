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
import { checkAgent, validatePackage } from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalCalendar } from "../../../packages/office/src/local-calendar.js";
import manifest from "../officehum.json" with { type: "json" };
import frontdesk from "./index.js";

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

describe("frontdesk role", () => {
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
});
