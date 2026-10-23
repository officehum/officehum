/**
 * The Word fixtures, against a real interpreter: a document is inspected, read in pages, drafted,
 * edited into an unpublished proposal, and refused when it is malformed or links out of the package.
 *
 * The two configurations the issue names are both exercised here. The refusal tests do not need an
 * interpreter — the pack inspects the package structure in process, so a macro, an external relationship
 * or an archive that is not a package is refused on any host — and they run in both configurations. The
 * rest need the pinned `paper-docx` and **skip visibly** when `OFFICEHUM_PAPER_PYTHON` is unset, because
 * the worker takes its interpreter from a configured path and there is no safe guess.
 *
 * The preservation claim is argued with bytes, not by eye: `word/styles.xml` in the awkward fixture is
 * deliberately byte-different from what a re-serialization would emit, so the proposal's styles.xml
 * matching it exactly is evidence that the part came back verbatim rather than being rewritten.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localVersionedFileStore,
  type VersionedFileRef,
  type VersionedFileStore,
} from "@officehum/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocumentRunOutcome, DocumentService } from "./document-service.js";
import { DEFAULT_LIMITS, type DocumentLease, type LeasedInput } from "./lease.js";
import { localDocumentService } from "./local-document-service.js";
import { subprocessPaperWorker } from "./paper-worker.js";
import { paperOfficeToolPack, RUN_DOCUMENT_PYTHON } from "./run-document-python.js";
import type { DocumentRunReceipt } from "./run-ledger.js";
import { runLedger } from "./run-ledger.js";
import {
  buildZip,
  configuredInterpreter,
  docxLike,
  sha256,
  textOf,
  utf8,
  wordFixtureCode,
  zipEntries,
} from "./test-helpers.js";
import {
  COMPARE_DOCUMENT,
  CREATE_DOCUMENT,
  EDIT_DOCUMENT,
  INSPECT_DOCUMENT,
  PREVIEW_DOCUMENT,
  READ_DOCUMENT,
  type WordEdit,
  type WordInspection,
  type WordReading,
} from "./word-operations.js";

const interpreter = configuredInterpreter();
const suite = interpreter === undefined ? describe.skip : describe;

if (interpreter === undefined) {
  console.warn(
    "paper Word fixtures skipped: set OFFICEHUM_PAPER_PYTHON to a provisioned Python 3.13 " +
      "(see packages/tools-paper-office/scripts/provision-worker.sh). The refusal fixtures still run.",
  );
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The parts an edit of the main body has no business touching. */
const UNTOUCHED_PARTS = [
  "word/styles.xml",
  "word/stylesWithEffects.xml",
  "word/settings.xml",
  "word/webSettings.xml",
  "word/fontTable.xml",
  "word/numbering.xml",
  "word/theme/theme1.xml",
  "word/header1.xml",
  "word/footer1.xml",
  "docProps/app.xml",
  "docProps/core.xml",
  "customXml/item1.xml",
  "_rels/.rels",
];

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paper-word-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Harness {
  readonly store: VersionedFileStore;
  readonly service: DocumentService;
  readonly runs: { count: number };
}

function harness(ledgerDir = join(root, "ledger")): Harness {
  const store = localVersionedFileStore(join(root, "files"));
  const runs = { count: 0 };
  const worker = subprocessPaperWorker({ interpreter: interpreter ?? "", graceSeconds: 20 });
  return {
    store,
    runs,
    service: localDocumentService({
      store,
      worker: {
        async run(request) {
          runs.count += 1;
          return worker.run(request);
        },
      },
      ledger: runLedger(ledgerDir),
      createdBy: "role:test",
      now: () => new Date("2026-10-23T00:00:00.000Z"),
    }),
  };
}

/** A service that keeps every receipt it committed, so a bare harness can be driven from the record. */
function recordingService(inner: DocumentService): DocumentService & {
  readonly receipts: DocumentRunReceipt[];
} {
  const receipts: DocumentRunReceipt[] = [];
  return {
    receipts,
    async runDocumentPython(request) {
      const outcome = await inner.runDocumentPython(request);
      if (outcome.kind === "committed") receipts.push(outcome.receipt);
      return outcome;
    },
  };
}

function committed(outcome: DocumentRunOutcome): DocumentRunReceipt {
  if (outcome.kind !== "committed") {
    throw new Error(`expected a commit, got ${outcome.code}: ${outcome.message}`);
  }
  return outcome.receipt;
}

/** A real Word fixture, built through the worker, as the version a task would be leased. */
async function fixture(
  store: VersionedFileStore,
  service: DocumentService,
  options: { awkward?: boolean; protected?: boolean; name?: string; operationId: string },
): Promise<VersionedFileRef> {
  const receipt = committed(
    await service.runDocumentPython({
      operationId: options.operationId,
      taskId: "task:word",
      lease: {
        leaseId: "lease:fixture",
        taskId: "task:word",
        inputs: [],
        outputFormats: ["docx"],
        limits: DEFAULT_LIMITS,
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
      code: wordFixtureCode(options),
      arguments: {},
    }),
  );
  const output = receipt.outputs[0];
  if (output === undefined) throw new Error("the fixture produced no document");
  const stored = await store.getVersion(output.fileId, output.versionId);
  if (stored === undefined) throw new Error("the fixture version is missing");
  return stored.ref;
}

function leaseOf(refs: readonly VersionedFileRef[], writable = true): DocumentLease {
  const inputs: LeasedInput[] = refs.map((ref) => ({
    fileId: ref.id,
    versionId: ref.versionId,
    name: ref.name,
    format: "docx",
    sha256: ref.sha256,
    size: ref.size,
    writable,
  }));
  return {
    leaseId: "lease:word",
    taskId: "task:word",
    inputs,
    outputFormats: ["docx"],
    limits: DEFAULT_LIMITS,
    expiresAt: "2999-01-01T00:00:00.000Z",
  };
}

function refOf(ref: VersionedFileRef) {
  return {
    fileId: ref.id,
    versionId: ref.versionId,
    name: ref.name,
    sha256: ref.sha256,
    size: ref.size,
  };
}

interface Tool {
  execute(
    args: unknown,
    api: { taskId: string; conversationId: string; callId: string },
  ): Promise<{ output: { text: string }[]; isError?: boolean; details?: Record<string, unknown> }>;
}

function toolOf(service: DocumentService, name: string, lease: DocumentLease | undefined): Tool {
  const pack = paperOfficeToolPack({ service, leaseFor: async () => lease });
  return pack.tools.find((tool) => tool.name === name) as unknown as Tool;
}

const API = { taskId: "task:word", conversationId: "conv", callId: "call-1" };

/**
 * Every call gets its own Pi Durable call identity, as a harness would: reusing one operation ID with
 * different arguments is exactly what the durable record refuses, and a test that did it by accident
 * would be testing the collision check rather than the operation.
 */
let callCounter = 0;

function nextApi() {
  callCounter += 1;
  return { ...API, callId: `call-${callCounter}` };
}

async function body<T>(
  tool: Tool,
  args: unknown,
  api = nextApi(),
): Promise<{
  ok: boolean;
  operationId: string;
  result: T;
  wrote: { fileId: string; versionId: string }[];
}> {
  const answer = await tool.execute(args, api);
  if (answer.isError === true) {
    throw new Error(`the tool refused: ${answer.output[0]?.text ?? "no message"}`);
  }
  return JSON.parse(answer.output[0]?.text ?? "{}") as never;
}

async function refuse(tool: Tool, args: unknown, api = nextApi()) {
  const answer = await tool.execute(args, api);
  if (answer.isError !== true) throw new Error("expected a refusal");
  return JSON.parse(answer.output[0]?.text ?? "{}") as {
    ok: boolean;
    code: string;
    message: string;
    operationId: string;
  };
}

/** Rebuilds a real package with one part edited, for the fixtures the worker itself would refuse. */
function rebuilt(
  bytes: Uint8Array,
  edit: (name: string, data: Uint8Array) => Uint8Array,
): Uint8Array {
  return buildZip([...zipEntries(bytes)].map(([name, data]) => ({ name, data: edit(name, data) })));
}

/** A real Word document that links outside the package: a genuine external relationship in a real file. */
function withExternalLink(bytes: Uint8Array, target: string): Uint8Array {
  return rebuilt(bytes, (name, data) => {
    if (name !== "word/_rels/document.xml.rels") return data;
    const relationship =
      '<Relationship Id="rIdPaperExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"' +
      ` Target="${target}" TargetMode="External"/>`;
    return utf8(textOf(data).replace("</Relationships>", `${relationship}</Relationships>`));
  });
}

suite("the Word adapter reads a leased document in bounded pages", () => {
  // This one walks five sections a page at a time, so it drives far more interpreter runs than its
  // siblings; under a loaded suite (three format adapters' fixtures spawn real subprocesses in
  // parallel) five seconds is not enough, so it gets the same explicit budget the PowerPoint fixtures
  // give their slow tests.
  it("pages paragraphs, headings, tables, comments and tracked changes to the end", async () => {
    const { store, service } = harness();
    const source = await fixture(store, service, { operationId: "conv:read-fixture" });
    const lease = leaseOf([source]);

    for (const section of ["blocks", "paragraphs", "headings", "tables", "comments", "revisions"]) {
      const collected: { index: number; story: string }[] = [];
      let cursor: number | null = 0;
      let total = -1;
      let pages = 0;
      while (cursor !== null) {
        const request: Record<string, unknown> = {
          ref: refOf(source),
          section,
          cursor,
          pageSize: 4,
        };
        const answer: { result: WordReading } = await body<WordReading>(
          toolOf(service, READ_DOCUMENT, lease),
          request,
          { ...API, callId: `call-${section}-${pages}` },
        );
        const page = answer.result.page;
        expect(page.section).toBe(section);
        expect(page.pageSize).toBe(4);
        expect(page.returned).toBeLessThanOrEqual(4);
        expect(page.items).toHaveLength(page.returned);
        if (total < 0) total = page.total;
        else expect(page.total).toBe(total);
        expect(page.cursor).toBe(cursor);
        for (const item of page.items) {
          if ("anchor" in item) collected.push({ index: item.index, story: item.story });
        }
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(20);
      }
      // Every item arrived exactly once, and the pages partition the section.
      if (["blocks", "paragraphs", "headings", "tables"].includes(section)) {
        expect(collected.length).toBe(total);
      } else {
        expect(collected.length).toBeLessThanOrEqual(total);
      }
      expect([...new Set(collected.map((item) => `${item.story}:${item.index}`))]).toHaveLength(
        collected.length,
      );
    }

    const reading = await body<WordReading>(toolOf(service, READ_DOCUMENT, lease), {
      ref: refOf(source),
      section: "headings",
    });
    const headings = reading.result.page.items as unknown as {
      text: string;
      headingLevel: number;
      inInsert: boolean;
    }[];
    expect(headings.map((item) => [item.text, item.headingLevel])).toEqual([
      ["Quarterly Close", 1],
      ["Notes", 2],
      ["Revenue", 2],
    ]);
    // The tracked heading is reported as inside a revision rather than as clean text.
    expect(headings.find((item) => item.text === "Notes")?.inInsert).toBe(true);

    const tables = await body<WordReading>(toolOf(service, READ_DOCUMENT, lease), {
      ref: refOf(source),
      section: "tables",
      includeCells: true,
    });
    const table = tables.result.page.items[0] as unknown as {
      shape: { rows: number; columns: number };
      cells: string[][];
    };
    expect(table.shape).toMatchObject({ rows: 2, columns: 2 });
    expect(table.cells).toEqual([
      ["Account", "Amount"],
      ["Revenue", "1250"],
    ]);

    const comments = await body<WordReading>(toolOf(service, READ_DOCUMENT, lease), {
      ref: refOf(source),
      section: "comments",
    });
    expect(comments.result.page.items).toEqual([
      expect.objectContaining({
        commentId: 0,
        author: "Reviewer",
        text: "Please confirm this figure.",
        resolved: false,
        anchoredText: "Revenue was 1250 dollars.",
      }),
    ]);

    const revisions = await body<WordReading>(toolOf(service, READ_DOCUMENT, lease), {
      ref: refOf(source),
      section: "revisions",
    });
    const changes = revisions.result.page.items as unknown as {
      revisionType: string;
      author: string;
      isParagraphMark: boolean;
    }[];
    expect(changes).toHaveLength(4);
    expect(changes.every((item) => item.revisionType === "insertion")).toBe(true);
    expect(changes.every((item) => item.author === "Reviewer")).toBe(true);
    expect(changes.some((item) => item.isParagraphMark)).toBe(true);
    expect(revisions.result.page.hasMore).toBe(false);
  }, 30_000);

  it("inspects counts, protection and the heading outline without writing anything", async () => {
    const { store, service } = harness();
    const source = await fixture(store, service, { operationId: "conv:inspect-fixture" });
    const answer = await body<WordInspection>(
      toolOf(service, INSPECT_DOCUMENT, leaseOf([source])),
      {
        ref: refOf(source),
      },
    );
    expect(answer.result.document).toMatchObject({
      storyParts: 4,
      headings: 3,
      tables: 1,
      comments: 1,
      unresolvedComments: 1,
      revisions: 4,
      editsBlocked: false,
    });
    expect(answer.result.document.revisionTypes).toEqual({ insertion: 4 });
    expect(answer.result.document.protection).toMatchObject({ edit: null, enforced: false });
    expect(answer.result.headingOutline.map((item) => item.text)).toEqual([
      "Quarterly Close",
      "Notes",
      "Revenue",
    ]);
    expect(answer.wrote).toEqual([]);
  });

  it("previews structure-marked text with a page bound, and shows the pending redline", async () => {
    const { store, service } = harness();
    const source = await fixture(store, service, { operationId: "conv:preview-fixture" });
    const answer = await body<{
      page: { total: number; items: { label: string }[] };
      redline: { insertedBlocks: number };
      pending: { changedLineCount: number };
    }>(toolOf(service, PREVIEW_DOCUMENT, leaseOf([source])), { ref: refOf(source), pageSize: 3 });
    expect(answer.result.page.total).toBe(10);
    expect(answer.result.page.items.map((item) => item.label).slice(0, 3)).toEqual([
      "H1: Quarterly Close",
      "P: Draft prepared by the office.",
      "H2: Notes",
    ]);
    // The tracked section is two inserted paragraphs: a block-level redline, not an element census.
    expect(answer.result.redline.insertedBlocks).toBe(2);
    expect(answer.result.pending.changedLineCount).toBeGreaterThan(0);
    expect(answer.wrote).toEqual([]);
  });
});

suite("the Word adapter drafts and proposes", () => {
  it("creates a new draft, which is a new file and not a publication", async () => {
    const { store, service } = harness();
    await fixture(store, service, { operationId: "conv:draft-fixture" });
    const answer = await body<{
      draft: { status: string; editOf: string | null; published: boolean; sha256: string };
      reopened: { paragraphs: number; tables: number };
    }>(toolOf(service, CREATE_DOCUMENT, leaseOf([])), {
      output: "close-summary.docx",
      blocks: [
        { kind: "heading", text: "Quarterly close", level: 1 },
        { kind: "paragraph", text: "Prepared by the office." },
        { kind: "list", items: ["Reconciled the bank", "Filed the receipts"] },
        {
          kind: "table",
          rows: [
            ["Account", "Amount"],
            ["Revenue", "1250"],
          ],
        },
      ],
    });
    expect(answer.result.draft).toMatchObject({ status: "draft", editOf: null, published: false });
    expect(answer.result.reopened).toMatchObject({ paragraphs: 4, tables: 1 });
    expect(answer.wrote).toHaveLength(1);

    const wrote = answer.wrote[0];
    const head = await store.getHead(wrote?.fileId ?? "");
    expect(head?.versionId).toBe(wrote?.versionId);
    expect(head?.sourceVersionId).toBeNull();
    expect(head?.sha256).toBe(answer.result.draft.sha256);
    // A draft is generated, not derived from a document: nothing was edited.
    expect(head?.metadata.source).toBe("generated");
    const stored = await store.getVersion(wrote?.fileId ?? "", wrote?.versionId ?? "");
    expect(stored?.bytes.byteLength).toBeGreaterThan(0);
    expect(zipEntries(stored?.bytes ?? new Uint8Array()).has("[Content_Types].xml")).toBe(true);
  });

  it("edits an existing document into an immutable proposal, and never edits it in place", async () => {
    const { store, service } = harness();
    const source = await fixture(store, service, { operationId: "conv:edit-fixture" });
    const lease = leaseOf([source]);
    const answer = await body<WordEdit>(toolOf(service, EDIT_DOCUMENT, lease), {
      ref: refOf(source),
      output: "close-summary.docx",
      author: "Office Hum",
      date: "2026-10-23T00:00:00Z",
      steps: [
        {
          kind: "insertSection",
          anchor: { text: "Quarterly Close" },
          heading: "Variance",
          paragraphs: ["Revenue grew 12%."],
          author: "Office Hum",
        },
        {
          kind: "replaceParagraphs",
          anchor: { text: "Revenue was 1250 dollars." },
          paragraphs: ["Revenue was 1400 dollars."],
        },
        { kind: "updateCell", nearText: "Revenue", row: 1, column: 1, text: "1400", tracked: true },
        {
          kind: "addComment",
          anchor: { text: "Draft prepared by the office." },
          text: "Please confirm the variance.",
          author: "Reviewer",
        },
      ],
    });

    const result = answer.result;
    expect(result.proposal).toMatchObject({
      status: "proposed",
      editOf: source.versionId,
      published: false,
    });
    expect(result.changes.map((change) => change.kind)).toEqual([
      "insertSection",
      "replaceParagraphs",
      "updateCell",
      "addComment",
    ]);
    expect(result.changes.every((change) => Object.keys(change.evidence).length > 0)).toBe(true);
    // A redline and a diff a reviewer can read, tied to the two versions' hashes.
    expect(result.redline.insertedBlocks).toBeGreaterThan(0);
    expect(result.redline.deletedBlocks).toBeGreaterThan(0);
    expect(result.diff.changedLineCount).toBeGreaterThan(0);
    expect(result.diff.stories.some((story) => story.diffLines.length > 0)).toBe(true);
    expect(result.changeSet.changed.some((part) => part.part === "word/document.xml")).toBe(true);
    expect(result.reopened.paragraphs).toBeGreaterThan(0);

    // The proposal is a new immutable version of the same file: the source version is untouched.
    const wrote = answer.wrote[0];
    expect(wrote?.fileId).toBe(source.id);
    expect(wrote?.versionId).not.toBe(source.versionId);
    const head = await store.getHead(source.id);
    expect(head?.versionId).toBe(wrote?.versionId);
    expect(head?.sourceVersionId).toBe(source.versionId);
    expect(head?.metadata.source).toBe("derived");
    const original = await store.getVersion(source.id, source.versionId);
    expect(original?.ref.sha256).toBe(source.sha256);
    expect(sha256(original?.bytes ?? new Uint8Array())).toBe(source.sha256);
    // Nothing published it.
    expect(await store.getPublished(source.id)).toBeUndefined();
  });

  it("preserves relationships, styles, headers, footers and untouched sections byte for byte", async () => {
    const { store, service } = harness();
    const source = await fixture(store, service, {
      operationId: "conv:preserve-fixture",
      awkward: true,
    });
    const lease = leaseOf([source]);
    const answer = await body<WordEdit>(toolOf(service, EDIT_DOCUMENT, lease), {
      ref: refOf(source),
      output: "proposal.docx",
      author: "Office Hum",
      date: "2026-10-23T00:00:00Z",
      steps: [
        {
          kind: "insertSection",
          anchor: { text: "Quarterly Close" },
          heading: "Variance",
          paragraphs: ["Revenue grew 12%."],
        },
      ],
    });

    const before = zipEntries(
      (await store.getVersion(source.id, source.versionId))?.bytes ?? new Uint8Array(),
    );
    const wrote = answer.wrote[0];
    const afterBytes = (await store.getVersion(wrote?.fileId ?? "", wrote?.versionId ?? ""))?.bytes;
    if (afterBytes === undefined) throw new Error("the proposal version is missing");
    const after = zipEntries(afterBytes);

    // The fixture's styles.xml is byte-different from what a re-serialization would emit.
    const stylesBefore = before.get("word/styles.xml");
    if (stylesBefore === undefined) throw new Error("the fixture has no styles part");
    expect(textOf(stylesBefore)).not.toContain('standalone="yes"');

    const untouched = UNTOUCHED_PARTS.filter((part) => before.has(part));
    expect(untouched.length).toBe(UNTOUCHED_PARTS.length);
    const identical: string[] = [];
    for (const part of untouched) {
      const unchanged = after.get(part);
      expect(unchanged, `${part} is missing from the proposal`).toBeDefined();
      if (sha256(unchanged ?? new Uint8Array()) === sha256(before.get(part) ?? new Uint8Array())) {
        identical.push(part);
      }
    }
    // Argument by bytes: every one of them came back exactly as it arrived, styles.xml included, so the
    // part was restored verbatim rather than re-serialized with a different XML declaration.
    expect(identical).toEqual(untouched);
    expect(sha256(after.get("word/styles.xml") ?? new Uint8Array())).toBe(sha256(stylesBefore));

    // The change set agrees with that count, and names only the parts the edit really touched.
    const byteIdentical = [...before.keys()].filter((part) => {
      const other = after.get(part);
      return other !== undefined && sha256(other) === sha256(before.get(part) ?? new Uint8Array());
    });
    expect(answer.result.changeSet.byteIdenticalCount).toBe(byteIdentical.length);
    expect(answer.result.changeSet.changed.map((part) => part.part)).toContain("word/document.xml");
    expect(answer.result.changeSet.changed.map((part) => part.part)).not.toContain(
      "word/styles.xml",
    );
    expect(answer.result.preservation.changedParts).toContain("word/document.xml");
    expect(answer.result.preservation.changedParts).not.toContain("word/styles.xml");
    expect(byteIdentical.length).toBeGreaterThan(10);
  });

  it("applies the remaining step kinds, including the ones that are not tracked changes", async () => {
    const { store, service } = harness();
    const source = await fixture(store, service, { operationId: "conv:steps-fixture" });
    const answer = await body<WordEdit>(toolOf(service, EDIT_DOCUMENT, leaseOf([source])), {
      ref: refOf(source),
      output: "proposal.docx",
      author: "Office Hum",
      date: "2026-10-23T00:00:00Z",
      steps: [
        {
          kind: "insertRow",
          nearText: "Revenue",
          row: 0,
          values: ["Costs", "10"],
          copyFormatFrom: 0,
        },
        { kind: "deleteRow", nearText: "Revenue", row: 1 },
        {
          kind: "replyComment",
          commentId: 0,
          text: "Confirmed by the bookkeeper.",
          author: "Bookkeeper",
        },
        { kind: "resolveComment", commentId: 0, resolved: true },
        { kind: "deleteComment", commentId: 0 },
        { kind: "acceptRevisions", revisionAuthor: "Reviewer" },
        { kind: "rejectRevisions" },
      ],
    });

    expect(answer.result.changes.map((change) => change.kind)).toEqual([
      "insertRow",
      "deleteRow",
      "replyComment",
      "resolveComment",
      "deleteComment",
      "acceptRevisions",
      "rejectRevisions",
    ]);
    const evidence = answer.result.changes.map((change) => change.evidence);
    // The row steps say which row they touched, and admit they are not Word revisions.
    expect(evidence[0]).toMatchObject({ insertedValues: ["Costs", "10"] });
    expect(evidence[1]).toMatchObject({ deletedRow: 1 });
    // The thread work resolved one comment, deleted the thread, then accepted the four insertions.
    expect(evidence[1 + 2]).toMatchObject({ commentId: 0, resolved: true });
    expect(evidence[4]).toMatchObject({ deletedCommentId: 0 });
    expect(evidence[5]).toMatchObject({ resolved: 4, accepted: true, remainingUnsupported: {} });
    expect(evidence[6]).toMatchObject({ resolved: 0, accepted: false });
    // Accepting the insertions removed them from the redline of the proposal.
    expect(answer.result.redline.insertedBlocks).toBe(0);
    expect(answer.result.reopened.comments).toBe(0);
    expect(answer.result.reopened.revisions).toBe(0);
    expect(answer.result.changeSet.changed.some((part) => part.part === "word/comments.xml")).toBe(
      true,
    );
  });

  it("refuses a protected document unless the caller acknowledges it deliberately", async () => {
    const { store, service } = harness();
    const source = await fixture(store, service, {
      operationId: "conv:protected-fixture",
      protected: true,
    });
    const lease = leaseOf([source]);
    const steps = [
      {
        kind: "insertSection",
        anchor: { text: "Quarterly Close" },
        heading: "Variance",
        paragraphs: ["Revenue grew 12%."],
      },
    ];

    const refused = await refuse(toolOf(service, EDIT_DOCUMENT, lease), {
      ref: refOf(source),
      output: "proposal.docx",
      author: "Office Hum",
      steps,
    });
    expect(refused.code).toBe("document-protected");
    // The refusal wrote nothing: the source is the head, still the only version.
    const refusedHead = await store.getHead(source.id);
    expect(refusedHead?.versionId).toBe(source.versionId);

    const answer = await body<WordEdit>(toolOf(service, EDIT_DOCUMENT, lease), {
      ref: refOf(source),
      output: "proposal.docx",
      author: "Office Hum",
      acknowledgeProtection: true,
      steps,
    });
    expect(answer.result.protection.acknowledged).toBe(true);
    expect(answer.result.proposal.published).toBe(false);

    // Acknowledging protection is in-memory only: the proposal still declares it.
    const wrote = answer.wrote[0];
    const proposal = (await store.getVersion(wrote?.fileId ?? "", wrote?.versionId ?? ""))?.bytes;
    if (proposal === undefined) throw new Error("the proposal version is missing");
    const settings = zipEntries(proposal).get("word/settings.xml");
    expect(textOf(settings ?? new Uint8Array())).toContain("documentProtection");
  });

  it("replays the same operation, returning the same receipt without a second version", async () => {
    const { store, service, runs } = harness();
    const source = await fixture(store, service, { operationId: "conv:replay-fixture" });
    const lease = leaseOf([source]);
    const args = {
      ref: refOf(source),
      output: "proposal.docx",
      author: "Office Hum",
      steps: [
        {
          kind: "replaceText",
          needle: "Draft prepared by the office.",
          text: "Prepared by the office.",
        },
      ],
    };
    const before = runs.count;
    const first = await toolOf(service, EDIT_DOCUMENT, lease).execute(args, API);
    const second = await toolOf(service, EDIT_DOCUMENT, lease).execute(args, API);
    expect(second.output[0]?.text).toBe(first.output[0]?.text);
    // The replay resolved to the committed receipt: the interpreter ran once, and one version exists.
    expect(runs.count).toBe(before + 1);
    const parsed = JSON.parse(first.output[0]?.text ?? "{}") as {
      operationId: string;
      wrote: { fileId: string; versionId: string }[];
    };
    expect(parsed.wrote).toHaveLength(1);
    const head = await store.getHead(source.id);
    expect(head?.versionId).toBe(parsed.wrote[0]?.versionId);
    const versions = await store.getVersion(source.id, parsed.wrote[0]?.versionId ?? "");
    expect(versions?.ref.sourceVersionId).toBe(source.versionId);
  });
});

suite("the Word adapter compares two leased versions and refuses what it must", () => {
  it("compares a proposal against the version it came from", async () => {
    const { store, service } = harness();
    const source = await fixture(store, service, { operationId: "conv:compare-fixture" });
    const proposed = await body<WordEdit>(toolOf(service, EDIT_DOCUMENT, leaseOf([source])), {
      ref: refOf(source),
      output: "proposal.docx",
      author: "Office Hum",
      steps: [
        {
          kind: "insertSection",
          anchor: { text: "Quarterly Close" },
          heading: "Variance",
          paragraphs: ["Revenue grew 12%."],
        },
      ],
    });
    const wrote = proposed.wrote[0];
    const proposal = await store.getVersion(wrote?.fileId ?? "", wrote?.versionId ?? "");
    if (proposal === undefined) throw new Error("the proposal version is missing");

    const answer = await body<{
      identical: boolean;
      changeSet: { changed: { part: string }[]; byteIdenticalCount: number };
      diff: { changedLineCount: number };
      redline: { insertedBlocks: number; total: number };
    }>(toolOf(service, COMPARE_DOCUMENT, leaseOf([source, proposal.ref], false)), {
      from: refOf(source),
      to: refOf(proposal.ref),
    });
    expect(answer.result.identical).toBe(false);
    expect(answer.result.diff.changedLineCount).toBeGreaterThan(0);
    expect(answer.result.redline.total).toBeGreaterThan(0);
    expect(answer.result.changeSet.byteIdenticalCount).toBeGreaterThan(10);
  });

  it("refuses a document that links outside the package, leaving the source byte-identical", async () => {
    const { store, service } = harness();
    const clean = await fixture(store, service, { operationId: "conv:linked-fixture" });
    const cleanBytes = (await store.getVersion(clean.id, clean.versionId))?.bytes;
    if (cleanBytes === undefined) throw new Error("the fixture version is missing");
    const source = await store.put({
      bytes: withExternalLink(cleanBytes, "https://example.com/quarterly-close"),
      name: "linked.docx",
      mimeType: DOCX_MIME,
      metadata: { createdBy: "host", source: "uploaded" },
    });
    const lease = leaseOf([source]);
    const before = (await store.getVersion(source.id, source.versionId))?.bytes;
    if (before === undefined) throw new Error("the fixture version is missing");

    for (const [name, args] of [
      [READ_DOCUMENT, { ref: refOf(source), section: "paragraphs" }],
      [
        EDIT_DOCUMENT,
        {
          ref: refOf(source),
          output: "proposal.docx",
          author: "Office Hum",
          steps: [{ kind: "deleteParagraphs", anchor: { text: "Quarterly Close" } }],
        },
      ],
    ] as const) {
      const refused = await refuse(toolOf(service, name, lease), args);
      expect(refused.code).toBe("external-relationship");
    }
    // The refusal left the source exactly as it was, and wrote no version.
    const after = (await store.getVersion(source.id, source.versionId))?.bytes;
    expect(sha256(after ?? new Uint8Array())).toBe(sha256(before));
    expect(source.sha256).toBe(sha256(before));
    expect(await store.getHead(source.id)).toMatchObject({ versionId: source.versionId });
  });

  it("refuses a package whose document part will not parse, leaving the source byte-identical", async () => {
    const { store, service } = harness();
    const source = await fixture(store, service, { operationId: "conv:malformed-fixture" });
    const original = (await store.getVersion(source.id, source.versionId))?.bytes;
    if (original === undefined) throw new Error("the fixture version is missing");

    // A structurally valid archive — content types, no macro, no external relationship — whose document
    // part is not well-formed. The host's structural inspection passes it; the pinned library refuses it.
    const broken = await store.put({
      bytes: rebuilt(original, (name, data) =>
        name === "word/document.xml" ? utf8('<w:document xmlns:w="w"><w:body>') : data,
      ),
      name: "broken.docx",
      mimeType: DOCX_MIME,
      metadata: { createdBy: "host", source: "uploaded" },
    });
    const brokenBytes = (await store.getVersion(broken.id, broken.versionId))?.bytes;
    if (brokenBytes === undefined) throw new Error("the broken version is missing");

    const refused = await refuse(toolOf(service, READ_DOCUMENT, leaseOf([broken])), {
      ref: refOf(broken),
      section: "paragraphs",
    });
    expect(refused.code).toBe("malformed-package");
    const after = (await store.getVersion(broken.id, broken.versionId))?.bytes;
    expect(sha256(after ?? new Uint8Array())).toBe(sha256(brokenBytes));
    expect(broken.sha256).toBe(sha256(brokenBytes));
  });
});

suite("a bare Pi Durable harness gets the same receipt as Office Hum", () => {
  it("rebuilds the same tool answer from the durable record, under the same operation ID", async () => {
    const { store, service } = harness();
    const source = await fixture(store, service, { operationId: "conv:portable-fixture" });
    const lease = leaseOf([source]);
    const args = {
      ref: refOf(source),
      output: "proposal.docx",
      author: "Office Hum",
      steps: [
        {
          kind: "replaceParagraphs",
          anchor: { text: "Revenue was 1250 dollars." },
          paragraphs: ["Revenue was 1400 dollars."],
        },
      ],
    };

    // Office Hum's shape: the local service, the FileStore and the run ledger.
    const recorder = recordingService(service);
    const office = await toolOf(recorder, EDIT_DOCUMENT, lease).execute(args, API);
    const receipt = recorder.receipts.at(-1);
    if (receipt === undefined || receipt.kind !== "run") throw new Error("no durable receipt");
    const recorded = JSON.parse(office.output[0]?.text ?? "{}") as { operationId: string };
    expect(receipt.operationId).toBe(recorded.operationId);

    // A bare harness's shape: a scripted service that answers from that record, with no Office Hum.
    const bare = paperOfficeToolPack({
      service: {
        async runDocumentPython(request) {
          expect(request.operationId).toBe(receipt.operationId);
          return { kind: "committed", receipt };
        },
      },
      leaseFor: async () => lease,
    });
    expect(bare.tools[0]?.name).toBe(RUN_DOCUMENT_PYTHON);
    const tool = bare.tools.find((item) => item.name === EDIT_DOCUMENT) as unknown as Tool;
    const answer = await tool.execute(args, API);
    expect(answer.isError).toBeUndefined();
    expect(answer.output[0]?.text).toBe(office.output[0]?.text);
  });
});

describe("the refusals that need no interpreter", () => {
  it("refuses an archive that is not a package, leaving the source byte-identical", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const service = localDocumentService({
      store,
      worker: {
        async run() {
          throw new Error("a malformed package is refused before the worker runs");
        },
      },
      ledger: runLedger(join(root, "ledger")),
      createdBy: "role:test",
    });
    const ref = await store.put({
      bytes: docxLike({ omitContentTypes: true }),
      name: "brief.docx",
      mimeType: DOCX_MIME,
      metadata: { createdBy: "host", source: "uploaded" },
    });
    const refused = await refuse(toolOf(service, READ_DOCUMENT, leaseOf([ref])), {
      ref: refOf(ref),
      section: "paragraphs",
    });
    expect(refused.code).toBe("archive-invalid");
    const after = await store.getVersion(ref.id, ref.versionId);
    expect(sha256(after?.bytes ?? new Uint8Array())).toBe(ref.sha256);
    expect(await store.getHead(ref.id)).toMatchObject({ versionId: ref.versionId });
  });

  it("refuses an external relationship, leaving the source byte-identical", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const service = localDocumentService({
      store,
      worker: {
        async run() {
          throw new Error("an external relationship is refused before the worker runs");
        },
      },
      ledger: runLedger(join(root, "ledger")),
      createdBy: "role:test",
    });
    const ref = await store.put({
      bytes: docxLike({ external: ["https://example.com/quarterly-close"] }),
      name: "linked.docx",
      mimeType: DOCX_MIME,
      metadata: { createdBy: "host", source: "uploaded" },
    });
    const lease = leaseOf([ref]);
    const before = (await store.getVersion(ref.id, ref.versionId))?.bytes;
    for (const [name, args] of [
      [INSPECT_DOCUMENT, { ref: refOf(ref) }],
      [PREVIEW_DOCUMENT, { ref: refOf(ref) }],
      [
        EDIT_DOCUMENT,
        {
          ref: refOf(ref),
          output: "proposal.docx",
          author: "Office Hum",
          steps: [{ kind: "deleteParagraphs", anchor: { text: "Quarterly Close" } }],
        },
      ],
    ] as const) {
      const refused = await refuse(toolOf(service, name, lease), args);
      expect(refused.code).toBe("external-relationship");
    }
    const after = (await store.getVersion(ref.id, ref.versionId))?.bytes;
    expect(sha256(after ?? new Uint8Array())).toBe(sha256(before ?? new Uint8Array()));
    expect(await store.getHead(ref.id)).toMatchObject({ versionId: ref.versionId });
  });
});
