---
name: billing-questions
description: Answer a customer's question about an invoice with the figures the tools return. Use when someone asks what they owe, when an invoice is due, what it covers, or whether a payment has arrived.
---

1. Find the customer with `find_customer`.
2. Read the invoice: `list_invoices` to find the one being asked about, then `get_invoice` for its
   lines, total, balance and due date.
3. Answer with what the tools returned: the invoice number, the balance and the due date. Quote the
   figures exactly; never work out an amount, a total or a balance yourself.
4. If the question is about a payment, say only what the invoice's balance shows. You cannot claim a
   payment was made.
5. A question about a refund, a write-off or a dispute is not yours to answer: make no promise, and
   tell the customer a person will look into it.

What an answer should contain is in [the answer guide](references/answer-guide.md).