/**
 * A sender's instruction, recognised on Twilio's own keyword list.
 *
 * This is not a preference the office is free to trim. STOP is a legal demand to stop texting a person,
 * and Twilio filters those keywords itself before a webhook is even sent, so the list this build carries
 * has to be Twilio's — a subset would miss an instruction a carrier already acted on and leave the
 * office's own record disagreeing with the network's.
 *
 * The match is on the whole trimmed message. "Stop by tomorrow" is a sentence somebody typed, not an
 * opt-out, and treating any message containing the word as a legal instruction would quietly cut off
 * conversations.
 */

export type OptOutState = "stop" | "start";

/** Twilio's opt-out keywords, in the spelling its documentation uses. */
export const STOP_KEYWORDS: readonly string[] = [
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
];

/** Twilio's opt-in keywords: the way back after a STOP. */
export const START_KEYWORDS: readonly string[] = ["START", "UNSTOP", "YES"];

const STOP = new Set(STOP_KEYWORDS);
const START = new Set(START_KEYWORDS);

/**
 * What this message is instructing, or `undefined` for ordinary text.
 *
 * Case and surrounding whitespace are ignored because people type "stop" and handsets add newlines;
 * nothing else is. A trailing period, an emoji or a second word makes it a message.
 */
export function optOutCommand(body: string): OptOutState | undefined {
  const keyword = body.trim().toUpperCase();
  if (STOP.has(keyword)) return "stop";
  if (START.has(keyword)) return "start";
  return undefined;
}
