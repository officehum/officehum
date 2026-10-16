/**
 * The Pi Durable adapter.
 *
 * This directory is the only place in Office Hum that calls Pi Durable's runtime API. Everything else
 * imports this surface, or Pi Durable *types* and authoring helpers (`defineTool`, `defineRole`,
 * `hook`, `defineDoc`, document tokens), which `AGENTS.md` allows. The rule is enforced by
 * `imports.test.ts`.
 *
 * The adapter adds no policy: no approvals, budgets, retries or routing. It wraps, in order:
 * `Harness.open` + `resume()`, `createRegistry`, `Harness.root`/`createConversation`/`conversation`,
 * `Conversation.submit`/`configure`/`abort`, `Harness.submission`/`inspect`, `watchEvents`,
 * `Session.snapshot` and `Session.close`. Each method names what it wraps.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  type AgentChange,
  type Conversation,
  type ConversationId,
  createRegistry,
  createSession,
  defineDoc,
  Harness,
  type HarnessSettings,
  type InputEntry,
  type JsonObject,
  ROOT_CONVERSATION_ID,
  type SessionDocToken,
  type Storage,
  type Submission,
  type SubmissionId,
  watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { RoleBundle } from "@officehum/sdk";
import { type OfficeEvent, officeEvents } from "./watch.js";

/**
 * Where one office keeps its durable state.
 *
 * `memory` is for tests. `sqlite` is one file per office, the shape the issue specifies. `jsonl` is a
 * directory holding Pi Durable's JSONL store, which is what solo mode writes today; it is here so the
 * solo, inbound and reply paths can move onto this adapter without changing their on-disk format.
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
};

/**
 * Pi Durable mints conversation ids and has no name index, so the adapter keeps one: a session-scoped
 * document mapping Office Hum's stable keys to conversation ids. Created in the same commit as the
 * conversation it names, so a crash cannot leave a name pointing at nothing.
 */
const OfficeDirectoryDoc = defineDoc<{ names: Record<string, number> }>({
  kind: "officehum.office.directory",
  version: 1,
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
   * `Harness.root` for `ROOT_KEY`, otherwise `Harness.conversation` by name, creating an ownerless
   * conversation with `Conversation.submit`-ready agent settings in one commit when the name is new.
   */
  conversation(key: string, options: OfficeConversationOptions): Promise<Conversation>;
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
  /** `watchEvents`, mapped to Office Hum's four kinds. Iterate until done, then `return`. */
  watch(conversation: Conversation): AsyncIterable<OfficeEvent>;
  /** `Harness.inspect().submissions`: unsettled submissions, for a resume pass. */
  openSubmissions(): Promise<readonly SubmissionId[]>;
  /** `Session.snapshot` for a session-scoped document. */
  snapshot<T extends JsonObject>(token: SessionDocToken<T>): Promise<Readonly<T> | undefined>;
  /** `Session.close`: seals admission, settles admitted commits, then closes storage. Idempotent. */
  close(): Promise<void>;
}

/** Open storage for an office. `jsonl` matches what `openSolo` opens today, `fsync` included. */
async function openStorage(option: OfficeStorage): Promise<Storage> {
  if (option === "memory") return new MemoryStorage();
  if ("sqlite" in option) return await openNodeSqliteStorage(option.sqlite);
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
    await openStorage(options.storage),
    {
      models: options.models,
      registry,
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      ...(options.onReport === undefined ? {} : { onReport: options.onReport }),
    },
    BACKGROUND_CONTEXT,
  );
  // Resume by default: work admitted before the last close continues, and this is idempotent.
  if (options.resume !== false) harness.resume();
  let closing: Promise<void> | undefined;
  return {
    harness,
    install(bundle) {
      for (const extension of bundle.extensions) registry.install(extension);
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
    async submit(conversation, { input, requestId, entry }) {
      return await conversation.submit(
        {
          type: "input",
          content: input,
          requestId,
          ...(entry === undefined ? {} : { entry }),
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
    watch: async function* (conversation) {
      const stream = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT);
      const pending: OfficeEvent[] = [];
      let wake: (() => void) | undefined;
      stream.start(async (events) => {
        for (const event of events) {
          for (const mapped of officeEvents(event)) pending.push(mapped);
        }
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
        await stream.stop();
      }
    },
    async close() {
      closing ??= harness.close(BACKGROUND_CONTEXT);
      return await closing;
    },
  };
}

/** The reserved root conversation id, re-exported so callers need no direct Pi Durable import. */
export { ROOT_CONVERSATION_ID };
