import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry,
  type Conversation,
  createRegistry,
  Harness,
  type ModelRef,
  type SettledSubmissionRecord,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { RoleBundle } from "@officehum/sdk";

export interface SoloResult {
  readonly submissionId: SubmissionId;
  readonly settlement: SettledSubmissionRecord;
  readonly text?: string;
}

export interface SoloSession {
  readonly harness: Harness;
  readonly root: Conversation;
  submit(content: string, requestId: string): Promise<SoloResult>;
  resume(): Promise<SoloResult[]>;
  close(): Promise<void>;
}

export interface OpenSoloOptions {
  readonly directory: string;
  readonly role: RoleBundle;
  readonly models: Models;
  readonly model?: ModelRef;
}

type LockRecord = { pid: number; token: string };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireLock(directory: string): { release(): void } {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "owner.lock");
  const record: LockRecord = { pid: process.pid, token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify(record), "utf8");
      } finally {
        closeSync(descriptor);
      }
      return {
        release() {
          try {
            const current = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
            if (current.token === record.token) unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: LockRecord;
      try {
        owner = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
      } catch {
        throw new Error(`Malformed ownership lock at ${path}; inspect it before retrying.`);
      }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string") {
        throw new Error(`Malformed ownership lock at ${path}; inspect it before retrying.`);
      }
      if (isAlive(owner.pid)) {
        throw new Error(`Front Desk state is owned by active process ${owner.pid}.`);
      }
      unlinkSync(path);
    }
  }
  throw new Error(`Could not acquire Front Desk ownership lock at ${path}.`);
}

async function resultFor(
  root: Conversation,
  submissionId: SubmissionId,
  settlement: SettledSubmissionRecord,
): Promise<SoloResult> {
  if (settlement.status !== "done" || settlement.type !== "input") {
    return { submissionId, settlement };
  }
  const entry = await root.commit(
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

export async function openSolo(options: OpenSoloOptions): Promise<SoloSession> {
  const lock = acquireLock(options.directory);
  let harness: Harness | undefined;
  try {
    const registry = createRegistry();
    for (const extension of options.role.extensions) registry.install(extension);
    const storage = await openNodeJsonlStorage(
      join(options.directory, "harness"),
      BACKGROUND_CONTEXT,
      { fsync: true },
    );
    harness = await Harness.open(storage, { models: options.models, registry }, BACKGROUND_CONTEXT);
    const agent =
      options.model === undefined
        ? options.role.agent
        : { ...options.role.agent, model: options.model };
    const root = await harness.root(BACKGROUND_CONTEXT, { agent });
    let closed = false;
    const session: SoloSession = {
      harness,
      root,
      async submit(content, requestId) {
        const submission = await root.submit(
          { type: "input", content, requestId },
          BACKGROUND_CONTEXT,
        );
        const settlement = await submission.wait(BACKGROUND_CONTEXT);
        return resultFor(root, submission.id, settlement);
      },
      async resume() {
        const pending = (await harness?.inspect(BACKGROUND_CONTEXT))?.submissions ?? [];
        harness?.resume();
        const results: SoloResult[] = [];
        for (const record of pending) {
          const submission = await harness?.submission(record.id, BACKGROUND_CONTEXT);
          if (submission === undefined) continue;
          const settlement = await submission.wait(BACKGROUND_CONTEXT);
          results.push(await resultFor(root, submission.id, settlement));
        }
        return results;
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await harness?.close(BACKGROUND_CONTEXT);
        } finally {
          lock.release();
        }
      },
    };
    return session;
  } catch (error) {
    try {
      await harness?.close(BACKGROUND_CONTEXT);
    } finally {
      lock.release();
    }
    throw error;
  }
}
