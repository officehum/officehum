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
 * The sender of the work a tool call or hook belongs to, given the call's conversation and task.
 * Both are taken from the caller's Pi Durable hook or tool context (a `HookApi` carries both),
 * never from a tool argument: an id the model chose could name another conversation's sender.
 * `undefined` when the host does not know: the sender is then unknown, exactly as for a role given
 * no resolver.
 */
export type SenderResolver = (call: {
  readonly conversationId: unknown;
  readonly taskId: unknown;
}) => Promise<VerifiedSender | undefined>;

/**
 * The person on the company record a verified sender is: by id for an internal sender, by email for
 * any sender (whole, ignoring case), and by phone for any sender, compared on a leading "+" and the
 * digits only, so the gateway's E.164 `+15035550143` is the record's `+1 503 555 0143`. Every match
 * is whole, never a prefix. `undefined` for no sender, or one the record does not know. An id only
 * names a colleague inside the office, so an outside contact that happens to spell one is nobody.
 */
export function senderPerson<P extends CompanyPerson & { email?: string; phone?: string }>(
  company: { readonly people: readonly P[] },
  sender: VerifiedSender | undefined,
): P | undefined {
  if (sender === undefined) return undefined;
  const contact = sender.contact.toLowerCase();
  const same = (value: string | undefined): boolean =>
    value !== undefined && value.toLowerCase() === contact;
  const phone = phoneDigits(sender.contact);
  const samePhone = (value: string | undefined): boolean =>
    phone !== undefined && value !== undefined && phoneDigits(value) === phone;
  return company.people.find(
    (person) =>
      (sender.origin === "internal" && same(person.id)) ||
      same(person.email) ||
      samePhone(person.phone),
  );
}

/**
 * The colleague a verified sender is: the person on the company record, and only when the work came
 * from inside the office (`origin: "internal"`). Every role asks this one question before treating a
 * sender as staff. An outside email or text is never a colleague, even from a colleague's own address
 * or number: an outside channel does not prove who typed it, so it gets what any outside contact gets.
 * Use `senderPerson` directly only to recognise an outside contact, never to trust one as staff.
 */
export function colleague<P extends CompanyPerson & { email?: string; phone?: string }>(
  company: { readonly people: readonly P[] },
  sender: VerifiedSender | undefined,
): P | undefined {
  return sender?.origin === "internal" ? senderPerson(company, sender) : undefined;
}

/** A phone number as a leading "+" and its digits; `undefined` when it holds no digit at all. */
function phoneDigits(value: string): string | undefined {
  const digits = value.replace(/\D/g, "");
  if (digits === "") return undefined;
  return value.trim().startsWith("+") ? `+${digits}` : digits;
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

/** A title that heads the company. The company validator allows one person to hold one. */
export const HEAD_TITLE = /\b(managing director|owner|president|chief executive)\b/i;
/** A director's title, which heads the company only when nobody holds a head title. */
const DIRECTOR_TITLE = /\bdirector\b/i;

/**
 * The person at the top of the company: whoever holds a head title (managing director, owner,
 * president, chief executive), wherever they sit in the record. Only when nobody does, the first
 * person whose title says director, in record order. `undefined` when neither exists. A complaint
 * about the person who would normally take it goes here instead, so a "Finance Director" listed
 * before the managing director must never be picked.
 */
export function companyHead<P extends CompanyPerson>(company: {
  readonly people: readonly P[];
}): P | undefined {
  return (
    company.people.find((candidate) => HEAD_TITLE.test(candidate.title)) ??
    company.people.find((candidate) => DIRECTOR_TITLE.test(candidate.title))
  );
}

/** "Name, Title", or the fallback when the company names nobody. */
export function personLabel(who: CompanyPerson | undefined, fallback = "a person"): string {
  return who === undefined ? fallback : `${who.name}, ${who.title}`;
}

/** A title that means the people function, and the everyday words people use for whoever holds it. */
const HR_TITLE = /\b(people|hr|human resources|personnel)\b/i;
const HR_WORDS = ["hr", "human resources", "personnel", "people ops", "people team"];

/**
 * Every person the company record names, by id, full name, title, surname, first name or an alias
 * the record gives them ("DW"), each matched as whole words anywhere in the text, ignoring case: how a
 * colleague refers to someone ("the people ops person", a surname, a first name, initials). A first
 * initial and surname ("D. Whitfield") is found by its surname. A word that only contains a name or
 * an alias does not match. Empty when the words name nobody on the record. Whoever holds a people or
 * HR title is also matched by the everyday words for that job ("HR", "human resources",
 * "personnel"). Used to keep a complaint away from the people it names, so matching eagerly only
 * ever sends it to someone else.
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
      (candidate.aliases ?? []).some((alias) => has(alias)) ||
      (HR_TITLE.test(candidate.title) && HR_WORDS.some((word) => has(word)))
    );
  });
}
