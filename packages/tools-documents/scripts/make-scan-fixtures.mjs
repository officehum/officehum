/**
 * Builds the extraction fixtures: pictures of paper, with no text layer, as a scanner or a
 * phone makes them, and one clean bill with a text layer (`text-bill.pdf`), which a model that cannot
 * read images can still extract. Every name, figure and address in them is made up.
 *
 *     node packages/tools-documents/scripts/make-scan-fixtures.mjs
 *
 * It draws with `@napi-rs/canvas`, a dependency of the package, using fonts macOS ships (Helvetica,
 * Courier, Bradley Hand); on another system Skia substitutes a font, so the pictures differ slightly.
 * The scanned PDFs are written byte by byte around a JPEG page, so they carry no text at all; the text
 * bill is Helvetica text, the way `make-fixtures.py` writes its PDFs. The fixtures are
 * committed; this script is how they were made and how to make them again.
 */

import { writeFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";

const FIXTURES = new URL("../fixtures/", import.meta.url);

// A4 at 150 dpi.
const WIDTH = 1240;
const HEIGHT = 1754;

/** A seeded generator, so the speckle and the skew come out the same on every run. */
function random(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Scanner speckle: a few grey dots over the page. */
function speckle(context, width, height, seed, count) {
  const next = random(seed);
  for (let index = 0; index < count; index += 1) {
    const shade = 120 + Math.floor(next() * 100);
    context.fillStyle = `rgb(${shade},${shade},${shade})`;
    context.fillRect(next() * width, next() * height, 1 + next() * 2, 1 + next() * 2);
  }
}

/** Draws rows of `[text, x]` cells, one row per entry, from `top`, `step` pixels apart. */
function rows(context, entries, top, step) {
  entries.forEach((cells, index) => {
    for (const [text, x, align] of cells) {
      context.textAlign = align ?? "left";
      context.fillText(text, x, top + index * step);
    }
  });
  context.textAlign = "left";
}

/** One bill page: a header, a table of lines, the totals and the terms. */
function billPage({ vendor, address, number, issued, due, lines, totals, terms, seed }) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fbfaf7";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = "#111111";
  context.font = "bold 44px Helvetica";
  context.fillText(vendor, 120, 170);
  context.font = "28px Helvetica";
  context.fillText(address, 120, 220);
  context.font = "bold 36px Helvetica";
  context.fillText("INVOICE", 120, 330);
  context.font = "30px Helvetica";
  rows(
    context,
    [
      [[`Invoice no: ${number}`, 120]],
      [[`Invoice date: ${issued}`, 120]],
      [[`Due date: ${due}`, 120]],
      [["Bill to: Example Trading Co., 4 Mill Lane, Leeds LS1 4AB", 120]],
    ],
    390,
    48,
  );
  context.font = "bold 30px Helvetica";
  rows(
    context,
    [
      [
        ["Description", 120],
        ["Qty", 680, "right"],
        ["Unit price", 900, "right"],
        ["Amount", 1120, "right"],
      ],
    ],
    660,
    0,
  );
  context.fillRect(120, 680, 1000, 3);
  context.font = "30px Helvetica";
  rows(
    context,
    lines.map(([description, quantity, price, amount]) => [
      [description, 120],
      [quantity, 680, "right"],
      [price, 900, "right"],
      [amount, 1120, "right"],
    ]),
    735,
    52,
  );
  const below = 735 + lines.length * 52 + 40;
  context.fillRect(620, below - 30, 500, 2);
  rows(
    context,
    totals.map(([label, amount]) => [
      [label, 900, "right"],
      [amount, 1120, "right"],
    ]),
    below + 20,
    52,
  );
  context.font = "28px Helvetica";
  context.fillText(terms, 120, below + totals.length * 52 + 120);
  speckle(context, WIDTH, HEIGHT, seed, 900);
  return canvas;
}

/** A PDF of one page that is nothing but a JPEG: what a scanner writes. */
function imagePdf(canvas) {
  const jpeg = canvas.encodeSync("jpeg", 85);
  const page = Buffer.from(`q 595 0 0 842 0 0 cm /Im1 Do Q`, "latin1");
  return pdfOf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [4 0 R] /Count 1 >>"),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      Buffer.from("\nendstream"),
    ]),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 3 0 R >> >> /Contents 5 0 R >>",
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${page.length} >>\nstream\n`),
      page,
      Buffer.from("\nendstream"),
    ]),
  ]);
}

/** A PDF file around numbered objects (object 1 the catalog), with its cross-reference table. */
function pdfOf(objects) {
  const parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let length = parts[0].length;
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      body,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
  ].join("");
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

/** A PDF with real text: one page of lines in Helvetica, as accounting software writes a bill. */
function textPdf(lines) {
  const body = ["BT", "/F1 12 Tf", "72 770 Td", "18 TL"];
  for (const line of lines) {
    body.push(
      `(${line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")}) Tj T*`,
    );
  }
  body.push("ET");
  const page = Buffer.from(body.join("\n"), "latin1");
  return pdfOf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [4 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${page.length} >>\nstream\n`),
      page,
      Buffer.from("\nendstream"),
    ]),
  ]);
}

/** The clean bill with a text layer: what a text-only model can extract. Every figure agrees. */
function textBill() {
  return textPdf([
    "Harbourside Stationers Ltd",
    "21 Dock Road, Hull HU1 2AA",
    "Invoice no: HS-3301",
    "Invoice date: 2026-11-10",
    "Due date: 2026-12-10",
    "Bill to: Example Trading Co., 4 Mill Lane, Leeds LS1 4AB",
    "Description / Qty / Unit price / Amount",
    "Copier paper A4 (boxes) / 10 / 4.50 / 45.00",
    "Toner cartridge / 1 / 120.00 / 120.00",
    "Subtotal: 165.00",
    "VAT 20%: 33.00",
    "Total GBP: 198.00",
    "Payment terms: 30 days from the invoice date",
  ]);
}

/** The clean bill: every line, the subtotal, the VAT and the total agree. */
function cleanBill() {
  return billPage({
    vendor: "Brightway Cleaning Ltd",
    address: "12 Harbour Road, Portsmouth PO1 2AB",
    number: "BW-1107",
    issued: "2026-11-02",
    due: "2026-12-02",
    lines: [
      ["Office cleaning (weeks)", "4", "300.00", "1,200.00"],
      ["Window washing", "2", "150.00", "300.00"],
    ],
    totals: [
      ["Subtotal", "1,500.00"],
      ["VAT 20%", "300.00"],
      ["Total GBP", "1,800.00"],
    ],
    terms: "Payment terms: 30 days from the invoice date",
    seed: 7,
  });
}

/** The bill whose lines do not add up: 180 + 240 is 420, not 440, and 440 + 88 is not 538. */
function wrongBill() {
  return billPage({
    vendor: "Northwind Supplies Ltd",
    address: "88 Quay Street, Bristol BS1 4DJ",
    number: "NW-2093",
    issued: "2026-11-05",
    due: "2026-12-05",
    lines: [
      ["Copier paper A4 (boxes)", "40", "4.50", "180.00"],
      ["Toner cartridge", "2", "120.00", "240.00"],
    ],
    totals: [
      ["Subtotal", "440.00"],
      ["VAT 20%", "88.00"],
      ["Total GBP", "538.00"],
    ],
    terms: "Payment terms: 30 days",
    seed: 11,
  });
}

/** A till receipt, photographed on a table: narrow, off-white, a little dim and turned 4 degrees. */
function receiptPhoto() {
  const paper = createCanvas(560, 900);
  const slip = paper.getContext("2d");
  slip.fillStyle = "#f4f1ea";
  slip.fillRect(0, 0, paper.width, paper.height);
  slip.fillStyle = "#222222";
  slip.font = "bold 34px Courier";
  slip.textAlign = "center";
  slip.fillText("CORNER CAFE", 280, 80);
  slip.font = "24px Courier";
  slip.fillText("3 Market Square, York YO1 8RS", 280, 120);
  slip.textAlign = "left";
  slip.font = "26px Courier";
  rows(
    slip,
    [
      [["Receipt no: R-5521", 40]],
      [["Date: 2026-11-14 08:42", 40]],
      [["", 40]],
      [
        ["2 x Flat white @ 3.20", 40],
        ["6.40", 520, "right"],
      ],
      [
        ["1 x Croissant @ 2.10", 40],
        ["2.10", 520, "right"],
      ],
      [["", 40]],
      [
        ["Subtotal", 40],
        ["8.50", 520, "right"],
      ],
      [
        ["VAT 20%", 40],
        ["1.70", 520, "right"],
      ],
      [
        ["TOTAL EUR", 40],
        ["10.20", 520, "right"],
      ],
      [["", 40]],
      [["Paid by card. Thank you!", 40]],
    ],
    200,
    48,
  );

  const photo = createCanvas(900, 1200);
  const context = photo.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 900, 1200);
  gradient.addColorStop(0, "#6b5a48");
  gradient.addColorStop(1, "#4a3d31");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 900, 1200);
  context.save();
  context.translate(450, 600);
  context.rotate((4 * Math.PI) / 180);
  context.shadowColor = "rgba(0,0,0,0.45)";
  context.shadowBlur = 24;
  context.drawImage(paper, -paper.width / 2, -paper.height / 2);
  context.restore();
  // Uneven light: the top of the photo is brighter than the bottom.
  const light = context.createLinearGradient(0, 0, 0, 1200);
  light.addColorStop(0, "rgba(255,255,255,0.06)");
  light.addColorStop(1, "rgba(0,0,0,0.12)");
  context.fillStyle = light;
  context.fillRect(0, 0, 900, 1200);
  speckle(context, 900, 1200, 23, 600);
  return photo.encodeSync("jpeg", 80);
}

/** A handwritten note: no layout, no total line, and a hand OCR reads only in part. */
function handwrittenNote() {
  const canvas = createCanvas(1000, 700);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fffef6";
  context.fillRect(0, 0, 1000, 700);
  context.strokeStyle = "#b8d0e8";
  for (let y = 120; y < 700; y += 70) {
    context.beginPath();
    context.moveTo(40, y);
    context.lineTo(960, y);
    context.stroke();
  }
  context.fillStyle = "#1d2a6b";
  context.font = "44px Bradley Hand";
  const next = random(5);
  const lines = [
    "Paid Jim for fixing the gate",
    "about 45 quid, cash",
    "plus a new hinge?? ask him",
    "- Tuesday",
  ];
  lines.forEach((line, index) => {
    context.save();
    context.translate(70, 108 + index * 140);
    context.rotate((next() - 0.5) * 0.06);
    context.fillText(line, 0, 0);
    context.restore();
  });
  return canvas.encodeSync("png");
}

writeFileSync(new URL("text-bill.pdf", FIXTURES), textBill());
writeFileSync(new URL("scanned-bill.pdf", FIXTURES), imagePdf(cleanBill()));
writeFileSync(new URL("bill-wrong-total.pdf", FIXTURES), imagePdf(wrongBill()));
writeFileSync(new URL("receipt-photo.jpg", FIXTURES), receiptPhoto());
writeFileSync(new URL("handwritten-note.png", FIXTURES), handwrittenNote());
