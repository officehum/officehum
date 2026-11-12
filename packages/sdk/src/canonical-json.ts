/**
 * Canonical JSON: the one text for a JSON value, whatever order its object keys were written in.
 *
 * Stored requests, approvals and receipts are compared and hashed as text, so two encoders must agree
 * on that text exactly. Keys are ordered by UTF-16 code unit, never `localeCompare`: collation
 * depends on the host's locale and ICU data, and the process that checks a stored text may not be the
 * machine that wrote it. Arrays keep their order; their order is part of the value.
 */
export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, nested]) => [key, sort(nested)]),
      );
    }
    return item;
  };
  const json = JSON.stringify(sort(value));
  if (json === undefined) throw new TypeError("Only a JSON value has a canonical form.");
  return json;
}

/**
 * Whether a stored canonical text says the same as a freshly made one.
 *
 * Versions before 2026-11-12 ordered keys by `localeCompare`, so a text one of them stored can hold
 * the same value with its keys in another order. Such a text is read back and put in today's order
 * before it is compared, which keeps work that was in flight across the upgrade recognisable.
 * Anything that is not JSON is simply not the same.
 */
export function sameCanonical(stored: string, canonical: string): boolean {
  if (stored === canonical) return true;
  try {
    return canonicalJson(JSON.parse(stored)) === canonical;
  } catch {
    return false;
  }
}
