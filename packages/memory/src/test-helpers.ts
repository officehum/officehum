/** Helpers for the memory tests: the fixture role and a scripted model. Not exported. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import type { Conversation, JsonObject } from "@earendil-works/pi-durable";
import { type AgentManifest, type DefinedRole, defineRole } from "@officehum/sdk";
import { MEMORY_HYGIENE_SKILL } from "./extension.js";

export const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/memory-desk", import.meta.url));
export const FIXTURE_MANIFEST = JSON.parse(
  readFileSync(new URL("../fixtures/memory-desk/officehum.json", import.meta.url), "utf8"),
) as AgentManifest;

/** The fixture role: no tools of its own, the memory-hygiene skill merged into its skills. */
export function memoryDesk(): DefinedRole {
  return defineRole({
    packageDir: FIXTURE_DIR,
    manifest: FIXTURE_MANIFEST,
    extraSkills: [MEMORY_HYGIENE_SKILL],
  });
}

export type Turn = { readonly tool: string; readonly args: JsonObject } | { readonly text: string };

/**
 * A scripted model: each request takes the next turn from the queue, and answers "Done." when it is
 * empty. `prompts` records each request's system prompt.
 */
export function scriptedModel() {
  const faux = fauxProvider({
    provider: "scripted",
    api: "scripted",
    models: [{ id: "scripted-1" }],
  });
  const turns: Turn[] = [];
  const prompts: string[] = [];
  const respond: FauxResponseFactory = (context, _options, _state, model) => {
    faux.appendResponses([respond]);
    prompts.push(getCurrentSystemPrompt(context.messages));
    const turn = turns.shift() ?? { text: "Done." };
    const message =
      "text" in turn
        ? fauxAssistantMessage(turn.text)
        : fauxAssistantMessage(fauxToolCall(turn.tool, turn.args), { stopReason: "toolUse" });
    return { ...message, provider: model.provider, model: model.id };
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, turns, prompts };
}

/** Runs the queued turns as tool calls in `conversation`, then returns each tool result's text. */
export async function callTools(
  model: ReturnType<typeof scriptedModel>,
  conversation: Conversation,
  calls: readonly { readonly tool: string; readonly args: JsonObject }[],
): Promise<string[]> {
  const before = (await conversation.context(BACKGROUND_CONTEXT)).messages.length;
  model.turns.push(...calls);
  const submission = await conversation.submit(
    { type: "input", content: "Go ahead." },
    BACKGROUND_CONTEXT,
  );
  await submission.wait(BACKGROUND_CONTEXT);
  const messages = (await conversation.context(BACKGROUND_CONTEXT)).messages.slice(before);
  return messages
    .filter((message) => message.role === "toolResult")
    .map((message) =>
      (message.content as { type: string; text?: string }[]).map((b) => b.text ?? "").join(""),
    );
}
