/** Helpers shared by the SDK's tests. Not exported from the package. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { JsonObject } from "@earendil-works/pi-durable";

export const SAMPLE_DIR = fileURLToPath(new URL("../fixtures/sample-desk", import.meta.url));
export const ACME_OVERLAY = fileURLToPath(new URL("../fixtures/overlays/acme", import.meta.url));
export const STOCKROOM_DIR = fileURLToPath(
  new URL("../fixtures/sample-stockroom", import.meta.url),
);
/** A business's overlay for the Sample Stockroom: it changes one named limit and leaves the rest. */
export const STOCKROOM_OVERLAY = fileURLToPath(
  new URL("../fixtures/overlays/acme-stockroom", import.meta.url),
);

const temps: string[] = [];

/** Writes files (path → content) into a new temporary directory named `name` and returns its path. */
export function tempDir(name: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "officehum-sdk-"));
  temps.push(root);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** Removes every directory `tempDir` made. Call from `afterEach`. */
export function removeTempDirs(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A SKILL.md with the given frontmatter lines and body. */
export function skillFile(frontmatter: string, body = "Do the work."): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

/** One turn of a scripted model: a reply, or a tool call. */
export type ScriptTurn =
  | { readonly text: string }
  | { readonly tool: string; readonly args: JsonObject };

/**
 * A scripted model for a real Pi Durable harness: each request is answered by `script`, which also
 * sees the tools offered. `offered` records the tool names of every request.
 */
export function scripted(
  script: (messages: readonly Message[], tools: readonly string[]) => ScriptTurn,
) {
  const faux = fauxProvider({
    provider: "scripted",
    api: "scripted",
    models: [{ id: "scripted-1" }],
  });
  const offered: string[][] = [];
  const respond: FauxResponseFactory = (context, _options, _state, model) => {
    faux.appendResponses([respond]);
    const tools = getCurrentTools(context.messages).map((tool) => tool.name);
    offered.push(tools);
    const turn = script(context.messages, tools);
    const message =
      "text" in turn
        ? fauxAssistantMessage(turn.text)
        : fauxAssistantMessage(fauxToolCall(turn.tool, turn.args), { stopReason: "toolUse" });
    return { ...message, provider: model.provider, model: model.id };
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: { provider: "scripted", modelId: "scripted-1" }, offered };
}

/** Calls `tool` once, then answers with the last tool result's text. */
export const callOnce =
  (tool: string, args: JsonObject) =>
  (messages: readonly Message[]): ScriptTurn => {
    const results = messages.filter((message) => message.role === "toolResult");
    if (results.length === 0) return { tool, args };
    const last = results.at(-1) as { content: { type: string; text?: string }[] };
    return { text: `Tool said: ${last.content.map((block) => block.text ?? "").join("")}` };
  };

/** The text of the last assistant message. */
export const lastAnswer = (messages: readonly Message[]) => {
  const answer = messages.filter((message) => message.role === "assistant").at(-1) as
    | { content: { type: string; text?: string }[] }
    | undefined;
  return (answer?.content ?? []).map((block) => block.text ?? "").join("");
};
