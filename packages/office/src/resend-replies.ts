import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Harness, InboxDoc, UserEntry } from "@earendil-works/pi-durable";
import type {
  InboundAuthority,
  InternalResendInbox,
  ReplyOperationRow,
  StoredInboundReceipt,
} from "./resend-inbox.js";
import { inboundAuthorityId } from "./resend-inbox.js";

export type ReplyTarget = {
  receiptId: string;
  conversationId: string;
  messengerId: string;
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  inReplyTo: string;
  references: string[];
};

export interface ReplyMessenger {
  readonly identity: string;
  prepare(receiptId: string, conversationId: string): Promise<ReplyTarget>;
  send(
    intent: { target: ReplyTarget; text: string },
    options: { requestId: string },
  ): Promise<{ id: string; status: "accepted" }>;
}

export type ResendReplyMessenger = ReplyMessenger & { close(): Promise<void> };

const ENDPOINT = "https://api.resend.com/emails";
const RETRY_WINDOW = 23 * 60 * 60 * 1000;
const RESPONSE_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT = 30_000;
const UNCERTAIN =
  "Reply outcome is uncertain; automatic retry is blocked. Inspect Resend before a new authorized submission.";

function providerKey(identity: string, namespace: string, requestId: string): string {
  return `officehum.email.reply.v1/${createHash("sha256")
    .update(JSON.stringify([identity, namespace, requestId]))
    .digest("hex")}`;
}

function exact(value: unknown, maximum: number, message = false): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (message && (code === 9 || code === 10 || code === 13)) return false;
      return code <= 31 || (code >= 127 && code <= 159);
    })
  );
}

function safeTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(UNCERTAIN);
  return value;
}

function validatePending(row: ReplyOperationRow, observed: number): void {
  if (
    !Number.isSafeInteger(row.firstAttemptAt) ||
    row.firstAttemptAt < 0 ||
    !Number.isSafeInteger(row.firstAttemptAt + RETRY_WINDOW) ||
    !Number.isSafeInteger(row.lastObservedAt) ||
    row.lastObservedAt < row.firstAttemptAt ||
    observed < row.lastObservedAt ||
    observed >= row.firstAttemptAt + RETRY_WINDOW
  ) {
    throw new Error(UNCERTAIN);
  }
}

function validateRow(
  row: ReplyOperationRow,
  identity: string,
  namespace: string,
): ReplyOperationRow {
  if (
    !exact(row.requestId, 500) ||
    !exact(row.receiptId, 200) ||
    typeof row.intentJson !== "string" ||
    typeof row.payloadJson !== "string" ||
    row.providerKey !== providerKey(identity, namespace, row.requestId) ||
    !Number.isSafeInteger(row.firstAttemptAt) ||
    row.firstAttemptAt < 0 ||
    !Number.isSafeInteger(row.lastObservedAt) ||
    row.lastObservedAt < row.firstAttemptAt ||
    (row.state !== "pending" && row.state !== "accepted") ||
    (row.state === "pending" ? row.providerReceiptId !== null : !exact(row.providerReceiptId, 200))
  ) {
    throw new Error("Malformed inbound reply operation.");
  }
  return row;
}

function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(canonical(value));
}

function targetFrom(
  receipt: StoredInboundReceipt,
  receiptAuthority: InboundAuthority,
  identity: string,
  from: string,
  replyTo: string,
): ReplyTarget {
  if (
    receipt.normalized === null ||
    receipt.routeSnapshot === null ||
    receipt.conversationId === null
  ) {
    throw new Error("Inbound reply target is not prepared.");
  }
  const normalized = receipt.normalized;
  if (
    receipt.routeSnapshot.authorityId !== inboundAuthorityId(receiptAuthority) ||
    receipt.routeSnapshot.sender !== normalized.from ||
    normalized.emailId !== receipt.emailId
  ) {
    throw new Error("Inbound reply target conflicts with its saved route.");
  }
  const thread =
    normalized.references.length === 0 && normalized.inReplyTo !== null
      ? [normalized.inReplyTo]
      : normalized.references;
  const references = [...new Set([...thread, normalized.messageId])];
  if (references.length > 50 || references.join(" ").length > 8192) {
    throw new Error("Inbound reply thread is too large.");
  }
  const subject = /^re:/iu.test(normalized.subject)
    ? normalized.subject
    : `Re: ${normalized.subject}`;
  if (subject.length > 200) throw new Error("Inbound reply subject is too large.");
  return {
    receiptId: receipt.emailId,
    conversationId: String(receipt.conversationId),
    messengerId: identity,
    from,
    to: normalized.from,
    replyTo,
    subject,
    inReplyTo: normalized.messageId,
    references,
  };
}

async function validateSubmission(
  harness: Harness,
  receipt: StoredInboundReceipt,
): Promise<number> {
  if (receipt.conversationId === null || receipt.requestId === null || receipt.envelope === null) {
    throw new Error("Inbound admission proof is unavailable.");
  }
  const result = await harness.commit(async (tx) => {
    const record = await tx.submissionByRequest(
      receipt.conversationId as never,
      receipt.requestId as string,
    );
    if (
      record === undefined ||
      record.type !== "input" ||
      record.conversationId !== receipt.conversationId
    ) {
      throw new Error("Inbound submission binding is missing.");
    }
    if (record.status === "queued") {
      const inbox = await tx.doc(InboxDoc, receipt.conversationId as never);
      const item = inbox.items.find(({ id }) => id === record.id);
      if (
        item === undefined ||
        item.mode !== "steer" ||
        !("content" in item) ||
        item.content !== receipt.envelope
      ) {
        throw new Error("Inbound submission binding conflicts with the saved envelope.");
      }
    } else {
      if (record.entry === undefined) throw new Error("Inbound submission binding is unknown.");
      const entry = await tx.entry(UserEntry, record.entry);
      if (
        entry === undefined ||
        entry.model?.length !== 1 ||
        entry.model[0]?.role !== "user" ||
        entry.model[0].content !== receipt.envelope
      ) {
        throw new Error("Inbound submission binding conflicts with the saved envelope.");
      }
    }
    return record.id as number;
  }, BACKGROUND_CONTEXT);
  return result;
}

async function boundedBody(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (response.redirected || response.body === null)
    throw new Error("Resend reply response was invalid.");
  const responseHeaders = [...response.headers];
  if (
    responseHeaders.length > 200 ||
    responseHeaders.reduce((total, [key, value]) => total + key.length + value.length, 0) >
      64 * 1024 ||
    responseHeaders.some(([key, value]) => key.length > 200 || value.length > 8192)
  ) {
    throw new Error("Resend reply response was invalid.");
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
      if (length > RESPONSE_LIMIT) {
        cancelReader(reader);
        throw new Error("Resend reply response was invalid.");
      }
      chunks.push(next.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined)) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Resend reply response was invalid.");
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {});
  } catch {}
}

export function createResendReplyMessenger(options: {
  inbox: InternalResendInbox;
  getHarness: () => Harness | undefined;
  getApiKey: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): ResendReplyMessenger {
  if (typeof options?.getHarness !== "function" || typeof options?.getApiKey !== "function") {
    throw new Error("Reply transport callbacks are invalid.");
  }
  const authorityJson = canonicalJson(options.inbox.authority);
  const identity = `officehum.resend.reply.v1:${createHash("sha256").update(authorityJson).digest("hex")}`;
  const transport = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let closed = false;
  const closing = new AbortController();
  let active: AbortController | undefined;
  let queue: Promise<void> = Promise.resolve();

  const perform = async (
    intent: { target: ReplyTarget; text: string },
    sendOptions: { requestId: string },
  ): Promise<{ id: string; status: "accepted" }> => {
    if (closed) throw new Error("Reply transport is closed.");
    if (!exact(sendOptions?.requestId, 500) || !exact(intent?.text, 4000, true)) {
      throw new Error("Reply request is invalid.");
    }
    const pinned = await messenger.prepare(intent.target.receiptId, intent.target.conversationId);
    const intentJson = canonicalJson({ target: pinned, text: intent.text });
    if (intentJson !== canonicalJson(intent))
      throw new Error("Reply target no longer matches its receipt.");
    const payloadJson = JSON.stringify({
      from: pinned.from,
      to: [pinned.to],
      reply_to: pinned.replyTo,
      subject: pinned.subject,
      text: intent.text,
      headers: {
        "In-Reply-To": pinned.inReplyTo,
        References: pinned.references.join(" "),
        "Auto-Submitted": "auto-replied",
        "X-Auto-Response-Suppress": "All",
      },
    });
    let row = options.inbox.replyOperation(sendOptions.requestId);
    if (row !== undefined) {
      validateRow(row, identity, options.inbox.namespace);
      if (row.intentJson !== intentJson || row.payloadJson !== payloadJson) {
        throw new Error("Reply request ID was already bound to a different payload.");
      }
      if (row.state === "accepted") {
        return { id: row.providerReceiptId as string, status: "accepted" };
      }
      validatePending(row, safeTime(now()));
    }
    let key: string;
    try {
      let onClose!: () => void;
      const closingPromise = new Promise<never>((_resolve, reject) => {
        onClose = () => reject(closing.signal.reason ?? new Error("closed"));
        closing.signal.addEventListener("abort", onClose, { once: true });
      });
      try {
        key = await Promise.race([options.getApiKey(), closingPromise]);
      } finally {
        closing.signal.removeEventListener("abort", onClose);
      }
      if (!exact(key, 1000)) throw new Error();
    } catch {
      if (closed) throw new Error("Reply transport is closed.");
      throw new Error("Resend API key is unavailable.");
    }
    if (closed) throw new Error("Reply transport is closed.");
    const observed = safeTime(now());
    if (row === undefined) {
      row = options.inbox.reserveReplyOperation({
        requestId: sendOptions.requestId,
        receiptId: pinned.receiptId,
        intentJson,
        payloadJson,
        providerKey: providerKey(identity, options.inbox.namespace, sendOptions.requestId),
        firstAttemptAt: observed,
        lastObservedAt: observed,
        state: "pending",
        providerReceiptId: null,
      });
    }
    validateRow(row, identity, options.inbox.namespace);
    if (row.intentJson !== intentJson || row.payloadJson !== payloadJson)
      throw new Error("Reply request ID was already bound to a different payload.");
    if (row.state === "accepted")
      return { id: row.providerReceiptId as string, status: "accepted" };
    validatePending(row, observed);
    options.inbox.observeReplyOperation(row.requestId, observed);
    validatePending({ ...row, lastObservedAt: observed }, safeTime(now()));
    const controller = new AbortController();
    active = controller;
    const onClose = () => controller.abort(new Error("closed"));
    closing.signal.addEventListener("abort", onClose, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("timeout")), REQUEST_TIMEOUT);
    let response: Response;
    let parsed: Record<string, unknown>;
    try {
      response = await transport(ENDPOINT, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": row.providerKey,
        },
        body: row.payloadJson,
        signal: controller.signal,
      });
      parsed = await boundedBody(response, controller.signal);
    } catch (error) {
      if (closed) throw new Error("Reply transport is closed.");
      if (error instanceof Error && error.message === "Resend reply response was invalid.")
        throw error;
      throw new Error("Reply request failed; its outcome is uncertain.");
    } finally {
      clearTimeout(timer);
      closing.signal.removeEventListener("abort", onClose);
      if (active === controller) active = undefined;
    }
    if (!response.ok) {
      if (response.status === 409 && parsed.name === "concurrent_idempotent_requests") {
        throw new Error("A matching Resend reply request is still in flight; retry later.");
      }
      if (response.status === 409)
        throw new Error("Resend rejected the reply idempotency binding.");
      throw new Error(`Resend rejected the reply request with HTTP ${response.status}.`);
    }
    if (!exact(parsed.id, 200)) throw new Error("Resend reply response was invalid.");
    options.inbox.acceptReplyOperation(row.requestId, parsed.id);
    return { id: parsed.id, status: "accepted" };
  };

  const messenger: ResendReplyMessenger = {
    identity,
    async prepare(receiptId, conversationId) {
      if (!exact(receiptId, 200) || !exact(conversationId, 200))
        throw new Error("Reply target request is invalid.");
      let receipt = options.inbox.receipt(receiptId);
      if (
        receipt === undefined ||
        receipt.conversationId === null ||
        String(receipt.conversationId) !== conversationId
      ) {
        throw new Error("Reply receipt does not belong to this conversation.");
      }
      if (receipt.state === "prepared") {
        const harness = options.getHarness();
        if (harness === undefined) throw new Error("Reply admission resolver is not attached.");
        const submissionId = await validateSubmission(harness, receipt);
        options.inbox.saveAdmission(receiptId, submissionId);
        receipt = options.inbox.receipt(receiptId);
      }
      if (receipt === undefined || (receipt.state !== "admitted" && receipt.state !== "settled")) {
        throw new Error("Inbound receipt is not admitted for reply.");
      }
      return targetFrom(
        receipt,
        options.inbox.authority,
        identity,
        options.inbox.authority.fromEmail,
        options.inbox.authority.inboundEmail,
      );
    },
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
      closing.abort(new Error("closed"));
      active?.abort(new Error("closed"));
      await queue;
    },
  };
  return messenger;
}
