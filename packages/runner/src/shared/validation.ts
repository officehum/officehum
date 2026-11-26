/**
 * The length check the calendar store applies to a value before it is trusted. The office's stores
 * apply the same one (it re-exports this), so a row one writes the other never refuses.
 */

/** The value trimmed, or an error naming `label` when it is empty or longer than `maximum`. */
export function bounded(value: string, label: string, maximum = 500): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum} characters.`);
  }
  return normalized;
}
