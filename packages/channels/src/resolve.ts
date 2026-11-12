/**
 * Who sent this message: a customer the office knows, or a stranger with the office's number.
 *
 * It is the one question the inbound paths answered differently — email matched the sender against the
 * contact list in `inbound-session.ts`, SMS asked the host's `isRegistered` — and the difference
 * mattered: a registered sender is exempt from the stranger's ceiling and is routed into a
 * conversation, an unknown one gets a callback ticket and no conversation at all.
 *
 * So the answer is a value the gateway produces once and hands on. `contactId` is `null` when the
 * sender is known to be a customer but the channel's boundary cannot name the contact row — the SMS
 * route knows only that a number belongs to somebody, and its intake re-reads the contact inside the
 * commit that creates the route.
 */
import type { InboundMessage } from "./adapter.js";

export type SenderResolution =
  | { readonly kind: "registered"; readonly contactId: string | null }
  | { readonly kind: "unknown" };

/** The conservative answer: every sender is a stranger, and the ceiling applies to all of them. */
export const UNKNOWN_SENDER: SenderResolution = { kind: "unknown" };

export function registeredSender(contactId: string | null = null): SenderResolution {
  return { kind: "registered", contactId };
}

/**
 * A resolver, as the gateway calls it. It may answer later: an office's contact list lives behind
 * its own store, and reading it is not instant. The gateway waits for the answer before the ceiling
 * is applied, and the provider is acknowledged only after dispatch either way.
 */
export type SenderResolver = (
  message: InboundMessage,
) => SenderResolution | Promise<SenderResolution>;

/**
 * A resolver from a predicate over the sender's address.
 *
 * This is the shape a host with no contact list can answer: "is this number one of ours?", asked from
 * whatever the host already holds. A host with no answer passes nothing, and every sender is a
 * stranger — which is the conservative reading, because it only makes the ceiling stricter.
 */
export function resolveBy(predicate: (from: string) => boolean | Promise<boolean>): SenderResolver {
  return async (message) => ((await predicate(message.from)) ? registeredSender() : UNKNOWN_SENDER);
}

/** The resolver a host with nothing to say gets. */
export const UNKNOWN_SENDERS: SenderResolver = () => UNKNOWN_SENDER;
