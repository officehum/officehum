/**
 * `renderDocument` without the real compiler or worker: a fake `typst`, a real local file store and
 * a recording `DocumentService`. What reaches Typst, what the store records, one file per operation
 * ID, and that a refusal writes nothing. The real compiler and worker are in `typst-real.test.ts`
 * and `office-real.test.ts`.
 */

import { join } from "node:path";
import { localVersionedFileStore, type VersionedFileStore } from "@officehum/sdk";
import type { DocumentRunRequest, DocumentService } from "@officehum/tools-paper-office";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocgenError } from "./errors.js";
import { type DocumentGeneratorOptions, documentGenerator } from "./generator.js";
import { sampleData } from "./schema.js";
import { builtinTemplates } from "./templates.js";
import { type FakeTypst, fakeTypst, leaseFor, removeTempDirs, tempDir } from "./test-helpers.js";

let store: VersionedFileStore;
let typst: FakeTypst;

beforeEach(() => {
  store = localVersionedFileStore(join(tempDir(), "files"));
  typst = fakeTypst();
});
afterEach(removeTempDirs);

const statement = () =>
  structuredClone(
    sampleData(
      builtinTemplates().find((entry) => entry.name === "customer-statement")?.schema ?? {},
    ),
  ) as Record<string, unknown>;

function generator(overrides: Partial<DocumentGeneratorOptions> = {}) {
  return documentGenerator({ store, typst: typst.binary, createdBy: "role:test", ...overrides });
}

const request = (overrides: Record<string, unknown> = {}) => ({
  template: "customer-statement",
  data: statement(),
  format: "pdf" as const,
  name: "statement-november",
  operationId: "conv:1:call-1",
  taskId: "task:1",
  ...overrides,
});

async function refusal(promise: Promise<unknown>): Promise<DocgenError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DocgenError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("a PDF", () => {
  it("is compiled from the template, its data and the brand, and saved as a generated draft", async () => {
    const rendered = await generator({
      branding: { companyName: "Acme Supplies", primaryColor: "#0b5394" },
    }).renderDocument(request());
    const template = builtinTemplates().find((entry) => entry.name === "customer-statement");
    expect(rendered.ref).toMatchObject({
      name: "statement-november.pdf",
      mimeType: "application/pdf",
      metadata: {
        createdBy: "role:test",
        source: "generated",
        template: { name: "customer-statement", version: template?.version },
      },
      operationId: "conv:1:call-1",
      context: { taskId: "task:1", worker: { image: "typst:0.13.1" } },
    });
    expect(rendered.template).toEqual({
      name: "customer-statement",
      version: template?.version,
      origin: "builtin",
    });
    expect(rendered.preview?.mimeType).toBe("image/png");

    const [pdf, png] = typst.runs();
    expect(Object.keys(pdf?.files ?? {}).sort()).toEqual([
      "_officehum.typ",
      "brand.json",
      "customer-statement.typ",
      "data.json",
    ]);
    expect(JSON.parse(pdf?.files["data.json"] ?? "")).toEqual(statement());
    expect(JSON.parse(pdf?.files["brand.json"] ?? "")).toEqual({
      companyName: "Acme Supplies",
      address: [],
      primaryColor: "#0B5394",
      accentColor: "#52606D",
      textColor: "#1F2933",
      font: "Libertinus Serif",
      logo: null,
    });
    expect(png?.args).toContain("png");
  });

  it("is one file per operation ID: a replay returns it and renders nothing again", async () => {
    const first = await generator().renderDocument(request());
    const runs = typst.runs().length;
    const again = await generator().renderDocument(request());
    expect(again.ref).toEqual(first.ref);
    // Only the preview is drawn again; the document is not compiled a second time.
    expect(
      typst
        .runs()
        .slice(runs)
        .map((run) => run.args[6]),
    ).toEqual(["png"]);
    const receipt = await store.lookupOperation("conv:1:call-1");
    expect(receipt?.kind === "create" && receipt.output.id).toBe(first.ref.id);
  });

  it("refuses a replay of an operation that saved another document", async () => {
    await generator().renderDocument(request());
    const error = await refusal(generator().renderDocument(request({ name: "other" })));
    expect(error.code).toBe("store-error");
  });

  it("copies the branding's logo into the compile directory, and only a PNG or JPEG", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const logo = await store.put({
      bytes: png,
      name: "logo.png",
      mimeType: "image/png",
      metadata: { createdBy: "person:owner", source: "uploaded" },
    });
    await generator({ branding: { logoFileId: logo.id } }).renderDocument(request());
    const files = typst.runs()[0]?.files ?? {};
    expect(JSON.parse(files["brand.json"] ?? "").logo).toBe("_logo.png");
    expect(Buffer.from(files["_logo.png"] ?? "", "latin1")).toEqual(Buffer.from(png));

    const text = await store.put({
      bytes: new TextEncoder().encode("not an image"),
      name: "notes.txt",
      mimeType: "text/plain",
      metadata: { createdBy: "person:owner", source: "uploaded" },
    });
    const error = await refusal(
      generator({ branding: { logoFileId: text.id } }).renderDocument(
        request({ operationId: "conv:1:call-2" }),
      ),
    );
    expect(error.code).toBe("invalid-branding");
  });

  it("omits a preview over 100 KB rather than sending it, at the lowest resolution that fits", async () => {
    const big = generator({
      templates: [
        {
          name: "poster",
          source: "FAKE_BIG_PNG",
          schema: { type: "object" },
          layer: "overlay acme",
          file: "overlay acme/templates/poster.typ",
        },
      ],
    });
    const rendered = await big.renderDocument(request({ template: "poster", data: {} }));
    expect(rendered.preview?.bytes.byteLength).toBeLessThanOrEqual(100_000);
    expect(
      typst
        .runs()
        .filter((run) => run.args.includes("png"))
        .map((run) => run.args[10]),
    ).toEqual(["72", "48", "32"]);
  });

  it("refuses a document over the page limit, and saves nothing", async () => {
    const long = generator({
      limits: { maxPages: 3 },
      templates: [
        {
          name: "long",
          source: "FAKE_PAGES=4",
          schema: { type: "object" },
          layer: "overlay acme",
          file: "overlay acme/templates/long.typ",
        },
      ],
    });
    const error = await refusal(long.renderDocument(request({ template: "long", data: {} })));
    expect(error.code).toBe("page-limit");
    expect(await store.lookupOperation("conv:1:call-1")).toBeUndefined();
  });

  it("reports a compile error with the compiler's message, and saves nothing", async () => {
    const broken = generator({
      templates: [
        {
          name: "broken",
          source: "FAKE_ERROR",
          schema: { type: "object" },
          layer: "overlay acme",
          file: "overlay acme/templates/broken.typ",
        },
      ],
    });
    const error = await refusal(broken.renderDocument(request({ template: "broken", data: {} })));
    expect(error.code).toBe("compile-failed");
    expect(error.message).toBe(
      "the broken template did not compile: broken.typ:2:5: error: unknown variable: nope",
    );
    expect(await store.lookupOperation("conv:1:call-1")).toBeUndefined();
  });

  it("says so when Typst is missing or at another version", async () => {
    expect(
      (await refusal(generator({ typst: join(tempDir(), "typst") }).renderDocument(request())))
        .code,
    ).toBe("typst-missing");
    expect(
      (await refusal(generator({ typst: fakeTypst("0.11.0").binary }).renderDocument(request())))
        .code,
    ).toBe("typst-version");
  });
});

describe("data that does not fit", () => {
  it("gets every field-level problem, and nothing is rendered or saved", async () => {
    const data = statement();
    delete data.currency;
    (data.lines as Record<string, unknown>[])[0] = {
      ...(data.lines as Record<string, unknown>[])[0],
      charges: "1077.84",
    };
    const error = await refusal(generator().renderDocument(request({ data })));
    expect(error.code).toBe("invalid-data");
    expect(error.problems).toEqual([
      { path: "data", message: "is missing currency" },
      { path: "data.lines[0].charges", message: "must be number" },
    ]);
    expect(typst.runs()).toEqual([]);
    expect(await store.lookupOperation("conv:1:call-1")).toBeUndefined();
  });

  it("refuses totals that do not match the lines, the way no schema can", async () => {
    const data = statement();
    data.totals = { charges: 999, payments: 1250 };
    const error = await refusal(generator().renderDocument(request({ data })));
    expect(error.problems.map((problem) => problem.path)).toEqual(["data.totals.charges"]);
    expect(typst.runs()).toEqual([]);
  });

  it("refuses an unknown template, a format it does not render, and a name with a folder", async () => {
    expect((await refusal(generator().renderDocument(request({ template: "invoice" })))).code).toBe(
      "unknown-template",
    );
    expect(
      (await refusal(generator().renderDocument(request({ template: "letter", format: "xlsx" }))))
        .code,
    ).toBe("unsupported-format");
    expect((await refusal(generator().renderDocument(request({ name: "../etc/x" })))).code).toBe(
      "invalid-request",
    );
  });
});

describe("Word and Excel", () => {
  function recordingService(): DocumentService & { calls: DocumentRunRequest[] } {
    const calls: DocumentRunRequest[] = [];
    return {
      calls,
      async runDocumentPython(run) {
        calls.push(run);
        return {
          kind: "refused",
          operationId: run.operationId,
          code: "worker-crash",
          message: "stopped",
        };
      },
    };
  }

  it("run the worker's own create program on the task's lease, with the template bound in", async () => {
    const service = recordingService();
    const error = await refusal(
      generator({ service }).renderDocument(request({ format: "xlsx", lease: leaseFor() })),
    );
    // The fake worker refuses, and its refusal reaches the caller unchanged.
    expect(error.code).toBe("worker-crash");
    const [call] = service.calls;
    expect(call?.operationId).toBe("conv:1:call-1");
    expect(call?.code).toContain('xlsx_adapter.run("create"');
    expect(call?.template).toEqual({
      name: "customer-statement",
      version: builtinTemplates().find((entry) => entry.name === "customer-statement")?.version,
    });
    expect(call?.arguments.output).toBe("statement-november.xlsx");
  });

  it("refuse without a lease, or with one that does not permit the format", async () => {
    const service = recordingService();
    expect(
      (await refusal(generator({ service }).renderDocument(request({ format: "docx" })))).code,
    ).toBe("no-lease");
    expect(
      (
        await refusal(
          generator({ service }).renderDocument(
            request({ format: "docx", lease: leaseFor(["xlsx"]) }),
          ),
        )
      ).code,
    ).toBe("output-format");
    expect(
      (await refusal(generator().renderDocument(request({ format: "docx", lease: leaseFor() }))))
        .code,
    ).toBe("no-service");
    expect(service.calls).toEqual([]);
  });
});
