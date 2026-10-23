/**
 * The typed PowerPoint contract, without an interpreter.
 *
 * Everything here is enforced in process, before any Python is spawned: the file references against the
 * lease, the page bounds, the output name, the edit steps, the create blocks, and the shape of the
 * answer the worker is allowed to give. These tests always run — they never need
 * `OFFICEHUM_PAPER_PYTHON` — which is what keeps the refusals enforced on a host with no provisioned
 * interpreter.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCUMENT_REFUSAL_CODES, DocumentError } from "./errors.js";
import { DEFAULT_LIMITS, type DocumentLease } from "./lease.js";
import { intentForRun, intentSha256, POLICY_VERSION } from "./operation.js";
import {
  assertPptxStep,
  COMPARE_PRESENTATION,
  COMPOSE_PRESENTATION,
  CREATE_PRESENTATION,
  EDIT_PRESENTATION,
  INSPECT_PRESENTATION,
  isPptxInput,
  MAX_PPTX_PAGE,
  MAX_PPTX_STEPS,
  PPTX_COMPOSE_MODES,
  PPTX_DIFF_DETAILS,
  PPTX_OPERATIONS,
  PPTX_READ_SECTIONS,
  PPTX_TOOL_NAMES,
  PREVIEW_PRESENTATION,
  parsePptxResult,
  pptxInstruction,
  pptxProgram,
  READ_PRESENTATION,
  resolvePptxOutput,
  resolvePptxRef,
  STEP_OPTIONAL,
  STEP_REQUIRED,
} from "./pptx-operations.js";
import { PPTX_TOOL_ORDER, PPTX_TOOL_REGISTRATIONS, pptxTools } from "./pptx-tools.js";
import { paperOfficeToolPack, RUN_DOCUMENT_PYTHON } from "./run-document-python.js";
import { pptxPackage, sha256, utf8 } from "./test-helpers.js";
import { WORD_TOOL_REGISTRATIONS } from "./word-tools.js";

const FILE_A = `file_${"A".repeat(26)}`;
const FILE_B = `file_${"B".repeat(26)}`;
const FILE_C = `file_${"C".repeat(26)}`;
const PPTX = pptxPackage();

function leased(fileId: string, name: string, writable = true, bytes = PPTX) {
  return {
    fileId,
    versionId: fileId,
    name,
    format: "pptx" as const,
    sha256: sha256(bytes),
    size: bytes.byteLength,
    writable,
  };
}

const LEASE: DocumentLease = {
  leaseId: "lease:pptx",
  taskId: "task:pptx",
  inputs: [leased(FILE_A, "brief.pptx"), leased(FILE_B, "appendix.pptx", false)],
  outputFormats: ["pptx"],
  limits: DEFAULT_LIMITS,
  expiresAt: "2999-01-01T00:00:00.000Z",
};

function refOf(fileId: string, bytes = PPTX) {
  return {
    fileId,
    versionId: fileId,
    name: fileId === FILE_A ? "brief.pptx" : "appendix.pptx",
    sha256: sha256(bytes),
    size: bytes.byteLength,
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

const ANCHOR = {
  part: "/ppt/slides/slide2.xml",
  block_index: 1,
  content_hash: "a".repeat(64),
  version: 2,
  locator: { kind: "shape", shape_id: 3, paragraph_index: 0 },
};

describe("a PowerPoint operation takes a leased file reference, never a path", () => {
  it("resolves a reference the lease pinned, and refuses anything else", () => {
    const leasedInput = resolvePptxRef(LEASE, refOf(FILE_A), "the ref");
    expect(leasedInput.versionId).toBe(FILE_A);
    expect(leasedInput.writable).toBe(true);
    expect(isPptxInput(leasedInput)).toBe(true);

    expect(
      refusalOf(() =>
        resolvePptxRef(LEASE, { ...refOf(FILE_A), versionId: FILE_C, fileId: FILE_C }, "the ref"),
      ).code,
    ).toBe("ungranted-input");

    // A reference whose hash does not match the version the lease pinned is not that version.
    expect(
      refusalOf(() =>
        resolvePptxRef(LEASE, { ...refOf(FILE_A), sha256: "b".repeat(64) }, "the ref"),
      ).code,
    ).toBe("ungranted-input");

    // There is no shape a caller can send that names a path: an extra field is refused outright.
    expect(
      refusalOf(() => resolvePptxRef(LEASE, { ...refOf(FILE_A), path: "/etc/hosts" }, "the ref"))
        .code,
    ).toBe("invalid-request");
    expect(refusalOf(() => resolvePptxRef(LEASE, refOf(FILE_A).versionId, "the ref")).code).toBe(
      "invalid-request",
    );
  });

  it("refuses a reference to a file that is not a PowerPoint deck", () => {
    const lease: DocumentLease = {
      ...LEASE,
      inputs: [{ ...leased(FILE_A, "report.docx"), format: "docx" }],
    };
    expect(
      refusalOf(() => resolvePptxRef(lease, { ...refOf(FILE_A), name: "report.docx" }, "the ref"))
        .code,
    ).toBe("invalid-request");
  });

  it("takes one staging file name for an output, and refuses a path or a format it may not write", () => {
    expect(resolvePptxOutput(LEASE, "proposal.pptx")).toBe("proposal.pptx");
    expect(refusalOf(() => resolvePptxOutput(LEASE, "../escape.pptx")).code).toBe("traversal");
    expect(refusalOf(() => resolvePptxOutput(LEASE, "folder/proposal.pptx")).code).toBe(
      "traversal",
    );
    expect(refusalOf(() => resolvePptxOutput(LEASE, "proposal.pptm")).code).toBe("output-format");
    expect(
      refusalOf(() => resolvePptxOutput({ ...LEASE, outputFormats: ["docx"] }, "proposal.pptx"))
        .code,
    ).toBe("output-format");
  });
});

describe("every operation sends a fixed program and checked arguments", () => {
  it("names the operation in the code, so the receipt's code hash does too", () => {
    for (const operation of PPTX_OPERATIONS) {
      const code = pptxInstruction(operation);
      expect(code).toContain(`documents.result(pptx_adapter.run(${JSON.stringify(operation)}`);
      expect(code).toContain("import pptx_adapter");
      expect(pptxInstruction(operation)).toBe(code);
    }
  });

  it("builds the arguments the adapter expects, and nothing else", () => {
    const cases: [string, unknown, string[]][] = [
      ["inspect", { ref: refOf(FILE_A) }, ["ref"]],
      [
        "read",
        { ref: refOf(FILE_A), section: "slides", pageSize: 5, cursor: 10 },
        ["ref", "section", "pageSize", "cursor"],
      ],
      ["preview", { ref: refOf(FILE_A), pageSize: 3 }, ["ref", "pageSize"]],
      ["compare", { from: refOf(FILE_A), to: refOf(FILE_B) }, ["from", "to"]],
      [
        "create",
        { output: "draft.pptx", slides: [{ blocks: [{ kind: "paragraph", text: "Hello." }] }] },
        ["output", "slides"],
      ],
      [
        "edit",
        {
          ref: refOf(FILE_A),
          output: "proposal.pptx",
          steps: [
            { kind: "replaceText", anchor: { text: "Revenue" }, find: "1250", replace: "1400" },
          ],
        },
        ["ref", "output", "steps"],
      ],
      [
        "compose",
        {
          into: refOf(FILE_A),
          from: refOf(FILE_B),
          output: "joined.pptx",
          mode: "keep_appearance",
        },
        ["into", "from", "output", "mode"],
      ],
    ];
    for (const [operation, args, keys] of cases) {
      const program = pptxProgram(operation as never, args, LEASE);
      expect(program.code).toBe(pptxInstruction(operation as never));
      expect(Object.keys(program.arguments).sort()).toEqual([...keys].sort());
    }
  });

  it("builds arguments a receipt can hash, for every operation and every optional field", () => {
    const everyStep = [
      { kind: "replaceText", anchor: ANCHOR, find: "1250", replace: "1400" },
      { kind: "replaceText", anchor: { text: "Revenue" }, find: "a", replace: "" },
      {
        kind: "replaceTextEverywhere",
        find: "1250",
        replace: "1400",
        includeNotes: true,
        expect: 1,
      },
      { kind: "writeNotes", slide: 1, text: "Confirmed." },
      { kind: "addSlide", layout: "Title Only", at: 0 },
      { kind: "cloneSlide", slide: 0, at: 1 },
      { kind: "deleteSlide", slide: 2 },
      { kind: "moveSlide", slide: 0, to: 1 },
      { kind: "rebindLayout", slide: 0, layout: "Blank", orphanPolicy: "bake" },
      {
        kind: "applyFooters",
        slide: 1,
        footer: "Office Hum",
        slideNumber: true,
        dateFormat: "datetime1",
        fixedDate: "2026-10-23",
        skipTitleSlides: true,
      },
      { kind: "deleteShape", slide: 1, shape: "Picture 3" },
      { kind: "moveShape", slide: 1, shapeId: 7, to: 0 },
      { kind: "copyShape", slide: 1, shapeId: 7 },
    ];
    const cases: [string, unknown][] = [
      ["inspect", { ref: refOf(FILE_A) }],
      ["read", { ref: refOf(FILE_A), section: "media", pageSize: 50, cursor: 0 }],
      ["preview", { ref: refOf(FILE_A), pageSize: 1, cursor: 0 }],
      ["compare", { from: refOf(FILE_A), to: refOf(FILE_B), detail: "full" }],
      [
        "create",
        {
          output: "draft.pptx",
          slides: [
            {
              title: "Close",
              layout: "Title and Content",
              notes: "Draft.",
              blocks: [
                { kind: "paragraph", text: "Prepared.", level: 2 },
                { kind: "bullets", items: [{ text: "One", level: 1 }] },
                { kind: "table", rows: [["a", "b"]] },
              ],
            },
            {},
          ],
        },
      ],
      [
        "edit",
        { ref: refOf(FILE_A), output: "proposal.pptx", steps: everyStep, detail: "structure" },
      ],
      [
        "compose",
        {
          into: refOf(FILE_A),
          from: refOf(FILE_B),
          output: "joined.pptx",
          mode: "adopt_theme",
          notes: false,
          detail: "text",
        },
      ],
    ];
    for (const [operation, args] of cases) {
      const program = pptxProgram(operation as never, args, LEASE);
      // An absent field must be *absent*: the receipt's intent hash refuses a value that is not JSON.
      expect(hasUndefined(program.arguments)).toBe(false);
      const intent = intentForRun({
        operationId: "conv:call",
        taskId: "task:pptx",
        policyVersion: POLICY_VERSION,
        code: program.code,
        arguments: program.arguments,
        lease: LEASE,
      });
      expect(() => intentSha256(intent)).not.toThrow();
      expect(intentSha256(intent)).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("agrees with the Python adapter about every step kind, block kind, section and mode", () => {
    // The tool validates a request and the adapter validates it again on the far side. They must agree
    // about the vocabulary, or a well-formed call would arrive as an `invalid-request` refusal.
    const source = readFileSync(new URL("../python/pptx_adapter.py", import.meta.url), "utf8");
    expect(source).toContain("STEP_FIELDS");
    for (const kind of Object.keys(STEP_OPTIONAL)) {
      expect(source, `${kind} is not a step the adapter knows`).toContain(`"${kind}": (`);
    }
    for (const field of Object.values(STEP_OPTIONAL).flat()) {
      expect(source, `${field} is not a field the adapter accepts`).toContain(`"${field}"`);
    }
    for (const section of PPTX_READ_SECTIONS) {
      expect(source).toContain(`"${section}"`);
    }
    for (const kind of ["paragraph", "bullets", "table"]) {
      expect(source, `${kind} is not a block the adapter knows`).toContain(`"${kind}"`);
    }
    for (const mode of PPTX_COMPOSE_MODES) {
      expect(source, `${mode} is not a mode the adapter knows`).toContain(`"${mode}"`);
    }
    for (const detail of PPTX_DIFF_DETAILS) {
      expect(source, `${detail} is not a diff detail the adapter knows`).toContain(`"${detail}"`);
    }
    // The workspace's import guard must admit the adapter module, or every typed call would be refused
    // as an import the workspace does not provide.
    const worker = readFileSync(new URL("../python/worker.py", import.meta.url), "utf8");
    expect(worker).toContain('"pptx_adapter"');
  });

  it("registers the edit and create schemas with the vocabulary its own validator accepts", () => {
    // The schema is what a model sees; STEP_OPTIONAL and the block list are what the validator accepts.
    const tools = pptxTools({ service: neverCalled(), leaseFor: async () => LEASE });
    const edit = tools.find((tool) => tool.name === EDIT_PRESENTATION);
    const editParameters = edit?.parameters as { properties?: Record<string, unknown> } | undefined;
    const steps = editParameters?.properties?.steps as
      | { items?: { anyOf?: { properties?: { kind?: { const?: unknown } } }[] } }
      | undefined;
    const stepKinds = (steps?.items?.anyOf ?? []).map((item) => item.properties?.kind?.const);
    expect(stepKinds).toEqual(Object.keys(STEP_OPTIONAL));
    expect(Object.keys(STEP_REQUIRED)).toEqual(Object.keys(STEP_OPTIONAL));

    const create = tools.find((tool) => tool.name === CREATE_PRESENTATION);
    const createParameters = create?.parameters as
      | { properties?: Record<string, unknown> }
      | undefined;
    const slides = createParameters?.properties?.slides as
      | {
          items?: {
            properties?: {
              blocks?: { items?: { anyOf?: { properties?: { kind?: { const?: unknown } } }[] } };
            };
          };
        }
      | undefined;
    const blockKinds = (slides?.items?.properties?.blocks?.items?.anyOf ?? []).map(
      (item) => item.properties?.kind?.const,
    );
    expect(blockKinds).toEqual(["paragraph", "bullets", "table"]);
  });

  it("gives the adapter the version id, name, hash and size of the leased version", () => {
    const program = pptxProgram("inspect", { ref: refOf(FILE_A) }, LEASE);
    expect(program.arguments.ref).toEqual({
      fileId: FILE_A,
      versionId: FILE_A,
      name: "brief.pptx",
      sha256: sha256(PPTX),
      size: PPTX.byteLength,
    });
  });

  it("marks an edit's output as a proposal of the leased version, and a draft as a new file", () => {
    const edit = pptxProgram(
      "edit",
      {
        ref: refOf(FILE_A),
        output: "proposal.pptx",
        steps: [{ kind: "deleteSlide", slide: 0 }],
      },
      LEASE,
    );
    expect(edit.output).toEqual({ name: "proposal.pptx", editOf: FILE_A });
    const create = pptxProgram(
      "create",
      { output: "draft.pptx", slides: [{ blocks: [{ kind: "paragraph", text: "x" }] }] },
      LEASE,
    );
    expect(create.output).toEqual({ name: "draft.pptx", editOf: null });
    expect(create.sources).toEqual([]);
  });

  it("marks a compose's destination as the leased version it proposes a new version of", () => {
    const program = pptxProgram(
      "compose",
      { into: refOf(FILE_A), from: refOf(FILE_B), output: "joined.pptx", mode: "bake" },
      LEASE,
    );
    expect(program.output).toEqual({ name: "joined.pptx", editOf: FILE_A });
    expect(program.sources.map((source) => source.versionId)).toEqual([FILE_A, FILE_B]);
  });

  it("refuses an edit of a version the lease holds read-only", () => {
    expect(
      refusalOf(() =>
        pptxProgram(
          "edit",
          {
            ref: refOf(FILE_B),
            output: "proposal.pptx",
            steps: [{ kind: "deleteSlide", slide: 0 }],
          },
          LEASE,
        ),
      ).code,
    ).toBe("unleased-path");
  });

  it("refuses a compose into a version the lease holds read-only", () => {
    expect(
      refusalOf(() =>
        pptxProgram(
          "compose",
          { into: refOf(FILE_B), from: refOf(FILE_A), output: "joined.pptx", mode: "bake" },
          LEASE,
        ),
      ).code,
    ).toBe("unleased-path");
  });
});

describe("the requests the typed tools refuse before any run", () => {
  const cases: [string, unknown, string][] = [
    ["read", { ref: refOf(FILE_A), section: "paragraphs" }, "invalid-request"],
    [
      "read",
      { ref: refOf(FILE_A), section: "slides", pageSize: MAX_PPTX_PAGE + 1 },
      "invalid-request",
    ],
    ["read", { ref: refOf(FILE_A), section: "slides", cursor: -1 }, "invalid-request"],
    ["read", { ref: refOf(FILE_A), section: "slides", includeCells: true }, "invalid-request"],
    ["preview", { ref: refOf(FILE_A), pagesize: 5 }, "invalid-request"],
    ["inspect", { ref: refOf(FILE_A), code: "print(1)" }, "invalid-request"],
    ["create", { output: "draft.pptx", slides: [] }, "invalid-request"],
    ["create", { output: "draft.pptx", slides: [{ blocks: [] }] }, "invalid-request"],
    [
      "create",
      {
        output: "draft.pptx",
        slides: [{ blocks: [{ kind: "table", rows: [["a"], ["b", "c"]] }] }],
      },
      "invalid-request",
    ],
    [
      "create",
      { output: "draft.pptx", slides: [{ blocks: [{ kind: "bullets", items: [] }] }] },
      "invalid-request",
    ],
    [
      "create",
      { output: "draft.pptx", slides: [{ blocks: [{ kind: "chart", series: [] }] }] },
      "invalid-request",
    ],
    [
      "edit",
      {
        ref: refOf(FILE_A),
        output: "proposal.pptx",
        steps: [{ kind: "replaceText", find: "a", replace: "b" }],
      },
      "invalid-request",
    ],
    [
      "edit",
      { ref: refOf(FILE_A), output: "proposal.pptx", steps: [{ kind: "scrollTo", slide: 0 }] },
      "invalid-request",
    ],
    [
      "edit",
      {
        ref: refOf(FILE_A),
        output: "proposal.pptx",
        steps: [
          {
            kind: "replaceText",
            anchor: { part: "/ppt/slides/slide1.xml", block_index: 0, content_hash: "zz" },
            find: "a",
            replace: "b",
          },
        ],
      },
      "invalid-request",
    ],
    [
      "edit",
      {
        ref: refOf(FILE_A),
        output: "proposal.pptx",
        steps: [
          {
            kind: "replaceText",
            anchor: { ...ANCHOR, version: undefined },
            find: "a",
            replace: "b",
          },
        ],
      },
      "invalid-request",
    ],
    [
      "edit",
      {
        ref: refOf(FILE_A),
        output: "proposal.pptx",
        steps: [{ kind: "deleteShape", slide: 0, shape: "Picture 3", shapeId: 4 }],
      },
      "invalid-request",
    ],
    [
      "edit",
      { ref: refOf(FILE_A), output: "proposal.pptx", steps: [{ kind: "deleteShape", slide: 0 }] },
      "invalid-request",
    ],
    [
      "edit",
      {
        ref: refOf(FILE_A),
        output: "proposal.pptx",
        steps: [{ kind: "rebindLayout", slide: 0, layout: "Blank", orphanPolicy: "guess" }],
      },
      "invalid-request",
    ],
    [
      "edit",
      {
        ref: refOf(FILE_A),
        output: "proposal.pptx",
        steps: [{ kind: "moveSlide", slide: 0, to: 1, extra: true }],
      },
      "invalid-request",
    ],
    [
      "edit",
      {
        ref: refOf(FILE_A),
        output: "proposal.pptx",
        steps: Array.from({ length: MAX_PPTX_STEPS + 1 }, () => ({
          kind: "deleteSlide",
          slide: 0,
        })),
      },
      "invalid-request",
    ],
    [
      "compose",
      { into: refOf(FILE_A), from: refOf(FILE_B), output: "joined.pptx", mode: "nope" },
      "invalid-request",
    ],
    [
      "compose",
      { into: refOf(FILE_A), from: refOf(FILE_B), output: "joined.pptx" },
      "invalid-request",
    ],
    [
      "compare",
      { from: refOf(FILE_A), to: refOf(FILE_B), detail: "everything" },
      "invalid-request",
    ],
  ];

  it.each(cases)("%s refuses %o as %s", (operation, args, code) => {
    expect(refusalOf(() => pptxProgram(operation as never, args, LEASE)).code).toBe(code);
  });

  it("leaves out what the caller did not send, rather than sending undefined", () => {
    const program = pptxProgram("read", { ref: refOf(FILE_A), section: "shapes" }, LEASE);
    expect(program.arguments).toEqual({
      ref: {
        fileId: FILE_A,
        versionId: FILE_A,
        name: "brief.pptx",
        sha256: sha256(PPTX),
        size: PPTX.byteLength,
      },
      section: "shapes",
    });
    expect(
      pptxProgram(
        "edit",
        {
          ref: refOf(FILE_A),
          output: "proposal.pptx",
          steps: [{ kind: "addSlide" }],
        },
        LEASE,
      ).arguments,
    ).toEqual({
      ref: {
        fileId: FILE_A,
        versionId: FILE_A,
        name: "brief.pptx",
        sha256: sha256(PPTX),
        size: PPTX.byteLength,
      },
      output: "proposal.pptx",
      steps: [{ kind: "addSlide" }],
    });
  });

  it("validates a step's own shape as the adapter will read it", () => {
    expect(assertPptxStep({ kind: "addSlide" }, 0)).toEqual({ kind: "addSlide" });
    expect(
      assertPptxStep({ kind: "replaceTextEverywhere", find: "a", replace: "", expect: 2 }, 0),
    ).toEqual({ kind: "replaceTextEverywhere", find: "a", replace: "", expect: 2 });
    expect(
      assertPptxStep({ kind: "applyFooters", footer: "Office Hum", slideNumber: true }, 0),
    ).toEqual({ kind: "applyFooters", footer: "Office Hum", slideNumber: true });
    expect(refusalOf(() => assertPptxStep({ kind: "applyFooters", slide: -1 }, 0)).code).toBe(
      "invalid-request",
    );
  });
});

describe("the typed PowerPoint surface", () => {
  it("maps the adapter's refusals onto codes the pack already knows", () => {
    for (const code of [
      "document-protected",
      "malformed-package",
      "unsupported-structure",
      "boundary-violation",
      "target-not-found",
      "ambiguous-target",
      "stale-anchor",
      "package-limit",
      "relationship-policy",
    ]) {
      expect(DOCUMENT_REFUSAL_CODES).toContain(code);
    }
  });

  it("names the seven operations the design names, in order", () => {
    expect(PPTX_OPERATIONS).toEqual([
      "inspect",
      "read",
      "create",
      "edit",
      "preview",
      "compare",
      "compose",
    ]);
    expect(PPTX_TOOL_NAMES.inspect).toBe(INSPECT_PRESENTATION);
    expect(PPTX_TOOL_NAMES.read).toBe(READ_PRESENTATION);
    expect(PPTX_TOOL_NAMES.create).toBe(CREATE_PRESENTATION);
    expect(PPTX_TOOL_NAMES.edit).toBe(EDIT_PRESENTATION);
    expect(PPTX_TOOL_NAMES.preview).toBe(PREVIEW_PRESENTATION);
    expect(PPTX_TOOL_NAMES.compare).toBe(COMPARE_PRESENTATION);
    expect(PPTX_TOOL_NAMES.compose).toBe(COMPOSE_PRESENTATION);
    expect(PPTX_TOOL_REGISTRATIONS).toEqual([
      INSPECT_PRESENTATION,
      READ_PRESENTATION,
      CREATE_PRESENTATION,
      EDIT_PRESENTATION,
      PREVIEW_PRESENTATION,
      COMPARE_PRESENTATION,
      COMPOSE_PRESENTATION,
    ]);
    expect(PPTX_TOOL_ORDER).toEqual(PPTX_OPERATIONS);
  });

  it("registers each tool with the section list its own validator accepts", () => {
    // The schema is what a model sees; PPTX_READ_SECTIONS is what the validator accepts. They must agree.
    const read = pptxTools({ service: neverCalled(), leaseFor: async () => LEASE }).find(
      (tool) => tool.name === READ_PRESENTATION,
    );
    const parameters = read?.parameters as { properties?: Record<string, unknown> } | undefined;
    const section = parameters?.properties?.section as
      | { anyOf?: { const?: unknown }[] }
      | undefined;
    const literals = (section?.anyOf ?? []).map((item) => item.const);
    expect(literals).toEqual([...PPTX_READ_SECTIONS]);
  });

  it("registers each schema with the closed argument shape the pack expects", () => {
    const tools = pptxTools({ service: neverCalled(), leaseFor: async () => LEASE });
    expect(tools.map((tool) => tool.name)).toEqual([...PPTX_TOOL_REGISTRATIONS]);
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
      INSPECT_PRESENTATION,
      READ_PRESENTATION,
      EDIT_PRESENTATION,
      PREVIEW_PRESENTATION,
      COMPARE_PRESENTATION,
      COMPOSE_PRESENTATION,
    ]) {
      const description = String(tools.find((tool) => tool.name === name)?.description);
      expect(description).toContain("file reference");
      expect(description).toContain("lease");
    }
    // The tools that can report overflow, or a preview, say there is no bitmap renderer.
    for (const name of [
      INSPECT_PRESENTATION,
      PREVIEW_PRESENTATION,
      EDIT_PRESENTATION,
      COMPARE_PRESENTATION,
    ]) {
      const description = String(tools.find((tool) => tool.name === name)?.description);
      expect(description).toContain("no bitmap renderer");
    }
  });

  it("offers every tool as replay-safe, and can withhold each typed set", () => {
    const service = neverCalled();
    const full = paperOfficeToolPack({ service, leaseFor: async () => LEASE });
    expect(full.tools.map((tool) => tool.name)).toEqual([
      RUN_DOCUMENT_PYTHON,
      ...WORD_TOOL_REGISTRATIONS,
      ...PPTX_TOOL_REGISTRATIONS,
    ]);
    for (const tool of full.tools) expect(tool.replay).toBe("safe");

    const workspaceOnly = paperOfficeToolPack({
      service,
      leaseFor: async () => LEASE,
      includeWordTools: false,
      includePptxTools: false,
    });
    expect(workspaceOnly.tools.map((tool) => tool.name)).toEqual([RUN_DOCUMENT_PYTHON]);

    const withoutPptx = paperOfficeToolPack({
      service,
      leaseFor: async () => LEASE,
      includePptxTools: false,
    });
    expect(withoutPptx.tools.map((tool) => tool.name)).toEqual([
      RUN_DOCUMENT_PYTHON,
      ...WORD_TOOL_REGISTRATIONS,
    ]);

    const withoutWord = paperOfficeToolPack({
      service,
      leaseFor: async () => LEASE,
      includeWordTools: false,
    });
    expect(withoutWord.tools.map((tool) => tool.name)).toEqual([
      RUN_DOCUMENT_PYTHON,
      ...PPTX_TOOL_REGISTRATIONS,
    ]);
  });
});

describe("the result validator", () => {
  const SOURCE = {
    fileId: FILE_A,
    versionId: FILE_A,
    name: "brief.pptx",
    sha256: sha256(PPTX),
    size: PPTX.byteLength,
  };

  const RENDERING = {
    bitmap: false,
    method: "structural",
    overflowMethod: "advance-estimate",
    constants: { averageGlyphAdvanceEm: 0.5, lineHeightEm: 1.2 },
    limits: ["no rasteriser in this interpreter"],
    isolation: "RASF-3111",
  };

  const CENSUS = {
    slides: 1,
    masters: 1,
    layouts: 11,
    shapes: 1,
    textBlocks: 1,
    blindTextBlocks: 0,
    notesSlides: 0,
    mediaParts: 0,
    mediaReferences: 0,
    orphanMediaParts: 0,
    pictures: 0,
    tables: 0,
    charts: 0,
    groups: 0,
    alternateContent: 0,
    slideWidthEmu: 9144000,
    slideHeightEmu: 6858000,
  };

  const TOTALS = { shapes: 1, overflowing: 0, compensated: 0, unresolved: 0 };

  function reading(overrides: Record<string, unknown> = {}) {
    return {
      schema: "paper_pptx_operation",
      version: 1,
      operation: "read",
      ok: true,
      source: { ...SOURCE },
      deck: { ...CENSUS },
      page: {
        section: "text",
        pageSize: 2,
        cursor: 0,
        returned: 1,
        total: 1,
        nextCursor: null,
        hasMore: false,
        items: [
          {
            position: 0,
            slideId: 256,
            part: "/ppt/slides/slide1.xml",
            blockIndex: 0,
            anchor: {
              part: "/ppt/slides/slide1.xml",
              block_index: 0,
              content_hash: "a".repeat(64),
            },
            shapeId: 2,
            shapeName: "Title 1",
            placeholderType: "CENTER_TITLE",
            container: "shape",
            containerDetail: null,
            blind: false,
            level: 0,
            fields: [],
            text: "Quarterly Close",
            truncated: false,
            runs: [
              {
                text: "Quarterly Close",
                truncated: false,
                font: {
                  sizeEmu: 558800,
                  sizePt: 44,
                  sizeResolved: true,
                  name: "Calibri",
                  nameResolved: true,
                  colorRgb: "000000",
                  colorResolved: true,
                },
              },
            ],
            runsTruncated: false,
          },
        ],
      },
      ...overrides,
    };
  }

  it("accepts a well-formed page and reports what it carries", () => {
    const result = parsePptxResult("read", reading(), [SOURCE]);
    expect(result.operation).toBe("read");
    if (result.operation !== "read") throw new Error("unreachable");
    expect(result.page.total).toBe(1);
    expect(result.page.nextCursor).toBeNull();
    expect(result.page.items[0]).toMatchObject({ text: "Quarterly Close", blind: false });
  });

  it("refuses an answer about a version this call never named", () => {
    const error = refusalOf(() =>
      parsePptxResult("read", reading({ source: { ...SOURCE, sha256: "b".repeat(64) } }), [SOURCE]),
    );
    expect(error.code).toBe("output-invalid");
  });

  it("refuses a page that is inconsistent with itself", () => {
    const page = reading();
    expect(
      refusalOf(() =>
        parsePptxResult("read", { ...page, page: { ...page.page, returned: 2 } }, [SOURCE]),
      ).code,
    ).toBe("output-invalid");
    expect(
      refusalOf(() =>
        parsePptxResult("read", { ...page, page: { ...page.page, total: 0 } }, [SOURCE]),
      ).code,
    ).toBe("output-invalid");
    expect(
      refusalOf(() =>
        parsePptxResult("read", { ...page, page: { ...page.page, pageSize: MAX_PPTX_PAGE + 1 } }, [
          SOURCE,
        ]),
      ).code,
    ).toBe("output-invalid");
  });

  it("refuses a page whose section is not one this tool pages", () => {
    const page = reading();
    expect(
      refusalOf(() =>
        parsePptxResult("read", { ...page, page: { ...page.page, section: "paragraphs" } }, [
          SOURCE,
        ]),
      ).code,
    ).toBe("output-invalid");
  });

  it("refuses a worker that claims a bitmap rendering, or a computed overflow with no reason", () => {
    const preview = {
      schema: "paper_pptx_operation",
      version: 1,
      operation: "preview",
      ok: true,
      source: { ...SOURCE },
      deck: { ...CENSUS },
      overflow: { ...TOTALS },
      overflowSlides: [],
      media: { references: [], orphanParts: [] },
      warnings: [],
      rendering: { ...RENDERING, bitmap: true },
      page: {
        section: "slides",
        pageSize: 1,
        cursor: 0,
        returned: 0,
        total: 0,
        nextCursor: null,
        hasMore: false,
        items: [],
      },
    };
    expect(refusalOf(() => parsePptxResult("preview", preview, [SOURCE])).code).toBe(
      "output-invalid",
    );

    const withSlide = {
      ...preview,
      rendering: { ...RENDERING },
      page: {
        ...preview.page,
        returned: 1,
        total: 1,
        items: [
          {
            position: 0,
            slideId: 256,
            part: "/ppt/slides/slide1.xml",
            layoutName: "Blank",
            titleText: null,
            lines: [],
            linesTruncated: false,
            notes: { present: false, text: null },
            media: [],
            overflow: {
              summary: TOTALS,
              items: [
                {
                  name: "TextBox 1",
                  shapeId: 2,
                  computed: false,
                  overflow: null,
                  compensated: false,
                  method: "advance-estimate",
                  reason: null,
                  declared: {},
                },
              ],
            },
          },
        ],
      },
    };
    expect(refusalOf(() => parsePptxResult("preview", withSlide, [SOURCE])).code).toBe(
      "output-invalid",
    );
    // …and accepts the same item once it says why it could not compute an answer.
    const explained = structuredClone(withSlide);
    const item = (explained.page.items[0] as { overflow: { items: { reason: unknown }[] } })
      .overflow.items[0];
    if (item !== undefined) item.reason = "the shape's geometry is inherited";
    const parsed = parsePptxResult("preview", explained, [SOURCE]);
    expect(parsed.operation).toBe("preview");
  });

  it("refuses the wrong operation, a bad envelope and a published file", () => {
    expect(refusalOf(() => parsePptxResult("inspect", reading(), [SOURCE])).code).toBe(
      "output-invalid",
    );
    expect(
      refusalOf(() => parsePptxResult("read", { ...reading(), ok: false }, [SOURCE])).code,
    ).toBe("output-invalid");
    expect(
      refusalOf(() =>
        parsePptxResult(
          "edit",
          {
            schema: "paper_pptx_operation",
            version: 1,
            operation: "edit",
            ok: true,
            source: SOURCE,
            proposal: {
              status: "proposed",
              name: "proposal.pptx",
              editOf: FILE_A,
              sha256: sha256(PPTX),
              size: PPTX.byteLength,
              published: true,
            },
            changes: [],
            steps: [],
            changeSet: {
              schema: "paper-package-diff",
              version: 1,
              added: [],
              removed: [],
              changed: [],
              byteIdenticalCount: 0,
              partCountBefore: 0,
              partCountAfter: 0,
              semanticallyEmpty: false,
            },
            diff: {
              schema: "paper-deck-diff",
              version: 5,
              detail: "text",
              slidesAdded: [],
              slidesRemoved: [],
              slidesMoved: [],
              slideChanges: [],
              slideChangeTotal: 0,
              packageChanges: [],
              identical: false,
            },
            preview: {
              changed: [],
              changedTotal: 0,
              added: [],
              addedTotal: 0,
              removed: [],
              removedTotal: 0,
              moved: [],
              limit: 8,
              limitNote: "bounded",
            },
            preservation: {
              byteIdenticalCount: 0,
              byteIdentical: [],
              byteIdenticalTruncated: false,
              byteIdenticalHashed: 0,
              changedParts: [],
              addedParts: [],
              removedParts: [],
              mediaByteIdentical: [],
              themeByteIdentical: [],
              layoutByteIdentical: [],
              masterByteIdentical: [],
              notesByteIdentical: [],
              slidePartsByteIdentical: [],
              verbatimCopy: false,
            },
            patch: { schema: "paper-package-diff", version: 1, residualCount: 0, isEmpty: true },
            overflow: { ...TOTALS },
            overflowSlides: [],
            reopened: { slides: 1 },
            rendering: { ...RENDERING },
          },
          [SOURCE],
        ),
      ).code,
    ).toBe("output-invalid");
  });

  it("refuses a compare answer that swaps the two versions it was given, or a compose that does", () => {
    const answer = {
      schema: "paper_pptx_operation",
      version: 1,
      operation: "compare",
      ok: true,
      sources: {
        from: { ...SOURCE, fileId: FILE_B, versionId: FILE_B, sha256: sha256(utf8("b")) },
        to: SOURCE,
      },
      changeSet: {
        schema: "paper-package-diff",
        version: 1,
        added: [],
        removed: [],
        changed: [],
        byteIdenticalCount: 0,
        partCountBefore: 0,
        partCountAfter: 0,
        semanticallyEmpty: true,
      },
      diff: {
        schema: "paper-deck-diff",
        version: 5,
        detail: "text",
        slidesAdded: [],
        slidesRemoved: [],
        slidesMoved: [],
        slideChanges: [],
        slideChangeTotal: 0,
        packageChanges: [],
        identical: true,
      },
      preview: {
        changed: [],
        changedTotal: 0,
        added: [],
        addedTotal: 0,
        removed: [],
        removedTotal: 0,
        moved: [],
        limit: 8,
        limitNote: "bounded",
      },
      identical: true,
      rendering: { ...RENDERING },
    };
    expect(refusalOf(() => parsePptxResult("compare", answer, [SOURCE, SOURCE])).code).toBe(
      "output-invalid",
    );
  });
});

function neverCalled() {
  return {
    async runDocumentPython() {
      throw new Error("the contract tests never reach the service");
    },
  };
}
