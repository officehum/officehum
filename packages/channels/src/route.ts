/**
 * How a conversation answers back, as a fact on the conversation (RASF-3160).
 *
 * The SMS path has always answered a text **by email**, and that was carried by a sentence in a prompt
 * ("Reply-By: email … — use send_message with channel \"email\"") and by a tool schema with one legal
 * channel. A prompt sentence is a wish; a route is data. Recording `{ channel, to }` on the
 * conversation means the tool can read where the answer goes instead of being told, and a conversation
 * with no route can only produce a callback ticket for a person.
 *
 * `to` is where the office would write; it is not permission to write. A first contact with a new
 * destination still waits for a person, whichever route it came from.
 */

/**
 * A route the office would answer on.
 *
 * Declared as an object type rather than an `interface` on purpose: documents in this office store
 * `JsonObject`, and only an alias has the implicit index signature that makes it one. A reply route is
 * written onto a conversation, so it has to be storable.
 */
export type ReplyRoute = {
  /** The channel the answer leaves by, in the same vocabulary the adapters and registry use. */
  readonly channel: string;
  /** The destination on that channel: a mailbox for `email`, a number for `sms`. */
  readonly to: string;
};

/** A route, checked at the boundary so a conversation never records half of one. */
export function replyRoute(channel: string, to: string): ReplyRoute {
  if (channel.trim() === "" || to.trim() === "") {
    throw new Error("A reply route needs a channel and a destination.");
  }
  return { channel, to };
}

/**
 * The line an envelope states about its own route, in the wording the prompt has always used.
 *
 * `undefined` is a conversation with no way to answer, and the sentence says so rather than leaving the
 * reader to notice the absence — a desk that believes it can reply to anything will try.
 */
export function replyByLine(route: ReplyRoute | null): string {
  if (route === null) {
    return "Reply-By: none — this contact has no email address on file; a person must decide how to reach them.";
  }
  return `Reply-By: ${route.channel} ${route.to} — use send_message with channel "${route.channel}"; a first contact waits for a person.`;
}
