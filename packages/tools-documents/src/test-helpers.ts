/**
 * Test helpers: the fixtures, a scripted model, a recording file store. Kept out of the build (see
 * `tsconfig.json`), typechecked by `tsconfig.test.json`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
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
  type DefinedRole,
  defineRole,
  type FileMetadata,
  type VersionedFileRef,
  type VersionedFileStore,
} from "@officehum/sdk";
import {
  DEFAULT_LIMITS,
  type DocumentLease,
  type LeasedInput,
  resolvePaperInterpreter,
} from "@officehum/tools-paper-office";
import { DOCUMENT_MIME, type DocumentKind } from "./reading.js";

export const FIXTURES = new URL("../fixtures/", import.meta.url);

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, FIXTURES)));
}

/** The interpreter the host configured, or `undefined` when there is none. */
export function configuredInterpreter(): string | undefined {
  return resolvePaperInterpreter(process.env);
}

/** Puts a fixture into a store, as an upload or as a file from outside the office. */
export async function putFixture(
  store: VersionedFileStore,
  name: string,
  kind: DocumentKind,
  source: FileMetadata["source"] = "uploaded",
): Promise<VersionedFileRef> {
  return store.put({
    bytes: fixture(name),
    name,
    mimeType: DOCUMENT_MIME[kind],
    metadata: {
      createdBy: "person:test",
      source,
      ...(source === "external" ? { provenance: "external" as const } : {}),
    },
  });
}

export function leasedInput(ref: VersionedFileRef, format: "docx" | "xlsx"): LeasedInput {
  return {
    fileId: ref.id,
    versionId: ref.versionId,
    name: ref.name,
    format,
    sha256: ref.sha256,
    size: ref.size,
    writable: false,
  };
}

export function leaseOf(inputs: readonly LeasedInput[], taskId = "task:1"): DocumentLease {
  return {
    leaseId: "lease:read",
    taskId,
    inputs,
    outputFormats: ["docx"],
    limits: DEFAULT_LIMITS,
    expiresAt: "2999-01-01T00:00:00.000Z",
  };
}

export const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/reading-desk", import.meta.url));
export const FIXTURE_MANIFEST = JSON.parse(
  readFileSync(new URL("../fixtures/reading-desk/officehum.json", import.meta.url), "utf8"),
) as AgentManifest;

/** The fixture role: the reading pack's three tools and nothing else. */
export function readingDesk(tools: DefinedRole["extensions"][number]["tools"]): DefinedRole {
  return defineRole({
    packageDir: FIXTURE_DIR,
    manifest: FIXTURE_MANIFEST,
    tools: tools ?? [],
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

/**
 * A scripted extraction model: each request is recorded, and answered by `answer` (a tool call's
 * arguments, or a whole message). It takes images unless `input` says otherwise.
 */
export function extractionModel(
  answer: JsonObject | ((context: TranscriptContext) => AssistantMessage),
  options: {
    readonly input?: ("text" | "image")[];
    readonly tool?: string;
    /** How long the model takes to answer, as a slow live model would. */
    readonly delayMs?: number;
  } = {},
) {
  const faux = fauxProvider({
    provider: "scripted-vision",
    api: "scripted-vision",
    models: [{ id: "vision-1", input: options.input ?? ["text", "image"] }],
  });
  const requests: TranscriptContext[] = [];
  const respond: FauxResponseFactory = async (context, _options, _state, model) => {
    faux.appendResponses([respond]);
    requests.push(context);
    if (options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    const message =
      typeof answer === "function"
        ? answer(context)
        : fauxAssistantMessage(
            fauxToolCall(options.tool ?? toolOffered(context) ?? "record", answer),
            { stopReason: "toolUse" },
          );
    return { ...message, provider: model.provider, model: model.id };
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    models,
    model: { provider: "scripted-vision", modelId: "vision-1" } as const,
    requests,
  };
}

/** The name of the one tool a request offers, read from its system messages. */
function toolOffered(context: TranscriptContext): string | undefined {
  for (const message of context.messages) {
    const added = (message as { toolsAdded?: { name: string }[] }).toolsAdded;
    if (added?.[0] !== undefined) return added[0].name;
  }
  return undefined;
}

/** A value as an extraction model cites it: the value, its page and its line. */
export function cited(value: string | null, line: number | null, page: number | null = 1) {
  return value === null ? { value: null, page: null, line: null } : { value, page, line };
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
      (message.content as { type: string; text?: string }[]).map((b) => b.text ?? "").join(""),
    );
}
