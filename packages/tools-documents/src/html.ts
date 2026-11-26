/**
 * HTML to plain text, for an email whose body is HTML only. A few lines of our own rather than a
 * library: the goal is readable text for a model, not a faithful rendering, and email HTML needs only
 * its block structure (paragraphs, breaks, list items, table rows) kept.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  euro: "€",
  pound: "£",
  copy: "©",
  reg: "®",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, entity: string) => {
    if (entity.startsWith("#")) {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<li\b[^>]*>/giu, "\n- ")
    .replace(/<\/(td|th)\s*>/giu, " | ")
    .replace(
      /<\/?(p|div|tr|table|ul|ol|h[1-6]|blockquote|section|article|header|footer)\b[^>]*>/giu,
      "\n\n",
    )
    .replace(/<\/li\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, "");
  return decodeEntities(text)
    .replace(/[ \t\f\v\u00a0]+/gu, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/(^|\n)(- [^\n]*)\n\n(?=- )/gu, "$1$2\n")
    .trim();
}
