/**
 * Amount masking for skill instructions and references. A model copies sample figures it reads in an
 * example; masked, it has to take the real figure from an engine finding. `read_skill` applies it when
 * the manifest's `contextPlan.maskAmounts` is true. The skills index is never masked.
 *
 * Masked: a currency symbol before a number (`$2,500`, `€ 12.50`), a currency code before or after one
 * (`USD 2,500`, `2,500 GBP`), and a number before a currency word (`300 dollars`, `45 cents`). Other
 * numbers (counts, dates, SKUs) are left alone. A fenced code block whose info string includes
 * `no-mask` is left exactly as written.
 */

/** What a masked amount reads as. */
export const MASKED_AMOUNT = "[amount: take it from an engine finding]";

const NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?(?:k|m|bn|thousand|million|billion)\b)?`;
const CODES = "USD|EUR|GBP|CAD|AUD|NZD|CHF|JPY|INR";
const WORDS = "dollars?|euros?|pounds?|cents?|pence|bucks";
const AMOUNT = new RegExp(
  [
    String.raw`[$£€¥]\s?${NUMBER}`,
    String.raw`\b(?:${CODES})\s?${NUMBER}`,
    String.raw`\b${NUMBER}\s?(?:${CODES}|${WORDS})\b`,
  ].join("|"),
  "gi",
);

/** A fenced code block's opening line, e.g. ```` ```text no-mask ````. */
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** Masks the amounts in `text`, leaving `no-mask` fenced blocks untouched. */
export function maskAmounts(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: { readonly marker: string; readonly keep: boolean } | undefined;
  for (const line of lines) {
    const match = FENCE.exec(line);
    if (fence === undefined && match !== null) {
      const marker = match[2] ?? "```";
      const keep = /(^|\s)no-mask(\s|$)/.test(match[3] ?? "");
      fence = { marker, keep };
      out.push(line);
      continue;
    }
    const closes =
      match !== null && (match[2] ?? "").startsWith(fence?.marker ?? "") && match[3]?.trim() === "";
    if (fence !== undefined && closes) {
      fence = undefined;
      out.push(line);
      continue;
    }
    out.push(fence?.keep === true ? line : line.replace(AMOUNT, MASKED_AMOUNT));
  }
  return out.join("\n");
}
