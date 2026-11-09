/**
 * Helpers every role package shares for reading the company record generated into it.
 *
 * Each role keeps its own `COMPANY_FACTS_URL` (the path is relative to that package) and its own
 * `CompanyFacts` type; only the loading, the person lookup and the label format are common.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The least a person record carries for these helpers. */
export interface CompanyPerson {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly aliases?: readonly string[];
}

/**
 * Who is asking, as the host verified it: the channel the work arrived on and the contact it came
 * from (a person's id for an internal ticket, an email address or phone number for an outside one).
 * Office Hum reads it from the ticket's provenance; a role never takes it from a tool argument or
 * from message text, which anyone can write.
 */
export interface VerifiedSender {
  readonly origin: "internal" | "external";
  readonly channel: string;
  readonly contact: string;
}

/**
 * The sender of the work a tool call or hook belongs to, given the call's conversation and task (a
 * Pi Durable `HookApi` or tool context carries both). `undefined` when the host does not know: the
 * sender is then unknown, exactly as for a role given no resolver at all.
 */
export type SenderResolver = (call: {
  readonly conversationId: unknown;
  readonly taskId: unknown;
}) => Promise<VerifiedSender | undefined>;

/**
 * The person on the company record a verified sender is: by id for an internal sender, and by email
 * or phone for any sender, each compared whole and ignoring case. `undefined` for no sender, or one
 * the record does not know. An id only names a colleague inside the office, so an outside contact
 * that happens to spell one is nobody.
 */
export function senderPerson<P extends CompanyPerson & { email?: string; phone?: string }>(
  company: { readonly people: readonly P[] },
  sender: VerifiedSender | undefined,
): P | undefined {
  if (sender === undefined) return undefined;
  const contact = sender.contact.toLowerCase();
  const same = (value: string | undefined): boolean =>
    value !== undefined && value.toLowerCase() === contact;
  return company.people.find(
    (person) =>
      (sender.origin === "internal" && same(person.id)) || same(person.email) || same(person.phone),
  );
}

/** The company facts generated into a role package. Throws when the copy is missing or is not JSON. */
export function loadCompanyFacts<T extends object>(url: URL): T {
  const path = fileURLToPath(url);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(url, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `${path} could not be read: ${error instanceof Error ? error.message : String(error)}. ` +
        "It is generated: run `npm run sync-company` in the repository this package came from.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must hold a JSON object.`);
  }
  return parsed as T;
}

/** "Name, Title", or the fallback when the company names nobody. */
export function personLabel(who: CompanyPerson | undefined, fallback = "a person"): string {
  return who === undefined ? fallback : `${who.name}, ${who.title}`;
}

/** A title that means the people function, and the everyday words people use for whoever holds it. */
const HR_TITLE = /\b(people|hr|human resources|personnel)\b/i;
const HR_WORDS = ["hr", "human resources", "personnel", "people ops", "people team"];

/**
 * Every person the company record names, by id, full name, title, surname or first name, each matched
 * as whole words anywhere in the text, ignoring case: how a colleague refers to someone ("the people
 * ops person", a surname, a first name). A word that only contains a name does not match. Empty when
 * the words name nobody on the record. Whoever holds a people or HR title is also matched by the
 * everyday words for that job ("HR", "human resources", "personnel"). Used to keep a complaint away
 * from the people it names, so matching eagerly only ever sends it to someone else.
 */
export function findPeople<P extends CompanyPerson>(
  company: { readonly people: readonly P[] },
  words: string,
): readonly P[] {
  const wanted = words.trim().toLowerCase();
  if (wanted === "") return [];
  const has = (phrase: string): boolean => {
    const escaped = phrase
      .trim()
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return escaped !== "" && new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(wanted);
  };
  return company.people.filter((candidate) => {
    const parts = candidate.name.split(" ");
    return (
      candidate.id.toLowerCase() === wanted ||
      has(candidate.name) ||
      has(candidate.title) ||
      parts.some((part) => has(part)) ||
      (HR_TITLE.test(candidate.title) && HR_WORDS.some((word) => has(word)))
    );
  });
}
