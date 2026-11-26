/**
 * The e-signature interface: what any provider client gives the pack, whichever service the business
 * uses. A client is written once per provider (separate issues); the pack, its tools and the office
 * only ever see this.
 *
 * Everything a client returns came from outside the office. `checkSendResult`, `checkStatusResult`
 * and `checkEvent` hold it to this shape before anything else reads it: a status outside the list, a
 * provider id that is not a short label, or a signer the request never named is refused, never passed
 * on.
 */

/** Where a signature request stands, in the provider's account of it. */
export const ESIGN_STATUSES = [
  "sent",
  "viewed",
  "partially_signed",
  "completed",
  "declined",
  "expired",
  "voided",
] as const;
export type ESignStatus = (typeof ESIGN_STATUSES)[number];

/** Where one signer stands. */
export const SIGNER_STATUSES = ["pending", "viewed", "signed", "declined"] as const;
export type SignerStatus = (typeof SIGNER_STATUSES)[number];

/** A provider-side template: a document already set up for signing, with its signer roles. */
export interface ESignTemplate {
  readonly id: string;
  readonly name: string;
  readonly roles: readonly string[];
}

/** One person asked to sign. Always an outside party. */
export interface ESignSigner {
  readonly name: string;
  readonly email: string;
  /** The template role they sign as, for a template request. */
  readonly role?: string;
  /** Their place in a signing order (1 signs first); absent signers sign in any order. */
  readonly order?: number;
}

/**
 * A document to send, read from the office's file store by the pack. The bytes are handed over so a
 * client never needs a file store of its own; the hash is the one the person approved.
 */
export interface ESignDocument {
  readonly fileId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

/** What to send: documents or a template (exactly one), the signers and the note to them. */
export interface ESignSendRequest {
  readonly documents?: readonly ESignDocument[];
  readonly templateId?: string;
  readonly signers: readonly ESignSigner[];
  readonly subject: string;
  readonly message: string;
  readonly expiresInDays?: number;
  /**
   * The office's id for this request, stable across a retry of the same call. A client must
   * deduplicate on it: a second `send` with the same id returns the first request, sending nothing.
   */
  readonly requestId: string;
}

export interface ESignSendResult {
  readonly requestId: string;
  /** The provider's own id for the request. */
  readonly providerId: string;
  readonly status: ESignStatus;
}

export interface ESignSignerState {
  readonly email: string;
  readonly status: SignerStatus;
  /** When the signer last moved (ISO 8601), when the provider says. */
  readonly at?: string;
}

export interface ESignStatusResult {
  readonly status: ESignStatus;
  readonly signers: readonly ESignSignerState[];
}

export interface ESignCompleted {
  /** The signed PDF. */
  readonly signed: Uint8Array;
  /** The provider's completion certificate (audit trail) as a PDF, when it gives one. */
  readonly certificate?: Uint8Array;
}

/** A webhook request as it arrived: headers (names lowercased) and the raw body its signature covers. */
export interface ESignWebhookRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: Uint8Array;
}

/** One verified event from a provider. */
export interface ESignEvent {
  /** The provider's id for the event itself, so a redelivery is recognised. */
  readonly eventId: string;
  readonly providerId: string;
  readonly status: ESignStatus;
  readonly signers: readonly ESignSignerState[];
  /** When it happened (ISO 8601). */
  readonly at: string;
}

export interface ESignature {
  listTemplates(): Promise<readonly ESignTemplate[]>;
  send(request: ESignSendRequest): Promise<ESignSendResult>;
  status(providerId: string): Promise<ESignStatusResult>;
  downloadCompleted(providerId: string): Promise<ESignCompleted>;
  void(providerId: string, reason: string): Promise<void>;
  /**
   * The event a webhook request carries, or `undefined` when it is not one this provider signed. Each
   * client verifies its own provider's signature; an unverified request is never an event.
   */
  parseWebhook(request: ESignWebhookRequest): Promise<ESignEvent | undefined>;
}

/** Why the pack refused, with a stable code. */
export class ESignError extends Error {
  constructor(
    readonly code: ESignErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ESignError";
  }
}

export const ESIGN_ERROR_CODES = [
  "invalid-request",
  "unknown-document",
  "unknown-template",
  "unknown-request",
  "send-interrupted",
  "not-approved",
  "changed-since-approval",
  "not-completed",
  "provider-output",
  "provider-error",
] as const;
export type ESignErrorCode = (typeof ESIGN_ERROR_CODES)[number];

/** A short printable label, as a provider id, an event id or a template id must be. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u;

export function isLabel(value: unknown): value is string {
  return typeof value === "string" && LABEL.test(value);
}

function outside(message: string): ESignError {
  return new ESignError("provider-output", `The e-signature provider returned ${message}.`);
}

function checkStatus(value: unknown): ESignStatus {
  if (!(ESIGN_STATUSES as readonly unknown[]).includes(value)) throw outside("an unknown status");
  return value as ESignStatus;
}

/**
 * The signers' states, kept only for the emails the request named (case-insensitive), each with the
 * spelling the office sent. A signer the request never named is refused: nobody is added by a reply.
 */
function checkSigners(value: unknown, sent: readonly string[]): ESignSignerState[] {
  if (!Array.isArray(value)) throw outside("signers that are not a list");
  const known = new Map(sent.map((email) => [email.toLowerCase(), email]));
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object") throw outside("a signer that is not a record");
    const { email, status, at } = entry as Record<string, unknown>;
    const ours = typeof email === "string" ? known.get(email.toLowerCase()) : undefined;
    if (ours === undefined) throw outside("a signer the request did not name");
    if (!(SIGNER_STATUSES as readonly unknown[]).includes(status)) {
      throw outside("an unknown signer status");
    }
    if (at !== undefined && (typeof at !== "string" || !ISO.test(at))) {
      throw outside("a signer time that is not ISO 8601");
    }
    return { email: ours, status: status as SignerStatus, ...(at === undefined ? {} : { at }) };
  });
}

export function checkSendResult(value: unknown, requestId: string): ESignSendResult {
  if (value === null || typeof value !== "object") throw outside("no send result");
  const result = value as Record<string, unknown>;
  if (result.requestId !== requestId) throw outside("another request's id");
  if (!isLabel(result.providerId)) throw outside("a provider id that is not a short label");
  return { requestId, providerId: result.providerId, status: checkStatus(result.status) };
}

export function checkStatusResult(value: unknown, sent: readonly string[]): ESignStatusResult {
  if (value === null || typeof value !== "object") throw outside("no status");
  const result = value as Record<string, unknown>;
  return { status: checkStatus(result.status), signers: checkSigners(result.signers, sent) };
}

/** An event held to the shape; `sent` is the request's signer emails, once the request is known. */
export function checkEvent(value: unknown, sent: readonly string[]): ESignEvent {
  if (value === null || typeof value !== "object") throw outside("no event");
  const event = value as Record<string, unknown>;
  if (!isLabel(event.eventId)) throw outside("an event id that is not a short label");
  if (!isLabel(event.providerId)) throw outside("a provider id that is not a short label");
  if (typeof event.at !== "string" || !ISO.test(event.at)) throw outside("an event time");
  return {
    eventId: event.eventId,
    providerId: event.providerId,
    status: checkStatus(event.status),
    signers: checkSigners(event.signers ?? [], sent),
    at: event.at,
  };
}

/** The PDF signature every signed copy and certificate must start with. */
export function isPdf(bytes: unknown): bytes is Uint8Array {
  return (
    bytes instanceof Uint8Array &&
    bytes.byteLength >= 5 &&
    Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-"
  );
}
