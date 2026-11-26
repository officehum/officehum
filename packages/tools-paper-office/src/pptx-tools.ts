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

import type { ToolRegistration } from "@earendil-works/pi-durable";
import { arr, bool, int, lit, map, obj, opt, str, union, unknown } from "@earendil-works/pi-schema";
import {
  type DocumentToolFamily,
  type DocumentToolOptions,
  documentTool,
  fileRefSchema,
} from "./document-tool.js";
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
  type PptxResult,
  PREVIEW_PRESENTATION,
  parsePptxResult,
  pptxProgram,
  READ_PRESENTATION,
} from "./pptx-operations.js";

// -- schemas ---------------------------------------------------------------------------------------

const FileRef = fileRefSchema("deck.pptx");

const AnchorText = obj({
  text: str({
    minLength: 1,
    description:
      "The exact literal text of one paragraph. Refused when it matches nothing, or more than once.",
  }),
});

const AnchorBlock = obj({
  part: str({
    minLength: 1,
    description: "The slide part, e.g. /ppt/slides/slide2.xml.",
  }),
  block_index: int({
    minimum: 0,
    description: "The block index read_presentation reported.",
  }),
  content_hash: str({
    minLength: 8,
    description:
      "The block's content_hash from read_presentation; a mismatch refuses as stale-anchor.",
  }),
  version: opt(int({ minimum: 0, description: "The anchor schema version the read reported." })),
  locator: opt(
    map(unknown(), {
      description: "The container identity and paragraph coordinates the read reported.",
    }),
  ),
});

const Anchor = union([AnchorText, AnchorBlock], {
  description:
    "Where the edit lands: by exact paragraph text, or by a block read_presentation reported (preferred — a stale one refuses).",
});

const FooterOptions = {
  footer: opt(
    str({
      description:
        "Literal footer text, not empty; leave the field out to remove the footer (an empty string is refused).",
    }),
  ),
  slideNumber: opt(bool({ description: "Write a live slide-number field." })),
  dateFormat: opt(str({ description: "A datetime..datetime13 token for an auto-updating date." })),
  fixedDate: opt(str({ description: "Literal date text (the dialog's Fixed mode)." })),
  skipTitleSlides: opt(bool({ description: "The dialog's \"Don't show on title slide\"." })),
};

const shapeTarget = {
  shape: opt(
    str({
      minLength: 1,
      description: "The shape's display name; refused when more than one shape has it.",
    }),
  ),
  shapeId: opt(
    int({
      minimum: 0,
      description: "The stable shape id, for a shape whose display name is no longer unique.",
    }),
  ),
};

const StepSchema = union(
  [
    obj({
      kind: lit("replaceText"),
      anchor: Anchor,
      find: str({ minLength: 1 }),
      replace: str({
        description: "The replacement, or the empty string to delete the match.",
      }),
    }),
    obj({
      kind: lit("replaceTextEverywhere"),
      find: str({ minLength: 1 }),
      replace: str(),
      includeNotes: opt(bool({ description: "Also cover existing notes slides." })),
      expect: opt(
        int({
          minimum: 0,
          description:
            "Refuse unless exactly this many occurrences were replaced, so drift cannot pass silently.",
        }),
      ),
    }),
    obj({
      kind: lit("writeNotes"),
      slide: int({ minimum: 0, description: "The 0-based slide position." }),
      text: str({
        description: 'Speaker-notes body text; "\\n" starts a new paragraph.',
      }),
    }),
    obj({
      kind: lit("addSlide"),
      layout: opt(
        str({ description: "A layout by unique exact name; default Title and Content." }),
      ),
      at: opt(int({ minimum: 0, description: "Move it to this position." })),
    }),
    obj({
      kind: lit("cloneSlide"),
      slide: int({ minimum: 0 }),
      at: opt(int({ minimum: 0 })),
    }),
    obj({ kind: lit("deleteSlide"), slide: int({ minimum: 0 }) }),
    obj({
      kind: lit("moveSlide"),
      slide: int({ minimum: 0 }),
      to: int({ minimum: 0 }),
    }),
    obj({
      kind: lit("rebindLayout"),
      slide: int({ minimum: 0 }),
      layout: str({ minLength: 1, description: "The destination layout's exact name." }),
      orphanPolicy: opt(
        union([lit("refuse"), lit("bake")], {
          description:
            "What to do with a source placeholder the layout has no home for: refuse (default), or bake it to a free shape.",
        }),
      ),
    }),
    obj({
      kind: lit("applyFooters"),
      slide: opt(
        int({
          minimum: 0,
          description: "One slide's position, or omit for every slide (Apply to All).",
        }),
      ),
      ...FooterOptions,
    }),
    obj({
      kind: lit("deleteShape"),
      slide: int({ minimum: 0 }),
      ...shapeTarget,
    }),
    obj({
      kind: lit("moveShape"),
      slide: int({ minimum: 0 }),
      to: int({ minimum: 0, description: "The z-order index to move it to." }),
      ...shapeTarget,
    }),
    obj({
      kind: lit("copyShape"),
      slide: int({ minimum: 0 }),
      ...shapeTarget,
    }),
  ],
  {
    description:
      "One edit step. Steps apply in the order given, each validating its own target before anything is written.",
  },
);

const BlockSchema = union(
  [
    obj({
      kind: lit("paragraph"),
      text: str({ minLength: 1 }),
      level: opt(int({ minimum: 0, maximum: 8 })),
    }),
    obj({
      kind: lit("bullets"),
      items: arr(
        obj({
          text: str({ minLength: 1 }),
          level: opt(int({ minimum: 0, maximum: 8 })),
        }),
        { minItems: 1 },
      ),
    }),
    obj({
      kind: lit("table"),
      rows: arr(arr(str()), { minItems: 1 }),
    }),
  ],
  { description: "One block of a new draft slide, applied in order." },
);

const SlideSchema = obj({
  title: opt(str({ minLength: 1, description: "The title placeholder's text." })),
  layout: opt(
    str({
      minLength: 1,
      description:
        "A layout by unique exact name; omitted uses Title and Content, or Blank for a slide with no title and no blocks.",
    }),
  ),
  notes: opt(str({ description: "Speaker notes for this slide." })),
  blocks: opt(arr(BlockSchema, { maxItems: 200 })),
});

const paging = {
  cursor: opt(int({ minimum: 0, description: "The nextCursor a previous page reported, or 0." })),
  pageSize: opt(
    int({
      minimum: 1,
      maximum: MAX_PPTX_PAGE,
      description: `1 to ${MAX_PPTX_PAGE} slides per page.`,
    }),
  ),
};

const detailParameter = opt(
  union(
    PPTX_DIFF_DETAILS.map((detail) => lit(detail)),
    {
      description:
        "How deep the deck diff goes: structure, text (default), or full (+ per-run resolved formatting).",
    },
  ),
);

const INSPECT_PARAMETERS = obj({ ref: FileRef }, { description: "The leased .pptx to inspect." });

const READ_PARAMETERS = obj(
  {
    ref: FileRef,
    section: union([lit("slides"), lit("text"), lit("shapes"), lit("notes"), lit("media")], {
      description:
        "What to page through: slides (order and layout), text blocks, shapes, speaker notes, or media references.",
    }),
    ...paging,
  },
  { description: "A bounded page of one section of a leased .pptx." },
);

const CREATE_PARAMETERS = obj(
  {
    output: str({
      minLength: 1,
      description: "The new draft's file name, e.g. close-summary.pptx.",
    }),
    slides: arr(SlideSchema, { minItems: 1 }),
  },
  { description: "A new PowerPoint draft, built from typed slides." },
);

const EDIT_PARAMETERS = obj(
  {
    ref: FileRef,
    output: str({
      minLength: 1,
      description: "The proposal's file name, e.g. close-summary.pptx.",
    }),
    steps: arr(StepSchema, { minItems: 1 }),
    detail: detailParameter,
  },
  { description: "An edit of a leased .pptx, as an unpublished proposal." },
);

const PREVIEW_PARAMETERS = obj(
  { ref: FileRef, ...paging },
  { description: "A bounded structural preview of a leased .pptx — text, shapes, notes, media." },
);

const COMPARE_PARAMETERS = obj(
  { from: FileRef, to: FileRef, detail: detailParameter },
  { description: "Two leased .pptx versions to diff, with before/after previews of what changed." },
);

const COMPOSE_PARAMETERS = obj(
  {
    into: FileRef,
    from: FileRef,
    output: str({ minLength: 1, description: "The proposal's file name." }),
    mode: union(
      PPTX_COMPOSE_MODES.map((mode) => lit(mode)),
      {
        description:
          "How the imported slides arrive: adopt_theme (rebind to a destination layout), keep_appearance (transplant the source layout chain), or bake (materialize resolved formatting).",
      },
    ),
    notes: opt(bool({ description: "Copy speaker notes (default true)." })),
    detail: detailParameter,
  },
  { description: "Append one leased .pptx's slides into another, as an unpublished proposal." },
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
    "publishes it.",
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
    "  set, a slide-level diff, and a before/after structural preview of the changed, added and removed",
    "  slides (at most 8 of each per call; `preview.limitNote` says so, and the change set is complete).",
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
    "**before/after structural preview of the changed, added and removed slides** (at most 8 of each per",
    "call; `preview.limitNote` says so, and the change set itself is complete).",
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

// -- trimming an oversized reply -------------------------------------------------------------------

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
function reduced(lighter: PptxResult): PptxResult {
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

// -- the tools -------------------------------------------------------------------------------------

/**
 * The reply budget. A deck-shaped result is intrinsically richer than a document-shaped one — every
 * package part has a hash, and a before/after preview is per slide — so the PowerPoint budget is
 * larger than the Word tools' 16 KB rather than dropping evidence a reviewer needs. Anything above
 * this is still trimmed by `boundedBody`, which names what it left out; the whole result is always
 * in the receipt.
 */
const MAX_TOOL_TEXT = 32_000;

const FAMILY: DocumentToolFamily<PptxOperation, PptxResult> = {
  subject: "PowerPoint file",
  descriptions: DESCRIPTIONS,
  program: pptxProgram,
  parse: parsePptxResult,
  trim: {
    maxText: MAX_TOOL_TEXT,
    reductions: [
      {
        // The cosmetic review lines go first: counts, hashes, step evidence and file ids all stay.
        omits: [
          "the preview lines and overflow items, which read_presentation and preview_presentation page",
          "the byte-identical parts' hash sample, which the change set and the receipt both hold",
          "the diff's per-slide deltas",
        ],
        apply: light,
      },
      {
        // Only then the step evidence, which the receipt still holds.
        omits: ["the per-step change evidence"],
        apply: reduced,
      },
    ],
    resultKeys: ["patch", "overflow"],
  },
  narrow: {
    inspect: "Read the deck a section at a time with read_presentation.",
    read: "Ask for a smaller pageSize.",
    create: "Read the draft back in pages with read_presentation.",
    edit: 'Ask for `detail: "structure"`, or edit in fewer steps per call.',
    preview: "Ask for a smaller pageSize.",
    compare: 'Ask for `detail: "structure"`, or read each version in pages with read_presentation.',
    compose: 'Ask for `detail: "structure"`, or import fewer slides per call.',
  },
};

/** The seven typed PowerPoint tools, each replay-safe on the shared `documentTool` path. */
export function pptxTools(options: DocumentToolOptions): readonly ToolRegistration[] {
  return [
    documentTool(FAMILY, "inspect", INSPECT_PRESENTATION, INSPECT_PARAMETERS, options),
    documentTool(FAMILY, "read", READ_PRESENTATION, READ_PARAMETERS, options),
    documentTool(FAMILY, "create", CREATE_PRESENTATION, CREATE_PARAMETERS, options),
    documentTool(FAMILY, "edit", EDIT_PRESENTATION, EDIT_PARAMETERS, options),
    documentTool(FAMILY, "preview", PREVIEW_PRESENTATION, PREVIEW_PARAMETERS, options),
    documentTool(FAMILY, "compare", COMPARE_PRESENTATION, COMPARE_PARAMETERS, options),
    documentTool(FAMILY, "compose", COMPOSE_PRESENTATION, COMPOSE_PARAMETERS, options),
  ];
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
