---
name: collections
description: Chase an overdue invoice with one reminder at the right stage. Use when an invoice is past its due date, when running a collections round, or when a customer needs a nudge about what they still owe.
---

1. List what is overdue with `list_invoices`, then read each one with `get_invoice` for its exact
   number, balance and due date. Work one invoice at a time.
2. Check the balance first. A paid invoice gets no reminder at all.
3. Match the reminder to how late the invoice is: a friendly note a few days after the due date, a
   firm one when it has been overdue for a while, and a final notice after about a month. The exact
   cadence and the three tones are in [the tone guide](references/tone-guide.md).
4. Send it with `send_reminder`, naming the invoice and the customer, and choosing the tone:
   `friendly`, `firm` or `final`.
5. One reminder per invoice per stage. Never send a second reminder for the same invoice.
6. A final notice waits for a person's approval. If it is declined, leave that invoice and say what
   was decided.
7. If the customer disputes the invoice, or asks for a refund or a write-off, stop and hand it to a
   person. Do not argue about the figures.