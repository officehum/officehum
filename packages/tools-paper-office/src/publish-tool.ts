/**
 * `publish_document`: an agent may *ask* for a proposal to be published, and a person's review is
 * what decides whether it happens.
 *
 * The tool cannot approve itself. It resolves the review the **host** opened for the exact proposed
 * version, hands the call's operation ID to the `PublicationGate`, and returns whatever the gate
 * says: `not-approved` while nobody has decided, `denied` after a refusal, `approval-mismatch` when
 * the approval is bound to other hashes, `stale-review` when a newer edit superseded the proposal,
 * `version-conflict` when the published pointer moved after the review. Every refusal returns before
 * the FileStore is asked to publish, so the published pointer is exactly where it was.
 *
 * The operation ID comes from the Pi Durable call identity, never from an argument, and the gate is
 * idempotent on it: a replayed call returns the same publication instead of a second pointer move.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { operationIdForCall } from "./operation.js";
import type { PublicationGate, ReviewPublication } from "./review.js";

export const PUBLISH_DOCUMENT = "publish_document";

const MAX_TOOL_TEXT = 4_000;

/** What the host needs to find the review for a proposal. The agent never names an approval. */
export interface PublishLookup {
  readonly taskId: string;
  readonly fileId: string;
  readonly proposedVersionId: string;
}

export interface PublishDocumentToolOptions {
  readonly gate: PublicationGate;
  /**
   * The review the host opened for a proposed version, or `undefined` when there is none. A review
   * and its decision are the host's; an agent cannot create one, so it cannot approve itself.
   */
  readonly reviewFor: (lookup: PublishLookup) => Promise<string | undefined>;
}

const parameters = Type.Object(
  {
    fileId: Type.String({
      minLength: 1,
      description: "The FileStore file id the proposal belongs to.",
    }),
    proposedVersionId: Type.String({
      minLength: 1,
      description: "The immutable proposed version id a person must have reviewed.",
    }),
  },
  { additionalProperties: false },
);

const DESCRIPTION = [
  "Ask to publish a proposed version of an existing file, behind a person's review of that exact version.",
  "",
  "- A person must have reviewed the exact proposed version first. If nobody has, this refuses with",
  "  `not-approved` and nothing changes; if a person declined, it refuses with `denied`.",
  "- The review is bound to the file, the source version and hash, the proposed version and hash, and",
  "  the evidence a person saw, so an approval for one proposal can never publish another.",
  "- Read the refusal and tell the user what is waiting on review. Do not try to work around it.",
  "- A replayed call returns the same publication; it never moves the published pointer twice.",
].join("\n");

type PublishToolDetails = {
  operationId: string;
  code?: string;
  reviewId?: string;
  files?: string[];
};

type PublishToolResult = {
  readonly output: { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
  readonly details: PublishToolDetails;
};

export function publishDocumentTool(options: PublishDocumentToolOptions): ToolRegistration {
  return defineTool({
    name: PUBLISH_DOCUMENT,
    description: DESCRIPTION,
    parameters,
    replay: "safe",
    execute: async (args: unknown, api): Promise<PublishToolResult> => {
      const taskId = String(api.taskId);
      const conversationId = String(api.conversationId);
      const operationId = operationIdForCall({ conversationId, callId: api.callId });

      const request = args as { fileId?: unknown; proposedVersionId?: unknown };
      if (
        typeof request.fileId !== "string" ||
        request.fileId === "" ||
        typeof request.proposedVersionId !== "string" ||
        request.proposedVersionId === ""
      ) {
        return refusal(
          operationId,
          "invalid-request",
          "publish_document needs a file and a version",
        );
      }

      const reviewId = await options.reviewFor({
        taskId,
        fileId: request.fileId,
        proposedVersionId: request.proposedVersionId,
      });
      if (reviewId === undefined) {
        return refusal(
          operationId,
          "not-approved",
          "no person has reviewed this proposed version, so it was not published",
        );
      }

      const outcome = await options.gate.publish({ reviewId, operationId });
      if (!outcome.ok) return refusal(operationId, outcome.code, outcome.message, reviewId);
      return published(operationId, reviewId, outcome.value);
    },
  }) as unknown as ToolRegistration;
}

/**
 * The `reviewFor` a host wires up when it keeps its reviews in one ledger: the review whose proposal
 * is exactly this file and proposed version. An approval is looked up by the *hashes it was made
 * for*, never by a name an agent supplied.
 */
export function reviewForProposed(
  gate: PublicationGate,
): (lookup: PublishLookup) => Promise<string | undefined> {
  return async (lookup) => {
    for (const record of await gate.list()) {
      if (
        record.proposal.identity.fileId === lookup.fileId &&
        record.proposal.identity.proposed.versionId === lookup.proposedVersionId
      ) {
        return record.reviewId;
      }
    }
    return undefined;
  };
}

function published(
  operationId: string,
  reviewId: string,
  publication: ReviewPublication,
): PublishToolResult {
  const receipt = publication.receipt;
  const body = {
    ok: true,
    operationId,
    reviewId,
    fileId: receipt.published.id,
    name: receipt.published.name,
    previous: receipt.previous?.versionId ?? null,
    published: receipt.published.versionId,
    sha256: receipt.published.sha256,
    approvalId: receipt.approvalId,
  };
  return {
    output: [{ type: "text", text: bounded(body) }],
    details: { operationId, reviewId, files: [receipt.published.versionId] },
  };
}

function refusal(
  operationId: string,
  code: string,
  message: string,
  reviewId?: string,
): PublishToolResult {
  const body = {
    ok: false,
    operationId,
    ...(reviewId === undefined ? {} : { reviewId }),
    code,
    message,
  };
  return {
    output: [{ type: "text", text: bounded(body) }],
    isError: true,
    details: { operationId, code, ...(reviewId === undefined ? {} : { reviewId }) },
  };
}

function bounded(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  if (json.length <= MAX_TOOL_TEXT) return json;
  return `${json.slice(0, MAX_TOOL_TEXT)}\n… (truncated; the receipt is in the review ledger)`;
}
