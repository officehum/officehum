/**
 * The signature requests this harness sent, in one session document keyed by the office's request
 * id. A send writes its record before it calls the provider, with no provider id, and fills the
 * provider id in once the provider answers; nothing else changes a record, and where a request stands
 * is always asked of the provider. A record still without a provider id is a send a restart cut off
 * mid-call: a later send of the same approved facts from the same conversation reuses its request id,
 * so the provider deduplicates it and nothing goes out twice.
 *
 * It is how `esign_status`, `esign_download` and `esign_void` find a request's provider id, and how a
 * host finds the conversation (and so the ticket) an event is about.
 */

import { defineDoc } from "@earendil-works/pi-durable";

/** A document as the person approved it: the store's id, name and content hash. */
export type ApprovedDocument = {
  fileId: string;
  name: string;
  mimeType: string;
  sha256: string;
};

/** A signer as the person approved them. */
export type ApprovedSigner = {
  name: string;
  email: string;
  role: string | null;
  order: number | null;
};

/** A template as the person approved it. */
export type ApprovedTemplate = { id: string; name: string; roles: string[] };

export type ESignRecord = {
  requestId: string;
  /** `null` until the provider answers the send. */
  providerId: string | null;
  /** The conversation and tool task of the send, from the call's API. */
  conversationId: string;
  taskId: string;
  documents: ApprovedDocument[];
  template: ApprovedTemplate | null;
  signers: ApprovedSigner[];
  subject: string;
  message: string;
  expiresInDays: number | null;
  sentAt: string;
};

export type ESignRecords = { requests: Record<string, ESignRecord> };

export const ESIGN_REQUESTS_DOC = defineDoc<ESignRecords>({
  kind: "officehum.esign-requests",
  version: 1,
  checkpointWhen: () => false,
  scope: "session",
  initial: () => ({ requests: {} }),
});

/** The record for a provider id, for a host handling that provider's event. */
export function recordForProvider(
  records: Readonly<ESignRecords> | undefined,
  providerId: string,
): (ESignRecord & { providerId: string }) | undefined {
  const found = Object.values(records?.requests ?? {}).find(
    (record) => record.providerId === providerId,
  );
  return found === undefined ? undefined : { ...found, providerId };
}

/** A name for the signed copy: the first document's (or the template's) name, without extension. */
export function signedBaseName(record: Pick<ESignRecord, "documents" | "template">): string {
  const source = record.documents[0]?.name ?? record.template?.name ?? "signature-request";
  const base = source
    .replace(/\.[A-Za-z0-9]{1,8}$/u, "")
    .replace(/[^A-Za-z0-9._ -]+/gu, "-")
    .trim()
    .slice(0, 80);
  return base === "" ? "signature-request" : base;
}
