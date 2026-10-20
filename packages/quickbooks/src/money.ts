/**
 * Input validation and cent conversions shared by the REST client and the fake, so both reject the
 * same bad input with the same message and both derive a status from the same rule. Amounts cross
 * the boundary as integer cents; QuickBooks reports decimals, so the two conversions here are the
 * only places a float exists.
 */

import type { CurrencyCode, InvoiceLine, InvoiceLineDraft, InvoiceStatus, Money } from "./types.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

/** A nonempty, trimmed string of at most `max` characters. */
export function bounded(value: string, label: string, max: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new Error(`${label} must be between 1 and ${max} characters (got ${trimmed.length}).`);
  }
  return trimmed;
}

/** A QuickBooks entity id. */
export function validId(value: string, label: string): string {
  return bounded(value, label, 200);
}

/** A write's idempotency key. QuickBooks allows at most 50 characters. */
export function validRequestId(value: string, label: string): string {
  return bounded(value, label, 50);
}

/** A calendar date in `YYYY-MM-DD` form. */
export function validDate(value: string, label: string): string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    throw new Error(`${label} must be a date in YYYY-MM-DD form (got ${JSON.stringify(value)}).`);
  }
  return value;
}

/** A three-letter ISO 4217 currency code. */
export function validCurrency(value: string, label: string): CurrencyCode {
  if (typeof value !== "string" || !CURRENCY.test(value)) {
    throw new Error(
      `${label} must be a three-letter ISO 4217 currency code (got ${JSON.stringify(value)}).`,
    );
  }
  return value;
}

/** A whole, non-negative number of cents. */
export function validCents(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} must be a whole number of cents, never a float (got ${JSON.stringify(value)}).`,
    );
  }
  return value;
}

/** An amount in integer cents plus a currency. */
export function validMoney(value: Money, label: string): Money {
  if (value === null || typeof value !== "object") {
    throw new Error(`${label} must be an amount of integer cents plus a currency.`);
  }
  return {
    cents: validCents(value.cents, `${label} cents`),
    currency: validCurrency(value.currency, `${label} currency`),
  };
}

/** A positive unit count, which QuickBooks permits to be fractional. */
export function validQuantity(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number (got ${JSON.stringify(value)}).`);
  }
  return value;
}

/** QuickBooks reports amounts as decimals: round half away from zero into integer cents. */
export function centsFromAmount(amount: unknown, label: string): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new Error(`QuickBooks returned a non-numeric ${label}.`);
  }
  return Math.round(amount * 100);
}

/** The decimal QuickBooks expects in a request body, from integer cents. */
export function amountFromCents(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

export function money(cents: number, currency: CurrencyCode): Money {
  return { cents, currency };
}

/** Today in UTC as `YYYY-MM-DD`; statuses are derived against this. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The status QuickBooks implies rather than stores: a zero balance is paid, a positive balance past
 * its due date is overdue, and anything else is open.
 */
export function statusOf(balance: number, dueOn: string, on: string = today()): InvoiceStatus {
  if (balance <= 0) return "paid";
  return dueOn < on ? "overdue" : "open";
}

/**
 * Validates a draft's lines and computes each amount in integer cents, the way QuickBooks will, so
 * the REST client and the fake agree on every total. Every line must share one currency.
 */
export function invoiceLines(lines: readonly InvoiceLineDraft[]): InvoiceLine[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("An invoice needs at least one line.");
  }
  const mapped = lines.map((line, index): InvoiceLine => {
    const label = `Invoice line ${index + 1}`;
    const description = bounded(line.description, `${label} description`, 1000);
    const quantity = validQuantity(line.quantity, `${label} quantity`);
    const unitPrice = validMoney(line.unitPrice, `${label} unit price`);
    const amount = money(
      validCents(Math.round(quantity * unitPrice.cents), `${label} amount`),
      unitPrice.currency,
    );
    return {
      description,
      quantity,
      unitPrice,
      amount,
      ...(line.itemId === undefined ? {} : { itemId: validId(line.itemId, `${label} item ID`) }),
    };
  });
  const currency = validCurrency(mapped[0]?.unitPrice.currency ?? "", "Invoice currency");
  for (const line of mapped) {
    if (line.unitPrice.currency !== currency) {
      throw new Error(
        `Every invoice line must use one currency; found ${currency} and ${line.unitPrice.currency}.`,
      );
    }
  }
  return mapped;
}
