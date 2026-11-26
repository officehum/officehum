"""Builds the reading pack's test fixtures. Every name, figure and address in them is made up.

Run it with the provisioned Paper worker interpreter, which has the pinned paper-docx and the
xlsxwriter dependency of paper-xlsx (xlsxwriter, unlike openpyxl, writes a formula's cached value):

    packages/tools-paper-office/scripts/provision-worker.sh
    packages/tools-paper-office/.worker/bin/python packages/tools-documents/scripts/make-fixtures.py

The PDFs and the email are written byte by byte below, so they need no library at all. The fixtures
are committed; this script is how they were made and how to make them again.
"""

from __future__ import annotations

import base64
import zlib
from pathlib import Path

import docx
import xlsxwriter

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"


# -- PDF -------------------------------------------------------------------------------------------


def _pdf(pages: list[bytes], extra: list[bytes] | None = None, resources: bytes = b"") -> bytes:
    """A minimal PDF: a catalog, a page tree, one content stream per page and a Helvetica font.

    ``extra`` objects are appended after the font (object 3 onwards) for page resources such as an
    image; ``resources`` is spliced into every page's resource dictionary.
    """
    extra = extra or []
    objects: list[bytes] = []
    first_page = 4 + len(extra)
    kids = b" ".join(f"{first_page + 2 * i} 0 R".encode() for i in range(len(pages)))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(b"<< /Type /Pages /Kids [" + kids + b"] /Count " + str(len(pages)).encode() + b" >>")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    objects.extend(extra)
    for index, content in enumerate(pages):
        stream_ref = first_page + 2 * index + 1
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> "
            + resources
            + b" >> /Contents "
            + f"{stream_ref} 0 R".encode()
            + b" >>"
        )
        objects.append(b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream")

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode() + b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        b"trailer\n<< /Size "
        + str(len(objects) + 1).encode()
        + b" /Root 1 0 R >>\nstartxref\n"
        + str(xref).encode()
        + b"\n%%EOF\n"
    )
    return bytes(out)


def _text_page(lines: list[str]) -> bytes:
    """One page of left-aligned lines, 12 pt Helvetica, top to bottom."""
    body = [b"BT", b"/F1 12 Tf", b"72 770 Td", b"16 TL"]
    for line in lines:
        escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        body.append(b"(" + escaped.encode("cp1252") + b") Tj T*")
    body.append(b"ET")
    return b"\n".join(body)


def vendor_bill() -> bytes:
    return _pdf(
        [
            _text_page(
                [
                    "Northwind Supplies Ltd",
                    "Invoice NW-2041",
                    "Bill to: Example Trading Co.",
                    "Invoice date: 2026-10-02",
                ]
            ),
            _text_page(
                [
                    "Line items",
                    "Copier paper A4, 40 boxes: 180.00",
                    "Toner cartridge, 2 units: 240.00",
                ]
            ),
            _text_page(
                [
                    "Total due: 420.00 EUR",
                    "Payment terms: 30 days from the invoice date",
                    "Bank reference: NW-2041",
                ]
            ),
        ]
    )


def scanned_receipt() -> bytes:
    """A page that holds only a picture, as a scanner makes it: no text layer at all."""
    side = 16
    pixels = bytes((x * 13 + y * 7) % 256 for y in range(side) for x in range(side))
    data = zlib.compress(pixels)
    image = (
        b"<< /Type /XObject /Subtype /Image /Width "
        + str(side).encode()
        + b" /Height "
        + str(side).encode()
        + b" /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length "
        + str(len(data)).encode()
        + b" >>\nstream\n"
        + data
        + b"\nendstream"
    )
    page = b"q 400 0 0 560 97 141 cm /Im1 Do Q"
    return _pdf([page], extra=[image], resources=b"/XObject << /Im1 4 0 R >>")


def attached_invoice() -> bytes:
    return _pdf(
        [
            _text_page(
                [
                    "Northwind Supplies Ltd",
                    "Invoice NW-2042",
                    "Total due: 95.00 EUR",
                ]
            )
        ]
    )


# -- Word ------------------------------------------------------------------------------------------


def contract() -> None:
    document = docx.Document()
    document.add_heading("Cleaning Services Agreement", 0)
    document.add_heading("1. Parties", 1)
    document.add_paragraph(
        "This agreement is between Example Trading Co. (the Client) and Brightway Cleaning Ltd "
        "(the Contractor)."
    )
    document.add_heading("2. Fees", 1)
    document.add_paragraph("The Client pays the Contractor these monthly fees:")
    table = document.add_table(rows=3, cols=2)
    rows = [("Service", "Monthly fee"), ("Office cleaning", "1,200.00"), ("Window washing", "300.00")]
    for r, (service, fee) in enumerate(rows):
        table.cell(r, 0).text = service
        table.cell(r, 1).text = fee
    document.add_paragraph("Invoices are due within 30 days.", style="List Bullet")
    document.add_paragraph("Late payments carry no interest.", style="List Bullet")
    document.add_heading("3. Term and termination", 1)
    document.add_paragraph(
        "This agreement starts on 1 November 2026 and runs for twelve months. Either party may end "
        "it with sixty days' written notice. On termination the Contractor returns every key and "
        "access card within five working days, and the Client pays for work done up to the end of "
        "the notice period. Neither party is liable for delays caused by events outside its "
        "reasonable control, provided it tells the other party promptly and does what it reasonably "
        "can to limit the delay. This clause survives the end of the agreement."
    )
    document.save(FIXTURES / "contract.docx")


# -- Excel -----------------------------------------------------------------------------------------


def price_list() -> None:
    book = xlsxwriter.Workbook(str(FIXTURES / "price-list.xlsx"))
    prices = book.add_worksheet("Prices")
    prices.write_row(0, 0, ["Item", "Unit price", "Quantity", "Total"])
    items = [("Copier paper A4", 4.5, 40), ("Toner cartridge", 120, 2), ("Stapler", 9.75, 3)]
    for index, (item, price, quantity) in enumerate(items, start=1):
        prices.write_string(index, 0, item)
        prices.write_number(index, 1, price)
        prices.write_number(index, 2, quantity)
        prices.write_formula(index, 3, f"=B{index + 1}*C{index + 1}", None, price * quantity)
    prices.write_string(4, 0, "Grand total")
    prices.write_formula(4, 3, "=SUM(D2:D4)", None, sum(p * q for _, p, q in items))
    notes = book.add_worksheet("Notes")
    notes.write_string(0, 0, "Prices valid until 31 December 2026.")
    notes.write_string(1, 0, "Supplier")
    notes.write_string(1, 1, "Northwind Supplies Ltd")
    notes.write_boolean(2, 0, True)
    book.close()


# -- CSV and email ---------------------------------------------------------------------------------


def price_csv() -> bytes:
    rows = [
        "Item;Unit price;Quantity;Updated",
        "Café crème;2,50;120;2026-10-01",
        "Thé vert;1,80;80;2026-10-03",
        "Croissant;1,20;200;2026-10-04",
    ]
    # Windows-1252, as a spreadsheet exported on a European desktop writes it.
    return ("\r\n".join(rows) + "\r\n").encode("cp1252")


def forwarded_email(attachment: bytes) -> bytes:
    encoded = base64.encodebytes(attachment).decode("ascii")
    html = (
        "<html><body><p>Hello,</p><p>Please find <b>invoice NW-2042</b> attached.</p>"
        "<ul><li>Total due: 95.00 EUR</li><li>Due: 2026-11-30</li></ul>"
        "<p>Regards,<br>Northwind Accounts</p></body></html>"
    )
    message = "\r\n".join(
        [
            "From: Northwind Accounts <accounts@northwind.example>",
            "To: Example Trading Co. <ap@example-trading.example>",
            "Subject: Fwd: Invoice NW-2042",
            "Date: Mon, 02 Nov 2026 09:15:00 +0000",
            "Message-ID: <nw-2042@northwind.example>",
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="outer"',
            "",
            "--outer",
            "Content-Type: text/html; charset=utf-8",
            "Content-Transfer-Encoding: 7bit",
            "",
            html,
            "--outer",
            'Content-Type: application/pdf; name="NW-2042.pdf"',
            "Content-Transfer-Encoding: base64",
            'Content-Disposition: attachment; filename="NW-2042.pdf"',
            "",
            encoded.replace("\n", "\r\n").rstrip("\r\n"),
            "--outer--",
            "",
        ]
    )
    return message.encode("ascii")


def main() -> None:
    FIXTURES.mkdir(exist_ok=True)
    (FIXTURES / "vendor-bill.pdf").write_bytes(vendor_bill())
    (FIXTURES / "scanned-receipt.pdf").write_bytes(scanned_receipt())
    contract()
    price_list()
    (FIXTURES / "prices.csv").write_bytes(price_csv())
    (FIXTURES / "forwarded-bill.eml").write_bytes(forwarded_email(attached_invoice()))


if __name__ == "__main__":
    main()
