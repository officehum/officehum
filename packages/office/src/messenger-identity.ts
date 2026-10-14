import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ConsoleMessengerIdentity = { readonly version: 1; readonly backend: "console" };
export type ResendMessengerIdentity = {
  readonly version: 1;
  readonly backend: "resend";
  readonly accountId: string;
  readonly fromEmail: string;
  readonly subject: string;
};
export type MessengerIdentity = ConsoleMessengerIdentity | ResendMessengerIdentity;

export const CONSOLE_MESSENGER_IDENTITY: ConsoleMessengerIdentity = {
  version: 1,
  backend: "console",
};

const EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function exactString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !hasControl(value)
  );
}

export function parseMessengerIdentity(value: unknown): MessengerIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed Front Desk Messenger identity.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version === 1 &&
    record.backend === "console" &&
    Object.keys(record).sort().join(",") === "backend,version"
  ) {
    return CONSOLE_MESSENGER_IDENTITY;
  }
  if (
    record.version !== 1 ||
    record.backend !== "resend" ||
    Object.keys(record).sort().join(",") !== "accountId,backend,fromEmail,subject,version" ||
    !exactString(record.accountId, 100) ||
    !exactString(record.fromEmail, 254) ||
    record.fromEmail !== record.fromEmail.toLowerCase() ||
    !EMAIL.test(record.fromEmail) ||
    !exactString(record.subject, 200)
  ) {
    throw new Error("Malformed Front Desk Messenger identity.");
  }
  return {
    version: 1,
    backend: "resend",
    accountId: record.accountId,
    fromEmail: record.fromEmail,
    subject: record.subject,
  };
}

export function messengerIdentityString(identity: MessengerIdentity): string {
  const parsed = parseMessengerIdentity(identity);
  if (parsed.backend === "console") return "officehum.console.v1";
  return `officehum.resend.v1:${createHash("sha256").update(JSON.stringify(parsed)).digest("hex")}`;
}

function readSaved(directory: string): MessengerIdentity | undefined {
  const path = join(directory, "messenger.json");
  try {
    return parseMessengerIdentity(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error("Malformed Front Desk Messenger identity.");
    throw error;
  }
}

function tableHasRows(path: string, tables: readonly string[]): boolean {
  if (!existsSync(path)) return false;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    for (const table of tables) {
      const exists = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (exists !== undefined && database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
        return true;
    }
    return false;
  } finally {
    database.close();
  }
}

export function hasDurableMessagingState(directory: string): boolean {
  if (existsSync(join(directory, "harness"))) return true;
  if (tableHasRows(join(directory, "messages.sqlite"), ["messages"])) return true;
  return tableHasRows(join(directory, "calendar.sqlite"), [
    "bookings",
    "approval_decisions",
    "calendar_operations",
  ]);
}

export function readMessengerIdentity(directory: string): MessengerIdentity | undefined {
  const stored = readSaved(directory);
  if (stored === undefined && existsSync(join(directory, "email.sqlite"))) {
    throw new Error(
      "Found an email ledger without Messenger metadata; inspect the state before retrying.",
    );
  }
  return stored;
}

export function bindMessengerIdentity(
  directory: string,
  requestedValue: MessengerIdentity,
): MessengerIdentity {
  const requested = parseMessengerIdentity(requestedValue);
  mkdirSync(directory, { recursive: true });
  let stored = readSaved(directory);
  if (stored === undefined) {
    if (existsSync(join(directory, "email.sqlite"))) {
      throw new Error(
        "Found an email ledger without Messenger metadata; inspect the state before retrying.",
      );
    }
    const historical = hasDurableMessagingState(directory);
    if (historical && requested.backend !== "console") {
      throw new Error("Legacy Front Desk state is bound to the console Messenger.");
    }
    stored = historical ? CONSOLE_MESSENGER_IDENTITY : requested;
    writeFileSync(join(directory, "messenger.json"), `${JSON.stringify(stored)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
  if (JSON.stringify(stored) !== JSON.stringify(requested)) {
    throw new Error(
      `Front Desk Messenger identity mismatch: state is bound to ${stored.backend}, requested ${requested.backend}.`,
    );
  }
  return stored;
}
