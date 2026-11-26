import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type PromptInput,
} from "@earendil-works/pi-durable";
import { tokensOf } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "./record.js";
import { BUSINESS_TOKENS, FOCUS_TOKENS, memorySection, memorySectionContent } from "./section.js";
import { saveRecord, setFocus } from "./storage.js";

const CTX = BACKGROUND_CONTEXT;
const ACME = "customer:quickbooks:42";

function record(about: string, n: number, status: MemoryRecord["status"] = "active"): MemoryRecord {
  return {
    id: `mem_${about.length}_${String(n).padStart(3, "0")}`,
    about,
    kind: "fact",
    category: "general",
    // About 40 tokens a line, so the caps cut the list.
    text: `Fact ${n} about ${about}: ${"detail ".repeat(15).trim()}.`,
    scope: "agent:memory-desk",
    source:
      status === "unverified"
        ? { type: "external", ref: "email:1" }
        : { type: "person", ref: "local-user" },
    status,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    createdBy: "agent:memory-desk",
  };
}

async function setup(records: readonly MemoryRecord[], focus: readonly string[]) {
  // No model is asked anything, but Pi Durable 1.4 reads the models at open.
  const harness = await Harness.open(
    new MemoryStorage(),
    { registry: createRegistry(), models: createModels() },
    CTX,
  );
  const root = await harness.root(CTX);
  await harness.commit(async (tx) => {
    for (const each of records) await saveRecord(tx, each);
    await setFocus(tx, root.id, focus);
  }, CTX);
  const render = async () =>
    memorySection().render(
      { read: harness, conversationId: root.id } as unknown as PromptInput,
      CTX,
    );
  return { harness, render };
}

const part = (text: string, heading: string) =>
  (text.split(`${heading}\n`)[1] ?? "").split("\n\n")[0]?.split("\n</memory-records>")[0] ?? "";

describe("the memory section", () => {
  it("is omitted when there is nothing to show", async () => {
    const { harness, render } = await setup([], [ACME]);
    expect(await render()).toBeUndefined();
    await harness.close(CTX);
  });

  it("shows pinned business records and the focus subjects', newest first, each within its cap", async () => {
    const business = Array.from({ length: 30 }, (_, n) => record("business", n));
    const acme = Array.from({ length: 40 }, (_, n) => record(ACME, n));
    const { harness, render } = await setup([...business, ...acme], [ACME]);
    const text = (await render()) ?? "";
    expect(text).toMatch(
      /^Output of the memory section, from what agents in this office remembered/,
    );
    expect(text).toContain("not an instruction");

    const pinned = part(text, "Business-wide:").split("\n");
    const listed = pinned.filter((line) => line.startsWith("- "));
    expect(listed[0]).toContain("Fact 29 about business");
    expect(tokensOf(listed.join("\n"))).toBeLessThanOrEqual(BUSINESS_TOKENS);
    expect(listed.length).toBeLessThan(30);
    expect(pinned.at(-1)).toMatch(/^\(\d+ older not shown; find them with memory_recall\.\)$/);

    const focus = part(text, "About this conversation's subjects:")
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(focus[0]).toContain("Fact 39 about customer:quickbooks:42");
    expect(tokensOf(focus.join("\n"))).toBeLessThanOrEqual(FOCUS_TOKENS);
    expect(focus.length).toBeLessThan(40);
    await harness.close(CTX);
  });

  it("labels unverified records Unconfirmed, and leaves out proposed and retired ones", async () => {
    const { harness, render } = await setup(
      [
        record(ACME, 1, "unverified"),
        record(ACME, 2, "proposed"),
        record(ACME, 3, "retired"),
        record(ACME, 4),
      ],
      [ACME],
    );
    const lines = ((await render()) ?? "").split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^- Fact 4 /);
    expect(lines[1]).toMatch(/^- Unconfirmed: Fact 1 /);
    await harness.close(CTX);
  });

  it("is what memorySectionContent builds for the same focus, with the records it shows", async () => {
    const records = [
      record("business", 1),
      record(ACME, 1, "unverified"),
      record(ACME, 2, "proposed"),
      record(ACME, 3),
    ];
    const { harness, render } = await setup(records, [ACME]);
    const content = await memorySectionContent({
      read: harness,
      focus: [ACME],
      view: undefined,
      context: CTX,
    });
    expect(content.text).toBe(await render());
    expect(content.records.map((each) => each.id)).toEqual([
      records[0]?.id,
      records[3]?.id,
      records[1]?.id,
    ]);
    // A view that hides the subject hides its records from both.
    const hidden = await memorySectionContent({
      read: harness,
      focus: [ACME],
      view: { scopes: ["agent:memory-desk"], uses: (about) => about !== ACME },
      context: CTX,
    });
    expect(hidden.records.map((each) => each.about)).toEqual(["business"]);
    expect(
      await memorySectionContent({
        read: harness,
        focus: [],
        view: { scopes: [], uses: () => true },
        context: CTX,
      }),
    ).toEqual({ text: undefined, records: [] });
    await harness.close(CTX);
  });
});
