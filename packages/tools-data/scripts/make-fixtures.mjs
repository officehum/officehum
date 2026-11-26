// Builds the data pack's CSV fixtures. Every name and figure in them is made up.
//
//   node packages/tools-data/scripts/make-fixtures.mjs
//
// The sales file comes from a seeded generator, so running this again writes the same bytes. The
// open-invoices workbook is made from open-invoices.csv by make-workbook.py. The fixtures are
// committed; this script is how they were made and how to make them again.

import { writeFileSync } from "node:fs";

const FIXTURES = new URL("../fixtures/", import.meta.url);

/** mulberry32: a small seeded generator, so the fixture is the same on every run. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = seeded(3204);
const pick = (list) => list[Math.floor(random() * list.length)];
const cents = (value) => `${Math.trunc(value / 100)}.${String(value % 100).padStart(2, "0")}`;

const CUSTOMERS = [
  ["Alder & Finch", "North"],
  ["Brightwater Dental", "South"],
  ["Copperleaf Cafe", "East"],
  ["Dunmore Logistics", "West"],
  ["Elmstead Primary", "North"],
  ["Fairhaven Florists", "South"],
  ["Granite Peak Gym", "East"],
  ["Hollins Print Co", "West"],
  ["Ivybridge Vets", "North"],
  ["Juniper Studios", "South"],
  ["Kestrel Joinery", "East"],
  ["Larkspur Bakery", "West"],
];
const PRODUCTS = [
  ["Copier paper A4 (box)", 2_499],
  ["Toner cartridge", 8_950],
  ["Desk chair", 14_900],
  ["Whiteboard markers (10)", 1_275],
  ["Filing cabinet", 21_999],
  ["Coffee beans 1 kg", 1_840],
  ["Monitor arm", 6_450],
  ["Label printer", 11_325],
];

const sales = ["order_id,order_date,customer,region,product,quantity,unit_price,amount"];
for (let index = 0; index < 10_000; index += 1) {
  const [customer, region] = pick(CUSTOMERS);
  const [product, price] = pick(PRODUCTS);
  const quantity = 1 + Math.floor(random() * 12);
  // Two quarters, 2026-04-01 to 2026-09-30: 183 days.
  const day = new Date(Date.UTC(2026, 3, 1) + Math.floor(random() * 183) * 86_400_000);
  const date = day.toISOString().slice(0, 10);
  sales.push(
    [
      `SO-${100_001 + index}`,
      date,
      customer,
      region,
      product,
      quantity,
      cents(price),
      cents(price * quantity),
    ].join(","),
  );
}
writeFileSync(new URL("sales.csv", FIXTURES), `${sales.join("\n")}\n`);

// Open invoices: two share an amount (INV-1004 and INV-1009), so matching by amount alone is wrong.
const invoices = [
  ["INV-1001", "Alder & Finch", "2026-09-02", "2026-10-02", "1250.00"],
  ["INV-1002", "Brightwater Dental", "2026-09-05", "2026-10-05", "480.50"],
  ["INV-1003", "Copperleaf Cafe", "2026-09-09", "2026-10-09", "2310.75"],
  ["INV-1004", "Dunmore Logistics", "2026-09-12", "2026-10-12", "899.00"],
  ["INV-1005", "Elmstead Primary", "2026-09-15", "2026-10-15", "3400.00"],
  ["INV-1006", "Fairhaven Florists", "2026-09-18", "2026-10-18", "156.20"],
  ["INV-1007", "Granite Peak Gym", "2026-09-22", "2026-10-22", "742.10"],
  ["INV-1008", "Hollins Print Co", "2026-09-25", "2026-10-25", "1999.99"],
  ["INV-1009", "Ivybridge Vets", "2026-09-29", "2026-10-29", "899.00"],
  ["INV-1010", "Juniper Studios", "2026-10-01", "2026-10-31", "615.40"],
];
writeFileSync(
  new URL("open-invoices.csv", FIXTURES),
  `${["invoice_number,customer,issue_date,due_date,amount", ...invoices.map((row) => row.join(","))].join("\n")}\n`,
);

// The bank statement: payments that match by reference and amount, one partial payment, one
// payment whose reference is missing, one that names INV-1009 (not INV-1004, which has the same
// amount), and the office's own outgoings.
const bank = [
  ["2026-10-01", "FASTER PAYMENT ALDER & FINCH REF INV-1001", "1250.00"],
  ["2026-10-02", "DIRECT DEBIT OFFICE RENT OCTOBER", "-2750.00"],
  ["2026-10-03", "BACS BRIGHTWATER DENTAL INV-1002", "480.50"],
  ["2026-10-06", "FASTER PAYMENT COPPERLEAF CAFE INV 1003 PART", "1000.00"],
  ["2026-10-08", "CARD PAYMENT STATIONERY WHOLESALE", "-312.48"],
  ["2026-10-10", "BACS IVYBRIDGE VETS REF INV-1009", "899.00"],
  ["2026-10-13", "FASTER PAYMENT ELMSTEAD PRIMARY", "3400.00"],
  ["2026-10-16", "BACS FAIRHAVEN FLORISTS INV-1006", "156.20"],
  ["2026-10-20", "BANK CHARGES", "-18.50"],
  ["2026-10-24", "FASTER PAYMENT HOLLINS PRINT INV-1008", "1999.99"],
];
writeFileSync(
  new URL("bank-statement.csv", FIXTURES),
  `${["date,description,amount", ...bank.map(([date, text, amount]) => `${date},"${text}",${amount}`)].join("\n")}\n`,
);
