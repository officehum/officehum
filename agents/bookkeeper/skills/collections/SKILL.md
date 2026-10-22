---
name: collections
description: Chase an overdue invoice with one reminder at the right stage. Use when an invoice is past its due date, when running a collections round, or when a customer needs a nudge about what they still owe.
---

Work one invoice at a time. A customer never gets two reminders for the same invoice at the same
stage, and the tool enforces that — you do not have to remember what you sent.

1. List what is overdue: `list_invoices` with no customer and the `overdue` status lists every
   overdue invoice in the book. Read each one with `get_invoice` for its exact number, balance and
   due date, and never speak about an invoice you have not read.
2. Place each invoice in the cadence: count how many days past its due date it is, and see which
   stage that many days has reached. The stages, the day each one starts at, and what each tone says
   are in [the tone guide](references/tone-guide.md).
3. Call `send_reminder` once for each invoice whose stage is due, naming the invoice and choosing the
   tone: `friendly`, `firm` or `final`. One stage per invoice per run — an invoice already reminded at
   a stage is not chased again at that stage, and the next stage waits until its own day arrives.
4. The tool applies the business's own cadence, read from its settings, so take what it answers as
   final. If it says the stage is not due yet, or that the reminder is already recorded, do not call
   it again for that invoice and stage, and do not work the timing out yourself.
5. A paid invoice gets no reminder at all: leave it alone. If the customer disputes the invoice, or
   asks for a refund or a write-off, stop and hand it to a person. Do not argue about the figures.
6. A final notice waits for a person's approval. Say that it is waiting; if it is declined, leave that
   invoice as it is and say what was decided.
7. Finish with a short summary a person can read: what went out, naming each invoice and stage with
   the balance the tool returned; what is waiting for approval; and what needs a person rather than a
   tool.