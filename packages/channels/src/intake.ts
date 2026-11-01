/**
 * What happens next, once the gateway has accepted a message (RASF-3160).
 *
 * The gateway answers *what arrived*; the intake answers *what that means for the office*, and the two
 * possible meanings are the whole of it:
 *
 *   * a registered sender is a customer writing in — one conversation per contact, so a second text is
 *     a second sentence in the thread rather than a second piece of work; and
 *   * an unknown sender is a stranger with the office's number — a callback ticket for a person, and no
 *     conversation opened, which is what makes "the agent cannot reply to this" a property of the shape
 *     rather than a rule the model is asked to follow.
 *
 * The gateway does not implement either: a host owns its harness, its board and its people, and this
 * package owns none of them. It only insists that the decision is made in one place per office rather
 * than once per channel.
 */
import type { GatewayOutcome } from "./gateway.js";

export interface InboundIntake {
  /**
   * Take one accepted message. Resolves when the office has it — a conversation input admitted, or a
   * ticket created — so the caller can answer the provider only after the work is durable.
   */
  accept(outcome: GatewayOutcome): void | Promise<void>;
}
