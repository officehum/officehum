/**
 * The typed PowerPoint tools, as Pi Durable registrations.
 *
 * Seven tools — `inspect_presentation`, `read_presentation`, `create_presentation`,
 * `edit_presentation`, `preview_presentation`, `compare_presentation`, `compose_presentation` — on
 * the same `DocumentService` the Python workspace uses. Each one validates its arguments, resolves
 * every file reference against the task's lease, and runs a fixed Python operation through
 * `runDocumentPython`, so a typed call and a submitted snippet share the same receipts, the same
 * staging, the same package inspection and the same idempotency.
 *
 * The operation ID comes from the Pi Durable conversation and call identity, never from an argument:
 * a model cannot choose its own replay identity. The rules the tools enforce, and where:
 *
 * - **A lease, not a path.** A file reference is a FileStore id with the version, name, hash and size
 *   the lease pinned; all five are checked against the lease before the run. A reference the lease
 *   does not grant is `ungranted-input`, and the output is one staging file name, never a directory.
 * - **Drafts and proposals, never publications.** `create_presentation` writes a new file (a draft);
 *   `edit_presentation` and `compose_presentation` propose a new immutable version of a leased file
 *   and leave it unpublished. All report `published: false`, and the result validator refuses
 *   anything else.
 * - **Bounded only.** `read_presentation` and `preview_presentation` answer with a page: page size,
 *   cursor and total. The validator refuses a page that is inconsistent with itself.
 * - **Nothing is edited in place.** Every mutating call commits a new immutable version; the source
 *   version is untouched, and one refusal leaves it byte-identical.
 *
 * Two things these tools say plainly rather than implying:
 *
 * - **No bitmap renderer exists here.** `preview_presentation` is a *structural* preview and the
 *   result carries `rendering.bitmap: false` with the reason; the validator refuses a worker that
 *   claims otherwise. Overflow is computed as an estimate and reported, or reported as a limit when
 *   it cannot be computed — and the validator refuses an uncomputed overflow with no reason.
 * - **A copy keeps its source's display name**, so `shapeId` addresses a shape whose name is no
 *   longer unique (the shape id comes back in the step's evidence). Name addressing refuses an
 *   ambiguity instead of guessing.
 */

import { type TSchema, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type {
  DocumentRunCommitted,
  DocumentRunRefused,
  DocumentService,
} from "./document-service.js";
import { DocumentError } from "./errors.js";
import type { DocumentLease } from "./lease.js";
import { operationIdForCall } from "./operation.js";
import {
  COMPARE_PRESENTATION,
  COMPOSE_PRESENTATION,
  CREATE_PRESENTATION,
  EDIT_PRESENTATION,
  INSPECT_PRESENTATION,
  MAX_PPTX_PAGE,
  PPTX_COMPOSE_MODES,
  PPTX_DIFF_DETAILS,
  PPTX_OPERATIONS,
  type PptxBeforeAfter,
  type PptxDiff,
  type PptxOperation,
  type PptxPreservation,
  type PptxProgram,
  type PptxResult,
  PREVIEW_PRESENTATION,
  parsePptxResult,
  pptxProgram,
  pptxResultRef,
  READ_PRESENTATION,
} from "./pptx-operations.js";
import type { LeaseLookup } from "./run-document-python.js";

/**
 * The reply budget. A deck-shaped result is intrinsically richer than a document-shaped one — every
 * package part has a hash, and a before/after preview is per slide — so the PowerPoint budget is
 * larger than the Word tools' 16 KB rather than dropping evidence a reviewer needs. Anything above
 * this is still trimmed by `boundedBody`, which names what it left out; the whole result is always
 * in the receipt.
 */
const MAX_TOOL_TEXT = 32_000;

/** The keys a too-large reply gives up, in the order it gives them up. */
const DROPPABLE = ["patch", "overflow", "reopened", "worker", "wrote"] as const;

/** What the PowerPoint tools need: the injected service and the host's lease lookup. */
export interface PptxToolOptions {
  readonly service: DocumentService;
  readonly leaseFor: (lookup: LeaseLookup) => Promise<DocumentLease | undefined>;
}

// -- schemas ---------------------------------------------------------------------------------------

const FileRef = Type.Object(
  {
    fileId: Type.String({ minLength: 1, description: "The FileStore file id the lease pinned." }),
    versionId: Type.String({
      minLength: 1,
      description: "The immutable version id the lease pinned.",
    }),
    name: Type.String({ minLength: 1, description: "The leased file name, e.g. deck.pptx." }),
    sha256: Type.String({
      minLength: 1,
      description: "The version's sha256, as the lease pinned it.",
    }),
    size: Type.Integer({ minimum: 0, description: "The version's size in bytes." }),
  },
  { additionalProperties: false },
);

const AnchorText = Type.Object(
  {
    text: Type.String({
      minLength: 1,
      description:
        "The exact literal text of one paragraph. Refused when it matches nothing, or more than once.",
    }),
  },
  { additionalProperties: false },
);

const AnchorBlock = Type.Object(
  {
    part: Type.String({
      minLength: 1,
      description: "The slide part, e.g. /ppt/slides/slide2.xml.",
    }),
    block_index: Type.Integer({
      minimum: 0,
      description: "The block index read_presentation reported.",
    }),
    content_hash: Type.String({
      minLength: 8,
      description:
        "The block's content_hash from read_presentation; a mismatch refuses as stale-anchor.",
    }),
    version: Type.Optional(
      Type.Integer({ minimum: 0, description: "The anchor schema version the read reported." }),
    ),
    locator: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "The container identity and paragraph coordinates the read reported.",
      }),
    ),
  },
  { additionalProperties: false },
);

const Anchor = Type.Union([AnchorText, AnchorBlock], {
  description:
    "Where the edit lands: by exact paragraph text, or by a block read_presentation reported (preferred — a stale one refuses).",
});

const FooterOptions = {
  footer: Type.Optional(Type.String({ description: "Literal footer text; omit to remove it." })),
  slideNumber: Type.Optional(Type.Boolean({ description: "Write a live slide-number field." })),
  dateFormat: Type.Optional(
    Type.String({ description: "A datetime..datetime13 token for an auto-updating date." }),
  ),
  fixedDate: Type.Optional(
    Type.String({ description: "Literal date text (the dialog's Fixed mode)." }),
  ),
  skipTitleSlides: Type.Optional(
    Type.Boolean({ description: "The dialog's \"Don't show on title slide\"." }),
  ),
};

const shapeTarget = {
  shape: Type.Optional(
    Type.String({
      minLength: 1,
      description: "The shape's display name; refused when more than one shape has it.",
    }),
  ),
  shapeId: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "The stable shape id, for a shape whose display name is no longer unique.",
    }),
  ),
};

const StepSchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal("replaceText"),
        anchor: Anchor,
        find: Type.String({ minLength: 1 }),
        replace: Type.String({
          description: "The replacement, or the empty string to delete the match.",
        }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("replaceTextEverywhere"),
        find: Type.String({ minLength: 1 }),
        replace: Type.String(),
        includeNotes: Type.Optional(
          Type.Boolean({ description: "Also cover existing notes slides." }),
        ),
        expect: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "Refuse unless exactly this many occurrences were replaced, so drift cannot pass silently.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("writeNotes"),
        slide: Type.Integer({ minimum: 0, description: "The 0-based slide position." }),
        text: Type.String({
          description: 'Speaker-notes body text; "\\n" starts a new paragraph.',
        }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("addSlide"),
        layout: Type.Optional(
          Type.String({ description: "A layout by unique exact name; default Title and Content." }),
        ),
        at: Type.Optional(Type.Integer({ minimum: 0, description: "Move it to this position." })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("cloneSlide"),
        slide: Type.Integer({ minimum: 0 }),
        at: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal("deleteSlide"), slide: Type.Integer({ minimum: 0 }) },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("moveSlide"),
        slide: Type.Integer({ minimum: 0 }),
        to: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("rebindLayout"),
        slide: Type.Integer({ minimum: 0 }),
        layout: Type.String({ minLength: 1, description: "The destination layout's exact name." }),
        orphanPolicy: Type.Optional(
          Type.Union([Type.Literal("refuse"), Type.Literal("bake")], {
            description:
              "What to do with a source placeholder the layout has no home for: refuse (default), or bake it to a free shape.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("applyFooters"),
        slide: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "One slide's position, or omit for every slide (Apply to All).",
          }),
        ),
        ...FooterOptions,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("deleteShape"),
        slide: Type.Integer({ minimum: 0 }),
        ...shapeTarget,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("moveShape"),
        slide: Type.Integer({ minimum: 0 }),
        to: Type.Integer({ minimum: 0, description: "The z-order index to move it to." }),
        ...shapeTarget,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("copyShape"),
        slide: Type.Integer({ minimum: 0 }),
        ...shapeTarget,
      },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      "One edit step. Steps apply in the order given, each validating its own target before anything is written.",
  },
);

const BlockSchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal("paragraph"),
        text: Type.String({ minLength: 1 }),
        level: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("bullets"),
        items: Type.Array(
          Type.Object(
            {
              text: Type.String({ minLength: 1 }),
              level: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("table"),
        rows: Type.Array(Type.Array(Type.String()), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
  ],
  { description: "One block of a new draft slide, applied in order." },
);

const SlideSchema = Type.Object(
  {
    title: Type.Optional(
      Type.String({ minLength: 1, description: "The title placeholder's text." }),
    ),
    layout: Type.Optional(
      Type.String({
        minLength: 1,
        description: "A layout by unique exact name; omitted uses Title and Content.",
      }),
    ),
    notes: Type.Optional(Type.String({ description: "Speaker notes for this slide." })),
    blocks: Type.Optional(Type.Array(BlockSchema, { maxItems: 200 })),
  },
  { additionalProperties: false },
);

const paging = {
  cursor: Type.Optional(
    Type.Integer({ minimum: 0, description: "The nextCursor a previous page reported, or 0." }),
  ),
  pageSize: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_PPTX_PAGE,
      description: `1 to ${MAX_PPTX_PAGE} slides per page.`,
    }),
  ),
};

const detailParameter = Type.Optional(
  Type.Union(
    PPTX_DIFF_DETAILS.map((detail) => Type.Literal(detail)),
    {
      description:
        "How deep the deck diff goes: structure, text (default), or full (+ per-run resolved formatting).",
    },
  ),
);

const INSPECT_PARAMETERS = Type.Object(
  { ref: FileRef },
  { additionalProperties: false, description: "The leased .pptx to inspect." },
);

const READ_PARAMETERS = Type.Object(
  {
    ref: FileRef,
    section: Type.Union(
      [
        Type.Literal("slides"),
        Type.Literal("text"),
        Type.Literal("shapes"),
        Type.Literal("notes"),
        Type.Literal("media"),
      ],
      {
        description:
          "What to page through: slides (order and layout), text blocks, shapes, speaker notes, or media references.",
      },
    ),
    ...paging,
  },
  { additionalProperties: false, description: "A bounded page of one section of a leased .pptx." },
);

const CREATE_PARAMETERS = Type.Object(
  {
    output: Type.String({
      minLength: 1,
      description: "The new draft's file name, e.g. close-summary.pptx.",
    }),
    slides: Type.Array(SlideSchema, { minItems: 1 }),
  },
  { additionalProperties: false, description: "A new PowerPoint draft, built from typed slides." },
);

const EDIT_PARAMETERS = Type.Object(
  {
    ref: FileRef,
    output: Type.String({
      minLength: 1,
      description: "The proposal's file name, e.g. close-summary.pptx.",
    }),
    steps: Type.Array(StepSchema, { minItems: 1 }),
    detail: detailParameter,
  },
  {
    additionalProperties: false,
    description: "An edit of a leased .pptx, as an unpublished proposal.",
  },
);

const PREVIEW_PARAMETERS = Type.Object(
  { ref: FileRef, ...paging },
  {
    additionalProperties: false,
    description: "A bounded structural preview of a leased .pptx — text, shapes, notes, media.",
  },
);

const COMPARE_PARAMETERS = Type.Object(
  { from: FileRef, to: FileRef, detail: detailParameter },
  {
    additionalProperties: false,
    description: "Two leased .pptx versions to diff, with before/after previews of what changed.",
  },
);

const COMPOSE_PARAMETERS = Type.Object(
  {
    into: FileRef,
    from: FileRef,
    output: Type.String({ minLength: 1, description: "The proposal's file name." }),
    mode: Type.Union(
      PPTX_COMPOSE_MODES.map((mode) => Type.Literal(mode)),
      {
        description:
          "How the imported slides arrive: adopt_theme (rebind to a destination layout), keep_appearance (transplant the source layout chain), or bake (materialize resolved formatting).",
      },
    ),
    notes: Type.Optional(Type.Boolean({ description: "Copy speaker notes (default true)." })),
    detail: detailParameter,
  },
  {
    additionalProperties: false,
    description: "Append one leased .pptx's slides into another, as an unpublished proposal.",
  },
);

// -- descriptions ----------------------------------------------------------------------------------

const REF_NOTE = [
  "Every operation takes a **file reference** (`fileId`, `versionId`, `name`, `sha256`, `size`) from this",
  "task's lease or from an earlier operation's output. It never takes a path or a URL: a reference the",
  "lease does not grant is refused, and no operation can widen the lease.",
].join("\n");

const RENDER_NOTE = [
  "There is **no bitmap renderer** in this workspace: a preview is structural, and an overflow report is",
  "a computed estimate from resolved font size and box geometry (or an explicit limit when it cannot be",
  "computed). The result says so in `rendering`.",
].join("\n");

const DESCRIPTIONS: Readonly<Record<PptxOperation, string>> = {
  inspect: [
    "Summarise a leased PowerPoint (.pptx) deck: slide, master, layout, shape, text-block, notes, media,",
    "picture, table and chart counts; the bounded slide outline with each slide's layout and title; the",
    "media references with their part hashes; which text is a blind region (table-cell text, whose",
    "effective formatting this version cannot resolve); and how much text is estimated to overflow its box.",
    "",
    REF_NOTE,
    "",
    "- Read-only: nothing is written and no file is created.",
    "- The reply is bounded — the outline and the media list are capped, and say so.",
    RENDER_NOTE,
  ].join("\n"),
  read: [
    "Read a leased PowerPoint (.pptx) deck in **bounded pages**: slide order and layout, every text block",
    "with its effective font, the shape inventory, speaker notes, or the media references. Each answer",
    "carries a page size, the cursor it started at, the section's total, and the next cursor, so a long",
    "deck is walked page by page rather than dumped into one reply.",
    "",
    REF_NOTE,
    "",
    '- `section: "text"` reports inherited formatting **resolved** (size, name, colour) with a `resolved`',
    "  flag per value, and each block carries a structural `anchor` so `edit_presentation` can address it.",
    '- `section: "text"` marks table-cell text `blind: true`: its effective values are unresolvable here.',
    '- `section: "media"` reports each image/media/video/audio reference with its part sha256.',
    "- Read-only: nothing is written.",
  ].join("\n"),
  create: [
    "Create a new PowerPoint (.pptx) **draft** from typed slides: a title, paragraphs, bullet lists, tables",
    "and speaker notes. The draft is a new immutable file — it has no source version and nothing publishes",
    "it.",
    "",
    "- `output` is a single file name; the task's lease decides whether a pptx output is permitted.",
    "- `layout` names a layout exactly; a name this deck does not define refuses with `target-not-found`",
    "  rather than falling back to the first layout.",
    "- The result reports the draft's name and sha256, the structure it built, where each slide's content",
    "  landed, and a reopen witness.",
    "- A new deck is a draft, never a published business file.",
  ].join("\n"),
  edit: [
    "Edit a leased PowerPoint (.pptx) deck into an **unpublished proposal**, as a new immutable version.",
    "The source version is never modified; the proposal stays unpublished until the review surface",
    "(RASF-3285) publishes it.",
    "",
    REF_NOTE,
    "",
    "- Steps: `replaceText` (anchored, formatting-preserving, and stale-anchor-refusing),",
    "  `replaceTextEverywhere`, `writeNotes`, `addSlide`, `cloneSlide`, `deleteSlide`, `moveSlide`,",
    "  `rebindLayout`, `applyFooters`, `deleteShape`, `moveShape`, `copyShape`. They apply in the order",
    "  given; each validates its own target before anything is written.",
    "- `replaceText` addresses a block by the `anchor` a read reported, or by that paragraph's exact text.",
    "  An anchor that no longer matches its content refuses with `stale-anchor`.",
    "- PowerPoint carries no revision markup, so there is no redline: review gets the structural change",
    "  set, a slide-level diff, and a before/after structural preview of each changed slide.",
    "- The result reports source and output sha256, the change set (parts added, removed, changed and left",
    "  byte-identical, each with its before and after sha256), and a reopen witness.",
    "- Untouched parts come back byte-identical — layouts, masters, theme, media and untouched slides —",
    "  because the edit saves through the fork's narrow `patch_save`.",
    RENDER_NOTE,
  ].join("\n"),
  preview: [
    "Preview a leased PowerPoint (.pptx) deck as bounded, **structural** slide previews: `T:`/`B:`/`P:`/`TC:`",
    "lines for title, body, paragraph and table-cell text, `TB<rows>x<columns>:` for a table, `PIC:<ext>:`",
    "for a picture and `CH:<type>:` for a chart, plus each slide's shape inventory, speaker notes, media",
    "references and estimated overflow. Paged like `read_presentation`.",
    "",
    REF_NOTE,
    "",
    RENDER_NOTE,
    "",
    "- Read-only: nothing is written. A preview is derived from the exact leased version, not a path.",
  ].join("\n"),
  compare: [
    "Diff two leased PowerPoint (.pptx) versions: the structural change set (parts added, removed, changed",
    "and left byte-identical, each hashed before and after), the fork's own slide-level diff, and a",
    "**before/after structural preview of every changed slide**.",
    "",
    REF_NOTE,
    "",
    "- Use it to review a proposal against the version it came from, before anyone publishes.",
    "- Slides are matched by their permanent slide id, so a pair is the same slide rather than the same",
    "  position.",
    "- Both versions must be leased to this task.",
    RENDER_NOTE,
  ].join("\n"),
  compose: [
    "Append one leased PowerPoint (.pptx) deck's slides into another, as an **unpublished proposal** that",
    "is a new immutable version of the destination.",
    "",
    REF_NOTE,
    "",
    "- `mode` is required and has no default: `adopt_theme` rebinds each imported slide to a destination",
    "  layout, `keep_appearance` transplants the source layout/master/theme chain, and `bake` materializes",
    "  the resolved formatting as explicit local properties.",
    "- Media always copies, never shared across packages; a relationship the import cannot carry refuses",
    "  with `relationship-policy` before anything is written.",
    "- The result reports each import's `ImportReport`, the structural change set, the slide-level diff and",
    "  a before/after preview of the slides that arrived.",
    "- The destination is never modified: the source version is untouched and the proposal is unpublished.",
  ].join("\n"),
};

// -- the tools -------------------------------------------------------------------------------------

/**
 * The seven typed PowerPoint tools. Every one is `replay: "safe"`: the service is idempotent by
 * operation ID, so an interrupted call that reruns resolves to the same committed receipt instead of
 * a second edit.
 */
export function pptxTools(options: PptxToolOptions): readonly ToolRegistration[] {
  return [
    pptxTool("inspect", INSPECT_PRESENTATION, INSPECT_PARAMETERS, options),
    pptxTool("read", READ_PRESENTATION, READ_PARAMETERS, options),
    pptxTool("create", CREATE_PRESENTATION, CREATE_PARAMETERS, options),
    pptxTool("edit", EDIT_PRESENTATION, EDIT_PARAMETERS, options),
    pptxTool("preview", PREVIEW_PRESENTATION, PREVIEW_PARAMETERS, options),
    pptxTool("compare", COMPARE_PRESENTATION, COMPARE_PARAMETERS, options),
    pptxTool("compose", COMPOSE_PRESENTATION, COMPOSE_PARAMETERS, options),
  ];
}

/** A type alias, not an interface, so it keeps the implicit index signature `JsonValue` needs. */
type PptxToolDetails = {
  operationId: string;
  operation: string;
  files?: string[];
  worker?: string;
  truncated?: boolean;
  code?: string;
};

type PptxToolResult = {
  readonly output: { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
  readonly details: PptxToolDetails;
};

function pptxTool(
  operation: PptxOperation,
  name: string,
  parameters: TSchema,
  options: PptxToolOptions,
): ToolRegistration {
  return defineTool({
    name,
    description: DESCRIPTIONS[operation],
    parameters,
    replay: "safe",
    execute: async (args: unknown, api): Promise<PptxToolResult> => {
      const taskId = String(api.taskId);
      const conversationId = String(api.conversationId);
      const operationId = operationIdForCall({ conversationId, callId: api.callId });

      const lease = await options.leaseFor({ taskId, conversationId });
      if (lease === undefined) {
        return refusalResult(
          operation,
          operationId,
          "no-lease",
          "this task has no document lease, so no PowerPoint file was granted. Ask the host for one.",
        );
      }

      let program: PptxProgram;
      try {
        program = pptxProgram(operation, args, lease);
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
      if (outcome.kind === "refused") return refusedOutcome(outcome, operation);

      try {
        const result = parsePptxResult(
          operation,
          outcome.receipt.result,
          program.sources.map(pptxResultRef),
        );
        return committed(operation, operationId, taskId, outcome, result);
      } catch (error) {
        return refused(error, operation, operationId);
      }
    },
  }) as unknown as ToolRegistration;
}

function committed(
  operation: PptxOperation,
  operationId: string,
  taskId: string,
  outcome: DocumentRunCommitted,
  result: PptxResult,
): PptxToolResult {
  const receipt = outcome.receipt;
  const compose = (value: PptxResult | null): Record<string, unknown> => ({
    ok: true,
    operation,
    operationId,
    taskId,
    ...(value === null ? {} : { result: value }),
    wrote: receipt.outputs.map((entry) => ({
      fileId: entry.fileId,
      versionId: entry.versionId,
      name: entry.name,
      format: entry.format,
      size: entry.size,
      sha256: entry.sha256,
      versionOf: entry.sourceVersionId,
    })),
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
  const { text, truncated } = boundedBody(compose, result);
  return {
    output: [{ type: "text", text }],
    details: {
      operationId,
      operation,
      files: receipt.outputs.map((entry) => entry.fileId),
      worker: receipt.worker.image,
      ...(truncated ? { truncated: true } : {}),
    },
  };
}

/**
 * A reply a model reads is JSON, so trimming it must keep it JSON. When a body does not fit, the verbose
 * review *lines* go first — their counts, the change set, the hashes and the file ids all stay — then the
 * droppable keys in priority order, and the body names what it left out. Slicing the string instead would
 * leave a model with a deck it cannot parse and no way to tell.
 */
function boundedBody(
  compose: (value: PptxResult | null) => Record<string, unknown>,
  result: PptxResult,
): { text: string; truncated: boolean } {
  const fits = (value: Record<string, unknown>): boolean =>
    JSON.stringify(value, null, 2).length <= MAX_TOOL_TEXT;
  const full = compose(result);
  if (fits(full)) return { text: JSON.stringify(full, null, 2), truncated: false };

  const omitted: string[] = [
    "the preview lines and overflow items, which read_presentation and preview_presentation page",
    "the byte-identical parts' hash sample, which the change set and the receipt both hold",
  ];
  // The cosmetic review lines go first: counts, hashes, step evidence and file ids all stay.
  let body = compose(light(result));
  if (!fits(body)) {
    // Only then the step evidence and the diff's per-slide deltas, which the receipt still holds.
    body = compose(reduced(result));
    omitted.push("the per-step change evidence and the diff's per-slide deltas");
  }
  for (const key of DROPPABLE) {
    if (fits(body)) break;
    if (key in body) {
      delete body[key];
      omitted.push(key);
    }
  }
  if (!fits(body)) {
    return {
      text: JSON.stringify(
        {
          ok: true,
          operation: result.operation,
          truncated: true,
          omitted:
            "every field; the run ledger holds the receipt and the versions hold the artifacts",
        },
        null,
        2,
      ),
      truncated: true,
    };
  }
  body.omitted = omitted;
  body.truncated = true;
  return { text: JSON.stringify(body, null, 2), truncated: true };
}

/** The result with its cosmetic review lines reduced to the counts that describe them. */
function light(result: PptxResult): PptxResult {
  switch (result.operation) {
    case "edit":
      return {
        ...result,
        diff: withoutSlideChanges(result.diff),
        preview: withoutLines(result.preview),
        preservation: withoutPartHashes(result.preservation),
      };
    case "compose":
      return {
        ...result,
        imports: result.imports.map((entry) => ({ ...entry, runShifts: [] })),
        diff: withoutSlideChanges(result.diff),
        preview: withoutLines(result.preview),
        preservation: withoutPartHashes(result.preservation),
      };
    case "compare":
      return {
        ...result,
        diff: withoutSlideChanges(result.diff),
        preview: withoutLines(result.preview),
      };
    case "inspect":
      return { ...result, overflowSlides: [], mediaOutline: [] };
    default:
      return result;
  }
}

/** The light result with its per-step evidence removed too: the last resort before dropping fields. */
function reduced(result: PptxResult): PptxResult {
  const lighter = light(result);
  if (lighter.operation === "edit") {
    return {
      ...lighter,
      changes: lighter.changes.map((change) => ({ ...change, evidence: {} })),
    };
  }
  return lighter;
}

function withoutPartHashes(preservation: PptxPreservation): PptxPreservation {
  return {
    ...preservation,
    byteIdentical: [],
    byteIdenticalHashed: 0,
    byteIdenticalTruncated: true,
  };
}

function withoutSlideChanges(diff: PptxDiff): PptxDiff {
  return { ...diff, slideChanges: [] };
}

function withoutLines(preview: PptxBeforeAfter): PptxBeforeAfter {
  return {
    ...preview,
    changed: preview.changed.map((pair) => ({
      ...pair,
      change: pair.change,
      before: withoutSlideLines(pair.before),
      after: withoutSlideLines(pair.after),
    })),
    added: preview.added.map((entry) => ({ ...entry, after: undefined })),
    removed: preview.removed.map((entry) => ({ ...entry, before: undefined })),
  };
}

function withoutSlideLines(
  slide: PptxBeforeAfter["changed"][number]["before"],
): PptxBeforeAfter["changed"][number]["before"] {
  return {
    ...slide,
    lines: [],
    linesTruncated: true,
    media: [],
    overflow: { ...slide.overflow, items: [] },
  };
}

function refusedOutcome(outcome: DocumentRunRefused, operation: PptxOperation): PptxToolResult {
  return refusalResult(operation, outcome.operationId, outcome.code, outcome.message);
}

function refused(error: unknown, operation: PptxOperation, operationId: string): PptxToolResult {
  if (error instanceof DocumentError) {
    return refusalResult(operation, operationId, error.code, error.message);
  }
  throw error;
}

function refusalResult(
  operation: PptxOperation,
  operationId: string,
  code: string,
  message: string,
): PptxToolResult {
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

/** The typed tools' names, in the order they are registered. */
export const PPTX_TOOL_REGISTRATIONS = [
  INSPECT_PRESENTATION,
  READ_PRESENTATION,
  CREATE_PRESENTATION,
  EDIT_PRESENTATION,
  PREVIEW_PRESENTATION,
  COMPARE_PRESENTATION,
  COMPOSE_PRESENTATION,
] as const;

/** Every typed operation, in the order the tools register them. Used by the contract tests. */
export const PPTX_TOOL_ORDER: readonly PptxOperation[] = PPTX_OPERATIONS;
