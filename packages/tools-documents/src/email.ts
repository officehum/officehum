/**
 * Email (`.eml`) through `postal-mime`: the headers, the text body (an HTML-only body converted to
 * text), and the attachments. Attachments are handed to an `AttachmentSink`; the one this module
 * provides saves each to the file store as an outside file, idempotently.
 */

import { createHash } from "node:crypto";
import type { VersionedFileStore } from "@officehum/sdk";
import PostalMime, { type Address, type Email } from "postal-mime";
import { htmlToText } from "./html.js";
import { type DocumentReading, type ReadingAttachment, ReadingError } from "./reading.js";

/** Where a reader puts an email's attachments. Answers each attachment's file id. */
export interface AttachmentSink {
  save(attachment: {
    readonly index: number;
    readonly name: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<string>;
}

const POLICY_VERSION = "documents-reading:1";
const READER_IMAGE = "officehum-documents:postal-mime";
const READER_LIBRARIES = { "postal-mime": "4.2.0" } as const;

export interface StoreAttachmentsOptions {
  readonly store: Pick<VersionedFileStore, "create">;
  readonly taskId: string;
  /** Who the store records as having saved the attachment, e.g. `role:bookkeeper`. */
  readonly createdBy: string;
  /** The email the attachments came from: its hash keys the saves; its id, if any, is the lineage. */
  readonly email: { readonly fileId?: string; readonly sha256: string };
}

/**
 * Saves attachments as `source: "external"` files. Each save's operation ID is derived from the task,
 * the email's hash and the attachment's position, and everything else in it is fixed, so reading the
 * same email again in the same task (or replaying the call) returns the file already saved.
 */
export function storeAttachments(options: StoreAttachmentsOptions): AttachmentSink {
  return {
    async save({ index, name, mimeType, bytes }) {
      const key = createHash("sha256")
        .update(`${options.taskId}\0${options.email.sha256}\0${index}`, "utf8")
        .digest("hex");
      const receipt = await options.store.create({
        operationId: `documents-attachment~${key}`,
        bytes,
        name,
        mimeType,
        metadata: {
          createdBy: options.createdBy,
          source: "external",
          provenance: "external",
          ...(options.email.fileId === undefined ? {} : { derivedFrom: [options.email.fileId] }),
        },
        context: {
          taskId: options.taskId,
          policyVersion: POLICY_VERSION,
          worker: { image: READER_IMAGE, libraries: { ...READER_LIBRARIES } },
          argumentsSha256: createHash("sha256")
            .update(`${options.email.sha256}\0${index}`, "utf8")
            .digest("hex"),
        },
      });
      return receipt.output.id;
    },
  };
}

function address(entry: Address | undefined): string | null {
  if (entry === undefined) return null;
  if ("group" in entry && Array.isArray(entry.group)) {
    return entry.group.map((member) => address(member)).join(", ");
  }
  const { name, address: mail } = entry as { name: string; address?: string };
  if (name && mail) return `${name} <${mail}>`;
  return mail || name || null;
}

function addresses(entries: readonly Address[] | undefined): string | null {
  if (entries === undefined || entries.length === 0) return null;
  return entries.map((entry) => address(entry)).join(", ");
}

/** A name the file store accepts: no path separators, no control characters, at most 255 bytes. */
function safeName(name: string | null | undefined, index: number): string {
  const cleaned = (name ?? "")
    .replace(/[/\\]/gu, "_")
    .replace(/\p{Cc}/gu, "")
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === ".." || /^meta\.json$/iu.test(cleaned)) {
    return `attachment-${index + 1}`;
  }
  let result = cleaned;
  while (Buffer.byteLength(result, "utf8") > 255) result = result.slice(0, -1);
  return result;
}

function safeMime(mimeType: string | undefined): string {
  const value = (mimeType ?? "").trim().toLowerCase();
  return /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(value)
    ? value
    : "application/octet-stream";
}

export async function readEmail(
  bytes: Uint8Array,
  name: string,
  sink: AttachmentSink | undefined,
): Promise<DocumentReading> {
  let email: Email;
  try {
    email = await PostalMime.parse(bytes);
  } catch (error) {
    throw new ReadingError(
      "malformed",
      `${name} is not a readable email (${error instanceof Error ? error.name : "unknown error"}).`,
    );
  }

  const headers: [string, string | null][] = [
    ["From", address(email.from)],
    ["To", addresses(email.to)],
    ["Cc", addresses(email.cc)],
    ["Subject", email.subject ?? null],
    ["Date", email.date ?? null],
  ];
  const body = (email.text ?? "").trim() || htmlToText(email.html ?? "");

  const attachments: ReadingAttachment[] = [];
  for (const [index, attachment] of email.attachments.entries()) {
    const content =
      typeof attachment.content === "string"
        ? new TextEncoder().encode(attachment.content)
        : new Uint8Array(attachment.content);
    const fileName = safeName(attachment.filename, index);
    const mimeType = safeMime(attachment.mimeType);
    const fileId =
      sink === undefined
        ? null
        : await sink.save({ index, name: fileName, mimeType, bytes: content });
    attachments.push({ fileId, name: fileName, mimeType, size: content.byteLength });
  }

  const attachmentLines =
    attachments.length === 0
      ? "No attachments."
      : attachments
          .map(
            (entry) =>
              `- ${entry.name} (${entry.mimeType}, ${entry.size} bytes): ${entry.fileId ?? "not saved"}`,
          )
          .join("\n");

  return {
    kind: "eml",
    sections: [
      {
        number: 1,
        heading: "Headers",
        level: null,
        ref: "email:headers",
        text: headers
          .flatMap(([label, value]) => (value === null ? [] : [`${label}: ${value}`]))
          .join("\n"),
      },
      { number: 2, heading: "Body", level: null, ref: "email:body", text: body || "(empty)" },
      {
        number: 3,
        heading: "Attachments",
        level: null,
        ref: "email:attachments",
        text: attachmentLines,
      },
    ],
    tables: [],
    attachments,
    metadata: {
      ...Object.fromEntries(headers.map(([label, value]) => [label.toLowerCase(), value])),
      messageId: email.messageId ?? null,
      attachments: attachments.length,
    },
    hasTextLayer: true,
  };
}
