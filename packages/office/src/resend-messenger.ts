import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  messengerIdentityString,
  parseMessengerIdentity,
  type ResendMessengerIdentity,
} from "./messenger-identity.js";

export type ResendMessageIntent = { to: string; channel: "email" | "sms"; text: string };
export type ResendDeliveryReceipt = { id: string; status: "accepted" };
export type ResendMessengerOptions = {
  accountId: string;
  fromEmail: string;
  subject: string;
  getApiKey: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};
export interface ResendMessenger {
  readonly identity: string;
  send(intent: ResendMessageIntent, options: { requestId: string }): Promise<ResendDeliveryReceipt>;
  close(): Promise<void>;
}

type OperationRow = {
  request_id: string;
  intent_json: string;
  payload_json: string;
  provider_key: string;
  first_attempt_at: number;
  last_observed_at: number;
  state: string;
  receipt_id: string | null;
};

const ENDPOINT = "https://api.resend.com/emails";
const RETRY_WINDOW = 23 * 60 * 60 * 1000;
const RESPONSE_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT = 30_000;
const EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const UNCERTAIN =
  "Email outcome is uncertain; automatic retry is blocked. Inspect Resend before a new authorized submission.";

function hasControl(value: string, message = false): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (message && (code === 9 || code === 10 || code === 13)) return false;
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function exact(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !hasControl(value)
  );
}

function validRequestId(value: unknown): string {
  if (!exact(value, 500)) throw new Error("Request ID is invalid.");
  return value;
}

function validIntent(value: unknown): { to: string; channel: "email"; text: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Message intent is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (record.channel !== "email") throw new Error("Resend Messenger supports email only.");
  if (!exact(record.to, 254) || record.to !== record.to.toLowerCase() || !EMAIL.test(record.to)) {
    throw new Error("Email destination is invalid.");
  }
  if (
    typeof record.text !== "string" ||
    record.text.length === 0 ||
    record.text.length > 4000 ||
    record.text.trim().length === 0 ||
    hasControl(record.text, true)
  ) {
    throw new Error("Message text is invalid.");
  }
  return { to: record.to, channel: "email", text: record.text };
}

function safeTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(UNCERTAIN);
  return value;
}

function validCredential(value: unknown): string {
  if (!exact(value, 1000)) throw new Error("Resend API key is unavailable.");
  return value;
}

function validReceiptId(value: unknown): string {
  if (!exact(value, 200)) throw new Error("Resend response was invalid.");
  return value;
}

function providerKey(identity: string, namespace: string, requestId: string): string {
  return `officehum.email.v1/${createHash("sha256")
    .update(JSON.stringify([identity, namespace, requestId]))
    .digest("hex")}`;
}

function inTransaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

async function boundedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await Promise.race([reader.read(), aborted]);
      } catch (error) {
        if (signal.aborted) cancelReader(reader);
        throw error;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      if (next.done) break;
      length += next.value.byteLength;
      if (length > RESPONSE_LIMIT) {
        cancelReader(reader);
        throw new Error("Resend response was invalid.");
      }
      chunks.push(next.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A native stream may keep its read pending while cancellation stalls.
    }
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    throw new Error("Resend response was invalid.");
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {});
  } catch {
    // Cancellation is cleanup only and must not extend the request deadline.
  }
}

function tableNames(database: DatabaseSync): string[] {
  return (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as unknown as { name: string }[]
  ).map(({ name }) => name);
}

function reserveFreshLedger(path: string): boolean {
  try {
    closeSync(openSync(path, "wx", 0o600));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function parsedJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Resend response was invalid.");
  }
}

function validatePendingTime(row: OperationRow, now: number): void {
  const observed = safeTime(now);
  if (
    !Number.isSafeInteger(row.first_attempt_at) ||
    row.first_attempt_at < 0 ||
    !Number.isSafeInteger(row.first_attempt_at + RETRY_WINDOW) ||
    !Number.isSafeInteger(row.last_observed_at) ||
    row.last_observed_at < row.first_attempt_at ||
    observed < row.last_observed_at ||
    observed >= row.first_attempt_at + RETRY_WINDOW
  ) {
    throw new Error(UNCERTAIN);
  }
}

function validateRow(
  row: OperationRow,
  identity: string,
  namespace: string,
  authority: ResendMessengerIdentity,
): OperationRow {
  if (
    !exact(row.request_id, 500) ||
    typeof row.intent_json !== "string" ||
    typeof row.payload_json !== "string" ||
    row.provider_key !== providerKey(identity, namespace, row.request_id) ||
    !Number.isSafeInteger(row.first_attempt_at) ||
    row.first_attempt_at < 0 ||
    !Number.isSafeInteger(row.first_attempt_at + RETRY_WINDOW) ||
    !Number.isSafeInteger(row.last_observed_at) ||
    row.last_observed_at < row.first_attempt_at ||
    (row.state !== "pending" && row.state !== "accepted") ||
    (row.state === "pending" ? row.receipt_id !== null : !exact(row.receipt_id, 200))
  ) {
    throw new Error("Malformed email ledger operation.");
  }
  try {
    const intentValue = JSON.parse(row.intent_json) as Record<string, unknown>;
    if (
      intentValue === null ||
      typeof intentValue !== "object" ||
      Array.isArray(intentValue) ||
      Object.keys(intentValue).join(",") !== "to,channel,text"
    ) {
      throw new Error();
    }
    const storedIntent = validIntent(intentValue);
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).join(",") !== "from,to,subject,text" ||
      payload.from !== authority.fromEmail ||
      payload.subject !== authority.subject ||
      !Array.isArray(payload.to) ||
      payload.to.length !== 1 ||
      payload.to[0] !== storedIntent.to ||
      payload.text !== storedIntent.text
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("Malformed email ledger operation.");
  }
  return row;
}

/** Open a durable Resend email adapter. Construction performs no network access. */
export function openResendMessenger(
  path: string,
  options: ResendMessengerOptions,
): ResendMessenger {
  if (options === null || typeof options !== "object")
    throw new Error("Resend authority is invalid.");
  const authority = parseMessengerIdentity({
    version: 1,
    backend: "resend",
    accountId: options.accountId,
    fromEmail: options.fromEmail,
    subject: options.subject,
  }) as ResendMessengerIdentity;
  if (typeof options.getApiKey !== "function")
    throw new Error("Resend credential callback is invalid.");
  const identity = messengerIdentityString(authority);
  const authorityJson = JSON.stringify(authority);
  const transport = options.fetch ?? globalThis.fetch;
  const clock = options.now ?? Date.now;
  mkdirSync(dirname(path), { recursive: true });
  const freshPath = reserveFreshLedger(path);
  const database = new DatabaseSync(path);
  let namespace = "";
  try {
    database.exec(
      `PRAGMA busy_timeout = 5000;
       PRAGMA synchronous = FULL;
       PRAGMA journal_mode = WAL;`,
    );
    if (freshPath && tableNames(database).length === 0) {
      inTransaction(database, () => {
        if (tableNames(database).length !== 0) return;
        const initialNamespace = randomUUID();
        database.exec(
          `CREATE TABLE email_metadata (
             singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
             schema_version INTEGER NOT NULL,
             authority_json TEXT NOT NULL,
             ledger_namespace TEXT NOT NULL
           );
           CREATE TABLE email_operations (
             request_id TEXT PRIMARY KEY,
             intent_json TEXT NOT NULL,
             payload_json TEXT NOT NULL,
             provider_key TEXT NOT NULL,
             first_attempt_at INTEGER NOT NULL,
             last_observed_at INTEGER NOT NULL,
             state TEXT NOT NULL,
             receipt_id TEXT
           );`,
        );
        database
          .prepare(
            "INSERT INTO email_metadata (singleton, schema_version, authority_json, ledger_namespace) VALUES (1, 1, ?, ?)",
          )
          .run(authorityJson, initialNamespace);
      });
    }
    const tables = tableNames(database);
    const metadataColumns = (
      database.prepare("PRAGMA table_info(email_metadata)").all() as unknown as { name: string }[]
    ).map(({ name }) => name);
    const operationColumns = (
      database.prepare("PRAGMA table_info(email_operations)").all() as unknown as { name: string }[]
    ).map(({ name }) => name);
    if (
      tables.join(",") !== "email_metadata,email_operations" ||
      metadataColumns.join(",") !== "singleton,schema_version,authority_json,ledger_namespace" ||
      operationColumns.join(",") !==
        "request_id,intent_json,payload_json,provider_key,first_attempt_at,last_observed_at,state,receipt_id"
    ) {
      throw new Error("Malformed email ledger schema.");
    }
    const metadataRows = database
      .prepare(
        "SELECT singleton, schema_version, authority_json, ledger_namespace FROM email_metadata",
      )
      .all() as unknown as {
      singleton: number;
      schema_version: number;
      authority_json: string;
      ledger_namespace: string;
    }[];
    if (metadataRows.length === 0) {
      throw new Error("Malformed email ledger metadata.");
    } else {
      const metadata = metadataRows[0];
      if (
        metadataRows.length !== 1 ||
        metadata?.singleton !== 1 ||
        metadata.schema_version !== 1 ||
        metadata.authority_json !== authorityJson ||
        typeof metadata.ledger_namespace !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          metadata.ledger_namespace,
        )
      ) {
        throw new Error("Email ledger authority does not match this Messenger.");
      }
      namespace = metadata.ledger_namespace;
    }
    const rows = database
      .prepare(
        "SELECT request_id, intent_json, payload_json, provider_key, first_attempt_at, last_observed_at, state, receipt_id FROM email_operations",
      )
      .all() as unknown as OperationRow[];
    rows.forEach((row) => {
      validateRow(row, identity, namespace, authority);
    });
  } catch (error) {
    database.close();
    throw error;
  }

  const find = database.prepare(
    "SELECT request_id, intent_json, payload_json, provider_key, first_attempt_at, last_observed_at, state, receipt_id FROM email_operations WHERE request_id = ?",
  );
  const insert = database.prepare(
    "INSERT INTO email_operations (request_id, intent_json, payload_json, provider_key, first_attempt_at, last_observed_at, state, receipt_id) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL)",
  );
  const updateObserved = database.prepare(
    "UPDATE email_operations SET last_observed_at = ? WHERE request_id = ? AND state = 'pending'",
  );
  const accept = database.prepare(
    "UPDATE email_operations SET state = 'accepted', receipt_id = ? WHERE request_id = ? AND state = 'pending'",
  );
  let closed = false;
  const closeController = new AbortController();
  let activeController: AbortController | undefined;
  let queue: Promise<void> = Promise.resolve();

  const perform = async (
    rawIntent: ResendMessageIntent,
    rawOptions: { requestId: string },
  ): Promise<ResendDeliveryReceipt> => {
    if (closed) throw new Error("Resend Messenger is closed.");
    const intent = validIntent(rawIntent);
    const requestId = validRequestId(rawOptions?.requestId);
    const intentJson = JSON.stringify(intent);
    const payloadJson = JSON.stringify({
      from: authority.fromEmail,
      to: [intent.to],
      subject: authority.subject,
      text: intent.text,
    });
    let row = find.get(requestId) as OperationRow | undefined;
    if (row !== undefined) {
      validateRow(row, identity, namespace, authority);
      if (row.intent_json !== intentJson || row.payload_json !== payloadJson) {
        throw new Error("Request ID was already bound to a different email payload.");
      }
      if (row.state === "accepted") return { id: row.receipt_id as string, status: "accepted" };
      validatePendingTime(row, safeTime(clock()));
    }

    let apiKey: string;
    try {
      let onClose!: () => void;
      const closing = new Promise<never>((_resolve, reject) => {
        onClose = () => reject(closeController.signal.reason ?? new Error("closed"));
        closeController.signal.addEventListener("abort", onClose, { once: true });
      });
      try {
        apiKey = validCredential(await Promise.race([options.getApiKey(), closing]));
      } finally {
        closeController.signal.removeEventListener("abort", onClose);
      }
    } catch (error) {
      if (closed) throw new Error("Resend Messenger is closed.");
      if (error instanceof Error && error.message === "Resend API key is unavailable.") throw error;
      throw new Error("Resend API key is unavailable.");
    }
    if (closed) throw new Error("Resend Messenger is closed.");
    const observed = safeTime(clock());
    if (row === undefined) {
      const key = providerKey(identity, namespace, requestId);
      row = inTransaction(database, () => {
        const concurrent = find.get(requestId) as OperationRow | undefined;
        if (concurrent !== undefined) {
          return validateRow(concurrent, identity, namespace, authority);
        }
        insert.run(requestId, intentJson, payloadJson, key, observed, observed);
        return find.get(requestId) as OperationRow;
      });
      if (row.intent_json !== intentJson || row.payload_json !== payloadJson) {
        throw new Error("Request ID was already bound to a different email payload.");
      }
      if (row.state === "accepted") return { id: row.receipt_id as string, status: "accepted" };
    }
    validatePendingTime(row, observed);
    row = inTransaction(database, () => {
      const current = validateRow(
        find.get(requestId) as OperationRow,
        identity,
        namespace,
        authority,
      );
      if (current.state === "accepted") {
        return current;
      }
      if (current.intent_json !== intentJson || current.payload_json !== payloadJson) {
        throw new Error("Request ID was already bound to a different email payload.");
      }
      validatePendingTime(current, observed);
      updateObserved.run(observed, requestId);
      return { ...current, last_observed_at: observed };
    });
    if (row.state === "accepted") return { id: row.receipt_id as string, status: "accepted" };
    validatePendingTime(row, safeTime(clock()));
    if (closed) throw new Error("Resend Messenger is closed.");

    const controller = new AbortController();
    activeController = controller;
    const timer = setTimeout(() => controller.abort(new Error("timeout")), REQUEST_TIMEOUT);
    let response: Response;
    let body: string;
    try {
      response = await transport(ENDPOINT, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": row.provider_key,
        },
        body: row.payload_json,
        signal: controller.signal,
      });
      if (response.redirected) throw new Error("redirect");
      body = await boundedBody(response, controller.signal);
    } catch (error) {
      if (closed) throw new Error("Resend Messenger is closed.");
      if (error instanceof Error && error.message === "Resend response was invalid.") {
        throw error;
      }
      throw new Error("Email request failed; its outcome is uncertain.");
    } finally {
      clearTimeout(timer);
      if (activeController === controller) activeController = undefined;
    }

    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = parsedJson(body);
    } catch (error) {
      if (response.ok) throw error;
    }
    if (!response.ok) {
      const name = parsed?.name;
      if (response.status === 409 && name === "invalid_idempotent_request") {
        throw new Error(
          "Resend rejected the idempotency binding; inspect the provider before retrying.",
        );
      }
      if (response.status === 409 && name === "concurrent_idempotent_requests") {
        throw new Error(
          "A matching Resend request is still in flight; retry the original submission later.",
        );
      }
      throw new Error(`Resend rejected the email request with HTTP ${response.status}.`);
    }
    const receiptId = validReceiptId(parsed?.id);
    return inTransaction(database, () => {
      const current = validateRow(
        find.get(requestId) as OperationRow,
        identity,
        namespace,
        authority,
      );
      if (current.state === "accepted") {
        if (current.receipt_id !== receiptId) {
          throw new Error("Email ledger contains a conflicting accepted receipt.");
        }
        return { id: current.receipt_id, status: "accepted" };
      }
      accept.run(receiptId, requestId);
      return { id: receiptId, status: "accepted" };
    });
  };

  return {
    identity,
    send(intent, sendOptions) {
      const result = queue.then(() => perform(intent, sendOptions));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    async close() {
      if (closed) return queue;
      closed = true;
      closeController.abort(new Error("closed"));
      activeController?.abort(new Error("closed"));
      await queue;
      database.close();
    },
  };
}
