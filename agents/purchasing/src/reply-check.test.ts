/**
 * The reply check on a real Pi Durable harness: a final reply that names a purchase order the desk
 * does not hold goes back to the model once, with the desk's answer, before the run ends. A scripted
 * model plays the replies; the desk is `fakePurchasingDesk`, which holds PO-1001 to PO-1004.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  type ScriptedTurn,
  scriptedProvider,
} from "../../../packages/office/src/testing/scripted-model.js";
import { fakePurchasingDesk } from "./desk.js";
import purchasing from "./index.js";
import { purchaseOrderIds } from "./reply-check.js";

function textOf(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return ((content ?? []) as { type?: string; text?: string }[])
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
}

/** Runs each input as its own run in one conversation; returns each run's answer and the requests. */
async function conversation(inputs: readonly string[], turns: readonly ScriptedTurn[]) {
  const role = purchasing({ desk: fakePurchasingDesk() });
  const scripted = scriptedProvider(turns);
  const registry = createRegistry();
  for (const extension of role.extensions) registry.install(extension);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: scripted.models, registry },
    BACKGROUND_CONTEXT,
  );
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { ...role.agent, model: scripted.model },
  });
  const answers: string[] = [];
  for (const input of inputs) {
    const submission = await root.submit({ type: "input", content: input }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    if (settled.status !== "done" || settled.type !== "input")
      throw new Error("run did not settle");
    await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
    const view = await root.context(BACKGROUND_CONTEXT);
    const last = [...view.messages].reverse().find((message) => message.role === "assistant");
    answers.push(last === undefined ? "" : textOf(last));
  }
  const users = (await root.context(BACKGROUND_CONTEXT)).messages
    .filter((message) => message.role === "user")
    .map(textOf);
  await harness.close(BACKGROUND_CONTEXT);
  return { answers, users, calls: scripted.calls };
}

describe("purchasing reply check", () => {
  it("finds every purchase order number a reply names, once each", () => {
    expect(
      purchaseOrderIds("PO-1003 and po-9999, then PO-1003 again; not PO1003 or XPO-12"),
    ).toEqual(["PO-1003", "PO-9999"]);
  });

  it("a reply naming a purchase order the desk does not hold goes back to the model once", async () => {
    const run = await conversation(
      ["The delivery note says PO-9999. Book it in."],
      [
        { text: "Recorded the delivery against PO-9999." },
        { text: "The desk has no PO-9999, so nothing was recorded. Which order is it?" },
      ],
    );
    expect(run.calls).toBe(2);
    expect(run.answers).toEqual([
      "The desk has no PO-9999, so nothing was recorded. Which order is it?",
    ]);
    const check = run.users.find((text) => text.startsWith("Desk check:"));
    expect(check).toContain("The purchasing desk holds no purchase order PO-9999");
  });

  it("a reply naming only orders the desk holds goes out as written", async () => {
    const run = await conversation(
      ["Where is PO-1003?"],
      [{ text: "PO-1003 is placed and due today; PO-1004 is a draft." }],
    );
    expect(run.calls).toBe(1);
    expect(run.users.some((text) => text.startsWith("Desk check:"))).toBe(false);
  });

  it("checks once per run, so a reply that names the order again goes out", async () => {
    const run = await conversation(
      ["PO-9999 arrived."],
      [
        { text: "PO-9999 is not one of our orders." },
        { text: "PO-9999 is not one of our orders, so nothing was recorded." },
      ],
    );
    expect(run.calls).toBe(2);
    expect(run.answers).toEqual(["PO-9999 is not one of our orders, so nothing was recorded."]);
  });

  it("checks each run afresh", async () => {
    const run = await conversation(
      ["PO-9999 arrived.", "And PO-8888?"],
      [
        { text: "PO-9999 is not on file." },
        { text: "PO-9999 is not on file; nothing was recorded." },
        { text: "PO-8888 was placed last week." },
        { text: "PO-8888 is not on file either." },
      ],
    );
    expect(run.calls).toBe(4);
    expect(run.answers).toEqual([
      "PO-9999 is not on file; nothing was recorded.",
      "PO-8888 is not on file either.",
    ]);
  });
});
