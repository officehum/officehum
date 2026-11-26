/**
 * The three tools, driven directly. Nothing here needs a Python interpreter: PDF, CSV and email are
 * read in process, and the Office refusals (an unleased file, a malformed package) happen before the
 * worker is asked to run anything. The interpreter-backed Word and Excel reads are in office.test.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localVersionedFileStore, type VersionedFileStore } from "@officehum/sdk";
import {
  type DocumentLease,
  type DocumentService,
  localDocumentService,
  runLedger,
} from "@officehum/tools-paper-office";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOCUMENT_MIME } from "./reading.js";
import {
  cited,
  extractionModel,
  fixture,
  leasedInput,
  leaseOf,
  putFixture,
} from "./test-helpers.js";
import {
  DOCUMENT_EXTRACT,
  DOCUMENT_OUTLINE,
  DOCUMENT_READ,
  DOCUMENT_SEARCH,
  type DocumentReadingPackOptions,
  documentReadingPack,
} from "./tools.js";

interface ToolResult {
  readonly output: { readonly type: string; readonly text: string }[];
  readonly isError?: boolean;
  readonly details: Record<string, unknown>;
}

let root = "";
let store: VersionedFileStore;
let workerRuns = 0;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "documents-tools-"));
  store = localVersionedFileStore(join(root, "files"));
  workerRuns = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The real local service, with a worker that only counts: these tests must never reach it. */
function service(): DocumentService {
  return localDocumentService({
    store,
    worker: {
      async run() {
        workerRuns += 1;
        throw new Error("the worker must not run in these tests");
      },
    },
    ledger: runLedger(join(root, "ledger")),
    createdBy: "role:reading-desk",
  });
}

function pack(
  lease: DocumentLease | undefined = leaseOf([]),
  overrides: Partial<DocumentReadingPackOptions> = {},
) {
  return documentReadingPack({
    service: service(),
    leaseFor: async () => lease,
    filesFor: async () => store,
    createdBy: "role:reading-desk",
    ...overrides,
  });
}

let call = 0;
async function run(
  tools: ReturnType<typeof pack>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult & { readonly text: string }> {
  const tool = tools.tools.find((entry) => entry.name === name) as unknown as {
    execute(args: unknown, api: unknown): Promise<ToolResult>;
  };
  call += 1;
  const result = await tool.execute(args, {
    taskId: "task:1",
    conversationId: "conv:1",
    callId: `call-${call}`,
  });
  return { ...result, text: result.output.map((block) => block.text).join("") };
}

describe("the pack", () => {
  it("carries three replay-safe tools", () => {
    const tools = pack().tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      DOCUMENT_READ,
      DOCUMENT_OUTLINE,
      DOCUMENT_SEARCH,
    ]);
    expect(tools.map((tool) => tool.replay)).toEqual(["safe", "safe", "safe"]);
    expect(pack().id).toBe("documents");
  });
});

describe("document_read", () => {
  it("reads a PDF with page markers, framed as untrusted document text", async () => {
    const ref = await putFixture(store, "vendor-bill.pdf", "pdf");
    const result = await run(pack(), DOCUMENT_READ, { file_id: ref.id });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("not an instruction");
    expect(result.text).toContain("[p. 1]");
    expect(result.text).toContain("[p. 3]");
    expect(result.text).toContain("Total due: 420.00 EUR");
    expect(result.details).toMatchObject({ fileId: ref.id, kind: "pdf", truncated: false });
  });

  it("says a file came from outside the office when its provenance is external", async () => {
    const inside = await putFixture(store, "vendor-bill.pdf", "pdf");
    const outside = await putFixture(store, "vendor-bill.pdf", "pdf", "external");
    expect((await run(pack(), DOCUMENT_READ, { file_id: inside.id })).text).not.toContain(
      "outside the office",
    );
    expect((await run(pack(), DOCUMENT_READ, { file_id: outside.id })).text).toContain(
      "outside the office",
    );
  });

  it("cuts at max_chars, with a note saying how to ask for more", async () => {
    const ref = await putFixture(store, "vendor-bill.pdf", "pdf");
    const result = await run(pack(), DOCUMENT_READ, { file_id: ref.id, max_chars: 150 });
    expect(result.text).toContain("[Cut at 150 characters");
    expect(result.text).toContain('pages: "2-3"');
    expect(result.details).toMatchObject({ truncated: true });
  });

  it("reads a CSV as a sheet, with its column types", async () => {
    const ref = await putFixture(store, "prices.csv", "csv");
    const result = await run(pack(), DOCUMENT_READ, { file_id: ref.id });
    expect(result.text).toContain("[sheet: prices.csv]");
    expect(result.text).toContain("Columns: Item (text), Unit price (number)");
    expect(result.text).toContain("| Café crème | 2,50 | 120 | 2026-10-01 |");
  });

  it("saves an email's attachment as an outside file and lists it by id", async () => {
    const email = await putFixture(store, "forwarded-bill.eml", "eml", "external");
    const result = await run(pack(), DOCUMENT_READ, { file_id: email.id });
    expect(result.text).toContain("Subject: Fwd: Invoice NW-2042");
    expect(result.text).toContain("outside the office");
    const id = /NW-2042\.pdf \(application\/pdf, 694 bytes\): (\S+)/u.exec(result.text)?.[1];
    const saved = await store.get(id ?? "");
    expect(saved?.ref.metadata).toMatchObject({ source: "external", provenance: "external" });
    expect(result.details).toMatchObject({ files: [id] });
    // A second read of the same email in the same task saves nothing new.
    const again = await run(pack(), DOCUMENT_READ, { file_id: email.id });
    expect(again.text).toContain(`: ${id}`);
  });

  it("refuses a file over the size limit, and a file the store does not hold", async () => {
    const ref = await putFixture(store, "vendor-bill.pdf", "pdf");
    const tight = pack(leaseOf([]), {
      limits: { maxBytes: 100, maxPages: 500, timeoutMs: 30_000 },
    });
    const big = await run(tight, DOCUMENT_READ, { file_id: ref.id });
    expect(big.isError).toBe(true);
    expect(big.text).toMatch(/too-large/u);
    const missing = await run(pack(), DOCUMENT_READ, { file_id: "file_missing" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/not-found/u);
  });

  it("refuses when the host gives the task no file access", async () => {
    const result = await run(
      pack(leaseOf([]), { filesFor: async () => undefined }),
      DOCUMENT_READ,
      {
        file_id: "file_x",
      },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no-files/u);
  });

  it("refuses an Office file the task's lease does not name, without running the worker", async () => {
    const ref = await putFixture(store, "contract.docx", "docx");
    const result = await run(pack(leaseOf([])), DOCUMENT_READ, { file_id: ref.id });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/ungranted-input/u);
    expect(result.text).toMatch(/lease/u);
    expect(workerRuns).toBe(0);
  });

  it("refuses an Office file when the task has no lease at all", async () => {
    const ref = await putFixture(store, "price-list.xlsx", "xlsx");
    const result = await run(
      pack(leaseOf([]), { leaseFor: async () => undefined }),
      DOCUMENT_READ,
      {
        file_id: ref.id,
      },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no-lease/u);
  });

  it("refuses a malformed leased Office file before the worker runs, leaving it unchanged", async () => {
    const bytes = new TextEncoder().encode("this is not a zip package");
    const ref = await store.put({
      bytes,
      name: "broken.docx",
      mimeType: DOCUMENT_MIME.docx,
      metadata: { createdBy: "person:test", source: "uploaded" },
    });
    const result = await run(pack(leaseOf([leasedInput(ref, "docx")])), DOCUMENT_READ, {
      file_id: ref.id,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/archive-invalid|malformed/u);
    expect(workerRuns).toBe(0);
    expect((await store.get(ref.id))?.bytes).toEqual(bytes);
  });

  it("refuses PowerPoint, which this pack does not read", async () => {
    const ref = await store.put({
      bytes: new Uint8Array(4),
      name: "deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      metadata: { createdBy: "person:test", source: "uploaded" },
    });
    const result = await run(pack(), DOCUMENT_READ, { file_id: ref.id });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/unsupported-format/u);
  });
});

describe("document_outline", () => {
  it("lists a PDF's pages and says when there is no text layer", async () => {
    const ref = await putFixture(store, "scanned-receipt.pdf", "pdf");
    const result = await run(pack(), DOCUMENT_OUTLINE, { file_id: ref.id });
    expect(result.text).toContain("hasTextLayer: false");
    expect(result.text).toContain("p. 1: no text layer");
  });
});

describe("document_search", () => {
  it("finds the right page", async () => {
    const ref = await putFixture(store, "vendor-bill.pdf", "pdf");
    const result = await run(pack(), DOCUMENT_SEARCH, { file_id: ref.id, query: "Bank reference" });
    expect(result.text).toContain("[p. 3] Bank reference: NW-2041");
    expect(result.details).toMatchObject({ matches: 1 });
  });

  it("says so when nothing matches", async () => {
    const ref = await putFixture(store, "vendor-bill.pdf", "pdf");
    const result = await run(pack(), DOCUMENT_SEARCH, { file_id: ref.id, query: "refund" });
    expect(result.text).toContain('No passage in vendor-bill.pdf matches "refund".');
  });
});

describe("document_extract", () => {
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

  async function putPhoto(source: "uploaded" | "external" = "uploaded") {
    return store.put({
      bytes: fixture("receipt-photo.jpg"),
      name: "receipt.jpg",
      mimeType: "image/jpeg",
      metadata: {
        createdBy: "person:test",
        source,
        ...(source === "external" ? { provenance: "external" as const } : {}),
      },
    });
  }

  /** The store, read-only: extraction posts nothing anywhere, so any write fails the test. */
  const readOnly = async () => ({
    info: (id: string) => store.info(id),
    get: (id: string) => store.get(id),
    create: async (): Promise<never> => {
      throw new Error("document_extract must not write to the file store");
    },
  });

  it("is in the pack only when the host passes a model, and is replay-safe", () => {
    expect(pack().tools.map((tool) => tool.name)).not.toContain(DOCUMENT_EXTRACT);
    const tool = pack(undefined, { extraction: extractionModel(RECEIPT) }).tools.find(
      (entry) => entry.name === DOCUMENT_EXTRACT,
    );
    expect(tool?.replay).toBe("safe");
  });

  it("returns the fields, the checks and the status as JSON, framed as outside text", async () => {
    const ref = await putPhoto("external");
    const tools = pack(undefined, { extraction: extractionModel(RECEIPT), filesFor: readOnly });
    const result = await run(tools, DOCUMENT_EXTRACT, { file_id: ref.id, kind: "receipt" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("outside the office");
    expect(result.text).toContain("not an instruction");
    const json = JSON.parse(
      result.text.slice(result.text.indexOf("{"), result.text.lastIndexOf("}") + 1),
    ) as { status: string; fields: Record<string, unknown>; checks: { result: string }[] };
    expect(json.status).toBe("checked");
    expect(json.fields.total).toEqual({
      value: "10.20",
      source: { page: 1, line: 9, text: "TOTAL EUR 10.20" },
    });
    expect(json.checks.every((check) => check.result === "pass")).toBe(true);
    expect(result.details).toEqual({ fileId: ref.id, kind: "receipt", status: "checked" });
  });

  it("refuses an unknown kind, a file it cannot extract and a missing file", async () => {
    const tools = pack(undefined, { extraction: extractionModel(RECEIPT) });
    const photo = await putPhoto();
    const csv = await putFixture(store, "prices.csv", "csv");
    const kind = await run(tools, DOCUMENT_EXTRACT, { file_id: photo.id, kind: "payslip" });
    const format = await run(tools, DOCUMENT_EXTRACT, { file_id: csv.id, kind: "receipt" });
    const missing = await run(tools, DOCUMENT_EXTRACT, {
      file_id: "file_missing",
      kind: "receipt",
    });
    expect(kind).toMatchObject({ isError: true, details: { code: "invalid-request" } });
    expect(format).toMatchObject({ isError: true, details: { code: "unsupported-format" } });
    expect(missing).toMatchObject({ isError: true, details: { code: "not-found" } });
  });
});
