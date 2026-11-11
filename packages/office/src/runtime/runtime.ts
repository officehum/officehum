/**
 * The runtime process: one office's Pi Durable harness behind the Gateway Protocol.
 *
 * The gateway (RASF-3105) supervises one of these per office and speaks to it over stdin/stdout. It
 * hosts every role of the office in one harness over one SQLite file, and answers the protocol's
 * commands: `submit` work, `subscribe` to a request's events, `get_state`, `list_agents`, `abort`, and
 * (from RASF-3108) `approve`. `docs/design/gateway-protocol.md` is the protocol; this module is the
 * runtime's half of it.
 *
 * Trust: the only caller is the gateway, which adds a `principal` from the authenticated session to
 * every command. A command without one is refused as `unauthorized`; the runtime never invents one.
 *
 * Exactly once: a submission is keyed by its scoped request id, `<principal id>/<request id>`, kept
 * in a durable index beside the office. The same key again returns the stored request with no new
 * work, across restarts. Pi Durable's own `submit` is idempotent per conversation as well, which
 * covers a crash between admitting the submission and writing the index.
 *
 * Events: each conversation has one listener, attached before any submit to it so no event is
 * missed. Tool and text events belong to the conversation's oldest unsettled request (the one the
 * run is working on); `settled` comes from the submission itself. Events are kept in memory, so after
 * a restart a request that finished before it replays only its `settled` event.
 */

import type { Readable, Writable } from "node:stream";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  type AgentChange,
  type Conversation,
  defineDoc,
  type ModelRef,
  type SettledSubmissionRecord,
  type SubmissionId,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import {
  type Abort,
  type EventMessage,
  type ForwardedCommand,
  handshake,
  invalidMessage,
  LineDecoder,
  type Principal,
  type RequestEvent,
  replyId,
  type ServerMessage,
  type Submit,
  type Subscribe,
  scopedRequestId,
  validateMessage,
} from "@officehum/protocol";
import { type Office, type OfficeEvent, type OfficeStorage, openOffice } from "../adapter/index.js";
import type { LoadedRole } from "../roles/load-role.js";
import { answerText } from "../roles/run-role.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS, type RemoteApprovals } from "./approvals.js";
import { RuntimeError } from "./errors.js";
import { FrameWriter } from "./frame-writer.js";

export interface RuntimeOptions {
  /** The office's id, sent as `serverId` in `welcome`. */
  readonly serverId: string;
  /** The office's roles, loaded. Each is an agent named by its manifest id. */
  readonly roles: readonly LoadedRole[];
  readonly storage: OfficeStorage;
  readonly models: Models;
  /** Overrides every role's model for conversations it starts; a saved conversation keeps its own. */
  readonly model?: ModelRef;
  /** Receives every message the runtime sends, in order. */
  readonly send: (message: ServerMessage) => void;
  /** Receives log lines. Never stdout: stdout carries protocol frames only. */
  readonly log?: (line: string) => void;
  /**
   * The remote approvals store whose `approve` the roles were loaded with. Omitted: no approvals can
   * be decided here, so the roles' gates refuse gated actions.
   */
  readonly approvals?: RemoteApprovals;
  /** How long each agent's approvals wait, by agent name; others wait the default 4 hours. */
  readonly approvalTimeoutsMs?: Readonly<Record<string, number>>;
}

export interface Runtime {
  /** Handles one decoded frame. Resolves once the command has been answered. */
  handle(json: unknown): Promise<void>;
  /** Closes the office. Unfinished work stays durable and resumes on the next start. */
  close(): Promise<void>;
}

/** One tool of an agent, as `list_agents` and `get_state` report it. */
export interface AgentToolInfo {
  readonly name: string;
  readonly replay: "safe" | "unsafe";
}

/** One agent, as `list_agents` and `get_state` report it (`result.data.agents`). */
export interface AgentInfo {
  readonly name: string;
  /** What the role does, from its manifest. */
  readonly role?: string;
  /** `provider/model` for conversations this agent starts. */
  readonly model: string;
  readonly tools: readonly AgentToolInfo[];
  /** `get_state` only: `busy` while any of the agent's requests is unsettled. */
  readonly status?: "idle" | "busy";
  /** `get_state` only: how many of the agent's requests are unsettled. */
  readonly openRequests?: number;
}

/**
 * One entry of the request index. Written before the submission is admitted, as an intent naming the
 * conversation and agent, then completed with the submission's id: a retry after a crash in between
 * goes back to the same conversation, where Pi Durable's own request id dedupes it.
 */
type IndexedRequest = { conversation: string; agent: string; submission?: number };

/**
 * The durable request index: scoped request id → its conversation key, agent and submission. Written
 * only by the runtime.
 */
const RequestIndexDoc = defineDoc<{ requests: Record<string, IndexedRequest> }>({
  kind: "officehum.runtime.requests",
  version: 1,
  scope: "session",
  initial: () => ({ requests: {} }),
});

/** At most this many events are held for a placed submission the runtime has not tracked yet. */
const PENDING_EVENT_LIMIT = 10_000;

interface AgentEntry {
  readonly name: string;
  readonly role: LoadedRole;
  readonly settings: AgentChange;
  readonly model: ModelRef;
}

interface OpenConversation {
  readonly key: string;
  readonly conversation: Conversation;
  /**
   * Submissions Pi Durable has placed and not settled, in placement order. The run works on the
   * first: its tool and text events belong to it.
   */
  readonly placed: number[];
  /**
   * Events of a placed submission that is not tracked yet: a run can start before `submit` returns.
   * Handed to the request when it is tracked; dropped when the submission settles untracked.
   */
  readonly pending: Map<number, RequestEvent[]>;
}

interface Tracked {
  /** The scoped request id, `<principal id>/<request id>`: what `accepted` and `event` carry. */
  readonly key: string;
  readonly agent: string;
  readonly conversation: OpenConversation;
  readonly submission: SubmissionId;
  readonly events: EventMessage[];
  /** Whether the connection receives this request's events as they happen. */
  subscribed: boolean;
  /** Set once the submission is known to be settled; its `settled` event follows. */
  settling: boolean;
}

const TERMINAL = new Set(["done", "unanswered"]);

/** Re-exported from the protocol, where the gateway reads the same rule. */
export { scopedRequestId };

/**
 * Each principal has its own conversations with an agent, so one person's transcript, queue and
 * `abort` never reach another's. Ids are URI-encoded, so no part can contain the `:` separator.
 */
function conversationKey(agent: string, principal: Principal, conversation?: string): string {
  const base = `agent:${agent}:${encodeURIComponent(principal.id)}`;
  return conversation === undefined ? base : `${base}:${encodeURIComponent(conversation)}`;
}

function modelName(model: ModelRef): string {
  return `${model.provider}/${model.modelId}`;
}

/**
 * Opens the office, installs its roles, attaches to the work a previous run left unsettled, resumes
 * it, and sends `welcome`. Every Pi Durable call goes through the adapter.
 */
export async function openRuntime(options: RuntimeOptions): Promise<Runtime> {
  const log = options.log ?? (() => {});
  const send = options.send;
  const { approvals } = options;
  const office: Office = await openOffice({
    storage: options.storage,
    models: options.models,
    // Open paused: attach to the unsettled work first, so no event of a resumed run is missed.
    resume: false,
    onReport: (error) => log(`Office report: ${String(error)}`),
  });

  try {
    const agents = new Map<string, AgentEntry>();
    for (const role of options.roles) {
      office.install(role.bundle);
      const model = options.model ?? role.bundle.agent.model ?? manifestModel(role) ?? undefined;
      if (model === undefined) {
        throw new Error(`${role.manifest.id} declares no model; pass one with --model.`);
      }
      agents.set(role.manifest.id, {
        name: role.manifest.id,
        role,
        settings: { ...role.bundle.agent, model },
        model,
      });
    }

    const index = new Map(Object.entries((await office.snapshot(RequestIndexDoc))?.requests ?? {}));
    const tracked = new Map<string, Tracked>();
    const bySubmission = new Map<number, Tracked>();
    const conversations = new Map<string, Promise<OpenConversation>>();
    /** Open conversations by Pi Durable conversation id, with their agent, for approvals. */
    const byConversationId = new Map<string, { open: OpenConversation; agent: AgentEntry }>();
    const restoring = new Map<string, Promise<Tracked | undefined>>();
    const settlements = new Set<Promise<void>>();
    let closing: Promise<void> | undefined;

    const writeIndex = async (key: string, entry: IndexedRequest) => {
      await office.harness.commit(async (transaction) => {
        const document = await transaction.doc(RequestIndexDoc);
        document.requests[key] = entry;
      }, BACKGROUND_CONTEXT);
      index.set(key, entry);
    };

    const toRequestEvent = (event: OfficeEvent): RequestEvent | undefined => {
      switch (event.kind) {
        case "text":
          return { kind: "text_delta", text: event.delta };
        case "tool_start":
          return { kind: "tool_start", toolCallId: event.callId, tool: event.tool };
        case "tool_end":
          return {
            kind: "tool_end",
            toolCallId: event.callId,
            tool: event.tool,
            ok: !event.failed,
          };
        default:
          return undefined;
      }
    };

    const onEvent = (open: OpenConversation, event: OfficeEvent) => {
      if (event.kind === "placed") {
        const id = event.submissionId as number;
        if (!open.placed.includes(id)) open.placed.push(id);
        return;
      }
      if (event.kind === "settled") {
        const id = event.submissionId as number;
        forget(open, id);
        const request = bySubmission.get(id);
        if (request !== undefined) settle(request);
        return;
      }
      const mapped = toRequestEvent(event);
      if (mapped !== undefined) deliver(open, mapped);
    };

    /** Puts an event on the request the conversation's run is working on, or holds it until tracked. */
    const deliver = (open: OpenConversation, mapped: RequestEvent) => {
      const current = open.placed[0];
      if (current === undefined) return;
      const request = bySubmission.get(current);
      if (request !== undefined) {
        emit(request, mapped);
        return;
      }
      const held = open.pending.get(current) ?? [];
      if (held.length === PENDING_EVENT_LIMIT) {
        log(`Dropping events for submission ${current}: it is not tracked.`);
        return;
      }
      held.push(mapped);
      open.pending.set(current, held);
    };

    const forget = (open: OpenConversation, id: number) => {
      const position = open.placed.indexOf(id);
      if (position !== -1) open.placed.splice(position, 1);
      open.pending.delete(id);
    };

    const conversationFor = (key: string, agent: AgentEntry): Promise<OpenConversation> => {
      let opening = conversations.get(key);
      if (opening === undefined) {
        opening = (async () => {
          const conversation = await office.conversation(key, { agent: agent.settings });
          const open: OpenConversation = { key, conversation, placed: [], pending: new Map() };
          byConversationId.set(String(conversation.id), { open, agent });
          await office.listen(conversation, (event) => onEvent(open, event));
          return open;
        })();
        // A failed open is not cached, so the next command tries again.
        opening.catch(() => conversations.delete(key));
        conversations.set(key, opening);
      }
      return opening;
    };

    const emit = (request: Tracked, event: RequestEvent) => {
      const message: EventMessage = {
        type: "event",
        requestId: request.key,
        seq: request.events.length + 1,
        event,
      };
      request.events.push(message);
      if (request.subscribed) send(message);
    };

    /** Marks a request settled (once) and emits its `settled` event with the answer. */
    const settle = (request: Tracked) => {
      if (request.settling) return;
      request.settling = true;
      forget(request.conversation, request.submission as number);
      const settling = (async () => {
        try {
          const record = await statusOf(request.submission);
          emit(request, await settledEvent(request.conversation.conversation, record));
        } catch (error) {
          // While closing, the office going away is the reason; the request is not failed, and it
          // settles properly on the next start.
          if (closing !== undefined) return;
          log(`Could not read how ${request.key} settled: ${String(error)}`);
          emit(request, { kind: "settled", status: "failed" });
        }
      })();
      settlements.add(settling);
      void settling.finally(() => settlements.delete(settling));
    };

    const statusOf = async (id: SubmissionId): Promise<SubmissionRecord> => {
      const submission = await office.submission(id);
      if (submission === undefined)
        throw new Error(`Submission ${String(id)} is not in this office.`);
      return await submission.status(BACKGROUND_CONTEXT);
    };

    /** Starts tracking a submission: hands it any events held for it, and settles it if it has. */
    const track = (
      key: string,
      agent: string,
      open: OpenConversation,
      submission: SubmissionId,
      record: SubmissionRecord | undefined,
    ): Tracked => {
      const request: Tracked = {
        key,
        agent,
        conversation: open,
        submission,
        events: [],
        subscribed: false,
        settling: false,
      };
      const id = submission as number;
      tracked.set(key, request);
      bySubmission.set(id, request);
      // A run resumed after a restart was placed before it: no `placed` event will come for it.
      if (record?.status === "placed" && !open.placed.includes(id)) open.placed.push(id);
      for (const event of open.pending.get(id) ?? []) emit(request, event);
      open.pending.delete(id);
      if (record !== undefined && TERMINAL.has(record.status)) settle(request);
      return request;
    };

    /**
     * A request known to the durable index but not tracked in this process: one from a past run.
     * Memoised, so two commands restoring one request get one tracked request.
     */
    const restore = (key: string): Promise<Tracked | undefined> => {
      const known = tracked.get(key);
      if (known !== undefined) return Promise.resolve(known);
      let restored = restoring.get(key);
      if (restored === undefined) {
        restored = (async () => {
          const indexed = index.get(key);
          // An intent without a submission: the crash came before Pi Durable answered. A retried
          // submit goes back to its conversation and finds out.
          if (indexed?.submission === undefined) return undefined;
          const agent = agents.get(indexed.agent);
          if (agent === undefined) {
            throw new RuntimeError(
              "not_found",
              `Request ${key} belongs to ${indexed.agent}, which this office no longer runs.`,
            );
          }
          const open = await conversationFor(indexed.conversation, agent);
          const submission = indexed.submission as unknown as SubmissionId;
          return track(key, indexed.agent, open, submission, await statusOf(submission));
        })();
        restoring.set(key, restored);
        void restored.finally(() => restoring.delete(key)).catch(() => {});
      }
      return restored;
    };

    const find = async (principal: Principal, requestId: string): Promise<Tracked> => {
      const request = await restore(scopedRequestId(principal, requestId));
      if (request === undefined) {
        throw new RuntimeError(
          "not_found",
          `No request ${requestId} was submitted by this caller.`,
        );
      }
      return request;
    };

    /** Sends recorded events after `afterSeq`, always including `settled`, then streams the rest. */
    const subscribe = (request: Tracked, afterSeq: number) => {
      for (const message of request.events) {
        if (message.seq > afterSeq || message.event.kind === "settled") send(message);
      }
      request.subscribed = true;
    };

    const agentFor = (name: string): AgentEntry => {
      const agent = agents.get(name);
      if (agent === undefined) {
        throw new RuntimeError(
          "unknown_agent",
          `This office has no agent ${name}; it runs ${[...agents.keys()].join(", ")}.`,
        );
      }
      return agent;
    };

    const submit = async (command: Submit & { principal: Principal }) => {
      const requested = agentFor(command.agent);
      const key = scopedRequestId(command.principal, command.requestId);
      const existing = await restore(key);
      if (existing !== undefined) {
        send({ type: "accepted", id: command.id, requestId: key, disposition: "existing" });
        subscribe(existing, 0);
        return;
      }
      // An intent left by a crash wins over this command's agent and conversation: the retry must
      // reach the conversation where Pi Durable may already hold it.
      const intent = index.get(key);
      const agent = intent === undefined ? requested : agents.get(intent.agent);
      if (agent === undefined) {
        throw new RuntimeError(
          "not_found",
          `Request ${key} belongs to ${intent?.agent}, which this office no longer runs.`,
        );
      }
      const conversation =
        intent?.conversation ??
        conversationKey(agent.name, command.principal, command.conversation);
      const open = await conversationFor(conversation, agent);
      if (intent === undefined) await writeIndex(key, { conversation, agent: agent.name });

      const { input } = command;
      const submission = await office.submit(
        open.conversation,
        input.kind === "message"
          ? { input: input.text, requestId: key }
          : {
              input: `Ticket ${input.type}: ${JSON.stringify(input.payload)}`,
              requestId: key,
              entry: {
                kind: "officehum.ticket",
                data: { type: input.type, payload: (input.payload ?? null) as JsonValue },
              },
            },
      );
      const request = track(key, agent.name, open, submission.id, undefined);
      await writeIndex(key, {
        conversation,
        agent: agent.name,
        submission: submission.id as number,
      });

      const record = await submission.status(BACKGROUND_CONTEXT);
      // New work that already finished was still started here; only a retry of an intent can find
      // work admitted before.
      const disposition =
        record.status === "queued"
          ? "queued"
          : record.status === "placed" || intent === undefined
            ? "started"
            : "existing";
      send({ type: "accepted", id: command.id, requestId: key, disposition });
      // Events recorded between admission and this reply go out now, after `accepted`.
      subscribe(request, 0);
      if (TERMINAL.has(record.status)) settle(request);
    };

    const describe = (agent: AgentEntry, withState: boolean): AgentInfo => {
      const tools = (agent.role.manifest.tools ?? []).map((tool) => ({
        name: tool.name,
        replay: tool.replay,
      }));
      const info: AgentInfo = {
        name: agent.name,
        ...(typeof agent.role.manifest.role === "string" ? { role: agent.role.manifest.role } : {}),
        model: modelName(agent.model),
        tools,
      };
      if (!withState) return info;
      const open = [...tracked.values()].filter(
        (request) => request.agent === agent.name && !request.settling,
      ).length;
      return { ...info, status: open > 0 ? "busy" : "idle", openRequests: open };
    };

    const answer = async (command: ForwardedCommand): Promise<void> => {
      switch (command.type) {
        case "submit": {
          // One submit at a time: two frames with one request id must not both start work. A failed
          // submit must not hold up the ones behind it, so the chain carries on past a rejection.
          const run = submitting.then(() => submit(command));
          submitting = run.catch(() => {});
          return await run;
        }
        case "subscribe": {
          const request = await find(command.principal, (command as Subscribe).requestId);
          // `settled` tells the caller a settled event is on its way, so it need not guess by timing.
          send({ type: "result", id: command.id, ok: true, data: { settled: request.settling } });
          subscribe(request, command.afterSeq ?? 0);
          return;
        }
        case "abort": {
          const request = await find(command.principal, (command as Abort).requestId);
          if (!request.settling) {
            await office.abort(request.conversation.conversation);
            const record = await statusOf(request.submission);
            if (TERMINAL.has(record.status)) settle(request);
          }
          send({ type: "result", id: command.id, ok: true });
          return;
        }
        case "list_agents":
          send({
            type: "result",
            id: command.id,
            ok: true,
            data: { agents: [...agents.values()].map((agent) => describe(agent, false)) },
          });
          return;
        case "get_state": {
          const selected =
            command.agent === undefined ? [...agents.values()] : [agentFor(command.agent)];
          send({
            type: "result",
            id: command.id,
            ok: true,
            data: { agents: selected.map((agent) => describe(agent, true)) },
          });
          return;
        }
        case "approve": {
          if (approvals === undefined) {
            throw new RuntimeError(
              "not_found",
              `No approval ${command.approvalId} is waiting here: this runtime takes no remote approvals.`,
            );
          }
          const approval = await approvals.decide(
            command.principal,
            command.approvalId,
            command.decision,
            command.note,
          );
          send({ type: "result", id: command.id, ok: true, data: { approval } });
          return;
        }
        case "watch_approvals":
          send({
            type: "result",
            id: command.id,
            ok: true,
            data: { approvals: approvals?.pending() ?? [] },
          });
          return;
        case "ping":
          send({ type: "result", id: command.id, ok: true });
          return;
      }
    };
    let submitting: Promise<void> = Promise.resolve();
    // Attach to the work a previous run left unsettled, then let it continue. A submission whose
    // index entry is only an intent (a crash came between admission and the index write) is found
    // by the request id Pi Durable stored with it, and its entry completed.
    const reverse = new Map(
      [...index].flatMap(([key, entry]) =>
        entry.submission === undefined ? [] : [[entry.submission, key] as const],
      ),
    );
    for (const id of await office.openSubmissions()) {
      try {
        let key = reverse.get(id as number);
        if (key === undefined) {
          const requestId = (await statusOf(id)).requestId;
          const intent = requestId === undefined ? undefined : index.get(requestId);
          if (requestId === undefined || intent === undefined) {
            log(
              `Submission ${String(id)} was not made through the runtime; leaving it to its owner.`,
            );
            continue;
          }
          await writeIndex(requestId, { ...intent, submission: id as number });
          key = requestId;
        }
        await restore(key);
      } catch (error) {
        // One request we cannot attach to (its agent left the office file) must not stop the office.
        log(
          `Could not attach to submission ${String(id)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // Bound before the office resumes, so a resumed run waiting on a person finds its request.
    await approvals?.bind({
      office,
      callerOf: (conversationId) => {
        const known = byConversationId.get(conversationId);
        if (known === undefined) return undefined;
        const { agent } = known;
        return {
          agent: agent.name,
          declarations: agent.role.manifest.approvals,
          timeoutMs: options.approvalTimeoutsMs?.[agent.name] ?? DEFAULT_APPROVAL_TIMEOUT_MS,
        };
      },
      announce: (conversationId, event) => {
        const known = byConversationId.get(conversationId);
        if (known !== undefined) deliver(known.open, event);
      },
      broadcast: (approval) => send({ type: "approval", approval }),
      log,
    });
    office.resume();
    send({ type: "welcome", version: 1, serverId: options.serverId });

    return {
      async handle(json) {
        const id = replyId(json);
        try {
          if (typeof json === "object" && json !== null && !("principal" in json)) {
            const asClient = validateMessage(json, "client");
            if (asClient.ok && asClient.message.type !== "hello") {
              throw new RuntimeError(
                "unauthorized",
                "Every command must carry the principal the gateway adds; this runtime takes commands only from its gateway.",
              );
            }
          }
          const checked = validateMessage(json, "gateway");
          if (!checked.ok) {
            send(invalidMessage(checked.problems, id));
            return;
          }
          const message = checked.message;
          if (message.type === "hello") {
            send(handshake(message, options.serverId));
            return;
          }
          await answer(message);
        } catch (error) {
          if (error instanceof RuntimeError) {
            send({
              type: "error",
              ...(id === undefined ? {} : { id }),
              code: error.code,
              message: error.message,
            });
            return;
          }
          log(
            `Command ${id ?? "(no id)"} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
          );
          send({
            type: "error",
            ...(id === undefined ? {} : { id }),
            code: "internal",
            message: "The runtime could not complete this command; its log has the details.",
          });
        }
      },
      async close() {
        closing ??= (async () => {
          // Let settles already under way read their answer before the office goes.
          await Promise.allSettled([...settlements]);
          approvals?.close();
          await office.close();
        })();
        return await closing;
      },
    };
  } catch (error) {
    await office.close();
    throw error;
  }
}

function manifestModel(role: LoadedRole): ModelRef | undefined {
  const declared = (role.manifest as { defaultModel?: { provider?: unknown; modelId?: unknown } })
    .defaultModel;
  return typeof declared?.provider === "string" && typeof declared.modelId === "string"
    ? { provider: declared.provider, modelId: declared.modelId }
    : undefined;
}

async function settledEvent(
  conversation: Conversation,
  record: SubmissionRecord,
): Promise<RequestEvent> {
  if (record.status === "done") {
    const answer = await answerText(conversation, record as SettledSubmissionRecord);
    return { kind: "settled", status: "done", ...(answer === undefined ? {} : { answer }) };
  }
  const reason = (record as { reason?: unknown }).reason;
  return { kind: "settled", status: reason === "aborted" ? "aborted" : "failed" };
}

/** How long a closing runtime waits for the gateway to read its last frames. */
const FLUSH_TIMEOUT_MS = 5_000;

export interface ServeRuntimeOptions extends Omit<RuntimeOptions, "send"> {
  /** Where frames arrive: the runtime's stdin. */
  readonly input: Readable;
  /** Where frames go: the runtime's stdout, and nothing else is written to it. */
  readonly output: Writable;
  /** Stops reading and closes the office, as the input ending would (a SIGINT, say). */
  readonly signal?: AbortSignal;
}

/**
 * Serves the protocol over a pair of streams until the input ends, then closes the office. Unfinished
 * work stays durable for the next start.
 */
export async function serveRuntime(options: ServeRuntimeOptions): Promise<void> {
  const log = options.log ?? (() => {});
  const writer = new FrameWriter(options.output, log);
  const runtime = await openRuntime({ ...options, send: (message) => writer.write(message) });
  const decoder = new LineDecoder();
  const inFlight = new Set<Promise<void>>();
  const dispatch = (frames: ReturnType<LineDecoder["push"]>) => {
    for (const frame of frames) {
      if (!frame.ok) {
        writer.write({ type: "error", code: frame.code, message: frame.message });
        continue;
      }
      const handled = runtime.handle(frame.value).finally(() => inFlight.delete(handled));
      inFlight.add(handled);
    }
  };
  const stop = () => options.input.destroy();
  options.signal?.addEventListener("abort", stop, { once: true });
  // A stop asked for while the office was opening has already fired.
  if (options.signal?.aborted === true) stop();
  try {
    try {
      for await (const chunk of options.input) dispatch(decoder.push(chunk as Uint8Array | string));
      dispatch(decoder.end());
    } catch (error) {
      // Destroying the input to stop ends the read with a premature-close error; that is the stop.
      if (options.signal?.aborted !== true) throw error;
    }
    await Promise.allSettled([...inFlight]);
  } finally {
    options.signal?.removeEventListener("abort", stop);
    await runtime.close();
    // A gateway that stopped reading leaves a write pending, which would keep the process alive.
    if (!(await writer.flush(FLUSH_TIMEOUT_MS))) options.output.destroy();
  }
}
