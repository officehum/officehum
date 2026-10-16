/**
 * A scripted model provider for Pi Durable: it plays back a fixed script of assistant turns instead
 * of calling a model. Crash tests and evals run deterministically, offline and free in CI.
 *
 * A script is either a list of turns — a tool call, or an answer — or a function of the transcript
 * for branching on what the tool returned. The provider records every request (the messages and the
 * tools offered) and counts model calls, so a test can assert what the office actually sent.
 *
 * It sits on pi-ai's faux provider for the streaming protocol, and adds the two things faux does not
 * give: a script with a loud, position-naming failure when it runs out, and a request recording.
 * `@earendil-works/pi-durable`'s harness resolves a model with `Models.getModel(provider, id)` against
 * the provider's declared catalog, so a scripted provider serves any `modelId` a role declares — see
 * the catalog fallback below.
 */
import type {
  Api,
  JsonObject,
  Message,
  Model,
  Provider,
  SimpleStreamOptions,
  ThinkingLevel,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels, type Models, type MutableModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai/utils/transcript";
import type { ModelRef } from "@earendil-works/pi-durable";

/** The provider id every scripted provider registers under. */
export const SCRIPTED_PROVIDER_ID = "scripted";

/** The id of the catalog model the provider declares; other ids resolve the same way. */
export const SCRIPTED_MODEL_ID = "scripted-1";

/** The api label stamped on scripted responses and catalog entries; dispatch does not depend on it. */
const SCRIPTED_API = "scripted";

/** A catalog window large enough that the harness never compacts a scripted conversation. */
const CONTEXT_WINDOW = 128_000;
const MAX_TOKENS = 16_384;

/** One tool call a scripted turn makes, as it appears in a script. */
export type ScriptedToolCall = {
  readonly name: string;
  /** Arguments passed to the tool; omitted means `{}`. */
  readonly args?: JsonObject;
};

/**
 * One assistant turn: a tool call (the office runs the tool and calls again), or an answer (the run
 * settles). The two are exclusive, matching the two ways a run moves.
 */
export type ScriptedTurn =
  | { readonly text: string }
  | { readonly toolCalls: readonly ScriptedToolCall[] };

/**
 * A script: turns played back in order, or a function of the transcript so a turn can branch on what
 * came back (the demo does exactly this — call `check_schedule`, then book the slot it returned).
 */
export type ScriptedScript =
  | readonly ScriptedTurn[]
  | ((messages: readonly Message[]) => ScriptedTurn);

/** A tool the model was offered, as the transcript declares it. */
export type ScriptedTool = {
  readonly name: string;
  readonly description: string;
};

/** One model request, recorded for assertions. `messages` is copied at request time. */
export type ScriptedRequest = {
  readonly messages: readonly Message[];
  readonly tools: readonly ScriptedTool[];
  /** The replayed system prompt, sections included, byte-for-byte as the model received it. */
  readonly system: string;
  /** The current named prompt sections, after replaying every system message. */
  readonly sections: Readonly<Record<string, string>>;
  readonly model: string;
  readonly provider: string;
  /** The thinking level the request asked for; `"off"` when the harness sent none. */
  readonly thinkingLevel: ThinkingLevel | "off";
};

/** What `scriptedProvider` returns: the provider, a ready `Models`, the recording and the counter. */
export interface ScriptedModel {
  readonly providerId: string;
  /** The pi-ai provider, for callers that register it into their own collection. */
  readonly provider: Provider;
  /** A collection with the scripted provider already registered; hand it to `openOffice`. */
  readonly models: Models;
  /** A model ref under the scripted provider, for an agent's `model` setting. */
  readonly model: ModelRef;
  /** Every request the office made, in order. */
  readonly requests: readonly ScriptedRequest[];
  /** How many times the model was called. A live value, safe to read after each await. */
  readonly calls: number;
}

export type ScriptedProviderOptions = {
  /** The `modelId` of the ref `model` carries; any other id resolves to the same streaming. */
  readonly modelId?: string;
};

/** A catalog entry for any id the harness asks for; the shape mirrors faux's declared models. */
function catalogEntry(modelId: string): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api: SCRIPTED_API,
    provider: SCRIPTED_PROVIDER_ID,
    baseUrl: "http://localhost:0",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_TOKENS,
  };
}

/** Snapshot the current tools, system prompt and sections the request carried. */
function recordRequest(
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  model: Model<string>,
): ScriptedRequest {
  const system = getCurrentSystemMessage(context.messages);
  const sections: Record<string, string> = {};
  for (const [key, value] of Object.entries(system?.sections ?? {})) {
    if (typeof value === "string") sections[key] = value;
  }
  return {
    messages: [...context.messages],
    tools: getCurrentTools(context.messages).map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
    system: getCurrentSystemPrompt(context.messages),
    sections,
    model: model.id,
    provider: model.provider,
    thinkingLevel: options?.reasoning ?? "off",
  };
}

/** The assistant message a turn becomes: a tool-use response, or a final answer. */
function assistantFor(turn: ScriptedTurn) {
  if ("text" in turn) return fauxAssistantMessage(turn.text);
  return fauxAssistantMessage(
    turn.toolCalls.map((call) => fauxToolCall(call.name, call.args ?? {})),
    { stopReason: "toolUse" },
  );
}

/**
 * The error that names where the script ran out and what it expected, instead of a bare `undefined`.
 * It is raised inside pi-ai's faux stream, which surfaces it as an error response, so the office
 * fails the run with this text rather than hanging.
 */
function exhausted(calls: number, index: number, length: number): Error {
  return new Error(
    `scripted model ran out of script: request ${calls} (turn ${index}) had no turn to answer with, ` +
      `but the script has ${length}. Add a turn at index ${index} — another tool call or a text answer — ` +
      `or use a function script that branches on the transcript.`,
  );
}

/**
 * Build a scripted provider.
 *
 * ```ts
 * const scripted = scriptedProvider([{ toolCalls: [{ name: "check_schedule" }] }, { text: "Booked." }]);
 * await openOffice({ storage: "memory", models: scripted.models });
 * // ...conversation({ agent: { model: scripted.model } })
 * expect(scripted.requests[0]?.tools.map((tool) => tool.name)).toEqual(["check_schedule"]);
 * ```
 */
export function scriptedProvider(
  script: ScriptedScript,
  options: ScriptedProviderOptions = {},
): ScriptedModel {
  const modelId = options.modelId ?? SCRIPTED_MODEL_ID;
  const faux = fauxProvider({
    provider: SCRIPTED_PROVIDER_ID,
    api: SCRIPTED_API,
    models: [{ id: modelId }],
  });

  const requests: ScriptedRequest[] = [];
  let calls = 0;

  const turnFor = (messages: readonly Message[], index: number): ScriptedTurn => {
    if (typeof script === "function") return script(messages);
    const turn = script[index];
    if (turn === undefined) throw exhausted(calls, index, script.length);
    return turn;
  };

  const respond: FauxResponseFactory = (context, streamOptions, _state, model) => {
    calls += 1;
    requests.push(recordRequest(context, streamOptions, model));
    // faux shifts one response per call, so re-arm with this same factory: the script, not faux's
    // queue, is the only thing that can run out, and it fails with a message naming the turn.
    faux.appendResponses([respond]);
    return assistantFor(turnFor(context.messages, calls - 1));
  };
  faux.setResponses([respond]);

  const models: MutableModels = createModels();
  models.setProvider(faux.provider);
  // faux lists only the ids declared up front, but a scripted provider stands in for whatever role
  // runs under it and cannot know that role's model id. Resolve any id under our provider to a fresh
  // catalog entry, so `{ provider: "scripted", modelId: anything }` streams without pre-declaring it.
  const declared = models.getModel.bind(models);
  models.getModel = (provider, id) =>
    provider === SCRIPTED_PROVIDER_ID
      ? (declared(provider, id) ?? catalogEntry(id))
      : declared(provider, id);

  return {
    providerId: SCRIPTED_PROVIDER_ID,
    provider: faux.provider,
    models,
    model: { provider: SCRIPTED_PROVIDER_ID, modelId },
    requests,
    get calls() {
      return calls;
    },
  };
}
