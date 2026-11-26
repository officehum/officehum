/**
 * `renderDocument`: a template and its data in, one immutable draft file in the file store out.
 *
 * - **PDF** is compiled by Typst (`typst.ts`) and saved with the store's own `create` under the
 *   call's operation ID: a replay finds the committed version through `lookupOperation` and renders
 *   nothing again, so one operation ID is one file.
 * - **Word and Excel** go through the injected Paper `DocumentService` with the worker's own
 *   `create_document` / `create_workbook` programs, on the task's lease: the same staging, receipts,
 *   idempotency and reopen check as every other Paper document. The template is bound into the run's
 *   intent and recorded in the draft's metadata.
 *
 * Data is checked against the template's schema, and a layout's own consistency checks, before
 * anything renders: a refusal writes nothing. Every file is `source: "generated"` with the template's
 * name and version in its metadata. A role's own tool calls this with figures it fetched itself, so
 * no model stands between the numbers and the document.
 */

import {
  FileStoreError,
  intentHash,
  type ResolvedTemplate,
  type VersionedFileRef,
  type VersionedFileStore,
} from "@officehum/sdk";
import {
  DocumentError,
  type DocumentLease,
  type DocumentRunReceipt,
  type DocumentService,
  parseWordResult,
  parseXlsxResult,
  wordProgram,
  xlsxProgram,
} from "@officehum/tools-paper-office";
import { type Branding, type ResolvedBranding, resolveBranding } from "./branding.js";
import { DocgenError } from "./errors.js";
import { layoutFor } from "./layouts.js";
import { dataProblems } from "./schema.js";
import {
  type DocumentTemplate,
  HELPER_FILE,
  helperSource,
  isBuiltin,
  type TemplateFormat,
  templateCatalog,
} from "./templates.js";
import {
  checkTypst,
  pdfPageCount,
  resolveTypst,
  runTypst,
  TYPST_VERSION,
  type TypstOutcome,
} from "./typst.js";

/** The policy every PDF's FileStore context binds, so a change of rules is visible. */
export const DOCGEN_POLICY_VERSION = "docgen:1";

/** The largest preview a tool result may carry inline (the SDK's `fileResult` limit). */
export const MAX_PREVIEW_BYTES = 100_000;

const MIME: Readonly<Record<TemplateFormat, string>> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export interface DocgenLimits {
  /** How long one Typst compile may run. Default 20 s. */
  readonly timeoutMs: number;
  /** The most pages a PDF may have. Default 50. */
  readonly maxPages: number;
}

export const DEFAULT_DOCGEN_LIMITS: DocgenLimits = { timeoutMs: 20_000, maxPages: 50 };

export interface DocumentGeneratorOptions {
  /** Where PDFs are saved and the logo is read from: the store the Paper service also commits to. */
  readonly store: VersionedFileStore;
  /** The Paper document service that renders Word and Excel. Without it only PDF renders. */
  readonly service?: DocumentService;
  /** The Typst binary. Default: `OFFICEHUM_TYPST`, else `typst` on the PATH. */
  readonly typst?: string;
  /** The business's branding; neutral where it says nothing (see `branding.ts`). */
  readonly branding?: Branding;
  /** The business's own templates, from its overlay (`resolveRoleFiles(...).value.templates`). */
  readonly templates?: readonly ResolvedTemplate[] | (() => readonly ResolvedTemplate[]);
  /** Who the store records as having made each PDF, e.g. `role:bookkeeper`. */
  readonly createdBy: string;
  /** Lower limits than the defaults; never higher. */
  readonly limits?: Partial<DocgenLimits>;
}

export interface RenderRequest {
  readonly template: string;
  readonly data: unknown;
  readonly format: TemplateFormat;
  /** The file name; the format's extension is added when it is missing. */
  readonly name: string;
  /** Stable across a crash and its replay: derive it from the tool call, never from an argument. */
  readonly operationId: string;
  readonly taskId: string;
  /** The task's document lease, which Word and Excel need. */
  readonly lease?: DocumentLease;
}

export interface RenderedDocument {
  readonly ref: VersionedFileRef;
  readonly template: { readonly name: string; readonly version: string; readonly origin: string };
  readonly format: TemplateFormat;
  /** A PNG of the first page, at most 100 KB, for a PDF. */
  readonly preview?: { readonly bytes: Uint8Array; readonly mimeType: "image/png" };
  /** Why there is no preview, when there is none. */
  readonly previewNote?: string;
}

export interface DocumentGenerator {
  /** Every template by name: the built-ins and the business's own. */
  templates(): readonly DocumentTemplate[];
  renderDocument(request: RenderRequest): Promise<RenderedDocument>;
}

export function documentGenerator(options: DocumentGeneratorOptions): DocumentGenerator {
  const limits: DocgenLimits = {
    timeoutMs: Math.min(options.limits?.timeoutMs ?? Infinity, DEFAULT_DOCGEN_LIMITS.timeoutMs),
    maxPages: Math.min(options.limits?.maxPages ?? Infinity, DEFAULT_DOCGEN_LIMITS.maxPages),
  };
  const overlays = (): readonly ResolvedTemplate[] =>
    typeof options.templates === "function" ? options.templates() : (options.templates ?? []);
  const catalog = () => templateCatalog(overlays());

  return {
    templates: () => [...catalog().values()],
    async renderDocument(request) {
      const template = catalog().get(request.template);
      if (template === undefined) {
        throw new DocgenError(
          "unknown-template",
          `there is no template ${JSON.stringify(request.template)}; the templates are ${[...catalog().keys()].join(", ")}`,
        );
      }
      if (!template.formats.includes(request.format)) {
        throw new DocgenError(
          "unsupported-format",
          `the ${template.name} template renders ${template.formats.join(", ")}, not ${request.format}` +
            (template.origin === "overlay"
              ? " (a business's own template is Typst, so PDF only)"
              : ""),
        );
      }
      const name = outputName(request.name, request.format);
      checkData(template, request.data);
      const brand = resolveBranding(options.branding);
      const stamp = { name: template.name, version: template.version, origin: template.origin };
      if (request.format === "pdf") {
        return renderPdf(options, limits, template, request, name, brand, stamp);
      }
      return renderOffice(options, template, request, name, brand, stamp);
    },
  };
}

/** One plain file name with the format's extension. */
function outputName(given: string, format: TemplateFormat): string {
  const trimmed = typeof given === "string" ? given.trim() : "";
  const name = trimmed.toLowerCase().endsWith(`.${format}`) ? trimmed : `${trimmed}.${format}`;
  if (
    trimmed === "" ||
    name.includes("/") ||
    name.includes("\\") ||
    name.startsWith(".") ||
    /\p{Cc}/u.test(name) ||
    Buffer.byteLength(name, "utf8") > 200
  ) {
    throw new DocgenError(
      "invalid-request",
      "name must be a plain file name of at most 200 bytes, like statement-november, with no folders",
    );
  }
  return name;
}

/** The data against the template's schema, then the built-in layout's own checks. */
export function checkData(template: DocumentTemplate, data: unknown): void {
  const problems = dataProblems(template.schema, data);
  if (problems.length === 0 && isBuiltin(template))
    problems.push(...layoutFor(template.name).checks(data));
  if (problems.length > 0) {
    throw new DocgenError(
      "invalid-data",
      `the data does not fit the ${template.name} template: ${problems.map((problem) => `${problem.path} ${problem.message}`).join("; ")}`,
      problems,
    );
  }
}

// -- PDF ------------------------------------------------------------------------------------------

async function renderPdf(
  options: DocumentGeneratorOptions,
  limits: DocgenLimits,
  template: DocumentTemplate,
  request: RenderRequest,
  name: string,
  brand: ResolvedBranding,
  stamp: RenderedDocument["template"],
): Promise<RenderedDocument> {
  const typst = checkTypst(options.typst ?? resolveTypst(process.env));
  const files = await compileFiles(options.store, template, request.data, brand);

  // A replay: the version this operation committed, and no second render of the document.
  const committed = await lookup(options.store, request.operationId);
  if (committed !== undefined) {
    if (committed.name !== name || committed.metadata.template?.version !== template.version) {
      throw new DocgenError(
        "store-error",
        `operation ${request.operationId} already saved ${committed.name} from another template or name, so it will not save again`,
      );
    }
    return {
      ref: committed,
      template: stamp,
      format: "pdf",
      ...(await preview(typst, template, files, limits)),
    };
  }

  if (!typst.ok) throw new DocgenError(typst.code, typst.message);
  const outcome = await runTypst({
    binary: typst.binary,
    files,
    main: `${template.name}.typ`,
    format: "pdf",
    timeoutMs: limits.timeoutMs,
  });
  const bytes = compiled(outcome, template);
  const pages = pdfPageCount(bytes);
  if (pages === undefined) {
    throw new DocgenError(
      "output-invalid",
      "Typst wrote a PDF whose pages cannot be counted, so it was not saved",
    );
  }
  if (pages > limits.maxPages) {
    throw new DocgenError(
      "page-limit",
      `the ${template.name} document came to ${pages} pages; the limit is ${limits.maxPages}. Send less data.`,
    );
  }
  let ref: VersionedFileRef;
  try {
    const receipt = await options.store.create({
      operationId: request.operationId,
      bytes,
      name,
      mimeType: MIME.pdf,
      metadata: {
        createdBy: options.createdBy,
        source: "generated",
        template: { name: template.name, version: template.version },
      },
      context: {
        taskId: request.taskId,
        policyVersion: DOCGEN_POLICY_VERSION,
        worker: { image: `typst:${TYPST_VERSION}`, libraries: { typst: TYPST_VERSION } },
        argumentsSha256: intentHash({
          template: stamp,
          format: "pdf",
          name,
          data: request.data,
          brand: { ...brand, address: [...brand.address] },
        }),
      },
    });
    ref = receipt.output;
  } catch (error) {
    throw storeError(error);
  }
  return {
    ref,
    template: stamp,
    format: "pdf",
    ...(await preview(typst, template, files, limits)),
  };
}

/** What a compile directory holds: the template, the helper library, the data, the brand, a logo. */
async function compileFiles(
  store: VersionedFileStore,
  template: DocumentTemplate,
  data: unknown,
  brand: ResolvedBranding,
): Promise<Record<string, string | Uint8Array>> {
  const files: Record<string, string | Uint8Array> = {
    [`${template.name}.typ`]: template.source,
    [HELPER_FILE]: helperSource(),
    "data.json": JSON.stringify(data),
  };
  let logo: string | null = null;
  if (brand.logoFileId !== null) {
    const image = await logoFile(store, brand.logoFileId);
    logo = `_logo.${image.extension}`;
    files[logo] = image.bytes;
  }
  files["brand.json"] = JSON.stringify({ ...brand, logoFileId: undefined, logo });
  return files;
}

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

async function logoFile(
  store: VersionedFileStore,
  fileId: string,
): Promise<{ bytes: Uint8Array; extension: "png" | "jpg" }> {
  let stored: Awaited<ReturnType<VersionedFileStore["get"]>>;
  try {
    stored = await store.get(fileId);
  } catch (error) {
    throw storeError(error);
  }
  if (stored === undefined) {
    throw new DocgenError(
      "invalid-branding",
      `the branding names logo ${fileId}, which the file store does not hold`,
    );
  }
  const bytes = stored.bytes;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((!png && !jpeg) || bytes.byteLength > MAX_LOGO_BYTES) {
    throw new DocgenError(
      "invalid-branding",
      "the branding's logo must be a PNG or JPEG of at most 2 MB",
    );
  }
  return { bytes, extension: png ? "png" : "jpg" };
}

function compiled(outcome: TypstOutcome, template: DocumentTemplate): Uint8Array {
  if (outcome.ok) return outcome.bytes;
  throw new DocgenError(
    outcome.code,
    outcome.code === "compile-failed"
      ? `the ${template.name} template did not compile: ${outcome.message}`
      : outcome.message,
  );
}

/**
 * A picture of the first page, from Typst's own PNG export, at the highest of three resolutions that
 * stays within 100 KB. A preview is a convenience: when it cannot be made, the document still is.
 */
async function preview(
  typst: ReturnType<typeof checkTypst>,
  template: DocumentTemplate,
  files: Record<string, string | Uint8Array>,
  limits: DocgenLimits,
): Promise<Pick<RenderedDocument, "preview" | "previewNote">> {
  if (!typst.ok) return { previewNote: `no preview: ${typst.message}` };
  for (const ppi of [72, 48, 32]) {
    const outcome = await runTypst({
      binary: typst.binary,
      files,
      main: `${template.name}.typ`,
      format: "png",
      ppi,
      timeoutMs: limits.timeoutMs,
    });
    if (!outcome.ok) return { previewNote: `no preview: ${outcome.message}` };
    if (outcome.bytes.byteLength <= MAX_PREVIEW_BYTES) {
      return { preview: { bytes: outcome.bytes, mimeType: "image/png" } };
    }
  }
  return {
    previewNote: "no preview: the first page does not fit in 100 KB even at 32 pixels per inch",
  };
}

async function lookup(
  store: VersionedFileStore,
  operationId: string,
): Promise<VersionedFileRef | undefined> {
  let receipt: Awaited<ReturnType<VersionedFileStore["lookupOperation"]>>;
  try {
    receipt = await store.lookupOperation(operationId);
  } catch (error) {
    throw storeError(error);
  }
  if (receipt === undefined) return undefined;
  if (receipt.kind !== "create") {
    throw new DocgenError(
      "store-error",
      `operation ${operationId} is already used for something other than a new file`,
    );
  }
  return receipt.output;
}

function storeError(error: unknown): DocgenError {
  if (error instanceof DocgenError) return error;
  if (error instanceof FileStoreError && error.code === "OPERATION_COLLISION") {
    return new DocgenError(
      "store-error",
      "this operation already saved a different document, so it will not save again",
    );
  }
  return new DocgenError(
    "store-error",
    `the file store refused the document: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// -- Word and Excel ---------------------------------------------------------------------------------

async function renderOffice(
  options: DocumentGeneratorOptions,
  template: DocumentTemplate,
  request: RenderRequest,
  name: string,
  brand: ResolvedBranding,
  stamp: RenderedDocument["template"],
): Promise<RenderedDocument> {
  const format = request.format as "docx" | "xlsx";
  if (options.service === undefined) {
    throw new DocgenError(
      "no-service",
      `this office renders ${format} through the Paper document worker, which the host has not connected`,
    );
  }
  if (request.lease === undefined) {
    throw new DocgenError(
      "no-lease",
      `this task has no document lease, so it may not write a ${format} file. Ask the host for one.`,
    );
  }
  const layout = layoutFor(template.name);
  let program: { code: string; arguments: Readonly<Record<string, unknown>> };
  try {
    program =
      format === "docx"
        ? wordProgram(
            "create",
            { output: name, blocks: layout.word(request.data, brand) },
            request.lease,
          )
        : xlsxProgram(
            "create",
            { output: name, sheets: layout.excel(request.data, brand) },
            request.lease,
          );
  } catch (error) {
    if (error instanceof DocumentError) throw new DocgenError(error.code, error.message);
    throw error;
  }
  const outcome = await options.service.runDocumentPython({
    operationId: request.operationId,
    taskId: request.taskId,
    lease: request.lease,
    code: program.code,
    arguments: program.arguments,
    template: { name: template.name, version: template.version },
  });
  if (outcome.kind === "refused") throw new DocgenError(outcome.code, outcome.message);

  const output = draftOf(outcome.receipt, name, format, layout.formulas(request.data));
  let stored: Awaited<ReturnType<VersionedFileStore["getVersion"]>>;
  try {
    stored = await options.store.getVersion(output.fileId, output.versionId);
  } catch (error) {
    throw storeError(error);
  }
  if (stored === undefined) {
    throw new DocgenError(
      "store-error",
      `the draft ${name} was committed but the file store cannot find it`,
    );
  }
  return {
    ref: stored.ref,
    template: stamp,
    format,
    previewNote: `no preview: a ${format === "docx" ? "Word" : "Excel"} file has no renderer here; open the file`,
  };
}

/**
 * The one draft a create run committed, checked against what the worker reported when it reopened
 * the file: the name and bytes it wrote, and for a workbook every formula present and no reference
 * left pointing nowhere.
 */
function draftOf(
  receipt: DocumentRunReceipt,
  name: string,
  format: "docx" | "xlsx",
  formulas: number,
): DocumentRunReceipt["outputs"][number] {
  const [output, ...extra] = receipt.outputs;
  if (output === undefined || extra.length > 0 || output.name !== name) {
    throw new DocgenError(
      "output-invalid",
      `the worker did not commit exactly one draft named ${name}`,
    );
  }
  try {
    const result =
      format === "docx"
        ? parseWordResult("create", receipt.result, [])
        : parseXlsxResult("create", receipt.result, []);
    if (result.operation !== "create" || result.draft.sha256 !== output.sha256) {
      throw new DocgenError(
        "output-invalid",
        `the worker's report on ${name} does not match the bytes it committed`,
      );
    }
    if ("recalculation" in result) {
      if (result.reopened.formulas !== formulas || result.reopened.referenceCheck !== 0) {
        throw new DocgenError(
          "output-invalid",
          `${name} reopened with ${result.reopened.formulas} formulas and ${result.reopened.referenceCheck} broken references; the layout wrote ${formulas} and none`,
        );
      }
    }
  } catch (error) {
    if (error instanceof DocumentError) throw new DocgenError(error.code, error.message);
    throw error;
  }
  return output;
}
