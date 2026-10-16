/**
 * Running one role package on its own, over one SQLite office: the core the `officehum run` command
 * drives, and what its crash-and-resume test exercises.
 *
 * It is deliberately small. `openRoleRun` opens an office over one SQLite file, installs the loaded
 * role's extensions, opens the role's conversation when absent (or reacquires it on resume), and
 * exposes `submit`, `resume`, `reload` and the manifest's operator commands. Every runtime call goes
 * through the adapter; this module imports only Pi Durable types and the `AssistantEntry` authoring
 * helper, like `solo.ts`.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  type AgentChange,
  AssistantEntry,
  type Conversation,
  type ModelRef,
  type SettledSubmissionRecord,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { type Engine, type EngineResult, type Issue, runOperatorCommand } from "@officehum/sdk";
import { type Office, openOffice, ROOT_KEY } from "../adapter/index.js";
import type { LoadedRole } from "./load-role.js";

/** One settled submission and the assistant's answer, when it gave one. */
export interface RoleRunResult {
  readonly submissionId: SubmissionId;
  readonly settlement: SettledSubmissionRecord;
  readonly text?: string;
}

export interface RoleRunOptions {
  /** The role to run: the result of `loadRole`. */
  readonly role: LoadedRole;
  /** The SQLite file to open the office on, e.g. `.officehum/frontdesk.sqlite`. */
  readonly database: string;
  readonly models: Models;
  /** Overrides the role's default model; the persisted model wins on reopen. */
  readonly model?: ModelRef;
  /** Receives failures that do not fail the calling operation. Wired to the harness `onReport`. */
  readonly onReport?: (error: unknown) => void;
}

/** A running role: its office, its conversation, and the operations the CLI offers. */
export interface RoleRun {
  readonly office: Office;
  readonly conversation: Conversation;
  readonly role: LoadedRole;
  readonly model: ModelRef;
  /** Admits `input` as an idempotent submission and waits for it to settle. */
  submit(input: string, requestId: string): Promise<RoleRunResult>;
  /** Reacquires and waits on every submission left unsettled by a previous run. */
  resume(): Promise<RoleRunResult[]>;
  /** Re-reads the role's files and overlays, then re-applies its agent settings. Named issues on problems. */
  reload(): Promise<readonly Issue[]>;
  /** Runs one operator command from the manifest: an engine view, with no model involved. */
  command(name: string): Promise<EngineResult>;
  close(): Promise<void>;
}

/** The engine `runOperatorCommand` needs; a role without an engine cannot run a command. */
function requireEngine(role: LoadedRole): Engine {
  const { engine } = role;
  if (engine === undefined) {
    throw new Error(`${role.manifest.id} declares no engine, so it has no operator commands.`);
  }
  return engine;
}

async function resultFor(
  conversation: Conversation,
  submissionId: SubmissionId,
  settlement: SettledSubmissionRecord,
): Promise<RoleRunResult> {
  if (settlement.status !== "done" || settlement.type !== "input") {
    return { submissionId, settlement };
  }
  const entry = await conversation.commit(
    (transaction) => transaction.entry(AssistantEntry, settlement.answer),
    BACKGROUND_CONTEXT,
  );
  const message = entry?.model?.find((item) => item.role === "assistant");
  const text = message?.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return text === undefined ? { submissionId, settlement } : { submissionId, settlement, text };
}

/**
 * Opens one role over one SQLite office. Refuses a database already bound to a different model, so a
 * `--model` change cannot silently rewrite an existing conversation; the operator picks a matching
 * `--model` or a fresh database.
 */
export async function openRoleRun(options: RoleRunOptions): Promise<RoleRun> {
  const office = await openOffice({
    storage: { sqlite: options.database },
    models: options.models,
    // Open paused so `resume()` can see which submissions a crash left unsettled; `submit` and
    // `Submission.wait` enable scheduling themselves.
    resume: false,
    ...(options.onReport === undefined ? {} : { onReport: options.onReport }),
  });
  try {
    const { role } = options;
    office.install(role.bundle);
    const model = options.model ?? role.bundle.agent.model ?? undefined;
    if (model === undefined) {
      throw new Error(
        `${role.manifest.id} declares no model; pass one, e.g. --model paper/ultramarine-1-flash.`,
      );
    }
    const agent: AgentChange = { ...role.bundle.agent, model };
    const conversation = await office.conversation(ROOT_KEY, { agent });
    const persisted = (await conversation.agent(BACKGROUND_CONTEXT)).model;
    if (persisted !== undefined && !sameModel(persisted, model)) {
      throw new Error(
        `The office at ${options.database} already uses ${persisted.provider}/${persisted.modelId}; ` +
          `pass --model ${persisted.provider}/${persisted.modelId}, or use a fresh database.`,
      );
    }
    if (persisted === undefined) await office.configure(conversation, agent);
    const currentAgent = (): AgentChange => ({
      ...role.bundle.agent,
      model: options.model === undefined ? (role.bundle.agent.model ?? model) : model,
    });

    let closing: Promise<void> | undefined;
    return {
      office,
      conversation,
      role,
      model,
      async submit(input, requestId) {
        const submission = await office.submit(conversation, { input, requestId });
        const settlement = await submission.wait(BACKGROUND_CONTEXT);
        return await resultFor(conversation, submission.id, settlement);
      },
      async resume() {
        // `openOffice` resumed scheduling on open; `openSubmissions` returns the submissions still in
        // flight, so a reacquired submission settles here exactly as an original one would.
        const pending = await office.openSubmissions();
        const results: RoleRunResult[] = [];
        for (const id of pending) {
          const submission = await office.submission(id);
          if (submission === undefined) continue;
          const settlement = await submission.wait(BACKGROUND_CONTEXT);
          results.push(await resultFor(conversation, submission.id, settlement));
        }
        return results;
      },
      async reload() {
        const issues = role.reload?.() ?? [];
        await office.configure(conversation, currentAgent());
        return issues;
      },
      async command(name) {
        return await runOperatorCommand(role.manifest, requireEngine(role), name);
      },
      async close() {
        closing ??= office.close();
        return await closing;
      },
    };
  } catch (error) {
    await office.close();
    throw error;
  }
}

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.modelId === right.modelId;
}
