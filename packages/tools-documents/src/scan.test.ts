import { describe, expect, it } from "vitest";
import { DEFAULT_READING_LIMITS } from "./reading.js";
import { MAX_SCAN_PAGES, scanDocument, scanFormatOf } from "./scan.js";
import { fixture } from "./test-helpers.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

function lines(page: { lines: readonly { text: string }[] } | undefined): string[] {
  return page?.lines.map((line) => line.text) ?? [];
}

describe("scanFormatOf", () => {
  it("knows PDF, JPEG, PNG and HEIC by type or by name", () => {
    expect(scanFormatOf("application/pdf")).toBe("pdf");
    expect(scanFormatOf("image/jpeg")).toBe("jpeg");
    expect(scanFormatOf("application/octet-stream", "IMG_0042.JPG")).toBe("jpeg");
    expect(scanFormatOf("image/png")).toBe("png");
    expect(scanFormatOf("image/heic")).toBe("heic");
    expect(scanFormatOf("application/octet-stream", "IMG_0042.HEIC")).toBe("heic");
    expect(scanFormatOf("text/csv", "prices.csv")).toBeUndefined();
  });
});

describe("scanDocument", () => {
  it("renders a PDF page with no text layer to PNG and reads it by OCR", async () => {
    const scan = await scanDocument({
      bytes: fixture("scanned-bill.pdf"),
      mimeType: "application/pdf",
    });
    expect(scan.format).toBe("pdf");
    expect(scan.pages).toHaveLength(1);
    const [page] = scan.pages;
    expect(page?.source).toBe("ocr");
    expect(page?.image?.mimeType).toBe("image/png");
    expect([...(page?.image?.data.subarray(0, 4) ?? [])]).toEqual(PNG_SIGNATURE);
    expect(lines(page)).toContain("Total GBP 1,800.00");
    expect(lines(page)).toContain("Invoice no: BW-1107");
    expect(page?.lines[0]?.number).toBe(1);
  });

  it("keeps a PDF's own text where it has one, and sends no image for it", async () => {
    const scan = await scanDocument({
      bytes: fixture("vendor-bill.pdf"),
      mimeType: "application/pdf",
    });
    expect(scan.pages.map((page) => page.source)).toEqual([
      "text-layer",
      "text-layer",
      "text-layer",
    ]);
    expect(scan.pages.every((page) => page.image === undefined)).toBe(true);
    expect(lines(scan.pages[2])).toContain("Total due: 420.00 EUR");
    expect(scan.pages[2]?.lines.every((line) => line.confidence === null)).toBe(true);
  });

  it("reads a phone photo by OCR and passes the photo itself on", async () => {
    const bytes = fixture("receipt-photo.jpg");
    const scan = await scanDocument({ bytes, mimeType: "image/jpeg", name: "receipt.jpg" });
    expect(scan.format).toBe("jpeg");
    expect(scan.pages[0]?.image).toEqual({ data: bytes, mimeType: "image/jpeg" });
    expect(lines(scan.pages[0])).toContain("TOTAL EUR 10.20");
  });

  it("refuses HEIC with a message that says what to send instead", async () => {
    await expect(
      scanDocument({ bytes: new Uint8Array(16), mimeType: "image/heic", name: "IMG_0042.HEIC" }),
    ).rejects.toMatchObject({
      code: "unsupported-format",
      message: expect.stringMatching(/IMG_0042\.HEIC.*HEIC.*JPEG/su),
    });
  });

  it("refuses formats that are not a scan, a photo or a PDF", async () => {
    await expect(
      scanDocument({ bytes: fixture("prices.csv"), mimeType: "text/csv", name: "prices.csv" }),
    ).rejects.toMatchObject({ code: "unsupported-format" });
  });

  it(`refuses a PDF longer than ${MAX_SCAN_PAGES} pages, or than the host's limit`, async () => {
    await expect(
      scanDocument(
        { bytes: fixture("vendor-bill.pdf"), mimeType: "application/pdf", name: "bill.pdf" },
        { limits: { ...DEFAULT_READING_LIMITS, maxPages: 2 } },
      ),
    ).rejects.toMatchObject({
      code: "too-many-pages",
      message: expect.stringContaining("bill.pdf"),
    });
  });

  it("refuses a damaged PDF and an image it cannot decode", async () => {
    const junk = new TextEncoder().encode("%PDF-1.4 nothing here");
    await expect(scanDocument({ bytes: junk, mimeType: "application/pdf" })).rejects.toMatchObject({
      code: "malformed",
    });
    await expect(scanDocument({ bytes: junk, mimeType: "image/png" })).rejects.toMatchObject({
      code: "malformed",
    });
  });
});
