/**
 * What a person approves before anything goes out for signature, and the check that what runs is
 * exactly that.
 *
 * `esign_send` is gated by `send_for_signature`, `esign_void` by `void_signature_request`, both with
 * no `when`: every call asks. Each approval has a facts reader. For a send it reads the documents
 * from the file store (name and content hash) or the template from the provider, and takes the
 * signers, subject and message from the call, so the person sees exactly what would go out. On a yes
 * the gate hands those facts to the tool, which reads them again and refuses if anything differs: a
 * document whose content changed, or any other drift, is never sent on an approval for something
 * else. The tool then sends the approved facts, never the model's arguments, so no signer is added
 * that the person did not see.
 *
 * Both tools also refuse a call that carries no approved facts at all, so a role whose manifest
 * forgot the approval cannot send or void either.
 */

import {
  type ApprovalFactsReader,
  approvedFacts,
  declaredFacts,
  type FileStore,
  sameFacts,
  type ToolArguments,
} from "@officehum/sdk";
import { type ESignature, ESignError } from "./esign.js";
import type { ApprovedDocument, ApprovedSigner, ApprovedTemplate } from "./records.js";

export const SEND_APPROVAL = "send_for_signature";
export const VOID_APPROVAL = "void_signature_request";

export const MAX_DOCUMENTS = 10;
export const MAX_SIGNERS = 20;

export type SendFacts = {
  documents: ApprovedDocument[];
  template: ApprovedTemplate | null;
  signers: ApprovedSigner[];
  subject: string;
  message: string;
  expiresInDays: number | null;
};

export type VoidFacts = { requestId: string; reason: string };

export interface ApprovalDependencies {
  readonly esign: ESignature;
  readonly store: FileStore;
}

const SEND_FIELDS = ["documents", "template", "signers", "subject", "message", "expiresInDays"];
const VOID_FIELDS = ["requestId", "reason"];
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/u;
const FILE_ID = /^file_[0-9A-HJKMNP-TV-Z]{26}$/u;

function invalid(message: string): ESignError {
  return new ESignError("invalid-request", message);
}

/** Printable text of at most `max` characters; `min` 0 allows empty. */
function text(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== "string") throw invalid(`${what} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max || hasControl(trimmed)) {
    throw invalid(
      `${what} must be ${min === 0 ? "at most" : `${min} to`} ${max} printable characters.`,
    );
  }
  return trimmed;
}

/** Whether text holds a control character other than a newline or a tab. */
function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 32 && char !== "\n" && char !== "\t") || (code >= 127 && code < 160)) return true;
  }
  return false;
}

function signersOf(value: unknown, template: ApprovedTemplate | null): ApprovedSigner[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SIGNERS) {
    throw invalid(`signers must list 1 to ${MAX_SIGNERS} people.`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const at = `signers[${index}]`;
    if (entry === null || typeof entry !== "object") throw invalid(`${at} must be a record.`);
    const { name, email, role, order } = entry as Record<string, unknown>;
    const address = text(email, `${at}.email`, 3, 254);
    if (!EMAIL.test(address)) throw invalid(`${at}.email is not an email address.`);
    if (seen.has(address.toLowerCase())) throw invalid(`${at}.email is listed twice.`);
    seen.add(address.toLowerCase());
    const signer: ApprovedSigner = {
      name: text(name, `${at}.name`, 1, 200),
      email: address,
      role: role === undefined || role === null ? null : text(role, `${at}.role`, 1, 64),
      order: null,
    };
    if (order !== undefined && order !== null) {
      if (!Number.isInteger(order) || (order as number) < 1 || (order as number) > MAX_SIGNERS) {
        throw invalid(`${at}.order must be a whole number from 1 to ${MAX_SIGNERS}.`);
      }
      signer.order = order as number;
    }
    if (template !== null && (signer.role === null || !template.roles.includes(signer.role))) {
      throw invalid(
        `${at}.role must be one of the template's roles: ${template.roles.join(", ")}.`,
      );
    }
    return signer;
  });
}

/**
 * The facts a send would go out with, read now: the documents from the store, the template from the
 * provider, the rest from the call. Throws an `ESignError` saying what is wrong.
 */
export async function readSendFacts(
  args: ToolArguments,
  { esign, store }: ApprovalDependencies,
): Promise<SendFacts> {
  const ids = args.document_file_ids;
  const templateId = args.template_id;
  const hasDocuments = ids !== undefined && ids !== null;
  const hasTemplate = templateId !== undefined && templateId !== null;
  if (hasDocuments === hasTemplate) {
    throw invalid("Give either document_file_ids or template_id, not both and not neither.");
  }
  const documents: ApprovedDocument[] = [];
  let template: ApprovedTemplate | null = null;
  if (hasDocuments) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_DOCUMENTS) {
      throw invalid(`document_file_ids must list 1 to ${MAX_DOCUMENTS} files.`);
    }
    for (const id of ids) {
      if (typeof id !== "string" || !FILE_ID.test(id)) {
        throw invalid(`${JSON.stringify(id)} is not a file id.`);
      }
      if (documents.some((document) => document.fileId === id)) {
        throw invalid(`${id} is listed twice.`);
      }
      const ref = await store.info(id);
      if (ref === undefined) {
        throw new ESignError("unknown-document", `${id} is not in the office's file store.`);
      }
      documents.push({
        fileId: ref.id,
        name: ref.name,
        mimeType: ref.mimeType,
        sha256: ref.sha256,
      });
    }
  } else {
    const id = text(templateId, "template_id", 1, 128);
    const found = (await esign.listTemplates()).find((entry) => entry.id === id);
    if (found === undefined) {
      throw new ESignError("unknown-template", `${id} is not one of esign_templates.`);
    }
    template = { id: found.id, name: found.name, roles: [...found.roles] };
  }
  const days = args.expires_in_days;
  if (days !== undefined && days !== null) {
    if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 365) {
      throw invalid("expires_in_days must be a whole number from 1 to 365.");
    }
  }
  return {
    documents,
    template,
    signers: signersOf(args.signers, template),
    subject: text(args.subject, "subject", 1, 200),
    message: text(args.message, "message", 0, 2000),
    expiresInDays: days === undefined || days === null ? null : (days as number),
  };
}

/** What the person reads before they decide on a send. */
export function sendSummary(facts: SendFacts): string {
  const what =
    facts.template === null
      ? facts.documents
          .map((document) => `${document.name} (${document.fileId}, sha256 ${document.sha256})`)
          .join("; ")
      : `the template ${facts.template.name} (${facts.template.id})`;
  const who = facts.signers
    .map(
      (signer) =>
        `${signer.name} <${signer.email}>` +
        (signer.role === null ? "" : ` as ${signer.role}`) +
        (signer.order === null ? "" : `, signing ${signer.order}${ordinal(signer.order)}`),
    )
    .join("; ");
  return [
    "Send for signature to people outside the office.",
    `Documents: ${what}`,
    `Signers: ${who}`,
    `Subject: ${facts.subject}`,
    `Message: ${facts.message === "" ? "(none)" : facts.message}`,
    ...(facts.expiresInDays === null ? [] : [`Expires after ${facts.expiresInDays} days`]),
  ].join("\n");
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

export function readVoidFacts(args: ToolArguments): VoidFacts {
  return {
    requestId: text(args.request_id, "request_id", 1, 512),
    reason: text(args.reason, "reason", 1, 500),
  };
}

/** The approval facts readers a role passes to `defineRole`'s `approvalFacts`. */
export function esignApprovalFacts(
  deps: ApprovalDependencies,
): Readonly<Record<string, ApprovalFactsReader>> {
  return {
    [SEND_APPROVAL]: declaredFacts(SEND_FIELDS, async (args) => {
      const facts = await readSendFacts(args, deps);
      return { summary: sendSummary(facts), facts };
    }),
    [VOID_APPROVAL]: declaredFacts(VOID_FIELDS, async (args) => {
      const facts = readVoidFacts(args);
      return {
        summary: `Void the signature request ${facts.requestId}, so nobody can sign it.\nReason: ${facts.reason}`,
        facts,
      };
    }),
  };
}

/**
 * The approved facts for this call, checked against the facts as they stand now. Refuses a call with
 * no approval, and one whose facts changed since the person saw them.
 */
export async function approvedNow<T>(
  args: ToolArguments,
  read: () => Promise<T> | T,
  what: string,
): Promise<T> {
  const approved = approvedFacts(args);
  if (approved === undefined) {
    throw new ESignError(
      "not-approved",
      `${what} needs a person's approval, and this call carries none, so nothing was done.`,
    );
  }
  const current = await read();
  if (!sameFacts(approved, current)) {
    throw new ESignError(
      "changed-since-approval",
      `What a person approved for ${what} is no longer what this call would do (a document, a signer or the message changed), so nothing was done. Ask again with the current details.`,
    );
  }
  return approved as T;
}
