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
 * Only numbers shaped like the desk's own (`PO-` and digits) are checked. A desk that cannot be read
 * lets the reply through: the check is advisory, and every tool still refuses an unknown number.
 */

import type { Message } from "@earendil-works/pi-ai";
import { GenerationTask, type HookRegistration, hook } from "@earendil-works/pi-durable";
import type { PurchasingDesk } from "./desk.js";

/** How the check's message starts. */
const MARKER = "Desk check:";

/** The generation's memo: whether the run this generation belongs to was already sent back. */
const CHECKED = "officehum.purchasing.reply-check.checked";

// Whole numbers only: a supplier's own reference such as PO-2024-118 is not the desk's PO-2024.
const PO_NUMBER = /\bPO-\d+(?![\w-])/gi;

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

/** The numbers the desk does not hold, or `undefined` when the desk cannot be read. */
async function unheld(desk: PurchasingDesk, ids: readonly string[]): Promise<string[] | undefined> {
  try {
    const missing: string[] = [];
    for (const id of ids) {
      if ((await desk.listPurchaseOrders({ id })).length === 0) missing.push(id);
    }
    return missing;
  } catch {
    return undefined;
  }
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
    //
    // Only the check's exact text counts, for numbers the desk really does not hold, so a sender who
    // starts a message with "Desk check:" does not switch the check off.
    beforeRequest: async (request, api, context) => {
      const last = [...request.messages].reverse().find((message) => message.role === "user");
      let checked = false;
      if (last !== undefined && desk !== undefined) {
        const text = textOf(last);
        const named = purchaseOrderIds(text);
        if (named.length > 0 && text === correction(named)) {
          const missing = await unheld(desk, named);
          checked = missing !== undefined && missing.length === named.length;
        }
      }
      await api.memo<boolean>(CHECKED, checked, context);
      return undefined;
    },
    onYield: async (answer, api, context) => {
      if (desk === undefined) return undefined;
      if ((await api.memo<boolean>(CHECKED, context)) === true) return undefined;
      const missing = await unheld(desk, purchaseOrderIds(textOf(answer as Message)));
      return missing === undefined || missing.length === 0
        ? undefined
        : { continue: correction(missing) };
    },
  });
}
