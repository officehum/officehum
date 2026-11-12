/**
 * What the typed Word, PowerPoint and Excel tools share as Pi Durable registrations.
 *
 * Every typed tool does the same things around its own format: derive the operation ID from the Pi
 * Durable call (never from an argument), look the task's lease up, turn the arguments into a fixed
 * program, run it through the injected `DocumentService`, validate the answer, and reply with bounded
 * JSON. That path lives here once; a format supplies its schemas, its program and parser, and what its
 * reply may give up when it is too large.
 */

import { type TSchema, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { DocumentRunCommitted, DocumentService } from "./document-service.js";
import { DocumentError } from "./errors.js";
import type { DocumentLease, LeasedInput } from "./lease.js";
import { operationIdForCall } from "./operation.js";
import { type DocumentFileRef, fileRefOf } from "./typed-operation.js";

/** What the pack needs to find a task's lease. The host owns leases; the pack only asks. */
export interface LeaseLookup {
  readonly taskId: string;
  readonly conversationId: string;
}

/** What a typed tool needs: the injected service and the host's lease lookup. */
export interface DocumentToolOptions {
  readonly service: DocumentService;
  readonly leaseFor: (lookup: LeaseLookup) => Promise<DocumentLease | undefined>;
}

/** The argument schema of a file reference; `example` is a file name of the tool's own format. */
export function fileRefSchema(example: string) {
  return Type.Object(
    {
      fileId: Type.String({ minLength: 1, description: "The FileStore file id the lease pinned." }),
      versionId: Type.String({
        minLength: 1,
        description: "The immutable version id the lease pinned.",
      }),
      name: Type.String({ minLength: 1, description: `The leased file name, e.g. ${example}.` }),
      sha256: Type.String({
        minLength: 1,
        description: "The version's sha256, as the lease pinned it.",
      }),
      size: Type.Integer({ minimum: 0, description: "The version's size in bytes." }),
    },
    { additionalProperties: false },
  );
}

/** What a too-large reply gives up, in order. */
export interface ReplyTrim<Result> {
  /** The most characters of JSON one reply may carry. */
  readonly maxText: number;
  /** Lighter forms of the result, each applied to the one before it, with what each leaves out. */
  readonly reductions: readonly {
    readonly omits: readonly string[];
    apply(result: Result): Result;
  }[];
  /** Fields of the *result* given up next. They are removed from the result, where they live. */
  readonly resultKeys: readonly string[];
}

/** The receipt fields beside the result, given up last: the file ids a caller needs go last of all. */
const RECEIPT_KEYS = ["read", "notes", "reopened", "worker", "wrote"] as const;

/**
 * A reply a model reads is JSON, so trimming it must keep it JSON; slicing the string would leave a
 * model with a document it cannot parse and no way to tell. A body that does not fit gives up its
 * verbose material first (the reductions keep every count, hash and file id), then named fields of
 * the result, then the receipt fields beside it, and names everything it left out.
 *
 * Returns `undefined` when what must stay still does not fit. The caller then refuses: an empty body
 * marked `ok` would tell a model the call answered when it carried nothing.
 */
export function boundedReply<Result extends object>(
  compose: (result: Result) => Record<string, unknown>,
  result: Result,
  trim: ReplyTrim<Result>,
): { readonly text: string; readonly truncated: boolean } | undefined {
  const render = (value: Record<string, unknown>): string => JSON.stringify(value, null, 2);
  const fits = (value: Record<string, unknown>): boolean => render(value).length <= trim.maxText;
  let body = compose(result);
  if (fits(body)) return { text: render(body), truncated: false };

  const omitted: string[] = [];
  let lighter = result;
  for (const reduction of trim.reductions) {
    lighter = reduction.apply(lighter);
    omitted.push(...reduction.omits);
    body = compose(lighter);
    if (fits(body)) break;
  }
  const inner = { ...lighter } as Record<string, unknown>;
  body = { ...body, result: inner };
  for (const key of trim.resultKeys) {
    if (fits(body)) break;
    if (key in inner) {
      delete inner[key];
      omitted.push(`result.${key}`);
    }
  }
  for (const key of RECEIPT_KEYS) {
    if (fits(body)) break;
    if (key in body) {
      delete body[key];
      omitted.push(key);
    }
  }
  if (!fits(body)) return undefined;
  body.omitted = omitted;
  body.truncated = true;
  return { text: render(body), truncated: true };
}

/** The program a typed request becomes: fixed code, checked arguments, and the leased inputs it names. */
export interface DocumentProgram {
  readonly code: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly sources: readonly LeasedInput[];
}

/** One format's typed tools: everything that differs between Word, PowerPoint and Excel. */
export interface DocumentToolFamily<Operation extends string, Result extends object> {
  /** What a missing lease did not grant, e.g. "Word document". */
  readonly subject: string;
  readonly descriptions: Readonly<Record<Operation, string>>;
  program(operation: Operation, args: unknown, lease: DocumentLease): DocumentProgram;
  parse(operation: Operation, value: unknown, sources: readonly DocumentFileRef[]): Result;
  readonly trim: ReplyTrim<Result>;
  /** Per operation, what to ask for instead when even the trimmed reply does not fit. */
  readonly narrow: Readonly<Record<Operation, string>>;
}

/** A type alias, not an interface, so it keeps the implicit index signature `JsonValue` needs. */
type DocumentToolDetails = {
  operationId: string;
  operation: string;
  files?: string[];
  worker?: string;
  truncated?: boolean;
  code?: string;
};

type DocumentToolResult = {
  readonly output: { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
  readonly details: DocumentToolDetails;
};

/**
 * One typed tool. It is `replay: "safe"`: the service is idempotent by operation ID, so an
 * interrupted call that reruns resolves to the same committed receipt instead of a second edit.
 */
export function documentTool<Operation extends string, Result extends object>(
  family: DocumentToolFamily<Operation, Result>,
  operation: Operation,
  name: string,
  parameters: TSchema,
  options: DocumentToolOptions,
): ToolRegistration {
  return defineTool({
    name,
    description: family.descriptions[operation],
    parameters,
    replay: "safe",
    execute: async (args: unknown, api): Promise<DocumentToolResult> => {
      const taskId = String(api.taskId);
      const conversationId = String(api.conversationId);
      const operationId = operationIdForCall({ conversationId, callId: api.callId });

      const lease = await options.leaseFor({ taskId, conversationId });
      if (lease === undefined) {
        return refusalResult(
          operation,
          operationId,
          "no-lease",
          `this task has no document lease, so no ${family.subject} was granted. Ask the host for one.`,
        );
      }

      let program: DocumentProgram;
      try {
        program = family.program(operation, args, lease);
      } catch (error) {
        return refused(error, operation, operationId);
      }

      const outcome = await options.service.runDocumentPython({
        operationId,
        taskId,
        lease,
        code: program.code,
        arguments: program.arguments,
      });
      if (outcome.kind === "refused") {
        return refusalResult(operation, outcome.operationId, outcome.code, outcome.message);
      }

      try {
        const result = family.parse(
          operation,
          outcome.receipt.result,
          program.sources.map(fileRefOf),
        );
        return committed(family, operation, operationId, taskId, outcome, result);
      } catch (error) {
        return refused(error, operation, operationId);
      }
    },
  }) as unknown as ToolRegistration;
}

function committed<Operation extends string, Result extends object>(
  family: DocumentToolFamily<Operation, Result>,
  operation: Operation,
  operationId: string,
  taskId: string,
  outcome: DocumentRunCommitted,
  result: Result,
): DocumentToolResult {
  const receipt = outcome.receipt;
  const wrote = receipt.outputs.map((entry) => ({
    fileId: entry.fileId,
    versionId: entry.versionId,
    name: entry.name,
    format: entry.format,
    size: entry.size,
    sha256: entry.sha256,
    versionOf: entry.sourceVersionId,
  }));
  const files = receipt.outputs.map((entry) => entry.fileId);
  const compose = (value: Result): Record<string, unknown> => ({
    ok: true,
    operation,
    operationId,
    taskId,
    result: value,
    wrote,
    read: receipt.reads.map((entry) => ({
      fileId: entry.fileId,
      versionId: entry.versionId,
      name: entry.name,
      sha256: entry.sha256,
    })),
    reopened: receipt.reopen,
    worker: { python: receipt.worker.python, libraries: receipt.worker.libraries },
    notes: receipt.notes,
  });
  const reply = boundedReply(compose, result, family.trim);
  if (reply === undefined) {
    // The run is committed and its receipt is in the ledger; only the reply is too large. Saying so,
    // with the versions it wrote, lets the caller ask again for less instead of acting on nothing.
    const message =
      `the ${operation} result does not fit in one reply, even trimmed. ${family.narrow[operation]}` +
      (wrote.length > 0
        ? " The run itself completed: the versions under `wrote` are committed, so do not repeat it."
        : "");
    const code = "reply-too-large";
    return {
      output: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: false,
              operation,
              operationId,
              code,
              message,
              ...(wrote.length > 0 ? { wrote } : {}),
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
      details: { operationId, operation, code, files },
    };
  }
  return {
    output: [{ type: "text", text: reply.text }],
    details: {
      operationId,
      operation,
      files,
      worker: receipt.worker.image,
      ...(reply.truncated ? { truncated: true } : {}),
    },
  };
}

function refused(error: unknown, operation: string, operationId: string): DocumentToolResult {
  if (error instanceof DocumentError) {
    return refusalResult(operation, operationId, error.code, error.message);
  }
  throw error;
}

function refusalResult(
  operation: string,
  operationId: string,
  code: string,
  message: string,
): DocumentToolResult {
  return {
    output: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, operation, operationId, code, message }, null, 2),
      },
    ],
    isError: true,
    details: { operationId, operation, code },
  };
}
