/**
 * The signed copy of a completed request, saved into the office's versioned file store.
 *
 * The signed PDF and the certificate are outside files (`source: "external"`) with the provider's id
 * in `externalId`, and the request's documents as their lineage. Their operation ids derive from the
 * provider id alone, so `esign_download` and a host that saves the copy when the completion event
 * arrives save one copy between them, whoever is first, and a repeat downloads nothing.
 */

import { createHash } from "node:crypto";
import {
  type CreateVersionInput,
  type FileMetadata,
  FileStoreError,
  type VersionedFileRef,
  type VersionedFileStore,
} from "@officehum/sdk";
import { type ESignature, ESignError, isPdf } from "./esign.js";
import { type ESignRecord, signedBaseName } from "./records.js";

/** Bound into each saved file's operation context. */
export const ESIGN_POLICY_VERSION = "officehum.esign.v1";
const PACK_IMAGE = "officehum/tools-esign";

export interface SignedCopy {
  readonly signed: VersionedFileRef;
  readonly certificate?: VersionedFileRef;
}

export interface SaveSignedOptions {
  readonly esign: ESignature;
  readonly store: VersionedFileStore;
  readonly record: Pick<ESignRecord, "documents" | "template"> & { readonly providerId: string };
  /** Who the store records as having saved it, e.g. `role:office-manager` or `office:esign`. */
  readonly createdBy: string;
}

function operationIds(providerId: string) {
  const key = createHash("sha256").update(providerId, "utf8").digest("hex");
  return { key, signed: `esign-signed~${key}`, certificate: `esign-certificate~${key}` };
}

async function saved(
  store: VersionedFileStore,
  ids: ReturnType<typeof operationIds>,
): Promise<SignedCopy | undefined> {
  const signed = await store.lookupOperation(ids.signed);
  if (signed === undefined || signed.kind === "publish") return undefined;
  const certificate = await store.lookupOperation(ids.certificate);
  return {
    signed: signed.output,
    ...(certificate === undefined || certificate.kind === "publish"
      ? {}
      : { certificate: certificate.output }),
  };
}

/** Saves the signed copy once, or returns the copy already saved. The request must be completed. */
export async function saveSigned(options: SaveSignedOptions): Promise<SignedCopy> {
  const { store, record } = options;
  const ids = operationIds(record.providerId);
  const already = await saved(store, ids);
  if (already !== undefined) return already;

  const completed = await options.esign.downloadCompleted(record.providerId);
  if (!isPdf(completed?.signed)) {
    throw new ESignError("provider-output", "The e-signature provider's signed copy is not a PDF.");
  }
  if (completed.certificate !== undefined && !isPdf(completed.certificate)) {
    throw new ESignError("provider-output", "The e-signature provider's certificate is not a PDF.");
  }
  const lineage = record.documents.map((document) => document.fileId);
  const metadata: FileMetadata = {
    createdBy: options.createdBy,
    source: "external",
    provenance: "external",
    ...(lineage.length === 0 ? {} : { derivedFrom: lineage }),
    externalId: { system: "esign", id: record.providerId },
  };
  const context = {
    taskId: `esign:${ids.key.slice(0, 32)}`,
    policyVersion: ESIGN_POLICY_VERSION,
    worker: { image: PACK_IMAGE, libraries: {} },
    argumentsSha256: ids.key,
  };
  const base = signedBaseName(record);
  const inputs: CreateVersionInput[] = [
    {
      operationId: ids.signed,
      bytes: completed.signed,
      name: `${base}-signed.pdf`,
      mimeType: "application/pdf",
      metadata,
      context,
    },
  ];
  if (completed.certificate !== undefined) {
    inputs.push({
      operationId: ids.certificate,
      bytes: completed.certificate,
      name: `${base}-certificate.pdf`,
      mimeType: "application/pdf",
      metadata,
      context,
    });
  }
  try {
    const [signed, certificate] = await store.commitVersions(inputs);
    if (signed === undefined) throw new Error("The file store committed no signed copy.");
    return {
      signed: signed.output,
      ...(certificate === undefined ? {} : { certificate: certificate.output }),
    };
  } catch (error) {
    // Another saver (the tool or the host) committed the same request's copy first.
    if (error instanceof FileStoreError && error.code === "OPERATION_COLLISION") {
      const winner = await saved(store, ids);
      if (winner !== undefined) return winner;
    }
    throw error;
  }
}
