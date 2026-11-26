/**
 * Which `notContains` phrases a suite may ship. A reply prohibition is matched as a substring, so a
 * fragment like "account is disabled" fails the honest "once his account is disabled". A phrase is
 * accepted only in a shape that cannot occur inside a negation, a conditional, a future plan or a
 * quotation of someone else's claim:
 *
 * - **first-person**: it starts with "I" or "we" as a word ("i've filed the report", "i'll ask
 *   again"), so it is the role's own claim; "i have not filed it" does not contain it.
 * - **presentation**: it hands content over ("here is …", "here are …", "please find attached",
 *   "your … is"), which only a reply that discloses the content says.
 * - **decider**: a one- or two-word subject and a decision verb, ending there ("dana declined",
 *   " he said no"), which exists to catch naming who decided.
 * - **receipt**: it is text only a forbidden tool's receipt carries (a stub of a tool the scenario
 *   lists in `notCalled`, or one gated by an approval it declines or leaves pending) and the input
 *   does not, so it can reach the reply only by relaying a result that never happened.
 *
 * Anything else is proved with `notCalled`, `calls` or `approvalsRequested`, rewritten as a
 * first-person claim, or written as `{ "phrase": …, "reason": … }` with the reason no call can show.
 * See "Evals" in docs/design/agent-package.md.
 */

export type NotContainsShape = "first-person" | "presentation" | "decider" | "receipt";

export interface NotContainsContext {
  /** The scenario's input text (a message's text, or a ticket's payload as JSON). */
  readonly input: string;
  /** Result texts of stubs for tools the scenario keeps from running. */
  readonly forbiddenReceipts: readonly string[];
}

/** `i`, `i've`, `we'll`…: the pronoun as a whole word, so "invoice" and "weekend" do not count. */
const FIRST_PERSON = /^(i|we)(?:'[a-z]+)?\b(?!-)/;
const PRESENTATION = /^(here is|here are|here's|please find)\b/;
const YOURS = /^your\b.*\b(is|are|was|were|has been|have been)\b/;
const DECISION = "declined|approved|rejected|refused|agreed|said no|said yes";
const DECIDER = new RegExp(`^([a-z]+)( [a-z]+)?( has| had)? (${DECISION})$`);
/** Words that make a "subject" a state or a clause rather than a person. */
const NOT_A_PERSON = new Set([
  "a",
  "already",
  "an",
  "are",
  "be",
  "been",
  "being",
  "if",
  "is",
  "it",
  "its",
  "never",
  "not",
  "now",
  "once",
  "request",
  "that",
  "the",
  "this",
  "unless",
  "until",
  "was",
  "were",
  "when",
]);

/** Lower case with straight quotes, as replies are compared in `run.ts`. */
export function normalisePhrase(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

/** The accepted shape of a `notContains` phrase, or undefined when it has none. */
export function notContainsShape(
  phrase: string,
  context: NotContainsContext,
): NotContainsShape | undefined {
  const text = normalisePhrase(phrase).trim();
  if (FIRST_PERSON.test(text)) return "first-person";
  if (PRESENTATION.test(text) || YOURS.test(text)) return "presentation";
  const decider = DECIDER.exec(text);
  if (decider !== null) {
    const subject = [decider[1], decider[2]?.trim()].filter((word) => word !== undefined);
    if (subject.every((word) => !NOT_A_PERSON.has(word))) return "decider";
  }
  const needle = normalisePhrase(phrase);
  if (
    !normalisePhrase(context.input).includes(needle) &&
    context.forbiddenReceipts.some((receipt) => normalisePhrase(receipt).includes(needle))
  )
    return "receipt";
  return undefined;
}

/** The advice every refused phrase carries. */
export const NOT_CONTAINS_ADVICE =
  'an honest reply can contain it (under a negation, a condition, a future plan or a quotation): prove the behaviour with notCalled, calls or approvalsRequested; or rewrite it as a first-person claim ("i\'ve …"), a presentation ("here is …"), a decider ("<name> declined") or a token only a forbidden tool\'s receipt carries; or write { "phrase": …, "reason": … } saying why no call can show it';
