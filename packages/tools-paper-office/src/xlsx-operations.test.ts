/**
 * The typed Excel contract, without an interpreter.
 *
 * Everything here is enforced in process, before any Python is spawned: the file references against the
 * lease, the read sections and their bounds, the output name, the edit steps, the create sheets, and the
 * shape of the answer the worker is allowed to give. These tests always run — they never need
 * `OFFICEHUM_PAPER_PYTHON` — which is what keeps the refusals enforced on a host with no provisioned
 * interpreter.
 *
 * Two of the checks here are the ones only this adapter needs, because only this adapter reports
 * arithmetic: a result may not claim a calculated value or a spawned process, and a numeric check that
 * claims to agree must carry the sum it computed and the cached value it compared against.
 */

import { describe, expect, it } from "vitest";
import { DOCUMENT_REFUSAL_CODES, DocumentError } from "./errors.js";
import { DEFAULT_LIMITS, type DocumentLease } from "./lease.js";
import { intentForRun, intentSha256, POLICY_VERSION } from "./operation.js";
import { PPTX_TOOL_REGISTRATIONS } from "./pptx-tools.js";
import { paperOfficeToolPack, RUN_DOCUMENT_PYTHON } from "./run-document-python.js";
import { sha256, xlsxPackage } from "./test-helpers.js";
import { WORD_TOOL_REGISTRATIONS } from "./word-tools.js";
import {
  assertXlsxSheet,
  assertXlsxStep,
  COMPARE_WORKBOOK,
  CREATE_WORKBOOK,
  EDIT_WORKBOOK,
  INSPECT_WORKBOOK,
  isXlsxInput,
  MAX_XLSX_PAGE,
  MAX_XLSX_RANGE_CELLS,
  MAX_XLSX_SHEETS,
  MAX_XLSX_STEPS,
  PREVIEW_WORKBOOK,
  parseXlsxResult,
  READ_WORKBOOK,
  resolveXlsxOutput,
  resolveXlsxRef,
  STEP_OPTIONAL,
  STEP_REQUIRED,
  XLSX_OPERATIONS,
  XLSX_READ_SECTIONS,
  XLSX_STEP_KINDS,
  XLSX_STYLE_FIELDS,
  XLSX_TOOL_NAMES,
  xlsxInstruction,
  xlsxProgram,
} from "./xlsx-operations.js";
import { XLSX_TOOL_ORDER, XLSX_TOOL_REGISTRATIONS, xlsxTools } from "./xlsx-tools.js";

const FILE_A = `file_${"A".repeat(26)}`;
const FILE_B = `file_${"B".repeat(26)}`;
const FILE_C = `file_${"C".repeat(26)}`;
const BOOK = xlsxPackage();

function leased(fileId: string, name: string, writable = true, format: "xlsx" | "docx" = "xlsx") {
  return {
    fileId,
    versionId: fileId,
    name,
    format,
    sha256: sha256(BOOK),
    size: BOOK.byteLength,
    writable,
  };
}

const LEASE: DocumentLease = {
  leaseId: "lease:xlsx",
  taskId: "task:xlsx",
  inputs: [leased(FILE_A, "close.xlsx"), leased(FILE_B, "read-only.xlsx", false)],
  outputFormats: ["xlsx"],
  limits: DEFAULT_LIMITS,
  expiresAt: "2999-01-01T00:00:00.000Z",
};

function refOf(fileId: string) {
  return {
    fileId,
    versionId: fileId,
    name: fileId === FILE_A ? "close.xlsx" : "read-only.xlsx",
    sha256: sha256(BOOK),
    size: BOOK.byteLength,
  };
}

/** Whether any value anywhere in `value` is `undefined`, which the receipt's intent hash refuses. */
function hasUndefined(value: unknown): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.some(hasUndefined);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasUndefined);
  }
  return false;
}

function refusalOf(run: () => unknown): DocumentError {
  try {
    run();
  } catch (error) {
    if (error instanceof DocumentError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const NEVER_CALLED = () => {
  throw new Error("the service must not be reached by a program-building test");
};

const SERVICE = { runDocumentPython: NEVER_CALLED };

describe("an Excel operation takes a leased file reference, never a path", () => {
  it("resolves a reference the lease pinned, and refuses anything else", () => {
    const leasedInput = resolveXlsxRef(LEASE, refOf(FILE_A), "the ref");
    expect(leasedInput.versionId).toBe(FILE_A);
    expect(leasedInput.writable).toBe(true);
    expect(isXlsxInput(leasedInput)).toBe(true);

    expect(
      refusalOf(() =>
        resolveXlsxRef(LEASE, { ...refOf(FILE_A), versionId: FILE_C, fileId: FILE_C }, "the ref"),
      ).code,
    ).toBe("ungranted-input");

    // A reference whose hash does not match the version the lease pinned is not that version.
    expect(
      refusalOf(() =>
        resolveXlsxRef(LEASE, { ...refOf(FILE_A), sha256: "b".repeat(64) }, "the ref"),
      ).code,
    ).toBe("ungranted-input");

    // There is no shape a caller can send that names a path: an extra field is refused outright.
    expect(
      refusalOf(() => resolveXlsxRef(LEASE, { ...refOf(FILE_A), path: "/etc/hosts" }, "the ref"))
        .code,
    ).toBe("invalid-request");
    expect(refusalOf(() => resolveXlsxRef(LEASE, refOf(FILE_A).versionId, "the ref")).code).toBe(
      "invalid-request",
    );
  });

  it("refuses a reference to a file that is not a workbook", () => {
    const lease: DocumentLease = {
      ...LEASE,
      inputs: [leased(FILE_A, "brief.docx", true, "docx")],
    };
    // The version is granted, but it is not a spreadsheet: an Excel operation reads `.xlsx`.
    expect(
      refusalOf(() => resolveXlsxRef(lease, { ...refOf(FILE_A), name: "brief.docx" }, "the ref"))
        .code,
    ).toBe("invalid-request");
  });

  it("checks the output name and the lease's permitted formats", () => {
    expect(resolveXlsxOutput(LEASE, "proposal.xlsx")).toBe("proposal.xlsx");
    expect(refusalOf(() => resolveXlsxOutput(LEASE, "proposal.docx")).code).toBe("output-format");
    expect(refusalOf(() => resolveXlsxOutput(LEASE, "../escape.xlsx")).code).toBe("traversal");
    expect(refusalOf(() => resolveXlsxOutput(LEASE, "dir/proposal.xlsx")).code).toBe("traversal");
    const docxOnly: DocumentLease = { ...LEASE, outputFormats: ["docx"] };
    expect(refusalOf(() => resolveXlsxOutput(docxOnly, "proposal.xlsx")).code).toBe(
      "output-format",
    );
    // The refusal code this adapter adds for a reference that cannot resolve is a known code.
    expect(DOCUMENT_REFUSAL_CODES).toContain("broken-reference");
  });
});

describe("the Excel operations and their programs", () => {
  it("names six operations, one tool each, in a fixed order", () => {
    expect(XLSX_OPERATIONS).toEqual(["inspect", "read", "create", "edit", "preview", "compare"]);
    expect(XLSX_TOOL_NAMES.inspect).toBe(INSPECT_WORKBOOK);
    expect(XLSX_TOOL_NAMES.read).toBe(READ_WORKBOOK);
    expect(XLSX_TOOL_NAMES.create).toBe(CREATE_WORKBOOK);
    expect(XLSX_TOOL_NAMES.edit).toBe(EDIT_WORKBOOK);
    expect(XLSX_TOOL_NAMES.preview).toBe(PREVIEW_WORKBOOK);
    expect(XLSX_TOOL_NAMES.compare).toBe(COMPARE_WORKBOOK);
    expect(XLSX_TOOL_REGISTRATIONS).toEqual([
      INSPECT_WORKBOOK,
      READ_WORKBOOK,
      CREATE_WORKBOOK,
      EDIT_WORKBOOK,
      PREVIEW_WORKBOOK,
      COMPARE_WORKBOOK,
    ]);
    expect(XLSX_TOOL_ORDER).toEqual(XLSX_OPERATIONS);
  });

  it("sends a fixed program per operation, with nothing interpolated into it", () => {
    for (const operation of XLSX_OPERATIONS) {
      const code = xlsxInstruction(operation);
      // The only variable in a program is the operation's own name; no argument is ever spliced in.
      expect(code).toMatch(
        /^import xlsx_adapter\n\ndocuments\.result\(xlsx_adapter\.run\("[a-z]+", documents\.arguments\(\)\)\)$/u,
      );
      expect(code).not.toContain("$");
    }
  });

  it("registers each tool with the section list its own validator accepts", () => {
    // The schema is what a model sees; XLSX_READ_SECTIONS is what the validator accepts. They agree.
    const read = xlsxTools({ service: SERVICE, leaseFor: async () => LEASE }).find(
      (tool) => tool.name === READ_WORKBOOK,
    );
    const parameters = read?.parameters as { properties?: Record<string, unknown> } | undefined;
    const section = parameters?.properties?.section as
      | { anyOf?: { const?: unknown }[] }
      | undefined;
    const literals = (section?.anyOf ?? []).map((item) => item.const);
    expect(literals).toEqual([...XLSX_READ_SECTIONS]);
  });

  it("registers each schema with the closed argument shape the pack expects", () => {
    const tools = xlsxTools({ service: SERVICE, leaseFor: async () => LEASE });
    expect(tools.map((tool) => tool.name)).toEqual([...XLSX_TOOL_REGISTRATIONS]);
    for (const tool of tools) {
      expect(tool.replay).toBe("safe");
      const parameters = (tool as unknown as { parameters: { additionalProperties?: unknown } })
        .parameters;
      expect(parameters.additionalProperties).toBe(false);
      expect(String(tool.description).length).toBeGreaterThan(120);
    }
    // Every operation that reads a file says the reference rule where a model will read it. `create`
    // takes no source reference: a new draft has nothing to be leased from.
    for (const name of [
      INSPECT_WORKBOOK,
      READ_WORKBOOK,
      EDIT_WORKBOOK,
      PREVIEW_WORKBOOK,
      COMPARE_WORKBOOK,
    ]) {
      const description = String(tools.find((tool) => tool.name === name)?.description);
      expect(description).toContain("file reference");
      expect(description).toContain("lease");
    }
    // The tools that can report arithmetic say what happened instead of calculating.
    for (const name of [
      INSPECT_WORKBOOK,
      CREATE_WORKBOOK,
      EDIT_WORKBOOK,
      PREVIEW_WORKBOOK,
      COMPARE_WORKBOOK,
    ]) {
      const description = String(tools.find((tool) => tool.name === name)?.description);
      expect(description).toContain("recalculation");
      expect(description.toLowerCase()).toContain("no calculation happens in this workspace");
    }
    // The edit tool names the reference rule and the refusal it produces.
    const edit = String(tools.find((tool) => tool.name === EDIT_WORKBOOK)?.description);
    expect(edit).toContain("broken-reference");
    expect(edit).toContain("changed-cell set");
    expect(edit).toContain("numeric checks");
    // Only the edit and compare tools can report a diff, and they say what it is measured with.
    expect(String(tools.find((tool) => tool.name === COMPARE_WORKBOOK)?.description)).toContain(
      "style diff",
    );
  });

  it("offers every tool as replay-safe, and can withhold each typed set", () => {
    const full = paperOfficeToolPack({ service: SERVICE, leaseFor: async () => LEASE });
    expect(full.tools.map((tool) => tool.name)).toEqual([
      RUN_DOCUMENT_PYTHON,
      ...WORD_TOOL_REGISTRATIONS,
      ...PPTX_TOOL_REGISTRATIONS,
      ...XLSX_TOOL_REGISTRATIONS,
    ]);
    for (const tool of full.tools) expect(tool.replay).toBe("safe");

    const withoutXlsx = paperOfficeToolPack({
      service: SERVICE,
      leaseFor: async () => LEASE,
      includeXlsxTools: false,
    });
    expect(withoutXlsx.tools.map((tool) => tool.name)).toEqual([
      RUN_DOCUMENT_PYTHON,
      ...WORD_TOOL_REGISTRATIONS,
      ...PPTX_TOOL_REGISTRATIONS,
    ]);

    const workspaceOnly = paperOfficeToolPack({
      service: SERVICE,
      leaseFor: async () => LEASE,
      includeWordTools: false,
      includePptxTools: false,
      includeXlsxTools: false,
    });
    expect(workspaceOnly.tools.map((tool) => tool.name)).toEqual([RUN_DOCUMENT_PYTHON]);
  });
});

describe("the Excel request validation", () => {
  it("resolves every operation's references and bounds its pages", () => {
    const inspect = xlsxProgram("inspect", { ref: refOf(FILE_A) }, LEASE);
    expect(inspect.sources.map((source) => source.versionId)).toEqual([FILE_A]);
    expect(inspect.output).toBeNull();
    expect(hasUndefined(inspect.arguments)).toBe(false);

    const read = xlsxProgram(
      "read",
      { ref: refOf(FILE_A), section: "cells", sheet: "Revenue", range: "A1:C10", pageSize: 5 },
      LEASE,
    );
    expect(read.arguments).toMatchObject({ section: "cells", sheet: "Revenue", pageSize: 5 });

    // A cells read with neither a sheet nor a range naming one cannot be resolved: refused here.
    expect(
      refusalOf(() => xlsxProgram("read", { ref: refOf(FILE_A), section: "cells" }, LEASE)).code,
    ).toBe("invalid-request");
    expect(
      refusalOf(() => xlsxProgram("read", { ref: refOf(FILE_A), section: "styles" }, LEASE)).code,
    ).toBe("invalid-request");
    expect(
      refusalOf(() =>
        xlsxProgram(
          "read",
          { ref: refOf(FILE_A), section: "cells", sheet: "Revenue", range: "1" },
          LEASE,
        ),
      ).code,
    ).toBe("invalid-request");
    expect(
      refusalOf(() =>
        xlsxProgram(
          "read",
          { ref: refOf(FILE_A), section: "sheets", pageSize: MAX_XLSX_PAGE + 1 },
          LEASE,
        ),
      ).code,
    ).toBe("invalid-request");
    expect(
      refusalOf(() => xlsxProgram("read", { ref: refOf(FILE_A), section: "everything" }, LEASE))
        .code,
    ).toBe("invalid-request");
    // An unknown field is refused rather than ignored, so a caller cannot smuggle anything in.
    expect(
      refusalOf(() =>
        xlsxProgram("read", { ref: refOf(FILE_A), section: "sheets", path: "/etc/hosts" }, LEASE),
      ).code,
    ).toBe("invalid-request");
  });

  it("refuses an edit of an input the lease holds read-only", () => {
    expect(
      refusalOf(() =>
        xlsxProgram(
          "edit",
          {
            ref: refOf(FILE_B),
            output: "proposal.xlsx",
            steps: [{ kind: "setCell", cell: "B2", value: 1 }],
          },
          LEASE,
        ),
      ).code,
    ).toBe("unleased-path");
    // …but a read of it is fine, and an inspect of it too.
    expect(xlsxProgram("inspect", { ref: refOf(FILE_B) }, LEASE).sources[0]?.writable).toBe(false);
  });

  it("validates every edit step kind, its required fields and its closed shape", () => {
    expect(XLSX_STEP_KINDS).toContain("setCell");
    expect(STEP_REQUIRED.setCell).toEqual(["cell"]);
    expect(STEP_OPTIONAL.setCell).toEqual(["sheet", "value", "formula"]);

    const program = (steps: unknown[]) =>
      xlsxProgram("edit", { ref: refOf(FILE_A), output: "proposal.xlsx", steps }, LEASE);

    // setCell: exactly one of value and formula, and a value never silently becomes a formula.
    expect(program([{ kind: "setCell", cell: "B2", value: 1400 }]).output?.editOf).toBe(FILE_A);
    expect(program([{ kind: "setCell", cell: "B2", value: null }]).output?.name).toBe(
      "proposal.xlsx",
    );
    expect(
      program([{ kind: "setCell", cell: "B2", formula: "=SUM(B2:B3)" }]).arguments,
    ).toMatchObject({ steps: [{ kind: "setCell", cell: "B2", formula: "=SUM(B2:B3)" }] });
    expect(refusalOf(() => program([{ kind: "setCell", cell: "B2" }])).code).toBe(
      "invalid-request",
    );
    expect(
      refusalOf(() => program([{ kind: "setCell", cell: "B2", value: 1, formula: "=2" }])).code,
    ).toBe("invalid-request");
    expect(refusalOf(() => program([{ kind: "setCell", cell: "B2", value: "=1+1" }])).code).toBe(
      "invalid-request",
    );
    expect(
      refusalOf(() => program([{ kind: "setCell", cell: "B2", formula: "SUM(B2:B3)" }])).code,
    ).toBe("invalid-request");
    expect(
      refusalOf(() => program([{ kind: "setCell", cell: "B2", value: Number.POSITIVE_INFINITY }]))
        .code,
    ).toBe("invalid-request");
    expect(
      refusalOf(() => program([{ kind: "setCell", cell: "B2", value: 1, style: {} }])).code,
    ).toBe("invalid-request");
    expect(refusalOf(() => program([{ kind: "setCell", cell: "B2", value: {} }])).code).toBe(
      "invalid-request",
    );
    expect(refusalOf(() => program([{ kind: "setCell", cell: "B", value: 1 }])).code).toBe(
      "invalid-request",
    );

    // setRange: a ragged block, a formula, or a range that does not match the block is refused.
    expect(
      program([
        {
          kind: "setRange",
          range: "A1:B2",
          rows: [
            [1, 2],
            [3, 4],
          ],
        },
      ]).arguments,
    ).toMatchObject({
      steps: [
        {
          kind: "setRange",
          range: "A1:B2",
          rows: [
            [1, 2],
            [3, 4],
          ],
        },
      ],
    });
    expect(
      refusalOf(() => program([{ kind: "setRange", range: "A1:B2", rows: [[1], [2, 3]] }])).code,
    ).toBe("invalid-request");
    expect(
      refusalOf(() => program([{ kind: "setRange", range: "A1:B1", rows: [["="]] }])).code,
    ).toBe("invalid-request");
    expect(
      refusalOf(() =>
        program([
          {
            kind: "setRange",
            range: "A1:A4",
            rows: Array.from({ length: 5 }, () => [1]),
          },
        ]),
      ).code,
    ).toBe("invalid-request");
    expect(refusalOf(() => program([{ kind: "setRange", rows: [[1]] }])).code).toBe(
      "invalid-request",
    );

    // clearCells, setStyle and setColumnWidth.
    expect(program([{ kind: "clearCells", range: "A1:B4" }]).arguments).toMatchObject({
      steps: [{ kind: "clearCells", range: "A1:B4" }],
    });
    expect(
      program([{ kind: "setStyle", range: "A1", style: { bold: true, fillColor: "#FFCC00" } }])
        .arguments,
    ).toMatchObject({ steps: [{ kind: "setStyle", range: "A1", style: { bold: true } }] });
    expect(refusalOf(() => program([{ kind: "setStyle", range: "A1", style: {} }])).code).toBe(
      "invalid-request",
    );
    expect(
      refusalOf(() => program([{ kind: "setStyle", range: "A1", style: { color: "nope" } }])).code,
    ).toBe("invalid-request");
    expect(
      refusalOf(() => program([{ kind: "setStyle", range: "A1", style: { numberFormat: 5 } }]))
        .code,
    ).toBe("invalid-request");
    expect(program([{ kind: "setColumnWidth", column: "B", width: 18 }]).arguments).toMatchObject({
      steps: [{ kind: "setColumnWidth", width: 18, columns: ["B"] }],
    });
    expect(
      program([{ kind: "setColumnWidth", columns: ["A", "B"], width: 12 }]).arguments,
    ).toMatchObject({ steps: [{ kind: "setColumnWidth", width: 12, columns: ["A", "B"] }] });
    expect(refusalOf(() => program([{ kind: "setColumnWidth", width: 18 }])).code).toBe(
      "invalid-request",
    );
    expect(
      refusalOf(() => program([{ kind: "setColumnWidth", column: "b1", width: 18 }])).code,
    ).toBe("invalid-request");

    // Sheet lifecycle and names.
    expect(program([{ kind: "addSheet", name: "Review", at: 0 }]).arguments).toMatchObject({
      steps: [{ kind: "addSheet", name: "Review", at: 0 }],
    });
    expect(program([{ kind: "deleteSheet", sheet: "Notes" }]).arguments).toMatchObject({
      steps: [{ kind: "deleteSheet", sheet: "Notes" }],
    });
    expect(
      program([{ kind: "renameSheet", sheet: "Notes", to: "Notes 2" }]).arguments,
    ).toMatchObject({ steps: [{ kind: "renameSheet", sheet: "Notes", to: "Notes 2" }] });
    expect(
      program([{ kind: "setName", name: "Total", reference: "Revenue!$B$4" }]).arguments,
    ).toMatchObject({ steps: [{ kind: "setName", name: "Total", reference: "Revenue!$B$4" }] });
    expect(refusalOf(() => program([{ kind: "setName", reference: "Revenue!$B$4" }])).code).toBe(
      "invalid-request",
    );
    expect(
      refusalOf(() => program([{ kind: "setName", name: "1bad", reference: "A!B" }])).code,
    ).toBe("invalid-request");
    expect(program([{ kind: "removeName", name: "Total" }]).arguments).toMatchObject({
      steps: [{ kind: "removeName", name: "Total", scope: "workbook" }],
    });
    expect(
      program([{ kind: "removeName", name: "Total", scope: "sheet", sheet: "Revenue" }]).arguments,
    ).toMatchObject({ steps: [{ kind: "removeName", name: "Total", scope: "sheet" }] });
    expect(
      refusalOf(() => program([{ kind: "removeName", name: "Total", scope: "book" }])).code,
    ).toBe("invalid-request");
    expect(refusalOf(() => program([{ kind: "frobnicate" }])).code).toBe("invalid-request");
  });

  it("bounds the number of steps and the size of a request", () => {
    const steps = Array.from({ length: MAX_XLSX_STEPS + 1 }, () => ({
      kind: "clearCells" as const,
      range: "A1",
    }));
    expect(
      refusalOf(() =>
        xlsxProgram("edit", { ref: refOf(FILE_A), output: "proposal.xlsx", steps }, LEASE),
      ).code,
    ).toBe("invalid-request");
    expect(
      refusalOf(() =>
        xlsxProgram("edit", { ref: refOf(FILE_A), output: "p.xlsx", steps: [] }, LEASE),
      ).code,
    ).toBe("invalid-request");
    // A step given as a string is not a step.
    expect(
      refusalOf(() =>
        xlsxProgram("edit", { ref: refOf(FILE_A), output: "p.xlsx", steps: ["x"] }, LEASE),
      ).code,
    ).toBe("invalid-request");
    expect(assertXlsxStep({ kind: "clearCells", range: "A1" }, 0)).toEqual({
      kind: "clearCells",
      range: "A1",
    });
    expect(refusalOf(() => assertXlsxStep({ kind: "setFormula", cell: "A1" }, 3)).code).toBe(
      "invalid-request",
    );
  });

  it("validates a created workbook's sheets", () => {
    const program = (sheets: unknown[]) =>
      xlsxProgram("create", { output: "new.xlsx", sheets }, LEASE);

    const created = program([
      {
        name: "Summary",
        rows: [
          ["Account", "Amount"],
          ["Revenue", 1250],
          ["Total", "=SUM(B2:B2)"],
        ],
        styles: [{ range: "A1:B1", style: { bold: true } }],
        names: [{ name: "Amounts", reference: "Summary!$B$2:$B$2" }],
        columnWidths: [{ column: "B", width: 18 }],
        freeze: "A2",
      },
    ]);
    expect(created.output).toEqual({ name: "new.xlsx", editOf: null });
    expect(hasUndefined(created.arguments)).toBe(false);
    // A draft may carry a formula as a string beginning with =, because that is how a draft's totals
    // are laid out from source data — and it is documented in the schema a model reads.
    const createdSheets = created.arguments.sheets as readonly {
      readonly name: string;
      readonly rows: readonly (readonly unknown[])[];
      readonly styles: readonly unknown[];
      readonly freeze: string;
    }[];
    expect(createdSheets[0]?.name).toBe("Summary");
    expect(createdSheets[0]?.rows[2]).toEqual(["Total", "=SUM(B2:B2)"]);
    expect(createdSheets[0]?.styles).toHaveLength(1);
    expect(createdSheets[0]?.freeze).toBe("A2");

    expect(refusalOf(() => program([])).code).toBe("invalid-request");
    expect(refusalOf(() => program([{ name: "Summary" }])).code).toBe("invalid-request");
    expect(refusalOf(() => program([{ name: "Summary", rows: [] }])).code).toBe("invalid-request");
    expect(refusalOf(() => program([{ name: "Summary", rows: [["a"], ["b", "c"]] }])).code).toBe(
      "invalid-request",
    );
    expect(
      refusalOf(() =>
        program([
          { name: "Summary", rows: [["a"]], styles: [{ range: "A1", style: { size: 0 } }] },
        ]),
      ).code,
    ).toBe("invalid-request");
    // A name whose reference points at a sheet that does not exist is a *runtime* refusal — the
    // adapter resolves it against the workbook it is writing — so it passes here and is refused there.
    expect(
      program([{ name: "Summary", rows: [["a"]], names: [{ name: "N", reference: "Missing!A1" }] }])
        .arguments,
    ).toMatchObject({ sheets: [{ names: [{ name: "N", reference: "Missing!A1" }] }] });
    expect(
      refusalOf(() => program([{ name: "Summary", rows: [["a"]], columnWidths: [{ width: 300 }] }]))
        .code,
    ).toBe("invalid-request");
    expect(refusalOf(() => program([{ name: "Summary", rows: [["a"]], freeze: "1" }])).code).toBe(
      "invalid-request",
    );
    expect(
      refusalOf(() =>
        program(
          Array.from({ length: MAX_XLSX_SHEETS + 1 }, (_item, index) => ({
            name: `S${index}`,
            rows: [[1]],
          })),
        ),
      ).code,
    ).toBe("invalid-request");
    // A block larger than this adapter writes in one call is refused with the limit named.
    expect(
      refusalOf(() =>
        program([
          {
            name: "Big",
            rows: Array.from({ length: 10 }, () => Array.from({ length: 500 }, () => 1)),
          },
        ]),
      ).code,
    ).toBe("invalid-request");
    expect(() => assertXlsxSheet({ name: "Summary", rows: [[1]] }, 0)).not.toThrow();
    expect(
      refusalOf(() => assertXlsxSheet({ name: "Summary", rows: [[1]], nope: 1 }, 0)).code,
    ).toBe("invalid-request");
  });

  it("keeps every argument JSON-hashable, so a receipt can bind them", () => {
    const programs = [
      xlsxProgram("inspect", { ref: refOf(FILE_A) }, LEASE),
      xlsxProgram("read", { ref: refOf(FILE_A), section: "sheets" }, LEASE),
      xlsxProgram("preview", { ref: refOf(FILE_A), cursor: 3 }, LEASE),
      xlsxProgram(
        "create",
        { output: "new.xlsx", sheets: [{ name: "S", rows: [[1, null]] }] },
        LEASE,
      ),
      xlsxProgram(
        "edit",
        {
          ref: refOf(FILE_A),
          output: "proposal.xlsx",
          steps: [{ kind: "setCell", cell: "B2", value: null }],
        },
        LEASE,
      ),
      xlsxProgram("compare", { from: refOf(FILE_A), to: refOf(FILE_B) }, LEASE),
    ];
    for (const program of programs) {
      expect(hasUndefined(program.arguments)).toBe(false);
      const intent = intentForRun({
        operationId: "conv:call",
        taskId: "task:xlsx",
        policyVersion: POLICY_VERSION,
        code: program.code,
        arguments: program.arguments,
        lease: LEASE,
      });
      expect(intentSha256(intent)).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("refuses a comparison whose two references are the same granted version twice", () => {
    const same = xlsxProgram("compare", { from: refOf(FILE_A), to: refOf(FILE_A) }, LEASE);
    expect(same.sources.map((source) => source.versionId)).toEqual([FILE_A, FILE_A]);
    expect(
      refusalOf(() => xlsxProgram("compare", { from: refOf(FILE_A), to: refOf(FILE_C) }, LEASE))
        .code,
    ).toBe("ungranted-input");
    expect(refusalOf(() => xlsxProgram("compare", { from: refOf(FILE_A) }, LEASE)).code).toBe(
      "invalid-request",
    );
  });

  it("declares the style fields and the step kinds it accepts", () => {
    expect([...XLSX_STYLE_FIELDS]).toEqual([
      "bold",
      "italic",
      "size",
      "name",
      "color",
      "fillColor",
      "numberFormat",
      "horizontal",
      "vertical",
      "wrapText",
    ]);
    expect([...XLSX_STEP_KINDS]).toEqual([
      "setCell",
      "setRange",
      "clearCells",
      "setStyle",
      "setColumnWidth",
      "addSheet",
      "deleteSheet",
      "renameSheet",
      "setName",
      "removeName",
    ]);
    expect(MAX_XLSX_RANGE_CELLS).toBe(4096);
  });
});

describe("the Excel tools, driven only through the injected service", () => {
  it("refuses with the service's own answer, and never reaches the worker twice", async () => {
    const seen: string[] = [];
    const pack = paperOfficeToolPack({
      service: {
        async runDocumentPython(request) {
          seen.push(request.code);
          return {
            kind: "refused",
            operationId: request.operationId,
            code: "worker-refused",
            message: "a bare-harness fake",
          };
        },
      },
      leaseFor: async () => LEASE,
    });
    const tool = pack.tools.find((item) => item.name === INSPECT_WORKBOOK) as unknown as {
      execute(
        args: unknown,
        api: { taskId: string; conversationId: string; callId: string },
      ): Promise<{
        isError?: boolean;
        output: { text: string }[];
        details?: Record<string, unknown>;
      }>;
    };
    const answer = await tool.execute(
      { ref: refOf(FILE_A) },
      { taskId: "task:xlsx", conversationId: "conv", callId: "call-1" },
    );
    expect(answer.isError).toBe(true);
    expect(seen).toEqual([xlsxInstruction("inspect")]);
    expect(JSON.parse(answer.output[0]?.text ?? "{}")).toMatchObject({
      ok: false,
      code: "worker-refused",
      operation: "inspect",
    });
  });

  it("refuses when this task has no lease at all", async () => {
    const pack = paperOfficeToolPack({
      service: {
        async runDocumentPython() {
          throw new Error("no lease means no run");
        },
      },
      leaseFor: async () => undefined,
    });
    const tool = pack.tools.find((item) => item.name === READ_WORKBOOK) as unknown as {
      execute(
        args: unknown,
        api: unknown,
      ): Promise<{ isError?: boolean; output: { text: string }[] }>;
    };
    const answer = await tool.execute(
      { ref: refOf(FILE_A), section: "sheets" },
      { taskId: "task:xlsx", conversationId: "conv", callId: "call-1" },
    );
    expect(answer.isError).toBe(true);
    expect(JSON.parse(answer.output[0]?.text ?? "{}")).toMatchObject({ code: "no-lease" });
  });
});

describe("the Excel result validator", () => {
  const SOURCE = {
    fileId: FILE_A,
    versionId: FILE_A,
    name: "close.xlsx",
    sha256: "a".repeat(64),
    size: 1024,
  };

  const CENSUS = {
    sheets: 1,
    chartsheets: 0,
    hiddenSheets: 0,
    protectedSheets: 0,
    namedRanges: 0,
    sheetScopedNames: 0,
    cells: 2,
    formulas: 1,
    styledCells: 0,
    tables: 0,
    mergedRanges: 0,
    dataValidations: 0,
    conditionalFormatting: 0,
    charts: 0,
    chartParts: 0,
    pivotParts: 0,
    macros: false,
    calcChain: false,
    parts: 6,
  };

  const PACKAGE = { parts: 6, macros: false, externalLinks: [], calcChain: false };

  const RECALC = {
    available: false,
    attempted: false,
    computed: false,
    engine: "openpyxl.oracle (headless LibreOffice)",
    engineInProcess: false,
    processSpawned: false,
    reason: "no LibreOffice installation was found and this worker cannot spawn a process",
    unsupportedFunctions: ["LAMBDA", "LET"],
    unsupportedFunctionCount: 2,
    limits: ["this library never calculates formulas itself"],
    limitsNote: "the functions above are ones the oracle would refuse anyway",
    workbookRequest: { requestsRecalculation: true, fullCalcOnLoad: "1" },
  };

  const PROTECTIONS = {
    protectedSheets: [],
    protectedSheetCount: 0,
    structureLocked: false,
    enforced: false,
    note: "protection is reported, never enforced",
  };

  const CHECK = {
    checkedReferences: 3,
    checkedSurfaces: 2,
    kinds: { "cell-range": 2, "defined-name": 1 },
    broken: [],
    brokenTotal: 0,
    brokenTruncated: false,
    brokenKinds: [],
    unscannable: [],
    clean: true,
    scope: "inspect",
    partsScanned: 6,
  };

  const SHEET = {
    position: 0,
    title: "Revenue",
    part: "xl/worksheets/sheet1.xml",
    state: "visible",
    dimensions: "A1:B2",
    usedRange: "A1:B2",
    maxRow: 2,
    maxColumn: 2,
    cells: 2,
    formulas: 1,
    styledCells: 0,
    namedRanges: 0,
    mergedRanges: 0,
    tables: 0,
    charts: 0,
    protected: false,
    freezePanes: null,
    autoFilter: false,
    dataValidations: 0,
    conditionalFormatting: 0,
  };

  const CELL = {
    sheet: "Revenue",
    address: "Revenue!B2",
    row: 2,
    column: 2,
    value: 1250,
    valueKind: "number",
    exact: "1250",
    formula: null,
    formulaTruncated: false,
    cachedValue: null,
    cachedKnown: false,
    nonFinite: false,
    numberFormat: "#,##0.00",
    styled: true,
  };

  const CHANGE_SET = {
    schema: "package_diff",
    version: 1,
    added: [],
    removed: [],
    changed: [
      {
        part: "xl/worksheets/sheet1.xml",
        kind: "xml",
        detail: ["/worksheet/sheetData[4]/row[1]/c[1]/v[0]: text '1250' != '1400'"],
        detailTotal: 1,
        beforeSha256: "b".repeat(64),
        afterSha256: "c".repeat(64),
        semanticChange: true,
      },
    ],
    byteIdentical: ["xl/styles.xml"],
    byteIdenticalCount: 1,
    partCountBefore: 6,
    partCountAfter: 6,
    semanticallyEmpty: false,
  };

  const PRESERVATION = {
    byteIdenticalCount: 1,
    byteIdentical: [{ part: "/xl/styles.xml", sha256: "d".repeat(64) }],
    byteIdenticalTruncated: false,
    byteIdenticalHashed: 1,
    changedParts: ["xl/worksheets/sheet1.xml"],
    addedParts: [],
    removedParts: [],
    worksheetByteIdentical: [],
    chartByteIdentical: [],
    mediaByteIdentical: [],
    themeByteIdentical: [],
    styleByteIdentical: ["/xl/styles.xml"],
    drawingByteIdentical: [],
    pivotByteIdentical: [],
    verbatimCopy: false,
  };

  const RECEIPT = {
    schema: "edit_receipt",
    version: 2,
    cellsChanged: {
      parts: { "xl/worksheets/sheet1.xml": { B2: "changed" } },
      total: 1,
      truncated: false,
    },
    partsChanged: ["xl/worksheets/sheet1.xml"],
    partsAdded: [],
    partsRemoved: [],
    confession: [],
    confessionTotal: 0,
    derivedEffects: [
      { kind: "formula_cache_removed", part: "xl/worksheets/sheet1.xml", cell: "B3" },
    ],
    derivedEffectsTotal: 1,
    recalc: null,
  };

  const REOPENED = {
    sheets: 1,
    cells: 2,
    formulas: 1,
    namedRanges: 0,
    styledCells: 0,
    tables: 0,
    charts: 0,
    chartParts: 0,
    parts: 6,
    referenceCheck: 0,
  };

  function diff(overrides: Record<string, unknown> = {}) {
    return {
      cells: [
        {
          address: "Revenue!B2",
          before: 1250,
          after: 1400,
          beforeType: "n",
          afterType: "n",
          kind: "value",
          shifted: false,
        },
      ],
      cellsTotal: 1,
      cellsTruncated: false,
      styleChanges: [],
      styleChangesTotal: 0,
      dependencies: [
        {
          formulaCell: "'Revenue'!B3",
          reference: "B2:B2",
          changedCell: "B2",
          sheet: "revenue",
          sameSheet: true,
        },
      ],
      dependenciesTotal: 1,
      numericChecks: [
        {
          address: "Revenue!B2",
          kind: "value-change",
          before: 1250,
          after: 1400,
          exactBefore: "1250",
          exactAfter: "1400",
          delta: 150,
          deltaExact: "150",
          method: "read-both-packages",
          note: null,
          sum: null,
        },
      ],
      numericChecksTotal: 1,
      numericChecksTruncated: false,
      measurement: "the fork's own cell diff, plus this adapter reading both packages",
      ...overrides,
    };
  }

  function inspection(overrides: Record<string, unknown> = {}) {
    return {
      schema: "paper_xlsx_operation",
      version: 1,
      operation: "inspect",
      ok: true,
      source: { ...SOURCE },
      workbook: { ...CENSUS },
      sheetOutline: [{ ...SHEET }],
      sheetOutlineTruncated: false,
      namedRanges: [],
      namedRangesTruncated: false,
      chartOutline: [],
      chartOutlineTruncated: false,
      unmodeledChartParts: [],
      package: { ...PACKAGE },
      referenceCheck: { ...CHECK },
      recalculation: { ...RECALC },
      protections: { ...PROTECTIONS },
      warnings: [],
      ...overrides,
    };
  }

  function reading(overrides: Record<string, unknown> = {}) {
    return {
      schema: "paper_xlsx_operation",
      version: 1,
      operation: "read",
      ok: true,
      source: { ...SOURCE },
      workbook: { ...CENSUS },
      page: {
        section: "cells",
        pageSize: 2,
        cursor: 0,
        returned: 1,
        total: 1,
        nextCursor: null,
        hasMore: false,
        items: [{ ...CELL }],
      },
      sectionRange: {
        sheet: "Revenue",
        requested: null,
        window: "A1:B2",
        clamped: false,
        note: null,
      },
      cachedValuesRead: true,
      package: { ...PACKAGE },
      ...overrides,
    };
  }

  function edit(overrides: Record<string, unknown> = {}) {
    return {
      schema: "paper_xlsx_operation",
      version: 1,
      operation: "edit",
      ok: true,
      source: { ...SOURCE },
      proposal: {
        status: "proposed",
        name: "proposal.xlsx",
        editOf: FILE_A,
        sha256: "e".repeat(64),
        size: 2048,
        published: false,
      },
      editReceipt: { ...RECEIPT },
      changes: [{ kind: "setCell", evidence: { cell: "Revenue!B2", written: "value" } }],
      steps: ["setCell"],
      changeSet: { ...CHANGE_SET },
      preservation: { ...PRESERVATION },
      diff: diff(),
      referenceCheck: {
        source: { ...CHECK, scope: "the leased input" },
        output: { ...CHECK, scope: "the written workbook" },
        sourceBroken: 0,
        outputBroken: 0,
        newBroken: [],
        note: "an operation that would add a broken reference is refused before anything is written",
      },
      recalculation: { ...RECALC },
      protections: { ...PROTECTIONS },
      reopened: { ...REOPENED },
      warnings: [],
      ...overrides,
    };
  }

  it("accepts a well-formed inspection and reports what it carries", () => {
    const result = parseXlsxResult("inspect", inspection(), [SOURCE]);
    expect(result.operation).toBe("inspect");
    if (result.operation !== "inspect") throw new Error("unreachable");
    expect(result.workbook.sheets).toBe(1);
    expect(result.sheetOutline[0]?.part).toBe("xl/worksheets/sheet1.xml");
    expect(result.referenceCheck.clean).toBe(true);
    expect(result.recalculation.computed).toBe(false);
    expect(result.recalculation.unsupportedFunctions).toEqual(["LAMBDA", "LET"]);
  });

  it("refuses an answer about a version this call never named", () => {
    for (const [operation, payload] of [
      ["inspect", inspection({ source: { ...SOURCE, sha256: "b".repeat(64) } })],
      ["read", reading({ source: { ...SOURCE, size: 99 } })],
      ["edit", edit({ source: { ...SOURCE, versionId: FILE_B } })],
    ] as const) {
      expect(refusalOf(() => parseXlsxResult(operation, payload, [SOURCE])).code).toBe(
        "output-invalid",
      );
    }
  });

  it("refuses an answer to a different operation, or one that is not this adapter's", () => {
    expect(
      refusalOf(() => parseXlsxResult("inspect", { ...inspection(), operation: "read" }, [SOURCE]))
        .code,
    ).toBe("output-invalid");
    expect(
      refusalOf(() =>
        parseXlsxResult("inspect", { ...inspection(), schema: "paper_pptx_operation" }, [SOURCE]),
      ).code,
    ).toBe("output-invalid");
    expect(
      refusalOf(() => parseXlsxResult("inspect", { ...inspection(), ok: false }, [SOURCE])).code,
    ).toBe("output-invalid");
    expect(
      refusalOf(() => parseXlsxResult("inspect", { ...inspection(), version: 2 }, [SOURCE])).code,
    ).toBe("output-invalid");
  });

  it("refuses a page that is inconsistent with itself", () => {
    const page = reading();
    const withPage = (patch: Record<string, unknown>) =>
      reading({ page: { ...page.page, ...patch } });
    expect(refusalOf(() => parseXlsxResult("read", withPage({ returned: 2 }), [SOURCE])).code).toBe(
      "output-invalid",
    );
    expect(refusalOf(() => parseXlsxResult("read", withPage({ total: 0 }), [SOURCE])).code).toBe(
      "output-invalid",
    );
    expect(
      refusalOf(() => parseXlsxResult("read", withPage({ pageSize: MAX_XLSX_PAGE + 1 }), [SOURCE]))
        .code,
    ).toBe("output-invalid");
    expect(
      refusalOf(() => parseXlsxResult("read", withPage({ nextCursor: 9, hasMore: true }), [SOURCE]))
        .code,
    ).toBe("output-invalid");
    expect(
      refusalOf(() =>
        parseXlsxResult("read", reading({ page: { ...page.page, section: "everything" } }), [
          SOURCE,
        ]),
      ).code,
    ).toBe("output-invalid");
  });

  it("validates a page's items against the section the page promises", () => {
    const sheetPage = reading({
      page: {
        section: "sheets",
        pageSize: 2,
        cursor: 0,
        returned: 1,
        total: 1,
        nextCursor: null,
        hasMore: false,
        items: [{ ...SHEET }],
      },
    });
    const result = parseXlsxResult("read", sheetPage, [SOURCE]);
    if (result.operation !== "read") throw new Error("unreachable");
    expect(result.page.items[0]).toMatchObject({ title: "Revenue" });
    // A sheet outline where a page promised cells is refused, not coerced.
    expect(
      refusalOf(() =>
        parseXlsxResult(
          "read",
          reading({
            page: {
              section: "sheets",
              pageSize: 2,
              cursor: 0,
              returned: 1,
              total: 1,
              nextCursor: null,
              hasMore: false,
              items: [{ ...CELL }],
            },
          }),
          [SOURCE],
        ),
      ).code,
    ).toBe("output-invalid");
  });

  it("refuses a recalculation block that claims what this workspace cannot do", () => {
    const withRecalc = (patch: Record<string, unknown>) =>
      inspection({ recalculation: { ...RECALC, ...patch } });
    for (const patch of [
      { computed: true },
      { attempted: true },
      { processSpawned: true },
      { engineInProcess: true },
      { unsupportedFunctions: [], unsupportedFunctionCount: 0 },
    ]) {
      expect(refusalOf(() => parseXlsxResult("inspect", withRecalc(patch), [SOURCE])).code).toBe(
        "output-invalid",
      );
    }
    // A worker that cannot say why it did not recalculate has nothing for a reviewer to read.
    const silent = withRecalc({ reason: "" });
    expect(refusalOf(() => parseXlsxResult("inspect", silent, [SOURCE])).code).toBe(
      "output-invalid",
    );
  });

  it("refuses a reference check whose verdict contradicts its own findings", () => {
    const withCheck = (patch: Record<string, unknown>) =>
      inspection({ referenceCheck: { ...CHECK, ...patch } });
    const broken = {
      where: "formula at Revenue!F1",
      owner: "cell",
      raw: "Missing!A1",
      kind: "missing-sheet",
      resolved: false,
      detail: "no sheet named 'Missing'",
    };
    expect(
      refusalOf(() => parseXlsxResult("inspect", withCheck({ clean: false }), [SOURCE])).code,
    ).toBe("output-invalid");
    expect(
      refusalOf(() =>
        parseXlsxResult(
          "inspect",
          withCheck({ brokenTotal: 1, broken: [], brokenKinds: ["missing-sheet"] }),
          [SOURCE],
        ),
      ).code,
    ).toBe("output-invalid");
    expect(
      refusalOf(() =>
        parseXlsxResult(
          "inspect",
          withCheck({ brokenTotal: 1, broken: [{ ...broken, resolved: true }], clean: false }),
          [SOURCE],
        ),
      ).code,
    ).toBe("output-invalid");
    // …and a well-formed broken report is accepted, with the finding intact.
    const accepted = parseXlsxResult(
      "inspect",
      withCheck({ brokenTotal: 1, broken: [broken], brokenKinds: ["missing-sheet"], clean: false }),
      [SOURCE],
    );
    if (accepted.operation !== "inspect") throw new Error("unreachable");
    expect(accepted.referenceCheck.broken[0]).toMatchObject({
      kind: "missing-sheet",
      detail: "no sheet named 'Missing'",
    });
  });

  it("refuses a proposal that is published, or breaks the references it was refused for", () => {
    expect(
      refusalOf(() =>
        parseXlsxResult("edit", edit({ proposal: { ...edit().proposal, published: true } }), [
          SOURCE,
        ]),
      ).code,
    ).toBe("output-invalid");
    expect(refusalOf(() => parseXlsxResult("edit", edit({ steps: [1] }), [SOURCE])).code).toBe(
      "output-invalid",
    );
    const referenceCheck = {
      ...edit().referenceCheck,
      newBroken: [
        {
          where: "formula at Revenue!H1",
          owner: "cell",
          raw: "Nope!A1",
          kind: "missing-sheet",
          resolved: false,
          detail: "no sheet named 'Nope'",
        },
      ],
    };
    expect(refusalOf(() => parseXlsxResult("edit", edit({ referenceCheck }), [SOURCE])).code).toBe(
      "output-invalid",
    );
    // The changed-cell set is the receipt's own: a bounded sample keeps the exact total beside it,
    // so a trimmed mapping is still reportable — and the total is what a reviewer reads.
    const bounded = parseXlsxResult(
      "edit",
      edit({
        editReceipt: {
          ...RECEIPT,
          cellsChanged: {
            parts: { "xl/worksheets/sheet1.xml": { B2: "changed" } },
            total: 9,
            truncated: true,
          },
        },
      }),
      [SOURCE],
    );
    if (bounded.operation !== "edit") throw new Error("unreachable");
    expect(bounded.editReceipt.cellsChanged.total).toBe(9);
    expect(bounded.editReceipt.cellsChanged.truncated).toBe(true);
    expect(bounded.editReceipt.cellsChanged.parts["xl/worksheets/sheet1.xml"]?.B2).toBe("changed");
  });

  it("refuses a numeric check that claims to agree without the sum and the cached value", () => {
    const withChecks = (checks: unknown[]) =>
      edit({ diff: diff({ numericChecks: checks, numericChecksTotal: checks.length }) });
    const sum = {
      function: "SUM",
      range: "B2:B3",
      adapterSum: 1650,
      adapterSumExact: "1650",
      cells: ["B2", "B3"],
      cellsTruncated: false,
      blankCells: 0,
      nonNumericCells: [],
      workbookCachedValue: 1650,
      workbookCachedKnown: true,
      agrees: true,
      reason: null,
      side: "after",
    };
    const check = { ...diff().numericChecks[0], kind: "value-change-with-sum", sum };

    const accepted = parseXlsxResult("edit", withChecks([check]), [SOURCE]);
    if (accepted.operation !== "edit") throw new Error("unreachable");
    expect(accepted.diff.numericChecks[0]?.sum?.agrees).toBe(true);
    expect(accepted.diff.numericChecks[0]?.sum?.adapterSumExact).toBe("1650");

    // A sum that agrees must carry the sum it computed…
    const { adapterSumExact: _omitted, ...noSum } = sum;
    expect(
      refusalOf(() => parseXlsxResult("edit", withChecks([{ ...check, sum: noSum }]), [SOURCE]))
        .code,
    ).toBe("output-invalid");
    // …and the cached value it compared against.
    const { workbookCachedKnown: _known, ...noCache } = sum;
    expect(
      refusalOf(() => parseXlsxResult("edit", withChecks([{ ...check, sum: noCache }]), [SOURCE]))
        .code,
    ).toBe("output-invalid");
    // A sum it could not compare must say why.
    expect(
      refusalOf(() =>
        parseXlsxResult(
          "edit",
          withChecks([{ ...check, sum: { ...sum, agrees: null, reason: null } }]),
          [SOURCE],
        ),
      ).code,
    ).toBe("output-invalid");
    // A check whose delta is not a number is refused rather than shown as a figure.
    expect(
      refusalOf(() =>
        parseXlsxResult("edit", withChecks([{ ...diff().numericChecks[0], delta: "150" }]), [
          SOURCE,
        ]),
      ).code,
    ).toBe("output-invalid");
  });

  it("refuses a draft that claims a source, and accepts one that does not", () => {
    const draft = {
      schema: "paper_xlsx_operation",
      version: 1,
      operation: "create",
      ok: true,
      draft: {
        status: "draft",
        name: "new.xlsx",
        editOf: null,
        sha256: "f".repeat(64),
        size: 2048,
        published: false,
      },
      structure: { ...CENSUS },
      placements: [
        {
          name: "Summary",
          rows: 1,
          columns: 2,
          at: "A1",
          cellsWritten: 2,
          formulas: 0,
          styles: 0,
          namedRanges: 0,
          cellsPresent: 2,
        },
      ],
      namedRanges: [],
      provenance: { template: "paper-xlsx default", source: null, note: "no engine ran" },
      reopened: { ...REOPENED },
      parts: { Summary: "xl/worksheets/sheet1.xml" },
      unmodeledChartParts: [],
      recalculation: { ...RECALC },
      warnings: [],
    };
    const result = parseXlsxResult("create", draft, []);
    if (result.operation !== "create") throw new Error("unreachable");
    expect(result.draft.editOf).toBeNull();
    expect(result.placements[0]?.cellsPresent).toBe(2);
    expect(
      refusalOf(() =>
        parseXlsxResult(
          "create",
          { ...draft, provenance: { ...draft.provenance, source: FILE_A } },
          [],
        ),
      ).code,
    ).toBe("output-invalid");
    expect(
      refusalOf(() =>
        parseXlsxResult("create", { ...draft, draft: { ...draft.draft, published: true } }, []),
      ).code,
    ).toBe("output-invalid");
  });

  it("checks both references of a comparison against the versions this call named", () => {
    const other = { ...SOURCE, fileId: FILE_B, versionId: FILE_B, name: "revised.xlsx" };
    const comparison = {
      schema: "paper_xlsx_operation",
      version: 1,
      operation: "compare",
      ok: true,
      sources: { from: { ...SOURCE }, to: { ...other } },
      changeSet: { ...CHANGE_SET },
      preservation: { ...PRESERVATION },
      diff: { ...diff(), identical: false },
      referenceCheck: {
        from: { ...CHECK, scope: "the compared source" },
        to: { ...CHECK, scope: "the compared target" },
      },
      recalculation: { ...RECALC },
      reopened: { ...REOPENED },
      warnings: [],
      identical: false,
    };
    const result = parseXlsxResult("compare", comparison, [SOURCE, other]);
    expect(result.operation).toBe("compare");
    if (result.operation !== "compare") throw new Error("unreachable");
    expect(result.identical).toBe(false);
    expect(result.sources.to.name).toBe("revised.xlsx");
    // A comparison that reports a version this call never named is refused.
    expect(
      refusalOf(() =>
        parseXlsxResult("compare", comparison, [SOURCE, { ...SOURCE, sha256: "9".repeat(64) }]),
      ).code,
    ).toBe("output-invalid");
    expect(
      refusalOf(() =>
        parseXlsxResult("compare", { ...comparison, operation: "edit" }, [SOURCE, other]),
      ).code,
    ).toBe("output-invalid");
  });
});
