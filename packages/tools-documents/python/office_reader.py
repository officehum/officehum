"""The reading pack's Office program, run by the Paper Office worker as submitted code.

It is fixed: the TypeScript side sends this file's text unchanged as the run's code, and everything
that varies (which leased version, which format, where to resume) arrives through
``documents.arguments()``. The run's receipt therefore binds this program's hash and the argument
hash, like every typed Paper Office operation.

Why its own program rather than ``word_adapter``'s or ``xlsx_adapter``'s ``read``: those pages are
built for editing, so they cap an item's text at 400 and 240 characters, and a contract clause or a
long note is usually longer. Reading needs the whole text, so this program walks the same pinned
libraries (``paper-docx``'s ``iter_blocks``; ``paper-xlsx``'s ``load_workbook``) and returns compact
items, as many as fit in one result, with the cursor that continues them.

``documents`` is in scope, as the worker provides it to every run. Nothing here takes a path from its
arguments: ``documents.open_input`` turns a leased version id into the run's read-only copy.
"""

import datetime
import json

import docx
import openpyxl

ARGS = documents.arguments()  # noqa: F821 - provided by the worker

# The worker refuses a result over 64 KiB; stop well short of it so the envelope always fits.
BUDGET_BYTES = 48_000
MAX_ITEM_TEXT = 8_000


def fail(code, message):
    raise documents.WorkspaceError(code, message)  # noqa: F821


def clip(text):
    if len(text) <= MAX_ITEM_TEXT:
        return text, False
    return text[:MAX_ITEM_TEXT], True


def leased_path():
    ref = ARGS.get("ref")
    if not isinstance(ref, dict) or not isinstance(ref.get("versionId"), str):
        fail("invalid-request", "the reader needs the leased reference it is to read")
    return documents.open_input(ref["versionId"])  # noqa: F821


def page_of(items, cursor):
    """As many items from ``cursor`` as fit the budget, and where the next run should resume."""
    kept = []
    used = 0
    index = cursor
    while index < len(items):
        size = len(json.dumps(items[index], ensure_ascii=False).encode("utf-8")) + 1
        if kept and used + size > BUDGET_BYTES:
            break
        kept.append(items[index])
        used += size
        index += 1
    return kept, (index if index < len(items) else None)


# -- Word ------------------------------------------------------------------------------------------


def heading_level(style_id):
    if style_id is None:
        return None
    if style_id == "Title":
        return 0
    if style_id.startswith("Heading") and style_id[7:].isdigit():
        return int(style_id[7:])
    return None


def is_list(block, style_id):
    if style_id is not None and style_id.startswith("List"):
        return True
    return bool(block._element.xpath("./w:pPr/w:numPr"))


def read_docx():
    try:
        document = docx.Document(leased_path())
        from docx.story import iter_blocks

        blocks = list(iter_blocks(document, view="current"))
    except documents.WorkspaceError:  # noqa: F821
        raise
    except Exception as error:  # the package opened as a zip but is not a readable Word document
        fail("malformed-package", f"the leased file is not a readable Word document ({type(error).__name__})")

    tables = {id(table._tbl): table for table in document.tables}
    items = []
    for block in blocks:
        item = {"story": block.story, "index": block.index}
        if block.kind == "table":
            table = tables.get(id(block._element))
            rows = []
            truncated = False
            if table is not None:
                for row in table.rows:
                    cells = []
                    for cell in row.cells:
                        text, cut = clip(cell.text)
                        truncated = truncated or cut
                        cells.append(text)
                    rows.append(cells)
            item.update({"kind": "table", "rows": rows, "truncated": truncated})
        else:
            text, cut = clip(block.text)
            level = heading_level(block.style_id)
            kind = "heading" if level is not None else ("list" if is_list(block, block.style_id) else "paragraph")
            item.update({"kind": kind, "text": text, "truncated": cut})
            if level is not None:
                item["level"] = level
        items.append(item)
    return {"format": "docx", "total": len(items), "items": items}


# -- Excel -----------------------------------------------------------------------------------------


def cell_value(value):
    """A cached or literal value as JSON, with the type it had in the workbook."""
    if value is None:
        return "empty", None
    if isinstance(value, bool):
        return "boolean", value
    if isinstance(value, (int, float)):
        return "number", value
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return "date", value.isoformat()
    text = str(value)
    if text.startswith("#") and text.endswith(("!", "?", "A")):
        return "error", text
    return "text", clip(text)[0]


def read_xlsx():
    path = leased_path()
    try:
        formulas = openpyxl.load_workbook(path, data_only=False)
        cached = openpyxl.load_workbook(path, data_only=True)
    except documents.WorkspaceError:  # noqa: F821
        raise
    except Exception as error:
        fail("malformed-package", f"the leased file is not a readable Excel workbook ({type(error).__name__})")

    sheets = []
    items = []
    for position, sheet in enumerate(formulas.worksheets):
        values = cached[sheet.title]
        tables = [
            {"name": name, "range": table.ref}
            for name, table in getattr(sheet, "tables", {}).items()
        ]
        sheets.append(
            {
                "position": position,
                "name": sheet.title,
                "state": sheet.sheet_state,
                "dimensions": sheet.dimensions,
                "maxRow": sheet.max_row,
                "maxColumn": sheet.max_column,
                "tables": tables,
            }
        )
        for row in sheet.iter_rows():
            for cell in row:
                if cell.value is None:
                    continue
                formula = cell.value if cell.data_type == "f" else None
                if formula is not None and not isinstance(formula, str):
                    formula = str(getattr(formula, "text", formula))
                item = {
                    "sheet": sheet.title,
                    "address": cell.coordinate,
                    "row": cell.row,
                    "column": cell.column,
                    "numberFormat": cell.number_format,
                }
                if formula is None:
                    kind, value = cell_value(cell.value)
                    item.update({"type": kind, "value": value, "formula": None, "cached": None})
                else:
                    # A formula's value is whatever the package cached when it was last saved; this
                    # program never calculates. No cache (a file never opened in Excel) is null.
                    kind, value = cell_value(values[cell.coordinate].value)
                    stored = None if kind == "empty" else {"type": kind, "value": value}
                    item.update({"type": "formula", "value": None, "formula": formula, "cached": stored})
                items.append(item)
    return {"format": "xlsx", "total": len(items), "items": items, "sheets": sheets}


def main():
    cursor = ARGS.get("cursor", 0)
    if not isinstance(cursor, int) or cursor < 0:
        fail("invalid-request", "the cursor must be a non-negative integer")
    fmt = ARGS.get("format")
    if fmt == "docx":
        reading = read_docx()
    elif fmt == "xlsx":
        reading = read_xlsx()
    else:
        fail("invalid-request", "the reader reads docx and xlsx only")
    if cursor > reading["total"]:
        fail("invalid-request", "the cursor is past the end of the document")
    kept, next_cursor = page_of(reading["items"], cursor)
    reading["items"] = kept
    reading["cursor"] = cursor
    reading["nextCursor"] = next_cursor
    documents.result(reading)  # noqa: F821


main()
