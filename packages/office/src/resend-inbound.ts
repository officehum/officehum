import { createHmac, timingSafeEqual } from "node:crypto";
import { convert } from "html-to-text";

export type SignedWebhookHeaders = { id: string; timestamp: string; signature: string };

export type InboundAttachment = {
  id: string;
  filename: string | null;
  contentType: string;
  size: number;
};

export type NormalizedInboundEmail = {
  emailId: string;
  from: string;
  to: string[];
  subject: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  text: string;
  truncated: boolean;
  attachments: InboundAttachment[];
};

export type ReceivingEvent = {
  type: "email.received";
  created_at: string;
  data: {
    email_id: string;
    from: string;
    to: string[];
    subject: string;
    message_id: string;
    attachments: unknown[];
  };
};

const MAX_RAW = 256 * 1024;
const MAX_TEXT = 256 * 1024;
const MAX_MODEL_TEXT = 16_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f\x41-\x7e]+@[\x21-\x3b\x3d\x3f\x41-\x7e]+>$/u;
const OMITTED = "[content omitted by parser limits]";

function controls(value: string, message = false): boolean {
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
    !controls(value)
  );
}

function strictBase64(value: string): Buffer {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error("Webhook signature is invalid.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("Webhook signature is invalid.");
  return decoded;
}

function webhookSecret(value: unknown): Buffer {
  if (typeof value !== "string" || !value.startsWith("whsec_") || value.length > 1000) {
    throw new Error("Webhook signing secret is invalid.");
  }
  const decoded = strictBase64(value.slice(6));
  if (decoded.length === 0) throw new Error("Webhook signing secret is invalid.");
  return decoded;
}

export function verifySvixWebhook(
  raw: Uint8Array,
  headers: SignedWebhookHeaders,
  secrets: readonly string[],
  now = Date.now(),
): Uint8Array {
  if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > MAX_RAW) {
    throw new Error("Webhook payload is invalid.");
  }
  if (
    !exact(headers?.id, 200) ||
    !exact(headers?.timestamp, 20) ||
    !exact(headers?.signature, 4096)
  ) {
    throw new Error("Webhook headers are invalid.");
  }
  if (!/^\d+$/u.test(headers.timestamp)) throw new Error("Webhook timestamp is invalid.");
  const timestamp = Number(headers.timestamp);
  const current = Math.floor(now / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || Math.abs(current - timestamp) > 300) {
    throw new Error("Webhook timestamp is invalid.");
  }
  const candidates = headers.signature.split(" ");
  if (
    candidates.length === 0 ||
    candidates.length > 16 ||
    candidates.some((part) => part.length === 0)
  ) {
    throw new Error("Webhook signature is invalid.");
  }
  let signatures: Buffer[];
  try {
    signatures = candidates.map((candidate) => {
      if (!candidate.startsWith("v1,")) throw new Error();
      const decoded = strictBase64(candidate.slice(3));
      if (decoded.length !== 32) throw new Error();
      return decoded;
    });
  } catch {
    throw new Error("Webhook signature is invalid.");
  }
  if (!Array.isArray(secrets) || secrets.length === 0 || secrets.length > 4) {
    throw new Error("Webhook signing secret is invalid.");
  }
  const prefix = Buffer.from(`${headers.id}.${headers.timestamp}.`, "utf8");
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", webhookSecret(secret))
      .update(prefix)
      .update(raw)
      .digest();
    for (const signature of signatures) matched = timingSafeEqual(expected, signature) || matched;
  }
  if (!matched) throw new Error("Webhook signature is invalid.");
  return Uint8Array.from(raw);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}

function strings(value: unknown, maximum: number, itemMaximum: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) throw new Error();
  return value.map((item) => {
    if (!exact(item, itemMaximum)) throw new Error();
    return item;
  });
}

function messageId(value: unknown): string {
  if (!exact(value, 998) || !MESSAGE_ID.test(value)) throw new Error();
  return value;
}

export function parseReceivingEvent(raw: Uint8Array): ReceivingEvent {
  try {
    if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > MAX_RAW)
      throw new Error();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const root = object(JSON.parse(text) as unknown);
    if (root.type !== "email.received" || !exact(root.created_at, 100)) throw new Error();
    const created = Date.parse(root.created_at);
    if (!Number.isFinite(created)) throw new Error();
    const data = object(root.data);
    if (!exact(data.email_id, 36) || !UUID.test(data.email_id)) throw new Error();
    if (!exact(data.from, 500) || !exact(data.subject, 998)) throw new Error();
    const to = strings(data.to, 50, 500);
    canonicalMailbox(data.from);
    to.forEach(canonicalMailbox);
    const attachments = data.attachments ?? [];
    if (!Array.isArray(attachments) || attachments.length > 50) throw new Error();
    attachments.forEach(attachment);
    return {
      type: "email.received",
      created_at: root.created_at,
      data: {
        email_id: data.email_id,
        from: data.from,
        to,
        subject: data.subject,
        message_id: messageId(data.message_id),
        attachments: structuredClone(attachments),
      },
    };
  } catch {
    throw new Error("Receiving event is invalid.");
  }
}

export function canonicalMailbox(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500 || controls(value)) {
    throw new Error("Mailbox is invalid.");
  }
  const trimmed = value.trim();
  let mailbox = trimmed;
  const angle = trimmed.match(/^([^<>]*)<([^<>]+)>$/u);
  if (angle !== null) {
    const display = angle[1]?.trim() ?? "";
    if (display.includes(",") || display.includes("(") || display.includes(")")) {
      throw new Error("Mailbox is invalid.");
    }
    mailbox = angle[2] ?? "";
  } else if (trimmed.includes("<") || trimmed.includes(">") || trimmed.includes(",")) {
    throw new Error("Mailbox is invalid.");
  }
  if (!/^[\x21-\x7e]+$/u.test(mailbox)) throw new Error("Mailbox is invalid.");
  const canonical = mailbox.toLowerCase();
  if (!EMAIL.test(canonical)) throw new Error("Mailbox is invalid.");
  return canonical;
}

function headers(value: unknown): Record<string, string> {
  const source = object(value ?? {});
  if (Object.keys(source).length > 200) throw new Error("Received email is invalid.");
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    if (
      !exact(key, 200) ||
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(key) ||
      typeof item !== "string" ||
      item.length > 8192 ||
      controls(item, true)
    ) {
      throw new Error("Received email is invalid.");
    }
    const normalizedKey = key.toLowerCase();
    if (result[normalizedKey] !== undefined) throw new Error("Received email is invalid.");
    const unfolded = item.replace(/\r\n[ \t]+/gu, " ");
    if (/[\r\n]/u.test(unfolded)) throw new Error("Received email is invalid.");
    result[normalizedKey] = unfolded;
  }
  return result;
}

function threadIds(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  const unfolded = value.replace(/\r\n[ \t]+/gu, " ");
  if (controls(unfolded, false) || unfolded.length > 8192)
    throw new Error("invalid_thread_headers");
  const ids = unfolded.trim().split(/[ \t]+/u);
  if (ids.length > 50 || ids.some((id) => !MESSAGE_ID.test(id) || id.length > 998)) {
    throw new Error("invalid_thread_headers");
  }
  return ids;
}

function cleanText(value: string): string {
  const normalized = [...value.replace(/\r\n?/gu, "\n")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || (code > 31 && (code < 127 || code > 159));
    })
    .join("");
  const lines = normalized.split("\n");
  const retained: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === "-----Original Message-----") break;
    if (/^On .+ wrote:$/u.test(line) && /^\s*>/u.test(lines[index + 1] ?? "")) break;
    if (/^\s*>/u.test(line)) continue;
    retained.push(line);
  }
  return retained.join("\n").trim();
}

function attachment(value: unknown): InboundAttachment {
  const source = object(value);
  const id = source.id ?? source.attachment_id;
  const contentType = source.content_type ?? source.contentType;
  if (
    !exact(id, 200) ||
    !exact(contentType, 200) ||
    !Number.isSafeInteger(source.size) ||
    (source.size as number) < 0
  ) {
    throw new Error("Received email is invalid.");
  }
  const filename = source.filename;
  if (filename !== null && filename !== undefined && !exact(filename, 500))
    throw new Error("Received email is invalid.");
  return { id, filename: filename ?? null, contentType, size: source.size as number };
}

function headerMailbox(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("reply_to_mismatch");
  if (value.trim() === "") return undefined;
  try {
    return canonicalMailbox(value);
  } catch {
    throw new Error("reply_to_mismatch");
  }
}

function loopBlocked(
  from: string,
  inbound: string,
  outbound: string,
  values: Record<string, string>,
): boolean {
  const local = from.slice(0, from.indexOf("@"));
  if (
    from === inbound ||
    from === outbound ||
    /(?:^|[-_.])no-?reply(?:$|[-_.])|^mailer-daemon$|^postmaster$/u.test(local)
  )
    return true;
  const auto = values["auto-submitted"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (auto !== undefined && auto !== "no") return true;
  const precedence = values.precedence?.trim().toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") return true;
  return (
    values["list-id"] !== undefined ||
    values["list-unsubscribe"] !== undefined ||
    values["return-path"]?.trim() === "<>" ||
    /multipart\/report|message\/delivery-status/iu.test(values["content-type"] ?? "")
  );
}

export function normalizeReceivedEmail(
  rawEvent: unknown,
  rawReceived: unknown,
  inboundEmail = "desk@example.test",
  outboundEmail = inboundEmail,
): NormalizedInboundEmail {
  const event = object(rawEvent);
  const eventData = object(event.data);
  const received = object(rawReceived);
  const emailId = received.id ?? received.email_id;
  if (emailId !== eventData.email_id || !exact(emailId, 36) || !UUID.test(emailId)) {
    throw new Error("binding_mismatch");
  }
  let from: string;
  let eventFrom: string;
  let to: string[];
  let eventTo: string[];
  let boundInbound: string;
  try {
    from = canonicalMailbox(received.from);
    eventFrom = canonicalMailbox(eventData.from);
    to = strings(received.to, 50, 500).map(canonicalMailbox);
    eventTo = strings(eventData.to, 50, 500).map(canonicalMailbox);
    boundInbound = canonicalMailbox(inboundEmail);
  } catch {
    throw new Error("binding_mismatch");
  }
  if (
    from !== eventFrom ||
    JSON.stringify(to) !== JSON.stringify(eventTo) ||
    !to.includes(boundInbound) ||
    received.subject !== eventData.subject
  ) {
    throw new Error("binding_mismatch");
  }
  const subject = received.subject as string;
  if ((/^re:/iu.test(subject) ? subject.length : subject.length + 4) > 200) {
    throw new Error("subject_too_long");
  }
  let values: Record<string, string>;
  try {
    values = headers(received.headers);
  } catch {
    throw new Error("invalid_thread_headers");
  }
  let authentication: Record<string, unknown>;
  try {
    authentication = object(received.authentication);
  } catch {
    throw new Error("authentication_failed");
  }
  if (authentication.dmarc !== "pass") throw new Error("authentication_failed");
  let parent: string;
  try {
    parent = messageId(received.message_id);
    if (
      parent !== eventData.message_id ||
      (values["message-id"] !== undefined && messageId(values["message-id"]) !== parent)
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("invalid_thread_headers");
  }
  const topReply = Array.isArray(received.reply_to)
    ? received.reply_to.length === 0
      ? undefined
      : received.reply_to.length === 1
        ? headerMailbox(received.reply_to[0])
        : (() => {
            throw new Error("reply_to_mismatch");
          })()
    : headerMailbox(received.reply_to);
  const headerReply = headerMailbox(values["reply-to"]);
  if (
    (topReply !== undefined && topReply !== from) ||
    (headerReply !== undefined && headerReply !== from) ||
    (topReply !== undefined && headerReply !== undefined && topReply !== headerReply)
  ) {
    throw new Error("reply_to_mismatch");
  }
  if (loopBlocked(from, boundInbound, canonicalMailbox(outboundEmail), values))
    throw new Error("auto_message");
  let inReplyTo: string | null;
  try {
    inReplyTo = values["in-reply-to"] === undefined ? null : messageId(values["in-reply-to"]);
  } catch {
    throw new Error("invalid_thread_headers");
  }
  const references = threadIds(values.references);
  const rawText = received.text;
  const rawHtml = received.html;
  if (
    (typeof rawText === "string" && rawText.length > MAX_TEXT) ||
    (typeof rawHtml === "string" && rawHtml.length > MAX_TEXT)
  ) {
    throw new Error("body_too_large");
  }
  let text = typeof rawText === "string" && rawText.trim() !== "" ? rawText : "";
  let truncated = false;
  if (text === "") {
    if (typeof rawHtml !== "string") throw new Error("empty_body");
    text = convert(rawHtml, {
      wordwrap: false,
      limits: {
        maxInputLength: MAX_TEXT,
        maxDepth: 40,
        maxChildNodes: 1000,
        ellipsis: OMITTED,
      },
      selectors: [
        ...[
          "script",
          "style",
          "iframe",
          "object",
          "embed",
          "form",
          "img",
          "head",
          "blockquote",
          "div.gmail_quote",
          "div.yahoo_quoted",
        ].map((selector) => ({ selector, format: "skip" })),
        { selector: "a", options: { ignoreHref: true } },
      ],
    });
    truncated = text.includes(OMITTED);
  }
  text = cleanText(text);
  if (text.length === 0) throw new Error("empty_body");
  if (text.length > MAX_MODEL_TEXT) {
    text = text.slice(0, MAX_MODEL_TEXT);
    truncated = true;
  }
  let attachments: InboundAttachment[];
  let eventAttachments: InboundAttachment[];
  try {
    attachments = Array.isArray(received.attachments) ? received.attachments.map(attachment) : [];
    eventAttachments = Array.isArray(eventData.attachments)
      ? eventData.attachments.map(attachment)
      : [];
  } catch {
    throw new Error("binding_mismatch");
  }
  if (attachments.length > 50) throw new Error("binding_mismatch");
  if (canonicalJson(attachments) !== canonicalJson(eventAttachments)) {
    throw new Error("binding_mismatch");
  }
  return {
    emailId,
    from,
    to,
    subject,
    messageId: parent,
    inReplyTo,
    references,
    text,
    truncated,
    attachments,
  };
}

export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, sort(nested)]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value));
}
