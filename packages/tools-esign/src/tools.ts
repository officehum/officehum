/**
 * The pack's five tools, as Pi Durable registrations.
 *
 * | Tool | Replay | Writes | Gate |
 * | --- | --- | --- | --- |
 * | `esign_templates` | safe | no | none |
 * | `esign_send` | unsafe | sends to outside parties | `send_for_signature`, always |
 * | `esign_status` | safe | no | none |
 * | `esign_download` | safe | saves the signed copy, once per request | none |
 * | `esign_void` | unsafe | voids a request | `void_signature_request`, always |
 *
 * A send's request id is the call's durable identity (`requestId("esign", api)`), so the provider can
 * deduplicate a repeated send and the request record is written once. Nothing a provider returns
 * reaches the model unchecked or unframed: statuses are held to the list, signers to the ones sent,
 * and provider data is fenced as outside output.
 */

import { createHash } from "node:crypto";
import {
  defineTool,
  type JsonObject,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { arr, int, obj, opt, type Schema, str } from "@earendil-works/pi-schema";
import {
  APPROVED_FACTS_ARG,
  type ApprovalFactsReader,
  approvedFactsParameter,
  fileResult,
  frameOutsideOutput,
  type LlmBlock,
  requestId,
  sameFacts,
  type VersionedFileStore,
} from "@officehum/sdk";
import {
  approvedNow,
  esignApprovalFacts,
  readSendFacts,
  readVoidFacts,
  type SendFacts,
  type VoidFacts,
} from "./approvals.js";
import { saveSigned } from "./download.js";
import {
  checkSendResult,
  checkStatusResult,
  type ESignature,
  type ESignDocument,
  ESignError,
  isLabel,
} from "./esign.js";
import { ESIGN_REQUESTS_DOC, type ESignRecord } from "./records.js";

export const ESIGN_TEMPLATES = "esign_templates";
export const ESIGN_SEND = "esign_send";
export const ESIGN_STATUS = "esign_status";
export const ESIGN_DOWNLOAD = "esign_download";
export const ESIGN_VOID = "esign_void";
export const ESIGN_PACK_ID = "esign";

export interface ESignPackOptions {
  readonly esign: ESignature;
  /** The office's file store: documents are read from it and signed copies saved to it. */
  readonly store: VersionedFileStore;
  /** Who the store records as having saved a signed copy, e.g. `role:office-manager`. */
  readonly createdBy: string;
}

export interface ESignPack {
  readonly id: string;
  readonly tools: readonly ToolRegistration[];
  /** The approval facts readers, for `defineRole`'s `approvalFacts`. */
  readonly approvalFacts: Readonly<Record<string, ApprovalFactsReader>>;
}

const SIGNER = obj(
  {
    name: str({ minLength: 1, description: "The signer's full name." }),
    email: str({ minLength: 3, description: "The signer's email address." }),
    role: opt(str({ description: "Their role in the template (template sends only)." })),
    order: opt(
      int({ minimum: 1, description: "Their place in the signing order; 1 signs first." }),
    ),
  },
  { description: "One person asked to sign." },
);

const SEND_PARAMETERS = obj(
  {
    document_file_ids: opt(
      arr(str(), { description: "The files to send, by id from the office's file store." }),
    ),
    template_id: opt(str({ description: "A template id from esign_templates, instead of files." })),
    signers: arr(SIGNER, { description: "Exactly the people the user asked to sign, no others." }),
    subject: str({ minLength: 1, description: "The email subject the signers see." }),
    message: str({ description: "The note the signers see with the documents." }),
    expires_in_days: opt(int({ minimum: 1, maximum: 365, description: "Days until it expires." })),
    [APPROVED_FACTS_ARG]: approvedFactsParameter(),
  },
  { description: "What to send for signature, to whom, and the note with it." },
);

const REQUEST_PARAMETERS = obj(
  { request_id: str({ minLength: 1, description: "The request_id esign_send returned." }) },
  { description: "Which signature request." },
);

const VOID_PARAMETERS = obj(
  {
    request_id: str({ minLength: 1, description: "The request_id esign_send returned." }),
    reason: str({ minLength: 1, description: "Why it is being voided; the signers may see it." }),
    [APPROVED_FACTS_ARG]: approvedFactsParameter(),
  },
  { description: "Which signature request to void, and why." },
);

const DESCRIPTIONS = {
  templates:
    "List the e-signature provider's templates: documents already set up for signing, each with its id, name and signer roles.",
  send: [
    "Send documents from the office's file store (or one template) to people outside the office for",
    "their signature. A person always approves first: they see the documents, the signers and the",
    "message, and exactly that is sent. Name only the signers the user asked for. You never sign",
    "for anyone. Returns a request_id to follow it with esign_status.",
  ].join("\n"),
  status:
    "Where a signature request stands: sent, viewed, partially_signed, completed, declined, expired or voided, and each signer's state.",
  download:
    "Save a completed request's signed PDF, and the provider's certificate when it has one, to the office's file store, and return the files.",
  void: "Void a signature request that is not completed, so nobody can sign it. A person approves first.",
} as const;

type ToolResult = {
  readonly output: LlmBlock[];
  readonly isError?: boolean;
  readonly details: JsonObject;
};

type Run = (
  args: Record<string, unknown>,
  api: ToolExecutionApi,
  context: Parameters<ToolRegistration["execute"]>[2],
) => Promise<ToolResult>;

const SOURCE = "the business's e-signature provider";

export function eSignaturePack(options: ESignPackOptions): ESignPack {
  const { esign, store } = options;
  const deps = { esign, store };

  const record = async (
    api: ToolExecutionApi,
    context: Parameters<Run>[2],
    id: unknown,
  ): Promise<ESignRecord & { providerId: string }> => {
    const found =
      typeof id === "string"
        ? (await api.snapshot(ESIGN_REQUESTS_DOC, context))?.requests[id]
        : undefined;
    if (found === undefined) {
      throw new ESignError(
        "unknown-request",
        `${JSON.stringify(id)} is not a signature request this office sent; use the request_id esign_send returned.`,
      );
    }
    if (found.providerId === null) {
      throw new ESignError(
        "send-interrupted",
        "This request's send was cut off before the provider answered, so whether it went out is not known. Send it again with esign_send and the same details: it will not go out twice.",
      );
    }
    return { ...found, providerId: found.providerId };
  };

  return {
    id: ESIGN_PACK_ID,
    approvalFacts: esignApprovalFacts(deps),
    tools: [
      tool(ESIGN_TEMPLATES, DESCRIPTIONS.templates, obj({}), "safe", async () => {
        const listed = await provider(() => esign.listTemplates());
        if (!Array.isArray(listed)) throw outsideShape("templates that are not a list");
        const templates = listed.map((entry) => {
          if (
            !isLabel(entry?.id) ||
            typeof entry.name !== "string" ||
            !Array.isArray(entry.roles)
          ) {
            throw outsideShape("a template without an id, a name and roles");
          }
          return { id: entry.id, name: entry.name, roles: entry.roles.map(String) };
        });
        return {
          output: frameOutsideOutput(
            { tool: ESIGN_TEMPLATES, origin: SOURCE, tag: "esign-output" },
            [{ type: "text", text: JSON.stringify({ templates }) }],
          ),
          details: { templates: templates.map((template) => template.id) },
        };
      }),

      tool(ESIGN_SEND, DESCRIPTIONS.send, SEND_PARAMETERS, "unsafe", async (args, api, context) => {
        const facts = await approvedNow<SendFacts>(
          args,
          () => readSendFacts(args, deps),
          "Sending for signature",
        );
        const id = requestId(ESIGN_PACK_ID, api);
        const conversationId = String(api.conversationId);
        const records = (await api.snapshot(ESIGN_REQUESTS_DOC, context))?.requests ?? {};
        const own = records[id];
        if (own?.providerId != null) return sentResult(own, "already sent by this call");
        // A send of these same approved facts from this conversation that a restart cut off before
        // the provider answered: reuse its request id, so the provider returns that request.
        const unfinished =
          own ??
          Object.values(records).find(
            (record) =>
              record.providerId === null &&
              record.conversationId === conversationId &&
              sameFacts(factsOf(record), facts),
          );
        const key = unfinished?.requestId ?? id;

        const documents: ESignDocument[] = [];
        for (const approved of facts.documents) {
          const file = await store.get(approved.fileId);
          const actual =
            file === undefined ? undefined : createHash("sha256").update(file.bytes).digest("hex");
          if (file === undefined || actual !== approved.sha256) {
            throw new ESignError(
              "changed-since-approval",
              `${approved.name} changed after a person approved sending it, so nothing was sent. Ask again with the current file.`,
            );
          }
          documents.push({ ...approved, bytes: file.bytes });
        }
        if (unfinished === undefined) {
          const intent: ESignRecord = {
            requestId: id,
            providerId: null,
            conversationId,
            taskId: String(api.taskId),
            documents: facts.documents,
            template: facts.template,
            signers: facts.signers,
            subject: facts.subject,
            message: facts.message,
            expiresInDays: facts.expiresInDays,
            sentAt: new Date(api.now()).toISOString(),
          };
          // Written before the provider is called, so a restart mid-call leaves it to be reused.
          await api.commit(async (tx) => {
            const doc = await tx.doc(ESIGN_REQUESTS_DOC);
            doc.requests[id] ??= intent;
          }, context);
        }
        const sent = checkSendResult(
          await provider(() =>
            esign.send({
              ...(facts.template === null ? { documents } : { templateId: facts.template.id }),
              signers: facts.signers.map((signer) => ({
                name: signer.name,
                email: signer.email,
                ...(signer.role === null ? {} : { role: signer.role }),
                ...(signer.order === null ? {} : { order: signer.order }),
              })),
              subject: facts.subject,
              message: facts.message,
              ...(facts.expiresInDays === null ? {} : { expiresInDays: facts.expiresInDays }),
              requestId: key,
            }),
          ),
          key,
        );
        // First write wins: a provider id already recorded for this request is kept.
        await api.commit(async (tx) => {
          const doc = await tx.doc(ESIGN_REQUESTS_DOC);
          const stored = doc.requests[key];
          if (stored === undefined) throw new Error(`The request record ${key} is missing.`);
          stored.providerId ??= sent.providerId;
        }, context);
        return sentResult({ requestId: key, signers: facts.signers }, sent.status);
      }),

      tool(
        ESIGN_STATUS,
        DESCRIPTIONS.status,
        REQUEST_PARAMETERS,
        "safe",
        async (args, api, context) => {
          const found = await record(api, context, args.request_id);
          const status = checkStatusResult(
            await provider(() => esign.status(found.providerId)),
            found.signers.map((signer) => signer.email),
          );
          return {
            output: frameOutsideOutput(
              { tool: ESIGN_STATUS, origin: SOURCE, tag: "esign-output" },
              [
                {
                  type: "text",
                  text: JSON.stringify({ request_id: found.requestId, ...status }),
                },
              ],
            ),
            details: { requestId: found.requestId, status: status.status },
          };
        },
      ),

      tool(
        ESIGN_DOWNLOAD,
        DESCRIPTIONS.download,
        REQUEST_PARAMETERS,
        "safe",
        async (args, api, context) => {
          const found = await record(api, context, args.request_id);
          const copy = await provider(async () => {
            try {
              return await saveSigned({
                esign,
                store,
                record: found,
                createdBy: options.createdBy,
              });
            } catch (error) {
              if (error instanceof ESignError) throw error;
              // Say why when the provider simply is not finished: a download before completion.
              const status = checkStatusResult(
                await esign.status(found.providerId),
                found.signers.map((signer) => signer.email),
              ).status;
              if (status !== "completed") {
                throw new ESignError(
                  "not-completed",
                  `The request is ${status}, not completed, so there is no signed copy yet.`,
                );
              }
              throw error;
            }
          });
          const refs =
            copy.certificate === undefined ? [copy.signed] : [copy.signed, copy.certificate];
          const result = fileResult(refs, { tool: ESIGN_DOWNLOAD });
          return {
            output: [
              ...result.output,
              {
                type: "text",
                text: JSON.stringify({ ok: true, request_id: found.requestId, saved: refs.length }),
              },
            ],
            details: { files: result.details.files, requestId: found.requestId },
          };
        },
      ),

      tool(ESIGN_VOID, DESCRIPTIONS.void, VOID_PARAMETERS, "unsafe", async (args, api, context) => {
        const facts = await approvedNow<VoidFacts>(
          args,
          () => readVoidFacts(args),
          "Voiding a signature request",
        );
        const found = await record(api, context, facts.requestId);
        await provider(() => esign.void(found.providerId, facts.reason));
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, request_id: found.requestId, status: "voided" }),
            },
          ],
          details: { requestId: found.requestId, status: "voided" },
        };
      }),
    ],
  };
}

/** A record's facts, in the shape the approval holds them, to compare with a new send's. */
function factsOf(record: ESignRecord): SendFacts {
  return {
    documents: record.documents,
    template: record.template,
    signers: record.signers,
    subject: record.subject,
    message: record.message,
    expiresInDays: record.expiresInDays,
  };
}

function sentResult(
  record: Pick<ESignRecord, "requestId" | "signers">,
  status: string,
): ToolResult {
  return {
    output: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          request_id: record.requestId,
          status,
          signers: record.signers.map((signer) => signer.email),
        }),
      },
    ],
    details: { requestId: record.requestId },
  };
}

function outsideShape(what: string): ESignError {
  return new ESignError("provider-output", `The e-signature provider returned ${what}.`);
}

/**
 * Runs a provider call. A failure that is not the pack's own refusal is the provider's: its message
 * stays in the details for the host, and the model is told only that the provider failed.
 */
class ProviderFailure extends Error {}

async function provider<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ESignError) throw error;
    throw new ProviderFailure(error instanceof Error ? error.message : String(error));
  }
}

function tool(
  name: string,
  description: string,
  parameters: Schema,
  replay: "safe" | "unsafe",
  run: Run,
): ToolRegistration {
  return defineTool({
    name,
    description,
    parameters,
    replay,
    execute: async (args: unknown, api, context): Promise<ToolResult> => {
      try {
        if (typeof args !== "object" || args === null) {
          throw new ESignError("invalid-request", "The arguments must be a JSON object.");
        }
        return await run(args as Record<string, unknown>, api, context);
      } catch (error) {
        if (error instanceof ESignError) {
          return refused({ ok: false, code: error.code, message: error.message }, error.code);
        }
        if (error instanceof ProviderFailure) {
          const unsure =
            replay === "unsafe"
              ? " It may or may not have acted; do not retry on your own, tell a person."
              : " Try again later.";
          return refused(
            {
              ok: false,
              code: "provider-error",
              message: `The e-signature provider failed.${unsure}`,
            },
            "provider-error",
            error.message,
          );
        }
        throw error;
      }
    },
  }) as unknown as ToolRegistration;
}

function refused(body: JsonObject, code: string, providerMessage?: string): ToolResult {
  return {
    output: [{ type: "text", text: JSON.stringify(body) }],
    isError: true,
    details: { code, ...(providerMessage === undefined ? {} : { providerMessage }) },
  };
}
