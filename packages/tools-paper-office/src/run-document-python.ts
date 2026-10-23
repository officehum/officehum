/**
 * The portable Paper Office tool pack: the Python workspace, and the typed Word operations on top of it.
 *
 * This is the Pi Durable surface the design asks for — `defineTool` registrations a role manifest can
 * attach or withhold, taking an injected `DocumentService` and never the Office Hum host. The same
 * pack therefore runs in a bare Pi Durable harness with a fake service (see the portability test) and
 * inside Office Hum with the local service.
 *
 * It carries `run_document_python` and, unless withheld, the six typed Word tools from `word-tools.ts`
 * and the seven typed PowerPoint tools from `pptx-tools.ts`. The typed tools are the same operation
 * underneath: a fixed program on the same service, so both share the lease, the staging, the package
 * inspection, the operation receipts and the idempotency.
 *
 * The operation ID is derived from the Pi Durable conversation and call identity, never from an
 * argument: a model cannot choose its own replay identity. Every tool is declared `replay: "safe"`,
 * because the service is idempotent by operation ID — an interrupted call that reruns resolves to the
 * same committed receipt instead of a second edit.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type {
  DocumentRunCommitted,
  DocumentRunRefused,
  DocumentService,
} from "./document-service.js";
import type { DocumentLease } from "./lease.js";
import { operationIdForCall } from "./operation.js";
import { pptxTools } from "./pptx-tools.js";
import { wordTools } from "./word-tools.js";

export const RUN_DOCUMENT_PYTHON = "run_document_python";
export const PAPER_OFFICE_PACK_ID = "paper-office";

const MAX_TOOL_TEXT = 9_000;
const MAX_CODE_BYTES = 128 * 1024;

/** What the pack needs to find a task's lease. The host owns leases; the pack only asks. */
export interface LeaseLookup {
  readonly taskId: string;
  readonly conversationId: string;
}

export interface PaperOfficeToolPackOptions {
  readonly service: DocumentService;
  /**
   * The lease for a task, or `undefined` when this task has none. A role may attach the capability and
   * still receive no usable lease: the tool then refuses instead of reaching for anything wider.
   */
  readonly leaseFor: (lookup: LeaseLookup) => Promise<DocumentLease | undefined>;
  /**
   * Whether the pack carries the typed Word tools (`inspect_document`, `read_document`,
   * `create_document`, `edit_document`, `preview_document`, `compare_document`) beside the Python
   * workspace. Defaults to `true`: the typed surface is the reviewable one, and a role that wants only
   * the workspace can withhold it.
   */
  readonly includeWordTools?: boolean;
  /**
   * Whether the pack carries the typed PowerPoint tools (`inspect_presentation`,
   * `read_presentation`, `create_presentation`, `edit_presentation`, `preview_presentation`,
   * `compare_presentation`, `compose_presentation`) beside the Python workspace. Defaults to `true`,
   * like the Word set: the typed surface is the reviewable one, and a role that wants only the
   * workspace can withhold it.
   */
  readonly includePptxTools?: boolean;
  readonly packId?: string;
}

export interface PaperOfficeToolPack {
  readonly id: string;
  readonly tools: readonly ToolRegistration[];
}

/**
 * The details a UI sees: JSON, and never the document's content. A type alias rather than an
 * interface, so it keeps the implicit index signature `JsonValue` needs.
 */
type PaperToolDetails = {
  operationId: string;
  code?: string;
  files?: string[];
  worker?: string;
};

type PaperToolResult = {
  readonly output: { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
  readonly details: PaperToolDetails;
};

const parameters = Type.Object({
  code: Type.String({
    description:
      "Python 3.13 for one bounded document operation. The workspace module `documents` is already in " +
      "scope: documents.inputs(), documents.open_input(name_or_version), documents.read_input(...), " +
      "documents.declare_output(name, format, edit_of=None), documents.write_output(name, bytes), " +
      "documents.arguments(), documents.result(value). Read only leased inputs, write only declared " +
      "outputs. There is no network, no shell, no credential and no host filesystem here.",
  }),
  arguments: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "JSON arguments for the code, read back with documents.arguments().",
    }),
  ),
});

const DESCRIPTION = [
  "Run Python against this task's leased document workspace to create or transform Word (.docx),",
  "PowerPoint (.pptx) and Excel (.xlsx) files with the pinned Paper libraries.",
  "",
  "- The code runs in an isolated Python 3.13 subprocess. It has no network, no shell, no credentials",
  "  and no model call. It reads only the immutable input versions this task's lease names, and writes",
  "  only the outputs it declares.",
  "- Every declared output is inspected as an Office package, reopened with its pinned library, and",
  "  committed as a new immutable version. A refusal or a timeout leaves every source untouched.",
  "- A replayed call returns the same committed receipt; it never edits a committed version in place.",
  "- Return the output file IDs and hashes you were given. Do not state a figure a document does not",
  "  contain, and trace any numeric claim to a spreadsheet cell or a computed value.",
].join("\n");

export function paperOfficeToolPack(options: PaperOfficeToolPackOptions): PaperOfficeToolPack {
  return {
    id: options.packId ?? PAPER_OFFICE_PACK_ID,
    tools: [
      runDocumentPython(options),
      ...(options.includeWordTools === false ? [] : wordTools(options)),
      ...(options.includePptxTools === false ? [] : pptxTools(options)),
    ],
  };
}

function runDocumentPython(options: PaperOfficeToolPackOptions): ToolRegistration {
  return defineTool({
    name: RUN_DOCUMENT_PYTHON,
    description: DESCRIPTION,
    parameters,
    replay: "safe",
    execute: async (args, api): Promise<PaperToolResult> => {
      const taskId = String(api.taskId);
      const conversationId = String(api.conversationId);
      const operationId = operationIdForCall({ conversationId, callId: api.callId });

      if (args.code.trim() === "" || Buffer.byteLength(args.code, "utf8") > MAX_CODE_BYTES) {
        return refusalResult(
          operationId,
          "invalid-request",
          "run_document_python needs code under 128 KB",
        );
      }
      const lease = await options.leaseFor({ taskId, conversationId });
      if (lease === undefined) {
        return refusalResult(
          operationId,
          "no-lease",
          "this task has no document lease, so no document workspace was granted. Ask the host for one.",
        );
      }

      const outcome = await options.service.runDocumentPython({
        operationId,
        taskId,
        lease,
        code: args.code,
        arguments: (args.arguments ?? {}) as Readonly<Record<string, unknown>>,
      });
      return outcome.kind === "refused" ? refused(outcome) : committed(outcome, taskId);
    },
  }) as unknown as ToolRegistration;
}

function committed(outcome: DocumentRunCommitted, taskId: string): PaperToolResult {
  const receipt = outcome.receipt;
  const body = {
    ok: true,
    operationId: receipt.operationId,
    taskId,
    worker: { python: receipt.worker.python, libraries: receipt.worker.libraries },
    read: receipt.reads.map((entry) => ({
      fileId: entry.fileId,
      versionId: entry.versionId,
      name: entry.name,
      format: entry.format,
      sha256: entry.sha256,
    })),
    wrote: receipt.outputs.map((entry) => ({
      fileId: entry.fileId,
      versionId: entry.versionId,
      name: entry.name,
      format: entry.format,
      size: entry.size,
      sha256: entry.sha256,
      versionOf: entry.sourceVersionId,
    })),
    reopened: receipt.reopen,
    result: receipt.resultDeclared ? receipt.result : null,
    notes: receipt.notes,
  };
  return {
    output: [{ type: "text", text: bounded(body) }],
    details: {
      operationId: receipt.operationId,
      files: receipt.outputs.map((entry) => entry.fileId),
      worker: receipt.worker.image,
    },
  };
}

function refused(outcome: DocumentRunRefused): PaperToolResult {
  return refusalResult(outcome.operationId, outcome.code, outcome.message);
}

function refusalResult(operationId: string, code: string, message: string): PaperToolResult {
  return {
    output: [{ type: "text", text: bounded({ ok: false, operationId, code, message }) }],
    isError: true,
    details: { operationId, code },
  };
}

function bounded(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  if (json.length <= MAX_TOOL_TEXT) return json;
  return `${json.slice(0, MAX_TOOL_TEXT)}\n… (truncated; the receipt is in the file ledger)`;
}
