/**
 * Filling in a completion-evidence entry's arguments from the ticket it is checked against.
 *
 * `officehum.json` declares what must check out before a ticket is done (`accepts[].done`), and an
 * entry's arguments may name the ticket: `{ticket.id}` and `{ticket.data.<path>}`, the only two
 * placeholders the manifest validator admits. A host that runs the evidence resolves them here, so
 * every host reads a placeholder the same way and none of them substitutes anything else.
 */

import { engineArgs } from "./engine.js";
import { EVIDENCE_PLACEHOLDER, type ParameterDeclaration } from "./manifest.js";

/** A value an evidence argument may carry, before and after its placeholders are filled. */
export type EvidenceValue = string | number | boolean;

/** The ticket an evidence entry is checked against: its id, and the data it was opened with. */
export interface EvidenceTicket {
  readonly id: string;
  readonly data: unknown;
}

export type ResolvedEvidenceArgs =
  | { readonly ok: true; readonly args: Record<string, EvidenceValue> }
  /** Every placeholder the ticket could not fill, as written, e.g. `{ticket.data.customer}`. */
  | { readonly ok: false; readonly missing: readonly string[] };

const PLACEHOLDER = /\{[^{}]*\}/g;

function isValue(value: unknown): value is EvidenceValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** What one placeholder names on the ticket, or `undefined` when the ticket has no such value. */
function lookup(placeholder: string, ticket: EvidenceTicket): EvidenceValue | undefined {
  if (!EVIDENCE_PLACEHOLDER.test(placeholder)) return undefined;
  const path = placeholder.slice(1, -1).split(".").slice(1);
  if (path[0] === "id") return ticket.id;
  let current: unknown = ticket.data;
  for (const key of path.slice(1)) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  // An empty string is a missing answer: a check for "the customer ''" would match anything or nothing.
  return isValue(current) && current !== "" ? current : undefined;
}

/**
 * The entry's arguments with every placeholder filled from the ticket. An argument that is one
 * placeholder and nothing else keeps the ticket value's own type, so a number stays a number; a
 * placeholder inside other text is written into it. Nothing is guessed: a placeholder the ticket
 * cannot fill is reported, and the caller fails the check instead of running it half-addressed.
 */
export function resolveEvidenceArgs(
  args: Readonly<Record<string, EvidenceValue>> | undefined,
  ticket: EvidenceTicket,
): ResolvedEvidenceArgs {
  const resolved: Record<string, EvidenceValue> = {};
  const missing: string[] = [];
  for (const [name, value] of Object.entries(args ?? {})) {
    if (typeof value !== "string") {
      resolved[name] = value;
      continue;
    }
    const placeholders = value.match(PLACEHOLDER) ?? [];
    const whole = placeholders.length === 1 && placeholders[0] === value;
    if (whole) {
      const found = lookup(value, ticket);
      if (found === undefined) missing.push(value);
      else resolved[name] = found;
      continue;
    }
    resolved[name] = value.replace(PLACEHOLDER, (placeholder) => {
      const found = lookup(placeholder, ticket);
      if (found === undefined) {
        missing.push(placeholder);
        return placeholder;
      }
      return String(found);
    });
  }
  return missing.length === 0 ? { ok: true, args: resolved } : { ok: false, missing };
}

/**
 * The engine arguments for an `engine` evidence entry: its subcommand, then each resolved argument
 * as a flag, by the same rule a tool's parameters follow (`engineArgs`).
 */
export function evidenceEngineArgs(
  subcommand: readonly string[],
  args: Readonly<Record<string, EvidenceValue>>,
): string[] {
  const parameters = Object.fromEntries(
    Object.entries(args).map(([name, value]): [string, ParameterDeclaration] => [
      name,
      { type: typeof value === "boolean" ? "boolean" : "string", description: name },
    ]),
  );
  return engineArgs(subcommand, parameters, args);
}
