/**
 * The real Typst, at the pinned version. These need `typst` 0.13.1 on the PATH or in
 * `OFFICEHUM_TYPST`, and skip visibly without it, as the Paper suites do without their interpreter.
 */

import { join } from "node:path";
import { localVersionedFileStore, type VersionedFileStore } from "@officehum/sdk";
import { readDocument } from "@officehum/tools-documents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocgenError } from "./errors.js";
import { documentGenerator } from "./generator.js";
import { formatMoney } from "./layouts.js";
import { overlayTemplateValidator } from "./overlay.js";
import { sampleData } from "./schema.js";
import { builtinTemplates } from "./templates.js";
import { configuredTypst, removeTempDirs, tempDir } from "./test-helpers.js";
import { pdfPageCount, TYPST_VERSION } from "./typst.js";

const typst = configuredTypst();
const suite = typst === undefined ? describe.skip : describe;

if (typst === undefined) {
  console.warn(
    `document generation Typst suites skipped: install Typst ${TYPST_VERSION} on the PATH or set ` +
      "OFFICEHUM_TYPST to it (see packages/tools-docgen/README.md).",
  );
}

let store: VersionedFileStore;
beforeEach(() => {
  store = localVersionedFileStore(join(tempDir(), "files"));
});
afterEach(removeTempDirs);

const overlay = (name: string, source: string) => ({
  name,
  source,
  schema: { type: "object", examples: [{}] },
  layer: "overlay acme",
  file: `overlay acme/templates/${name}.typ`,
});

function generator(templates = [] as ReturnType<typeof overlay>[], maxPages?: number) {
  return documentGenerator({
    store,
    typst: typst ?? "",
    createdBy: "role:test",
    branding: { companyName: "Acme Supplies", address: ["1 High Street", "Springfield"] },
    templates,
    ...(maxPages === undefined ? {} : { limits: { maxPages } }),
  });
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DocgenError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return "rendered";
}

const call = (template: string, data: unknown, id = template) => ({
  template,
  data,
  format: "pdf" as const,
  name: template,
  operationId: `conv:typst:${id}`,
  taskId: "task:1",
});

suite("the built-in templates, compiled", () => {
  for (const template of builtinTemplates()) {
    it(`${template.name} renders a PDF with a first-page preview`, async () => {
      const rendered = await generator().renderDocument(
        call(template.name, sampleData(template.schema)),
      );
      const stored = await store.get(rendered.ref.id);
      expect(
        Buffer.from(stored?.bytes ?? [])
          .subarray(0, 5)
          .toString(),
      ).toBe("%PDF-");
      expect(rendered.preview?.bytes.byteLength).toBeGreaterThan(0);
      expect(rendered.preview?.bytes.byteLength).toBeLessThanOrEqual(100_000);
    }, 60_000);
  }

  it("prints a customer statement's totals exactly as the data gives them", async () => {
    const template = builtinTemplates().find((entry) => entry.name === "customer-statement");
    const data = sampleData(template?.schema ?? {}) as {
      totals: { charges: number; payments: number };
      closingBalance: number;
      amountDue: number;
      openingBalance: number;
    };
    const rendered = await generator().renderDocument(call("customer-statement", data));
    const stored = await store.get(rendered.ref.id);
    const reading = await readDocument(stored?.bytes ?? new Uint8Array(), "application/pdf", {
      name: "statement.pdf",
    });
    const text = (reading.pages ?? []).map((page) => page.text).join("\n");
    for (const figure of [
      data.totals.charges,
      data.totals.payments,
      data.closingBalance,
      data.amountDue,
      data.openingBalance,
    ]) {
      expect(text).toContain(formatMoney(figure));
    }
    expect(text).toContain("Acme Supplies");
  }, 60_000);
});

suite("what a template may not reach", () => {
  it("cannot read /etc/passwd, a path above its directory, or a URL", async () => {
    const templates = [
      overlay("passwd", '#read("/etc/passwd")'),
      overlay("above", '#read("../../../../../../etc/passwd")'),
      overlay("url", '#image("https://example.com/logo.png")'),
      overlay("package", '#import "@preview/example:0.1.0": *'),
    ];
    for (const template of templates) {
      expect(await code(generator(templates).renderDocument(call(template.name, {})))).toMatch(
        /^compile-failed: /u,
      );
    }
  }, 120_000);

  it("counts pages from the PDF the way a PDF reader does", async () => {
    const pages = overlay("pages", "#for i in range(4) { [Page #(i + 1)]; pagebreak() }\nEnd");
    const rendered = await generator([pages]).renderDocument(call("pages", {}));
    const bytes = (await store.get(rendered.ref.id))?.bytes ?? new Uint8Array();
    const reading = await readDocument(bytes, "application/pdf", { name: "pages.pdf" });
    expect(pdfPageCount(bytes)).toBe(5);
    expect(reading.pages?.length).toBe(5);
  }, 60_000);

  it("renders a long statement over several pages, totals intact and the preview within 100 KB", async () => {
    const template = builtinTemplates().find((entry) => entry.name === "customer-statement");
    const data = structuredClone(sampleData(template?.schema ?? {})) as {
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
    };
    let balance = data.openingBalance;
    data.lines = Array.from({ length: 120 }, (_, index) => {
      const charges = 10 + index * 1.25;
      balance = Math.round((balance + charges) * 100) / 100;
      return {
        date: `${(index % 28) + 1} Nov 2026`,
        reference: `INV-${3000 + index}`,
        description: `Delivery ${index + 1}`,
        charges,
        payments: 0,
        balance,
      };
    });
    const charges = data.lines.reduce((sum, line) => sum + Math.round(line.charges * 100), 0) / 100;
    data.totals = { charges, payments: 0 };
    data.closingBalance = balance;
    data.amountDue = balance;
    const rendered = await generator().renderDocument(call("customer-statement", data, "long"));
    const bytes = (await store.get(rendered.ref.id))?.bytes ?? new Uint8Array();
    const reading = await readDocument(bytes, "application/pdf", { name: "long.pdf" });
    expect(reading.pages?.length).toBeGreaterThan(1);
    expect(pdfPageCount(bytes)).toBe(reading.pages?.length);
    const text = (reading.pages ?? []).map((page) => page.text).join("\n");
    expect(text).toContain(formatMoney(charges));
    expect(text).toContain(formatMoney(balance));
    expect(rendered.preview?.bytes.byteLength).toBeLessThanOrEqual(100_000);
  }, 60_000);

  it("refuses a document longer than the page limit", async () => {
    const long = overlay("long", "#for i in range(5) { pagebreak() }");
    expect(await code(generator([long], 3).renderDocument(call("long", {})))).toMatch(
      /^page-limit: /u,
    );
  }, 60_000);

  it("rejects an overlay template that does not compile, at draft time, with the compiler's message", () => {
    const check = overlayTemplateValidator({ typst: typst ?? "" });
    const [problem] = check({
      layer: "overlay acme",
      resolved: {
        templates: [overlay("broken", '#let data = json("data.json")\n#data.at("nope")')],
      },
    });
    expect(problem?.source).toBe("overlay acme/templates/broken.typ");
    expect(problem?.message).toMatch(
      /^does not compile with sample data from its schema: .*error/u,
    );
  }, 60_000);
});
