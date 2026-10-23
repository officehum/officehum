"""The typed Excel adapter for the Paper Office worker (paper-xlsx).

Six operations, one per call: ``inspect``, ``read``, ``create``, ``edit``, ``preview`` and
``compare``. Each takes a **leased input reference** — a FileStore version id with the name, hash
and size the lease pinned — never a server path, and answers with bounded JSON. Nothing here calls a
model, so the same operation and parameters produce the same result, and the worker that runs it
binds the code hash, the argument hash and the leased source hashes into one receipt.

The path story is the same as the Word and PowerPoint adapters': ``documents.open_input(version_id)``
returns the read-only copy of a leased version, ``documents.declare_output(name, "xlsx",
edit_of=...)`` returns a reserved path inside this run's staging directory, and neither is ever
chosen by a caller.

``openpyxl.preserve`` is what makes preservation arguable with bytes. It is on by default for
``load_workbook(path)``: the original package stays the source of truth, the object model is a set of
edits to it, and the save is a splice. An untouched worksheet keeps its original bytes because they
are raw-copied, not re-serialized — which is the whole point, because a *stock* round trip rewrites
every sheet part. The ``preservation`` block reports each byte-identical part's sha256, so
"the other sheets came back verbatim" is a hash comparison rather than a claim.

What this adapter refuses, and why it refuses it here as well as in the host:

- **macros** — upstream ``openpyxl`` keeps a VBA project only under ``keep_vba=True`` and drops it
  otherwise, so opening one would be a silent loss. ``xl/vbaProject.bin``, a macro-enabled content
  type and ``xl/vbaData.xml`` each refuse with ``macro-payload`` before any parser sees the file.
- **external links** — ``xl/externalLinks/*`` parts, ``xl/connections.xml``, a ``TargetMode="External"``
  relationship, an ``[1]Sheet!A1`` reference to another workbook and a URI-scheme relationship target
  all refuse with ``external-relationship``: they are exactly the reads that would leave the package.
- **malformed packages** — a ZIP that will not open, no ``[Content_Types].xml``, or XML the parser
  rejects refuse with ``malformed-package``.

**Recalculation cannot happen inside this worker, and the result says so.** ``openpyxl.oracle`` never
calculates formulas itself — its docstring is explicit that a partial engine is "a silent-wrongness
machine" — and delegates to headless LibreOffice. This worker forbids spawning a process (its import
guard denies ``subprocess`` and it patches ``os.exec*``/``system``/``popen``/``fork``), so no oracle
run is possible here even where LibreOffice is installed. Every result therefore carries a
``recalculation`` block with ``available``, ``attempted: False``, the reason, the functions the
oracle would not support anyway (``ORACLE_UNSUPPORTED_FUNCS``), and — honestly — nothing that looks
like a computed value. What the adapter *does* verify is arithmetically checkable without an engine:
the workbook's own cached values, its changed-cell set, its reference graph, and an explicit sum of
cells it names, computed here with exact arithmetic and labelled as this adapter's sum rather than a
recalculation. The proposal's own recalc request (``fullCalcOnLoad``/``forceFullCalc`` in
``xl/workbook.xml``, written by the fork's splice when a value changed) is reported, so a reviewer
knows Excel will recalculate when a person opens it.

Reference verification is the other half. ``inspect``, ``read``, ``edit`` and ``compare`` walk every
formula surface the model holds — cells, defined names, print areas, data validation, conditional
formatting, tables and chart series references — and report the ones that cannot resolve: a sheet
prefix naming a sheet this workbook does not have, a name that is not defined, a range outside the
grid, a structured reference to a table that is gone, and the ``#REF!`` operands and cached error
values ``openpyxl.preserve.hygiene`` finds. An operation that would *create* a broken reference
refuses with ``broken-reference`` and writes nothing; a source that already has one is reported, not
silently fixed and not refused, because a reviewer needs to see it.

Bounded by construction: every page has a size, a cursor and a total; every string is truncated with
an explicit flag; the change set, the dependency list, the numeric checks, the preservation list,
the preview lines and the reference report all carry budgets and say what they left out.

Refusals are ``documents.WorkspaceError`` with a stable code — ``invalid-request``,
``broken-reference``, ``macro-payload``, ``external-relationship``, ``malformed-package``,
``unsupported-structure``, ``target-not-found``, ``ambiguous-target``, ``relationship-policy``,
``boundary-violation``, ``output-format``, ``package-limit`` — or the workspace's own codes for a bad
name, a bad lease reference or a read-only source. Every one of them leaves the source bytes
unchanged: nothing here writes outside the staging directory, and the workspace hashes the inputs
again after the run.
"""

from __future__ import annotations

import hashlib
import math
import re
import zipfile
from datetime import date, datetime, time as time_of_day, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, NoReturn, Optional, Sequence, Tuple
from xml.etree import ElementTree

import openpyxl
import openpyxl.oracle as oracle
import openpyxl.package as paper_package
from openpyxl import Workbook, load_workbook
from openpyxl.errors import (
    AmbiguousTargetError,
    BoundaryViolationError,
    PaperRefusal,
    RelationshipPolicyError,
    TargetNotFoundError,
    UnsupportedStructureError,
)
from openpyxl.formula import Tokenizer
from openpyxl.formula.tokenizer import TokenizerError
from openpyxl.preserve import diffreport, hygiene, perception, receipts
from openpyxl.preserve import references as paper_references
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils.cell import column_index_from_string, get_column_letter, range_boundaries
from openpyxl.workbook.defined_name import DefinedName

import officehum_documents as documents

SCHEMA = "paper_xlsx_operation"
VERSION = 1

MAX_PAGE = 50
DEFAULT_PAGE = 20
MAX_ITEM_TEXT = 240
MAX_CELL_TEXT = 160
MAX_STEPS = 32
MAX_CREATED_SHEETS = 32
MAX_RANGE_CELLS = 4096
MAX_OUTLINE = 50
MAX_NAMED = 50
MAX_CHARTS = 25
MAX_CHANGED_CELLS = 60
MAX_DEPENDENTS = 25
MAX_BROKEN = 25
MAX_PART_HASHES = 24
MAX_NUMERIC_CHECKS = 20
MAX_SUM_CELLS = 32
MAX_PREVIEW_LINES = 60
MAX_CHART_REFERENCES = 8
MAX_TEXT = 4_000
MAX_NAME_REFERENCE = 512

#: The one format this adapter owns.
FORMAT = "xlsx"

#: The sections ``read`` pages through, in the order the issue names them.
READ_SECTIONS = ("sheets", "cells", "formulas", "names", "styles", "charts")

#: Excel's own grid, so a range outside it can be named as broken rather than clamped silently.
EXCEL_MAX_ROW = 1_048_576
EXCEL_MAX_COLUMN = 16_384

REF_KEYS = ("fileId", "versionId", "name", "sha256", "size")

#: The parts that make a workbook a macro-enabled one, or an outbound link.
MACRO_PARTS = ("xl/vbaproject.bin", "xl/vbadata.xml", "xl/vbaprojectsignature.bin")
EXTERNAL_PART_PREFIXES = ("xl/externallinks/", "xl/connections.xml")
EXTERNAL_CONTENT_TYPES = ("macroenabled", "externallink")

STEP_FIELDS: Dict[str, Tuple[Tuple[str, ...], Tuple[str, ...]]] = {
    "setCell": (("cell",), ("sheet", "value", "formula")),
    "setRange": (("range", "rows"), ("sheet",)),
    "clearCells": (("range",), ("sheet",)),
    "setStyle": (("range", "style"), ("sheet",)),
    "setColumnWidth": (("width",), ("sheet", "column", "columns")),
    "addSheet": (("name",), ("at",)),
    "deleteSheet": (("sheet",), ()),
    "renameSheet": (("sheet", "to"), ()),
    "setName": (("name", "reference"), ("scope",)),
    "removeName": (("name",), ("scope", "sheet")),
}

STYLE_FIELDS = (
    "bold",
    "italic",
    "size",
    "name",
    "color",
    "fillColor",
    "numberFormat",
    "horizontal",
    "vertical",
    "wrapText",
)

#: What a caller must know about calculation in this workspace. Reported, never hidden.
_UNSUPPORTED_FUNCTIONS = tuple(sorted(oracle.ORACLE_UNSUPPORTED_FUNCS))


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


def _boolean(value: Any, what: str) -> bool:
    if not isinstance(value, bool):
        _fail("invalid-request", f"{what} must be true or false")
    return value


def _integer(value: Any, what: str, low: int, high: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        _fail("invalid-request", f"{what} must be an integer between {low} and {high}")
    return value


def _number(value: Any, what: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail("invalid-request", f"{what} must be a number")
    number = float(value)
    if not math.isfinite(number) or not low <= number <= high:
        _fail("invalid-request", f"{what} must be a finite number between {low} and {high}")
    return number


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
    if not name.lower().endswith(".xlsx"):
        _fail("output-format", f"an output named {name!r} is not an .xlsx file")
    return name


def _truncate(value: Any, limit: int) -> Tuple[str, bool]:
    text = "" if value is None else str(value)
    if len(text) <= limit:
        return text, False
    return text[:limit], True


def _bounded(value: Sequence[Any], limit: int) -> Tuple[List[Any], bool]:
    return list(value[:limit]), len(value) > limit


def _page_of(entry: Dict[str, Any]) -> Tuple[int, int]:
    cursor = 0 if entry.get("cursor") is None else _integer(entry["cursor"], "cursor", 0, 10**9)
    page_size = (
        DEFAULT_PAGE
        if entry.get("pageSize") is None
        else _integer(entry["pageSize"], "pageSize", 1, MAX_PAGE)
    )
    return cursor, page_size


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


def _envelope(operation: str, **fields: Any) -> Dict[str, Any]:
    return {"schema": SCHEMA, "version": VERSION, "operation": operation, "ok": True, **fields}


# -- the package guard: macros, external links, malformed archives ---------------------------------


def _zip_names(path: str, what: str) -> List[str]:
    try:
        with zipfile.ZipFile(path) as archive:
            return list(archive.namelist())
    except (zipfile.BadZipFile, OSError, ValueError) as error:
        _fail("malformed-package", f"{what} is not a readable Office package: {error}")


def _zip_text(archive: zipfile.ZipFile, name: str) -> str:
    try:
        return archive.read(name).decode("utf-8", "replace")
    except (KeyError, OSError, zipfile.BadZipFile, ValueError):
        return ""


def _read_part(path: str, name: str) -> bytes:
    try:
        with zipfile.ZipFile(path) as archive:
            return archive.read(name)
    except (KeyError, OSError, zipfile.BadZipFile, ValueError):
        return b""


def _guard_package(path: str, what: str) -> Dict[str, Any]:
    """Refuse a macro-bearing, externally-linked or malformed package before any parser sees it.

    This is the adapter's own gate, not a second copy of the host's: a worker driven directly — by a
    submitted snippet, or by a host that skipped its structural inspection — still refuses here. The
    returns are the package facts the report needs anyway.
    """
    names = _zip_names(path, what)
    lower = [name.lower() for name in names]
    for part in MACRO_PARTS:
        if part in lower:
            _fail(
                "macro-payload",
                f"{what} holds a VBA project ({part}); this adapter refuses macros rather than "
                "dropping them, which is what opening one would do",
            )
    content_types = _zip_text(zipfile.ZipFile(path), "[Content_Types].xml").lower()
    if content_types == "":
        _fail("malformed-package", f"{what} is not an Office package: no [Content_Types].xml")
    if any(token in content_types for token in EXTERNAL_CONTENT_TYPES):
        _fail(
            "macro-payload" if "macroenabled" in content_types else "external-relationship",
            f"{what} declares content this adapter does not open (see its [Content_Types].xml)",
        )
    external: List[str] = []
    for name in names:
        if name.lower().startswith(EXTERNAL_PART_PREFIXES):
            external.append("/" + name)
        if name.lower().endswith(".rels"):
            payload = _zip_text(zipfile.ZipFile(path), name)
            if re.search(r'TargetMode\s*=\s*"External"', payload, re.I) or re.search(
                r'Target\s*=\s*"[A-Za-z][A-Za-z0-9+.-]*:', payload
            ):
                external.append("/" + name)
    if external:
        _fail(
            "external-relationship",
            f"{what} links outside the package ({', '.join(sorted(set(external))[:4])}), which this "
            "workspace will not open: an external link is a read that leaves the file",
        )
    return {
        "parts": len(names),
        "macros": False,
        "externalLinks": [],
        "calcChain": any(name.lower() == "xl/calcchain.xml" for name in lower),
    }


# -- opening a leased version ----------------------------------------------------------------------


def _load(path: str, what: str, data_only: bool = False) -> Any:
    try:
        return load_workbook(path, data_only=data_only)
    except UnsupportedStructureError as error:
        _fail("unsupported-structure", f"{what} holds structure this version cannot open: {error}")
    except (PaperRefusal, ValueError, KeyError, OSError, zipfile.BadZipFile, RuntimeError) as error:
        _fail(
            "malformed-package",
            f"{what} is not a readable workbook: {type(error).__name__}: {error}",
        )


def _open(reference: Dict[str, Any]) -> Tuple[str, Any, Dict[str, Any]]:
    """(path, workbook, package facts) for a leased version, or a typed refusal."""
    path = documents.open_input(reference["versionId"])
    what = f"the leased input {reference['name']!r}"
    facts = _guard_package(path, what)
    return path, _load(path, what), facts


def _measure(path: str, what: str) -> Any:
    """A second, independent model of a package — for measuring what was written, not what was meant."""
    return _load(path, what)


def _applying(call: Any, *args: Any, **kwargs: Any) -> Any:
    """Run one fork operation, turning its typed refusal into one of this workspace's codes."""
    try:
        return call(*args, **kwargs)
    except documents.WorkspaceError:
        raise
    except AmbiguousTargetError as error:
        _fail("ambiguous-target", str(error))
    except TargetNotFoundError as error:
        _fail("target-not-found", str(error))
    except RelationshipPolicyError as error:
        _fail("relationship-policy", str(error))
    except BoundaryViolationError as error:
        _fail("boundary-violation", str(error))
    except UnsupportedStructureError as error:
        if "strand references" in str(error):
            _fail("broken-reference", str(error))
        _fail("unsupported-structure", str(error))
    except PaperRefusal as error:
        _fail("unsupported-structure", f"{type(error).__name__}: {error}")


def _sheet(wb: Any, value: Any, what: str) -> Any:
    title = _string(value, what, 255)
    for sheet in wb.worksheets:
        if sheet.title == title:
            return sheet
    available = sorted(sheet.title for sheet in wb.worksheets)
    _fail(
        "target-not-found",
        f"{what} names sheet {title!r}, which this workbook does not have; it has: "
        + ", ".join(available),
    )


def _optional_sheet(wb: Any, value: Any, what: str) -> Optional[Any]:
    return None if value is None else _sheet(wb, value, what)


def _coordinate(value: Any, what: str) -> str:
    """One A1 coordinate, normalized. Absolute markers are accepted and dropped."""
    text = _string(value, what, 32).replace("$", "").upper()
    match = re.fullmatch(r"([A-Z]{1,3})([0-9]{1,7})", text)
    if match is None:
        _fail("invalid-request", f"{what} must be a single cell address such as B7")
    row = int(match.group(2))
    column = column_index_from_string(match.group(1))
    if not 1 <= row <= EXCEL_MAX_ROW or not 1 <= column <= EXCEL_MAX_COLUMN:
        _fail("invalid-request", f"{what} is outside the spreadsheet grid")
    return f"{match.group(1)}{row}"


def _bounded_range(value: Any, what: str) -> Tuple[str, Optional[str], Tuple[int, int, int, int]]:
    """(normalized text, sheet prefix or None, bounds) for a range, within this adapter's budget.

    A range this adapter will not read as one page set is refused with the limit named rather than
    silently clamped: a caller that asked for a million cells needs to know it did not get them.
    """
    text = _string(value, what, 128).replace("$", "")
    prefix, core = _split_sheet_prefix(text)
    try:
        min_col, min_row, max_col, max_row = range_boundaries(core.upper())
    except (TypeError, ValueError, IndexError):
        _fail("invalid-request", f"{what} is not a range such as A1:C10")
    if min_col is None or min_row is None or max_col is None or max_row is None:
        _fail("invalid-request", f"{what} is not a finite range such as A1:C10")
    if min_row < 1 or min_col < 1 or max_row > EXCEL_MAX_ROW or max_col > EXCEL_MAX_COLUMN:
        _fail("invalid-request", f"{what} is outside the spreadsheet grid")
    if max_row < min_row or max_col < min_col:
        _fail("invalid-request", f"{what} is reversed")
    area = (max_row - min_row + 1) * (max_col - min_col + 1)
    if area > MAX_RANGE_CELLS:
        _fail(
            "invalid-request",
            f"{what} covers {area} cells; this adapter reads at most {MAX_RANGE_CELLS} cells in one "
            "range. Read it in parts.",
        )
    core_text = (
        f"{get_column_letter(min_col)}{min_row}"
        if (min_row, min_col, max_row, max_col) == (min_row, min_col, min_row, min_col)
        else f"{get_column_letter(min_col)}{min_row}:{get_column_letter(max_col)}{max_row}"
    )
    return core_text, prefix, (min_col, min_row, max_col, max_row)


_SHEET_PREFIX = re.compile(r"^(?:'((?:[^']|'')+)'|([^'!\[\]]+))!(.*)$")


def _split_sheet_prefix(text: str) -> Tuple[Optional[str], str]:
    """(sheet title or None, the rest). Handles the quoted form Excel writes for odd titles."""
    stripped = text.strip()
    if stripped.startswith("["):
        _fail(
            "external-relationship",
            f"the reference {text!r} names another workbook, which this workspace does not open",
        )
    match = _SHEET_PREFIX.match(stripped)
    if match is None:
        return None, stripped
    title = match.group(1).replace("''", "'") if match.group(1) is not None else (match.group(2) or "")
    return title, match.group(3)


def _qualified(sheet_title: str, reference: str) -> str:
    """A reference addressed with a sheet title, quoted when the title needs it."""
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", sheet_title):
        return f"{sheet_title}!{reference}"
    return f"'{sheet_title.replace(chr(39), chr(39) * 2)}'!{reference}"


# -- reading cells ---------------------------------------------------------------------------------


def _scalar(value: Any) -> Dict[str, Any]:
    """One cell value as JSON, with the exact text a numeric check needs and never a NaN.

    JSON has no NaN or Infinity, and a workbook may hold either; they are reported as ``nonFinite``
    with their exact text rather than being dropped or turned into ``null``.
    """
    if value is None:
        return {"value": None, "kind": "empty", "exact": None}
    if isinstance(value, bool):
        return {"value": value, "kind": "boolean", "exact": "TRUE" if value else "FALSE"}
    if isinstance(value, int):
        return {"value": value, "kind": "number", "exact": str(value)}
    if isinstance(value, float):
        if not math.isfinite(value):
            return {"value": None, "kind": "number", "exact": repr(value), "nonFinite": True}
        return {"value": value, "kind": "number", "exact": repr(value)}
    if isinstance(value, Decimal):
        return {"value": str(value), "kind": "number", "exact": str(value), "decimal": True}
    if isinstance(value, datetime):
        return {"value": value.isoformat(), "kind": "datetime", "exact": value.isoformat()}
    if isinstance(value, date):
        return {"value": value.isoformat(), "kind": "date", "exact": value.isoformat()}
    if isinstance(value, time_of_day):
        return {"value": value.isoformat(), "kind": "time", "exact": value.isoformat()}
    if isinstance(value, timedelta):
        return {"value": value.total_seconds(), "kind": "duration", "exact": str(value)}
    text, truncated = _truncate(value, MAX_ITEM_TEXT)
    return {"value": text, "kind": "text", "exact": None, "truncated": truncated}


def _exact_decimal(value: Any) -> Optional[str]:
    """The exact decimal text of a numeric value, or None when the value is not a number."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return repr(value)
    if isinstance(value, Decimal):
        return str(value)
    return None


def _style_signature(cell: Any) -> Dict[str, Any]:
    """A cell's visible formatting as a small comparable record. Read, never inferred."""
    font = cell.font
    fill = cell.fill
    alignment = cell.alignment
    border = cell.border
    return {
        "numberFormat": cell.number_format,
        "bold": bool(font.bold),
        "italic": bool(font.italic),
        "underline": font.underline if font.underline is not None else None,
        "fontName": font.name,
        "fontSize": float(font.sz) if font.sz is not None else None,
        "fontColor": _color_text(font.color),
        "fillColor": _color_text(fill.fgColor) if fill.patternType else None,
        "fillPattern": fill.patternType,
        "horizontal": alignment.horizontal,
        "vertical": alignment.vertical,
        "wrapText": bool(alignment.wrap_text),
        "borderStyle": border.left.style if border.left is not None else None,
        "locked": cell.protection.locked if cell.protection is not None else None,
    }


def _color_text(color: Any) -> Optional[str]:
    if color is None:
        return None
    if getattr(color, "type", None) == "rgb" and isinstance(color.rgb, str):
        return color.rgb[-6:].upper()
    if getattr(color, "theme", None) is not None:
        return f"theme:{color.theme}"
    if getattr(color, "indexed", None) is not None:
        return f"indexed:{color.indexed}"
    return None


def _cell_item(sheet: Any, cell: Any, cached: Optional[Any], cache_known: bool) -> Dict[str, Any]:
    scalar = _scalar(cell.value)
    formula: Optional[str] = None
    if cell.data_type == "f" and isinstance(cell.value, str):
        formula, formula_truncated = _truncate(cell.value, MAX_ITEM_TEXT)
        scalar = {"value": None, "kind": "formula", "exact": None}
    else:
        formula_truncated = False
    cached_scalar = _scalar(cached)
    item: Dict[str, Any] = {
        "sheet": sheet.title,
        "address": _qualified(sheet.title, cell.coordinate),
        "row": cell.row,
        "column": cell.column,
        "value": scalar.get("value"),
        "valueKind": scalar["kind"],
        "exact": scalar.get("exact"),
        "formula": formula,
        "formulaTruncated": formula_truncated,
        "cachedValue": cached_scalar.get("value") if formula is not None else None,
        "cachedKnown": bool(cache_known and formula is not None),
        "nonFinite": bool(scalar.get("nonFinite")),
        "numberFormat": cell.number_format,
        "styled": bool(cell.has_style),
    }
    if scalar.get("truncated"):
        item["truncated"] = True
    return item


def _present_cells(sheet: Any) -> List[Any]:
    """Every cell the model holds, in reading order. An untouched empty grid is not a page set."""
    return [cell for _key, cell in sorted(sheet._cells.items(), key=lambda item: item[0])]


def _cached_model(path: str, what: str) -> Any:
    """A second load that keeps the values the file itself cached, so they can be reported as such."""
    return _load(path, what, data_only=True)


def _cached_value(cached_wb: Any, title: str, coordinate: str) -> Tuple[Any, bool]:
    if cached_wb is None:
        return None, False
    if title not in cached_wb.sheetnames:
        return None, False
    cell = cached_wb[title][coordinate]
    if cell.value is None:
        return None, False
    return cell.value, True


def _used_bounds(sheet: Any) -> Tuple[int, int, int, int]:
    """The rectangle the sheet's own cells occupy, or A1:A1 for an empty sheet."""
    rows = [row for row, _column in sheet._cells] or [1]
    columns = [column for _row, column in sheet._cells] or [1]
    return min(columns), min(rows), max(columns), max(rows)


def _window(
    sheet: Any, bounds: Optional[Tuple[int, int, int, int]]
) -> Tuple[Tuple[int, int, int, int], bool, Optional[str]]:
    """The rectangle a read will actually walk, and whether the sheet forced a narrower one."""
    if bounds is not None:
        return bounds, False, None
    min_col, min_row, max_col, max_row = _used_bounds(sheet)
    if (max_col - min_col + 1) * (max_row - min_row + 1) <= MAX_RANGE_CELLS:
        return (min_col, min_row, max_col, max_row), False, None
    columns = min(max_col, min_col + MAX_RANGE_CELLS // max(1, max_row - min_row + 1) - 1, min_col + 16383)
    reason = (
        f"the sheet's used range is larger than the {MAX_RANGE_CELLS} cells this adapter reads in "
        f"one call, so the default window was narrowed to columns {get_column_letter(min_col)} to "
        f"{get_column_letter(max(columns, min_col))}; ask for a range to read another part of it"
    )
    return (min_col, min_row, max(columns, min_col), max_row), True, reason


# -- reference verification ------------------------------------------------------------------------


def _defined_name_index(wb: Any) -> Dict[str, Any]:
    """Every defined name by its lower-cased name: workbook-scoped first, then sheet-scoped."""
    index: Dict[str, Any] = {}
    for name, definition in wb.defined_names.items():
        index[name.lower()] = {"scope": "workbook", "sheet": None, "definition": definition}
    for sheet in wb.worksheets:
        for name, definition in sheet.defined_names.items():
            index.setdefault(
                name.lower(),
                {"scope": "sheet", "sheet": sheet.title, "definition": definition},
            )
    return index


def _table_index(wb: Any) -> Dict[str, str]:
    index: Dict[str, str] = {}
    for sheet in wb.worksheets:
        for name, table in sheet.tables.items():
            index[name.lower()] = sheet.title
            index[str(table.displayName).lower()] = sheet.title
    return index


def _known_titles(wb: Any) -> Dict[str, str]:
    titles: Dict[str, str] = {}
    for sheet in list(wb.worksheets) + list(wb.chartsheets):
        titles[sheet.title.lower()] = sheet.title
    return titles


def _reference_kind(text: str, titles: Dict[str, str], names: Dict[str, Any], tables: Dict[str, str]) -> Optional[Dict[str, Any]]:
    """Resolve one formula operand against the workbook's own names, sheets and tables.

    Returns None when the operand is not a reference at all (a literal, a number, a text token), and
    a record with ``resolved: False`` and a ``reason`` when it is one that cannot be found.
    """
    raw = text.strip()
    if raw == "" or raw.startswith('"') or raw.startswith("#"):
        return None
    if re.fullmatch(r"-?[0-9.eE+]+", raw) or raw.upper() in ("TRUE", "FALSE"):
        return None
    if raw.startswith("[") or re.search(r"\[[0-9]+\]", raw):
        return {
            "raw": raw,
            "kind": "external-workbook",
            "resolved": False,
            "detail": "the reference names another workbook",
        }
    if "[" in raw and "]" in raw and "!" not in raw:
        table = raw.split("[", 1)[0].strip()
        if table.lower() in tables:
            return {"raw": raw, "kind": "table-column", "resolved": True, "detail": tables[table.lower()]}
        return {
            "raw": raw,
            "kind": "missing-table",
            "resolved": False,
            "detail": "the structured reference names a table this workbook does not have",
        }
    title, core = _split_sheet_prefix_loose(raw)
    if title is not None and title.lower() not in titles:
        return {
            "raw": raw,
            "kind": "missing-sheet",
            "resolved": False,
            "detail": f"no sheet named {title!r}",
        }
    if title is not None and "!" in core:
        # `Sheet1!A1:Sheet1!B2` — both endpoints named. Legal, and both must name the same sheet.
        second_title, second_core = _split_sheet_prefix_loose(core.split("!", 1)[0] + "!" + core.split("!", 1)[1])
        same = second_title is not None and second_title.lower() in titles
        if same:
            core = f"{core.split('!', 1)[0]}:{second_core}"
        else:
            return {
                "raw": raw,
                "kind": "unresolvable-range",
                "resolved": False,
                "detail": "the range names two different sheets",
            }
    target = core.upper().replace("$", "")
    if re.fullmatch(r"[A-Z]{1,3}(:[A-Z]{1,3})?", target) or re.fullmatch(
        r"[0-9]{1,7}(:[0-9]{1,7})?", target
    ):
        # A whole column or a whole row: a legal reference, and one this adapter cannot call broken.
        if re.fullmatch(r"[A-Z]{1,3}(:[A-Z]{1,3})?", target) and any(
            column_index_from_string(part) > EXCEL_MAX_COLUMN for part in target.split(":")
        ):
            return {
                "raw": raw,
                "kind": "out-of-grid-range",
                "resolved": False,
                "detail": f"the range {target} is outside the spreadsheet grid",
            }
        if re.fullmatch(r"[0-9]{1,7}(:[0-9]{1,7})?", target) and any(
            int(part) > EXCEL_MAX_ROW for part in target.split(":")
        ):
            return {
                "raw": raw,
                "kind": "out-of-grid-range",
                "resolved": False,
                "detail": f"the range {target} is outside the spreadsheet grid",
            }
        return {
            "raw": raw,
            "kind": "cell-range",
            "resolved": True,
            "sheet": titles.get(title.lower()) if title is not None else None,
            "detail": target,
        }
    if re.fullmatch(r"[A-Z]{1,3}[0-9]{1,7}(:[A-Z]{1,3}[0-9]{1,7})?", target):
        try:
            min_col, min_row, max_col, max_row = range_boundaries(target)
        except (TypeError, ValueError, IndexError):
            return {
                "raw": raw,
                "kind": "unresolvable-range",
                "resolved": False,
                "detail": "the range cannot be read as coordinates",
            }
        if (
            min_row is None
            or min_col is None
            or max_row is None
            or max_col is None
            or min_row < 1
            or min_col < 1
            or max_row > EXCEL_MAX_ROW
            or max_col > EXCEL_MAX_COLUMN
        ):
            return {
                "raw": raw,
                "kind": "out-of-grid-range",
                "resolved": False,
                "detail": f"the range {target} is outside the spreadsheet grid",
            }
        return {
            "raw": raw,
            "kind": "cell-range",
            "resolved": True,
            "sheet": titles.get(title.lower()) if title is not None else None,
            "detail": target,
        }
    if core.upper() in ("TRUE", "FALSE"):
        return None
    if core.lower() in names:
        return {"raw": raw, "kind": "defined-name", "resolved": True, "detail": core}
    if re.fullmatch(r"[A-Za-z_\\][A-Za-z0-9_.\\]*", core):
        return {
            "raw": raw,
            "kind": "missing-name",
            "resolved": False,
            "detail": f"no defined name {core!r} in this workbook",
        }
    return {
        "raw": raw,
        "kind": "unresolved-reference",
        "resolved": False,
        "detail": "the operand is not a reference this adapter can resolve",
    }


def _split_sheet_prefix_loose(text: str) -> Tuple[Optional[str], str]:
    """(prefix or None, rest) without refusing a bracketed external reference — that is reported."""
    match = _SHEET_PREFIX.match(text.strip())
    if match is None:
        return None, text.strip()
    title = match.group(1).replace("''", "'") if match.group(1) is not None else (match.group(2) or "")
    return title, match.group(3)


def _formula_references(formula: str, titles: Dict[str, str], names: Dict[str, Any], tables: Dict[str, str]) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """(references, tokenizer error). A formula that will not tokenize is reported, never guessed."""
    try:
        tokens = Tokenizer(formula).items
    except (TokenizerError, IndexError, ValueError) as error:
        return [], f"{type(error).__name__}: {error}"
    found: List[Dict[str, Any]] = []
    for token in tokens:
        if token.type != "OPERAND":
            continue
        if token.subtype == "TEXT":
            continue
        if token.subtype == "ERROR":
            found.append(
                {
                    "raw": token.value,
                    "kind": "error-operand",
                    "resolved": False,
                    "detail": "the formula carries an Excel error operand",
                }
            )
            continue
        resolved = _reference_kind(token.value, titles, names, tables)
        if resolved is not None:
            found.append(resolved)
    return found, None


def _reference_check(wb: Any, path: str, what: str) -> Dict[str, Any]:
    """Every formula reference the model holds, and the ones that cannot resolve.

    Built on the fork's own ``formula_surfaces`` — cells, defined names, print areas, data validation,
    conditional formatting, table ranges and chart series — so "every reference" means every surface
    the library itself rewrites on a rename or a shift, and nothing this adapter thought of on its own.
    """
    titles = _known_titles(wb)
    names = _defined_name_index(wb)
    tables = _table_index(wb)
    broken: List[Dict[str, Any]] = []
    checked = 0
    surfaces = 0
    unreadable: List[Dict[str, Any]] = []
    kinds: Dict[str, int] = {}
    for surface in paper_references.formula_surfaces(wb):
        value = surface.value
        if not isinstance(value, str) or value.strip() == "":
            continue
        surfaces += 1
        probe = value if value.startswith("=") else "=" + value
        references, error = _formula_references(probe, titles, names, tables)
        if error is not None:
            unreadable.append(
                {"where": surface.label, "reason": error, "kind": "unscannable-formula"}
            )
            continue
        for reference in references:
            checked += 1
            kinds[reference["kind"]] = kinds.get(reference["kind"], 0) + 1
            if reference["resolved"]:
                continue
            broken.append({"where": surface.label, "owner": _owner_of(surface), **reference})
    for found in hygiene.scan_errors(wb):
        broken.append(
            {
                "where": found["address"],
                "owner": "cell",
                "raw": found["value"],
                "kind": "cached-error-value" if found["source"] == "value" else "error-operand",
                "resolved": False,
                "detail": f"the package holds the error value {found['value']} (source: {found['source']})",
            }
        )
    kept, truncated = _bounded(broken, MAX_BROKEN)
    return {
        "checkedReferences": checked,
        "checkedSurfaces": surfaces,
        "kinds": kinds,
        "broken": kept,
        "brokenTotal": len(broken),
        "brokenTruncated": truncated,
        "brokenKinds": sorted({item["kind"] for item in broken}),
        "unscannable": _bounded(unreadable, 8)[0],
        "clean": not broken,
        "scope": what,
        "partsScanned": len(_zip_names(path, what)),
    }


def _owner_of(surface: Any) -> str:
    if surface.cell:
        return "cell"
    if surface.name:
        return "name"
    if surface.range_ref:
        return "range"
    return "formula"


def _reference_signature(check: Dict[str, Any]) -> set:
    """The identity of a broken reference, so a *new* one can be told from a pre-existing one."""
    return {
        (item.get("where"), item.get("kind"), item.get("raw")) for item in check.get("broken", [])
    }


# -- workbook census, sheets, names, charts and styles ---------------------------------------------


def _sheet_part_map(path: str) -> Dict[str, str]:
    """{sheet title: worksheet part name} from the package itself, not from a guess."""
    workbook_xml = _read_part(path, "xl/workbook.xml")
    rels_xml = _read_part(path, "xl/_rels/workbook.xml.rels")
    if not workbook_xml or not rels_xml:
        return {}
    rel_targets: Dict[str, str] = {}
    try:
        for relationship in ElementTree.fromstring(rels_xml):
            identifier = relationship.get("Id")
            target = relationship.get("Target")
            if identifier and target:
                rel_targets[identifier] = target.lstrip("/")
    except ElementTree.ParseError:
        return {}
    mapping: Dict[str, str] = {}
    try:
        for sheet in ElementTree.fromstring(workbook_xml).iter():
            if not sheet.tag.endswith("}sheet") and sheet.tag != "sheet":
                continue
            title = sheet.get("name")
            identifier = sheet.get(
                "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
            )
            if title is None or identifier is None:
                continue
            target = rel_targets.get(identifier)
            if target is None:
                continue
            mapping[title] = target if target.startswith("xl/") else f"xl/{target}"
    except ElementTree.ParseError:
        return {}
    return mapping


def _calc_metadata(path: str) -> Dict[str, Any]:
    """The workbook's own recalculation request, read from the package rather than assumed."""
    workbook_xml = _read_part(path, "xl/workbook.xml")
    attributes: Dict[str, Any] = {}
    if workbook_xml:
        try:
            for element in ElementTree.fromstring(workbook_xml).iter():
                if element.tag.endswith("}calcPr") or element.tag == "calcPr":
                    attributes = {key: value for key, value in element.attrib.items()}
                    break
        except ElementTree.ParseError:
            attributes = {}
    return {
        "calcPr": attributes,
        "fullCalcOnLoad": attributes.get("fullCalcOnLoad"),
        "forceFullCalc": attributes.get("forceFullCalc"),
        "calcMode": attributes.get("calcMode"),
        "requestsRecalculation": (
            attributes.get("fullCalcOnLoad") in ("1", "true")
            or attributes.get("forceFullCalc") in ("1", "true")
        ),
    }


def _declared_names(wb: Any) -> List[Dict[str, Any]]:
    """Workbook- and sheet-scoped defined names, each resolved against the sheets it names."""
    titles = _known_titles(wb)
    items: List[Dict[str, Any]] = []

    def item(name: str, scope: str, sheet_title: Optional[str], definition: Any) -> Dict[str, Any]:
        text = definition.attr_text if isinstance(definition.attr_text, str) else ""
        prefix, core = _split_sheet_prefix_loose(text)
        resolved = True
        reason: Optional[str] = None
        kind = "formula" if text.startswith("=") or "(" in text else "range"
        if prefix is not None and prefix.lower() not in titles:
            resolved, reason, kind = False, f"no sheet named {prefix!r}", "broken-range"
        elif (
            prefix is not None
            and re.fullmatch(r"[A-Z$0-9]{1,4}:[A-Z$0-9]{1,4}", core.upper()) is None
            and re.fullmatch(r"[A-Z$0-9]{1,4}", core.upper()) is None
        ):
            resolved, reason, kind = False, "the reference is not a range", "broken-range"
        elif prefix is not None:
            try:
                min_col, min_row, max_col, max_row = range_boundaries(core.upper())
            except (TypeError, ValueError, IndexError):
                resolved, reason, kind = False, "the range cannot be read as coordinates", "broken-range"
            else:
                out = (
                    min_row is None
                    or max_row is None
                    or min_col is None
                    or max_col is None
                    or min_row < 1
                    or min_col < 1
                    or max_row > EXCEL_MAX_ROW
                    or max_col > EXCEL_MAX_COLUMN
                )
                if out:
                    resolved, reason, kind = False, "the range is outside the grid", "broken-range"
        reference, truncated = _truncate(text, MAX_NAME_REFERENCE)
        return {
            "name": name,
            "scope": scope,
            "sheet": sheet_title,
            "reference": reference,
            "referenceTruncated": truncated,
            "kind": kind,
            "resolved": resolved,
            "reason": reason,
        }

    for name, definition in wb.defined_names.items():
        items.append(item(name, "workbook", None, definition))
    for sheet in wb.worksheets:
        for name, definition in sheet.defined_names.items():
            items.append(item(name, "sheet", sheet.title, definition))
    return items


def _chart_title(chart: Any) -> Tuple[Optional[str], bool, Optional[str]]:
    """(title text, resolved, reason). A title this version cannot read is reported, not invented."""
    title = getattr(chart, "title", None)
    if title is None:
        return None, True, None
    try:
        tx = getattr(title, "tx", None)
        rich = getattr(tx, "rich", None)
        if rich is not None:
            texts: List[str] = []
            for paragraph in getattr(rich, "p", ()) or ():
                for run in getattr(paragraph, "r", ()) or ():
                    if isinstance(getattr(run, "t", None), str):
                        texts.append(run.t)
            if texts:
                text, _truncated = _truncate("".join(texts), MAX_CELL_TEXT)
                return text, True, None
        reference = getattr(tx, "strRef", None)
        if reference is not None and isinstance(getattr(reference, "f", None), str):
            return _truncate(reference.f, MAX_CELL_TEXT)[0], True, "reference"
    except (AttributeError, TypeError) as error:  # a shape this version does not model
        return None, False, f"{type(error).__name__}: {error}"
    return None, False, "the chart's title is not a form this version reads"


def _chart_references(chart: Any) -> List[Dict[str, Any]]:
    found: List[Dict[str, Any]] = []
    for series in getattr(chart, "series", ()) or ():
        for attribute, kind in (("val", "values"), ("cat", "categories"), ("xVal", "x-values"), ("yVal", "y-values")):
            holder = getattr(series, attribute, None)
            if holder is None:
                continue
            for name in ("numRef", "strRef", "multiLvlStrRef"):
                reference = getattr(holder, name, None)
                if reference is None:
                    continue
                text = getattr(reference, "f", None)
                if isinstance(text, str):
                    found.append({"kind": str(getattr(holder, "title", None) or "series"), "role": kind, "reference": text})
    return found


def _chart_items(wb: Any, path: str) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Modeled charts, plus the chart parts the package holds but this version does not model."""
    items: List[Dict[str, Any]] = []
    for sheet in wb.worksheets:
        for position, chart in enumerate(getattr(sheet, "_charts", ()) or ()):
            title, resolved, reason = _chart_title(chart)
            references, truncated = _bounded(_chart_references(chart), MAX_CHART_REFERENCES)
            items.append(
                {
                    "sheet": sheet.title,
                    "position": position,
                    "type": type(chart).__name__,
                    "title": title,
                    "titleResolved": resolved,
                    "titleReason": reason,
                    "seriesCount": len(getattr(chart, "series", ()) or ()),
                    "references": references,
                    "referencesTruncated": truncated,
                    "modeled": True,
                }
            )
    parts = [
        "/" + name
        for name in _zip_names(path, "the workbook")
        if name.lower().startswith("xl/charts/") and name.lower().endswith(".xml")
    ]
    if len(parts) > len(items):
        return items, sorted(parts)
    return items, []


def _style_items(wb: Any, sheet: Optional[Any]) -> List[Dict[str, Any]]:
    sheets = [sheet] if sheet is not None else list(wb.worksheets)
    items: List[Dict[str, Any]] = []
    for current in sheets:
        for cell in _present_cells(current):
            if not cell.has_style:
                continue
            items.append(
                {
                    "sheet": current.title,
                    "address": _qualified(current.title, cell.coordinate),
                    "style": _style_signature(cell),
                    "value": _scalar(cell.value).get("value") if cell.data_type != "f" else None,
                    "formula": cell.value if cell.data_type == "f" else None,
                }
            )
    return items


def _sheet_outline(wb: Any, sheet: Any, position: int, parts: Dict[str, str]) -> Dict[str, Any]:
    cells = _present_cells(sheet)
    formulas = [cell for cell in cells if cell.data_type == "f"]
    styled = [cell for cell in cells if cell.has_style]
    min_col, min_row, max_col, max_row = _used_bounds(sheet)
    named = [item for item in _declared_names(wb) if item["scope"] == "sheet" and item["sheet"] == sheet.title]
    protected = bool(getattr(getattr(sheet, "protection", None), "sheet", False))
    item: Dict[str, Any] = {
        "position": position,
        "title": sheet.title,
        "part": parts.get(sheet.title),
        "state": str(sheet.sheet_state),
        "dimensions": sheet.dimensions if isinstance(sheet.dimensions, str) else None,
        "usedRange": f"{get_column_letter(min_col)}{min_row}:{get_column_letter(max_col)}{max_row}",
        "maxRow": max_row,
        "maxColumn": max_col,
        "cells": len(cells),
        "formulas": len(formulas),
        "styledCells": len(styled),
        "namedRanges": len(named),
        "mergedRanges": len(sheet.merged_cells.ranges),
        "tables": len(sheet.tables),
        "charts": len(getattr(sheet, "_charts", ()) or ()),
        "protected": protected,
        "freezePanes": sheet.freeze_panes if isinstance(sheet.freeze_panes, str) else None,
        "autoFilter": bool(sheet.auto_filter.ref) if sheet.auto_filter is not None else False,
        "dataValidations": len(sheet.data_validations.dataValidation),
        "conditionalFormatting": len(list(sheet.conditional_formatting)),
    }
    return item


def _census(wb: Any, path: str, parts: Dict[str, str], charts: Sequence[Any]) -> Dict[str, Any]:
    cells = 0
    formulas = 0
    styled = 0
    tables = 0
    merged = 0
    validations = 0
    formatting = 0
    named = 0
    for sheet in wb.worksheets:
        present = _present_cells(sheet)
        cells += len(present)
        formulas += sum(1 for cell in present if cell.data_type == "f")
        styled += sum(1 for cell in present if cell.has_style)
        tables += len(sheet.tables)
        merged += len(sheet.merged_cells.ranges)
        validations += len(sheet.data_validations.dataValidation)
        formatting += len(list(sheet.conditional_formatting))
        named += len(sheet.defined_names)
    names = _declared_names(wb)
    macros = "xl/vbaproject.bin" in [name.lower() for name in _zip_names(path, "the workbook")]
    return {
        "sheets": len(wb.worksheets),
        "chartsheets": len(wb.chartsheets),
        "hiddenSheets": sum(1 for sheet in wb.worksheets if str(sheet.sheet_state) != "visible"),
        "protectedSheets": sum(
            1 for sheet in wb.worksheets if bool(getattr(getattr(sheet, "protection", None), "sheet", False))
        ),
        "namedRanges": len(names),
        "sheetScopedNames": named,
        "cells": cells,
        "formulas": formulas,
        "styledCells": styled,
        "tables": tables,
        "mergedRanges": merged,
        "dataValidations": validations,
        "conditionalFormatting": formatting,
        "charts": len(charts),
        "chartParts": len(
            [
                name
                for name in _zip_names(path, "the workbook")
                if name.lower().startswith("xl/charts/") and name.lower().endswith(".xml")
            ]
        ),
        "pivotParts": len(
            [
                name
                for name in _zip_names(path, "the workbook")
                if name.lower().startswith("xl/pivot")
            ]
        ),
        "macros": macros,
        "calcChain": any(name.lower() == "xl/calcchain.xml" for name in _zip_names(path, "the workbook")),
        "parts": len(parts),
    }


# -- recalculation ---------------------------------------------------------------------------------


def _recalculation(path: str) -> Dict[str, Any]:
    """What can and cannot be recalculated here, with the reason, and never a computed value.

    ``openpyxl.oracle`` is the fork's only calculation path and it deliberately implements no engine:
    it delegates to headless LibreOffice. This worker refuses to spawn a process at all, so the oracle
    is reported as unavailable *or* unusable here rather than being approximated.
    """
    present = bool(oracle.available())
    metadata = _calc_metadata(path)
    limits = [
        "this library never calculates formulas itself: its own documentation says a partial engine "
        "would be a silent-wrongness machine, so it delegates to headless LibreOffice",
        "this worker cannot spawn a process: its import guard denies subprocess and it patches "
        "os.system, os.popen, os.fork and os.exec*, so a LibreOffice run is impossible here even "
        "where LibreOffice is installed",
        "no operation of this adapter returns a calculated value: a cached value reported here is one "
        "the package already held, quoted with its source, never recomputed",
    ]
    if present:
        reason = (
            "LibreOffice was found, but this worker cannot spawn the process the oracle needs, so no "
            "recalculation was attempted and no calculated value is reported"
        )
    else:
        reason = (
            "no LibreOffice installation was found (openpyxl.oracle.available() is false) and this "
            "worker cannot spawn a process anyway, so no recalculation was attempted and no "
            "calculated value is reported"
        )
    return {
        "available": present,
        "attempted": False,
        "computed": False,
        "engine": "openpyxl.oracle (headless LibreOffice)",
        "engineInProcess": False,
        "processSpawned": False,
        "reason": reason,
        "unsupportedFunctions": list(_UNSUPPORTED_FUNCTIONS),
        "unsupportedFunctionCount": len(_UNSUPPORTED_FUNCTIONS),
        "limits": limits,
        "workbookRequest": metadata,
        "limitsNote": (
            "the functions above are ones the oracle would refuse even where it can run; a workbook "
            "using one cannot be recalculated here or there"
        ),
    }


# -- change set, diff, dependencies and numeric checks ----------------------------------------------


def _part_hashes(path: str) -> Dict[str, str]:
    with zipfile.ZipFile(path) as archive:
        return {
            info.filename: hashlib.sha256(archive.read(info.filename)).hexdigest()
            for info in archive.infolist()
        }


def _change_set(source_path: str, output_path: str) -> Dict[str, Any]:
    """The structural change set: parts added, removed, changed and left byte-identical."""
    before = _part_hashes(source_path)
    after = _part_hashes(output_path)
    residual = _applying(paper_package.diff_package, source_path, output_path)
    payload = residual.to_dict()
    changed = []
    for delta in payload["changed"]:
        name = delta["part"].lstrip("/")
        changed.append(
            {
                "part": delta["part"],
                "kind": delta["kind"],
                "detail": list(delta.get("detail", []))[:8],
                "detailTotal": len(delta.get("detail", [])),
                "beforeSha256": before.get(name),
                "afterSha256": after.get(name),
                "semanticChange": before.get(name) != after.get(name),
            }
        )
    return {
        "schema": payload["schema"],
        "version": payload["version"],
        "added": ["/" + name for name in sorted(after) if name not in before],
        "removed": ["/" + name for name in sorted(before) if name not in after],
        "changed": changed,
        "byteIdentical": [name for name in sorted(before) if after.get(name) == before[name]],
        "byteIdenticalCount": sum(1 for name in before if after.get(name) == before[name]),
        "partCountBefore": len(before),
        "partCountAfter": len(after),
        "semanticallyEmpty": (
            not payload["changed"] and not payload["added"] and not payload["removed"]
        ),
    }


def _preservation(source_path: str, output_path: str, changed_parts: Sequence[str]) -> Dict[str, Any]:
    """Which parts came back byte-identical, each with its sha256 as the evidence."""
    before = _part_hashes(source_path)
    after = _part_hashes(output_path)
    identical = sorted(name for name in before if after.get(name) == before[name])
    order = ("/worksheets/", "/charts/", "/media/", "/styles.xml", "/theme/", "/drawings/", "/pivot")
    ordered: List[str] = []
    for fragment in order:
        ordered.extend(name for name in identical if fragment in name and name not in ordered)
    ordered.extend(name for name in identical if name not in ordered)
    kept, truncated = _bounded(ordered, MAX_PART_HASHES)

    def like(fragment: str) -> List[str]:
        return [f"/{name}" for name in identical if fragment in name]

    changed = [name.lstrip("/") for name in changed_parts]
    return {
        "byteIdenticalCount": len(identical),
        "byteIdentical": [{"part": "/" + name, "sha256": before[name]} for name in kept],
        "byteIdenticalTruncated": truncated,
        "byteIdenticalHashed": len(kept),
        "changedParts": changed,
        "addedParts": sorted(name for name in after if name not in before),
        "removedParts": sorted(name for name in before if name not in after),
        "worksheetByteIdentical": like("/worksheets/"),
        "chartByteIdentical": like("/charts/"),
        "mediaByteIdentical": like("/media/"),
        "themeByteIdentical": like("/theme/"),
        "styleByteIdentical": like("/styles.xml"),
        "drawingByteIdentical": like("/drawings/"),
        "pivotByteIdentical": like("/pivot"),
        "verbatimCopy": len(changed) == 0 and len(identical) == len(before) == len(after),
    }


def _cells_diff(source_path: str, output_path: str) -> Tuple[List[Dict[str, Any]], int]:
    """The fork's own cell-level measurement: values and formulas only, and it says so."""
    report = _applying(diffreport.diff_workbooks, source_path, output_path).to_dict()
    items: List[Dict[str, Any]] = []
    for entry in report["changed"]:
        items.append(
            {
                "address": entry["address"],
                "before": _scalar(entry.get("before")).get("value"),
                "after": _scalar(entry.get("after")).get("value"),
                "beforeType": entry.get("before_type"),
                "afterType": entry.get("after_type"),
                "kind": "value",
                "shifted": False,
            }
        )
    for entry in report["shifted"]:
        items.append(
            {
                "address": entry["address"],
                "before": _scalar(entry.get("before")).get("value"),
                "after": _scalar(entry.get("after")).get("value"),
                "beforeType": entry.get("before_type"),
                "afterType": entry.get("after_type"),
                "kind": "shifted",
                "shifted": True,
            }
        )
    return items, len(items)


def _style_diff(
    source_model: Any, output_model: Any, addresses: Sequence[str]
) -> List[Dict[str, Any]]:
    """Style changes per cell, from the two models — the part ``diff_workbooks`` cannot see."""
    changes: List[Dict[str, Any]] = []
    for address in addresses:
        title, coordinate = _split_address(address)
        if title is None:
            continue
        if title not in source_model.sheetnames or title not in output_model.sheetnames:
            continue
        before = _style_signature(source_model[title][coordinate])
        after = _style_signature(output_model[title][coordinate])
        if before == after:
            continue
        keys = sorted(key for key in before if before[key] != after.get(key))
        changes.append(
            {"address": address, "keys": keys, "before": before, "after": after}
        )
    return changes


def _style_diffs_everywhere(source_model: Any, output_model: Any) -> List[Dict[str, Any]]:
    """Style changes on every sheet, including ones no cell diff reported (a style-only edit)."""
    addresses: List[str] = []
    for sheet in output_model.worksheets:
        for cell in _present_cells(sheet):
            if cell.has_style:
                addresses.append(_qualified(sheet.title, cell.coordinate))
    for sheet in source_model.worksheets:
        for cell in _present_cells(sheet):
            if cell.has_style:
                address = _qualified(sheet.title, cell.coordinate)
                if address not in addresses:
                    addresses.append(address)
    return _style_diff(source_model, output_model, addresses)


def _split_address(address: str) -> Tuple[Optional[str], str]:
    title, core = _split_sheet_prefix_loose(address)
    return title, core.upper().replace("$", "")


def _dependencies(wb: Any, addresses: Sequence[str]) -> Tuple[List[Dict[str, Any]], int]:
    """Formula cells whose own references touch a changed cell — the affected dependency list.

    Measured against the *output* model with the fork's own dependency sketch, so a formula that
    points at a changed cell is found by the same coarse analysis a shift guard uses.
    """
    sketch = _applying(perception.dependency_sketch, wb)
    payload = sketch.to_dict() if hasattr(sketch, "to_dict") else {}
    references = payload.get("references", {})
    targets: List[Tuple[str, str, int, int, int, int]] = []
    for address in addresses:
        title, core = _split_address(address)
        if title is None:
            continue
        try:
            min_col, min_row, max_col, max_row = range_boundaries(core)
        except (TypeError, ValueError, IndexError):
            continue
        if None in (min_col, min_row, max_col, max_row):
            continue
        targets.append((title.lower(), core, min_col, min_row, max_col, max_row))
    found: List[Dict[str, Any]] = []
    for owner, raw_references in sorted(references.items()):
        owner_title, _owner_core = _split_address(str(owner))
        owner_key = (owner_title or "").lower()
        for raw in raw_references:
            text = str(raw).replace("$", "")
            qualified = re.match(
                r"^(?:'((?:[^']|'')+)'|([^'!]+))!([A-Z]{1,3}[0-9]{1,7}(?::[A-Z]{1,3}[0-9]{1,7})?)$",
                text,
            )
            if qualified is not None:
                sheet_title = (qualified.group(1) or qualified.group(2) or "")
                sheet_title = sheet_title.replace("''", "'").lower()
                core = qualified.group(3)
                same_sheet = False
            elif re.fullmatch(r"[A-Z]{1,3}[0-9]{1,7}(?::[A-Z]{1,3}[0-9]{1,7})?", text):
                # An unqualified reference means the sheet the formula itself lives on.
                sheet_title, core, same_sheet = owner_key, text, True
            else:
                continue
            try:
                min_col, min_row, max_col, max_row = range_boundaries(core)
            except (TypeError, ValueError, IndexError):
                continue
            if None in (min_col, min_row, max_col, max_row):
                continue
            for target_title, target_core, t_min_col, t_min_row, t_max_col, t_max_row in targets:
                if sheet_title != target_title:
                    continue
                if (
                    min_col <= t_max_col
                    and t_min_col <= max_col
                    and min_row <= t_max_row
                    and t_min_row <= max_row
                ):
                    found.append(
                        {
                            "formulaCell": owner,
                            "reference": str(raw),
                            "changedCell": target_core,
                            "sheet": sheet_title,
                            "sameSheet": same_sheet,
                        }
                    )
                    break
    kept, truncated = _bounded(found, MAX_DEPENDENTS)
    return kept, len(found)


_SUM_FORMULA = re.compile(
    r"^=\s*SUM\(\s*(\$?[A-Z]{1,3}\$?[0-9]{1,7}\s*:\s*\$?[A-Z]{1,3}\$?[0-9]{1,7}|\$?[A-Z]{1,3}\$?[0-9]{1,7})\s*\)$",
    re.I,
)


def _numeric_checks(
    source_model: Any,
    output_model: Any,
    changed: Sequence[Dict[str, Any]],
    cached_output: Any,
) -> Tuple[List[Dict[str, Any]], int]:
    """Explicit numeric checks a reviewer can verify, and never a fabricated calculated value.

    Two kinds:

    - ``value-change``: the exact before and after of a changed cell, with the exact decimal delta of
      the two numbers this adapter read. Nothing is recomputed; the check is the arithmetic of the two
      values the file holds.
    - ``sum-of-named-cells``: for a changed cell whose own formula is ``SUM(<range>)``, this adapter
      adds the literal numbers in the cells that range names, exactly, and reports its own sum beside
      whatever value the file cached. ``agrees`` is that comparison or ``null`` with the reason it
      could not be made — no spreadsheet engine ran, and a difference is reported, not resolved.
    """
    checks: List[Dict[str, Any]] = []
    total = 0
    for address in changed:
        title, coordinate = _split_address(address)
        if title is None:
            continue
        total += 1
        before = _value_of(source_model, title, coordinate)
        after = _value_of(output_model, title, coordinate)
        dropped = before == after
        check: Dict[str, Any] = {
            "address": address,
            "kind": "cache-dropped" if dropped else "value-change",
            "before": before,
            "after": after,
            "exactBefore": _exact_of(source_model, title, coordinate),
            "exactAfter": _exact_of(output_model, title, coordinate),
            "delta": None,
            "deltaExact": None,
            "method": "read-both-packages",
            "note": (
                "the cell's own value or formula is unchanged; the edit's receipt records it because "
                "the cached value of the formula was dropped when an input changed, so the file asks "
                "to be recalculated"
                if dropped
                else None
            ),
            "sum": None,
        }
        before_exact = check["exactBefore"]
        after_exact = check["exactAfter"]
        if before_exact is not None and after_exact is not None:
            try:
                delta = Decimal(after_exact) - Decimal(before_exact)
            except (InvalidOperation, ValueError):
                delta = None
            if delta is not None:
                check["delta"] = float(delta)
                check["deltaExact"] = str(delta)
        sum_check = _sum_check(output_model, cached_output, title, coordinate)
        if sum_check is not None:
            sum_check["side"] = "after"
        else:
            sum_check = _sum_check(source_model, None, title, coordinate)
            if sum_check is not None:
                sum_check["side"] = "before"
        if sum_check is not None:
            check["sum"] = sum_check
            check["kind"] = "value-change-with-sum"
        checks.append(check)
        if len(checks) >= MAX_NUMERIC_CHECKS:
            break
    return checks, total


def _changed_addresses(
    source_path: str, receipt_payload: Dict[str, Any], diff_entries: Sequence[Dict[str, Any]]
) -> List[str]:
    """Every address the change touched: the cell diff plus the receipt's own changed-cell set.

    The two are not the same, and the difference matters. ``diff_workbooks`` measures values and
    formulas; the fork's edit receipt also records the coordinates whose *cached* value was dropped
    because an input changed. A reviewer wants both, so both are checked and reported.
    """
    addresses = [entry["address"] for entry in diff_entries]
    parts = {part.lstrip("/"): title for title, part in _sheet_part_map(source_path).items()}
    for part, cells in sorted((receipt_payload.get("cells_changed") or {}).items()):
        title = parts.get(part.lstrip("/"))
        if title is None or not isinstance(cells, dict):
            continue
        for coordinate in sorted(cells):
            address = _qualified(title, coordinate)
            if address not in addresses:
                addresses.append(address)
    return addresses


def _value_of(model: Any, title: str, coordinate: str) -> Any:
    """One cell's value as JSON — the formula text for a formula cell, as the cell diff reports it."""
    if title not in model.sheetnames:
        return None
    try:
        cell = model[title][coordinate]
    except (KeyError, ValueError):
        return None
    if cell.data_type == "f":
        return cell.value if isinstance(cell.value, str) else None
    return _scalar(cell.value).get("value")


def _exact_of(model: Any, title: str, coordinate: str) -> Optional[str]:
    if title not in model.sheetnames:
        return None
    cell = model[title][coordinate]
    if cell.data_type == "f":
        return None
    return _exact_decimal(cell.value)


def _sum_check(
    model: Any, cached_model: Optional[Any], title: str, coordinate: str
) -> Optional[Dict[str, Any]]:
    """This adapter's own exact sum over the cells a ``SUM`` names, or None when the cell is not one."""
    if title not in model.sheetnames:
        return None
    cell = model[title][coordinate]
    formula = cell.value if cell.data_type == "f" and isinstance(cell.value, str) else None
    if formula is None:
        return None
    match = _SUM_FORMULA.match(formula)
    if match is None:
        return None
    try:
        min_col, min_row, max_col, max_row = range_boundaries(match.group(1).replace("$", "").upper())
    except (TypeError, ValueError, IndexError):
        return None
    if None in (min_col, min_row, max_col, max_row):
        return None
    area = (max_row - min_row + 1) * (max_col - min_col + 1)
    if area > MAX_RANGE_CELLS:
        return {
            "function": "SUM",
            "range": match.group(1),
            "adapterSum": None,
            "adapterSumExact": None,
            "cells": [],
            "cellsTruncated": True,
            "blankCells": None,
            "nonNumericCells": [],
            "workbookCachedValue": None,
            "agrees": None,
            "reason": (
                f"the range covers {area} cells, more than the {MAX_RANGE_CELLS} this adapter will sum "
                "explicitly, so no sum is reported"
            ),
        }
    sheet = model[title]
    numbers: List[Decimal] = []
    named: List[str] = []
    blanks = 0
    non_numeric: List[str] = []
    for row in range(min_row, max_row + 1):
        for column in range(min_col, max_col + 1):
            address = f"{get_column_letter(column)}{row}"
            inner = sheet[address]
            if inner.data_type == "f":
                non_numeric.append(address)
                continue
            if inner.value is None:
                blanks += 1
                continue
            exact = _exact_decimal(inner.value)
            if exact is None:
                non_numeric.append(address)
                continue
            try:
                numbers.append(Decimal(exact))
            except (InvalidOperation, ValueError):
                non_numeric.append(address)
                continue
            named.append(address)
    if non_numeric:
        return {
            "function": "SUM",
            "range": match.group(1),
            "adapterSum": None,
            "adapterSumExact": None,
            "cells": named[:MAX_SUM_CELLS],
            "cellsTruncated": len(named) > MAX_SUM_CELLS,
            "blankCells": blanks,
            "nonNumericCells": non_numeric[:8],
            "workbookCachedValue": None,
            "agrees": None,
            "reason": (
                "the range holds a formula or a non-numeric cell, so this adapter reports no integer "
                "sum: it adds cells it can name exactly, and it will not guess at the rest"
            ),
        }
    adapter_sum = sum(numbers, Decimal(0))
    cached_value, cached_known = _cached_value(cached_model, title, coordinate)
    agrees: Optional[bool] = None
    if cached_known and _exact_decimal(cached_value) is not None:
        try:
            agrees = Decimal(str(_exact_decimal(cached_value))) == adapter_sum
        except (InvalidOperation, ValueError):
            agrees = None
    reason: Optional[str] = None
    if not cached_known:
        reason = (
            "the file holds no cached value for this formula (the splice drops the cache when an "
            "input changes, so Excel recalculates on load), and no engine ran here"
        )
    elif agrees is not None and not agrees:
        reason = (
            "the cached value in the package and this adapter's exact sum of the cells the range "
            "names differ; both are reported and neither is treated as the answer"
        )
    return {
        "function": "SUM",
        "range": match.group(1),
        "adapterSum": float(adapter_sum),
        "adapterSumExact": str(adapter_sum),
        "cells": named[:MAX_SUM_CELLS],
        "cellsTruncated": len(named) > MAX_SUM_CELLS,
        "blankCells": blanks,
        "nonNumericCells": [],
        "workbookCachedValue": cached_value if cached_known else None,
        "workbookCachedKnown": cached_known,
        "agrees": agrees,
        "reason": reason,
    }


# -- preview ---------------------------------------------------------------------------------------


def _preview_lines(wb: Any, sheet: Any, names: Sequence[Dict[str, Any]], charts: Sequence[Any]) -> Tuple[List[Dict[str, Any]], int]:
    """A bounded structural rendering of one sheet: values, formulas, styles, names, charts, tables."""
    lines: List[Dict[str, Any]] = []
    total = 0

    def add(marker: str, label: str, address: str, text: str) -> None:
        nonlocal total
        total += 1
        if len(lines) >= MAX_PREVIEW_LINES:
            return
        clip, truncated = _truncate(text, MAX_CELL_TEXT)
        lines.append(
            {"marker": marker, "label": label, "address": address, "text": clip, "truncated": truncated}
        )

    for cell in _present_cells(sheet):
        address = _qualified(sheet.title, cell.coordinate)
        if cell.data_type == "f":
            add("F", f"F: {cell.coordinate}", address, f"={cell.value}" if not str(cell.value).startswith("=") else str(cell.value))
            continue
        scalar = _scalar(cell.value)
        if scalar["kind"] == "empty":
            if cell.has_style:
                add("S", f"S: {cell.coordinate}", address, "styled, no value")
            continue
        add("V", f"V: {cell.coordinate}", address, f"{cell.coordinate} = {scalar.get('exact') or scalar.get('value')}")
    for name in names:
        if name["scope"] == "sheet" and name["sheet"] != sheet.title:
            continue
        add("N", f"N: {name['name']}", name["name"], f"{name['name']} = {name['reference']}")
    for table in sheet.tables.values():
        add("T", f"T: {table.displayName}", _qualified(sheet.title, table.ref), f"table {table.displayName} over {table.ref}")
    for chart in charts:
        add("C", f"C: {type(chart).__name__}", _qualified(sheet.title, "A1"), f"{type(chart).__name__} with {len(getattr(chart, 'series', ()) or ())} series")
    if sheet.merged_cells.ranges:
        for merged in sorted(str(item) for item in sheet.merged_cells.ranges)[:MAX_PREVIEW_LINES]:
            add("M", f"M: {merged}", _qualified(sheet.title, merged), f"merged {merged}")
    if sheet.auto_filter.ref:
        add("AF", "AF: autoFilter", _qualified(sheet.title, str(sheet.auto_filter.ref)), f"auto filter over {sheet.auto_filter.ref}")
    return lines, total


# -- operations ------------------------------------------------------------------------------------


def _inspect(params: Dict[str, Any]) -> Dict[str, Any]:
    entry = _object(params, "inspect parameters", ("ref",))
    _required(entry, ("ref",), "inspect parameters")
    reference = _reference(entry["ref"], "inspect ref")
    path, wb, facts = _open(reference)
    parts = _sheet_part_map(path)
    charts, unmodeled = _chart_items(wb, path)
    outline = [_sheet_outline(wb, sheet, position, parts) for position, sheet in enumerate(wb.worksheets)]
    kept_outline, outline_truncated = _bounded(outline, MAX_OUTLINE)
    names = _declared_names(wb)
    kept_names, names_truncated = _bounded(names, MAX_NAMED)
    kept_charts, charts_truncated = _bounded(charts, MAX_CHARTS)
    check = _reference_check(wb, path, "inspect")
    return _envelope(
        "inspect",
        source=_source(reference),
        workbook=_census(wb, path, parts, charts),
        sheetOutline=kept_outline,
        sheetOutlineTruncated=outline_truncated,
        namedRanges=kept_names,
        namedRangesTruncated=names_truncated,
        chartOutline=kept_charts,
        chartOutlineTruncated=charts_truncated,
        unmodeledChartParts=unmodeled,
        package=facts,
        referenceCheck=check,
        recalculation=_recalculation(path),
        protections=_protections(wb),
        warnings=_warnings(wb, check, unmodeled),
    )


def _protections(wb: Any) -> Dict[str, Any]:
    """Protection the workbook declares. This adapter reports it; it never enforces or breaks it."""
    protected: List[Dict[str, Any]] = []
    locked_writes_possible = False
    for sheet in wb.worksheets:
        protection = getattr(sheet, "protection", None)
        if protection is None or not protection.sheet:
            continue
        locked = sum(1 for cell in _present_cells(sheet) if cell.protection is not None and cell.protection.locked)
        locked_writes_possible = locked_writes_possible or locked > 0
        protected.append(
            {
                "sheet": sheet.title,
                "hasPassword": bool(protection.password),
                "lockedCells": locked,
                "note": (
                    "this library reports protection and never enforces it: a write to a locked cell "
                    "proceeds and is reported, so a person must confirm an edit to a protected sheet"
                ),
            }
        )
    structure = getattr(getattr(wb, "security", None), "lockStructure", None)
    return {
        "protectedSheets": protected,
        "protectedSheetCount": len(protected),
        "structureLocked": bool(structure),
        "enforced": False,
        "note": "protection is reported, never enforced: no operation refused a write because of it",
    }


def _warnings(wb: Any, check: Dict[str, Any], unmodeled: Sequence[str]) -> List[str]:
    warnings: List[str] = []
    if check["brokenTotal"]:
        warnings.append(
            f"{check['brokenTotal']} formula reference(s) in this workbook cannot be resolved "
            f"({', '.join(check['brokenKinds'])}); they are reported, not repaired"
        )
    if check["unscannable"]:
        warnings.append(
            f"{len(check['unscannable'])} formula surface(s) could not be tokenized, so their "
            "references were not verified"
        )
    if unmodeled:
        warnings.append(
            f"{len(unmodeled)} chart part(s) are present in the package but not modeled by this "
            "version, so their series references were not verified"
        )
    protected = _protections(wb)["protectedSheetCount"]
    if protected:
        warnings.append(
            f"{protected} sheet(s) declare protection; this library reports protection and never "
            "enforces it, so a write to a locked cell would proceed"
        )
    path = _source_path_of(wb)
    if path is not None and any(
        name.lower() == "xl/calcchain.xml" for name in _zip_names(path, "the workbook")
    ):
        warnings.append(
            "the package holds a calculation chain; a changed formula removes it so the chain cannot "
            "contradict the edit"
        )
    return warnings


def _source_path_of(wb: Any) -> Optional[str]:
    """The path a workbook was opened from, when this run knows it. Used only for evidence."""
    return _OPEN_PATHS.get(id(wb))


_OPEN_PATHS: Dict[int, str] = {}


def _remember(wb: Any, path: str) -> Any:
    _OPEN_PATHS[id(wb)] = path
    return wb


def _read(params: Dict[str, Any]) -> Dict[str, Any]:
    entry = _object(
        params, "read parameters", ("ref", "section", "sheet", "range", "cursor", "pageSize")
    )
    _required(entry, ("ref", "section"), "read parameters")
    reference = _reference(entry["ref"], "read ref")
    section = _one_of(entry["section"], "a read section", READ_SECTIONS)
    cursor, page_size = _page_of(entry)
    path, wb, facts = _open(reference)
    parts = _sheet_part_map(path)
    if section in ("cells", "styles") and entry.get("sheet") is None and entry.get("range") is None:
        _fail("invalid-request", f"a {section} read needs a sheet (or a range naming one)")
    sheet = _optional_sheet(wb, entry.get("sheet"), "the read sheet")
    cached = _cached_model(path, f"the leased input {reference['name']!r}")
    window_note: Optional[str] = None
    window_clamped = False
    bounds: Optional[Tuple[int, int, int, int]] = None
    items: List[Dict[str, Any]] = []
    if section == "cells":
        bounds = None
        if entry.get("range") is not None:
            core, prefix, bounds = _bounded_range(entry["range"], "a read range")
            if prefix is not None:
                named_sheet = _sheet(wb, prefix, "the range's sheet")
                if sheet is not None and named_sheet.title != sheet.title:
                    _fail(
                        "ambiguous-target",
                        f"the range names sheet {named_sheet.title!r} and the request names "
                        f"{sheet.title!r}; name one of them",
                    )
                sheet = named_sheet
            elif sheet is None:
                _fail("invalid-request", "a range without a sheet prefix needs a sheet")
        if sheet is None:
            _fail("invalid-request", "a cells read needs a sheet")
        bounds, window_clamped, window_note = _window(sheet, bounds)
        items = _cells_of(sheet, cached, bounds)
    elif section == "sheets":
        items = [
            _sheet_outline(wb, current, position, parts)
            for position, current in enumerate(wb.worksheets)
        ]
    elif section == "formulas":
        items = _formula_items(wb, sheet, cached)
    elif section == "names":
        items = _declared_names(wb)
    elif section == "styles":
        items = _style_items(wb, sheet)
    else:
        charts, _unmodeled = _chart_items(wb, path)
        items = [item for item in charts if sheet is None or item["sheet"] == sheet.title]
    page = _page(items, cursor, page_size, section)
    result = _envelope(
        "read",
        source=_source(reference),
        workbook=_census(wb, path, parts, _chart_items(wb, path)[0]),
        page=page,
        sectionRange=(
            {
                "sheet": sheet.title,
                "requested": entry.get("range"),
                "window": f"{get_column_letter(bounds[0])}{bounds[1]}:{get_column_letter(bounds[2])}{bounds[3]}"
                if section == "cells" and bounds is not None
                else None,
                "clamped": window_clamped,
                "note": window_note,
            }
            if section == "cells" and sheet is not None and bounds is not None
            else None
        ),
        cachedValuesRead=cached is not None,
        package=facts,
    )
    return result


def _cells_of(sheet: Any, cached: Any, bounds: Tuple[int, int, int, int]) -> List[Dict[str, Any]]:
    min_col, min_row, max_col, max_row = bounds
    items: List[Dict[str, Any]] = []
    for row in range(min_row, max_row + 1):
        for column in range(min_col, max_col + 1):
            cell = sheet._cells.get((row, column))
            if cell is None:
                continue
            value, known = _cached_value(cached, sheet.title, cell.coordinate)
            items.append(_cell_item(sheet, cell, value if known else None, known))
    return items


def _formula_items(wb: Any, sheet: Optional[Any], cached: Any) -> List[Dict[str, Any]]:
    titles = _known_titles(wb)
    names = _defined_name_index(wb)
    tables = _table_index(wb)
    sheets = [sheet] if sheet is not None else list(wb.worksheets)
    items: List[Dict[str, Any]] = []
    for current in sheets:
        for cell in _present_cells(current):
            if cell.data_type != "f" or not isinstance(cell.value, str):
                continue
            references, error = _formula_references(cell.value, titles, names, tables)
            kept, truncated = _bounded(references, MAX_CHART_REFERENCES)
            value, known = _cached_value(cached, current.title, cell.coordinate)
            formula, formula_truncated = _truncate(cell.value, MAX_ITEM_TEXT)
            items.append(
                {
                    "sheet": current.title,
                    "address": _qualified(current.title, cell.coordinate),
                    "formula": formula,
                    "formulaTruncated": formula_truncated,
                    "references": kept,
                    "referencesTotal": len(references),
                    "referencesTruncated": truncated,
                    "brokenReferences": [item for item in references if not item["resolved"]],
                    "tokenizerError": error,
                    "cachedValue": value if known else None,
                    "cachedKnown": known,
                }
            )
    return items


# -- create ----------------------------------------------------------------------------------------


def _created_sheet(wb: Any, spec: Dict[str, Any], index: int) -> Dict[str, Any]:
    what = f"sheet {index}"
    name = _string(spec["name"], f"{what} name", 255)
    if name in wb.sheetnames:
        _fail("invalid-request", f"{what} names sheet {name!r}, which the new workbook already has")
    rows = spec.get("rows")
    if not isinstance(rows, list) or not rows:
        _fail("invalid-request", f"{what} needs a non-empty list of rows")
    width = None
    for position, row in enumerate(rows):
        if not isinstance(row, list) or not row:
            _fail("invalid-request", f"{what} row {position} must be a non-empty list of cells")
        if width is None:
            width = len(row)
        if len(row) != width:
            _fail("invalid-request", f"{what} rows must all hold {width} cells")
    if len(rows) > 1_048_576 or (width or 0) > EXCEL_MAX_COLUMN:
        _fail("invalid-request", f"{what} is larger than the spreadsheet grid")
    at = spec.get("at") or "A1"
    coordinate = _coordinate(at, f"{what} at")
    sheet = wb.create_sheet(name)
    written = 0
    formulas = 0
    for row_index, row in enumerate(rows):
        for column_index, value in enumerate(row):
            target = sheet.cell(
                row=sheet[coordinate].row + row_index, column=sheet[coordinate].column + column_index
            )
            written += 1
            if isinstance(value, str) and value.startswith("="):
                target.value = value
                formulas += 1
            elif isinstance(value, (str, int, float, bool)) or value is None:
                target.value = float(value) if isinstance(value, bool) else value
            else:
                _fail(
                    "invalid-request",
                    f"{what} cell {row_index}.{column_index} must be a string, number, boolean or null",
                )
    for style_spec in spec.get("styles") or ():
        _apply_style(wb, sheet, style_spec, what)
    for name_spec in spec.get("names") or ():
        _define_name(wb, name_spec, "workbook", what)
    for width_spec in spec.get("columnWidths") or ():
        _apply_column_width(sheet, width_spec, what)
    if spec.get("freeze") is not None:
        sheet.freeze_panes = _coordinate(spec["freeze"], f"{what} freeze")
    return {
        "name": name,
        "rows": len(rows),
        "columns": width or 0,
        "at": coordinate,
        "cellsWritten": written,
        "formulas": formulas,
        "styles": len(spec.get("styles") or ()),
        "namedRanges": len(spec.get("names") or ()),
        "cellsPresent": len(_present_cells(sheet)),
    }


def _sheet_specs(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list) or not value:
        _fail("invalid-request", "create needs a non-empty list of sheets")
    if len(value) > MAX_CREATED_SHEETS:
        _fail("invalid-request", f"create takes at most {MAX_CREATED_SHEETS} sheets")
    specs: List[Dict[str, Any]] = []
    total = 0
    for index, raw in enumerate(value):
        what = f"sheet {index}"
        spec = _object(raw, what, ("name", "rows", "at", "styles", "names", "columnWidths", "freeze"))
        _required(spec, ("name", "rows"), what)
        name = _string(spec["name"], f"{what} name", 255)
        rows = spec["rows"]
        if not isinstance(rows, list) or not rows:
            _fail("invalid-request", f"{what} needs a non-empty list of rows")
        width: Optional[int] = None
        for position, row in enumerate(rows):
            if not isinstance(row, list) or not row:
                _fail("invalid-request", f"{what} row {position} must be a non-empty list of cells")
            if width is None:
                width = len(row)
            if len(row) != width:
                _fail("invalid-request", f"{what} rows must all hold {width} cells")
            total += len(row)
        for row in rows:
            for cell in row:
                if not (isinstance(cell, (str, int, float, bool)) or cell is None):
                    _fail(
                        "invalid-request",
                        f"{what} cells must be strings, numbers, booleans or null; a formula is a "
                        "string beginning with =",
                    )
        if total > MAX_RANGE_CELLS * MAX_CREATED_SHEETS:
            _fail(
                "invalid-request",
                f"create writes at most {MAX_RANGE_CELLS * MAX_CREATED_SHEETS} cells in one call",
            )
        specs.append(
            {
                "name": name,
                "rows": rows,
                "at": spec.get("at"),
                "styles": [_style_spec(item, f"{what} style") for item in spec.get("styles") or ()],
                "names": [_name_spec(item, f"{what} name") for item in spec.get("names") or ()],
                "columnWidths": [
                    _width_spec(item, f"{what} column width") for item in spec.get("columnWidths") or ()
                ],
                "freeze": spec.get("freeze"),
            }
        )
    return specs


def _style_spec(value: Any, what: str) -> Dict[str, Any]:
    entry = _object(value, what, ("range", "style"))
    _required(entry, ("range", "style"), what)
    style = _object(entry["style"], f"{what} style", STYLE_FIELDS)
    if not style:
        _fail("invalid-request", f"{what} names no style")
    for key in ("bold", "italic", "wrapText"):
        if key in style:
            style[key] = _boolean(style[key], f"{what} style {key}")
    if "size" in style:
        style["size"] = _number(style["size"], f"{what} style size", 1, 400)
    if "name" in style:
        style["name"] = _string(style["name"], f"{what} style name", 128)
    if "color" in style:
        style["color"] = _color(style["color"], f"{what} style color")
    if "fillColor" in style:
        style["fillColor"] = _color(style["fillColor"], f"{what} style fillColor")
    if "numberFormat" in style:
        style["numberFormat"] = _string(style["numberFormat"], f"{what} style numberFormat", 128)
    if "horizontal" in style:
        style["horizontal"] = _one_of(
            style["horizontal"], f"{what} style horizontal", ("left", "center", "right", "fill", "justify")
        )
    if "vertical" in style:
        style["vertical"] = _one_of(
            style["vertical"], f"{what} style vertical", ("top", "center", "bottom", "justify")
        )
    core, _prefix, _bounds = _bounded_range(entry["range"], f"{what} range")
    return {"range": core, "style": style}


def _color(value: Any, what: str) -> str:
    text = _string(value, what, 16).lstrip("#").upper()
    if not re.fullmatch(r"[0-9A-F]{6}", text):
        _fail("invalid-request", f"{what} must be six hexadecimal digits such as FFCC00")
    return text


def _name_spec(value: Any, what: str) -> Dict[str, Any]:
    entry = _object(value, what, ("name", "reference", "scope"))
    _required(entry, ("name", "reference"), what)
    name = _string(entry["name"], f"{what} name", 255)
    if not re.fullmatch(r"[A-Za-z_\\][A-Za-z0-9_.\\]*", name):
        _fail("invalid-request", f"{what} name must be a defined name such as RevenueTotal")
    scope = entry.get("scope") or "workbook"
    if scope not in ("workbook", "sheet"):
        _fail("invalid-request", f"{what} scope must be workbook or sheet")
    reference = _string(entry["reference"], f"{what} reference", MAX_NAME_REFERENCE)
    return {"name": name, "reference": reference, "scope": scope}


def _width_spec(value: Any, what: str) -> Dict[str, Any]:
    entry = _object(value, what, ("column", "columns", "width"))
    _required(entry, ("width",), what)
    width = _number(entry["width"], f"{what} width", 0, 255)
    columns: List[str] = []
    if entry.get("column") is not None:
        columns.append(_column(entry["column"], f"{what} column"))
    for item in entry.get("columns") or ():
        columns.append(_column(item, f"{what} column"))
    if not columns:
        _fail("invalid-request", f"{what} needs a column or a list of columns")
    if len(columns) > 64:
        _fail("invalid-request", f"{what} names more than 64 columns")
    return {"columns": columns, "width": width}


def _column(value: Any, what: str) -> str:
    text = _string(value, what, 8).replace("$", "").upper()
    match = re.fullmatch(r"([A-Z]{1,3})", text)
    if match is None:
        _fail("invalid-request", f"{what} must be a column letter such as B")
    if column_index_from_string(match.group(1)) > EXCEL_MAX_COLUMN:
        _fail("invalid-request", f"{what} is outside the spreadsheet grid")
    return match.group(1)


def _apply_style(wb: Any, sheet: Any, spec: Dict[str, Any], what: str) -> List[str]:
    core, _prefix, bounds = _bounded_range(spec["range"], f"{what} range")
    min_col, min_row, max_col, max_row = bounds
    touched: List[str] = []
    style = spec["style"]
    for row in range(min_row, max_row + 1):
        for column in range(min_col, max_col + 1):
            cell = sheet.cell(row=row, column=column)
            if style.get("bold") is not None or style.get("italic") is not None or style.get("size") is not None or style.get("name") is not None or style.get("color") is not None:
                cell.font = Font(
                    bold=style.get("bold"),
                    italic=style.get("italic"),
                    size=style.get("size"),
                    name=style.get("name"),
                    color=style.get("color"),
                )
            if style.get("fillColor") is not None:
                cell.fill = PatternFill("solid", fgColor=style["fillColor"])
            if style.get("numberFormat") is not None:
                cell.number_format = style["numberFormat"]
            if (
                style.get("horizontal") is not None
                or style.get("vertical") is not None
                or style.get("wrapText") is not None
            ):
                cell.alignment = Alignment(
                    horizontal=style.get("horizontal"),
                    vertical=style.get("vertical"),
                    wrap_text=style.get("wrapText"),
                )
            touched.append(cell.coordinate)
    return touched


def _apply_column_width(sheet: Any, spec: Dict[str, Any], what: str) -> None:
    for column in spec["columns"]:
        sheet.column_dimensions[column].width = spec["width"]


def _define_name(wb: Any, spec: Dict[str, Any], scope: str, what: str) -> Dict[str, Any]:
    """A defined name whose reference this adapter has resolved against the sheets it names."""
    name = spec["name"]
    reference = spec["reference"]
    prefix, core = _split_sheet_prefix_loose(reference)
    titles = _known_titles(wb)
    if prefix is None:
        _fail(
            "invalid-request",
            f"{what} reference {reference!r} needs a sheet prefix such as Revenue!$B$2, so it cannot "
            "mean a different sheet depending on who reads it",
        )
    if prefix.lower() not in titles:
        _fail(
            "broken-reference",
            f"{what} reference {reference!r} names sheet {prefix!r}, which this workbook does not "
            "have; a defined name that points nowhere is refused before it is written",
        )
    try:
        min_col, min_row, max_col, max_row = range_boundaries(core.upper().replace("$", ""))
    except (TypeError, ValueError, IndexError):
        _fail("invalid-request", f"{what} reference {reference!r} is not a range")
    if None in (min_col, min_row, max_col, max_row) or min_row < 1 or min_col < 1 or max_row > EXCEL_MAX_ROW or max_col > EXCEL_MAX_COLUMN:
        _fail("broken-reference", f"{what} reference {reference!r} is outside the spreadsheet grid")
    definition = DefinedName(name, attr_text=reference)
    if spec["scope"] == "sheet":
        sheet = _sheet(wb, prefix, f"{what} sheet")
        sheet.defined_names[name] = definition
    else:
        wb.defined_names.add(definition)
    return {"name": name, "reference": reference, "scope": spec["scope"]}


def _create(params: Dict[str, Any]) -> Dict[str, Any]:
    entry = _object(params, "create parameters", ("output", "sheets"))
    _required(entry, ("output", "sheets"), "create parameters")
    name = _output_name(entry["output"])
    specs = _sheet_specs(entry["sheets"])
    path = documents.declare_output(name, FORMAT)
    wb = Workbook()
    wb.remove(wb.active)
    placements = [_created_sheet(wb, spec, index) for index, spec in enumerate(specs)]
    _applying(wb.save, path)
    sha, size = _written(path)
    parts = _sheet_part_map(path)
    chart_items, unmodeled = _chart_items(wb, path)
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
        structure=_census(wb, path, parts, chart_items),
        placements=placements,
        namedRanges=_declared_names(wb),
        provenance={
            "template": "paper-xlsx default",
            "source": None,
            "note": (
                "a new workbook carries the values and formulas it was given; nothing here computes "
                "one, and no chart is drawn (charts are read by this adapter, drawn by the data pack)"
            ),
        },
        reopened=_reopened(path),
        parts=parts,
        unmodeledChartParts=unmodeled,
        recalculation=_recalculation(path),
        warnings=[
            "no spreadsheet engine ran here: a formula written into a new draft has no cached value "
            "until Excel or LibreOffice opens it",
        ],
    )


def _written(path: str) -> Tuple[str, int]:
    with open(path, "rb") as handle:
        data = handle.read()
    return hashlib.sha256(data).hexdigest(), len(data)


def _reopened(path: str) -> Dict[str, Any]:
    """Reopen the written workbook with the pinned library: the check the design wants before a commit."""
    wb = _measure(path, "the written workbook")
    parts = _sheet_part_map(path)
    charts, _unmodeled = _chart_items(wb, path)
    census = _census(wb, path, parts, charts)
    return {
        "sheets": census["sheets"],
        "cells": census["cells"],
        "formulas": census["formulas"],
        "namedRanges": census["namedRanges"],
        "styledCells": census["styledCells"],
        "tables": census["tables"],
        "charts": census["charts"],
        "chartParts": census["chartParts"],
        "parts": census["parts"],
        "referenceCheck": _reference_check(wb, path, "the written workbook")["brokenTotal"],
    }


# -- edit ------------------------------------------------------------------------------------------


def _set_cell(wb: Any, spec: Dict[str, Any]) -> Dict[str, Any]:
    sheet = _optional_sheet(wb, spec.get("sheet"), "the setCell sheet") or wb.worksheets[0]
    coordinate = _coordinate(spec["cell"], "the setCell cell")
    has_value = "value" in spec
    has_formula = spec.get("formula") is not None
    if has_value and has_formula:
        _fail("invalid-request", "the setCell step takes either value or formula, not both")
    if not has_value and not has_formula:
        _fail(
            "invalid-request",
            "the setCell step needs a value (a literal, or null to clear the cell) or a formula "
            "(text beginning with =)",
        )
    cell = sheet[coordinate]
    previous = cell.value if cell.data_type != "f" else None
    previous_formula = cell.value if cell.data_type == "f" else None
    if has_formula:
        formula = _string(spec["formula"], "the setCell formula", MAX_TEXT)
        if not formula.startswith("="):
            _fail("invalid-request", "the setCell formula must begin with =")
        cell.value = formula
        written_kind = "formula"
        written = formula
    else:
        value = spec["value"]
        if not (isinstance(value, (str, int, float, bool)) or value is None):
            _fail(
                "invalid-request",
                "the setCell value must be a string, number, boolean or null; a formula uses the "
                "formula field",
            )
        if isinstance(value, float) and not math.isfinite(value):
            _fail("invalid-request", "the setCell value must be finite; a workbook cannot hold NaN here")
        if isinstance(value, str) and value.startswith("="):
            _fail(
                "invalid-request",
                "a setCell value that begins with = would be read as a formula; use the formula field "
                "so the intent is explicit",
            )
        cell.value = float(value) if isinstance(value, bool) else value
        written_kind = "value"
        written = value
    locked = bool(sheet.protection is not None and sheet.protection.sheet and cell.protection is not None and cell.protection.locked)
    return {
        "kind": "setCell",
        "evidence": {
            "sheet": sheet.title,
            "cell": _qualified(sheet.title, coordinate),
            "written": written_kind,
            "previous": _scalar(previous).get("value"),
            "previousFormula": previous_formula,
            "protectedSheet": bool(sheet.protection is not None and sheet.protection.sheet),
            "lockedCell": locked,
        },
    }


def _set_range(wb: Any, spec: Dict[str, Any]) -> Dict[str, Any]:
    sheet = _optional_sheet(wb, spec.get("sheet"), "the setRange sheet") or wb.worksheets[0]
    core, _prefix, bounds = _bounded_range(spec["range"], "the setRange range")
    rows = spec["rows"]
    if not isinstance(rows, list) or not rows:
        _fail("invalid-request", "the setRange step needs a non-empty list of rows")
    width = None
    for position, row in enumerate(rows):
        if not isinstance(row, list) or not row:
            _fail("invalid-request", f"the setRange row {position} must be a non-empty list of cells")
        if width is None:
            width = len(row)
        if len(row) != width:
            _fail("invalid-request", f"the setRange rows must all hold {width} cells")
    min_col, min_row, max_col, max_row = bounds
    if len(rows) * (width or 0) > MAX_RANGE_CELLS:
        _fail(
            "invalid-request",
            f"the setRange step writes {len(rows) * (width or 0)} cells; the limit is {MAX_RANGE_CELLS}",
        )
    if min_row + len(rows) - 1 > max_row or min_col + (width or 0) - 1 > max_col:
        _fail(
            "invalid-request",
            f"the setRange values ({len(rows)}x{width}) do not fit the range {core}; a range that "
            "does not match the block it carries is refused rather than half written",
        )
    written = 0
    for row_index, row in enumerate(rows):
        for column_index, value in enumerate(row):
            if not (isinstance(value, (str, int, float, bool)) or value is None):
                _fail(
                    "invalid-request",
                    "the setRange cells must be strings, numbers, booleans or null; a formula uses "
                    "the setCell step",
                )
            if isinstance(value, str) and value.startswith("="):
                _fail(
                    "invalid-request",
                    "the setRange step writes literals; a cell beginning with = uses the setCell step "
                    "with its formula field",
                )
            if isinstance(value, float) and not math.isfinite(value):
                _fail("invalid-request", "the setRange cells must be finite numbers")
            sheet.cell(row=min_row + row_index, column=min_col + column_index).value = (
                float(value) if isinstance(value, bool) else value
            )
            written += 1
    return {
        "kind": "setRange",
        "evidence": {"sheet": sheet.title, "range": _qualified(sheet.title, core), "cells": written},
    }


def _clear_cells(wb: Any, spec: Dict[str, Any]) -> Dict[str, Any]:
    sheet = _optional_sheet(wb, spec.get("sheet"), "the clearCells sheet") or wb.worksheets[0]
    core, _prefix, bounds = _bounded_range(spec["range"], "the clearCells range")
    min_col, min_row, max_col, max_row = bounds
    cleared: List[str] = []
    for row in range(min_row, max_row + 1):
        for column in range(min_col, max_col + 1):
            cell = sheet._cells.get((row, column))
            if cell is None or (cell.value is None and not cell.has_style):
                continue
            cell.value = None
            cleared.append(cell.coordinate)
    return {
        "kind": "clearCells",
        "evidence": {
            "sheet": sheet.title,
            "range": _qualified(sheet.title, core),
            "cleared": _bounded(cleared, 20)[0],
            "clearedTotal": len(cleared),
        },
    }


def _apply_edit_step(wb: Any, spec: Any) -> Dict[str, Any]:
    """One typed edit step. Every target is validated before anything is written."""
    block = _object(spec, "an edit step")
    kind = block.get("kind")
    if not isinstance(kind, str) or kind not in STEP_FIELDS:
        _fail("invalid-request", f"an edit step names an unknown kind {kind!r}")
    required, optional = STEP_FIELDS[kind]
    _object(block, f"the {kind} step", ("kind", *required, *optional))
    _required(block, required, f"the {kind} step")

    if kind == "setCell":
        return _set_cell(wb, block)
    if kind == "setRange":
        return _set_range(wb, block)
    if kind == "clearCells":
        return _clear_cells(wb, block)
    if kind == "setStyle":
        sheet = _optional_sheet(wb, block.get("sheet"), "the setStyle sheet") or wb.worksheets[0]
        style_spec = _style_spec({"range": block["range"], "style": block["style"]}, "the setStyle")
        touched = _apply_style(wb, sheet, style_spec, "the setStyle")
        return {
            "kind": kind,
            "evidence": {
                "sheet": sheet.title,
                "range": _qualified(sheet.title, style_spec["range"]),
                "keys": sorted(style_spec["style"]),
                "cells": _bounded(touched, 20)[0],
                "cellsTotal": len(touched),
            },
        }
    if kind == "setColumnWidth":
        sheet = _optional_sheet(wb, block.get("sheet"), "the setColumnWidth sheet") or wb.worksheets[0]
        width_spec = _width_spec(
            {"column": block.get("column"), "columns": block.get("columns"), "width": block["width"]},
            "the setColumnWidth",
        )
        _apply_column_width(sheet, width_spec, "the setColumnWidth")
        return {
            "kind": kind,
            "evidence": {"sheet": sheet.title, "columns": width_spec["columns"], "width": width_spec["width"]},
        }
    if kind == "addSheet":
        name = _string(block["name"], "the addSheet name", 255)
        if name in wb.sheetnames:
            _fail("invalid-request", f"the addSheet step names sheet {name!r}, which already exists")
        sheet = wb.create_sheet(name)
        at = None
        if block.get("at") is not None:
            at = _integer(block["at"], "the addSheet at", 0, 10**4)
            wb.move_sheet(sheet, offset=at - wb.sheetnames.index(name))
        return {
            "kind": kind,
            "evidence": {"name": name, "at": at, "sheets": len(wb.worksheets)},
        }
    if kind == "deleteSheet":
        sheet = _sheet(wb, block["sheet"], "the deleteSheet sheet")
        if len(wb.worksheets) <= 1:
            _fail("invalid-request", "a workbook must keep at least one worksheet")
        pointing = _references_to_sheet(wb, sheet.title)
        if pointing["total"]:
            _fail(
                "broken-reference",
                f"deleting sheet {sheet.title!r} would leave {pointing['total']} reference(s) pointing "
                f"at a sheet that no longer exists ({_describe(pointing['items'])}). No proposal "
                "was produced and every source version is unchanged. Rewrite or remove those "
                "references first.",
            )
        title = sheet.title
        wb.remove(sheet)
        return {"kind": kind, "evidence": {"sheet": title, "sheets": len(wb.worksheets)}}
    if kind == "renameSheet":
        sheet = _sheet(wb, block["sheet"], "the renameSheet sheet")
        to = _string(block["to"], "the renameSheet to", 255)
        if to in wb.sheetnames and to != sheet.title:
            _fail("invalid-request", f"the renameSheet step names sheet {to!r}, which already exists")
        before = sheet.title
        _applying(setattr, sheet, "title", to)
        return {
            "kind": kind,
            "evidence": {
                "sheet": before,
                "to": to,
                "referencesRewritten": _references_to_sheet(wb, to)["total"],
            },
        }
    if kind == "setName":
        spec = _name_spec(
            {"name": block["name"], "reference": block["reference"], "scope": block.get("scope")},
            "the setName",
        )
        written = _define_name(wb, spec, spec["scope"], "the setName")
        return {"kind": kind, "evidence": written}
    name = _string(block["name"], "the removeName name", 255)
    scope = block.get("scope") or "workbook"
    if scope not in ("workbook", "sheet"):
        _fail("invalid-request", "the removeName scope must be workbook or sheet")
    sheet_name = block.get("sheet")
    registry = wb.defined_names
    if scope == "sheet":
        if sheet_name is None:
            _fail("invalid-request", "a sheet-scoped removeName needs the sheet it belongs to")
        registry = _sheet(wb, sheet_name, "the removeName sheet").defined_names
    if name not in registry:
        _fail(
            "target-not-found",
            f"the removeName step names {name!r}, which this workbook does not define",
        )
    del registry[name]
    return {"kind": "removeName", "evidence": {"name": name, "scope": scope}}


def _describe(items: Sequence[Dict[str, Any]]) -> str:
    return "; ".join(f"{item['where']} ({item['kind']})" for item in items[:4])


def _describe_broken(items: Sequence[Dict[str, Any]]) -> str:
    """A broken reference, named with what it is *and* what could not be found."""
    return "; ".join(
        f"{item['where']} ({item['kind']}: {item.get('detail') or item.get('raw')})"
        for item in items[:4]
    )


def _references_to_sheet(wb: Any, title: str) -> Dict[str, Any]:
    """Every formula surface that points at one sheet, so a delete or a rename can be argued."""
    titles = _known_titles(wb)
    names = _defined_name_index(wb)
    tables = _table_index(wb)
    found: List[Dict[str, Any]] = []
    for surface in paper_references.formula_surfaces(wb):
        value = surface.value
        if not isinstance(value, str) or value.strip() == "":
            continue
        probe = value if value.startswith("=") else "=" + value
        references, _error = _formula_references(probe, titles, names, tables)
        for reference in references:
            if reference.get("sheet") == title and reference["kind"] == "cell-range":
                found.append({"where": surface.label, "kind": reference["kind"], "raw": reference["raw"]})
    for item in _declared_names(wb):
        prefix, _core = _split_sheet_prefix_loose(item["reference"])
        if prefix == title:
            found.append({"where": f"defined name {item['name']}", "kind": "defined-name", "raw": item["reference"]})
    for sheet in wb.worksheets:
        if sheet.title == title:
            continue
        for table in sheet.tables.values():
            prefix, _core = _split_sheet_prefix_loose(str(table.ref))
            if prefix == title:
                found.append({"where": f"table {table.displayName}", "kind": "table-range", "raw": str(table.ref)})
    kept, truncated = _bounded(found, 8)
    return {"items": kept, "total": len(found), "truncated": truncated}


def _steps(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list) or not value:
        _fail("invalid-request", "edit needs a non-empty list of steps")
    if len(value) > MAX_STEPS:
        _fail("invalid-request", f"edit takes at most {MAX_STEPS} steps")
    return [_object(step, f"step {index}") for index, step in enumerate(value)]


def _report(
    operation: str,
    wb: Any,
    source_path: str,
    path: str,
    reference: Dict[str, Any],
    name: str,
    payload: Dict[str, Any],
    source_check: Dict[str, Any],
) -> Dict[str, Any]:
    """Save through the fork's own preserve-mode save, then measure what it wrote."""
    _applying(wb.save, path)
    edit_receipt = _applying(receipts.receipt, source_path, path)
    receipt_payload = edit_receipt.to_dict()
    change_set = _change_set(source_path, path)
    source_model = _remember(_measure(source_path, f"the leased input {reference['name']!r}"), source_path)
    output_model = _remember(_measure(path, "the written workbook"), path)
    output_check = _reference_check(output_model, path, "the written workbook")
    new_broken = [
        item
        for item in output_check["broken"]
        if (item.get("where"), item.get("kind"), item.get("raw"))
        not in _reference_signature(source_check)
    ]
    if new_broken:
        _fail(
            "broken-reference",
            f"the edit would leave {len(new_broken)} reference(s) this workbook cannot resolve "
            f"({_describe_broken(new_broken)}). No proposal was produced and every source version is "
            "unchanged. Fix the reference, or the step that removed what it pointed at.",
        )
    changed_cells, changed_total = _cells_diff(source_path, path)
    style_changes = _style_diffs_everywhere(source_model, output_model)
    cached_output = _cached_model(path, "the written workbook")
    changed_addresses = _changed_addresses(source_path, receipt_payload, changed_cells)
    numeric, numeric_total = _numeric_checks(
        source_model, output_model, changed_addresses, cached_output
    )
    dependencies, dependency_total = _dependencies(output_model, changed_addresses)
    preservation = _preservation(
        source_path, path, [item["part"] for item in change_set["changed"]]
    )
    sha, size = _written(path)
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
        editReceipt={
            "schema": receipt_payload["schema"],
            "version": receipt_payload["version"],
            "cellsChanged": _bounded_mapping(receipt_payload.get("cells_changed") or {}),
            "partsChanged": list(receipt_payload.get("parts_changed") or []),
            "partsAdded": list(receipt_payload.get("parts_added") or []),
            "partsRemoved": list(receipt_payload.get("parts_removed") or []),
            "confession": list(receipt_payload.get("confession") or [])[:8],
            "confessionTotal": len(receipt_payload.get("confession") or []),
            "derivedEffects": list(receipt_payload.get("derived_effects") or [])[:8],
            "derivedEffectsTotal": len(receipt_payload.get("derived_effects") or []),
            "recalc": receipt_payload.get("recalc"),
        },
        changeSet=change_set,
        preservation=preservation,
        diff={
            "cells": _bounded(changed_cells, MAX_CHANGED_CELLS)[0],
            "cellsTotal": changed_total,
            "cellsTruncated": changed_total > MAX_CHANGED_CELLS,
            "styleChanges": _bounded(style_changes, MAX_CHANGED_CELLS)[0],
            "styleChangesTotal": len(style_changes),
            "dependencies": dependencies,
            "dependenciesTotal": dependency_total,
            "numericChecks": numeric,
            "numericChecksTotal": numeric_total,
            "numericChecksTruncated": numeric_total > MAX_NUMERIC_CHECKS,
            "measurement": (
                "the cell and formula diff is openpyxl.preserve.diffreport's own measurement; the "
                "style diff and the numeric checks are this adapter reading the two packages"
            ),
        },
        referenceCheck={
            "source": source_check,
            "output": output_check,
            "sourceBroken": source_check["brokenTotal"],
            "outputBroken": output_check["brokenTotal"],
            "newBroken": [],
            "note": (
                "an operation that would add a broken reference is refused before anything is written, "
                "so newBroken is always empty in a result that exists"
            ),
        },
        recalculation=_recalculation(path),
        protections=_protections(wb),
        reopened=_reopened(path),
        warnings=_warnings(
            output_model, output_check, _chart_items(output_model, path)[1]
        ),
    )


def _bounded_mapping(value: Dict[str, Any]) -> Dict[str, Any]:
    """The changed-cell set keyed by part, bounded, with its exact total kept beside it."""
    parts: Dict[str, Any] = {}
    total = 0
    for part, cells in sorted(value.items()):
        if not isinstance(cells, dict):
            continue
        total += len(cells)
        parts[part] = {address: state for address, state in sorted(cells.items())[:MAX_CHANGED_CELLS]}
    return {"parts": parts, "total": total, "truncated": total > MAX_CHANGED_CELLS}


def _edit(params: Dict[str, Any]) -> Dict[str, Any]:
    entry = _object(params, "edit parameters", ("ref", "output", "steps"))
    _required(entry, ("ref", "output", "steps"), "edit parameters")
    reference = _reference(entry["ref"], "edit source")
    name = _output_name(entry["output"])
    steps = _steps(entry["steps"])
    path = documents.declare_output(name, FORMAT, edit_of=reference["versionId"])
    source_path, wb, _facts = _open(reference)
    _remember(wb, source_path)
    source_check = _reference_check(wb, source_path, "the leased input")
    changes = [_apply_edit_step(wb, spec) for spec in steps]
    return _report(
        "edit",
        wb,
        source_path,
        path,
        reference,
        name,
        {"changes": changes, "steps": [spec.get("kind") for spec in steps]},
        source_check,
    )


def _preview(params: Dict[str, Any]) -> Dict[str, Any]:
    entry = _object(params, "preview parameters", ("ref", "cursor", "pageSize"))
    _required(entry, ("ref",), "preview parameters")
    reference = _reference(entry["ref"], "preview ref")
    cursor, page_size = _page_of(entry)
    path, wb, facts = _open(reference)
    parts = _sheet_part_map(path)
    names = _declared_names(wb)
    items: List[Dict[str, Any]] = []
    for position, sheet in enumerate(wb.worksheets):
        charts = list(getattr(sheet, "_charts", ()) or ())
        lines, total = _preview_lines(wb, sheet, names, charts)
        outline = _sheet_outline(wb, sheet, position, parts)
        items.append(
            {
                "position": position,
                "title": sheet.title,
                "part": outline["part"],
                "usedRange": outline["usedRange"],
                "protected": outline["protected"],
                "lines": lines,
                "linesTruncated": total > len(lines),
                "lineTotal": total,
                "counts": {
                    "cells": outline["cells"],
                    "formulas": outline["formulas"],
                    "styledCells": outline["styledCells"],
                    "tables": outline["tables"],
                    "charts": outline["charts"],
                },
            }
        )
    check = _reference_check(wb, path, "preview")
    chart_items, unmodeled = _chart_items(wb, path)
    return _envelope(
        "preview",
        source=_source(reference),
        page=_page(items, cursor, page_size, "sheets"),
        workbook=_census(wb, path, parts, chart_items),
        namedRanges=names,
        unmodeledChartParts=unmodeled,
        package=facts,
        referenceCheck=check,
        recalculation=_recalculation(path),
        protections=_protections(wb),
        warnings=_warnings(wb, check, unmodeled),
    )


def _compare(params: Dict[str, Any]) -> Dict[str, Any]:
    entry = _object(params, "compare parameters", ("from", "to"))
    _required(entry, ("from", "to"), "compare parameters")
    from_ref = _reference(entry["from"], "compare from")
    to_ref = _reference(entry["to"], "compare to")
    from_path = documents.open_input(from_ref["versionId"])
    to_path = documents.open_input(to_ref["versionId"])
    _guard_package(from_path, f"the leased input {from_ref['name']!r}")
    _guard_package(to_path, f"the leased input {to_ref['name']!r}")
    from_wb = _remember(_load(from_path, f"the leased input {from_ref['name']!r}"), from_path)
    to_wb = _remember(_load(to_path, f"the leased input {to_ref['name']!r}"), to_path)
    change_set = _change_set(from_path, to_path)
    preserved = _preservation(from_path, to_path, [item["part"] for item in change_set["changed"]])
    changed_cells, changed_total = _cells_diff(from_path, to_path)
    style_changes = _style_diffs_everywhere(from_wb, to_wb)
    cached_to = _cached_model(to_path, f"the leased input {to_ref['name']!r}")
    addresses = _changed_addresses(from_path, {}, changed_cells)
    numeric, numeric_total = _numeric_checks(from_wb, to_wb, addresses, cached_to)
    dependencies, dependency_total = _dependencies(to_wb, addresses)
    from_check = _reference_check(from_wb, from_path, "the compared source")
    to_check = _reference_check(to_wb, to_path, "the compared target")
    return _envelope(
        "compare",
        sources={"from": _source(from_ref), "to": _source(to_ref)},
        changeSet=change_set,
        preservation=preserved,
        diff={
            "cells": _bounded(changed_cells, MAX_CHANGED_CELLS)[0],
            "cellsTotal": changed_total,
            "cellsTruncated": changed_total > MAX_CHANGED_CELLS,
            "styleChanges": _bounded(style_changes, MAX_CHANGED_CELLS)[0],
            "styleChangesTotal": len(style_changes),
            "dependencies": dependencies,
            "dependenciesTotal": dependency_total,
            "numericChecks": numeric,
            "numericChecksTotal": numeric_total,
            "numericChecksTruncated": numeric_total > MAX_NUMERIC_CHECKS,
            "identical": bool(
                change_set["semanticallyEmpty"] and not changed_total and not style_changes
            ),
            "measurement": (
                "the cell and formula diff is openpyxl.preserve.diffreport's own measurement; the "
                "style diff and the numeric checks are this adapter reading the two packages"
            ),
        },
        referenceCheck={"from": from_check, "to": to_check},
        recalculation=_recalculation(to_path),
        reopened=_reopened(to_path),
        warnings=_warnings(to_wb, to_check, _chart_items(to_wb, to_path)[1]),
        identical=bool(change_set["semanticallyEmpty"] and not changed_total and not style_changes),
    )


OPERATIONS = {
    "inspect": _inspect,
    "read": _read,
    "create": _create,
    "edit": _edit,
    "preview": _preview,
    "compare": _compare,
}


def run(operation: str, parameters: Any) -> Dict[str, Any]:
    """Run one typed Excel operation. ``operation`` is fixed by the submitted code."""
    if operation not in OPERATIONS:
        _fail("invalid-request", f"{operation!r} is not an Excel operation")
    return OPERATIONS[operation](_object(parameters, "operation parameters"))


__all__ = ["run", "SCHEMA", "VERSION", "OPERATIONS", "READ_SECTIONS", "FORMAT"]