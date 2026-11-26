/**
 * The checks an extraction must pass before anything may treat it as true. They are code, not model
 * judgment: every figure is parsed into integer cents (`bigint`) and compared exactly, and the
 * model's figures are the data being checked, never an input to the arithmetic's answer.
 *
 * A figure that is missing or not a plain decimal fails its check rather than being guessed at, so a
 * result is `checked` only when the document states everything the arithmetic needs.
 */

export interface ExtractionCheck {
  /** Stable: `line-amount`, `lines-subtotal`, `subtotal-tax-total`, `dates`, `currency`, `source-total`, `source-document-number`, `sources`. */
  readonly name: string;
  readonly result: "pass" | "fail";
  readonly message: string;
}

/** The figures the checks read, as the model gave them: strings, or `null` where it found none. */
export interface CheckInput {
  readonly documentNumber: string | null;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly currency: string | null;
  readonly subtotal: string | null;
  readonly total: string | null;
  readonly lineItems: readonly {
    readonly quantity: string | null;
    readonly unitPrice: string | null;
    readonly amount: string | null;
  }[];
  readonly taxLines: readonly { readonly amount: string | null }[];
}

interface Decimal {
  /** The digits as an integer: `12.5` is 125 with scale 1. */
  readonly units: bigint;
  readonly scale: number;
}

/** A plain decimal (`-12.50`, `4`, `0.125`), with at most `maxScale` places; otherwise `undefined`. */
function parseDecimal(text: string, maxScale: number): Decimal | undefined {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(text);
  if (match === null) return undefined;
  const fraction = match[3] ?? "";
  if (fraction.length > maxScale) return undefined;
  const units = BigInt(`${match[2]}${fraction}`);
  return { units: match[1] === "-" ? -units : units, scale: fraction.length };
}

/** An amount as integer cents: a plain decimal with at most two places, otherwise `undefined`. */
export function toCents(text: string): bigint | undefined {
  const decimal = parseDecimal(text, 2);
  return decimal === undefined ? undefined : decimal.units * 10n ** BigInt(2 - decimal.scale);
}

function formatCents(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

/** Rounds `units / 10^scale` to whole units, half away from zero. */
function roundHalfAway(units: bigint, scale: number): bigint {
  if (scale <= 0) return units * 10n ** BigInt(-scale);
  const divisor = 10n ** BigInt(scale);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const rounded = (absolute + divisor / 2n) / divisor;
  return negative ? -rounded : rounded;
}

/** Quantity and unit price may carry four places (0.0125 a sheet); the product is rounded to the cent. */
const QUANTITY_PLACES = 4;
const PRICE_PLACES = 4;

function pass(name: string, message: string): ExtractionCheck {
  return { name, result: "pass", message };
}

function fail(name: string, message: string): ExtractionCheck {
  return { name, result: "fail", message };
}

function lineAmountChecks(input: CheckInput): ExtractionCheck[] {
  const checks: ExtractionCheck[] = [];
  input.lineItems.forEach((line, index) => {
    const which = `line ${index + 1}`;
    if (line.quantity === null && line.unitPrice === null) return;
    if (line.quantity === null || line.unitPrice === null) {
      checks.push(
        fail(
          "line-amount",
          `${which} gives a ${line.quantity === null ? "unit price" : "quantity"} but no ${line.quantity === null ? "quantity" : "unit price"}, so its amount cannot be checked`,
        ),
      );
      return;
    }
    const quantity = parseDecimal(line.quantity, QUANTITY_PLACES);
    const price = parseDecimal(line.unitPrice, PRICE_PLACES);
    const amount = line.amount === null ? undefined : toCents(line.amount);
    if (quantity === undefined || price === undefined || amount === undefined) {
      checks.push(
        fail(
          "line-amount",
          `${which}: quantity "${line.quantity}", unit price "${line.unitPrice}" and amount "${line.amount ?? "none"}" must all be plain decimals`,
        ),
      );
      return;
    }
    // The product's scale is the sum of the two; bring it to cents (scale 2), rounding half away.
    const expected = roundHalfAway(quantity.units * price.units, quantity.scale + price.scale - 2);
    checks.push(
      expected === amount
        ? pass("line-amount", `${which}: ${line.quantity} × ${line.unitPrice} = ${line.amount}`)
        : fail(
            "line-amount",
            `${which}: ${line.quantity} × ${line.unitPrice} is ${formatCents(expected)}, but the amount given is ${line.amount}`,
          ),
    );
  });
  return checks;
}

/** The sum of `amounts` in cents, or a message naming the first that is missing or not a decimal. */
function sumCents(
  amounts: readonly (string | null)[],
  what: string,
): { cents: bigint } | { problem: string } {
  let cents = 0n;
  for (const [index, amount] of amounts.entries()) {
    const value = amount === null ? undefined : toCents(amount);
    if (value === undefined) {
      return {
        problem: `${what} ${index + 1} has ${amount === null ? "no amount" : `the amount "${amount}", which is not a plain decimal`}`,
      };
    }
    cents += value;
  }
  return { cents };
}

function figure(name: string, text: string | null): { cents: bigint } | { problem: string } {
  if (text === null) return { problem: `no ${name} is stated` };
  const cents = toCents(text);
  return cents === undefined
    ? { problem: `the ${name} "${text}" is not a plain decimal` }
    : { cents };
}

function linesSubtotalCheck(input: CheckInput): ExtractionCheck {
  const name = "lines-subtotal";
  if (input.lineItems.length === 0) return fail(name, "no line items were found to add up");
  const lines = sumCents(
    input.lineItems.map((line) => line.amount),
    "line",
  );
  if ("problem" in lines) return fail(name, lines.problem);
  const subtotal = figure("subtotal", input.subtotal);
  if ("problem" in subtotal) return fail(name, subtotal.problem);
  return lines.cents === subtotal.cents
    ? pass(name, `the lines add up to the subtotal, ${formatCents(subtotal.cents)}`)
    : fail(
        name,
        `the lines add up to ${formatCents(lines.cents)}, but the subtotal given is ${formatCents(subtotal.cents)}`,
      );
}

function totalCheck(input: CheckInput): ExtractionCheck {
  const name = "subtotal-tax-total";
  const subtotal = figure("subtotal", input.subtotal);
  if ("problem" in subtotal) return fail(name, subtotal.problem);
  const tax = sumCents(
    input.taxLines.map((line) => line.amount),
    "tax line",
  );
  if ("problem" in tax) return fail(name, tax.problem);
  const total = figure("total", input.total);
  if ("problem" in total) return fail(name, total.problem);
  const expected = subtotal.cents + tax.cents;
  return expected === total.cents
    ? pass(
        name,
        `subtotal ${formatCents(subtotal.cents)} plus tax ${formatCents(tax.cents)} is the total, ${formatCents(total.cents)}`,
      )
    : fail(
        name,
        `subtotal ${formatCents(subtotal.cents)} plus tax ${formatCents(tax.cents)} is ${formatCents(expected)}, but the total given is ${formatCents(total.cents)}`,
      );
}

/** A real calendar date written `YYYY-MM-DD`, as days since the epoch; otherwise `undefined`. */
function parseDate(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (match === null) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? time / 86_400_000
    : undefined;
}

function datesCheck(input: CheckInput): ExtractionCheck {
  const name = "dates";
  if (input.issueDate === null) return fail(name, "no issue date is stated");
  const issued = parseDate(input.issueDate);
  if (issued === undefined) {
    return fail(name, `the issue date "${input.issueDate}" is not a real date written YYYY-MM-DD`);
  }
  if (input.dueDate === null) return pass(name, `issued ${input.issueDate}; no due date is stated`);
  const due = parseDate(input.dueDate);
  if (due === undefined) {
    return fail(name, `the due date "${input.dueDate}" is not a real date written YYYY-MM-DD`);
  }
  return due >= issued
    ? pass(name, `issued ${input.issueDate}, due ${input.dueDate}`)
    : fail(name, `the due date ${input.dueDate} is before the issue date ${input.issueDate}`);
}

let currencies: ReadonlySet<string> | undefined;

function currencyCheck(input: CheckInput): ExtractionCheck {
  const name = "currency";
  if (input.currency === null) return fail(name, "no currency is stated");
  // ICU's list of ISO 4217 codes, as Node ships it.
  currencies ??= new Set(Intl.supportedValuesOf("currency"));
  return /^[A-Z]{3}$/u.test(input.currency) && currencies.has(input.currency)
    ? pass(name, `${input.currency} is an ISO 4217 code`)
    : fail(name, `"${input.currency}" is not an ISO 4217 currency code`);
}

/**
 * Whether any number in `lines` is `cents`, read either way a document writes decimals: `1,800.00`
 * and `1.800,00` are both 1800.00. Numbers a space separates are never joined.
 */
export function textHasAmount(lines: readonly string[], cents: bigint): boolean {
  for (const line of lines) {
    for (const token of line.match(/\d(?:[\d.,]*\d)?/gu) ?? []) {
      const dotDecimal = toCents(token.replaceAll(",", ""));
      const commaDecimal = toCents(token.replaceAll(".", "").replace(",", "."));
      if (dotDecimal === cents || commaDecimal === cents) return true;
    }
  }
  return false;
}

/** Letters and digits only, upper case: OCR and models disagree about spaces, dashes and case. */
function squeeze(text: string): string {
  return text.toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function sourceTotalCheck(input: CheckInput, source: readonly string[]): ExtractionCheck {
  const name = "source-total";
  const total = figure("total", input.total);
  if ("problem" in total) return fail(name, total.problem);
  return textHasAmount(source, total.cents)
    ? pass(name, `the document's text shows the total ${formatCents(total.cents)}`)
    : fail(name, `the total ${formatCents(total.cents)} does not appear in the document's text`);
}

function sourceNumberCheck(input: CheckInput, source: readonly string[]): ExtractionCheck {
  const name = "source-document-number";
  if (input.documentNumber === null) return fail(name, "no document number is stated");
  const wanted = squeeze(input.documentNumber);
  if (wanted === "") {
    return fail(name, `the document number "${input.documentNumber}" has no letters or digits`);
  }
  return squeeze(source.join("\n")).includes(wanted)
    ? pass(name, `the document's text shows the number ${input.documentNumber}`)
    : fail(
        name,
        `the document number ${input.documentNumber} does not appear in the document's text`,
      );
}

/**
 * Every check, in a fixed order: each line's amount, the lines against the subtotal, subtotal plus
 * tax against the total, the dates, the currency, then the total and the document number against
 * `source`, the document's own text (OCR or its text layer), which the model did not write.
 */
export function checkExtraction(input: CheckInput, source: readonly string[]): ExtractionCheck[] {
  return [
    ...lineAmountChecks(input),
    linesSubtotalCheck(input),
    totalCheck(input),
    datesCheck(input),
    currencyCheck(input),
    sourceTotalCheck(input, source),
    sourceNumberCheck(input, source),
  ];
}
