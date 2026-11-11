/**
 * A request id for `submit`, built from what the work is, so a retry of the same work (after a crash,
 * on another machine) names the same request and the gateway runs it once:
 * `org:role:YYYY-MM-DD:<first 16 hex digits of the SHA-256 of content>`.
 *
 * `date` is a `Date` (its UTC day) or a `YYYY-MM-DD` string. `org` and `role` must not contain `:`.
 */
export async function makeRequestId(
  org: string,
  role: string,
  date: Date | string,
  content: string,
): Promise<string> {
  const problems: string[] = [];
  for (const [name, value] of [
    ["org", org],
    ["role", role],
  ] as const) {
    if (value === "" || value.includes(":")) {
      problems.push(`${name} must be non-empty and contain no ":" (got ${JSON.stringify(value)})`);
    }
  }
  const day = typeof date === "string" ? date : date.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    problems.push(`date must be a Date or a YYYY-MM-DD string (got ${JSON.stringify(date)})`);
  }
  if (problems.length > 0) throw new TypeError(`makeRequestId: ${problems.join("; ")}`);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const hex = [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const id = `${org}:${role}:${day}:${hex}`;
  // The protocol caps identifiers at 256 characters.
  if (id.length > 256) {
    throw new TypeError(`makeRequestId: the id would be ${id.length} characters; the limit is 256`);
  }
  return id;
}
