/**
 * The pack in a fixture role, in a bare Pi Durable harness: in-memory storage, a scripted model, and
 * nothing from Office Hum. The role passes `checkAgent`; a conversation reads a PDF, an email and
 * (with a provisioned interpreter) a Word document and a workbook through the real tools.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { checkAgent, localVersionedFileStore, type VersionedFileStore } from "@officehum/sdk";
import {
  type DocumentLease,
  localDocumentService,
  runLedger,
  subprocessPaperWorker,
} from "@officehum/tools-paper-office";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  callTools,
  cited,
  configuredInterpreter,
  extractionModel,
  FIXTURE_MANIFEST,
  fixture,
  leasedInput,
  leaseOf,
  putFixture,
  readingDesk,
  scriptedModel,
} from "./test-helpers.js";
import { documentReadingPack } from "./tools.js";

const interpreter = configuredInterpreter();

/** What the scripted extraction model reads off `receipt-photo.jpg`. */
const RECEIPT = {
  vendor: cited("Corner Cafe", 1),
  vendor_address: cited(null, null),
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
};
const CTX = BACKGROUND_CONTEXT;

let root = "";
let store: VersionedFileStore;
let lease: DocumentLease;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "documents-harness-"));
  store = localVersionedFileStore(join(root, "files"));
  lease = leaseOf([]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function role() {
  const pack = documentReadingPack({
    extraction: extractionModel(RECEIPT),
    service: localDocumentService({
      store,
      worker: subprocessPaperWorker({ interpreter: interpreter ?? "", graceSeconds: 30 }),
      ledger: runLedger(join(root, "ledger")),
      createdBy: "role:reading-desk",
    }),
    leaseFor: async () => lease,
    filesFor: async () => store,
    createdBy: "role:reading-desk",
  });
  return readingDesk(pack.tools);
}

async function open() {
  const model = scriptedModel();
  const desk = role();
  const registry = createRegistry();
  for (const extension of desk.extensions) registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models: model.models, registry }, CTX);
  const conversation = await harness.root(CTX, { agent: desk.agent });
  return { model, harness, conversation };
}

describe("the fixture role", () => {
  it("passes checkAgent with the pack's four tools", async () => {
    expect((await checkAgent(role(), FIXTURE_MANIFEST, { strict: true })).issues).toEqual([]);
  });

  it("reads, outlines and searches a PDF and an email in a bare harness", async () => {
    const bill = await putFixture(store, "vendor-bill.pdf", "pdf");
    const email = await putFixture(store, "forwarded-bill.eml", "eml", "external");
    const { model, harness, conversation } = await open();
    const [outline, read, search, mail] = await callTools(model, conversation, [
      { tool: "document_outline", args: { file_id: bill.id } },
      { tool: "document_read", args: { file_id: bill.id, pages: "3" } },
      { tool: "document_search", args: { file_id: bill.id, query: "toner" } },
      { tool: "document_read", args: { file_id: email.id } },
    ]);
    expect(outline).toContain("p. 3:");
    expect(read).toContain("[p. 3]");
    expect(read).not.toContain("[p. 1]");
    expect(search).toContain("[p. 2] Toner cartridge, 2 units: 240.00");
    expect(mail).toContain("outside the office");
    expect(mail).toContain("NW-2042.pdf (application/pdf, 694 bytes): ");
    await harness.close(CTX);
  });

  it("extracts a receipt photo in a bare harness, checked by code", async () => {
    const photo = await store.put({
      bytes: fixture("receipt-photo.jpg"),
      name: "receipt.jpg",
      mimeType: "image/jpeg",
      metadata: { createdBy: "person:test", source: "uploaded" },
    });
    const { model, harness, conversation } = await open();
    const [extracted] = await callTools(model, conversation, [
      { tool: "document_extract", args: { file_id: photo.id, kind: "receipt" } },
    ]);
    expect(extracted).toContain('"status": "checked"');
    expect(extracted).toContain('"text": "TOTAL EUR 10.20"');
    await harness.close(CTX);
  });
});

describe.skipIf(interpreter === undefined)("Word and Excel in a bare harness", () => {
  it("reads leased Office files through the Paper worker and leaves the sources unchanged", async () => {
    const contract = await putFixture(store, "contract.docx", "docx");
    const prices = await putFixture(store, "price-list.xlsx", "xlsx");
    lease = leaseOf([leasedInput(contract, "docx"), leasedInput(prices, "xlsx")]);
    const { model, harness, conversation } = await open();
    const [word, excel, unleased] = await callTools(model, conversation, [
      { tool: "document_read", args: { file_id: contract.id } },
      { tool: "document_read", args: { file_id: prices.id, sheet: "Prices" } },
      { tool: "document_outline", args: { file_id: "file_not_leased" } },
    ]);
    expect(word).toContain("[s. 3, word/document.xml#3]");
    expect(word).toContain("| Office cleaning | 1,200.00 |");
    expect(excel).toContain("[sheet: Prices]");
    expect(excel).toContain("449.25 (=SUM(D2:D4))");
    expect(unleased).toMatch(/not-found|ungranted-input/u);
    for (const [ref, name] of [
      [contract, "contract.docx"],
      [prices, "price-list.xlsx"],
    ] as const) {
      const stored = await store.getVersion(ref.id, ref.versionId);
      const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
      expect(hash(stored?.bytes ?? new Uint8Array())).toBe(hash(fixture(name)));
    }
    await harness.close(CTX);
  }, 60_000);
});
