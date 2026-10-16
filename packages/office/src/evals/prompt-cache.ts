/**
 * The prompt-cache check for the eval runner.
 *
 * A prompt cache only pays off when the leading system message and its stable sections are
 * byte-identical from request to request, and the system message leads the model context: Pi Durable
 * 1.1.0 put the system message first, and 1.3.0 keeps any post-compaction baseline first too. This
 * reads the requests a scripted provider recorded and returns one line per broken invariant, so a
 * role's eval run can prove its prompt is cacheable.
 *
 * It checks that the sections a role already renders stay stable. It does not decide which sections
 * are relevant, which is RASF-3234's job; a role that adds or removes a section mid-run is out of
 * scope here — this is the cache baseline, not the relevance filter.
 */

/**
 * The part of a recorded model request the check reads; the scripted provider's `ScriptedRequest`
 * satisfies it, and so does any hand-built request in a test.
 */
export interface PromptCacheRequest {
  readonly messages: readonly { readonly role: string }[];
  /** The replayed system prompt, byte-for-byte as the model received it. */
  readonly system: string;
  /** The named prompt sections currently in effect. */
  readonly sections: Readonly<Record<string, string>>;
}

/** How many requests the check needs before it can compare anything. */
export const PROMPT_CACHE_REQUESTS = 3;

/** A section map as a stable string: key order is normalised, so only real changes differ. */
function sectionSignature(sections: Readonly<Record<string, string>>): string {
  const entries = Object.entries(sections).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

/**
 * Runs the check across the recorded requests. Returns one line per failed invariant; an empty array
 * is a pass. The first request is the baseline every later request is compared against.
 */
export function promptCacheFailures(requests: readonly PromptCacheRequest[]): string[] {
  const first = requests[0];
  if (first === undefined) return ["prompt cache: no requests were recorded"];

  const failures: string[] = [];
  if (requests.length < PROMPT_CACHE_REQUESTS) {
    failures.push(
      `prompt cache: needs ${PROMPT_CACHE_REQUESTS} requests to compare; got ${requests.length}`,
    );
  }

  requests.forEach((request, index) => {
    const at = `prompt cache: request ${index + 1}`;
    const lead = request.messages[0]?.role;
    if (lead !== "system") {
      failures.push(
        `${at}: the system message does not lead the context (the first message is ${JSON.stringify(lead ?? null)}); Pi Durable 1.1.0 put it first`,
      );
    }
    if (request.system !== first.system) {
      failures.push(`${at}: the system message is not byte-identical to request 1`);
    }
    if (sectionSignature(request.sections) !== sectionSignature(first.sections)) {
      failures.push(`${at}: the stable sections changed from request 1`);
    }
  });

  return failures;
}
