/**
 * Tests for the scripted model provider: a two-turn script settles a role, the recording shows what
 * the model actually saw, and a script that runs out fails with a message naming the turn.
 *
 * No network, no real model, no credential.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { RoleBundle } from "@officehum/sdk";
import { describe, expect, it } from "vitest";
import { openOffice, ROOT_KEY } from "../adapter/index.js";
import { scriptedProvider } from "./scripted-model.js";

/** The text a fixture role renders into its prompt section, so a test can find it in a request. */
const GREETING = "Greet every visitor by their name.";

/** A fixture role: one tool with a run counter, and one prompt section. */
function fixtureRole(model: ModelRef): {
  bundle: RoleBundle;
  runs: { count: number };
} {
  const runs = { count: 0 };
  const checkSchedule = defineTool({
    name: "check_schedule",
    description: "List the free slots for a date.",
    parameters: Type.Object({ date: Type.String() }),
    replay: "safe",
    execute: async () => {
      runs.count += 1;
      return { output: [{ type: "text" as const, text: "09:00Z" }] };
    },
  });
  const extension = defineExtension({
    name: "frontdesk",
    tools: [checkSchedule],
    sections: [section("frontdesk-greeting", () => GREETING)],
  });
  return {
    runs,
    bundle: {
      extensions: [extension],
      agent: {
        model,
        extensions: [extension],
        instructions: "You are the front desk.",
      },
    },
  };
}

describe("scriptedProvider", () => {
  it("drives a fixture role to settled with a two-turn script and records what the model saw", async () => {
    const scripted = scriptedProvider([
      { toolCalls: [{ name: "check_schedule", args: { date: "2030-01-15" } }] },
      { text: "The 09:00 slot is free." },
    ]);
    // Any modelId under the scripted provider resolves, even one the provider never declared.
    const { bundle, runs } = fixtureRole({ provider: "scripted", modelId: "frontdesk-eval" });

    const office = await openOffice({ storage: "memory", models: scripted.models });
    office.install(bundle);
    const conversation = await office.conversation(ROOT_KEY, { agent: bundle.agent });
    const submitted = await office.submit(conversation, { input: "Any slots?", requestId: "once" });
    expect((await submitted.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    await office.close();

    expect(runs.count).toBe(1);
    expect(scripted.calls).toBe(2);

    // One request per model call, in order: the tool call, then the answer the tool result earned.
    expect(scripted.requests).toHaveLength(2);
    const [first, second] = scripted.requests;
    expect(first?.tools).toEqual([
      { name: "check_schedule", description: "List the free slots for a date." },
    ]);
    expect(second?.tools.map((tool) => tool.name)).toEqual(["check_schedule"]);
    // The role's section and instructions reached the model verbatim.
    expect(first?.sections["frontdesk-greeting"]).toContain(GREETING);
    expect(first?.system).toContain("You are the front desk.");
    expect(first?.model).toBe("frontdesk-eval");
    expect(first?.provider).toBe("scripted");
    // The second request carries the tool result the first turn's call produced.
    expect(second?.messages.some((message) => message.role === "toolResult")).toBe(true);
  });

  it("keeps the system prompt and its sections byte-identical across a conversation", async () => {
    const scripted = scriptedProvider([
      { toolCalls: [{ name: "check_schedule", args: { date: "2030-01-15" } }] },
      { toolCalls: [{ name: "check_schedule", args: { date: "2030-01-16" } }] },
      { text: "Both days are open." },
    ]);
    const { bundle } = fixtureRole(scripted.model);

    const office = await openOffice({ storage: "memory", models: scripted.models });
    office.install(bundle);
    const conversation = await office.conversation(ROOT_KEY, { agent: bundle.agent });
    const submitted = await office.submit(conversation, { input: "Two days?", requestId: "twice" });
    expect((await submitted.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    await office.close();

    expect(scripted.calls).toBe(3);
    const [first, second, third] = scripted.requests;
    expect(first?.system).toBeDefined();
    // Stable content is byte-identical request to request, which is what a prompt-cache check keys on.
    expect(second?.system).toBe(first?.system);
    expect(third?.system).toBe(first?.system);
    expect(second?.sections).toEqual(first?.sections);
    expect(third?.sections).toEqual(first?.sections);
  });

  it("fails loudly, naming the turn, when the script runs out", async () => {
    // One turn, but the tool call needs a follow-up the script does not have.
    const scripted = scriptedProvider([{ toolCalls: [{ name: "check_schedule", args: {} }] }]);
    const { bundle } = fixtureRole(scripted.model);

    const office = await openOffice({ storage: "memory", models: scripted.models });
    office.install(bundle);
    const conversation = await office.conversation(ROOT_KEY, { agent: bundle.agent });
    const submitted = await office.submit(conversation, { input: "go", requestId: "exhausted" });
    const settled = await submitted.wait(BACKGROUND_CONTEXT);
    await office.close();

    expect(settled.status).toBe("unanswered");
    if (settled.status !== "unanswered") throw new Error("expected an unanswered submission");
    expect(settled.reason).toBe("model_error");
    // The message names the request and the turn that was missing, not a bare `undefined`.
    expect(String(settled.detail)).toContain("ran out of script");
    expect(String(settled.detail)).toContain("turn 1");
    expect(scripted.calls).toBe(2);
  });

  it("branches on the transcript with a function script", async () => {
    // The function is the demo model's shape: call a tool until it has run, then answer.
    const scripted = scriptedProvider((messages) =>
      messages.some((message) => message.role === "toolResult")
        ? { text: "Booked." }
        : { toolCalls: [{ name: "check_schedule", args: { date: "2030-01-15" } }] },
    );
    const { bundle, runs } = fixtureRole(scripted.model);

    const office = await openOffice({ storage: "memory", models: scripted.models });
    office.install(bundle);
    const conversation = await office.conversation(ROOT_KEY, { agent: bundle.agent });
    const submitted = await office.submit(conversation, { input: "branch", requestId: "branch" });
    expect((await submitted.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    await office.close();

    expect(runs.count).toBe(1);
    expect(scripted.calls).toBe(2);
    // The branch saw the tool result, so the second request answers.
    expect(scripted.requests[1]?.tools.map((tool) => tool.name)).toEqual(["check_schedule"]);
  });
});
