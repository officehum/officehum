/**
 * The reply check: a final reply that names a purchase order the desk does not hold goes back to the
 * model once, with the desk's answer, before the run ends.
 *
 * Every tool that takes a purchase order number already refuses one the desk does not hold. A number
 * the model only writes in its reply reaches no tool, so this checks the reply itself, through Pi
 * Durable's `onYield` hook: it sees each final answer and can continue the run with one more user
 * message. It cannot rewrite or withhold the answer, and an honest reply ("PO-9999 is not one of
 * ours") names the number too, so the check does not judge the wording: it tells the model which
 * numbers the desk does not hold and asks it to correct any claim about them, or send the reply again
 * unchanged. That costs one more model turn and happens once per run, so a reply that still names
 * the number goes out; the check can delay a reply, never loop on one.
 *
 * Only numbers shaped like the desk's own (`PO-` and digits) are checked.
 */

import type { Message } from "@earendil-works/pi-ai";
import { GenerationTask, type HookRegistration, hook } from "@earendil-works/pi-durable";
import type { PurchasingDesk } from "./desk.js";

/** How the check's message starts, so the next request can tell this run was already checked. */
const MARKER = "Desk check:";

/** The generation's memo: whether the run this generation belongs to was already sent back. */
const CHECKED = "officehum.purchasing.reply-check.checked";

const PO_NUMBER = /\bPO-\d+\b/gi;

/** The purchase order numbers a text names, upper-cased, each once, in order. */
export function purchaseOrderIds(text: string): string[] {
  return [...new Set([...text.matchAll(PO_NUMBER)].map((match) => match[0].toUpperCase()))];
}

function textOf(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return ((content ?? []) as { type?: string; text?: string }[])
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
}

function correction(missing: readonly string[]): string {
  const which = missing.join(", ");
  const one = missing.length === 1;
  return `${MARKER} The purchasing desk holds no purchase order ${which}, and your reply names ${one ? "it" : "them"}. If your reply says or suggests that ${one ? "it exists" : "they exist"}, ${one ? "was" : "were"} placed or approved, ${one ? "is" : "are"} expected, or that anything was recorded against ${one ? "it" : "them"}, write your reply again without that claim and say the desk has no such order. If your reply already says so, write it again unchanged. Your next message is your full reply to the person and nothing else.`;
}

/**
 * The hook, over the role's desk. With no desk there is nothing to check against, so every reply
 * goes out as written.
 */
export function purchaseOrderReplyCheck(desk: PurchasingDesk | undefined): HookRegistration {
  return hook(GenerationTask, {
    // `onYield` sees only the answer, so the run's state is read here: once the check's message is
    // the latest user message, this generation is the check's own continuation. The memo is the
    // generation's, durable, and shared with its `onYield`.
    beforeRequest: async (request, api, context) => {
      const last = [...request.messages].reverse().find((message) => message.role === "user");
      const checked = last !== undefined && textOf(last).startsWith(MARKER);
      await api.memo<boolean>(CHECKED, checked, context);
      return undefined;
    },
    onYield: async (answer, api, context) => {
      if (desk === undefined) return undefined;
      if ((await api.memo<boolean>(CHECKED, context)) === true) return undefined;
      const missing: string[] = [];
      for (const id of purchaseOrderIds(textOf(answer as Message))) {
        if ((await desk.listPurchaseOrders({ id })).length === 0) missing.push(id);
      }
      return missing.length === 0 ? undefined : { continue: correction(missing) };
    },
  });
}
