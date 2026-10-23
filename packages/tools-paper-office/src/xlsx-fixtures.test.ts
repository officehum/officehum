/**
 * The Excel fixtures, against a real interpreter: a workbook is inspected, read in pages, drafted,
 * edited into an unpublished proposal, diffed against the version it came from, and refused when it
 * carries a macro, links out of the package, or would be left with a reference pointing nowhere.
 *
 * The two configurations the issue names are both exercised. The refusal fixtures at the bottom do not
 * need an interpreter — the pack inspects the package structure in process, so an archive that is not a
 * package, one holding a VBA project, or a relationship that leaves the package is refused on any host
 * — and they run in both configurations. The rest need the pinned `paper-xlsx` and **skip visibly**
 * when `OFFICEHUM_PAPER_PYTHON` is unset, because the worker takes its interpreter from a configured
 * path and there is no safe guess.
 *
 * Preservation is argued with bytes and not by eye. Every part of the source, of the proposal and of a
 * *stock* round trip of the same source is unzipped and hashed, so "the untouched sheet came back
 * verbatim" is a sha256 comparison against both alternatives — and the fixture's untouched sheet is
 * deliberately byte-different from what a re-serialization emits, so the comparison can tell them
 * apart.
 *
 * Recalculation is reported, never faked: the result must say the oracle is unavailable here, name the
 * functions it would refuse anyway, and carry no value the adapter computed — the only number it
 * produces is its own explicit sum of cells it names, and that is checked to be exactly the sum of the
 * cells reported beside it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localVersionedFileStore,
  type VersionedFileRef,
  type VersionedFileStore,
} from "@officehum/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocumentRunOutcome, DocumentService } from "./document-service.js";
import { DEFAULT_LIMITS, type DocumentLease, type LeasedInput } from "./lease.js";
import { localDocumentService } from "./local-document-service.js";
import { subprocessPaperWorker } from "./paper-worker.js";
import { paperOfficeToolPack, RUN_DOCUMENT_PYTHON } from "./run-document-python.js";
import type { DocumentRunReceipt } from "./run-ledger.js";
import { runLedger } from "./run-ledger.js";
import {
  buildZip,
  configuredInterpreter,
  invokeWorker,
  sha256,
  textOf,
  utf8,
  xlsxFixtureCode,
  xlsxLike,
  xlsxNaiveRoundTripCode,
  xlsxPackage,
  zipEntries,
} from "./test-helpers.js";
import {
  COMPARE_WORKBOOK,
  CREATE_WORKBOOK,
  EDIT_WORKBOOK,
  INSPECT_WORKBOOK,
  PREVIEW_WORKBOOK,
  READ_WORKBOOK,
  type XlsxComparison,
  type XlsxDraft,
  type XlsxEdit,
  type XlsxInspection,
  type XlsxPreview,
  type XlsxReading,
  type XlsxResult,
} from "./xlsx-operations.js";

const interpreter = configuredInterpreter();
const suite = interpreter === undefined ? describe.skip : describe;

/**
 * A fixture test with an explicit budget. Each of these drives several real Python 3.13 subprocesses —
 * a workbook is built by one run, then read, inspected, edited or compared by more — so the default
 * five-second budget is not enough for the larger ones under a loaded suite.
 */
const itSlow = (name: string, run: () => Promise<void>): void => {
  it(name, run, 60_000);
};

if (interpreter === undefined) {
  console.warn(
    "paper Excel fixtures skipped: set OFFICEHUM_PAPER_PYTHON to a provisioned Python 3.13 " +
      "(see packages/tools-paper-office/scripts/provision-worker.sh). The refusal fixtures still run.",
  );
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** The fixed program a direct worker call submits: the same one the typed tool submits. */
const DIRECT_PROGRAM = [
  "import xlsx_adapter",
  "",
  'documents.result(xlsx_adapter.run("inspect", documents.arguments()))',
].join("\n");

/** The parts an edit of one sheet has no business touching. */
const UNTOUCHED_PARTS = [
  "xl/charts/chart1.xml",
  "xl/drawings/drawing1.xml",
  "xl/drawings/_rels/drawing1.xml.rels",
  "xl/theme/theme1.xml",
  "docProps/core.xml",
  "_rels/.rels",
];

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paper-xlsx-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Harness {
  readonly store: VersionedFileStore;
  readonly service: DocumentService;
  readonly runs: { count: number };
}

function harness(ledgerDir = join(root, "ledger")): Harness {
  const store = localVersionedFileStore(join(root, "files"));
  const runs = { count: 0 };
  const worker = subprocessPaperWorker({ interpreter: interpreter ?? "", graceSeconds: 30 });
  return {
    store,
    runs,
    service: localDocumentService({
      store,
      worker: {
        async run(request) {
          runs.count += 1;
          return worker.run(request);
        },
      },
      ledger: runLedger(ledgerDir),
      createdBy: "role:test",
      now: () => new Date("2026-10-23T00:00:00.000Z"),
    }),
  };
}

/** A service that keeps every receipt it committed, so a bare harness can be driven from the record. */
function recordingService(inner: DocumentService): DocumentService & {
  readonly receipts: DocumentRunReceipt[];
} {
  const receipts: DocumentRunReceipt[] = [];
  return {
    receipts,
    async runDocumentPython(request) {
      const outcome = await inner.runDocumentPython(request);
      if (outcome.kind === "committed") receipts.push(outcome.receipt);
      return outcome;
    },
  };
}

function committed(outcome: DocumentRunOutcome): DocumentRunReceipt {
  if (outcome.kind !== "committed") {
    throw new Error(`expected a commit, got ${outcome.code}: ${outcome.message}`);
  }
  return outcome.receipt;
}

interface FixtureOptions {
  readonly variant?: "main" | "revised";
  readonly broken?: boolean;
  readonly unmodeled?: boolean;
  readonly name?: string;
  readonly operationId: string;
}

/** A real Excel fixture, built through the worker, as the version a task would be leased. */
async function fixture(
  store: VersionedFileStore,
  service: DocumentService,
  options: FixtureOptions,
): Promise<{ readonly ref: VersionedFileRef; readonly result: Readonly<Record<string, unknown>> }> {
  const receipt = committed(
    await service.runDocumentPython({
      operationId: options.operationId,
      taskId: "task:xlsx",
      lease: {
        leaseId: "lease:fixture",
        taskId: "task:xlsx",
        inputs: [],
        outputFormats: ["xlsx"],
        limits: DEFAULT_LIMITS,
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
      code: xlsxFixtureCode(options),
      arguments: {},
    }),
  );
  const output = receipt.outputs[0];
  if (output === undefined) throw new Error("the fixture produced no workbook");
  const stored = await store.getVersion(output.fileId, output.versionId);
  if (stored === undefined) throw new Error("the fixture version is missing");
  return { ref: stored.ref, result: (receipt.result ?? {}) as Readonly<Record<string, unknown>> };
}

function leaseOf(refs: readonly VersionedFileRef[], writable = true): DocumentLease {
  const inputs: LeasedInput[] = refs.map((ref) => ({
    fileId: ref.id,
    versionId: ref.versionId,
    name: ref.name,
    format: "xlsx",
    sha256: ref.sha256,
    size: ref.size,
    writable,
  }));
  return {
    leaseId: "lease:xlsx",
    taskId: "task:xlsx",
    inputs,
    outputFormats: ["xlsx"],
    limits: DEFAULT_LIMITS,
    expiresAt: "2999-01-01T00:00:00.000Z",
  };
}

function refOf(ref: VersionedFileRef) {
  return {
    fileId: ref.id,
    versionId: ref.versionId,
    name: ref.name,
    sha256: ref.sha256,
    size: ref.size,
  };
}

interface Tool {
  execute(
    args: unknown,
    api: { taskId: string; conversationId: string; callId: string },
  ): Promise<{ output: { text: string }[]; isError?: boolean; details?: Record<string, unknown> }>;
}

function toolOf(service: DocumentService, name: string, lease: DocumentLease | undefined): Tool {
  const pack = paperOfficeToolPack({ service, leaseFor: async () => lease });
  return pack.tools.find((tool) => tool.name === name) as unknown as Tool;
}

const API = { taskId: "task:xlsx", conversationId: "conv", callId: "call-1" };

/**
 * Every call gets its own Pi Durable call identity, as a harness would: reusing one operation ID with
 * different arguments is exactly what the durable record refuses, and a test that did it by accident
 * would be testing the collision check rather than the operation.
 */
let callCounter = 0;

function nextApi() {
  callCounter += 1;
  return { ...API, callId: `call-${callCounter}` };
}

async function body<T>(
  tool: Tool,
  args: unknown,
  api = nextApi(),
): Promise<{
  ok: boolean;
  operationId: string;
  result: T;
  wrote: { fileId: string; versionId: string; sha256: string; versionOf: string | null }[];
}> {
  const answer = await tool.execute(args, api);
  if (answer.isError === true) {
    throw new Error(`the tool refused: ${answer.output[0]?.text ?? "no message"}`);
  }
  return JSON.parse(answer.output[0]?.text ?? "{}") as never;
}

async function refuse(tool: Tool, args: unknown, api = nextApi()) {
  const answer = await tool.execute(args, api);
  if (answer.isError !== true) throw new Error("expected a refusal");
  return JSON.parse(answer.output[0]?.text ?? "{}") as {
    ok: boolean;
    code: string;
    message: string;
    operationId: string;
  };
}

/** Rebuilds a real package with one part edited or added, for the fixtures the worker itself refuses. */
function rebuilt(
  bytes: Uint8Array,
  edit: (name: string, data: Uint8Array) => Uint8Array,
  extra: readonly { name: string; data: string | Uint8Array }[] = [],
): Uint8Array {
  const entries = [...zipEntries(bytes)].map(([name, data]) => ({
    name,
    data: edit(name, data),
  }));
  return buildZip([...entries, ...extra]);
}

/** A real workbook that links outside the package: a genuine external relationship in a real file. */
function withExternalLink(bytes: Uint8Array, target: string): Uint8Array {
  return rebuilt(bytes, (name, data) => {
    if (name !== "xl/_rels/workbook.xml.rels") return data;
    const relationship =
      '<Relationship Id="rIdPaperExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"' +
      ` Target="${target}" TargetMode="External"/>`;
    return utf8(textOf(data).replace("</Relationships>", `${relationship}</Relationships>`));
  });
}

/** A real workbook with a VBA project and a macro-enabled content type: what openpyxl would drop. */
function withMacro(bytes: Uint8Array): Uint8Array {
  return rebuilt(
    bytes,
    (name, data) =>
      name === "[Content_Types].xml"
        ? utf8(
            textOf(data).replace(
              "</Types>",
              '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
            ),
          )
        : data,
    [{ name: "xl/vbaProject.bin", data: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]) }],
  );
}

/**
 * The reference a *direct* worker call must use: `invokeWorker` stages one input under a synthesized
 * version id, and the adapter resolves the version the lease names rather than a store id.
 */
function directRef(name: string, bytes: Uint8Array) {
  const id = `file_${"A".repeat(26)}`;
  return { fileId: id, versionId: id, name, sha256: sha256(bytes), size: bytes.byteLength };
}

/** Per-part sha256, by package member name. The only acceptable argument for preservation. */
function partHashes(bytes: Uint8Array): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [name, data] of zipEntries(bytes)) out.set(name, sha256(data));
  return out;
}

async function bytesOf(
  store: VersionedFileStore,
  fileId: string,
  versionId: string,
): Promise<Uint8Array> {
  const stored = await store.getVersion(fileId, versionId);
  if (stored === undefined) throw new Error(`version ${versionId} is missing`);
  return stored.bytes;
}

suite("the Excel adapter reads a leased workbook in bounded pages", () => {
  itSlow("pages sheets, cells, formulas, names, styles and charts to the end", async () => {
    const { store, service } = harness();
    const source = await fixture(store, service, { operationId: "conv:read-fixture" });
    const lease = leaseOf([source.ref]);

    // The fixture's own cached value, reported by the run that wrote it, not by this test.
    expect(source.result.cached).toBe(1500);

    for (const section of ["sheets", "cells", "formulas", "names", "styles", "charts"]) {
      const args: Record<string, unknown> = { ref: refOf(source.ref), section, pageSize: 3 };
      if (section === "cells" || section === "styles") args.sheet = "Revenue";
      const collected: Readonly<Record<string, unknown>>[] = [];
      let cursor: number | null = 0;
      let total = -1;
      let pages = 0;
      while (cursor !== null) {
        const answer: { result: XlsxReading } = await body<XlsxReading>(
          toolOf(service, READ_WORKBOOK, lease),
          { ...args, cursor },
          { ...API, callId: `call-${section}-${pages}` },
        );
        const page: XlsxReading["page"] = answer.result.page;
        expect(page.section).toBe(section);
        expect(page.pageSize).toBe(3);
        expect(page.returned).toBeLessThanOrEqual(3);
        expect(page.items).toHaveLength(page.returned);
        if (total < 0) total = page.total;
        else expect(page.total).toBe(total);
        expect(page.cursor).toBe(cursor);
        collected.push(...(page.items as unknown as readonly Readonly<Record<string, unknown>>[]));
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(30);
      }
      // The pages partition the section: every item arrived exactly once, under the identity its own
      // section names.
      expect(collected.length).toBe(total);
      const keys = collected.map((item) => {
        if (section === "cells") return String(item.address);
        if (section === "formulas") return String(item.address);
        if (section === "names") return String(item.name);
        if (section === "styles") return String(item.address);
        if (section === "charts") return `${String(item.sheet)}:${String(item.position)}`;
        return String(item.title);
      });
      expect(new Set(keys).size).toBe(collected.length);
      expect(total).toBeGreaterThan(0);
    }

    // Sheets: order, size and state, each mapped to the part the package really holds it in.
    const sheets = await body<XlsxReading>(toolOf(service, READ_WORKBOOK, lease), {
      ref: refOf(source.ref),
      section: "sheets",
    });
    const outline = sheets.result.page.items as unknown as {
      position: number;
      title: string;
      part: string | null;
      usedRange: string;
      formulas: number;
      styledCells: number;
      charts: number;
      protected: boolean;
      state: string;
    }[];
    expect(outline.map((item) => item.title)).toEqual(["Revenue", "Notes", "Styles"]);
    expect(outline.map((item) => item.part)).toEqual([
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
      "xl/worksheets/sheet3.xml",
    ]);
    expect(outline[0]?.usedRange).toBe("A1:E4");
    expect(outline[0]?.formulas).toBe(4);
    expect(outline[0]?.styledCells).toBe(2);
    expect(outline[0]?.charts).toBe(1);
    expect(outline.every((item) => item.protected === false)).toBe(true);
    expect(outline.every((item) => item.state === "visible")).toBe(true);

    // Cells: a range read, with each cell's own formula and the value the *package* cached for it.
    const cells = await body<XlsxReading>(toolOf(service, READ_WORKBOOK, lease), {
      ref: refOf(source.ref),
      section: "cells",
      range: "Revenue!A1:B4",
      pageSize: 50,
    });
    const cellItems = cells.result.page.items as unknown as {
      address: string;
      value: unknown;
      valueKind: string;
      exact: string | null;
      formula: string | null;
      cachedValue: unknown;
      cachedKnown: boolean;
      numberFormat: string;
      styled: boolean;
    }[];
    expect(cellItems.map((item) => item.address)).toEqual([
      "Revenue!A1",
      "Revenue!B1",
      "Revenue!A2",
      "Revenue!B2",
      "Revenue!A3",
      "Revenue!B3",
      "Revenue!A4",
      "Revenue!B4",
    ]);
    expect(cells.result.sectionRange).toMatchObject({
      sheet: "Revenue",
      window: "A1:B4",
      clamped: false,
    });
    expect(cells.result.cachedValuesRead).toBe(true);
    const total = cellItems.find((item) => item.address === "Revenue!B4");
    expect(total?.formula).toBe("=SUM(B2:B3)");
    expect(total?.valueKind).toBe("formula");
    // The cached value is the package's own — the fixture wrote 1500 into it — never a recomputation.
    expect(total?.cachedKnown).toBe(true);
    expect(total?.cachedValue).toBe(1500);
    const revenue = cellItems.find((item) => item.address === "Revenue!B2");
    expect(revenue?.value).toBe(1250);
    expect(revenue?.exact).toBe("1250");
    expect(revenue?.numberFormat).toBe("#,##0.00");

    // A range larger than the adapter's budget is refused with the limit named, not silently clamped.
    const big = await refuse(toolOf(service, READ_WORKBOOK, lease), {
      ref: refOf(source.ref),
      section: "cells",
      sheet: "Revenue",
      range: "A1:XFD1048576",
    });
    expect(big.code).toBe("invalid-request");

    // Formulas: every reference a formula makes, with whether it resolved.
    const formulas = await body<XlsxReading>(toolOf(service, READ_WORKBOOK, lease), {
      ref: refOf(source.ref),
      section: "formulas",
      pageSize: 50,
    });
    const formulaItems = formulas.result.page.items as unknown as {
      address: string;
      formula: string;
      references: { raw: string; kind: string; resolved: boolean }[];
      brokenReferences: unknown[];
      cachedValue: unknown;
      cachedKnown: boolean;
      tokenizerError: string | null;
    }[];
    expect(formulaItems).toHaveLength(4);
    const sumCell = formulaItems.find((item) => item.address === "Revenue!B4");
    expect(sumCell?.formula).toBe("=SUM(B2:B3)");
    expect(sumCell?.cachedValue).toBe(1500);
    expect(sumCell?.references[0]).toMatchObject({
      raw: "B2:B3",
      kind: "cell-range",
      resolved: true,
      sheet: null,
    });
    expect(formulaItems.every((item) => item.brokenReferences.length === 0)).toBe(true);
    expect(formulaItems.every((item) => item.tokenizerError === null)).toBe(true);
    const namedFormula = formulaItems.find((item) => item.address === "Revenue!C1");
    expect(namedFormula?.references[0]).toMatchObject({ kind: "defined-name", resolved: true });
    // A whole-column reference is a legal reference, and is reported as resolved.
    const wholeColumn = formulaItems.find((item) => item.address === "Revenue!E1");
    expect(wholeColumn?.references[0]).toMatchObject({ raw: "A:A", resolved: true });

    // Names: the defined range, resolved against the sheet it names.
    const names = await body<XlsxReading>(toolOf(service, READ_WORKBOOK, lease), {
      ref: refOf(source.ref),
      section: "names",
    });
    expect(names.result.page.items).toEqual([
      {
        name: "RevenueTotal",
        scope: "workbook",
        sheet: null,
        reference: "Revenue!$B$2",
        referenceTruncated: false,
        kind: "range",
        resolved: true,
        reason: null,
      },
    ]);

    // Styles: the real formatting of a styled cell, read from the file.
    const styles = await body<XlsxReading>(toolOf(service, READ_WORKBOOK, lease), {
      ref: refOf(source.ref),
      section: "styles",
      sheet: "Styles",
      pageSize: 50,
    });
    const styleItems = styles.result.page.items as unknown as {
      address: string;
      style: Record<string, unknown>;
    }[];
    const styled = styleItems.find((item) => item.address === "Styles!A2");
    expect(styled?.style).toMatchObject({
      italic: true,
      fontSize: 14,
      numberFormat: "0.00%",
    });

    // Charts: the bar chart with the series reference that ties it to the sheet.
    const charts = await body<XlsxReading>(toolOf(service, READ_WORKBOOK, lease), {
      ref: refOf(source.ref),
      section: "charts",
    });
    const chartItems = charts.result.page.items as unknown as {
      sheet: string;
      type: string;
      title: string | null;
      titleResolved: boolean;
      seriesCount: number;
      references: { role: string; reference: string }[];
    }[];
    expect(chartItems).toHaveLength(1);
    expect(chartItems[0]?.sheet).toBe("Revenue");
    expect(chartItems[0]?.type).toBe("BarChart");
    expect(chartItems[0]?.title).toBe("Revenue by account");
    expect(chartItems[0]?.titleResolved).toBe(true);
    expect(chartItems[0]?.seriesCount).toBe(1);
    expect(chartItems[0]?.references).toEqual([
      { kind: "series", role: "values", reference: "'Revenue'!$B$2:$B$3" },
    ]);
  });

  itSlow(
    "inspects a workbook and reports its references and its calculation limits honestly",
    async () => {
      const { store, service } = harness();
      const source = await fixture(store, service, { operationId: "conv:inspect-fixture" });
      const lease = leaseOf([source.ref]);

      const answer = await body<XlsxInspection>(toolOf(service, INSPECT_WORKBOOK, lease), {
        ref: refOf(source.ref),
      });
      const result = answer.result;
      expect(result.workbook).toMatchObject({
        sheets: 3,
        chartsheets: 0,
        hiddenSheets: 0,
        protectedSheets: 0,
        namedRanges: 1,
        sheetScopedNames: 0,
        cells: 14,
        formulas: 4,
        styledCells: 4,
        charts: 1,
        chartParts: 1,
        pivotParts: 0,
        macros: false,
      });
      expect(result.sheetOutline.map((sheet) => sheet.title)).toEqual([
        "Revenue",
        "Notes",
        "Styles",
      ]);
      expect(result.package.macros).toBe(false);
      expect(result.package.externalLinks).toEqual([]);
      expect(result.protections.enforced).toBe(false);
      expect(result.namedRanges.map((name) => name.name)).toEqual(["RevenueTotal"]);
      expect(result.chartOutline[0]?.title).toBe("Revenue by account");
      expect(result.unmodeledChartParts).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(answer.wrote).toEqual([]);

      // The references in this workbook all resolve: the report is not vacuous.
      expect(result.referenceCheck.clean).toBe(true);
      expect(result.referenceCheck.broken).toEqual([]);
      expect(result.referenceCheck.brokenTotal).toBe(0);
      expect(result.referenceCheck.checkedSurfaces).toBeGreaterThanOrEqual(5);
      expect(result.referenceCheck.checkedReferences).toBeGreaterThanOrEqual(5);
      expect(result.referenceCheck.kinds["cell-range"]).toBeGreaterThanOrEqual(1);
      expect(result.referenceCheck.kinds["defined-name"]).toBe(1);

      // Recalculation: unavailable here, and said so rather than approximated.
      expect(result.recalculation.computed).toBe(false);
      expect(result.recalculation.attempted).toBe(false);
      expect(result.recalculation.processSpawned).toBe(false);
      expect(result.recalculation.engineInProcess).toBe(false);
      expect(result.recalculation.reason).toContain("LibreOffice");
      expect(result.recalculation.reason).toContain("spawn");
      expect(result.recalculation.unsupportedFunctions.length).toBeGreaterThan(10);
      expect(result.recalculation.unsupportedFunctions).toContain("LAMBDA");
      expect(result.recalculation.limits.join(" ")).toContain("never calculates");
      expect(result.recalculation.workbookRequest).toBeDefined();

      // A preview is structural and paged, and it names the same facts.
      const preview = await body<XlsxPreview>(toolOf(service, PREVIEW_WORKBOOK, lease), {
        ref: refOf(source.ref),
        pageSize: 2,
      });
      expect(preview.result.page.total).toBe(3);
      expect(preview.result.page.nextCursor).toBe(2);
      const full = await body<XlsxPreview>(toolOf(service, PREVIEW_WORKBOOK, lease), {
        ref: refOf(source.ref),
        pageSize: 3,
      });
      const revenue = full.result.page.items[0];
      const markers = new Set((revenue?.lines ?? []).map((line) => line.marker));
      expect(markers.has("V")).toBe(true);
      expect(markers.has("F")).toBe(true);
      expect(markers.has("N")).toBe(true);
      expect(markers.has("C")).toBe(true);
      expect((revenue?.lines ?? []).some((line) => line.text.includes("B2 = 1250"))).toBe(true);
      expect((revenue?.lines ?? []).some((line) => line.text.startsWith("=SUM(B2:B3)"))).toBe(true);
      expect(revenue?.counts.formulas).toBe(4);
      expect(revenue?.counts.charts).toBe(1);
      expect(full.result.referenceCheck.clean).toBe(true);
      expect(full.wrote).toEqual([]);
    },
  );
});

suite("the Excel adapter drafts and proposes", () => {
  itSlow("creates a new draft, which is a new file and not a publication", async () => {
    const { store, service } = harness();
    const answer = await body<XlsxDraft>(toolOf(service, CREATE_WORKBOOK, leaseOf([])), {
      output: "close-summary.xlsx",
      sheets: [
        {
          name: "Summary",
          at: "A1",
          rows: [
            ["Account", "Amount"],
            ["Revenue", 1250],
            ["Support", 250],
            ["Total", "=SUM(B2:B3)"],
          ],
          styles: [{ range: "A1:B1", style: { bold: true, fillColor: "EEEEEE" } }],
          names: [{ name: "AmountColumn", reference: "Summary!$B$2:$B$3" }],
          columnWidths: [{ column: "B", width: 18 }],
          freeze: "A2",
        },
      ],
    });
    expect(answer.result.draft).toMatchObject({
      status: "draft",
      editOf: null,
      published: false,
    });
    expect(answer.result.provenance.source).toBeNull();
    expect(answer.result.placements).toEqual([
      {
        name: "Summary",
        rows: 4,
        columns: 2,
        at: "A1",
        cellsWritten: 8,
        formulas: 1,
        styles: 1,
        namedRanges: 1,
        cellsPresent: 8,
      },
    ]);
    expect(answer.result.reopened).toMatchObject({
      sheets: 1,
      cells: 8,
      formulas: 1,
      namedRanges: 1,
      styledCells: 2,
      charts: 0,
      referenceCheck: 0,
    });
    expect(answer.result.namedRanges[0]).toMatchObject({
      name: "AmountColumn",
      scope: "workbook",
      resolved: true,
    });
    expect(answer.result.parts).toEqual({ Summary: "xl/worksheets/sheet1.xml" });
    // A formula written into a draft has no cached value until an engine opens it, and the result
    // says so rather than inventing one.
    expect(answer.result.warnings.join(" ")).toContain("no spreadsheet engine ran here");
    expect(answer.result.recalculation.computed).toBe(false);
    expect(answer.wrote).toHaveLength(1);

    const wrote = answer.wrote[0];
    const head = await store.getHead(wrote?.fileId ?? "");
    expect(head?.versionId).toBe(wrote?.versionId);
    expect(head?.sourceVersionId).toBeNull();
    expect(head?.sha256).toBe(answer.result.draft.sha256);
    expect(head?.metadata.source).toBe("generated");
    const bytes = await bytesOf(store, wrote?.fileId ?? "", wrote?.versionId ?? "");
    expect(zipEntries(bytes).has("xl/workbook.xml")).toBe(true);

    // A defined name that points at a sheet the draft does not have is refused, not written.
    const orphanName = await refuse(toolOf(service, CREATE_WORKBOOK, leaseOf([])), {
      output: "close-summary.xlsx",
      sheets: [
        {
          name: "Summary",
          rows: [["a"]],
          names: [{ name: "Nope", reference: "Missing!$A$1" }],
        },
      ],
    });
    expect(orphanName.code).toBe("broken-reference");

    // A ragged block is refused rather than half written.
    const ragged = await refuse(toolOf(service, CREATE_WORKBOOK, leaseOf([])), {
      output: "close-summary.xlsx",
      sheets: [{ name: "Summary", rows: [["a", "b"], ["c"]] }],
    });
    expect(ragged.code).toBe("invalid-request");
  });

  itSlow(
    "edits cells and formulas into an immutable proposal, preserving untouched parts byte for byte",
    async () => {
      const { store, service } = harness();
      const source = await fixture(store, service, { operationId: "conv:edit-fixture" });
      const lease = leaseOf([source.ref]);

      const answer = await body<XlsxEdit>(toolOf(service, EDIT_WORKBOOK, lease), {
        ref: refOf(source.ref),
        output: "proposal.xlsx",
        steps: [
          { kind: "setCell", sheet: "Revenue", cell: "B2", value: 1400 },
          { kind: "setCell", sheet: "Revenue", cell: "A5", formula: "=RevenueTotal*2" },
          {
            kind: "setRange",
            sheet: "Notes",
            range: "A3:B4",
            rows: [
              [1, 2],
              [3, 4],
            ],
          },
          { kind: "setStyle", sheet: "Revenue", range: "A4", style: { italic: true } },
          { kind: "setColumnWidth", sheet: "Revenue", column: "B", width: 20 },
          { kind: "addSheet", name: "Review" },
          { kind: "renameSheet", sheet: "Notes", to: "NotesRenamed" },
          { kind: "setName", name: "TotalCell", reference: "Revenue!$B$4" },
          { kind: "clearCells", sheet: "Styles", range: "A1" },
        ],
      });
      const result = answer.result;
      expect(result.proposal).toMatchObject({
        status: "proposed",
        editOf: source.ref.versionId,
        published: false,
      });
      expect(result.steps).toEqual([
        "setCell",
        "setCell",
        "setRange",
        "setStyle",
        "setColumnWidth",
        "addSheet",
        "renameSheet",
        "setName",
        "clearCells",
      ]);
      expect(result.changes).toHaveLength(9);
      expect(result.changes[0]?.evidence).toMatchObject({
        sheet: "Revenue",
        cell: "Revenue!B2",
        written: "value",
        previous: 1250,
      });
      expect(result.changes[1]?.evidence).toMatchObject({ written: "formula" });
      expect(result.changes[4]?.evidence).toMatchObject({ columns: ["B"], width: 20 });
      expect(result.changes[6]?.evidence).toMatchObject({
        sheet: "Notes",
        to: "NotesRenamed",
      });

      // The proposal is a new immutable version of the same file: the source version is untouched.
      const wrote = answer.wrote[0];
      expect(wrote?.fileId).toBe(source.ref.id);
      expect(wrote?.versionId).not.toBe(source.ref.versionId);
      const head = await store.getHead(source.ref.id);
      expect(head?.versionId).toBe(wrote?.versionId);
      expect(head?.sourceVersionId).toBe(source.ref.versionId);
      expect(head?.metadata.source).toBe("derived");
      const original = await bytesOf(store, source.ref.id, source.ref.versionId);
      expect(sha256(original)).toBe(source.ref.sha256);
      // Nothing published it.
      expect(await store.getPublished(source.ref.id)).toBeUndefined();

      // The changed-cell set the fork's own receipt records, keyed by the part that holds each cell.
      expect(result.editReceipt.cellsChanged.total).toBeGreaterThan(0);
      expect(result.editReceipt.cellsChanged.truncated).toBe(false);
      expect(result.editReceipt.cellsChanged.parts["xl/worksheets/sheet1.xml"]?.B2).toBe("changed");
      expect(result.editReceipt.partsChanged).toContain("xl/worksheets/sheet1.xml");
      expect(result.editReceipt.partsAdded).toContain("xl/worksheets/sheet4.xml");
      // The splice drops the cached value of a formula whose input changed, and asks to recalculate.
      expect(
        result.editReceipt.derivedEffects.some((effect) => effect.kind === "formula_cache_removed"),
      ).toBe(true);
      expect(result.recalculation.workbookRequest.requestsRecalculation).toBe(true);
      expect(result.recalculation.computed).toBe(false);
      expect(result.editReceipt.recalc).toBeNull();

      // The cell and formula diff, with the dependencies it affects.
      const changes = new Map(result.diff.cells.map((cell) => [cell.address, cell]));
      expect(changes.get("Revenue!B2")).toMatchObject({ before: 1250, after: 1400, kind: "value" });
      expect(changes.get("Revenue!A5")).toMatchObject({ before: null, after: "=RevenueTotal*2" });
      const renamedFormula = changes.get("Revenue!D1");
      expect(renamedFormula).toMatchObject({ before: "=Notes!A1" });
      expect(renamedFormula?.after).toBe("='NotesRenamed'!A1");
      expect(result.diff.cellsTruncated).toBe(false);
      expect(result.diff.dependenciesTotal).toBeGreaterThanOrEqual(1);
      expect(result.diff.dependencies[0]).toMatchObject({
        formulaCell: "'Revenue'!B4",
        reference: "B2:B3",
        changedCell: "B2",
        sameSheet: true,
      });

      // Style diff: the formatting change on A4, with the keys that differ.
      const styleChange = result.diff.styleChanges.find(
        (change) => change.address === "Revenue!A4",
      );
      expect(styleChange?.keys).toContain("italic");
      expect(styleChange?.after.italic).toBe(true);

      // Explicit numeric checks: the exact before and after, the exact delta, and — where a SUM names
      // cells — this adapter's own exact sum beside the value the file cached.
      const b2Check = result.diff.numericChecks.find((check) => check.address === "Revenue!B2");
      expect(b2Check).toMatchObject({
        kind: "value-change",
        exactBefore: "1250",
        exactAfter: "1400",
        deltaExact: "150",
        method: "read-both-packages",
      });
      const sumCheck = result.diff.numericChecks.find(
        (check) => check.address === "Revenue!B4",
      )?.sum;
      expect(sumCheck).toBeDefined();
      expect(sumCheck?.function).toBe("SUM");
      expect(sumCheck?.range).toBe("B2:B3");
      expect(sumCheck?.cells).toEqual(["B2", "B3"]);
      // The adapter added the cells it names: 1400 + 250, exactly.
      expect(sumCheck?.adapterSumExact).toBe("1650");
      expect(sumCheck?.adapterSum).toBe(1650);
      // The proposal dropped the formula's cached value, so there is nothing to compare against — and
      // the check says exactly that instead of reporting a value it computed.
      expect(sumCheck?.workbookCachedKnown).toBe(false);
      expect(sumCheck?.workbookCachedValue).toBeNull();
      expect(sumCheck?.agrees).toBeNull();
      expect(sumCheck?.reason).toContain("no cached value");
      expect(sumCheck?.reason).toContain("no engine ran here");
      expect(result.diff.numericChecksTotal).toBeGreaterThanOrEqual(1);

      // The workbook's own references, before and after: the rename rewrote the one that named Notes.
      expect(result.referenceCheck.sourceBroken).toBe(0);
      expect(result.referenceCheck.outputBroken).toBe(0);
      expect(result.referenceCheck.newBroken).toEqual([]);
      expect(result.referenceCheck.note).toContain("refused before anything is written");
      expect(result.reopened).toMatchObject({
        sheets: 4,
        formulas: 5,
        namedRanges: 2,
        charts: 1,
        chartParts: 1,
        referenceCheck: 0,
      });

      // Preservation, argued with per-part sha256 rather than by eye.
      const before = partHashes(original);
      const after = partHashes(await bytesOf(store, wrote?.fileId ?? "", wrote?.versionId ?? ""));
      const untouched = UNTOUCHED_PARTS.filter((part) => before.has(part));
      expect(untouched).toHaveLength(UNTOUCHED_PARTS.length);
      for (const part of untouched) {
        expect(after.get(part), `${part} is missing from the proposal`).toBeDefined();
        expect(after.get(part), `${part} was rewritten`).toBe(before.get(part));
      }
      // The parts the edit really touched are exactly the ones that differ.
      expect(after.get("xl/worksheets/sheet1.xml")).not.toBe(
        before.get("xl/worksheets/sheet1.xml"),
      );
      expect(after.get("xl/worksheets/sheet3.xml")).not.toBe(
        before.get("xl/worksheets/sheet3.xml"),
      );

      const trulyIdentical = [...before.keys()].filter(
        (part) => after.get(part) === before.get(part),
      );
      expect(result.changeSet.byteIdenticalCount).toBe(trulyIdentical.length);
      expect(result.preservation.byteIdenticalCount).toBe(trulyIdentical.length);
      expect(result.changeSet.changed.every((change) => change.beforeSha256 !== null)).toBe(true);
      expect(result.preservation.chartByteIdentical).toEqual(["/xl/charts/chart1.xml"]);
      expect(result.preservation.themeByteIdentical).toEqual(["/xl/theme/theme1.xml"]);
      expect(result.preservation.drawingByteIdentical).toContain("/xl/drawings/drawing1.xml");
      expect(result.preservation.verbatimCopy).toBe(false);
      // The reported hashes are the packages' hashes, not a claim about them.
      for (const entry of result.preservation.byteIdentical) {
        const name = entry.part.slice(1);
        expect(trulyIdentical).toContain(name);
        expect(before.get(name)).toBe(entry.sha256);
      }
      expect(result.preservation.byteIdenticalHashed).toBe(
        result.preservation.byteIdentical.length,
      );
    },
  );

  itSlow(
    "returns an untouched sheet verbatim where a re-serialization would drop content it cannot model",
    async () => {
      const { store, service } = harness();
      const source = await fixture(store, service, {
        operationId: "conv:verbatim-fixture",
        unmodeled: true,
      });
      const lease = leaseOf([source.ref]);

      // A stock round trip of the same source: preserve mode off, so every part is re-serialized.
      const naive = committed(
        await service.runDocumentPython({
          operationId: "conv:naive-round-trip",
          taskId: "task:xlsx",
          lease,
          code: xlsxNaiveRoundTripCode(source.ref.versionId),
          arguments: {},
        }),
      );
      const naiveOutput = naive.outputs[0];
      if (naiveOutput === undefined) throw new Error("the naive round trip produced no workbook");

      const sourceBytes = await bytesOf(store, source.ref.id, source.ref.versionId);
      const naiveBytes = await bytesOf(store, naiveOutput.fileId, naiveOutput.versionId);
      // The sparkline extension is on the Notes sheet, which this edit does not touch at all.
      const quirky = zipEntries(sourceBytes).get("xl/worksheets/sheet2.xml");
      expect(quirky).toBeDefined();
      expect(textOf(quirky ?? new Uint8Array())).toContain("<x14:sparklineGroups");
      // Re-serializing that sheet guts the sparklines, exactly as the library's reader warns it will…
      const naiveSheet = zipEntries(naiveBytes).get("xl/worksheets/sheet2.xml");
      expect(textOf(naiveSheet ?? new Uint8Array())).not.toContain("sparklineGroups");
      expect(sha256(naiveSheet ?? new Uint8Array())).not.toBe(sha256(quirky ?? new Uint8Array()));

      // …and the proposal returns the original bytes: the untouched sheet was copied, not rebuilt.
      const answer = await body<XlsxEdit>(toolOf(service, EDIT_WORKBOOK, lease), {
        ref: refOf(source.ref),
        output: "proposal.xlsx",
        steps: [{ kind: "setCell", sheet: "Revenue", cell: "B2", value: 1400 }],
      });
      const wrote = answer.wrote[0];
      const proposalBytes = await bytesOf(store, wrote?.fileId ?? "", wrote?.versionId ?? "");
      const proposalSheet = zipEntries(proposalBytes).get("xl/worksheets/sheet2.xml");
      expect(sha256(proposalSheet ?? new Uint8Array())).toBe(sha256(quirky ?? new Uint8Array()));
      expect(textOf(proposalSheet ?? new Uint8Array())).toContain("<xm:sqref>B6</xm:sqref>");
      // The proposal's read of that sheet still sees the cell the sheet really holds, so the preserved
      // bytes are the sheet the reader reports and not a stale copy of something else.
      const notes = await body<XlsxReading>(toolOf(service, READ_WORKBOOK, lease), {
        ref: refOf(source.ref),
        section: "cells",
        sheet: "Notes",
      });
      expect(
        (notes.result.page.items as unknown as { address: string }[]).map((item) => item.address),
      ).toEqual(["Notes!A1"]);

      // The result's own evidence agrees, part by part.
      const entry = answer.result.preservation.byteIdentical.find(
        (part) => part.part === "/xl/worksheets/sheet2.xml",
      );
      expect(entry?.sha256).toBe(sha256(quirky ?? new Uint8Array()));
      expect(answer.result.preservation.worksheetByteIdentical).toContain(
        "/xl/worksheets/sheet2.xml",
      );
    },
  );

  itSlow(
    "reports a source's broken references, and refuses every edit that would add one",
    async () => {
      const { store, service } = harness();
      const broken = await fixture(store, service, {
        operationId: "conv:broken-fixture",
        broken: true,
      });
      const brokenLease = leaseOf([broken.ref]);

      // The three broken references the fixture carries are reported — not repaired, not refused.
      const inspected = await body<XlsxInspection>(toolOf(service, INSPECT_WORKBOOK, brokenLease), {
        ref: refOf(broken.ref),
      });
      expect(inspected.result.referenceCheck.clean).toBe(false);
      expect(inspected.result.referenceCheck.brokenTotal).toBe(3);
      expect([...inspected.result.referenceCheck.brokenKinds].sort()).toEqual([
        "missing-name",
        "missing-sheet",
        "out-of-grid-range",
      ]);
      const byKind = new Map(
        inspected.result.referenceCheck.broken.map((item) => [item.kind, item]),
      );
      expect(byKind.get("missing-sheet")).toMatchObject({
        where: "formula at Revenue!F1",
        raw: "Missing!A1",
        resolved: false,
      });
      expect(byKind.get("missing-sheet")?.detail).toContain("Missing");
      expect(byKind.get("out-of-grid-range")?.raw).toBe("Revenue!A1:A2000000");
      expect(byKind.get("missing-name")?.raw).toBe("GoneTotal");
      expect(inspected.result.warnings.join(" ")).toContain("cannot be resolved");
      // Reading them is the same story, told where a reviewer will look.
      const reading = await body<XlsxReading>(toolOf(service, READ_WORKBOOK, brokenLease), {
        ref: refOf(broken.ref),
        section: "formulas",
        pageSize: 50,
      });
      const brokenItems = (
        reading.result.page.items as unknown as { brokenReferences: unknown[] }[]
      ).filter((item) => item.brokenReferences.length > 0);
      expect(brokenItems).toHaveLength(3);

      // An edit that touches something else still works, and says the broken references are still there.
      const edited = await body<XlsxEdit>(toolOf(service, EDIT_WORKBOOK, brokenLease), {
        ref: refOf(broken.ref),
        output: "proposal.xlsx",
        steps: [{ kind: "setCell", sheet: "Revenue", cell: "B2", value: 999 }],
      });
      expect(edited.result.referenceCheck.sourceBroken).toBe(3);
      expect(edited.result.referenceCheck.outputBroken).toBe(3);
      expect(edited.result.referenceCheck.newBroken).toEqual([]);
      expect(edited.result.warnings.join(" ")).toContain("3 formula reference(s)");
      expect(edited.result.proposal.published).toBe(false);

      // Now the four edits that would *create* one: each refuses, and writes nothing.
      const before = await bytesOf(store, broken.ref.id, broken.ref.versionId);
      const head = await store.getHead(broken.ref.id);
      const cases = [
        {
          name: "a formula naming a sheet the workbook does not have",
          steps: [{ kind: "setCell", sheet: "Revenue", cell: "H1", formula: "=NoSuchSheet!A1" }],
          expect: "no sheet named",
        },
        {
          name: "a formula naming a range outside the grid",
          steps: [
            {
              kind: "setCell",
              sheet: "Revenue",
              cell: "H2",
              formula: "=SUM(Revenue!A1:A2000000)",
            },
          ],
          expect: "outside the spreadsheet grid",
        },
        {
          name: "removing a name a formula still uses",
          steps: [{ kind: "removeName", name: "RevenueTotal" }],
          expect: "no defined name",
        },
        {
          name: "deleting a sheet other formulas point at",
          steps: [{ kind: "deleteSheet", sheet: "Notes" }],
          expect: "pointing at a sheet that no longer exists",
        },
      ] as const;
      for (const item of cases) {
        const refused = await refuse(toolOf(service, EDIT_WORKBOOK, brokenLease), {
          ref: refOf(broken.ref),
          output: "refused.xlsx",
          steps: item.steps,
        });
        expect(refused.code, item.name).toBe("broken-reference");
        expect(refused.message, item.name).toContain(item.expect);
        expect(refused.message, item.name).toContain("every source version is unchanged");
      }
      // No proposal exists, the source version is byte-identical, and it is still the head.
      expect(sha256(await bytesOf(store, broken.ref.id, broken.ref.versionId))).toBe(
        sha256(before),
      );
      expect(await store.getHead(broken.ref.id)).toMatchObject({ versionId: head?.versionId });
      expect(await store.getPublished(broken.ref.id)).toBeUndefined();
    },
  );

  itSlow(
    "refuses a macro-bearing workbook and an externally-linked one through the adapter itself",
    async () => {
      const { store, service } = harness();
      const source = await fixture(store, service, { operationId: "conv:hostile-fixture" });
      const sourceBytes = await bytesOf(store, source.ref.id, source.ref.versionId);

      // The host refuses these before the worker runs (see the fixtures at the bottom of this file).
      // These go straight to the worker, so what refuses here is the *adapter's* own guard.
      const macro = await store.put({
        bytes: withMacro(sourceBytes),
        name: "macro.xlsx",
        mimeType: XLSX_MIME,
        metadata: { createdBy: "host", source: "uploaded" },
      });
      const macroBytes = await bytesOf(store, macro.id, macro.versionId);
      const macroAnswer = await invokeWorker(interpreter ?? "", {
        operationId: "direct:macro",
        code: DIRECT_PROGRAM,
        arguments: { ref: directRef("macro.xlsx", macroBytes) },
        inputs: [{ name: "macro.xlsx", format: "xlsx", bytes: macroBytes }],
        outputFormats: ["xlsx"],
      });
      expect(macroAnswer.json.ok).toBe(false);
      expect(macroAnswer.json.code).toBe("macro-payload");
      expect(String(macroAnswer.json.message)).toContain("VBA project");
      expect(sha256(await bytesOf(store, macro.id, macro.versionId))).toBe(sha256(macroBytes));

      const linked = await store.put({
        bytes: withExternalLink(sourceBytes, "https://example.com/quarterly-close"),
        name: "linked.xlsx",
        mimeType: XLSX_MIME,
        metadata: { createdBy: "host", source: "uploaded" },
      });
      const linkedBytes = await bytesOf(store, linked.id, linked.versionId);
      const linkedAnswer = await invokeWorker(interpreter ?? "", {
        operationId: "direct:linked",
        code: DIRECT_PROGRAM,
        arguments: { ref: directRef("linked.xlsx", linkedBytes) },
        inputs: [{ name: "linked.xlsx", format: "xlsx", bytes: linkedBytes }],
        outputFormats: ["xlsx"],
      });
      expect(linkedAnswer.json.ok).toBe(false);
      expect(String(linkedAnswer.json.code)).toMatch(/external-relationship|macro-payload/);
      expect(sha256(await bytesOf(store, linked.id, linked.versionId))).toBe(sha256(linkedBytes));

      // An external-link *part* (xl/externalLinks/) is refused by the adapter too.
      const externalPart = await store.put({
        bytes: rebuilt(sourceBytes, (_name, data) => data, [
          {
            name: "xl/externalLinks/externalLink1.xml",
            data: '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
          },
        ]),
        name: "external-parts.xlsx",
        mimeType: XLSX_MIME,
        metadata: { createdBy: "host", source: "uploaded" },
      });
      const partsBytes = await bytesOf(store, externalPart.id, externalPart.versionId);
      const partsAnswer = await invokeWorker(interpreter ?? "", {
        operationId: "direct:external-parts",
        code: DIRECT_PROGRAM,
        arguments: { ref: directRef("external-parts.xlsx", partsBytes) },
        inputs: [{ name: "external-parts.xlsx", format: "xlsx", bytes: partsBytes }],
        outputFormats: ["xlsx"],
      });
      expect(partsAnswer.json.ok).toBe(false);
      expect(partsAnswer.json.code).toBe("external-relationship");
      expect(String(partsAnswer.json.message)).toContain("external");
      expect(sha256(await bytesOf(store, externalPart.id, externalPart.versionId))).toBe(
        sha256(partsBytes),
      );

      // The lease is unaffected by any of it: the source the adapter was given is still the head.
      expect(await store.getHead(source.ref.id)).toMatchObject({ versionId: source.ref.versionId });
    },
  );

  itSlow(
    "replays the same operation, returning the same receipt without a second version",
    async () => {
      const { store, service, runs } = harness();
      const source = await fixture(store, service, { operationId: "conv:replay-fixture" });
      const lease = leaseOf([source.ref]);
      const args = {
        ref: refOf(source.ref),
        output: "proposal.xlsx",
        steps: [{ kind: "setCell", sheet: "Revenue", cell: "B2", value: 1400 }],
      };
      const before = runs.count;
      const first = await toolOf(service, EDIT_WORKBOOK, lease).execute(args, API);
      const second = await toolOf(service, EDIT_WORKBOOK, lease).execute(args, API);
      expect(second.output[0]?.text).toBe(first.output[0]?.text);
      // The replay resolved to the committed receipt: the interpreter ran once, and one version exists.
      expect(runs.count).toBe(before + 1);
      const parsed = JSON.parse(first.output[0]?.text ?? "{}") as {
        operationId: string;
        wrote: { fileId: string; versionId: string }[];
      };
      expect(parsed.wrote).toHaveLength(1);
      const head = await store.getHead(source.ref.id);
      expect(head?.versionId).toBe(parsed.wrote[0]?.versionId);
      const stored = await store.getVersion(source.ref.id, parsed.wrote[0]?.versionId ?? "");
      expect(stored?.ref.sourceVersionId).toBe(source.ref.versionId);
    },
  );
});

suite("the Excel adapter compares two leased versions", () => {
  itSlow("diffs cells, formulas, styles, dependencies and explicit numeric checks", async () => {
    const { store, service } = harness();
    const main = await fixture(store, service, { operationId: "conv:compare-main" });
    const revised = await fixture(store, service, {
      operationId: "conv:compare-revised",
      variant: "revised",
      name: "revised.xlsx",
    });
    // The two differ only in what total B4 sums.
    expect(main.result.cached).toBe(1500);
    expect(revised.result.cached).toBe(1250);

    const answer = await body<XlsxComparison>(
      toolOf(service, COMPARE_WORKBOOK, leaseOf([revised.ref, main.ref], false)),
      { from: refOf(revised.ref), to: refOf(main.ref) },
    );
    expect(answer.result.identical).toBe(false);
    expect(answer.result.diff.identical).toBe(false);
    expect(answer.result.preservation.byteIdenticalCount).toBeGreaterThan(10);
    const total = answer.result.diff.cells.find((cell) => cell.address === "Revenue!B4");
    expect(total).toMatchObject({ before: "=SUM(B2:B2)", after: "=SUM(B2:B3)" });

    // The numeric check compares this adapter's own exact sum against the value the *target* cached:
    // 1250 + 250 = 1500, and the file already holds 1500, so the check agrees — and says so.
    const sum = answer.result.diff.numericChecks.find(
      (check) => check.address === "Revenue!B4",
    )?.sum;
    expect(sum?.cells).toEqual(["B2", "B3"]);
    expect(sum?.adapterSumExact).toBe("1500");
    expect(sum?.workbookCachedKnown).toBe(true);
    expect(sum?.workbookCachedValue).toBe(1500);
    expect(sum?.agrees).toBe(true);
    expect(sum?.reason).toBeNull();
    expect(sum?.side).toBe("after");
    // It is still not a recalculation: nothing was computed by an engine, and the result says so.
    expect(answer.result.recalculation.computed).toBe(false);
    expect(answer.result.recalculation.attempted).toBe(false);
    expect(answer.result.referenceCheck.from.clean).toBe(true);
    expect(answer.result.referenceCheck.to.clean).toBe(true);

    // A workbook against itself is identical, so the diff is not reporting noise.
    const same = await body<XlsxResult>(
      toolOf(service, COMPARE_WORKBOOK, leaseOf([main.ref], false)),
      { from: refOf(main.ref), to: refOf(main.ref) },
    );
    if (same.result.operation !== "compare") throw new Error("expected a comparison");
    expect(same.result.identical).toBe(true);
    expect(same.result.diff.cells).toEqual([]);
  });
});

suite("a bare Pi Durable harness gets the same receipt as Office Hum", () => {
  itSlow(
    "rebuilds the same tool answer from the durable record, under the same operation ID",
    async () => {
      const { store, service } = harness();
      const source = await fixture(store, service, { operationId: "conv:portable-fixture" });
      const lease = leaseOf([source.ref]);
      const args = {
        ref: refOf(source.ref),
        output: "proposal.xlsx",
        steps: [{ kind: "setCell", sheet: "Revenue", cell: "B2", value: 1400 }],
      };

      // Office Hum's shape: the local service, the FileStore and the run ledger.
      const recorder = recordingService(service);
      const office = await toolOf(recorder, EDIT_WORKBOOK, lease).execute(args, API);
      const receipt = recorder.receipts.at(-1);
      if (receipt === undefined || receipt.kind !== "run") throw new Error("no durable receipt");
      const recorded = JSON.parse(office.output[0]?.text ?? "{}") as { operationId: string };
      expect(receipt.operationId).toBe(recorded.operationId);

      // A bare harness's shape: a scripted service that answers from that record, with no Office Hum.
      const bare = paperOfficeToolPack({
        service: {
          async runDocumentPython(request) {
            expect(request.operationId).toBe(receipt.operationId);
            return { kind: "committed", receipt };
          },
        },
        leaseFor: async () => lease,
      });
      expect(bare.tools[0]?.name).toBe(RUN_DOCUMENT_PYTHON);
      const tool = bare.tools.find((item) => item.name === EDIT_WORKBOOK) as unknown as Tool;
      const answer = await tool.execute(args, API);
      expect(answer.isError).toBeUndefined();
      expect(answer.output[0]?.text).toBe(office.output[0]?.text);
    },
  );
});

describe("the refusals that need no interpreter", () => {
  function serviceWithoutWorker(): { store: VersionedFileStore; service: DocumentService } {
    const store = localVersionedFileStore(join(root, "files"));
    return {
      store,
      service: localDocumentService({
        store,
        worker: {
          async run() {
            throw new Error("this package is refused before the worker runs");
          },
        },
        ledger: runLedger(join(root, "ledger")),
        createdBy: "role:test",
      }),
    };
  }

  it("refuses an archive that is not a package, leaving the source byte-identical", async () => {
    const { store, service } = serviceWithoutWorker();
    const ref = await store.put({
      bytes: xlsxLike({ omitContentTypes: true }),
      name: "close.xlsx",
      mimeType: XLSX_MIME,
      metadata: { createdBy: "host", source: "uploaded" },
    });
    const refused = await refuse(toolOf(service, READ_WORKBOOK, leaseOf([ref])), {
      ref: refOf(ref),
      section: "sheets",
    });
    expect(refused.code).toBe("archive-invalid");
    const after = await store.getVersion(ref.id, ref.versionId);
    expect(sha256(after?.bytes ?? new Uint8Array())).toBe(ref.sha256);
    expect(await store.getHead(ref.id)).toMatchObject({ versionId: ref.versionId });
  });

  it("refuses a workbook holding a VBA project, leaving the source byte-identical", async () => {
    const { store, service } = serviceWithoutWorker();
    const ref = await store.put({
      bytes: xlsxLike({
        extra: [{ name: "xl/vbaProject.bin", data: new Uint8Array([1, 2, 3]) }],
      }),
      name: "macro.xlsx",
      mimeType: XLSX_MIME,
      metadata: { createdBy: "host", source: "uploaded" },
    });
    const lease = leaseOf([ref]);
    const before = (await store.getVersion(ref.id, ref.versionId))?.bytes;
    for (const [name, args] of [
      [INSPECT_WORKBOOK, { ref: refOf(ref) }],
      [READ_WORKBOOK, { ref: refOf(ref), section: "sheets" }],
      [PREVIEW_WORKBOOK, { ref: refOf(ref) }],
      [
        EDIT_WORKBOOK,
        {
          ref: refOf(ref),
          output: "proposal.xlsx",
          steps: [{ kind: "setCell", cell: "B2", value: 1400 }],
        },
      ],
    ] as const) {
      const refused = await refuse(toolOf(service, name, lease), args);
      expect(refused.code).toBe("macro-payload");
    }
    const after = (await store.getVersion(ref.id, ref.versionId))?.bytes;
    expect(sha256(after ?? new Uint8Array())).toBe(sha256(before ?? new Uint8Array()));
    expect(await store.getHead(ref.id)).toMatchObject({ versionId: ref.versionId });
  });

  it("refuses an external relationship, leaving the source byte-identical", async () => {
    const { store, service } = serviceWithoutWorker();
    const ref = await store.put({
      bytes: xlsxLike({ external: ["https://example.com/quarterly-close"] }),
      name: "linked.xlsx",
      mimeType: XLSX_MIME,
      metadata: { createdBy: "host", source: "uploaded" },
    });
    const lease = leaseOf([ref]);
    const before = (await store.getVersion(ref.id, ref.versionId))?.bytes;
    for (const [name, args] of [
      [INSPECT_WORKBOOK, { ref: refOf(ref) }],
      [PREVIEW_WORKBOOK, { ref: refOf(ref) }],
      [
        EDIT_WORKBOOK,
        {
          ref: refOf(ref),
          output: "proposal.xlsx",
          steps: [{ kind: "setCell", cell: "B2", value: 1400 }],
        },
      ],
    ] as const) {
      const refused = await refuse(toolOf(service, name, lease), args);
      expect(refused.code).toBe("external-relationship");
    }
    const after = (await store.getVersion(ref.id, ref.versionId))?.bytes;
    expect(sha256(after ?? new Uint8Array())).toBe(sha256(before ?? new Uint8Array()));
    expect(await store.getHead(ref.id)).toMatchObject({ versionId: ref.versionId });
  });

  it("refuses a reference to a workbook the lease does not grant, before the worker runs", async () => {
    const { store, service } = serviceWithoutWorker();
    const ref = await store.put({
      bytes: xlsxPackage(),
      name: "close.xlsx",
      mimeType: XLSX_MIME,
      metadata: { createdBy: "host", source: "uploaded" },
    });
    const refused = await refuse(toolOf(service, INSPECT_WORKBOOK, leaseOf([])), {
      ref: refOf(ref),
    });
    expect(refused.code).toBe("ungranted-input");
    expect(await store.getHead(ref.id)).toMatchObject({ versionId: ref.versionId });
  });
});
