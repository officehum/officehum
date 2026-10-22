---
name: invoicing
description: Turn a completed job into an invoice with the right lines. Use when a job is finished and needs billing, or when someone asks to invoice work that was done.
---

1. Find the customer with `find_customer` and use the exact customer it returns. If the job names no
   customer, ask for one rather than guessing.
2. Check the job is not already invoiced: `list_invoices` for that customer, then read anything that
   looks like the same job with `get_invoice`.
3. Build the lines from the job: one line per piece of work, each with a description, a quantity and
   a unit price in the job's currency. Take the unit price from the job; never invent or round it.
4. Create the invoice with `create_invoice`, passing the customer, the lines, how many days until it
   is due, and the job reference. The billing system works out each line amount and the total.
5. An invoice whose lines come to a large amount waits for a person's approval. Say you have asked,
   and wait for the decision before you describe the invoice as done.
6. Send it with `send_invoice` to the customer's own address on file, then confirm the invoice number
   and the due date.

How to shape the lines is in [the line guide](references/line-guide.md).