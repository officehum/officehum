import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The signature Twilio documents: HMAC-SHA1, keyed with the account's auth token, over the full URL
 * followed by every POST parameter's name and value appended in ascending key order, base64-encoded.
 *
 * Exported because a test has to be able to produce the signature a real webhook would carry. A test
 * that reimplemented the scheme would agree with itself; a test that calls this shares the one copy of
 * the scheme, and the fixture bodies around it are what make the check meaningful.
 *
 * The sort is by parameter name in code-unit order, which is what Twilio's helper libraries do. The
 * order the body arrived in is therefore irrelevant: a proxy that rewrites field order cannot break a
 * signature that a deliberate reorder in the body also cannot break.
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((text, key) => text + key + (params[key] ?? ""), url);
  return createHmac("sha1", authToken).update(payload, "utf8").digest("base64");
}

/**
 * Does this header sign this URL and these parameters?
 *
 * Compared with `timingSafeEqual`, and the reason is worth stating because the alternative looks
 * harmless. A `===` on the base64 strings returns at the first byte that differs, so the time it takes
 * tells the caller how long a prefix they got right. An attacker who can post to the endpoint and
 * measure it can walk the digest one byte at a time — roughly 28 positions times 256 candidates per
 * position — and end up holding a signature that verifies for a body of their choosing, without ever
 * learning the auth token. Constant time turns that back into a 2^160 search. The length check before
 * the comparison is unavoidable (`timingSafeEqual` throws on a mismatch) and leaks nothing: the length
 * of a base64 SHA-1 is a public, fixed property of the algorithm.
 *
 * A missing or empty header is a false, not an error: a scanner hitting the route should get the same
 * refusal as a forgery, and the route should not have to special-case it.
 */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
  header: string | undefined,
): boolean {
  if (header === undefined || header === "") return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params), "utf8");
  const presented = Buffer.from(header, "utf8");
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}
