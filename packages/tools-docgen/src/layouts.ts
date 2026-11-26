/**
 * The built-in templates as Word and Excel: each one's data laid out as the typed blocks of the Paper
 * worker's `create_document` and the sheets of its `create_workbook`, plus the checks every format
 * shares (a quote's subtotal is the sum of its lines, a statement's totals the sums of its charges
 * and payments).
 *
 * Nothing here invents a figure. Word shows each number from the data formatted exactly as the PDF
 * prints it (`formatMoney` is `money()` in `_officehum.typ`); Excel holds the numbers themselves with
 * a number format, and lays a total out as a formula over exactly the rows holding the figures it
 * adds. Data has already matched the template's schema when a layout sees it.
 */

import type {
  WordCreateBlock,
  XlsxSheetSpec,
  XlsxStyleTarget,
} from "@officehum/tools-paper-office";
import type { ResolvedBranding } from "./branding.js";
import type { DataProblem } from "./errors.js";
import type { BuiltinTemplateName } from "./templates.js";

export interface Layout {
  /** The Word draft's blocks. */
  word(data: unknown, brand: ResolvedBranding): WordCreateBlock[];
  /** The Excel draft's sheets; empty for a template with no spreadsheet form. */
  excel(data: unknown, brand: ResolvedBranding): XlsxSheetSpec[];
  /** Problems no schema can state: figures that must agree with each other. */
  checks(data: unknown): DataProblem[];
  /** How many formulas the Excel draft holds, so the reopened workbook can be checked against it. */
  formulas(data: unknown): number;
}

// -- figures --------------------------------------------------------------------------------------

/** Whole cents, rounding half away from zero as Typst's `calc.round` does. */
function cents(value: number): number {
  const rounded = Math.round(Math.abs(value) * 100);
  return rounded === 0 ? 0 : Math.sign(value) * rounded;
}

/** A figure with two decimals and thousands separators: 1234.5 is `1,234.50`. */
export function formatMoney(value: number): string {
  const whole = cents(value);
  const sign = whole < 0 ? "-" : "";
  const absolute = Math.abs(whole);
  const units = Math.floor(absolute / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `${sign}${units}.${String(absolute % 100).padStart(2, "0")}`;
}

/** Text for a spreadsheet cell. A draft treats text beginning with `=` as a formula; data never is. */
export function textCell(value: string): string {
  return value.startsWith("=") ? `'${value}` : value;
}

function sumCents(values: readonly number[]): number {
  return values.reduce((total, value) => total + cents(value), 0);
}

function disagree(path: string, given: number, expected: number, what: string): DataProblem[] {
  return cents(given) === expected
    ? []
    : [{ path, message: `is ${formatMoney(given)}, but ${what} ${formatMoney(expected / 100)}` }];
}

// -- Word helpers ---------------------------------------------------------------------------------

const paragraph = (text: string): WordCreateBlock => ({ kind: "paragraph", text });
const heading = (text: string, level: number): WordCreateBlock => ({
  kind: "heading",
  text,
  level,
});

/** Paragraphs for the non-empty strings among `texts`. */
function paragraphs(...texts: readonly (string | undefined)[]): WordCreateBlock[] {
  return texts
    .filter((text): text is string => text !== undefined && text.trim() !== "")
    .map(paragraph);
}

/** A table, split into several when it has more rows than one draft table holds, header on each. */
function tables(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): WordCreateBlock[] {
  const blocks: WordCreateBlock[] = [];
  for (let start = 0; start < Math.max(rows.length, 1); start += 63) {
    blocks.push({ kind: "table", rows: [header, ...rows.slice(start, start + 63)] });
  }
  return blocks;
}

function letterhead(brand: ResolvedBranding): WordCreateBlock[] {
  return paragraphs(brand.companyName, ...brand.address);
}

// -- Excel helpers --------------------------------------------------------------------------------

type Cell = string | number | null;

/** Rows padded to one width, as a draft sheet needs. */
function padded(rows: readonly (readonly Cell[])[]): Cell[][] {
  const width = Math.max(1, ...rows.map((row) => row.length));
  return rows.map((row) => [...row, ...Array<Cell>(width - row.length).fill(null)]);
}

const MONEY_FORMAT = "#,##0.00";

function headerStyle(range: string, brand: ResolvedBranding): XlsxStyleTarget {
  return { range, style: { bold: true, color: "FFFFFF", fillColor: brand.primaryColor } };
}

function titleStyle(brand: ResolvedBranding): XlsxStyleTarget {
  return { range: "A1", style: { bold: true, size: 14, color: brand.primaryColor } };
}

// -- the templates --------------------------------------------------------------------------------

interface Letter {
  date: string;
  recipient: { name: string; address?: string[] };
  subject?: string;
  salutation: string;
  body: string[];
  closing: string;
  signature: { name: string; title?: string };
}

const letter: Layout = {
  word(value, brand) {
    const data = value as Letter;
    return [
      ...letterhead(brand),
      ...paragraphs(data.date, data.recipient.name, ...(data.recipient.address ?? [])),
      ...(data.subject === undefined ? [] : [heading(data.subject, 2)]),
      ...paragraphs(
        data.salutation,
        ...data.body,
        data.closing,
        data.signature.name,
        data.signature.title,
      ),
    ];
  },
  excel: () => [],
  checks: () => [],
  formulas: () => 0,
};

interface Memo {
  to: string;
  from: string;
  cc?: string;
  date: string;
  subject: string;
  body: string[];
}

const memo: Layout = {
  word(value, brand) {
    const data = value as Memo;
    const rows = [
      ["To", data.to],
      ["From", data.from],
      ...(data.cc === undefined ? [] : [["Cc", data.cc]]),
      ["Date", data.date],
      ["Subject", data.subject],
    ];
    return [
      ...letterhead(brand),
      heading("Memo", 0),
      { kind: "table", rows },
      ...paragraphs(...data.body),
    ];
  },
  excel: () => [],
  checks: () => [],
  formulas: () => 0,
};

interface Report {
  title: string;
  subtitle?: string;
  author?: string;
  date?: string;
  summary?: string;
  sections: {
    heading: string;
    paragraphs?: string[];
    table?: { columns: string[]; rows: string[][] };
  }[];
}

const byline = (data: Report) =>
  [data.author, data.date].filter((part) => part !== undefined).join(" · ");

const report: Layout = {
  word(value, brand) {
    const data = value as Report;
    return [
      ...letterhead(brand),
      heading(data.title, 0),
      ...paragraphs(data.subtitle, byline(data), data.summary),
      ...data.sections.flatMap((section) => [
        heading(section.heading, 1),
        ...paragraphs(...(section.paragraphs ?? [])),
        ...(section.table === undefined ? [] : tables(section.table.columns, section.table.rows)),
      ]),
    ];
  },
  excel(value, brand) {
    const data = value as Report;
    const rows: Cell[][] = [[textCell(data.title)]];
    const styles: XlsxStyleTarget[] = [titleStyle(brand)];
    for (const line of [data.subtitle, byline(data), data.summary]) {
      if (line !== undefined && line !== "") rows.push([textCell(line)]);
    }
    for (const section of data.sections) {
      rows.push([]);
      rows.push([textCell(section.heading)]);
      styles.push({ range: `A${rows.length}`, style: { bold: true, color: brand.primaryColor } });
      for (const text of section.paragraphs ?? []) rows.push([textCell(text)]);
      if (section.table !== undefined) {
        rows.push(section.table.columns.map(textCell));
        const columns = section.table.columns.length;
        styles.push(headerStyle(`A${rows.length}:${column(columns)}${rows.length}`, brand));
        for (const row of section.table.rows) rows.push(row.map(textCell));
      }
    }
    return [
      {
        name: "Report",
        rows: padded(rows),
        styles: styles.slice(0, 64),
        columnWidths: [{ columns: ["A"], width: 48 }],
      },
    ];
  },
  checks(value) {
    const data = value as Report;
    return data.sections.flatMap((section, index) => {
      const table = section.table;
      if (table === undefined) return [];
      return table.rows.flatMap((row, rowIndex) =>
        row.length === table.columns.length
          ? []
          : [
              {
                path: `data.sections[${index}].table.rows[${rowIndex}]`,
                message: `has ${row.length} cells; the table has ${table.columns.length} columns`,
              },
            ],
      );
    });
  },
  formulas: () => 0,
};

interface Quote {
  number: string;
  date: string;
  validUntil: string;
  customer: { name: string; address?: string[] };
  currency: string;
  lines: { description: string; quantity: number; unitPrice: number; amount: number }[];
  subtotal: number;
  tax?: { label: string; amount: number };
  total: number;
  terms?: string[];
  notes?: string;
}

const quote: Layout = {
  word(value, brand) {
    const data = value as Quote;
    const totals = [
      ["Subtotal", formatMoney(data.subtotal)],
      ...(data.tax === undefined ? [] : [[data.tax.label, formatMoney(data.tax.amount)]]),
      [`Total (${data.currency})`, formatMoney(data.total)],
    ];
    return [
      ...letterhead(brand),
      heading("Quote", 0),
      ...paragraphs(`No. ${data.number}`, `Date: ${data.date}`, `Valid until: ${data.validUntil}`),
      heading("Quote for", 2),
      ...paragraphs(data.customer.name, ...(data.customer.address ?? [])),
      ...tables(
        ["Description", "Quantity", "Unit price", `Amount (${data.currency})`],
        data.lines.map((line) => [
          line.description,
          String(line.quantity),
          formatMoney(line.unitPrice),
          formatMoney(line.amount),
        ]),
      ),
      { kind: "table", rows: totals },
      ...(data.terms === undefined || data.terms.length === 0
        ? []
        : [
            heading("Terms", 2),
            { kind: "list" as const, items: data.terms, listKind: "bullet" as const },
          ]),
      ...paragraphs(data.notes),
    ];
  },
  excel(value, brand) {
    const data = value as Quote;
    const rows: Cell[][] = [
      [textCell(brand.companyName || "Quote")],
      ["Quote", textCell(data.number)],
      ["Date", textCell(data.date)],
      ["Valid until", textCell(data.validUntil)],
      ["Customer", textCell(data.customer.name)],
      [],
      ["Description", "Quantity", "Unit price", `Amount (${textCell(data.currency)})`],
    ];
    const header = rows.length;
    for (const line of data.lines) {
      rows.push([textCell(line.description), line.quantity, line.unitPrice, line.amount]);
    }
    const last = rows.length;
    rows.push([null, null, "Subtotal", `=SUM(D${header + 1}:D${last})`]);
    const subtotal = rows.length;
    let total = `=D${subtotal}`;
    if (data.tax !== undefined) {
      rows.push([null, null, textCell(data.tax.label), data.tax.amount]);
      total = `=D${subtotal}+D${rows.length}`;
    }
    rows.push([null, null, `Total (${textCell(data.currency)})`, total]);
    const end = rows.length;
    return [
      {
        name: "Quote",
        rows: padded(rows),
        styles: [
          titleStyle(brand),
          headerStyle(`A${header}:D${header}`, brand),
          { range: `C${header + 1}:D${end}`, style: { numberFormat: MONEY_FORMAT } },
          { range: `C${end}:D${end}`, style: { bold: true } },
        ],
        columnWidths: [
          { columns: ["A"], width: 44 },
          { columns: ["B"], width: 10 },
          { columns: ["C", "D"], width: 16 },
        ],
        freeze: `A${header + 1}`,
      },
    ];
  },
  checks(value) {
    const data = value as Quote;
    const subtotal = sumCents(data.lines.map((line) => line.amount));
    return [
      ...disagree("data.subtotal", data.subtotal, subtotal, "the line amounts add up to"),
      ...disagree(
        "data.total",
        data.total,
        cents(data.subtotal) + cents(data.tax?.amount ?? 0),
        "the subtotal plus tax is",
      ),
    ];
  },
  formulas: () => 2,
};

interface Statement {
  customer: { name: string; account?: string; address?: string[] };
  statementDate: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  openingBalance: number;
  lines: {
    date: string;
    reference: string;
    description: string;
    charges: number;
    payments: number;
    balance: number;
  }[];
  totals: { charges: number; payments: number };
  closingBalance: number;
  amountDue: number;
  dueDate?: string;
  message?: string;
}

const statement: Layout = {
  word(value, brand) {
    const data = value as Statement;
    const money = formatMoney;
    return [
      ...letterhead(brand),
      heading("Statement", 0),
      ...paragraphs(
        data.customer.name,
        ...(data.customer.address ?? []),
        data.customer.account === undefined ? undefined : `Account: ${data.customer.account}`,
        `Date: ${data.statementDate}`,
        `Period: ${data.periodStart} to ${data.periodEnd}`,
      ),
      ...tables(
        ["Date", "Reference", "Description", "Charges", "Payments", "Balance"],
        [
          ["", "", "Opening balance", "", "", money(data.openingBalance)],
          ...data.lines.map((line) => [
            line.date,
            line.reference,
            line.description,
            money(line.charges),
            money(line.payments),
            money(line.balance),
          ]),
          [
            "",
            "",
            "Totals",
            money(data.totals.charges),
            money(data.totals.payments),
            money(data.closingBalance),
          ],
        ],
      ),
      ...paragraphs(
        `Amount due (${data.currency}): ${money(data.amountDue)}`,
        data.dueDate === undefined ? undefined : `Due by ${data.dueDate}`,
        data.message,
      ),
    ];
  },
  excel(value, brand) {
    const data = value as Statement;
    const rows: Cell[][] = [
      [textCell(brand.companyName || "Statement")],
      ["Customer", textCell(data.customer.name)],
      ...(data.customer.account === undefined
        ? []
        : [["Account", textCell(data.customer.account)]]),
      ["Statement date", textCell(data.statementDate)],
      ["Period", textCell(`${data.periodStart} to ${data.periodEnd}`)],
      [],
      ["Date", "Reference", "Description", "Charges", "Payments", "Balance"],
    ];
    const header = rows.length;
    rows.push([null, null, "Opening balance", null, null, data.openingBalance]);
    const first = rows.length + 1;
    for (const line of data.lines) {
      rows.push([
        textCell(line.date),
        textCell(line.reference),
        textCell(line.description),
        line.charges,
        line.payments,
        line.balance,
      ]);
    }
    const last = rows.length;
    rows.push([
      null,
      null,
      "Totals",
      `=SUM(D${first}:D${last})`,
      `=SUM(E${first}:E${last})`,
      data.closingBalance,
    ]);
    const totals = rows.length;
    rows.push([]);
    rows.push([`Amount due (${textCell(data.currency)})`, data.amountDue]);
    const due = rows.length;
    if (data.dueDate !== undefined) rows.push(["Due by", textCell(data.dueDate)]);
    return [
      {
        name: "Statement",
        rows: padded(rows),
        styles: [
          titleStyle(brand),
          headerStyle(`A${header}:F${header}`, brand),
          { range: `D${header + 1}:F${totals}`, style: { numberFormat: MONEY_FORMAT } },
          { range: `A${totals}:F${totals}`, style: { bold: true } },
          { range: `A${due}:B${due}`, style: { bold: true } },
          { range: `B${due}`, style: { numberFormat: MONEY_FORMAT } },
        ],
        columnWidths: [
          { columns: ["A", "B"], width: 16 },
          { columns: ["C"], width: 36 },
          { columns: ["D", "E", "F"], width: 14 },
        ],
        freeze: `A${header + 1}`,
      },
    ];
  },
  checks(value) {
    const data = value as Statement;
    const charges = sumCents(data.lines.map((line) => line.charges));
    const payments = sumCents(data.lines.map((line) => line.payments));
    return [
      ...disagree(
        "data.totals.charges",
        data.totals.charges,
        charges,
        "the lines' charges add up to",
      ),
      ...disagree(
        "data.totals.payments",
        data.totals.payments,
        payments,
        "the lines' payments add up to",
      ),
      ...disagree(
        "data.closingBalance",
        data.closingBalance,
        cents(data.openingBalance) + charges - payments,
        "the opening balance plus charges less payments is",
      ),
    ];
  },
  formulas: () => 2,
};

interface MeetingNotes {
  title: string;
  date: string;
  attendees: string[];
  absent?: string[];
  agenda?: string[];
  notes: { topic: string; points: string[] }[];
  decisions?: string[];
  actions?: { owner: string; task: string; due?: string }[];
}

const meetingNotes: Layout = {
  word(value, brand) {
    const data = value as MeetingNotes;
    const list = (items: readonly string[], listKind: "bullet" | "decimal" = "bullet") =>
      ({ kind: "list", items, listKind }) as const;
    const absent = data.absent ?? [];
    const agenda = data.agenda ?? [];
    const decisions = data.decisions ?? [];
    const actions = data.actions ?? [];
    return [
      ...letterhead(brand),
      heading(data.title, 0),
      ...paragraphs(
        data.date,
        `Attendees: ${data.attendees.join(", ")}`,
        absent.length === 0 ? undefined : `Absent: ${absent.join(", ")}`,
      ),
      ...(agenda.length === 0 ? [] : [heading("Agenda", 2), list(agenda, "decimal")]),
      heading("Notes", 2),
      ...data.notes.flatMap((item) => [heading(item.topic, 3), list(item.points)]),
      ...(decisions.length === 0 ? [] : [heading("Decisions", 2), list(decisions)]),
      ...(actions.length === 0
        ? []
        : [
            heading("Actions", 2),
            ...tables(
              ["Owner", "Action", "Due"],
              actions.map((action) => [action.owner, action.task, action.due ?? ""]),
            ),
          ]),
    ];
  },
  excel: () => [],
  checks: () => [],
  formulas: () => 0,
};

const LAYOUTS: Readonly<Record<BuiltinTemplateName, Layout>> = {
  letter,
  memo,
  report,
  quote,
  "customer-statement": statement,
  "meeting-notes": meetingNotes,
};

export function layoutFor(name: string): Layout {
  const layout = (LAYOUTS as Readonly<Record<string, Layout>>)[name];
  if (layout === undefined) throw new Error(`there is no built-in layout for ${name}`);
  return layout;
}

/** A column letter for a 1-based column number (A, B, … Z, AA …). */
function column(index: number): string {
  let letters = "";
  for (let rest = index; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }
  return letters;
}
