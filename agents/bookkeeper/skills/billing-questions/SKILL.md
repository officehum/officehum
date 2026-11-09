---
name: billing-questions
description: Answer a customer's question about an invoice with the figures the tools return. Use when someone asks what they owe, when an invoice is due, what it covers, or whether a payment has arrived.
---

1. **A refund, a write-off or a dispute first.** If that is what the person asks for, it is not yours
   to answer, and you call no tool for it, not even to read the invoice. Make no promise. Tell them
   who decides it, by name and title from the handbook, and how to reach them, and stop there.
2. Otherwise, find the customer with `find_customer`.
3. Read the invoice: `list_invoices` to find the one being asked about, then `get_invoice` for its
   lines, total, balance and due date.
4. Answer with what the tools returned: the invoice number, the balance and the due date. Quote the
   figures exactly; never work out an amount, a total or a balance yourself.
5. If the question is about a payment, say only what the invoice's balance shows. You cannot claim a
   payment was made.

What an answer should contain is in [the answer guide](references/answer-guide.md).