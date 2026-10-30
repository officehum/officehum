import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The one channel the console outbox records.
 *
 * It used to take `sms` as well, because `send_message` did. The Front Desk no longer sends SMS
 * (RASF-3162), and an outbox that would happily record a text is a door left open behind a rule —
 * so it refuses the channel and says why, rather than storing a delivery that could never happen.
 */
export type ConsoleMessageChannel = "email";
export type ConsoleMessageIntent = {
  to: string;
  channel: ConsoleMessageChannel;
  text: string;
};
export type ConsoleDeliveryReceipt = { id: string; status: "recorded" | "accepted" };
export type ConsoleMessage = {
  requestId: string;
  intent: ConsoleMessageIntent;
  delivery: ConsoleDeliveryReceipt;
};

export interface ConsoleMessenger {
  readonly identity: string;
  send(
    intent: ConsoleMessageIntent,
    options: { requestId: string },
  ): Promise<ConsoleDeliveryReceipt>;
  messages(): ConsoleMessage[];
  close(): void;
}

const CONSOLE_IDENTITY = "officehum.console.v1";

type MessageRow = {
  request_id: string;
  to_address: string;
  channel: string;
  text: string;
  delivery_id: string;
  delivery_status: string;
};

function hasControl(value: string, message = false): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (message && (code === 9 || code === 10 || code === 13)) return false;
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function bounded(value: string, label: string, maximum: number): string {
  if (value.length === 0 || value.length > maximum || value.trim() !== value || hasControl(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function validateIntent(value: ConsoleMessageIntent): ConsoleMessageIntent {
  if (value === null || typeof value !== "object") throw new Error("Message intent is invalid.");
  const channel = value.channel;
  if (channel !== "email") {
    throw new Error("The console outbox records email only: the office does not send SMS.");
  }
  const to = bounded(value.to, "Message destination", 254);
  if (
    value.text.length === 0 ||
    value.text.length > 4000 ||
    value.text.trim().length === 0 ||
    hasControl(value.text, true)
  ) {
    throw new Error("Message text is invalid.");
  }
  return { to, channel, text: value.text };
}

function rowMessage(row: MessageRow): ConsoleMessage {
  if (
    typeof row.request_id !== "string" ||
    typeof row.to_address !== "string" ||
    row.channel !== "email" ||
    typeof row.text !== "string" ||
    typeof row.delivery_id !== "string" ||
    row.delivery_status !== "recorded"
  ) {
    throw new Error("Malformed console message row.");
  }
  try {
    return {
      requestId: bounded(row.request_id, "Stored request ID", 500),
      intent: validateIntent({
        to: row.to_address,
        channel: row.channel,
        text: row.text,
      }),
      delivery: {
        id: bounded(row.delivery_id, "Stored delivery ID", 200),
        status: "recorded",
      },
    };
  } catch (error) {
    throw new Error("Malformed console message row.", { cause: error });
  }
}

function sameIntent(left: ConsoleMessageIntent, right: ConsoleMessageIntent): boolean {
  return left.to === right.to && left.channel === right.channel && left.text === right.text;
}

/** Open the durable synthetic outbox. It records locally and never performs a network request. */
export function openConsoleMessenger(path: string): ConsoleMessenger {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  let closed = false;
  try {
    database.exec(
      `PRAGMA busy_timeout = 5000;
       PRAGMA synchronous = FULL;
       PRAGMA journal_mode = WAL;
       CREATE TABLE IF NOT EXISTS messenger_metadata (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         identity TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS messages (
         request_id TEXT PRIMARY KEY,
         to_address TEXT NOT NULL,
         channel TEXT NOT NULL,
         text TEXT NOT NULL,
         delivery_id TEXT NOT NULL,
         delivery_status TEXT NOT NULL
       );`,
    );
    const metadata = database
      .prepare("SELECT identity FROM messenger_metadata WHERE singleton = 1")
      .get() as { identity: string } | undefined;
    if (metadata === undefined) {
      const anyMessage = database.prepare("SELECT 1 FROM messages LIMIT 1").get();
      if (anyMessage !== undefined) throw new Error("Missing console Messenger identity.");
      database
        .prepare("INSERT INTO messenger_metadata (singleton, identity) VALUES (1, ?)")
        .run(CONSOLE_IDENTITY);
    } else if (metadata.identity !== CONSOLE_IDENTITY) {
      throw new Error("Console Messenger identity does not match this outbox.");
    }
    const rows = database
      .prepare(
        "SELECT request_id, to_address, channel, text, delivery_id, delivery_status FROM messages ORDER BY rowid",
      )
      .all() as unknown as MessageRow[];
    rows.forEach(rowMessage);
  } catch (error) {
    database.close();
    throw error;
  }

  const find = database.prepare(
    "SELECT request_id, to_address, channel, text, delivery_id, delivery_status FROM messages WHERE request_id = ?",
  );
  const insert = database.prepare(
    "INSERT INTO messages (request_id, to_address, channel, text, delivery_id, delivery_status) VALUES (?, ?, ?, ?, ?, 'recorded')",
  );
  const list = database.prepare(
    "SELECT request_id, to_address, channel, text, delivery_id, delivery_status FROM messages ORDER BY rowid",
  );

  const ensureOpen = () => {
    if (closed) throw new Error("Console Messenger is closed.");
  };

  return {
    identity: CONSOLE_IDENTITY,
    async send(rawIntent, options) {
      ensureOpen();
      const intent = validateIntent(rawIntent);
      const requestId = bounded(options.requestId, "Request ID", 500);
      database.exec("BEGIN IMMEDIATE");
      try {
        const existing = find.get(requestId) as MessageRow | undefined;
        if (existing !== undefined) {
          const prior = rowMessage(existing);
          if (!sameIntent(prior.intent, intent)) {
            throw new Error("Request ID was already bound to a different intent.");
          }
          database.exec("COMMIT");
          return { ...prior.delivery };
        }
        const delivery: ConsoleDeliveryReceipt = { id: randomUUID(), status: "recorded" };
        insert.run(requestId, intent.to, intent.channel, intent.text, delivery.id);
        database.exec("COMMIT");
        return delivery;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    },
    messages() {
      ensureOpen();
      return (list.all() as unknown as MessageRow[]).map(rowMessage);
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}
