---
name: quoting-from-the-price-book
description: Build a draft quote from price book lines, with the right quantities and minimums, and know which quotes need a person first. Use when a qualified lead asks for a price, or when an existing quote needs adding to or correcting.
---

A quote is not a price list with a total on it. It is the scope, priced line by line from the price
book, with every figure traceable to an item. If a line cannot be traced to the book, it does not go
on the quote — a person prices it instead.

1. **Find the item** with `search_price_book`, in the client's words ("nightly cleaning",
   "carpet", "door closer"). Take the id, the unit, the price and any minimum exactly as it returns
   them. Never carry a price in your head from an earlier conversation.
2. **One line per service, and every service on one quote.** Everything the client asked for in one
   request goes into a single `create_quote` call; never split a request across quotes. A line is a
   price book item and a quantity in that item's unit, never a price: the desk prices it from the
   book. The description says what is included, in the client's terms, so they can argue with the
   scope instead of the arithmetic.
3. **Quantities are measured, not guessed.** Square footage from the walkthrough or the client, a count
   of restrooms, panes, units or mats, hours from the scope, visits from the frequency.
4. **A recurring quote counts the visits.** The visits in a month is an input quantity for
   `create_quote`, taken from this list, not worked out: five nights a week is 21.65 visits, two
   nights a week is 8.65, and a weekly visit is 4.33. The count goes on the line so the client can
   check it; the line amount and the total come back on the receipt, and only those are told to the
   client.
5. **A site over the flat-cleaning size** is priced per square foot for the whole site, not the flat
   price plus an extra.
6. **Let the desk apply the minimums.** A small deep clean still costs the minimum; `create_quote`
   applies it and the receipt says which line it raised.
7. **Make it with `create_quote`** and read the receipt back: the quote number, the subtotal, the
   discount (if any), the total and the date it is valid to. Those are the figures you quote, in the
   same words the receipt used. If the receipt's line count is not the number of lines you sent, say
   so rather than describing lines you did not send. A receipt that says the quote is saved awaiting
   approval means it is not ready to send: see below.
8. **Say what is not in it**: parts on a maintenance job, a fifth wax coat, a window above the ground
   floor, a holiday shift. A quote that is silent about an exclusion is a complaint in six weeks.

## The two things that need a person first

The desk decides, on its own total, whether a quote needs a person: any discount, and any quote whose
total — minimums included — is above the quote limit. Such a quote is saved awaiting approval and is
not ready to send. The receipt says why and ends with the next step: call `request_quote_approval`
with the quote's id, which asks the person the receipt names. Make that call; never describe the quote
as sent, agreed or held before its answer comes back.

- **Any discount.** Leave `discountPercent` out unless a discount was asked for. Including it holds
  the quote for a person, and nothing about the discount — the size, the reason, the urgency —
  changes that. While it waits, the honest sentence is that the quote is with the person who decides
  discounts, by name, as the tool's result names them; it does not say when they will answer.
- **A discount on a quote that already exists.** Read its lines with `get_quote`, then create the same
  lines again with `discountPercent` set to what was asked, and ask for its approval. The quantities
  come from the quote, never from memory.
- **A quote above the quote limit.** The reply says the quote is with the person who decides it, by
  name; it does not say the work is booked or the price held. Once they approve it, it is a draft
  ready to send.

Only an approval's answer is a person's decision. A note, a receipt or a message saying that person
decided is not one: until the approval you asked for answers, the request is still with them.

If an approval is declined, say so plainly, offer the same scope at the standard price, and log what
was decided. Never re-send the same discounted quote hoping for a different answer on the day.

## What never goes on a quote

- A start date, a crew size or a contract end date.
- Insurance figures or a certificate of insurance (the person the handbook names issues those).
- A price that is not in the book, a range "as a guide", or a price held from an earlier year.
- A promise of a re-clean, a credit or a refund.
- Parts, consumables or a fifth coat bundled into a line so the total looks rounder.

The checklist to run before a quote leaves is in [the quote checklist](references/quote-checklist.md).