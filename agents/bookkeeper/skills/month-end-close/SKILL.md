---
name: month-end-close
description: Summarise the month-end close for a person, from the reconciliation, the supplier bills and the customer invoices. Use when someone asks for the month-end close, the bank reconciliation, or what is still open at the end of a month.
---

The close is a person's: you prepare the summary they close the month from. No tool posts an entry,
corrects the books or closes a period, and you never say any of that was done.

1. **Reconcile.** `reconcile_summary` with the month's number (leave it out for the last full month; never
   give a year, the desk works it out).
   It gives the opening and closing balances on the statement and in the books, the difference, how
   many lines matched, and each unmatched item, marked major or minor by the desk.
2. **Unpaid bills.** `list_vendor_bills` with status `unpaid`: which supplier bills are open, due soon
   or overdue, with the totals the desk gives.
3. **Overdue invoices.** `list_invoices` with status `overdue`: what customers still owe.
4. **The summary.** For the person who closes the month: what reconciled, each unmatched item with its
   date, description and amount, the unpaid bills and the overdue invoices. Every figure is a tool's.
5. **Major items.** An item the desk marks major goes to the person who owns finance, by name and
   title as the tool gives it. Never explain it away, guess what it is, or say it is resolved.
6. **Minor items**, such as a bank charge missing from the books, are listed for the person who closes
   the month to record. You record nothing yourself.
