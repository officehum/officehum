/** Rendering a reading: markers, selection, the cut and its note, the outline and search. */

import { describe, expect, it } from "vitest";
import { readDocument } from "./read-document.js";
import type { DocumentReading } from "./reading.js";
import { documentUnits, parsePages, renderOutline, renderRead, searchDocument } from "./render.js";
import { fixture } from "./test-helpers.js";

const bill = () => readDocument(fixture("vendor-bill.pdf"), "application/pdf");

const contract: DocumentReading = {
  kind: "docx",
  sections: [
    { number: 1, heading: "Agreement", level: 0, ref: "word/document.xml#0", text: "# Agreement" },
    {
      number: 2,
      heading: "2. Fees",
      level: 1,
      ref: "word/document.xml#3",
      text: "## 2. Fees\n\n| Service | Fee |\n| --- | --- |\n| Cleaning | 1,200.00 |",
    },
  ],
  tables: [{ name: "Table 1", location: "s. 2", rows: 2, columns: 2 }],
  metadata: { blocks: 4 },
  hasTextLayer: true,
};

describe("documentUnits", () => {
  it("lists a reading's units with the markers and labels document_read shows", () => {
    expect(documentUnits(contract)).toEqual([
      expect.objectContaining({
        kind: "section",
        marker: "s. 1",
        label: "s. 1, word/document.xml#0",
      }),
      expect.objectContaining({ marker: "s. 2", text: expect.stringContaining("Cleaning") }),
    ]);
  });
});

describe("document_read's text", () => {
  it("marks every page, in order", async () => {
    const { text, truncated } = renderRead(await bill(), { name: "vendor-bill.pdf" });
    expect(truncated).toBe(false);
    expect(text.indexOf("[p. 1]")).toBeLessThan(text.indexOf("Invoice NW-2041"));
    expect(text.indexOf("[p. 2]")).toBeLessThan(text.indexOf("Line items"));
    expect(text.indexOf("[p. 3]")).toBeLessThan(text.indexOf("Total due: 420.00 EUR"));
    expect(text.indexOf("Invoice NW-2041")).toBeLessThan(text.indexOf("[p. 2]"));
  });

  it("selects pages, and refuses pages the document does not have", async () => {
    const reading = await bill();
    const { text } = renderRead(reading, { name: "vendor-bill.pdf", pages: "2-3" });
    expect(text).not.toContain("[p. 1]");
    expect(text).toContain("[p. 2]");
    expect(text).toContain("[p. 3]");
    expect(() => renderRead(reading, { name: "vendor-bill.pdf", pages: "4" })).toThrow(
      /has pages 1 to 3/u,
    );
  });

  it("cuts at max_chars, on a line, with a note saying how to ask for more", async () => {
    const { text, truncated } = renderRead(await bill(), {
      name: "vendor-bill.pdf",
      maxChars: 120,
    });
    expect(truncated).toBe(true);
    const [body, note] = text.split("\n\n[Cut at");
    expect(body?.length).toBeLessThanOrEqual(120);
    expect(note).toMatch(/pages: "2-3"/u);
    expect(note).toMatch(/max_chars/u);
  });

  it("marks Word sections with their source reference", () => {
    const { text } = renderRead(contract, { name: "contract.docx" });
    expect(text).toContain("[s. 2, word/document.xml#3]");
    expect(text).toContain("| Cleaning | 1,200.00 |");
  });

  it("marks sheets, and selects one by name", async () => {
    const reading = await readDocument(fixture("prices.csv"), "text/csv", { name: "prices.csv" });
    expect(renderRead(reading, { name: "prices.csv" }).text).toContain("[sheet: prices.csv]");
    expect(() => renderRead(reading, { name: "prices.csv", sheet: "Other" })).toThrow(
      /has no sheet "Other"; its sheets are prices\.csv/u,
    );
  });

  it("parses page lists", () => {
    expect(parsePages("3")).toEqual([3]);
    expect(parsePages(" 1-2, 5 ")).toEqual([1, 2, 5]);
    expect(() => parsePages("2-1")).toThrow(/page list/u);
    expect(() => parsePages("x")).toThrow(/page list/u);
  });
});

describe("document_outline's text", () => {
  it("lists pages with whether each has text", async () => {
    const scan = await readDocument(fixture("scanned-receipt.pdf"), "application/pdf");
    const outline = renderOutline(scan, "scanned-receipt.pdf");
    expect(outline).toContain("hasTextLayer: false");
    expect(outline).toContain("p. 1: no text layer");
  });

  it("lists sections and tables with their sizes", () => {
    const outline = renderOutline(contract, "contract.docx");
    expect(outline).toContain("s. 2 (word/document.xml#3): 2. Fees");
    expect(outline).toContain("Table 1 in s. 2: 2 rows x 2 columns");
  });
});

describe("document_search", () => {
  it("finds the passage and the page it is on", async () => {
    const matches = searchDocument(await bill(), "toner cartridge");
    expect(matches).toEqual([{ marker: "p. 2", passage: "Toner cartridge, 2 units: 240.00" }]);
  });

  it("matches every word of the query when the phrase is not there whole", async () => {
    const matches = searchDocument(await bill(), "payment days");
    expect(matches.map((match) => match.marker)).toEqual(["p. 3"]);
  });

  it("finds nothing for text that is not in the document", async () => {
    expect(searchDocument(await bill(), "refund")).toEqual([]);
  });
});
