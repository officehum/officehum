/**
 * The PowerPoint fixtures, against a real interpreter: a deck is inspected, read in pages, drafted,
 * edited into an unpublished proposal, composed with another lease's slides, and refused when it is
 * malformed or links out of the package.
 *
 * The two configurations the issue names are both exercised here. The refusal tests at the bottom do
 * not need an interpreter — the pack inspects the package structure in process, so an archive that is
 * not a package or a relationship that leaves it is refused on any host — and they run in both
 * configurations. The rest need the pinned `paper-pptx` and **skip visibly** when
 * `OFFICEHUM_PAPER_PYTHON` is unset, because the worker takes its interpreter from a configured path
 * and there is no safe guess.
 *
 * The preservation claim is argued with bytes and not by eye: every part of the source and of the
 * proposal is unzipped and hashed, so "the theme, the media and the untouched slides came back
 * verbatim" is a sha256 comparison — and the hashes the result *reports* are checked against the
 * hashes the packages actually hold.
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
import {
  COMPARE_PRESENTATION,
  COMPOSE_PRESENTATION,
  CREATE_PRESENTATION,
  EDIT_PRESENTATION,
  INSPECT_PRESENTATION,
  type PptxCompose,
  type PptxDraft,
  type PptxEdit,
  type PptxInspection,
  type PptxPreview,
  type PptxReading,
  type PptxResult,
  PREVIEW_PRESENTATION,
  READ_PRESENTATION,
} from "./pptx-operations.js";
import { paperOfficeToolPack, RUN_DOCUMENT_PYTHON } from "./run-document-python.js";
import type { DocumentRunReceipt } from "./run-ledger.js";
import { runLedger } from "./run-ledger.js";
import {
  buildZip,
  configuredInterpreter,
  pptxFixtureCode,
  pptxLike,
  pptxPackage,
  sha256,
  textOf,
  utf8,
  zipEntries,
} from "./test-helpers.js";

const interpreter = configuredInterpreter();
const suite = interpreter === undefined ? describe.skip : describe;

/**
 * A fixture test with an explicit budget. Each of these drives several real Python 3.13 subprocesses —
 * a deck is built by one run, then read, inspected, edited or composed by more — so the default
 * five-second budget is not enough for the larger ones under a loaded suite. A test that needs a real
 * interpreter is a test that spawns one.
 */
const itSlow = (name: string, run: () => Promise<void>): void => {
  it(name, run, 30_000);
};

if (interpreter === undefined) {
  console.warn(
    "paper PowerPoint fixtures skipped: set OFFICEHUM_PAPER_PYTHON to a provisioned Python 3.13 " +
      "(see packages/tools-paper-office/scripts/provision-worker.sh). The refusal fixtures still run.",
  );
}

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** The parts an edit of one slide's text has no business touching. */
const UNTOUCHED_PARTS = [
  "ppt/media/image1.png",
  "ppt/theme/theme1.xml",
  "ppt/theme/theme2.xml",
  "ppt/slideMasters/slideMaster1.xml",
  "ppt/slideLayouts/slideLayout1.xml",
  "ppt/slideLayouts/slideLayout2.xml",
  "ppt/slideLayouts/slideLayout11.xml",
  "ppt/slides/slide1.xml",
  "ppt/slides/slide3.xml",
  "ppt/notesMasters/notesMaster1.xml",
  "ppt/presProps.xml",
  "ppt/viewProps.xml",
  "ppt/tableStyles.xml",
  "docProps/core.xml",
  "_rels/.rels",
];

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paper-pptx-"));
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

/** A real PowerPoint fixture, built through the worker, as the version a task would be leased. */
async function fixture(
  store: VersionedFileStore,
  service: DocumentService,
  options: {
    readonly variant?: "main" | "appendix";
    readonly name?: string;
    readonly operationId: string;
  },
): Promise<VersionedFileRef> {
  const receipt = committed(
    await service.runDocumentPython({
      operationId: options.operationId,
      taskId: "task:pptx",
      lease: {
        leaseId: "lease:fixture",
        taskId: "task:pptx",
        inputs: [],
        outputFormats: ["pptx"],
        limits: DEFAULT_LIMITS,
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
      code: pptxFixtureCode(options),
      arguments: {},
    }),
  );
  const output = receipt.outputs[0];
  if (output === undefined) throw new Error("the fixture produced no deck");
  const stored = await store.getVersion(output.fileId, output.versionId);
  if (stored === undefined) throw new Error("the fixture version is missing");
  return stored.ref;
}

function leaseOf(refs: readonly VersionedFileRef[], writable = true): DocumentLease {
  const inputs: LeasedInput[] = refs.map((ref) => ({
    fileId: ref.id,
    versionId: ref.versionId,
    name: ref.name,
    format: "pptx",
    sha256: ref.sha256,
    size: ref.size,
    writable,
  }));
  return {
    leaseId: "lease:pptx",
    taskId: "task:pptx",
    inputs,
    outputFormats: ["pptx"],
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

const API = { taskId: "task:pptx", conversationId: "conv", callId: "call-1" };

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
  wrote: { fileId: string; versionId: string; sha256: string; versionOf: string | null }[];
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

/** A real deck that links outside the package: a genuine external relationship in a real file. */
function withExternalLink(bytes: Uint8Array, target: string): Uint8Array {
  return rebuilt(bytes, (name, data) => {
    if (name !== "ppt/_rels/presentation.xml.rels") return data;
    const relationship =
      '<Relationship Id="rIdPaperExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"' +
      ` Target="${target}" TargetMode="External"/>`;
    return utf8(textOf(data).replace("</Relationships>", `${relationship}</Relationships>`));
  });
}

/** Per-part sha256, by package member name. The only acceptable argument for preservation. */
function partHashes(bytes: Uint8Array): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [name, data] of zipEntries(bytes)) out.set(name, sha256(data));
  return out;
}

async function bytesOf(
  store: VersionedFileStore,
  fileId: string,
  versionId: string,
): Promise<Uint8Array> {
  const stored = await store.getVersion(fileId, versionId);
  if (stored === undefined) throw new Error(`version ${versionId} is missing`);
  return stored.bytes;
}

suite("the PowerPoint adapter reads a leased deck in bounded pages", () => {
  itSlow("pages slide order, text, shapes, notes and media to the end", async () => {
    const { store, service } = harness();
    const source = await fixture(store, service, { operationId: "conv:read-fixture" });
    const lease = leaseOf([source]);

    for (const section of ["slides", "text", "shapes", "notes", "media"]) {
      const collected: Readonly<Record<string, unknown>>[] = [];
      let cursor: number | null = 0;
      let total = -1;
      let pages = 0;
      while (cursor !== null) {
        const answer: { result: PptxReading } = await body<PptxReading>(
          toolOf(service, READ_PRESENTATION, lease),
          { ref: refOf(source), section, cursor, pageSize: 3 },
          { ...API, callId: `call-${section}-${pages}` },
        );
        const page: PptxReading["page"] = answer.result.page;
        expect(page.section).toBe(section);
        expect(page.pageSize).toBe(3);
        expect(page.returned).toBeLessThanOrEqual(3);
        expect(page.items).toHaveLength(page.returned);
        if (total < 0) total = page.total;
        else expect(page.total).toBe(total);
        expect(page.cursor).toBe(cursor);
        collected.push(...(page.items as unknown as readonly Readonly<Record<string, unknown>>[]));
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(30);
      }
      // The pages partition the section: every item arrived exactly once, under the identity its own
      // section names — a text block by its part and block index, a shape by its slide and shape id.
      expect(collected.length).toBe(total);
      const keys = collected.map((item) => {
        if (section === "text") return `${String(item.part)}:${String(item.blockIndex)}`;
        if (section === "shapes") return `${String(item.slideId)}:${String(item.shapeId)}`;
        if (section === "media") return String(item.target);
        return String(item.slideId);
      });
      expect(new Set(keys).size).toBe(collected.length);
    }

    // Slide order, layouts and titles, as the deck was built.
    const slides = await body<PptxReading>(toolOf(service, READ_PRESENTATION, lease), {
      ref: refOf(source),
      section: "slides",
    });
    const outline = slides.result.page.items as unknown as {
      position: number;
      layoutName: string;
      titleText: string | null;
      hasNotes: boolean;
      shapeCount: number;
    }[];
    expect(outline).toHaveLength(3);
    expect(outline.map((item) => item.position)).toEqual([0, 1, 2]);
    expect(outline.map((item) => item.layoutName)).toEqual([
      "Title Slide",
      "Title and Content",
      "Blank",
    ]);
    expect(outline.map((item) => item.titleText).slice(0, 2)).toEqual([
      "Quarterly Close",
      "Revenue",
    ]);
    expect(outline[1]?.hasNotes).toBe(true);
    expect(outline[0]?.hasNotes).toBe(false);

    // Text: resolved effective fonts, and table-cell text honestly marked blind.
    const text = await body<PptxReading>(toolOf(service, READ_PRESENTATION, lease), {
      ref: refOf(source),
      section: "text",
      pageSize: 50,
    });
    const blocks = text.result.page.items as unknown as {
      text: string;
      blind: boolean;
      container: string;
      part: string;
      blockIndex: number;
      anchor: { content_hash?: unknown };
      runs: { font: { sizeEmu: number | null; sizeResolved: boolean; nameResolved: boolean } }[];
    }[];
    const revenue = blocks.find((block) => block.text === "Revenue was 1250 dollars.");
    expect(revenue).toBeDefined();
    expect(revenue?.blind).toBe(false);
    expect(revenue?.anchor.content_hash).toBeTypeOf("string");
    expect(revenue?.runs[0]?.font.sizeResolved).toBe(true);
    expect(revenue?.runs[0]?.font.sizeEmu).toBeGreaterThan(0);
    expect(revenue?.runs[0]?.font.nameResolved).toBe(true);
    const cells = blocks.filter((block) => block.container === "table-cell");
    expect(cells).toHaveLength(4);
    // Table-cell text is visible but its effective values are unresolvable: reported blind, not guessed.
    expect(cells.every((cell) => cell.blind)).toBe(true);
    expect(cells.map((cell) => cell.text)).toEqual(["Account", "Amount", "Revenue", "1250"]);

    // Shapes: the picture, the table and the text boxes are all reported with their facts.
    const shapes = await body<PptxReading>(toolOf(service, READ_PRESENTATION, lease), {
      ref: refOf(source),
      section: "shapes",
      pageSize: 50,
    });
    const shapeItems = shapes.result.page.items as unknown as {
      kind: string;
      name: string;
      table: { rows: number; cols: number } | null;
      image: { ext: string } | null;
      left: number | null;
      width: number | null;
    }[];
    expect(shapeItems.some((shape) => shape.table?.rows === 2 && shape.table?.cols === 2)).toBe(
      true,
    );
    const picture = shapeItems.find((shape) => shape.image !== null);
    expect(picture?.image?.ext).toBe("png");
    expect(picture?.width).toBeGreaterThan(0);
    expect(shapeItems.some((shape) => shape.name.startsWith("TextBox"))).toBe(true);

    // Notes: the content slide has them, the others do not.
    const notes = await body<PptxReading>(toolOf(service, READ_PRESENTATION, lease), {
      ref: refOf(source),
      section: "notes",
    });
    const notesItems = notes.result.page.items as unknown as {
      position: number;
      present: boolean;
      text: string;
    }[];
    expect(notesItems.map((item) => item.present)).toEqual([false, true, false]);
    expect(notesItems[1]?.text).toBe("Confirm the revenue figure with the bookkeeper.");

    // Media: one reference, with the part's real hash.
    const media = await body<PptxReading>(toolOf(service, READ_PRESENTATION, lease), {
      ref: refOf(source),
      section: "media",
    });
    const mediaItems = media.result.page.items as unknown as {
      kind: string;
      target: string;
      sha256: string;
      bytes: number;
      slideId: number;
    }[];
    expect(mediaItems).toHaveLength(1);
    expect(mediaItems[0]?.kind).toBe("image");
    expect(mediaItems[0]?.target).toBe("/ppt/media/image1.png");
    const sourceBytes = await bytesOf(store, source.id, source.versionId);
    const mediaBytes = zipEntries(sourceBytes).get("ppt/media/image1.png");
    expect(mediaItems[0]?.sha256).toBe(sha256(mediaBytes ?? new Uint8Array()));
    expect(mediaItems[0]?.bytes).toBe(mediaBytes?.byteLength);
  });

  itSlow(
    "inspects a deck and previews it, reporting overflow rather than ignoring it",
    async () => {
      const { store, service } = harness();
      const source = await fixture(store, service, { operationId: "conv:inspect-fixture" });
      const lease = leaseOf([source]);

      const answer = await body<PptxInspection>(toolOf(service, INSPECT_PRESENTATION, lease), {
        ref: refOf(source),
      });
      expect(answer.result.deck).toMatchObject({
        slides: 3,
        masters: 1,
        pictures: 1,
        tables: 1,
        notesSlides: 1,
        mediaParts: 1,
        orphanMediaParts: 0,
        blindTextBlocks: 4,
      });
      expect(answer.result.slideOutline.map((item) => item.layoutName)).toEqual([
        "Title Slide",
        "Title and Content",
        "Blank",
      ]);
      // No bitmap renderer exists in process, and the result says so rather than implying a picture.
      expect(answer.result.rendering.bitmap).toBe(false);
      expect(answer.result.rendering.limits.join(" ")).toContain("no rasteriser");
      expect(answer.result.warnings.join(" ")).toContain("table-cell text");
      // The deliberately long text box is reported as overflowing; nothing is silently dropped.
      expect(answer.result.overflow.overflowing).toBeGreaterThanOrEqual(1);
      expect(answer.result.overflowSlides.length).toBeGreaterThanOrEqual(1);
      expect(answer.wrote).toEqual([]);

      const firstPage = await body<PptxPreview>(toolOf(service, PREVIEW_PRESENTATION, lease), {
        ref: refOf(source),
        pageSize: 2,
      });
      expect(firstPage.result.page.total).toBe(3);
      expect(firstPage.result.page.items).toHaveLength(2);
      expect(firstPage.result.page.nextCursor).toBe(2);
      const preview = await body<PptxPreview>(toolOf(service, PREVIEW_PRESENTATION, lease), {
        ref: refOf(source),
        pageSize: 3,
      });
      const content = preview.result.page.items[1];
      const labels = (content?.lines ?? []).map((line) => line.label);
      expect(labels.some((label) => label.startsWith("T:"))).toBe(true);
      expect(labels.some((label) => label.startsWith("B:"))).toBe(true);
      expect(labels.some((label) => label.startsWith("PIC:png:"))).toBe(true);
      expect(labels.some((label) => label.startsWith("TB2x2:"))).toBe(true);
      expect(labels.some((label) => label.startsWith("TC:"))).toBe(true);
      expect(content?.notes.text).toBe("Confirm the revenue figure with the bookkeeper.");
      expect(content?.media.map((item) => item.target)).toEqual(["/ppt/media/image1.png"]);

      const blank = preview.result.page.items[2];
      const overflowing = (blank?.overflow.items ?? []).filter((item) => item.overflow === true);
      // The overflowing box is named, with the estimate that says why…
      expect(overflowing).toHaveLength(1);
      expect(overflowing[0]?.name).toContain("TextBox");
      expect(overflowing[0]?.reason).toBeNull();
      expect(overflowing[0]?.computed).toBe(true);
      expect(overflowing[0]?.declared.autoSize).toBe("NONE");
      expect(overflowing[0]?.declared.wordWrap).toBe(true);
      // …and the box whose text fits is examined and not flagged, so the report is not vacuous: two
      // text shapes were resolved on that slide, one overflows, and none was left unresolved.
      expect(blank?.overflow.summary).toEqual({
        shapes: 2,
        overflowing: 1,
        compensated: 0,
        unresolved: 0,
      });
      expect(preview.result.overflow.overflowing).toBeGreaterThanOrEqual(1);
      expect(preview.wrote).toEqual([]);
    },
  );
});

suite("the PowerPoint adapter drafts and proposes", () => {
  itSlow("creates a new draft, which is a new file and not a publication", async () => {
    const { store, service } = harness();
    const answer = await body<PptxDraft>(toolOf(service, CREATE_PRESENTATION, leaseOf([])), {
      output: "close-summary.pptx",
      slides: [
        {
          title: "Quarterly close",
          layout: "Title and Content",
          notes: "Draft for review.",
          blocks: [
            { kind: "paragraph", text: "Prepared by the office." },
            {
              kind: "bullets",
              items: [{ text: "Reconciled the bank" }, { text: "Filed the receipts", level: 1 }],
            },
          ],
        },
        {
          title: "Figures",
          blocks: [
            {
              kind: "table",
              rows: [
                ["Account", "Amount"],
                ["Revenue", "1250"],
              ],
            },
          ],
        },
      ],
    });
    expect(answer.result.draft).toMatchObject({
      status: "draft",
      editOf: null,
      published: false,
    });
    expect(answer.result.provenance.source).toBeNull();
    expect(answer.result.reopened.slides).toBe(2);
    expect(answer.result.reopened.tables).toBe(1);
    expect(answer.result.reopened.notesSlides).toBe(1);
    expect(answer.result.placements.map((placement) => placement.layout)).toEqual([
      "Title and Content",
      "Title and Content",
    ]);
    expect(answer.wrote).toHaveLength(1);

    const wrote = answer.wrote[0];
    const head = await store.getHead(wrote?.fileId ?? "");
    expect(head?.versionId).toBe(wrote?.versionId);
    expect(head?.sourceVersionId).toBeNull();
    expect(head?.sha256).toBe(answer.result.draft.sha256);
    // A draft is generated, not derived from a deck: nothing was edited.
    expect(head?.metadata.source).toBe("generated");
    const bytes = await bytesOf(store, wrote?.fileId ?? "", wrote?.versionId ?? "");
    expect(zipEntries(bytes).has("[Content_Types].xml")).toBe(true);
    expect(zipEntries(bytes).has("ppt/presentation.xml")).toBe(true);
  });

  itSlow("refuses a ragged table and a layout the deck does not define", async () => {
    const { service } = harness();
    const label = await refuse(toolOf(service, CREATE_PRESENTATION, leaseOf([])), {
      output: "close-summary.pptx",
      slides: [{ blocks: [{ kind: "table", rows: [["a"], ["b", "c"]] }] }],
    });
    expect(label.code).toBe("invalid-request");

    const layout = await refuse(toolOf(service, CREATE_PRESENTATION, leaseOf([])), {
      output: "close-summary.pptx",
      slides: [{ layout: "Wide Screen", blocks: [{ kind: "paragraph", text: "x" }] }],
    });
    expect(layout.code).toBe("target-not-found");
    expect(layout.message).toContain("Title and Content");
  });

  itSlow(
    "edits a deck into an immutable proposal, preserving untouched parts byte for byte",
    async () => {
      const { store, service } = harness();
      const source = await fixture(store, service, { operationId: "conv:edit-fixture" });
      const lease = leaseOf([source]);

      // The anchor comes from a read, exactly as a model would get it.
      const reading = await body<PptxReading>(toolOf(service, READ_PRESENTATION, lease), {
        ref: refOf(source),
        section: "text",
        pageSize: 50,
      });
      const blocks = reading.result.page.items as unknown as {
        text: string;
        anchor: Record<string, unknown>;
        slideId: number;
      }[];
      const matched = blocks.find((block) => block.text === "Revenue was 1250 dollars.");
      const anchor = matched?.anchor;
      expect(anchor).toBeDefined();

      const answer = await body<PptxEdit>(toolOf(service, EDIT_PRESENTATION, lease), {
        ref: refOf(source),
        output: "proposal.pptx",
        detail: "full",
        steps: [
          { kind: "replaceText", anchor, find: "1250", replace: "1400" },
          { kind: "writeNotes", slide: 1, text: "Revenue confirmed at 1400." },
        ],
      });
      const result = answer.result;
      expect(result.proposal).toMatchObject({
        status: "proposed",
        editOf: source.versionId,
        published: false,
      });
      expect(result.steps).toEqual(["replaceText", "writeNotes"]);
      expect(result.changes[0]?.kind).toBe("replaceText");
      expect(result.changes[0]?.evidence.replacements).toBe(1);
      expect(result.changes[1]?.evidence.notesCreated).toBe(false);
      // There is no revision markup in PowerPoint: the review surface is the change set and the diff.
      expect(result.changeSet.changed.map((change) => change.part)).toContain(
        "/ppt/slides/slide2.xml",
      );
      expect(result.changeSet.changed.map((change) => change.part)).toContain(
        "/ppt/notesSlides/notesSlide1.xml",
      );
      expect(result.changeSet.changed.every((change) => change.beforeSha256 !== null)).toBe(true);
      expect(result.changeSet.semanticallyEmpty).toBe(false);
      expect(result.diff.slideChangeTotal).toBeGreaterThanOrEqual(1);
      expect(result.reopened.slides).toBe(3);

      // Before/after previews, matched by permanent slide id, for the slide the text changed on.
      const pair = result.preview.changed.find((entry) => entry.slideId === matched?.slideId);
      expect(pair).toBeDefined();
      const beforeText = (pair?.before.lines ?? []).map((line) => line.text);
      const afterText = (pair?.after.lines ?? []).map((line) => line.text);
      expect(beforeText).toContain("Revenue was 1250 dollars.");
      expect(afterText).toContain("Revenue was 1400 dollars.");
      expect(beforeText).not.toEqual(afterText);

      // The proposal is a new immutable version of the same file: the source version is untouched.
      const wrote = answer.wrote[0];
      expect(wrote?.fileId).toBe(source.id);
      expect(wrote?.versionId).not.toBe(source.versionId);
      const head = await store.getHead(source.id);
      expect(head?.versionId).toBe(wrote?.versionId);
      expect(head?.sourceVersionId).toBe(source.versionId);
      expect(head?.metadata.source).toBe("derived");
      const original = await bytesOf(store, source.id, source.versionId);
      expect(sha256(original)).toBe(source.sha256);
      // Nothing published it.
      expect(await store.getPublished(source.id)).toBeUndefined();

      // Preservation, argued with per-part sha256 rather than by eye.
      const before = partHashes(original);
      const after = partHashes(await bytesOf(store, wrote?.fileId ?? "", wrote?.versionId ?? ""));
      const untouched = UNTOUCHED_PARTS.filter((part) => before.has(part));
      expect(untouched).toHaveLength(UNTOUCHED_PARTS.length);
      for (const part of untouched) {
        expect(after.get(part), `${part} is missing from the proposal`).toBeDefined();
      }
      const identical = untouched.filter((part) => after.get(part) === before.get(part));
      // Every one of them came back exactly as it arrived: media, both themes, the master, the layouts,
      // the notes master, and the two slides this edit did not touch.
      expect(identical).toEqual(untouched);
      // The parts the edit really touched are exactly the ones that differ.
      expect(after.get("ppt/slides/slide2.xml")).not.toBe(before.get("ppt/slides/slide2.xml"));
      expect(after.get("ppt/notesSlides/notesSlide1.xml")).not.toBe(
        before.get("ppt/notesSlides/notesSlide1.xml"),
      );

      // The change set's own count is the count the packages actually have.
      const trulyIdentical = [...before.keys()].filter(
        (part) => after.get(part) === before.get(part),
      );
      expect(result.changeSet.byteIdenticalCount).toBe(trulyIdentical.length);
      expect(result.preservation.byteIdenticalCount).toBe(trulyIdentical.length);
      // The reported hashes are the packages' hashes, not a claim about them. The sample is bounded and
      // category-ordered — media, theme, masters, layouts, notes, slides, then the rest — so the parts
      // the issue names first are the ones reported, and the count stays exact either way.
      const reported = new Map(
        result.preservation.byteIdentical.map((part) => [part.part, part.sha256]),
      );
      expect(result.preservation.byteIdenticalHashed).toBe(reported.size);
      expect(reported.size).toBeGreaterThan(0);
      for (const [part, hash] of reported) {
        expect(trulyIdentical).toContain(part.slice(1));
        expect(before.get(part.slice(1))).toBe(hash);
      }
      expect(result.preservation.byteIdentical.map((part) => part.part)).toContain(
        "/ppt/media/image1.png",
      );
      expect(result.preservation.mediaByteIdentical).toEqual(["/ppt/media/image1.png"]);
      expect(result.preservation.themeByteIdentical).toContain("/ppt/theme/theme1.xml");
      expect(result.preservation.layoutByteIdentical.length).toBeGreaterThan(5);
      expect(result.preservation.masterByteIdentical).toContain(
        "/ppt/slideMasters/slideMaster1.xml",
      );
      expect(result.preservation.verbatimCopy).toBe(false);
      expect(result.preservation.changedParts).toContain("ppt/slides/slide2.xml");
    },
  );

  itSlow(
    "applies the remaining step kinds, including a layout rebind that has to bake an orphan",
    async () => {
      const { store, service } = harness();
      const source = await fixture(store, service, { operationId: "conv:steps-fixture" });
      const lease = leaseOf([source]);
      const shapes = await body<PptxReading>(toolOf(service, READ_PRESENTATION, lease), {
        ref: refOf(source),
        section: "shapes",
        pageSize: 50,
      });
      const picture = (
        shapes.result.page.items as unknown as {
          kind: string;
          shapeId: number;
          name: string;
          position: number;
        }[]
      ).find((shape) => shape.kind === "PICTURE");
      expect(picture).toBeDefined();

      // A copy keeps its source's display name, so the copy is addressed by the id its step reported.
      const copied = await body<PptxEdit>(toolOf(service, EDIT_PRESENTATION, leaseOf([source])), {
        ref: refOf(source),
        output: "copy.pptx",
        steps: [
          { kind: "copyShape", slide: picture?.position ?? 1, shapeId: picture?.shapeId ?? 0 },
        ],
      });
      const copyId = copied.result.changes[0]?.evidence.shapeId;
      expect(copyId).toBeTypeOf("number");
      // Name addressing refuses the ambiguity a copy creates rather than guessing between the two.
      const ambiguous = await refuse(toolOf(service, EDIT_PRESENTATION, leaseOf([source])), {
        ref: refOf(source),
        output: "ambiguous.pptx",
        steps: [
          { kind: "copyShape", slide: picture?.position ?? 1, shape: picture?.name ?? "" },
          { kind: "deleteShape", slide: picture?.position ?? 1, shape: picture?.name ?? "" },
        ],
      });
      expect(ambiguous.code).toBe("ambiguous-target");

      // The multi-step edit runs against its own fixture: the copy above became the head of `source`.
      const second = await fixture(store, service, {
        operationId: "conv:steps-fixture-2",
        name: "brief-two.pptx",
      });
      const secondShapes = await body<PptxReading>(
        toolOf(service, READ_PRESENTATION, leaseOf([second])),
        { ref: refOf(second), section: "shapes", pageSize: 50 },
      );
      const secondPicture = (
        secondShapes.result.page.items as unknown as {
          kind: string;
          shapeId: number;
          name: string;
          position: number;
        }[]
      ).find((shape) => shape.kind === "PICTURE");
      expect(secondPicture).toBeDefined();

      // The slide- and shape-level steps, on the deck the read above described.
      const shapeSteps = [
        {
          kind: "moveShape" as const,
          slide: secondPicture?.position ?? 1,
          shape: secondPicture?.name ?? "",
          to: 0,
        },
        {
          kind: "deleteShape" as const,
          slide: secondPicture?.position ?? 1,
          shape: secondPicture?.name ?? "",
        },
        { kind: "cloneSlide" as const, slide: 0, at: 0 },
        { kind: "moveSlide" as const, slide: 0, to: 2 },
        { kind: "deleteSlide" as const, slide: 3 },
        { kind: "addSlide" as const, layout: "Title Only", at: 0 },
      ];
      const tool = toolOf(service, EDIT_PRESENTATION, leaseOf([second]));
      const raw = await tool.execute(
        { ref: refOf(second), output: "shapes.pptx", detail: "text", steps: shapeSteps },
        nextApi(),
      );
      const parsed = JSON.parse(raw.output[0]?.text ?? "{}") as {
        result: PptxEdit;
        truncated?: boolean;
        omitted?: unknown;
      };
      expect(parsed.result.steps).toEqual(shapeSteps.map((step) => step.kind));
      expect(parsed.result.changes).toHaveLength(shapeSteps.length);
      // Every step's evidence is present, or the reply names that it dropped it — never a silent gap
      // where the per-step evidence should be.
      const evidence = parsed.result.changes.map((change) => Object.keys(change.evidence).length);
      expect(
        evidence.every((size) => size > 0) ||
          String(parsed.omitted).includes("per-step change evidence"),
      ).toBe(true);
      expect(parsed.result.preview.addedTotal).toBeGreaterThanOrEqual(1);
      expect(parsed.result.preview.removedTotal).toBeGreaterThanOrEqual(1);

      // The layout, footer and count-guard steps, on a third fixture so each reply stays small enough to
      // carry its own step evidence.
      const third = await fixture(store, service, {
        operationId: "conv:steps-fixture-3",
        name: "brief-three.pptx",
      });
      const answer = await body<PptxEdit>(toolOf(service, EDIT_PRESENTATION, leaseOf([third])), {
        ref: refOf(third),
        output: "proposal.pptx",
        detail: "text",
        steps: [
          { kind: "rebindLayout", slide: 0, layout: "Blank", orphanPolicy: "bake" },
          { kind: "applyFooters", footer: "Office Hum", slideNumber: true },
          { kind: "replaceTextEverywhere", find: "Amount", replace: "Total", expect: 1 },
        ],
      });
      expect(answer.result.steps).toEqual([
        "rebindLayout",
        "applyFooters",
        "replaceTextEverywhere",
      ]);
      const rebind = answer.result.changes[0]?.evidence as {
        target_layout_name: string;
        baked_orphans: string[];
      };
      expect(rebind.target_layout_name).toBe("Blank");
      expect(rebind.baked_orphans.length).toBeGreaterThan(0);
      const footers = answer.result.changes[1]?.evidence as { scope: string; applied: string[] };
      expect(footers.scope).toBe("deck");
      expect(footers.applied).toEqual(["footer", "slide_number"]);
      // The count guard held: exactly one "Amount" was replaced.
      const guard = answer.result.changes[2]?.evidence as { replacements: number } | undefined;
      expect(guard?.replacements).toBe(1);
      // A count guard that does not hold refuses, so drift cannot pass silently.
      const drifted = await refuse(toolOf(service, EDIT_PRESENTATION, leaseOf([third])), {
        ref: refOf(third),
        output: "drifted.pptx",
        steps: [{ kind: "replaceTextEverywhere", find: "Amount", replace: "Total", expect: 9 }],
      });
      expect(drifted.code).toBe("target-not-found");
      expect(drifted.message).toContain("expected 9");
    },
  );

  itSlow(
    "refuses a stale anchor, a malformed package and an external link, leaving the source byte-identical",
    async () => {
      const { store, service } = harness();
      const source = await fixture(store, service, { operationId: "conv:refusal-fixture" });
      const lease = leaseOf([source]);
      const sourceBytes = await bytesOf(store, source.id, source.versionId);

      // A stale anchor: a block whose content hash is not what the block hashes to now.
      const reading = await body<PptxReading>(toolOf(service, READ_PRESENTATION, lease), {
        ref: refOf(source),
        section: "text",
        pageSize: 50,
      });
      const fresh = (
        reading.result.page.items as unknown as { text: string; anchor: Record<string, unknown> }[]
      ).find((block) => block.text === "Revenue was 1250 dollars.")?.anchor;
      const stale = await refuse(toolOf(service, EDIT_PRESENTATION, lease), {
        ref: refOf(source),
        output: "stale.pptx",
        steps: [
          {
            kind: "replaceText",
            anchor: { ...fresh, content_hash: "0".repeat(64) },
            find: "1250",
            replace: "1400",
          },
        ],
      });
      // The fork refuses rather than editing whatever moved into that position.
      expect(["stale-anchor", "target-not-found"]).toContain(stale.code);
      // A refusal that never wrote anything: the source is still the head and the only version.
      expect(await store.getHead(source.id)).toMatchObject({ versionId: source.versionId });
      expect(sha256(await bytesOf(store, source.id, source.versionId))).toBe(sha256(sourceBytes));

      // A structurally valid archive whose slide part will not parse: the host's structural inspection
      // passes it, and the pinned library refuses it.
      const broken = await store.put({
        bytes: rebuilt(sourceBytes, (name, data) =>
          name === "ppt/slides/slide1.xml" ? utf8('<p:sld xmlns:p="p"><p:cSld>') : data,
        ),
        name: "broken.pptx",
        mimeType: PPTX_MIME,
        metadata: { createdBy: "host", source: "uploaded" },
      });
      const brokenBytes = await bytesOf(store, broken.id, broken.versionId);
      const malformed = await refuse(toolOf(service, READ_PRESENTATION, leaseOf([broken])), {
        ref: refOf(broken),
        section: "slides",
      });
      expect(malformed.code).toBe("malformed-package");
      expect(sha256(await bytesOf(store, broken.id, broken.versionId))).toBe(sha256(brokenBytes));

      // A real deck that links outside the package: refused before any parser sees it.
      const linked = await store.put({
        bytes: withExternalLink(sourceBytes, "https://example.com/quarterly-close"),
        name: "linked.pptx",
        mimeType: PPTX_MIME,
        metadata: { createdBy: "host", source: "uploaded" },
      });
      const linkedBytes = await bytesOf(store, linked.id, linked.versionId);
      const linkLease = leaseOf([linked]);
      for (const [name, args] of [
        [INSPECT_PRESENTATION, { ref: refOf(linked) }],
        [PREVIEW_PRESENTATION, { ref: refOf(linked) }],
        [READ_PRESENTATION, { ref: refOf(linked), section: "slides" }],
        [
          EDIT_PRESENTATION,
          {
            ref: refOf(linked),
            output: "proposal.pptx",
            steps: [{ kind: "deleteSlide", slide: 0 }],
          },
        ],
      ] as const) {
        const refused = await refuse(toolOf(service, name, linkLease), args);
        expect(refused.code).toBe("external-relationship");
      }
      expect(sha256(await bytesOf(store, linked.id, linked.versionId))).toBe(sha256(linkedBytes));
      expect(await store.getHead(linked.id)).toMatchObject({ versionId: linked.versionId });
    },
  );

  itSlow(
    "replays the same operation, returning the same receipt without a second version",
    async () => {
      const { store, service, runs } = harness();
      const source = await fixture(store, service, { operationId: "conv:replay-fixture" });
      const lease = leaseOf([source]);
      const args = {
        ref: refOf(source),
        output: "proposal.pptx",
        steps: [{ kind: "replaceTextEverywhere", find: "Amount", replace: "Total" }],
      };
      const before = runs.count;
      const first = await toolOf(service, EDIT_PRESENTATION, lease).execute(args, API);
      const second = await toolOf(service, EDIT_PRESENTATION, lease).execute(args, API);
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
      const stored = await store.getVersion(source.id, parsed.wrote[0]?.versionId ?? "");
      expect(stored?.ref.sourceVersionId).toBe(source.versionId);
    },
  );
});

suite("the PowerPoint adapter composes one leased deck into another", () => {
  itSlow("imports a source deck's slides as an unpublished proposal", async () => {
    const { store, service } = harness();
    const destination = await fixture(store, service, { operationId: "conv:dest-fixture" });
    const appendix = await fixture(store, service, {
      operationId: "conv:appendix-fixture",
      variant: "appendix",
      name: "appendix.pptx",
    });
    const lease = leaseOf([destination, appendix], false);
    // The destination must be writable; a read-only lease refuses the proposal.
    const readOnly = await refuse(toolOf(service, COMPOSE_PRESENTATION, lease), {
      into: refOf(destination),
      from: refOf(appendix),
      output: "joined.pptx",
      mode: "keep_appearance",
    });
    expect(readOnly.code).toBe("unleased-path");

    const writable = leaseOf([destination, appendix]);
    const answer = await body<PptxCompose>(toolOf(service, COMPOSE_PRESENTATION, writable), {
      into: refOf(destination),
      from: refOf(appendix),
      output: "joined.pptx",
      mode: "keep_appearance",
      detail: "text",
    });
    expect(answer.result.importCount).toBe(1);
    expect(answer.result.mode).toBe("keep_appearance");
    expect(answer.result.imports[0]?.layoutBindingMethod).toBe("transplant");
    expect(answer.result.proposal.published).toBe(false);
    expect(answer.result.proposal.editOf).toBe(destination.versionId);
    expect(answer.result.sources.from.versionId).toBe(appendix.versionId);
    // The imported slide is a slide this deck did not have: reported as added, with a preview.
    expect(answer.result.diff.slidesAdded.map((slide) => slide.slide_id)).toEqual([
      answer.result.imports[0]?.destSlideId,
    ]);
    expect(answer.result.preview.addedTotal).toBe(1);
    const imported = answer.result.preview.added[0]?.after as
      | { lines: { text: string }[] }
      | undefined;
    expect(imported?.lines.map((line) => line.text)).toContain("Notes for the appendix.");
    expect(answer.result.reopened.slides).toBe(4);

    // The destination is untouched, and its media came back verbatim.
    const wrote = answer.wrote[0];
    expect(wrote?.fileId).toBe(destination.id);
    expect(sha256(await bytesOf(store, destination.id, destination.versionId))).toBe(
      destination.sha256,
    );
    expect(answer.result.preservation.mediaByteIdentical).toContain("/ppt/media/image1.png");

    const applied = await refuse(toolOf(service, COMPOSE_PRESENTATION, writable), {
      into: refOf(destination),
      from: refOf(appendix),
      output: "joined.pptx",
      mode: "guess",
    });
    expect(applied.code).toBe("invalid-request");
  });

  itSlow("compares a proposal against the version it came from", async () => {
    const { store, service } = harness();
    const source = await fixture(store, service, { operationId: "conv:compare-fixture" });
    const proposed = await body<PptxEdit>(toolOf(service, EDIT_PRESENTATION, leaseOf([source])), {
      ref: refOf(source),
      output: "proposal.pptx",
      steps: [{ kind: "replaceTextEverywhere", find: "Amount", replace: "Total" }],
    });
    const wrote = proposed.wrote[0];
    const proposal = await store.getVersion(wrote?.fileId ?? "", wrote?.versionId ?? "");
    if (proposal === undefined) throw new Error("the proposal version is missing");

    const answer = await body<PptxResult>(
      toolOf(service, COMPARE_PRESENTATION, leaseOf([source, proposal.ref], false)),
      {
        from: refOf(source),
        to: refOf(proposal.ref),
        detail: "text",
      },
    );
    if (answer.result.operation !== "compare") throw new Error("expected a comparison");
    expect(answer.result.identical).toBe(false);
    expect(answer.result.changeSet.byteIdenticalCount).toBeGreaterThan(40);
    expect(answer.result.preview.changedTotal).toBeGreaterThanOrEqual(1);
    const pair = answer.result.preview.changed[0];
    expect(pair?.before.lines.map((line) => line.text)).toContain("Amount");
    expect(pair?.after.lines.map((line) => line.text)).toContain("Total");

    // A deck against itself is identical, so the diff is not reporting noise.
    const same = await body<PptxResult>(
      toolOf(service, COMPARE_PRESENTATION, leaseOf([source], false)),
      { from: refOf(source), to: refOf(source) },
    );
    if (same.result.operation !== "compare") throw new Error("expected a comparison");
    expect(same.result.identical).toBe(true);
  });
});

suite("a bare Pi Durable harness gets the same receipt as Office Hum", () => {
  itSlow(
    "rebuilds the same tool answer from the durable record, under the same operation ID",
    async () => {
      const { store, service } = harness();
      const source = await fixture(store, service, { operationId: "conv:portable-fixture" });
      const lease = leaseOf([source]);
      const args = {
        ref: refOf(source),
        output: "proposal.pptx",
        steps: [{ kind: "replaceTextEverywhere", find: "1250", replace: "1400" }],
      };

      // Office Hum's shape: the local service, the FileStore and the run ledger.
      const recorder = recordingService(service);
      const office = await toolOf(recorder, EDIT_PRESENTATION, lease).execute(args, API);
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
      const tool = bare.tools.find((item) => item.name === EDIT_PRESENTATION) as unknown as Tool;
      const answer = await tool.execute(args, API);
      expect(answer.isError).toBeUndefined();
      expect(answer.output[0]?.text).toBe(office.output[0]?.text);
    },
  );
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
      bytes: pptxLike({ omitContentTypes: true }),
      name: "brief.pptx",
      mimeType: PPTX_MIME,
      metadata: { createdBy: "host", source: "uploaded" },
    });
    const refused = await refuse(toolOf(service, READ_PRESENTATION, leaseOf([ref])), {
      ref: refOf(ref),
      section: "slides",
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
      bytes: pptxLike({ external: ["https://example.com/quarterly-close"] }),
      name: "linked.pptx",
      mimeType: PPTX_MIME,
      metadata: { createdBy: "host", source: "uploaded" },
    });
    const lease = leaseOf([ref]);
    const before = (await store.getVersion(ref.id, ref.versionId))?.bytes;
    for (const [name, args] of [
      [INSPECT_PRESENTATION, { ref: refOf(ref) }],
      [PREVIEW_PRESENTATION, { ref: refOf(ref) }],
      [
        EDIT_PRESENTATION,
        {
          ref: refOf(ref),
          output: "proposal.pptx",
          steps: [{ kind: "deleteSlide", slide: 0 }],
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

  it("refuses a reference to a deck the lease does not grant, before the worker runs", async () => {
    const store = localVersionedFileStore(join(root, "files"));
    const service = localDocumentService({
      store,
      worker: {
        async run() {
          throw new Error("an ungranted reference is refused before the worker runs");
        },
      },
      ledger: runLedger(join(root, "ledger")),
      createdBy: "role:test",
    });
    const ref = await store.put({
      bytes: pptxPackage(),
      name: "brief.pptx",
      mimeType: PPTX_MIME,
      metadata: { createdBy: "host", source: "uploaded" },
    });
    const refused = await refuse(toolOf(service, INSPECT_PRESENTATION, leaseOf([])), {
      ref: refOf(ref),
    });
    expect(refused.code).toBe("ungranted-input");
    expect(await store.getHead(ref.id)).toMatchObject({ versionId: ref.versionId });
  });
});
