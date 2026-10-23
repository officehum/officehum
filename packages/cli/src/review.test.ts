/**
 * The `review` command: the person's surface over the version-bound publication gate.
 *
 * It shows the exact artifact identity and the format-native evidence, records the decision bound to
 * those hashes, and only then publishes. Every refusal is checked against the published pointer read
 * back from the file store, not just against the exit code.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localVersionedFileStore, type VersionedFileRef } from "@officehum/sdk";
import {
  publicationGate,
  REVIEW_EVIDENCE_SCHEMA,
  REVIEW_EVIDENCE_VERSION,
  type ReviewEvidence,
  type ReviewIdentity,
  reviewLedger,
} from "@officehum/tools-paper-office";
import { afterEach, describe, expect, it } from "vitest";
import { type CliIo, runCli } from "./cli.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CONTEXT = {
  taskId: "task:review",
  policyVersion: "policy:1",
  worker: { image: "paper-worker:python-3.13.17", libraries: {} },
  argumentsSha256: "a".repeat(64),
};

function io(): { io: CliIo; output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      output: (line) => output.push(line),
      error: (line) => errors.push(line),
      readApproval: async () => undefined,
    },
    output,
    errors,
  };
}

function docxBytes(marker: string): Uint8Array {
  return Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(marker)]);
}

function artifact(ref: VersionedFileRef): ReviewIdentity["source"] {
  return {
    fileId: ref.id,
    versionId: ref.versionId,
    name: ref.name,
    format: "docx",
    sha256: ref.sha256,
    size: ref.size,
  };
}

/** A minimal but honest evidence object for one docx source/proposal pair. */
function evidenceOf(source: VersionedFileRef, proposed: VersionedFileRef): ReviewEvidence {
  return {
    schema: REVIEW_EVIDENCE_SCHEMA,
    version: REVIEW_EVIDENCE_VERSION,
    format: "docx",
    identical: false,
    sources: {
      from: { versionId: source.versionId, sha256: source.sha256 },
      to: { versionId: proposed.versionId, sha256: proposed.sha256 },
    },
    changeSet: {
      added: [],
      removed: [],
      changed: [
        {
          part: "word/document.xml",
          kind: "text",
          beforeSha256: source.sha256,
          afterSha256: proposed.sha256,
        },
      ],
      byteIdenticalCount: 3,
      semanticallyEmpty: false,
    },
    diff: { kind: "word-text-diff", changedLineCount: 1 },
    preview: { kind: "word-redline", insertedBlocks: 1, deletedBlocks: 0 },
    validation: {
      deterministic: true,
      checks: [{ name: "change-set-matches-identical", ok: true, detail: "the versions differ" }],
      numeric: [],
      rubric: null,
    },
    limitations: ["no-rendering: this workspace never renders Word pagination or layout"],
  };
}

interface Seeded {
  readonly dir: string;
  readonly reviewId: string;
  readonly fileId: string;
  readonly source: VersionedFileRef;
  readonly proposed: VersionedFileRef;
  readonly published: () => Promise<string | null>;
}

/** Seeds a state directory with a published file and one pending review, as the host would. */
async function seeded(): Promise<Seeded> {
  const dir = mkdtempSync(join(tmpdir(), "officehum-cli-review-"));
  temps.push(dir);
  const store = localVersionedFileStore(join(dir, "files"));
  const created = await store.create({
    operationId: "create:1",
    bytes: docxBytes("v1"),
    name: "brief.docx",
    mimeType: DOCX_MIME,
    metadata: { createdBy: "role:test", source: "generated" },
    context: CONTEXT,
  });
  await store.publish({
    operationId: "seed:publish",
    fileId: created.output.id,
    expectedPublishedVersionId: null,
    versionId: created.output.versionId,
    approvalId: "seed",
  });
  const edited = await store.putVersion({
    operationId: "edit:1",
    fileId: created.output.id,
    sourceVersionId: created.output.versionId,
    bytes: docxBytes("v2-edited"),
    name: "brief.docx",
    mimeType: DOCX_MIME,
    metadata: { createdBy: "role:test", source: "derived" },
    context: CONTEXT,
  });
  const identity: ReviewIdentity = {
    fileId: created.output.id,
    name: "brief.docx",
    format: "docx",
    source: artifact(created.output),
    proposed: artifact(edited.output),
  };
  const gate = publicationGate({ store, ledger: reviewLedger(join(dir, "reviews")) });
  const opened = await gate.open({
    identity,
    evidence: evidenceOf(created.output, edited.output),
  });
  if (!opened.ok) throw new Error(`could not open a review: ${opened.message}`);
  return {
    dir,
    reviewId: opened.value.reviewId,
    fileId: created.output.id,
    source: created.output,
    proposed: edited.output,
    published: async () => (await store.getPublished(created.output.id))?.versionId ?? null,
  };
}

describe("the review command", () => {
  it("lists and shows the exact artifact identity and the stated limits", async () => {
    const s = await seeded();
    const listed = io();
    expect(await runCli(["review", "list", "--state", s.dir], listed.io)).toBe(0);
    expect(listed.output.join("\n")).toContain(s.reviewId);
    expect(listed.output.join("\n")).toContain("pending");

    const shown = io();
    expect(
      await runCli(["review", "show", "--state", s.dir, "--review", s.reviewId], shown.io),
    ).toBe(0);
    const report = shown.output.join("\n");
    expect(report).toContain(`File: brief.docx (${s.fileId}) [docx]`);
    expect(report).toContain(
      `Source version (immutable): ${s.source.versionId} sha256 ${s.source.sha256}`,
    );
    expect(report).toContain(
      `Proposed version (immutable): ${s.proposed.versionId} sha256 ${s.proposed.sha256}`,
    );
    expect(report).toContain("Deterministic checks: 1/1 hold [deterministic: yes]");
    expect(report).toContain("no-rendering");
    expect(report).toContain("Decision: none yet");
  });

  it("refuses to publish before a decision, and the pointer does not move", async () => {
    const s = await seeded();
    const refused = io();
    const code = await runCli(
      [
        "review",
        "publish",
        "--state",
        s.dir,
        "--review",
        s.reviewId,
        "--operation-id",
        "publish:1",
      ],
      refused.io,
    );
    expect(code).toBe(1);
    expect(refused.errors.join("\n")).toContain("not-approved");
    // Read the pointer back: a refusal is a no-op on the store.
    expect(await s.published()).toBe(s.source.versionId);
  });

  it("publishes only after a person approves, and a denial never publishes", async () => {
    const s = await seeded();

    const denied = io();
    expect(
      await runCli(
        [
          "review",
          "decide",
          "--state",
          s.dir,
          "--review",
          s.reviewId,
          "--verdict",
          "deny",
          "--by",
          "azmat",
        ],
        denied.io,
      ),
    ).toBe(0);
    expect(denied.output.join("\n")).toContain("Denied");

    const afterDenial = io();
    expect(
      await runCli(
        [
          "review",
          "publish",
          "--state",
          s.dir,
          "--review",
          s.reviewId,
          "--operation-id",
          "publish:1",
        ],
        afterDenial.io,
      ),
    ).toBe(1);
    expect(afterDenial.errors.join("\n")).toContain("denied");
    expect(await s.published()).toBe(s.source.versionId);

    // A second state directory, approved this time.
    const ok = await seeded();
    const approved = io();
    expect(
      await runCli(
        [
          "review",
          "decide",
          "--state",
          ok.dir,
          "--review",
          ok.reviewId,
          "--verdict",
          "approve",
          "--by",
          "azmat",
          "--approval",
          "approval:3285",
        ],
        approved.io,
      ),
    ).toBe(0);
    expect(approved.output.join("\n")).toContain("Approved");

    const published = io();
    expect(
      await runCli(
        [
          "review",
          "publish",
          "--state",
          ok.dir,
          "--review",
          ok.reviewId,
          "--operation-id",
          "publish:1",
        ],
        published.io,
      ),
    ).toBe(0);
    expect(published.output.join("\n")).toContain(`-> ${ok.proposed.versionId}`);
    expect(await ok.published()).toBe(ok.proposed.versionId);
  });

  it("rejects an unknown subcommand and a command missing its ids", async () => {
    const s = await seeded();
    const unknown = io();
    expect(await runCli(["review", "nonsense", "--state", s.dir], unknown.io)).toBe(2);
    const missing = io();
    expect(await runCli(["review", "show", "--state", s.dir], missing.io)).toBe(2);
    const noVerdict = io();
    expect(
      await runCli(
        ["review", "decide", "--state", s.dir, "--review", s.reviewId, "--by", "azmat"],
        noVerdict.io,
      ),
    ).toBe(2);
  });
});
