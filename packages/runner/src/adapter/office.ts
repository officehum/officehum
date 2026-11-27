/**
 * The Pi Durable adapter.
 *
 * This directory is the only place in Office Hum that calls Pi Durable's runtime API. Everything else
 * imports this surface, or Pi Durable *types* and authoring helpers (`defineTool`, `defineRole`,
 * `hook`, `defineDoc`, document tokens), which `AGENTS.md` allows. The rule is enforced by
 * `imports.test.ts`.
 *
 * The adapter adds no policy: no approvals, budgets, retries or routing. It wraps, in order:
 * `Harness.open` + `resume()`, `createRegistry` (and its snapshot's `tools`),
 * `Harness.root`/`createConversation`/`conversation`,
 * `Conversation.submit`/`configure`/`abort`, `Harness.submission`/`inspect`/`resume`,
 * `Harness.observeConversation`/`observeCommits`, `Session.snapshot` and `Session.close`. Each method
 * names what it wraps.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  type AgentChange,
  type Conversation,
  type ConversationId,
  type ConversationView,
  createRegistry,
  createSession,
  defineDoc,
  Harness,
  type HarnessSettings,
  type InputEntry,
  type JsonObject,
  type Observation,
  type Report,
  ROOT_CONVERSATION_ID,
  type SessionDocToken,
  type SetTimer,
  type Storage,
  type Submission,
  type SubmissionId,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { RoleBundle } from "@officehum/sdk";
import { backUpBeforeMigration } from "./store-backup.js";
import { type OfficeEvent, submissionEvents, viewEvents } from "./watch.js";

/** One view operation, as `viewEvents` reads it. */
type Op = Parameters<typeof viewEvents>[2][number];

/**
 * Where one host keeps its durable state.
 *
 * `memory` is for tests. `sqlite` is one file per host. `jsonl` is a directory holding Pi Durable's
 * JSONL store, so a host that already writes that format can move onto this adapter without changing
 * its on-disk format.
 */
export type OfficeStorage = "memory" | { readonly sqlite: string } | { readonly jsonl: string };

/** Key of the reserved root conversation, the one every office always has. */
export const ROOT_KEY = "root";

export type OpenOfficeOptions = {
  readonly storage: OfficeStorage;
  readonly models: Models;
  readonly settings?: HarnessSettings;
  /** Receives failures that do not fail the calling operation. Wired to `HarnessOptions.onReport`. */
  readonly onReport?: (error: unknown) => void;
  /**
   * Enable task scheduling on open. Default true, so work admitted before the last close continues.
   * A caller that must see which submissions were left unsettled — the run command reacquiring work
   * after a crash — opens with false and drives recovery itself; `submit` and `Submission.wait` enable
   * scheduling anyway, so this only delays it.
   */
  readonly resume?: boolean;
  /**
   * The harness's clock and timers (`HarnessOptions.now` and `setTimer`), which durable sleeps count
   * against. Default `Date.now` and `setTimeout`. Every process that opens one store must use the
   * same clock; tests inject a fake one to move it.
   */
  readonly clock?: { readonly now: () => number; readonly setTimer: SetTimer };
  /**
   * Where the office says what it did to its store, such as where it copied a store before Pi Durable
   * migrated it. Default: standard error.
   */
  readonly log?: (line: string) => void;
};

export type OfficeConversationOptions = {
  /** The role's agent settings: model, extension selection and instructions. */
  readonly agent: AgentChange;
};

export type OfficeSubmitOptions = {
  readonly input: string;
  /** Idempotency key, scoped to the conversation. `submit` with the same one returns the original. */
  readonly requestId: string;
  /** Relayed provenance (M2). The kind must not start with `pi.`. */
  readonly entry?: InputEntry;
  /**
   * What a busy conversation does with the input: `followUp` (Pi Durable's default) places it when
   * the run answers, `steer` after the current tool round, `reject` throws `ConversationBusy`.
   */
  readonly whenBusy?: "followUp" | "steer" | "reject";
};

/**
 * Pi Durable mints conversation ids and has no name index, so the adapter keeps one: a session-scoped
 * document mapping Office Hum's stable keys to conversation ids. Created in the same commit as the
 * conversation it names, so a crash cannot leave a name pointing at nothing.
 */
const OfficeDirectoryDoc = defineDoc<{ names: Record<string, number> }>({
  kind: "officehum.office.directory",
  version: 1,
  checkpointWhen: () => false,
  scope: "session",
  initial: () => ({ names: {} }),
});

/** One office: a Harness over one Storage, with the registry roles install into. */
export interface Office {
  /**
   * The underlying Harness, for the callers that must hand it to Pi Durable's authored documents and
   * reads rather than a rebuilt surface: solo mode exposes it as `SoloSession.harness`, and its tools,
   * the CLI, the inbound path and the reply transport call `commit`, `snapshot`, `inspect`,
   * `conversation`, `createConversation`, `submission` and `waitForIdle` on it directly. Everything
   * else goes through the methods below; this is the one runtime handle the adapter hands back.
   */
  readonly harness: Harness;
  /** `createRegistry` + `registry.install(extension)`, once per extension of the bundle. */
  install(bundle: RoleBundle): void;
  /**
   * `registry.snapshot().tools()`: the replay policy of the installed tool named `tool`. `unsafe` when
   * any installed tool of that name is, or states none (Pi Durable's default); `undefined` when none
   * is installed.
   */
  replayOf(tool: string): "safe" | "unsafe" | undefined;
  /**
   * `Harness.root` for `ROOT_KEY`, otherwise `Harness.conversation` by name, creating an ownerless
   * conversation with `Conversation.submit`-ready agent settings in one commit when the name is new.
   */
  conversation(key: string, options: OfficeConversationOptions): Promise<Conversation>;
  /**
   * The id of the conversation `key` names now, from the same name index, without creating one;
   * undefined for a name never given (a history read checks a submission against it).
   */
  conversationId(key: string): Promise<ConversationId | undefined>;
  /** `Conversation.submit`. Idempotent by `requestId`; the adapter never invents one or retries. */
  submit(conversation: Conversation, options: OfficeSubmitOptions): Promise<Submission>;
  /** `Harness.submission`. The reacquire-after-restart path. */
  submission(id: SubmissionId): Promise<Submission | undefined>;
  /** `Conversation.configure`. Used after an overlay reload changes model, tools or skills. */
  configure(conversation: Conversation, change: AgentChange): Promise<void>;
  /**
   * `Conversation.abort`: withdraw queued inputs, mark the ordinary scope's live tasks, and resolve
   * once that scope is idle. The eval runner uses it to end a trial whose run must stop.
   */
  abort(conversation: Conversation): Promise<void>;
  /**
   * `Harness.observeConversation` + `Harness.observeCommits`, mapped to Office Hum's event kinds.
   * Resolves once both are attached, so every event committed after it resolves reaches `onEvent`; a
   * host that must not miss a run's events attaches before it submits. `stop` detaches.
   */
  listen(
    conversation: Conversation,
    onEvent: (event: OfficeEvent) => void,
  ): Promise<{ stop(): Promise<void> }>;
  /** `listen`, as an iterable of Office Hum's event kinds. Iterate until done, then `return`. */
  watch(conversation: Conversation): AsyncIterable<OfficeEvent>;
  /**
   * `Harness.resume`: enable scheduling, so work admitted before the last close continues. For a host
   * that opened with `resume: false` to attach to its unsettled work first. Idempotent.
   */
  resume(): void;
  /** `Harness.inspect().submissions`: unsettled submissions, for a resume pass. */
  openSubmissions(): Promise<readonly SubmissionId[]>;
  /** `Session.snapshot` for a session-scoped document. */
  snapshot<T extends JsonObject>(token: SessionDocToken<T>): Promise<Readonly<T> | undefined>;
  /** `Session.close`: seals admission, settles admitted commits, then closes storage. Idempotent. */
  close(): Promise<void>;
}

/** Open storage for an office. `jsonl` matches what `openSolo` opens today, `fsync` included. */
async function openStorage(
  option: OfficeStorage,
  log: (line: string) => void = (line) => console.error(line),
): Promise<Storage> {
  if (option === "memory") return new MemoryStorage();
  if ("sqlite" in option) {
    // Pi Durable migrates a store written by 1.3 when it opens it, for good: copy it first.
    await backUpBeforeMigration(option.sqlite, log);
    return await openNodeSqliteStorage(option.sqlite);
  }
  return await openNodeJsonlStorage(option.jsonl, BACKGROUND_CONTEXT, { fsync: true });
}

/** Read one session document without opening a Harness, for read-only inspection. `createSession`. */
export async function readStoredDocument<T extends JsonObject>(
  storage: OfficeStorage,
  token: SessionDocToken<T>,
): Promise<Readonly<T> | undefined> {
  const opened = await openStorage(storage);
  const session = createSession(opened);
  try {
    return await session.snapshot(token, BACKGROUND_CONTEXT);
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}

export async function openOffice(options: OpenOfficeOptions): Promise<Office> {
  const registry = createRegistry();
  const harness = await Harness.open(
    await openStorage(options.storage, options.log),
    {
      models: options.models,
      registry,
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      ...(options.clock === undefined
        ? {}
        : { now: options.clock.now, setTimer: options.clock.setTimer }),
      // Pi Durable hands over a tagged report; the office's callers want the failure itself.
      ...(options.onReport === undefined
        ? {}
        : { onReport: (report: Report) => options.onReport?.(report.error) }),
    },
    BACKGROUND_CONTEXT,
  );
  // Resume by default: work admitted before the last close continues, and this is idempotent.
  if (options.resume !== false) harness.resume();
  const listen: Office["listen"] = async (conversation, onEvent) => {
    const id = conversation.id;
    // Submissions from the stored commits: a commit's observers run after the view's for the same
    // commit, so a submission's events follow that commit's view events, as in 1.3.0's stream.
    const commits = harness.observeCommits({
      advance: (publication) => {
        const records: SubmissionRecord[] = [];
        for (const change of publication.changes) {
          if (change.type === "submission" && change.value.conversationId === id) {
            records.push(change.value);
          }
        }
        records.sort((a, b) => (a.id as number) - (b.id as number));
        for (const record of records) for (const event of submissionEvents(record)) onEvent(event);
      },
      end: () => {},
    });
    // Text and tool calls from the view, which shows a streamed partial as soon as it is adopted.
    // Calls that come before the observation resolves start from its value, so they wait for it.
    let current: ConversationView | undefined;
    let early: { value: ConversationView; ops: readonly Op[] }[] | undefined = [];
    const advance = (value: ConversationView, ops: readonly Op[]) => {
      const before = current;
      current = value;
      for (const event of viewEvents(before, value, ops)) onEvent(event);
    };
    let observation: Observation<ConversationView>;
    try {
      observation = await harness.observeConversation(
        id,
        {
          advance: (call) => {
            if (call.kind !== "value") return;
            if (early !== undefined) early.push({ value: call.value, ops: call.ops });
            else advance(call.value, call.ops);
          },
          end: () => {},
        },
        BACKGROUND_CONTEXT,
      );
    } catch (error) {
      commits.detach();
      throw error;
    }
    current = observation.value;
    const queued = early;
    early = undefined;
    for (const call of queued) advance(call.value, call.ops);
    return {
      async stop() {
        observation.detach();
        commits.detach();
      },
    };
  };
  let closing: Promise<void> | undefined;
  return {
    harness,
    install(bundle) {
      for (const extension of bundle.extensions) registry.install(extension);
    },
    replayOf(tool) {
      const found = registry
        .snapshot()
        .tools()
        .filter((entry) => entry.tool.name === tool);
      if (found.length === 0) return undefined;
      return found.some((entry) => (entry.tool.replay ?? "unsafe") === "unsafe")
        ? "unsafe"
        : "safe";
    },
    async conversation(key, { agent }) {
      if (key === ROOT_KEY) return await harness.root(BACKGROUND_CONTEXT, { agent });
      const known = (await harness.snapshot(OfficeDirectoryDoc, BACKGROUND_CONTEXT))?.names[key];
      if (known !== undefined) {
        const found = await harness.conversation(known as ConversationId, BACKGROUND_CONTEXT);
        if (found !== undefined) return found;
      }
      // `tx.createConversation` takes no agent, so create through the Harness, which applies it in the
      // creating commit, then record the name. A crash between the two leaves one unnamed conversation
      // and the next call creates another; nothing else is affected.
      const created = await harness.createConversation(
        { ownership: { kind: "ownerless" }, agent },
        BACKGROUND_CONTEXT,
      );
      await harness.commit(async (transaction) => {
        const directory = await transaction.doc(OfficeDirectoryDoc);
        directory.names[key] = created.id as number;
      }, BACKGROUND_CONTEXT);
      return created;
    },
    async conversationId(key) {
      const known = (await harness.snapshot(OfficeDirectoryDoc, BACKGROUND_CONTEXT))?.names[key];
      return known === undefined ? undefined : (known as ConversationId);
    },
    async submit(conversation, { input, requestId, entry, whenBusy }) {
      return await conversation.submit(
        {
          type: "input",
          content: input,
          requestId,
          ...(entry === undefined ? {} : { entry }),
          ...(whenBusy === undefined ? {} : { whenBusy }),
        },
        BACKGROUND_CONTEXT,
      );
    },
    async submission(id) {
      return await harness.submission(id, BACKGROUND_CONTEXT);
    },
    async configure(conversation, change) {
      await conversation.configure(change, BACKGROUND_CONTEXT);
    },
    async abort(conversation) {
      await conversation.abort(BACKGROUND_CONTEXT);
    },
    async openSubmissions() {
      const inspection = await harness.inspect(BACKGROUND_CONTEXT);
      return inspection.submissions.map((record) => record.id);
    },
    async snapshot(token) {
      return await harness.snapshot(token, BACKGROUND_CONTEXT);
    },
    listen,
    watch: async function* (conversation) {
      const pending: OfficeEvent[] = [];
      let wake: (() => void) | undefined;
      const listening = await listen(conversation, (event) => {
        pending.push(event);
        wake?.();
      });
      try {
        while (true) {
          const next = pending.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          // No event yet: park until the listener wakes this iteration. A consumer that stops has its
          // `return` run the `finally`, which detaches the watch.
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        await listening.stop();
      }
    },
    resume() {
      harness.resume();
    },
    async close() {
      closing ??= harness.close(BACKGROUND_CONTEXT);
      return await closing;
    },
  };
}

/** The reserved root conversation id, re-exported so callers need no direct Pi Durable import. */
export { ROOT_CONVERSATION_ID };
