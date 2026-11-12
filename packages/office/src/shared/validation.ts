/**
 * The string checks every store and adapter in this package applies to a value before it is trusted.
 *
 * They live in one place because a second copy is a second definition of "a clean string": the copies
 * had already drifted in name (`controls`, `hasControl`, `exact`, `exactString`) while meaning the same
 * thing, and a check that differs between the file that writes a row and the file that reads it back
 * is a row one of them refuses.
 */

/**
 * Does the value carry a C0 or C1 control character?
 *
 * `message` allows tab, line feed and carriage return, which a message body legitimately has and an
 * identifier never does.
 */
export function controls(value: string, message = false): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (message && (code === 9 || code === 10 || code === 13)) return false;
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

/** A non-empty string of at most `maximum` characters, already trimmed, with no control characters. */
export function exact(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !controls(value)
  );
}

/** A message body: not blank, at most `maximum` characters, line breaks and tabs allowed. */
export function messageText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim().length > 0 &&
    !controls(value, true)
  );
}

/** The value trimmed, or an error naming `label` when it is empty or longer than `maximum`. */
export function bounded(value: string, label: string, maximum = 500): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum} characters.`);
  }
  return normalized;
}
