/**
 * Money typed at the terminal, as whole cents. An approver enters a value as dollars and
 * cents; it is read as text, never through floating point, so "0.29" is 29 cents and not 28.999….
 */

import {
  type ApprovalRequest,
  type ApprovalValueRequest,
  approvalValueProblem,
} from "@officehum/sdk";
import type { CliIo } from "./cli.js";

const AMOUNT = /^(-?)(\d+)(?:\.(\d{0,2}))?$/;

/**
 * Whole cents from text such as `12`, `12.5`, `12.50` or `-3.07`: digits, an optional decimal point
 * and at most two decimals, and a leading minus only when `allowNegative`. `undefined` for anything
 * else (a currency sign, a thousands separator, a third decimal, a number too large to be exact).
 */
export function parseCents(text: string, allowNegative: boolean): number | undefined {
  const match = AMOUNT.exec(text.trim());
  if (match === null) return undefined;
  const [, minus = "", whole = "", fraction = ""] = match;
  if (minus === "-" && !allowNegative) return undefined;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return undefined;
  // `|| 0` turns "-0" into 0 rather than -0.
  return (minus === "-" ? -cents : cents) || 0;
}

/** Whole cents as dollars and cents: 1250 is "12.50", -7 is "-0.07". */
export function formatCents(cents: number): string {
  const size = Math.abs(cents);
  const text = `${Math.floor(size / 100)}.${String(size % 100).padStart(2, "0")}`;
  return cents < 0 ? `-${text}` : text;
}

/** The bounds of a value request in dollars, as the terminal shows them. */
function boundsText(request: ApprovalValueRequest): string {
  return request.max === undefined
    ? `at least ${formatCents(request.min)}`
    : `from ${formatCents(request.min)} to ${formatCents(request.max)}`;
}

/**
 * Asks the person at the terminal for the value an approval asks for, after their yes: the label, the
 * proposed amount when there is one, and the bounds. An answer that does not parse or is out of bounds
 * is asked again; an empty answer, or the end of input, returns `undefined`, which the caller treats
 * as a decline.
 */
export async function readApprovalValue(
  io: CliIo,
  request: ApprovalRequest & { readonly valueRequest: ApprovalValueRequest },
): Promise<number | undefined> {
  const asked = request.valueRequest;
  const proposed = request.amount === undefined ? "" : `, proposed ${formatCents(request.amount)}`;
  io.output(`Enter ${asked.label} (${boundsText(asked)}${proposed}).`);
  for (;;) {
    const answer = (
      await io.readApproval("Amount in dollars and cents (empty to decline): ")
    )?.trim();
    if (answer === undefined || answer === "") return undefined;
    const cents = parseCents(answer, asked.min < 0);
    if (cents === undefined) {
      io.error(
        `${JSON.stringify(answer)} is not an amount like 12.50${asked.min < 0 ? " or -12.50" : ""}; try again.`,
      );
      continue;
    }
    if (approvalValueProblem(asked, { approved: true, value: cents }) !== undefined) {
      io.error(`${formatCents(cents)} is outside ${boundsText(asked)}; try again.`);
      continue;
    }
    return cents;
  }
}
