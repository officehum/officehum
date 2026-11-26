/**
 * Test helpers: a store, the fixture role, a scripted model and a way to run tool calls in a
 * conversation. Kept out of the build (see `tsconfig.json`), typechecked by `tsconfig.test.json`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, JsonObject } from "@earendil-works/pi-durable";
import {
  type AgentManifest,
  type Approver,
  type DefinedRole,
  defineRole,
  localVersionedFileStore,
  type VersionedFileStore,
} from "@officehum/sdk";
import type { ESignature } from "./esign.js";
import { eSignaturePack } from "./tools.js";

const temps: string[] = [];

export function tempDir(prefix = "esign-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function tempStore(): VersionedFileStore {
  return localVersionedFileStore(join(tempDir(), "files"));
}

/** A small PDF saved as an internal draft, as a role's own contract would be. */
export async function savedContract(store: VersionedFileStore, text = "contract"): Promise<string> {
  const ref = await store.put({
    bytes: new TextEncoder().encode(`%PDF-1.7\n% ${text}\n%%EOF\n`),
    name: "service-agreement.pdf",
    mimeType: "application/pdf",
    metadata: { createdBy: "role:signing-desk", source: "generated" },
  });
  return ref.id;
}

export const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/signing-desk", import.meta.url));
export const FIXTURE_MANIFEST = JSON.parse(
  readFileSync(new URL("../fixtures/signing-desk/officehum.json", import.meta.url), "utf8"),
) as AgentManifest;

/** The fixture role: the pack's five tools, its approval facts and the given approver. */
export function signingDesk(options: {
  esign: ESignature;
  store: VersionedFileStore;
  approve?: Approver;
}): DefinedRole {
  const pack = eSignaturePack({
    esign: options.esign,
    store: options.store,
    createdBy: "role:signing-desk",
  });
  return defineRole({
    packageDir: FIXTURE_DIR,
    manifest: FIXTURE_MANIFEST,
    tools: pack.tools,
    approvalFacts: pack.approvalFacts,
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
}

export type Turn = { readonly tool: string; readonly args: JsonObject } | { readonly text: string };

/** A scripted model: each request takes the next turn, and answers "Done." when there is none. */
export function scriptedModel() {
  const faux = fauxProvider({
    provider: "scripted",
    api: "scripted",
    models: [{ id: "scripted-1" }],
  });
  const turns: Turn[] = [];
  const respond: FauxResponseFactory = (_context, _options, _state, model) => {
    faux.appendResponses([respond]);
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
  return { models, turns };
}

/** Runs the queued tool calls in `conversation`, then returns each tool result's text. */
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
      (message.content as { type: string; text?: string }[])
        .map((block) => block.text ?? "")
        .join(""),
    );
}
