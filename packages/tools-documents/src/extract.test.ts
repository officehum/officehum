/**
 * The extraction evals: each fixture through real rendering, real OCR and the real checks,
 * with a scripted model standing in for the vision model. The scripted answers are what a careful
 * model reads off each picture; the checks, not the model, decide the status.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { type Extraction, extractDocument, MODEL_TIMEOUT_MS, modelTimeout } from "./extract.js";
import { DEFAULT_READING_LIMITS } from "./reading.js";
import { cited, extractionModel, fixture } from "./test-helpers.js";

const PDF = "application/pdf";

/** What a careful model reads off `scanned-bill.pdf`, with the line numbers OCR gave it. */
const CLEAN_BILL: JsonObject = {
  vendor: cited("Brightway Cleaning Ltd", 1),
  vendor_address: cited("12 Harbour Road, Portsmouth PO1 2AB", 2),
  document_number: cited("BW-1107", 4),
  issue_date: cited("2026-11-02", 5),
  due_date: cited("2026-12-02", 6),
  currency: cited("GBP", 13),
  line_items: [
    {
      description: "Office cleaning (weeks)",
      quantity: "4",
      unit_price: "300.00",
      amount: "1200.00",
      page: 1,
      line: 9,
    },
    {
      description: "Window washing",
      quantity: "2",
      unit_price: "150.00",
      amount: "300.00",
      page: 1,
      line: 10,
    },
  ],
  subtotal: cited("1500.00", 11),
  tax_lines: [{ label: "VAT", rate: "20%", amount: "300.00", page: 1, line: 12 }],
  total: cited("1800.00", 13),
  payment_terms: cited("30 days from the invoice date", 14),
};

function failed(extraction: Extraction): string[] {
  return extraction.checks.filter((check) => check.result === "fail").map((check) => check.name);
}

describe("extraction evals with a scripted model", () => {
  it("a clean scanned bill is checked, every value with its page and OCR line", async () => {
    const model = extractionModel(CLEAN_BILL);
    const result = await extractDocument(
      { bytes: fixture("scanned-bill.pdf"), mimeType: PDF, name: "scanned-bill.pdf" },
      "vendor_bill",
      model,
    );
    expect(failed(result)).toEqual([]);
    expect(result.status).toBe("checked");
    expect(result.partyRole).toBe("vendor");
    expect(result.fields.party).toEqual({
      value: "Brightway Cleaning Ltd",
      source: { page: 1, line: 1, text: "Brightway Cleaning Ltd" },
    });
    expect(result.fields.total.source?.text).toContain("1,800.00");
    expect(result.fields.documentNumber.source?.text).toContain("BW-1107");
    expect(result.lineItems[1]).toMatchObject({
      description: "Window washing",
      amount: "300.00",
      source: { page: 1, line: 10, text: expect.stringContaining("Window washing") },
    });
    expect(result.taxLines[0]?.source.text).toContain("VAT 20%");
    expect(result.pages).toEqual([{ number: 1, source: "ocr", confidence: expect.any(Number) }]);
    expect(result.model).toBe("scripted-vision/vision-1");
  });

  it("a bill whose lines do not add up is unverified: the arithmetic catches the wrong total", async () => {
    const model = extractionModel({
      vendor: cited("Northwind Supplies Ltd", 1),
      vendor_address: cited("88 Quay Street, Bristol BS1 4DJ", 2),
      document_number: cited("NW-2093", 4),
      issue_date: cited("2026-11-05", 5),
      due_date: cited("2026-12-05", 6),
      currency: cited("GBP", 13),
      line_items: [
        {
          description: "Copier paper A4 (boxes)",
          quantity: "40",
          unit_price: "4.50",
          amount: "180.00",
          page: 1,
          line: 9,
        },
        {
          description: "Toner cartridge",
          quantity: "2",
          unit_price: "120.00",
          amount: "240.00",
          page: 1,
          line: 10,
        },
      ],
      subtotal: cited("440.00", 11),
      tax_lines: [{ label: "VAT", rate: "20%", amount: "88.00", page: 1, line: 12 }],
      total: cited("538.00", 13),
      payment_terms: cited("30 days", 14),
    });
    const result = await extractDocument(
      { bytes: fixture("bill-wrong-total.pdf"), mimeType: PDF },
      "vendor_bill",
      model,
    );
    expect(result.status).toBe("unverified");
    expect(failed(result)).toEqual(["lines-subtotal", "subtotal-tax-total"]);
    const total = result.checks.find((check) => check.name === "subtotal-tax-total");
    expect(total?.message).toContain("528.00");
    expect(total?.message).toContain("538.00");
  });

  it("a skewed phone photo of a receipt is checked", async () => {
    const model = extractionModel({
      vendor: cited("Corner Cafe", 1),
      vendor_address: cited("3 Market Square, York YO1 8RS", 2),
      document_number: cited("R-5521", 3),
      issue_date: cited("2026-11-14", 4),
      due_date: cited(null, null),
      currency: cited("EUR", 9),
      line_items: [
        {
          description: "Flat white",
          quantity: "2",
          unit_price: "3.20",
          amount: "6.40",
          page: 1,
          line: 5,
        },
        {
          description: "Croissant",
          quantity: "1",
          unit_price: "2.10",
          amount: "2.10",
          page: 1,
          line: 6,
        },
      ],
      subtotal: cited("8.50", 7),
      tax_lines: [{ label: "VAT", rate: "20%", amount: "1.70", page: 1, line: 8 }],
      total: cited("10.20", 9),
      payment_terms: cited(null, null),
    });
    const result = await extractDocument(
      { bytes: fixture("receipt-photo.jpg"), mimeType: "image/jpeg", name: "receipt.jpg" },
      "receipt",
      model,
    );
    expect(failed(result)).toEqual([]);
    expect(result.status).toBe("checked");
    expect(result.fields.dueDate).toEqual({ value: null, source: null });
    expect(result.fields.total.source?.text).toContain("10.20");
  });

  it("a handwritten note is unverified, with the failed checks saying why", async () => {
    const model = extractionModel({
      vendor: cited("Jim", 1),
      vendor_address: cited(null, null),
      document_number: cited(null, null),
      issue_date: cited(null, null),
      due_date: cited(null, null),
      currency: cited(null, null),
      line_items: [],
      subtotal: cited(null, null),
      tax_lines: [],
      total: cited("45", 2),
      payment_terms: cited(null, null),
    });
    const result = await extractDocument(
      { bytes: fixture("handwritten-note.png"), mimeType: "image/png" },
      "receipt",
      model,
    );
    expect(result.status).toBe("unverified");
    expect(failed(result)).toEqual([
      "lines-subtotal",
      "subtotal-tax-total",
      "dates",
      "currency",
      "source-document-number",
    ]);
    expect(result.checks.find((check) => check.name === "source-total")?.result).toBe("pass");
  });

  it("checks the model's figures rather than trusting them", async () => {
    const model = extractionModel({
      ...CLEAN_BILL,
      subtotal: cited("1600.00", 11),
      total: cited("1900.00", 13),
    });
    const result = await extractDocument(
      { bytes: fixture("scanned-bill.pdf"), mimeType: PDF },
      "vendor_bill",
      model,
    );
    expect(result.status).toBe("unverified");
    expect(failed(result)).toEqual(["lines-subtotal", "source-total"]);
  });
});

describe("what the model is sent and what it must send back", () => {
  it("sends each scanned page as an image with its numbered OCR lines, and one tool to call", async () => {
    const model = extractionModel(CLEAN_BILL);
    await extractDocument(
      { bytes: fixture("scanned-bill.pdf"), mimeType: PDF },
      "vendor_bill",
      model,
    );
    const request = JSON.stringify(model.requests[0]);
    expect(request).toContain('"type":"image"');
    expect(request).toContain('"mimeType":"image/png"');
    expect(request).toContain("[p. 1]");
    expect(request).toContain("13: Total GBP 1,800.00");
    expect(request).toContain("record_vendor_bill");
    expect(request).toMatch(/not instructions/u);
  });

  it("names the customer, not the vendor, on a customer invoice", async () => {
    const { vendor, vendor_address, ...rest } = CLEAN_BILL;
    const model = extractionModel({
      ...rest,
      customer: vendor ?? null,
      customer_address: vendor_address ?? null,
    });
    const result = await extractDocument(
      { bytes: fixture("scanned-bill.pdf"), mimeType: PDF },
      "customer_invoice",
      model,
    );
    expect(result.partyRole).toBe("customer");
    expect(JSON.stringify(model.requests[0])).toContain("record_customer_invoice");
  });

  it("extracts a PDF with a text layer through a text-only model, sending no image", async () => {
    const model = extractionModel(
      {
        vendor: cited("Northwind Supplies Ltd", 1),
        vendor_address: cited(null, null),
        document_number: cited("NW-2041", 2),
        issue_date: cited("2026-10-02", 4),
        due_date: cited(null, null),
        currency: cited("EUR", 1, 3),
        line_items: [
          {
            description: "Copier paper A4",
            quantity: null,
            unit_price: null,
            amount: "180.00",
            page: 2,
            line: 2,
          },
          {
            description: "Toner cartridge",
            quantity: null,
            unit_price: null,
            amount: "240.00",
            page: 2,
            line: 3,
          },
        ],
        subtotal: cited(null, null),
        tax_lines: [],
        total: cited("420.00", 1, 3),
        payment_terms: cited("30 days from the invoice date", 2, 3),
      },
      { input: ["text"] },
    );
    const result = await extractDocument(
      { bytes: fixture("vendor-bill.pdf"), mimeType: PDF },
      "vendor_bill",
      model,
    );
    expect(JSON.stringify(model.requests[0])).not.toContain('"type":"image"');
    expect(result.pages.map((page) => page.source)).toEqual([
      "text-layer",
      "text-layer",
      "text-layer",
    ]);
    expect(result.fields.total.source).toEqual({ page: 3, line: 1, text: "Total due: 420.00 EUR" });
    // No subtotal is printed, so the arithmetic cannot be checked: unverified, never assumed.
    expect(result.status).toBe("unverified");
    expect(failed(result)).toEqual(["lines-subtotal", "subtotal-tax-total"]);
  });

  it("refuses a scan when the model cannot see images, instead of switching models", async () => {
    const model = extractionModel(CLEAN_BILL, { input: ["text"] });
    await expect(
      extractDocument({ bytes: fixture("scanned-bill.pdf"), mimeType: PDF }, "vendor_bill", model),
    ).rejects.toMatchObject({ code: "model-not-vision" });
    expect(model.requests).toHaveLength(0);
  });

  it("refuses a model the collection does not have", async () => {
    const model = extractionModel(CLEAN_BILL);
    await expect(
      extractDocument(
        { bytes: fixture("handwritten-note.png"), mimeType: "image/png" },
        "receipt",
        {
          models: model.models,
          model: { provider: "nowhere", modelId: "none" },
        },
      ),
    ).rejects.toMatchObject({ code: "model-unavailable" });
  });

  it("withholds a value that cites no page, or a page the document does not have", async () => {
    const model = extractionModel({
      ...CLEAN_BILL,
      vendor_address: { value: "12 Harbour Road", page: null, line: null },
      payment_terms: cited("30 days", 1, 4),
    });
    const result = await extractDocument(
      { bytes: fixture("scanned-bill.pdf"), mimeType: PDF },
      "vendor_bill",
      model,
    );
    expect(result.fields.partyAddress).toEqual({ value: null, source: null });
    expect(result.fields.paymentTerms).toEqual({ value: null, source: null });
    expect(result.status).toBe("unverified");
    const sources = result.checks.find((check) => check.name === "sources");
    expect(sources?.result).toBe("fail");
    expect(sources?.message).toContain("vendor_address");
    expect(sources?.message).toContain("payment_terms");
  });

  it("keeps the page but no quoted text when the cited line does not exist", async () => {
    const model = extractionModel({ ...CLEAN_BILL, vendor: cited("Brightway Cleaning Ltd", 99) });
    const result = await extractDocument(
      { bytes: fixture("scanned-bill.pdf"), mimeType: PDF },
      "vendor_bill",
      model,
    );
    expect(result.fields.party.source).toEqual({ page: 1, line: null, text: null });
  });

  it("surfaces a provider failure", async () => {
    const model = extractionModel(() =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream unavailable" }),
    );
    await expect(
      extractDocument(
        { bytes: fixture("handwritten-note.png"), mimeType: "image/png" },
        "receipt",
        model,
      ),
    ).rejects.toMatchObject({
      code: "model-error",
      message: expect.stringContaining("upstream unavailable"),
    });
  });

  it("refuses an answer that does not call the tool, or does not match the schema", async () => {
    const silent = extractionModel(() => fauxAssistantMessage("It is a receipt."));
    await expect(
      extractDocument(
        { bytes: fixture("handwritten-note.png"), mimeType: "image/png" },
        "receipt",
        silent,
      ),
    ).rejects.toMatchObject({ code: "model-invalid-answer" });

    const wrong = extractionModel({ ...CLEAN_BILL, total: 1800, line_items: "two" });
    await expect(
      extractDocument({ bytes: fixture("scanned-bill.pdf"), mimeType: PDF }, "vendor_bill", wrong),
    ).rejects.toMatchObject({
      code: "model-invalid-answer",
      message: expect.stringMatching(/\/total.*\/line_items|\/line_items.*\/total/su),
    });
  });
});

/** What a careful model reads off `text-bill.pdf`, line numbers from its text layer. */
const TEXT_BILL: JsonObject = {
  vendor: cited("Harbourside Stationers Ltd", 1),
  vendor_address: cited("21 Dock Road, Hull HU1 2AA", 2),
  document_number: cited("HS-3301", 3),
  issue_date: cited("2026-11-10", 4),
  due_date: cited("2026-12-10", 5),
  currency: cited("GBP", 12),
  line_items: [
    {
      description: "Copier paper A4 (boxes)",
      quantity: "10",
      unit_price: "4.50",
      amount: "45.00",
      page: 1,
      line: 8,
    },
    {
      description: "Toner cartridge",
      quantity: "1",
      unit_price: "120.00",
      amount: "120.00",
      page: 1,
      line: 9,
    },
  ],
  subtotal: cited("165.00", 10),
  tax_lines: [{ label: "VAT", rate: "20%", amount: "33.00", page: 1, line: 11 }],
  total: cited("198.00", 12),
  payment_terms: cited("30 days from the invoice date", 13),
};

describe("a text-layer bill and a text-only model", () => {
  it("a clean bill with a text layer is checked by a model that cannot read images", async () => {
    const model = extractionModel(TEXT_BILL, { input: ["text"] });
    const result = await extractDocument(
      { bytes: fixture("text-bill.pdf"), mimeType: PDF, name: "text-bill.pdf" },
      "vendor_bill",
      model,
    );
    expect(failed(result)).toEqual([]);
    expect(result.status).toBe("checked");
    expect(result.pages).toEqual([{ number: 1, source: "text-layer", confidence: null }]);
    expect(result.fields.total.source).toEqual({ page: 1, line: 12, text: "Total GBP: 198.00" });
    expect(JSON.stringify(model.requests[0])).not.toContain('"type":"image"');
  });

  it("reports the model call's usage and cost", async () => {
    const result = await extractDocument(
      { bytes: fixture("text-bill.pdf"), mimeType: PDF },
      "vendor_bill",
      extractionModel(TEXT_BILL, { input: ["text"] }),
    );
    expect(result.usage).toMatchObject({
      totalTokens: expect.any(Number),
      cost: { total: expect.any(Number) },
    });
  });

  it("refuses a photo for a text-only model before running OCR on it", async () => {
    const model = extractionModel(CLEAN_BILL, { input: ["text"] });
    const started = Date.now();
    await expect(
      extractDocument(
        { bytes: fixture("handwritten-note.png"), mimeType: "image/png" },
        "receipt",
        model,
      ),
    ).rejects.toMatchObject({ code: "model-not-vision" });
    // OCR takes the better part of a second; the refusal comes from the format alone.
    expect(Date.now() - started).toBeLessThan(300);
  });
});

describe("time limits", () => {
  it("the reading limit covers reading only: a model slower than it still answers", async () => {
    const model = extractionModel(TEXT_BILL, { input: ["text"], delayMs: 600 });
    const result = await extractDocument(
      { bytes: fixture("text-bill.pdf"), mimeType: PDF },
      "vendor_bill",
      model,
      { limits: { ...DEFAULT_READING_LIMITS, timeoutMs: 300 } },
    );
    expect(result.status).toBe("checked");
  });

  it("the model call has its own limit, which names the model call", async () => {
    const model = extractionModel(TEXT_BILL, { input: ["text"], delayMs: 2_000 });
    await expect(
      extractDocument({ bytes: fixture("text-bill.pdf"), mimeType: PDF }, "vendor_bill", {
        ...model,
        timeoutMs: 200,
      }),
    ).rejects.toMatchObject({
      code: "model-timeout",
      message: expect.stringMatching(/model call to scripted-vision\/vision-1.*0\.2 s/su),
    });
  });

  it("defaults the model limit to 180 s, and a host may lower it but never raise it", () => {
    expect(MODEL_TIMEOUT_MS).toBe(180_000);
    expect(modelTimeout({ timeoutMs: 10 * MODEL_TIMEOUT_MS })).toBe(MODEL_TIMEOUT_MS);
    expect(modelTimeout({ timeoutMs: 5_000 })).toBe(5_000);
    expect(modelTimeout({})).toBe(MODEL_TIMEOUT_MS);
  });
});
