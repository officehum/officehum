/**
 * The readers that work from bytes, in process: PDF, CSV and email. Word and Excel go through the
 * Paper Office worker and are in office.test.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExternalFile, localVersionedFileStore } from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { decodeText, detectDelimiter } from "./csv.js";
import { storeAttachments } from "./email.js";
import { htmlToText } from "./html.js";
import { readDocument } from "./read-document.js";
import { DEFAULT_READING_LIMITS, ReadingError, withinTime } from "./reading.js";
import { fixture } from "./test-helpers.js";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("PDF", () => {
  it("reads the three-page vendor bill as text per page", async () => {
    const reading = await readDocument(fixture("vendor-bill.pdf"), "application/pdf");
    expect(reading.kind).toBe("pdf");
    expect(reading.hasTextLayer).toBe(true);
    expect(reading.pages?.map((page) => page.number)).toEqual([1, 2, 3]);
    expect(reading.pages?.[0]?.text).toContain("Invoice NW-2041");
    expect(reading.pages?.[1]?.text).toContain("Toner cartridge, 2 units: 240.00");
    expect(reading.pages?.[2]?.text).toContain("Total due: 420.00 EUR");
    expect(reading.metadata.pages).toBe(3);
    expect(reading.tables).toEqual([]);
  });

  it("reports a scan without a text layer, so a later OCR tool can take over", async () => {
    const reading = await readDocument(fixture("scanned-receipt.pdf"), "application/pdf");
    expect(reading.hasTextLayer).toBe(false);
    expect(reading.pages).toEqual([{ number: 1, text: "", hasText: false }]);
  });

  it("refuses a PDF over the page limit and a file over the size limit", async () => {
    const pages = readDocument(fixture("vendor-bill.pdf"), "application/pdf", {
      limits: { ...DEFAULT_READING_LIMITS, maxPages: 2 },
    });
    await expect(pages).rejects.toMatchObject({ code: "too-many-pages" });
    await expect(pages).rejects.toThrow(/3 pages, over the 2/u);
    const big = readDocument(new Uint8Array(51 * 1024 * 1024), "application/pdf", {
      name: "huge.pdf",
    });
    await expect(big).rejects.toMatchObject({ code: "too-large" });
    await expect(big).rejects.toThrow(/huge\.pdf is 51\.0 MB, over the 50\.0 MB/u);
  });

  it("refuses bytes that are not a PDF, clearly", async () => {
    const reading = readDocument(new TextEncoder().encode("not a pdf"), "application/pdf");
    await expect(reading).rejects.toBeInstanceOf(ReadingError);
    await expect(reading).rejects.toMatchObject({ code: "malformed" });
  });

  it("stops waiting when a file takes longer than its time limit", async () => {
    // A parser that never answers stands in for a pathological file.
    const reading = withinTime(
      () => new Promise(() => undefined),
      {
        ...DEFAULT_READING_LIMITS,
        timeoutMs: 20,
      },
      "stuck.pdf",
    );
    await expect(reading).rejects.toMatchObject({ code: "timeout" });
    await expect(reading).rejects.toThrow(/reading stuck\.pdf took longer than 0\.02 s/u);
  });
});

describe("CSV", () => {
  it("detects a semicolon delimiter and a Windows-1252 encoding, and types each column", async () => {
    const reading = await readDocument(fixture("prices.csv"), "text/csv", { name: "prices.csv" });
    expect(reading.kind).toBe("csv");
    expect(reading.metadata).toMatchObject({ delimiter: ";", encoding: "windows-1252", rows: 3 });
    const sheet = reading.sheets?.[0];
    expect(sheet?.name).toBe("prices.csv");
    expect(sheet?.columnTypes).toEqual([
      { name: "Item", type: "text" },
      { name: "Unit price", type: "number" },
      { name: "Quantity", type: "integer" },
      { name: "Updated", type: "date" },
    ]);
    expect(sheet?.cells.find((cell) => cell.address === "A2")?.value).toBe("Café crème");
    // A decimal comma, as a semicolon file from a European desktop writes it.
    expect(sheet?.cells.find((cell) => cell.address === "B2")).toMatchObject({
      type: "number",
      value: 2.5,
    });
    expect(sheet?.text).toContain("| Item | Unit price | Quantity | Updated |");
    expect(sheet?.text).toContain("| Thé vert | 1,80 | 80 | 2026-10-03 |");
    expect(reading.tables).toEqual([
      { name: "prices.csv", location: "sheet: prices.csv", rows: 4, columns: 4 },
    ]);
  });

  it("decodes UTF-8 (with or without a byte-order mark) before falling back", () => {
    expect(decodeText(new TextEncoder().encode("\uFEFFa;é"))).toEqual({
      text: "a;é",
      encoding: "utf-8",
    });
    expect(decodeText(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]))).toEqual({
      text: "café",
      encoding: "windows-1252",
    });
  });

  it("picks the delimiter that splits the lines most consistently, ignoring quoted ones", () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n"x;y",5,6\n')).toBe(",");
    expect(detectDelimiter("a\tb\n1\t2\n")).toBe("\t");
    expect(detectDelimiter("a|b|c\n1|2|3\n")).toBe("|");
    expect(detectDelimiter("one column\nonly\n")).toBe(",");
  });

  it("keeps quoted fields whole, with their delimiters, quotes and line breaks", async () => {
    const csv = 'name,note\n"Smith, J","said ""hi""\nthen left"\n';
    const reading = await readDocument(new TextEncoder().encode(csv), "text/csv");
    const cells = reading.sheets?.[0]?.cells ?? [];
    expect(cells.find((cell) => cell.address === "A2")?.value).toBe("Smith, J");
    expect(cells.find((cell) => cell.address === "B2")?.value).toBe('said "hi"\nthen left');
  });
});

describe("email", () => {
  it("reads headers, converts the HTML body, and lists the attachment", async () => {
    const reading = await readDocument(fixture("forwarded-bill.eml"), "message/rfc822");
    expect(reading.kind).toBe("eml");
    expect(reading.metadata).toMatchObject({
      subject: "Fwd: Invoice NW-2042",
      from: "Northwind Accounts <accounts@northwind.example>",
      to: "Example Trading Co. <ap@example-trading.example>",
      attachments: 1,
    });
    const [headers, body, attachments] = reading.sections ?? [];
    expect(headers?.heading).toBe("Headers");
    expect(headers?.text).toContain("Subject: Fwd: Invoice NW-2042");
    expect(body?.heading).toBe("Body");
    expect(body?.text).toContain("Please find invoice NW-2042 attached.");
    expect(body?.text).toContain("- Total due: 95.00 EUR");
    expect(body?.text).not.toContain("<b>");
    expect(attachments?.heading).toBe("Attachments");
    // With no file store the attachment is listed but not saved.
    expect(reading.attachments).toEqual([
      { fileId: null, name: "NW-2042.pdf", mimeType: "application/pdf", size: 694 },
    ]);
  });

  it("saves each attachment to the file store as an outside file, once per task and email", async () => {
    const dir = await mkdtemp(join(tmpdir(), "documents-eml-"));
    temps.push(dir);
    const store = localVersionedFileStore(dir);
    const bytes = fixture("forwarded-bill.eml");
    const sink = () =>
      storeAttachments({
        store,
        taskId: "task:1",
        createdBy: "role:reading-desk",
        email: { fileId: "file_01JABCDEFGHJKMNPQRSTVWXYZ0", sha256: "a".repeat(64) },
      });
    const first = await readDocument(bytes, "message/rfc822", { attachments: sink() });
    const again = await readDocument(bytes, "message/rfc822", { attachments: sink() });
    const fileId = first.attachments?.[0]?.fileId;
    expect(fileId).toEqual(expect.any(String));
    expect(again.attachments?.[0]?.fileId).toBe(fileId);
    const saved = await store.get(fileId ?? "");
    expect(saved?.ref).toMatchObject({
      name: "NW-2042.pdf",
      mimeType: "application/pdf",
      metadata: {
        source: "external",
        provenance: "external",
        createdBy: "role:reading-desk",
        derivedFrom: ["file_01JABCDEFGHJKMNPQRSTVWXYZ0"],
      },
    });
    expect(isExternalFile(saved?.ref ?? { metadata: { createdBy: "", source: "generated" } })).toBe(
      true,
    );
    // The attachment is itself a readable PDF.
    const attached = await readDocument(saved?.bytes ?? new Uint8Array(), "application/pdf");
    expect(attached.pages?.[0]?.text).toContain("Invoice NW-2042");
    expect(first.sections?.[2]?.text).toContain(
      `NW-2042.pdf (application/pdf, 694 bytes): ${fileId}`,
    );
  });
});

describe("HTML to text", () => {
  it("keeps paragraphs, line breaks and list items, and drops scripts, styles and tags", () => {
    expect(
      htmlToText(
        "<style>p{color:red}</style><p>One &amp; two</p><script>alert(1)</script>" +
          "<ul><li>A</li><li>B</li></ul>Line<br>break&nbsp;here &lt;ok&gt; &#8364; &#x20AC;",
      ),
    ).toBe("One & two\n\n- A\n- B\n\nLine\nbreak here <ok> € €");
  });
});

describe("formats the readers do not take from bytes", () => {
  it("sends Word and Excel through the lease, and refuses PowerPoint and unknown types", async () => {
    await expect(
      readDocument(fixture("contract.docx"), "application/octet-stream", { name: "contract.docx" }),
    ).rejects.toMatchObject({ code: "unsupported-format" });
    await expect(readDocument(new Uint8Array(1), "image/png")).rejects.toMatchObject({
      code: "unsupported-format",
    });
    await expect(
      readDocument(
        new Uint8Array(1),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    ).rejects.toThrow(/PowerPoint/u);
  });
});
