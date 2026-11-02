# The quote checklist

Run it before `create_quote`, and again on the receipt before the quote is described to anyone.

## Before

- [ ] The lead exists, by id, and its notes have been read.
- [ ] The scope is written: what is cleaned or fixed, how often, and at what time.
- [ ] The size is measured or given — square footage, restrooms, panes, units, hours.
- [ ] Every line names a price book item, and the unit matches the item's unit.
- [ ] Every price was returned by `search_price_book` in this conversation, not remembered.
- [ ] A recurring line shows the visit count for the frequency.
- [ ] Exclusions are written: parts, holiday shifts, anything above the ground floor.
- [ ] No discount is on the quote unless one was asked for, and a discount means an approval.
- [ ] Nothing about a start date, a crew size or a contract term is on it.

## After

- [ ] The receipt came back with a quote number. A quote is done when the tool says so, not before.
- [ ] Any minimum the desk applied is mentioned, not hidden.
- [ ] The total in the reply is the receipt's total, to the cent, in the same currency.
- [ ] If an approval was raised, the reply says who has it and when they will answer — and does not
      call the quote agreed, accepted or held.
- [ ] `log_activity` records what was quoted and what happens next.

## Worked shape

A nightly contract for a 2,800 sq ft office, five nights a week:

- The site is under the flat-cleaning size, so the recurring line is the flat per-visit item.
- The visit count is five nights × 4.33 weeks = 21.65.
- One line: the visit item, quantity 21.65, unit price from the book.
- Restroom consumables, per restroom per visit, is a second line if supplies are in the contract.
- The subtotal is the desk's; if it lands above the quote limit the quote waits for Marcus, and the
  reply says so.

A first deep clean for a 3,200 sq ft suite:

- One line: the first-visit deep clean item, quantity 3,200 (sq ft), unit price from the book.
- The quantity is small enough that the line falls under the item's minimum, so the desk raises the
  line to the minimum and the receipt says it did.
- The reply quotes the receipt's figure and mentions the minimum, so the client is not surprised by a
  number that does not match their own multiplication.

## The mistakes that actually happen

- Quoting the flat visit price for a site over the flat size, which underprices the job.
- Counting visits as twenty for a five-night week, which underquotes every month by a noticeable sum.
- Forgetting that the minimum applies to the line, not to the quote.
- Describing a quote as "held" while an approval is outstanding.
- Adding a discount to keep a conversation moving. It does not; it stops the quote until a person
  answers.