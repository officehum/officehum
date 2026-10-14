import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  readonly connectorIdentity?: ConnectorIdentity;
}

export type LocalConnectorIdentity = { readonly version: 1; readonly backend: "local" };
export type GoogleConnectorIdentity = {
  readonly version: 1;
  readonly backend: "google";
  readonly calendarId: string;
  readonly timeZone: "UTC";
  readonly workingHours: { readonly start: "09:00"; readonly end: "12:00" };
  readonly durationMinutes: 60;
};
export type ConnectorIdentity = LocalConnectorIdentity | GoogleConnectorIdentity;

const LOCAL_IDENTITY: LocalConnectorIdentity = { version: 1, backend: "local" };
const LIFECYCLE_TOOLS = ["list_bookings", "reschedule_appointment", "cancel_appointment"] as const;

function parseConnectorIdentity(value: unknown): ConnectorIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed Front Desk connector identity.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("Malformed Front Desk connector identity.");
  if (record.backend === "local") {
    if (Object.keys(record).sort().join(",") !== "backend,version") {
      throw new Error("Malformed Front Desk connector identity.");
    }
    return LOCAL_IDENTITY;
  }
  if (
    record.backend !== "google" ||
    typeof record.calendarId !== "string" ||
    record.calendarId.trim().length === 0 ||
    record.calendarId === "primary" ||
    record.timeZone !== "UTC" ||
    record.durationMinutes !== 60 ||
    record.workingHours === null ||
    typeof record.workingHours !== "object" ||
    Array.isArray(record.workingHours)
  ) {
    throw new Error("Malformed Front Desk connector identity.");
  }
  const hours = record.workingHours as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "backend,calendarId,durationMinutes,timeZone,version,workingHours" ||
    Object.keys(hours).sort().join(",") !== "end,start" ||
    hours.start !== "09:00" ||
    hours.end !== "12:00"
  ) {
    throw new Error("Malformed Front Desk connector identity.");
  }
  return {
    version: 1,
    backend: "google",
    calendarId: record.calendarId.trim(),
    timeZone: "UTC",
    workingHours: { start: "09:00", end: "12:00" },
    durationMinutes: 60,
  };
}

function identityEquals(left: ConnectorIdentity, right: ConnectorIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function readConnectorIdentity(directory: string): ConnectorIdentity {
  const path = join(directory, "connector.json");
  try {
    return parseConnectorIdentity(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof SyntaxError) throw new Error("Malformed Front Desk connector identity.");
      throw error;
    }
  }
  return LOCAL_IDENTITY;
}

export function hasDurableLocalState(directory: string): boolean {
  if (existsSync(join(directory, "harness"))) return true;
  const path = join(directory, "calendar.sqlite");
  if (!existsSync(path)) return false;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    for (const table of ["bookings", "approval_decisions", "calendar_operations"] as const) {
      const exists = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (exists !== undefined && database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
        return true;
      }
    }
    return false;
  } finally {
    database.close();
  }
}

function bindConnectorIdentity(
  directory: string,
  requestedValue: ConnectorIdentity | undefined,
): ConnectorIdentity {
  const requested = parseConnectorIdentity(requestedValue ?? LOCAL_IDENTITY);
  const path = join(directory, "connector.json");
  let stored: ConnectorIdentity | undefined;
  try {
    stored = parseConnectorIdentity(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof SyntaxError) throw new Error("Malformed Front Desk connector identity.");
      throw error;
    }
  }
  if (stored === undefined) {
    stored = hasDurableLocalState(directory) ? LOCAL_IDENTITY : requested;
    writeFileSync(path, `${JSON.stringify(stored)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
  if (!identityEquals(stored, requested)) {
    throw new Error(
      `Front Desk connector identity mismatch: state is bound to ${stored.backend}, requested ${requested.backend}.`,
    );
  }
  return stored;
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
  const database = new DatabaseSync(join(directory, "ownership.sqlite"));
  const record: LockRecord = { pid: process.pid, token: randomUUID() };
  let held = false;
  let released = false;
  const releaseDatabase = () => {
    if (held) database.exec("ROLLBACK");
    held = false;
    database.close();
  };
  try {
    database.exec(
      "PRAGMA busy_timeout = 1000; CREATE TABLE IF NOT EXISTS ownership_guard (id INTEGER PRIMARY KEY CHECK (id = 1)); PRAGMA busy_timeout = 0;",
    );
    try {
      database.exec("BEGIN IMMEDIATE");
      held = true;
    } catch (error) {
      throw new Error("Front Desk state is owned by another active process.", { cause: error });
    }

    let owner: LockRecord | undefined;
    try {
      owner = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof SyntaxError) {
          throw new Error(`Malformed ownership lock at ${path}; inspect it before retrying.`);
        }
        throw error;
      }
    }
    if (owner !== undefined) {
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string") {
        throw new Error(`Malformed ownership lock at ${path}; inspect it before retrying.`);
      }
      if (isAlive(owner.pid)) {
        throw new Error(`Front Desk state is owned by active process ${owner.pid}.`);
      }
      unlinkSync(path);
    }
    writeFileSync(path, JSON.stringify(record), { encoding: "utf8", flag: "wx", mode: 0o600 });
    return {
      release() {
        if (released) return;
        released = true;
        let failure: unknown;
        try {
          try {
            const current = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
            if (current.token === record.token) unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        } catch (error) {
          failure = error;
        } finally {
          releaseDatabase();
        }
        if (failure !== undefined) throw failure;
      },
    };
  } catch (error) {
    releaseDatabase();
    throw error;
  }
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
    bindConnectorIdentity(options.directory, options.connectorIdentity);
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
    const resolved = await root.agent(BACKGROUND_CONTEXT);
    const missing = LIFECYCLE_TOOLS.filter(
      (name) => !resolved.tools.some((tool) => tool.name === name),
    );
    if (missing.length > 0) {
      const selected = new Set([...resolved.tools.map((tool) => tool.name), ...missing]);
      const registrations = options.role.extensions
        .flatMap((extension) => extension.tools ?? [])
        .filter((tool) => selected.has(tool.name));
      await root.configure({ tools: registrations }, BACKGROUND_CONTEXT);
    }
    let closePromise: Promise<void> | undefined;
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
        closePromise ??= (async () => {
          try {
            await harness?.close(BACKGROUND_CONTEXT);
          } finally {
            lock.release();
          }
        })();
        return closePromise;
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
