import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ApprovalDecision, ApprovalRequest, Approver } from "@officehum/sdk";
import {
  canonicalJson,
  canonicalMailbox,
  type NormalizedInboundEmail,
  normalizeReceivedEmail,
  parseReceivingEvent,
  type ReceivingEvent,
  type SignedWebhookHeaders,
  verifySvixWebhook,
} from "./resend-inbound.js";
import { withSoloOwnership } from "./solo.js";

export type InboundAuthority = {
  version: 1;
  messengerId: string;
  accountId: string;
  fromEmail: string;
  inboundEmail: string;
};

export type InboxSummary = {
  emailId: string;
  state: "received" | "prepared" | "admitted" | "settled" | "blocked";
  reason: string | null;
  conversationId: number | null;
  submissionId: number | null;
};

export type ReceiveResult = { status: 200 | 202 | 204; emailId?: string };

export type ResendInboundOptions = {
  authority: InboundAuthority;
  getApiKey: () => Promise<string>;
  getWebhookSecrets: () => Promise<readonly string[]>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

export interface ResendInbox {
  readonly authority: InboundAuthority;
  readonly namespace: string;
  accept(raw: Uint8Array, headers: SignedWebhookHeaders): Promise<ReceiveResult>;
  summaries(): InboxSummary[];
  close(): Promise<void>;
}

export type StoredInboundReceipt = {
  emailId: string;
  canonicalEventJson: string;
  event: ReceivingEvent;
  state: InboxSummary["state"];
  reason: string | null;
  fetched: Record<string, unknown> | null;
  normalized: NormalizedInboundEmail | null;
  routeSnapshot: InboundRouteSnapshot | null;
  conversationId: number | null;
  requestId: string | null;
  envelope: string | null;
  submissionId: number | null;
  settlement: Record<string, unknown> | null;
  replyRequestId: string | null;
};

export type InboundRouteSnapshot = {
  authorityId: string;
  sender: string;
  contactId: string | null;
  contactRevision: number | null;
};

export function inboundAuthorityId(value: InboundAuthority): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export type ReplyOperationRow = {
  requestId: string;
  receiptId: string;
  intentJson: string;
  payloadJson: string;
  providerKey: string;
  firstAttemptAt: number;
  lastObservedAt: number;
  state: "pending" | "accepted";
  providerReceiptId: string | null;
};

export interface InternalResendInbox extends ResendInbox {
  abortWork(): void;
  receipt(emailId: string): StoredInboundReceipt | undefined;
  eligible(limit?: number): StoredInboundReceipt[];
  fetchReceived(
    emailId: string,
    event: ReceivingEvent,
  ): Promise<{ fetched: Record<string, unknown>; normalized: NormalizedInboundEmail }>;
  savePrepared(
    emailId: string,
    fetched: Record<string, unknown>,
    normalized: NormalizedInboundEmail,
  ): void;
  saveRoute(
    emailId: string,
    route: InboundRouteSnapshot,
    conversationId: number,
    requestId: string,
    envelope: string,
  ): void;
  saveAdmission(emailId: string, submissionId: number): void;
  saveSettlement(emailId: string, settlement: Record<string, unknown>): void;
  defer(emailId: string, reason: string): void;
  block(emailId: string, reason: string): void;
  readReplyDecision(key: string, request: ApprovalRequest): ApprovalDecision | undefined;
  recordReplyDecision(
    key: string,
    request: ApprovalRequest,
    decision: ApprovalDecision,
  ): ApprovalDecision;
  replyOperation(requestId: string): ReplyOperationRow | undefined;
  reserveReplyOperation(row: ReplyOperationRow): ReplyOperationRow;
  observeReplyOperation(requestId: string, observedAt: number): void;
  acceptReplyOperation(requestId: string, providerReceiptId: string): void;
}

type ReceiptRow = {
  email_id: string;
  canonical_event_json: string;
  state: string;
  reason: string | null;
  fetched_json: string | null;
  normalized_json: string | null;
  route_snapshot_json: string | null;
  conversation_id: number | null;
  request_id: string | null;
  envelope: string | null;
  submission_id: number | null;
  settlement_json: string | null;
  reply_request_id: string | null;
};

const GET_LIMIT = 1024 * 1024;
const REQUEST_TIMEOUT = 30_000;
const MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f\x41-\x7e]+@[\x21-\x3b\x3d\x3f\x41-\x7e]+>$/u;
const REASON_CODES = new Set([
  "route_mismatch",
  "fetch_failed",
  "authentication_failed",
  "reply_to_mismatch",
  "auto_message",
  "invalid_thread_headers",
  "subject_too_long",
  "empty_body",
  "body_too_large",
  "binding_mismatch",
  "route_conflict",
  "submission_binding_conflict",
  "submission_binding_unknown",
]);

function exact(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    })
  );
}

function messageText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim().length > 0 &&
    !controls(value, true)
  );
}

function controls(value: string, message = false): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (message && (code === 9 || code === 10 || code === 13)) return false;
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function reasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODES.has(value);
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

function tableNames(database: DatabaseSync): string[] {
  return (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as unknown as {
      name: string;
    }[]
  ).map(({ name }) => name);
}

function columnNames(database: DatabaseSync, table: string): string[] {
  return (
    database.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
  ).map(({ name }) => name);
}

function reserve(path: string): boolean {
  try {
    closeSync(openSync(path, "wx", 0o600));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function authority(value: InboundAuthority): InboundAuthority {
  if (
    value?.version !== 1 ||
    !exact(value.messengerId, 500) ||
    !exact(value.accountId, 500) ||
    canonicalMailbox(value.fromEmail) !== value.fromEmail ||
    canonicalMailbox(value.inboundEmail) !== value.inboundEmail
  ) {
    throw new Error("Inbound authority is invalid.");
  }
  return structuredClone(value);
}

function parsedObject(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
  if (canonicalJson(parsed) !== value) throw new Error();
  return parsed as Record<string, unknown>;
}

function immutableFetched(value: Record<string, unknown>): Record<string, unknown> {
  const copy = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(copy);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(
            ([key]) =>
              key !== "raw" && key !== "raw_url" && key !== "download_url" && key !== "downloadUrl",
          )
          .map(([key, nested]) => [key, copy(nested)]),
      );
    }
    return item;
  };
  return copy(value) as Record<string, unknown>;
}

function storedReceipt(row: ReceiptRow, expectedAuthorityId?: string): StoredInboundReceipt {
  try {
    if (
      !exact(row.email_id, 36) ||
      !["received", "prepared", "admitted", "settled", "blocked"].includes(row.state) ||
      (row.reason !== null && !reasonCode(row.reason))
    ) {
      throw new Error();
    }
    const event = parseReceivingEvent(new TextEncoder().encode(row.canonical_event_json));
    if (event.data.email_id !== row.email_id) throw new Error();
    const normalized = parsedObject(row.normalized_json) as NormalizedInboundEmail | null;
    const routeSnapshot = parsedObject(row.route_snapshot_json) as InboundRouteSnapshot | null;
    const fetched = parsedObject(row.fetched_json);
    const settlement = parsedObject(row.settlement_json);
    if ((fetched === null) !== (normalized === null)) throw new Error();
    if (normalized !== null) {
      if (
        normalized.emailId !== row.email_id ||
        canonicalMailbox(normalized.from) !== normalized.from ||
        !Array.isArray(normalized.to) ||
        normalized.to.length === 0 ||
        normalized.to.length > 50 ||
        normalized.to.some((item) => canonicalMailbox(item) !== item) ||
        !exact(normalized.subject, 200) ||
        !exact(normalized.messageId, 998) ||
        !MESSAGE_ID.test(normalized.messageId) ||
        (normalized.inReplyTo !== null &&
          (!exact(normalized.inReplyTo, 998) || !MESSAGE_ID.test(normalized.inReplyTo))) ||
        !Array.isArray(normalized.references) ||
        normalized.references.length > 50 ||
        normalized.references.join(" ").length > 8192 ||
        normalized.references.some((item) => !exact(item, 998) || !MESSAGE_ID.test(item)) ||
        !messageText(normalized.text, 16_000) ||
        typeof normalized.truncated !== "boolean" ||
        !Array.isArray(normalized.attachments) ||
        normalized.attachments.length > 50 ||
        normalized.attachments.some(
          (item) =>
            item === null ||
            typeof item !== "object" ||
            !exact(item.id, 200) ||
            (item.filename !== null && !exact(item.filename, 500)) ||
            !exact(item.contentType, 200) ||
            !Number.isSafeInteger(item.size) ||
            item.size < 0,
        )
      ) {
        throw new Error();
      }
    }
    const routeParts = [routeSnapshot, row.conversation_id, row.request_id, row.envelope];
    if (!routeParts.every((item) => item === null) && !routeParts.every((item) => item !== null)) {
      throw new Error();
    }
    if (
      routeSnapshot !== null &&
      (!/^[0-9a-f]{64}$/u.test(routeSnapshot.authorityId) ||
        (expectedAuthorityId !== undefined && routeSnapshot.authorityId !== expectedAuthorityId) ||
        canonicalMailbox(routeSnapshot.sender) !== routeSnapshot.sender ||
        routeSnapshot.sender !== normalized?.from ||
        (routeSnapshot.contactId === null) !== (routeSnapshot.contactRevision === null) ||
        (routeSnapshot.contactId !== null && !exact(routeSnapshot.contactId, 200)) ||
        (routeSnapshot.contactRevision !== null &&
          (!Number.isSafeInteger(routeSnapshot.contactRevision) ||
            routeSnapshot.contactRevision < 1)))
    ) {
      throw new Error();
    }
    if (
      (row.conversation_id !== null &&
        (!Number.isSafeInteger(row.conversation_id) || row.conversation_id < 1)) ||
      (row.request_id !== null && !exact(row.request_id, 500)) ||
      (row.envelope !== null && (row.envelope.length === 0 || row.envelope.length > 32_000)) ||
      (row.submission_id !== null &&
        (!Number.isSafeInteger(row.submission_id) || row.submission_id < 1)) ||
      (row.reply_request_id !== null && !exact(row.reply_request_id, 500)) ||
      (row.state === "received" && normalized !== null) ||
      (row.state === "prepared" && normalized === null) ||
      (row.state === "blocked" && row.reason === null) ||
      (row.state === "received" && row.reason !== null && row.reason !== "fetch_failed") ||
      ((row.state === "prepared" || row.state === "admitted" || row.state === "settled") &&
        row.reason !== null) ||
      ((row.state === "admitted" || row.state === "settled") &&
        (routeSnapshot === null || row.submission_id === null)) ||
      (row.reply_request_id !== null && row.state !== "admitted" && row.state !== "settled") ||
      (row.state !== "settled" && settlement !== null) ||
      (row.state === "settled" &&
        (settlement === null ||
          Object.keys(settlement).length !== 1 ||
          (settlement.status !== "done" && settlement.status !== "unanswered")))
    ) {
      throw new Error();
    }
    return {
      emailId: row.email_id,
      canonicalEventJson: row.canonical_event_json,
      event,
      state: row.state as InboxSummary["state"],
      reason: row.reason,
      fetched,
      normalized,
      routeSnapshot,
      conversationId: row.conversation_id,
      requestId: row.request_id,
      envelope: row.envelope,
      submissionId: row.submission_id,
      settlement,
      replyRequestId: row.reply_request_id,
    };
  } catch {
    throw new Error("Malformed inbound receipt.");
  }
}

function replyOperationRow(row: Record<string, unknown>): ReplyOperationRow {
  const result: ReplyOperationRow = {
    requestId: row.request_id as string,
    receiptId: row.receipt_id as string,
    intentJson: row.intent_json as string,
    payloadJson: row.payload_json as string,
    providerKey: row.provider_key as string,
    firstAttemptAt: row.first_attempt_at as number,
    lastObservedAt: row.last_observed_at as number,
    state: row.state as "pending" | "accepted",
    providerReceiptId: row.provider_receipt_id as string | null,
  };
  if (
    !exact(result.requestId, 500) ||
    !exact(result.receiptId, 200) ||
    typeof result.intentJson !== "string" ||
    typeof result.payloadJson !== "string" ||
    !exact(result.providerKey, 200) ||
    !Number.isSafeInteger(result.firstAttemptAt) ||
    result.firstAttemptAt < 0 ||
    !Number.isSafeInteger(result.lastObservedAt) ||
    result.lastObservedAt < result.firstAttemptAt ||
    (result.state !== "pending" && result.state !== "accepted") ||
    (result.state === "pending"
      ? result.providerReceiptId !== null
      : !exact(result.providerReceiptId, 200))
  ) {
    throw new Error("Malformed inbound reply operation.");
  }
  return result;
}

function validateEventRow(row: Record<string, unknown>): { emailId: string; canonical: string } {
  try {
    if (
      !exact(row.event_id, 200) ||
      !(row.raw_payload instanceof Uint8Array) ||
      !/^[0-9a-f]{64}$/u.test(row.raw_sha256 as string) ||
      typeof row.canonical_event_json !== "string" ||
      !exact(row.email_id, 36) ||
      !Number.isSafeInteger(row.verified_at) ||
      (row.verified_at as number) < 0
    ) {
      throw new Error();
    }
    const raw = Uint8Array.from(row.raw_payload);
    if (createHash("sha256").update(raw).digest("hex") !== row.raw_sha256) throw new Error();
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
    if (canonicalJson(decoded) !== row.canonical_event_json) throw new Error();
    const event = parseReceivingEvent(raw);
    if (event.data.email_id !== row.email_id) throw new Error();
    return { emailId: row.email_id, canonical: row.canonical_event_json };
  } catch {
    throw new Error("Malformed inbound event.");
  }
}

function validateApprovalRow(row: Record<string, unknown>): void {
  try {
    if (
      !exact(row.approval_key, 500) ||
      typeof row.request_json !== "string" ||
      typeof row.decision_json !== "string"
    ) {
      throw new Error();
    }
    const request = JSON.parse(row.request_json) as unknown;
    if (
      request === null ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      canonicalJson(request) !== row.request_json
    ) {
      throw new Error();
    }
    const decision = JSON.parse(row.decision_json) as ApprovalDecision;
    if (canonicalJson(validDecision(decision)) !== row.decision_json) throw new Error();
  } catch {
    throw new Error("Malformed inbound reply approval.");
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {});
  } catch {}
}

async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (response.redirected || !response.ok || response.body === null)
    throw new Error("Receiving request failed.");
  const responseHeaders = [...response.headers];
  if (
    responseHeaders.length > 200 ||
    responseHeaders.reduce((total, [key, value]) => total + key.length + value.length, 0) >
      64 * 1024 ||
    responseHeaders.some(([key, value]) => key.length > 200 || value.length > 8192)
  ) {
    throw new Error("Receiving response was invalid.");
  }
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
      if (length > GET_LIMIT) {
        cancelReader(reader);
        throw new Error("Receiving response was invalid.");
      }
      chunks.push(next.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Receiving response was invalid.");
  }
}

function validDecision(value: ApprovalDecision): ApprovalDecision {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.approved !== "boolean" ||
    (value.by !== undefined && !exact(value.by, 200)) ||
    (value.note !== undefined &&
      (typeof value.note !== "string" || value.note.length > 1000 || controls(value.note, true)))
  ) {
    throw new Error("Approval decision is invalid.");
  }
  return structuredClone(value);
}

export function openResendInbox(path: string, options: ResendInboundOptions): InternalResendInbox {
  if (
    typeof options?.getApiKey !== "function" ||
    typeof options?.getWebhookSecrets !== "function"
  ) {
    throw new Error("Inbound callbacks are invalid.");
  }
  const boundAuthority = authority(options.authority);
  const authorityJson = canonicalJson(boundAuthority);
  const now = options.now ?? Date.now;
  const transport = options.fetch ?? globalThis.fetch;
  mkdirSync(dirname(path), { recursive: true });
  const fresh = reserve(path);
  const database = new DatabaseSync(path);
  let namespace = "";
  try {
    database.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL;");
    if (fresh && tableNames(database).length === 0) {
      inTransaction(database, () => {
        database.exec(`
          CREATE TABLE inbound_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,authority_json TEXT NOT NULL,ledger_namespace TEXT NOT NULL,work_cursor INTEGER NOT NULL);
          CREATE TABLE events(event_id TEXT PRIMARY KEY,raw_payload BLOB NOT NULL,raw_sha256 TEXT NOT NULL,canonical_event_json TEXT NOT NULL,email_id TEXT NOT NULL,verified_at INTEGER NOT NULL);
          CREATE TABLE receipts(email_id TEXT PRIMARY KEY,canonical_event_json TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,fetched_json TEXT,normalized_json TEXT,route_snapshot_json TEXT,conversation_id INTEGER,request_id TEXT,envelope TEXT,submission_id INTEGER,settlement_json TEXT,reply_request_id TEXT UNIQUE);
          CREATE TABLE reply_approvals(approval_key TEXT PRIMARY KEY,request_json TEXT NOT NULL,decision_json TEXT NOT NULL);
          CREATE TABLE reply_operations(request_id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL UNIQUE,intent_json TEXT NOT NULL,payload_json TEXT NOT NULL,provider_key TEXT NOT NULL,first_attempt_at INTEGER NOT NULL,last_observed_at INTEGER NOT NULL,state TEXT NOT NULL,provider_receipt_id TEXT);
        `);
        database
          .prepare("INSERT INTO inbound_metadata VALUES(1,1,?,?,0)")
          .run(authorityJson, randomUUID());
      });
    }
    const metadata = database
      .prepare(
        "SELECT singleton,schema_version,authority_json,ledger_namespace,work_cursor FROM inbound_metadata",
      )
      .all() as unknown as {
      singleton: number;
      schema_version: number;
      authority_json: string;
      ledger_namespace: string;
      work_cursor: number;
    }[];
    if (
      metadata.length !== 1 ||
      metadata[0]?.singleton !== 1 ||
      metadata[0].schema_version !== 1 ||
      metadata[0].authority_json !== authorityJson ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        metadata[0].ledger_namespace,
      ) ||
      !Number.isSafeInteger(metadata[0].work_cursor) ||
      metadata[0].work_cursor < 0
    ) {
      throw new Error("Inbound authority does not match this inbox.");
    }
    namespace = metadata[0].ledger_namespace;
    const expected = "events,inbound_metadata,receipts,reply_approvals,reply_operations";
    if (
      tableNames(database).join(",") !== expected ||
      columnNames(database, "inbound_metadata").join(",") !==
        "singleton,schema_version,authority_json,ledger_namespace,work_cursor" ||
      columnNames(database, "events").join(",") !==
        "event_id,raw_payload,raw_sha256,canonical_event_json,email_id,verified_at" ||
      columnNames(database, "receipts").join(",") !==
        "email_id,canonical_event_json,state,reason,fetched_json,normalized_json,route_snapshot_json,conversation_id,request_id,envelope,submission_id,settlement_json,reply_request_id" ||
      columnNames(database, "reply_approvals").join(",") !==
        "approval_key,request_json,decision_json" ||
      columnNames(database, "reply_operations").join(",") !==
        "request_id,receipt_id,intent_json,payload_json,provider_key,first_attempt_at,last_observed_at,state,provider_receipt_id"
    )
      throw new Error("Malformed inbound inbox schema.");
    const all = database.prepare("SELECT * FROM receipts").all() as unknown as ReceiptRow[];
    const expectedAuthorityId = inboundAuthorityId(boundAuthority);
    all.forEach((row) => {
      storedReceipt(row, expectedAuthorityId);
    });
    const receipts = new Map(all.map((row) => [row.email_id, row]));
    const events = (
      database.prepare("SELECT * FROM events").all() as unknown as Record<string, unknown>[]
    ).map(validateEventRow);
    for (const event of events) {
      const receipt = receipts.get(event.emailId);
      if (receipt === undefined || receipt.canonical_event_json !== event.canonical) {
        throw new Error("Malformed inbound event binding.");
      }
    }
    for (const receipt of all) {
      if (!events.some((event) => event.emailId === receipt.email_id)) {
        throw new Error("Malformed inbound event binding.");
      }
    }
    (
      database.prepare("SELECT * FROM reply_approvals").all() as unknown as Record<
        string,
        unknown
      >[]
    ).forEach(validateApprovalRow);
    const operations = database
      .prepare("SELECT * FROM reply_operations")
      .all() as unknown as Record<string, unknown>[];
    for (const raw of operations) {
      const operation = replyOperationRow(raw);
      const receipt = receipts.get(operation.receiptId);
      if (receipt === undefined || receipt.reply_request_id !== operation.requestId) {
        throw new Error("Malformed inbound reply operation binding.");
      }
    }
    for (const receipt of all) {
      if (
        receipt.reply_request_id !== null &&
        !operations.some((row) => row.request_id === receipt.reply_request_id)
      ) {
        throw new Error("Malformed inbound reply operation binding.");
      }
    }
  } catch (error) {
    database.close();
    throw error;
  }
  const findReceipt = database.prepare("SELECT * FROM receipts WHERE email_id=?");
  let closed = false;
  const closeController = new AbortController();
  const active = new Set<AbortController>();
  let activeFetches = 0;
  const fetchDrainWaiters = new Set<() => void>();

  const api: InternalResendInbox = {
    authority: boundAuthority,
    namespace,
    abortWork() {
      closeController.abort(new Error("closed"));
      for (const controller of active) controller.abort(new Error("closed"));
    },
    async accept(raw, headers) {
      if (closed) throw new Error("Inbound inbox is closed.");
      let secrets: readonly string[];
      try {
        secrets = await options.getWebhookSecrets();
      } catch {
        throw new Error("Webhook signing secret is unavailable.");
      }
      if (closed) throw new Error("Inbound inbox is closed.");
      verifySvixWebhook(raw, headers, secrets, now());
      let generic: Record<string, unknown>;
      try {
        const decoded = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(raw),
        ) as unknown;
        if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
          throw new Error();
        }
        generic = decoded as Record<string, unknown>;
      } catch {
        throw new Error("Receiving event is invalid.");
      }
      if (generic.type !== "email.received") return { status: 204 };
      const event = parseReceivingEvent(raw);
      const canonicalEventJson = canonicalJson(generic);
      const routeMatches = event.data.to
        .map(canonicalMailbox)
        .includes(boundAuthority.inboundEmail);
      const rawHash = createHash("sha256").update(raw).digest("hex");
      const verifiedAt = now();
      return inTransaction(database, () => {
        const priorEvent = database
          .prepare("SELECT * FROM events WHERE event_id=?")
          .get(headers.id) as
          | {
              raw_payload: Uint8Array;
              raw_sha256: string;
              canonical_event_json: string;
              email_id: string;
            }
          | undefined;
        if (priorEvent !== undefined) {
          if (
            priorEvent.raw_sha256 !== rawHash ||
            Buffer.compare(Buffer.from(priorEvent.raw_payload), Buffer.from(raw)) !== 0 ||
            priorEvent.canonical_event_json !== canonicalEventJson ||
            priorEvent.email_id !== event.data.email_id
          ) {
            throw new Error("Webhook event identity conflict.");
          }
          return { status: 200, emailId: event.data.email_id } as const;
        }
        const receipt = findReceipt.get(event.data.email_id) as ReceiptRow | undefined;
        if (receipt !== undefined && receipt.canonical_event_json !== canonicalEventJson) {
          throw new Error("Inbound email identity conflict.");
        }
        database
          .prepare("INSERT INTO events VALUES(?,?,?,?,?,?)")
          .run(
            headers.id,
            Buffer.from(raw),
            rawHash,
            canonicalEventJson,
            event.data.email_id,
            verifiedAt,
          );
        if (receipt !== undefined) return { status: 200, emailId: event.data.email_id } as const;
        database
          .prepare(
            "INSERT INTO receipts(email_id,canonical_event_json,state,reason) VALUES(?,?,?,?)",
          )
          .run(
            event.data.email_id,
            canonicalEventJson,
            routeMatches ? "received" : "blocked",
            routeMatches ? null : "route_mismatch",
          );
        return { status: 202, emailId: event.data.email_id } as const;
      });
    },
    summaries() {
      if (closed) throw new Error("Inbound inbox is closed.");
      return (
        database
          .prepare(
            "SELECT email_id,state,reason,conversation_id,submission_id FROM receipts ORDER BY rowid",
          )
          .all() as unknown as {
          email_id: string;
          state: InboxSummary["state"];
          reason: string | null;
          conversation_id: number | null;
          submission_id: number | null;
        }[]
      ).map((row) => {
        if (
          (row.reason !== null && !reasonCode(row.reason)) ||
          (row.state === "blocked" && row.reason === null) ||
          (row.state === "received" && row.reason !== null && row.reason !== "fetch_failed") ||
          ((row.state === "prepared" || row.state === "admitted" || row.state === "settled") &&
            row.reason !== null)
        ) {
          throw new Error("Malformed inbound receipt.");
        }
        return {
          emailId: row.email_id,
          state: row.state,
          reason: row.reason,
          conversationId: row.conversation_id,
          submissionId: row.submission_id,
        };
      });
    },
    receipt(emailId) {
      const row = findReceipt.get(emailId) as ReceiptRow | undefined;
      return row === undefined
        ? undefined
        : structuredClone(storedReceipt(row, inboundAuthorityId(boundAuthority)));
    },
    eligible(limit = 20) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
        throw new Error("Inbound batch limit is invalid.");
      return inTransaction(database, () => {
        const metadata = database
          .prepare("SELECT work_cursor FROM inbound_metadata WHERE singleton=1")
          .get() as { work_cursor: number };
        const after = database
          .prepare(
            "SELECT rowid,* FROM receipts WHERE state IN ('received','prepared','admitted') AND rowid>? ORDER BY rowid LIMIT ?",
          )
          .all(metadata.work_cursor, limit) as unknown as (ReceiptRow & { rowid: number })[];
        const rows = [...after];
        if (rows.length < limit) {
          rows.push(
            ...(database
              .prepare(
                "SELECT rowid,* FROM receipts WHERE state IN ('received','prepared','admitted') AND rowid<=? ORDER BY rowid LIMIT ?",
              )
              .all(metadata.work_cursor, limit - rows.length) as unknown as (ReceiptRow & {
              rowid: number;
            })[]),
          );
        }
        const last = rows.at(-1);
        if (last !== undefined) {
          database
            .prepare("UPDATE inbound_metadata SET work_cursor=? WHERE singleton=1")
            .run(last.rowid);
        }
        return rows.map((row) =>
          structuredClone(storedReceipt(row, inboundAuthorityId(boundAuthority))),
        );
      });
    },
    async fetchReceived(emailId, event) {
      if (closed) throw new Error("Inbound inbox is closed.");
      if (closeController.signal.aborted) throw new Error("Receiving request failed.");
      if (emailId !== event.data.email_id) throw new Error("Received email binding is invalid.");
      activeFetches += 1;
      try {
        let key: string;
        try {
          let onClose!: () => void;
          const closing = new Promise<never>((_resolve, reject) => {
            onClose = () => reject(closeController.signal.reason ?? new Error("closed"));
            closeController.signal.addEventListener("abort", onClose, { once: true });
          });
          try {
            key = await Promise.race([options.getApiKey(), closing]);
          } finally {
            closeController.signal.removeEventListener("abort", onClose);
          }
          if (!exact(key, 1000)) throw new Error();
        } catch {
          throw new Error("Resend API key is unavailable.");
        }
        if (closeController.signal.aborted) throw new Error("Receiving request failed.");
        const controller = new AbortController();
        active.add(controller);
        const onClose = () => controller.abort(new Error("closed"));
        closeController.signal.addEventListener("abort", onClose, { once: true });
        const timer = setTimeout(() => controller.abort(new Error("timeout")), REQUEST_TIMEOUT);
        try {
          const response = await transport(
            `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}?html_format=cid`,
            {
              method: "GET",
              redirect: "error",
              headers: { Authorization: `Bearer ${key}` },
              signal: controller.signal,
            },
          );
          const fetched = await boundedJson(response, controller.signal);
          const normalized = normalizeReceivedEmail(
            event,
            fetched,
            boundAuthority.inboundEmail,
            boundAuthority.fromEmail,
          );
          return { fetched: immutableFetched(fetched), normalized };
        } catch (error) {
          if (
            error instanceof Error &&
            [
              "authentication_failed",
              "reply_to_mismatch",
              "auto_message",
              "invalid_thread_headers",
              "subject_too_long",
              "empty_body",
              "body_too_large",
              "binding_mismatch",
            ].includes(error.message)
          )
            throw error;
          throw new Error("Receiving request failed.");
        } finally {
          clearTimeout(timer);
          closeController.signal.removeEventListener("abort", onClose);
          active.delete(controller);
        }
      } finally {
        activeFetches -= 1;
        if (activeFetches === 0) {
          for (const resolve of fetchDrainWaiters) resolve();
          fetchDrainWaiters.clear();
        }
      }
    },
    savePrepared(emailId, fetched, normalized) {
      inTransaction(database, () => {
        const row = findReceipt.get(emailId) as ReceiptRow | undefined;
        if (row === undefined) throw new Error("Inbound receipt was not found.");
        if (row.fetched_json !== null || row.normalized_json !== null) {
          if (
            row.fetched_json !== canonicalJson(fetched) ||
            row.normalized_json !== canonicalJson(normalized)
          )
            throw new Error("Inbound prepared snapshot conflict.");
          return;
        }
        const result = database
          .prepare(
            "UPDATE receipts SET fetched_json=?,normalized_json=?,state='prepared',reason=NULL WHERE email_id=? AND state='received'",
          )
          .run(canonicalJson(fetched), canonicalJson(normalized), emailId);
        if (result.changes !== 1) throw new Error("Inbound prepared state conflict.");
      });
    },
    saveRoute(emailId, route, conversationId, requestId, envelope) {
      inTransaction(database, () => {
        const row = findReceipt.get(emailId) as ReceiptRow | undefined;
        if (row === undefined) throw new Error("Inbound receipt was not found.");
        const prepared = storedReceipt(row, inboundAuthorityId(boundAuthority));
        if (
          prepared.normalized === null ||
          !/^[0-9a-f]{64}$/u.test(route?.authorityId) ||
          route.authorityId !== inboundAuthorityId(boundAuthority) ||
          canonicalMailbox(route.sender) !== route.sender ||
          route.sender !== prepared.normalized.from ||
          (route.contactId === null) !== (route.contactRevision === null) ||
          (route.contactId !== null && !exact(route.contactId, 200)) ||
          (route.contactRevision !== null &&
            (!Number.isSafeInteger(route.contactRevision) || route.contactRevision < 1)) ||
          !Number.isSafeInteger(conversationId) ||
          conversationId < 1 ||
          !exact(requestId, 500) ||
          typeof envelope !== "string" ||
          envelope.length === 0 ||
          envelope.length > 32_000
        ) {
          throw new Error("Inbound route is invalid.");
        }
        const routeJson = canonicalJson(route);
        if (row.route_snapshot_json !== null) {
          if (
            row.route_snapshot_json !== routeJson ||
            row.conversation_id !== conversationId ||
            row.request_id !== requestId ||
            row.envelope !== envelope
          )
            throw new Error("Inbound route binding conflict.");
          return;
        }
        const result = database
          .prepare(
            "UPDATE receipts SET route_snapshot_json=?,conversation_id=?,request_id=?,envelope=? WHERE email_id=? AND state='prepared'",
          )
          .run(routeJson, conversationId, requestId, envelope, emailId);
        if (result.changes !== 1) throw new Error("Inbound route state conflict.");
      });
    },
    saveAdmission(emailId, submissionId) {
      const result = database
        .prepare(
          "UPDATE receipts SET submission_id=?,state='admitted',reason=NULL WHERE email_id=? AND submission_id IS NULL AND state='prepared'",
        )
        .run(submissionId, emailId);
      if (result.changes === 0) {
        const row = findReceipt.get(emailId) as ReceiptRow | undefined;
        if (row?.submission_id !== submissionId)
          throw new Error("Inbound admission binding conflict.");
      }
    },
    saveSettlement(emailId, settlement) {
      const json = canonicalJson(settlement);
      const result = database
        .prepare(
          "UPDATE receipts SET settlement_json=?,state='settled',reason=NULL WHERE email_id=? AND state='admitted'",
        )
        .run(json, emailId);
      if (result.changes === 0) {
        const row = findReceipt.get(emailId) as ReceiptRow | undefined;
        if (row?.settlement_json !== json) throw new Error("Inbound settlement binding conflict.");
      }
    },
    defer(emailId, reason) {
      if (!reasonCode(reason)) throw new Error("Inbound deferral reason is invalid.");
      database
        .prepare("UPDATE receipts SET reason=? WHERE email_id=? AND state='received'")
        .run(reason, emailId);
    },
    block(emailId, reason) {
      if (!reasonCode(reason)) throw new Error("Inbound block reason is invalid.");
      database
        .prepare(
          "UPDATE receipts SET state='blocked',reason=? WHERE email_id=? AND state!='settled'",
        )
        .run(reason, emailId);
    },
    readReplyDecision(key, request) {
      const row = database
        .prepare("SELECT request_json,decision_json FROM reply_approvals WHERE approval_key=?")
        .get(key) as { request_json: string; decision_json: string } | undefined;
      if (row === undefined) return undefined;
      if (row.request_json !== canonicalJson(request))
        throw new Error("Approval identity was already bound to a different reply.");
      return validDecision(JSON.parse(row.decision_json) as ApprovalDecision);
    },
    recordReplyDecision(key, request, decision) {
      return inTransaction(database, () => {
        const requestJson = canonicalJson(request);
        const saved = api.readReplyDecision(key, request);
        if (saved !== undefined) return saved;
        const valid = validDecision(decision);
        database
          .prepare("INSERT INTO reply_approvals VALUES(?,?,?)")
          .run(key, requestJson, canonicalJson(valid));
        return valid;
      });
    },
    replyOperation(requestId) {
      const row = database
        .prepare("SELECT * FROM reply_operations WHERE request_id=?")
        .get(requestId) as Record<string, unknown> | undefined;
      if (row === undefined) return undefined;
      return replyOperationRow(row);
    },
    reserveReplyOperation(row) {
      return inTransaction(database, () => {
        replyOperationRow({
          request_id: row.requestId,
          receipt_id: row.receiptId,
          intent_json: row.intentJson,
          payload_json: row.payloadJson,
          provider_key: row.providerKey,
          first_attempt_at: row.firstAttemptAt,
          last_observed_at: row.lastObservedAt,
          state: row.state,
          provider_receipt_id: row.providerReceiptId,
        });
        const existing = api.replyOperation(row.requestId);
        if (existing !== undefined) return existing;
        const receipt = findReceipt.get(row.receiptId) as ReceiptRow | undefined;
        if (receipt === undefined) throw new Error("Reply receipt was not found.");
        if (receipt.state !== "admitted" && receipt.state !== "settled") {
          throw new Error("Inbound receipt is not admitted for reply.");
        }
        if (receipt.reply_request_id !== null && receipt.reply_request_id !== row.requestId)
          throw new Error("This inbound receipt already has a reply operation.");
        database
          .prepare(
            "UPDATE receipts SET reply_request_id=? WHERE email_id=? AND reply_request_id IS NULL",
          )
          .run(row.requestId, row.receiptId);
        database
          .prepare("INSERT INTO reply_operations VALUES(?,?,?,?,?,?,?,?,?)")
          .run(
            row.requestId,
            row.receiptId,
            row.intentJson,
            row.payloadJson,
            row.providerKey,
            row.firstAttemptAt,
            row.lastObservedAt,
            row.state,
            row.providerReceiptId,
          );
        return row;
      });
    },
    observeReplyOperation(requestId, observedAt) {
      if (!Number.isSafeInteger(observedAt) || observedAt < 0)
        throw new Error("Reply observation time is invalid.");
      const result = database
        .prepare(
          "UPDATE reply_operations SET last_observed_at=? WHERE request_id=? AND state='pending'",
        )
        .run(observedAt, requestId);
      if (result.changes === 0) {
        const row = api.replyOperation(requestId);
        if (row === undefined) throw new Error("Reply operation was not found.");
      }
    },
    acceptReplyOperation(requestId, providerReceiptId) {
      if (!exact(providerReceiptId, 200)) throw new Error("Reply delivery ID is invalid.");
      inTransaction(database, () => {
        const row = api.replyOperation(requestId);
        if (row === undefined) throw new Error("Reply operation was not found.");
        if (row.state === "accepted") {
          if (row.providerReceiptId !== providerReceiptId)
            throw new Error("Reply operation contains a conflicting accepted receipt.");
          return;
        }
        database
          .prepare(
            "UPDATE reply_operations SET state='accepted',provider_receipt_id=? WHERE request_id=? AND state='pending'",
          )
          .run(providerReceiptId, requestId);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      api.abortWork();
      if (activeFetches > 0) {
        await new Promise<void>((resolve) => fetchDrainWaiters.add(resolve));
      }
      database.close();
    },
  };
  return api;
}

export async function readInboundInbox(directory: string): Promise<InboxSummary[]> {
  return withSoloOwnership(directory, () => {
    const path = `${directory}/inbound.sqlite`;
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return (
        database
          .prepare(
            "SELECT email_id,state,reason,conversation_id,submission_id FROM receipts ORDER BY rowid",
          )
          .all() as unknown as {
          email_id: string;
          state: InboxSummary["state"];
          reason: string | null;
          conversation_id: number | null;
          submission_id: number | null;
        }[]
      ).map((row) => {
        if (
          !exact(row.email_id, 36) ||
          !["received", "prepared", "admitted", "settled", "blocked"].includes(row.state) ||
          (row.reason !== null && !reasonCode(row.reason)) ||
          (row.state === "blocked" && row.reason === null) ||
          (row.state === "received" && row.reason !== null && row.reason !== "fetch_failed") ||
          ((row.state === "prepared" || row.state === "admitted" || row.state === "settled") &&
            row.reason !== null) ||
          (row.conversation_id !== null &&
            (!Number.isSafeInteger(row.conversation_id) || row.conversation_id < 1)) ||
          (row.submission_id !== null &&
            (!Number.isSafeInteger(row.submission_id) || row.submission_id < 1))
        ) {
          throw new Error("Malformed inbound receipt.");
        }
        return {
          emailId: row.email_id,
          state: row.state,
          reason: row.reason,
          conversationId: row.conversation_id,
          submissionId: row.submission_id,
        };
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Malformed inbound receipt.") throw error;
      throw new Error("Malformed inbound inbox.");
    } finally {
      database.close();
    }
  });
}

export function readInboundAuthority(directory: string): InboundAuthority {
  return withSoloOwnership(directory, () => {
    const database = new DatabaseSync(`${directory}/inbound.sqlite`, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT authority_json FROM inbound_metadata WHERE singleton=1")
        .get() as { authority_json: string } | undefined;
      if (row === undefined) throw new Error("Malformed inbound inbox metadata.");
      return authority(JSON.parse(row.authority_json) as InboundAuthority);
    } catch {
      throw new Error("Malformed inbound inbox metadata.");
    } finally {
      database.close();
    }
  });
}

/** Bind a human reply decision to the complete trusted request before Pi records its tool memo. */
export function durableInboundReplyApprover(
  inbox: InternalResendInbox,
  decide: Approver,
): Approver {
  const pending = new Map<string, { requestJson: string; promise: Promise<ApprovalDecision> }>();
  return async (request, context) => {
    if (request.approvalId !== "confirm_inbound_reply" || request.tool !== "reply_message") {
      return {
        approved: false,
        by: "inbound-policy",
        note: "Only exact authenticated inbound replies can use this approval channel.",
      };
    }
    const key = `${request.conversationId}:${request.taskId}:${request.callId}:${request.approvalId}`;
    const prior = inbox.readReplyDecision(key, request);
    if (prior !== undefined) return prior;
    const requestJson = canonicalJson(request);
    const active = pending.get(key);
    if (active !== undefined) {
      if (active.requestJson !== requestJson)
        throw new Error("Approval identity was already bound to a different reply.");
      return active.promise;
    }
    const promise = (async () => {
      const answer = await decide(request, context);
      return inbox.recordReplyDecision(key, request, answer);
    })().finally(() => pending.delete(key));
    pending.set(key, { requestJson, promise });
    return promise;
  };
}
