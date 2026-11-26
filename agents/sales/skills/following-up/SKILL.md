---
name: following-up
description: Keep a lead moving after a quote or a conversation, with a cadence that ends rather than nags. Use when a quote has gone out, when a decision is due, when a client pushes back on a quoted price, or when a lead has gone quiet.
---

A follow-up is a reason to answer, not a reminder that you exist. Every message carries something the
client did not have before: an answer to their question, a measured figure, a date, a name.

1. **Record the quote as sent, and schedule the next touch, when it goes out.** Mark it with
   `record_quote_outcome` (`sent`, on the day it went), then put the first follow-up on the lead with
   `schedule_follow_up`. Each time a touch is done, schedule the next one; `list_leads` shows every
   lead's next follow-up. A quote awaiting a person's approval is not ready to send: it is never marked
   sent, and the client is not told it was.
2. **Follow the company's cadence**: a first follow-up within the week, a second before the quote's
   validity runs out, and a close after three weeks of silence. The dates and what goes in each message
   are in [the follow-up cadence](references/follow-up-cadence.md).
3. **Log every touch** with `log_activity`, including the ones that got no answer. A cadence nobody can
   see is a cadence that gets repeated by the next person.
   When the client answers the quote, record it on the quote with `record_quote_outcome` (`accepted`
   or `declined`); that does not move the lead, so move it with `update_lead_stage` once the deal is
   closed.
4. **Change the channel once.** A quote answered by silence on email may get an answer by phone. One
   call, not a series of them.
5. **Count from the day the quote was sent, not from the touches.** `get_quote` shows the day it was
   sent when one is recorded; count from that. A quote with no sent day recorded is counted from the
   day it was issued. Once the close day has passed, close the lead even if earlier touches were never
   logged, and say so in the reason.
6. **Close it properly.** When the period runs out, move the lead to `lost` with `update_lead_stage`,
   and give the reason — the price, the timing, a competitor, a contract they renewed. A won deal is
   closed the same way, as `won`. A closed deal is reopened by a person, not by this role. A pipeline full of leads that are neither alive
   nor dead is a pipeline nobody can plan from.

## When the answer is not a follow-up

- A client who says the price is **too high**, without asking for anything off, has raised a price
  objection. Read the quote with `get_quote` and answer with its value: what each line covers, in
  the receipt's figures, the total, and what it leaves out. Offer no discount and raise no
  approval. Log the touch first; the reply that follows is what the client reads, so the lines and
  the total go in it.
- A client who wants a **lower price** — a percentage or an amount off — is asking for a discount: a
  person's decision, and the reply says the request is with them only once the approval's result says
  so.
- A client who wants a **start date** or a **different schedule** is asking operations.
- A client who **disagrees with an invoice** is asking finance.
- A client who says the **work was short** is making a complaint: the reply names the person the
  escalation path names for complaints, and says it has gone to them only if a tool result says so.

Following up on a quote is not licence to answer any of those yourself, and a follow-up is a bad place
to promise something to keep the conversation alive.

## What a good follow-up looks like

- "Marisol — the scope for the two floors is attached, and I have priced the five-night option at the
  total in the quote. Two things you asked about: the restrooms are included, and the strip-and-wax is
  not. The quote is with [the person the handbook names for discounts, by name], who decides it."
- "Dr. Osei — the walkthrough is booked for Tuesday at 08:00 with operations. After that I can quote the
  nightly clean and the supplies together, so you are not comparing two invoices."

Not this: "Just circling back on the below." There is nothing in it for the client to answer.