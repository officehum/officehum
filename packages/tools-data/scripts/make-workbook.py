"""Builds open-invoices.xlsx from open-invoices.csv. Every name and figure in it is made up.

Run it with the provisioned Paper worker interpreter, which has xlsxwriter (a paper-xlsx dependency):

    packages/tools-paper-office/scripts/provision-worker.sh
    packages/tools-paper-office/.worker/bin/python packages/tools-data/scripts/make-workbook.py

The workbook is kept as an office would keep it: a bold header row, dates as dates, amounts as
numbers with a two-decimal format. The data pack takes a sheet's first row that holds anything as its
header.
"""

from __future__ import annotations

import csv
import datetime
from pathlib import Path

import xlsxwriter

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"


def main() -> None:
    with (FIXTURES / "open-invoices.csv").open(newline="", encoding="utf-8") as handle:
        rows = list(csv.reader(handle))
    header, body = rows[0], rows[1:]

    workbook = xlsxwriter.Workbook(str(FIXTURES / "open-invoices.xlsx"))
    # A fixed creation time, so the file is the same on every run.
    workbook.set_properties({"created": datetime.datetime(2026, 10, 1, 9, 0, 0)})
    sheet = workbook.add_worksheet("Open invoices")
    bold = workbook.add_format({"bold": True})
    date = workbook.add_format({"num_format": "yyyy-mm-dd"})
    money = workbook.add_format({"num_format": "#,##0.00"})
    sheet.write_row(0, 0, header, bold)
    for index, (number, customer, issued, due, amount) in enumerate(body, start=1):
        sheet.write_string(index, 0, number)
        sheet.write_string(index, 1, customer)
        sheet.write_datetime(index, 2, datetime.datetime.fromisoformat(issued), date)
        sheet.write_datetime(index, 3, datetime.datetime.fromisoformat(due), date)
        sheet.write_number(index, 4, float(amount), money)
    workbook.close()


if __name__ == "__main__":
    main()
