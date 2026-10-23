"""The typed PowerPoint adapter for the Paper Office worker (paper-pptx).

Seven operations, one per call: ``inspect``, ``read``, ``create``, ``edit``, ``preview``,
``compare`` and ``compose``. Each takes a **leased input reference** — a FileStore version id
with the name, hash and size the lease pinned — never a server path, and answers with bounded
JSON. Nothing here calls a model, so the same operation and parameters produce the same result,
and the worker that runs it binds the code hash, the argument hash and the leased source hashes
into one receipt.

The one thing worth stating plainly, because it looks like a contradiction: this module *does*
handle paths, but it never reads one from its parameters. ``documents.open_input(version_id)``
returns the read-only copy of a leased version inside this run's input directory, and
``documents.declare_output(name, "pptx", edit_of=...)`` returns a reserved path inside the run's
staging directory. The tool above this module takes file refs; the workspace API is what turns
one into a path, and it will only do that for a version the lease names.

What is read truthfully, rather than guessed at: ``pptx.inspect`` resolves inherited formatting
through the documented inheritance walk, so a run's effective size, name and colour are reported
with provenance and an unresolvable value says ``resolved=False`` instead of inventing a default.
``pptx.inspect.inspect_deck`` gives the per-slide shape inventory, and
``pptx.inspect.inspect_text`` gives every text block with a structural anchor (``part``,
``block_index``, ``content_hash``, ``locator``) — the anchor ``pptx.edit`` consumes. Table-cell
text is a *blind region* for effective values (the resolver does not walk table styles), and it is
reported as blind, never as resolved.

What is preserved, and the evidence for it: an ``edit`` or a ``compose`` writes through
``pptx.package.patch_save``, which gives back the original bytes of every part semantically
identical to its counterpart in the source, so relationships, layouts, masters, theme, media and
untouched slides survive the open/edit/save cycle. The structural change set the result carries is
``pptx.package.diff_package``'s own part-by-part comparison joined to the sha256 of each part
before and after, so preservation is argued with bytes rather than by eye. The slide-level change
set and the before/after preview of changed slides come from ``pptx.diff.diff_decks``, the fork's
own differ — this module does not implement a second one.

Anchored text replacement is ``pptx.edit.replace_text_at``, which refuses a stale anchor
(``StaleAnchorError``) rather than editing whatever moved into its place: the correct answer to
"edit a proposal made against an older version". Deck composition is ``pptx.compose.append_deck``,
whose ``ImportReport`` ledger is what keeps a cross-deck import's relationship policy checkable.

**No bitmap rendering exists in this interpreter.** There is no rasteriser in the fork, and its
only measurement path, ``TextFrame.fit_text``, is a fit *application* rather than a report: it
mutates the frame and resolves a host-installed font, so it can be neither read-only nor bound
into a receipt. The worker has no isolation to run a real renderer (RASF-3111). So a "preview" here is a
**structural** preview — slide text with structure markers, the shape inventory with effective
formatting, speaker notes, media references, and the per-slide change set — and overflow is
**computed and reported** as an estimate from resolved font size, box geometry and the frame's own
declared autofit state, or reported as an explicit limit when the estimate cannot be made (an
inherited geometry, an unresolved font, text that is a blind region). Every result carries a
``rendering`` block saying exactly that.

Bounded by construction: every page has a size, a cursor and a total; every string is truncated
with an explicit flag; the diff, the preview, the overflow list and the preservation list carry
budgets and say what they left out. A huge deck cannot blow up a reply.

Refusals are ``documents.WorkspaceError`` with a stable code — ``stale-anchor``,
``ambiguous-target``, ``target-not-found``, ``package-limit``, ``relationship-policy``,
``boundary-violation``, ``unsupported-structure``, ``malformed-package`` — or the workspace's own
codes for a bad name, a bad lease reference or a read-only source. Every one of them leaves the
source bytes unchanged: nothing here writes outside the staging directory, and the workspace hashes
the inputs again after the run.
"""

from __future__ import annotations

import hashlib
import math
import os
import zipfile
from typing import Any, Dict, List, NoReturn, Optional, Sequence, Tuple

import pptx
import pptx.package as paper_package
from pptx import compose as deck_compose
from pptx import diff as deck_diff
from pptx import edit as edit_ops
from pptx import inspect as deck_inspect
from pptx.enum.text import MSO_AUTO_SIZE
from pptx.errors import (
    AmbiguousTargetError,
    BoundaryViolationError,
    PackageLimitError,
    PaperRefusal,
    RelationshipPolicyError,
    StaleAnchorError,
    TargetNotFoundError,
    UnsupportedStructureError,
    materialize_slides,
)
from pptx.inspect import BlockAnchor
from pptx.util import Inches

import officehum_documents as documents

try:  # lxml raises this out of the parser; paper-pptx never wraps it
    from lxml.etree import XMLSyntaxError
except ImportError:  # pragma: no cover - lxml is a hard dependency of the fork
    XMLSyntaxError = ValueError  # type: ignore[assignment, misc]

SCHEMA = "paper_pptx_operation"
VERSION = 1

MAX_PAGE = 50
DEFAULT_PAGE = 20
MAX_ITEM_TEXT = 400
MAX_LABEL_TEXT = 200
MAX_LABEL_LINES = 200
MAX_PREVIEW_SHAPES = 60
MAX_PREVIEW_MEDIA = 40
MAX_CHANGED_SLIDES = 8
MAX_DIFF_SLIDE_CHANGES = 20
MAX_DIFF_ENTRIES = 10
MAX_STEPS = 32
MAX_CREATED_SLIDES = 100
MAX_CREATED_BLOCKS = 200
MAX_CELLS = 64
MAX_TEXT = 4_000
MAX_OUTLINE = 100
MAX_MEDIA = 100
MAX_ANCHORS = 10
MAX_PART_HASHES = 24
MAX_RUNS = 20
MAX_OVERFLOW_ITEMS = 20
MAX_OVERFLOW_SLIDES = 4
MAX_CHILDREN = 40

READ_SECTIONS = ("slides", "text", "shapes", "notes", "media")
BLOCK_KINDS = ("paragraph", "bullets", "table")
COMPOSE_MODES = ("adopt_theme", "keep_appearance", "bake")
DIFF_DETAILS = ("structure", "text", "full")

STEP_FIELDS: Dict[str, Tuple[Tuple[str, ...], Tuple[str, ...]]] = {
    "replaceText": (("anchor", "find", "replace"), ()),
    "replaceTextEverywhere": (("find", "replace"), ("includeNotes", "expect")),
    "writeNotes": (("slide", "text"), ()),
    "addSlide": ((), ("layout", "at")),
    "cloneSlide": (("slide",), ("at",)),
    "deleteSlide": (("slide",), ()),
    "moveSlide": (("slide", "to"), ()),
    "rebindLayout": (("slide", "layout"), ("orphanPolicy",)),
    "applyFooters": ((), ("slide", "footer", "slideNumber", "dateFormat", "fixedDate", "skipTitleSlides")),
    "deleteShape": (("slide",), ("shape", "shapeId")),
    "moveShape": (("slide", "to"), ("shape", "shapeId")),
    "copyShape": (("slide",), ("shape", "shapeId")),
}

REF_KEYS = ("fileId", "versionId", "name", "sha256", "size")
ANCHOR_KEYS = ("part", "block_index", "content_hash", "version", "locator")

DEFAULT_LAYOUT = "Title and Content"
FALLBACK_LAYOUT = "Blank"

#: The media relationship types a slide (or a notes slide) can carry a reference under.
MEDIA_RELTYPES = {
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image": "image",
    "http://schemas.microsoft.com/office/2007/relationships/media": "media",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video": "video",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio": "audio",
}
MEDIA_FRAGMENTS = ("/media/",)

TITLE_FAMILY = ("TITLE", "CENTER_TITLE")
BODY_FAMILY = ("BODY", "OBJECT", "SUBTITLE", "VERTICAL_BODY", "VERTICAL_OBJECT")

#: The overflow estimate's one documented assumption pair, reported in every estimate so a caller
#: can see exactly what was assumed rather than trusting a number.
AVERAGE_GLYPH_ADVANCE_EM = 0.5
LINE_HEIGHT_EM = 1.2
EMU_PER_INCH = 914400

#: What a caller must know about rendering in this workspace. Reported, never hidden.
RENDERING = {
    "bitmap": False,
    "method": "structural",
    "overflowMethod": "advance-estimate",
    "constants": {
        "averageGlyphAdvanceEm": AVERAGE_GLYPH_ADVANCE_EM,
        "lineHeightEm": LINE_HEIGHT_EM,
    },
    "limits": [
        "there is no rasteriser in this interpreter, so no operation here can produce a bitmap",
        "the fork's only text-measurement path is TextFrame.fit_text, which mutates the frame "
        "(it turns autofit off and writes a best-fit size into every run) and resolves a font "
        "installed on the host, so it is neither read-only nor reproducible across hosts",
        "this report therefore measures nothing: overflow is an estimate from the resolved font "
        "size and the box's own geometry, from the constants above",
        "a real renderer, or a host-font measurement the receipt could stand behind, would need "
        "isolation this worker does not have (RASF-3111)",
    ],
    "isolation": "RASF-3111",
}


def _fail(code: str, message: str) -> NoReturn:
    """A typed refusal. The worker reports the code unchanged, and nothing was written."""
    raise documents.WorkspaceError(code, message)


# -- validation ------------------------------------------------------------------------------------


def _object(value: Any, what: str, allowed: Optional[Sequence[str]] = None) -> Dict[str, Any]:
    if not isinstance(value, dict):
        _fail("invalid-request", f"{what} must be a JSON object")
    if allowed is not None:
        for key in value:
            if key not in allowed:
                _fail("invalid-request", f"{what} carries an unknown field {key!r}")
    return value


def _required(entry: Dict[str, Any], keys: Sequence[str], what: str) -> None:
    for key in keys:
        if key not in entry:
            _fail("invalid-request", f"{what} is missing {key}")


def _string(value: Any, what: str, limit: int = MAX_TEXT) -> str:
    if not isinstance(value, str) or value == "":
        _fail("invalid-request", f"{what} must be a non-empty string")
    if len(value) > limit:
        _fail("invalid-request", f"{what} is longer than {limit} characters")
    return value


def _maybe_string(value: Any, what: str, limit: int = MAX_TEXT) -> str:
    if not isinstance(value, str):
        _fail("invalid-request", f"{what} must be a string, empty to delete the text")
    if len(value) > limit:
        _fail("invalid-request", f"{what} is longer than {limit} characters")
    return value


def _boolean(value: Any, what: str) -> bool:
    if not isinstance(value, bool):
        _fail("invalid-request", f"{what} must be true or false")
    return value


def _integer(value: Any, what: str, low: int, high: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        _fail("invalid-request", f"{what} must be an integer between {low} and {high}")
    return value


def _one_of(value: Any, what: str, allowed: Sequence[str]) -> str:
    if not isinstance(value, str) or value not in allowed:
        _fail("invalid-request", f"{what} must be one of {', '.join(allowed)}")
    return value


def _reference(value: Any, what: str) -> Dict[str, Any]:
    """A leased FileRef, as the lease described it. The workspace resolves the version id it names."""
    entry = _object(value, what, REF_KEYS)
    _required(entry, REF_KEYS, what)
    _string(entry["fileId"], f"{what} fileId", 256)
    _string(entry["versionId"], f"{what} versionId", 256)
    _string(entry["name"], f"{what} name", 255)
    _string(entry["sha256"], f"{what} sha256", 64)
    _integer(entry["size"], f"{what} size", 0, 2**53 - 1)
    return {key: entry[key] for key in REF_KEYS}


def _source(reference: Dict[str, Any]) -> Dict[str, Any]:
    return {key: reference[key] for key in REF_KEYS}


def _output_name(value: Any) -> str:
    name = _string(value, "an output name", 255)
    if not name.lower().endswith(".pptx"):
        _fail("output-format", f"an output named {name!r} is not a .pptx file")
    return name


def _truncate(value: Any, limit: int) -> Tuple[str, bool]:
    text = "" if value is None else str(value)
    if len(text) <= limit:
        return text, False
    return text[:limit], True


def _bounded(value: Sequence[Any], limit: int) -> Tuple[List[Any], bool]:
    return list(value[:limit]), len(value) > limit


# -- opening a leased version ---------------------------------------------------------------------


def _load(what: str, path: str) -> Any:
    try:
        return pptx.Presentation(path)
    except PackageLimitError as error:
        _fail("package-limit", f"{what} is not an unambiguous PowerPoint package: {error}")
    except XMLSyntaxError as error:
        _fail("malformed-package", f"{what} holds XML that will not parse: {error}")
    except (PaperRefusal, ValueError, KeyError, OSError, zipfile.BadZipFile) as error:
        _fail(
            "malformed-package",
            f"{what} is not a readable PowerPoint package: {type(error).__name__}: {error}",
        )


def _open(reference: Dict[str, Any]) -> Tuple[str, Any]:
    """(path, presentation) for a leased version, or a typed refusal."""
    path = documents.open_input(reference["versionId"])
    what = f"the leased input {reference['name']!r}"
    return path, _load(what, path)


def _reopen(path: str) -> Any:
    return _load("the written deck", path)


def _applying(call, *args: Any, **kwargs: Any) -> Any:
    """Run one fork operation, turning its typed refusal into one of this workspace's codes.

    ``StaleAnchorError`` subclasses ``TargetNotFoundError`` and is caught first, so "the content
    moved on" never arrives as "there is no such block".
    """
    try:
        return call(*args, **kwargs)
    except documents.WorkspaceError:
        raise
    except StaleAnchorError as error:
        _fail("stale-anchor", str(error))
    except AmbiguousTargetError as error:
        _fail("ambiguous-target", str(error))
    except TargetNotFoundError as error:
        _fail("target-not-found", str(error))
    except PackageLimitError as error:
        _fail("package-limit", str(error))
    except RelationshipPolicyError as error:
        _fail("relationship-policy", str(error))
    except BoundaryViolationError as error:
        _fail("boundary-violation", str(error))
    except UnsupportedStructureError as error:
        _fail("unsupported-structure", str(error))
    except XMLSyntaxError as error:
        _fail("malformed-package", f"the deck holds XML that will not parse: {error}")
    except PaperRefusal as error:
        _fail("unsupported-structure", f"{type(error).__name__}: {error}")


def _slides_of(presentation: Any) -> List[Any]:
    """The deck's slides, refusing typed when the relationship graph is broken."""
    return _applying(materialize_slides, presentation, "paper-pptx")


def _manifest_of(manifest: Any, slide_id: int) -> Any:
    for entry in manifest.slides:
        if entry.slide_id == slide_id:
            return entry
    return manifest.slides[0]


# -- item shaping ----------------------------------------------------------------------------------


def _effective_font_summary(font: Any) -> Dict[str, Any]:
    """One run's resolved font, compactly: values and whether each resolved, no provenance."""
    size = font.size.to_dict()
    name = font.name.to_dict()
    color = font.color_rgb.to_dict()
    bold = font.bold.to_dict() if font.bold is not None else None
    italic = font.italic.to_dict() if font.italic is not None else None
    underline = font.underline.to_dict() if font.underline is not None else None
    return {
        "sizeEmu": size["value"],
        "sizePt": size["value_pt"],
        "sizeResolved": size["resolved"],
        "name": name["value"],
        "nameResolved": name["resolved"],
        "colorRgb": color["value"],
        "colorResolved": color["resolved"],
        "bold": None if bold is None else bold["value"],
        "boldResolved": bool(bold and bold["resolved"]),
        "italic": None if italic is None else italic["value"],
        "italicResolved": bool(italic and italic["resolved"]),
        "underline": None if underline is None else underline["value"],
        "underlineResolved": bool(underline and underline["resolved"]),
    }


def _run_item(run: Any) -> Dict[str, Any]:
    text, truncated = _truncate(run.text, MAX_ITEM_TEXT)
    item: Dict[str, Any] = {
        "text": text,
        "truncated": truncated,
        "font": _effective_font_summary(run.font),
    }
    if run.field_type is not None:
        item["fieldType"] = run.field_type
    return item


def _block_item(block: Any, position: int, slide_id: int) -> Dict[str, Any]:
    """One text block, with its structural anchor and a bounded run list."""
    text, truncated = _truncate(block.text, MAX_ITEM_TEXT)
    runs, runs_truncated = _bounded(block.runs, MAX_RUNS)
    return {
        "position": position,
        "slideId": slide_id,
        "part": block.anchor.part,
        "blockIndex": block.anchor.block_index,
        "anchor": block.anchor.to_dict(),
        "shapeId": block.shape_id,
        "shapeName": block.shape_name,
        "placeholderType": block.placeholder_type,
        "container": block.container,
        "containerDetail": block.container_detail,
        "blind": block.blind,
        "level": block.level,
        "fields": list(block.fields),
        "text": text,
        "truncated": truncated,
        "runs": [_run_item(run) for run in runs],
        "runsTruncated": runs_truncated,
    }


def _shape_item(shape: Any, position: int, slide_id: int, depth: int = 0) -> Dict[str, Any]:
    item: Dict[str, Any] = {
        "position": position,
        "slideId": slide_id,
        "shapeId": shape.shape_id,
        "name": shape.name,
        "kind": shape.kind,
        "zIndex": shape.z_index,
        "placeholderType": shape.placeholder_type,
        "left": shape.x,
        "top": shape.y,
        "width": shape.cx,
        "height": shape.cy,
        "rotation": shape.rotation,
        "textBlockCount": shape.text_block_count,
        "autofit": shape.autofit,
        "table": shape.table,
        "chart": shape.chart,
        "image": shape.image,
    }
    children = shape.children
    if depth >= 3:
        item["children"] = []
        item["childrenTruncated"] = len(children) > 0
    else:
        kept, truncated = _bounded(children, MAX_CHILDREN)
        item["children"] = [_shape_item(child, position, slide_id, depth + 1) for child in kept]
        item["childrenTruncated"] = truncated
    return item


def _title_shape_of(manifest: Any) -> Optional[str]:
    for shape in manifest.shapes:
        if shape.placeholder_type in TITLE_FAMILY:
            return shape.name
    return None


def _title_text_of(blocks: Sequence[Any]) -> Optional[str]:
    for block in blocks:
        if block.placeholder_type in TITLE_FAMILY:
            text = block.text.strip()
            if text:
                return _truncate(text, MAX_ITEM_TEXT)[0]
    return None


def _slide_outline(
    manifest: Any,
    position: int,
    blocks: Sequence[Any],
    media: int,
) -> Dict[str, Any]:
    return {
        "position": position,
        "slideId": manifest.slide_id,
        "part": manifest.part,
        "layoutName": manifest.layout_name,
        "titleShape": _title_shape_of(manifest),
        "titleText": _title_text_of(blocks),
        "shapeCount": len(manifest.shapes),
        "textBlockCount": len(blocks),
        "hasNotes": manifest.has_notes,
        "mediaCount": media,
        "alternateContent": manifest.alternate_content_count,
    }


# -- media references ------------------------------------------------------------------------------


def _rId_order(rId: str) -> Tuple[int, str]:
    digits = rId[3:] if rId.startswith("rId") else rId
    return (int(digits) if digits.isdigit() else 10**9, rId)


def _story_parts(slide: Any) -> List[Tuple[str, Any]]:
    """The slide part, and its notes part when one exists. Never creates a notes part."""
    parts: List[Tuple[str, Any]] = [(str(slide.part.partname), slide.part)]
    if slide.has_notes_slide:
        for rId in slide.part.rels:
            rel = slide.part.rels[rId]
            if rel.reltype.endswith("/notesSlide") and not rel.is_external:
                parts.append((str(rel.target_part.partname), rel.target_part))
    return parts


def _media_ref(position: Optional[int], slide: Any, partname: str, rId: str, kind: str, rel: Any) -> Dict[str, Any]:
    part = rel.target_part
    target = str(part.partname)
    blob = getattr(part, "blob", None)
    return {
        "position": position,
        "slideId": slide.slide_id,
        "part": partname,
        "rId": rId,
        "kind": kind,
        "reltype": rel.reltype,
        "target": target,
        "contentType": getattr(part, "content_type", None),
        "ext": os.path.splitext(target)[1].lstrip(".").lower() or None,
        "sha256": hashlib.sha256(blob).hexdigest() if blob is not None else None,
        "bytes": len(blob) if blob is not None else None,
    }


def _media_of(slide: Any, position: Optional[int]) -> List[Dict[str, Any]]:
    """Every image/media/video/audio relationship on one slide (or its notes slide)."""
    found: List[Dict[str, Any]] = []
    for partname, part in _story_parts(slide):
        rels = getattr(part, "rels", None)
        if rels is None:
            continue
        for rId in sorted(rels, key=_rId_order):
            rel = rels[rId]
            kind = MEDIA_RELTYPES.get(rel.reltype)
            if kind is None or rel.is_external:
                continue
            found.append(_media_ref(position, slide, partname, rId, kind, rel))
    return found


def _package_media(presentation: Any) -> List[Dict[str, Any]]:
    """Every ``/media/`` part in the package, referenced or not."""
    parts: List[Dict[str, Any]] = []
    for part in presentation.part.package.iter_parts():
        target = str(part.partname)
        if not any(fragment in target for fragment in MEDIA_FRAGMENTS):
            continue
        blob = getattr(part, "blob", None)
        parts.append(
            {
                "target": target,
                "contentType": getattr(part, "content_type", None),
                "ext": os.path.splitext(target)[1].lstrip(".").lower() or None,
                "sha256": hashlib.sha256(blob).hexdigest() if blob is not None else None,
                "bytes": len(blob) if blob is not None else None,
            }
        )
    return sorted(parts, key=lambda item: item["target"])


def _deck_media(presentation: Any) -> Tuple[List[Dict[str, Any]], List[str]]:
    """(references in slide order, media part names no slide relationship reaches)."""
    references: List[Dict[str, Any]] = []
    referenced: set = set()
    for position, slide in enumerate(_slides_of(presentation)):
        for item in _media_of(slide, position):
            references.append(item)
            referenced.add(item["target"])
    orphans = [
        part["target"] for part in _package_media(presentation) if part["target"] not in referenced
    ]
    return references, sorted(orphans)


# -- overflow --------------------------------------------------------------------------------------


def _overflow_of_shape(shape: Any, blocks: Sequence[Any]) -> Optional[Dict[str, Any]]:
    """Whether a text shape's content exceeds its box — computed, or reported as a limit.

    The frame's own declared autofit state is read first, because it is the deck telling on
    itself: ``normAutofit`` with a font scale means the deck already shrank the text to fit, and
    ``spAutoFit`` means the box grows to the text, so a fixed-box overflow cannot occur. Only when
    neither is declared is a number computed, and that number is an *estimate* — no font metrics
    are available, so the constants in ``RENDERING`` are published with every estimate.
    """
    if not getattr(shape, "has_text_frame", False) or not shape.has_text_frame:
        return None
    frame = shape.text_frame
    auto_size = frame.auto_size
    declared = {
        "autoSize": auto_size.name if auto_size is not None else None,
        "fontScale": frame.font_scale,
        "lineSpaceReduction": frame.line_space_reduction,
        "wordWrap": frame.word_wrap,
        "marginLeft": int(frame.margin_left),
        "marginRight": int(frame.margin_right),
        "marginTop": int(frame.margin_top),
        "marginBottom": int(frame.margin_bottom),
    }
    base: Dict[str, Any] = {"name": shape.name, "shapeId": shape.shape_id, "declared": declared}
    if auto_size == MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE and (frame.font_scale or 1.0) < 1.0:
        return {
            **base,
            "computed": False,
            "overflow": False,
            "compensated": True,
            "method": "declared-autofit",
            "reason": "the deck declares normAutofit and has already shrunk the text to fit",
        }
    if auto_size == MSO_AUTO_SIZE.SHAPE_TO_FIT_TEXT:
        return {
            **base,
            "computed": False,
            "overflow": False,
            "compensated": True,
            "method": "declared-autofit",
            "reason": "the deck declares spAutoFit: the box grows to the text, so a fixed-box "
            "overflow cannot occur",
        }
    left, top, width, height = shape.left, shape.top, shape.width, shape.height
    if None in (left, top, width, height):
        return {
            **base,
            "computed": False,
            "overflow": None,
            "compensated": False,
            "method": "advance-estimate",
            "reason": "the shape's geometry is inherited, not explicit, so there is no box to "
            "measure against",
        }
    if not blocks:
        return {
            **base,
            "computed": False,
            "overflow": None,
            "compensated": False,
            "method": "advance-estimate",
            "reason": "no text block was resolved for this shape",
        }
    sizes = [
        run.font.size.value
        for block in blocks
        for run in block.runs
        if run.font.size.resolved and isinstance(run.font.size.value, int)
    ]
    if not sizes:
        return {
            **base,
            "computed": False,
            "overflow": None,
            "compensated": False,
            "method": "advance-estimate",
            "reason": "no run's font size could be resolved, so no height can be estimated",
        }
    font_emu = int(max(sizes))
    available_width = int(width) - declared["marginLeft"] - declared["marginRight"]
    available_height = int(height) - declared["marginTop"] - declared["marginBottom"]
    if available_width <= 0 or available_height <= 0:
        return {
            **base,
            "computed": False,
            "overflow": None,
            "compensated": False,
            "method": "advance-estimate",
            "reason": "the box is narrower or shorter than its own text insets",
        }
    wraps = frame.word_wrap is not False
    lines_needed = 0
    estimated_width = 0
    blind = False
    for block in blocks:
        blind = blind or block.blind
        text = block.text
        estimated = int(len(text) * font_emu * AVERAGE_GLYPH_ADVANCE_EM)
        estimated_width = max(estimated_width, estimated)
        if text == "":
            lines = 1
        elif wraps:
            lines = max(1, math.ceil(estimated / available_width))
        else:
            lines = 1
        lines_needed += lines
    line_spacing = 1.0
    try:
        spacing = deck_inspect.effective_paragraph_format(
            shape.text_frame.paragraphs[0]
        ).line_spacing
        if spacing.resolved and isinstance(spacing.value, (int, float)):
            line_spacing = float(spacing.value)
    except PaperRefusal:
        line_spacing = 1.0
    required_height = int(lines_needed * font_emu * LINE_HEIGHT_EM * line_spacing)
    vertical = required_height > available_height
    horizontal = (not wraps) and estimated_width > available_width
    return {
        **base,
        "computed": True,
        "overflow": bool(vertical or horizontal),
        "vertical": vertical,
        "horizontal": horizontal,
        "compensated": False,
        "blind": blind,
        "method": "advance-estimate",
        "fontEmu": font_emu,
        "linesNeeded": lines_needed,
        "requiredHeightEmu": required_height,
        "availableHeightEmu": available_height,
        "estimatedWidthEmu": estimated_width,
        "availableWidthEmu": available_width,
        "wraps": wraps,
        "lineSpacing": line_spacing,
        "reason": None,
    }


def _iter_shapes_deep(shapes: Any) -> List[Any]:
    """Every shape in a tree, group children included, in tree order."""
    found: List[Any] = []
    for shape in shapes:
        found.append(shape)
        if hasattr(shape, "shapes"):
            try:
                found.extend(_iter_shapes_deep(shape.shapes))
            except (AttributeError, TypeError):
                continue
    return found


def _iter_text_shapes(shapes: Any) -> List[Any]:
    """Every shape with a text frame, group children included, in tree order."""
    return [
        shape
        for shape in _iter_shapes_deep(shapes)
        if getattr(shape, "has_text_frame", False) and shape.has_text_frame
    ]


def _blocks_by_shape(slide: Any) -> Dict[Any, List[Any]]:
    inspection = _applying(deck_inspect.inspect_text, slide)
    grouped: Dict[Any, List[Any]] = {}
    for block in inspection.blocks:
        grouped.setdefault(block.shape_id, []).append(block)
    return grouped


def _slide_overflow(slide: Any, blocks: Optional[Sequence[Any]] = None) -> List[Dict[str, Any]]:
    grouped = _blocks_by_shape(slide) if blocks is None else _group(blocks)
    items: List[Dict[str, Any]] = []
    for shape in _iter_text_shapes(slide.shapes):
        report = _overflow_of_shape(shape, grouped.get(shape.shape_id, []))
        if report is not None:
            items.append(report)
    return items


def _group(blocks: Sequence[Any]) -> Dict[Any, List[Any]]:
    grouped: Dict[Any, List[Any]] = {}
    for block in blocks:
        grouped.setdefault(block.shape_id, []).append(block)
    return grouped


def _overflow_summary(items: Sequence[Dict[str, Any]]) -> Dict[str, int]:
    return {
        "shapes": len(items),
        "overflowing": sum(1 for item in items if item["overflow"] is True),
        "compensated": sum(1 for item in items if item["compensated"] is True),
        "unresolved": sum(
            1 for item in items if item["computed"] is False and item["compensated"] is False
        ),
    }


def _deck_overflow(presentation: Any) -> Dict[str, Any]:
    """Overflow across the deck: exact totals, plus the slides that have something to report.

    Only slides with an overflowing or uncomputable box appear in the per-slide detail, bounded to
    ``MAX_OVERFLOW_ITEMS`` items each, and the totals count every text shape in the deck whatever the
    detail holds. That keeps "how much text overflows here" answerable without shipping a report for
    every clean slide.
    """
    slides: List[Dict[str, Any]] = []
    totals = {"shapes": 0, "overflowing": 0, "compensated": 0, "unresolved": 0}
    for position, slide in enumerate(_slides_of(presentation)):
        items = _slide_overflow(slide)
        summary = _overflow_summary(items)
        for key in totals:
            totals[key] += summary[key]
        if not (summary["overflowing"] or summary["unresolved"]):
            continue
        notable = [
            item for item in items if item["overflow"] is True or item["computed"] is False
        ]
        kept, truncated = _bounded(notable, MAX_OVERFLOW_ITEMS)
        slides.append(
            {
                "position": position,
                "slideId": slide.slide_id,
                "summary": summary,
                "items": kept,
                "itemsTruncated": truncated,
            }
        )
    return {"totals": totals, "slides": slides}


# -- change set, diff and preservation -------------------------------------------------------------


def _zip_parts(path: str) -> Dict[str, bytes]:
    """Every ZIP member of a package, by name: a package's own shape, read as bytes."""
    with zipfile.ZipFile(path) as archive:
        return {info.filename: archive.read(info.filename) for info in archive.infolist()}


def _hashes_of(parts: Dict[str, bytes]) -> Dict[str, str]:
    return {name: hashlib.sha256(data).hexdigest() for name, data in parts.items()}


def _change_set(source_path: str, output_path: str) -> Dict[str, Any]:
    """The structural change set: parts added, removed, changed and left byte-identical.

    The fork's own ``diff_package`` decides which members are *semantically* different; the sha256
    of each member before and after is what makes preservation arguable with bytes.
    """
    before = _hashes_of(_zip_parts(source_path))
    after = _hashes_of(_zip_parts(output_path))
    residual = _applying(paper_package.diff_package, source_path, output_path)
    changed = []
    for delta in residual.deltas:
        name = delta.partname.lstrip("/")
        changed.append(
            {
                "part": delta.partname,
                "kind": delta.kind,
                "change": delta.change,
                "detail": delta.detail,
                "beforeSha256": before.get(name),
                "afterSha256": after.get(name),
                "semanticChange": before.get(name) != after.get(name),
            }
        )
    payload = residual.to_dict()
    return {
        "schema": payload["schema"],
        "version": payload["version"],
        "added": ["/" + name for name in sorted(after) if name not in before],
        "removed": ["/" + name for name in sorted(before) if name not in after],
        "changed": changed,
        "byteIdenticalCount": sum(1 for name in before if after.get(name) == before[name]),
        "partCountBefore": len(before),
        "partCountAfter": len(after),
        "semanticallyEmpty": residual.is_empty,
    }


def _preservation(source_path: str, output_path: str, changed_parts: Sequence[str]) -> Dict[str, Any]:
    """Which parts came back byte-identical, with each part's sha256 as the evidence.

    The hash list is bounded and ordered media, theme, masters, layouts, notes, slides, then the rest,
    so the parts the issue names first — preserved slides and media — are always the ones reported, and
    the count is exact whatever the list holds. The changed parts' before and after hashes are in the
    change set and are never bounded.
    """
    before = _hashes_of(_zip_parts(source_path))
    after = _hashes_of(_zip_parts(output_path))
    identical = sorted(name for name in before if after.get(name) == before[name])
    ordered: List[str] = []
    for fragment in ("/media/", "/theme/", "/slideMasters/", "/slideLayouts/", "/notesSlides/", "/slides/"):
        ordered.extend(name for name in identical if fragment in name and name not in ordered)
    ordered.extend(name for name in identical if name not in ordered)
    kept, truncated = _bounded(ordered, MAX_PART_HASHES)

    def like(fragment: str, names: Sequence[str]) -> List[str]:
        """The parts in `names` whose name carries `fragment`, as package part names."""
        return [f"/{name}" for name in names if fragment in name]

    changed = [name.lstrip("/") for name in changed_parts]
    return {
        "byteIdenticalCount": len(identical),
        "byteIdentical": [{"part": "/" + name, "sha256": before[name]} for name in kept],
        "byteIdenticalTruncated": truncated,
        "byteIdenticalHashed": len(kept),
        "changedParts": changed,
        "addedParts": sorted(name for name in after if name not in before),
        "removedParts": sorted(name for name in before if name not in after),
        "mediaByteIdentical": like("/media/", identical),
        "themeByteIdentical": like("/theme/", identical),
        "layoutByteIdentical": like("/slideLayouts/", identical),
        "masterByteIdentical": like("/slideMasters/", identical),
        "notesByteIdentical": like("/notesSlides/", identical),
        "slidePartsByteIdentical": like("/slides/", identical),
        "verbatimCopy": len(changed) == 0 and len(identical) == len(before) == len(after),
    }


def _diff(path_a: str, path_b: str, detail: str) -> Dict[str, Any]:
    """The fork's own deck diff, bounded: slide-level changes with their before/after evidence."""
    raw = _applying(deck_diff.diff_decks, path_a, path_b, detail=detail).to_dict()
    changes: List[Dict[str, Any]] = []
    for change in raw["slide_changes"][:MAX_DIFF_SLIDE_CHANGES]:
        bounded: Dict[str, Any] = {"slide_id": change["slide_id"]}
        for key in (
            "shapes_added",
            "shapes_removed",
            "geometry_changes",
            "images_replaced",
            "chart_data_changes",
        ):
            if key in change:
                bounded[key] = change[key]
        for key in ("table_structure_changes", "text_changes", "effective_shifts", "bullet_shifts"):
            if key in change:
                values = list(change[key])
                bounded[key] = values[:MAX_DIFF_ENTRIES]
                bounded[key + "_total"] = len(values)
        if "notes_change" in change:
            bounded["notes_change"] = change["notes_change"]
        changes.append(bounded)
    return {
        "schema": raw["schema"],
        "version": raw["version"],
        "detail": raw["detail"],
        "slidesAdded": raw["slides_added"],
        "slidesRemoved": raw["slides_removed"],
        "slidesMoved": raw["slides_moved"],
        "slideChanges": changes,
        "slideChangeTotal": len(raw["slide_changes"]),
        "packageChanges": raw["package_changes"],
        "identical": not (
            raw["slide_changes"]
            or raw["slides_added"]
            or raw["slides_removed"]
            or raw["slides_moved"]
            or raw["package_changes"]
        ),
    }


# -- structural preview ----------------------------------------------------------------------------


def _marker(block: Any) -> str:
    if block.container == "table-cell":
        return "TC"
    if block.container == "group":
        return "G"
    if block.placeholder_type in TITLE_FAMILY:
        return "T"
    if block.placeholder_type in BODY_FAMILY:
        return f"B{block.level}" if block.level else "B"
    return "P"


def _slide_preview(slide: Any, manifest: Any, position: Optional[int], blocks: Sequence[Any]) -> Dict[str, Any]:
    """One bounded structural preview of a slide: text lines, shape facts, notes and media.

    This is the closest thing to a picture this workspace can produce, and it says so: there is no
    bitmap renderer in process (see ``RENDERING``).
    """
    grouped = _group(blocks)
    lines: List[Dict[str, Any]] = []

    def emit(shapes: Sequence[Any], depth: int) -> None:
        for shape in shapes:
            for block in grouped.get(shape.shape_id, []):
                text, truncated = _truncate(block.text, MAX_LABEL_TEXT)
                label = f"{_marker(block)}: {text}"
                lines.append(
                    {
                        "marker": _marker(block),
                        "text": text,
                        "truncated": truncated,
                        "shape": shape.name,
                        "label": (("  " * depth) + label) if depth else label,
                    }
                )
            if shape.table is not None:
                lines.append(
                    {
                        "marker": "TB",
                        "text": shape.name,
                        "truncated": False,
                        "shape": shape.name,
                        "label": f"TB{shape.table['rows']}x{shape.table['cols']}: {shape.name}",
                    }
                )
            if shape.chart is not None:
                lines.append(
                    {
                        "marker": "CH",
                        "text": shape.name,
                        "truncated": False,
                        "shape": shape.name,
                        "label": f"CH:{shape.chart['chart_type']}: {shape.name}",
                    }
                )
            if shape.image is not None:
                lines.append(
                    {
                        "marker": "PIC",
                        "text": shape.name,
                        "truncated": False,
                        "shape": shape.name,
                        "label": f"PIC:{shape.image['ext']}: {shape.name}",
                    }
                )
            if shape.children:
                emit(shape.children, depth + 1)

    emit(manifest.shapes, 0)
    kept_lines, lines_truncated = _bounded(lines, MAX_LABEL_LINES)
    kept_shapes, shapes_truncated = _bounded(manifest.shapes, MAX_PREVIEW_SHAPES)
    media = _media_of(slide, position)
    kept_media, media_truncated = _bounded(media, MAX_PREVIEW_MEDIA)
    notes_text: Optional[str] = None
    if slide.has_notes_slide:
        try:
            notes_text, _ = _truncate(slide.read_notes_text(), MAX_LABEL_TEXT)
        except PaperRefusal:
            notes_text = None
    overflow = _slide_overflow(slide, blocks)
    return {
        "position": position,
        "slideId": slide.slide_id,
        "part": str(slide.part.partname),
        "layoutName": manifest.layout_name,
        "titleText": _title_text_of(blocks),
        "lines": kept_lines,
        "linesTruncated": lines_truncated,
        "shapes": [
            {
                "shapeId": shape.shape_id,
                "name": shape.name,
                "kind": shape.kind,
                "zIndex": shape.z_index,
                "placeholderType": shape.placeholder_type,
                "textBlockCount": shape.text_block_count,
                "autofit": shape.autofit,
                "table": shape.table,
                "chart": shape.chart,
                "image": shape.image,
                "childCount": len(shape.children),
            }
            for shape in kept_shapes
        ],
        "shapesTruncated": shapes_truncated,
        "notes": {"present": slide.has_notes_slide, "text": notes_text},
        "media": kept_media,
        "mediaTruncated": media_truncated,
        "overflow": {
            "summary": _overflow_summary(overflow),
            "items": [
                item for item in overflow if item["overflow"] is True or item["computed"] is False
            ][:MAX_OVERFLOW_ITEMS],
        },
    }


def _survey(path: str) -> Tuple[Any, Any, List[Any]]:
    """(presentation, manifest, slides) for a deck this run may only read."""
    presentation = _reopen(path)
    manifest = _applying(deck_inspect.inspect_deck, presentation)
    return presentation, manifest, _slides_of(presentation)


def _before_after(source_path: str, output_path: str, diff: Dict[str, Any]) -> Dict[str, Any]:
    """Before/after structural previews for the slides the change set says changed.

    Slides are matched by their permanent slide id — the fork's own matching contract — so the two
    sides of a pair are the same slide rather than the same position.
    """
    _source_prs, source_manifest, source_slides = _survey(source_path)
    _output_prs, output_manifest, output_slides = _survey(output_path)
    source_by_id = {slide.slide_id: (index, slide) for index, slide in enumerate(source_slides)}
    output_by_id = {slide.slide_id: (index, slide) for index, slide in enumerate(output_slides)}
    source_blocks = {
        slide.slide_id: _applying(deck_inspect.inspect_text, slide).blocks for slide in source_slides
    }
    output_blocks = {
        slide.slide_id: _applying(deck_inspect.inspect_text, slide).blocks for slide in output_slides
    }

    changed: List[Dict[str, Any]] = []
    for change in diff["slideChanges"][:MAX_CHANGED_SLIDES]:
        slide_id = change["slide_id"]
        before = source_by_id.get(slide_id)
        after = output_by_id.get(slide_id)
        if before is None or after is None:
            continue
        changed.append(
            {
                "slideId": slide_id,
                "change": change,
                "before": _slide_preview(
                    before[1], _manifest_of(source_manifest, slide_id), before[0], source_blocks[slide_id]
                ),
                "after": _slide_preview(
                    after[1], _manifest_of(output_manifest, slide_id), after[0], output_blocks[slide_id]
                ),
            }
        )
    added: List[Dict[str, Any]] = []
    for ref in diff["slidesAdded"][:MAX_CHANGED_SLIDES]:
        found = output_by_id.get(ref["slide_id"])
        if found is None:
            continue
        added.append(
            {
                "slideId": ref["slide_id"],
                "position": ref["position"],
                "title": ref["title"],
                "after": _slide_preview(
                    found[1],
                    _manifest_of(output_manifest, ref["slide_id"]),
                    found[0],
                    output_blocks[ref["slide_id"]],
                ),
            }
        )
    removed: List[Dict[str, Any]] = []
    for ref in diff["slidesRemoved"][:MAX_CHANGED_SLIDES]:
        found = source_by_id.get(ref["slide_id"])
        if found is None:
            continue
        removed.append(
            {
                "slideId": ref["slide_id"],
                "position": ref["position"],
                "title": ref["title"],
                "before": _slide_preview(
                    found[1],
                    _manifest_of(source_manifest, ref["slide_id"]),
                    found[0],
                    source_blocks[ref["slide_id"]],
                ),
            }
        )
    return {
        "changed": changed,
        "changedTotal": len(diff["slideChanges"]),
        "added": added,
        "addedTotal": len(diff["slidesAdded"]),
        "removed": removed,
        "removedTotal": len(diff["slidesRemoved"]),
        "moved": diff["slidesMoved"],
        "limit": MAX_CHANGED_SLIDES,
        "limitNote": "before/after previews are built for at most "
        f"{MAX_CHANGED_SLIDES} changed slides per call; the change set itself is complete",
    }


# -- census ----------------------------------------------------------------------------------------


def _deck_census(presentation: Any, manifest: Optional[Any] = None) -> Dict[str, Any]:
    man = _applying(deck_inspect.inspect_deck, presentation) if manifest is None else manifest
    slides = _slides_of(presentation)
    text_blocks = 0
    blind_blocks = 0
    for slide in slides:
        inspection = _applying(deck_inspect.inspect_text, slide)
        text_blocks += len(inspection.blocks)
        blind_blocks += inspection.blind_region_count
    shapes = 0
    pictures = 0
    tables = 0
    charts = 0
    groups = 0
    alternate = 0

    def walk(entries: Sequence[Any]) -> None:
        nonlocal shapes, pictures, tables, charts, groups
        for shape in entries:
            shapes += 1
            if shape.kind == "PICTURE":
                pictures += 1
            if shape.table is not None:
                tables += 1
            if shape.chart is not None:
                charts += 1
            if shape.children:
                groups += 1
                walk(shape.children)

    for entry in man.slides:
        walk(entry.shapes)
        alternate += entry.alternate_content_count
    references, orphans = _deck_media(presentation)
    layouts = sum(len(master.slide_layouts) for master in presentation.slide_masters)
    return {
        "slides": len(slides),
        "masters": len(presentation.slide_masters),
        "layouts": layouts,
        "shapes": shapes,
        "textBlocks": text_blocks,
        "blindTextBlocks": blind_blocks,
        "notesSlides": sum(1 for entry in man.slides if entry.has_notes),
        "mediaParts": len(_package_media(presentation)),
        "mediaReferences": len(references),
        "orphanMediaParts": len(orphans),
        "pictures": pictures,
        "tables": tables,
        "charts": charts,
        "groups": groups,
        "alternateContent": alternate,
        "slideWidthEmu": man.slide_width,
        "slideHeightEmu": man.slide_height,
    }


def _reopened(path: str) -> Dict[str, Any]:
    """Reopen the written deck with the pinned library: the check the design wants before a commit."""
    presentation = _reopen(path)
    census = _deck_census(presentation)
    return {
        "slides": census["slides"],
        "shapes": census["shapes"],
        "textBlocks": census["textBlocks"],
        "notesSlides": census["notesSlides"],
        "mediaParts": census["mediaParts"],
        "masters": census["masters"],
        "layouts": census["layouts"],
        "tables": census["tables"],
        "charts": census["charts"],
        "pictures": census["pictures"],
    }


def _envelope(operation: str, **fields: Any) -> Dict[str, Any]:
    return {"schema": SCHEMA, "version": VERSION, "operation": operation, "ok": True, **fields}


def _page(items: Sequence[Any], cursor: int, page_size: int, section: str) -> Dict[str, Any]:
    total = len(items)
    if cursor > total:
        _fail(
            "invalid-request",
            f"the cursor {cursor} is past the end of the {section} page set, which holds {total} items",
        )
    window = list(items[cursor : cursor + page_size])
    returned = len(window)
    next_cursor = cursor + returned if cursor + returned < total else None
    return {
        "section": section,
        "pageSize": page_size,
        "cursor": cursor,
        "returned": returned,
        "total": total,
        "nextCursor": next_cursor,
        "hasMore": next_cursor is not None,
        "items": window,
    }


def _paging(entry: Dict[str, Any]) -> Tuple[int, int]:
    cursor = 0 if entry.get("cursor") is None else _integer(entry["cursor"], "cursor", 0, 10**9)
    page_size = (
        DEFAULT_PAGE
        if entry.get("pageSize") is None
        else _integer(entry["pageSize"], "pageSize", 1, MAX_PAGE)
    )
    return cursor, page_size


def _warnings(census: Dict[str, Any], orphans: Sequence[str]) -> List[str]:
    warnings: List[str] = []
    if census["blindTextBlocks"]:
        warnings.append(
            f"{census['blindTextBlocks']} text block(s) are table-cell text: their effective "
            "formatting is not resolvable in this version and is reported unresolved, not guessed"
        )
    if census["alternateContent"]:
        warnings.append(
            f"{census['alternateContent']} mc:AlternateContent subtree(s) are not surveyable; "
            "operations that must see everything refuse rather than guess"
        )
    if orphans:
        warnings.append(f"{len(orphans)} media part(s) are not reachable from any slide relationship")
    return warnings


# -- operations ------------------------------------------------------------------------------------


def _inspect(params: Dict[str, Any]) -> Dict[str, Any]:
    entry = _object(params, "inspect parameters", ("ref",))
    _required(entry, ("ref",), "inspect parameters")
    reference = _reference(entry["ref"], "inspect ref")
    _path, presentation = _open(reference)
    manifest = _applying(deck_inspect.inspect_deck, presentation)
    slides = _slides_of(presentation)
    census = _deck_census(presentation, manifest)
    overflow = _deck_overflow(presentation)

    outline: List[Dict[str, Any]] = []
    for position, slide in enumerate(slides):
        blocks = _applying(deck_inspect.inspect_text, slide).blocks
        outline.append(
            _slide_outline(manifest.slides[position], position, blocks, len(_media_of(slide, position)))
        )
    kept_outline, outline_truncated = _bounded(outline, MAX_OUTLINE)
    references, orphans = _deck_media(presentation)
    kept_media, media_truncated = _bounded(references, MAX_MEDIA)
    return _envelope(
        "inspect",
        source=_source(reference),
        deck=census,
        overflow=overflow["totals"],
        overflowSlides=overflow["slides"][:MAX_OVERFLOW_SLIDES],
        slideOutline=kept_outline,
        slideOutlineTruncated=outline_truncated,
        mediaOutline=kept_media,
        mediaOutlineTruncated=media_truncated,
        orphanMediaParts=orphans,
        warnings=_warnings(census, orphans),
        rendering=RENDERING,
    )


def _section_items(presentation: Any, manifest: Any, slides: Sequence[Any], section: str) -> List[Dict[str, Any]]:
    if section == "slides":
        items: List[Dict[str, Any]] = []
        for position, slide in enumerate(slides):
            blocks = _applying(deck_inspect.inspect_text, slide).blocks
            items.append(
                _slide_outline(manifest.slides[position], position, blocks, len(_media_of(slide, position)))
            )
        return items
    if section == "text":
        items = []
        for position, slide in enumerate(slides):
            for block in _applying(deck_inspect.inspect_text, slide).blocks:
                items.append(_block_item(block, position, slide.slide_id))
        return items
    if section == "shapes":
        items = []
        for position, entry in enumerate(manifest.slides):
            for shape in entry.shapes:
                items.append(_shape_item(shape, position, entry.slide_id))
        return items
    if section == "notes":
        items = []
        for position, slide in enumerate(slides):
            present = slide.has_notes_slide
            text = ""
            truncated = False
            if present:
                try:
                    text, truncated = _truncate(slide.read_notes_text(), MAX_ITEM_TEXT)
                except PaperRefusal as error:
                    text, truncated = f"<unreadable notes: {type(error).__name__}>", False
            items.append(
                {
                    "position": position,
                    "slideId": slide.slide_id,
                    "part": str(slide.part.partname),
                    "present": present,
                    "text": text,
                    "truncated": truncated,
                }
            )
        return items
    return _deck_media(presentation)[0]


def _read(params: Dict[str, Any]) -> Dict[str, Any]:
    entry = _object(params, "read parameters", ("ref", "section", "cursor", "pageSize"))
    _required(entry, ("ref", "section"), "read parameters")
    reference = _reference(entry["ref"], "read ref")
    section = _one_of(entry["section"], "a read section", READ_SECTIONS)
    cursor, page_size = _paging(entry)
    _path, presentation = _open(reference)
    manifest = _applying(deck_inspect.inspect_deck, presentation)
    slides = _slides_of(presentation)
    page = _page(_section_items(presentation, manifest, slides, section), cursor, page_size, section)
    return _envelope(
        "read", source=_source(reference), deck=_deck_census(presentation, manifest), page=page
    )


# -- create ----------------------------------------------------------------------------------------


def _block_specs(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list) or not value:
        _fail("invalid-request", "a slide needs a non-empty list of blocks")
    if len(value) > MAX_CREATED_BLOCKS:
        _fail("invalid-request", f"a slide takes at most {MAX_CREATED_BLOCKS} blocks")
    specs: List[Dict[str, Any]] = []
    for index, raw in enumerate(value):
        what = f"block {index}"
        spec = _object(raw, what)
        kind = _string(spec.get("kind"), f"{what} kind", 64)
        if kind not in BLOCK_KINDS:
            _fail("invalid-request", f"{what} names an unknown kind {kind!r}")
        if kind == "paragraph":
            _object(spec, what, ("kind", "text", "level"))
            _required(spec, ("kind", "text"), what)
            specs.append(
                {
                    "kind": kind,
                    "text": _string(spec["text"], f"{what} text"),
                    "level": 0 if spec.get("level") is None else _integer(spec["level"], f"{what} level", 0, 8),
                }
            )
        elif kind == "bullets":
            _object(spec, what, ("kind", "items"))
            _required(spec, ("kind", "items"), what)
            items = spec["items"]
            if not isinstance(items, list) or not items:
                _fail("invalid-request", f"{what} needs a non-empty list of items")
            if len(items) > MAX_CELLS:
                _fail("invalid-request", f"{what} holds more than {MAX_CELLS} items")
            parsed: List[Dict[str, Any]] = []
            for item_index, item in enumerate(items):
                item_what = f"{what} item {item_index}"
                item_spec = _object(item, item_what, ("text", "level"))
                _required(item_spec, ("text",), item_what)
                parsed.append(
                    {
                        "text": _string(item_spec["text"], f"{item_what} text"),
                        "level": 0
                        if item_spec.get("level") is None
                        else _integer(item_spec["level"], f"{item_what} level", 0, 8),
                    }
                )
            specs.append({"kind": kind, "items": parsed})
        else:
            _object(spec, what, ("kind", "rows"))
            _required(spec, ("kind", "rows"), what)
            rows = spec["rows"]
            if not isinstance(rows, list) or not rows:
                _fail("invalid-request", f"{what} needs a non-empty list of rows")
            if len(rows) > MAX_CELLS:
                _fail("invalid-request", f"{what} holds more than {MAX_CELLS} rows")
            width = None
            cells: List[List[str]] = []
            for row in rows:
                if not isinstance(row, list) or not row:
                    _fail("invalid-request", f"{what} rows must be non-empty lists of cells")
                if width is None:
                    width = len(row)
                if len(row) != width:
                    _fail("invalid-request", f"{what} rows must all hold the same number of cells")
                if len(row) > MAX_CELLS:
                    _fail("invalid-request", f"{what} rows hold more than {MAX_CELLS} cells")
                cells.append([_maybe_string(cell, f"{what} cell", MAX_TEXT) for cell in row])
            specs.append({"kind": kind, "rows": cells})
    return specs


def _slide_specs(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list) or not value:
        _fail("invalid-request", "create needs a non-empty list of slides")
    if len(value) > MAX_CREATED_SLIDES:
        _fail("invalid-request", f"create takes at most {MAX_CREATED_SLIDES} slides")
    specs: List[Dict[str, Any]] = []
    for index, raw in enumerate(value):
        what = f"slide {index}"
        spec = _object(raw, what, ("title", "layout", "notes", "blocks"))
        blocks = spec.get("blocks")
        specs.append(
            {
                "title": None if spec.get("title") is None else _string(spec["title"], f"{what} title"),
                "layout": None if spec.get("layout") is None else _string(spec["layout"], f"{what} layout", 255),
                "notes": None if spec.get("notes") is None else _string(spec["notes"], f"{what} notes"),
                "blocks": [] if blocks is None else _block_specs(blocks),
            }
        )
    return specs


def _inches(value: float) -> Any:
    return Inches(value)


def _width_inches(presentation: Any) -> float:
    width = presentation.slide_width
    return (float(width) / EMU_PER_INCH) if width is not None else 10.0


def _layout_by_name(presentation: Any, name: str, what: str) -> Any:
    """A layout by unique exact name. A name this deck does not define refuses, listing what it has.

    This never falls back to the first layout: an ambiguous or missing layout is a refusal, not a
    guess, the same rule ``pptx.compose`` applies to an imported slide's binding.
    """
    matches = [layout for layout in presentation.slide_layouts if layout.name == name]
    if not matches:
        available = sorted({layout.name for layout in presentation.slide_layouts})
        _fail(
            "target-not-found",
            f"{what} names layout {name!r}, which this deck does not define; it defines: "
            + ", ".join(available),
        )
    if len(matches) > 1:
        _fail("ambiguous-target", f"{what} names layout {name!r}, which this deck defines more than once")
    return matches[0]


def _body_placeholder(slide: Any) -> Any:
    for placeholder in slide.placeholders:
        ph_type = placeholder.placeholder_format.type
        if ph_type is not None and ph_type.name in BODY_FAMILY:
            return placeholder
    return None


def _write_paragraphs(frame: Any, paragraphs: Sequence[Tuple[str, int]]) -> None:
    frame.clear()
    first = True
    for text, level in paragraphs:
        paragraph = frame.paragraphs[0] if first else frame.add_paragraph()
        paragraph.text = text
        paragraph.level = level
        first = False


def _textbox(slide: Any, presentation: Any, top: float, height: float) -> Any:
    """A deterministic text box, used only where the layout has no placeholder to hold the text."""
    return _applying(
        slide.shapes.add_textbox,
        _inches(0.5),
        _inches(top),
        _inches(max(1.0, _width_inches(presentation) - 1.0)),
        _inches(height),
    )


def _add_created_slide(presentation: Any, spec: Dict[str, Any], index: int) -> Dict[str, Any]:
    what = f"slide {index}"
    title_text = spec["title"]
    blocks = spec["blocks"]
    paragraphs: List[Tuple[str, int]] = []
    for block in blocks:
        if block["kind"] == "paragraph":
            paragraphs.append((block["text"], block["level"]))
        elif block["kind"] == "bullets":
            paragraphs.extend((item["text"], item["level"]) for item in block["items"])
    tables = [block for block in blocks if block["kind"] == "table"]
    layout_name = spec["layout"] or (DEFAULT_LAYOUT if blocks or title_text else FALLBACK_LAYOUT)
    layout = _applying(_layout_by_name, presentation, layout_name, what)
    slide = _applying(presentation.slides.add_slide, layout)
    placed: List[str] = []

    if title_text is not None:
        title = slide.shapes.title
        if title is not None and title.has_text_frame:
            title.text_frame.text = title_text
            placed.append(title.name)
        else:
            _textbox(slide, presentation, 0.3, 0.8).text_frame.text = title_text
            placed.append("a title text box")

    top = 1.4 + (0.9 if title_text is not None else 0.0)
    if paragraphs:
        body = _body_placeholder(slide)
        height = min(4.0, 0.35 * len(paragraphs) + 0.35)
        if body is not None:
            _write_paragraphs(body.text_frame, paragraphs)
            placed.append(body.name)
        else:
            _write_paragraphs(_textbox(slide, presentation, top, height).text_frame, paragraphs)
            placed.append("a body text box")
        top += height + 0.2

    for table_spec in tables:
        rows = table_spec["rows"]
        height = 0.4 * len(rows)
        graphic = _applying(
            slide.shapes.add_table,
            len(rows),
            len(rows[0]),
            _inches(0.5),
            _inches(top),
            _inches(max(1.0, _width_inches(presentation) - 1.0)),
            _inches(height),
        )
        table = graphic.table
        for row_index, row in enumerate(rows):
            for column_index, cell in enumerate(row):
                table.cell(row_index, column_index).text = cell
        placed.append(graphic.name)
        top += height + 0.2

    if spec["notes"] is not None:
        slide.notes_slide
        _applying(slide.replace_notes_text, spec["notes"])

    return {
        "position": index,
        "slideId": slide.slide_id,
        "layout": layout.name,
        "placed": placed,
        "notes": spec["notes"] is not None,
        "blocks": len(blocks),
    }


def _written(path: str) -> Tuple[str, int]:
    with open(path, "rb") as handle:
        data = handle.read()
    return hashlib.sha256(data).hexdigest(), len(data)


def _create(params: Dict[str, Any]) -> Dict[str, Any]:
    entry = _object(params, "create parameters", ("output", "slides"))
    _required(entry, ("output", "slides"), "create parameters")
    name = _output_name(entry["output"])
    specs = _slide_specs(entry["slides"])
    path = documents.declare_output(name, "pptx")
    presentation = pptx.Presentation()
    placements = [_add_created_slide(presentation, spec, index) for index, spec in enumerate(specs)]
    overflow = _deck_overflow(presentation)
    _applying(presentation.save, path)
    sha, size = _written(path)
    return _envelope(
        "create",
        draft={
            "status": "draft",
            "name": name,
            "editOf": None,
            "sha256": sha,
            "size": size,
            "published": False,
        },
        structure=_deck_census(presentation),
        placements=placements,
        overflow=overflow["totals"],
        overflowSlides=overflow["slides"][:MAX_OVERFLOW_SLIDES],
        provenance={"template": "paper-pptx default", "source": None},
        reopened=_reopened(path),
        rendering=RENDERING,
    )


# -- edits -----------------------------------------------------------------------------------------


def _slide_at(presentation: Any, index: Any, what: str) -> Any:
    slides = _slides_of(presentation)
    position = _integer(index, f"{what} slide", 0, 10**6)
    if position >= len(slides):
        _fail(
            "target-not-found",
            f"{what} names slide {position}, but this deck holds {len(slides)} slides",
        )
    return slides[position]


def _shape_at(slide: Any, fields: Dict[str, Any], what: str) -> Any:
    """The one shape a step names, by display name or by stable id.

    ``shape`` goes through the fork's own ``shape_by_name``, which refuses an ambiguity. ``shapeId``
    exists because a copy keeps its source's display name (``add_copy`` re-ids but does not rename),
    so name addressing cannot reach a shape that was just copied.
    """
    name = fields.get("shape")
    shape_id = fields.get("shapeId")
    if (name is None) == (shape_id is None):
        _fail(
            "invalid-request",
            f"{what} must name its shape by exactly one of shape (display name) or shapeId",
        )
    if name is not None:
        return _applying(slide.shapes.shape_by_name, _string(name, f"{what} shape", 255))
    wanted = _integer(shape_id, f"{what} shapeId", 0, 10**9)
    matches = [shape for shape in _iter_shapes_deep(slide.shapes) if shape.shape_id == wanted]
    if not matches:
        _fail("target-not-found", f"{what} names shape id {wanted}, which this slide does not hold")
    if len(matches) > 1:
        _fail("ambiguous-target", f"{what} names shape id {wanted}, held more than once")
    return matches[0]


def _anchor(presentation: Any, value: Any, what: str) -> BlockAnchor:
    """A structural anchor for ``pptx.edit``: exact paragraph text, or the block a read reported.

    A bare ``text`` anchor is resolved to the one block whose literal text it matches exactly, so a
    stale or ambiguous request refuses here rather than editing the wrong paragraph. A structural
    anchor is handed to the fork unchanged, so the fork's own stale-anchor check decides.
    """
    spec = _object(value, what)
    if "text" in spec:
        _object(spec, what, ("text",))
        wanted = _string(spec["text"], f"{what} text")
        matches: List[Any] = []
        for slide in _slides_of(presentation):
            for block in _applying(deck_inspect.inspect_text, slide).blocks:
                if block.text == wanted:
                    matches.append(block)
        if not matches:
            _fail("target-not-found", f"{what} text matches no text block in this deck")
        if len(matches) > 1:
            _fail(
                "ambiguous-target",
                f"{what} text matches {len(matches)} text blocks; anchor the one you mean by part, "
                "block_index and content_hash",
            )
        return matches[0].anchor
    _object(spec, what, ANCHOR_KEYS)
    _required(spec, ("part", "block_index", "content_hash"), what)
    part = _string(spec["part"], f"{what} part", 512)
    block_index = _integer(spec["block_index"], f"{what} block_index", 0, 10**8)
    content_hash = _string(spec["content_hash"], f"{what} content_hash", 128)
    version = spec.get("version")
    locator = spec.get("locator")
    if (version is None) != (locator is None):
        _fail(
            "invalid-request",
            f"{what} must carry both version and locator for a structural anchor, or neither for "
            "a legacy text-hash anchor",
        )
    if version is not None:
        version = _integer(version, f"{what} version", 0, 10**6)
        locator = _object(locator, f"{what} locator")
    return BlockAnchor(part, block_index, content_hash, version, locator)


def _step_fields(spec: Dict[str, Any], kind: str, what: str) -> Dict[str, Any]:
    required, optional = STEP_FIELDS[kind]
    _object(spec, what, ("kind", *required, *optional))
    _required(spec, required, what)
    return spec


def _replace_evidence(result: Any) -> Dict[str, Any]:
    payload = result.to_dict()
    blocks, truncated = _bounded(payload["blocks"], MAX_ANCHORS)
    return {
        "schema": payload["schema"],
        "version": payload["version"],
        "replacements": payload["replacements"],
        "blocks": blocks,
        "blocksTruncated": truncated,
    }


def _apply_step(presentation: Any, spec: Any) -> Dict[str, Any]:
    """One typed edit step, against the fork's own primitives. Returns the fork's change evidence."""
    block = _object(spec, "an edit step")
    kind = _string(block.get("kind"), "an edit step kind", 64)
    if kind not in STEP_FIELDS:
        _fail("invalid-request", f"an edit step names an unknown kind {kind!r}")
    what = f"the {kind} step"
    fields = _step_fields(block, kind, what)

    if kind == "replaceText":
        anchor = _anchor(presentation, fields["anchor"], f"{what} anchor")
        result = _applying(
            edit_ops.replace_text_at,
            presentation,
            anchor,
            _string(fields["find"], f"{what} find"),
            _maybe_string(fields["replace"], f"{what} replace"),
        )
        return {"kind": kind, "evidence": _replace_evidence(result)}

    if kind == "replaceTextEverywhere":
        expect = (
            None if fields.get("expect") is None else _integer(fields["expect"], f"{what} expect", 0, 10**6)
        )
        result = _applying(
            edit_ops.replace_text,
            presentation,
            _string(fields["find"], f"{what} find"),
            _maybe_string(fields["replace"], f"{what} replace"),
            include_notes=bool(fields.get("includeNotes")),
        )
        if expect is not None and result.replacements != expect:
            _fail(
                "target-not-found",
                f"{what} expected {expect} replacement(s) and made {result.replacements}; the deck "
                "is not the one this step was planned against",
            )
        return {"kind": kind, "evidence": _replace_evidence(result)}

    if kind == "writeNotes":
        slide = _slide_at(presentation, fields["slide"], what)
        text = _maybe_string(fields["text"], f"{what} text")
        created = False
        if not slide.has_notes_slide:
            slide.notes_slide  # materializes the notes part; replace_notes_text never creates one
            created = True
        _applying(slide.replace_notes_text, text)
        return {
            "kind": kind,
            "evidence": {"slideId": slide.slide_id, "notesCreated": created, "characters": len(text)},
        }

    if kind == "addSlide":
        layout = _layout_by_name(presentation, fields.get("layout") or DEFAULT_LAYOUT, what)
        slide = _applying(presentation.slides.add_slide, layout)
        at = None
        if fields.get("at") is not None:
            at = _integer(fields["at"], f"{what} at", 0, 10**6)
            _applying(presentation.slides.move, slide, min(at, len(_slides_of(presentation)) - 1))
        return {
            "kind": kind,
            "evidence": {
                "slideId": slide.slide_id,
                "layout": layout.name,
                "at": at,
                "slides": len(_slides_of(presentation)),
            },
        }

    if kind == "cloneSlide":
        source = _slide_at(presentation, fields["slide"], what)
        source_id = source.slide_id
        clone = _applying(presentation.slides.clone, source)
        at = None
        if fields.get("at") is not None:
            at = _integer(fields["at"], f"{what} at", 0, 10**6)
            _applying(presentation.slides.move, clone, min(at, len(_slides_of(presentation)) - 1))
        return {
            "kind": kind,
            "evidence": {
                "sourceSlideId": source_id,
                "slideId": clone.slide_id,
                "at": at,
                "slides": len(_slides_of(presentation)),
            },
        }

    if kind == "deleteSlide":
        slide = _slide_at(presentation, fields["slide"], what)
        slide_id = slide.slide_id
        _applying(presentation.slides.delete, slide)
        return {
            "kind": kind,
            "evidence": {"slideId": slide_id, "slides": len(_slides_of(presentation))},
        }

    if kind == "moveSlide":
        slide = _slide_at(presentation, fields["slide"], what)
        to_index = _integer(fields["to"], f"{what} to", 0, 10**6)
        slide_id = slide.slide_id
        _applying(presentation.slides.move, slide, min(to_index, len(_slides_of(presentation)) - 1))
        return {
            "kind": kind,
            "evidence": {
                "slideId": slide_id,
                "to": to_index,
                "order": [item.slide_id for item in _slides_of(presentation)],
            },
        }

    if kind == "rebindLayout":
        slide = _slide_at(presentation, fields["slide"], what)
        layout = _layout_by_name(presentation, _string(fields["layout"], f"{what} layout", 255), what)
        policy = fields.get("orphanPolicy")
        if policy is not None and policy not in ("refuse", "bake"):
            _fail("invalid-request", f"{what} orphanPolicy must be refuse or bake")
        report = _applying(slide.rebind_layout, layout, orphan_policy=policy or "refuse")
        payload = report.to_dict()
        shifts, shifts_truncated = _bounded(payload["run_shifts"], MAX_DIFF_ENTRIES)
        return {
            "kind": kind,
            "evidence": {
                **{key: payload[key] for key in payload if key != "run_shifts"},
                "run_shifts_truncated": shifts_truncated,
                "run_shifts_total": len(payload["run_shifts"]),
                "run_shifts": shifts,
            },
        }

    if kind == "applyFooters":
        options: Dict[str, Any] = {}
        if fields.get("footer") is not None:
            options["footer"] = _string(fields["footer"], f"{what} footer", 1_000)
        if fields.get("slideNumber") is not None:
            options["slide_number"] = _boolean(fields["slideNumber"], f"{what} slideNumber")
        if fields.get("dateFormat") is not None:
            options["date_format"] = _string(fields["dateFormat"], f"{what} dateFormat", 64)
        if fields.get("fixedDate") is not None:
            options["fixed_date"] = _string(fields["fixedDate"], f"{what} fixedDate", 64)
        if fields.get("skipTitleSlides") is not None:
            options["skip_title_slides"] = _boolean(fields["skipTitleSlides"], f"{what} skipTitleSlides")
        if fields.get("slide") is not None:
            slide = _slide_at(presentation, fields["slide"], what)
            _applying(slide.apply_footers, **options)
            return {
                "kind": kind,
                "evidence": {"scope": "slide", "slideId": slide.slide_id, "applied": sorted(options)},
            }
        _applying(presentation.apply_footers, **options)
        return {
            "kind": kind,
            "evidence": {
                "scope": "deck",
                "slides": len(_slides_of(presentation)),
                "applied": sorted(options),
            },
        }

    slide = _slide_at(presentation, fields["slide"], what)
    shape = _shape_at(slide, fields, what)

    if kind == "deleteShape":
        shape_id = shape.shape_id
        name = shape.name
        _applying(slide.shapes.delete, shape)
        return {
            "kind": kind,
            "evidence": {
                "slideId": slide.slide_id,
                "shapeId": shape_id,
                "name": name,
                "shapes": len(slide.shapes),
            },
        }

    if kind == "moveShape":
        to_index = _integer(fields["to"], f"{what} to", 0, 10**6)
        shape_id = shape.shape_id
        name = shape.name
        _applying(slide.shapes.move, shape, to_index)
        return {
            "kind": kind,
            "evidence": {
                "slideId": slide.slide_id,
                "shapeId": shape_id,
                "name": name,
                "to": to_index,
            },
        }

    copy = _applying(slide.shapes.add_copy, shape)
    return {
        "kind": kind,
        "evidence": {
            "slideId": slide.slide_id,
            "sourceShapeId": shape.shape_id,
            "shapeId": copy.shape_id,
            "name": copy.name,
            "shapes": len(slide.shapes),
        },
    }


def _steps(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list) or not value:
        _fail("invalid-request", "edit needs a non-empty list of steps")
    if len(value) > MAX_STEPS:
        _fail("invalid-request", f"edit takes at most {MAX_STEPS} steps")
    return [_object(step, f"step {index}") for index, step in enumerate(value)]


def _report(
    operation: str,
    presentation: Any,
    source_path: str,
    path: str,
    reference: Dict[str, Any],
    name: str,
    payload: Dict[str, Any],
    detail: str,
) -> Dict[str, Any]:
    """Save through the fork's narrow save, then report the change set, diff and preservation."""
    patch = _applying(paper_package.patch_save, source_path, presentation, path)
    change_set = _change_set(source_path, path)
    diff = _diff(source_path, path, detail)
    preview = _before_after(source_path, path, diff)
    preservation = _preservation(source_path, path, [item["part"] for item in change_set["changed"]])
    preservation["verbatimCopy"] = bool(patch.is_empty and preservation["verbatimCopy"])
    sha, size = _written(path)
    patch_payload = patch.to_dict()
    overflow = _deck_overflow(presentation)
    return _envelope(
        operation,
        source=_source(reference),
        proposal={
            "status": "proposed",
            "name": name,
            "editOf": reference["versionId"],
            "sha256": sha,
            "size": size,
            "published": False,
        },
        **payload,
        changeSet=change_set,
        diff=diff,
        preview=preview,
        preservation=preservation,
        patch={
            "schema": patch_payload["schema"],
            "version": patch_payload["version"],
            "residualCount": len(patch_payload["deltas"]),
            "isEmpty": patch.is_empty,
        },
        overflow=overflow["totals"],
        overflowSlides=overflow["slides"][:MAX_OVERFLOW_SLIDES],
        reopened=_reopened(path),
        rendering=RENDERING,
    )


def _edit(params: Dict[str, Any]) -> Dict[str, Any]:
    entry = _object(params, "edit parameters", ("ref", "output", "steps", "detail"))
    _required(entry, ("ref", "output", "steps"), "edit parameters")
    reference = _reference(entry["ref"], "edit source")
    name = _output_name(entry["output"])
    detail = _one_of(entry.get("detail", "text"), "edit detail", DIFF_DETAILS)
    steps = _steps(entry["steps"])

    path = documents.declare_output(name, "pptx", edit_of=reference["versionId"])
    source_path, presentation = _open(reference)
    changes = [_apply_step(presentation, spec) for spec in steps]
    return _report(
        "edit",
        presentation,
        source_path,
        path,
        reference,
        name,
        {"changes": changes, "steps": [spec.get("kind") for spec in steps]},
        detail,
    )


def _compose(params: Dict[str, Any]) -> Dict[str, Any]:
    entry = _object(
        params, "compose parameters", ("into", "from", "output", "mode", "notes", "detail")
    )
    _required(entry, ("into", "from", "output", "mode"), "compose parameters")
    into = _reference(entry["into"], "compose destination")
    origin_ref = _reference(entry["from"], "compose source")
    name = _output_name(entry["output"])
    mode = _one_of(entry["mode"], "a compose mode", COMPOSE_MODES)
    notes = True if entry.get("notes") is None else _boolean(entry["notes"], "compose notes")
    detail = _one_of(entry.get("detail", "text"), "compose detail", DIFF_DETAILS)

    path = documents.declare_output(name, "pptx", edit_of=into["versionId"])
    destination_path, destination = _open(into)
    origin_path = documents.open_input(origin_ref["versionId"])
    origin = _load(f"the leased input {origin_ref['name']!r}", origin_path)
    reports = _applying(deck_compose.append_deck, destination, origin, mode=mode, notes=notes)
    imports = []
    for report in reports:
        payload = report.to_dict()
        shifts, shifts_truncated = _bounded(payload["run_shifts"], MAX_DIFF_ENTRIES)
        imports.append(
            {
                "schema": payload["schema"],
                "version": payload["version"],
                "mode": payload["mode"],
                "sourceSlide": payload["source_slide"],
                "destSlide": payload["dest_slide"],
                "destSlideId": payload["dest_slide_id"],
                "position": payload["position"],
                "layoutBinding": payload["layout_binding"],
                "layoutBindingMethod": payload["layout_binding_method"],
                "partsAdded": payload["parts_added"],
                "partsReused": payload["parts_reused"],
                "notesCopied": payload["notes_copied"],
                "commentsDropped": payload["comments_dropped"],
                "runShifts": shifts,
                "runShiftsTotal": len(payload["run_shifts"]),
                "runShiftsTruncated": shifts_truncated,
            }
        )
    return _report(
        "compose",
        destination,
        destination_path,
        path,
        into,
        name,
        {
            "sources": {"into": _source(into), "from": _source(origin_ref)},
            "mode": mode,
            "imports": imports,
            "importCount": len(imports),
        },
        detail,
    )


def _preview(params: Dict[str, Any]) -> Dict[str, Any]:
    entry = _object(params, "preview parameters", ("ref", "cursor", "pageSize"))
    _required(entry, ("ref",), "preview parameters")
    reference = _reference(entry["ref"], "preview ref")
    cursor, page_size = _paging(entry)
    path, presentation = _open(reference)
    manifest = _applying(deck_inspect.inspect_deck, presentation)
    slides = _slides_of(presentation)
    items = []
    for position, slide in enumerate(slides):
        blocks = _applying(deck_inspect.inspect_text, slide).blocks
        items.append(_slide_preview(slide, manifest.slides[position], position, blocks))
    overflow = _deck_overflow(presentation)
    references, orphans = _deck_media(presentation)
    census = _deck_census(presentation, manifest)
    return _envelope(
        "preview",
        source=_source(reference),
        page=_page(items, cursor, page_size, "slides"),
        deck=census,
        overflow=overflow["totals"],
        overflowSlides=overflow["slides"][:MAX_OVERFLOW_SLIDES],
        media={"references": references[:MAX_MEDIA], "orphanParts": orphans},
        warnings=_warnings(census, orphans),
        rendering=RENDERING,
    )


def _compare(params: Dict[str, Any]) -> Dict[str, Any]:
    entry = _object(params, "compare parameters", ("from", "to", "detail"))
    _required(entry, ("from", "to"), "compare parameters")
    from_ref = _reference(entry["from"], "compare from")
    to_ref = _reference(entry["to"], "compare to")
    detail = _one_of(entry.get("detail", "text"), "compare detail", DIFF_DETAILS)
    from_path = documents.open_input(from_ref["versionId"])
    to_path = documents.open_input(to_ref["versionId"])
    _load(f"the leased input {from_ref['name']!r}", from_path)
    _load(f"the leased input {to_ref['name']!r}", to_path)
    change_set = _change_set(from_path, to_path)
    diff = _diff(from_path, to_path, detail)
    preview = _before_after(from_path, to_path, diff)
    return _envelope(
        "compare",
        sources={"from": _source(from_ref), "to": _source(to_ref)},
        changeSet=change_set,
        diff=diff,
        preview=preview,
        identical=bool(change_set["semanticallyEmpty"] and diff["identical"]),
        rendering=RENDERING,
    )


OPERATIONS = {
    "inspect": _inspect,
    "read": _read,
    "create": _create,
    "edit": _edit,
    "preview": _preview,
    "compare": _compare,
    "compose": _compose,
}


def run(operation: str, parameters: Any) -> Dict[str, Any]:
    """Run one typed PowerPoint operation. ``operation`` is fixed by the submitted code."""
    if operation not in OPERATIONS:
        _fail("invalid-request", f"{operation!r} is not a PowerPoint operation")
    return OPERATIONS[operation](_object(parameters, "operation parameters"))


__all__ = ["run", "SCHEMA", "VERSION", "OPERATIONS"]