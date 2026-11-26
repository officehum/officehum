/**
 * A fake e-signature provider for tests and evals: no network, no account. It keeps requests in
 * memory, deduplicates `send` by request id as a real client must, and has a controllable signer: each
 * of `view`, `sign`, `decline` and `expire` moves a request and returns the webhook the provider would
 * post, signed with HMAC-SHA256 over the raw body, which `parseWebhook` verifies.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ESignature,
  ESignCompleted,
  ESignEvent,
  ESignSendRequest,
  ESignSendResult,
  ESignSignerState,
  ESignStatus,
  ESignStatusResult,
  ESignTemplate,
  ESignWebhookRequest,
  SignerStatus,
} from "./esign.js";

/** The header the fake signs its webhooks with. */
export const FAKE_SIGNATURE_HEADER = "x-fake-esign-signature";

export interface FakeESignatureOptions {
  readonly templates?: readonly ESignTemplate[];
  /** The webhook signing secret; a fixed test value by default. */
  readonly secret?: string;
  /** The clock events and signer times are stamped with. */
  readonly now?: () => Date;
}

/** One request as the fake holds it. */
export interface FakeRequest {
  readonly providerId: string;
  readonly request: ESignSendRequest;
  status: ESignStatus;
  readonly signers: Map<string, { status: SignerStatus; at?: string }>;
  voidReason?: string;
}

export interface FakeESignature extends ESignature {
  /** Every request the fake created, in order: a deduplicated `send` creates none. */
  requests(): readonly FakeRequest[];
  /** How many times `send` was called, deduplicated or not. */
  sendCalls(): number;
  view(providerId: string, email: string): ESignWebhookRequest;
  sign(providerId: string, email: string): ESignWebhookRequest;
  decline(providerId: string, email: string): ESignWebhookRequest;
  expire(providerId: string): ESignWebhookRequest;
  /** A webhook for any event, signed with `secret` (the fake's own by default). */
  webhook(event: ESignEvent, secret?: string): ESignWebhookRequest;
}

const DEFAULT_SECRET = "fake-esign-test-secret";

export function fakeESignature(options: FakeESignatureOptions = {}): FakeESignature {
  const secret = options.secret ?? DEFAULT_SECRET;
  const now = options.now ?? (() => new Date());
  const templates = options.templates ?? [
    { id: "tpl-nda", name: "Mutual NDA", roles: ["client", "company"] },
  ];
  const byProvider = new Map<string, FakeRequest>();
  const byRequestId = new Map<string, FakeRequest>();
  const created: FakeRequest[] = [];
  let calls = 0;
  let events = 0;

  const find = (providerId: string): FakeRequest => {
    const found = byProvider.get(providerId);
    if (found === undefined) throw new Error(`The fake has no request ${providerId}.`);
    return found;
  };

  const signerStates = (entry: FakeRequest): ESignSignerState[] =>
    [...entry.signers].map(([email, state]) => ({
      email,
      status: state.status,
      ...(state.at === undefined ? {} : { at: state.at }),
    }));

  /** The request's status from its signers, unless it already ended. */
  const settle = (entry: FakeRequest): void => {
    if (entry.status === "expired" || entry.status === "voided") return;
    const states = [...entry.signers.values()].map((state) => state.status);
    if (states.includes("declined")) entry.status = "declined";
    else if (states.every((state) => state === "signed")) entry.status = "completed";
    else if (states.includes("signed")) entry.status = "partially_signed";
    else if (states.includes("viewed")) entry.status = "viewed";
  };

  const signed = (body: Uint8Array, key: string): string =>
    createHmac("sha256", key).update(body).digest("hex");

  const webhook = (event: ESignEvent, key = secret): ESignWebhookRequest => {
    const body = new TextEncoder().encode(JSON.stringify(event));
    return { headers: { [FAKE_SIGNATURE_HEADER]: signed(body, key) }, body };
  };

  const move = (providerId: string, email: string, status: SignerStatus): ESignWebhookRequest => {
    const entry = find(providerId);
    const signer = entry.signers.get(email);
    if (signer === undefined) throw new Error(`${email} is not a signer of ${providerId}.`);
    signer.status = status;
    signer.at = now().toISOString();
    settle(entry);
    return eventFor(entry);
  };

  const eventFor = (entry: FakeRequest): ESignWebhookRequest => {
    events += 1;
    return webhook({
      eventId: `evt-${events}`,
      providerId: entry.providerId,
      status: entry.status,
      signers: signerStates(entry),
      at: now().toISOString(),
    });
  };

  const pdf = (text: string): Uint8Array =>
    new TextEncoder().encode(`%PDF-1.7\n% ${text}\n%%EOF\n`);

  return {
    async listTemplates() {
      return templates;
    },
    async send(request): Promise<ESignSendResult> {
      calls += 1;
      const existing = byRequestId.get(request.requestId);
      const entry =
        existing ??
        ((): FakeRequest => {
          const providerId = `env-${created.length + 1}`;
          const made: FakeRequest = {
            providerId,
            request,
            status: "sent",
            signers: new Map(
              request.signers.map((signer) => [signer.email, { status: "pending" }]),
            ),
          };
          created.push(made);
          byProvider.set(providerId, made);
          byRequestId.set(request.requestId, made);
          return made;
        })();
      return { requestId: request.requestId, providerId: entry.providerId, status: entry.status };
    },
    async status(providerId): Promise<ESignStatusResult> {
      const entry = find(providerId);
      return { status: entry.status, signers: signerStates(entry) };
    },
    async downloadCompleted(providerId): Promise<ESignCompleted> {
      const entry = find(providerId);
      if (entry.status !== "completed") {
        throw new Error(`Request ${providerId} is ${entry.status}, not completed.`);
      }
      return { signed: pdf(`signed ${providerId}`), certificate: pdf(`certificate ${providerId}`) };
    },
    async void(providerId, reason) {
      const entry = find(providerId);
      if (entry.status === "completed") throw new Error(`Request ${providerId} is completed.`);
      entry.status = "voided";
      entry.voidReason = reason;
    },
    async parseWebhook(request) {
      const header = request.headers[FAKE_SIGNATURE_HEADER];
      if (typeof header !== "string") return undefined;
      const expected = Buffer.from(signed(request.body, secret), "hex");
      const given = Buffer.from(header, "hex");
      if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected)) {
        return undefined;
      }
      try {
        return JSON.parse(new TextDecoder().decode(request.body)) as ESignEvent;
      } catch {
        return undefined;
      }
    },
    requests: () => [...created],
    sendCalls: () => calls,
    view: (providerId, email) => move(providerId, email, "viewed"),
    sign: (providerId, email) => move(providerId, email, "signed"),
    decline: (providerId, email) => move(providerId, email, "declined"),
    expire(providerId) {
      const entry = find(providerId);
      entry.status = "expired";
      return eventFor(entry);
    },
    webhook,
  };
}
